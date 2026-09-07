import { SftpStatusError, StatusCode } from '@remote-sftp-explorer/sftp-protocol';

/**
 * Domain-level failure kinds.
 *
 * Classification lives here rather than in the extension so it can be tested without VS Code;
 * the extension's only job is turning one of these into the matching FileSystemError.
 * The previous implementation could not do this at all: it modelled two status codes, so
 * every failure became a generic error and VS Code showed the same unhelpful message for a
 * missing file, a permissions problem, and a dead connection.
 */
export type RemoteErrorKind =
  | 'not-found'
  | 'no-permissions'
  | 'already-exists'
  | 'not-a-directory'
  | 'is-a-directory'
  | 'unsupported'
  | 'connection-lost'
  | 'cancelled'
  | 'conflict'
  | 'unknown';

export interface ClassifiedError {
  kind: RemoteErrorKind;
  message: string;
}

export function classifyRemoteError(error: unknown, path?: string): ClassifiedError {
  const where = path === undefined ? '' : ` (${path})`;

  if (error instanceof SftpStatusError) {
    switch (error.code) {
      case StatusCode.NoSuchFile:
        return { kind: 'not-found', message: `The remote file no longer exists${where}.` };
      case StatusCode.PermissionDenied:
        return {
          kind: 'no-permissions',
          message: `You do not have permission for this operation${where}.`
        };
      case StatusCode.OpUnsupported:
        return {
          kind: 'unsupported',
          message: `The server does not support this operation${where}.`
        };
      case StatusCode.NoConnection:
      case StatusCode.ConnectionLost:
        return { kind: 'connection-lost', message: 'The connection to the server was lost.' };
      case StatusCode.Failure: {
        // FAILURE is the catch-all in v3, so the server's own words are the only signal for
        // the cases that have no dedicated code.
        const detail = error.serverMessage.toLowerCase();
        if (detail.includes('exists')) {
          return { kind: 'already-exists', message: `That name is already taken${where}.` };
        }
        if (detail.includes('not a directory')) {
          return { kind: 'not-a-directory', message: `That path is not a directory${where}.` };
        }
        if (detail.includes('is a directory')) {
          return { kind: 'is-a-directory', message: `That path is a directory${where}.` };
        }
        if (detail.includes('not empty')) {
          return { kind: 'unknown', message: `The directory is not empty${where}.` };
        }
        return { kind: 'unknown', message: error.message };
      }
      default:
        return { kind: 'unknown', message: error.message };
    }
  }

  if (error instanceof Error) {
    if (error.name === 'AbortedError') {
      return { kind: 'cancelled', message: 'The operation was cancelled.' };
    }
    if (error.name === 'RemoteConflictError') {
      return { kind: 'conflict', message: error.message };
    }
    if (error.name === 'SshExitError' || /connection (is )?closed|ssh exited/iu.test(error.message)) {
      return { kind: 'connection-lost', message: error.message };
    }
    return { kind: 'unknown', message: error.message };
  }

  return { kind: 'unknown', message: String(error) };
}
