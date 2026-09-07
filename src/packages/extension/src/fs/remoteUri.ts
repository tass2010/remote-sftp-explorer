import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { normalizeRemotePath } from '@remote-sftp-explorer/core';

export const REMOTE_SCHEME = 'remote-sftp';

/**
 * A stable, opaque id for a host alias.
 *
 * The alias itself never goes into the URI authority: aliases can contain characters that are
 * awkward or ambiguous there. Hashing keeps the authority well-formed while staying stable
 * across reconnects, so a document opened before a disconnect can still be saved after one.
 */
export function hostIdFor(alias: string): string {
  return createHash('sha256').update(alias).digest('hex').slice(0, 16);
}

export function remoteUri(alias: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REMOTE_SCHEME,
    authority: hostIdFor(alias),
    // Built through Uri.from so encoding happens once, correctly.
    path: normalizeRemotePath(remotePath)
  });
}

export function remotePathOf(uri: vscode.Uri): string {
  if (uri.scheme !== REMOTE_SCHEME) {
    throw new Error(`Not a remote SFTP URI: ${uri.toString()}`);
  }
  return normalizeRemotePath(uri.path);
}
