import * as vscode from 'vscode';

/**
 * Run work behind a notification, reporting failure to the user rather than the console.
 *
 * Shared by the connection commands and the file operations: both are user-initiated actions
 * whose failures are the user's to see, and an unhandled rejection in a command handler is
 * silent apart from a line in a log nobody has open.
 */
export async function runWithProgress(title: string, work: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      work
    );
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
