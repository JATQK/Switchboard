import { randomBytes } from 'crypto';
import { atomicWriteJson, tryReadJson } from './fsutil';
import { registryFile, stateFile } from './paths';
import { isObj } from './usage';
import type { Profile } from './types';

export const DEFAULT_ID = 'default';

export function defaultProfile(order = 0): Profile {
  return { id: DEFAULT_ID, label: 'Default', configDir: '', isDefault: true, order, addedAt: Date.now() };
}

function isProfile(v: unknown): v is Profile {
  return isObj(v) && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.configDir === 'string' && typeof v.order === 'number';
}

/** Saved profiles, sorted. Always contains the default profile. */
export async function loadProfiles(): Promise<Profile[]> {
  const raw = await tryReadJson(registryFile());
  const list = Array.isArray(raw?.profiles) ? raw.profiles.filter(isProfile).map((p) => ({ ...p, isDefault: p.id === DEFAULT_ID })) : [];
  if (!list.some((p) => p.isDefault)) list.unshift(defaultProfile(list.length ? Math.min(...list.map((p) => p.order)) - 1 : 0));
  return list.sort((a, b) => a.order - b.order);
}

export async function saveProfiles(list: Profile[]): Promise<void> {
  const normalized = [...list].sort((a, b) => a.order - b.order).map((p, i) => ({ ...p, order: i }));
  await atomicWriteJson(registryFile(), { version: 1, profiles: normalized });
}

export function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Folder-name-safe slug for a new profile directory. */
export function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'account';
}

export interface SharedState {
  activeId: string;
  /** Epoch ms of the last switch (manual or automatic); drives the cooldown across windows. */
  switchedAt: number;
  /** After a manual switch, don't move proactively until a limit forces it. */
  manualHold: boolean;
  /** Profile id we last warned "all accounts exhausted" for, so only one window warns, once. */
  exhaustedNotice?: string;
}

export async function loadState(): Promise<SharedState> {
  const raw = await tryReadJson(stateFile());
  return {
    activeId: typeof raw?.activeId === 'string' ? raw.activeId : DEFAULT_ID,
    switchedAt: typeof raw?.switchedAt === 'number' ? raw.switchedAt : 0,
    manualHold: raw?.manualHold === true,
    exhaustedNotice: typeof raw?.exhaustedNotice === 'string' ? raw.exhaustedNotice : undefined,
  };
}

export async function saveState(state: SharedState): Promise<void> {
  await atomicWriteJson(stateFile(), state);
}
