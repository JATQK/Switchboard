import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { Switchboard } from './switchboard';

type Message = { type: string; id?: string };

/** Webview actions → commands. Account actions receive the card's account id. */
const ACTIONS: Record<string, string> = {
  switch: 'switchboard.switchAccount',
  login: 'switchboard.login',
  loginNew: 'switchboard.loginNew',
  add: 'switchboard.addAccount',
  toggleAuto: 'switchboard.toggleAutoSwitch',
  liveOn: 'switchboard.enableLiveUsage',
  liveDismiss: 'switchboard.dismissLiveUsage',
  refresh: 'switchboard.refresh',
  terminal: 'switchboard.openTerminal',
  moveChats: 'switchboard.moveChats',
  settings: 'switchboard.openSettings',
  log: 'switchboard.showLog',
};

export class SwitchboardPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'switchboard.panel';
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sb: Switchboard,
  ) {
    this.subs.push(sb.onDidChange(() => this.post()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.subs.push(
      view.webview.onDidReceiveMessage((m: Message) => {
        if (m.type === 'ready') return this.post();
        const command = ACTIONS[m.type];
        if (command) void vscode.commands.executeCommand(command, ...(m.id ? [m.id] : []));
      }),
      view.onDidChangeVisibility(() => view.visible && this.post()),
      view.onDidDispose(() => (this.view = undefined)),
    );
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.sb.getState() });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Switchboard</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<header class="auto" id="auto"></header>
<div id="banner"></div>
<main id="list" aria-live="polite"></main>
<footer id="footer"></footer>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }
}
