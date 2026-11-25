import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { envFor } from './env';
import { isObj } from './usage';

export { envFor };

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Finds `claude`: the setting, then PATH, then ~/.local/bin, then the binary bundled with the Claude Code extension. */
export async function findClaudeExecutable(setting: string): Promise<string | undefined> {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const candidates: string[] = [];
  if (setting.trim()) candidates.push(setting.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(...names.map((n) => path.join(dir, n)));
  }
  candidates.push(...names.map((n) => path.join(os.homedir(), '.local', 'bin', n)));
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) candidates.push(...names.map((n) => path.join(ext.extensionPath, 'resources', 'native-binary', n)));
  for (const c of candidates) {
    if (await isFile(c)) return c;
  }
  return undefined;
}

const isScript = (exe: string) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** Runs `claude <args>` non-interactively against a config dir (undefined = Claude Code's default). */
export function runClaude(claude: string, args: string[], configDir: string | undefined): Promise<{ ok: boolean; stdout: string }> {
  const [cmd, argv] = isScript(claude) ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${claude}" ${args.join(' ')}`]] : [claude, args];
  return new Promise((resolve) => {
    execFile(cmd, argv, { env: envFor(configDir), timeout: 20_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout ?? '') }),
    );
  });
}

/** Runs `claude auth status --json`: Claude Code's own answer to "who is logged in here?". */
export async function authStatus(claude: string, configDir: string | undefined): Promise<AuthStatus | undefined> {
  const { stdout } = await runClaude(claude, ['auth', 'status', '--json'], configDir);
  try {
    const j: unknown = JSON.parse(stdout.trim());
    if (!isObj(j) || typeof j.loggedIn !== 'boolean') return undefined;
    return {
      loggedIn: j.loggedIn && j.authMethod !== 'none',
      email: typeof j.email === 'string' ? j.email : undefined,
      orgName: typeof j.orgName === 'string' ? j.orgName : undefined,
      subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined,
    };
  } catch {
    return undefined;
  }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Process to launch for running `claude <args>` against a config dir in a terminal.
 * CLAUDE_CONFIG_DIR is set (or removed) by the launched command itself, because VS Code applies extension
 * environment collections (which carry the *active* profile) on top of a terminal's own `env`.
 */
export function launchSpec(claude: string, args: string[], configDir: string | undefined, platform = process.platform): { shellPath: string; shellArgs: string[] } {
  if (platform === 'win32') {
    const setVar = configDir ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(configDir)}` : 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue';
    // Windows PowerShell 5.1 drops double quotes inside arguments it passes to a program; escape them the way the
    // program's C runtime reads them back (\" and doubled backslashes before a quote or the end of a quoted argument).
    const native = (a: string) => {
      const escaped = a.replace(/(\\*)"/g, '$1$1\\"');
      return /\s/.test(a) ? escaped.replace(/(\\+)$/, '$1$1') : escaped;
    };
    const run = `& ${psQuote(claude)} ${args.map((a) => psQuote(native(a))).join(' ')}`.trimEnd();
    return { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${setVar}; ${run}; exit $LASTEXITCODE`] };
  }
  return {
    shellPath: '/usr/bin/env',
    shellArgs: configDir ? [`CLAUDE_CONFIG_DIR=${configDir}`, claude, ...args] : ['-u', 'CLAUDE_CONFIG_DIR', claude, ...args],
  };
}

/** Terminal options that run `claude <args>` against a config dir. */
export function claudeTerminalOptions(claude: string, args: string[], configDir: string | undefined, name: string): vscode.TerminalOptions {
  return { name, ...launchSpec(claude, args, configDir), iconPath: new vscode.ThemeIcon('account') };
}
