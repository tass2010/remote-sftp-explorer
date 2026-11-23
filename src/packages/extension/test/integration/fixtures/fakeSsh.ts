/**
 * A stand-in for `ssh.exe`, for the Extension Host tests.
 *
 * It is spawned by the real `NodeProcessSpawner`, over real pipes, and answers real SFTP v3
 * framing -- so everything between the extension and the wire is exercised, not stubbed. What
 * it replaces is only the network and the server on the far end, which it serves from a local
 * directory named by `REMOTE_SFTP_FAKE_ROOT`.
 *
 * Two modes, matching the two ways the extension invokes ssh:
 *   `ssh -G <alias>`         host discovery validating an alias
 *   `ssh ... -s <alias> sftp` the SFTP subsystem
 *
 * Statting `/.disconnect` makes the process exit without answering, which is how a test drops
 * the link. Anything else would have to race a real socket.
 */
import type * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  FrameDecoder,
  OpenFlag,
  PacketReader,
  PacketType,
  PacketWriter,
  StatusCode,
  writeAttributes,
  type FileAttributes
} from '@remote-sftp-explorer/sftp-protocol';

const SFTP_VERSION = 3;
/** Statting this path makes the server exit, which is how a test drops the link. */
const DISCONNECT_PATH = '/.disconnect';

const root = process.env['REMOTE_SFTP_FAKE_ROOT'];
if (root === undefined) {
  process.stderr.write('REMOTE_SFTP_FAKE_ROOT is not set\n');
  process.exit(2);
}

const argv = process.argv.slice(2);

if (argv.includes('-G')) {
  // `ssh -G <alias>` dumps the effective configuration. Host discovery only needs it to exit
  // zero and name a hostname, so that is all this prints.
  const alias = argv[argv.indexOf('-G') + 1] ?? 'unknown';
  process.stdout.write(`host ${alias}\nhostname ${alias}.test.invalid\nuser tester\nport 22\n`);
  process.exit(0);
}

// -- filesystem -------------------------------------------------------------

/** Map a remote path onto the served directory, refusing anything that escapes it. */
function local(remote: string): string {
  const normalized = path.posix.normalize(remote.startsWith('/') ? remote : `/${remote}`);
  const resolved = path.join(root as string, normalized);
  const base = path.resolve(root as string);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw Object.assign(new Error('outside the served root'), { code: 'EACCES' });
  }
  return resolved;
}

function attributesOf(stat: fs.Stats): FileAttributes {
  let mode = stat.mode & 0o7777;
  if (stat.isDirectory()) mode |= 0o040000;
  else if (stat.isSymbolicLink()) mode |= 0o120000;
  else mode |= 0o100000;
  return {
    size: BigInt(stat.size),
    permissions: mode,
    // v3 couples atime and mtime under a single flag, so both travel or neither does.
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  };
}

function statusFor(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'ENOENT') return StatusCode.NoSuchFile;
  if (code === 'EACCES' || code === 'EPERM') return StatusCode.PermissionDenied;
  return StatusCode.Failure;
}

// -- responses --------------------------------------------------------------

const out = process.stdout;

function send(packet: Uint8Array): void {
  out.write(packet);
}

function status(requestId: number, code: number, message = ''): void {
  send(
    new PacketWriter(64)
      .uint8(PacketType.Status)
      .uint32(requestId)
      .uint32(code)
      .string(message)
      .string('')
      .buildFramed()
  );
}

function ok(requestId: number): void {
  status(requestId, StatusCode.Ok);
}

function fail(requestId: number, error: unknown): void {
  status(requestId, statusFor(error), String((error as Error).message ?? error));
}

function handlePacket(requestId: number, handle: string): void {
  send(
    new PacketWriter(32)
      .uint8(PacketType.Handle)
      .uint32(requestId)
      .string(handle)
      .buildFramed()
  );
}

function attrs(requestId: number, attributes: FileAttributes): void {
  send(writeAttributes(new PacketWriter(64).uint8(PacketType.Attrs).uint32(requestId), attributes).buildFramed());
}

function names(
  requestId: number,
  entries: Array<{ filename: string; attributes: FileAttributes }>
): void {
  const writer = new PacketWriter(1024)
    .uint8(PacketType.Name)
    .uint32(requestId)
    .uint32(entries.length);
  for (const entry of entries) {
    writer.string(entry.filename).string(entry.filename);
    writeAttributes(writer, entry.attributes);
  }
  send(writer.buildFramed());
}

// -- handles ----------------------------------------------------------------

interface FileHandleState {
  kind: 'file';
  fd: fsp.FileHandle;
}
interface DirHandleState {
  kind: 'dir';
  entries: Array<{ filename: string; attributes: FileAttributes }>;
  served: boolean;
}

const handles = new Map<string, FileHandleState | DirHandleState>();
let nextHandle = 1;

function openFlagsToNode(flags: number): string {
  const read = (flags & OpenFlag.Read) !== 0;
  const write = (flags & OpenFlag.Write) !== 0;
  const excl = (flags & OpenFlag.Excl) !== 0;
  const trunc = (flags & OpenFlag.Trunc) !== 0;
  const creat = (flags & OpenFlag.Creat) !== 0;

  if (write && excl) return 'wx';
  if (write && trunc) return 'w';
  if (write && creat) return read ? 'a+' : 'a';
  if (write) return 'r+';
  return 'r';
}

// -- dispatch ---------------------------------------------------------------

async function dispatch(type: number, requestId: number, reader: PacketReader): Promise<void> {
  switch (type) {
    case PacketType.Realpath: {
      const target = reader.string();
      if (target === '.') {
        names(requestId, [{ filename: '/', attributes: {} }]);
        return;
      }
      // Resolved on disk, as OpenSSH does: following a link to a directory depends on REALPATH
      // answering with where the link leads, not with the link's own path.
      try {
        const base = await fsp.realpath(root as string);
        const real = await fsp.realpath(local(target));
        const inside = path.relative(base, real).split(path.sep).join('/');
        names(requestId, [{ filename: `/${inside}`, attributes: {} }]);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Stat:
    case PacketType.Lstat: {
      const target = reader.string();
      // The kill switch. Exiting without answering is what a dropped connection looks like
      // from the client's side: a closed pipe with requests still outstanding.
      if (target === DISCONNECT_PATH) {
        process.exit(1);
      }
      try {
        const stat =
          type === PacketType.Stat
            ? await fsp.stat(local(target))
            : await fsp.lstat(local(target));
        attrs(requestId, attributesOf(stat));
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Opendir: {
      const target = reader.string();
      try {
        const directory = local(target);
        const found = await fsp.readdir(directory);
        const entries: Array<{ filename: string; attributes: FileAttributes }> = [];
        for (const name of found) {
          const stat = await fsp.lstat(path.join(directory, name));
          entries.push({ filename: name, attributes: attributesOf(stat) });
        }
        const id = `d${nextHandle++}`;
        handles.set(id, { kind: 'dir', entries, served: false });
        handlePacket(requestId, id);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Readdir: {
      const id = reader.string();
      const state = handles.get(id);
      if (state === undefined || state.kind !== 'dir') {
        status(requestId, StatusCode.Failure, 'bad handle');
        return;
      }
      if (state.served) {
        status(requestId, StatusCode.Eof);
        return;
      }
      state.served = true;
      if (state.entries.length === 0) {
        status(requestId, StatusCode.Eof);
        return;
      }
      names(requestId, state.entries);
      return;
    }

    case PacketType.Open: {
      const target = reader.string();
      const flags = reader.uint32();
      try {
        const fd = await fsp.open(local(target), openFlagsToNode(flags));
        const id = `f${nextHandle++}`;
        handles.set(id, { kind: 'file', fd });
        handlePacket(requestId, id);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Read: {
      const id = reader.string();
      const offset = Number(reader.uint64());
      const length = reader.uint32();
      const state = handles.get(id);
      if (state === undefined || state.kind !== 'file') {
        status(requestId, StatusCode.Failure, 'bad handle');
        return;
      }
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await state.fd.read(buffer, 0, length, offset);
        if (bytesRead === 0) {
          status(requestId, StatusCode.Eof);
          return;
        }
        send(
          new PacketWriter(bytesRead + 32)
            .uint8(PacketType.Data)
            .uint32(requestId)
            .string(buffer.subarray(0, bytesRead))
            .buildFramed()
        );
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Write: {
      const id = reader.string();
      const offset = Number(reader.uint64());
      const data = reader.stringBytes();
      const state = handles.get(id);
      if (state === undefined || state.kind !== 'file') {
        status(requestId, StatusCode.Failure, 'bad handle');
        return;
      }
      try {
        await state.fd.write(Buffer.from(data), 0, data.length, offset);
        ok(requestId);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Close: {
      const id = reader.string();
      const state = handles.get(id);
      handles.delete(id);
      if (state?.kind === 'file') await state.fd.close().catch(() => undefined);
      ok(requestId);
      return;
    }

    case PacketType.Mkdir: {
      const target = reader.string();
      try {
        await fsp.mkdir(local(target));
        ok(requestId);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Rmdir: {
      const target = reader.string();
      try {
        await fsp.rmdir(local(target));
        ok(requestId);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Remove: {
      const target = reader.string();
      try {
        await fsp.unlink(local(target));
        ok(requestId);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Rename: {
      const from = reader.string();
      const to = reader.string();
      try {
        // v3 RENAME must not clobber, which is exactly why the client has a backup fallback.
        await fsp.access(local(to)).then(
          () => {
            throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
          },
          () => undefined
        );
        await fsp.rename(local(from), local(to));
        ok(requestId);
      } catch (error) {
        fail(requestId, error);
      }
      return;
    }

    case PacketType.Setstat:
    case PacketType.Fsetstat: {
      // Accepted and ignored: nothing under test depends on the mode actually changing, and
      // refusing would make saves fail for a reason that has nothing to do with the test.
      ok(requestId);
      return;
    }

    case PacketType.Extended: {
      const extension = reader.string();
      if (extension === 'posix-rename@openssh.com') {
        const from = reader.string();
        const to = reader.string();
        try {
          await fsp.rename(local(from), local(to));
          ok(requestId);
        } catch (error) {
          fail(requestId, error);
        }
        return;
      }
      if (extension === 'fsync@openssh.com') {
        const id = reader.string();
        const state = handles.get(id);
        if (state?.kind === 'file') await state.fd.sync().catch(() => undefined);
        ok(requestId);
        return;
      }
      status(requestId, StatusCode.OpUnsupported, extension);
      return;
    }

    default:
      status(requestId, StatusCode.OpUnsupported, `type ${type}`);
  }
}

// -- wire -------------------------------------------------------------------

const decoder = new FrameDecoder();
/** Packets are handled strictly in order so a READ never overtakes the WRITE before it. */
let chain: Promise<void> = Promise.resolve();

process.stdin.on('data', (chunk: Buffer) => {
  for (const packet of decoder.push(new Uint8Array(chunk))) {
    const reader = new PacketReader(packet);
    const type = reader.uint8();

    if (type === PacketType.Init) {
      reader.uint32();
      const version = new PacketWriter(128).uint8(PacketType.Version).uint32(SFTP_VERSION);
      for (const [name, value] of [
        ['posix-rename@openssh.com', '1'],
        ['fsync@openssh.com', '1']
      ]) {
        version.string(name as string).string(value as string);
      }
      send(version.buildFramed());
      continue;
    }

    const requestId = reader.uint32();
    chain = chain.then(() =>
      dispatch(type, requestId, reader).catch((error: unknown) => {
        fail(requestId, error);
      })
    );
  }
});

process.stdin.on('end', () => process.exit(0));
