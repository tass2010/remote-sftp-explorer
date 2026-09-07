import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/**
 * Two bundles, because they run in different worlds:
 *   - the extension host: node, CommonJS, `vscode` supplied by the host
 *   - the webview client: browser, IIFE, DOM only
 *
 * The client is emitted to media/ and then read at resolve time and inlined under the page's
 * nonce, which is what lets the webview keep `localResourceRoots: []` (ADR-0001, condition C1).
 */
const extensionBundle = {
  entryPoints: ['src/packages/extension/src/extension.ts'],
  outfile: 'src/packages/extension/dist/extension.cjs',
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info'
};

const webviewBundle = {
  entryPoints: ['src/packages/extension/webview/src/main.ts'],
  outfile: 'src/packages/extension/media/filesView.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  // No source map: the file is inlined into the page, and a map would have nothing to point at.
  sourcemap: false,
  minify: !watch,
  logLevel: 'info'
};

await mkdir('src/packages/extension/media', { recursive: true });
await Promise.all([build(extensionBundle), build(webviewBundle)]);
await copyFile(
  'src/packages/extension/webview/src/style.css',
  'src/packages/extension/media/filesView.css'
);

console.log('Built extension and webview bundles.');
