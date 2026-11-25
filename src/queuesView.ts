/**
 * Queues in VS Code: the "Queues" view, and starting or attaching the real Claude Code chats (panel or terminal) that
 * work through them. Keeps Switchboard's Stop hook in Claude Code's settings exactly while some queue needs it.
 * The file layout and the hook are in queues.ts.
 */
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { insertIntoChat, newChat, openSession } from './claudeCode';
import { processAlive } from './chats';
import { claudeTerminalOptions, runClaude } from './cli';
import { formatAgo } from './format';
import { tryReadJson } from './fsutil';
import { Mutex } from './mutex';
import { pathKey } from './paths';
import * as Q from './queues';
import { settingsFiles } from './statusline';
import type { Switchboard } from './switchboard';
import { readSession, sessionFiles } from './transcripts';

const CONSENT_KEY = 'switchboard.queueHookConsent';
const KINDS_KEY = 'switchboard.chatKinds';
const START_KEY = 'switchboard.lastStart';
const PENDING_TIMEOUT_MS = 30 * 60_000;
/** Longer first tasks go to a terminal chat as a file reference (Windows command lines are limited). */
const MAX_ARG_TASK = 6000;

type Kind = 'panel' | 'terminal';

interface ChatInfo {
  sessionId: string;
  title: string;
  kind?: Kind;
  /** 'busy', 'idle', or undefined when not running. */
  status?: string;
  follows: { id: string; name: string }[];
  paused: boolean;
  current?: { queueId: string; queueName: string; text: string };
  /** Tasks waiting in the queues it follows. */
  waiting: number;
  /** Its hook is waiting in the background to hand it the next task (so it needs no nudge). */
  waiter: boolean;
}

const firstLine = (s: string, max = 70) => {
  const l = s.trim().split(/\r?\n/)[0];
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

export class Queues implements vscode.Disposable {
  private work: Q.WorkState = { queues: [], chats: [], pending: [] };
  private readonly live = new Map<string, Q.LiveChat>();
  private liveCheckedAt = 0;
  private readonly titles = new Map<string, string>();
  private readonly guesses = new Map<string, { title: string; at: number }>();
  private readonly detectedKinds = new Map<string, Kind>();
  private readonly transcriptFiles = new Map<string, string>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  /** Chats whose hook waits in the background for their next task (session id → process id). */
  private waiters = new Map<string, number>();
  private readonly lock = new Mutex();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  /** Queues that had unfinished tasks at the last refresh (to say when one is through). */
  private unfinished = new Set<string>();
  private readonly subs: vscode.Disposable[] = [];
  /** Set by the view: polls more often while it is visible. */
  viewVisible: () => boolean = () => false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly sb: Switchboard,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subs.push(
      this.changed,
      vscode.window.onDidCloseTerminal((t) => {
        for (const [sid, term] of this.terminals) if (term === t) this.terminals.delete(sid);
        void this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.changed.fire()),
    );
  }

  get cwd(): string | undefined {
    const f = vscode.workspace.workspaceFolders?.[0];
    return f?.uri.scheme === 'file' ? f.uri.fsPath : undefined;
  }

  unavailableReason(): string | undefined {
    if (!this.cwd) return 'Open a folder: queues are worked through by Claude Code chats running in it.';
    if (!vscode.workspace.isTrusted) return 'Queues start and steer Claude Code chats in this folder, so they need a trusted workspace.';
    return undefined;
  }

  private usable(): boolean {
    const reason = this.unavailableReason();
    if (reason) void vscode.window.showWarningMessage(`Switchboard: ${reason}`);
    return !reason;
  }

  async start(): Promise<void> {
    await Q.ensureHookScript().catch(() => undefined); // keep an installed hook's script current after an update
    try {
      const moved = await Q.migrateLegacyChatQueues(await settingsFiles(this.sb.configDirs()));
      if (moved) this.log.info(`Queues: carried over ${moved} task${moved === 1 ? '' : 's'} queued for chats by the earlier version`);
    } catch (err) {
      this.log.warn(`Queues: could not carry over the earlier chat queues: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh();
  }

  // ------------------------------------------------------------ state

  get state(): Q.WorkState {
    return this.work;
  }

  /** Re-reads the queues, ties started panel chats to their queues, keeps the hook in sync, and schedules the next look. */
  async refresh(): Promise<void> {
    await this.lock.run(async () => {
      this.work = await Q.readWork();
      this.waiters = new Map([...(await Q.readWaiters())].filter(([, pid]) => processAlive(pid)));
      if (this.work.pending.length) await this.bindStartedChats();
      if (this.work.chats.length && Date.now() - this.liveCheckedAt > (this.viewVisible() ? 10_000 : 60_000)) await this.checkLive();
      await this.syncHook();
      this.announceFinished();
      if (this.timer) clearTimeout(this.timer);
      const active = this.work.pending.length > 0 || this.work.queues.some((q) => q.tasks.some((t) => t.state !== 'done'));
      this.timer = setTimeout(() => void this.refresh(), active ? 2000 : this.work.chats.length ? 15_000 : 60_000);
    });
    this.changed.fire();
  }

  private kinds(): Record<string, Kind> {
    return this.memento.get<Record<string, Kind>>(KINDS_KEY, {});
  }

  private async rememberKind(sid: string, kind: Kind): Promise<void> {
    await this.memento.update(KINDS_KEY, { ...this.kinds(), [sid]: kind });
  }

  /** Panel chats Switchboard opened carry their start token in the first message: find them (the hook does too). */
  private async bindStartedChats(): Promise<void> {
    const cwd = this.cwd;
    if (!cwd) return;
    const files = await sessionFiles(this.sb.configDirs(), cwd);
    for (const p of this.work.pending) {
      if (Date.now() - p.createdAt > PENDING_TIMEOUT_MS) {
        await Q.cancelPendingStart(p.token);
        this.log.info(`Queues: a chat opened for ${p.token} never started; its task is waiting again`);
        continue;
      }
      for (const f of files.filter((x) => x.mtimeMs >= p.createdAt - 5000 && !this.work.chats.some((c) => c.sessionId === x.sessionId.toLowerCase()))) {
        const s = await readSession(f.file).catch(() => undefined);
        if (!s?.prompts[0]?.includes(p.token)) continue;
        if (await Q.bindPendingStart(p.token, f.sessionId)) {
          await this.rememberKind(f.sessionId.toLowerCase(), 'panel');
          this.log.info(`Queues: chat ${f.sessionId} started for ${p.token}`);
        }
        break;
      }
    }
    this.work = await Q.readWork();
  }

  /** Interactive Claude Code chats across all accounts (each account keeps its own list of running sessions). */
  private async checkLive(): Promise<Q.LiveChat[]> {
    this.liveCheckedAt = Date.now();
    const claude = await this.sb.claudeExecutable();
    if (!claude) return [];
    const all: Q.LiveChat[] = [];
    for (const dir of this.sb.configDirs()) all.push(...Q.parseAgents((await runClaude(claude, ['agents', '--json'], dir)).stdout));
    this.live.clear();
    for (const c of all) this.live.set(c.sessionId, c);
    return all;
  }

  /** The hook is in Claude Code's settings exactly while a queue needs it (and always in its current version). */
  private async syncHook(): Promise<void> {
    const files = await settingsFiles(this.sb.configDirs());
    try {
      const legacy = await Q.removeLegacyHook(files);
      if (legacy.length) this.log.info(`Queues: removed the earlier build's hook from ${legacy.join(', ')}`);
    } catch {
      // not valid JSON: leave it
    }
    const current = await Q.filesWithHook(files);
    const withHook = await Q.filesWithHook(files, true);
    try {
      if (Q.hookNeeded(this.work) && current.length < files.length) {
        const { changed, failed } = await Q.installHook(files);
        if (changed.length) this.log.info(`Queues: Stop hook added to ${changed.join(', ')}`);
        if (failed.length) void vscode.window.showWarningMessage(`Switchboard could not add its queue hook to ${failed.join(', ')} (not valid JSON).`);
      } else if (!Q.hookNeeded(this.work) && withHook.length) {
        const changed = await Q.removeHook(withHook);
        if (changed.length) this.log.info(`Queues: Stop hook removed from ${changed.join(', ')}`);
      }
    } catch (err) {
      this.log.warn(`Queues: could not update Claude Code settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private announceFinished(): void {
    const now = new Set(this.work.queues.filter((q) => q.tasks.some((t) => t.state !== 'done')).map((q) => q.id));
    for (const id of this.unfinished) {
      const q = this.work.queues.find((x) => x.id === id);
      if (!q || now.has(id) || !q.tasks.length) continue;
      void vscode.window.showInformationMessage(`Switchboard: queue "${q.name}" is through, ${q.tasks.length} task${q.tasks.length === 1 ? '' : 's'} done.`, 'Copy Results').then((p) => p && this.copyResults(id));
    }
    this.unfinished = now;
  }

  private queueName(id: string): string {
    return this.work.queues.find((q) => q.id === id)?.name ?? 'queue';
  }

  /** A chat's title: its name in Claude Code, else its latest prompt. Transcripts are re-read at most every 20 s. */
  private async title(sid: string): Promise<string> {
    const cached = this.titles.get(sid);
    if (cached) return cached;
    const guess = this.guesses.get(sid);
    if (guess && Date.now() - guess.at < 20_000) return guess.title;
    const file = await this.transcript(sid);
    const s = file ? await readSession(file).catch(() => undefined) : undefined;
    // Claude Code may name a chat after the start marker in its first message: that name says nothing.
    if (s?.title && !/sb-[a-f0-9]{10}|switchboard queue/i.test(s.title)) {
      this.titles.set(sid, s.title);
      return s.title;
    }
    const prompt = s?.prompts[0] && Q.withoutMarker(s.prompts[0]);
    const title = prompt ? firstLine(prompt, 60) : this.live.get(sid)?.name ?? `Chat ${sid.slice(0, 8)}`;
    this.guesses.set(sid, { title, at: Date.now() });
    return title;
  }

  private async transcript(sid: string): Promise<string | undefined> {
    const known = this.transcriptFiles.get(sid);
    if (known) return known;
    for (const dir of this.sb.configDirs()) {
      const projects = path.join(dir, 'projects');
      for (const f of await fs.readdir(projects).catch(() => [] as string[])) {
        const file = path.join(projects, f, `${sid}.jsonl`);
        if (await fs.stat(file).then(() => true, () => false)) {
          this.transcriptFiles.set(sid, file);
          return file;
        }
      }
    }
    return undefined;
  }

  /** Where a chat runs: known for chats Switchboard started, else from the transcript's entry point (read once). */
  private async kindOf(sid: string): Promise<Kind | undefined> {
    const known = this.kinds()[sid] ?? this.detectedKinds.get(sid);
    if (known) return known;
    const file = await this.transcript(sid);
    if (!file) return undefined;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const kind: Kind | undefined = /"entrypoint":"claude-vscode"/.test(text) ? 'panel' : /"entrypoint":"/.test(text) ? 'terminal' : undefined;
    if (kind) this.detectedKinds.set(sid, kind);
    return kind;
  }

  /** Everything the view shows about the chats that follow queues. */
  async chatInfos(): Promise<ChatInfo[]> {
    const out: ChatInfo[] = [];
    for (const c of this.work.chats) {
      const running = this.work.queues.flatMap((q) => q.tasks.filter((t) => t.state === 'running' && t.chat === c.sessionId).map((t) => ({ q, t })))[0];
      out.push({
        sessionId: c.sessionId,
        title: await this.title(c.sessionId),
        kind: await this.kindOf(c.sessionId),
        status: this.live.get(c.sessionId)?.status ?? (this.terminals.has(c.sessionId) ? 'busy' : undefined),
        follows: c.follows.map((id) => ({ id, name: this.queueName(id) })),
        paused: c.paused,
        current: running ? { queueId: running.q.id, queueName: running.q.name, text: running.t.text } : undefined,
        waiting: this.work.queues.filter((q) => c.follows.includes(q.id)).reduce((n, q) => n + q.tasks.filter((t) => t.state === 'waiting').length, 0),
        waiter: this.waiters.has(c.sessionId),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ queues and tasks

  async newQueue(name?: string): Promise<string | undefined> {
    const n = name ?? (await vscode.window.showInputBox({ title: 'New queue', prompt: 'Name', placeHolder: 'e.g. Refactor auth', validateInput: (v) => (v.trim() ? undefined : 'Give the queue a name') }));
    if (!n?.trim()) return undefined;
    const id = await Q.createQueue(n);
    await this.refresh();
    return id;
  }

  async renameQueue(id: string): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Rename queue', value: this.queueName(id), validateInput: (v) => (v.trim() ? undefined : 'Name cannot be empty') });
    if (name?.trim()) await Q.renameQueue(id, name);
    await this.refresh();
  }

  async deleteQueue(id: string): Promise<void> {
    const q = this.work.queues.find((x) => x.id === id);
    if (!q) return;
    if (q.tasks.some((t) => t.state === 'running' || t.state === 'starting')) {
      void vscode.window.showWarningMessage(`A chat is working on a task of "${q.name}". Wait for it, or stop the chat from following the queue, then delete it.`);
      return;
    }
    if (q.tasks.length) {
      const ok = await vscode.window.showWarningMessage(`Delete the queue "${q.name}" and its ${q.tasks.length} task${q.tasks.length === 1 ? '' : 's'}?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
    }
    await Q.deleteQueue(id);
    await this.refresh();
  }

  /** Picks a queue (or makes one). */
  async pickQueue(title: string): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { id?: string };
    const items: Item[] = this.work.queues.map((q) => ({ label: q.name, description: this.summary(q), id: q.id }));
    items.push({ label: '$(add) New queue…' });
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title });
    if (!pick) return undefined;
    return pick.id ?? this.newQueue();
  }

  summary(q: Q.Queue): string {
    const n = (s: Q.TaskState) => q.tasks.filter((t) => t.state === s).length;
    const parts = [`${n('waiting')} waiting`, n('running') + n('starting') ? `${n('running') + n('starting')} running` : '', n('done') ? `${n('done')} done` : ''];
    return parts.filter(Boolean).join(' · ');
  }

  async addTask(queueId: string | undefined, text: string): Promise<boolean> {
    if (!this.usable() || !text.trim()) return false;
    const id = queueId ?? (await this.pickQueue('Add the task to which queue?'));
    if (!id) return false;
    await Q.addTask(id, text);
    await this.refresh();
    const followers = this.work.chats.filter((c) => c.follows.includes(id) && !c.paused);
    if (!followers.length) {
      void vscode.window.setStatusBarMessage(`$(list-ordered) Added to "${this.queueName(id)}". Start a chat or add one to work on it.`, 5000);
    }
    return true;
  }

  async editTask(queueId: string, key: string, text: string): Promise<void> {
    await Q.editTask(queueId, key, text);
    await this.refresh();
  }

  async removeTask(queueId: string, key: string): Promise<void> {
    await Q.removeTask(queueId, key);
    await this.refresh();
  }

  async moveTask(queueId: string, key: string, delta: number): Promise<void> {
    await Q.moveTask(queueId, key, delta);
    await this.refresh();
  }

  async requeue(queueId: string, key: string): Promise<void> {
    const t = this.work.queues.find((q) => q.id === queueId)?.tasks.find((x) => x.key === key);
    if (t?.state === 'starting') {
      const p = this.work.pending.find((x) => x.token === t.chat);
      if (p) await Q.cancelPendingStart(p.token);
    } else if (t?.state === 'running' && t.chat && this.live.get(t.chat)?.status === 'busy') {
      const ok = await vscode.window.showWarningMessage('A chat is still working on this task. Put it back in line anyway?', { modal: true }, 'Put Back');
      if (ok !== 'Put Back') return;
    }
    await Q.requeueTask(queueId, key);
    await this.refresh();
  }

  async clearDone(queueId: string): Promise<void> {
    await Q.clearDone(queueId);
    await this.refresh();
  }

  async copyResults(queueId: string): Promise<void> {
    const q = this.work.queues.find((x) => x.id === queueId);
    const done = q?.tasks.filter((t) => t.state === 'done') ?? [];
    if (!q || !done.length) {
      void vscode.window.showInformationMessage('Switchboard: no finished tasks to copy yet.');
      return;
    }
    const md = [`# ${q.name}`, ...(await Promise.all(done.map(async (t, i) => `## ${i + 1}. ${firstLine(t.text, 120)}\n\n_${t.chat ? await this.title(t.chat) : 'chat'}_\n\n${t.result ?? '(no answer recorded)'}`)))].join('\n\n');
    await vscode.env.clipboard.writeText(md);
    void vscode.window.setStatusBarMessage('$(check) Queue results copied', 3000);
  }

  async copyResult(queueId: string, key: string): Promise<void> {
    const t = this.work.queues.find((q) => q.id === queueId)?.tasks.find((x) => x.key === key);
    if (!t?.result) return;
    await vscode.env.clipboard.writeText(t.result);
    void vscode.window.setStatusBarMessage('$(check) Result copied', 3000);
  }

  async showResult(queueId: string, key: string): Promise<void> {
    const t = this.work.queues.find((q) => q.id === queueId)?.tasks.find((x) => x.key === key);
    if (!t) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `> ${t.text.replace(/\r?\n/g, '\n> ')}\n\n${t.result ?? '_(no answer recorded)_'}\n` });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  // ------------------------------------------------------------ chats

  private async consent(): Promise<boolean> {
    if (this.memento.get(CONSENT_KEY, false)) return true;
    const ok = await vscode.window.showInformationMessage(
      'Let Claude Code chats work through your queues?',
      {
        modal: true,
        detail:
          "While you use queues, Switchboard adds a Stop hook to Claude Code's settings. It runs in the background after each turn: in a chat that follows a queue, it marks the task done, waits until the chat is idle and a task is waiting, and then hands Claude that task, so the chat keeps going without you. In other chats it only waits (for half an hour) in case you add them to a queue. Switchboard removes the hook when no queue needs it.",
      },
      'Continue',
    );
    if (ok !== 'Continue') return false;
    await this.memento.update(CONSENT_KEY, true);
    return true;
  }

  /**
   * Starts new chats that work through a queue: in the Claude Code panel (one Enter each) or in terminals (on their own).
   * Without a preset, asks where, how many, and (for terminals) model and permission mode.
   */
  async startChats(queueId?: string, preset?: { where: Kind; count: number; model?: string; mode?: string }): Promise<void> {
    if (preset) {
      if (!this.usable() || !queueId || !(await this.consent())) return;
      return this.launch(queueId, preset.where, preset.count, [...(preset.model ? ['--model', preset.model] : []), ...(preset.mode ? ['--permission-mode', preset.mode] : [])]);
    }
    if (!this.usable()) return;
    const id = queueId ?? (await this.pickQueue('Start chats for which queue?'));
    const q = id ? this.work.queues.find((x) => x.id === id) : undefined;
    if (!id || !q) return;
    const waiting = q.tasks.filter((t) => t.state === 'waiting').length;
    if (!waiting) {
      void vscode.window.showInformationMessage(`"${q.name}" has no waiting tasks. Add some first.`);
      return;
    }
    const last = this.memento.get<{ where?: Kind; model?: string; mode?: string }>(START_KEY, {});
    const where = await vscode.window.showQuickPick(
      [
        { label: '$(terminal) Claude Code in an editor tab', description: 'fully automatic', detail: 'Each chat opens as a tab running Claude Code (with the active account), starts on its first task and keeps going on its own.', place: 'terminal' as const },
        { label: '$(comment-discussion) Claude Code panel', description: 'press Enter once', detail: "Each chat opens with its first task in the message box. Claude Code doesn't let extensions send panel messages, so press Enter there once; after that it keeps going on its own.", place: 'panel' as const },
      ].sort((a) => (a.place === last.where ? -1 : 0)),
      { title: `Start chats for "${q.name}"` },
    );
    if (!where) return;
    const counts = [1, 2, 3, 4, 5].filter((n) => n <= waiting);
    const count = await vscode.window.showQuickPick(
      counts.map((n) => ({ label: String(n), description: n === 1 ? 'one chat works through the tasks' : `${n} chats share the tasks`, n })),
      { title: `How many chats? (${waiting} task${waiting === 1 ? '' : 's'} waiting)` },
    );
    if (!count) return;
    let args: string[] = [];
    if (where.place === 'terminal') {
      const model = await vscode.window.showQuickPick(
        [{ label: 'Claude Code default', value: '' }, { label: 'opus', value: 'opus' }, { label: 'sonnet', value: 'sonnet' }, { label: 'haiku', value: 'haiku' }].sort((a) => (a.value === last.model ? -1 : 0)),
        { title: 'Model for the new chats', placeHolder: 'You can change it in each chat with /model' },
      );
      if (!model) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Claude Code default', value: '' },
          { label: 'acceptEdits', description: 'edits without asking', value: 'acceptEdits' },
          { label: 'auto', description: 'Claude Code checks risky tool calls', value: 'auto' },
          { label: 'plan', description: 'read and plan only', value: 'plan' },
          { label: 'manual', description: 'ask before changes', value: 'manual' },
        ].sort((a) => (a.value === last.mode ? -1 : 0)),
        { title: 'Permission mode for the new chats', placeHolder: 'Shift+Tab changes it in a chat' },
      );
      if (!mode) return;
      args = [...(model.value ? ['--model', model.value] : []), ...(mode.value ? ['--permission-mode', mode.value] : [])];
      await this.memento.update(START_KEY, { where: where.place, model: model.value, mode: mode.value });
    } else {
      await this.memento.update(START_KEY, { ...last, where: where.place });
    }
    if (!(await this.consent())) return;
    await this.launch(id, where.place, count.n, args);
  }

  /** Opens `count` chats for a queue, each with its own first task (claimed up front, so chats never share one). */
  private async launch(id: string, where: Kind, count: number, args: string[]): Promise<void> {
    const q = this.work.queues.find((x) => x.id === id);
    if (!q) return;
    const claude = where === 'terminal' ? await this.sb.claudeExecutable() : undefined;
    if (where === 'terminal' && !claude) return;
    if (where === 'terminal' && count > 1 && !(await this.terminalSetUp())) {
      // Every new terminal chat would stop at the same first-run questions: start one, let the user answer them there.
      const ok = await vscode.window.showInformationMessage(
        'Claude Code asks a few setup questions (such as a color theme) the first time it runs in a terminal for this account.',
        { modal: true, detail: 'Switchboard starts one terminal chat now. Answer the questions there; the chat then starts on its first task. Start more chats once that is done.' },
        'Start One Chat',
      );
      if (ok !== 'Start One Chat') return;
      count = 1;
    }
    let opened = 0;
    for (let i = 0; i < count; i++) {
      if (where === 'terminal') {
        const sid = randomUUID();
        const task = await Q.claimNext([id], sid);
        if (!task) break;
        await Q.setFollows(sid, [id]);
        await this.rememberKind(sid, 'terminal');
        const file = path.join(Q.workRoot(), 'queues', id, `${task.key}.${sid}.run`);
        const prompt = task.text.length > MAX_ARG_TASK ? `Do the task described in this file: ${file}` : task.text;
        const account = this.sb.activeAccount();
        const term = vscode.window.createTerminal({
          ...claudeTerminalOptions(claude!, ['--session-id', sid, ...args, prompt], account.configDir, `Claude · ${q.name} ${i + 1}`),
          location: { viewColumn: vscode.ViewColumn.Active, preserveFocus: i > 0 },
        });
        this.terminals.set(sid, term);
      } else {
        const token = Q.newStartToken();
        const task = await Q.claimNext([id], token);
        if (!task) break;
        await Q.addPendingStart(token, [id]);
        await newChat(`${task.text}\n\n${Q.startMarker(q.name, token)}`);
      }
      opened++;
    }
    await this.refresh();
    if (where === 'panel' && opened) {
      void vscode.window.showInformationMessage(
        `Opened ${opened} Claude Code chat${opened === 1 ? '' : 's'} with ${opened === 1 ? 'its' : 'their'} first task in the message box. Press Enter there once (pick the model and permissions first if you like): the chat then works through "${q.name}" on its own, and picks up tasks you add later.`,
      );
    }
  }

  /** Whether Claude Code's terminal first-run setup is done for the active account (else it asks before starting). */
  private async terminalSetUp(): Promise<boolean> {
    const dir = this.sb.activeAccount().configDir;
    const file = dir ? path.join(dir, '.claude.json') : process.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(process.env.CLAUDE_CONFIG_DIR.trim(), '.claude.json') : path.join(os.homedir(), '.claude.json');
    return (await tryReadJson(file))?.hasCompletedOnboarding === true;
  }

  /** Lets a chat that is already running follow a queue. */
  async attachChat(queueId?: string): Promise<void> {
    if (!this.usable()) return;
    const id = queueId ?? (await this.pickQueue('Which queue should the chat work on?'));
    if (!id) return;
    const cwd = this.cwd!;
    const live = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for Claude Code chats…' }, () => this.checkLive());
    const here = live.filter((c) => pathKey(c.cwd) === pathKey(cwd));
    if (!here.length) {
      void vscode.window.showInformationMessage('No Claude Code chat is running in this folder. Start one, or use "Start chats…".');
      return;
    }
    const items = await Promise.all(
      here.map(async (c) => {
        const f = this.work.chats.find((x) => x.sessionId === c.sessionId);
        return {
          label: await this.title(c.sessionId),
          description: [c.status === 'busy' ? 'working' : c.status === 'idle' ? 'waiting for you' : c.status, f?.follows.length ? `follows ${f.follows.map((x) => this.queueName(x)).join(' → ')}` : ''].filter(Boolean).join(' · '),
          detail: c.sessionId,
          chat: c,
          follows: f?.follows ?? [],
        };
      }),
    );
    const pick = await vscode.window.showQuickPick(items, { title: `Which chat should work on "${this.queueName(id)}"?`, matchOnDetail: true });
    if (!pick || !(await this.consent())) return;
    await Q.setFollows(pick.chat.sessionId, [...pick.follows.filter((x) => x !== id), id]);
    await this.refresh();
    if (pick.chat.status === 'idle' && this.waiters.has(pick.chat.sessionId)) {
      void vscode.window.setStatusBarMessage(`$(check) "${pick.label}" follows "${this.queueName(id)}" and starts on its next task`, 4000);
    } else if (pick.chat.status === 'idle') {
      const p = await vscode.window.showInformationMessage(
        `"${pick.label}" now follows "${this.queueName(id)}". It finished its last turn before Switchboard's hook was in place, so it needs one nudge; after that it keeps going on its own.`,
        'Give It the Next Task',
      );
      if (p) await this.nextNow(pick.chat.sessionId);
    } else void vscode.window.setStatusBarMessage(`$(check) "${pick.label}" follows "${this.queueName(id)}"`, 4000);
  }

  /** For a chat waiting for the user: claims its next task and puts it into the chat. */
  async nextNow(sid: string): Promise<void> {
    const c = this.work.chats.find((x) => x.sessionId === sid);
    if (!c) return;
    if (this.work.queues.some((q) => q.tasks.some((t) => t.state === 'running' && t.chat === sid))) {
      void vscode.window.showInformationMessage('That chat already has a task. It takes the next one when its turn ends.');
      return;
    }
    const task = await Q.claimNext(c.follows, sid);
    if (!task) {
      void vscode.window.showInformationMessage('The queues this chat follows have no waiting tasks.');
      return;
    }
    await this.refresh();
    const term = this.terminals.get(sid);
    if (term) {
      // Bracketed paste keeps line breaks in the message; Enter sends it.
      term.sendText(`\x1b[200~${task.text}\x1b[201~`, false);
      term.sendText('\r', false);
      term.show();
      return;
    }
    await openSession(sid);
    await new Promise((r) => setTimeout(r, 800));
    const how = await insertIntoChat(task.text);
    void vscode.window.showInformationMessage(
      how === 'inserted' ? 'The task is in the chat\'s message box: press Enter to send it.' : 'Could not put the task into that chat. Send it there yourself, or put it back in line.',
    );
  }

  async show(sid: string): Promise<void> {
    const term = this.terminals.get(sid);
    if (term) term.show();
    else await openSession(sid);
  }

  async setPaused(sid: string, paused: boolean): Promise<void> {
    await Q.setPaused(sid, paused);
    await this.refresh();
  }

  async unfollow(sid: string, queueId?: string): Promise<void> {
    const c = this.work.chats.find((x) => x.sessionId === sid);
    if (!c) return;
    await Q.setFollows(sid, queueId ? c.follows.filter((x) => x !== queueId) : []);
    await this.refresh();
  }

  async follow(sid: string): Promise<void> {
    const c = this.work.chats.find((x) => x.sessionId === sid);
    const id = c && (await this.pickQueue('Which queue should this chat work on next?'));
    if (!c || !id) return;
    await Q.setFollows(sid, [...c.follows.filter((x) => x !== id), id]);
    await this.refresh();
  }

  async moveFollow(sid: string, queueId: string, delta: number): Promise<void> {
    const c = this.work.chats.find((x) => x.sessionId === sid);
    if (!c) return;
    const list = [...c.follows];
    const i = list.indexOf(queueId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Q.setFollows(sid, list);
    await this.refresh();
  }

  /** Text for the view: how long ago a task finished. */
  ago(ms: number | undefined): string {
    return ms ? formatAgo(ms) : '';
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subs.forEach((d) => d.dispose());
  }
}

// ---------------------------------------------------------------- view

type Message = { type: string; queue?: string; key?: string; chat?: string; text?: string; delta?: number; paused?: boolean };

export class QueuesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'switchboard.queue';
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly queues: Queues,
    /** Lets the user pick a snippet; resolves to its expanded text. */
    private readonly pickSnippetText: () => Promise<string | undefined>,
  ) {
    this.subs.push(queues.onDidChange(() => void this.post()));
    queues.viewVisible = () => !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.subs.push(
      view.webview.onDidReceiveMessage((m: Message) => void this.handle(m)),
      view.onDidChangeVisibility(() => view.visible && void this.queues.refresh()),
      view.onDidDispose(() => (this.view = undefined)),
    );
  }

  private async handle(m: Message): Promise<void> {
    const w = this.queues;
    const q = m.queue ?? '';
    const k = m.key ?? '';
    const c = m.chat ?? '';
    switch (m.type) {
      case 'ready':
        return w.refresh();
      case 'newQueue':
        return void (await w.newQueue());
      case 'renameQueue':
        return w.renameQueue(q);
      case 'deleteQueue':
        return w.deleteQueue(q);
      case 'clearDone':
        return w.clearDone(q);
      case 'copyResults':
        return w.copyResults(q);
      case 'add':
        if (m.text && (await w.addTask(q, m.text))) void this.view?.webview.postMessage({ type: 'clear', queue: q });
        return;
      case 'snippet': {
        const text = await this.pickSnippetText();
        if (text !== undefined) void this.view?.webview.postMessage({ type: 'insert', queue: q, text });
        return;
      }
      case 'edit':
        return m.text ? w.editTask(q, k, m.text) : undefined;
      case 'remove':
        return w.removeTask(q, k);
      case 'move':
        return w.moveTask(q, k, m.delta ?? 0);
      case 'requeue':
        return w.requeue(q, k);
      case 'copy':
        return w.copyResult(q, k);
      case 'show':
        return w.showResult(q, k);
      case 'startChats':
        return w.startChats(q);
      case 'attachChat':
        return w.attachChat(q);
      case 'showChat':
        return w.show(c);
      case 'nextNow':
        return w.nextNow(c);
      case 'pause':
        return w.setPaused(c, !!m.paused);
      case 'unfollow':
        return w.unfollow(c, m.queue);
      case 'follow':
        return w.follow(c);
      case 'moveFollow':
        return w.moveFollow(c, q, m.delta ?? 0);
    }
  }

  private async post(): Promise<void> {
    if (!this.view) return;
    const w = this.queues;
    const chats = await w.chatInfos();
    const chatTitle = new Map(chats.map((c) => [c.sessionId, c.title]));
    void this.view.webview.postMessage({
      type: 'state',
      state: {
        unavailable: w.unavailableReason(),
        queues: w.state.queues.map((q) => ({
          id: q.id,
          name: q.name,
          summary: w.summary(q),
          followers: chats.filter((c) => c.follows.some((f) => f.id === q.id)).map((c) => ({ sessionId: c.sessionId, title: c.title, status: c.status, paused: c.paused, waiter: c.waiter })),
          tasks: q.tasks.map((t) => ({
            key: t.key,
            text: t.text,
            state: t.state,
            chat: t.chat,
            chatTitle: t.chat ? chatTitle.get(t.chat) ?? (t.state === 'starting' ? 'new chat' : `chat ${t.chat.slice(0, 8)}`) : undefined,
            result: t.result && t.result.length > 4000 ? `${t.result.slice(0, 4000)}…` : t.result,
            ago: w.ago(t.doneAt),
          })),
        })),
        chats,
      },
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'queue.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'queue.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Queues</title>
</head>
<body>
<div id="notice"></div>
<main id="queues" aria-live="polite"></main>
<section id="chats" aria-live="polite"></section>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
  }
}
