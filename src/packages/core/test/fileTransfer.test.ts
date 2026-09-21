/**
 * Transfer pacing: how fast it is going, and when to stop waiting.
 *
 * Everything here runs on a controllable clock, so a twenty-second stall is tested in
 * microseconds and the tests do not become the slowest part of the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllableClock } from '../../sftp-protocol/test/support/fakeSftpServer.ts';
import {
  DEFAULT_STALL_MS,
  describeProgress,
  formatBytes,
  formatDuration,
  runTransfer,
  TransferMonitor,
  TransferStalledError
} from '../src/transfer/fileTransfer.ts';

// ---------------------------------------------------------------------------
// Rate and estimate
// ---------------------------------------------------------------------------

test('the rate follows the recent window, not the whole transfer', () => {
  // A transfer that crawled for a minute and then sped up must not keep reporting the crawl:
  // the number people use to decide whether to wait has to describe what the link is doing
  // now.
  const clock = createControllableClock();
  const monitor = new TransferMonitor({ clock, total: 10_000_000 });

  // Ten seconds at 1 KB/s.
  for (let second = 1; second <= 10; second += 1) {
    clock.advance(1000);
    monitor.record(second * 1024);
  }
  assert.ok(monitor.snapshot().bytesPerSecond < 2048, 'slow start is reported as slow');

  // Then five seconds at 1 MB/s.
  let bytes = 10 * 1024;
  for (let second = 1; second <= 5; second += 1) {
    clock.advance(1000);
    bytes += 1024 * 1024;
    monitor.record(bytes);
  }

  const rate = monitor.snapshot().bytesPerSecond;
  assert.ok(
    rate > 512 * 1024,
    `the window should have caught up to roughly 1 MB/s, saw ${Math.round(rate)}`
  );
});

test('no estimate is offered until there is a rate behind it', () => {
  // "0 B/s, unknown remaining" on a transfer that has merely just started reads like a fault.
  const clock = createControllableClock();
  const monitor = new TransferMonitor({ clock, total: 1000 });

  assert.equal(monitor.snapshot().etaSeconds, undefined, 'nothing has happened yet');

  clock.advance(1000);
  monitor.record(100);
  const progress = monitor.snapshot();
  assert.ok(progress.etaSeconds !== undefined);
  // 900 bytes left at 100 B/s.
  assert.ok(Math.abs((progress.etaSeconds ?? 0) - 9) < 1, `saw ${String(progress.etaSeconds)}`);
});

test('a finished transfer stops estimating instead of predicting zero forever', () => {
  const clock = createControllableClock();
  const monitor = new TransferMonitor({ clock, total: 1000 });
  clock.advance(1000);
  monitor.record(1000);
  assert.equal(monitor.snapshot().etaSeconds, undefined);
});

// ---------------------------------------------------------------------------
// The stall guard
// ---------------------------------------------------------------------------

test('a transfer that stops moving is abandoned rather than left hanging', async () => {
  const clock = createControllableClock();
  let aborted = false;

  const attempt = runTransfer({
    clock,
    what: 'Downloading /srv/big.iso',
    total: 1_000_000,
    run: ({ signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })
  });

  clock.advance(DEFAULT_STALL_MS);
  await assert.rejects(attempt, TransferStalledError);
  assert.ok(aborted, 'the work must be told to stop, not merely reported as failed');
});

test('progress keeps a slow transfer alive indefinitely', async () => {
  // The guard fires on no progress at all, never on a low rate. A link doing a few kilobytes
  // a second is painful, not broken, and cutting it off would throw away work that would
  // have finished.
  const clock = createControllableClock();

  const attempt = runTransfer({
    clock,
    what: 'Uploading',
    total: 100,
    run: async ({ report }) => {
      for (let tick = 1; tick <= 20; tick += 1) {
        // Just inside the window, every time, forever.
        clock.advance(DEFAULT_STALL_MS - 1);
        report(tick);
        await Promise.resolve();
      }
      return 'finished';
    }
  });

  assert.equal(await attempt, 'finished');
});

test('a stall is reported as a stall, not as a cancellation', async () => {
  // Both arrive through the same signal, so without the distinction the user would be told
  // they cancelled something they did not touch.
  const clock = createControllableClock();

  const attempt = runTransfer({
    clock,
    what: 'Downloading /srv/big.iso',
    total: 10,
    run: ({ signal, report }) =>
      new Promise<void>((_resolve, reject) => {
        report(5);
        signal.addEventListener('abort', () => reject(new Error('The operation was cancelled.')));
      })
  });

  clock.advance(DEFAULT_STALL_MS);
  await assert.rejects(attempt, (error: unknown) => {
    assert.ok(error instanceof TransferStalledError);
    assert.match(error.message, /Downloading \/srv\/big\.iso/);
    assert.equal(error.bytesTransferred, 5, 'the message can say how far it got');
    return true;
  });
});

test('cancelling passes through as itself', async () => {
  const clock = createControllableClock();
  const outer = new AbortController();

  const attempt = runTransfer({
    clock,
    what: 'Downloading',
    total: 10,
    signal: outer.signal,
    run: ({ signal }) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled by the user')));
      })
  });

  outer.abort();
  await assert.rejects(attempt, /cancelled by the user/);
});

test('a signal already aborted never starts the work', async () => {
  const clock = createControllableClock();
  const outer = new AbortController();
  outer.abort();

  await assert.rejects(
    runTransfer({
      clock,
      what: 'Downloading',
      total: 10,
      signal: outer.signal,
      run: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('already cancelled'));
        })
    }),
    /already cancelled/
  );
});

test('the stall timer is cleared when the transfer finishes', async () => {
  // A timer left armed on a completed transfer keeps the process awake and, worse, could fire
  // against a controller nobody is listening to any more.
  const clock = createControllableClock();
  await runTransfer({ clock, what: 'Downloading', total: 0, run: async () => undefined });
  assert.equal(clock.pendingTimers, 0);
});

// ---------------------------------------------------------------------------
// What the notification says
// ---------------------------------------------------------------------------

test('sizes and durations are written the way people read them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');

  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatDuration(3700), '1h 1m');
});

test('the progress line omits what it does not yet know', () => {
  assert.equal(
    describeProgress({ bytes: 0, total: 2048, bytesPerSecond: 0, etaSeconds: undefined }),
    '0 B of 2.0 KB'
  );
  assert.equal(
    describeProgress({ bytes: 1024, total: 2048, bytesPerSecond: 512, etaSeconds: 2 }),
    '1.0 KB of 2.0 KB · 512 B/s · 2s left'
  );
});
