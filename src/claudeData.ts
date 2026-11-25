/**
 * Reads what Claude Code itself writes into a config dir. Never touches credentials:
 * `.credentials.json` / the keychain are left entirely to Claude Code.
 */
import * as path from 'path';
import { mtimeMs, tryReadJson } from './fsutil';
import { STATUS_DUMP } from './paths';
import { isObj, parseCachedUsage, parseStatusRateLimits } from './usage';
import type { AccountInfo, UsageReading } from './types';

export interface ConfigSnapshot {
  /** From `oauthAccount`; undefined when Claude Code has no claude.ai login recorded there. */
  account?: Omit<AccountInfo, 'loggedIn' | 'plan'>;
  /** Claude Code's own cached copy of the usage meters. */
  cached?: UsageReading & { accountUuid?: string };
}

export async function readConfigSnapshot(globalConfigFile: string): Promise<ConfigSnapshot> {
  const cfg = await tryReadJson(globalConfigFile);
  if (!cfg) return {};
  const snap: ConfigSnapshot = {};
  const acct = cfg.oauthAccount;
  if (isObj(acct) && typeof acct.accountUuid === 'string') {
    snap.account = {
      accountUuid: acct.accountUuid,
      email: typeof acct.emailAddress === 'string' ? acct.emailAddress : undefined,
      organizationName: typeof acct.organizationName === 'string' ? acct.organizationName : undefined,
    };
  }
  const c = cfg.cachedUsageUtilization;
  if (isObj(c) && typeof c.fetchedAtMs === 'number' && isObj(c.utilization)) {
    snap.cached = {
      usage: parseCachedUsage(c.utilization),
      at: c.fetchedAtMs,
      source: 'cache',
      accountUuid: typeof c.accountUuid === 'string' ? c.accountUuid : undefined,
    };
  }
  return snap;
}

export interface StatusDump extends UsageReading {
  transcriptPath?: string;
}

/** The status line JSON our status-line script saved into the config dir, if it has rate-limit data. */
export async function readStatusDump(configDir: string): Promise<StatusDump | undefined> {
  const file = path.join(configDir, STATUS_DUMP);
  const at = await mtimeMs(file);
  if (at === undefined) return undefined;
  const json = await tryReadJson(file);
  const usage = parseStatusRateLimits(json?.rate_limits);
  if (!usage) return undefined;
  return {
    usage,
    at,
    source: 'statusline',
    transcriptPath: typeof json?.transcript_path === 'string' ? json.transcript_path : undefined,
  };
}

/** Picks the most recent of several readings. */
export function newest<T extends UsageReading>(...readings: (T | undefined)[]): T | undefined {
  return readings.filter((r): r is T => !!r).sort((a, b) => b.at - a.at)[0];
}
