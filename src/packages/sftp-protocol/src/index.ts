export {
  AttributeFlag,
  DEFAULT_MAX_PACKET_LENGTH,
  Extension,
  FileTypeBits,
  FileTypeMask,
  OpenFlag,
  PacketType,
  SFTP_VERSION,
  type PacketTypeValue
} from './constants.ts';

export { SftpProtocolError } from './wire/errors.ts';
export { PacketReader } from './wire/reader.ts';
export { PacketWriter, requestWriter } from './wire/writer.ts';
export { FrameDecoder } from './wire/frameDecoder.ts';
export {
  classifyEntry,
  NO_ATTRIBUTES,
  readAttributes,
  writeAttributes,
  type FileAttributes,
  type RemoteEntryType
} from './wire/attributes.ts';
export {
  assertOk,
  expectType,
  readStatus,
  SftpStatusError,
  StatusCode,
  statusName,
  type SftpStatus,
  type StatusCodeValue
} from './wire/status.ts';

export * from './packets.ts';

export type { ByteChannel } from './client/channel.ts';
export type { AbortLike, Clock } from './client/platform.ts';
export { ServerCapabilities } from './client/capabilities.ts';
export { RequestRegistry } from './client/requestRegistry.ts';
export {
  SftpClient,
  type DirectoryEntry,
  type ReadFileOptions,
  type SftpClientOptions,
  type WriteStreamOptions
} from './client/sftpClient.ts';
