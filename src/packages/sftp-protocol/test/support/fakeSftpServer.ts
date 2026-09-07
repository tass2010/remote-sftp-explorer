/**
 * A scriptable in-memory SFTP server and byte channel.
 *
 * This is the harness that makes the pipelining and failure behaviour testable at all: the
 * client's only I/O dependency is a ByteChannel, so nothing here needs a subprocess, a socket,
 * or a filesystem. The knobs (`delay`, `reorder`, `dropResponse`, `shortRead`) exist because
 * the defects this rebuild fixes were all timing- and ordering-dependent.
 */
import {
  FrameDecoder,
  PacketReader,
  PacketType,
  PacketWriter,
  SFTP_VERSION,
  StatusCode,
  writeAttributes,
  type ByteChannel,
  type Clock,
  type FileAttributes
} from '../../src/index.ts';

export interface ControllableClock extends Clock {
  /** Advance virtual time, firing every timer due at or before the new instant. */
  advance(ms: number): void;
  readonly pendingTimers: number;
}

export function createControllableClock(start = 0): ControllableClock {
  let current = start;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();

  return {
    now: () => current,
    setTimeout(handler, ms) {
      const handle = nextHandle++;
      timers.set(handle, { at: current + ms, handler });
      return handle;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') timers.delete(handle);
    },
    advance(ms) {
      current += ms;
      for (const [handle, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= current) {
          timers.delete(handle);
          timer.handler();
        }
      }
    },
    get pendingTimers() {
      return timers.size;
    }
  };
}

export interface RequestContext {
  type: number;
  requestId: number;
  reader: PacketReader;
}

export type RequestHandler = (context: RequestContext) => Uint8Array | undefined;

export interface FakeServerOptions {
  version?: number;
  extensions?: Record<string, string>;
  /** Respond to VERSION automatically when INIT arrives. */
  autoHandshake?: boolean;
}

export class FakeSftpServer {
  readonly channel: ByteChannel;

  /** Every request the server received, in arrival order. */
  readonly received: RequestContext[] = [];
  /** Peak simultaneous outstanding requests -- the direct measure of pipelining. */
  peakInFlight = 0;

  #dataListeners: Array<(chunk: Uint8Array) => void> = [];
  #closeListeners: Array<(error?: Error) => void> = [];
  #decoder = new FrameDecoder();
  #handlers = new Map<number, RequestHandler>();
  #outstanding = 0;
  #closed = false;

  /** Responses held back until `flush()`, used to force overlap and reordering. */
  #held: Uint8Array[] = [];
  #holding = false;
  #dropIds = new Set<number>();

  readonly #options: Required<FakeServerOptions>;

  constructor(options: FakeServerOptions = {}) {
    this.#options = {
      version: options.version ?? SFTP_VERSION,
      extensions: options.extensions ?? {},
      autoHandshake: options.autoHandshake ?? true
    };

    this.channel = {
      write: (bytes) => {
        if (this.#closed) throw new Error('channel closed');
        this.#consume(bytes);
      },
      onData: (listener) => {
        this.#dataListeners.push(listener);
      },
      onClose: (listener) => {
        this.#closeListeners.push(listener);
      },
      close: () => {
        this.kill();
      }
    };
  }

  on(type: number, handler: RequestHandler): this {
    this.#handlers.set(type, handler);
    return this;
  }

  /** Stop sending responses; they queue until `flush()`. */
  hold(): void {
    this.#holding = true;
  }

  /** Release held responses, optionally reversed to prove out-of-order handling. */
  flush(options: { reverse?: boolean } = {}): void {
    const queued = options.reverse === true ? [...this.#held].reverse() : [...this.#held];
    this.#held = [];
    this.#holding = false;
    for (const packet of queued) this.#emit(packet);
  }

  /** Never answer this request id -- used to drive the timeout path. */
  dropResponse(requestId: number): void {
    this.#dropIds.add(requestId);
  }

  kill(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(error);
  }

  /** Deliver raw bytes to the client, bypassing the request machinery. */
  inject(packet: Uint8Array): void {
    this.#emit(packet);
  }

  // -- helpers for building responses -------------------------------------

  static status(requestId: number, code: number, message = ''): Uint8Array {
    return new PacketWriter(64)
      .uint8(PacketType.Status)
      .uint32(requestId)
      .uint32(code)
      .string(message)
      .string('')
      .buildFramed();
  }

  static handle(requestId: number, handle: Uint8Array): Uint8Array {
    return new PacketWriter(32)
      .uint8(PacketType.Handle)
      .uint32(requestId)
      .string(handle)
      .buildFramed();
  }

  static data(requestId: number, data: Uint8Array): Uint8Array {
    return new PacketWriter(data.length + 32)
      .uint8(PacketType.Data)
      .uint32(requestId)
      .string(data)
      .buildFramed();
  }

  static attrs(requestId: number, attributes: FileAttributes): Uint8Array {
    const writer = new PacketWriter(64).uint8(PacketType.Attrs).uint32(requestId);
    return writeAttributes(writer, attributes).buildFramed();
  }

  static name(
    requestId: number,
    entries: Array<{ filename: string; longname?: string; attributes?: FileAttributes }>
  ): Uint8Array {
    const writer = new PacketWriter(256)
      .uint8(PacketType.Name)
      .uint32(requestId)
      .uint32(entries.length);
    for (const entry of entries) {
      writer.string(entry.filename).string(entry.longname ?? '');
      writeAttributes(writer, entry.attributes ?? {});
    }
    return writer.buildFramed();
  }

  // -- internals ----------------------------------------------------------

  #consume(bytes: Uint8Array): void {
    for (const packet of this.#decoder.push(bytes)) {
      const reader = new PacketReader(packet);
      const type = reader.uint8();

      if (type === PacketType.Init) {
        reader.uint32();
        if (this.#options.autoHandshake) this.#emit(this.#versionPacket());
        continue;
      }

      const requestId = reader.uint32();
      const context: RequestContext = { type, requestId, reader };
      this.received.push(context);
      this.#outstanding += 1;
      this.peakInFlight = Math.max(this.peakInFlight, this.#outstanding);

      if (this.#dropIds.has(requestId)) {
        // Deliberately silent: the client should time out.
        continue;
      }

      const handler = this.#handlers.get(type);
      const response = handler?.(context);
      this.#outstanding -= 1;
      if (response !== undefined) this.#send(response);
    }
  }

  #versionPacket(): Uint8Array {
    const writer = new PacketWriter(128)
      .uint8(PacketType.Version)
      .uint32(this.#options.version);
    for (const [name, value] of Object.entries(this.#options.extensions)) {
      writer.string(name).string(value);
    }
    return writer.buildFramed();
  }

  #send(packet: Uint8Array): void {
    if (this.#holding) this.#held.push(packet);
    else this.#emit(packet);
  }

  #emit(packet: Uint8Array): void {
    for (const listener of this.#dataListeners) listener(packet);
  }
}

export { StatusCode };
