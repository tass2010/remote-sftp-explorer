import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** rustup installs to ~/.cargo/bin, which is not always on an npm script's PATH. */
function resolveCargo() {
  const candidate = path.join(
    os.homedir(),
    '.cargo',
    'bin',
    process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  );
  return existsSync(candidate) ? candidate : 'cargo';
}

/**
 * Build the Windows askpass helper and stage it where the manifest expects it.
 *
 * Two targets produce a working binary:
 *
 *   x86_64-pc-windows-msvc  the release target, built on Windows CI
 *   x86_64-pc-windows-gnu   cross-compiled from Linux with mingw-w64
 *
 * The gnu target exists so a complete, installable VSIX can be produced from a Linux
 * development machine. The helper depends only on serde, serde_json, and zeroize -- all pure
 * Rust with no MSVC-specific linkage -- so the two builds are equivalent in behaviour.
 *
 * Pass a target explicitly, or let it pick: MSVC on Windows, GNU elsewhere.
 */
const explicitTarget = process.argv[2];
const target =
  explicitTarget ??
  (process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-pc-windows-gnu');

const manifest = path.resolve('src/native/askpass/Cargo.toml');
const destination = path.resolve('src/packages/extension/bin/win32-x64');

console.log(`Building the askpass helper for ${target}...`);

try {
  execFileSync(
    resolveCargo(),
    ['build', '--release', '--target', target, '--manifest-path', manifest],
    { stdio: 'inherit' }
  );
} catch {
  console.error(
    `\nThe build failed. For ${target} you need:\n` +
      (target.endsWith('-gnu')
        ? '  rustup target add x86_64-pc-windows-gnu\n  apt install mingw-w64\n'
        : '  rustup target add x86_64-pc-windows-msvc (on Windows, with MSVC build tools)\n')
  );
  process.exit(1);
}

const built = path.resolve(
  'src/native/askpass/target',
  target,
  'release/remote-sftp-askpass.exe'
);
if (!existsSync(built)) {
  console.error(`cargo reported success but ${built} is missing.`);
  process.exit(1);
}

mkdirSync(destination, { recursive: true });
copyFileSync(built, path.join(destination, 'remote-sftp-askpass.exe'));
console.log(`Staged ${path.join(destination, 'remote-sftp-askpass.exe')}`);
