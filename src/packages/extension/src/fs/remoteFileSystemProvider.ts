import * as vscode from 'vscode';
import {
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
      return entries.map((entry) => [entry.name, toFileType(entry.type)] as [string, vscode.FileType]);
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

      const { content, baseline } = await session.readFile(path);
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

      if (!options.overwrite && known !== undefined) {
        throw vscode.FileSystemError.FileExists(uri);
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
            onConflict: (current) => this.#askAboutConflict(path, current)
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
      const entry = await session.stat(path);

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
    _options: { readonly overwrite: boolean }
  ): Promise<void> {
    return this.#guard(oldUri, async () => {
      const session = await this.#sessions.require();
      await session.rename(remotePathOf(oldUri), remotePathOf(newUri));
      this.#documents.delete(oldUri.toString());
      this.#emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
    });
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

  async #askAboutConflict(path: string, current: RemoteBaseline): Promise<boolean> {
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
      // Dropping the cached baseline makes the next open re-read from the server.
      this.#documents.clear();
      void vscode.commands.executeCommand('workbench.action.files.revert');
      return false;
    }
    return false;
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
