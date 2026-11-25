/**
 * The Claude Code VS Code extension, driven through its own commands. It has no API for other extensions; these
 * commands and their arguments were verified against Claude Code 2.1.331 (see docs/research/). Prompts passed to them
 * are put in the message box, never sent.
 */
import * as vscode from 'vscode';

export const CLAUDE_CODE_ID = 'anthropic.claude-code';
const PANEL_VIEW_TYPE = 'claudeVSCodePanel';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function claudeCodeInstalled(): boolean {
  return !!vscode.extensions.getExtension(CLAUDE_CODE_ID);
}

async function requireClaudeCode(): Promise<boolean> {
  if (claudeCodeInstalled()) return true;
  const pick = await vscode.window.showWarningMessage('This needs the Claude Code extension.', 'Show Extension');
  if (pick) await vscode.commands.executeCommand('extension.open', CLAUDE_CODE_ID);
  return false;
}

function isClaudeTab(tab: vscode.Tab | undefined): boolean {
  const input = tab?.input;
  return input instanceof vscode.TabInputWebview && input.viewType.includes(PANEL_VIEW_TYPE);
}

const claudeTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab);

/**
 * Opens a conversation in a Claude Code tab, with its history. Only works for conversations of the open folder
 * (others open as a new chat), and only once no other process holds the conversation.
 */
export async function openSession(sessionId: string, prompt?: string): Promise<boolean> {
  if (!(await requireClaudeCode())) return false;
  await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, prompt);
  return true;
}

/** A new Claude Code conversation with `prompt` in the message box, where the user prefers Claude (tab or sidebar). */
export async function newChat(prompt: string): Promise<boolean> {
  if (!(await requireClaudeCode())) return false;
  await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
  return true;
}

/**
 * Puts text into the message box of the Claude Code conversation in front, through the clipboard (restored after).
 * Pastes only when a Claude Code tab is verifiably focused; otherwise starts a new chat with the text instead, so
 * nothing is ever pasted into a file. Returns how the text arrived.
 */
export async function insertIntoChat(text: string): Promise<'inserted' | 'newChat' | undefined> {
  if (!(await requireClaudeCode())) return undefined;
  if (!claudeTabs().length) return (await newChat(text)) ? 'newChat' : undefined;
  await vscode.commands.executeCommand('claude-vscode.focus');
  await sleep(300);
  if (!isClaudeTab(vscode.window.tabGroups.activeTabGroup.activeTab)) return (await newChat(text)) ? 'newChat' : undefined;
  const previous = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(text);
  try {
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  } finally {
    setTimeout(() => void vscode.env.clipboard.writeText(previous), 1000);
  }
  return 'inserted';
}

/** A link that opens a conversation in Claude Code (VS Code asks once before letting a link open it). */
export function sessionLink(sessionId: string): string {
  return `vscode://${CLAUDE_CODE_ID}/open?session=${encodeURIComponent(sessionId)}`;
}
