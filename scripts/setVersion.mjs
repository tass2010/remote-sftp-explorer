import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Set the version everywhere at once.
 *
 * There are eight places, and three of them are the pinned dependencies packages declare on
 * each other. Missing one of those does not produce a cosmetic inconsistency -- npm workspaces
 * fails to link, or links a version that does not exist. That is why this is a script rather
 * than a line in a checklist saying "remember to edit eight files".
 *
 *   npm run version -- 0.3.1
 */
const WORKSPACE_PACKAGES = ['sftp-protocol', 'core', 'extension'];
const SCOPE = '@remote-sftp-explorer/';

const version = process.argv[2];

if (version === undefined) {
  console.error('Usage: npm run version -- <version>\n  e.g. npm run version -- 0.3.1');
  process.exit(1);
}

// Deliberately strict. A typo here propagates into a published artifact's filename and a git
// tag, both of which are awkward to take back.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${version}" is not a version. Expected MAJOR.MINOR.PATCH, e.g. 0.3.1`);
  process.exit(1);
}

const changed = [];

function updateJson(file, mutate) {
  const before = readFileSync(file, 'utf8');
  const manifest = JSON.parse(before);
  mutate(manifest);
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  if (after !== before) {
    writeFileSync(file, after);
    changed.push(path.relative(process.cwd(), file));
  }
}

updateJson('package.json', (manifest) => {
  manifest.version = version;
});

for (const name of WORKSPACE_PACKAGES) {
  updateJson(path.join('src/packages', name, 'package.json'), (manifest) => {
    manifest.version = version;
    // The pinned cross-package dependencies. These are the ones that actually break.
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith(SCOPE)) manifest.dependencies[dependency] = version;
    }
  });
}

// Cargo: only the [package] version. A blind replace would also rewrite the dependency
// versions further down the file.
const cargoPath = 'src/native/askpass/Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
const updatedCargo = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/u,
  `$1${version}$2`
);
if (updatedCargo !== cargo) {
  writeFileSync(cargoPath, updatedCargo);
  changed.push(cargoPath);
}

if (changed.length === 0) {
  console.log(`Already at ${version}; nothing to change.`);
  process.exit(0);
}

console.log(`Set version ${version} in:`);
for (const file of changed) console.log(`  ${file}`);

// The lock file records the workspace versions too, so it goes stale the moment they change.
console.log('\nUpdating package-lock.json...');
execFileSync('npm', ['install', '--package-lock-only', '--silent'], { stdio: 'inherit' });

console.log(
  '\nNext: npm test (the version-consistency test will confirm this), then commit and tag.'
);
