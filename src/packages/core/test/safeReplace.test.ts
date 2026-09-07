import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusCode } from '@remote-sftp-explorer/sftp-protocol';
import { createHarness } from './support/fakeRemoteFs.ts';
import { isArtifactName, safeReplace, sweepArtifacts } from '../src/fs/safeReplace.ts';

const content = (text: string): Uint8Array => new TextEncoder().encode(text);
const isTemp = (path: string): boolean => path.endsWith('.tmp');
const isBackup = (path: string): boolean => path.endsWith('.bak');

let counter = 0;
const randomToken = (): string => `t${counter++}`;

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('with posix-rename the replacement lands atomically and leaves no artefacts', async () => {
  const { client, fs } = await createHarness({ posixRename: true });
  fs.write('/dir/file.txt', 'old', 0o100644);

  const result = await safeReplace({
    client,
    path: '/dir/file.txt',
    content: content('new'),
    permissions: 0o100644,
    randomToken
  });

  assert.equal(result.strategy, 'posix-rename');
  assert.equal(fs.read('/dir/file.txt'), 'new');
  assert.deepEqual(fs.artifacts(), []);
});

test('the replacement inherits the permission bits of the file it replaces', async () => {
  const { client, fs } = await createHarness({ posixRename: true });
  fs.write('/dir/script.sh', 'old', 0o100755);

  await safeReplace({
    client,
    path: '/dir/script.sh',
    content: content('new'),
    permissions: 0o100755,
    randomToken
  });

  // The mode is masked to permission bits: the file-type bits belong to the server.
  assert.equal(fs.permissions.get('/dir/script.sh'), 0o755);
});

test('without posix-rename the backup fallback still replaces the file', async () => {
  // The previous implementation refused to save at all against such a server.
  const { client, fs } = await createHarness({ posixRename: false });
  fs.write('/dir/file.txt', 'old');

  const result = await safeReplace({
    client,
    path: '/dir/file.txt',
    content: content('new'),
    randomToken
  });

  assert.equal(result.strategy, 'backup-fallback');
  assert.equal(fs.read('/dir/file.txt'), 'new');
  assert.deepEqual(fs.artifacts(), [], 'temp and backup are both cleaned up');
});

test('saving a file that does not exist yet creates it', async () => {
  const { client, fs } = await createHarness({ posixRename: false });
  await safeReplace({ client, path: '/dir/new.txt', content: content('hello'), randomToken });

  assert.equal(fs.read('/dir/new.txt'), 'hello');
  assert.deepEqual(fs.artifacts(), []);
});

test('the content is fsynced before the swap when the server supports it', async () => {
  const { client, fs } = await createHarness({ posixRename: true, fsync: true });
  fs.write('/dir/file.txt', 'old');

  await safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken });

  const order = fs.operations.map((entry) => entry.operation);
  const fsyncAt = order.indexOf('fsync');
  const renameAt = order.indexOf('posix-rename');
  assert.ok(fsyncAt >= 0, 'fsync must be issued');
  assert.ok(
    fsyncAt < renameAt,
    'a durable rename over non-durable contents can leave an empty file after a crash'
  );
});

// ---------------------------------------------------------------------------
// Failure injection -- step 2 (writing the temporary file)
// ---------------------------------------------------------------------------

test('a failed write leaves the original untouched and removes the temp file', async () => {
  const { client, fs } = await createHarness({ posixRename: true });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'write', match: isTemp, code: StatusCode.Failure });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    /FAILURE/
  );

  assert.equal(fs.read('/dir/file.txt'), 'original');
  assert.deepEqual(fs.artifacts(), []);
});

test('a failed open of the temporary file leaves the original untouched', async () => {
  const { client, fs } = await createHarness({ posixRename: true });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'open', match: isTemp, code: StatusCode.PermissionDenied });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    /PERMISSION_DENIED/
  );

  assert.equal(fs.read('/dir/file.txt'), 'original');
});

// ---------------------------------------------------------------------------
// Failure injection -- the atomic branch
// ---------------------------------------------------------------------------

test('a failed atomic rename leaves the original intact and cleans up the temp file', async () => {
  const { client, fs } = await createHarness({ posixRename: true });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'posix-rename', match: isTemp, code: StatusCode.PermissionDenied });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    /PERMISSION_DENIED/
  );

  assert.equal(fs.read('/dir/file.txt'), 'original', 'must be byte-for-byte unchanged');
  assert.deepEqual(fs.artifacts(), []);
});

// ---------------------------------------------------------------------------
// Failure injection -- the backup fallback, step by step
// ---------------------------------------------------------------------------

test('a failure moving the original aside leaves it in place', async () => {
  const { client, fs } = await createHarness({ posixRename: false });
  fs.write('/dir/file.txt', 'original');
  fs.fail({
    operation: 'rename',
    match: (path) => path === '/dir/file.txt',
    code: StatusCode.PermissionDenied
  });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    /could not be moved aside[\s\S]*unchanged/
  );

  assert.equal(fs.read('/dir/file.txt'), 'original');
  assert.deepEqual(fs.artifacts(), [], 'the temporary file must be cleaned up');
});

test('a failure moving the replacement into place restores the original', async () => {
  // The riskiest step: the original has already been moved aside, so failing here without a
  // rollback would leave the user with no file at all.
  const { client, fs } = await createHarness({ posixRename: false });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'rename', match: isTemp, code: StatusCode.Failure });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    /original has been restored/
  );

  assert.equal(fs.read('/dir/file.txt'), 'original', 'the original must be back at its path');
  assert.deepEqual(fs.artifacts(), []);
});

test('when both the swap and the rollback fail, the error says where the data is', async () => {
  const { client, fs } = await createHarness({ posixRename: false });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'rename', match: isTemp, code: StatusCode.Failure });
  fs.fail({ operation: 'rename', match: isBackup, code: StatusCode.Failure });

  await assert.rejects(
    () => safeReplace({ client, path: '/dir/file.txt', content: content('new'), randomToken }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /could not be restored/);
      assert.match(message, /\.bak/, 'must name the backup holding the previous contents');
      assert.match(message, /\.tmp/, 'must name the temp file holding the new contents');
      return true;
    }
  );

  // Nothing was destroyed: both copies are still on the server, and the message says so.
  assert.equal(fs.artifacts().length, 2);
});

test('a failure removing the backup still counts as a successful save', async () => {
  // The content is already correct here. Reporting failure would push the user to retry a
  // write that already landed.
  const { client, fs } = await createHarness({ posixRename: false });
  fs.write('/dir/file.txt', 'original');
  fs.fail({ operation: 'remove', match: isBackup, code: StatusCode.PermissionDenied });

  const warnings: string[] = [];
  const result = await safeReplace({
    client,
    path: '/dir/file.txt',
    content: content('new'),
    randomToken: () => 'stable',
    logger: {
      info: () => undefined,
      debug: () => undefined,
      error: () => undefined,
      warn: (message) => warnings.push(message)
    }
  });

  assert.equal(fs.read('/dir/file.txt'), 'new', 'the save succeeded');
  assert.equal(result.orphanedBackup, '/dir/.file.txt.remote-sftp-stable.bak');
  assert.equal(warnings.length, 1, 'the orphan is reported, not silently ignored');
});

// ---------------------------------------------------------------------------
// Artefact sweeping
// ---------------------------------------------------------------------------

test('artefact names are recognised without a persisted journal', () => {
  assert.equal(isArtifactName('.notes.txt.remote-sftp-a1b2.tmp'), true);
  assert.equal(isArtifactName('.notes.txt.remote-sftp-a1b2.bak'), true);
  assert.equal(isArtifactName('notes.txt'), false);
  assert.equal(isArtifactName('.hidden'), false);
  assert.equal(isArtifactName('.remote-sftp-notes.txt'), false, 'needs a temp or backup suffix');
  assert.equal(isArtifactName('notes.remote-sftp-x.tmp'), false, 'artefacts are dotfiles');
});

test('sweeping removes leftovers from an interrupted save and nothing else', async () => {
  const { client, fs } = await createHarness({});
  fs.write('/dir/keep.txt', 'keep');
  fs.write('/dir/.keep.txt.remote-sftp-dead.tmp', 'junk');
  fs.write('/dir/.keep.txt.remote-sftp-dead.bak', 'junk');
  fs.write('/dir/.dotfile', 'a real user file');

  const removed = await sweepArtifacts(client, '/dir');

  assert.deepEqual(removed.sort(), [
    '/dir/.keep.txt.remote-sftp-dead.bak',
    '/dir/.keep.txt.remote-sftp-dead.tmp'
  ]);
  assert.equal(fs.read('/dir/keep.txt'), 'keep');
  assert.equal(fs.read('/dir/.dotfile'), 'a real user file', 'ordinary dotfiles are left alone');
});

test('sweeping a directory it cannot read is not an error', async () => {
  const { client } = await createHarness({});
  const removed = await sweepArtifacts(client, '/nonexistent');
  assert.deepEqual(removed, []);
});
