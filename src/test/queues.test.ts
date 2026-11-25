/**
 * Queues worked through by real Claude Code chats: task files, chats following queues, the Stop hook script (run for
 * real, in PowerShell and sh), starting panel chats, and adding/removing the hook in Claude Code's settings.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-queues-'));
process.env.SWITCHBOARD_HOME = path.join(tmp, 'home');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Loaded after SWITCHBOARD_HOME is set.
const Q = require('../queues') as typeof import('../queues');

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const C = '16fd2706-8baf-433b-82eb-8c7fada847da';
const hasPowerShell = process.platform === 'win32' && spawnSync('powershell', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

beforeEach(() => fs.rmSync(Q.workRoot(), { recursive: true, force: true }));

const work = () => Q.readWork();
const states = async (queueId: string) => (await work()).queues.find((q) => q.id === queueId)!.tasks.map((t) => `${t.text}:${t.state}${t.chat ? `@${t.chat.slice(0, 4)}` : ''}`);

test('queues hold tasks in order; edit, move, remove, requeue, rename and delete', async () => {
  const q = await Q.createQueue('  Refactor  ');
  await Q.addTask(q, ' one ');
  await Q.addTask(q, 'two');
  const three = await Q.addTask(q, 'three');
  let w = await work();
  assert.equal(w.queues[0].name, 'Refactor');
  assert.deepEqual(await states(q), ['one:waiting', 'two:waiting', 'three:waiting']);
  await Q.moveTask(q, three, -2);
  assert.deepEqual(await states(q), ['three:waiting', 'one:waiting', 'two:waiting']);
  const first = (await work()).queues[0].tasks[0];
  assert.equal(await Q.editTask(q, first.key, 'THREE'), true);
  await Q.renameQueue(q, 'Renamed');
  w = await work();
  assert.equal(w.queues[0].name, 'Renamed');
  assert.equal(w.queues[0].tasks[0].text, 'THREE');

  const claimed = await Q.claimNext([q], A);
  assert.equal(claimed?.text, 'THREE');
  assert.equal(await Q.removeTask(q, claimed!.key), false, 'a running task stays');
  assert.equal(await Q.editTask(q, claimed!.key, 'x'), false);
  assert.equal(await Q.requeueTask(q, claimed!.key), true);
  assert.deepEqual(await states(q), ['THREE:waiting', 'one:waiting', 'two:waiting']);
  assert.equal(await Q.removeTask(q, (await work()).queues[0].tasks[1].key), true);
  assert.deepEqual(await states(q), ['THREE:waiting', 'two:waiting']);

  await Q.setFollows(A, [q, 'not-a-queue']);
  await Q.deleteQueue(q);
  w = await work();
  assert.deepEqual(w.queues, []);
  assert.deepEqual(w.chats, [], 'a chat that followed only that queue follows nothing now');
  await assert.rejects(Q.addTask('../escape', 'x'));
});

test('tasks added within the same millisecond keep the order they were added in', async () => {
  const q = await Q.createQueue('fast');
  const realNow = Date.now;
  Date.now = () => 1_795_000_000_000;
  try {
    for (const t of ['1', '2', '3', '4', '5', '6', '7', '8']) await Q.addTask(q, t);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(await states(q), ['1', '2', '3', '4', '5', '6', '7', '8'].map((t) => `${t}:waiting`));
  assert.equal((await Q.claimNext([q], A))?.text, '1', 'the first one added is handed out first');
});

test('chats follow queues in order; pausing; what needs the hook', async () => {
  const q1 = await Q.createQueue('one');
  const q2 = await Q.createQueue('two');
  assert.equal(Q.hookNeeded(await work()), false, 'empty queues, no chats');
  await Q.setFollows(A.toUpperCase(), [q2, q1, q2]);
  let w = await work();
  assert.deepEqual(w.chats, [{ sessionId: A, follows: [q2, q1], paused: false }]);
  assert.equal(Q.hookNeeded(w), true, 'a chat follows a queue: it waits for tasks');
  await Q.setPaused(A, true);
  w = await work();
  assert.equal(w.chats[0].paused, true);
  await Q.setFollows(A, []);
  assert.deepEqual((await work()).chats, []);
  const t = await Q.addTask(q1, 'task');
  assert.equal(Q.hookNeeded(await work()), true, 'an unfinished task: chats may be added to its queue');
  await Q.claimNext([q1], B);
  assert.equal(Q.hookNeeded(await work()), true, 'a running task must be marked done');
  await Q.removeTask(q1, t); // not removable while running
  await Q.requeueTask(q1, t);
  await Q.removeTask(q1, t);
  assert.equal(Q.hookNeeded(await work()), false, 'nothing left to do');
});

test('a panel chat Switchboard opens is tied to its queues by the token in its first message', async () => {
  const q = await Q.createQueue('docs');
  await Q.addTask(q, 'first');
  await Q.addTask(q, 'second');
  const token = Q.newStartToken();
  const t = await Q.claimNext([q], token);
  await Q.addPendingStart(token, [q]);
  let w = await work();
  assert.equal(w.pending[0].token, token);
  assert.deepEqual(await states(q), [`first:starting@${token.slice(0, 4)}`, 'second:waiting']);
  assert.equal(Q.hookNeeded(w), true);
  assert.match(Q.startMarker('docs', token), new RegExp(token));
  assert.equal(Q.withoutMarker(`Do it.\n\n${Q.startMarker('docs', token)}`), 'Do it.');

  assert.equal(await Q.bindPendingStart(token, A), true);
  assert.equal(await Q.bindPendingStart(token, B), false, 'only once');
  w = await work();
  assert.deepEqual(w.pending, []);
  assert.deepEqual(w.chats, [{ sessionId: A, follows: [q], paused: false }]);
  assert.equal(w.queues[0].tasks.find((x) => x.key === t!.key)!.state, 'running');

  const other = Q.newStartToken();
  await Q.claimNext([q], other);
  await Q.addPendingStart(other, [q]);
  await Q.cancelPendingStart(other);
  assert.deepEqual(await states(q), [`first:running@${A.slice(0, 4)}`, 'second:waiting'], 'a cancelled start gives its task back');
});

for (const kind of ['ps1', 'sh'] as const) {
  test(`the ${kind} hook: wakes idle chats with their next task, shares queues, records results, binds new panel chats`, { skip: kind === 'ps1' ? !hasPowerShell : !hasSh }, async () => {
    const script = path.join(tmp, `hook.${kind}`);
    fs.writeFileSync(script, Q.hookScriptSource(kind));
    // Claude Code's record of each running chat. The "process" is this test runner, so it is alive. (Git Bash can't
    // see Windows process ids, so the sh hook gets no pid there; it only runs on macOS and Linux for real.)
    const cfg = path.join(tmp, `${kind}-cfg`);
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    const record = (sid: string, status: 'idle' | 'busy' | undefined) => {
      const file = path.join(cfg, 'sessions', `${sid.slice(0, 6).replace(/\D/g, '1')}.json`);
      if (!status) return fs.rmSync(file, { force: true });
      const pid = kind === 'ps1' || process.platform !== 'win32' ? { pid: process.pid } : {};
      fs.writeFileSync(file, JSON.stringify({ ...pid, sessionId: sid, cwd: tmp, kind: 'interactive', entrypoint: 'claude-vscode', status }));
    };
    const args = kind === 'ps1' ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]] : ['sh', [script]];
    const env = (wait: number) => ({ ...process.env, CLAUDE_CONFIG_DIR: cfg, SWITCHBOARD_QUEUE_WAIT: String(wait) });
    const input = (sid: string, extra: object) => JSON.stringify({ session_id: sid, hook_event_name: 'Stop', last_assistant_message: `answer of ${sid.slice(0, 4)} "quoted"`, ...extra });
    /** Runs the hook until it ends: the task it woke the chat with, or '' when it gave up waiting (after `wait` s). */
    const run = (sid: string, extra: object = {}, wait = 1) => {
      const r = spawnSync(args[0] as string, args[1] as string[], { input: input(sid, extra), encoding: 'utf8', env: env(wait) });
      if (r.status === 2) return r.stderr;
      assert.equal(r.status, 0, r.stderr);
      return '';
    };
    /** Starts the hook in the background, as Claude Code does. */
    const start = (sid: string, wait = 30) => {
      const p = spawn(args[0] as string, args[1] as string[], { env: env(wait) });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdin.end(input(sid, {}));
      const ended = new Promise<{ code: number | null; task: string; at: number }>((resolve) => p.on('close', (code) => resolve({ code, task: err, at: Date.now() })));
      return { ended };
    };
    const waiterFile = (sid: string) => path.join(Q.workRoot(), 'waiters', sid);
    const until = async (cond: () => boolean, ms = 15000) => {
      for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
      assert.ok(cond(), 'timed out');
    };

    const q1 = await Q.createQueue('Refactor "auth"');
    const q2 = await Q.createQueue('Docs');
    const tricky = 'Fix "quotes", back\\slashes,\nnew lines and ünïcödé';
    await Q.addTask(q1, tricky);
    await Q.addTask(q1, 'b');
    await Q.addTask(q2, 'c');
    await Q.setFollows(A, [q1, q2]);
    await Q.setFollows(B, [q1]);
    for (const sid of [A, B, C]) record(sid, 'idle');

    assert.equal(run(C), '', 'a chat that follows nothing gets nothing');
    const a = run(A);
    assert.ok(a.startsWith(Q.preamble('Refactor "auth"')), a);
    assert.equal(a.slice(Q.preamble('Refactor "auth"').length).trim(), tricky);
    assert.match(run(B), /b$/);
    assert.match(run(A), /c$/, 'its first queue is empty: on to the next');
    assert.equal(run(B), '', 'nothing left in the queue it follows');
    assert.equal(fs.existsSync(waiterFile(B)), false, 'a waiter that gives up cleans up');
    let w = await work();
    const done = w.queues.find((q) => q.id === q1)!.tasks;
    assert.deepEqual(done.map((t) => [t.state, t.chat]), [['done', A], ['done', B]]);
    assert.equal(done[0].result, `answer of ${A.slice(0, 4)} "quoted"`);
    await Q.setPaused(A, true);
    await Q.addTask(q2, 'd');
    assert.equal(run(A), '', 'paused: finishes its task, takes no new one');
    w = await work();
    assert.deepEqual(w.queues.find((q) => q.id === q2)!.tasks.map((t) => t.state), ['done', 'waiting']);
    await Q.setPaused(A, false);

    // A chat that waits is woken when a task arrives later.
    const later = start(B);
    await until(() => fs.existsSync(waiterFile(B)));
    await new Promise((r) => setTimeout(r, 1000));
    await Q.addTask(q1, 'arrives later');
    const woke = await later.ended;
    assert.equal(woke.code, 2);
    assert.match(woke.task, /arrives later$/);

    // A busy chat (the user is talking to it) is not woken; once idle, it is.
    record(B, 'busy');
    const busy = start(B);
    await Q.addTask(q1, 'after the user');
    await new Promise((r) => setTimeout(r, 3500));
    assert.deepEqual((await work()).queues.find((q) => q.id === q1)!.tasks.at(-1)!.state, 'waiting');
    record(B, 'idle');
    const resumed = await busy.ended;
    assert.equal(resumed.code, 2);
    assert.match(resumed.task, /after the user$/);

    // A later turn of the same chat starts its own waiter: the earlier one steps aside.
    const first = start(B);
    await until(() => fs.existsSync(waiterFile(B)));
    fs.writeFileSync(waiterFile(B), '1 newer');
    const replaced = await first.ended;
    assert.equal(replaced.code, 0);
    assert.equal(fs.readFileSync(waiterFile(B), 'utf8'), '1 newer', 'leaves the newer waiter alone');
    fs.rmSync(waiterFile(B));

    // A chat that has ended (no record left) stops its waiter within a few seconds.
    record(B, undefined);
    const t0 = Date.now();
    const gone = await start(B).ended;
    assert.equal(gone.code, 0);
    assert.ok(gone.at - t0 < 10_000, `took ${gone.at - t0} ms`);
    if (kind === 'ps1') {
      // A crashed chat's record whose process id now belongs to another process (it started at another time).
      record(B, 'idle');
      const file = fs.readdirSync(path.join(cfg, 'sessions')).map((f) => path.join(cfg, 'sessions', f)).find((f) => fs.readFileSync(f, 'utf8').includes(B))!;
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), procStart: '100000000000000000' }));
      await Q.addTask(q1, 'not for a stranger');
      const reused = await start(B).ended;
      assert.equal(reused.code, 0);
      assert.equal((await work()).queues.find((q) => q.id === q1)!.tasks.at(-1)!.state, 'waiting');
      await Q.removeTask(q1, (await work()).queues.find((q) => q.id === q1)!.tasks.at(-1)!.key);
    }
    record(B, 'idle');

    // A panel chat Switchboard opened, whose first message carries the token.
    const token = Q.newStartToken();
    await Q.claimNext([q2], token);
    await Q.addTask(q2, 'e');
    await Q.addPendingStart(token, [q2]);
    const transcript = path.join(tmp, `${kind}-transcript.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: `d\n\n${Q.startMarker('Docs', token)}` } }) + '\n');
    record(B, undefined); // B would take "e" otherwise
    assert.equal(run(B, { transcript_path: transcript }), '', 'another chat is not bound by it');
    assert.match(run(C, { transcript_path: transcript }), /e$/, 'bound, its first task done, the next one handed over');
    w = await work();
    assert.deepEqual(w.pending, []);
    assert.deepEqual(w.chats.find((c) => c.sessionId === C)?.follows, [q2]);
    assert.deepEqual(w.queues.find((q) => q.id === q2)!.tasks.map((t) => [t.text, t.state, t.chat?.slice(0, 4)]), [
      ['c', 'done', A.slice(0, 4)],
      ['d', 'done', C.slice(0, 4)],
      ['e', 'running', C.slice(0, 4)],
    ]);
    assert.equal(run('not-a-session'), '');
    assert.deepEqual([...(await Q.readWaiters()).keys()], [], 'no waiter left behind');
  });
}

test('the hook is added to and removed from Claude Code settings, keeping everything else', async () => {
  const a = path.join(tmp, 'cfg-a', 'settings.json');
  const b = path.join(tmp, 'cfg-b', 'settings.json');
  const bad = path.join(tmp, 'cfg-bad', 'settings.json');
  const theirs = { matcher: '', hooks: [{ type: 'command', command: 'echo theirs' }] };
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(a, JSON.stringify({ model: 'opus', hooks: { Stop: [theirs], PreToolUse: [] } }));
  fs.writeFileSync(bad, '{ not json');
  assert.deepEqual(await Q.filesWithHook([a, b]), []);
  const { changed, failed } = await Q.installHook([a, b, bad]);
  assert.deepEqual(changed, [a, b]);
  assert.deepEqual(failed, [bad]);
  assert.deepEqual(await Q.filesWithHook([a, b]), [a, b]);
  const sa = JSON.parse(fs.readFileSync(a, 'utf8'));
  assert.equal(sa.model, 'opus');
  assert.deepEqual(sa.hooks.Stop[0], theirs);
  const ours = sa.hooks.Stop[1].hooks[0];
  assert.match(ours.command, /switchboard-queues/);
  assert.equal(ours.asyncRewake, true, 'runs in the background and wakes Claude');
  assert.ok(ours.timeout > 86_400);
  assert.ok(fs.existsSync(Q.hookScriptPath()));
  assert.deepEqual((await Q.installHook([a, b])).changed, [], 'no duplicates');

  // The earlier version of the hook (it ran in the foreground) is replaced, not added to.
  const old = { ...sa, hooks: { ...sa.hooks, Stop: [theirs, { hooks: [{ type: 'command', command: ours.command, timeout: 30 }] }] } };
  fs.writeFileSync(a, JSON.stringify(old));
  assert.deepEqual(await Q.filesWithHook([a, b]), [b]);
  assert.deepEqual(await Q.filesWithHook([a, b], true), [a, b]);
  assert.deepEqual((await Q.installHook([a, b])).changed, [a]);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')).hooks.Stop, [theirs, { hooks: [ours] }]);
  assert.deepEqual(await Q.removeHook([a, b, bad]), [a, b]);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { model: 'opus', hooks: { Stop: [theirs], PreToolUse: [] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(b, 'utf8')), {});
  assert.equal(fs.readFileSync(bad, 'utf8'), '{ not json');
});

test('tasks queued for chats by the earlier build become a queue the chat follows; its hook and script go', async () => {
  const home = process.env.SWITCHBOARD_HOME!;
  const legacy = path.join(home, 'chat-queues', A);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, '001795558687406-e28c72.task'), 'check the changes');
  fs.writeFileSync(path.join(legacy, '001795558833615-57452e.task'), 'add placeholders');
  fs.writeFileSync(path.join(legacy, '001795558000000-aaaaaa.sent'), 'already delivered');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'switchboard-chat-queue.ps1'), '# old');
  const settings = path.join(tmp, 'cfg-legacy', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const statusLine = { type: 'command', command: 'powershell -File switchboard-statusline.ps1' };
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'powershell -File "C:/x/switchboard-chat-queue.ps1"' }] }] }, statusLine }));
  const existing = await Q.createQueue('Mine');
  await Q.setFollows(A, [existing]);

  assert.equal(await Q.migrateLegacyChatQueues([settings]), 2);
  const w = await work();
  const carried = w.queues.find((q) => q.id !== existing)!;
  assert.match(carried.name, /Earlier tasks for chat 0f8fad5b/);
  assert.deepEqual(carried.tasks.map((t) => [t.text, t.state]), [['check the changes', 'waiting'], ['add placeholders', 'waiting']]);
  assert.deepEqual(w.chats.find((c) => c.sessionId === A)?.follows, [existing, carried.id], 'after the queues it already follows');
  assert.equal(fs.existsSync(path.join(home, 'chat-queues')), false);
  assert.equal(fs.existsSync(path.join(home, 'bin', 'switchboard-chat-queue.ps1')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'opus', statusLine }, 'only the old hook is removed');
  assert.equal(await Q.migrateLegacyChatQueues([settings]), 0, 'nothing the second time');
});

test('only interactive sessions count as chats', () => {
  const out = JSON.stringify([
    { pid: 1, cwd: 'c:\\work', kind: 'interactive', sessionId: A.toUpperCase(), name: 'fix', status: 'busy' },
    { pid: 2, cwd: 'c:\\work', kind: 'background', sessionId: B, status: 'idle' },
    { pid: 3, cwd: 'c:\\work', kind: 'interactive' },
  ]);
  assert.deepEqual(Q.parseAgents(out), [{ sessionId: A, cwd: 'c:\\work', name: 'fix', status: 'busy' }]);
  assert.deepEqual(Q.parseAgents('oops'), []);
});
