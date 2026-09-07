import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import {
  ConnectionStateModel,
  DirectoryHistoryStore,
  FavoritesStore
} from '@remote-sftp-explorer/core';
import {
  MementoAdapter,
  NodeCommandRunner,
  NodeFileSystemPort,
  NodeProcessSpawner,
  OutputChannelLogger,
  VsCodePromptUi
} from './adapters/vscodeAdapters.ts';
import { SessionManager } from './sessionManager.ts';
import { RemoteFileSystemProvider } from './fs/remoteFileSystemProvider.ts';
import { REMOTE_SCHEME, remoteUri } from './fs/remoteUri.ts';
import type { HostTreeItem } from './views/hostsTree.ts';
import { HOSTS_VIEW_ID, HostsTreeProvider } from './views/hostsTree.ts';
import type {
  FavoriteTreeItem
} from './views/favoritesTree.ts';
import {
  FAVORITES_VIEW_ID,
  FavoritesTreeProvider
} from './views/favoritesTree.ts';
import { FILES_VIEW_ID, FilesWebviewProvider } from './views/filesWebview.ts';
import { ConnectionStatusBar } from './statusBar.ts';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Remote SFTP Explorer', { log: true });
  context.subscriptions.push(channel);
  const logger = new OutputChannelLogger(channel);

  // Platform gate. Enforced at runtime rather than through npm's os/cpu manifest fields,
  // which would block installing dev dependencies on a Linux development machine.
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    logger.error(`Unsupported platform: ${process.platform}-${process.arch}`);
    void vscode.window.showErrorMessage(
      'Remote SFTP Explorer currently supports only Windows 11 x64.'
    );
    return;
  }

  const state = new ConnectionStateModel();
  const globalState = new MementoAdapter(context.globalState);
  const favorites = new FavoritesStore(globalState);
  const history = new DirectoryHistoryStore(globalState);

  const sessions = new SessionManager({
    spawner: new NodeProcessSpawner(),
    prompts: new VsCodePromptUi(),
    logger,
    state,
    sshExecutable: resolveSshExecutable(),
    askpassExecutable: resolveAskpassExecutable(context, logger)
  });
  context.subscriptions.push(sessions);

  const fileSystem = new RemoteFileSystemProvider(sessions, logger);
  context.subscriptions.push(
    fileSystem,
    vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, fileSystem, {
      isCaseSensitive: true
    })
  );

  const hostsTree = new HostsTreeProvider({
    fs: new NodeFileSystemPort(),
    runner: new NodeCommandRunner(),
    state,
    logger,
    sshExecutable: resolveSshExecutable(),
    userConfigPath: path.join(os.homedir(), '.ssh', 'config'),
    systemConfigPath: resolveSystemConfigPath(),
    homeDirectory: os.homedir()
  });

  const favoritesTree = new FavoritesTreeProvider(favorites, state);

  const filesView = new FilesWebviewProvider({
    sessions,
    history,
    logger,
    clientScriptPath: context.asAbsolutePath(path.join('media', 'filesView.js')),
    clientStylePath: context.asAbsolutePath(path.join('media', 'filesView.css')),
    onAddFavorite: (entry) => {
      const alias = sessions.alias;
      if (alias === undefined) return;
      void favorites
        .add({ alias, path: entry.path, type: entry.type, name: entry.name })
        .then(() => favoritesTree.refresh());
    }
  });

  context.subscriptions.push(
    hostsTree,
    favoritesTree,
    filesView,
    new ConnectionStatusBar(state),
    vscode.window.registerTreeDataProvider(HOSTS_VIEW_ID, hostsTree),
    vscode.window.registerTreeDataProvider(FAVORITES_VIEW_ID, favoritesTree),
    vscode.window.registerWebviewViewProvider(FILES_VIEW_ID, filesView, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Keeps menu `when` clauses accurate.
  context.subscriptions.push(
    { dispose: state.subscribe((snapshot) => {
      void vscode.commands.executeCommand(
        'setContext',
        'remoteSftp.connected',
        snapshot.status === 'connected' || snapshot.status === 'reconnecting'
      );
    }) }
  );

  // Drop a document's cached baseline when its editor closes.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => fileSystem.release(document.uri))
  );

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('remoteSftp.refreshHosts', () => {
    hostsTree.refresh();
  });

  register('remoteSftp.connect', async (item?: HostTreeItem) => {
    const alias = item?.alias ?? (await pickHost(hostsTree));
    if (alias === undefined) return;

    // A tree item fires its command on every single click, so this handler has to be
    // idempotent rather than assuming one click means one connection.
    if (sessions.isConnecting(alias)) {
      // Already under way. SessionManager would coalesce the attempt anyway, but returning
      // here also avoids stacking a second progress notification over the first.
      filesView.reveal();
      return;
    }

    if (sessions.alias === alias) {
      // Connected already. Reveal the panel, but do not navigate: re-running the connect flow
      // used to send the browser back to the home directory, discarding wherever the user had
      // browsed to, which made an accidental second click destructive.
      filesView.reveal();
      return;
    }

    await runWithProgress(`Connecting to ${alias}`, async () => {
      const session = await sessions.connect(alias);
      hostsTree.refresh();
      filesView.reveal();
      await filesView.navigate(session.rootPath);
    });
  });

  register('remoteSftp.disconnect', async () => {
    await sessions.disconnect();
    hostsTree.refresh();
    favoritesTree.refresh();
  });

  register('remoteSftp.refreshFiles', async () => {
    await filesView.refresh();
  });

  register('remoteSftp.addFavorite', async () => {
    // Invoked from the palette: the browser's own context menu passes the entry directly.
    void vscode.window.showInformationMessage(
      'Right-click an entry in Remote Files to save it as a favourite.'
    );
  });

  register('remoteSftp.removeFavorite', async (item?: FavoriteTreeItem) => {
    if (item === undefined) return;
    await favorites.remove(item.favorite.alias, item.favorite.path);
    favoritesTree.refresh();
  });

  register('remoteSftp.openFavorite', async (item?: FavoriteTreeItem) => {
    if (item === undefined) return;
    const { alias, path: target, type } = item.favorite;
    await runWithProgress(`Opening ${target}`, async () => {
      await sessions.connect(alias);
      if (type === 'directory') {
        filesView.reveal();
        await filesView.navigate(target);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', remoteUri(alias, target), {
        preview: false
      });
    });
  });

  register('remoteSftp.clearHistory', async () => {
    const alias = sessions.alias;
    await history.clear(alias);
    await filesView.refresh();
  });

  logger.info('Remote SFTP Explorer activated.');
}

export function deactivate(): void {
  // Everything is registered as a subscription; VS Code disposes them for us.
}

async function pickHost(hostsTree: HostsTreeProvider): Promise<string | undefined> {
  const items = await hostsTree.getChildren();
  const usable = items.filter((item) => item.command !== undefined);
  if (usable.length === 0) {
    void vscode.window.showErrorMessage(
      'No usable SSH hosts were found in your configuration.'
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    usable.map((item) => ({ label: item.alias, description: String(item.description ?? '') })),
    { placeHolder: 'Select an SSH host' }
  );
  return picked?.label;
}

async function runWithProgress(title: string, work: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      work
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }
}

function resolveSshExecutable(): string {
  // Prefer the well-known location so a shadowed `ssh` on PATH cannot be picked up silently.
  const system = path.join(
    process.env['WINDIR'] ?? 'C:\\Windows',
    'System32',
    'OpenSSH',
    'ssh.exe'
  );
  return existsSync(system) ? system : 'ssh.exe';
}

function resolveSystemConfigPath(): string | undefined {
  const programData = process.env['ProgramData'];
  if (programData === undefined) return undefined;
  const candidate = path.join(programData, 'ssh', 'ssh_config');
  return existsSync(candidate) ? candidate : undefined;
}

function resolveAskpassExecutable(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger
): string | undefined {
  const candidate = context.asAbsolutePath(
    path.join('bin', 'win32-x64', 'remote-sftp-askpass.exe')
  );
  if (existsSync(candidate)) return candidate;
  // Without it only key and agent authentication can work, so say so plainly rather than
  // failing later with an opaque OpenSSH error.
  logger.warn(`The askpass helper was not found at ${candidate}.`);
  return undefined;
}
