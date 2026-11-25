/**
 * Claude Code chats that are running right now, per account, and what their transcripts say about usage limits.
 *
 * Every Claude Code process registers itself in `<config dir>/sessions/<pid>.json` (the list behind
 * `claude agents`), so the folder a chat registered in is the account it runs on. A running process keeps its
 * account: moving a chat means ending its process and resuming the conversation under the new account, which works
 * because accounts share their `projects` folder (the transcripts).
 */
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tryReadJson } from './fsutil';
import { pathKey } from './paths';
import { projectDir } from './transcripts';
import { isObj } from './usage';
import type { UsageReading } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunningChat {
  pid: number;
  sessionId: string;
  cwd: string;
  /** The account folder the chat registered in, i.e. the account it runs on. */
  configDir: string;
  /** 'interactive' for chats; 'background' for `claude --bg` sessions. */
  kind: string;
  /** Where it runs: 'claude-vscode' (the Claude Code panel), 'cli' (a terminal), or an SDK. */
  entrypoint?: string;
  name?: string;
  /** 'idle' (waiting for the user) or 'busy'. */
  status?: string;
  /** Epoch ms the process started. */
  startedAt?: number;
}

export type ChatPlace = 'panel' | 'terminal' | 'other';

export function placeOf(chat: Pick<RunningChat, 'entrypoint'>): ChatPlace {
  if (chat.entrypoint === 'claude-vscode') return 'panel';
  if (chat.entrypoint === 'cli') return 'terminal';
  return 'other';
}

/** One `sessions/<pid>.json` record, or undefined when it isn't a chat Switchboard understands. */
export function parseSessionRecord(json: unknown, configDir: string): RunningChat | undefined {
  if (!isObj(json)) return undefined;
  const { pid, sessionId, cwd } = json;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof cwd !== 'string' || !cwd) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    pid,
    sessionId: sessionId.toLowerCase(),
    cwd,
    configDir,
    kind: str(json.kind) ?? 'interactive',
    entrypoint: str(json.entrypoint),
    name: str(json.name),
    status: str(json.status),
    startedAt: typeof json.startedAt === 'number' ? json.startedAt : undefined,
  };
}

/** Whether a process exists. Signal 0 only checks; EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Chats registered in an account folder whose process is still running. */
export async function readRunningChats(configDir: string, alive: (pid: number) => boolean = processAlive): Promise<RunningChat[]> {
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const chats: RunningChat[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const chat = parseSessionRecord(await tryReadJson(path.join(dir, name)), configDir);
    if (chat && alive(chat.pid)) chats.push(chat);
  }
  return chats.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** `claude agents --json`: Claude Code's own list of live sessions (it also guards against reused process IDs). */
export function parseAgentsList(stdout: string): { pid: number; sessionId: string; status?: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((a): a is Record<string, unknown> => isObj(a) && typeof a.pid === 'number' && typeof a.sessionId === 'string')
    .map((a) => ({ pid: a.pid as number, sessionId: String(a.sessionId).toLowerCase(), status: typeof a.status === 'string' ? a.status : undefined }));
}

/** Whether two account folders see the same transcripts, so a conversation can continue from one in the other. */
export async function sharesHistory(dirA: string, dirB: string): Promise<boolean> {
  if (pathKey(dirA) === pathKey(dirB)) return true;
  try {
    const [a, b] = await Promise.all([fs.realpath(path.join(dirA, 'projects')), fs.realpath(path.join(dirB, 'projects'))]);
    return pathKey(a) === pathKey(b);
  } catch {
    return false;
  }
}

/**
 * Ends a chat's process. On Windows the whole process tree goes (MCP servers and shells it started), since
 * terminating only the parent would leave those behind.
 */
export function endProcess(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

// ---------------------------------------------------------------- usage limits seen in transcripts

/** A chat ran into a usage limit: that window is full until it resets. */
export interface LimitHit {
  window: 'session' | 'weekly';
  /** ISO time the limit resets. */
  resetsAt?: string;
  /** Epoch ms of the rejected request. */
  at: number;
}

const WINDOWS: Record<string, LimitHit['window']> = { five_hour: 'session', seven_day: 'weekly' };

/**
 * The latest usage-limit rejection in transcript text (Claude Code records it as an assistant message with
 * `apiError: "usage_limit_reached"`), ignoring anything before `since`.
 */
export function findLimitHit(jsonl: string, since = 0): LimitHit | undefined {
  let latest: LimitHit | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.includes('"usage_limit_reached"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(rec) || rec.apiError !== 'usage_limit_reached' || typeof rec.timestamp !== 'string') continue;
    const at = Date.parse(rec.timestamp);
    if (Number.isNaN(at) || at < since) continue;
    const params = isObj(rec.apiErrorParams) ? rec.apiErrorParams : undefined;
    const info = isObj(params?.rate_limit_info) ? params.rate_limit_info : isObj(rec.quotaLimits) ? rec.quotaLimits : undefined;
    const window = typeof info?.rateLimitType === 'string' ? WINDOWS[info.rateLimitType] : undefined;
    if (!window) continue;
    const resetsAt = typeof info?.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? new Date(info.resetsAt * 1000).toISOString() : undefined;
    if (!latest || at >= latest.at) latest = { window, resetsAt, at };
  }
  return latest;
}

/** Limit rejections are at the end of a transcript; reading the tail is enough. */
const TAIL_BYTES = 512 * 1024;
const tailCache = new Map<string, { mtimeMs: number; size: number; hit?: LimitHit; since: number }>();

async function readTail(file: string, size: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

/** The latest limit a running chat hit since its process started (earlier ones may be from another account). */
export async function chatLimitHit(chat: RunningChat): Promise<LimitHit | undefined> {
  const proj = await projectDir(chat.configDir, chat.cwd);
  if (!proj) return undefined;
  const file = path.join(proj, `${chat.sessionId}.jsonl`);
  const since = chat.startedAt ?? 0;
  try {
    const st = await fs.stat(file);
    const cached = tailCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.since === since) return cached.hit;
    const hit = findLimitHit(await readTail(file, st.size), since);
    tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, hit, since });
    return hit;
  } catch {
    return undefined;
  }
}

/** The most recent limit any of an account's running chats hit. */
export async function latestLimitHit(chats: RunningChat[]): Promise<LimitHit | undefined> {
  let latest: LimitHit | undefined;
  for (const chat of chats) {
    const hit = await chatLimitHit(chat);
    if (hit && (!latest || hit.at > latest.at)) latest = hit;
  }
  return latest;
}

/** A usage reading updated with a newer limit hit: that window becomes 100% until it resets. */
export function withLimitHit(reading: UsageReading | undefined, hit: LimitHit | undefined): UsageReading | undefined {
  if (!hit || (reading && reading.at >= hit.at)) return reading;
  return { usage: { ...reading?.usage, [hit.window]: { utilization: 100, resetsAt: hit.resetsAt } }, at: hit.at, source: 'limit' };
}
