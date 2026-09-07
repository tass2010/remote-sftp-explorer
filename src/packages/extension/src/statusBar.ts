import * as vscode from 'vscode';
import type { ConnectionSnapshot, ConnectionStateModel } from '@remote-sftp-explorer/core';

/** Reflects the connection state, so "reconnecting" is visible rather than silent. */
export class ConnectionStatusBar implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem;
  readonly #unsubscribe: () => void;

  constructor(state: ConnectionStateModel) {
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.#unsubscribe = state.subscribe((snapshot) => this.#render(snapshot));
  }

  dispose(): void {
    this.#unsubscribe();
    this.#item.dispose();
  }

  #render(snapshot: ConnectionSnapshot): void {
    const alias = snapshot.alias ?? '';
    this.#item.backgroundColor = undefined;
    this.#item.command = undefined;

    switch (snapshot.status) {
      case 'connecting':
        this.#item.text = `$(sync~spin) SFTP: connecting to ${alias}`;
        this.#item.tooltip = `Connecting to ${alias}…`;
        break;
      case 'connected':
        this.#item.text = `$(vm-active) SFTP: ${alias}`;
        this.#item.tooltip = `Connected to ${alias}`;
        this.#item.command = 'remoteSftp.disconnect';
        break;
      case 'reconnecting':
        this.#item.text = `$(sync~spin) SFTP: reconnecting to ${alias}`;
        this.#item.tooltip = `Connection to ${alias} lost${
          snapshot.detail === undefined ? '' : ` (${snapshot.detail})`
        }; reconnecting…`;
        this.#item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'disconnecting':
        this.#item.text = `$(sync~spin) SFTP: disconnecting`;
        this.#item.tooltip = `Disconnecting from ${alias}…`;
        break;
      case 'failed':
        this.#item.text = `$(error) SFTP: ${alias || 'failed'}`;
        this.#item.tooltip = snapshot.detail ?? 'The connection failed.';
        this.#item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.#item.command = 'remoteSftp.connect';
        break;
      case 'disconnected':
      default:
        // Nothing to say when there is no connection; the views are the entry point.
        this.#item.hide();
        return;
    }
    this.#item.show();
  }
}
