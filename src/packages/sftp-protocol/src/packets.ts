import { OpenFlag, PacketType, SFTP_VERSION } from './constants.ts';
import { PacketReader } from './wire/reader.ts';
import { PacketWriter, requestWriter } from './wire/writer.ts';
import { SftpProtocolError } from './wire/errors.ts';
import { readAttributes, writeAttributes, type FileAttributes } from './wire/attributes.ts';
import { expectType, readStatus, type SftpStatus } from './wire/status.ts';

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface VersionPacket {
  version: number;
  extensions: ReadonlyMap<string, Uint8Array>;
}

export function encodeInit(version = SFTP_VERSION): Uint8Array {
  return new PacketWriter(16).uint8(PacketType.Init).uint32(version).buildFramed();
}

export function decodeVersion(payload: Uint8Array): VersionPacket {
  const reader = new PacketReader(payload);
  expectType(reader.uint8(), PacketType.Version, 'VERSION');
  const version = reader.uint32();
  const extensions = new Map<string, Uint8Array>();
  while (reader.remaining > 0) {
    const name = reader.string();
    // Extension values are arbitrary bytes -- never assume UTF-8 text.
    extensions.set(name, Uint8Array.from(reader.stringBytes()));
  }
  return { version, extensions };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function encodeOpen(
  requestId: number,
  path: string,
  flags: number,
  attributes: FileAttributes = {}
): Uint8Array {
  const writer = requestWriter(PacketType.Open, requestId).string(path).uint32(flags);
  return writeAttributes(writer, attributes).buildFramed();
}

export function encodeClose(requestId: number, handle: Uint8Array): Uint8Array {
  return requestWriter(PacketType.Close, requestId).string(handle).buildFramed();
}

export function encodeRead(
  requestId: number,
  handle: Uint8Array,
  offset: bigint,
  length: number
): Uint8Array {
  return requestWriter(PacketType.Read, requestId)
    .string(handle)
    .uint64(offset)
    .uint32(length)
    .buildFramed();
}

export function encodeWrite(
  requestId: number,
  handle: Uint8Array,
  offset: bigint,
  data: Uint8Array
): Uint8Array {
  return requestWriter(PacketType.Write, requestId, data.length + 64)
    .string(handle)
    .uint64(offset)
    .string(data)
    .buildFramed();
}

export function encodeOpendir(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Opendir, requestId).string(path).buildFramed();
}

export function encodeReaddir(requestId: number, handle: Uint8Array): Uint8Array {
  return requestWriter(PacketType.Readdir, requestId).string(handle).buildFramed();
}

export function encodeStat(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Stat, requestId).string(path).buildFramed();
}

export function encodeLstat(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Lstat, requestId).string(path).buildFramed();
}

export function encodeFstat(requestId: number, handle: Uint8Array): Uint8Array {
  return requestWriter(PacketType.Fstat, requestId).string(handle).buildFramed();
}

export function encodeSetstat(
  requestId: number,
  path: string,
  attributes: FileAttributes
): Uint8Array {
  const writer = requestWriter(PacketType.Setstat, requestId).string(path);
  return writeAttributes(writer, attributes).buildFramed();
}

export function encodeFsetstat(
  requestId: number,
  handle: Uint8Array,
  attributes: FileAttributes
): Uint8Array {
  const writer = requestWriter(PacketType.Fsetstat, requestId).string(handle);
  return writeAttributes(writer, attributes).buildFramed();
}

export function encodeRemove(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Remove, requestId).string(path).buildFramed();
}

export function encodeMkdir(
  requestId: number,
  path: string,
  attributes: FileAttributes = {}
): Uint8Array {
  const writer = requestWriter(PacketType.Mkdir, requestId).string(path);
  return writeAttributes(writer, attributes).buildFramed();
}

export function encodeRmdir(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Rmdir, requestId).string(path).buildFramed();
}

export function encodeRealpath(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Realpath, requestId).string(path).buildFramed();
}

export function encodeRename(requestId: number, from: string, to: string): Uint8Array {
  return requestWriter(PacketType.Rename, requestId).string(from).string(to).buildFramed();
}

export function encodeReadlink(requestId: number, path: string): Uint8Array {
  return requestWriter(PacketType.Readlink, requestId).string(path).buildFramed();
}

/**
 * SSH_FXP_SYMLINK.
 *
 * Beware: OpenSSH's server implements v3 SYMLINK with the arguments in the OPPOSITE order to
 * the draft -- it reads linkpath first, then targetpath. Every real-world client follows
 * OpenSSH, so we do too. Getting this backwards silently creates a link pointing at the wrong
 * place, which is why it has a dedicated test.
 */
export function encodeSymlink(
  requestId: number,
  linkPath: string,
  targetPath: string
): Uint8Array {
  return requestWriter(PacketType.Symlink, requestId)
    .string(targetPath)
    .string(linkPath)
    .buildFramed();
}

export function encodeExtended(
  requestId: number,
  extension: string,
  build: (writer: PacketWriter) => PacketWriter
): Uint8Array {
  return build(requestWriter(PacketType.Extended, requestId).string(extension)).buildFramed();
}

export function encodePosixRename(requestId: number, from: string, to: string): Uint8Array {
  return encodeExtended(requestId, 'posix-rename@openssh.com', (writer) =>
    writer.string(from).string(to)
  );
}

export function encodeFsync(requestId: number, handle: Uint8Array): Uint8Array {
  return encodeExtended(requestId, 'fsync@openssh.com', (writer) => writer.string(handle));
}

export function encodeLimits(requestId: number): Uint8Array {
  return encodeExtended(requestId, 'limits@openssh.com', (writer) => writer);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface NameEntry {
  filename: string;
  longname: string;
  attributes: FileAttributes;
}

export type ResponseBody =
  | { kind: 'status'; status: SftpStatus }
  | { kind: 'handle'; handle: Uint8Array }
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'name'; entries: NameEntry[] }
  | { kind: 'attrs'; attributes: FileAttributes }
  | { kind: 'extendedReply'; reader: PacketReader };

export interface DecodedResponse {
  type: number;
  requestId: number;
  body: ResponseBody;
}

/** Split a response packet into its type, request id, and typed body. */
export function decodeResponse(payload: Uint8Array): DecodedResponse {
  const reader = new PacketReader(payload);
  const type = reader.uint8();
  const requestId = reader.uint32();

  switch (type) {
    case PacketType.Status:
      return { type, requestId, body: { kind: 'status', status: readStatus(reader) } };
    case PacketType.Handle:
      return {
        type,
        requestId,
        body: { kind: 'handle', handle: Uint8Array.from(reader.stringBytes()) }
      };
    case PacketType.Data:
      return {
        type,
        requestId,
        body: { kind: 'data', data: Uint8Array.from(reader.stringBytes()) }
      };
    case PacketType.Name: {
      const count = reader.uint32();
      const entries: NameEntry[] = [];
      for (let index = 0; index < count; index += 1) {
        const filename = reader.string();
        const longname = reader.string();
        entries.push({ filename, longname, attributes: readAttributes(reader) });
      }
      return { type, requestId, body: { kind: 'name', entries } };
    }
    case PacketType.Attrs:
      return { type, requestId, body: { kind: 'attrs', attributes: readAttributes(reader) } };
    case PacketType.ExtendedReply:
      return { type, requestId, body: { kind: 'extendedReply', reader } };
    default:
      throw new SftpProtocolError(`unknown SFTP response packet type ${type}`);
  }
}

export interface ServerLimits {
  maxPacketLength: bigint;
  maxReadLength: bigint;
  maxWriteLength: bigint;
  maxOpenHandles: bigint;
}

export function decodeLimitsReply(reader: PacketReader): ServerLimits {
  return {
    maxPacketLength: reader.uint64(),
    maxReadLength: reader.uint64(),
    maxWriteLength: reader.uint64(),
    maxOpenHandles: reader.uint64()
  };
}

export { OpenFlag };
