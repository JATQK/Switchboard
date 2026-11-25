/** Runs inside the VS Code extension host started by runTest.ts. */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function run(): Promise<void> {
  const home = process.env.SWITCHBOARD_HOME!;
  const defaultDir = process.env.CLAUDE_CONFIG_DIR!;
  const bobDir = path.join(home, 'profiles', 'bob');
  for (const [dir, who] of [
    [defaultDir, 'alice'],
    [bobDir, 'bob'],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: `${who}-uuid`, emailAddress: `${who}@example.com` } }));
  }
  fs.writeFileSync(
    path.join(home, 'profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        { id: 'default', label: 'Default', configDir: '', isDefault: true, order: 0, addedAt: 0 },
        { id: 'p-bob', label: 'bob', configDir: bobDir, isDefault: false, order: 1, addedAt: 0 },
      ],
    }),
  );
  await vscode.workspace.getConfiguration('switchboard').update('claudePath', process.env.SWITCHBOARD_CLAUDE_PATH, vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.getExtension('jatqk.switchboard-accounts');
  assert.ok(ext, 'extension is installed');
  await ext.activate();
  assert.ok(ext.isActive, 'extension activated');

  // Contributed commands are registered.
  const commands = await vscode.commands.getCommands(true);
  for (const c of (ext.packageJSON.contributes.commands as { command: string }[]).map((x) => x.command)) {
    assert.ok(commands.includes(c), `command ${c} is registered`);
  }

  // Startup wrote the status line script; nothing was switched yet.
  await waitFor('status line script', () => fs.existsSync(path.join(home, 'bin')) && fs.readdirSync(path.join(home, 'bin')).length > 0);
  await vscode.commands.executeCommand('switchboard.refresh');

  // The sidebar view resolves.
  await vscode.commands.executeCommand('switchboard.panel.focus');
  await sleep(500);

  // Switch to bob and back.
  await vscode.commands.executeCommand('switchboard.switchAccount', 'p-bob');
  assert.equal(readJson(path.join(home, 'state.json')).activeId, 'p-bob');
  assert.equal(fs.readFileSync(path.join(home, 'active-config-dir'), 'utf8'), bobDir);
  await vscode.commands.executeCommand('switchboard.switchAccount', 'default');
  assert.equal(readJson(path.join(home, 'state.json')).activeId, 'default');
  assert.equal(fs.readFileSync(path.join(home, 'active-config-dir'), 'utf8'), '');

  // Live usage on/off edits Claude Code's settings.json in every profile.
  await vscode.commands.executeCommand('switchboard.enableLiveUsage');
  for (const dir of [defaultDir, bobDir]) {
    assert.match(readJson(path.join(dir, 'settings.json')).statusLine.command, /switchboard-statusline/);
  }
  await vscode.commands.executeCommand('switchboard.disableLiveUsage');
  for (const dir of [defaultDir, bobDir]) {
    assert.equal(readJson(path.join(dir, 'settings.json')).statusLine, undefined);
  }

  // Auto-switch toggle writes the user setting.
  await vscode.commands.executeCommand('switchboard.toggleAutoSwitch');
  assert.equal(vscode.workspace.getConfiguration('switchboard').get('autoSwitch.enabled'), true);
  await vscode.commands.executeCommand('switchboard.toggleAutoSwitch');
  assert.equal(vscode.workspace.getConfiguration('switchboard').get('autoSwitch.enabled'), false);

  // A status line reading over the threshold makes auto-switch move to bob.
  await vscode.workspace.getConfiguration('switchboard').update('autoSwitch.cooldownMinutes', 0, vscode.ConfigurationTarget.Global);
  fs.writeFileSync(
    path.join(defaultDir, 'switchboard-status.json'),
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 97, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }),
  );
  fs.writeFileSync(
    path.join(bobDir, 'switchboard-status.json'),
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }),
  );
  await vscode.workspace.getConfiguration('switchboard').update('autoSwitch.enabled', true, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('switchboard.refresh');
  await waitFor('auto-switch to bob', () => readJson(path.join(home, 'state.json')).activeId === 'p-bob');
  await vscode.workspace.getConfiguration('switchboard').update('autoSwitch.enabled', false, vscode.ConfigurationTarget.Global);
}
