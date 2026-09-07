import { SftpProtocolError } from './errors.ts';

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Sequential reader over one SFTP packet body.
 *
 * Every accessor checks the remaining length first. That underflow guard is the single most
 * important property here: a truncated or hostile packet must fail loudly at the read that
 * runs off the end, never return silent garbage.
 */
export class PacketReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    // One view for the whole packet; the previous implementation built a fresh Buffer wrapper
    // on every single field read, which dominated the cost of parsing large directory listings.
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  get offset(): number {
    return this.#offset;
  }

  uint8(): number {
    this.#require(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  uint32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, false);
    this.#offset += 4;
    return value;
  }

  uint64(): bigint {
    this.#require(8);
    const value = this.#view.getBigUint64(this.#offset, false);
    this.#offset += 8;
    return value;
  }

  /** A view onto the packet, not a copy. Callers that retain it must copy first. */
  bytes(length: number): Uint8Array {
    this.#require(length);
    const value = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  /** A length-prefixed byte string, returned without assuming it is text. */
  stringBytes(): Uint8Array {
    return this.bytes(this.uint32());
  }

  /** A length-prefixed UTF-8 string. Invalid sequences become replacement characters. */
  string(): string {
    return utf8Decoder.decode(this.stringBytes());
  }

  assertFinished(context: string): void {
    if (this.remaining !== 0) {
      throw new SftpProtocolError(`${context} has ${this.remaining} unexpected trailing bytes`);
    }
  }

  #require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new SftpProtocolError(`invalid read length ${length}`);
    }
    if (length > this.remaining) {
      throw new SftpProtocolError(
        `packet underflow: wanted ${length} bytes, ${this.remaining} remain`
      );
    }
  }
}
