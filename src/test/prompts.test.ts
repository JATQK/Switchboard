/** Transcripts (reading Claude Code's conversations) and snippets (saved prompts). */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { expandSnippet, loadSnippets, newSnippet, saveSnippets, suggestName, toSlashCommand, variablesIn, writeSlashCommand } from '../snippets';
import { parseTranscript, projectDir, projectSlug, recentPrompts, sessionFiles } from '../transcripts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-prompts-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (o: unknown) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => line({ type: 'user', sessionId: 'S1', message: { role: 'user', content }, ...extra });
const assistant = (...blocks: unknown[]) => line({ type: 'assistant', sessionId: 'S1', message: { role: 'assistant', content: blocks } });
const text = (t: string) => ({ type: 'text', text: t });

const TRANSCRIPT = [
  line({ type: 'custom-title', customTitle: 'Fix the tests', sessionId: 'S1' }),
  user([text('<ide_opened_file>The user opened src/a.ts</ide_opened_file>'), text('Why do the tests fail?')]),
  assistant(text('Let me look.')),
  assistant({ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }),
  user([{ type: 'tool_result', content: '6 failing' }]),
  assistant(text('They find a real claude.exe.'), text('Fix: isolate HOME.')),
  user('<command-name>/clear</command-name>'),
  user('Now fix it'),
  user('injected reminder', { isMeta: true }),
  assistant(text('Working on it…')),
  assistant({ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }),
  user([{ type: 'tool_result', content: 'ok' }]),
  line({ type: 'assistant', isSidechain: true, message: { content: [text('subagent chatter')] } }),
  assistant(text('Done: tests pass.')),
  '{"type":"user","message":', // half-written last line
].join('\n');

test('transcripts: prompts, last prompt and the final answer, without injected context or interim text', () => {
  const s = parseTranscript(TRANSCRIPT);
  assert.equal(s.title, 'Fix the tests');
  assert.equal(s.sessionId, 'S1');
  assert.deepEqual(s.prompts, ['Why do the tests fail?', 'Now fix it']);
  assert.equal(s.lastPrompt, 'Now fix it');
  assert.equal(s.lastAnswer, 'Done: tests pass.');
  assert.equal(parseTranscript('').lastAnswer, undefined);
  // Claude Code's generated title, unless the user named the conversation.
  const ai = line({ type: 'ai-title', aiTitle: 'Reply with one word', sessionId: 'S1' });
  assert.equal(parseTranscript([ai, user('hi')].join('\n')).title, 'Reply with one word');
  assert.equal(parseTranscript([line({ type: 'custom-title', customTitle: 'Mine' }), ai].join('\n')).title, 'Mine');
});

test('transcripts: project folders are found by slug regardless of case; newest session first', async () => {
  const cwd = process.platform === 'win32' ? 'C:\\Work\\My App' : '/work/My App';
  assert.equal(projectSlug(cwd), process.platform === 'win32' ? 'C--Work-My-App' : '-work-My-App');
  const a = path.join(tmp, 'cfg-a');
  const b = path.join(tmp, 'cfg-b');
  const dirA = path.join(a, 'projects', projectSlug(cwd).toLowerCase());
  const dirB = path.join(b, 'projects', projectSlug(cwd));
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(dirA, `${older}.jsonl`), user('old prompt'));
  fs.writeFileSync(path.join(dirB, `${newer}.jsonl`), [user('first'), user('second'), user('old prompt')].join('\n'));
  fs.writeFileSync(path.join(dirB, 'not-a-session.txt'), 'x');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dirA, `${older}.jsonl`), past, past);
  assert.equal(await projectDir(a, cwd), dirA);
  const files = await sessionFiles([a, b, path.join(tmp, 'missing')], cwd);
  assert.deepEqual(files.map((f) => f.sessionId), [newer, older]);
  assert.deepEqual(await recentPrompts([a, b], cwd), ['old prompt', 'second', 'first']);
});

test('snippets: variables are listed and filled in; each question is asked once; cancel aborts', async () => {
  const t = 'Review ${file}:\n${selection}\nFocus: ${input:Focus}. Again: ${input:Focus}. Clip ${clipboard} ${input}';
  assert.deepEqual(variablesIn(t), { context: ['file', 'selection', 'clipboard'], inputs: ['Focus', 'Value'] });
  const asked: string[] = [];
  const out = await expandSnippet(t, { file: 'a.ts', selection: 'code', clipboard: 'C', ask: async (q) => (asked.push(q), q === 'Focus' ? 'speed' : 'v') });
  assert.equal(out, 'Review a.ts:\ncode\nFocus: speed. Again: speed. Clip C v');
  assert.deepEqual(asked, ['Focus', 'Value']);
  assert.equal(await expandSnippet('${input:X}', { ask: async () => undefined }), undefined);
  assert.equal(await expandSnippet('no vars, ${selection}', { ask: async () => 'x' }), 'no vars, ');
});

test('snippets: saved to and loaded from one JSON file', async () => {
  const file = path.join(tmp, 'sb', 'snippets.json');
  assert.deepEqual(await loadSnippets(file), []);
  const s = newSnippet('  Review  ', 'Review this', 'desc');
  await saveSnippets(file, [s, { junk: true } as never]);
  const loaded = await loadSnippets(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, 'Review');
  assert.equal(loaded[0].text, 'Review this');
  assert.equal(suggestName('Explain the following code in simple terms for a new teammate please'), 'Explain the following code in simple terms for…');
  assert.equal(suggestName('short\nsecond line'), 'short');
});

test('snippets: become Claude Code slash commands with $ARGUMENTS or $1, $2', async () => {
  const dir = path.join(tmp, 'commands');
  const one = toSlashCommand(newSnippet('Explain Code!', 'Explain ${input:What} simply.'), dir);
  assert.equal(one.name, 'explain-code');
  assert.equal(one.file, path.join(dir, 'explain-code.md'));
  assert.equal(one.content, '---\ndescription: "Explain <What> simply."\nargument-hint: "<What>"\n---\nExplain $ARGUMENTS simply.\n');
  assert.deepEqual(one.unsupported, []);
  const two = toSlashCommand(newSnippet('Compare', 'Compare ${input:A} with ${input:B} in ${selection}', 'Compare two things'), dir);
  assert.match(two.content, /^---\ndescription: "Compare two things"\nargument-hint: "<A> <B>"\n---\nCompare \$1 with \$2 in \$\{selection\}\n$/);
  assert.deepEqual(two.unsupported, ['${selection}']);
  assert.equal(await writeSlashCommand(one, false), 'written');
  assert.equal(await writeSlashCommand(one, false), 'exists');
  assert.equal(fs.readFileSync(one.file, 'utf8'), one.content);
});
