import { DEFAULT_MAX_PACKET_LENGTH } from '../constants.ts';
import { SftpProtocolError } from './errors.ts';

/**
 * Reassembles length-prefixed SFTP packets from an arbitrarily chunked byte stream.
 *
 * Carried over from the previous implementation, which got the hard parts right: a chunk
 * boundary may fall anywhere (including inside the length prefix), several packets may arrive
 * in one chunk, and the length limit is checked BEFORE the body is buffered so a hostile
 * length cannot make us allocate first and regret it later.
 *
 * Changed: pending bytes are kept as a list of chunks instead of one buffer that gets
 * reallocated and copied on every push. A 256 KiB DATA packet delivered as many small stdout
 * reads was quadratic before.
 */
export class FrameDecoder {
  readonly maxPacketLength: number;
  #chunks: Uint8Array[] = [];
  #pending = 0;

  constructor(maxPacketLength = DEFAULT_MAX_PACKET_LENGTH) {
    if (!Number.isSafeInteger(maxPacketLength) || maxPacketLength < 1) {
      throw new RangeError('maxPacketLength must be a positive safe integer');
    }
    this.maxPacketLength = maxPacketLength;
  }

  get pendingBytes(): number {
    return this.#pending;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#pending += chunk.length;
    }

    const packets: Uint8Array[] = [];
    for (;;) {
      if (this.#pending < 4) break;
      const length = this.#peekUint32();
      if (length < 1) {
        throw new SftpProtocolError('SFTP packet length must include a packet type byte');
      }
      if (length > this.maxPacketLength) {
        throw new SftpProtocolError(
          `SFTP packet length ${length} exceeds limit ${this.maxPacketLength}`
        );
      }
      if (this.#pending - 4 < length) break;
      this.#discard(4);
      packets.push(this.#take(length));
    }
    return packets;
  }

  /** Call when the stream ends: leftover bytes mean the peer was cut off mid-packet. */
  finish(): void {
    if (this.#pending !== 0) {
      throw new SftpProtocolError(`stream ended with ${this.#pending} incomplete bytes`);
    }
  }

  reset(): void {
    this.#chunks = [];
    this.#pending = 0;
  }

  #peekUint32(): number {
    const first = this.#chunks[0]!;
    if (first.length >= 4) {
      return (
        ((first[0]! << 24) | (first[1]! << 16) | (first[2]! << 8) | first[3]!) >>> 0
      );
    }
    // The length prefix itself straddles a chunk boundary.
    let value = 0;
    let seen = 0;
    for (const chunk of this.#chunks) {
      for (const byte of chunk) {
        value = ((value << 8) | byte) >>> 0;
        seen += 1;
        if (seen === 4) return value;
      }
    }
    return value;
  }

  #discard(count: number): void {
    let left = count;
    while (left > 0) {
      const head = this.#chunks[0]!;
      if (head.length <= left) {
        left -= head.length;
        this.#chunks.shift();
      } else {
        this.#chunks[0] = head.subarray(left);
        left = 0;
      }
    }
    this.#pending -= count;
  }

  #take(count: number): Uint8Array {
    const head = this.#chunks[0]!;
    if (head.length === count) {
      this.#chunks.shift();
      this.#pending -= count;
      return head;
    }
    if (head.length > count) {
      const packet = head.subarray(0, count);
      this.#chunks[0] = head.subarray(count);
      this.#pending -= count;
      return packet;
    }
    const packet = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const chunk = this.#chunks[0]!;
      const wanted = count - written;
      if (chunk.length <= wanted) {
        packet.set(chunk, written);
        written += chunk.length;
        this.#chunks.shift();
      } else {
        packet.set(chunk.subarray(0, wanted), written);
        this.#chunks[0] = chunk.subarray(wanted);
        written = count;
      }
    }
    this.#pending -= count;
    return packet;
  }
}
