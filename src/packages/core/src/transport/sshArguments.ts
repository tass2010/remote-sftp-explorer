/**
 * Argument construction for the OpenSSH subprocess.
 *
 * Arguments are always passed as an array with `shell: false`; nothing here is ever
 * interpolated into a command line.
 */

export class InvalidHostAliasError extends Error {
  constructor(alias: string) {
    super(`"${alias}" is not a usable SSH host alias.`);
    this.name = 'InvalidHostAliasError';
  }
}

/**
 * A host alias must come from the local SSH config and must not look like an option.
 * A leading `-` would otherwise let a config-supplied name act as an ssh flag.
 */
export function assertUsableAlias(alias: string): void {
  if (alias.length === 0 || alias.startsWith('-') || alias.includes('\0')) {
    throw new InvalidHostAliasError(alias);
  }
  if (/\s/u.test(alias)) throw new InvalidHostAliasError(alias);
}

export interface SshArgumentOptions {
  /** Extra `-o Key=Value` settings, used by tests and diagnostics. */
  extraOptions?: ReadonlyArray<readonly [string, string]>;
}

export function buildSshArguments(
  alias: string,
  options: SshArgumentOptions = {}
): string[] {
  assertUsableAlias(alias);

  const settings: Array<readonly [string, string]> = [
    // A file-browsing session has no business allocating a terminal, forwarding ports, or
    // running local commands, whatever the user's config says.
    ['RequestTTY', 'no'],
    ['ClearAllForwardings', 'yes'],
    ['PermitLocalCommand', 'no'],
    ['RemoteCommand', 'none'],
    ['ConnectTimeout', '15'],
    // Keepalive: also how a dead connection is noticed within ~45 seconds.
    ['ServerAliveInterval', '15'],
    ['ServerAliveCountMax', '3'],
    // A wrong password should fail once, not three times.
    ['NumberOfPasswordPrompts', '1'],
    ...(options.extraOptions ?? [])
  ];

  // NOTE: BatchMode is deliberately absent. The previous implementation hardcoded
  // `BatchMode=yes`, which disables every interactive prompt in OpenSSH and so made
  // password, passphrase, and keyboard-interactive authentication impossible -- only
  // key/agent auth could ever connect. See docs/04-auth-and-security.md.
  const args = ['-T'];
  for (const [key, value] of settings) args.push('-o', `${key}=${value}`);
  args.push('-s', alias, 'sftp');
  return args;
}

/** Environment for the ssh child, layered over the inherited environment. */
export function buildSshEnvironment(
  base: Record<string, string | undefined>,
  askpass: { executable: string; url: string; token: string } | undefined
): Record<string, string | undefined> {
  // Must extend the inherited environment rather than replace it: dropping USERPROFILE or
  // SSH_AUTH_SOCK would break config discovery and agent authentication respectively.
  const env: Record<string, string | undefined> = { ...base };
  if (askpass === undefined) return env;

  env['SSH_ASKPASS'] = askpass.executable;
  // `force` makes OpenSSH use the helper even when a terminal appears to be available.
  env['SSH_ASKPASS_REQUIRE'] = 'force';
  env['REMOTE_SFTP_ASKPASS_URL'] = askpass.url;
  env['REMOTE_SFTP_ASKPASS_TOKEN'] = askpass.token;
  // Detach from any inherited DISPLAY-based askpass behaviour.
  delete env['SSH_ASKPASS_PROMPT'];
  return env;
}
