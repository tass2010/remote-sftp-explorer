import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/**
 * Bundles for the Extension Host test run.
 *
 * Three artefacts in three different worlds, which is why they are built separately from the
 * extension itself:
 *   - the launcher runs in plain Node, before VS Code exists;
 *   - the suite is loaded by VS Code inside the Extension Host, so `vscode` is external;
 *   - the fake ssh is spawned as a child process, so it must be executable on its own.
 *
 * Bundled rather than type-stripped because Electron loads the suite through its own module
 * machinery, and a single file with no loader flags is one fewer thing to be surprised by.
 */
// Deliberately NOT under the extension package. Its manifest ships `dist/**`, so a bundle
// placed there rides along into the VSIX -- which briefly shipped a fake SSH server to users
// before anyone noticed.
const outdir = 'dist/integration';

await Promise.all([
  build({
    entryPoints: { runTests: 'src/packages/extension/test/integration/runTests.ts' },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // It reaches into VS Code's own download cache and spawns the editor; bundling it would
    // break both.
    external: ['@vscode/test-electron'],
    logLevel: 'info'
  }),
  build({
    entryPoints: { suite: 'src/packages/extension/test/integration/suite/index.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['vscode'],
    logLevel: 'info'
  }),
  build({
    entryPoints: { fakeSsh: 'src/packages/extension/test/integration/fixtures/fakeSsh.ts' },
    outdir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    // Spawned by path, the way the extension spawns the real ssh, so it needs to be its own
    // runnable program rather than something `node` is pointed at.
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info'
  })
]);

chmodSync(`${outdir}/fakeSsh.cjs`, 0o755);
console.log('Built the Extension Host test bundles.');
