import { assertUsableAlias } from '../transport/sshArguments.ts';
import type { CommandRunner } from '../ports.ts';

export const SSH_G_TIMEOUT_MS = 10_000;

export interface ResolvedHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
}

export interface ValidationFailure {
  alias: string;
  reason: string;
}

export type ValidationResult =
  | { ok: true; host: ResolvedHost }
  | { ok: false; failure: ValidationFailure };

/**
 * Ask OpenSSH itself whether an alias resolves, and to what.
 *
 * `ssh -G` applies the full configuration -- Match blocks, Include chains, system defaults,
 * canonicalisation -- and prints the effective settings without connecting. That makes it the
 * only trustworthy answer to "will this alias work, and where does it point?", which is why
 * the design called for it. The previous implementation never ran it, so a host that OpenSSH
 * could not resolve still appeared in the list and failed only at connect time.
 */
export async function validateHost(
  runner: CommandRunner,
  sshExecutable: string,
  alias: string,
  timeoutMs = SSH_G_TIMEOUT_MS
): Promise<ValidationResult> {
  try {
    assertUsableAlias(alias);
  } catch (error) {
    return {
      ok: false,
      failure: { alias, reason: error instanceof Error ? error.message : String(error) }
    };
  }

  let result;
  try {
    result = await runner.run(sshExecutable, ['-G', alias], timeoutMs);
  } catch (error) {
    return {
      ok: false,
      failure: {
        alias,
        reason: `ssh -G could not be run: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] ?? `exit code ${result.code}`;
    return { ok: false, failure: { alias, reason: detail } };
  }

  return { ok: true, host: { alias, ...parseSshG(result.stdout) } };
}

/**
 * Parse `ssh -G` output: one lowercase keyword per line, then its value.
 *
 * Unknown keywords are ignored rather than treated as errors -- OpenSSH adds settings between
 * versions, and we only need three of them.
 */
export function parseSshG(stdout: string): Omit<ResolvedHost, 'alias'> {
  const resolved: Omit<ResolvedHost, 'alias'> = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;
    const keyword = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value.length === 0) continue;

    if (keyword === 'hostname') resolved.hostName = value;
    else if (keyword === 'user') resolved.user = value;
    else if (keyword === 'port') {
      const port = Number.parseInt(value, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) resolved.port = port;
    }
  }
  return resolved;
}

/** A short `user@host:port` description for the host list, when we have the parts. */
export function describeHost(host: ResolvedHost): string | undefined {
  if (host.hostName === undefined) return undefined;
  const user = host.user === undefined ? '' : `${host.user}@`;
  const port = host.port === undefined || host.port === 22 ? '' : `:${host.port}`;
  return `${user}${host.hostName}${port}`;
}
