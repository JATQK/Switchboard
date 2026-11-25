/** Commands for queues, snippets, and copying from Claude Code conversations. */
import * as vscode from 'vscode';
import { sessionLink } from './claudeCode';
import { formatAgo } from './format';
import type { Queues } from './queuesView';
import type { Snippets } from './snippetsView';
import type { Switchboard } from './switchboard';
import { readSession, sessionFiles, type SessionFile } from './transcripts';

type CopyWhat = 'answer' | 'prompt' | 'resume' | 'link';

async function pickSession(sb: Switchboard, cwd: string): Promise<SessionFile | undefined> {
  const files = (await sessionFiles(sb.configDirs(), cwd)).slice(0, 30);
  const items = await Promise.all(
    files.map(async (f) => {
      const s = await readSession(f.file).catch(() => undefined);
      return { label: s?.title || (s?.lastPrompt ? s.lastPrompt.split(/\r?\n/)[0].slice(0, 80) : f.sessionId), description: formatAgo(f.mtimeMs), detail: f.sessionId, file: f };
    }),
  );
  return (await vscode.window.showQuickPick(items, { title: 'Claude Code conversations in this folder', matchOnDetail: true }))?.file;
}

/** Copies something from the latest Claude Code conversation in this folder (or one the user picks). */
async function copyFromClaude(sb: Switchboard, what?: CopyWhat): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showInformationMessage('Open a folder: Claude Code keeps conversations per folder.');
    return;
  }
  let session: SessionFile | undefined = (await sessionFiles(sb.configDirs(), cwd))[0];
  if (!session) {
    void vscode.window.showInformationMessage('No Claude Code conversations found for this folder yet.');
    return;
  }
  if (!what) {
    const summary = await readSession(session.file).catch(() => undefined);
    const name = summary?.title || summary?.lastPrompt?.split(/\r?\n/)[0].slice(0, 60) || 'latest conversation';
    type Item = vscode.QuickPickItem & { what?: CopyWhat; other?: boolean };
    const items: Item[] = [
      { label: '$(comment) Last answer', what: 'answer', detail: summary?.lastAnswer?.slice(0, 120) },
      { label: '$(feedback) Last prompt', what: 'prompt', detail: summary?.lastPrompt?.slice(0, 120) },
      { label: '$(terminal) Resume command', what: 'resume', detail: `claude --resume ${session.sessionId}` },
      { label: '$(link) Link that opens it in Claude Code', what: 'link', detail: sessionLink(session.sessionId) },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(history) From another conversation…', other: true },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Copy from "${name}" (${formatAgo(session.mtimeMs)})` });
    if (!pick) return;
    if (pick.other) {
      session = await pickSession(sb, cwd);
      if (!session) return;
      return copyFrom(session, await pickWhat());
    }
    what = pick.what;
  }
  return copyFrom(session, what);
}

async function pickWhat(): Promise<CopyWhat | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(comment) Last answer', what: 'answer' as const },
      { label: '$(feedback) Last prompt', what: 'prompt' as const },
      { label: '$(terminal) Resume command', what: 'resume' as const },
      { label: '$(link) Link that opens it in Claude Code', what: 'link' as const },
    ],
    { title: 'Copy what?' },
  );
  return pick?.what;
}

async function copyFrom(session: SessionFile, what: CopyWhat | undefined): Promise<void> {
  if (!what) return;
  let text: string | undefined;
  if (what === 'resume') text = `claude --resume ${session.sessionId}`;
  else if (what === 'link') text = sessionLink(session.sessionId);
  else {
    const s = await readSession(session.file);
    text = what === 'answer' ? s.lastAnswer : s.lastPrompt;
  }
  if (!text) {
    void vscode.window.showInformationMessage(`That conversation has no ${what === 'answer' ? 'answer' : 'prompt'} yet.`);
    return;
  }
  await vscode.env.clipboard.writeText(text);
  const label = { answer: 'Last answer', prompt: 'Last prompt', resume: 'Resume command', link: 'Link' }[what];
  void vscode.window.setStatusBarMessage(`$(check) ${label} copied`, 3000);
}

export function registerFeatureCommands(
  ctx: vscode.ExtensionContext,
  sb: Switchboard,
  queues: Queues,
  snippets: Snippets,
  log: vscode.LogOutputChannel,
): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(msg);
          void vscode.window.showErrorMessage(`Switchboard: ${msg}`);
        }
      }),
    );

  const selectionText = () => {
    const e = vscode.window.activeTextEditor;
    return e && !e.selection.isEmpty ? e.document.getText(e.selection) : '';
  };

  // ---- queues
  register('switchboard.queues.new', () => queues.newQueue());
  register('switchboard.queues.addTask', async () => {
    const text = selectionText() || (await vscode.window.showInputBox({ title: 'Add a task to a queue', prompt: 'The task, as you would write it to Claude', ignoreFocusOut: true }));
    if (text?.trim()) await queues.addTask(undefined, text);
  });
  register('switchboard.queues.startChats', () => queues.startChats());
  register('switchboard.queues.attachChat', () => queues.attachChat());

  // ---- snippets
  register('switchboard.snippets.use', () => snippets.use());
  register('switchboard.snippets.new', () => snippets.create());
  register('switchboard.snippets.newFromSelection', () => snippets.createFromSelection());
  register('switchboard.snippets.fromHistory', () => snippets.createFromHistory());
  register('switchboard.snippets.insert', (arg) => snippets.insert(arg));
  register('switchboard.snippets.newChat', (arg) => snippets.newChat(arg));
  register('switchboard.snippets.enqueue', (arg) => snippets.enqueue(arg));
  register('switchboard.snippets.copy', (arg) => snippets.copy(arg));
  register('switchboard.snippets.saveAsCommand', (arg) => snippets.saveAsCommand(arg));
  register('switchboard.snippets.edit', (arg) => snippets.edit(arg));
  register('switchboard.snippets.rename', (arg) => snippets.rename(arg));
  register('switchboard.snippets.describe', (arg) => snippets.describe(arg));
  register('switchboard.snippets.delete', (arg) => snippets.remove(arg));
  register('switchboard.snippets.openFile', () => snippets.openFile());

  // ---- copy from Claude Code
  register('switchboard.copyFromClaude', () => copyFromClaude(sb));
  register('switchboard.copyLastAnswer', () => copyFromClaude(sb, 'answer'));
  register('switchboard.copyLastPrompt', () => copyFromClaude(sb, 'prompt'));
}
