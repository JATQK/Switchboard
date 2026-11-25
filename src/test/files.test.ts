/** Tests for the parts that touch the file system: status line scripts/settings and config sharing. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-files-'));
process.env.SWITCHBOARD_HOME = path.join(tmp, 'home');
import * as sharing from '../sharing';
import * as statusline from '../statusline';

before(() => fs.mkdirSync(process.env.SWITCHBOARD_HOME!, { recursive: true }));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SAMPLE = JSON.stringify({
  session_id: 's1',
  transcript_path: '/x/projects/p/s1.jsonl',
  rate_limits: { five_hour: { used_percentage: 23.7, resets_at: 1738425600 }, seven_day: { resets_at: 1738857600, used_percentage: 41.2 } },
});

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const hasPowerShell = process.platform === 'win32';

function run(kind: 'ps1' | 'sh', configDir: string, input: string): string {
  const file = path.join(tmp, `script.${kind}`);
  fs.writeFileSync(file, statusline.scriptSource(kind));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  const r =
    kind === 'ps1'
      ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { input, env, encoding: 'utf8' })
      : spawnSync('sh', [file], { input, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

for (const kind of ['ps1', 'sh'] as const) {
  test(`the ${kind} status line script saves the JSON and prints a usage summary`, { skip: kind === 'ps1' ? !hasPowerShell : !hasSh }, () => {
    const dir = fs.mkdtempSync(path.join(tmp, `cfg-${kind}-`));
    assert.equal(run(kind, dir, SAMPLE), '5h 23% | 7d 41%');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'switchboard-status.json'), 'utf8')), JSON.parse(SAMPLE));
    // No rate limits (e.g. API key users): empty status line, data still saved.
    assert.equal(run(kind, dir, JSON.stringify({ session_id: 's2' })), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'switchboard-status.json'), 'utf8')), { session_id: 's2' });
  });
}

test('the status line command uses forward slashes (required for Git Bash on Windows)', () => {
  assert.ok(!statusline.statuslineCommand().includes('\\'));
  assert.ok(statusline.isOurCommand(statusline.statuslineCommand()));
});

test('turning live usage on and off keeps and restores an existing status line', async () => {
  const a = path.join(tmp, 'set-a');
  const b = path.join(tmp, 'set-b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'settings.json'), JSON.stringify({ model: 'x', statusLine: { type: 'command', command: 'my-line' } }));
  const files = await statusline.settingsFiles([a, b]);
  assert.equal(files.length, 2);
  assert.deepEqual((await statusline.inspect(files)).foreign, [path.join(a, 'settings.json')]);

  await statusline.enable(files);
  assert.equal((await statusline.inspect(files)).state, 'on');
  const sa = JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8'));
  assert.equal(sa.model, 'x');
  assert.ok(statusline.isOurCommand(sa.statusLine.command));

  await statusline.disable(files);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8')), { model: 'x', statusLine: { type: 'command', command: 'my-line' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'settings.json'), 'utf8')), {});
  assert.equal((await statusline.inspect(files)).state, 'off');
});

test('leaves settings files that are not valid JSON alone', async () => {
  const c = path.join(tmp, 'set-c');
  fs.mkdirSync(c);
  fs.writeFileSync(path.join(c, 'settings.json'), '{ not json');
  const { failed } = await statusline.enable([path.join(c, 'settings.json')]);
  assert.equal(failed.length, 1);
  assert.equal(fs.readFileSync(path.join(c, 'settings.json'), 'utf8'), '{ not json');
});

test('profiles share config through links, and deleting a profile never touches the shared content', async () => {
  const source = path.join(tmp, 'default-cfg');
  fs.mkdirSync(path.join(source, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', 'my-skill', 'SKILL.md'), 'hello');
  fs.writeFileSync(path.join(source, 'CLAUDE.md'), 'memory');
  const root = path.join(tmp, 'home', 'profiles');
  const profile = path.join(root, 'work');

  const res = await sharing.shareConfig(profile, source);
  assert.ok(res.linked.includes('skills') && res.linked.includes('projects'));
  assert.equal(fs.readFileSync(path.join(profile, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(profile, 'CLAUDE.md'), 'utf8'), 'memory');
  // settings.json is created in the source so later settings are shared too, and counts once for live usage
  assert.ok(fs.existsSync(path.join(source, 'settings.json')));
  assert.equal((await statusline.settingsFiles([source, profile])).length, res.copied.includes('settings.json') ? 2 : 1);
  // what Claude Code writes into the profile's projects folder lands in the shared one
  fs.writeFileSync(path.join(profile, 'projects', 'transcript.jsonl'), '{}');
  assert.ok(fs.existsSync(path.join(source, 'projects', 'transcript.jsonl')));

  fs.writeFileSync(path.join(profile, '.credentials.json'), '{}');
  await sharing.removeProfileDir(profile, root);
  assert.equal(fs.existsSync(profile), false);
  assert.equal(fs.readFileSync(path.join(source, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(source, 'CLAUDE.md'), 'utf8'), 'memory');
  assert.ok(fs.existsSync(path.join(source, 'projects', 'transcript.jsonl')));
});

test('refuses to delete folders outside the profiles root', async () => {
  const outside = path.join(tmp, 'not-a-profile');
  fs.mkdirSync(outside);
  await assert.rejects(sharing.removeProfileDir(outside, path.join(tmp, 'home', 'profiles')), /Refusing/);
  assert.ok(fs.existsSync(outside));
});

test('seeds a new profile with non-secret preferences only', async () => {
  const def = path.join(tmp, 'def.json');
  fs.writeFileSync(def, JSON.stringify({ mcpServers: { a: { command: 'x' } }, theme: 'dark', oauthAccount: { accountUuid: 'u' }, cachedUsageUtilization: {} }));
  const target = path.join(tmp, 'seeded', '.claude.json');
  await sharing.seedGlobalConfig(target, def);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { mcpServers: { a: { command: 'x' } }, theme: 'dark' });
});
