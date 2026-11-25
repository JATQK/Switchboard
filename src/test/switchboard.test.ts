/**
 * End-to-end test of the switching core against temporary config folders, with a stubbed `vscode` module.
 * Two Switchboard instances stand in for two VS Code windows.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-e2e-'));
const home = path.join(tmp, 'home');
const defaultDir = path.join(tmp, 'default');
process.env.SWITCHBOARD_HOME = home;
process.env.CLAUDE_CONFIG_DIR = defaultDir;
// Never find (or run) a real `claude` in this test: not on PATH, and not in a real ~/.local/bin either.
process.env.PATH = '';
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user-home');

// ---------------------------------------------------------------- vscode stub

const settings: Record<string, Record<string, unknown>> = { switchboard: {}, claudeCode: {} };
const notifications: string[] = [];

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T) {
    this.listeners.forEach((l) => l(e));
  }
  dispose() {
    this.listeners = [];
  }
}

const vscodeStub = {
  EventEmitter,
  MarkdownString: class {
    constructor(public value = '') {}
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, def: unknown) => (key in settings[section] ? settings[section][key] : def),
      inspect: (key: string) => ({ key, globalValue: settings[section][key] }),
      update: async (key: string, value: unknown) => {
        if (value === undefined) delete settings[section][key];
        else settings[section][key] = value;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showInformationMessage: async (m: string) => void notifications.push(m),
    showWarningMessage: async (m: string) => void notifications.push(m),
    showErrorMessage: async (m: string) => void notifications.push(m),
    createTerminal: () => ({ show() {}, dispose() {} }),
  },
  extensions: { getExtension: (id: string) => (id === 'anthropic.claude-code' ? { extensionPath: path.join(tmp, 'no-such-extension') } : undefined) },
  commands: { executeCommand: async () => undefined },
};

const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

const { Switchboard } = require('../switchboard') as typeof import('../switchboard');
const { ChatMover } = require('../chatMover') as typeof import('../chatMover');
const { projectSlug } = require('../transcripts') as typeof import('../transcripts');
const { Applier } = require('../applier') as typeof import('../applier');
const { saveProfiles, loadProfiles } = require('../profiles') as typeof import('../profiles');

// ---------------------------------------------------------------- fixtures

function envCollection() {
  const vars = new Map<string, string>();
  return {
    vars,
    description: undefined as unknown,
    replace: (k: string, v: string) => void vars.set(k, v),
    delete: (k: string) => void vars.delete(k),
  };
}
const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
function memento() {
  const m = new Map<string, unknown>();
  return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, v: unknown) => void m.set(k, v), keys: () => [...m.keys()] };
}

const profileDir = (name: string) => path.join(home, 'profiles', name);
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};
const account = (who: string) => ({ accountUuid: `${who}-uuid`, emailAddress: `${who}@example.com`, organizationName: `${who} org` });
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
function statusDump(dir: string, session: number, weekly: number, transcriptDir = dir) {
  writeJson(path.join(dir, 'switchboard-status.json'), {
    session_id: 'x',
    transcript_path: path.join(transcriptDir, 'projects', 'p', 'x.jsonl'),
    rate_limits: {
      five_hour: { used_percentage: session, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: weekly, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  });
}

type SB = InstanceType<typeof Switchboard>;
let sb: SB;
let sb2: SB;
const win1 = envCollection();
const win2 = envCollection();
const ids: Record<string, string> = {};
const byLabel = (s: SB, label: string) => s.getState().accounts.find((a) => a.label === label)!;
/** Notifications after a switch come from ChatMover, which first looks for chats on the old account. */
async function notification(pattern: RegExp): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const hit = notifications.find((n) => pattern.test(n));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}
let mover: InstanceType<typeof ChatMover>;

before(async () => {
  writeJson(path.join(defaultDir, '.claude.json'), {
    oauthAccount: account('alice'),
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      accountUuid: 'alice-uuid',
      utilization: { five_hour: { utilization: 20, resets_at: inHours(2) }, seven_day: { utilization: 40, resets_at: inHours(50) } },
    },
  });
  writeJson(path.join(profileDir('bob'), '.claude.json'), { oauthAccount: account('bob') });
  const list = await loadProfiles();
  await saveProfiles([...list, { id: 'p-bob', label: 'bob', configDir: profileDir('bob'), isDefault: false, order: 1, addedAt: 0 }]);
  settings.claudeCode.environmentVariables = [{ name: 'FOO', value: '1' }];

  sb = new Switchboard(new Applier(win1 as never, log as never), log as never, memento() as never);
  sb2 = new Switchboard(new Applier(win2 as never, log as never), log as never, memento() as never);
  mover = new ChatMover(sb, log as never);
  await sb.start();
  await sb2.start();
  ids.alice = byLabel(sb, 'Default').id;
  ids.bob = 'p-bob';
});

after(() => {
  mover.dispose();
  sb.dispose();
  sb2.dispose();
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The tests below run in order and build on each other.

test('reads accounts and usage from what Claude Code wrote', () => {
  const s = sb.getState();
  assert.equal(s.accounts.length, 2);
  const def = byLabel(sb, 'Default');
  assert.equal(def.active, true);
  assert.equal(def.email, 'alice@example.com');
  assert.equal(def.loggedIn, true);
  assert.equal(def.session?.pct, 20);
  assert.equal(def.weekly?.pct, 40);
  assert.equal(def.usageSource, 'cache');
  const bob = byLabel(sb, 'bob');
  assert.equal(bob.loggedIn, true);
  assert.equal(bob.usageAt, undefined); // no usage seen yet
  assert.equal(s.liveUsage, 'off');
  assert.equal(win1.vars.has('CLAUDE_CONFIG_DIR'), false);
});

test('switching points new terminals, the Claude Code extension and the shell file at the profile', async () => {
  assert.equal(await sb.switchTo(ids.bob, 'manual'), true);
  assert.equal(win1.vars.get('CLAUDE_CONFIG_DIR'), profileDir('bob'));
  assert.deepEqual(settings.claudeCode.environmentVariables, [
    { name: 'FOO', value: '1' },
    { name: 'CLAUDE_CONFIG_DIR', value: profileDir('bob') },
  ]);
  assert.equal(fs.readFileSync(path.join(home, 'active-config-dir'), 'utf8'), profileDir('bob'));
  assert.equal(sb.getState().activeId, ids.bob);
  assert.equal(await sb.switchTo(ids.bob, 'manual'), false); // already active
});

test('other windows follow the shared state', async () => {
  await sb2.refresh();
  assert.equal(sb2.getState().activeId, ids.bob);
  assert.equal(win2.vars.get('CLAUDE_CONFIG_DIR'), profileDir('bob'));
});

test('live usage from the status line drives auto-switch', async () => {
  statusDump(profileDir('bob'), 93, 50);
  settings.switchboard['autoSwitch.enabled'] = true;
  settings.switchboard['autoSwitch.cooldownMinutes'] = 0;
  await sb.refresh();
  const s = sb.getState();
  assert.equal(s.activeId, ids.alice);
  assert.equal(byLabel(sb, 'bob').usageSource, 'statusline');
  assert.equal(byLabel(sb, 'bob').session?.pct, 93);
  assert.ok(await notification(/Switched bob → Default \(session usage at 93%\)\. New Claude Code chats use Default\./));
  // back to default: overrides removed, unrelated entries kept
  assert.equal(win1.vars.has('CLAUDE_CONFIG_DIR'), false);
  assert.deepEqual(settings.claudeCode.environmentVariables, [{ name: 'FOO', value: '1' }]);
  assert.equal(fs.readFileSync(path.join(home, 'active-config-dir'), 'utf8'), '');
});

test('a status dump that landed in the default folder is credited to the profile it came from', async () => {
  settings.switchboard['autoSwitch.enabled'] = false;
  await new Promise((r) => setTimeout(r, 20));
  statusDump(defaultDir, 50, 55, profileDir('bob')); // transcript lives in bob's profile
  await sb.refresh();
  assert.equal(byLabel(sb, 'bob').session?.pct, 50);
  assert.equal(byLabel(sb, 'Default').usageSource, 'cache');
  assert.equal(byLabel(sb, 'Default').session?.pct, 20);
});

test('a running chat that hits a usage limit fills that window, and a switch offers to move the chat', async () => {
  // A panel chat on the default account, registered the way Claude Code does it. Its "process" is this test
  // runner, so it counts as running; the move is only offered, never accepted, so nothing is ended.
  const sessionId = '0b7c6a52-1d1e-4c51-9e3a-5f2f6a0e9b11';
  const cwd = path.join(tmp, 'work');
  const startedAt = Date.now() - 60_000;
  writeJson(path.join(defaultDir, 'sessions', `${process.pid}.json`), {
    pid: process.pid,
    sessionId,
    cwd,
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    status: 'idle',
    startedAt,
  });
  const resetAt = Math.floor(Date.now() / 1000) + 7200;
  const rejection = (at: number, type: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      apiError: 'usage_limit_reached',
      apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: resetAt, rateLimitType: type } },
      message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }] },
    });
  const transcript = path.join(defaultDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  // The first rejection predates this process (another account's, before a move) and is ignored. The second is newer
  // than Claude Code's cached usage, so it wins.
  fs.writeFileSync(transcript, [rejection(startedAt - 1000, 'seven_day'), rejection(Date.now(), 'five_hour')].join('\n') + '\n');
  // bob sees the same history, so the chat can move there.
  fs.symlinkSync(path.join(defaultDir, 'projects'), path.join(profileDir('bob'), 'projects'), process.platform === 'win32' ? 'junction' : 'dir');

  await sb.refresh();
  const def = byLabel(sb, 'Default');
  assert.equal(def.chats, 1);
  assert.equal(def.usageSource, 'limit');
  assert.equal(def.session?.pct, 100);
  assert.equal(def.session?.resetsAt, new Date(resetAt * 1000).toISOString());
  assert.equal(def.weekly?.pct, 40); // still from Claude Code's cache
  assert.equal(byLabel(sb, 'bob').chats, 0);

  notifications.length = 0;
  assert.equal(await sb.switchTo(ids.bob, 'manual'), true);
  assert.ok(await notification(/Switched to bob\. A Claude Code chat still runs on Default\. Move it to bob\?/));
  assert.ok(fs.existsSync(path.join(defaultDir, 'sessions', `${process.pid}.json`))); // offered, not moved

  fs.rmSync(path.join(defaultDir, 'sessions'), { recursive: true, force: true });
  await sb.refresh();
  assert.equal(byLabel(sb, 'Default').chats, 0);
});

test('a profile without a login is shown as logged out and cannot be switched to', async () => {
  fs.mkdirSync(profileDir('carol'), { recursive: true });
  const list = await loadProfiles();
  await saveProfiles([...list, { id: 'p-carol', label: 'carol', configDir: profileDir('carol'), isDefault: false, order: 9, addedAt: 0 }]);
  await sb.refresh();
  assert.equal(byLabel(sb, 'carol').loggedIn, false);
  await assert.rejects(sb.switchTo('p-carol', 'manual'), /not logged in/);
});

test('reordering, renaming and skipping are shared too', async () => {
  await sb.move('p-carol', -1);
  await sb.rename('p-carol', 'Carol');
  await sb.setExcluded(ids.bob, true);
  await sb2.refresh();
  const labels = sb2.getState().accounts.map((a) => a.label);
  assert.deepEqual(labels, ['Default', 'Carol', 'bob']);
  assert.equal(byLabel(sb2, 'bob').excluded, true);
});

test('removing an active profile switches to the default and deletes only Switchboard-made folders', async () => {
  await sb.switchTo(ids.bob, 'manual');
  assert.equal(sb.canDeleteFolder(ids.bob), true);
  await sb.remove(ids.bob, true);
  assert.equal(sb.getState().activeId, ids.alice);
  assert.equal(fs.existsSync(profileDir('bob')), false);
  assert.ok(fs.existsSync(path.join(defaultDir, '.claude.json')));
  assert.deepEqual(
    sb.getState().accounts.map((a) => a.label),
    ['Default', 'Carol'],
  );
  // the default profile can never be removed
  await sb.remove(ids.alice, true);
  assert.equal(sb.getState().accounts.length, 2);
});
