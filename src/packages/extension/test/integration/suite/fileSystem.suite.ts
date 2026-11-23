import * as vscode from 'vscode';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { equal, ok, rejects, suite } from './harness.ts';
import { ALIAS, connect, fakeRoot, remoteUri } from './support.ts';

/**
 * The file system provider, driven the way VS Code drives it.
 *
 * Every assertion checks both sides: what the editor was told, and what actually landed in
 * the directory the fake server serves. A provider that reports success without writing, or
 * writes without reporting, passes only one of the two.
 */
export const fileSystemSuite = suite('file system provider', (test) => {
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  const onDisk = (name: string): string => join(fakeRoot(), name);

  test('reading a file returns its bytes', async () => {
    await connect();
    writeFileSync(onDisk('read-me.txt'), 'contents from the server');

    const bytes = await vscode.workspace.fs.readFile(remoteUri(ALIAS, '/read-me.txt'));
    equal(decode(bytes), 'contents from the server', 'the editor must see what is on the server');
  });

  test('stat reports type, size and time', async () => {
    await connect();
    writeFileSync(onDisk('sized.txt'), '0123456789');

    const stat = await vscode.workspace.fs.stat(remoteUri(ALIAS, '/sized.txt'));
    equal(stat.type, vscode.FileType.File, 'a regular file');
    equal(stat.size, 10, 'the size the editor allocates against');
    ok(stat.mtime > 0, 'a modification time must be reported');
  });

  test('a directory stats as a directory and lists its entries', async () => {
    await connect();
    const entries = await vscode.workspace.fs.readDirectory(remoteUri(ALIAS, '/subdir'));
    const names = entries.map(([name]) => name).sort();
    ok(names.includes('inner.txt'), `expected inner.txt, saw ${names.join(', ')}`);

    const stat = await vscode.workspace.fs.stat(remoteUri(ALIAS, '/subdir'));
    equal(stat.type, vscode.FileType.Directory, 'the type bits must survive the round trip');
  });

  test('a save that is not confirmed leaves the server untouched', async () => {
    // Every save asks first. VS Code refuses to show dialogs during a test run, which is
    // exactly the declined path -- so this tests the confirmation contract rather than
    // bypassing it: the editor is told the write failed, and the old bytes are still there.
    await connect();
    writeFileSync(onDisk('write-me.txt'), 'before');

    await rejects(
      () =>
        Promise.resolve(
          vscode.workspace.fs.writeFile(remoteUri(ALIAS, '/write-me.txt'), encode('after'))
        ),
      () => true,
      'a save nobody confirmed'
    );
    equal(readFileSync(onDisk('write-me.txt'), 'utf8'), 'before', 'nothing may have been written');
  });

  test('a confirmed write reaches the server and leaves no temporary behind', async () => {
    // The confirmation cannot be answered from here, so the write itself is driven through
    // the session -- the same RemoteSession, over the same pipe, that the provider would use
    // once the dialog was accepted.
    const test_ = await connect();
    const session = test_.sessions.session;
    ok(session !== undefined, 'a live session is required');
    writeFileSync(onDisk('session-write.txt'), 'before');

    await session.writeFile('/session-write.txt', encode('after'));

    equal(readFileSync(onDisk('session-write.txt'), 'utf8'), 'after', 'the bytes reach the disk');
    const names = (await vscode.workspace.fs.readDirectory(remoteUri(ALIAS, '/'))).map(
      ([name]) => name
    );
    const leftovers = names.filter((name) => name.includes('.remote-sftp-'));
    equal(leftovers.length, 0, `no temporary may survive, saw ${leftovers.join(', ')}`);
  });

  test('creating a directory and deleting it both reach the server', async () => {
    await connect();
    await vscode.workspace.fs.createDirectory(remoteUri(ALIAS, '/made-here'));
    equal(existsSync(onDisk('made-here')), true, 'the directory must exist on the server');

    await vscode.workspace.fs.delete(remoteUri(ALIAS, '/made-here'), { recursive: false });
    equal(existsSync(onDisk('made-here')), false, 'and be gone afterwards');
  });

  test('a recursive delete removes the contents too', async () => {
    await connect();
    mkdirSync(onDisk('tree/nested'), { recursive: true });
    writeFileSync(onDisk('tree/one.txt'), 'one');
    writeFileSync(onDisk('tree/nested/two.txt'), 'two');

    await vscode.workspace.fs.delete(remoteUri(ALIAS, '/tree'), { recursive: true });
    equal(existsSync(onDisk('tree')), false, 'the whole tree must go');
  });

  test('deleting a link to a directory removes the link and never the contents', async () => {
    // recursive:true is the dangerous case: the provider used to stat the path, which follows
    // the link, and then walked into the target deleting everything it found there.
    await connect();
    mkdirSync(onDisk('link-target'), { recursive: true });
    writeFileSync(onDisk('link-target/keep.txt'), 'keep');
    symlinkSync(onDisk('link-target'), onDisk('dir-link'));

    await vscode.workspace.fs.delete(remoteUri(ALIAS, '/dir-link'), { recursive: true });

    equal(existsSync(onDisk('dir-link')), false, 'the link itself must be gone');
    equal(
      readFileSync(onDisk('link-target/keep.txt'), 'utf8'),
      'keep',
      'what it pointed at must be untouched'
    );
  });

  test('renaming moves the file and leaves nothing behind', async () => {
    await connect();
    writeFileSync(onDisk('old-name.txt'), 'unchanged');

    await vscode.workspace.fs.rename(
      remoteUri(ALIAS, '/old-name.txt'),
      remoteUri(ALIAS, '/new-name.txt'),
      { overwrite: false }
    );

    equal(existsSync(onDisk('old-name.txt')), false, 'the old name is gone');
    equal(readFileSync(onDisk('new-name.txt'), 'utf8'), 'unchanged', 'the contents came along');
  });

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  test('a missing file becomes FileNotFound, not a generic failure', async () => {
    // This is the mapping that matters most: VS Code shows its own "file does not exist"
    // handling only for this specific error, and anything else surfaces as a raw message.
    await connect();
    await rejects(
      () => Promise.resolve(vscode.workspace.fs.stat(remoteUri(ALIAS, '/not-here.txt'))),
      (error) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound',
      'stat of a missing file'
    );
  });

  test('reading a missing file is also FileNotFound', async () => {
    await connect();
    await rejects(
      () => Promise.resolve(vscode.workspace.fs.readFile(remoteUri(ALIAS, '/not-here.txt'))),
      (error) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound',
      'readFile of a missing file'
    );
  });

  test('listing something that is not a directory is refused', async () => {
    await connect();
    writeFileSync(onDisk('a-file.txt'), 'x');
    await rejects(
      () => Promise.resolve(vscode.workspace.fs.readDirectory(remoteUri(ALIAS, '/a-file.txt'))),
      (error) => error instanceof vscode.FileSystemError,
      'readDirectory of a file'
    );
  });

  test('a rename onto an existing name does not silently overwrite', async () => {
    // posix-rename is atomic and replaces the destination without complaint, so refusing has
    // to be done deliberately. Getting this wrong destroys a file the user never named.
    await connect();
    writeFileSync(onDisk('source.txt'), 'source');
    writeFileSync(onDisk('occupied.txt'), 'occupied');

    await rejects(
      () =>
        Promise.resolve(
          vscode.workspace.fs.rename(
            remoteUri(ALIAS, '/source.txt'),
            remoteUri(ALIAS, '/occupied.txt'),
            { overwrite: false }
          )
        ),
      (error) => error instanceof vscode.FileSystemError && error.code === 'FileExists',
      'rename onto a taken name'
    );
    equal(
      readFileSync(onDisk('occupied.txt'), 'utf8'),
      'occupied',
      'the destination must survive intact'
    );
    equal(existsSync(onDisk('source.txt')), true, 'and the source must not have moved');
  });
});
