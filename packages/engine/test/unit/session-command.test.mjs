// Developer tests for `surety session …` and `surety pace` (BS5 §3; D6
// §2.7, §7.6): each command parsed into exactly one request to its route
// with its closed body, every usage problem refused before anything is
// asked, `say` waiting for its turn to settle and printing the role's
// reply, and the pace read printed with unknown kept unknown. Against a
// stand-in for the engine's API on loopback, in a scratch home.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { parseSession, parsePace, turnOf, settledText, paceLines } = await import(join(dist, 'sessions', 'session-command.js'));

test('surety session: each command is one request to its route with its closed body', () => {
  const P = '/v1/projects/prj_1/sessions';
  assert.deepEqual(parseSession(['open', '--project', 'prj_1', '--role', 'spec_writer']).request, { method: 'POST', path: P, body: { role: 'spec_writer' } });
  assert.deepEqual(parseSession(['open', '--role', 'architect', '--model', 'opus', '--project', 'prj_1']).request, { method: 'POST', path: P, body: { role: 'architect', model: 'opus' } });
  const say = parseSession(['say', 'run_1', '--project', 'prj_1', '--text', '--not a flag, my words']);
  assert.deepEqual(say.request, { method: 'POST', path: `${P}/run_1/turns`, body: { text: '--not a flag, my words' } }, "the owner's words as they are");
  assert.equal(say.waitMs, 45 * 60_000);
  assert.equal(parseSession(['say', 'run_1', '--project', 'prj_1', '--text', 'hi', '--no-wait']).waitMs, null);
  assert.equal(parseSession(['say', 'run_1', '--project', 'prj_1', '--text', 'hi', '--wait-minutes', '5']).waitMs, 5 * 60_000);
  assert.deepEqual(parseSession(['say', 'run_1', '--project', 'prj_1', '--file', 'words.txt'], (f) => `read ${f}`).request.body, { text: 'read words.txt' });
  assert.deepEqual(parseSession(['save', 'run_1', '--project', 'prj_1']).request, { method: 'POST', path: `${P}/run_1/save`, body: {} });
  assert.deepEqual(parseSession(['close', 'run_1', '--project', 'prj_1']).request, { method: 'POST', path: `${P}/run_1/close`, body: {} });
  assert.deepEqual(parseSession(['close', 'run_1', '--project', 'prj_1', '--refuse']).request.body, { refuse: true });
  assert.deepEqual(parseSession(['resume', 'run_1', '--project', 'prj_1']).request, { method: 'POST', path: `${P}/run_1/resume`, body: {} });
  assert.deepEqual(parseSession(['show', 'run_1', '--project', 'p/x']).request, { method: 'GET', path: '/v1/projects/p%2Fx/sessions/run_1', body: null });
});

test('surety session: every usage problem is a string, nothing asked', () => {
  const problems = [
    [],
    ['talk'],
    ['open', '--project', 'prj_1'],
    ['open', '--project', 'prj_1', '--role', 'builder'],
    ['open', '--role', 'vision'],
    ['say', '--project', 'prj_1', '--text', 'hi'],
    ['say', 'run_1', '--project', 'prj_1'],
    ['say', 'run_1', '--project', 'prj_1', '--text', 'hi', '--file', 'x'],
    ['say', 'run_1', '--project', 'prj_1', '--text', '   '],
    ['say', 'run_1', '--project', 'prj_1', '--text', 'hi', '--wait-minutes', '0'],
    ['say', 'run_1', '--project', 'prj_1', '--text', 'hi', '--no-wait', '--wait-minutes', '3'],
    ['save', 'run_1'],
    ['save', 'run_1', '--project', 'prj_1', '--refuse'],
    ['close', 'run_1', '--project', 'prj_1', '--project', 'prj_2'],
    ['show', 'run_1', '--project'],
  ];
  for (const argv of problems) assert.equal(typeof parseSession(argv, () => 'x'), 'string', JSON.stringify(argv));
  assert.equal(typeof parseSession(['say', 'run_1', '--project', 'p', '--file', 'nope'], () => { throw new Error('ENOENT'); }), 'string');
});

test("a turn's state from the session read; what say prints: the reply and questions, or that the turn failed or is unknown, never a made-up reply", () => {
  const view = { turns: [{ turn: 1, state: 'settled', reply: 'Hello.', questions_for_owner: ['Which tier?'], done: false }, { turn: 2, state: 'running', reply: null }] };
  assert.equal(turnOf(view, 2).state, 'running');
  assert.equal(turnOf(view, 3), null);
  assert.deepEqual(settledText(turnOf(view, 1)), { ok: true, text: 'Hello.\n\nQuestions for you:\n- Which tier?' });
  assert.equal(settledText({ state: 'failed', failure: { reason: 'deadline' } }).ok, false);
  assert.match(settledText({ state: 'unknown' }).text, /unknown/);
});

test('surety pace: one GET of the read; every figure on a line with its path; unknown stays unknown', () => {
  assert.deepEqual(parsePace(['--project', 'prj_1']), { request: { method: 'GET', path: '/v1/projects/prj_1/pace', body: null }, json: false });
  assert.equal(parsePace(['--json', '--project', 'prj_1']).json, true);
  for (const argv of [[], ['--project'], ['--json'], ['--project', 'a', '--project', 'b'], ['--project', 'a', '--yaml']]) assert.equal(typeof parsePace(argv), 'string', JSON.stringify(argv));
  assert.deepEqual(paceLines({ project: { to_spec_approved: { unknown: 'no event' }, sessions: [] }, runs: [{ wait_s: 0 }] }), ['project.to_spec_approved.unknown: no event', 'project.sessions: []', 'runs[0].wait_s: 0']);
});

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A stand-in for the engine's API: the session's routes and the pace read.
async function standIn(t, handle) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, token: req.headers['x-surety-token'], body: body === '' ? null : JSON.parse(body) });
      const [status, out] = handle(req.method, req.url, seen);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const home = scratch(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ api_port: server.address().port }));
  writeFileSync(join(home, 'api.token'), 't'.repeat(40) + '\n', { mode: 0o600 });
  return { home, seen };
}

const cli = (home, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dist, 'cli.js'), ...args], { env: { PATH: process.env.PATH, SURETY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('surety session say against the API: the turn admitted, the session read until that turn settles, the reply printed; a failed turn exits 1', async (t) => {
  let reads = 0;
  const { home, seen } = await standIn(t, (method, path) => {
    if (method === 'POST' && path === '/v1/projects/prj_1/sessions/run_1/turns') return [202, { run: 'run_1', turn: 2 }];
    if (method === 'GET' && path === '/v1/projects/prj_1/sessions/run_1') {
      reads++;
      return [200, { run: {}, turns: [{ turn: 1, state: 'settled', reply: 'old' }, { turn: 2, state: reads < 2 ? 'running' : 'settled', reply: 'Here is the draft.', questions_for_owner: [], done: true }] }];
    }
    return [404, { code: 'not_found' }];
  });
  const r = await cli(home, ['session', 'say', 'run_1', '--project', 'prj_1', '--text', 'Write the spec.']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Here is the draft.\n\nThe role proposes closing the session (surety session close).\n');
  assert.deepEqual(seen[0], { method: 'POST', path: '/v1/projects/prj_1/sessions/run_1/turns', token: 't'.repeat(40), body: { text: 'Write the spec.' } });
  assert.ok(seen.filter((s) => s.method === 'GET').length >= 2, 'read until settled');

  const failing = await standIn(t, (method) => (method === 'POST' ? [202, { run: 'run_1', turn: 1 }] : [200, { turns: [{ turn: 1, state: 'failed', failure: { reason_class: 'deadline' } }] }]));
  const f = await cli(failing.home, ['session', 'say', 'run_1', '--project', 'prj_1', '--text', 'hi']);
  assert.equal(f.code, 1);
  assert.match(f.stderr, /The turn failed/);
  assert.equal(f.stdout, '');

  const refused = await standIn(t, () => [409, { code: 'session_not_idle' }]);
  const n = await cli(refused.home, ['session', 'say', 'run_1', '--project', 'prj_1', '--text', 'hi']);
  assert.equal(n.code, 1);
  assert.match(n.stderr, /^409 .*session_not_idle/);
});

test('surety session open and pace against the API: the answer printed; pace --json as the engine gave it', async (t) => {
  const { home, seen } = await standIn(t, (method, path) =>
    method === 'POST' ? [201, { run: 'run_9', role: 'vision' }] : path.endsWith('/pace') ? [200, { project: { idle: { unknown: 'no observation' } } }] : [404, {}],
  );
  const o = await cli(home, ['session', 'open', '--project', 'prj_1', '--role', 'vision']);
  assert.equal(o.code, 0, o.stderr);
  assert.deepEqual(JSON.parse(o.stdout), { run: 'run_9', role: 'vision' });
  assert.deepEqual(seen[0].body, { role: 'vision' });
  const j = await cli(home, ['pace', '--project', 'prj_1', '--json']);
  assert.deepEqual(JSON.parse(j.stdout), { project: { idle: { unknown: 'no observation' } } });
  const p = await cli(home, ['pace', '--project', 'prj_1']);
  assert.equal(p.stdout, 'project.idle.unknown: no observation\n');
  const u = await cli(home, ['pace']);
  assert.equal(u.code, 2, 'a usage problem exits 2');
});
