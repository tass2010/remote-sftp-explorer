import { open, type FileHandle } from 'node:fs/promises';
import type { TransferSink, TransferSource } from '@remote-sftp-explorer/core';

/**
 * Local files as transfer endpoints.
 *
 * Both sides position every read and write explicitly rather than relying on a file cursor,
 * because a transfer has many chunks in flight at once and they neither arrive nor are asked
 * for in order. A shared cursor would interleave them into nonsense.
 */

export class NodeFileSink implements TransferSink {
  readonly #handle: FileHandle;
  #closed = false;

  private constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  /** Truncates or creates. The caller has already decided it is allowed to overwrite. */
  static async create(path: string): Promise<NodeFileSink> {
    return new NodeFileSink(await open(path, 'w'));
  }

  async write(offset: number, chunk: Uint8Array): Promise<void> {
    await this.#handle.write(chunk, 0, chunk.length, offset);
  }

  async close(): Promise<void> {
    // Closing twice throws, and the transfer code closes in a `finally` that can run after an
    // error path has already cleaned up.
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}

export class NodeFileSource implements TransferSource {
  readonly size: number;
  readonly #handle: FileHandle;
  #closed = false;

  private constructor(handle: FileHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  static async open(path: string): Promise<NodeFileSource> {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw new Error(`${path} is a folder. Only files can be uploaded.`);
      return new NodeFileSource(handle, stat.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(length);
    let filled = 0;
    // A positional read may return less than asked for without being at the end, so it is
    // repeated until the buffer is full or the file really has run out. Returning a short
    // chunk from the middle of a file would upload something other than what is on disk --
    // the transfer refuses it, but only because this loop makes the distinction meaningful.
    while (filled < length) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        filled,
        length - filled,
        offset + filled
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }
}
