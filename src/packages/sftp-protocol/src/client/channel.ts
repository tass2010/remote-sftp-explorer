/**
 * The byte pipe the client speaks over.
 *
 * Deliberately minimal and I/O-free: `core` implements it over an ssh subprocess's stdio,
 * and tests implement it in memory. This is the seam that lets the entire pipelining and
 * failure-injection suite run on any platform with no subprocess (ADR-0002).
 */
export interface ByteChannel {
  write(bytes: Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Fires once when the pipe dies, with a reason if there was one. */
  onClose(listener: (error?: Error) => void): void;
  close(): void;
}

export type { AbortLike, Clock } from './platform.ts';
