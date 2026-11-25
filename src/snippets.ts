/**
 * Saved prompts. They live in one JSON file in Switchboard's folder, so every VS Code window (and the user, by hand)
 * sees the same list. Pure Node; the VS Code side is in snippetsView.ts.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson, exists, tryReadJson } from './fsutil';
import { slugify } from './profiles';
import { isObj } from './usage';

export interface Snippet {
  id: string;
  name: string;
  text: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

function isSnippet(v: unknown): v is Snippet {
  return isObj(v) && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.text === 'string';
}

export async function loadSnippets(file: string): Promise<Snippet[]> {
  const raw = await tryReadJson(file);
  const list = Array.isArray(raw?.snippets) ? raw.snippets.filter(isSnippet) : [];
  return list.map((s) => ({ ...s, createdAt: Number(s.createdAt) || 0, updatedAt: Number(s.updatedAt) || 0 }));
}

export async function saveSnippets(file: string, list: Snippet[]): Promise<void> {
  await atomicWriteJson(file, {
    version: 1,
    $comment: 'Switchboard prompt snippets. Variables: ${selection}, ${file}, ${clipboard}, ${input:Question}.',
    snippets: list,
  });
}

export function newSnippet(name: string, text: string, description?: string): Snippet {
  const now = Date.now();
  return { id: `s-${now.toString(36)}-${randomBytes(3).toString('hex')}`, name: name.trim(), text, description: description?.trim() || undefined, createdAt: now, updatedAt: now };
}

/** A short name for a prompt: its first line, shortened at a word boundary. */
export function suggestName(text: string, max = 48): string {
  const first = text.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : max).trimEnd()}…`;
}

export interface ExpandContext {
  selection?: string;
  file?: string;
  clipboard?: string;
  /** Asks for an `${input:Question}` value; undefined cancels. */
  ask(question: string): Promise<string | undefined>;
}

const VARIABLE = /\$\{(selection|file|clipboard|input(?::([^}]*))?)\}/g;

export function variablesIn(text: string): { context: string[]; inputs: string[] } {
  const context = new Set<string>();
  const inputs: string[] = [];
  for (const m of text.matchAll(VARIABLE)) {
    if (m[1].startsWith('input')) {
      const q = (m[2] ?? '').trim() || 'Value';
      if (!inputs.includes(q)) inputs.push(q);
    } else context.add(m[1]);
  }
  return { context: [...context], inputs };
}

/** Fills in a snippet's variables. Each `${input:Q}` is asked once. Returns undefined if the user cancels. */
export async function expandSnippet(text: string, ctx: ExpandContext): Promise<string | undefined> {
  const answers = new Map<string, string>();
  for (const q of variablesIn(text).inputs) {
    const a = await ctx.ask(q);
    if (a === undefined) return undefined;
    answers.set(q, a);
  }
  return text.replace(VARIABLE, (_m, name: string, q?: string) => {
    if (name.startsWith('input')) return answers.get((q ?? '').trim() || 'Value') ?? '';
    return (name === 'selection' ? ctx.selection : name === 'file' ? ctx.file : ctx.clipboard) ?? '';
  });
}

export interface SlashCommand {
  name: string;
  file: string;
  content: string;
  /** Variables a slash command cannot fill in; they stay as plain text. */
  unsupported: string[];
}

/**
 * A Claude Code custom command (`<config>/commands/<name>.md`) for a snippet. `${input:…}` becomes `$ARGUMENTS`
 * (one question) or `$1`, `$2`… (several), so `/name some text` fills them in.
 */
export function toSlashCommand(s: Snippet, commandsDir: string): SlashCommand {
  const { context, inputs } = variablesIn(s.text);
  const body = s.text.replace(VARIABLE, (m, name: string, q?: string) => {
    if (!name.startsWith('input')) return m;
    if (inputs.length === 1) return '$ARGUMENTS';
    return `$${inputs.indexOf((q ?? '').trim() || 'Value') + 1}`;
  });
  const yaml = (v: string) => JSON.stringify(v.replace(/\s+/g, ' ').trim());
  const readable = s.text.replace(VARIABLE, (_m, name: string, q?: string) => `<${name.startsWith('input') ? (q ?? '').trim() || 'Value' : name}>`);
  const front = [`description: ${yaml(s.description || suggestName(readable, 80))}`];
  if (inputs.length) front.push(`argument-hint: ${yaml(inputs.map((q) => `<${q}>`).join(' '))}`);
  const name = slugify(s.name);
  return {
    name,
    file: path.join(commandsDir, `${name}.md`),
    content: `---\n${front.join('\n')}\n---\n${body.trimEnd()}\n`,
    unsupported: context.map((c) => `\${${c}}`),
  };
}

export async function writeSlashCommand(cmd: SlashCommand, overwrite: boolean): Promise<'written' | 'exists'> {
  if (!overwrite && (await exists(cmd.file))) return 'exists';
  await fs.mkdir(path.dirname(cmd.file), { recursive: true });
  await fs.writeFile(cmd.file, cmd.content, 'utf8');
  return 'written';
}
