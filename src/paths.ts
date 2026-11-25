import * as os from 'os';
import * as path from 'path';

/** Switchboard's own folder. Overridable with SWITCHBOARD_HOME (used by the tests). */
export function switchboardHome(): string {
  return process.env.SWITCHBOARD_HOME?.trim() || path.join(os.homedir(), '.claude-switchboard');
}

export const profilesRoot = () => path.join(switchboardHome(), 'profiles');
export const registryFile = () => path.join(switchboardHome(), 'profiles.json');
export const stateFile = () => path.join(switchboardHome(), 'state.json');
/** Plain-text path of the active profile's config dir (empty for the default), for shell profiles to read. */
export const activeDirFile = () => path.join(switchboardHome(), 'active-config-dir');
export const binDir = () => path.join(switchboardHome(), 'bin');
export const statuslineBackupFile = () => path.join(switchboardHome(), 'statusline-backup.json');
export const snippetsFile = () => path.join(switchboardHome(), 'snippets.json');

/** Name of the file the status-line script writes into each config dir. */
export const STATUS_DUMP = 'switchboard-status.json';

/** The config dir Claude Code uses when Switchboard sets no override. */
export function defaultConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.claude');
}

/** Effective config dir of a profile. */
export function configDirOf(p: { isDefault: boolean; configDir: string }): string {
  return p.isDefault ? defaultConfigDir() : p.configDir;
}

/** Where Claude Code keeps `.claude.json` (account details and its usage cache) for a config dir. */
export function globalConfigFileOf(p: { isDefault: boolean; configDir: string }): string {
  if (p.isDefault && !process.env.CLAUDE_CONFIG_DIR?.trim()) return path.join(os.homedir(), '.claude.json');
  return path.join(configDirOf(p), '.claude.json');
}

/** Case/separator-insensitive path comparison key (Windows paths are case-insensitive). */
export function pathKey(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase().replace(/\//g, '\\') : resolved;
}

export function isInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c !== p && c.startsWith(p + path.sep);
}
