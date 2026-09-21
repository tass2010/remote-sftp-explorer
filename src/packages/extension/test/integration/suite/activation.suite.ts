import * as vscode from 'vscode';
import { equal, ok, suite } from './harness.ts';
import { api, EXTENSION_ID } from './support.ts';

/**
 * Activation.
 *
 * Until this existed, nothing had ever run `activate()`. Every defect in it -- a bad import, a
 * command registered under the wrong id, a view provider that throws while being constructed
 * -- would have reached a user as "the extension does nothing" with a line in a log nobody
 * has open.
 */
export const activationSuite = suite('activation', (test) => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.all.find((candidate) =>
      candidate.id.endsWith(EXTENSION_ID)
    );
    ok(extension !== undefined, 'the extension under development must be loaded');
    await api();
    equal(extension.isActive, true, 'activate() must have completed');
  });

  test('every contributed command is registered with VS Code itself', async () => {
    // manifest.test.ts proves the source contains a matching registerCommand call. This proves
    // the call actually ran: a handler behind an early return, or after a throw, is contributed
    // and dead, and only the running editor can tell the difference.
    await api();
    const registered = new Set(await vscode.commands.getCommands(true));
    const extension = vscode.extensions.all.find((candidate) =>
      candidate.id.endsWith(EXTENSION_ID)
    );
    const contributed = (
      extension?.packageJSON as { contributes: { commands: Array<{ command: string }> } }
    ).contributes.commands;

    ok(contributed.length > 0, 'the manifest must contribute commands');
    for (const entry of contributed) {
      ok(registered.has(entry.command), `${entry.command} is contributed but never registered`);
    }
  });

  test('the remote-sftp scheme has a file system provider behind it', async () => {
    const test = await api();
    ok(test.fileSystem !== undefined, 'the provider must be constructed');
    // Registration is proven by the scheme resolving at all: an unregistered scheme throws
    // "cannot resolve" rather than a file-not-found.
    let message = '';
    try {
      await vscode.workspace.fs.stat(
        vscode.Uri.from({ scheme: 'remote-sftp', authority: 'nobody', path: '/nothing' })
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    ok(
      !message.includes('ENOPRO') && !message.toLowerCase().includes('cannot read'),
      `the scheme must be registered; got ${message}`
    );
  });

  test('the platform gate was bypassed by the seam, not by luck', async () => {
    // Everything else in this file depends on the override having taken effect. If it had
    // not, activate() would have returned early on this machine and every other test would
    // fail for a reason that has nothing to do with what it is checking.
    const test = await api();
    ok(test.sessions !== undefined, 'activation ran past the platform gate');
    if (process.platform !== 'win32') {
      ok(
        test.fileSystem !== undefined,
        'on a non-Windows host only the test override can have got us here'
      );
    }
  });
});
