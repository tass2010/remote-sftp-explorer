import * as vscode from 'vscode';
import {
  describeNameProblem,
  joinRemotePath,
  nameStemRange,
  parentRemotePath,
  remoteBaseName,
  type BrowserEntry
} from '@remote-sftp-explorer/core';
import { remoteUri } from '../fs/remoteUri.ts';
import { runWithProgress } from '../ui/progress.ts';
import type { RemoteFileSystemProvider } from '../fs/remoteFileSystemProvider.ts';
import type { SessionManager } from '../sessionManager.ts';
import type { FilesWebviewProvider } from '../views/filesWebview.ts';

/**
 * Creating, renaming and deleting remote entries.
 *
 * The operations themselves already existed on RemoteSession and on the file system provider;
 * what was missing was any way for a user to reach them. Everything here is that reachable
 * half: choosing a target, asking for a name, confirming a deletion, reporting what happened.
 *
 * Each command works from two directions -- the browser's context menu, which passes the path
 * it was opened over, and the command palette, which passes nothing and falls back to the
 * highlighted row. One implementation serves both, so the two cannot drift apart.
 */
export interface FileOperationDependencies {
  sessions: SessionManager;
  files: FilesWebviewProvider;
  /**
   * Called directly, not through VS Code's workspace file API.
   *
   * Sending a remote-sftp URI through that API would arrive right back at this same provider,
   * having gained nothing -- it fires its own change events either way -- while making this
   * extension a caller of an API that reads the open workspace. manifest.test.ts treats any
   * such call as grounds to re-examine the untrusted-workspace claim, and relaxing a check
   * about trust to buy a redundant round trip would be the wrong trade.
   */
  fileSystem: RemoteFileSystemProvider;
}

export function registerFileOperations(
  context: vscode.ExtensionContext,
  dependencies: FileOperationDependencies
): void {
  const { sessions, files, fileSystem } = dependencies;

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  /** Changing anything needs both a live host and somewhere for the result to land. */
  function requireConnection(): { alias: string; directory: string } | undefined {
    const alias = sessions.alias;
    const directory = files.currentDirectory ?? sessions.session?.rootPath;
    if (alias === undefined || directory === undefined) {
      void vscode.window.showInformationMessage(
        'Connect to an SSH host before creating or changing remote files.'
      );
      return undefined;
    }
    return { alias, directory };
  }

  /**
   * Which entry a command acts on.
   *
   * A path from the context menu is still looked up rather than used as given: the listing may
   * have been refreshed since the menu opened, and an entry that is no longer there is exactly
   * the case where acting anyway would be wrong.
   */
  function resolveTarget(target: string | undefined): BrowserEntry | undefined {
    const found = target === undefined ? undefined : files.entryAt(target);
    const entry = found ?? files.selectedEntry;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('Select a file or folder in Remote Files first.');
      return undefined;
    }
    return entry;
  }

  async function promptForName(options: {
    title: string;
    prompt: string;
    value: string;
    current?: string | undefined;
  }): Promise<string | undefined> {
    const selection = nameStemRange(options.value);
    const taken = files.entryNames;

    const answer = await vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      value: options.value,
      // Preselecting the stem means renaming does not begin with deleting the extension.
      ...(selection === undefined ? {} : { valueSelection: selection }),
      // A prompt that vanishes when the user glances at another window loses what they typed.
      ignoreFocusOut: true,
      validateInput: (candidate) =>
        describeNameProblem(candidate, { taken, current: options.current })
    });

    if (answer === undefined) return undefined;
    // Confirming the name something already has is a no-op, not a rename onto itself.
    if (options.current !== undefined && answer === options.current) return undefined;
    return answer;
  }

  async function create(kind: 'file' | 'directory'): Promise<void> {
    const where = requireConnection();
    if (where === undefined) return;

    const name = await promptForName({
      title: kind === 'file' ? 'New File' : 'New Folder',
      prompt: `Create in ${where.directory}`,
      value: ''
    });
    if (name === undefined) return;

    const path = joinRemotePath(where.directory, name);
    await runWithProgress(`Creating ${name}`, async () => {
      if (kind === 'directory') {
        await fileSystem.createDirectory(remoteUri(where.alias, path));
      } else {
        // Not a write of empty content: that asks for create-and-overwrite, which would
        // silently truncate a file appearing between the name check and the write. createFile
        // opens with EXCL, so the server refuses rather than destroying anything.
        const session = await sessions.require(where.alias);
        await session.createFile(path);
      }
      await files.refresh();
      // A new folder is somewhere to go; a new file is something to write in. Opening it is
      // what VS Code's own explorer does, and it saves a second interaction.
      if (kind === 'file') {
        await vscode.commands.executeCommand('vscode.open', remoteUri(where.alias, path), {
          preview: false
        });
      }
    });
  }

  register('remoteSftp.newFile', async () => {
    await create('file');
  });

  register('remoteSftp.newFolder', async () => {
    await create('directory');
  });

  register('remoteSftp.rename', async (target?: string) => {
    const where = requireConnection();
    if (where === undefined) return;
    const entry = resolveTarget(target);
    if (entry === undefined) return;

    const currentName = remoteBaseName(entry.path);
    const name = await promptForName({
      title: 'Rename',
      prompt: `Rename ${currentName}`,
      value: currentName,
      current: currentName
    });
    if (name === undefined) return;

    const destination = joinRemotePath(parentRemotePath(entry.path), name);
    await runWithProgress(`Renaming ${currentName}`, async () => {
      await fileSystem.rename(
        remoteUri(where.alias, entry.path),
        remoteUri(where.alias, destination),
        // Never overwrite: a rename landing on an existing name must fail loudly, because what
        // it would destroy is not the thing the user was looking at.
        { overwrite: false }
      );
      await files.refresh();
    });
  });

  register('remoteSftp.delete', async (target?: string) => {
    const where = requireConnection();
    if (where === undefined) return;
    const entry = resolveTarget(target);
    if (entry === undefined) return;

    if (entry.path === '/') {
      void vscode.window.showErrorMessage('The filesystem root cannot be deleted.');
      return;
    }

    const confirmed = await confirmDelete(entry, where.alias);
    if (confirmed === undefined) return;

    await runWithProgress(`Deleting ${entry.name}`, async () => {
      await fileSystem.delete(remoteUri(where.alias, entry.path), {
        recursive: confirmed.recursive
      });
      await files.refresh();
    });
  });

  /**
   * Ask before deleting, saying what is actually about to be deleted.
   *
   * "Delete this folder" and "delete this folder and the four hundred things inside it" call
   * for different answers, and the user can only weigh that if the dialog says which one is
   * about to happen. So a directory is counted before the question is asked.
   */
  async function confirmDelete(
    entry: BrowserEntry,
    alias: string
  ): Promise<{ recursive: boolean } | undefined> {
    const undone = `This deletes it on ${alias}. It cannot be undone.`;
    let recursive = false;
    let detail = undone;

    if (entry.type === 'directory') {
      const children = await countChildren(entry.path);
      if (children === undefined) {
        // Not being able to count is a reason to say so, not a reason to quietly escalate to a
        // recursive delete on less information than usual.
        detail = `Its contents could not be listed, so it is deleted only if empty. ${undone}`;
      } else if (children > 0) {
        recursive = true;
        const items = children === 1 ? 'item' : 'items';
        detail = `It contains ${children} ${items}, which are deleted too. ${undone}`;
      }
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete ${entry.name}?`,
      { modal: true, detail },
      'Delete'
    );
    return choice === 'Delete' ? { recursive } : undefined;
  }

  async function countChildren(path: string): Promise<number | undefined> {
    try {
      const session = await sessions.require();
      return (await session.list(path)).length;
    } catch {
      return undefined;
    }
  }
}
