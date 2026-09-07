import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  formatModified,
  formatSize,
  parentRemotePath,
  parseBrowserMessage,
  resolveDisplayPath,
  type BrowserEntry,
  type BrowserState,
  type DirectoryHistoryStore,
  type Logger
} from '@remote-sftp-explorer/core';
import type { SessionManager } from '../sessionManager.ts';
import { renderBrowserHtml } from './webviewHtml.ts';
import { remoteUri } from '../fs/remoteUri.ts';

export const FILES_VIEW_ID = 'remoteSftp.files';

export interface FilesWebviewOptions {
  sessions: SessionManager;
  history: DirectoryHistoryStore;
  logger: Logger;
  clientScriptPath: string;
  clientStylePath: string;
  onAddFavorite(entry: { path: string; type: 'file' | 'directory'; name: string }): void;
}

/**
 * The remote file browser.
 *
 * A webview rather than a TreeView, for the reasons and at the costs recorded in ADR-0001.
 * The security posture that decision depends on is enforced here: a nonce-only CSP, no
 * addressable local resources, and messages validated in both directions.
 */
export class FilesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #options: FilesWebviewOptions;
  #view: vscode.WebviewView | undefined;
  #currentPath: string | undefined;
  #entries: BrowserEntry[] = [];
  #offline = false;
  #error: string | undefined;
  /**
   * The last host and root we knew about.
   *
   * `sessions.alias` goes undefined the moment a connection drops, which during a reconnect
   * would otherwise blank the path field and empty the recent-directory list until the session
   * came back. Remembering them keeps the panel showing where the user actually is.
   */
  #lastAlias: string | undefined;
  #lastRootPath: string | undefined;
  /** Last known listing per host+path, so a dropped connection still shows something. */
  readonly #cache = new Map<string, BrowserEntry[]>();

  constructor(options: FilesWebviewOptions) {
    this.#options = options;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = {
      enableScripts: true,
      // Nothing on disk is addressable from the page; the client is inlined under the nonce.
      localResourceRoots: []
    };

    const nonce = randomBytes(18).toString('base64url');
    view.webview.html = renderBrowserHtml({
      nonce,
      cspSource: view.webview.cspSource,
      script: readFileSync(this.#options.clientScriptPath, 'utf8'),
      style: readFileSync(this.#options.clientStylePath, 'utf8')
    });

    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseBrowserMessage(raw);
      if (message === undefined) {
        this.#options.logger.debug('Discarded an unrecognised message from the file browser.');
        return;
      }
      void this.#handle(message);
    });

    view.onDidDispose(() => {
      this.#view = undefined;
    });
  }

  async navigate(path: string): Promise<void> {
    const alias = this.#options.sessions.alias ?? this.#lastAlias;
    if (alias === undefined) {
      // Nothing to browse, but the panel must still be told that -- returning silently is
      // what previously left the path field blank with no explanation.
      this.#error = 'Connect to an SSH host to browse remote files.';
      this.#post();
      return;
    }
    this.#lastAlias = alias;

    this.#error = undefined;
    try {
      const active = await this.#options.sessions.require(alias);
      const entries = await active.list(path);
      const rows = entries.map(toBrowserEntry);
      this.#cache.set(cacheKey(alias, path), rows);
      this.#entries = rows;
      this.#currentPath = path;
      this.#offline = false;
      await this.#options.history.record(alias, path);
    } catch (error) {
      // Falling back to cache keeps the panel useful while disconnected, but the user is told
      // that is what happened rather than being shown stale data as if it were live.
      const cached = this.#cache.get(cacheKey(alias, path));
      if (cached === undefined) {
        // The listing failed, so the entries still belong to wherever we were before. Leave
        // #currentPath alone: the path bar must agree with the rows beneath it, and claiming
        // to be somewhere we could not reach would be worse than showing the last good path.
        this.#error = describe(error);
      } else {
        this.#entries = cached;
        this.#currentPath = path;
        this.#offline = true;
        this.#error = undefined;
      }
    }
    this.#post();
  }

  /**
   * Re-read the current directory.
   *
   * Always posts, even when there is nowhere to go. The panel's state is driven entirely by
   * these messages, so an early return leaves whatever the page last rendered -- on first open
   * that is an empty path field, which is the bug this guards against.
   */
  async refresh(): Promise<void> {
    const path =
      this.#currentPath ?? this.#options.sessions.session?.rootPath ?? this.#lastRootPath;
    if (path === undefined) {
      this.#post();
      return;
    }
    await this.navigate(path);
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${FILES_VIEW_ID}.focus`);
  }

  dispose(): void {
    this.#cache.clear();
  }

  async #handle(message: ReturnType<typeof parseBrowserMessage>): Promise<void> {
    if (message === undefined) return;
    switch (message.type) {
      case 'ready':
        await this.refresh();
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'navigate':
      case 'navigateHistory':
        await this.navigate(message.path);
        return;
      case 'navigateParent': {
        if (this.#currentPath !== undefined) {
          await this.navigate(parentRemotePath(this.#currentPath));
        }
        return;
      }
      case 'openEntry': {
        const alias = this.#options.sessions.alias;
        if (alias === undefined) return;
        const entry = this.#entries.find((candidate) => candidate.path === message.path);
        if (entry?.type === 'directory') {
          await this.navigate(message.path);
          return;
        }
        // preview:false opens a real tab. The default preview tab is reused by the next file
        // opened, so double-clicking a second file would replace the first rather than sit
        // beside it -- which is not what opening two files is meant to do.
        await vscode.commands.executeCommand('vscode.open', remoteUri(alias, message.path), {
          preview: false
        });
        return;
      }
      case 'clearHistory': {
        const alias = this.#options.sessions.alias;
        if (alias !== undefined) await this.#options.history.clear(alias);
        this.#post();
        return;
      }
      case 'addFavorite': {
        const entry = this.#entries.find((candidate) => candidate.path === message.path);
        if (entry === undefined || entry.type === 'other' || entry.type === 'symlink') return;
        this.#options.onAddFavorite({
          path: entry.path,
          type: entry.type,
          name: entry.name
        });
        return;
      }
      default:
        return;
    }
  }

  #post(): void {
    const view = this.#view;
    if (view === undefined) return;

    const rootPath = this.#options.sessions.session?.rootPath ?? this.#lastRootPath;
    if (rootPath !== undefined) this.#lastRootPath = rootPath;

    const alias = this.#options.sessions.alias ?? this.#lastAlias;
    const state: BrowserState = {
      alias: alias ?? '',
      path: resolveDisplayPath({
        currentPath: this.#currentPath,
        sessionRoot: this.#options.sessions.session?.rootPath,
        lastRoot: this.#lastRootPath
      }),
      rootPath: rootPath ?? '/',
      entries: this.#entries,
      history: alias === undefined ? [] : this.#options.history.forAlias(alias),
      offline: this.#offline,
      status: this.#offline ? 'Showing cached contents; the connection is down.' : '',
      ...(this.#error === undefined ? {} : { error: this.#error })
    };
    void view.webview.postMessage({ type: 'state', state });
  }
}

function toBrowserEntry(entry: {
  name: string;
  path: string;
  type: BrowserEntry['type'];
  size: bigint;
  mtime: number | undefined;
}): BrowserEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    sizeLabel: formatSize(entry.size, entry.type),
    modifiedLabel: formatModified(entry.mtime),
    // Raw values travel too, so the client can sort without asking the server again. Number()
    // is safe here: postMessage cannot carry a bigint, and a size beyond 2^53 bytes is not a
    // real file.
    sizeBytes: Number(entry.size),
    mtime: entry.mtime ?? 0,
    canFavorite: entry.type === 'file' || entry.type === 'directory'
  };
}

function cacheKey(alias: string, path: string): string {
  return `${alias} ${path}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
