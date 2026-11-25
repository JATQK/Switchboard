import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, untilReset } from '../format';
import { effectivePct, parseCachedUsage, parseStatusRateLimits, planLabel, upcomingReset } from '../usage';

test("parses Claude Code's cached usage", () => {
  const u = parseCachedUsage({
    five_hour: { utilization: 34, resets_at: '2026-11-22T17:30:00.385817+00:00', limit_dollars: null },
    seven_day: { utilization: 73, resets_at: '2026-11-22T22:00:00.385837+00:00' },
    seven_day_opus: null,
  });
  assert.deepEqual(u.session, { utilization: 34, resetsAt: '2026-11-22T17:30:00.385817+00:00' });
  assert.deepEqual(u.weekly, { utilization: 73, resetsAt: '2026-11-22T22:00:00.385837+00:00' });
});

test('cached usage falls back to the limits array', () => {
  const u = parseCachedUsage({
    five_hour: null,
    limits: [
      { kind: 'session', percent: 16, resets_at: 'x' },
      { kind: 'weekly_all', percent: 70, resets_at: null },
    ],
  });
  assert.deepEqual(u.session, { utilization: 16, resetsAt: 'x' });
  assert.deepEqual(u.weekly, { utilization: 70, resetsAt: undefined });
});

test('cached usage tolerates junk', () => {
  assert.deepEqual(parseCachedUsage(null), {});
  assert.equal(parseCachedUsage({ five_hour: { utilization: 'lots' } }).session, undefined);
  assert.equal(parseCachedUsage({ five_hour: { utilization: 140 } }).session?.utilization, 100);
});

test('parses status line rate_limits (epoch-second reset times)', () => {
  const u = parseStatusRateLimits({
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  });
  assert.deepEqual(u, {
    session: { utilization: 23.5, resetsAt: '2025-02-01T16:00:00.000Z' },
    weekly: { utilization: 41.2, resetsAt: '2025-02-06T16:00:00.000Z' },
  });
});

test('a window Claude Code dropped after its reset counts as 0%', () => {
  const u = parseStatusRateLimits({ seven_day: { used_percentage: 60, resets_at: 1738857600 } });
  assert.deepEqual(u?.session, { utilization: 0 });
  assert.equal(u?.weekly?.utilization, 60);
});

test('no status line rate_limits means no reading', () => {
  assert.equal(parseStatusRateLimits(undefined), undefined);
  assert.equal(parseStatusRateLimits(null), undefined);
  assert.equal(parseStatusRateLimits({}), undefined);
  assert.equal(parseStatusRateLimits({ spend_limit: { used_percentage: 3 } }), undefined);
});

test('a window whose reset time has passed counts as empty', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(effectivePct({ utilization: 95, resetsAt: '2026-01-01T11:59:00Z' }, now), 0);
  assert.equal(effectivePct({ utilization: 95, resetsAt: '2026-01-01T12:01:00Z' }, now), 95);
  assert.equal(effectivePct({ utilization: 40 }, now), 40);
  assert.equal(effectivePct(undefined, now), undefined);
  assert.equal(upcomingReset({ utilization: 95, resetsAt: '2026-01-01T11:59:00Z' }, now), undefined);
  assert.equal(upcomingReset({ utilization: 95, resetsAt: '2026-01-01T12:01:00Z' }, now), '2026-01-01T12:01:00Z');
});

test('plan labels', () => {
  assert.equal(planLabel('pro'), 'Pro');
  assert.equal(planLabel('max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(planLabel('max'), 'Max');
  assert.equal(planLabel(undefined), undefined);
});

test('durations', () => {
  assert.equal(formatDuration(30_000), '<1m');
  assert.equal(formatDuration(12 * 60_000), '12m');
  assert.equal(formatDuration(2 * 3600_000 + 14 * 60_000), '2h 14m');
  assert.equal(formatDuration(3 * 86400_000 + 4 * 3600_000 + 5 * 60_000), '3d 4h');
  assert.equal(untilReset(undefined), undefined);
  assert.equal(untilReset('2000-01-01T00:00:00Z'), 'now');
});
