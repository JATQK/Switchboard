import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { findLimitHit, parseAgentsList, parseSessionRecord, placeOf, readRunningChats, sharesHistory, withLimitHit } from '../chats';
import type { UsageReading } from '../types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-chats-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ID = '4c8cc518-eefd-4153-bc38-036d2d6b4c40';

/** A `sessions/<pid>.json` record as Claude Code 2.1.331 writes it (trimmed). */
const record = (pid: number, extra: Record<string, unknown> = {}) => ({
  pid,
  sessionId: ID,
  cwd: 'c:\\work',
  startedAt: 1795558566542,
  kind: 'interactive',
  entrypoint: 'claude-vscode',
  name: 'switchboard-07',
  status: 'idle',
  ...extra,
});

test('session records name the chat, where it runs and whether it is idle', () => {
  const chat = parseSessionRecord(record(3988, { sessionId: ID.toUpperCase() }), 'C:\\acct');
  assert.deepEqual(chat, {
    pid: 3988,
    sessionId: ID,
    cwd: 'c:\\work',
    configDir: 'C:\\acct',
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    name: 'switchboard-07',
    status: 'idle',
    startedAt: 1795558566542,
  });
  assert.equal(placeOf(chat!), 'panel');
  assert.equal(placeOf({ entrypoint: 'cli' }), 'terminal');
  assert.equal(placeOf({ entrypoint: 'sdk-ts' }), 'other');
  assert.equal(parseSessionRecord(record(0), 'x'), undefined);
  assert.equal(parseSessionRecord(record(5, { sessionId: 'nope' }), 'x'), undefined);
  assert.equal(parseSessionRecord('junk', 'x'), undefined);
});

test('only chats whose process is alive count as running', async () => {
  const dir = path.join(tmp, 'acct');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', '11.json'), JSON.stringify(record(11, { startedAt: 2 })));
  fs.writeFileSync(path.join(dir, 'sessions', '12.json'), JSON.stringify(record(12, { startedAt: 1 })));
  fs.writeFileSync(path.join(dir, 'sessions', '13.json'), JSON.stringify(record(13)));
  fs.writeFileSync(path.join(dir, 'sessions', '14.json'), '{ half written');
  fs.writeFileSync(path.join(dir, 'sessions', '11.abc.key'), 'not a record');
  const chats = await readRunningChats(dir, (pid) => pid !== 13);
  assert.deepEqual(
    chats.map((c) => c.pid),
    [12, 11],
  ); // oldest first; 13 has exited
  assert.deepEqual(await readRunningChats(path.join(tmp, 'missing')), []);
});

test('claude agents --json lists live sessions', () => {
  const out = JSON.stringify([{ pid: 3988, cwd: 'c:\\work', kind: 'interactive', startedAt: 1, sessionId: ID.toUpperCase(), name: 'x', status: 'idle' }, { nope: 1 }]);
  assert.deepEqual(parseAgentsList(out), [{ pid: 3988, sessionId: ID, status: 'idle' }]);
  assert.deepEqual(parseAgentsList('not json'), []);
});

/** A usage-limit rejection as Claude Code 2.1.331 records it in a transcript (trimmed). */
const rejection = (iso: string, type: string, resetsAt = 1795569000) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso,
    message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 2:10am (Europe/Berlin)" }] },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: type, overageStatus: 'rejected', isUsingOverage: false } },
    error: 'rate_limit',
    isApiErrorMessage: true,
  });

test('a usage-limit rejection in a transcript says which window is full and when it resets', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', timestamp: '2026-11-24T22:40:00.000Z', message: { role: 'user', content: 'mentions "usage_limit_reached" in text' } }),
    rejection('2026-11-24T22:48:13.442Z', 'five_hour'),
    '{"broken": ',
    rejection('2026-11-24T22:52:32.798Z', 'five_hour'),
    rejection('2026-11-24T22:50:00.000Z', 'seven_day_opus'), // a model-specific limit: not one Switchboard tracks
  ].join('\n');
  assert.deepEqual(findLimitHit(jsonl), { window: 'session', resetsAt: new Date(1795569000 * 1000).toISOString(), at: Date.parse('2026-11-24T22:52:32.798Z') });
  // Rejections from before the chat's process started belong to whatever account it ran on then.
  assert.equal(findLimitHit(jsonl, Date.parse('2026-11-24T23:00:00Z')), undefined);
  assert.equal(findLimitHit(rejection('2026-11-24T22:48:13Z', 'seven_day'))?.window, 'weekly');
  assert.equal(findLimitHit(''), undefined);
});

test('a newer limit hit fills its window and keeps the other one', () => {
  const reading: UsageReading = {
    usage: { session: { utilization: 76, resetsAt: 'a' }, weekly: { utilization: 6, resetsAt: 'b' } },
    at: 1000,
    source: 'cache',
  };
  assert.deepEqual(withLimitHit(reading, { window: 'session', resetsAt: 'c', at: 2000 }), {
    usage: { session: { utilization: 100, resetsAt: 'c' }, weekly: { utilization: 6, resetsAt: 'b' } },
    at: 2000,
    source: 'limit',
  });
  // Usage read after the hit already knows better (for example, the window has reset since).
  assert.equal(withLimitHit(reading, { window: 'session', at: 500 }), reading);
  assert.equal(withLimitHit(reading, undefined), reading);
  assert.deepEqual(withLimitHit(undefined, { window: 'weekly', at: 1 }), { usage: { weekly: { utilization: 100, resetsAt: undefined } }, at: 1, source: 'limit' });
});

test('accounts that link the same projects folder share history', async () => {
  const main = path.join(tmp, 'main');
  const linked = path.join(tmp, 'linked');
  const separate = path.join(tmp, 'separate');
  fs.mkdirSync(path.join(main, 'projects'), { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.mkdirSync(path.join(separate, 'projects'), { recursive: true });
  fs.symlinkSync(path.join(main, 'projects'), path.join(linked, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await sharesHistory(main, linked), true);
  if (process.platform === 'win32') assert.equal(await sharesHistory(linked, main.toUpperCase()), true);
  assert.equal(await sharesHistory(main, separate), false);
  assert.equal(await sharesHistory(main, path.join(tmp, 'nothing-here')), false);
  assert.equal(await sharesHistory(main, main), true);
});
