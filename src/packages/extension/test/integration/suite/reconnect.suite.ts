import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { equal, ok, suite, waitFor } from './harness.ts';
import { ALIAS, connect, fakeRoot, remoteUri } from './support.ts';

/**
 * Losing the connection and getting it back.
 *
 * The fake server exits when asked for `/.disconnect`, which from the client's side is what a
 * dropped link looks like: the pipe closes with requests still outstanding. Nothing here
 * simulates the state machine -- the real SessionManager sees a real child process die.
 */
export const reconnectSuite = suite('reconnection', (test) => {
  const drop = async (): Promise<void> => {
    // The stat itself is expected to fail; the point is the server exiting while it runs.
    await vscode.workspace.fs
      .stat(remoteUri(ALIAS, '/.disconnect'))
      .then(
        () => undefined,
        () => undefined
      );
  };

  test('a dropped connection is noticed rather than leaving a dead session behind', async () => {
    const test_ = await connect();
    equal(test_.sessions.alias, ALIAS, 'connected to begin with');

    await drop();
    await waitFor('the manager to notice the session is gone', () => test_.sessions.session === undefined);
  });

  test('the state model reports the loss instead of staying on connected', async () => {
    const test_ = await connect();
    const seen: string[] = [];
    const stop = test_.state.subscribe((snapshot) => seen.push(snapshot.status));

    await drop();
    await waitFor('a status other than connected', () =>
      seen.some((status) => status === 'reconnecting' || status === 'failed')
    );
    stop();

    ok(
      seen.includes('reconnecting') || seen.includes('failed'),
      `expected the connection state to move on, saw ${seen.join(' -> ')}`
    );
  });

  test('connecting again after a drop gives a working session', async () => {
    // Whether the automatic retry or the user gets there first, the requirement is the same:
    // the next connection must work, and must not be poisoned by the abandoned requests from
    // the one that died.
    const test_ = await connect();
    await drop();
    await waitFor('the session to be released', () => test_.sessions.session === undefined);

    await test_.sessions.connect(ALIAS);
    await waitFor('the replacement session', () => test_.sessions.alias === ALIAS);

    writeFileSync(join(fakeRoot(), 'after-reconnect.txt'), 'still working');
    const bytes = await vscode.workspace.fs.readFile(remoteUri(ALIAS, '/after-reconnect.txt'));
    equal(
      new TextDecoder().decode(bytes),
      'still working',
      'the new session must serve reads normally'
    );
  });

  test('the file browser recovers once the connection is back', async () => {
    const test_ = await connect();
    await drop();
    await waitFor('the session to be released', () => test_.sessions.session === undefined);
    await test_.sessions.connect(ALIAS);
    await waitFor('the replacement session', () => test_.sessions.alias === ALIAS);

    await vscode.commands.executeCommand('remoteSftp.refreshFiles');
    await waitFor('the listing to come back', () => test_.files.entryNames.length > 0);
    ok(
      test_.files.entryNames.includes('notes.txt'),
      `expected the fixture listing back, saw ${test_.files.entryNames.join(', ')}`
    );
  });
});
