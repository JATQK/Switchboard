/**
 * Reads the conversations Claude Code saves as JSONL transcripts in `<config>/projects/<folder slug>/<session>.jsonl`:
 * the user's prompts, the last answer and the session title. Read-only; nothing here writes into Claude Code's folders.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { isObj } from './usage';

/** Claude Code names a project's folder after its path, with every character other than A–Z, a–z, 0–9 turned into "-". */
export function projectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

/** The folder holding the transcripts of `cwd`, matched without regard to case (Windows drive letters differ). */
export async function projectDir(configDir: string, cwd: string): Promise<string | undefined> {
  const root = path.join(configDir, 'projects');
  const slug = projectSlug(cwd).toLowerCase();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === slug);
    return hit ? path.join(root, hit.name) : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionFile {
  sessionId: string;
  file: string;
  mtimeMs: number;
}

/** The transcripts of a folder across config dirs (each counted once), newest first. */
export async function sessionFiles(configDirs: string[], cwd: string): Promise<SessionFile[]> {
  const seen = new Map<string, SessionFile>();
  for (const dir of configDirs) {
    const proj = await projectDir(dir, cwd);
    if (!proj) continue;
    let names: string[] = [];
    try {
      names = await fs.readdir(proj);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^([0-9a-f-]{36})\.jsonl$/i.exec(name);
      if (!m) continue;
      const file = path.join(proj, name);
      try {
        const st = await fs.stat(file);
        const prev = seen.get(m[1].toLowerCase());
        if (!prev || prev.mtimeMs < st.mtimeMs) seen.set(m[1].toLowerCase(), { sessionId: m[1], file, mtimeMs: st.mtimeMs });
      } catch {
        // vanished while listing
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface SessionSummary {
  sessionId?: string;
  title?: string;
  /** The user's own prompts, oldest first (no tool results, no injected context). */
  prompts: string[];
  lastPrompt?: string;
  /** Claude's final text after the last prompt, without the interim text written before tool calls. */
  lastAnswer?: string;
}

/** Text Claude Code adds around a prompt (IDE context, reminders, command echoes) is wrapped in a tag. */
const INJECTED = /^\s*<([a-z][\w-]*)[\s>][\s\S]*<\/\1>\s*$/i;
const COMMAND_ECHO = /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr)>/i;

function userText(content: unknown): { text?: string; toolResult: boolean } {
  if (typeof content === 'string') return { text: COMMAND_ECHO.test(content) || INJECTED.test(content) ? undefined : content.trim() || undefined, toolResult: false };
  if (!Array.isArray(content)) return { toolResult: false };
  const parts: string[] = [];
  let toolResult = false;
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'tool_result') toolResult = true;
    if (block.type === 'text' && typeof block.text === 'string' && !INJECTED.test(block.text) && !COMMAND_ECHO.test(block.text)) parts.push(block.text);
  }
  const text = parts.join('\n').trim();
  return { text: text || undefined, toolResult };
}

export function parseTranscript(jsonl: string): SessionSummary {
  const summary: SessionSummary = { prompts: [] };
  let answer: string[] = [];
  /** Title priority: one the user set, then Claude Code's generated one, then an old-style summary. */
  let custom: string | undefined;
  let ai: string | undefined;
  let older: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a line being written right now
    }
    if (!isObj(rec)) continue;
    if (typeof rec.sessionId === 'string') summary.sessionId ??= rec.sessionId;
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') custom = rec.customTitle;
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') ai = rec.aiTitle;
    if (rec.type === 'summary' && typeof rec.summary === 'string') older ??= rec.summary;
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    const message = isObj(rec.message) ? rec.message : undefined;
    if (rec.type === 'user' && message) {
      const { text, toolResult } = userText(message.content);
      if (text && !toolResult) {
        summary.prompts.push(text);
        answer = [];
      } else if (toolResult) {
        answer = []; // text before a tool call was interim
      }
    } else if (rec.type === 'assistant' && message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObj(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) answer.push(block.text.trim());
      }
    }
  }
  summary.title = custom || ai || older;
  summary.lastPrompt = summary.prompts.at(-1);
  summary.lastAnswer = answer.length ? answer.join('\n\n') : undefined;
  return summary;
}

/** Transcripts can grow large; only the tail matters for the latest answer, but prompts need the whole file. */
export async function readSession(file: string, maxBytes = 32 * 1024 * 1024): Promise<SessionSummary> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return parseTranscript(text);
  } finally {
    await handle.close();
  }
}

/** Recent prompts across a folder's latest sessions, newest first, without duplicates. */
export async function recentPrompts(configDirs: string[], cwd: string, limit = 40, sessions = 5): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of (await sessionFiles(configDirs, cwd)).slice(0, sessions)) {
    const { prompts } = await readSession(s.file).catch(() => ({ prompts: [] as string[] }));
    for (const p of [...prompts].reverse()) {
      const key = p.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
