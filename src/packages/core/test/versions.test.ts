/**
 * Version consistency across the workspace.
 *
 * Eight places carry the version, and three of them are the pinned dependencies the packages
 * declare on each other. Getting one wrong does not look wrong -- npm workspaces either fails
 * to link or links a version that does not exist, and the packaging step happily names the
 * artifact after whichever number the extension manifest happens to hold.
 *
 * `npm run set-version` writes all eight. This test is what makes forgetting to use it fail
 * loudly rather than quietly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const SCOPE = '@remote-sftp-explorer/';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

function readManifest(relative: string): Manifest {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), 'utf8')) as Manifest;
}

const root = readManifest('package.json');
const packages = ['sftp-protocol', 'core', 'extension'].map((name) => ({
  name,
  relative: `src/packages/${name}/package.json`,
  manifest: readManifest(`src/packages/${name}/package.json`)
}));

test('every workspace package carries the root version', () => {
  for (const pkg of packages) {
    assert.equal(
      pkg.manifest.version,
      root.version,
      `${pkg.relative} is ${pkg.manifest.version}, but the root is ${root.version}. ` +
        'Run `npm run set-version -- <version>` rather than editing by hand.'
    );
  }
});

test('cross-package dependencies are pinned to that same version', () => {
  // The failure this guards against is not cosmetic: a stale pin here means npm cannot link
  // the workspace, or links something that was never published.
  for (const pkg of packages) {
    for (const [dependency, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (!dependency.startsWith(SCOPE)) continue;
      assert.equal(
        range,
        root.version,
        `${pkg.relative} depends on ${dependency}@${range}, but the workspace is at ` +
          `${root.version}. Run \`npm run set-version -- <version>\`.`
      );
    }
  }
});

test('the askpass crate carries the same version', () => {
  const cargo = readFileSync(path.join(repoRoot, 'src/native/askpass/Cargo.toml'), 'utf8');
  // Anchored to [package]: the dependency versions further down are unrelated.
  const found = /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u.exec(cargo)?.[1];

  assert.equal(
    found,
    root.version,
    `Cargo.toml is ${found ?? 'unreadable'}, but the workspace is at ${root.version}.`
  );
});

test('every cross-package dependency names a package that exists', () => {
  const known = new Set(packages.map((pkg) => pkg.manifest.name));
  for (const pkg of packages) {
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (!dependency.startsWith(SCOPE)) continue;
      assert.ok(
        known.has(dependency),
        `${pkg.relative} depends on ${dependency}, which is not a package in this workspace.`
      );
    }
  }
});
