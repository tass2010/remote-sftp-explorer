# Security Policy

This extension handles SSH credentials and connects to remote machines, so security reports
are taken seriously and answered.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead:
[Report a vulnerability](https://github.com/tass2010/remote-sftp-explorer/security/advisories/new).
It is enabled on this repository, so the report stays between you and the maintainer until a
fix exists.

Useful things to include, to whatever extent you have them: what an attacker can achieve, the
steps to reproduce, the extension version, and your OpenSSH and VS Code versions. A proof of
concept helps but is not required — a clear description of the flaw is enough to start.

Expect an acknowledgement within about a week. This is a small project maintained in spare
time, so please read that as a genuine estimate rather than a service commitment.

## Supported versions

Only the latest release. There are no maintenance branches, and fixes go into the next
release rather than being backported.

## What this project does with your credentials

Understanding the design will tell you where to look.

Authentication is not implemented here. The extension launches the OpenSSH client already
installed on your machine and lets it do the authenticating, so keys, agents, certificates and
`known_hosts` policy stay entirely OpenSSH's business. No private key is ever read, copied, or
stored by this extension.

What the extension does handle is the answer you type into a prompt. When OpenSSH needs a
password, a passphrase, or a host-key confirmation, it runs a small helper binary shipped with
the extension, which relays the prompt to VS Code over loopback HTTP and returns your answer
on stdout. That channel is scoped as tightly as we could make it:

- it listens on `127.0.0.1` only, on an OS-assigned port, and rejects any non-loopback caller;
- a fresh 256-bit token is minted for every connection attempt and compared in constant time;
- the request body is capped by counting bytes as they arrive, and the socket is destroyed on
  overflow rather than the body being buffered;
- the server is shut down as soon as the connection attempt ends, so the endpoint does not
  outlive the authentication it exists for;
- answers and tokens are never written to disk and never reach a log. There is a test that
  asserts this by running the real components and scanning the logger output.

Nothing you type is persisted. The only things stored on disk are favourites and directory
history — host aliases and remote *paths*, in VS Code's ordinary global state. Remote file
contents are never stored.

## Known limitations

These are design limits rather than bugs, and reporting them will not tell us anything new.
They are listed because knowing about them may help you decide whether this tool suits your
threat model.

**JavaScript strings cannot be zeroed.** The Rust helper zeroes its copies of the token and
the answer, including the raw HTTP buffer that carried them. The TypeScript side minimises
copies but cannot do the same: strings are immutable and garbage-collected, so an answer may
persist in the Extension Host's memory until collected, and could in principle reach swap.
Anyone able to read that process's memory has already won.

**Draft protection is VS Code's, not ours.** Declining a save leaves the editor dirty, and
VS Code's own hot-exit backup stores that content unencrypted in its storage.

**Favourites and history are plaintext.** They live in VS Code's global state, an ordinary
file on disk, so remote paths are readable by anything that can read that file.

**We trust your SSH config.** It is treated as trusted local configuration: OpenSSH will
execute a `ProxyCommand` or a `Match exec` you have configured. Port forwarding and
`LocalCommand` are explicitly disabled for these sessions, since a file browser has no need of
them, but the config is otherwise honoured as written.

**One unverified assumption.** Whether Win32-OpenSSH honours `SSH_ASKPASS` when launched from
a console-less process with piped stdio has not yet been confirmed on real hardware. If it
does not, password prompts fail rather than falling back to anything less safe — but the
behaviour is genuinely unverified and is stated here rather than assumed.

## Out of scope

- Vulnerabilities in OpenSSH itself. Report those to the OpenSSH project.
- Vulnerabilities in VS Code itself. Report those to Microsoft.
- An attacker who already executes code as your user. They can read the Extension Host's
  memory, VS Code's backups, and your SSH keys, and nothing this extension does can prevent
  that.
