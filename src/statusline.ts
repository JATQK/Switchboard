/**
 * Optional "live usage": Claude Code passes rate-limit data to a user-configured status line command
 * after every assistant message. Switchboard's status line script saves that JSON into the config dir
 * (where Switchboard reads it) and prints a short usage summary as the status line.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteJson, exists, tryReadJson, writeJsonInPlace } from './fsutil';
import { binDir, STATUS_DUMP, statuslineBackupFile } from './paths';
import { isObj } from './usage';

const MARKER = 'switchboard-statusline';

const PS1 = `# Written by the Switchboard VS Code extension (safe to delete; turn off "live usage" in Switchboard to remove it from settings).
# Saves the status line data Claude Code passes in, including rate_limits, so Switchboard can show live usage,
# then prints a short usage summary as the status line.
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
$raw = [Console]::In.ReadToEnd()
$dir = $env:CLAUDE_CONFIG_DIR
if (-not $dir) { $dir = Join-Path $HOME '.claude' }
$out = Join-Path $dir '${STATUS_DUMP}'
$tmp = "$out.$PID.tmp"
try {
  [System.IO.File]::WriteAllText($tmp, $raw, $utf8)
  Move-Item -LiteralPath $tmp -Destination $out -Force
} catch {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
try {
  $r = ($raw | ConvertFrom-Json).rate_limits
  $parts = @()
  if ($r.five_hour) { $parts += ('5h ' + [math]::Floor([double]$r.five_hour.used_percentage) + '%') }
  if ($r.seven_day) { $parts += ('7d ' + [math]::Floor([double]$r.seven_day.used_percentage) + '%') }
  if ($parts.Count -gt 0) { [Console]::Out.Write(($parts -join ' | ')) }
} catch {}
`;

const SH = `#!/bin/sh
# Written by the Switchboard VS Code extension (safe to delete; turn off "live usage" in Switchboard to remove it from settings).
# Saves the status line data Claude Code passes in, including rate_limits, so Switchboard can show live usage,
# then prints a short usage summary as the status line.
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
out="$dir/${STATUS_DUMP}"
tmp="$out.$$.tmp"
json=$(cat)
if printf '%s' "$json" > "$tmp" 2>/dev/null; then mv -f "$tmp" "$out" 2>/dev/null || rm -f "$tmp"; fi
pct() {
  printf '%s' "$json" | tr -d '\\n\\r' | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*{[^}]*\\"used_percentage\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p"
}
f=$(pct five_hour)
w=$(pct seven_day)
line=""
[ -n "$f" ] && line="5h $f%"
[ -n "$w" ] && line="\${line:+$line | }7d $w%"
printf '%s' "$line"
`;

/** Script source for a platform (exposed for tests). */
export function scriptSource(kind: 'ps1' | 'sh'): string {
  return kind === 'ps1' ? PS1.replace(/\n/g, '\r\n') : SH;
}

export function scriptPath(): string {
  return path.join(binDir(), process.platform === 'win32' ? `${MARKER}.ps1` : `${MARKER}.sh`);
}

/** The statusLine command. Forward slashes so it works whether Claude Code runs it via Git Bash or PowerShell. */
export function statuslineCommand(): string {
  const script = scriptPath();
  return process.platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script.replace(/\\/g, '/')}"`
    : `sh "${script}"`;
}

export function isOurCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(MARKER);
}

/** (Re)writes the scripts so they always match this version of the extension. */
export async function ensureScripts(): Promise<void> {
  await fs.mkdir(binDir(), { recursive: true });
  const file = scriptPath();
  const content = scriptSource(process.platform === 'win32' ? 'ps1' : 'sh');
  const current = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (current !== content) await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o755 });
}

/** Distinct settings.json files for the given config dirs (profiles that share one via a link count once). */
export async function settingsFiles(configDirs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of configDirs) {
    const file = path.join(dir, 'settings.json');
    let key: string;
    try {
      const st = await fs.stat(file);
      key = `${st.dev}:${st.ino}`;
    } catch {
      key = path.resolve(file).toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  return files;
}

export type LiveUsageState = 'on' | 'off' | 'partial';

export interface LiveUsageReport {
  state: LiveUsageState;
  /** Settings files that already have a different status line. */
  foreign: string[];
}

export async function inspect(files: string[]): Promise<LiveUsageReport> {
  let ours = 0;
  const foreign: string[] = [];
  for (const file of files) {
    const s = (await tryReadJson(file))?.statusLine;
    if (isObj(s) && isOurCommand(s.command)) ours++;
    else if (isObj(s) && s.command) foreign.push(file);
  }
  return { state: ours === 0 ? 'off' : ours === files.length ? 'on' : 'partial', foreign };
}

type Backup = Record<string, unknown>;

/** Installs our status line in every file. Existing status lines are backed up for `disable`. */
export async function enable(files: string[]): Promise<{ changed: string[]; failed: string[] }> {
  await ensureScripts();
  const backup: Backup = (await tryReadJson(statuslineBackupFile())) ?? {};
  const changed: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    let settings: Record<string, unknown>;
    if (await exists(file)) {
      const parsed = await tryReadJson(file);
      if (!parsed) {
        failed.push(file); // not valid JSON: leave it alone
        continue;
      }
      settings = parsed;
    } else {
      settings = {};
    }
    const current = settings.statusLine;
    if (isObj(current) && isOurCommand(current.command)) continue;
    if (current !== undefined) backup[path.resolve(file)] = current;
    settings.statusLine = { type: 'command', command: statuslineCommand(), padding: 0 };
    await writeJsonInPlace(file, settings);
    changed.push(file);
  }
  await atomicWriteJson(statuslineBackupFile(), backup);
  return { changed, failed };
}

/** Removes our status line again, restoring whatever was there before. */
export async function disable(files: string[]): Promise<string[]> {
  const backup: Backup = (await tryReadJson(statuslineBackupFile())) ?? {};
  const changed: string[] = [];
  for (const file of files) {
    const settings = await tryReadJson(file);
    if (!settings || !isObj(settings.statusLine) || !isOurCommand(settings.statusLine.command)) continue;
    const key = path.resolve(file);
    if (key in backup) {
      settings.statusLine = backup[key];
      delete backup[key];
    } else {
      delete settings.statusLine;
    }
    await writeJsonInPlace(file, settings);
    changed.push(file);
  }
  await atomicWriteJson(statuslineBackupFile(), backup);
  return changed;
}
