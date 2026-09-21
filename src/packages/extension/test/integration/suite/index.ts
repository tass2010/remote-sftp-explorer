/**
 * The entry VS Code loads inside the Extension Host.
 *
 * Suites are imported and listed here rather than discovered from disk: the whole thing is
 * bundled into one file, so there is nothing to discover and no module loader to fight with
 * inside Electron. Adding a suite means adding a line here, which is the point -- a suite
 * that is never listed is a suite that never runs, and that should be visible.
 */
import { run as runSuites, type Suite } from './harness.ts';
import { activationSuite } from './activation.suite.ts';
import { viewsSuite } from './views.suite.ts';
import { fileSystemSuite } from './fileSystem.suite.ts';
import { reconnectSuite } from './reconnect.suite.ts';

const suites: Suite[] = [activationSuite, viewsSuite, fileSystemSuite, reconnectSuite];

export async function run(): Promise<void> {
  // Printed before anything else so a failure to get this far is distinguishable from a
  // failure inside a suite.
  console.log(`Extension Host suite loaded: ${suites.length} suites.`);
  await runSuites(suites);
}
