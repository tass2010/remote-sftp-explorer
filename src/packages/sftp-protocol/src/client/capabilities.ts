import { Extension } from '../constants.ts';
import type { ServerLimits } from '../packets.ts';

/**
 * What this server can do, resolved once at VERSION time.
 *
 * The previous implementation re-derived this at every call site by string-comparing the
 * advertised extension value against "1", which is both repetitive and wrong for extensions
 * that advertise a different version string.
 */
export class ServerCapabilities {
  readonly version: number;
  readonly #extensions: ReadonlyMap<string, Uint8Array>;
  #limits: ServerLimits | undefined;

  constructor(version: number, extensions: ReadonlyMap<string, Uint8Array>) {
    this.version = version;
    this.#extensions = extensions;
  }

  has(name: string): boolean {
    return this.#extensions.has(name);
  }

  get posixRename(): boolean {
    return this.has(Extension.PosixRename);
  }

  get fsync(): boolean {
    return this.has(Extension.Fsync);
  }

  get limits(): boolean {
    return this.has(Extension.Limits);
  }

  get hardlink(): boolean {
    return this.has(Extension.Hardlink);
  }

  get extensionNames(): string[] {
    return [...this.#extensions.keys()].sort();
  }

  setLimits(limits: ServerLimits): void {
    this.#limits = limits;
  }

  /**
   * Largest READ we should ask for. Servers cap this internally and return short reads if we
   * exceed it; asking within the limit avoids a pointless extra round trip per chunk.
   */
  readChunkSize(fallback = 256 * 1024): number {
    const limit = this.#limits?.maxReadLength ?? 0n;
    if (limit <= 0n) return fallback;
    return Math.min(fallback, Number(limit));
  }

  /**
   * Largest WRITE payload. Defaults to 64 KiB rather than the previous implementation's
   * 32 KiB, which combined with serial writes to cap uploads near 640 KB/s at 50 ms RTT.
   */
  writeChunkSize(fallback = 64 * 1024): number {
    const limit = this.#limits?.maxWriteLength ?? 0n;
    if (limit <= 0n) return fallback;
    return Math.min(fallback, Number(limit));
  }
}
