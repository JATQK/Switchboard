/** Compact duration: "3d 4h", "2h 14m", "12m", "<1m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "resets in 2h 14m" style helper; undefined when there is no reset time. */
export function untilReset(resetsAt: string | undefined, now = Date.now()): string | undefined {
  if (!resetsAt) return undefined;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return undefined;
  return t <= now ? 'now' : formatDuration(t - now);
}

export function formatAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const diff = now - ts;
  if (diff < 45_000) return 'just now';
  return `${formatDuration(diff)} ago`;
}

export function pct(n: number | undefined): string {
  return n === undefined ? '–' : `${Math.round(n)}%`;
}
