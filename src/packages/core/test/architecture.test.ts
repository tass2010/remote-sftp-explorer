/**
 * Executable architecture invariants.
 *
 * Every rule here is referenced by an `enforced-by:` tag in docs/02-architecture.md.
 * If you change a rule, change the doc in the same commit -- that pairing is the whole
 * point: the previous generation of this project asserted an architecture in prose that
 * nothing checked, and the code silently drifted away from it for months.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
const packagesRoot = path.join(repoRoot, 'src', 'packages');

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Module specifiers of static imports, dynamic imports, and re-exports. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function relative(file: string): string {
  return path.relative(repoRoot, file);
}

const protocolSrc = path.join(packagesRoot, 'sftp-protocol', 'src');
const coreSrc = path.join(packagesRoot, 'core', 'src');
const extensionSrc = path.join(packagesRoot, 'extension', 'src');
const webviewSrc = path.join(packagesRoot, 'extension', 'webview', 'src');

test('sftp-protocol performs no I/O and knows nothing about node or vscode', () => {
  for (const file of sourceFiles(protocolSrc)) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.startsWith('node:'),
        `${relative(file)} imports "${specifier}"; sftp-protocol must stay I/O-free so its ` +
          'client engine is testable against an in-memory channel (ADR-0002).'
      );
      assert.notEqual(
        specifier,
        'vscode',
        `${relative(file)} imports vscode; only the extension package may do that.`
      );
      assert.ok(
        !specifier.startsWith('@remote-sftp-explorer/'),
        `${relative(file)} imports "${specifier}"; sftp-protocol sits at the bottom of the ` +
          'dependency graph and may not depend on sibling packages.'
      );
    }
  }
});

test('core never imports vscode', () => {
  // This is the rule the previous implementation broke in spirit: `core` was vscode-free
  // but also import-free, i.e. dead. The companion check is "core is actually reachable",
  // which lives in the extension package's own dependency test.
  for (const file of sourceFiles(coreSrc)) {
    for (const specifier of importsOf(file)) {
      assert.notEqual(
        specifier,
        'vscode',
        `${relative(file)} imports vscode. core must stay host-agnostic and unit-testable ` +
          'without an Extension Host; take a port from core/ports instead.'
      );
    }
  }
});

test('the webview client touches neither node nor vscode', () => {
  for (const file of sourceFiles(webviewSrc)) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.startsWith('node:'),
        `${relative(file)} imports "${specifier}"; the webview client runs in a sandboxed ` +
          'iframe with DOM APIs only.'
      );
      assert.notEqual(
        specifier,
        'vscode',
        `${relative(file)} imports vscode; the webview has no access to the extension API.`
      );
    }
  }
});

test('no package reaches past another package public entry point', () => {
  const everySource = [
    ...sourceFiles(protocolSrc),
    ...sourceFiles(coreSrc),
    ...sourceFiles(extensionSrc),
    ...sourceFiles(webviewSrc)
  ];
  for (const file of everySource) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('@remote-sftp-explorer/')) continue;
      const segments = specifier.split('/');
      assert.equal(
        segments.length,
        2,
        `${relative(file)} deep-imports "${specifier}". Import the package root so its ` +
          'public surface stays reviewable.'
      );
    }
  }
});

test('every package declares the dependencies it actually imports', () => {
  const packages = [
    { name: 'sftp-protocol', dir: path.join(packagesRoot, 'sftp-protocol'), src: protocolSrc },
    { name: 'core', dir: path.join(packagesRoot, 'core'), src: coreSrc },
    { name: 'extension', dir: path.join(packagesRoot, 'extension'), src: extensionSrc }
  ];
  for (const pkg of packages) {
    const manifest = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const used = new Set<string>();
    for (const file of sourceFiles(pkg.src)) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('@remote-sftp-explorer/')) {
          used.add(specifier.split('/').slice(0, 2).join('/'));
        }
      }
    }
    for (const specifier of used) {
      assert.ok(
        declared.has(specifier),
        `${pkg.name} imports ${specifier} but does not declare it in package.json dependencies.`
      );
    }
  }
});
