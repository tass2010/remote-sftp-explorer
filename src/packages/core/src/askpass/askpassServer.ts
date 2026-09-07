import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { classifyPrompt } from './promptClassifier.ts';
import type { Logger, PromptUi } from '../ports.ts';

/** Matches the cap the Rust helper enforces on its side. */
export const MAX_REQUEST_BYTES = 8 * 1024;
export const PROMPT_PATH = '/v1/prompt';

export interface AskpassServerOptions {
  prompts: PromptUi;
  logger?: Logger;
  /** Overridable for tests; production always binds loopback. */
  host?: string;
}

export interface AskpassEndpoint {
  url: string;
  token: string;
}

interface PromptPayload {
  prompt?: unknown;
  hint?: unknown;
  envHint?: unknown;
  argv?: unknown;
}

/**
 * A loopback HTTP server that answers the Rust `SSH_ASKPASS` helper.
 *
 * Lifetime is one connection attempt: started before `ssh` is spawned and closed as soon as
 * the child exits, so the endpoint does not outlive the authentication it exists for.
 *
 * Everything about it is scoped tightly on purpose -- it is the one component that handles
 * plaintext credentials.
 */
export class AskpassServer {
  readonly #prompts: PromptUi;
  readonly #logger: Logger | undefined;
  readonly #host: string;
  #server: Server | undefined;
  #token: string | undefined;

  constructor(options: AskpassServerOptions) {
    this.#prompts = options.prompts;
    this.#logger = options.logger;
    this.#host = options.host ?? '127.0.0.1';
  }

  get running(): boolean {
    return this.#server !== undefined;
  }

  async start(): Promise<AskpassEndpoint> {
    if (this.#server !== undefined) throw new Error('The askpass server is already running.');

    // 32 bytes, base64url: 43 characters, all inside the printable range the helper validates.
    const token = randomBytes(32).toString('base64url');
    this.#token = token;

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      // Port 0: the OS picks a free port, so nothing is predictable between runs.
      server.listen(0, this.#host, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('The askpass server did not bind to a TCP port.'));
          return;
        }
        resolve(address.port);
      });
    });

    this.#logger?.debug(`Askpass bridge listening on ${this.#host}:${port}`);
    return { url: `http://${this.#host}:${port}${PROMPT_PATH}`, token };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#token = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Any keep-alive socket would otherwise hold the port open past the auth attempt.
      server.closeAllConnections?.();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rejection = this.#reject(request);
      if (rejection !== undefined) {
        this.#logger?.debug(`Askpass request rejected: ${rejection.reason}`);
        respond(response, rejection.status, { error: 'rejected' });
        return;
      }

      const body = await readBody(request);
      if (body === undefined) {
        respond(response, 413, { error: 'too large' });
        return;
      }

      let payload: PromptPayload;
      try {
        payload = JSON.parse(body) as PromptPayload;
      } catch {
        respond(response, 400, { error: 'invalid json' });
        return;
      }

      const promptText = typeof payload.prompt === 'string' ? payload.prompt : '';
      const envHint = typeof payload.envHint === 'string'
        ? payload.envHint
        : typeof payload.hint === 'string'
          ? payload.hint
          : undefined;

      const kind = classifyPrompt(promptText, envHint);
      // Log the classification, never the prompt: a PAM module can put identifying detail in
      // the prompt text, and the answer must never be near a log line at all.
      this.#logger?.debug(`Askpass prompt classified as "${kind}"`);

      const answer = await this.#prompts.ask({ kind, message: promptText });
      if (answer === undefined) {
        respond(response, 200, { cancelled: true });
        return;
      }
      respond(response, 200, { answer });
    } catch (error) {
      this.#logger?.warn('The askpass bridge failed to answer a prompt.', error);
      respond(response, 500, { error: 'internal' });
    }
  }

  /** All of these must hold, or the request is refused. */
  #reject(request: IncomingMessage): { status: number; reason: string } | undefined {
    if (request.method !== 'POST') return { status: 405, reason: 'method' };

    const url = request.url ?? '';
    const path = url.split('?')[0];
    if (path !== PROMPT_PATH) return { status: 404, reason: 'path' };

    const remote = request.socket.remoteAddress ?? '';
    // Node reports IPv4-mapped IPv6 for loopback in some configurations.
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
      return { status: 403, reason: 'not loopback' };
    }

    const header = request.headers.authorization ?? '';
    const expected = this.#token;
    if (expected === undefined) return { status: 503, reason: 'not running' };
    if (!header.startsWith('Bearer ')) return { status: 401, reason: 'no bearer token' };
    if (!constantTimeEquals(header.slice('Bearer '.length), expected)) {
      return { status: 401, reason: 'bad token' };
    }
    return undefined;
  }
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length itself is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the body with a streaming cap.
 *
 * Checking Content-Length alone would let a lying client stream unbounded data, so the guard
 * counts what actually arrives and destroys the socket on overflow.
 */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        request.destroy();
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => finish(undefined));
  });
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // Nothing here should ever be cached or reused.
    'cache-control': 'no-store'
  });
  response.end(payload);
}
