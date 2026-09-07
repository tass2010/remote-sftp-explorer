import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type {
  ConnectionStateModel} from '@remote-sftp-explorer/core';
import {
  AskpassServer,
  ReconnectScheduler,
  RemoteSession,
  type Logger,
  type ProcessSpawner,
  type PromptUi
} from '@remote-sftp-explorer/core';

export interface SessionManagerOptions {
  spawner: ProcessSpawner;
  prompts: PromptUi;
  logger: Logger;
  state: ConnectionStateModel;
  sshExecutable: string;
  askpassExecutable: string | undefined;
}

/**
 * Owns the single active connection and its lifecycle.
 *
 * Only one session exists at a time, so connecting elsewhere tears down the current one. That
 * is a product decision, not a technical limit -- see the open question in docs/01-product.md.
 */
export class SessionManager implements vscode.Disposable {
  readonly #options: SessionManagerOptions;
  readonly #reconnect = new ReconnectScheduler();
  #session: RemoteSession | undefined;
  /** The attempt in flight, with the host it is for -- see connect() for why the alias matters. */
  #connecting: { alias: string; promise: Promise<RemoteSession> } | undefined;
  #autoReconnect = false;
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
  }

  get session(): RemoteSession | undefined {
    return this.#session?.closed === true ? undefined : this.#session;
  }

  get alias(): string | undefined {
    return this.session?.alias;
  }

  /**
   * Connect, replacing any existing session.
   *
   * `viaReconnect` distinguishes an automatic retry from a user action; a user action always
   * cancels an in-progress reconnect cycle, because they have chosen where to go.
   */
  async connect(alias: string, options: { viaReconnect?: boolean } = {}): Promise<RemoteSession> {
    if (options.viaReconnect !== true) {
      this.#reconnect.stop();
      this.#autoReconnect = true;
    }

    const existing = this.session;
    if (existing !== undefined && existing.alias === alias) return existing;

    // Clicking a host in the tree fires this command on every single click, so repeated
    // clicks during a slow authentication are normal and must not each spawn an ssh process.
    //
    // The alias has to be part of the check. Sharing whichever attempt happened to be in
    // flight meant that clicking host A and then host B handed B's caller a session for A --
    // it connected to somewhere the user had not asked for, and reported success.
    while (this.#connecting !== undefined) {
      if (this.#connecting.alias === alias) return this.#connecting.promise;
      // A different host was requested. Let the current attempt finish rather than tearing
      // down a half-authenticated connection, then honour the newer request.
      await this.#connecting.promise.catch(() => undefined);
    }

    const promise = this.#establish(alias, options.viaReconnect === true);
    this.#connecting = { alias, promise };
    try {
      return await promise;
    } finally {
      if (this.#connecting?.promise === promise) this.#connecting = undefined;
    }
  }

  /** True while an attempt for this host is already under way. */
  isConnecting(alias: string): boolean {
    return this.#connecting?.alias === alias;
  }

  /** The session for an operation, reconnecting on demand if one is expected. */
  async require(alias?: string): Promise<RemoteSession> {
    const current = this.session;
    if (current !== undefined && (alias === undefined || current.alias === alias)) return current;

    const target = alias ?? this.#options.state.alias;
    if (target === undefined) {
      throw new Error('Connect to an SSH host before browsing remote files.');
    }
    if (!this.#autoReconnect) {
      throw new Error(`Not connected to ${target}.`);
    }
    return this.connect(target);
  }

  async disconnect(): Promise<void> {
    this.#reconnect.stop();
    this.#autoReconnect = false;
    const session = this.#session;
    this.#session = undefined;
    if (session === undefined) {
      this.#options.state.set('disconnected');
      return;
    }
    this.#options.state.set('disconnecting', session.alias);
    await session.dispose();
    this.#options.state.set('disconnected');
  }

  dispose(): void {
    this.#disposed = true;
    this.#reconnect.stop();
    void this.#session?.dispose();
    this.#session = undefined;
  }

  async #establish(alias: string, viaReconnect: boolean): Promise<RemoteSession> {
    const previous = this.#session;
    this.#session = undefined;
    if (previous !== undefined) await previous.dispose();

    this.#options.state.set(viaReconnect ? 'reconnecting' : 'connecting', alias);

    // The askpass endpoint exists only for the duration of this attempt.
    const askpassServer = new AskpassServer({
      prompts: this.#options.prompts,
      logger: this.#options.logger
    });

    let askpass: { executable: string; url: string; token: string } | undefined;
    if (this.#options.askpassExecutable !== undefined) {
      const endpoint = await askpassServer.start();
      askpass = { executable: this.#options.askpassExecutable, ...endpoint };
    } else {
      // Without the helper, only key and agent authentication can work.
      this.#options.logger.warn(
        'The askpass helper is not available; password and passphrase prompts will fail.'
      );
    }

    try {
      const session = await RemoteSession.connect({
        spawner: this.#options.spawner,
        executable: this.#options.sshExecutable,
        alias,
        environment: process.env,
        askpass,
        logger: this.#options.logger,
        clock: {
          now: () => Date.now(),
          setTimeout: (handler, ms) => setTimeout(handler, ms),
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
        },
        randomToken: () => randomBytes(8).toString('hex')
      });

      this.#session = session;
      this.#options.state.set('connected', alias);
      session.onDidClose((error) => this.#handleUnexpectedClose(alias, error));

      // Clear leftovers from a save that an earlier disconnect interrupted.
      void session.sweep(session.rootPath).catch(() => undefined);
      return session;
    } catch (error) {
      this.#options.state.set('failed', alias, describe(error));
      throw error;
    } finally {
      await askpassServer.stop();
    }
  }

  #handleUnexpectedClose(alias: string, error?: Error): void {
    if (this.#disposed || error === undefined) return;
    this.#session = undefined;
    this.#options.logger.warn(`The connection to ${alias} was lost.`, error);

    if (!this.#autoReconnect) {
      this.#options.state.set('failed', alias, describe(error));
      return;
    }

    this.#options.state.set('reconnecting', alias, describe(error));
    this.#reconnect.start({
      attempt: async (attemptNumber) => {
        this.#options.logger.info(`Reconnecting to ${alias} (attempt ${attemptNumber})...`);
        await this.connect(alias, { viaReconnect: true });
      },
      onSuccess: () => {
        this.#options.logger.info(`Reconnected to ${alias}.`);
      },
      onFailure: (attemptNumber, failure, willRetry) => {
        this.#options.logger.warn(
          `Reconnect attempt ${attemptNumber} to ${alias} failed${willRetry ? '; retrying' : ''}.`,
          failure
        );
      },
      onGiveUp: (failure) => {
        this.#options.state.set('failed', alias, describe(failure));
        void vscode.window.showErrorMessage(
          `Could not reconnect to ${alias}. Connect again when the server is reachable.`
        );
      }
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
