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

export interface TransferProgressContext {
  /** Replace the notification's detail line. */
  report(message: string, percent: number): void;
  /** Aborts when the user presses Cancel. */
  signal: AbortSignal;
}

export type TransferOutcome = 'done' | 'cancelled' | 'failed';

/**
 * Run a transfer behind a cancellable notification.
 *
 * Cancellable is the point. A transfer can be large, the link can be slow, and the stall
 * guard only fires when nothing at all is moving -- so the case left over is a transfer that
 * is working but too slow to be worth waiting for. Only the person watching can judge that,
 * and they need a button to act on it.
 */
export async function runTransferWithProgress(
  title: string,
  work: (context: TransferProgressContext) => Promise<void>
): Promise<TransferOutcome> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      // VS Code takes an increment since the last report, not a total, so the last value has
      // to be remembered here or the bar advances by the whole percentage every time.
      let reported = 0;

      try {
        await work({
          signal: controller.signal,
          report: (message, percent) => {
            const bounded = Math.max(0, Math.min(100, percent));
            progress.report({ message, increment: bounded - reported });
            reported = bounded;
          }
        });
        return 'done';
      } catch (error) {
        if (token.isCancellationRequested) return 'cancelled';
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        return 'failed';
      } finally {
        subscription.dispose();
      }
    }
  );
}
