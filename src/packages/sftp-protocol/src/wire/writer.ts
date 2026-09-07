import { SftpProtocolError } from './errors.ts';

const utf8Encoder = new TextEncoder();

/**
 * Builds one SFTP packet into a single growable buffer.
 *
 * The previous implementation allocated a small buffer per field, pushed it onto an array,
 * concatenated at build time, and then concatenated a second time to prepend the length
 * prefix -- copying a large WRITE payload twice. Here the four-byte length prefix is reserved
 * up front and patched in place, so `buildFramed()` copies nothing.
 */
export class PacketWriter {
  #bytes: Uint8Array;
  #view: DataView;
  #length = 0;

  constructor(initialCapacity = 256) {
    this.#bytes = new Uint8Array(Math.max(initialCapacity, 8));
    this.#view = new DataView(this.#bytes.buffer);
    // Reserve the frame length prefix.
    this.#length = 4;
  }

  uint8(value: number): this {
    this.#reserve(1);
    this.#view.setUint8(this.#length, value & 0xff);
    this.#length += 1;
    return this;
  }

  uint32(value: number): this {
    this.#reserve(4);
    this.#view.setUint32(this.#length, value >>> 0, false);
    this.#length += 4;
    return this;
  }

  uint64(value: bigint): this {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new SftpProtocolError(`uint64 out of range: ${value}`);
    }
    this.#reserve(8);
    this.#view.setBigUint64(this.#length, value, false);
    this.#length += 8;
    return this;
  }

  raw(value: Uint8Array): this {
    this.#reserve(value.length);
    this.#bytes.set(value, this.#length);
    this.#length += value.length;
    return this;
  }

  /** Length-prefixed string, per the SFTP `string` type. */
  string(value: string | Uint8Array): this {
    const bytes = typeof value === 'string' ? utf8Encoder.encode(value) : value;
    return this.uint32(bytes.length).raw(bytes);
  }

  /** The packet body with its 4-byte big-endian length prefix already in place. */
  buildFramed(): Uint8Array {
    const payloadLength = this.#length - 4;
    this.#view.setUint32(0, payloadLength, false);
    return this.#bytes.subarray(0, this.#length);
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#bytes.length) return;
    let capacity = this.#bytes.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }
}

/** Convenience for building a request packet: type byte, request id, then the body. */
export function requestWriter(type: number, requestId: number, capacity?: number): PacketWriter {
  return new PacketWriter(capacity).uint8(type).uint32(requestId);
}
