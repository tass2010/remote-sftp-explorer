import * as vscode from 'vscode';
import { basename } from 'node:path';
import { unlink } from 'node:fs/promises';
import {
  describeProgress,
  formatBytes,
  joinRemotePath,
  type BrowserEntry,
  type Logger
} from '@remote-sftp-explorer/core';
import { NodeFileSink, NodeFileSource } from '../adapters/nodeTransfer.ts';
import { runTransferWithProgress } from '../ui/progress.ts';
import type { SessionManager } from '../sessionManager.ts';
import type { FilesWebviewProvider } from '../views/filesWebview.ts';

/**
 * Moving whole files between this machine and the server.
 *
 * Distinct from the create/rename/delete commands because the failure modes are different.
 * Those are single round trips that either work or do not; a transfer runs for minutes, over
 * a link that may be bad, and the interesting question is not whether it succeeded but what
 * to do while it has not finished yet.
 *
 * Three answers, and all three are needed:
 *   - say how fast it is going, so waiting is an informed decision rather than a guess;
 *   - offer Cancel, because only the person watching can judge "too slow to be worth it";
 *   - abandon it automatically when nothing moves at all, so a dead link fails instead of
 *     sitting there forever.
 */
export interface FileTransferDependencies {
  sessions: SessionManager;
  files: FilesWebviewProvider;
  logger: Logger;
}

export function registerFileTransfers(
  context: vscode.ExtensionContext,
  dependencies: FileTransferDependencies
): void {
  const { sessions, files, logger } = dependencies;

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  function requireConnection(): { alias: string; directory: string } | undefined {
    const alias = sessions.alias;
    const directory = files.currentDirectory ?? sessions.session?.rootPath;
    if (alias === undefined || directory === undefined) {
      void vscode.window.showInformationMessage('Connect to an SSH host first.');
      return undefined;
    }
    return { alias, directory };
  }

  function resolveTarget(target: string | undefined): BrowserEntry | undefined {
    const found = target === undefined ? undefined : files.entryAt(target);
    const entry = found ?? files.selectedEntry;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('Select a file in Remote Files first.');
      return undefined;
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  register('remoteSftp.download', async (target?: string) => {
    const where = requireConnection();
    if (where === undefined) return;
    const entry = resolveTarget(target);
    if (entry === undefined) return;

    if (entry.type === 'directory') {
      // Recursive download is a different feature with its own decisions to make about
      // collisions and partial trees. Refusing plainly beats half-doing it.
      void vscode.window.showInformationMessage(
        `${entry.name} is a folder. Only files can be downloaded.`
      );
      return;
    }

    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(entry.name),
      title: `Save ${entry.name}`,
      saveLabel: 'Download'
    });
    if (destination === undefined) return;

    const localPath = destination.fsPath;
    const outcome = await runTransferWithProgress(
      `Downloading ${entry.name} (${formatBytes(entry.sizeBytes)})`,
      async ({ report, signal }) => {
        const session = await sessions.require(where.alias);
        const sink = await NodeFileSink.create(localPath);
        await session.download(entry.path, sink, {
          signal,
          onProgress: (progress) => {
            report(
              describeProgress(progress),
              progress.total === 0 ? 100 : (progress.bytes / progress.total) * 100
            );
          }
        });
      }
    );

    if (outcome === 'done') {
      await offerToOpen(localPath, entry.name);
      return;
    }
    // A cancelled or failed download leaves a partial file that looks like the real thing.
    // Removing it is the only way the next person to look at that folder is not misled.
    await discardPartial(localPath, logger);
  });

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  register('remoteSftp.upload', async () => {
    const where = requireConnection();
    if (where === undefined) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: 'Upload',
      title: `Upload to ${where.directory}`
    });
    if (picked === undefined || picked.length === 0) return;

    const existing = new Set(files.entryNames);
    let uploaded = 0;

    for (const [index, uri] of picked.entries()) {
      const name = basename(uri.fsPath);
      const remotePath = joinRemotePath(where.directory, name);

      if (existing.has(name)) {
        const choice = await vscode.window.showWarningMessage(
          `${name} already exists in ${where.directory}.`,
          { modal: true, detail: 'Uploading replaces it. The original is not kept.' },
          'Replace',
          'Skip'
        );
        // Dismissing the dialog means neither, and must not be read as agreement.
        if (choice !== 'Replace') continue;
      }

      const counter = picked.length === 1 ? '' : ` (${index + 1} of ${picked.length})`;
      const outcome = await runTransferWithProgress(
        `Uploading ${name}${counter}`,
        async ({ report, signal }) => {
          const session = await sessions.require(where.alias);
          const source = await NodeFileSource.open(uri.fsPath);
          await session.upload(remotePath, source, {
            signal,
            onProgress: (progress) => {
              report(
                describeProgress(progress),
                progress.total === 0 ? 100 : (progress.bytes / progress.total) * 100
              );
            }
          });
        }
      );

      if (outcome === 'done') {
        uploaded += 1;
        continue;
      }
      // Stopping the whole batch on the first failure: if the link just died, grinding
      // through twenty more files to fail twenty more times helps nobody.
      if (outcome === 'failed') break;
      const carryOn = await vscode.window.showWarningMessage(
        `${name} was cancelled.`,
        { modal: true, detail: 'Continue with the remaining files?' },
        'Continue'
      );
      if (carryOn !== 'Continue') break;
    }

    if (uploaded > 0) await files.refresh();
  });

  async function offerToOpen(localPath: string, name: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Downloaded ${name}.`,
      'Open',
      'Reveal in Explorer'
    );
    if (choice === 'Open') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(localPath));
    } else if (choice === 'Reveal in Explorer') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(localPath));
    }
  }

  async function discardPartial(localPath: string, log: Logger): Promise<void> {
    try {
      await unlink(localPath);
    } catch (error) {
      // Not being able to tidy up is worth a line in the log, but the download has already
      // reported its own failure and a second dialog about the leftover would only confuse.
      log.warn(`Could not remove the incomplete download at ${localPath}.`, error);
    }
  }
}
