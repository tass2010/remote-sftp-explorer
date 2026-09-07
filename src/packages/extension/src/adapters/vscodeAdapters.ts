import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, access } from 'node:fs/promises';
import type {
  CommandResult,
  CommandRunner,
  FileSystemPort,
  Logger,
  Memento,
  ProcessSpawner,
  PromptRequest,
  PromptUi,
  SpawnedProcess,
  SpawnOptions
} from '@remote-sftp-explorer/core';

/**
 * Implementations of the core ports, backed by VS Code and node.
 *
 * This file is the entire surface where product logic meets its host. Everything below it in
 * the dependency graph is testable without an Extension Host.
 */

export class OutputChannelLogger implements Logger {
  readonly #channel: vscode.LogOutputChannel;

  constructor(channel: vscode.LogOutputChannel) {
    this.#channel = channel;
  }

  info(message: string): void {
    this.#channel.info(message);
  }

  warn(message: string, error?: unknown): void {
    this.#channel.warn(error === undefined ? message : `${message} ${describe(error)}`);
  }

  error(message: string, error?: unknown): void {
    this.#channel.error(error === undefined ? message : `${message} ${describe(error)}`);
  }

  debug(message: string): void {
    this.#channel.debug(message);
  }
}

export class VsCodePromptUi implements PromptUi {
  async ask(request: PromptRequest): Promise<string | undefined> {
    if (request.kind === 'confirm') {
      // The full OpenSSH text is shown verbatim: a fingerprint the user is asked to trust must
      // never be paraphrased or truncated.
      const choice = await vscode.window.showWarningMessage(
        'Remote SFTP Explorer: confirm the SSH connection',
        { modal: true, detail: request.message },
        'Yes',
        'No'
      );
      if (choice === undefined) return undefined;
      return choice === 'Yes' ? 'yes' : 'no';
    }

    return vscode.window.showInputBox({
      prompt: request.message,
      password: request.kind === 'secret',
      // Losing focus mid-authentication would abort the connection.
      ignoreFocusOut: true
    });
  }
}

export class NodeProcessSpawner implements ProcessSpawner {
  spawn(options: SpawnOptions): SpawnedProcess {
    const child = spawn(options.executable, options.args, {
      // Never a shell: arguments stay an array and are not re-parsed.
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env
    });

    return {
      pid: child.pid,
      write: (chunk) => {
        child.stdin.write(chunk);
      },
      onStdout: (listener) => child.stdout.on('data', (chunk: Buffer) => listener(chunk)),
      onStderr: (listener) => child.stderr.on('data', (chunk: Buffer) => listener(chunk)),
      onExit: (listener) => child.on('close', (code, signal) => listener(code, signal)),
      onError: (listener) => child.on('error', listener),
      closeStdin: () => child.stdin.end(),
      kill: (signal) => {
        child.kill(signal as NodeJS.Signals | undefined);
      }
    };
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(executable: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { timeout: timeoutMs, windowsHide: true, shell: false },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== 'number') {
            // Could not be launched at all -- distinct from a non-zero exit.
            reject(error);
            return;
          }
          resolve({
            code: error === null ? 0 : (error.code as number),
            stdout,
            stderr
          });
        }
      );
    });
  }
}

export class NodeFileSystemPort implements FileSystemPort {
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async listDirectory(path: string): Promise<string[]> {
    return readdir(path);
  }
}

export class MementoAdapter implements Memento {
  readonly #memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.#memento = memento;
  }

  get<T>(key: string): T | undefined {
    return this.#memento.get<T>(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.#memento.update(key, value);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
