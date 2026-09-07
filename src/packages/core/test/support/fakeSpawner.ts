import type { ProcessSpawner, SpawnedProcess, SpawnOptions } from '../../src/ports.ts';

/**
 * A controllable stand-in for a spawned `ssh` process.
 *
 * The real transport is the only place a subprocess exists, so this fake is what lets the
 * session, reconnect, and disconnect paths be tested without one.
 */
export class FakeProcess implements SpawnedProcess {
  readonly pid = 4242;
  readonly written: Uint8Array[] = [];
  stdinClosed = false;
  killed = false;

  #stdout: Array<(chunk: Uint8Array) => void> = [];
  #stderr: Array<(chunk: Uint8Array) => void> = [];
  #exit: Array<(code: number | null, signal: string | null) => void> = [];
  #error: Array<(error: Error) => void> = [];

  /** Set to pipe stdin somewhere -- e.g. into a fake SFTP server. */
  onWrite?: (chunk: Uint8Array) => void;

  write(chunk: Uint8Array): void {
    if (this.stdinClosed) throw new Error('stdin is closed');
    this.written.push(chunk);
    this.onWrite?.(chunk);
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.#stdout.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.#stderr.push(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.#exit.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#error.push(listener);
  }

  closeStdin(): void {
    this.stdinClosed = true;
  }

  kill(): void {
    this.killed = true;
    this.emitExit(null, 'SIGTERM');
  }

  // -- test controls ------------------------------------------------------

  emitStdout(chunk: Uint8Array): void {
    for (const listener of this.#stdout) listener(chunk);
  }

  emitStderr(text: string): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of this.#stderr) listener(chunk);
  }

  emitExit(code: number | null, signal: string | null = null): void {
    for (const listener of this.#exit) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of this.#error) listener(error);
  }
}

export class FakeSpawner implements ProcessSpawner {
  readonly spawns: SpawnOptions[] = [];
  readonly processes: FakeProcess[] = [];
  /** Called for each spawn, so a test can script the child's behaviour. */
  onSpawn?: (child: FakeProcess, options: SpawnOptions) => void;

  spawn(options: SpawnOptions): SpawnedProcess {
    this.spawns.push(options);
    const child = new FakeProcess();
    this.processes.push(child);
    this.onSpawn?.(child, options);
    return child;
  }

  get lastProcess(): FakeProcess | undefined {
    return this.processes.at(-1);
  }

  get lastSpawn(): SpawnOptions | undefined {
    return this.spawns.at(-1);
  }
}
