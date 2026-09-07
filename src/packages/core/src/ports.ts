/**
 * The seams between product logic and its host.
 *
 * `core` never imports `vscode` (docs/02-architecture.md, invariant 4). Everything the host
 * provides arrives through one of these interfaces, so every module below can be unit-tested
 * on any platform with a hand-written fake.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
  /** Verbose diagnostics. Must never receive secrets. */
  debug(message: string): void;
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
};

export type PromptKind = 'secret' | 'confirm' | 'text';

export interface PromptRequest {
  kind: PromptKind;
  /** OpenSSH's prompt text, shown verbatim so fingerprints are never paraphrased. */
  message: string;
}

export interface PromptUi {
  /** Resolve with the answer, or undefined if the user cancelled. */
  ask(request: PromptRequest): Promise<string | undefined>;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  write(chunk: Uint8Array): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
  closeStdin(): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  executable: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface ProcessSpawner {
  spawn(options: SpawnOptions): SpawnedProcess;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** For one-shot commands whose output we parse, such as `ssh -G`. */
export interface CommandRunner {
  run(executable: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  listDirectory(path: string): Promise<string[]>;
}

/** Key/value storage that survives restarts. Backed by VS Code's Memento. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}
