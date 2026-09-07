import { Extension, OpenFlag, PacketType, SFTP_VERSION } from '../constants.ts';
import { FrameDecoder } from '../wire/frameDecoder.ts';
import { SftpProtocolError } from '../wire/errors.ts';
import {
  assertOk,
  expectType,
  SftpStatusError,
  StatusCode,
  type SftpStatus
} from '../wire/status.ts';
import { classifyEntry, type FileAttributes, type RemoteEntryType } from '../wire/attributes.ts';
import {
  decodeLimitsReply,
  decodeResponse,
  decodeVersion,
  encodeClose,
  encodeExtended,
  encodeFsetstat,
  encodeFstat,
  encodeFsync,
  encodeInit,
  encodeLimits,
  encodeLstat,
  encodeMkdir,
  encodeOpen,
  encodeOpendir,
  encodePosixRename,
  encodeRead,
  encodeReaddir,
  encodeReadlink,
  encodeRealpath,
  encodeRemove,
  encodeRename,
  encodeRmdir,
  encodeSetstat,
  encodeStat,
  encodeSymlink,
  encodeWrite,
  type DecodedResponse,
  type NameEntry
} from '../packets.ts';
import type { ByteChannel } from './channel.ts';
import type { AbortLike, Clock } from './platform.ts';
import { RequestRegistry } from './requestRegistry.ts';
import { ServerCapabilities } from './capabilities.ts';

export interface SftpClientOptions {
  /**
   * Required, not defaulted: this package has no access to `setTimeout` by design, so the
   * caller supplies time. `core` passes a system clock; tests pass a controllable one.
   */
  clock: Clock;
  /** Requests allowed in flight simultaneously. */
  maxInFlight?: number;
  /** Deadline for metadata operations (STAT, READDIR, REALPATH, ...). */
  metadataTimeoutMs?: number;
  /** Deadline for the INIT/VERSION handshake. */
  handshakeTimeoutMs?: number;
  /** A transfer aborts after this long with no byte progress at all. */
  transferStallMs?: number;
  maxPacketLength?: number;
}

export interface DirectoryEntry {
  filename: string;
  longname: string;
  type: RemoteEntryType;
  attributes: FileAttributes;
}

export interface ReadFileOptions {
  size: bigint;
  signal?: AbortLike | undefined;
  onProgress?: ((bytesSoFar: number) => void) | undefined;
}

export interface WriteStreamOptions {
  signal?: AbortLike | undefined;
  onProgress?: ((bytesSoFar: number) => void) | undefined;
}

const DEFAULTS = {
  maxInFlight: 32,
  metadataTimeoutMs: 30_000,
  handshakeTimeoutMs: 60_000,
  transferStallMs: 60_000
} as const;

class AbortedError extends Error {
  constructor() {
    super('The SFTP operation was cancelled.');
    this.name = 'AbortedError';
  }
}

/**
 * A pipelined SFTP v3 client.
 *
 * Requests are correlated by id and may complete out of order; up to `maxInFlight` are
 * outstanding at once, with the rest queued. All I/O goes through the injected ByteChannel,
 * so this class is fully testable without a subprocess.
 */
export class SftpClient {
  readonly #channel: ByteChannel;
  readonly #clock: Clock;
  readonly #registry: RequestRegistry;
  readonly #decoder: FrameDecoder;
  readonly #options: Required<Omit<SftpClientOptions, 'clock' | 'maxPacketLength'>>;
  readonly #maxInFlight: number;

  /** Requests waiting for a window slot. */
  readonly #queue: Array<() => void> = [];
  /** Handles we opened and have not yet closed, so channel death can release them. */
  readonly #openHandles = new Set<string>();

  #capabilities: ServerCapabilities | undefined;
  #handshakeWaiter: ((payload: Uint8Array) => void) | undefined;
  #closed = false;
  #closeError: Error | undefined;

  constructor(channel: ByteChannel, options: SftpClientOptions) {
    this.#channel = channel;
    this.#clock = options.clock;
    this.#registry = new RequestRegistry(this.#clock);
    this.#decoder = new FrameDecoder(options.maxPacketLength);
    this.#maxInFlight = options.maxInFlight ?? DEFAULTS.maxInFlight;
    this.#options = {
      maxInFlight: this.#maxInFlight,
      metadataTimeoutMs: options.metadataTimeoutMs ?? DEFAULTS.metadataTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
      transferStallMs: options.transferStallMs ?? DEFAULTS.transferStallMs
    };

    channel.onData((chunk) => this.#onData(chunk));
    channel.onClose((error) => this.#onClose(error));
  }

  get capabilities(): ServerCapabilities {
    if (this.#capabilities === undefined) {
      throw new SftpProtocolError('the SFTP handshake has not completed');
    }
    return this.#capabilities;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get inFlight(): number {
    return this.#registry.inFlight;
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  async handshake(): Promise<ServerCapabilities> {
    const versionPayload = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        this.#handshakeWaiter = undefined;
        reject(new SftpProtocolError('timed out waiting for the SFTP VERSION packet'));
      }, this.#options.handshakeTimeoutMs);

      this.#handshakeWaiter = (payload) => {
        this.#clock.clearTimeout(timer);
        this.#handshakeWaiter = undefined;
        resolve(payload);
      };

      try {
        this.#channel.write(encodeInit());
      } catch (error) {
        this.#clock.clearTimeout(timer);
        this.#handshakeWaiter = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const version = decodeVersion(versionPayload);
    if (version.version !== SFTP_VERSION) {
      throw new SftpProtocolError(
        `server negotiated SFTP version ${version.version}; only ${SFTP_VERSION} is supported`
      );
    }
    const capabilities = new ServerCapabilities(version.version, version.extensions);
    this.#capabilities = capabilities;

    if (capabilities.limits) {
      // Best-effort: a server may advertise the extension and still refuse the call.
      try {
        const response = await this.#request(PacketType.Extended, (id) => encodeLimits(id));
        if (response.body.kind === 'extendedReply') {
          capabilities.setLimits(decodeLimitsReply(response.body.reader));
        }
      } catch {
        // Fall back to conservative defaults.
      }
    }
    return capabilities;
  }

  // -------------------------------------------------------------------------
  // Path operations
  // -------------------------------------------------------------------------

  async realpath(path: string, signal?: AbortLike): Promise<string> {
    const response = await this.#request(
      PacketType.Realpath,
      (id) => encodeRealpath(id, path),
      { signal, context: `resolving ${path}` }
    );
    const entries = this.#expectName(response, `resolving ${path}`);
    const first = entries[0];
    if (first === undefined) {
      throw new SftpProtocolError(`REALPATH for ${path} returned no entries`);
    }
    return first.filename;
  }

  async stat(path: string, signal?: AbortLike): Promise<FileAttributes> {
    const response = await this.#request(PacketType.Stat, (id) => encodeStat(id, path), {
      signal,
      context: `stat ${path}`
    });
    return this.#expectAttrs(response, `stat ${path}`);
  }

  async lstat(path: string, signal?: AbortLike): Promise<FileAttributes> {
    const response = await this.#request(PacketType.Lstat, (id) => encodeLstat(id, path), {
      signal,
      context: `lstat ${path}`
    });
    return this.#expectAttrs(response, `lstat ${path}`);
  }

  async readlink(path: string, signal?: AbortLike): Promise<string> {
    const response = await this.#request(PacketType.Readlink, (id) => encodeReadlink(id, path), {
      signal,
      context: `readlink ${path}`
    });
    const entries = this.#expectName(response, `readlink ${path}`);
    const first = entries[0];
    if (first === undefined) throw new SftpProtocolError(`READLINK for ${path} returned nothing`);
    return first.filename;
  }

  async setstat(path: string, attributes: FileAttributes, signal?: AbortLike): Promise<void> {
    const response = await this.#request(
      PacketType.Setstat,
      (id) => encodeSetstat(id, path, attributes),
      { signal, context: `setstat ${path}` }
    );
    assertOk(this.#expectStatus(response, `setstat ${path}`), `setstat ${path}`);
  }

  async remove(path: string, signal?: AbortLike): Promise<void> {
    const response = await this.#request(PacketType.Remove, (id) => encodeRemove(id, path), {
      signal,
      context: `removing ${path}`
    });
    assertOk(this.#expectStatus(response, `removing ${path}`), `removing ${path}`);
  }

  async mkdir(path: string, attributes: FileAttributes = {}, signal?: AbortLike): Promise<void> {
    const response = await this.#request(
      PacketType.Mkdir,
      (id) => encodeMkdir(id, path, attributes),
      { signal, context: `creating ${path}` }
    );
    assertOk(this.#expectStatus(response, `creating ${path}`), `creating ${path}`);
  }

  async rmdir(path: string, signal?: AbortLike): Promise<void> {
    const response = await this.#request(PacketType.Rmdir, (id) => encodeRmdir(id, path), {
      signal,
      context: `removing directory ${path}`
    });
    assertOk(this.#expectStatus(response, `removing ${path}`), `removing directory ${path}`);
  }

  async rename(from: string, to: string, signal?: AbortLike): Promise<void> {
    const response = await this.#request(
      PacketType.Rename,
      (id) => encodeRename(id, from, to),
      { signal, context: `renaming ${from}` }
    );
    assertOk(this.#expectStatus(response, `renaming ${from}`), `renaming ${from} to ${to}`);
  }

  async symlink(linkPath: string, targetPath: string, signal?: AbortLike): Promise<void> {
    const response = await this.#request(
      PacketType.Symlink,
      (id) => encodeSymlink(id, linkPath, targetPath),
      { signal, context: `linking ${linkPath}` }
    );
    assertOk(this.#expectStatus(response, `linking ${linkPath}`), `linking ${linkPath}`);
  }

  /** POSIX-semantics atomic rename. Only valid when `capabilities.posixRename` is true. */
  async posixRename(from: string, to: string, signal?: AbortLike): Promise<void> {
    const response = await this.#request(
      PacketType.Extended,
      (id) => encodePosixRename(id, from, to),
      { signal, context: `renaming ${from}` }
    );
    assertOk(this.#expectStatus(response, `renaming ${from}`), `atomically renaming ${from}`);
  }

  // -------------------------------------------------------------------------
  // Directories
  // -------------------------------------------------------------------------

  async readDirectory(
    path: string,
    options: { signal?: AbortLike | undefined; onBatch?: (entries: DirectoryEntry[]) => void } = {}
  ): Promise<DirectoryEntry[]> {
    const handle = await this.#openDirectory(path, options.signal);
    const all: DirectoryEntry[] = [];
    try {
      for (;;) {
        this.#throwIfAborted(options.signal);
        const response = await this.#request(
          PacketType.Readdir,
          (id) => encodeReaddir(id, handle),
          { signal: options.signal, context: `listing ${path}` }
        );
        if (response.body.kind === 'status') {
          if (response.body.status.code === StatusCode.Eof) break;
          throw new SftpStatusError(response.body.status, `listing ${path}`);
        }
        if (response.body.kind !== 'name') {
          throw new SftpProtocolError(`expected NAME while listing ${path}`);
        }
        const batch = response.body.entries
          .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          .map((entry) => toDirectoryEntry(entry));
        if (batch.length > 0) {
          all.push(...batch);
          options.onBatch?.(batch);
        }
      }
    } finally {
      await this.#closeHandleQuietly(handle);
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // File transfer
  // -------------------------------------------------------------------------

  async open(path: string, flags: number, attributes: FileAttributes = {}, signal?: AbortLike): Promise<Uint8Array> {
    const response = await this.#request(
      PacketType.Open,
      (id) => encodeOpen(id, path, flags, attributes),
      { signal, context: `opening ${path}` }
    );
    if (response.body.kind === 'status') {
      throw new SftpStatusError(response.body.status, `opening ${path}`);
    }
    if (response.body.kind !== 'handle') {
      throw new SftpProtocolError(`expected HANDLE while opening ${path}`);
    }
    this.#openHandles.add(handleKey(response.body.handle));
    return response.body.handle;
  }

  async close(handle: Uint8Array, signal?: AbortLike): Promise<void> {
    this.#openHandles.delete(handleKey(handle));
    const response = await this.#request(PacketType.Close, (id) => encodeClose(id, handle), {
      signal,
      context: 'closing a handle'
    });
    assertOk(this.#expectStatus(response, 'closing a handle'), 'closing a handle');
  }

  async fstat(handle: Uint8Array, signal?: AbortLike): Promise<FileAttributes> {
    const response = await this.#request(PacketType.Fstat, (id) => encodeFstat(id, handle), {
      signal,
      context: 'stat on an open handle'
    });
    return this.#expectAttrs(response, 'stat on an open handle');
  }

  async fsetstat(
    handle: Uint8Array,
    attributes: FileAttributes,
    signal?: AbortLike
  ): Promise<void> {
    const response = await this.#request(
      PacketType.Fsetstat,
      (id) => encodeFsetstat(id, handle, attributes),
      { signal, context: 'setting attributes on an open handle' }
    );
    assertOk(this.#expectStatus(response, 'fsetstat'), 'setting attributes');
  }

  async fsync(handle: Uint8Array, signal?: AbortLike): Promise<void> {
    const response = await this.#request(PacketType.Extended, (id) => encodeFsync(id, handle), {
      signal,
      context: 'flushing to disk'
    });
    assertOk(this.#expectStatus(response, 'fsync'), 'flushing to disk');
  }

  /**
   * Read a whole file with a pipelined window of READs.
   *
   * Two properties that a naive loop gets wrong:
   *  - a short read is normal and does NOT signal EOF;
   *  - EOF on a high-offset slot does not mean lower offsets are done, because those requests
   *    may still be in flight.
   */
  async readFile(path: string, options: ReadFileOptions): Promise<Uint8Array> {
    const total = Number(options.size);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new SftpProtocolError(`unsupported file size ${options.size}`);
    }
    const handle = await this.open(path, OpenFlag.Read, {}, options.signal);
    const buffer = new Uint8Array(total);
    let received = 0;

    try {
      const chunkSize = this.capabilities.readChunkSize();
      let nextOffset = 0;
      const active = new Set<Promise<void>>();
      let failure: unknown;

      const pump = (): void => {
        while (
          failure === undefined &&
          nextOffset < total &&
          active.size < this.#maxInFlight
        ) {
          const offset = nextOffset;
          const length = Math.min(chunkSize, total - offset);
          nextOffset += length;

          const task = (async () => {
            const response = await this.#request(
              PacketType.Read,
              (id) => encodeRead(id, handle, BigInt(offset), length),
              { signal: options.signal, context: `reading ${path}`, transfer: true }
            );
            if (response.body.kind === 'status') {
              // EOF here only means this slot found the end; shorter files simply stop early.
              if (response.body.status.code === StatusCode.Eof) return;
              throw new SftpStatusError(response.body.status, `reading ${path}`);
            }
            if (response.body.kind !== 'data') {
              throw new SftpProtocolError(`expected DATA while reading ${path}`);
            }
            buffer.set(response.body.data, offset);
            received += response.body.data.length;
            options.onProgress?.(received);
          })();

          const tracked = task
            .catch((error: unknown) => {
              failure ??= error;
            })
            .finally(() => {
              active.delete(tracked);
            });
          active.add(tracked);
        }
      };

      pump();
      while (active.size > 0) {
        await Promise.race([...active]);
        if (failure === undefined) pump();
      }
      if (failure !== undefined) throw failure;

      this.#throwIfAborted(options.signal);
      return buffer;
    } finally {
      await this.#closeHandleQuietly(handle);
    }
  }

  /** Write a whole buffer to an already-open handle, pipelined. */
  async writeAll(
    handle: Uint8Array,
    content: Uint8Array,
    options: WriteStreamOptions = {}
  ): Promise<void> {
    const chunkSize = this.capabilities.writeChunkSize();
    let nextOffset = 0;
    let written = 0;
    const active = new Set<Promise<void>>();
    let failure: unknown;

    const pump = (): void => {
      while (
        failure === undefined &&
        nextOffset < content.length &&
        active.size < this.#maxInFlight
      ) {
        const offset = nextOffset;
        const end = Math.min(offset + chunkSize, content.length);
        nextOffset = end;
        const slice = content.subarray(offset, end);

        const task = (async () => {
          const response = await this.#request(
            PacketType.Write,
            (id) => encodeWrite(id, handle, BigInt(offset), slice),
            { signal: options.signal, context: 'writing', transfer: true }
          );
          assertOk(this.#expectStatus(response, 'writing'), 'writing');
          written += slice.length;
          options.onProgress?.(written);
        })();

        const tracked = task
          .catch((error: unknown) => {
            failure ??= error;
          })
          .finally(() => {
            active.delete(tracked);
          });
        active.add(tracked);
      }
    };

    pump();
    while (active.size > 0) {
      await Promise.race([...active]);
      if (failure === undefined) pump();
    }
    if (failure !== undefined) throw failure;
    this.#throwIfAborted(options.signal);
  }

  /** Raw extended request, for callers that need an extension we do not wrap. */
  async extended(
    extension: string,
    build: Parameters<typeof encodeExtended>[2],
    signal?: AbortLike
  ): Promise<DecodedResponse> {
    return this.#request(PacketType.Extended, (id) => encodeExtended(id, extension, build), {
      signal,
      context: extension
    });
  }

  dispose(error?: Error): void {
    this.#onClose(error ?? new Error('The SFTP client was disposed.'));
    this.#channel.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #openDirectory(path: string, signal?: AbortLike): Promise<Uint8Array> {
    const response = await this.#request(PacketType.Opendir, (id) => encodeOpendir(id, path), {
      signal,
      context: `listing ${path}`
    });
    if (response.body.kind === 'status') {
      throw new SftpStatusError(response.body.status, `listing ${path}`);
    }
    if (response.body.kind !== 'handle') {
      throw new SftpProtocolError(`expected HANDLE while listing ${path}`);
    }
    this.#openHandles.add(handleKey(response.body.handle));
    return response.body.handle;
  }

  /**
   * Close a handle without letting the close failure replace a more interesting error.
   *
   * The previous implementation closed handles inside `finally` blocks that could throw,
   * so a failing READ surfaced as a confusing CLOSE error instead.
   */
  async #closeHandleQuietly(handle: Uint8Array): Promise<void> {
    this.#openHandles.delete(handleKey(handle));
    if (this.#closed) return;
    try {
      await this.#request(PacketType.Close, (id) => encodeClose(id, handle), {
        context: 'closing a handle'
      });
    } catch {
      // Intentionally swallowed.
    }
  }

  #request(
    type: number,
    encode: (requestId: number) => Uint8Array,
    options: { signal?: AbortLike | undefined; context?: string; transfer?: boolean } = {}
  ): Promise<DecodedResponse> {
    return new Promise<DecodedResponse>((resolve, reject) => {
      const start = (): void => {
        if (this.#closed) {
          reject(this.#closeError ?? new Error('The SFTP connection is closed.'));
          return;
        }
        if (options.signal?.aborted === true) {
          reject(new AbortedError());
          return;
        }

        const requestId = this.#registry.allocateId();
        const timeoutMs = options.transfer === true
          ? this.#options.transferStallMs
          : this.#options.metadataTimeoutMs;

        const timer = this.#clock.setTimeout(() => {
          this.#registry.abandon(requestId);
          this.#drainQueue();
          reject(
            new SftpProtocolError(
              `SFTP request timed out after ${timeoutMs} ms` +
                (options.context === undefined ? '' : ` while ${options.context}`)
            )
          );
        }, timeoutMs);

        const onAbort = (): void => {
          this.#registry.abandon(requestId);
          this.#drainQueue();
          reject(new AbortedError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        this.#registry.add({
          requestId,
          type,
          timer,
          resolve: (response) => {
            options.signal?.removeEventListener('abort', onAbort);
            this.#drainQueue();
            resolve(response);
          },
          reject: (error) => {
            options.signal?.removeEventListener('abort', onAbort);
            this.#drainQueue();
            reject(error);
          }
        });

        try {
          this.#channel.write(encode(requestId));
        } catch (error) {
          this.#registry.take(requestId);
          options.signal?.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      if (this.#registry.inFlight < this.#maxInFlight) start();
      else this.#queue.push(start);
    });
  }

  #drainQueue(): void {
    while (this.#queue.length > 0 && this.#registry.inFlight < this.#maxInFlight) {
      const next = this.#queue.shift();
      next?.();
    }
  }

  #onData(chunk: Uint8Array): void {
    let packets: Uint8Array[];
    try {
      packets = this.#decoder.push(chunk);
    } catch (error) {
      this.#onClose(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (const packet of packets) {
      // The VERSION reply carries no request id, so it is dispatched separately.
      if (this.#handshakeWaiter !== undefined && packet[0] === PacketType.Version) {
        this.#handshakeWaiter(packet);
        continue;
      }

      let response: DecodedResponse;
      try {
        response = decodeResponse(packet);
      } catch (error) {
        this.#onClose(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const pending = this.#registry.take(response.requestId);
      if (pending !== undefined) {
        pending.resolve(response);
        continue;
      }

      const abandoned = this.#registry.claimAbandoned(response.requestId);
      if (abandoned !== undefined) {
        // A late reply to a request we gave up on. Discard it -- but if it handed us a file
        // handle, close it, or the server leaks that handle for the life of the connection.
        if (response.body.kind === 'handle') {
          this.#openHandles.add(handleKey(response.body.handle));
          void this.#closeHandleQuietly(response.body.handle);
        }
        continue;
      }

      // A response for an id we never issued means the stream is out of sync.
      this.#onClose(
        new SftpProtocolError(`received a response for unknown request id ${response.requestId}`)
      );
      return;
    }
  }

  #onClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error ?? new Error('The SFTP connection closed.');
    this.#openHandles.clear();
    this.#queue.length = 0;
    this.#registry.failAll(this.#closeError);
  }

  #throwIfAborted(signal?: AbortLike): void {
    if (signal?.aborted === true) throw new AbortedError();
  }

  #expectStatus(response: DecodedResponse, context: string): SftpStatus {
    if (response.body.kind !== 'status') {
      expectType(response.type, PacketType.Status, `STATUS while ${context}`);
      throw new SftpProtocolError(`expected STATUS while ${context}`);
    }
    return response.body.status;
  }

  #expectAttrs(response: DecodedResponse, context: string): FileAttributes {
    if (response.body.kind === 'status') {
      throw new SftpStatusError(response.body.status, context);
    }
    if (response.body.kind !== 'attrs') {
      throw new SftpProtocolError(`expected ATTRS while ${context}`);
    }
    return response.body.attributes;
  }

  #expectName(response: DecodedResponse, context: string): NameEntry[] {
    if (response.body.kind === 'status') {
      throw new SftpStatusError(response.body.status, context);
    }
    if (response.body.kind !== 'name') {
      throw new SftpProtocolError(`expected NAME while ${context}`);
    }
    return response.body.entries;
  }
}

function toDirectoryEntry(entry: NameEntry): DirectoryEntry {
  return {
    filename: entry.filename,
    longname: entry.longname,
    type: classifyEntry(entry.attributes.permissions, entry.longname),
    attributes: entry.attributes
  };
}

function handleKey(handle: Uint8Array): string {
  let key = '';
  for (const byte of handle) key += byte.toString(16).padStart(2, '0');
  return key;
}

export { Extension, OpenFlag };
