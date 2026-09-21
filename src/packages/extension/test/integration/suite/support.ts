import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension.ts';
import { waitFor } from './harness.ts';

export const EXTENSION_ID = 'remote-sftp-explorer';
export const ALIAS = 'testhost';

/** Where the fake ssh serves from, handed down by the launcher. */
export function fakeRoot(): string {
  const root = process.env['REMOTE_SFTP_FAKE_ROOT'];
  if (root === undefined) throw new Error('REMOTE_SFTP_FAKE_ROOT is not set in the host');
  return root;
}

let cached: TestApi | undefined;

/**
 * Activate the extension and take the test seam it returns.
 *
 * Looked up by id suffix rather than `publisher.name`, because the manifest has no publisher
 * yet and VS Code falls back to `undefined_publisher.<name>` when it is missing.
 */
export async function api(): Promise<TestApi> {
  if (cached !== undefined) return cached;
  const extension = vscode.extensions.all.find((candidate) =>
    candidate.id.endsWith(EXTENSION_ID)
  );
  if (extension === undefined) {
    throw new Error(
      `the extension was not loaded; saw ${vscode.extensions.all.map((e) => e.id).join(', ')}`
    );
  }
  const exported = (await extension.activate()) as TestApi | undefined;
  if (exported === undefined) {
    throw new Error('activate() returned nothing -- the platform gate or the test seam refused');
  }
  cached = exported;
  return exported;
}

export function remoteUri(alias: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'remote-sftp', authority: alias, path });
}

/** Connect and wait until the session is genuinely usable. */
export async function connect(): Promise<TestApi> {
  const test = await api();
  if (test.sessions.alias === ALIAS) return test;
  await test.sessions.connect(ALIAS);
  await waitFor('the session to report connected', () => test.sessions.alias === ALIAS);
  return test;
}
