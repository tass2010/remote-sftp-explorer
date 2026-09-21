import { parentRemotePath, normalizeRemotePath } from '../fs/remotePath.ts';

interface Waiter {
  resolve: () => void;
}

/**
 * Per-path mutual exclusion for mutating operations.
 *
 * This replaces the previous implementation's single promise chain, which serialised every
 * operation on the session -- including reads of unrelated paths -- and so was both a
 * correctness overreach and the main throughput ceiling.
 *
 * Rules:
 *   - a write/rename/delete takes an exclusive lock on the path AND its parent directory,
 *     because those operations change the parent's contents too;
 *   - reads take no lock at all, so unrelated reads run concurrently;
 *   - waiters on a key are served first-in-first-out, so no request can be starved;
 *   - when two keys are needed they are acquired in sorted order, which makes deadlock
 *     structurally impossible rather than merely unlikely.
 */
export class PathLockRegistry {
  readonly #held = new Set<string>();
  readonly #waiters = new Map<string, Waiter[]>();

  get heldCount(): number {
    return this.#held.size;
  }

  /** Run `operation` while holding the write lock for `path` and its parent. */
  async withWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    return this.withWriteLocks([path], operation);
  }

  /**
   * Run `operation` holding the write locks for several paths at once.
   *
   * Every path an operation touches must be claimed in ONE acquisition. Nesting two
   * `withWriteLock` calls deadlocks the operation against itself whenever the paths share a
   * parent -- which for a rename inside a directory is always -- because the inner call waits
   * for a key the outer call is still holding and nothing will ever release it. Sorting makes
   * concurrent operations safe against each other; only combining makes one operation safe
   * against itself.
   */
  async withWriteLocks<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const keys = new Set<string>();
    for (const path of paths) {
      const normalized = normalizeRemotePath(path);
      keys.add(normalized);
      keys.add(parentRemotePath(normalized));
    }
    // Sorted acquisition order: two operations wanting overlapping keys always take them in
    // the same sequence, so they can never each hold one and wait for the other.
    const ordered = [...keys].sort();

    const acquired: string[] = [];
    try {
      for (const key of ordered) {
        await this.#acquire(key);
        acquired.push(key);
      }
      return await operation();
    } finally {
      for (const key of acquired.reverse()) this.#release(key);
    }
  }

  /** True while any lock covering this exact path is held. Diagnostics and tests only. */
  isLocked(path: string): boolean {
    return this.#held.has(normalizeRemotePath(path));
  }

  async #acquire(key: string): Promise<void> {
    if (!this.#held.has(key)) {
      this.#held.add(key);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.#waiters.get(key);
      if (queue === undefined) this.#waiters.set(key, [{ resolve }]);
      else queue.push({ resolve });
    });
  }

  #release(key: string): void {
    const queue = this.#waiters.get(key);
    const next = queue?.shift();
    if (next === undefined) {
      this.#waiters.delete(key);
      this.#held.delete(key);
      return;
    }
    if (queue !== undefined && queue.length === 0) this.#waiters.delete(key);
    // The lock passes straight to the next waiter; it is never observably free in between.
    next.resolve();
  }
}
