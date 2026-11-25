import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type Candidate, type Policy } from '../autoSwitch';

const policy = (over: Partial<Policy> = {}): Policy => ({
  sessionThreshold: 90,
  weeklyThreshold: 95,
  strategy: 'mostHeadroom',
  allowReturn: true,
  ...over,
});

const acct = (id: string, order: number, session: number, weekly: number, over: Partial<Candidate> = {}): Candidate => ({
  id,
  order,
  healthy: true,
  session,
  weekly,
  ...over,
});

test('stays while the active account is below both thresholds', () => {
  const d = decide('a', [acct('a', 0, 50, 60), acct('b', 1, 0, 0)], policy());
  assert.deepEqual(d, { kind: 'stay' });
});

test('switches to the account with the most headroom when the session limit is hit', () => {
  const d = decide('a', [acct('a', 0, 92, 40), acct('b', 1, 60, 10), acct('c', 2, 5, 20)], policy());
  assert.equal(d.kind, 'switch');
  assert.equal(d.kind === 'switch' && d.targetId, 'c');
  assert.match(d.kind === 'switch' ? d.reason : '', /session usage at 92%/);
});

test('weekly limit takes precedence in the reason', () => {
  const d = decide('a', [acct('a', 0, 95, 96), acct('b', 1, 0, 0)], policy());
  assert.equal(d.kind === 'switch' && d.reason, 'weekly usage at 96%');
});

test('priority strategy picks the first account in list order that has capacity', () => {
  const d = decide('a', [acct('a', 0, 95, 10), acct('b', 1, 80, 80), acct('c', 2, 0, 0)], policy({ strategy: 'priority' }));
  assert.equal(d.kind === 'switch' && d.targetId, 'b');
});

test('never switches to excluded, unhealthy or exhausted accounts', () => {
  const d = decide(
    'a',
    [acct('a', 0, 91, 10), acct('b', 1, 0, 0, { excluded: true }), acct('c', 2, 0, 0, { healthy: false }), acct('d', 3, 99, 0), acct('e', 4, 10, 97)],
    policy(),
  );
  assert.equal(d.kind, 'exhausted');
});

test('reports the earliest time capacity returns when everything is exhausted', () => {
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const later = new Date(Date.now() + 7200_000).toISOString();
  const d = decide(
    'a',
    [acct('a', 0, 91, 10, { sessionResetsAt: later }), acct('b', 1, 99, 10, { sessionResetsAt: soon })],
    policy(),
  );
  assert.equal(d.kind === 'exhausted' && d.nextResetAt, soon);
});

test('does nothing when the active account has no fresh data', () => {
  const d = decide('a', [acct('a', 0, 99, 99, { healthy: false }), acct('b', 1, 0, 0)], policy());
  assert.deepEqual(d, { kind: 'stay' });
});

test('priority strategy returns to a preferred account once it has clear headroom', () => {
  const accounts = [acct('a', 0, 0, 30), acct('b', 1, 40, 40)];
  assert.equal(decide('b', accounts, policy({ strategy: 'priority' })).kind, 'switch');
  // ...but not right after the user picked an account by hand
  assert.equal(decide('b', accounts, policy({ strategy: 'priority', allowReturn: false })).kind, 'stay');
  // ...and not when the preferred account is only just under the threshold
  assert.equal(decide('b', [acct('a', 0, 85, 30), acct('b', 1, 40, 40)], policy({ strategy: 'priority' })).kind, 'stay');
});

test('most-headroom strategy never moves away from an account that is under its limits', () => {
  const d = decide('b', [acct('a', 0, 0, 0), acct('b', 1, 70, 70)], policy());
  assert.deepEqual(d, { kind: 'stay' });
});

// ---------------------------------------------------------------- soonestWeeklyReset

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const soonest = (over: Partial<Policy> = {}) => policy({ strategy: 'soonestWeeklyReset', ...over });

test('soonestWeeklyReset: on a limit, prefers the account whose weekly resets first, even with less headroom', () => {
  const d = decide(
    'a',
    [
      acct('a', 0, 92, 40, { weeklyResetsAt: inHours(100) }),
      acct('b', 1, 0, 5, { weeklyResetsAt: inHours(150) }), // most headroom, but resets late
      acct('c', 2, 50, 70, { weeklyResetsAt: inHours(20) }), // resets soonest
    ],
    soonest(),
  );
  assert.equal(d.kind === 'switch' && d.targetId, 'c');
});

test('soonestWeeklyReset: skips a sooner-resetting account that has no session capacity', () => {
  const d = decide(
    'a',
    [
      acct('a', 0, 92, 40, { weeklyResetsAt: inHours(100) }),
      acct('b', 1, 95, 30, { weeklyResetsAt: inHours(10) }),
      acct('c', 2, 20, 30, { weeklyResetsAt: inHours(50) }),
    ],
    soonest(),
  );
  assert.equal(d.kind === 'switch' && d.targetId, 'c');
});

test('soonestWeeklyReset: accounts whose weekly window has not started rank last', () => {
  const d = decide(
    'a',
    [acct('a', 0, 92, 40, { weeklyResetsAt: inHours(100) }), acct('b', 1, 0, 0), acct('c', 2, 30, 60, { weeklyResetsAt: inHours(140) })],
    soonest(),
  );
  assert.equal(d.kind === 'switch' && d.targetId, 'c');
});

test('soonestWeeklyReset: near-equal reset times fall back to most headroom', () => {
  const t = Date.now() + 50 * 3600_000;
  const d = decide(
    'a',
    [
      acct('a', 0, 92, 40, { weeklyResetsAt: inHours(100) }),
      acct('b', 1, 60, 60, { weeklyResetsAt: new Date(t).toISOString() }),
      acct('c', 2, 10, 20, { weeklyResetsAt: new Date(t + 500).toISOString() }), // API jitter
    ],
    soonest(),
  );
  assert.equal(d.kind === 'switch' && d.targetId, 'c');
});

test('soonestWeeklyReset: moves proactively to an account whose weekly resets clearly sooner', () => {
  const accounts = [acct('a', 0, 30, 40, { weeklyResetsAt: inHours(100) }), acct('b', 1, 0, 70, { weeklyResetsAt: inHours(20) })];
  const d = decide('a', accounts, soonest());
  assert.deepEqual(d, { kind: 'switch', targetId: 'b', reason: 'its weekly limit resets sooner' });
  // not right after a manual switch
  assert.deepEqual(decide('a', accounts, soonest({ allowReturn: false })), { kind: 'stay' });
});

test('soonestWeeklyReset: no proactive move for tiny reset differences or a nearly full session', () => {
  const tiny = [acct('a', 0, 30, 40, { weeklyResetsAt: inHours(20.5) }), acct('b', 1, 0, 10, { weeklyResetsAt: inHours(20) })];
  assert.deepEqual(decide('a', tiny, soonest()), { kind: 'stay' });
  const busy = [acct('a', 0, 30, 40, { weeklyResetsAt: inHours(100) }), acct('b', 1, 85, 10, { weeklyResetsAt: inHours(20) })];
  assert.deepEqual(decide('a', busy, soonest()), { kind: 'stay' });
  const weeklyFull = [acct('a', 0, 30, 40, { weeklyResetsAt: inHours(100) }), acct('b', 1, 0, 95, { weeklyResetsAt: inHours(20) })];
  assert.deepEqual(decide('a', weeklyFull, soonest()), { kind: 'stay' });
});

test('soonestWeeklyReset: uses expiring weekly quota right up to the threshold', () => {
  const accounts = [acct('a', 0, 30, 40, { weeklyResetsAt: inHours(100) }), acct('b', 1, 0, 93, { weeklyResetsAt: inHours(20) })];
  assert.equal(decide('a', accounts, soonest()).kind, 'switch');
});

test('soonestWeeklyReset: full cycle uses the soon-expiring account first and returns after its session resets', () => {
  const early = { weeklyResetsAt: inHours(24) }; // account "e" loses its quota first
  const late = { weeklyResetsAt: inHours(120) };
  // 1. on the late account, early one is free -> go use it
  let d = decide('l', [acct('e', 1, 0, 50, early), acct('l', 0, 10, 20, late)], soonest());
  assert.equal(d.kind === 'switch' && d.targetId, 'e');
  // 2. early account's session runs out -> fall back to the late one
  d = decide('e', [acct('e', 1, 91, 60, early), acct('l', 0, 10, 20, late)], soonest());
  assert.equal(d.kind === 'switch' && d.targetId, 'l');
  // 3. while the early session is still used up, stay
  d = decide('l', [acct('e', 1, 91, 60, early), acct('l', 0, 40, 30, late)], soonest());
  assert.deepEqual(d, { kind: 'stay' });
  // 4. early session window resets (effective 0%) -> back to it
  d = decide('l', [acct('e', 1, 0, 60, early), acct('l', 0, 40, 30, late)], soonest());
  assert.equal(d.kind === 'switch' && d.targetId, 'e');
  // 5. early weekly almost used up -> still worth using the rest before it expires
  d = decide('l', [acct('e', 1, 0, 94, early), acct('l', 0, 40, 30, late)], soonest());
  assert.equal(d.kind === 'switch' && d.targetId, 'e');
  // 6. early weekly reached the threshold -> switch off it and stay off
  d = decide('e', [acct('e', 1, 20, 95, early), acct('l', 0, 40, 30, late)], soonest());
  assert.equal(d.kind === 'switch' && d.targetId, 'l');
  d = decide('l', [acct('e', 1, 0, 95, early), acct('l', 0, 40, 30, late)], soonest());
  assert.deepEqual(d, { kind: 'stay' });
});

// ---------------------------------------------------------------- accounts without usage data

test('falls back to a logged-in account without usage data only when nothing known has capacity', () => {
  const fresh = acct('n', 5, 0, 0, { healthy: false, unknownUsage: true, session: undefined, weekly: undefined });
  // something known has capacity: prefer it
  let d = decide('a', [acct('a', 0, 95, 10), acct('b', 1, 20, 20), fresh], policy());
  assert.equal(d.kind === 'switch' && d.targetId, 'b');
  // nothing known has capacity: try the unknown one
  d = decide('a', [acct('a', 0, 95, 10), acct('b', 1, 99, 20), fresh], policy());
  assert.equal(d.kind === 'switch' && d.targetId, 'n');
  assert.match(d.kind === 'switch' ? d.reason : '', /without usage data/);
  // never proactively, and never when excluded
  assert.deepEqual(decide('a', [acct('a', 0, 10, 10), fresh], policy({ strategy: 'priority' })), { kind: 'stay' });
  assert.equal(decide('a', [acct('a', 0, 95, 10), { ...fresh, excluded: true }], policy()).kind, 'exhausted');
});
