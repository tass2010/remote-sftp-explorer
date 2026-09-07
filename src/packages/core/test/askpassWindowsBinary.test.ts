/**
 * Exercise the actual Windows binary that ships in the VSIX.
 *
 * The other askpass tests run the host-native build. This one runs the cross-compiled
 * `x86_64-pc-windows-gnu` PE executable under Wine, which is the closest we can get on Linux
 * to testing the artifact a user will actually install. It matters because the shipped binary
 * differs from the native one in the ways most likely to break: the subsystem it declares, the
 * C runtime it links, and its socket implementation.
 *
 * Skipped when Wine or the staged binary is absent, so the suite still passes without either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AskpassServer } from '../src/askpass/askpassServer.ts';
import type { PromptRequest, PromptUi } from '../src/ports.ts';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const binaryPath = path.join(
  repoRoot,
  'src/packages/extension/bin/win32-x64/remote-sftp-askpass.exe'
);

function wineAvailable(): boolean {
  try {
    execFileSync('wine', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = !existsSync(binaryPath)
  ? 'the Windows helper is not staged (npm run build:askpass)'
  : !wineAvailable()
    ? 'wine is not installed'
    : false;

class ScriptedPrompts implements PromptUi {
  readonly seen: PromptRequest[] = [];
  readonly #answer: string | undefined;

  constructor(answer: string | undefined) {
    this.#answer = answer;
  }

  async ask(request: PromptRequest): Promise<string | undefined> {
    this.seen.push(request);
    return this.#answer;
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runUnderWine(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      'wine',
      [binaryPath, ...args],
      // WINEDEBUG silences Wine's own chatter so stderr reflects only the helper.
      { env: { ...process.env, WINEDEBUG: '-all', ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          stdout,
          stderr
        });
      }
    );
  });
}

test('the shipped Windows binary relays a password prompt', { skip }, async () => {
  const prompts = new ScriptedPrompts('correct horse battery staple');
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runUnderWine(["bob@example's password:"], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'correct horse battery staple\n',
      'stdout carries the answer and nothing else'
    );
    assert.equal(prompts.seen[0]?.kind, 'secret');
  } finally {
    await server.stop();
  }
});

test('the shipped Windows binary refuses a wrong token', { skip }, async () => {
  const prompts = new ScriptedPrompts('never-reached');
  const server = new AskpassServer({ prompts });
  const { url } = await server.start();

  try {
    const result = await runUnderWine(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: 'z'.repeat(43)
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(prompts.seen.length, 0, 'an unauthorised call must not reach the user');
  } finally {
    await server.stop();
  }
});

test('the shipped Windows binary honours a cancelled prompt', { skip }, async () => {
  const prompts = new ScriptedPrompts(undefined);
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runUnderWine(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token
    });

    // OpenSSH must see a failure, never an empty password.
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  } finally {
    await server.stop();
  }
});
