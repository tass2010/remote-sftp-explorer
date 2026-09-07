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

That single decision is why your existing configuration keeps working, and it shapes most of
the rest of the design. The cost is that the SFTP protocol has to be implemented here, and
that interactive authentication prompts have to be bridged out of a process with no terminal.

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

| Script | Does |
|---|---|
| `npm run typecheck` | Typechecks all four projects, each under its own boundary |
| `npm run lint` | ESLint, including the import-boundary rules |
| `npm test` | The whole suite |
| `npm run build` | Bundles the extension host and the webview client |
| `npm run build:askpass` | Builds the Rust helper and stages it for packaging |
| `npm run package:vsix` | Everything packaging needs, then produces the VSIX |

Packaging **fails** rather than warning if the authentication helper is missing, and tells you
how to build it. That is deliberate: an earlier release shipped without the helper because the
manifest omitted its directory, and the result was an extension that silently could not do
password authentication at all.

## Security

Credentials are never written to disk or to a log. The `SSH_ASKPASS` helper zeroes its copies
of the token and the answer. The TypeScript side minimises copies but **cannot** zero a
JavaScript string — strings are immutable and garbage-collected, so an answer may persist in
memory until collected. Saying so plainly seems better than implying parity.

The prompt bridge listens on `127.0.0.1` only, mints a fresh 256-bit token for every connection
attempt, compares it in constant time, and shuts down as soon as the attempt ends.

If you find a vulnerability, please report it privately rather than opening a public issue.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure
`npm run typecheck`, `npm run lint` and `npm test` all pass.

The suite includes architecture invariants as executable tests
(`src/packages/core/test/architecture.test.ts`), so a package-boundary violation fails the
build rather than having to be caught in review. The same goes for the extension manifest: a
contributed command with no handler, or a handler with no contribution, is a test failure.

## License

MIT. See [LICENSE](LICENSE).
