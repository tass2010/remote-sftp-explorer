import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEntry,
  decodeResponse,
  decodeVersion,
  encodeInit,
  encodeOpen,
  encodeRead,
  encodeRealpath,
  encodeSymlink,
  encodeWrite,
  FrameDecoder,
  OpenFlag,
  PacketReader,
  PacketType,
  PacketWriter,
  readAttributes,
  readStatus,
  SftpProtocolError,
  StatusCode,
  writeAttributes
} from '../src/index.ts';

function body(framed: Uint8Array): Uint8Array {
  return framed.subarray(4);
}

// ---------------------------------------------------------------------------
// Writer and reader
// ---------------------------------------------------------------------------

test('the writer frames a packet with a big-endian length prefix', () => {
  const framed = encodeInit();
  assert.equal(framed.length, 4 + 5);
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  assert.equal(view.getUint32(0, false), 5);
  assert.equal(framed[4], PacketType.Init);
  assert.equal(view.getUint32(5, false), 3);
});

test('the writer grows past its initial capacity without corrupting earlier fields', () => {
  const writer = new PacketWriter(8).uint8(PacketType.Write).uint32(7);
  const payload = new Uint8Array(5000).fill(0xab);
  writer.string(payload);
  const framed = writer.buildFramed();

  const reader = new PacketReader(body(framed));
  assert.equal(reader.uint8(), PacketType.Write);
  assert.equal(reader.uint32(), 7);
  assert.deepEqual(reader.stringBytes(), payload);
  reader.assertFinished('grown packet');
});

test('the reader refuses to read past the end of a packet', () => {
  const reader = new PacketReader(new Uint8Array([0x01, 0x02]));
  assert.throws(() => reader.uint32(), SftpProtocolError);
});

test('the reader reports unexpected trailing bytes', () => {
  const reader = new PacketReader(new Uint8Array([1, 2, 3]));
  reader.uint8();
  assert.throws(() => reader.assertFinished('test packet'), /trailing bytes/);
});

test('64-bit sizes and offsets survive a round trip beyond Number.MAX_SAFE_INTEGER', () => {
  const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
  const framed = encodeRead(1, new Uint8Array([9]), huge, 4096);
  const reader = new PacketReader(body(framed));
  reader.uint8();
  reader.uint32();
  reader.stringBytes();
  assert.equal(reader.uint64(), huge);
  assert.equal(reader.uint32(), 4096);
});

test('paths round-trip as UTF-8, including spaces, newlines, and non-ASCII', () => {
  for (const path of ['/目录/文件.txt', '/a b/c', '/line\nbreak', '/emoji/🚀/x']) {
    const framed = encodeRealpath(1, path);
    const reader = new PacketReader(body(framed));
    reader.uint8();
    reader.uint32();
    assert.equal(reader.string(), path);
  }
});

// ---------------------------------------------------------------------------
// Frame decoder
// ---------------------------------------------------------------------------

test('the decoder reassembles a packet delivered one byte at a time', () => {
  const decoder = new FrameDecoder();
  const framed = encodeRealpath(42, '/home');
  const collected: Uint8Array[] = [];
  for (const byte of framed) collected.push(...decoder.push(new Uint8Array([byte])));

  assert.equal(collected.length, 1);
  const reader = new PacketReader(collected[0]!);
  assert.equal(reader.uint8(), PacketType.Realpath);
  assert.equal(reader.uint32(), 42);
  assert.equal(reader.string(), '/home');
  decoder.finish();
});

test('the decoder splits several packets arriving in one chunk', () => {
  const decoder = new FrameDecoder();
  const first = encodeRealpath(1, '/a');
  const second = encodeRealpath(2, '/b');
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);

  const packets = decoder.push(joined);
  assert.equal(packets.length, 2);
  decoder.finish();
});

test('the decoder rejects an oversized length before buffering the body', () => {
  const decoder = new FrameDecoder(64);
  const header = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096 > 64
  assert.throws(() => decoder.push(header), /exceeds limit/);
  // Nothing was retained: the limit check ran before any allocation.
  assert.equal(decoder.pendingBytes, 4);
});

test('the decoder rejects a zero-length packet', () => {
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(new Uint8Array([0, 0, 0, 0])), /packet type/);
});

test('the decoder reports a stream that ended mid-packet', () => {
  const decoder = new FrameDecoder();
  decoder.push(new Uint8Array([0, 0, 0, 5, 1]));
  assert.throws(() => decoder.finish(), /incomplete bytes/);
});

test('a length prefix split across chunks is still read correctly', () => {
  const decoder = new FrameDecoder();
  const framed = encodeRealpath(7, '/x');
  assert.equal(decoder.push(framed.subarray(0, 2)).length, 0);
  const packets = decoder.push(framed.subarray(2));
  assert.equal(packets.length, 1);
  decoder.finish();
});

// ---------------------------------------------------------------------------
// Attributes and status
// ---------------------------------------------------------------------------

test('attributes round-trip and omit absent fields', () => {
  const writer = new PacketWriter(64);
  writeAttributes(writer, { size: 1234n, permissions: 0o100644, atime: 1, mtime: 2 });
  const reader = new PacketReader(body(writer.buildFramed()));
  const attributes = readAttributes(reader);

  assert.equal(attributes.size, 1234n);
  assert.equal(attributes.permissions, 0o100644);
  assert.equal(attributes.mtime, 2);
  assert.equal(attributes.uid, undefined);
});

test('STATUS parses with and without the optional message and language tag', () => {
  // Draft-02 added the trailer; servers in the wild omit it, and treating that as malformed
  // -- which the previous implementation did -- breaks against them for no benefit.
  const withTrailer = new PacketWriter(64)
    .uint8(PacketType.Status)
    .uint32(1)
    .uint32(StatusCode.NoSuchFile)
    .string('not found')
    .string('en')
    .buildFramed();
  const bare = new PacketWriter(32)
    .uint8(PacketType.Status)
    .uint32(1)
    .uint32(StatusCode.NoSuchFile)
    .buildFramed();

  for (const packet of [withTrailer, bare]) {
    const reader = new PacketReader(body(packet));
    reader.uint8();
    reader.uint32();
    const status = readStatus(reader);
    assert.equal(status.code, StatusCode.NoSuchFile);
  }
});

test('entry type comes from permission bits, falling back to the long name', () => {
  assert.equal(classifyEntry(0o040755), 'directory');
  assert.equal(classifyEntry(0o100644), 'file');
  assert.equal(classifyEntry(0o120777), 'symlink');
  assert.equal(classifyEntry(0o010000), 'other');
  // Some servers omit permissions from READDIR attributes.
  assert.equal(classifyEntry(undefined, 'drwxr-xr-x 2 u g 4096 x'), 'directory');
  assert.equal(classifyEntry(undefined, '-rw-r--r-- 1 u g 10 x'), 'file');
  assert.equal(classifyEntry(undefined, 'lrwxrwxrwx 1 u g 3 x -> y'), 'symlink');
  assert.equal(classifyEntry(undefined, ''), 'other');
});

// ---------------------------------------------------------------------------
// Packet specifics
// ---------------------------------------------------------------------------

test('SYMLINK sends targetpath before linkpath, matching OpenSSH', () => {
  // OpenSSH's server implements v3 SYMLINK with the arguments reversed relative to the draft.
  // Every real client follows OpenSSH; getting this backwards silently creates a link that
  // points at the wrong place, which is why it is pinned here.
  const framed = encodeSymlink(1, '/link', '/target');
  const reader = new PacketReader(body(framed));
  assert.equal(reader.uint8(), PacketType.Symlink);
  reader.uint32();
  assert.equal(reader.string(), '/target', 'targetpath must be first on the wire');
  assert.equal(reader.string(), '/link');
});

test('OPEN carries flags and attributes', () => {
  const framed = encodeOpen(3, '/f', OpenFlag.Write | OpenFlag.Creat, { permissions: 0o644 });
  const reader = new PacketReader(body(framed));
  reader.uint8();
  reader.uint32();
  assert.equal(reader.string(), '/f');
  assert.equal(reader.uint32(), OpenFlag.Write | OpenFlag.Creat);
  assert.equal(readAttributes(reader).permissions, 0o644);
});

test('WRITE frames its payload as a length-prefixed string', () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const framed = encodeWrite(5, new Uint8Array([0xaa]), 100n, payload);
  const reader = new PacketReader(body(framed));
  reader.uint8();
  reader.uint32();
  reader.stringBytes();
  assert.equal(reader.uint64(), 100n);
  assert.deepEqual(reader.stringBytes(), payload);
});

test('VERSION keeps extension values as bytes rather than assuming text', () => {
  const writer = new PacketWriter(64).uint8(PacketType.Version).uint32(3);
  writer.string('posix-rename@openssh.com').string('1');
  writer.string('binary-ext').string(new Uint8Array([0xff, 0xfe]));
  const version = decodeVersion(body(writer.buildFramed()));

  assert.equal(version.version, 3);
  assert.deepEqual(version.extensions.get('binary-ext'), new Uint8Array([0xff, 0xfe]));
});

test('decodeResponse rejects an unknown packet type', () => {
  const packet = new PacketWriter(16).uint8(199).uint32(1).buildFramed();
  assert.throws(() => decodeResponse(body(packet)), /unknown SFTP response packet type 199/);
});
