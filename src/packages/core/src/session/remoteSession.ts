import {
  OpenFlag,
  SftpClient,
  SftpStatusError,
  StatusCode,
  type Clock,
  type DirectoryEntry,
  type FileAttributes,
  type RemoteEntryType
} from '@remote-sftp-explorer/sftp-protocol';
import { SshTransport, type SshTransportOptions } from '../transport/sshTransport.ts';
import { PathLockRegistry } from '../locks/pathLockRegistry.ts';
import { safeReplace, sweepArtifacts, type SafeReplaceResult } from '../fs/safeReplace.ts';
import { joinRemotePath, normalizeRemotePath, parentRemotePath } from '../fs/remotePath.ts';
import type { Logger } from '../ports.ts';

export interface RemoteEntry {
  name: string;
  path: string;
  type: RemoteEntryType;
  size: bigint;
  mtime: number | undefined;
  permissions: number | undefined;
}

/** Enough to notice that a file changed under us, at the cost of one STAT. */
export interface RemoteBaseline {
  size: bigint;
  mtime: number | undefined;
}

export interface RemoteSessionOptions extends SshTransportOptions {
  clock: Clock;
  randomToken(): string;
  maxInFlight?: number;
}

export class RemoteSession {
  readonly alias: string;
  readonly #transport: SshTransport;
  readonly #client: SftpClient;
  readonly #locks = new PathLockRegistry();
  readonly #randomToken: () => string;
  readonly #logger: Logger | undefined;

  #rootPath = '/';
  #closed = false;
  readonly #closeListeners = new Set<(error?: Error) => void>();

  private constructor(options: RemoteSessionOptions, transport: SshTransport, client: SftpClient) {
    this.alias = options.alias;
    this.#transport = transport;
    this.#client = client;
    this.#randomToken = options.randomToken;
    this.#logger = options.logger;
  }

  static async connect(options: RemoteSessionOptions): Promise<RemoteSession> {
    const transport = new SshTransport(options);
    const channel = transport.start();
    const client = new SftpClient(channel, {
      clock: options.clock,
      ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight })
    });

    const session = new RemoteSession(options, transport, client);
    channel.onClose((error) => session.#handleClose(error));

    await client.handshake();
    // REALPATH "." is how the remote home directory is discovered; it is also the first
    // round trip that proves the channel really carries SFTP and not a shell banner.
    session.#rootPath = normalizeRemotePath(await client.realpath('.'));
    return session;
  }

  get rootPath(): string {
    return this.#rootPath;
  }

  get closed(): boolean {
    return this.#closed || this.#client.closed;
  }

  get capabilities(): SftpClient['capabilities'] {
    return this.#client.capabilities;
  }

  onDidClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(directory: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    const path = normalizeRemotePath(directory);
    const entries = await this.#client.readDirectory(path, { signal });
    return entries.map((entry) => toRemoteEntry(path, entry)).sort(compareEntries);
  }

  async stat(target: string, signal?: AbortSignal): Promise<RemoteEntry> {
    const path = normalizeRemotePath(target);
    const attributes = await this.#client.stat(path, signal);
    return {
      name: path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1),
      path,
      type: entryTypeOf(attributes),
      size: attributes.size ?? 0n,
      mtime: attributes.mtime,
      permissions: attributes.permissions
    };
  }

  async baseline(target: string, signal?: AbortSignal): Promise<RemoteBaseline> {
    const attributes = await this.#client.stat(normalizeRemotePath(target), signal);
    return { size: attributes.size ?? 0n, mtime: attributes.mtime };
  }

  async readFile(
    target: string,
    options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {}
  ): Promise<{ content: Uint8Array; baseline: RemoteBaseline }> {
    const path = normalizeRemotePath(target);
    // Stat before and after: if the file changed underneath the read, the bytes we assembled
    // may be a mix of two versions, and silently handing that to an editor would be worse
    // than making the user try again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.baseline(path, options.signal);
      const content = await this.#client.readFile(path, {
        size: before.size,
        signal: options.signal,
        onProgress: options.onProgress
      });
      const after = await this.baseline(path, options.signal);
      if (!baselineChanged(before, after)) return { content, baseline: after };
    }
    throw new Error(`${path} kept changing while it was being read. Open it again.`);
  }

  async readlink(target: string, signal?: AbortSignal): Promise<string> {
    return this.#client.readlink(normalizeRemotePath(target), signal);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Replace a file's contents, holding the write lock for its path and parent.
   *
   * Conflict detection happens inside the lock: checking outside it would leave a window in
   * which another save could land between the check and the replace.
   */
  async writeFile(
    target: string,
    content: Uint8Array,
    options: {
      expected?: RemoteBaseline | undefined;
      onConflict?: (current: RemoteBaseline) => Promise<boolean>;
      signal?: AbortSignal;
      onProgress?: (bytes: number) => void;
    } = {}
  ): Promise<SafeReplaceResult> {
    const path = normalizeRemotePath(target);

    return this.#locks.withWriteLock(path, async () => {
      let permissions: number | undefined;
      if (options.expected !== undefined) {
        let current: RemoteBaseline | undefined;
        try {
          const attributes = await this.#client.stat(path, options.signal);
          current = { size: attributes.size ?? 0n, mtime: attributes.mtime };
          permissions = attributes.permissions;
        } catch (error) {
          // A file that has been deleted is not a conflict; we are about to recreate it.
          if (!(error instanceof SftpStatusError && error.is(StatusCode.NoSuchFile))) throw error;
        }

        if (current !== undefined && baselineChanged(options.expected, current)) {
          const proceed = (await options.onConflict?.(current)) ?? false;
          if (!proceed) {
            throw new RemoteConflictError(path, options.expected, current);
          }
        }
      }

      return safeReplace({
        client: this.#client,
        path,
        content,
        permissions,
        randomToken: this.#randomToken,
        logger: this.#logger,
        signal: options.signal,
        onProgress: options.onProgress
      });
    });
  }

  async createDirectory(target: string, signal?: AbortSignal): Promise<void> {
    const path = normalizeRemotePath(target);
    await this.#locks.withWriteLock(path, () => this.#client.mkdir(path, {}, signal));
  }

  async createFile(target: string, signal?: AbortSignal): Promise<void> {
    const path = normalizeRemotePath(target);
    await this.#locks.withWriteLock(path, async () => {
      // Excl makes this fail rather than truncate when the name is already taken.
      const handle = await this.#client.open(
        path,
        OpenFlag.Write | OpenFlag.Creat | OpenFlag.Excl,
        {},
        signal
      );
      await this.#client.close(handle, signal);
    });
  }

  async remove(target: string, signal?: AbortSignal): Promise<void> {
    const path = normalizeRemotePath(target);
    await this.#locks.withWriteLock(path, () => this.#client.remove(path, signal));
  }

  async removeDirectory(target: string, signal?: AbortSignal): Promise<void> {
    const path = normalizeRemotePath(target);
    await this.#locks.withWriteLock(path, () => this.#client.rmdir(path, signal));
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    const source = normalizeRemotePath(from);
    const destination = normalizeRemotePath(to);
    await this.#locks.withWriteLock(source, () =>
      this.#locks.withWriteLock(destination, async () => {
        if (this.#client.capabilities.posixRename) {
          await this.#client.posixRename(source, destination, signal);
        } else {
          await this.#client.rename(source, destination, signal);
        }
      })
    );
  }

  /** Clean up temporary and backup files left by a save that was interrupted. */
  async sweep(directory: string): Promise<string[]> {
    return sweepArtifacts(this.#client, normalizeRemotePath(directory), this.#logger);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.dispose();
  }

  #handleClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of [...this.#closeListeners]) listener(error);
    this.#closeListeners.clear();
  }
}

export class RemoteConflictError extends Error {
  readonly path: string;
  readonly expected: RemoteBaseline;
  readonly current: RemoteBaseline;

  constructor(path: string, expected: RemoteBaseline, current: RemoteBaseline) {
    super(`${path} changed on the server since it was opened.`);
    this.name = 'RemoteConflictError';
    this.path = path;
    this.expected = expected;
    this.current = current;
  }
}

export function baselineChanged(a: RemoteBaseline, b: RemoteBaseline): boolean {
  return a.size !== b.size || a.mtime !== b.mtime;
}

function entryTypeOf(attributes: FileAttributes): RemoteEntryType {
  const permissions = attributes.permissions;
  if (permissions === undefined) return 'other';
  switch (permissions & 0o170000) {
    case 0o040000:
      return 'directory';
    case 0o100000:
      return 'file';
    case 0o120000:
      return 'symlink';
    default:
      return 'other';
  }
}

function toRemoteEntry(directory: string, entry: DirectoryEntry): RemoteEntry {
  return {
    name: entry.filename,
    path: joinRemotePath(directory, entry.filename),
    type: entry.type,
    size: entry.attributes.size ?? 0n,
    mtime: entry.attributes.mtime,
    permissions: entry.attributes.permissions
  };
}

/** Directories first, then by name -- the ordering the file browser expects. */
function compareEntries(a: RemoteEntry, b: RemoteEntry): number {
  const aDirectory = a.type === 'directory' ? 0 : 1;
  const bDirectory = b.type === 'directory' ? 0 : 1;
  if (aDirectory !== bDirectory) return aDirectory - bDirectory;
  return a.name.localeCompare(b.name);
}

export { parentRemotePath };
