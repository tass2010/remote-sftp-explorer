export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  alias?: string | undefined;
  detail?: string | undefined;
}

export type ConnectionListener = (snapshot: ConnectionSnapshot) => void;

/**
 * The session state machine, as a plain observable value.
 *
 * `disconnecting` was in the original design and absent from the shipped state union;
 * `reconnecting` was added when auto-reconnect landed. Both are here so the UI can
 * distinguish "going away on purpose" from "lost the connection and trying again".
 */
export class ConnectionStateModel {
  #snapshot: ConnectionSnapshot = { status: 'disconnected' };
  readonly #listeners = new Set<ConnectionListener>();

  get snapshot(): ConnectionSnapshot {
    return this.#snapshot;
  }

  get status(): ConnectionStatus {
    return this.#snapshot.status;
  }

  get alias(): string | undefined {
    return this.#snapshot.alias;
  }

  /** True when file operations may be attempted. */
  get usable(): boolean {
    return this.#snapshot.status === 'connected';
  }

  set(status: ConnectionStatus, alias?: string, detail?: string): void {
    this.#snapshot = { status, alias, detail };
    for (const listener of [...this.#listeners]) listener(this.#snapshot);
  }

  subscribe(listener: ConnectionListener): () => void {
    this.#listeners.add(listener);
    // Deliver the current state immediately so a late subscriber is never out of date.
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }
}
