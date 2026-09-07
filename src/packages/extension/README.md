# Remote SFTP Explorer

Browse and safely edit files on remote Linux/Unix servers, using the OpenSSH setup you already
have on your Windows machine.

There is no second configuration file. The extension reads your existing SSH config, lists the
hosts it finds, and hands the alias straight back to `ssh.exe` to connect — so your agent,
keys, certificates, `ProxyJump` chains, and `known_hosts` policy all keep working unchanged.

## Requirements

- Windows 11 x64
- VS Code 1.100 or newer
- OpenSSH (`ssh.exe` on `PATH`, or at `%WINDIR%\System32\OpenSSH\ssh.exe`)
- At least one non-wildcard `Host` entry in `%USERPROFILE%\.ssh\config`
- A server with the SFTP subsystem enabled

## Views

The activity bar container has three:

- **SSH Hosts** — every concrete alias from your SSH config. Each is validated with `ssh -G`,
  so an alias OpenSSH cannot resolve is shown as unusable with the reason, rather than failing
  only when you try to connect.
- **Favorites** — locations you have saved, scoped to the connected host.
- **Remote Files** — a single-directory browser with an editable path bar, a per-host history
  dropdown, and Name/Size/Modified columns. Arrow keys, Home, End, Enter, and Backspace all
  navigate it.

## Authentication

Password, key passphrase, keyboard-interactive, and host-key prompts appear as native VS Code
input boxes. Passwords are masked; a host-key confirmation shows OpenSSH's full prompt text,
including the fingerprint, so you can check it before agreeing.

Nothing you type is stored. No password, passphrase, code, or key ever reaches disk.

## Editing and saving

Files open in the normal editor. Every save asks for confirmation before touching the server.

Before uploading, the file's modification time and size are compared against what they were
when you opened it. If something else changed the file meanwhile, you choose: overwrite,
discard your changes and reload, or cancel.

The replacement itself is never a truncating write. The new content goes to a temporary file in
the same directory, inherits the original's permissions, is flushed to disk, and is then swapped
into place — atomically where the server supports it, otherwise through a rename-via-backup
sequence that puts the original back if any step fails.

If you decline the save confirmation, the editor simply stays unsaved, and VS Code's own
backup protects your work as it would for any other file.

## What is not here yet

Creating, renaming, deleting, uploading, and downloading are not implemented. The browse and
save loop is deliberately proven first, because delete and rename are where a protocol bug
destroys data rather than merely annoying you.

The interface is English only.

## What is stored on your machine

- **Favourites** — the host alias and remote path you chose to save.
- **Directory history** — up to 20 recently visited directories per host, clearable with
  **Clear Directory History**.

Both live in VS Code's global state, which is an ordinary file on disk: remote *paths* are
recoverable from it. Remote file *contents* and credentials are never stored.
