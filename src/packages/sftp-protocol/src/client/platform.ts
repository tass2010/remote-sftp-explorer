/**
 * The minimal platform surface this package depends on, declared structurally.
 *
 * We deliberately do NOT pull in the DOM or node lib here. `types: []` keeps the package
 * I/O-free (ADR-0002), and adding `DOM` to get `AbortSignal` would also hand it `fetch`,
 * `XMLHttpRequest`, and every other browser global -- exactly what the boundary exists to
 * prevent. Declaring the shapes we need keeps the dependency explicit and one screen long.
 *
 * A real `AbortSignal` and a real `setTimeout` satisfy these structurally, so callers pass
 * the genuine article without adapters.
 */

export interface AbortListenerOptions {
  once?: boolean;
}

/** Structural stand-in for the standard AbortSignal. */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: AbortListenerOptions
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Injected time, so tests advance the clock instead of waiting. */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
