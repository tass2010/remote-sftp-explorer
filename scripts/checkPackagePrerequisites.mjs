import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Refuse to package unless everything the manifest promises is actually present.
 *
 * `vsce` already fails when a `files` pattern matches nothing, but its message ("remove any
 * include pattern which is not needed") points at the wrong fix: dropping `bin/**` is how the
 * previous release ended up shipping without its askpass helper, which is why password
 * authentication could not work. This turns that into an explicit instruction instead.
 */
const extensionRoot = path.resolve('src/packages/extension');

const required = [
  {
    file: 'dist/extension.cjs',
    fix: 'npm run build'
  },
  {
    file: 'media/filesView.js',
    fix: 'npm run build'
  },
  {
    file: 'media/filesView.css',
    fix: 'npm run build'
  },
  {
    file: 'bin/win32-x64/remote-sftp-askpass.exe',
    fix:
      'cargo build --release --target x86_64-pc-windows-msvc --manifest-path ' +
      'src/native/askpass/Cargo.toml, then copy the binary into ' +
      'src/packages/extension/bin/win32-x64/. This requires Windows; a package built ' +
      'without it cannot do password, passphrase, or keyboard-interactive authentication.'
  }
];

const missing = required.filter((entry) => !existsSync(path.join(extensionRoot, entry.file)));

if (missing.length > 0) {
  console.error('Cannot package: required files are missing.\n');
  for (const entry of missing) {
    console.error(`  ${entry.file}`);
    console.error(`      fix: ${entry.fix}\n`);
  }
  process.exit(1);
}

console.log('All packaging prerequisites are present.');
