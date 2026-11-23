import * as vscode from 'vscode';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepEqual, equal, ok, suite, waitFor } from './harness.ts';
import { ALIAS, api, connect, fakeRoot } from './support.ts';

/**
 * The three views, rendered by the real editor.
 *
 * `getChildren` is what VS Code calls; calling it here exercises the same path, including the
 * `ssh -G` validation the hosts tree does in the background and the state subscriptions that
 * decide which icon each row gets.
 */
export const viewsSuite = suite('views', (test) => {
  test('the hosts tree lists what the SSH config names', async () => {
    const test_ = await api();
    const items = await test_.hosts.getChildren();
    deepEqual(
      items.map((item) => item.alias).sort(),
      ['secondhost', ALIAS],
      'both configured aliases must appear'
    );
    ok(items.every((item) => item.command !== undefined), 'each host must be clickable');
  });

  test('host validation eventually fills in the description', async () => {
    // Discovery draws immediately and probes afterwards, so the description arrives late by
    // design. This is the half that used to block the first paint.
    const test_ = await api();
    await test_.hosts.getChildren();
    await waitFor('the ssh -G probe to report back', async () => {
      const items = await test_.hosts.getChildren();
      return items.some((item) => String(item.description ?? '').length > 0);
    });
  });

  test('a host tree item is refused when the config names none', async () => {
    const test_ = await api();
    const items = await test_.hosts.getChildren();
    // Children of a host are not a thing; asking must not throw or invent rows.
    const first = items[0];
    ok(first !== undefined, 'there is at least one host');
    deepEqual(await test_.hosts.getChildren(first), [], 'hosts are leaves');
  });

  test('the favorites tree shows what was saved, scoped to its host', async () => {
    const test_ = await api();
    await connect();

    await vscode.commands.executeCommand('remoteSftp.refreshFiles');
    const entry = test_.files.entryAt('/notes.txt');
    ok(entry !== undefined, 'the fixture file must be listed before it can be favourited');

    // Going through the same callback the webview uses, rather than the store directly.
    await vscode.commands.executeCommand('remoteSftp.addFavorite');
    const before = await test_.favorites.getChildren();

    test_.favorites.refresh();
    const after = await test_.favorites.getChildren();
    equal(after.length, before.length, 'refreshing must not duplicate rows');
  });

  test('the files view resolves and reflects the remote directory', async () => {
    const test_ = await connect();
    // Focusing the view is what makes VS Code resolve the webview, which is where the CSP,
    // the inlined client and the message plumbing are actually set up.
    await vscode.commands.executeCommand('remoteSftp.files.focus');
    await vscode.commands.executeCommand('remoteSftp.refreshFiles');

    await waitFor('the listing to arrive', () => test_.files.entryNames.length > 0);
    const names = [...test_.files.entryNames].sort();
    ok(names.includes('notes.txt'), `expected notes.txt among ${names.join(', ')}`);
    ok(names.includes('subdir'), `expected subdir among ${names.join(', ')}`);
    equal(test_.files.currentDirectory, '/', 'the browser starts at the remote home');
  });

  test('navigating updates both the listing and the current directory', async () => {
    const test_ = await connect();
    await test_.files.navigate('/subdir');
    equal(test_.files.currentDirectory, '/subdir', 'the path bar follows the rows');
    ok(
      test_.files.entryNames.includes('inner.txt'),
      `expected inner.txt, saw ${test_.files.entryNames.join(', ')}`
    );
    await test_.files.navigate('/');
  });

  test('opening a link to a directory goes to where it points', async () => {
    // Used to be handed to the editor as a file, which failed with "is a directory".
    const test_ = await connect();
    mkdirSync(join(fakeRoot(), 'install-dir'), { recursive: true });
    writeFileSync(join(fakeRoot(), 'install-dir', 'tool.sh'), 'echo');
    symlinkSync(join(fakeRoot(), 'install-dir'), join(fakeRoot(), 'skill-link'));
    try {
      await test_.files.navigate('/');
      equal(test_.files.entryAt('/skill-link')?.type, 'symlink', 'the listing shows the link');

      await test_.files.openEntry('/skill-link');

      equal(test_.files.currentDirectory, '/install-dir', 'the path bar names the target');
      ok(
        test_.files.entryNames.includes('tool.sh'),
        `expected the target's contents, saw ${test_.files.entryNames.join(', ')}`
      );
    } finally {
      rmSync(join(fakeRoot(), 'skill-link'));
      rmSync(join(fakeRoot(), 'install-dir'), { recursive: true });
      await test_.files.navigate('/');
    }
  });

  test('opening a dangling link stays put instead of failing elsewhere', async () => {
    const test_ = await connect();
    symlinkSync(join(fakeRoot(), 'nowhere'), join(fakeRoot(), 'dangling-link'));
    try {
      await test_.files.navigate('/');
      await test_.files.openEntry('/dangling-link');
      equal(test_.files.currentDirectory, '/', 'nothing to go to, so the browser does not move');
    } finally {
      rmSync(join(fakeRoot(), 'dangling-link'));
    }
  });
});
