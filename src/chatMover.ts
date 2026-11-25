/**
 * Moves running Claude Code chats to the active account. A Claude Code process keeps the account it started with, so
 * a switch only reaches new chats. To move a running chat, Switchboard waits until it is idle (its turn is complete)
 * and ends its process:
 * - a panel chat is restarted by the Claude Code extension with the next message, resuming the same conversation
 *   with the account its `claudeCode.environmentVariables` setting now names (the extension shows no error for a
 *   process that ends between turns);
 * - a terminal chat continues in a new terminal (`claude --resume <id>`).
 * Both rely on the accounts sharing their transcripts (`projects`), which Switchboard sets up for new accounts.
 */
import * as vscode from 'vscode';
import { endProcess, parseAgentsList, placeOf, processAlive, readRunningChats, sharesHistory, type RunningChat } from './chats';
import { runClaude } from './cli';
import { readSettings, type Switchboard, type SwitchEvent } from './switchboard';

/** How long a move waits for a busy chat to finish its turn. */
const WAIT_IDLE_MS = 30 * 60_000;
const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidate {
  chat: RunningChat;
  /** Label of the account it runs on. */
  from: string;
  /** The account folder as Claude Code sees it (undefined for the default account). */
  configDir: string | undefined;
}

export class ChatMover implements vscode.Disposable {
  private moving = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly sb: Switchboard,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subs.push(sb.onDidSwitch((e) => void this.afterSwitch(e).catch((err) => this.log.error(`After switching: ${err instanceof Error ? err.message : String(err)}`))));
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }

  private label(id: string): string {
    return this.sb.getProfile(id)?.label ?? 'another account';
  }

  /** Interactive panel and terminal chats on other accounts than the active one, read fresh from disk. */
  private async candidates(fromId?: string): Promise<{ movable: Candidate[]; unshared: string[] }> {
    const accounts = this.sb.accounts();
    const target = accounts.find((a) => a.id === this.sb.activeAccount().id);
    if (!target) return { movable: [], unshared: [] };
    const panelFollows = readSettings().applyToClaudeCodeExtension;
    const movable: Candidate[] = [];
    const unshared: string[] = [];
    for (const a of accounts) {
      if (a.id === target.id || (fromId && a.id !== fromId)) continue;
      const running = (await readRunningChats(a.configDir)).filter((c) => c.kind === 'interactive' && placeOf(c) !== 'other');
      if (!running.length) continue;
      if (!(await sharesHistory(a.configDir, target.configDir))) {
        unshared.push(a.label);
        continue;
      }
      for (const chat of running) {
        // Panel chats restart with whatever account Claude Code's extension setting names; that is only the active
        // account while Switchboard manages the setting.
        if (placeOf(chat) === 'panel' && !panelFollows) continue;
        movable.push({ chat, from: a.label, configDir: a.isDefault ? undefined : a.configDir });
      }
    }
    return { movable, unshared };
  }

  private async afterSwitch(e: SwitchEvent): Promise<void> {
    const settings = readSettings();
    const to = this.label(e.toId);
    const lead = e.source === 'auto' ? `Switched ${this.label(e.fromId)} → ${to} (${e.reason ?? 'limit reached'}).` : `Switched to ${to}.`;
    const { movable } = settings.moveChats === 'never' ? { movable: [] } : await this.candidates();

    if (movable.length && settings.moveChats === 'always') {
      const moved = await this.move(movable);
      if (e.source === 'manual' || settings.autoSwitch.notify) void vscode.window.showInformationMessage(`Switchboard: ${lead} ${this.summary(moved, to)}`);
      return;
    }
    if (movable.length) {
      const from = [...new Set(movable.map((c) => c.from))].join(', ');
      const n = movable.length;
      const button = n === 1 ? 'Move Chat' : `Move ${n} Chats`;
      const pick = await vscode.window.showInformationMessage(
        `Switchboard: ${lead} ${n === 1 ? 'A Claude Code chat still runs' : `${n} Claude Code chats still run`} on ${from}. Move ${n === 1 ? 'it' : 'them'} to ${to}? ${n === 1 ? 'It continues' : 'They continue'} the same conversation.`,
        button,
      );
      if (pick === button) {
        // The offer may have been open a while; move what runs on other accounts now.
        const now = this.sb.activeAccount().label;
        const moved = await this.move((await this.candidates()).movable);
        void vscode.window.showInformationMessage(`Switchboard: ${this.summary(moved, now)}`);
      }
      return;
    }
    if (e.source === 'auto' && settings.autoSwitch.notify) void vscode.window.showInformationMessage(`Switchboard: ${lead} New Claude Code chats use ${to}.`);
  }

  /** The command: moves the chats of one account (or of every other account) to the active one. */
  async moveChats(fromId?: string): Promise<void> {
    if (this.moving) {
      void vscode.window.showInformationMessage('Switchboard is already moving chats.');
      return;
    }
    const to = this.sb.activeAccount().label;
    if (fromId === this.sb.activeAccount().id) {
      void vscode.window.showInformationMessage(`Its chats already use ${to}, the active account.`);
      return;
    }
    const { movable, unshared } = await this.candidates(fromId);
    if (!movable.length) {
      void vscode.window.showInformationMessage(
        unshared.length
          ? `The chats on ${unshared.join(', ')} can't move to ${to}: the accounts don't share Claude Code's conversation history.`
          : `No Claude Code chats run on ${fromId ? this.label(fromId) : 'other accounts'}.`,
      );
      return;
    }
    const moved = await this.move(movable);
    void vscode.window.showInformationMessage(`Switchboard: ${this.summary(moved, to)}`);
  }

  private summary(moved: RunningChat[], to: string): string {
    if (!moved.length) return 'No chat was moved.';
    const terminal = moved.filter((c) => placeOf(c) === 'terminal').length;
    const panel = moved.length - terminal;
    const parts = [
      panel ? `${panel === moved.length ? (panel === 1 ? 'It' : 'They') : 'Panel chats'} continue there with your next message` : '',
      terminal ? `${terminal === moved.length ? (terminal === 1 ? 'It' : 'They') : 'Terminal chats'} continue in a new terminal` : '',
    ].filter(Boolean);
    return `Moved ${moved.length === 1 ? '1 chat' : `${moved.length} chats`} to ${to}. ${parts.join('; ')}.`;
  }

  /** Moves each chat once it is idle. Returns the chats that moved (with their current session). */
  private async move(list: Candidate[]): Promise<RunningChat[]> {
    const claude = await this.sb.claudeExecutable();
    if (!claude || this.moving) return [];
    this.moving = true;
    const target = this.sb.activeAccount().label;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Moving chats to ${target}`, cancellable: true },
        async (progress, token) => {
          const moved: RunningChat[] = [];
          for (const c of list) {
            if (token.isCancellationRequested) break;
            const chat = await this.whenIdle(c, claude, token, (m) => progress.report({ message: m }));
            if (!chat) continue;
            await endProcess(chat.pid);
            for (let i = 0; i < 50 && processAlive(chat.pid); i++) await sleep(100);
            if (processAlive(chat.pid)) {
              this.log.warn(`Could not end the Claude Code process ${chat.pid} of chat ${chat.sessionId}.`);
              continue;
            }
            this.log.info(`Moved chat ${chat.sessionId} (${placeOf(chat)}, process ${chat.pid}) to ${target}.`);
            if (placeOf(chat) === 'terminal') await this.sb.openTerminal(['--resume', chat.sessionId], chat.cwd);
            moved.push(chat);
          }
          return moved;
        },
      );
    } finally {
      this.moving = false;
      void this.sb.refresh(false);
    }
  }

  /**
   * Waits until the chat's process is idle, then confirms with `claude agents --json` that the process is still that
   * chat. Returns its current record (its session can change, e.g. after /clear), or undefined once it has ended.
   */
  private async whenIdle(c: Candidate, claude: string, token: vscode.CancellationToken, report: (m: string) => void): Promise<RunningChat | undefined> {
    const deadline = Date.now() + WAIT_IDLE_MS;
    const name = c.chat.name ? `"${c.chat.name}"` : 'a chat';
    let waiting = false;
    while (!token.isCancellationRequested && Date.now() < deadline) {
      const now = (await readRunningChats(c.chat.configDir)).find((x) => x.pid === c.chat.pid);
      if (!now) return undefined; // ended on its own
      if (now.status === 'idle') {
        const live = parseAgentsList((await runClaude(claude, ['agents', '--json'], c.configDir)).stdout).find((a) => a.pid === now.pid);
        if (live && live.sessionId === now.sessionId && live.status === 'idle') return now;
        if (!live) {
          this.log.warn(`Not moving chat ${now.sessionId}: \`claude agents\` does not list its process ${now.pid}.`);
          return undefined;
        }
      }
      if (!waiting) report(`waiting for ${name} to finish its turn…`);
      waiting = true;
      await sleep(POLL_MS);
    }
    if (!token.isCancellationRequested) this.log.warn(`Gave up waiting for chat ${c.chat.sessionId} to become idle.`);
    return undefined;
  }
}
