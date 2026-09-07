/**
 * Packaging invariants.
 *
 * Every VSIX the previous project produced was zero bytes, and its manifest omitted the
 * directory holding the askpass helper, so packaging had never actually worked. These checks
 * cover the parts of that which can be verified without Windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
) as { main: string; files: string[]; version: string };

const bundlePath = path.join(extensionRoot, manifest.main);
const built = existsSync(bundlePath);
const skip = !built && 'run `npm run build` first';

test('the manifest entry point is what the build produces', { skip }, () => {
  assert.ok(existsSync(bundlePath), `${manifest.main} is missing`);
  assert.ok(statSync(bundlePath).size > 10_000, 'the bundle is implausibly small');
});

test('the webview client and stylesheet are built and non-empty', { skip }, () => {
  for (const asset of ['media/filesView.js', 'media/filesView.css']) {
    const assetPath = path.join(extensionRoot, asset);
    assert.ok(existsSync(assetPath), `${asset} is missing`);
    assert.ok(statSync(assetPath).size > 100, `${asset} is empty`);
  }
});

test('the packaged file list covers everything the extension loads at runtime', () => {
  for (const pattern of ['dist/**', 'media/**', 'bin/**', 'resources/**']) {
    assert.ok(
      manifest.files.includes(pattern),
      `"${pattern}" is missing from package.json "files"; it would not ship`
    );
  }
});

test('the bundle does not inline the vscode module', { skip }, () => {
  // `vscode` is supplied by the host at runtime; bundling a copy would break activation.
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /require\("vscode"\)/u);
});
