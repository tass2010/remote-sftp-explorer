export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ReconnectCallbacks {
  attempt(attemptNumber: number): Promise<void>;
  onSuccess?(attemptNumber: number): void;
  onFailure?(attemptNumber: number, error: unknown, willRetry: boolean): void;
  onGiveUp?(error: unknown): void;
}

/** delay = min(initial * 2^(attempt-1), max). Attempt 1 waits `initial`. */
export function reconnectDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  return Math.min(initialDelayMs * 2 ** (Math.max(attempt, 1) - 1), maxDelayMs);
}

/**
 * Retries a connection with exponential backoff.
 *
 * Timers are injectable so the whole schedule is testable instantly. Carried over from the
 * previous implementation, which got this right -- the formula, the defaults, and the
 * stop semantics are unchanged.
 */
export class ReconnectScheduler {
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxAttempts: number;
  readonly #setTimeout: (handler: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  #timer: unknown;
  #running = false;
  #generation = 0;

  constructor(options: ReconnectOptions = {}) {
    this.#initialDelayMs = options.initialDelayMs ?? 1_000;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#setTimeout = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.#clearTimeout =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get running(): boolean {
    return this.#running;
  }

  delayForAttempt(attempt: number): number {
    return reconnectDelayMs(attempt, this.#initialDelayMs, this.#maxDelayMs);
  }

  /** Begin retrying. Calling this while already running is a no-op, not a second cycle. */
  start(callbacks: ReconnectCallbacks): void {
    if (this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    this.#schedule(callbacks, 1, generation);
  }

  /** Cancel any pending retry and ignore the result of one already in flight. */
  stop(): void {
    this.#running = false;
    this.#generation += 1;
    if (this.#timer !== undefined) {
      this.#clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #schedule(callbacks: ReconnectCallbacks, attempt: number, generation: number): void {
    const delay = this.delayForAttempt(attempt);
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.#run(callbacks, attempt, generation);
    }, delay);
  }

  async #run(
    callbacks: ReconnectCallbacks,
    attempt: number,
    generation: number
  ): Promise<void> {
    if (generation !== this.#generation) return;
    try {
      await callbacks.attempt(attempt);
      // A stop() during the attempt must suppress the success event too, or the UI would
      // announce a connection the user already cancelled.
      if (generation !== this.#generation) return;
      this.#running = false;
      callbacks.onSuccess?.(attempt);
    } catch (error) {
      if (generation !== this.#generation) return;
      const willRetry = attempt < this.#maxAttempts;
      callbacks.onFailure?.(attempt, error, willRetry);
      if (!willRetry) {
        this.#running = false;
        callbacks.onGiveUp?.(error);
        return;
      }
      this.#schedule(callbacks, attempt + 1, generation);
    }
  }
}
