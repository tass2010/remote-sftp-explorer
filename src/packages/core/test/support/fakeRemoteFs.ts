/**
 * An in-memory remote filesystem behind a FakeSftpServer.
 *
 * Failures are injected by predicate rather than by exact path, because the paths that matter
 * for save-path testing (the temporary and backup files) are generated internally and are not
 * known to the test.
 */
import {
  Extension,
  OpenFlag,
  PacketType,
  readAttributes,
  SftpClient,
  StatusCode
} from '@remote-sftp-explorer/sftp-protocol';
import {
  createControllableClock,
  FakeSftpServer
} from '../../../sftp-protocol/test/support/fakeSftpServer.ts';

export type Operation =
  | 'open'
  | 'write'
  | 'rename'
  | 'posix-rename'
  | 'remove'
  | 'read'
  | 'fsync'
  | 'close';

export interface FailureRule {
  operation: Operation;
  /** Applied to the primary path (source path for renames). */
  match(path: string, target?: string): boolean;
  code?: number;
  /** Fail only this many times, then stop. Defaults to once. */
  times?: number;
}

export class FakeRemoteFs {
  readonly files = new Map<string, Uint8Array>();
  readonly permissions = new Map<string, number>();
  readonly operations: Array<{ operation: Operation; path: string; target?: string }> = [];

  #rules: FailureRule[] = [];
  #nextHandle = 1;
  readonly #handles = new Map<string, string>();
  readonly #listed = new Set<string>();

  fail(rule: FailureRule): void {
    this.#rules.push({ times: 1, code: StatusCode.Failure, ...rule });
  }

  write(path: string, text: string, mode?: number): void {
    this.files.set(path, new TextEncoder().encode(text));
    if (mode !== undefined) this.permissions.set(path, mode);
  }

  read(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  /** Paths that look like leftovers from an interrupted save. */
  artifacts(): string[] {
    return [...this.files.keys()].filter((path) => path.includes('.remote-sftp-')).sort();
  }

  #check(operation: Operation, path: string, target?: string): number | undefined {
    this.operations.push(target === undefined ? { operation, path } : { operation, path, target });
    const index = this.#rules.findIndex(
      (rule) => rule.operation === operation && rule.match(path, target)
    );
    if (index < 0) return undefined;
    const rule = this.#rules[index]!;
    const remaining = (rule.times ?? 1) - 1;
    if (remaining <= 0) this.#rules.splice(index, 1);
    else rule.times = remaining;
    return rule.code ?? StatusCode.Failure;
  }

  install(server: FakeSftpServer): void {
    server.on(PacketType.Open, ({ requestId, reader }) => {
      const path = reader.string();
      const flags = reader.uint32();
      const attributes = readAttributes(reader);
      const failure = this.#check('open', path);
      if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'open failed');

      const exists = this.files.has(path);
      // Excl means "create, and fail if it is already there" -- never truncate.
      if (exists && (flags & OpenFlag.Excl) !== 0 && (flags & OpenFlag.Creat) !== 0) {
        return FakeSftpServer.status(requestId, StatusCode.Failure, 'already exists');
      }
      if (!exists && (flags & OpenFlag.Creat) === 0) {
        return FakeSftpServer.status(requestId, StatusCode.NoSuchFile, 'missing');
      }

      const id = String(this.#nextHandle++);
      this.#handles.set(id, path);
      // Only create or truncate when asked; a read-only open must leave the content alone.
      if (!exists || (flags & OpenFlag.Trunc) !== 0) {
        this.files.set(path, new Uint8Array(0));
      }
      // Creating with a mode is how the replacement inherits the original's permissions.
      if (attributes.permissions !== undefined) {
        this.permissions.set(path, attributes.permissions);
      }
      return FakeSftpServer.handle(requestId, new TextEncoder().encode(id));
    });

    server.on(PacketType.Write, ({ requestId, reader }) => {
      const handle = new TextDecoder().decode(reader.stringBytes());
      const offset = Number(reader.uint64());
      const data = Uint8Array.from(reader.stringBytes());
      const path = this.#handles.get(handle);
      if (path === undefined) {
        return FakeSftpServer.status(requestId, StatusCode.Failure, 'bad handle');
      }
      const failure = this.#check('write', path);
      if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'write failed');

      const existing = this.files.get(path) ?? new Uint8Array(0);
      const grown = new Uint8Array(Math.max(existing.length, offset + data.length));
      grown.set(existing, 0);
      grown.set(data, offset);
      this.files.set(path, grown);
      return FakeSftpServer.status(requestId, StatusCode.Ok);
    });

    server.on(PacketType.Read, ({ requestId, reader }) => {
      const handle = new TextDecoder().decode(reader.stringBytes());
      const offset = Number(reader.uint64());
      const length = reader.uint32();
      const path = this.#handles.get(handle);
      if (path === undefined) {
        return FakeSftpServer.status(requestId, StatusCode.Failure, 'bad handle');
      }
      const failure = this.#check('read', path);
      if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'read failed');

      const contents = this.files.get(path) ?? new Uint8Array(0);
      if (offset >= contents.length) {
        return FakeSftpServer.status(requestId, StatusCode.Eof);
      }
      return FakeSftpServer.data(
        requestId,
        contents.subarray(offset, Math.min(offset + length, contents.length))
      );
    });

    server.on(PacketType.Close, ({ requestId, reader }) => {
      const handle = new TextDecoder().decode(reader.stringBytes());
      this.#handles.delete(handle);
      return FakeSftpServer.status(requestId, StatusCode.Ok);
    });

    server.on(PacketType.Rename, ({ requestId, reader }) => {
      const from = reader.string();
      const to = reader.string();
      const failure = this.#check('rename', from, to);
      if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'rename failed');
      return this.#move(requestId, from, to);
    });

    server.on(PacketType.Remove, ({ requestId, reader }) => {
      const path = reader.string();
      const failure = this.#check('remove', path);
      if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'remove failed');
      this.files.delete(path);
      this.permissions.delete(path);
      return FakeSftpServer.status(requestId, StatusCode.Ok);
    });

    server.on(PacketType.Extended, ({ requestId, reader }) => {
      const extension = reader.string();
      if (extension === Extension.PosixRename) {
        const from = reader.string();
        const to = reader.string();
        const failure = this.#check('posix-rename', from, to);
        if (failure !== undefined) {
          return FakeSftpServer.status(requestId, failure, 'posix rename failed');
        }
        return this.#move(requestId, from, to);
      }
      if (extension === Extension.Fsync) {
        const handle = new TextDecoder().decode(reader.stringBytes());
        const failure = this.#check('fsync', this.#handles.get(handle) ?? '');
        if (failure !== undefined) return FakeSftpServer.status(requestId, failure, 'fsync failed');
        return FakeSftpServer.status(requestId, StatusCode.Ok);
      }
      return FakeSftpServer.status(requestId, StatusCode.OpUnsupported, 'unsupported');
    });

    server.on(PacketType.Opendir, ({ requestId, reader }) => {
      const path = reader.string();
      const id = String(this.#nextHandle++);
      this.#handles.set(id, path);
      return FakeSftpServer.handle(requestId, new TextEncoder().encode(id));
    });

    server.on(PacketType.Readdir, ({ requestId, reader }) => {
      const handle = new TextDecoder().decode(reader.stringBytes());
      const directory = this.#handles.get(handle) ?? '/';
      if (this.#listed.has(handle)) return FakeSftpServer.status(requestId, StatusCode.Eof);
      this.#listed.add(handle);
      const prefix = directory === '/' ? '/' : `${directory}/`;
      const names = [...this.files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length));
      if (names.length === 0) return FakeSftpServer.status(requestId, StatusCode.Eof);
      return FakeSftpServer.name(
        requestId,
        names.map((filename) => ({
          filename,
          attributes: { permissions: this.permissions.get(prefix + filename) ?? 0o100644 }
        }))
      );
    });

    server.on(PacketType.Stat, ({ requestId, reader }) => {
      const path = reader.string();
      const bytes = this.files.get(path);
      if (bytes === undefined) {
        return FakeSftpServer.status(requestId, StatusCode.NoSuchFile, 'missing');
      }
      return FakeSftpServer.attrs(requestId, {
        size: BigInt(bytes.length),
        permissions: this.permissions.get(path) ?? 0o100644,
        // v3 couples atime and mtime under one flag, so both must be present.
        atime: 900,
        mtime: 1000
      });
    });
  }

  #move(requestId: number, from: string, to: string): Uint8Array {
    const entry = this.files.get(from);
    if (entry === undefined) {
      return FakeSftpServer.status(requestId, StatusCode.NoSuchFile, 'missing');
    }
    const mode = this.permissions.get(from);
    this.files.delete(from);
    this.permissions.delete(from);
    this.files.set(to, entry);
    if (mode !== undefined) this.permissions.set(to, mode);
    return FakeSftpServer.status(requestId, StatusCode.Ok);
  }
}

export interface Harness {
  client: SftpClient;
  fs: FakeRemoteFs;
  server: FakeSftpServer;
}

export async function createHarness(
  options: { posixRename?: boolean; fsync?: boolean } = {}
): Promise<Harness> {
  const extensions: Record<string, string> = {};
  if (options.posixRename !== false) extensions[Extension.PosixRename] = '1';
  if (options.fsync !== false) extensions[Extension.Fsync] = '1';

  const server = new FakeSftpServer({ extensions });
  const fs = new FakeRemoteFs();
  fs.install(server);
  const client = new SftpClient(server.channel, { clock: createControllableClock() });
  await client.handshake();
  return { client, fs, server };
}
