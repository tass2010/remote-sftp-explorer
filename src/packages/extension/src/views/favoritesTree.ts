import * as vscode from 'vscode';
import type {
  ConnectionStateModel,
  Favorite,
  FavoritesStore
} from '@remote-sftp-explorer/core';

export const FAVORITES_VIEW_ID = 'remoteSftp.favorites';

export class FavoriteTreeItem extends vscode.TreeItem {
  readonly favorite: Favorite;

  constructor(favorite: Favorite) {
    super(favorite.name, vscode.TreeItemCollapsibleState.None);
    this.favorite = favorite;
    this.contextValue = 'remoteSftp.favorite';
    this.description = favorite.path;
    this.tooltip = `${favorite.alias}:${favorite.path}`;
    this.iconPath = new vscode.ThemeIcon(favorite.type === 'directory' ? 'folder' : 'file');
    this.command = {
      command: 'remoteSftp.openFavorite',
      title: 'Open Favorite',
      arguments: [this]
    };
  }
}

/**
 * Saved locations, scoped to the connected host.
 *
 * A native TreeView, per the standing rule in ADR-0001: a webview is only justified where a
 * TreeView genuinely cannot express the interface, and a flat list of names is not that case.
 */
export class FavoritesTreeProvider
  implements vscode.TreeDataProvider<FavoriteTreeItem>, vscode.Disposable
{
  readonly #store: FavoritesStore;
  readonly #state: ConnectionStateModel;
  readonly #changed = new vscode.EventEmitter<FavoriteTreeItem | undefined>();

  readonly onDidChangeTreeData = this.#changed.event;

  constructor(store: FavoritesStore, state: ConnectionStateModel) {
    this.#store = store;
    this.#state = state;
    state.subscribe(() => this.#changed.fire(undefined));
  }

  getTreeItem(element: FavoriteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FavoriteTreeItem): FavoriteTreeItem[] {
    if (element !== undefined) return [];
    const alias = this.#state.alias;
    if (alias === undefined) return [];
    // Showing another host's favourites would offer paths that cannot be opened from here.
    return this.#store.forAlias(alias).map((favorite) => new FavoriteTreeItem(favorite));
  }

  refresh(): void {
    this.#changed.fire(undefined);
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
