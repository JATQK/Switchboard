import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return { ThemeIcon: class {}, extensions: { getExtension: () => undefined } };
  return originalLoad.call(this, request, ...rest);
};
const { launchSpec } = require('../cli') as typeof import('../cli');
Module._load = originalLoad;

test('POSIX terminals set or remove CLAUDE_CONFIG_DIR via env, without a shell', () => {
  assert.deepEqual(launchSpec('/bin/claude', ['auth', 'login'], '/home/u/p 1', 'linux'), {
    shellPath: '/usr/bin/env',
    shellArgs: ['CLAUDE_CONFIG_DIR=/home/u/p 1', '/bin/claude', 'auth', 'login'],
  });
  assert.deepEqual(launchSpec('/bin/claude', [], undefined, 'darwin').shellArgs, ['-u', 'CLAUDE_CONFIG_DIR', '/bin/claude']);
});

test("Windows terminals quote paths for PowerShell (including ones with ' and spaces)", () => {
  const spec = launchSpec("C:\\Program Files\\claude.exe", ['auth', 'login', '--email', 'a@b.c'], "C:\\Users\\O'Brien\\p", 'win32');
  assert.equal(spec.shellPath, 'powershell.exe');
  const cmd = spec.shellArgs.at(-1)!;
  assert.match(cmd, /^\$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O''Brien\\p'; & 'C:\\Program Files\\claude\.exe' 'auth' 'login' '--email' 'a@b\.c'; exit \$LASTEXITCODE$/);
  assert.match(launchSpec('claude.exe', [], undefined, 'win32').shellArgs.at(-1)!, /^Remove-Item Env:CLAUDE_CONFIG_DIR/);
});

test('the Windows launch command passes arguments through unchanged (quotes, line breaks, backslashes)', { skip: process.platform !== 'win32' }, () => {
  // A first task for a queue chat goes on the command line; Windows PowerShell 5.1 would drop its double quotes.
  const args = ['Fix "quotes", it\'s fine,\nsecond line & $dollar %PATH% `tick', 'say \\"hi\\" there', 'ends with a backslash \\', 'plain'];
  const spec = launchSpec(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], undefined, 'win32');
  const r = spawnSync(spec.shellPath, spec.shellArgs, { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout.trim()), args);
});

test('the Windows launch command really sets the variable for the child process', { skip: process.platform !== 'win32' }, () => {
  // Stand-in for claude: print the variable the child sees, even when the parent env has another value.
  const spec = launchSpec('powershell.exe', ['-NoProfile', '-Command', 'Write-Output $env:CLAUDE_CONFIG_DIR'], "C:\\x\\it's here", 'win32');
  const r = spawnSync(spec.shellPath, spec.shellArgs, { env: { ...process.env, CLAUDE_CONFIG_DIR: 'C:\\wrong' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), "C:\\x\\it's here");
  const cleared = launchSpec('powershell.exe', ['-NoProfile', '-Command', 'Write-Output "[$env:CLAUDE_CONFIG_DIR]"'], undefined, 'win32');
  const r2 = spawnSync(cleared.shellPath, cleared.shellArgs, { env: { ...process.env, CLAUDE_CONFIG_DIR: 'C:\\wrong' }, encoding: 'utf8' });
  assert.equal(r2.stdout.trim(), '[]');
});

test('the POSIX launch command really sets the variable for the child process', { skip: process.platform === 'win32' }, () => {
  const spec = launchSpec('/bin/sh', ['-c', 'printf %s "$CLAUDE_CONFIG_DIR"'], '/tmp/x y', process.platform);
  const r = spawnSync(spec.shellPath, spec.shellArgs, { env: { ...process.env, CLAUDE_CONFIG_DIR: '/wrong' }, encoding: 'utf8' });
  assert.equal(r.stdout, '/tmp/x y');
});
