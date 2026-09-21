# Changelog

## Unreleased

### Added

- **Extension Host tests.** `npm run test:integration` runs the extension inside a real VS Code
  against a fake `ssh` that speaks real SFTP over real pipes: activation, the three views, the
  file system provider and its error mapping, and losing and regaining a connection. The nine
  source files that import `vscode` had no runtime test of any kind before this; the three
  fixes above are what its first run found.
- **Uploading and downloading files.** On the right-click menu in Remote Files, on the view's
  title bar, and in the command palette.
  - Neither side ever holds the file in memory, so size is bounded by the disk rather than by
    the extension. Transfers stay pipelined at 32 chunks in flight.
  - An upload goes through the same replace sequence a save does -- temporary file, fsync,
    atomic rename -- so a link that dies mid-upload cannot leave a half-written file where a
    good one was. A download that fails or is cancelled removes its partial local file.
  - The notification shows size, rate and an estimate, and can be cancelled.
  - A transfer that makes no progress at all for 20 seconds is abandoned with an error saying
    so, rather than waiting on a per-request timeout that names one packet. There is
    deliberately no minimum-throughput rule: a slow link is not a broken one, and cutting it
    off would discard work that would have finished.
- **Creating, renaming and deleting remote files and folders.** The operations had been
  implemented and tested since the rebuild, but nothing in the interface reached them, so a
  file browser could not manage files. They are now on a right-click menu in Remote Files, on
  the view's title bar, and in the command palette.
  - Deleting always asks first, and says what it is about to delete: a folder is counted
    beforehand, so "delete this folder" and "delete this folder and the 412 things inside it"
    are distinguishable before the button is pressed rather than after.
  - A new file is created with EXCL and opened, so it can never silently truncate a file that
    appeared since the name was typed. A rename never overwrites.
  - The menu is reachable from the keyboard with the menu key or Shift+F10, and navigable with
    the arrow keys.
- Every command now carries a category, so the palette shows "Remote SFTP: Delete" rather than
  a bare "Delete" among everything else that offers one.

### Changed

- Right-clicking a row opens a menu instead of immediately adding it to favourites. Adding to
  favourites is now an item on that menu.

### Fixed

- **Renaming a file within a directory no longer hangs forever.** `rename` took the lock for
  the source and then, nested inside it, the lock for the destination. Both cover the parent
  directory, so the inner acquisition waited on a key the outer one was still holding and
  nothing could ever release it. Every rename inside one folder -- which is nearly all of them
  -- deadlocked with no error and no timeout.
- **Host validation results now reach the list.** `getChildren` returned a cached promise that
  had resolved to the pre-validation snapshot, so the `ssh -G` descriptions and the marking of
  unusable hosts were computed, stored, and never shown.
- **Renaming onto an existing name is refused rather than silently replacing it.**
  `posix-rename@openssh.com` is atomic and overwrites without complaint, and the provider was
  discarding the `overwrite: false` it had been given.
- **A short read no longer leaves a hole in the middle of a file.** Servers may legitimately
  answer a READ with fewer bytes than asked for. The remainder of that range was never
  requested again, so the gap stayed as zeroes -- invisible in a small text file, corruption
  in anything large. The test that was meant to cover this only checked the length, which the
  zero-filled buffer satisfied.
- **The host list appears without waiting for every host to be probed.** It ran `ssh -G` for
  each configured alias and awaited all of them before drawing a single row -- far worse with
  `Match exec` or canonicalisation, which run commands and resolve DNS. Probing now happens in
  the background, four at a time.
- **Opening a file makes two fewer round trips.** It stat'ed the file twice before reading a
  byte, and waited for a CLOSE reply nobody reads. Directory listings no longer wait for that
  reply either.
- A refresh arriving while hosts were being probed could be overwritten by the older results,
  because the guard compared list lengths and a refresh usually produces a list of the same
  length.

## 0.3.0

A rebuild. The previous implementation had drifted from its design in ways nothing caught, and
two defects meant parts of it could not work at all.

### Fixed

- **Password, passphrase, and keyboard-interactive authentication now work.** The argument
  builder hardcoded `-o BatchMode=yes`, which disables every interactive prompt in OpenSSH, so
  only key and agent authentication could ever connect. The `SSH_ASKPASS` helper that was meant
  to bridge those prompts existed but was never called by anything, and would not have shipped
  in the package regardless — the manifest omitted its directory.
- **Saving works against servers without `posix-rename@openssh.com`.** Previously such a server
  caused the save to be refused outright. There is now a rename-via-backup fallback that
  restores the original if any step fails.
- **A timed-out request no longer poisons the session.** A late response was handed to the next
  unrelated request, which failed an id check and produced a misleading error. Abandoned ids are
  now quarantined, and a late file handle is closed rather than leaked.
- **Failures report what actually went wrong.** Only two SFTP status codes were modelled, so a
  missing file, a permissions problem, and a dead connection all produced the same message.
- Handles are released without the close failure replacing the more interesting error.
- Directory listings tolerate servers that omit the optional STATUS trailer.

### Changed

- Transfers are pipelined, up to 32 requests in flight. Reads and writes were fully serial, and
  every operation on the session — including reads of unrelated paths — queued behind every
  other, which capped throughput regardless of available bandwidth.
- Writes lock only the affected path and its parent, so unrelated work proceeds in parallel.
- Timeouts are tiered: metadata operations have a deadline, transfers use a stall timer, so a
  large file no longer fails by construction.
- Host discovery reads the system-wide `ssh_config` and validates each alias with `ssh -G`.
- The file browser keyboard and screen-reader support was rebuilt around ARIA grid semantics;
  the previous markup applied `role="tree"` to plain buttons, which is an invalid pattern.
- The browser client is now typed TypeScript, bundled and inlined under the page nonce, rather
  than a string literal in the host code.
- `remoteSftp.refreshFolder` was removed. Its handler was byte-identical to
  `remoteSftp.refreshFiles` and it appeared in no menu.

### Notes

Draft protection now relies on VS Code's own hot-exit backup rather than a bespoke encrypted
store. The store existed and was tested, but no code path ever called it; the platform already
provides the property it was meant to guarantee. The trade-off is recorded in
`docs/adr/0005-no-encrypted-pending-store.md`.

## 0.2.0

Replaced the remote file tree with a webview browser, and added favourites, per-host directory
history, automatic reconnection with exponential backoff, and SSH keepalive.

## 0.1.0

Extension activation, the Windows x64 platform guard, and initial protocol scaffolding.
