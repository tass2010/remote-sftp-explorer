/**
 * Manifest / source / documentation agreement.
 *
 * The previous implementation declared nine commands, of which one (`remoteSftp.refreshFolder`)
 * had a handler byte-identical to another, while eight commands named in the design document
 * were never registered anywhere. Each of those is caught here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const srcRoot = path.join(extensionRoot, 'src');

interface Manifest {
  capabilities?: {
    untrustedWorkspaces?: { supported?: boolean | string };
  };
  contributes: {
    configuration?: unknown;
    commands: Array<{ command: string; title: string }>;
    views: Record<string, Array<{ id: string; name: string; type?: string }>>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
  };
}

const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
) as Manifest;

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
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

function allSourceText(): string {
  return sourceFiles(srcRoot)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * During the rebuild the extension package is contributed-but-not-yet-implemented. A test
 * that is red for weeks trains people to ignore it, so the source-to-manifest checks stay
 * dormant until the first handler lands and then bite permanently.
 */
const hasExtensionSource = sourceFiles(srcRoot).length > 0;

/**
 * Command ids the source actually registers.
 *
 * Both the direct `vscode.commands.registerCommand('id', ...)` form and a local `register(
 * 'id', ...)` helper that wraps it count -- the point of this check is whether a handler
 * exists, not which spelling was used to attach it.
 */
function registeredCommandIds(text: string): string[] {
  const ids: string[] = [];
  const pattern = /\bregister(?:Command)?\s*\(\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

test('every contributed command is registered exactly once in source', { skip: !hasExtensionSource && 'extension sources not written yet (P8)' }, () => {
  const text = allSourceText();
  const registered = registeredCommandIds(text);
  for (const contributed of manifest.contributes.commands) {
    const occurrences = registered.filter((id) => id === contributed.command).length;
    assert.equal(
      occurrences,
      1,
      `${contributed.command} is contributed by package.json but registered ${occurrences} ` +
        'time(s) in src/. A contributed command with no handler fails at runtime with ' +
        '"command not found".'
    );
  }
});

test('every registered command is contributed by the manifest', { skip: !hasExtensionSource && 'extension sources not written yet (P8)' }, () => {
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const id of new Set(registeredCommandIds(allSourceText()))) {
    assert.ok(
      contributed.has(id),
      `${id} is registered in src/ but missing from contributes.commands, so it is invisible ` +
        'in the command palette and in menus.'
    );
  }
});

test('every menu entry references a contributed command', () => {
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      assert.ok(
        contributed.has(entry.command),
        `menus.${menu} references ${entry.command}, which is not in contributes.commands.`
      );
    }
  }
});

test('contributed commands have unique ids and titles', () => {
  const ids = manifest.contributes.commands.map((entry) => entry.command);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command id in contributes.commands');
  const titles = manifest.contributes.commands.map((entry) => entry.title);
  assert.equal(
    new Set(titles).size,
    titles.length,
    'two commands share a title; users cannot tell them apart in the command palette'
  );
});

test('the manifest ships the askpass binary directory', () => {
  // Regression guard: 0.2.0 shipped a `files` array of dist/** and resources/** only, so the
  // Rust SSH_ASKPASS helper could never have reached a user even once it was built.
  const files = (JSON.parse(
    readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
  ) as { files: string[] }).files;
  assert.ok(
    files.includes('bin/**'),
    'package.json "files" must include bin/** or the askpass helper is omitted from the VSIX'
  );
});

// ---------------------------------------------------------------------------
// Workspace Trust
// ---------------------------------------------------------------------------

test('the extension declares whether it runs in an untrusted workspace', () => {
  // Without this, VS Code disables the extension in Restricted Mode and the whole activity
  // bar icon disappears, with only a line in the Extensions view to explain why.
  const supported = manifest.capabilities?.untrustedWorkspaces?.supported;
  assert.notEqual(
    supported,
    undefined,
    'capabilities.untrustedWorkspaces is undeclared, so the extension silently disables itself ' +
      'whenever the open folder is not trusted'
  );
});

test('claiming untrusted-workspace support stays honest', () => {
  // The claim rests on one thing: nothing this extension reads can be influenced by the
  // folder that happens to be open. Every input comes from the user's home directory or the
  // system. These checks fail if that stops being true, because at that point the claim would
  // be an invitation rather than a statement of fact.
  if (manifest.capabilities?.untrustedWorkspaces?.supported !== true) return;

  assert.equal(
    manifest.contributes.configuration,
    undefined,
    'A settings contribution can be overridden by workspace settings, and a workspace is ' +
      'exactly what an untrusted workspace is. Adding one -- an ssh executable path, say -- ' +
      'means switching to "limited" and listing it under restrictedConfigurations.'
  );

  const source = allSourceText();
  for (const api of [
    'getConfiguration',
    'workspaceFolders',
    'workspace.fs',
    'workspace.findFiles',
    'asRelativePath'
  ]) {
    assert.ok(
      !source.includes(api),
      `src/ uses ${api}, so the workspace can now influence this extension. Re-examine the ` +
        'untrustedWorkspaces claim before keeping it.'
    );
  }
});
