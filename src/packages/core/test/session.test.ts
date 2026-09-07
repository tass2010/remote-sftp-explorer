import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStateModel } from '../src/session/connectionState.ts';
import { reconnectDelayMs, ReconnectScheduler } from '../src/session/reconnectScheduler.ts';
import { SshTransport } from '../src/transport/sshTransport.ts';
import { FakeSpawner } from './support/fakeSpawner.ts';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

test('a subscriber receives the current state immediately and every transition', () => {
  const model = new ConnectionStateModel();
  const seen: string[] = [];
  const unsubscribe = model.subscribe((snapshot) => seen.push(snapshot.status));

  model.set('connecting', 'example');
  model.set('connected', 'example');
  model.set('reconnecting', 'example', 'connection lost');
  model.set('connected', 'example');
  model.set('disconnecting', 'example');
  model.set('disconnected');

  assert.deepEqual(seen, [
    'disconnected',
    'connecting',
    'connected',
    'reconnecting',
    'connected',
    'disconnecting',
    'disconnected'
  ]);
  unsubscribe();
  model.set('failed');
  assert.equal(seen.length, 7, 'an unsubscribed listener must stop hearing updates');
});

test('only the connected state permits file operations', () => {
  const model = new ConnectionStateModel();
  for (const status of ['disconnected', 'connecting', 'reconnecting', 'disconnecting', 'failed'] as const) {
    model.set(status);
    assert.equal(model.usable, false, status);
  }
  model.set('connected', 'example');
  assert.equal(model.usable, true);
  assert.equal(model.alias, 'example');
});

// ---------------------------------------------------------------------------
// Reconnect backoff
// ---------------------------------------------------------------------------

test('the delay doubles per attempt and then holds at the ceiling', () => {
  assert.equal(reconnectDelayMs(1, 1_000, 30_000), 1_000);
  assert.equal(reconnectDelayMs(2, 1_000, 30_000), 2_000);
  assert.equal(reconnectDelayMs(3, 1_000, 30_000), 4_000);
  assert.equal(reconnectDelayMs(4, 1_000, 30_000), 8_000);
  assert.equal(reconnectDelayMs(5, 1_000, 30_000), 16_000);
  assert.equal(reconnectDelayMs(6, 1_000, 30_000), 30_000, 'capped, not unbounded');
  assert.equal(reconnectDelayMs(50, 1_000, 30_000), 30_000);
});

/** A scheduler whose timers fire when the test says so. */
function manualScheduler(options: { maxAttempts?: number } = {}): {
  scheduler: ReconnectScheduler;
  fire(): Promise<void>;
  delays: number[];
} {
  const queue: Array<{ handler: () => void; delay: number }> = [];
  const delays: number[] = [];
  const scheduler = new ReconnectScheduler({
    ...options,
    setTimeoutFn: (handler, ms) => {
      delays.push(ms);
      queue.push({ handler, delay: ms });
      return queue.length;
    },
    clearTimeoutFn: (handle) => {
      const index = (handle as number) - 1;
      if (index >= 0 && index < queue.length) queue.splice(index, 1);
    }
  });

  return {
    scheduler,
    delays,
    async fire() {
      const next = queue.shift();
      next?.handler();
      // Let the async attempt settle before the test inspects the outcome.
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    }
  };
}

test('retries continue until an attempt succeeds', async () => {
  const { scheduler, fire, delays } = manualScheduler();
  let attempts = 0;
  let succeededOn: number | undefined;

  scheduler.start({
    attempt: async (attempt) => {
      attempts = attempt;
      if (attempt < 3) throw new Error('still down');
    },
    onSuccess: (attempt) => {
      succeededOn = attempt;
    }
  });

  await fire();
  await fire();
  await fire();

  assert.equal(attempts, 3);
  assert.equal(succeededOn, 3);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  assert.equal(scheduler.running, false);
});

test('the cycle gives up after the configured number of attempts', async () => {
  const { scheduler, fire } = manualScheduler({ maxAttempts: 3 });
  const failures: number[] = [];
  let gaveUp: unknown;

  scheduler.start({
    attempt: async () => {
      throw new Error('down');
    },
    onFailure: (attempt) => failures.push(attempt),
    onGiveUp: (error) => {
      gaveUp = error;
    }
  });

  await fire();
  await fire();
  await fire();

  assert.deepEqual(failures, [1, 2, 3]);
  assert.ok(gaveUp instanceof Error);
  assert.equal(scheduler.running, false);
});

test('stopping cancels the pending retry', async () => {
  const { scheduler, fire } = manualScheduler();
  let attempts = 0;

  scheduler.start({
    attempt: async () => {
      attempts += 1;
      throw new Error('down');
    }
  });
  scheduler.stop();
  await fire();

  assert.equal(attempts, 0, 'a cancelled cycle must not run another attempt');
  assert.equal(scheduler.running, false);
});

test('stopping during an attempt suppresses its success event', async () => {
  // Otherwise the UI would announce a connection the user had already cancelled.
  const { scheduler, fire } = manualScheduler();
  let announced = false;

  scheduler.start({
    attempt: async () => {
      scheduler.stop();
    },
    onSuccess: () => {
      announced = true;
    }
  });
  await fire();

  assert.equal(announced, false);
});

test('starting twice does not run two cycles at once', async () => {
  const { scheduler, fire } = manualScheduler();
  let attempts = 0;
  const callbacks = {
    attempt: async () => {
      attempts += 1;
      throw new Error('down');
    }
  };

  scheduler.start(callbacks);
  scheduler.start(callbacks);
  await fire();

  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function transportFor(spawner: FakeSpawner): SshTransport {
  return new SshTransport({
    spawner,
    executable: 'ssh',
    alias: 'example',
    environment: { PATH: '/usr/bin', USERPROFILE: 'C:\\Users\\dev' }
  });
}

test('the transport spawns ssh with hardened arguments and the sftp subsystem', () => {
  const spawner = new FakeSpawner();
  transportFor(spawner).start();

  const spawn = spawner.lastSpawn;
  assert.ok(spawn);
  assert.equal(spawn.executable, 'ssh');
  assert.deepEqual(spawn.args.slice(-3), ['-s', 'example', 'sftp']);
  assert.ok(!spawn.args.join(' ').toLowerCase().includes('batchmode'));
  assert.equal(spawn.env['USERPROFILE'], 'C:\\Users\\dev', 'the environment must be inherited');
});

test('stdout becomes channel data and stdin carries writes', () => {
  const spawner = new FakeSpawner();
  const channel = transportFor(spawner).start();

  const received: Uint8Array[] = [];
  channel.onData((chunk) => received.push(chunk));

  spawner.lastProcess?.emitStdout(new Uint8Array([1, 2, 3]));
  assert.deepEqual(received, [new Uint8Array([1, 2, 3])]);

  channel.write(new Uint8Array([9]));
  assert.deepEqual(spawner.lastProcess?.written, [new Uint8Array([9])]);
});

test('an unexpected exit closes the channel with the stderr tail', () => {
  const spawner = new FakeSpawner();
  const transport = transportFor(spawner);
  const channel = transport.start();

  let closeError: Error | undefined;
  channel.onClose((error) => {
    closeError = error;
  });

  spawner.lastProcess?.emitStderr('Permission denied (publickey).\n');
  spawner.lastProcess?.emitExit(255);

  assert.ok(closeError);
  assert.match(closeError.message, /exited with code 255/);
  assert.match(closeError.message, /Permission denied/, 'diagnostics must survive');
});

test('a deliberate disconnect is not reported as a failure', async () => {
  const spawner = new FakeSpawner();
  const transport = transportFor(spawner);
  const channel = transport.start();

  let closed = false;
  let closeError: Error | undefined;
  channel.onClose((error) => {
    closed = true;
    closeError = error;
  });

  const disposing = transport.dispose(50);
  // Closing stdin is what lets ssh finish on its own.
  assert.equal(spawner.lastProcess?.stdinClosed, true);
  spawner.lastProcess?.emitExit(0);
  await disposing;

  assert.equal(closed, true);
  assert.equal(closeError, undefined, 'a manual close carries no error');
  assert.equal(spawner.lastProcess?.killed, false, 'a cooperative child is never killed');
});

test('a child that will not exit is terminated rather than hanging the caller', async () => {
  const spawner = new FakeSpawner();
  const transport = transportFor(spawner);
  transport.start();

  await transport.dispose(10);
  assert.equal(spawner.lastProcess?.killed, true);
});

test('the stderr tail is bounded so a chatty server cannot grow it without limit', () => {
  const spawner = new FakeSpawner();
  const transport = transportFor(spawner);
  transport.start();

  for (let index = 0; index < 200; index += 1) {
    spawner.lastProcess?.emitStderr('x'.repeat(200));
  }
  assert.ok(transport.stderrTail.length <= 8 * 1024 + 200);
});

test('writing after the process exits fails loudly', () => {
  const spawner = new FakeSpawner();
  const channel = transportFor(spawner).start();
  spawner.lastProcess?.emitExit(0);

  assert.throws(() => channel.write(new Uint8Array([1])), /closed/);
});
