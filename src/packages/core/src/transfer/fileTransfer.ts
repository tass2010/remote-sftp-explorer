import type { AbortLike, Clock } from '@remote-sftp-explorer/sftp-protocol';

/**
 * Moving whole files between this machine and the server.
 *
 * Two things make a transfer different from the reads and writes an editor does. It can be
 * far larger than memory, so nothing here ever holds the file; and it can be watched by a
 * person, so it has to say how fast it is going and stop when it is going nowhere.
 */

/** Bytes pulled on demand, for content too large to hold. */
export interface ContentSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A source that owns a resource -- a file handle -- and must be released. */
export interface TransferSource extends ContentSource {
  close(): Promise<void>;
}

/**
 * Somewhere downloaded bytes go.
 *
 * Chunks arrive with the offset they belong at and not necessarily in order, because many
 * reads are in flight at once, so an implementation must position its writes rather than
 * append.
 */
export interface TransferSink {
  write(offset: number, chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface TransferProgress {
  bytes: number;
  total: number;
  bytesPerSecond: number;
  /** Absent until there is a rate to base it on. */
  etaSeconds: number | undefined;
}

/** Nothing moved for long enough that the transfer is treated as dead. */
export class TransferStalledError extends Error {
  readonly bytesTransferred: number;
  readonly stallMs: number;

  constructor(what: string, bytesTransferred: number, stallMs: number) {
    super(
      `${what} stopped making progress for ${Math.round(stallMs / 1000)} seconds and was ` +
        'abandoned. The connection may be down.'
    );
    this.name = 'TransferStalledError';
    this.bytesTransferred = bytesTransferred;
    this.stallMs = stallMs;
  }
}

/**
 * How long a transfer may move zero bytes before it is abandoned.
 *
 * Shorter than the per-request deadline on purpose. A request timeout bounds one chunk, but
 * with a window of them in flight a dead link still takes a full request timeout to surface,
 * and the error then names a single READ rather than the transfer the user is watching.
 */
export const DEFAULT_STALL_MS = 20_000;

/** Rate is averaged over this much recent history rather than the whole transfer. */
const RATE_WINDOW_MS = 5_000;

/**
 * Throughput, measured over a trailing window.
 *
 * Averaging over the whole transfer would make the rate crawl towards a number that stopped
 * being true minutes ago, and the estimate with it; a window follows what the link is doing
 * now, which is what someone deciding whether to wait actually needs.
 */
export class TransferMonitor {
  readonly #clock: Clock;
  readonly #total: number;
  readonly #samples: Array<{ at: number; bytes: number }> = [];
  #bytes = 0;

  constructor(options: { clock: Clock; total: number }) {
    this.#clock = options.clock;
    this.#total = options.total;
    this.#samples.push({ at: options.clock.now(), bytes: 0 });
  }

  get bytes(): number {
    return this.#bytes;
  }

  record(bytes: number): void {
    this.#bytes = bytes;
    const at = this.#clock.now();
    this.#samples.push({ at, bytes });
    // Keep the oldest sample that is still outside the window: dropping it too would leave
    // the window measuring from its own leading edge and report a rate of nearly zero.
    while (this.#samples.length > 2 && (this.#samples[1]?.at ?? at) <= at - RATE_WINDOW_MS) {
      this.#samples.shift();
    }
  }

  snapshot(): TransferProgress {
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    let bytesPerSecond = 0;
    if (first !== undefined && last !== undefined) {
      const seconds = (last.at - first.at) / 1000;
      if (seconds > 0) bytesPerSecond = Math.max(0, (last.bytes - first.bytes) / seconds);
    }

    const remaining = this.#total - this.#bytes;
    return {
      bytes: this.#bytes,
      total: this.#total,
      bytesPerSecond,
      // No estimate until there is a rate behind it. A number that swings between "3 seconds"
      // and "one hour" is worse than no number, because people act on it.
      etaSeconds:
        bytesPerSecond > 0 && remaining > 0 ? remaining / bytesPerSecond : undefined
    };
  }
}

export interface TransferContext {
  /** Pass to the SFTP call. Aborts on cancellation and on a stall alike. */
  signal: AbortSignal;
  /** Report the running byte total. Every call is also proof the transfer is alive. */
  report(bytes: number): void;
}

export interface RunTransferOptions<T> {
  clock: Clock;
  /** Named in the stall message, so it says which transfer died. */
  what: string;
  total: number;
  stallMs?: number | undefined;
  signal?: AbortLike | undefined;
  onProgress?: ((progress: TransferProgress) => void) | undefined;
  run(context: TransferContext): Promise<T>;
}

/**
 * Run a transfer, abandoning it when it stops moving.
 *
 * Deliberately NOT a minimum-throughput rule. A link managing eight kilobytes a second is
 * painful, not broken, and cutting it off would throw away work that would have finished. So
 * the guard fires only on no progress at all, and the caller is handed the rate to display
 * and a signal to cancel with, leaving the judgement where it belongs.
 */
export async function runTransfer<T>(options: RunTransferOptions<T>): Promise<T> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const monitor = new TransferMonitor({ clock: options.clock, total: options.total });
  const controller = new AbortController();

  let stalled = false;
  let timer: unknown;

  const arm = (): void => {
    if (timer !== undefined) options.clock.clearTimeout(timer);
    timer = options.clock.setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };

  const onCancel = (): void => controller.abort();
  options.signal?.addEventListener('abort', onCancel, { once: true });
  if (options.signal?.aborted === true) controller.abort();

  arm();
  try {
    return await options.run({
      signal: controller.signal,
      report: (bytes) => {
        monitor.record(bytes);
        // Any byte at all proves the transfer is alive, so the clock starts again.
        arm();
        options.onProgress?.(monitor.snapshot());
      }
    });
  } catch (error) {
    // A stall aborts through the same signal a cancellation does, so the distinction has to
    // be made here. Otherwise the user is told they cancelled something they did not.
    if (stalled) throw new TransferStalledError(options.what, monitor.bytes, stallMs);
    throw error;
  } finally {
    if (timer !== undefined) options.clock.clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCancel);
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The one line a progress notification shows.
 *
 * Rate and estimate appear only once they mean something. A transfer that has just started
 * shows how much there is to do, not "0 B/s, unknown remaining", which reads like a fault.
 */
export function describeProgress(progress: TransferProgress): string {
  const parts = [`${formatBytes(progress.bytes)} of ${formatBytes(progress.total)}`];
  if (progress.bytesPerSecond > 0) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
  if (progress.etaSeconds !== undefined) {
    parts.push(`${formatDuration(progress.etaSeconds)} left`);
  }
  return parts.join(' · ');
}
