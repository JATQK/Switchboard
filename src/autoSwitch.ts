/**
 * Pure auto-switch decision logic. No VS Code or I/O here so it can be unit tested.
 */

export type Strategy = 'mostHeadroom' | 'priority' | 'soonestWeeklyReset';

/** Reset times closer than this count as equal (the API's reset timestamps jitter slightly). */
const SAME_RESET_MS = 60_000;
/** soonestWeeklyReset only moves proactively when the other account's weekly limit resets at least this much sooner. */
const DEFAULT_RESET_GAP_MS = 60 * 60_000;

export interface Candidate {
  id: string;
  order: number;
  excluded?: boolean;
  /** Usage is known and recent enough to act on. */
  healthy: boolean;
  /** Logged in, but no usage seen yet: only used as a last resort when every known account is at its limit. */
  unknownUsage?: boolean;
  /** Effective session usage in percent (0 once the window has reset). */
  session?: number;
  /** Effective weekly usage in percent. */
  weekly?: number;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
}

export interface Policy {
  sessionThreshold: number;
  weeklyThreshold: number;
  strategy: Strategy;
  /**
   * Allow proactive moves while the active account is still under its limits: back to a higher-priority
   * account (priority), or to one whose weekly limit resets sooner (soonestWeeklyReset).
   * Turned off after a manual switch so the user's choice sticks.
   */
  allowReturn: boolean;
  /** Extra headroom (percentage points) an account needs before we move to it proactively. */
  returnMargin?: number;
  /** Minimum difference in weekly reset time for a proactive soonestWeeklyReset move. */
  resetGapMs?: number;
}

export type Decision =
  | { kind: 'stay' }
  | { kind: 'switch'; targetId: string; reason: string }
  | { kind: 'exhausted'; reason: string; nextResetAt?: string };

export function limitHit(c: Candidate, p: Policy): 'session' | 'weekly' | undefined {
  if ((c.weekly ?? 0) >= p.weeklyThreshold) return 'weekly';
  if ((c.session ?? 0) >= p.sessionThreshold) return 'session';
  return undefined;
}

export function hasCapacity(c: Candidate, p: Policy, margin = 0): boolean {
  return c.healthy && (c.session ?? 0) < p.sessionThreshold - margin && (c.weekly ?? 0) < p.weeklyThreshold - margin;
}

/** 0 = idle, 1 = at the threshold of whichever limit is closest. */
export function load(c: Candidate, p: Policy): number {
  return Math.max((c.session ?? 0) / p.sessionThreshold, (c.weekly ?? 0) / p.weeklyThreshold);
}

/** When the account regains capacity (ISO string), if it is currently blocked. */
export function capacityReturnsAt(c: Candidate, p: Policy): string | undefined {
  if ((c.weekly ?? 0) >= p.weeklyThreshold) return c.weeklyResetsAt;
  if ((c.session ?? 0) >= p.sessionThreshold) return c.sessionResetsAt;
  return undefined;
}

function byOrder(a: Candidate, b: Candidate): number {
  return a.order - b.order;
}

/**
 * Epoch ms of the next weekly reset. A window with no reset time hasn't started yet (it starts on first use
 * and then lasts a full week), so it sorts last.
 */
export function weeklyResetTime(c: Candidate): number {
  const t = c.weeklyResetsAt ? Date.parse(c.weeklyResetsAt) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Soonest weekly reset first; near-equal resets fall back to most headroom, then list order. */
function bySoonestWeeklyReset(p: Policy) {
  return (a: Candidate, b: Candidate): number => {
    const ta = weeklyResetTime(a);
    const tb = weeklyResetTime(b);
    const same = ta === tb || (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < SAME_RESET_MS);
    if (!same) return ta < tb ? -1 : 1;
    return load(a, p) - load(b, p) || byOrder(a, b);
  };
}

function pickTarget(others: Candidate[], p: Policy): Candidate {
  switch (p.strategy) {
    case 'priority':
      return [...others].sort(byOrder)[0];
    case 'soonestWeeklyReset':
      return [...others].sort(bySoonestWeeklyReset(p))[0];
    default:
      return [...others].sort((a, b) => load(a, p) - load(b, p) || byOrder(a, b))[0];
  }
}

export function decide(activeId: string, candidates: Candidate[], p: Policy): Decision {
  const active = candidates.find((c) => c.id === activeId);
  // Without fresh data for the active account we cannot judge; never switch blindly.
  if (!active || !active.healthy) return { kind: 'stay' };

  const others = candidates.filter((c) => c.id !== activeId && !c.excluded && hasCapacity(c, p));
  const hit = limitHit(active, p);

  if (hit) {
    const usedPct = Math.round((hit === 'session' ? active.session : active.weekly) ?? 0);
    const label = `${hit === 'session' ? 'session' : 'weekly'} usage at ${usedPct}%`;
    if (!others.length) {
      const untried = candidates.filter((c) => c.id !== activeId && !c.excluded && c.unknownUsage).sort(byOrder)[0];
      if (untried) return { kind: 'switch', targetId: untried.id, reason: `${label}; trying an account without usage data yet` };
      const resets = candidates
        .filter((c) => c.id === activeId || !c.excluded)
        .map((c) => capacityReturnsAt(c, p))
        .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      return { kind: 'exhausted', reason: label, nextResetAt: resets[0] };
    }
    return { kind: 'switch', targetId: pickTarget(others, p).id, reason: label };
  }

  if (!p.allowReturn) return { kind: 'stay' };
  const margin = p.returnMargin ?? 10;

  if (p.strategy === 'priority') {
    const preferred = others.filter((c) => c.order < active.order && hasCapacity(c, p, margin)).sort(byOrder)[0];
    if (preferred) return { kind: 'switch', targetId: preferred.id, reason: 'preferred account has capacity again' };
  }

  if (p.strategy === 'soonestWeeklyReset') {
    // Use weekly quota that expires soonest: move to an account whose weekly limit resets clearly earlier
    // than the active one's, as soon as it has session room. Stable: an account only drops back in the
    // ranking when its own weekly window resets.
    // The margin applies to the session only (no point switching for a sliver of session); the weekly quota
    // is meant to be used up to the threshold, since it expires anyway.
    const cutoff = weeklyResetTime(active) - (p.resetGapMs ?? DEFAULT_RESET_GAP_MS);
    const sooner = others
      .filter((c) => (c.session ?? 0) < p.sessionThreshold - margin && weeklyResetTime(c) < cutoff)
      .sort(bySoonestWeeklyReset(p))[0];
    if (sooner) return { kind: 'switch', targetId: sooner.id, reason: 'its weekly limit resets sooner' };
  }

  return { kind: 'stay' };
}
