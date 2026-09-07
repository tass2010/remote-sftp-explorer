import * as vscode from 'vscode';
import {
  describeHost,
  discoverHosts,
  validateHost,
  type CommandRunner,
  type ConnectionStateModel,
  type FileSystemPort,
  type Logger
} from '@remote-sftp-explorer/core';

export const HOSTS_VIEW_ID = 'remoteSftp.hosts';

export class HostTreeItem extends vscode.TreeItem {
  readonly alias: string;

  constructor(alias: string, description: string | undefined, usable: boolean, active: boolean) {
    super(alias, vscode.TreeItemCollapsibleState.None);
    this.alias = alias;
    this.contextValue = 'remoteSftp.host';
    if (description !== undefined) this.description = description;
    this.iconPath = new vscode.ThemeIcon(
      active ? 'vm-active' : usable ? 'vm' : 'warning',
      usable ? undefined : new vscode.ThemeColor('problemsWarningIcon.foreground')
    );
    if (!usable) {
      // An alias OpenSSH cannot resolve is shown greyed with the reason, rather than being
      // hidden or failing only when the user tries to connect.
      this.tooltip = description;
    }
    if (usable) {
      this.command = { command: 'remoteSftp.connect', title: 'Connect', arguments: [this] };
    }
  }
}

export interface HostsTreeOptions {
  fs: FileSystemPort;
  runner: CommandRunner;
  state: ConnectionStateModel;
  logger: Logger;
  sshExecutable: string;
  userConfigPath: string;
  systemConfigPath: string | undefined;
  homeDirectory: string;
}

/** Lists the hosts configured in the user's SSH config. */
export class HostsTreeProvider
  implements vscode.TreeDataProvider<HostTreeItem>, vscode.Disposable
{
  readonly #options: HostsTreeOptions;
  readonly #changed = new vscode.EventEmitter<HostTreeItem | undefined>();
  #items: HostTreeItem[] | undefined;

  readonly onDidChangeTreeData = this.#changed.event;

  constructor(options: HostsTreeOptions) {
    this.#options = options;
    // Connection state changes the active-host icon, so the view follows it.
    options.state.subscribe(() => this.#changed.fire(undefined));
  }

  getTreeItem(element: HostTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HostTreeItem): Promise<HostTreeItem[]> {
    if (element !== undefined) return [];
    if (this.#items === undefined) this.#items = await this.#load();
    return this.#items;
  }

  /** Re-read the SSH config. It is never watched; refreshing is explicit. */
  refresh(): void {
    this.#items = undefined;
    this.#changed.fire(undefined);
  }

  dispose(): void {
    this.#changed.dispose();
  }

  async #load(): Promise<HostTreeItem[]> {
    const activeAlias = this.#options.state.alias;
    let hosts;
    try {
      hosts = await discoverHosts({
        fs: this.#options.fs,
        userConfigPath: this.#options.userConfigPath,
        systemConfigPath: this.#options.systemConfigPath,
        homeDirectory: this.#options.homeDirectory
      });
    } catch (error) {
      this.#options.logger.error('Could not read the SSH configuration.', error);
      return [];
    }

    if (hosts.length === 0) {
      this.#options.logger.info('No concrete Host entries were found in the SSH configuration.');
      return [];
    }

    // Validate with ssh -G in parallel: it is the only trustworthy answer to whether an alias
    // resolves, and doing it here means an unusable host is visibly unusable.
    const validations = await Promise.all(
      hosts.map((host) =>
        validateHost(this.#options.runner, this.#options.sshExecutable, host.alias)
      )
    );

    return validations.map((result) =>
      result.ok
        ? new HostTreeItem(
            result.host.alias,
            describeHost(result.host),
            true,
            result.host.alias === activeAlias
          )
        : new HostTreeItem(result.failure.alias, result.failure.reason, false, false)
    );
  }
}
