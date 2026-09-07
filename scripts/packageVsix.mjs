import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Package the extension into dist/.
 *
 * The output name is derived from the manifest rather than written down. It used to be
 * hardcoded, which meant bumping the version would have produced a file still claiming to be
 * the old one.
 *
 * The digest is printed because during development every build carries the same version
 * number, so the file name alone cannot tell you whether the thing you just installed is the
 * thing you just built.
 */
const extensionRoot = path.resolve('src/packages/extension');
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const outDir = path.resolve('dist');
const outFile = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);

mkdirSync(outDir, { recursive: true });

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'vsce',
    'package',
    '--target',
    'win32-x64',
    '--no-dependencies',
    '--out',
    outFile
  ],
  { cwd: extensionRoot, stdio: 'inherit' }
);

const bytes = readFileSync(outFile);
const digest = createHash('sha256').update(bytes).digest('hex');

console.log(`\n  ${outFile}`);
console.log(`  ${statSync(outFile).size.toLocaleString()} bytes`);
console.log(`  sha256 ${digest}`);
console.log(
  `\n  Install:  code --install-extension "${outFile}" --force` +
    `\n  --force is required because reinstalling the same version is otherwise refused.` +
    `\n  Then reload the window (Developer: Reload Window) for the change to take effect.\n`
);
