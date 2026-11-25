/**
 * Makes every profile share one Claude Code setup: settings, CLAUDE.md, skills, agents, commands,
 * plugins and project history live in the default config dir and are linked into each profile.
 * Only the login and `.claude.json` stay per profile.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { exists, tryReadJson, writeJsonInPlace } from './fsutil';
import { isInside } from './paths';

export const SHARED_DIRS = ['agents', 'commands', 'skills', 'plugins', 'output-styles', 'projects', 'file-history', 'todos', 'ide'];
export const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
/** `.claude.json` keys copied once into a new profile, so it starts with your MCP servers and without onboarding. */
const SEEDED_KEYS = ['mcpServers', 'theme', 'hasCompletedOnboarding', 'editorMode'];

export interface ShareResult {
  linked: string[];
  copied: string[];
}

async function linkFile(src: string, dest: string): Promise<'linked' | 'copied'> {
  try {
    await fs.symlink(src, dest, 'file');
    return 'linked';
  } catch {
    try {
      // Windows without Developer Mode can't create file symlinks; a hard link needs no special rights.
      await fs.link(src, dest);
      return 'linked';
    } catch {
      await fs.copyFile(src, dest);
      return 'copied';
    }
  }
}

export async function shareConfig(profileDir: string, sourceDir: string): Promise<ShareResult> {
  const result: ShareResult = { linked: [], copied: [] };
  await fs.mkdir(profileDir, { recursive: true });
  for (const name of SHARED_DIRS) {
    const src = path.join(sourceDir, name);
    const dest = path.join(profileDir, name);
    if (await exists(dest)) continue;
    await fs.mkdir(src, { recursive: true });
    // Directory junctions work on Windows without admin rights or Developer Mode.
    await fs.symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
    result.linked.push(name);
  }
  for (const name of SHARED_FILES) {
    const src = path.join(sourceDir, name);
    const dest = path.join(profileDir, name);
    if (await exists(dest)) continue;
    if (!(await exists(src))) {
      if (name !== 'settings.json') continue;
      await writeJsonInPlace(src, {}); // so settings made later are shared too
    }
    result[await linkFile(src, dest)].push(name);
  }
  return result;
}

/** Seeds a new profile's `.claude.json` with a few non-secret preferences from the default one. */
export async function seedGlobalConfig(profileGlobalConfig: string, defaultGlobalConfig: string): Promise<void> {
  if (await exists(profileGlobalConfig)) return;
  const source = await tryReadJson(defaultGlobalConfig);
  if (!source) return;
  const seed: Record<string, unknown> = {};
  for (const key of SEEDED_KEYS) if (key in source) seed[key] = source[key];
  if (Object.keys(seed).length) await writeJsonInPlace(profileGlobalConfig, seed);
}

/**
 * Deletes a profile folder created by Switchboard. Links are removed first, so the shared content they point
 * to is never touched. Refuses to delete anything outside `allowedRoot`.
 */
export async function removeProfileDir(profileDir: string, allowedRoot: string): Promise<void> {
  if (!isInside(profileDir, allowedRoot)) throw new Error(`Refusing to delete ${profileDir}: it is not inside ${allowedRoot}`);
  let entries: string[];
  try {
    entries = await fs.readdir(profileDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(profileDir, name);
    const st = await fs.lstat(p);
    if (!st.isSymbolicLink()) continue;
    try {
      await fs.unlink(p);
    } catch {
      await fs.rmdir(p); // Windows junctions
    }
  }
  // Anything still pointing elsewhere at this point would be unexpected; check before deleting recursively.
  for (const name of await fs.readdir(profileDir)) {
    if ((await fs.lstat(path.join(profileDir, name))).isSymbolicLink()) {
      throw new Error(`Refusing to delete ${profileDir}: could not remove the link ${name}`);
    }
  }
  await fs.rm(profileDir, { recursive: true, force: true });
}
