import { AttributeFlag, FileTypeBits, FileTypeMask } from '../constants.ts';
import type { PacketReader } from './reader.ts';
import type { PacketWriter } from './writer.ts';

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

/**
 * SFTP v3 ATTRS. Every field is optional because the flags word says which are present.
 *
 * Sizes are bigint: a remote file may exceed Number.MAX_SAFE_INTEGER, and silently losing
 * precision on a size is how you get a truncated download.
 */
export interface FileAttributes {
  size?: bigint;
  uid?: number;
  gid?: number;
  permissions?: number;
  atime?: number;
  mtime?: number;
  extended?: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
}

export function readAttributes(reader: PacketReader): FileAttributes {
  const flags = reader.uint32();
  const attributes: FileAttributes = {};
  if ((flags & AttributeFlag.Size) !== 0) attributes.size = reader.uint64();
  if ((flags & AttributeFlag.UidGid) !== 0) {
    attributes.uid = reader.uint32();
    attributes.gid = reader.uint32();
  }
  if ((flags & AttributeFlag.Permissions) !== 0) attributes.permissions = reader.uint32();
  if ((flags & AttributeFlag.AccessModifyTime) !== 0) {
    attributes.atime = reader.uint32();
    attributes.mtime = reader.uint32();
  }
  if ((flags & AttributeFlag.Extended) !== 0) {
    const count = reader.uint32();
    const extended: Array<readonly [Uint8Array, Uint8Array]> = [];
    for (let index = 0; index < count; index += 1) {
      extended.push([
        Uint8Array.from(reader.stringBytes()),
        Uint8Array.from(reader.stringBytes())
      ]);
    }
    attributes.extended = extended;
  }
  return attributes;
}

export function writeAttributes(writer: PacketWriter, attributes: FileAttributes): PacketWriter {
  let flags = 0;
  if (attributes.size !== undefined) flags |= AttributeFlag.Size;
  if (attributes.uid !== undefined && attributes.gid !== undefined) flags |= AttributeFlag.UidGid;
  if (attributes.permissions !== undefined) flags |= AttributeFlag.Permissions;
  if (attributes.atime !== undefined && attributes.mtime !== undefined) {
    flags |= AttributeFlag.AccessModifyTime;
  }

  writer.uint32(flags);
  if (attributes.size !== undefined) writer.uint64(attributes.size);
  if (attributes.uid !== undefined && attributes.gid !== undefined) {
    writer.uint32(attributes.uid).uint32(attributes.gid);
  }
  if (attributes.permissions !== undefined) writer.uint32(attributes.permissions);
  if (attributes.atime !== undefined && attributes.mtime !== undefined) {
    writer.uint32(attributes.atime).uint32(attributes.mtime);
  }
  return writer;
}

/** No attributes at all -- the common case for OPEN when we do not want to set anything. */
export const NO_ATTRIBUTES: FileAttributes = {};

/**
 * Classify an entry.
 *
 * Permission bits are authoritative when present. The `longname` fallback exists because some
 * servers omit permissions from READDIR attributes, and the first character of the ls-style
 * long name still tells us what we need.
 */
export function classifyEntry(
  permissions: number | undefined,
  longname = ''
): RemoteEntryType {
  if (permissions !== undefined) {
    switch (permissions & FileTypeMask) {
      case FileTypeBits.Directory:
        return 'directory';
      case FileTypeBits.Regular:
        return 'file';
      case FileTypeBits.Symlink:
        return 'symlink';
      default:
        return 'other';
    }
  }
  switch (longname.charAt(0)) {
    case 'd':
      return 'directory';
    case '-':
      return 'file';
    case 'l':
      return 'symlink';
    default:
      return 'other';
  }
}
