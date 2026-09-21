/**
 * Full-stack session tests: transport -> SFTP client -> RemoteSession.
 *
 * A fake subprocess carries real SFTP bytes to an in-memory server, so everything below the
 * VS Code layer is exercised together -- including the framing over a simulated pipe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extension, PacketType } from '@remote-sftp-explorer/sftp-protocol';
import {
  createControllableClock,
  FakeSftpServer,
  type ControllableClock
} from '../../sftp-protocol/test/support/fakeSftpServer.ts';
import { FakeRemoteFs } from './support/fakeRemoteFs.ts';
import { FakeSpawner } from './support/fakeSpawner.ts';
import { RemoteConflictError, RemoteSession } from '../src/session/remoteSession.ts';

interface Fixture {
  session: RemoteSession;
  fs: FakeRemoteFs;
  spawner: FakeSpawner;
  server: FakeSftpServer;
  clock: ControllableClock;
}

let tokenCounter = 0;

async function connect(options: { posixRename?: boolean } = {}): Promise<Fixture> {
  const extensions: Record<string, string> = { [Extension.Fsync]: '1' };
  if (options.posixRename !== false) extensions[Extension.PosixRename] = '1';

  const server = new FakeSftpServer({ extensions });
  const fs = new FakeRemoteFs();
  fs.install(server);
  // REALPATH "." resolves the remote home directory.
  server.on(16 /* Realpath */, ({ requestId }) =>
    FakeSftpServer.name(requestId, [{ filename: '/home/dev' }])
  );

  const spawner = new FakeSpawner();
  spawner.onSpawn = (child) => {
    // Wire the fake process's stdio to the fake server: stdin in, stdout back.
    server.channel.onData((chunk) => child.emitStdout(chunk));
    child.onWrite = (chunk) => server.channel.write(chunk);
  };

  const clock = createControllableClock();
  const session = await RemoteSession.connect({
    spawner,
    executable: 'ssh',
    alias: 'example',
    environment: { PATH: '/usr/bin' },
    clock,
    randomToken: () => `tok${tokenCounter++}`
  });

  return { session, fs, spawner, server, clock };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

test('connecting negotiates SFTP and resolves the remote home directory', async () => {
  const { session, spawner } = await connect();

  assert.equal(session.rootPath, '/home/dev');
  assert.equal(session.closed, false);
  assert.equal(session.capabilities.posixRename, true);
  assert.deepEqual(spawner.lastSpawn?.args.slice(-3), ['-s', 'example', 'sftp']);
});

test('a directory listing sorts directories first, then by name', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/zebra.txt', 'z', 0o100644);
  fs.write('/home/dev/alpha.txt', 'a', 0o100644);
  fs.write('/home/dev/subdir/inner', 'i', 0o100644);
  fs.permissions.set('/home/dev/subdir', 0o040755);
  fs.files.set('/home/dev/subdir', new Uint8Array(0));

  const entries = await session.list('/home/dev');
  const names = entries.map((entry) => entry.name);

  assert.equal(names[0], 'subdir', 'directories come first');
  assert.deepEqual(names.slice(1), ['alpha.txt', 'zebra.txt']);
  assert.equal(entries[0]?.path, '/home/dev/subdir', 'entries carry their absolute path');
});

test('reading a file returns its content and a baseline for later conflict checks', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'hello world', 0o100644);

  const { content, baseline } = await session.readFile('/home/dev/notes.txt');

  assert.equal(decode(content), 'hello world');
  assert.equal(baseline.size, 11n);
  assert.equal(baseline.mtime, 1000);
});

test('saving replaces the file and leaves no artefacts behind', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'old', 0o100644);
  const baseline = await session.baseline('/home/dev/notes.txt');

  const result = await session.writeFile('/home/dev/notes.txt', text('new'), {
    expected: baseline
  });

  assert.equal(result.strategy, 'posix-rename');
  assert.equal(fs.read('/home/dev/notes.txt'), 'new');
  assert.deepEqual(fs.artifacts(), []);
});

test('a remote change since opening is refused rather than silently overwritten', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'original', 0o100644);
  const baseline = await session.baseline('/home/dev/notes.txt');

  // Someone else edits the file: same mtime in this fake, but a different size.
  fs.write('/home/dev/notes.txt', 'changed by someone else', 0o100644);

  await assert.rejects(
    () => session.writeFile('/home/dev/notes.txt', text('mine'), { expected: baseline }),
    RemoteConflictError
  );
  assert.equal(
    fs.read('/home/dev/notes.txt'),
    'changed by someone else',
    'the other edit must survive'
  );
});

test('the user can consent to overwrite a conflicting change', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'original', 0o100644);
  const baseline = await session.baseline('/home/dev/notes.txt');
  fs.write('/home/dev/notes.txt', 'changed elsewhere', 0o100644);

  let asked = false;
  await session.writeFile('/home/dev/notes.txt', text('mine'), {
    expected: baseline,
    onConflict: async () => {
      asked = true;
      return true;
    }
  });

  assert.equal(asked, true, 'the user must be asked, not assumed');
  assert.equal(fs.read('/home/dev/notes.txt'), 'mine');
});

test('a file deleted since opening is recreated rather than treated as a conflict', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'original', 0o100644);
  const baseline = await session.baseline('/home/dev/notes.txt');
  fs.files.delete('/home/dev/notes.txt');

  await session.writeFile('/home/dev/notes.txt', text('restored'), { expected: baseline });
  assert.equal(fs.read('/home/dev/notes.txt'), 'restored');
});

test('concurrent saves to one path are serialised', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'start', 0o100644);

  await Promise.all([
    session.writeFile('/home/dev/notes.txt', text('first')),
    session.writeFile('/home/dev/notes.txt', text('second'))
  ]);

  // Whichever landed last, the file must be one of the two whole values -- never a mixture,
  // and never a leftover temporary file.
  assert.ok(['first', 'second'].includes(fs.read('/home/dev/notes.txt') ?? ''));
  assert.deepEqual(fs.artifacts(), []);
});

test('creating a file that already exists fails instead of truncating it', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/existing.txt', 'valuable', 0o100644);

  // O_EXCL is what makes this a refusal rather than a silent truncation.
  await assert.rejects(() => session.createFile('/home/dev/existing.txt'));
  assert.equal(fs.read('/home/dev/existing.txt'), 'valuable');
});

test('an unexpected ssh exit closes the session and notifies listeners', async () => {
  const { session, spawner } = await connect();

  let closeError: Error | undefined;
  session.onDidClose((error) => {
    closeError = error;
  });

  spawner.lastProcess?.emitStderr('Connection reset by peer\n');
  spawner.lastProcess?.emitExit(255);

  assert.equal(session.closed, true);
  assert.ok(closeError);
  assert.match(closeError.message, /Connection reset by peer/);
});

test('operations after the connection drops fail rather than hanging', async () => {
  const { session, spawner } = await connect();
  spawner.lastProcess?.emitExit(255);

  await assert.rejects(() => session.list('/home/dev'));
});

test('sweeping clears leftovers from an interrupted save', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/keep.txt', 'keep', 0o100644);
  fs.write('/home/dev/.keep.txt.remote-sftp-old.tmp', 'junk', 0o100644);

  const removed = await session.sweep('/home/dev');

  assert.deepEqual(removed, ['/home/dev/.keep.txt.remote-sftp-old.tmp']);
  assert.equal(fs.read('/home/dev/keep.txt'), 'keep');
});

test('a server without posix-rename still saves, via the backup fallback', async () => {
  const { session, fs } = await connect({ posixRename: false });
  fs.write('/home/dev/notes.txt', 'old', 0o100644);

  const result = await session.writeFile('/home/dev/notes.txt', text('new'));

  assert.equal(result.strategy, 'backup-fallback');
  assert.equal(fs.read('/home/dev/notes.txt'), 'new');
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

const statCount = (server: FakeSftpServer): number =>
  server.received.filter((request) => request.type === PacketType.Stat).length;

test('a caller that already has the stat does not pay for it again', async () => {
  // Opening a file used to stat it twice before reading a byte: once for the size and type
  // check, then again here for the baseline. On a link with latency that is a whole round
  // trip spent re-asking a question just answered.
  const { session, fs, server } = await connect();
  fs.write('/home/dev/notes.txt', 'hello world', 0o100644);

  const known = await session.baseline('/home/dev/notes.txt');
  const before = statCount(server);

  const { content } = await session.readFile('/home/dev/notes.txt', { known });

  assert.equal(decode(content), 'hello world');
  assert.equal(
    statCount(server) - before,
    1,
    'only the closing consistency check should stat; the opening one was handed in'
  );
});

test('without a known baseline the read still stats on both sides', async () => {
  // The consistency check is the point of the pair, so the saving must come from not asking
  // twice -- never from dropping the check.
  const { session, fs, server } = await connect();
  fs.write('/home/dev/notes.txt', 'hello world', 0o100644);

  const before = statCount(server);
  await session.readFile('/home/dev/notes.txt');

  assert.equal(statCount(server) - before, 2, 'one before the read, one after');
});

test('reading does not wait for the handle to be closed', async () => {
  // The bytes are assembled before CLOSE is sent; making the editor wait for its reply buys
  // nothing but latency.
  const { session, fs, server } = await connect();
  fs.write('/home/dev/notes.txt', 'content', 0o100644);

  await session.readFile('/home/dev/notes.txt');
  const closesAtReturn = server.received.filter((r) => r.type === PacketType.Close).length;

  await settle();
  const closesAfter = server.received.filter((r) => r.type === PacketType.Close).length;
  assert.ok(closesAfter >= closesAtReturn, 'the handle is still released, just not awaited');
  assert.ok(closesAfter >= 1, 'the handle must eventually be closed');
});

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Whole-file transfers
// ---------------------------------------------------------------------------

class MemorySink {
  readonly chunks = new Map<number, Uint8Array>();
  closed = false;
  async write(offset: number, chunk: Uint8Array): Promise<void> {
    this.chunks.set(offset, Uint8Array.from(chunk));
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  assemble(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (const [offset, chunk] of this.chunks) out.set(chunk, offset);
    return out;
  }
}

class MemorySource {
  readonly size: number;
  closed = false;
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.size = bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.#bytes.subarray(offset, offset + length);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

test('downloading writes every byte at its own offset and releases the sink', async () => {
  const { session, fs } = await connect();
  const content = 'the quick brown fox jumps over the lazy dog';
  fs.write('/home/dev/notes.txt', content, 0o100644);

  const sink = new MemorySink();
  const result = await session.download('/home/dev/notes.txt', sink);

  assert.equal(decode(sink.assemble(content.length)), content);
  assert.equal(result.bytes, content.length);
  assert.equal(sink.closed, true);
});

test('the sink is closed even when the download fails', async () => {
  // A local file left open on a failed download is the worst of both outcomes: incomplete and
  // still locked.
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'content', 0o100644);
  fs.fail({ operation: 'open', match: (path) => path === '/home/dev/notes.txt' });

  const sink = new MemorySink();
  await assert.rejects(() => session.download('/home/dev/notes.txt', sink));
  assert.equal(sink.closed, true);
});

test('a directory is refused before anything is opened', async () => {
  const { session, fs } = await connect();
  // The fake answers STAT from its file table, so the directory needs an entry of its own for
  // the mode bits to be visible at all.
  fs.write('/home/dev/subdir', '', 0o040755);
  fs.write('/home/dev/subdir/inner', 'i', 0o100644);

  const sink = new MemorySink();
  await assert.rejects(() => session.download('/home/dev/subdir', sink), /is a directory/);
  assert.equal(sink.closed, false, 'nothing was opened, so there is nothing to release');
});

test('uploading replaces through a temporary file, never truncating the original', async () => {
  // The whole point on a bad link: an interrupted upload must not be able to leave a
  // half-written file where a good one was.
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'the original contents', 0o100644);

  const source = new MemorySource(text('replacement contents'));
  await session.upload('/home/dev/notes.txt', source);

  assert.equal(fs.read('/home/dev/notes.txt'), 'replacement contents');
  assert.equal(source.closed, true);
  // Nothing was ever opened on the destination itself; the writes went to a temporary name.
  const opened = fs.operations.filter((op) => op.operation === 'open').map((op) => op.path);
  assert.ok(
    opened.every((path) => path !== '/home/dev/notes.txt'),
    `the destination must not be opened for writing, saw ${opened.join(', ')}`
  );
  assert.equal(fs.artifacts().length, 0, 'the temporary file is cleaned up');
});

test('an upload that fails part way leaves the original file intact', async () => {
  const { session, fs } = await connect();
  fs.write('/home/dev/notes.txt', 'the original contents', 0o100644);
  fs.fail({ operation: 'write', match: (path) => path.includes('.remote-sftp-') });

  const source = new MemorySource(text('replacement contents'));
  await assert.rejects(() => session.upload('/home/dev/notes.txt', source));

  assert.equal(fs.read('/home/dev/notes.txt'), 'the original contents');
  assert.equal(source.closed, true, 'the local handle is released whatever happened');
  assert.equal(fs.artifacts().length, 0, 'and the temporary file does not survive the failure');
});

test('a stalled upload reports the stall and stops', async () => {
  const { session, fs, clock } = await connect();
  fs.write('/home/dev/notes.txt', 'original', 0o100644);

  // A local read that never returns: a disconnected network share, a removed device. The SFTP
  // side is perfectly healthy, so only a guard watching bytes rather than packets notices.
  const source = {
    size: 4096,
    closed: false,
    started: false,
    read: (): Promise<Uint8Array> => {
      source.started = true;
      return new Promise<Uint8Array>(() => undefined);
    },
    close: async (): Promise<void> => {
      source.closed = true;
    }
  };

  const attempt = session.upload('/home/dev/notes.txt', source, { stallMs: 5_000 });
  const rejected = assert.rejects(attempt, /stopped making progress/);

  // Advancing before the transfer has actually begun would fire nothing -- the write lock and
  // the temporary-file open both have to complete before the stall timer is armed -- and the
  // test would then wait for a timer that is set afterwards and never reached.
  for (let tick = 0; tick < 50 && !source.started; tick += 1) await Promise.resolve();
  assert.ok(source.started, 'the upload must be under way before the clock is advanced');

  clock.advance(5_000);
  await rejected;

  assert.equal(source.closed, true, 'the local handle is released even on a stall');
  assert.equal(fs.read('/home/dev/notes.txt'), 'original', 'and the original is untouched');
});

test('renaming within a directory completes instead of deadlocking on its own lock', async () => {
  // rename takes the source lock and then, nested inside it, the destination lock. Both cover
  // the same parent directory, so the inner acquisition waits for a key the outer one is
  // still holding and nothing will ever release it. Sorted acquisition prevents deadlock
  // BETWEEN concurrent operations; it says nothing about one operation nesting two.
  const { session, fs } = await connect();
  fs.write('/home/dev/old.txt', 'contents', 0o100644);

  const outcome = await Promise.race([
    session.rename('/home/dev/old.txt', '/home/dev/new.txt').then(() => 'renamed'),
    new Promise((resolve) => setTimeout(() => resolve('DEADLOCKED'), 500))
  ]);

  assert.equal(outcome, 'renamed');
  assert.equal(fs.read('/home/dev/new.txt'), 'contents');
});
