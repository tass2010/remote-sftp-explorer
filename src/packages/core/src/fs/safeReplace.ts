import {
  OpenFlag,
  SftpStatusError,
  StatusCode,
  type SftpClient
} from '@remote-sftp-explorer/sftp-protocol';
import { joinRemotePath, parentRemotePath, remoteBaseName } from './remotePath.ts';
import type { Logger } from '../ports.ts';

/** Marker embedded in every temporary and backup name so the sweeper can recognise them. */
const ARTIFACT_MARKER = '.remote-sftp-';
const TEMP_SUFFIX = '.tmp';
const BACKUP_SUFFIX = '.bak';

export type ReplaceStrategy = 'posix-rename' | 'backup-fallback';

export interface SafeReplaceResult {
  strategy: ReplaceStrategy;
  /**
   * Set when the content landed correctly but a backup file could not be removed. The save
   * SUCCEEDED; this is a housekeeping warning, not a failure.
   */
  orphanedBackup?: string;
}

export interface SafeReplaceOptions {
  client: SftpClient;
  path: string;
  content: Uint8Array;
  /** Permission bits of the file being replaced, so the replacement inherits them. */
  permissions?: number | undefined;
  randomToken: () => string;
  logger?: Logger | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((bytesWritten: number) => void) | undefined;
}

/**
 * Replace a remote file's contents without ever truncating the original.
 *
 * Sequence:
 *   1. write the new content to a temporary file in the same directory
 *   2. fsync it if the server supports that, then close
 *   3. swap it into place -- atomically when `posix-rename@openssh.com` exists, otherwise
 *      through a rename-via-backup sequence that restores the original on failure
 *
 * The previous implementation had step 3's atomic branch only and simply refused to save at
 * all against a server without the extension, which is a large fraction of non-OpenSSH SFTP
 * servers.
 */
export async function safeReplace(options: SafeReplaceOptions): Promise<SafeReplaceResult> {
  const { client, path, logger } = options;
  const directory = parentRemotePath(path);
  const name = remoteBaseName(path);
  const token = options.randomToken();
  // The random component never derives from user input, so a hostile filename cannot steer
  // where the temporary file lands.
  const tempPath = joinRemotePath(directory, `.${name}${ARTIFACT_MARKER}${token}${TEMP_SUFFIX}`);

  await writeTemporary(options, tempPath);

  if (client.capabilities.posixRename) {
    try {
      await client.posixRename(tempPath, path, options.signal);
      return { strategy: 'posix-rename' };
    } catch (error) {
      await removeQuietly(client, tempPath, logger);
      throw error;
    }
  }

  return replaceViaBackup(options, tempPath, directory, name, token);
}

async function writeTemporary(options: SafeReplaceOptions, tempPath: string): Promise<void> {
  const { client, content, permissions, logger } = options;
  // Carry the original's mode onto the replacement. Masked to the permission bits: the file
  // type bits belong to the server, and passing them back can be rejected outright.
  const attributes = permissions === undefined ? {} : { permissions: permissions & 0o7777 };

  const handle = await client.open(
    tempPath,
    OpenFlag.Write | OpenFlag.Creat | OpenFlag.Excl,
    attributes,
    options.signal
  );

  try {
    await client.writeAll(handle, content, {
      signal: options.signal,
      onProgress: options.onProgress
    });
    if (client.capabilities.fsync) {
      // Without this the rename can be durable while the contents are not, which after a
      // server crash leaves a correctly-named empty file.
      await client.fsync(handle, options.signal);
    }
    await client.close(handle, options.signal);
  } catch (error) {
    try {
      await client.close(handle);
    } catch {
      // The handle may already be gone; the original error is the interesting one.
    }
    await removeQuietly(client, tempPath, logger);
    throw error;
  }
}

/**
 * Rename-through-backup, for servers without POSIX rename.
 *
 * There is an unavoidable window between steps 1 and 2 where the target does not exist. That
 * is the price of a server whose rename refuses to overwrite; what matters is that every
 * failure leaves either the original or the new content in place, never nothing and never a
 * half-written file.
 */
async function replaceViaBackup(
  options: SafeReplaceOptions,
  tempPath: string,
  directory: string,
  name: string,
  token: string
): Promise<SafeReplaceResult> {
  const { client, path, logger } = options;
  const backupPath = joinRemotePath(
    directory,
    `.${name}${ARTIFACT_MARKER}${token}${BACKUP_SUFFIX}`
  );

  // Step 1: move the original aside. A missing target is fine -- we are creating the file.
  let originalExisted = true;
  try {
    await client.rename(path, backupPath, options.signal);
  } catch (error) {
    if (isMissing(error)) {
      originalExisted = false;
    } else {
      await removeQuietly(client, tempPath, logger);
      throw new Error(
        `Could not save ${path}: the original could not be moved aside. ` +
          `It is unchanged. (${describe(error)})`
      );
    }
  }

  // Step 2: move the new content into place.
  try {
    await client.rename(tempPath, path, options.signal);
  } catch (error) {
    if (originalExisted) {
      try {
        await client.rename(backupPath, path);
        await removeQuietly(client, tempPath, logger);
        throw new Error(
          `Could not save ${path}: the replacement could not be moved into place. ` +
            `The original has been restored. (${describe(error)})`
        );
      } catch (restoreError) {
        // Both the swap and the rollback failed. Say exactly where the data is.
        throw new Error(
          `Could not save ${path}, and the original could not be restored. ` +
            `The previous contents are at ${backupPath} and the new contents are at ` +
            `${tempPath}. (${describe(restoreError)})`
        );
      }
    }
    await removeQuietly(client, tempPath, logger);
    throw error;
  }

  // Step 3: drop the backup. The save has already succeeded by this point, so a failure here
  // is housekeeping -- reporting it as a failed save would be actively misleading.
  if (originalExisted) {
    try {
      await client.remove(backupPath, options.signal);
    } catch (error) {
      logger?.warn(`Saved ${path}, but could not remove the backup at ${backupPath}.`, error);
      return { strategy: 'backup-fallback', orphanedBackup: backupPath };
    }
  }
  return { strategy: 'backup-fallback' };
}

/**
 * Remove temporary and backup files left behind by an interrupted save.
 *
 * Run on connect. Recognising artefacts by name means no on-disk journal is needed, which
 * matters because we deliberately persist nothing about in-progress edits (ADR-0005).
 */
export async function sweepArtifacts(
  client: SftpClient,
  directory: string,
  logger?: Logger
): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await client.readDirectory(directory);
  } catch (error) {
    logger?.debug(`Could not scan ${directory} for leftover files: ${describe(error)}`);
    return removed;
  }

  for (const entry of entries) {
    if (!isArtifactName(entry.filename)) continue;
    const artifactPath = joinRemotePath(directory, entry.filename);
    try {
      await client.remove(artifactPath);
      removed.push(artifactPath);
      logger?.info(`Removed a leftover file from an interrupted save: ${artifactPath}`);
    } catch (error) {
      logger?.debug(`Could not remove ${artifactPath}: ${describe(error)}`);
    }
  }
  return removed;
}

export function isArtifactName(filename: string): boolean {
  return (
    filename.startsWith('.') &&
    filename.includes(ARTIFACT_MARKER) &&
    (filename.endsWith(TEMP_SUFFIX) || filename.endsWith(BACKUP_SUFFIX))
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof SftpStatusError && error.is(StatusCode.NoSuchFile);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeQuietly(
  client: SftpClient,
  path: string,
  logger?: Logger
): Promise<void> {
  try {
    await client.remove(path);
  } catch (error) {
    logger?.debug(`Could not clean up ${path}: ${describe(error)}`);
  }
}
