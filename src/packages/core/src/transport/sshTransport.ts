import type { ByteChannel } from '@remote-sftp-explorer/sftp-protocol';
import { buildSshArguments, buildSshEnvironment } from './sshArguments.ts';
import type { Logger, ProcessSpawner, SpawnedProcess } from '../ports.ts';

/** Keep the tail of stderr for diagnostics without letting a chatty server grow unbounded. */
const STDERR_LIMIT = 8 * 1024;

/** How long to let in-flight work finish before killing the child on a clean disconnect. */
export const GRACEFUL_EXIT_MS = 5_000;

export interface SshTransportOptions {
  spawner: ProcessSpawner;
  executable: string;
  alias: string;
  environment: Record<string, string | undefined>;
  askpass?: { executable: string; url: string; token: string } | undefined;
  logger?: Logger | undefined;
}

export class SshExitError extends Error {
  readonly code: number | null;
  readonly diagnostic: string;

  constructor(code: number | null, diagnostic: string) {
    const base = code === null ? 'The ssh process exited.' : `ssh exited with code ${code}.`;
    super(diagnostic.length > 0 ? `${base} ${diagnostic}` : base);
    this.name = 'SshExitError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

/**
 * Runs `ssh -s <alias> sftp` and exposes its stdio as a ByteChannel.
 *
 * The protocol package cannot do this itself by design (ADR-0002); this is the only place a
 * subprocess exists. The spawner is injected so the whole path is testable without one.
 */
export class SshTransport {
  readonly #options: SshTransportOptions;
  #child: SpawnedProcess | undefined;
  #stderr: string[] = [];
  #stderrBytes = 0;
  #exited = false;
  #manualClose = false;
  #closeListeners: Array<(error?: Error) => void> = [];

  constructor(options: SshTransportOptions) {
    this.#options = options;
  }

  get stderrTail(): string {
    return this.#stderr.join('').trim();
  }

  get exited(): boolean {
    return this.#exited;
  }

  start(): ByteChannel {
    if (this.#child !== undefined) throw new Error('This transport has already been started.');

    const args = buildSshArguments(this.#options.alias);
    const env = buildSshEnvironment(this.#options.environment, this.#options.askpass);
    // The argument list is safe to log; the environment is not -- it carries the askpass token.
    this.#options.logger?.debug(`Spawning ${this.#options.executable} ${args.join(' ')}`);

    const child = this.#options.spawner.spawn({
      executable: this.#options.executable,
      args,
      env
    });
    this.#child = child;

    const dataListeners: Array<(chunk: Uint8Array) => void> = [];
    child.onStdout((chunk) => {
      for (const listener of dataListeners) listener(chunk);
    });
    child.onStderr((chunk) => this.#recordStderr(chunk));
    child.onExit((code) => {
      this.#exited = true;
      // A manual disconnect is not a failure; anything else is.
      const error = this.#manualClose
        ? undefined
        : new SshExitError(code, this.stderrTail);
      this.#emitClose(error);
    });
    child.onError((error) => {
      this.#exited = true;
      this.#emitClose(error);
    });

    return {
      write: (bytes) => {
        if (this.#exited) throw new Error('The ssh connection has closed.');
        child.write(bytes);
      },
      onData: (listener) => dataListeners.push(listener),
      onClose: (listener) => this.#closeListeners.push(listener),
      close: () => void this.dispose()
    };
  }

  /**
   * Close the connection deliberately.
   *
   * Closing stdin lets ssh finish and exit on its own; the timer is the backstop for a child
   * that will not leave, so a disconnect never hangs the UI.
   */
  async dispose(graceMs = GRACEFUL_EXIT_MS): Promise<void> {
    const child = this.#child;
    if (child === undefined || this.#exited) return;
    this.#manualClose = true;

    try {
      child.closeStdin();
    } catch {
      // Already gone.
    }

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
      this.#closeListeners.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
      if (this.#exited) {
        clearTimeout(timer);
        resolve(true);
      }
    });

    if (!exited) {
      this.#options.logger?.warn('ssh did not exit in time; terminating it.');
      try {
        child.kill();
      } catch {
        // Nothing further we can do.
      }
    }
  }

  #recordStderr(chunk: Uint8Array): void {
    // stderr is diagnostics only. It can contain a prompt, so it is kept for error messages
    // but never echoed into the log at info level.
    const text = new TextDecoder().decode(chunk);
    this.#stderr.push(text);
    this.#stderrBytes += text.length;
    while (this.#stderrBytes > STDERR_LIMIT && this.#stderr.length > 1) {
      const dropped = this.#stderr.shift();
      this.#stderrBytes -= dropped?.length ?? 0;
    }
  }

  #emitClose(error?: Error): void {
    const listeners = this.#closeListeners;
    this.#closeListeners = [];
    for (const listener of listeners) listener(error);
  }
}
