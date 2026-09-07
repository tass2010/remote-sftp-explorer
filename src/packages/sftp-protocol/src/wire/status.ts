import { SftpProtocolError } from './errors.ts';
import type { PacketReader } from './reader.ts';

/**
 * SSH_FX_* result codes.
 *
 * The previous implementation modelled only OK and EOF and collapsed everything else into a
 * generic Error, which made mapping SFTP failures onto meaningful editor errors impossible.
 */
export const StatusCode = {
  Ok: 0,
  Eof: 1,
  NoSuchFile: 2,
  PermissionDenied: 3,
  Failure: 4,
  BadMessage: 5,
  NoConnection: 6,
  ConnectionLost: 7,
  OpUnsupported: 8
} as const;

export type StatusCodeValue = (typeof StatusCode)[keyof typeof StatusCode];

const STATUS_NAMES = new Map<number, string>([
  [StatusCode.Ok, 'OK'],
  [StatusCode.Eof, 'EOF'],
  [StatusCode.NoSuchFile, 'NO_SUCH_FILE'],
  [StatusCode.PermissionDenied, 'PERMISSION_DENIED'],
  [StatusCode.Failure, 'FAILURE'],
  [StatusCode.BadMessage, 'BAD_MESSAGE'],
  [StatusCode.NoConnection, 'NO_CONNECTION'],
  [StatusCode.ConnectionLost, 'CONNECTION_LOST'],
  [StatusCode.OpUnsupported, 'OP_UNSUPPORTED']
]);

export function statusName(code: number): string {
  return STATUS_NAMES.get(code) ?? `UNKNOWN(${code})`;
}

export interface SftpStatus {
  code: number;
  message: string;
  languageTag: string;
}

/** A server-reported failure. Carries the code so callers can map it to a domain error. */
export class SftpStatusError extends Error {
  readonly code: number;
  readonly serverMessage: string;

  constructor(status: SftpStatus, context?: string) {
    const detail = status.message.trim();
    const where = context === undefined ? '' : ` while ${context}`;
    super(`SFTP ${statusName(status.code)}${where}${detail ? `: ${detail}` : ''}`);
    this.name = 'SftpStatusError';
    this.code = status.code;
    this.serverMessage = detail;
  }

  is(code: StatusCodeValue): boolean {
    return this.code === code;
  }
}

/**
 * Read a STATUS body (the type byte and request id are already consumed).
 *
 * The message and language tag are OPTIONAL. Draft-02 added them, and servers in the wild
 * omit them; treating their absence as a malformed packet -- as the previous implementation
 * did -- breaks against those servers for no benefit.
 */
export function readStatus(reader: PacketReader): SftpStatus {
  const code = reader.uint32();
  let message = '';
  let languageTag = '';
  if (reader.remaining >= 4) message = reader.string();
  if (reader.remaining >= 4) languageTag = reader.string();
  // Trailing bytes are tolerated: unknown extensions may append data we do not model.
  return { code, message, languageTag };
}

export function assertOk(status: SftpStatus, context?: string): void {
  if (status.code !== StatusCode.Ok) throw new SftpStatusError(status, context);
}

export function expectType(received: number, expected: number, label: string): void {
  if (received !== expected) {
    throw new SftpProtocolError(`expected ${label} (${expected}), received packet type ${received}`);
  }
}
