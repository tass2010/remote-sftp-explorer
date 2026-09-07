import type { Memento } from '../ports.ts';
import { normalizeRemotePath } from '../fs/remotePath.ts';

export const FAVORITES_KEY = 'remoteSftp.favorites.v1';
export const HISTORY_KEY = 'remoteSftp.directoryHistory.v1';
export const HISTORY_LIMIT = 20;

export type FavoriteType = 'file' | 'directory';

export interface Favorite {
  alias: string;
  path: string;
  type: FavoriteType;
  name: string;
}

interface FavoritesEnvelope {
  version: 1;
  items: Favorite[];
}

interface HistoryEnvelope {
  version: 1;
  byAlias: Record<string, string[]>;
}

/**
 * Favourites the user explicitly saved.
 *
 * What this stores -- a host alias and a remote path -- is documented in
 * docs/01-product.md under "What we persist". It is ordinary VS Code global state, which is
 * a plaintext file on disk, so remote *paths* are recoverable from it. Remote content and
 * credentials are never stored anywhere.
 */
export class FavoritesStore {
  readonly #memento: Memento;

  constructor(memento: Memento) {
    this.#memento = memento;
  }

  all(): Favorite[] {
    const stored = this.#memento.get<FavoritesEnvelope>(FAVORITES_KEY);
    if (stored === undefined || stored.version !== 1 || !Array.isArray(stored.items)) return [];
    // Stored state can be hand-edited or written by an older version, so validate rather than
    // trust: a malformed entry should drop out, not crash the view.
    return stored.items.filter(isFavorite);
  }

  forAlias(alias: string): Favorite[] {
    return this.all().filter((favorite) => favorite.alias === alias);
  }

  async add(favorite: Favorite): Promise<void> {
    if (!isFavorite(favorite)) throw new Error('Refusing to save a malformed favourite.');
    const items = this.all().filter(
      (existing) => !(existing.alias === favorite.alias && existing.path === favorite.path)
    );
    items.push(favorite);
    await this.#write(items);
  }

  async remove(alias: string, path: string): Promise<void> {
    await this.#write(
      this.all().filter((existing) => !(existing.alias === alias && existing.path === path))
    );
  }

  async #write(items: Favorite[]): Promise<void> {
    const envelope: FavoritesEnvelope = { version: 1, items };
    await this.#memento.update(FAVORITES_KEY, envelope);
  }
}

/** Recently visited directories, per host, most recent first. */
export class DirectoryHistoryStore {
  readonly #memento: Memento;

  constructor(memento: Memento) {
    this.#memento = memento;
  }

  forAlias(alias: string): string[] {
    const stored = this.#memento.get<HistoryEnvelope>(HISTORY_KEY);
    if (stored === undefined || stored.version !== 1) return [];
    const paths = stored.byAlias?.[alias];
    return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string') : [];
  }

  async record(alias: string, path: string): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizeRemotePath(path);
    } catch {
      return;
    }
    const existing = this.forAlias(alias).filter((entry) => entry !== normalized);
    // Most recent first, capped -- an unbounded history would grow global state forever.
    const updated = [normalized, ...existing].slice(0, HISTORY_LIMIT);
    await this.#writeAlias(alias, updated);
  }

  async clear(alias?: string): Promise<void> {
    if (alias === undefined) {
      await this.#memento.update(HISTORY_KEY, { version: 1, byAlias: {} } satisfies HistoryEnvelope);
      return;
    }
    await this.#writeAlias(alias, []);
  }

  async #writeAlias(alias: string, paths: string[]): Promise<void> {
    const stored = this.#memento.get<HistoryEnvelope>(HISTORY_KEY);
    const byAlias = stored?.version === 1 ? { ...stored.byAlias } : {};
    if (paths.length === 0) delete byAlias[alias];
    else byAlias[alias] = paths;
    await this.#memento.update(HISTORY_KEY, { version: 1, byAlias } satisfies HistoryEnvelope);
  }
}

function isFavorite(value: unknown): value is Favorite {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Favorite>;
  if (typeof candidate.alias !== 'string' || candidate.alias.length === 0) return false;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return false;
  if (candidate.type !== 'file' && candidate.type !== 'directory') return false;
  if (typeof candidate.path !== 'string') return false;
  try {
    normalizeRemotePath(candidate.path);
  } catch {
    return false;
  }
  return true;
}
