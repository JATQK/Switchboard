import type { Usage, UsageWindow } from './types';

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

function cacheWindow(v: unknown): UsageWindow | undefined {
  if (!isObj(v)) return undefined;
  const pct = typeof v.utilization === 'number' ? v.utilization : v.percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = typeof v.resets_at === 'string' && v.resets_at ? v.resets_at : undefined;
  return { utilization: clampPct(pct), resetsAt };
}

/** Parses Claude Code's cached usage (`cachedUsageUtilization.utilization` in `.claude.json`). */
export function parseCachedUsage(json: unknown): Usage {
  if (!isObj(json)) return {};
  const usage: Usage = { session: cacheWindow(json.five_hour), weekly: cacheWindow(json.seven_day) };
  if (Array.isArray(json.limits)) {
    for (const limit of json.limits) {
      if (!isObj(limit)) continue;
      if (!usage.session && limit.kind === 'session') usage.session = cacheWindow(limit);
      if (!usage.weekly && limit.kind === 'weekly_all') usage.weekly = cacheWindow(limit);
    }
  }
  return usage;
}

function statusWindow(v: unknown): UsageWindow | undefined {
  if (!isObj(v) || typeof v.used_percentage !== 'number' || !Number.isFinite(v.used_percentage)) return undefined;
  const r = v.resets_at;
  const resetsAt =
    typeof r === 'number' && Number.isFinite(r)
      ? new Date(r * 1000).toISOString()
      : typeof r === 'string' && r
        ? r
        : undefined;
  return { utilization: clampPct(v.used_percentage), resetsAt };
}

/**
 * Parses `rate_limits` from the JSON Claude Code sends to the status line command
 * (`five_hour` / `seven_day` with `used_percentage` and `resets_at` in epoch seconds).
 * Returns undefined when there is no rate-limit data. Claude Code drops a window once it has reset,
 * so a missing window next to a present one means 0%.
 */
export function parseStatusRateLimits(rateLimits: unknown): Usage | undefined {
  if (!isObj(rateLimits)) return undefined;
  const session = statusWindow(rateLimits.five_hour);
  const weekly = statusWindow(rateLimits.seven_day);
  if (!session && !weekly) return undefined;
  return { session: session ?? { utilization: 0 }, weekly: weekly ?? { utilization: 0 } };
}

/** Usage percentage, treating a window whose reset time has passed as empty. */
export function effectivePct(w: UsageWindow | undefined, now = Date.now()): number | undefined {
  if (!w) return undefined;
  if (w.resetsAt) {
    const t = Date.parse(w.resetsAt);
    if (!Number.isNaN(t) && t <= now) return 0;
  }
  return w.utilization;
}

/** Reset time if it is still ahead; a passed reset means a fresh window that hasn't started yet. */
export function upcomingReset(w: UsageWindow | undefined, now = Date.now()): string | undefined {
  if (!w?.resetsAt) return undefined;
  const t = Date.parse(w.resetsAt);
  return Number.isNaN(t) || t <= now ? undefined : w.resetsAt;
}

export function planLabel(subscriptionType?: string, rateLimitTier?: string): string | undefined {
  const multiplier = rateLimitTier?.match(/max_(\d+)x/i)?.[1];
  if (subscriptionType === 'max' || multiplier) return multiplier ? `Max ${multiplier}x` : 'Max';
  if (!subscriptionType) return undefined;
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}
