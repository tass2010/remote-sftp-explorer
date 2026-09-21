/**
 * Launches VS Code with this extension loaded and the suite pointed at.
 *
 * Runs in plain Node, outside the editor. Everything it does here -- the fixture tree, the
 * SSH config, the environment -- is what the Extension Host then finds waiting for it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const here = resolve(import.meta.dirname);
const extensionDevelopmentPath = resolve(here, '../../..');
const extensionTestsPath = resolve(here, 'suite.cjs');
const fakeSsh = resolve(here, 'fakeSsh.cjs');

const workspace = mkdtempSync(join(tmpdir(), 'remote-sftp-host-'));
const remoteRoot = join(workspace, 'remote');
const home = join(workspace, 'home');

/**
 * The remote filesystem the fake server serves.
 *
 * Deliberately small and named for what each file is for: a test that has to reason about a
 * large fixture spends its attention in the wrong place.
 */
mkdirSync(join(remoteRoot, 'subdir'), { recursive: true });
writeFileSync(join(remoteRoot, 'notes.txt'), 'hello from the fake server\n');
writeFileSync(join(remoteRoot, 'subdir', 'inner.txt'), 'nested\n');

mkdirSync(join(home, '.ssh'), { recursive: true });
writeFileSync(
  join(home, '.ssh', 'config'),
  [
    'Host testhost',
    '  HostName testhost.test.invalid',
    '  User tester',
    '',
    'Host secondhost',
    '  HostName second.test.invalid',
    '  User tester',
    ''
  ].join('\n')
);

const overrides = {
  sshExecutable: fakeSsh,
  userConfigPath: join(home, '.ssh', 'config'),
  homeDirectory: home
};

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // A fresh profile every run: a stale one carries favourites and directory history from
    // the last run, which is exactly the kind of hidden state that makes a suite pass alone
    // and fail in sequence.
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-gpu',
      '--no-sandbox',
      // Without this the window opens a modal asking whether the folder is trusted, and a
      // modal nobody can answer is indistinguishable from a hang.
      '--disable-workspace-trust'
    ],
    extensionTestsEnv: {
      REMOTE_SFTP_TEST_OVERRIDES: JSON.stringify(overrides),
      REMOTE_SFTP_FAKE_ROOT: remoteRoot
    }
  });
  console.log('\nExtension Host tests passed.');
} catch (error) {
  console.error('\nExtension Host tests failed.');
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
