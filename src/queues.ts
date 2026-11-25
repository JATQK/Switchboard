/**
 * Queues of tasks, worked through by real Claude Code chats (in the Claude Code panel or a terminal).
 *
 * Everything lives in files under `~/.claude-switchboard/work/`, so a small Stop hook can hand out tasks without
 * Switchboard running:
 *
 *   queues/<queue id>/name                  the queue's name (plain text)
 *   queues/<queue id>/<order>-<r>.task      a waiting task (its text)
 *   queues/<queue id>/<order>-<r>.<chat>.run   claimed by a chat (<chat> is its session id, or a start token)
 *   queues/<queue id>/<order>-<r>.<chat>.done  finished by that chat; `.<chat>.json` holds the Stop hook input
 *                                           (with Claude's last message) of the turn that finished it
 *   chats/<session id>                      the queues a chat follows, one id per line, in order
 *   chats/<session id>.paused               the chat finishes its current task but takes no new ones
 *   chats/pending/<token>                   a panel chat Switchboard opened but that hasn't started yet; its first
 *                                           message contains the token, which ties the new session to its queues
 *
 * When Claude finishes a turn in a chat that follows queues, the hook marks the chat's running task done, then claims
 * the oldest waiting task of the first followed queue that has one (claiming = renaming the file, which only one chat
 * can win) and hands it to Claude as additional context, so Claude carries on in the same turn. Several chats can
 * follow one queue: they share its tasks. A chat that runs out of tasks in one queue moves on to the next it follows.
 * Pure Node: the VS Code side is in queuesView.ts.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exists, tryReadJson, writeJsonInPlace } from './fsutil';
import { binDir, switchboardHome } from './paths';
import { isObj } from './usage';

const MARKER = 'switchboard-queues';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_ID = /^q-[a-z0-9]+-[a-f0-9]+$/;
const TOKEN = /^sb-[a-f0-9]{10}$/;
const TASK = /^(\d{15})-([a-f0-9]+)\.(task|([0-9a-z-]+)\.(run|done))$/i;

export const workRoot = () => path.join(switchboardHome(), 'work');
const queuesDir = () => path.join(workRoot(), 'queues');
const chatsDir = () => path.join(workRoot(), 'chats');
const pendingDir = () => path.join(chatsDir(), 'pending');

export type TaskState = 'waiting' | 'starting' | 'running' | 'done';

export interface Task {
  queueId: string;
  /** `<order>-<random>`: identifies the task within its queue across states. */
  key: string;
  order: number;
  text: string;
  state: TaskState;
  /** Session id of the chat running or having run it, or the start token while a panel chat starts. */
  chat?: string;
  /** Claude's last message of the turn that finished the task. */
  result?: string;
  doneAt?: number;
}

export interface Queue {
  id: string;
  name: string;
  tasks: Task[];
}

export interface Follower {
  sessionId: string;
  /** Queue ids, in the order the chat works through them. */
  follows: string[];
  paused: boolean;
}

export interface PendingStart {
  token: string;
  follows: string[];
  createdAt: number;
}

export interface WorkState {
  queues: Queue[];
  chats: Follower[];
  pending: PendingStart[];
}

const isQueueId = (id: string) => QUEUE_ID.test(id);
const checkQueue = (id: string) => {
  if (!isQueueId(id)) throw new Error(`Not a queue id: ${id}`);
  return path.join(queuesDir(), id);
};
const checkSession = (sid: string) => {
  if (!UUID.test(sid)) throw new Error(`Not a Claude Code session id: ${sid}`);
  return sid.toLowerCase();
};
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(15, '0');
const readText = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);
const list = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);
/** Atomic claim: false when someone else moved the file first. */
const move = (from: string, to: string) => fs.rename(from, to).then(() => true, () => false);

// ---------------------------------------------------------------- reading

export async function readWork(): Promise<WorkState> {
  const queues: Queue[] = [];
  for (const id of (await list(queuesDir())).filter(isQueueId)) {
    const dir = path.join(queuesDir(), id);
    const names = await list(dir);
    const tasks: Task[] = [];
    for (const file of names) {
      const m = TASK.exec(file);
      if (!m) continue;
      const text = await readText(path.join(dir, file));
      if (text === undefined) continue; // claimed meanwhile
      const key = `${m[1]}-${m[2]}`;
      const chat = m[4]?.toLowerCase();
      const state: TaskState = m[3] === 'task' ? 'waiting' : m[5] === 'done' ? 'done' : chat && TOKEN.test(chat) ? 'starting' : 'running';
      const task: Task = { queueId: id, key, order: Number(m[1]), text, state, chat };
      if (state === 'done' && chat) {
        const hookInput = await tryReadJson(path.join(dir, `${key}.${chat}.json`));
        if (typeof hookInput?.last_assistant_message === 'string') task.result = hookInput.last_assistant_message;
        task.doneAt = (await fs.stat(path.join(dir, file)).catch(() => undefined))?.mtimeMs;
      }
      tasks.push(task);
    }
    tasks.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    queues.push({ id, name: ((await readText(path.join(dir, 'name'))) ?? '').trim() || 'Queue', tasks });
  }
  const chats: Follower[] = [];
  const chatNames = await list(chatsDir());
  for (const name of chatNames.filter((n) => UUID.test(n))) {
    const follows = ((await readText(path.join(chatsDir(), name))) ?? '').split(/\r?\n/).map((l) => l.trim()).filter(isQueueId);
    chats.push({ sessionId: name.toLowerCase(), follows, paused: chatNames.includes(`${name}.paused`) });
  }
  const pending: PendingStart[] = [];
  for (const token of (await list(pendingDir())).filter((t) => TOKEN.test(t))) {
    const file = path.join(pendingDir(), token);
    const follows = ((await readText(file)) ?? '').split(/\r?\n/).map((l) => l.trim()).filter(isQueueId);
    pending.push({ token, follows, createdAt: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? Date.now() });
  }
  queues.sort((a, b) => a.id.localeCompare(b.id));
  return { queues, chats, pending };
}

// ---------------------------------------------------------------- queues and tasks

export async function createQueue(name: string): Promise<string> {
  const id = `q-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const dir = checkQueue(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'name'), name.trim() || 'Queue', 'utf8');
  return id;
}

export async function renameQueue(id: string, name: string): Promise<void> {
  await fs.writeFile(path.join(checkQueue(id), 'name'), name.trim() || 'Queue', 'utf8');
}

/** Deletes a queue with its tasks, and drops it from every chat's list. */
export async function deleteQueue(id: string): Promise<void> {
  await fs.rm(checkQueue(id), { recursive: true, force: true });
  for (const c of (await readWork()).chats) if (c.follows.includes(id)) await setFollows(c.sessionId, c.follows.filter((q) => q !== id));
}

/** The last order handed out by this process, so tasks added within the same millisecond keep their order. */
let lastOrder = 0;

export async function addTask(queueId: string, text: string): Promise<string> {
  const dir = checkQueue(queueId);
  await fs.mkdir(dir, { recursive: true });
  // 15 digits (milliseconds × 100) keep tasks in the order they were added: always after every task already in the
  // queue, even one added in the same millisecond (or by another window). The random part keeps keys unique.
  const newest = Math.max(0, ...(await list(dir)).map((f) => Number(TASK.exec(f)?.[1] ?? 0)));
  const order = Math.max(Date.now() * 100, newest + 1, lastOrder + 1);
  lastOrder = order;
  const key = `${pad(order)}-${randomBytes(3).toString('hex')}`;
  // Under another name first: the hook must never pick up a half-written task.
  const tmp = path.join(dir, `${key}.tmp`);
  await fs.writeFile(tmp, text.trim(), 'utf8');
  await fs.rename(tmp, path.join(dir, `${key}.task`));
  return key;
}

async function taskFile(queueId: string, key: string): Promise<string | undefined> {
  const dir = checkQueue(queueId);
  const hit = (await list(dir)).find((f) => f.startsWith(`${key}.`) && TASK.test(f));
  return hit ? path.join(dir, hit) : undefined;
}

export async function editTask(queueId: string, key: string, text: string): Promise<boolean> {
  const file = await taskFile(queueId, key);
  if (!file?.endsWith('.task') || !text.trim()) return false;
  await fs.writeFile(file, text.trim(), 'utf8');
  return true;
}

/** Removes a task, unless a chat is working on it. */
export async function removeTask(queueId: string, key: string): Promise<boolean> {
  const file = await taskFile(queueId, key);
  if (!file || file.endsWith('.run')) return false;
  await fs.rm(file, { force: true });
  await fs.rm(file.replace(/\.done$/, '.json'), { force: true });
  return true;
}

/** Puts a done, starting or stuck task back in line (in its original place). */
export async function requeueTask(queueId: string, key: string): Promise<boolean> {
  const file = await taskFile(queueId, key);
  if (!file || file.endsWith('.task')) return false;
  const ok = await move(file, path.join(checkQueue(queueId), `${key}.task`));
  if (ok) await fs.rm(file.replace(/\.(run|done)$/, '.json'), { force: true });
  return ok;
}

/** Moves a waiting task `delta` places among the waiting tasks (renumbering them). */
export async function moveTask(queueId: string, key: string, delta: number): Promise<void> {
  const q = (await readWork()).queues.find((x) => x.id === queueId);
  const waiting = q?.tasks.filter((t) => t.state === 'waiting') ?? [];
  const from = waiting.findIndex((t) => t.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= waiting.length) return;
  const [t] = waiting.splice(from, 1);
  waiting.splice(to, 0, t);
  const base = Math.min(...waiting.map((w) => w.order));
  const dir = checkQueue(queueId);
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i];
    const rand = w.key.split('-')[1];
    const next = `${pad(base + i)}-${rand}`;
    if (next !== w.key) await move(path.join(dir, `${w.key}.task`), path.join(dir, `${next}.task`));
  }
}

export async function clearDone(queueId: string): Promise<void> {
  const dir = checkQueue(queueId);
  for (const f of await list(dir)) if (/\.(done|json)$/.test(f) && TASK.test(f.replace(/\.json$/, '.done'))) await fs.rm(path.join(dir, f), { force: true });
}

// ---------------------------------------------------------------- chats

export async function setFollows(sessionId: string, follows: string[]): Promise<void> {
  const sid = checkSession(sessionId);
  await fs.mkdir(chatsDir(), { recursive: true });
  const ids = [...new Set(follows.filter(isQueueId))];
  const file = path.join(chatsDir(), sid);
  if (!ids.length) {
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.paused`, { force: true });
    return;
  }
  await fs.writeFile(`${file}.tmp`, `${ids.join('\n')}\n`, 'utf8');
  await fs.rename(`${file}.tmp`, file);
}

export async function setPaused(sessionId: string, paused: boolean): Promise<void> {
  const file = path.join(chatsDir(), `${checkSession(sessionId)}.paused`);
  if (paused) await fs.writeFile(file, '', 'utf8');
  else await fs.rm(file, { force: true });
}

/** Claims the next waiting task of the given queues for a chat (used to start a chat with its first task). */
export async function claimNext(follows: string[], chat: string): Promise<Task | undefined> {
  if (!UUID.test(chat) && !TOKEN.test(chat)) throw new Error(`Not a chat id: ${chat}`);
  for (const queueId of follows.filter(isQueueId)) {
    const dir = path.join(queuesDir(), queueId);
    for (const f of (await list(dir)).filter((n) => n.endsWith('.task')).sort()) {
      const key = f.slice(0, -'.task'.length);
      if (!(await move(path.join(dir, f), path.join(dir, `${key}.${chat.toLowerCase()}.run`)))) continue;
      const text = (await readText(path.join(dir, `${key}.${chat.toLowerCase()}.run`))) ?? '';
      return { queueId, key, order: Number(key.split('-')[0]), text, state: TOKEN.test(chat) ? 'starting' : 'running', chat: chat.toLowerCase() };
    }
  }
  return undefined;
}

export function newStartToken(): string {
  return `sb-${randomBytes(5).toString('hex')}`;
}

/** Remembers a panel chat that is about to start; the token must appear in its first message. */
export async function addPendingStart(token: string, follows: string[]): Promise<void> {
  if (!TOKEN.test(token)) throw new Error(`Not a start token: ${token}`);
  await fs.mkdir(pendingDir(), { recursive: true });
  await fs.writeFile(path.join(pendingDir(), token), `${follows.filter(isQueueId).join('\n')}\n`, 'utf8');
}

/** Ties a started panel chat to its queues (the hook does the same; whichever comes first wins). */
export async function bindPendingStart(token: string, sessionId: string): Promise<boolean> {
  const sid = checkSession(sessionId);
  if (!TOKEN.test(token)) return false;
  await fs.mkdir(chatsDir(), { recursive: true });
  if (!(await move(path.join(pendingDir(), token), path.join(chatsDir(), sid)))) return false;
  for (const q of (await list(queuesDir())).filter(isQueueId)) {
    const dir = path.join(queuesDir(), q);
    for (const f of (await list(dir)).filter((n) => n.endsWith(`.${token}.run`))) await move(path.join(dir, f), path.join(dir, f.replace(`.${token}.run`, `.${sid}.run`)));
  }
  return true;
}

/** Gives up on a panel chat that never started: its task goes back in line. */
export async function cancelPendingStart(token: string): Promise<void> {
  if (!TOKEN.test(token)) return;
  for (const q of (await list(queuesDir())).filter(isQueueId)) {
    const dir = path.join(queuesDir(), q);
    for (const f of (await list(dir)).filter((n) => n.endsWith(`.${token}.run`))) await move(path.join(dir, f), path.join(dir, f.replace(`.${token}.run`, '.task')));
  }
  await fs.rm(path.join(pendingDir(), token), { force: true });
}

/**
 * Whether the hook is needed: while a queue has unfinished tasks, a chat follows a queue, or a panel chat is starting.
 * Chats wait for their next task (in the background) only while it is installed.
 */
export function hookNeeded(w: WorkState): boolean {
  return w.pending.length > 0 || w.chats.length > 0 || w.queues.some((q) => q.tasks.some((t) => t.state !== 'done'));
}

// ---------------------------------------------------------------- the Stop hook

/** How a queued task is introduced to Claude, after the queue name. It arrives through the hook, not as a message. */
const NOTE =
  "The user queued it for you; do it now, as if they had just sent it. It reaches you through a hook, so the chat does not show it: begin your reply with one short line that sums up the task in a few words.";

export const preamble = (queueName: string) => `Next task from the Switchboard queue "${queueName}". ${NOTE}`;

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function ps1(root: string): string {
  return `# Written by the Switchboard VS Code extension (safe to delete; Switchboard removes the hook when no queue needs it).
# Claude Code Stop hook, run in the background (asyncRewake). When a turn ends, it marks the chat's queue task done.
# Then it waits until the chat is idle and a queue the chat follows has a task, and wakes Claude with that task
# (exit code 2). It stops when the chat ends, when a later turn of the same chat starts a new waiter, or after a while.
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
$raw = [Console]::In.ReadToEnd()
$m = [regex]::Match($raw, '"session_id"\\s*:\\s*"([0-9a-fA-F-]{36})"')
if (-not $m.Success) { exit 0 }
$sid = $m.Groups[1].Value.ToLowerInvariant()
$root = ${psQuote(root)}
$queues = Join-Path $root 'queues'
$chats = Join-Path $root 'chats'
$follow = Join-Path $chats $sid
function Read-Text($p) { try { return [System.IO.File]::ReadAllText($p, $utf8) } catch { return $null } }
if (-not (Test-Path -LiteralPath $follow)) {
  # A panel chat Switchboard opened: its first message carries a start token.
  $pending = @(Get-ChildItem -LiteralPath (Join-Path $chats 'pending') -File)
  $tp = $null
  if ($pending.Count -gt 0) { try { $tp = ($raw | ConvertFrom-Json).transcript_path } catch {} }
  if ($tp -and (Test-Path -LiteralPath $tp)) {
    foreach ($p in $pending) {
      if (-not (Select-String -LiteralPath $tp -SimpleMatch -Pattern $p.Name -Quiet)) { continue }
      try { [System.IO.File]::Move($p.FullName, $follow) } catch { continue }
      foreach ($f in (Get-ChildItem -LiteralPath $queues -Recurse -File -Filter ('*.' + $p.Name + '.run'))) {
        try { [System.IO.File]::Move($f.FullName, ($f.FullName.Substring(0, $f.FullName.Length - $p.Name.Length - 4) + $sid + '.run')) } catch {}
      }
      break
    }
  }
}
if (Test-Path -LiteralPath $follow) {
  # The turn that just ended finished this chat's task.
  foreach ($f in (Get-ChildItem -LiteralPath $queues -Recurse -File -Filter ('*.' + $sid + '.run'))) {
    $base = $f.FullName.Substring(0, $f.FullName.Length - 4)
    try { [System.IO.File]::Move($f.FullName, $base + '.done'); [System.IO.File]::WriteAllText($base + '.json', $raw, $utf8) } catch {}
  }
}
# From here on: wait in the background for this chat's next task.
$cfg = $env:CLAUDE_CONFIG_DIR
if (-not $cfg) { $cfg = Join-Path $HOME '.claude' }
$sessions = Join-Path $cfg 'sessions'
$waiters = Join-Path $root 'waiters'
[void](New-Item -ItemType Directory -Force -Path $waiters)
$mine = Join-Path $waiters $sid
$me = [string]$PID + ' ' + [guid]::NewGuid().ToString('N')
[System.IO.File]::WriteAllText($mine, $me, $utf8)
function Stop-Waiting($code) {
  if ((Read-Text $mine) -eq $me) { Remove-Item -LiteralPath $mine -Force }
  exit $code
}
$started = Get-Date
$record = $null
$misses = 0
$first = $true
while ($true) {
  if (-not $first) {
    Start-Sleep -Milliseconds 1500
    # Chats that follow a queue wait up to a day; others half an hour (in case they are added to a queue).
    $limit = 1800
    if (Test-Path -LiteralPath $follow) { $limit = 86400 }
    if ($env:SWITCHBOARD_QUEUE_WAIT) { $limit = [int]$env:SWITCHBOARD_QUEUE_WAIT }
    if (((Get-Date) - $started).TotalSeconds -ge $limit) { Stop-Waiting 0 }
  }
  $first = $false
  # A later turn of this chat started its own waiter.
  if ((Read-Text $mine) -ne $me) { exit 0 }
  # Claude Code keeps a record of each running chat: is this one still running, and idle?
  $rec = $null
  if ($record) { $rec = Read-Text $record }
  if (-not $rec -or $rec -notmatch ('"sessionId"\\s*:\\s*"' + $sid + '"')) {
    $record = $null
    $rec = $null
    foreach ($f in @(Get-ChildItem -LiteralPath $sessions -Filter '*.json' -File)) {
      $t = Read-Text $f.FullName
      if ($t -and $t -match ('"sessionId"\\s*:\\s*"' + $sid + '"')) { $record = $f.FullName; $rec = $t; break }
    }
  }
  if (-not $rec) {
    $misses++
    if ($misses -ge 3) { Stop-Waiting 0 }
    continue
  }
  $misses = 0
  $pm = [regex]::Match($rec, '"pid"\\s*:\\s*(\\d+)')
  if ($pm.Success) {
    $proc = Get-Process -Id ([int]$pm.Groups[1].Value) -ErrorAction SilentlyContinue
    if (-not $proc) { Stop-Waiting 0 }
    # A chat that crashed leaves its record behind, and Windows soon reuses process ids: compare start times.
    $ps = [regex]::Match($rec, '"procStart"\\s*:\\s*"?(\\d{17,})')
    if ($ps.Success) {
      try { if ([math]::Abs($proc.StartTime.ToFileTimeUtc() - [int64]$ps.Groups[1].Value) -gt 20000000) { Stop-Waiting 0 } } catch {}
    }
  }
  if ($rec -notmatch '"status"\\s*:\\s*"idle"') { continue }
  if (-not (Test-Path -LiteralPath $follow) -or (Test-Path -LiteralPath ($follow + '.paused'))) { continue }
  foreach ($q in @(Get-Content -LiteralPath $follow)) {
    $q = $q.Trim()
    if (-not $q) { continue }
    $dir = Join-Path $queues $q
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($t in (Get-ChildItem -LiteralPath $dir -File -Filter '*.task' | Sort-Object Name)) {
      $run = $t.FullName.Substring(0, $t.FullName.Length - 5) + '.' + $sid + '.run'
      try { [System.IO.File]::Move($t.FullName, $run) } catch { continue }
      $name = Read-Text (Join-Path $dir 'name')
      if ($name) { $name = $name.Trim() } else { $name = '' }
      $text = ('Next task from the Switchboard queue "' + $name + '". ${NOTE}') + "\`n\`n" + (Read-Text $run)
      [Console]::Error.Write($text)
      Stop-Waiting 2
    }
  }
}
`;
}

function sh(root: string): string {
  return `#!/bin/sh
# Written by the Switchboard VS Code extension (safe to delete; Switchboard removes the hook when no queue needs it).
# Claude Code Stop hook, run in the background (asyncRewake). When a turn ends, it marks the chat's queue task done.
# Then it waits until the chat is idle and a queue the chat follows has a task, and wakes Claude with that task
# (exit code 2). It stops when the chat ends, when a later turn of the same chat starts a new waiter, or after a while.
root=${shQuote(root)}
input=$(cat)
flat=$(printf '%s' "$input" | tr -d '\\n\\r')
sid=$(printf '%s' "$flat" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F-]\\{36\\}\\)".*/\\1/p' | tr 'A-F' 'a-f')
[ -n "$sid" ] || exit 0
follow="$root/chats/$sid"
if [ ! -f "$follow" ]; then
  # A panel chat Switchboard opened: its first message carries a start token.
  tp=$(printf '%s' "$flat" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | sed 's/\\\\\\\\/\\\\/g')
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    for p in "$root/chats/pending/"sb-*; do
      [ -f "$p" ] || break
      token=$(basename "$p")
      grep -F -q "$token" "$tp" || continue
      mv "$p" "$follow" 2>/dev/null || continue
      for f in "$root"/queues/*/*."$token".run; do
        [ -f "$f" ] && mv "$f" "\${f%.$token.run}.$sid.run" 2>/dev/null
      done
      break
    done
  fi
fi
if [ -f "$follow" ]; then
  # The turn that just ended finished this chat's task.
  for f in "$root"/queues/*/*."$sid".run; do
    [ -f "$f" ] || continue
    base="\${f%.run}"
    mv "$f" "$base.done" 2>/dev/null && printf '%s' "$input" > "$base.json"
  done
fi
# From here on: wait in the background for this chat's next task.
sessions="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
mkdir -p "$root/waiters"
mine="$root/waiters/$sid"
me="$$ $(date +%s)"
printf '%s' "$me" > "$mine"
stop_waiting() {
  [ "$(cat "$mine" 2>/dev/null)" = "$me" ] && rm -f "$mine"
  exit "$1"
}
started=$(date +%s)
record=""
misses=0
first=1
while :; do
  if [ "$first" != 1 ]; then
    sleep 2
    # Chats that follow a queue wait up to a day; others half an hour (in case they are added to a queue).
    limit=1800
    [ -f "$follow" ] && limit=86400
    [ -n "$SWITCHBOARD_QUEUE_WAIT" ] && limit=$SWITCHBOARD_QUEUE_WAIT
    [ $(( $(date +%s) - started )) -ge "$limit" ] && stop_waiting 0
  fi
  first=0
  # A later turn of this chat started its own waiter.
  [ "$(cat "$mine" 2>/dev/null)" = "$me" ] || exit 0
  # Claude Code keeps a record of each running chat: is this one still running, and idle?
  rec=""
  [ -n "$record" ] && rec=$(tr -d '\\n\\r' < "$record" 2>/dev/null)
  if ! printf '%s' "$rec" | grep -q -i -E "\\"sessionId\\"[[:space:]]*:[[:space:]]*\\"$sid\\""; then
    record=$(grep -l -i -E "\\"sessionId\\"[[:space:]]*:[[:space:]]*\\"$sid\\"" "$sessions"/*.json 2>/dev/null | head -n 1)
    rec=""
    [ -n "$record" ] && rec=$(tr -d '\\n\\r' < "$record" 2>/dev/null)
  fi
  if [ -z "$rec" ]; then
    misses=$((misses + 1))
    [ "$misses" -ge 3 ] && stop_waiting 0
    continue
  fi
  misses=0
  pid=$(printf '%s' "$rec" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then stop_waiting 0; fi
  printf '%s' "$rec" | grep -q -E '"status"[[:space:]]*:[[:space:]]*"idle"' || continue
  [ -f "$follow" ] && [ ! -f "$follow.paused" ] || continue
  while IFS= read -r q || [ -n "$q" ]; do
    q=$(printf '%s' "$q" | tr -d '\\r \\t')
    [ -n "$q" ] && [ -d "$root/queues/$q" ] || continue
    for t in "$root/queues/$q"/*.task; do
      [ -f "$t" ] || break
      run="\${t%.task}.$sid.run"
      mv "$t" "$run" 2>/dev/null || continue
      name=$(cat "$root/queues/$q/name" 2>/dev/null)
      { printf 'Next task from the Switchboard queue "%s". %s\\n\\n' "$name" ${shQuote(NOTE)}; cat "$run"; } >&2
      stop_waiting 2
    done
  done < "$follow"
done
`;
}

/** Script source for a platform (exposed for tests). */
export function hookScriptSource(kind: 'ps1' | 'sh', root = workRoot()): string {
  return kind === 'ps1' ? ps1(root).replace(/\n/g, '\r\n') : sh(root);
}

export function hookScriptPath(): string {
  return path.join(binDir(), process.platform === 'win32' ? `${MARKER}.ps1` : `${MARKER}.sh`);
}

/** The hook command. Forward slashes so it works whether Claude Code runs it via Git Bash or PowerShell. */
export function hookCommand(): string {
  const script = hookScriptPath();
  return process.platform === 'win32' ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script.replace(/\\/g, '/')}"` : `sh "${script}"`;
}

/** (Re)writes the hook script so it matches this version of the extension. */
export async function ensureHookScript(): Promise<void> {
  await fs.mkdir(binDir(), { recursive: true });
  const file = hookScriptPath();
  const content = hookScriptSource(process.platform === 'win32' ? 'ps1' : 'sh');
  if ((await readText(file)) !== content) await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o755 });
}

const marked = (marker: string) => (h: unknown) => isObj(h) && typeof h.command === 'string' && h.command.includes(marker);
const isOurs = marked(MARKER);
const isLegacy = marked('switchboard-chat-queue');
/** A waiter gives up after a day; Claude Code may end it a little later. */
const HOOK_TIMEOUT = 86_400 + 600;
/** The hook runs in the background and wakes Claude when it exits with code 2 (Claude Code's `asyncRewake`). */
const hookEntry = () => ({ type: 'command', command: hookCommand(), asyncRewake: true, timeout: HOOK_TIMEOUT });
const isCurrent = (h: unknown) => isOurs(h) && isObj(h) && h.asyncRewake === true && h.command === hookCommand() && h.timeout === HOOK_TIMEOUT;
const stopEntries = (s: Record<string, unknown>) => (isObj(s.hooks) && Array.isArray(s.hooks.Stop) ? s.hooks.Stop : undefined);
const hasHook = (s: Record<string, unknown> | undefined, is: (h: unknown) => boolean) =>
  !!s && (stopEntries(s) ?? []).some((e) => isObj(e) && Array.isArray(e.hooks) && e.hooks.some(is));

/** Settings without the Stop hooks matching `is` (other hooks, and other entries' settings, are kept). */
function withoutHook(settings: Record<string, unknown>, is: (h: unknown) => boolean): Record<string, unknown> {
  if (!hasHook(settings, is)) return settings;
  const hooks = { ...(settings.hooks as Record<string, unknown>) };
  const stop = (stopEntries(settings) ?? [])
    .map((e) => (isObj(e) && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter((h) => !is(h)) } : e))
    .filter((e) => !(isObj(e) && Array.isArray(e.hooks) && e.hooks.length === 0));
  if (stop.length) hooks.Stop = stop;
  else delete hooks.Stop;
  const next: Record<string, unknown> = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/** Which of these Claude Code settings files have the hook (this version of it, unless `anyVersion`). */
export async function filesWithHook(files: string[], anyVersion = false): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) if (hasHook(await tryReadJson(f), anyVersion ? isOurs : isCurrent)) out.push(f);
  return out;
}

/** Adds the Stop hook to each settings file that lacks it, replacing an older version of it. Invalid JSON is left alone. */
export async function installHook(files: string[]): Promise<{ changed: string[]; failed: string[] }> {
  await ensureHookScript();
  const changed: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    let settings: Record<string, unknown> = {};
    if (await exists(file)) {
      const parsed = await tryReadJson(file);
      if (!parsed) {
        failed.push(file);
        continue;
      }
      settings = parsed;
    }
    if (hasHook(settings, isCurrent)) continue;
    const next = withoutHook(settings, isOurs);
    const hooks = isObj(next.hooks) ? next.hooks : {};
    const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
    next.hooks = { ...hooks, Stop: [...stop, { hooks: [hookEntry()] }] };
    await writeJsonInPlace(file, next);
    changed.push(file);
  }
  return { changed, failed };
}

/** Removes the hook again (any version of it), keeping every other hook. */
export async function removeHook(files: string[], is: (h: unknown) => boolean = isOurs): Promise<string[]> {
  const changed: string[] = [];
  for (const file of files) {
    const settings = await tryReadJson(file);
    if (!settings || !hasHook(settings, is)) continue;
    await writeJsonInPlace(file, withoutHook(settings, is));
    changed.push(file);
  }
  return changed;
}

/**
 * Removes the hook of an early development build. Its script is gone, so a leftover entry makes every turn end with a hook error.
 * Claude Code can put it back when it rewrites a settings file from what it loaded earlier, so this runs on every sync.
 */
export function removeLegacyHook(files: string[]): Promise<string[]> {
  return removeHook(files, isLegacy);
}

/** Chats that have a hook waiting for their next task right now, with the waiting process's id. */
export async function readWaiters(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const dir = path.join(workRoot(), 'waiters');
  for (const name of (await list(dir)).filter((n) => UUID.test(n))) {
    const pid = Number(((await readText(path.join(dir, name))) ?? '').trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) out.set(name.toLowerCase(), pid);
  }
  return out;
}

// ---------------------------------------------------------------- earlier versions

const LEGACY_MARKER = 'switchboard-chat-queue';

/**
 * An early development build queued tasks per chat in `chat-queues/<session>/` with a hook of its own. Turns each such chat's
 * waiting tasks into a queue the chat follows (task file names are compatible), then removes the old folder, hook and
 * script. Returns the number of tasks carried over.
 */
export async function migrateLegacyChatQueues(settings: string[]): Promise<number> {
  const legacy = path.join(switchboardHome(), 'chat-queues');
  let moved = 0;
  for (const sid of (await list(legacy)).filter((n) => UUID.test(n))) {
    const dir = path.join(legacy, sid);
    const tasks = (await list(dir)).filter((f) => /^\d{15}-[a-f0-9]+\.task$/.test(f)).sort();
    if (!tasks.length) continue;
    const id = await createQueue(`Earlier tasks for chat ${sid.slice(0, 8)}`);
    for (const f of tasks) if (await move(path.join(dir, f), path.join(queuesDir(), id, f))) moved++;
    const current = (await readWork()).chats.find((c) => c.sessionId === sid.toLowerCase())?.follows ?? [];
    await setFollows(sid, [...current, id]);
  }
  await fs.rm(legacy, { recursive: true, force: true });
  await removeLegacyHook(settings);
  for (const ext of ['ps1', 'sh']) await fs.rm(path.join(binDir(), `${LEGACY_MARKER}.${ext}`), { force: true });
  return moved;
}

// ---------------------------------------------------------------- running chats

export interface LiveChat {
  sessionId: string;
  cwd: string;
  name?: string;
  /** 'busy' (working) or 'idle' (waiting for the user). */
  status?: string;
}

/** Interactive Claude Code sessions from `claude agents --json`. */
export function parseAgents(stdout: string): LiveChat[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((a): a is Record<string, unknown> => isObj(a) && a.kind === 'interactive' && typeof a.sessionId === 'string' && UUID.test(a.sessionId) && typeof a.cwd === 'string')
    .map((a) => ({ sessionId: String(a.sessionId).toLowerCase(), cwd: String(a.cwd), name: typeof a.name === 'string' ? a.name : undefined, status: typeof a.status === 'string' ? a.status : undefined }));
}

/** The line Switchboard adds to the first message of a panel chat it opens (it ties the chat to its queues). */
export function startMarker(queueName: string, token: string): string {
  return `[queue: ${queueName} · ${token}]`;
}

/** Removes the start marker from a prompt or title. */
export function withoutMarker(text: string): string {
  return text.replace(/\s*\[queue: [^\]]* · sb-[a-f0-9]{10}\]\s*/g, ' ').trim();
}
