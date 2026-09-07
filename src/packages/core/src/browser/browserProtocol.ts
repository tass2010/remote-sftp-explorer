import { normalizeRemotePath } from '../fs/remotePath.ts';
import type { RemoteEntryType } from '@remote-sftp-explorer/sftp-protocol';

/**
 * The message contract between the extension host and the file-browser webview.
 *
 * Validated in BOTH directions against an allowlist. Messages from the webview are the more
 * obvious risk, but validating what we send keeps the client's assumptions honest too.
 */

export type BrowserMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'navigateParent' }
  | { type: 'clearHistory' }
  | { type: 'navigate'; path: string }
  | { type: 'navigateHistory'; path: string }
  | { type: 'openEntry'; path: string }
  | { type: 'addFavorite'; path: string };

const PATHLESS = new Set(['ready', 'refresh', 'navigateParent', 'clearHistory']);
const WITH_PATH = new Set(['navigate', 'navigateHistory', 'openEntry', 'addFavorite']);

/**
 * Parse a message from the webview, or return undefined.
 *
 * Anything not on the allowlist is dropped rather than passed along -- a webview that has been
 * compromised must not be able to reach an operation we did not intend to expose.
 */
export function parseBrowserMessage(value: unknown): BrowserMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { type?: unknown; path?: unknown };
  if (typeof candidate.type !== 'string') return undefined;

  if (PATHLESS.has(candidate.type)) {
    return { type: candidate.type } as BrowserMessage;
  }
  if (!WITH_PATH.has(candidate.type)) return undefined;
  if (typeof candidate.path !== 'string') return undefined;

  let path: string;
  try {
    // Normalising here means the rest of the system never sees a relative path or a traversal.
    path = normalizeRemotePath(candidate.path);
  } catch {
    return undefined;
  }
  return { type: candidate.type, path } as BrowserMessage;
}

/**
 * One row in the browser.
 *
 * Carries both the formatted text and the raw values behind it. The client sorts locally, so
 * changing the order costs nothing -- but it cannot sort by a string like "2.0 KB" or a
 * truncated date, so the numbers travel alongside their labels.
 */
export interface BrowserEntry {
  name: string;
  path: string;
  type: RemoteEntryType;
  sizeLabel: string;
  modifiedLabel: string;
  /** Bytes, as a number: postMessage cannot carry a bigint. */
  sizeBytes: number;
  /** Seconds since the epoch, or 0 when the server did not report one. */
  mtime: number;
  canFavorite: boolean;
}

export type SortKey = 'name' | 'size' | 'modified';
export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortOrder = { key: 'name', direction: 'asc' };

/**
 * Order the rows.
 *
 * Directories always come first, whatever the key or direction. Every file manager does this,
 * and the alternative -- sorting folders in among the files by size or date -- makes a
 * directory listing much harder to navigate.
 *
 * Name is the final tiebreaker so the order is total: two files of equal size would otherwise
 * swap places between listings for no visible reason.
 */
export function sortBrowserEntries(
  entries: readonly BrowserEntry[],
  order: SortOrder
): BrowserEntry[] {
  const sign = order.direction === 'asc' ? 1 : -1;

  return [...entries].sort((a, b) => {
    const aIsDirectory = a.type === 'directory' ? 0 : 1;
    const bIsDirectory = b.type === 'directory' ? 0 : 1;
    if (aIsDirectory !== bIsDirectory) return aIsDirectory - bIsDirectory;

    let compared = 0;
    if (order.key === 'size') compared = a.sizeBytes - b.sizeBytes;
    else if (order.key === 'modified') compared = a.mtime - b.mtime;
    else compared = compareNames(a.name, b.name);

    if (compared !== 0) return compared * sign;
    // The tiebreaker is not reversed: within equal keys the names stay alphabetical, which
    // reads better than having them flip when the direction changes.
    return compareNames(a.name, b.name);
  });
}

function compareNames(a: string, b: string): number {
  // numeric:true so file10 sorts after file9 rather than before it.
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export interface BrowserState {
  alias: string;
  path: string;
  rootPath: string;
  entries: BrowserEntry[];
  history: string[];
  /** True when the rows came from cache because the connection is down. */
  offline: boolean;
  status: string;
  error?: string;
}

export type HostMessage = { type: 'state'; state: BrowserState };

export interface DisplayPathInputs {
  /** Where the browser last successfully listed. */
  currentPath: string | undefined;
  /** The live session's root, absent while disconnected. */
  sessionRoot: string | undefined;
  /** The root of the last session we had, kept across a reconnect. */
  lastRoot: string | undefined;
}

/**
 * Decide which path the path field should show.
 *
 * Extracted from the view so it can be tested: the panel is driven entirely by posted state,
 * and a gap here shows up as a blank or stale path field rather than an obvious failure.
 *
 * The order matters. Where we actually listed wins; the session root is the answer before the
 * first navigation; the remembered root covers a reconnect, during which the live session is
 * briefly gone. Falling back to "/" would be wrong -- it would claim to be at the filesystem
 * root while showing the home directory's contents.
 */
export function resolveDisplayPath(inputs: DisplayPathInputs): string {
  return inputs.currentPath ?? inputs.sessionRoot ?? inputs.lastRoot ?? '';
}

export function formatSize(bytes: bigint, type: RemoteEntryType): string {
  if (type === 'directory') return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${units[0]}` : `${value.toFixed(1)} ${units[unit]}`;
}

export function formatModified(mtime: number | undefined): string {
  if (mtime === undefined || mtime <= 0) return '';
  // SFTP v3 timestamps are seconds since the epoch.
  return new Date(mtime * 1000).toISOString().replace('T', ' ').slice(0, 16);
}
