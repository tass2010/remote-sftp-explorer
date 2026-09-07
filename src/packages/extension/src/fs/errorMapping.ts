import * as vscode from 'vscode';
import { classifyRemoteError } from '@remote-sftp-explorer/core';

/**
 * Turn a remote failure into the VS Code error that best describes it.
 *
 * The classification itself lives in core, where it is testable without an Extension Host;
 * this is only the translation. Getting it right matters because VS Code renders these very
 * differently -- FileNotFound closes a stale editor, NoPermissions explains itself, and a
 * generic Error just says something went wrong.
 */
export function toFileSystemError(error: unknown, uri?: vscode.Uri): Error {
  // Already a VS Code error: pass it through rather than reclassifying our own message.
  if (error instanceof vscode.FileSystemError) return error;

  const { kind, message } = classifyRemoteError(error, uri?.path);
  const target = uri ?? message;

  switch (kind) {
    case 'not-found':
      return vscode.FileSystemError.FileNotFound(target);
    case 'no-permissions':
      return vscode.FileSystemError.NoPermissions(target);
    case 'already-exists':
      return vscode.FileSystemError.FileExists(target);
    case 'not-a-directory':
      return vscode.FileSystemError.FileNotADirectory(target);
    case 'is-a-directory':
      return vscode.FileSystemError.FileIsADirectory(target);
    case 'unsupported':
      return vscode.FileSystemError.NoPermissions(message);
    case 'connection-lost':
      return vscode.FileSystemError.Unavailable(message);
    case 'cancelled':
      return new vscode.CancellationError();
    case 'conflict':
    case 'unknown':
    default:
      return new Error(message);
  }
}
