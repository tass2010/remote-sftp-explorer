# Remote SFTP Explorer

Browse and edit files on remote Linux/Unix servers from VS Code, using the OpenSSH setup you
already have on your machine.

There is no second configuration file to maintain. The extension reads your existing SSH
config, lists the hosts it finds, and hands the alias straight back to `ssh.exe` to connect —
so your agent, keys, certificates, `ProxyJump` chains, `Match` rules and `known_hosts` policy
all keep working exactly as they do on the command line.

## Status

**Early, and Windows-only.** Browsing, opening, editing and saving all work. Creating,
renaming, deleting, uploading and downloading do not yet have a user interface. Read
[Limitations](#limitations) before installing — it is a short list and an honest one.

## How it works

Rather than reimplementing SSH in JavaScript, this extension launches the OpenSSH client you
already trust and speaks the SFTP protocol over its stdio:

```
VS Code  ──►  ssh.exe -s <host> sftp  ──►  your server
```

That single decision is why your existing configuration keeps working, and it is the reason
for most of the design. The trade-offs are recorded in
[ADR-0004](docs/adr/0004-keep-ssh-subprocess.md).

## Requirements

| | |
|---|---|
| Operating system | Windows 11 x64 |
| VS Code | 1.100 or newer |
| OpenSSH | `ssh.exe` on `PATH`, or at `%WINDIR%\System32\OpenSSH\ssh.exe` |
| SSH config | At least one non-wildcard `Host` entry in `%USERPROFILE%\.ssh\config` |
| Server | Any SSH server with the SFTP subsystem enabled |

## Installing

No Marketplace release yet. Download the `.vsix` from
[Releases](../../releases) and install it:

```bash
code --install-extension remote-sftp-explorer-<version>.vsix
```

Then reload the window. Or use **Extensions: Install from VSIX…** from the command palette.

## What it does

**Finds your hosts.** Reads `%USERPROFILE%\.ssh\config` and the system-wide `ssh_config`,
following `Include` directives. Each alias is validated with `ssh -G`, so a host OpenSSH
cannot resolve is shown as unusable with the reason, rather than failing later when you try
to connect.

**Handles every authentication method.** Password, key passphrase, keyboard-interactive and
host-key confirmation all appear as native VS Code prompts, bridged from OpenSSH through a
small `SSH_ASKPASS` helper. Nothing you type is ever written to disk or to a log.

**Browses.** A single-directory panel with an editable path bar, per-host history, sortable
Name and Size columns, and full keyboard navigation.

**Saves carefully.** Every save asks first. Before uploading, the file's size and modification
time are compared against what they were when you opened it, so a change someone else made in
the meantime is never silently overwritten — you choose to overwrite, reload, or cancel.

The write itself is never a truncating overwrite. New content goes to a temporary file in the
same directory, inherits the original's permissions, is flushed to disk, and is then swapped
into place — atomically where the server supports `posix-rename@openssh.com`, otherwise
through a rename-via-backup sequence that restores the original if any step fails. Leftovers
from an interrupted save are cleaned up on the next connection.

**Reconnects.** Dropped connections retry with exponential backoff, with SSH keepalive to
notice a dead link within about 45 seconds.

## Limitations

Stated plainly, so you can decide before installing:

- **Windows 11 x64 only.** macOS and Linux clients are not supported. The extension refuses to
  activate elsewhere rather than half-working.
- **No file management UI yet.** Creating, renaming, deleting, uploading and downloading are
  not reachable from the interface. The underlying operations exist; the commands and menus do
  not.
- **One connection at a time.** Opening a host replaces the current session.
- **English only.**
- **No remote change detection.** The panel does not notice edits made on the server by
  something else; refresh to see them.
- **Conflict detection uses size and modification time**, not content hashing. It catches most
  concurrent edits cheaply, but it is not a merge tool.

## What is stored on your machine

- **Favourites** — the host alias and remote path you chose to save.
- **Directory history** — up to 20 recently visited directories per host, clearable from the
  command palette.

Both live in VS Code's global state, an ordinary file on disk, so remote *paths* are
recoverable from it. Remote file *contents* and credentials are never stored anywhere.

## Building from source

Requires Node.js 22+, and Rust with `mingw-w64` if you want to build the authentication helper
(which cross-compiles a real Windows binary from Linux).

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run package:vsix
```

[docs/06-building.md](docs/06-building.md) covers the prerequisites, every script, and why
packaging refuses rather than warns when the helper is missing.

## Documentation

The documentation is short and split by question rather than being one large document, because
a 150-line protocol document gets re-read by whoever changes the protocol and an 800-line
omnibus gets re-read by nobody.

| Document | Answers |
|---|---|
| [01-product.md](docs/01-product.md) | What is this, who is it for, and what does it deliberately not do? |
| [02-architecture.md](docs/02-architecture.md) | How is the code divided, and what may depend on what? |
| [03-protocol.md](docs/03-protocol.md) | How do we speak SFTP v3 over an `ssh.exe` subprocess? |
| [04-auth-and-security.md](docs/04-auth-and-security.md) | How do auth prompts reach the user, and what are the security limits? |
| [05-testing.md](docs/05-testing.md) | What is tested where, and what genuinely needs Windows? |
| [06-building.md](docs/06-building.md) | How do I build, test, and package this? |
| [adr/](docs/adr/) | Dated records of decisions, including the ones that were reversed. |

Architectural claims in those documents carry an `enforced-by:` tag naming the test that proves
them, and a test asserts that every such tag points at a file that exists. This is deliberate:
the previous generation of this project asserted an architecture in prose that nothing checked,
and the code drifted away from it for months without anyone noticing.

## Security

Credentials are never written to disk or to a log. The `SSH_ASKPASS` helper zeroes its copies
of the token and the answer; the TypeScript side minimises copies but cannot zero a JavaScript
string, and [04-auth-and-security.md](docs/04-auth-and-security.md) says so plainly rather than
implying parity.

If you find a vulnerability, please report it privately rather than opening a public issue.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure
`npm run typecheck`, `npm run lint` and `npm test` all pass — the test suite includes
architecture and documentation invariants, so a boundary violation or a stale doc reference
will fail the build rather than being caught in review.

## License

MIT. See [LICENSE](LICENSE).
