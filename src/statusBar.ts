import * as vscode from 'vscode';
import { pct, untilReset } from './format';
import { readSettings, type Switchboard, type WindowView } from './switchboard';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('switchboard.status', vscode.StatusBarAlignment.Right, 100);
  private readonly subs: vscode.Disposable[] = [];
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly sb: Switchboard) {
    this.item.name = 'Switchboard';
    this.item.command = 'switchboard.switchAccount';
    this.subs.push(
      sb.onDidChange(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('switchboard') && this.render()),
    );
    // Keep "resets in" times in the tooltip current.
    this.ticker = setInterval(() => this.render(), 60_000);
    this.render();
  }

  private render(): void {
    const settings = readSettings();
    if (!settings.statusBar) {
      this.item.hide();
      return;
    }
    const state = this.sb.getState();
    const active = state.accounts.find((a) => a.active);
    const zap = state.auto.enabled ? ' $(zap)' : '';
    if (!active) {
      this.item.text = '$(arrow-swap) Switchboard';
    } else if (active.loggedIn === false) {
      this.item.text = `$(arrow-swap) ${active.label}: not logged in${zap}`;
    } else {
      const usage = active.session || active.weekly ? ` 5h ${pct(active.session?.pct)} · 7d ${pct(active.weekly?.pct)}` : '';
      this.item.text = `$(arrow-swap) ${active.label}${usage}${zap}`;
    }

    const s = active?.session?.pct ?? 0;
    const w = active?.weekly?.pct ?? 0;
    const { sessionThreshold, weeklyThreshold } = settings.autoSwitch;
    this.item.backgroundColor =
      s >= sessionThreshold || w >= weeklyThreshold
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : s >= sessionThreshold - 15 || w >= weeklyThreshold - 15
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(
      `**Switchboard** · auto-switch ${state.auto.enabled ? `on at ${sessionThreshold}% session / ${weeklyThreshold}% weekly` : 'off'}\n\n`,
    );
    md.appendMarkdown('| | Account | 5h session | 7d weekly |\n|:-:|:--|--:|--:|\n');
    const cell = (v?: WindowView) => {
      const r = v && v.pct > 0 ? untilReset(v.resetsAt) : undefined;
      return `${pct(v?.pct)}${r ? ` (${r})` : ''}`;
    };
    for (const a of state.accounts) {
      const mark = a.active ? '$(circle-filled)' : a.loggedIn === false ? '$(circle-slash)' : '';
      const label = a.label.replace(/[|\\`*_[\]<>]/g, (c) => `\\${c}`);
      md.appendMarkdown(a.loggedIn === false ? `| ${mark} | ${label} | not logged in | |\n` : `| ${mark} | ${label} | ${cell(a.session)} | ${cell(a.weekly)} |\n`);
    }
    if (state.liveUsage !== 'on') md.appendMarkdown('\n$(info) Live usage is off, so numbers can lag behind.');
    md.appendMarkdown('\n\nClick to switch account');
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.subs.forEach((d) => d.dispose());
    this.item.dispose();
  }
}
