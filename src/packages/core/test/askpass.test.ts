import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskpassServer, MAX_REQUEST_BYTES, PROMPT_PATH } from '../src/askpass/askpassServer.ts';
import { classifyPrompt } from '../src/askpass/promptClassifier.ts';
import {
  buildSshArguments,
  buildSshEnvironment,
  InvalidHostAliasError
} from '../src/transport/sshArguments.ts';
import type { Logger, PromptRequest, PromptUi } from '../src/ports.ts';

class RecordingPrompts implements PromptUi {
  readonly seen: PromptRequest[] = [];
  answer: string | undefined = 'hunter2';

  async ask(request: PromptRequest): Promise<string | undefined> {
    this.seen.push(request);
    return this.answer;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(message);
  }
  warn(message: string): void {
    this.lines.push(message);
  }
  error(message: string): void {
    this.lines.push(message);
  }
  debug(message: string): void {
    this.lines.push(message);
  }
}

async function post(
  url: string,
  options: { token?: string; body?: string; method?: string } = {}
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  const method = options.method ?? 'POST';
  const response = await fetch(url, {
    method,
    headers,
    // fetch refuses to attach a body to GET/HEAD.
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: options.body ?? JSON.stringify({ prompt: 'password:' }) })
  });
  return { status: response.status, body: await response.text() };
}

// ---------------------------------------------------------------------------
// Prompt classification
// ---------------------------------------------------------------------------

test('host key confirmations are recognised as confirmations', () => {
  const prompts = [
    "The authenticity of host 'example (10.0.0.1)' can't be established.\n" +
      'ED25519 key fingerprint is SHA256:abc.\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
    'Are you sure you want to continue connecting (yes/no)?',
    'Continue? (yes/no)?'
  ];
  for (const prompt of prompts) {
    assert.equal(classifyPrompt(prompt), 'confirm', prompt.slice(0, 40));
  }
});

test('credential prompts are recognised as secrets', () => {
  const prompts = [
    "user@example's password:",
    'Enter passphrase for key /home/u/.ssh/id_ed25519:',
    'Verification code:',
    'One-time password:',
    'Duo two-factor login for user',
    'Enter PIN for authenticator:'
  ];
  for (const prompt of prompts) {
    assert.equal(classifyPrompt(prompt), 'secret', prompt);
  }
});

test('an unrecognised prompt defaults to secret, failing closed', () => {
  // Showing a credential in an unmasked box is worse than masking something harmless.
  assert.equal(classifyPrompt('Something entirely unexpected:'), 'secret');
  assert.equal(classifyPrompt(''), 'secret');
});

test('an explicit environment hint wins over the text', () => {
  assert.equal(classifyPrompt('password:', 'confirm'), 'confirm');
  assert.equal(classifyPrompt('anything at all', 'text'), 'text');
  // But a hint of "text" must not downgrade something that looks like a credential.
  assert.equal(classifyPrompt('Enter passphrase:', 'text'), 'secret');
});

// ---------------------------------------------------------------------------
// The loopback server
// ---------------------------------------------------------------------------

test('a correctly authenticated prompt reaches the UI and returns the answer', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  try {
    const response = await post(url, { token });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { answer: 'hunter2' });
    assert.equal(prompts.seen.length, 1);
    assert.equal(prompts.seen[0]?.kind, 'secret');
  } finally {
    await server.stop();
  }
});

test('cancelling the prompt reports cancellation rather than an empty answer', async () => {
  const prompts = new RecordingPrompts();
  prompts.answer = undefined;
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  try {
    const response = await post(url, { token });
    assert.deepEqual(JSON.parse(response.body), { cancelled: true });
  } finally {
    await server.stop();
  }
});

test('a wrong token is refused and never reaches the UI', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url } = await server.start();
  try {
    const response = await post(url, { token: 'not-the-token' });
    assert.equal(response.status, 401);
    assert.equal(prompts.seen.length, 0, 'the user must not be prompted by an unauthorised call');
  } finally {
    await server.stop();
  }
});

test('a missing token is refused', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url } = await server.start();
  try {
    assert.equal((await post(url)).status, 401);
    assert.equal(prompts.seen.length, 0);
  } finally {
    await server.stop();
  }
});

test('the wrong method and the wrong path are both refused', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  try {
    assert.equal((await post(url, { token, method: 'GET' })).status, 405);
    const wrongPath = url.replace(PROMPT_PATH, '/v1/other');
    assert.equal((await post(wrongPath, { token })).status, 404);
    assert.equal(prompts.seen.length, 0);
  } finally {
    await server.stop();
  }
});

test('an oversized body is refused before it can be parsed', async () => {
  // The guard counts bytes as they arrive and destroys the socket on overflow, rather than
  // trusting Content-Length -- so the client sees a dropped connection, not a status code.
  // That abruptness is the point: nothing oversized is ever buffered or parsed.
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  try {
    const huge = JSON.stringify({ prompt: 'x'.repeat(MAX_REQUEST_BYTES + 1000) });
    await assert.rejects(
      () => post(url, { token, body: huge }),
      'the connection must be dropped rather than the body buffered'
    );
    assert.equal(prompts.seen.length, 0, 'the user must never be prompted by an oversized call');
  } finally {
    await server.stop();
  }
});

test('malformed JSON is rejected without prompting', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  try {
    assert.equal((await post(url, { token, body: 'not json' })).status, 400);
    assert.equal(prompts.seen.length, 0);
  } finally {
    await server.stop();
  }
});

test('each start mints a fresh token', async () => {
  const prompts = new RecordingPrompts();
  const first = new AskpassServer({ prompts });
  const a = await first.start();
  await first.stop();

  const second = new AskpassServer({ prompts });
  const b = await second.start();
  await second.stop();

  assert.notEqual(a.token, b.token, 'a token must never be reused across attempts');
  assert.ok(a.token.length >= 43, 'expected at least 256 bits of entropy, base64url encoded');
});

test('a stopped server no longer answers', async () => {
  const prompts = new RecordingPrompts();
  const server = new AskpassServer({ prompts });
  const { url, token } = await server.start();
  await server.stop();

  await assert.rejects(() => post(url, { token }), 'the endpoint must not outlive the attempt');
});

test('neither the answer nor the token ever reaches the logger', async () => {
  const prompts = new RecordingPrompts();
  prompts.answer = 'SUPER-SECRET-ANSWER';
  const logger = new RecordingLogger();
  const server = new AskpassServer({ prompts, logger });
  const { url, token } = await server.start();
  try {
    await post(url, { token, body: JSON.stringify({ prompt: "bob@host's password:" }) });
    await post(url, { token: 'wrong-token-value' });
  } finally {
    await server.stop();
  }

  const transcript = logger.lines.join('\n');
  assert.ok(!transcript.includes('SUPER-SECRET-ANSWER'), 'the answer must never be logged');
  assert.ok(!transcript.includes(token), 'the token must never be logged');
  assert.ok(!transcript.includes('wrong-token-value'), 'a rejected token must not be logged');
  assert.ok(!transcript.includes("bob@host's password"), 'prompt text may identify the user');
});

// ---------------------------------------------------------------------------
// ssh arguments and environment
// ---------------------------------------------------------------------------

test('BatchMode is never passed, or interactive authentication cannot work', () => {
  // The single line that made password, passphrase, and keyboard-interactive auth impossible
  // in 0.2.0. This test exists so it cannot come back.
  const args = buildSshArguments('example');
  assert.ok(
    !args.some((arg) => arg.toLowerCase().includes('batchmode')),
    `BatchMode disables every OpenSSH prompt; found: ${args.join(' ')}`
  );
});

test('the argument list hardens the session and requests the sftp subsystem', () => {
  const args = buildSshArguments('example');
  const joined = args.join(' ');
  for (const expected of [
    'RequestTTY=no',
    'ClearAllForwardings=yes',
    'PermitLocalCommand=no',
    'RemoteCommand=none',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    'NumberOfPasswordPrompts=1'
  ]) {
    assert.ok(joined.includes(expected), `missing ${expected}`);
  }
  assert.deepEqual(args.slice(-3), ['-s', 'example', 'sftp']);
});

test('an alias that could be read as an option is refused', () => {
  for (const alias of ['-oProxyCommand=evil', '', 'has space', 'nul\0byte']) {
    assert.throws(() => buildSshArguments(alias), InvalidHostAliasError, alias);
  }
});

test('the askpass environment extends the inherited one rather than replacing it', () => {
  // Replacing it would drop USERPROFILE and SSH_AUTH_SOCK, breaking config discovery and
  // agent authentication.
  const base = { USERPROFILE: 'C:\\Users\\dev', SSH_AUTH_SOCK: '\\\\.\\pipe\\agent', PATH: 'x' };
  const env = buildSshEnvironment(base, {
    executable: 'C:\\ext\\askpass.exe',
    url: 'http://127.0.0.1:5000/v1/prompt',
    token: 'abc'
  });

  assert.equal(env['USERPROFILE'], 'C:\\Users\\dev');
  assert.equal(env['SSH_AUTH_SOCK'], '\\\\.\\pipe\\agent');
  assert.equal(env['SSH_ASKPASS'], 'C:\\ext\\askpass.exe');
  assert.equal(env['SSH_ASKPASS_REQUIRE'], 'force');
  assert.equal(env['REMOTE_SFTP_ASKPASS_URL'], 'http://127.0.0.1:5000/v1/prompt');
  assert.equal(env['REMOTE_SFTP_ASKPASS_TOKEN'], 'abc');
});

test('without an askpass endpoint the environment is left alone', () => {
  const env = buildSshEnvironment({ PATH: 'x' }, undefined);
  assert.deepEqual(env, { PATH: 'x' });
});
