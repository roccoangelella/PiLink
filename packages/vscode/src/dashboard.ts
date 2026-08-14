import crypto from "node:crypto";
import * as vscode from "vscode";
import type { DashboardState, WebviewCommandMessage } from "./protocol.js";
import { parseWebviewMessage } from "./protocol.js";

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private panel?: vscode.WebviewPanel;
  private refreshTimer?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly stateFactory: () => Promise<DashboardState>,
    private readonly commandHandler: (message: WebviewCommandMessage) => Promise<void>,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.configure(webviewView.webview);
    const disposable = webviewView.onDidDispose(() => this.detach(webviewView.webview));
    this.subscriptions.push(disposable);
  }

  openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "vspilink.dashboard",
      "VSPiLink",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.png");
    this.panel = panel;
    this.configure(panel.webview);
    const disposable = panel.onDidDispose(() => {
      this.detach(panel.webview);
      this.panel = undefined;
    });
    this.subscriptions.push(disposable);
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshNow().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
    this.panel?.dispose();
    this.webviews.clear();
  }

  private configure(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webview.html = this.html(webview);
    this.webviews.add(webview);
    const disposable = webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) {
        void vscode.window.showWarningMessage("VSPiLink ignored an invalid webview message.");
        return;
      }
      try {
        await this.commandHandler(message);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : "The VSPiLink command failed.");
      } finally {
        void this.refresh();
      }
    });
    this.subscriptions.push(disposable);
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.refresh(), 2_500);
      this.refreshTimer.unref();
    }
    void this.refresh();
  }

  private detach(webview: vscode.Webview): void {
    this.webviews.delete(webview);
    if (this.webviews.size === 0 && this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private async refreshNow(): Promise<void> {
    if (this.disposed || this.webviews.size === 0) return;
    const state = await this.stateFactory();
    const message = { type: "state", state };
    await Promise.all([...this.webviews].map(async (webview) => {
      try {
        await webview.postMessage(message);
      } catch {
        this.webviews.delete(webview);
      }
    }));
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "styles.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "logo.png"));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>PiLink · VSPiLink extension</title>
</head>
<body>
  <div id="app" data-logo-uri="${logoUri}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
