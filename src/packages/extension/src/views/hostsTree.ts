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

/** How many `ssh -G` probes may run at once. */
const VALIDATION_CONCURRENCY = 4;

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * Unbounded Promise.all would spawn one ssh process per configured host simultaneously.
 * Process creation is expensive on Windows, and a config with fifty hosts would start fifty
 * of them at once -- slower in total than a bounded queue, and hard on the machine.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Lists the hosts configured in the user's SSH config. */
export class HostsTreeProvider
  implements vscode.TreeDataProvider<HostTreeItem>, vscode.Disposable
{
  readonly #options: HostsTreeOptions;
  readonly #changed = new vscode.EventEmitter<HostTreeItem | undefined>();
  #items: HostTreeItem[] | undefined;
  #loading: Promise<HostTreeItem[]> | undefined;
  /**
   * Bumped by every refresh so a probe that started against an older list cannot publish its
   * answers over a newer one. Comparing list lengths is not enough: a refresh usually produces
   * a list of exactly the same length, which is precisely when stale results would be applied.
   */
  #generation = 0;
  #disposed = false;

  readonly onDidChangeTreeData = this.#changed.event;

  constructor(options: HostsTreeOptions) {
    this.#options = options;
    // Connection state changes the active-host icon, so the view follows it.
    options.state.subscribe(() => this.#changed.fire(undefined));
  }

  getTreeItem(element: HostTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Hosts appear as soon as the config has been parsed, which is only local file reads.
   *
   * Validation runs afterwards, in the background. It used to be awaited here, so nothing at
   * all was shown until every `ssh -G` had returned -- one process spawn per configured host,
   * and far worse than that if the config uses `Match exec`, which runs a command each time,
   * or canonicalisation, which does DNS lookups. The panel looked broken on first open for
   * what was really just a queue of subprocesses.
   */
  async getChildren(element?: HostTreeItem): Promise<HostTreeItem[]> {
    if (element !== undefined) return [];
    // One shared promise, so two near-simultaneous expansions parse the config once.
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<HostTreeItem[]> {
    const generation = this.#generation;
    const items = await this.#discover();
    if (generation !== this.#generation) return this.#items ?? [];
    this.#items = items;
    // Deliberately not awaited: the whole point is that the list draws before the probes run.
    void this.#validate(generation);
    return items;
  }

  /** Re-read the SSH config. It is never watched; refreshing is explicit. */
  refresh(): void {
    this.#generation += 1;
    this.#items = undefined;
    this.#loading = undefined;
    this.#changed.fire(undefined);
  }

  dispose(): void {
    this.#disposed = true;
    this.#changed.dispose();
  }

  /** The fast half: parse the config and show what it names. */
  async #discover(): Promise<HostTreeItem[]> {
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

    const activeAlias = this.#options.state.alias;
    // Usable until proven otherwise: someone who knows their host works should not have to
    // wait for a probe before they can click it. Connecting reports a real error if it fails.
    return hosts.map(
      (host) => new HostTreeItem(host.alias, undefined, true, host.alias === activeAlias)
    );
  }

  /** The slow half: ask OpenSSH to resolve each alias, then redraw once with the answers. */
  async #validate(generation: number): Promise<void> {
    const aliases = (this.#items ?? []).map((item) => item.alias);
    if (aliases.length === 0) return;

    const validations = await mapWithLimit(aliases, VALIDATION_CONCURRENCY, (alias) =>
      validateHost(this.#options.runner, this.#options.sshExecutable, alias)
    );
    // A refresh may have replaced the list, or the view may be gone, while probes were running.
    if (this.#disposed || generation !== this.#generation) return;

    const activeAlias = this.#options.state.alias;
    this.#items = validations.map((result) =>
      result.ok
        ? new HostTreeItem(
            result.host.alias,
            describeHost(result.host),
            true,
            result.host.alias === activeAlias
          )
        : new HostTreeItem(result.failure.alias, result.failure.reason, false, false)
    );
    // One redraw for the whole batch rather than one per host, which would make the list
    // visibly churn on a large config.
    this.#changed.fire(undefined);
  }
}
