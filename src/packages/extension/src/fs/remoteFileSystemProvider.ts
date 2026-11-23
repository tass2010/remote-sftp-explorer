import * as vscode from 'vscode';
import {
  classifyRemoteError,
  parentRemotePath,
  type Logger,
  type RemoteBaseline,
  type RemoteEntry
} from '@remote-sftp-explorer/core';
import type { SessionManager } from '../sessionManager.ts';
import { toFileSystemError } from './errorMapping.ts';
import { remotePathOf, REMOTE_SCHEME } from './remoteUri.ts';

/** Above this, opening asks first; above the hard limit it is refused. See docs/01-product.md. */
export const WARN_OPEN_BYTES = 20 * 1024 * 1024;
export const MAX_OPEN_BYTES = 100 * 1024 * 1024;

interface OpenDocument {
  content: Uint8Array;
  baseline: RemoteBaseline;
}

/**
 * Bridges VS Code's filesystem API onto a RemoteSession.
 *
 * Deliberately thin: conflict detection, locking, and safe replacement all live in core. What
 * belongs here is the parts that are genuinely about VS Code -- size policy, the save
 * confirmation, and error translation.
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  readonly #sessions: SessionManager;
  readonly #logger: Logger;
  readonly #documents = new Map<string, OpenDocument>();
  readonly #emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.#emitter.event;

  constructor(sessions: SessionManager, logger: Logger) {
    this.#sessions = sessions;
    this.#logger = logger;
  }

  /** v1 does not observe server-side changes; see docs/01-product.md. */
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const entry = await session.stat(remotePathOf(uri));
      return toFileStat(entry);
    });
  }

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const entries = await session.list(remotePathOf(uri));
      return Promise.all(
        entries.map(async (entry): Promise<[string, vscode.FileType]> => {
          if (entry.type !== 'symlink') return [entry.name, toFileType(entry.type)];
          // VS Code expects a link to carry its target's type alongside the link bit; reporting
          // every link as a file made a link to a directory unexpandable. One STAT per link,
          // and only for links, which are rare enough in a listing for that to be cheap.
          try {
            const target = await session.stat(entry.path);
            return [entry.name, vscode.FileType.SymbolicLink | toFileType(target.type)];
          } catch {
            // Dangling: there is nothing behind the link to describe.
            return [entry.name, vscode.FileType.SymbolicLink | vscode.FileType.Unknown];
          }
        })
      );
    });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const path = remotePathOf(uri);
      const stat = await session.stat(path);

      if (stat.type === 'directory') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (stat.type === 'other') {
        throw vscode.FileSystemError.NoPermissions(
          'Special files cannot be opened in the editor.'
        );
      }

      const size = Number(stat.size);
      if (size > MAX_OPEN_BYTES) {
        throw vscode.FileSystemError.NoPermissions(
          `${path} is ${formatMiB(size)}, over the ${formatMiB(MAX_OPEN_BYTES)} editor limit.`
        );
      }
      if (size > WARN_OPEN_BYTES) {
        // The whole file enters Extension Host memory, so this is a real cost, not a formality.
        const choice = await vscode.window.showWarningMessage(
          `${path} is ${formatMiB(size)}. Opening it may slow VS Code down.`,
          { modal: true },
          'Open anyway'
        );
        if (choice !== 'Open anyway') throw new vscode.CancellationError();
      }

      // The stat above already answered this; passing it down saves a round trip per open.
      const { content, baseline } = await session.readFile(path, {
        known: { size: stat.size, mtime: stat.mtime }
      });
      this.#documents.set(uri.toString(), { content, baseline });
      return content;
    });
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const path = remotePathOf(uri);
      const known = this.#documents.get(uri.toString());

      // The contract VS Code relies on, checked before the user is asked anything. An ordinary
      // save passes create and overwrite both true, so this costs a round trip only when a
      // caller actually asked for one of the two refusals.
      if (!options.create || !options.overwrite) {
        const exists = await this.#exists(session, path);
        if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
        if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      }

      // Every save is confirmed. Declining throws, which leaves the editor dirty -- VS Code's
      // own hot-exit backup is what protects the draft from here (ADR-0005).
      const choice = await vscode.window.showWarningMessage(
        `Update ${path} on ${session.alias}?`,
        { modal: true, detail: 'The new content will replace the file on the remote server.' },
        'Update Remote'
      );
      if (choice !== 'Update Remote') {
        throw new vscode.CancellationError();
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating ${path}`,
          cancellable: false
        },
        () =>
          session.writeFile(path, content, {
            expected: known?.baseline,
            onConflict: (current) => this.#askAboutConflict(uri, path, current)
          })
      );

      if (result.orphanedBackup !== undefined) {
        // The save succeeded; this is housekeeping the user may want to clean up by hand.
        void vscode.window.showWarningMessage(
          `Saved ${path}, but a backup was left at ${result.orphanedBackup}.`
        );
      }

      try {
        this.#documents.set(uri.toString(), { content, baseline: await session.baseline(path) });
      } catch {
        // A refreshed baseline is an optimisation; losing it only costs an extra check later.
        this.#documents.delete(uri.toString());
      }

      this.#emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.#logger.info(`Updated ${path} on ${session.alias}.`);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const path = remotePathOf(uri);
      await session.createDirectory(path);
      this.#fireParentChanged(uri, path);
    });
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    return this.#guard(uri, async () => {
      const session = await this.#sessions.require();
      const path = remotePathOf(uri);
      // lstat, not stat: stat follows a link to a directory and reports the directory, and a
      // recursive delete would then empty the target rather than remove the link.
      const entry = await session.lstat(path);

      if (entry.type === 'directory') {
        if (!options.recursive) {
          await session.removeDirectory(path);
        } else {
          await this.#deleteRecursively(session, path);
        }
      } else {
        // Deleting a symlink removes the link, never what it points at.
        await session.remove(path);
      }

      this.#documents.delete(uri.toString());
      this.#fireParentChanged(uri, path);
    });
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    return this.#guard(oldUri, async () => {
      const session = await this.#sessions.require();
      const destination = remotePathOf(newUri);

      if (!options.overwrite) {
        // `posix-rename@openssh.com` is atomic and silently replaces the destination, so
        // without this the extension would offer to refuse an overwrite and then perform one.
        // The gap between the check and the rename cannot be closed from here; a check with a
        // gap still beats no check, and on servers without the extension plain v3 RENAME
        // refuses on its own.
        if (await this.#exists(session, destination)) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
      }

      await session.rename(remotePathOf(oldUri), destination);
      this.#documents.delete(oldUri.toString());
      this.#emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
    });
  }

  /** Only "no such file" means absent; a dropped connection must not read as permission to create. */
  async #exists(
    session: Awaited<ReturnType<SessionManager['require']>>,
    path: string
  ): Promise<boolean> {
    try {
      await session.lstat(path);
      return true;
    } catch (error) {
      if (classifyRemoteError(error).kind === 'not-found') return false;
      throw error;
    }
  }

  /** Forget a document's cached baseline when its editor closes. */
  release(uri: vscode.Uri): void {
    if (uri.scheme === REMOTE_SCHEME) this.#documents.delete(uri.toString());
  }

  dispose(): void {
    this.#emitter.dispose();
    this.#documents.clear();
  }

  async #deleteRecursively(
    session: Awaited<ReturnType<SessionManager['require']>>,
    path: string
  ): Promise<void> {
    // Depth-first, and never following a symlink into its target: deleting a link must not
    // delete what it points at.
    const entries = await session.list(path);
    for (const entry of entries) {
      if (entry.type === 'directory') await this.#deleteRecursively(session, entry.path);
      else await session.remove(entry.path);
    }
    await session.removeDirectory(path);
  }

  async #askAboutConflict(
    uri: vscode.Uri,
    path: string,
    current: RemoteBaseline
  ): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `${path} changed on the server since you opened it.`,
      {
        modal: true,
        detail:
          `The file is now ${current.size} bytes. Overwriting discards the other changes.`
      },
      'Overwrite Remote',
      'Discard My Changes and Reload'
    );

    if (choice === 'Overwrite Remote') return true;
    if (choice === 'Discard My Changes and Reload') {
      // This document only. Clearing every baseline left the other open files with no
      // `expected` to compare against, so their next save skipped conflict detection and
      // could silently overwrite someone else's change.
      this.#documents.delete(uri.toString());
      // Not awaited: the save that asked is still holding this path's write lock.
      void this.#reload(uri);
      return false;
    }
    return false;
  }

  /**
   * Revert one document to what the server has.
   *
   * The revert command acts on the active editor, which during Save All need not be the file
   * that conflicted, so the right document is brought forward first.
   */
  async #reload(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.window.showTextDocument(uri, { preview: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } catch (error) {
      this.#logger.warn(`Could not reload ${uri.path} from the server.`, error);
    }
  }

  #fireParentChanged(uri: vscode.Uri, path: string): void {
    this.#emitter.fire([
      { type: vscode.FileChangeType.Changed, uri: uri.with({ path: parentRemotePath(path) }) }
    ]);
  }

  /** Run an operation, translating any failure into the matching VS Code error. */
  async #guard<T>(uri: vscode.Uri, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toFileSystemError(error, uri);
    }
  }
}

function toFileType(type: RemoteEntry['type']): vscode.FileType {
  switch (type) {
    case 'directory':
      return vscode.FileType.Directory;
    case 'file':
      return vscode.FileType.File;
    case 'symlink':
      return vscode.FileType.SymbolicLink | vscode.FileType.File;
    default:
      return vscode.FileType.Unknown;
  }
}

function toFileStat(entry: RemoteEntry): vscode.FileStat {
  const mtime = (entry.mtime ?? 0) * 1000;
  return {
    type: toFileType(entry.type),
    ctime: mtime,
    mtime,
    size: Number(entry.size)
  };
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
