/**
 * Full-stack session tests: transport -> SFTP client -> RemoteSession.
 *
 * A fake subprocess carries real SFTP bytes to an in-memory server, so everything below the
 * VS Code layer is exercised together -- including the framing over a simulated pipe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Extension } from '@remote-sftp-explorer/sftp-protocol';
import {
  createControllableClock,
  FakeSftpServer
} from '../../sftp-protocol/test/support/fakeSftpServer.ts';
import { FakeRemoteFs } from './support/fakeRemoteFs.ts';
import { FakeSpawner } from './support/fakeSpawner.ts';
import { RemoteConflictError, RemoteSession } from '../src/session/remoteSession.ts';

interface Fixture {
  session: RemoteSession;
  fs: FakeRemoteFs;
  spawner: FakeSpawner;
  server: FakeSftpServer;
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

  const session = await RemoteSession.connect({
    spawner,
    executable: 'ssh',
    alias: 'example',
    environment: { PATH: '/usr/bin' },
    clock: createControllableClock(),
    randomToken: () => `tok${tokenCounter++}`
  });

  return { session, fs, spawner, server };
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
