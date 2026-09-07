# Changelog

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
