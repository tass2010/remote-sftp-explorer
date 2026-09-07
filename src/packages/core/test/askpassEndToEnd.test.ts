/**
 * The Rust helper and the TypeScript server, actually talking to each other.
 *
 * These two halves existed in 0.2.0 and were never once connected: the helper was written and
 * unit-tested, the server did not exist, and nothing set SSH_ASKPASS. This test is the proof
 * that the wire contract between them holds -- token, path, body shape, exit codes, and the
 * rule that only the answer reaches stdout.
 *
 * Skipped when the helper has not been built, so the suite still runs on a machine without a
 * Rust toolchain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AskpassServer } from '../src/askpass/askpassServer.ts';
import type { PromptRequest, PromptUi } from '../src/ports.ts';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const helperPath = path.join(
  repoRoot,
  'src/native/askpass/target/debug',
  process.platform === 'win32' ? 'remote-sftp-askpass.exe' : 'remote-sftp-askpass'
);

const helperMissing = !existsSync(helperPath);
const skip = helperMissing && 'the askpass helper has not been built (cargo build)';

interface HelperRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHelper(
  args: string[],
  env: Record<string, string | undefined>
): Promise<HelperRun> {
  return new Promise((resolve) => {
    execFile(
      helperPath,
      args,
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

class ScriptedPrompts implements PromptUi {
  readonly seen: PromptRequest[] = [];
  readonly #answer: string | undefined;

  // A parameter property would be tidier but is not erasable syntax, and the test runner
  // strips types rather than compiling them.
  constructor(answer: string | undefined) {
    this.#answer = answer;
  }

  async ask(request: PromptRequest): Promise<string | undefined> {
    this.seen.push(request);
    return this.#answer;
  }
}

test('the helper relays a password prompt and prints only the answer', { skip }, async () => {
  const prompts = new ScriptedPrompts('correct horse battery staple');
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runHelper(["bob@example's password:"], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'correct horse battery staple\n',
      'stdout must carry the answer and nothing else'
    );
    assert.equal(prompts.seen.length, 1);
    assert.equal(prompts.seen[0]?.kind, 'secret', 'a password prompt must be masked');
    assert.equal(prompts.seen[0]?.message, "bob@example's password:");
  } finally {
    await server.stop();
  }
});

test('a host key prompt arrives classified as a confirmation', { skip }, async () => {
  const prompts = new ScriptedPrompts('yes');
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runHelper(
      ['Are you sure you want to continue connecting (yes/no/[fingerprint])?'],
      { REMOTE_SFTP_ASKPASS_URL: url, REMOTE_SFTP_ASKPASS_TOKEN: token }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'yes\n');
    assert.equal(prompts.seen[0]?.kind, 'confirm');
  } finally {
    await server.stop();
  }
});

test('cancelling exits non-zero and prints nothing to stdout', { skip }, async () => {
  const prompts = new ScriptedPrompts(undefined);
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runHelper(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token
    });

    assert.notEqual(result.code, 0, 'OpenSSH must see a failure, not an empty password');
    assert.equal(result.stdout, '');
  } finally {
    await server.stop();
  }
});

test('a wrong token fails without ever prompting the user', { skip }, async () => {
  const prompts = new ScriptedPrompts('never-reached');
  const server = new AskpassServer({ prompts });
  const { url } = await server.start();

  try {
    const result = await runHelper(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: 'z'.repeat(43)
    });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(prompts.seen.length, 0);
  } finally {
    await server.stop();
  }
});

test('SSH_ASKPASS_REQUIRE=never is honoured', { skip }, async () => {
  const prompts = new ScriptedPrompts('should-not-be-asked');
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const result = await runHelper(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token,
      SSH_ASKPASS_REQUIRE: 'never'
    });

    assert.notEqual(result.code, 0);
    assert.equal(prompts.seen.length, 0, 'the user asked OpenSSH not to use a helper');
  } finally {
    await server.stop();
  }
});

test('a missing endpoint fails cleanly instead of hanging', { skip }, async () => {
  const result = await runHelper(['password:'], {
    REMOTE_SFTP_ASKPASS_URL: undefined,
    REMOTE_SFTP_ASKPASS_TOKEN: undefined
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
});

test('no secret appears on stderr on any failure path', { skip }, async () => {
  const prompts = new ScriptedPrompts('TOP-SECRET');
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();

  try {
    const cancelled = await runHelper(['password:'], {
      REMOTE_SFTP_ASKPASS_URL: url,
      REMOTE_SFTP_ASKPASS_TOKEN: token,
      SSH_ASKPASS_REQUIRE: 'never'
    });
    assert.ok(!cancelled.stderr.includes(token), 'the token must not reach stderr');
    assert.ok(!cancelled.stderr.includes('TOP-SECRET'));
  } finally {
    await server.stop();
  }
});
