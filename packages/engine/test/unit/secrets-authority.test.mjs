// Developer tests for M4 slice 28, secrets and authority (D4 §§5.2, 7.1 to
// 7.3; E127 item 7 (m3); SEAM.md §§310 to 317): the launch channel's peer
// proof, the service's environment, a check's secret variable and the
// definition field, the `surety env` command line, and what a read of a
// service of unknown supervision keeps. Pure functions and this process's
// own /proc; nothing is started but one child node process of this test,
// which signals nothing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { commAnswers, launchNonce } = await import(join(dist, 'deploy', 'service-host.js'));
const { serviceEnvironment } = await import(join(dist, 'deploy', 'service-profile.js'));
const { checkSecretVariable } = await import(join(dist, 'checks', 'run.js'));
const { parseDefinition, defaultGoverned } = await import(join(dist, 'checks', 'schema.js'));
const { parseEnv } = await import(join(dist, 'deploy', 'env-command.js'));
const { withheldRead, wholeLinesWithin } = await import(join(dist, 'deploy', 'withhold.js'));
const { OutputCapture } = await import(join(dist, 'checks', 'run.js'));
const { holdSecret, CUT_FRAGMENT_MIN } = await import(join(dist, 'records', 'redact.js'));

const startTime = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
};

test('E127 m3: only the named process can answer the challenge; a process naming another\'s pid cannot', () => {
  const nonce = launchNonce();
  assert.match(nonce, /^[a-z0-9]{15}$/, 'a nonce fits a task\'s name');
  assert.notEqual(launchNonce(), nonce, 'single-use: each challenge draws a new one');
  const me = process.pid;
  const born = startTime(me);
  const before = readFileSync('/proc/self/comm', 'utf8').replace(/\n$/, '');
  try {
    // A child of this test naming this process's pid writes the nonce to
    // this process's name: the kernel refuses it (another thread group).
    const child = spawnSync(process.execPath, ['-e', `try { require('fs').writeFileSync('/proc/${me}/comm', ${JSON.stringify(nonce)}); console.log('written'); } catch (e) { console.log(e.code); }`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.stdout.trim(), 'EINVAL', `another process cannot set this one's name (${child.stdout} ${child.stderr})`);
    assert.equal(commAnswers(me, born, nonce), false, 'so a client naming this pid does not answer');
    // The named process itself answers.
    writeFileSync('/proc/self/comm', nonce);
    assert.equal(commAnswers(me, born, nonce), true, 'the named process answers its own challenge');
    assert.equal(commAnswers(me, born + 1, nonce), false, 'a different start time (a reused pid) proves nothing');
    assert.equal(commAnswers(me, born, launchNonce()), false, 'another nonce is not answered');
    assert.equal(commAnswers(2 ** 22 + 7, born, nonce), false, 'an unread process proves nothing');
  } finally {
    writeFileSync('/proc/self/comm', before);
  }
});

test('the service\'s environment: exactly the configured variables, secrets from the held values; one unheld starts nothing', () => {
  const held = { 'deploy/a': 'value-a', 'deploy/b': 'value-b' };
  const lk = { env: { MODE: 'x' }, secrets: { APP_TOKEN: 'deploy/a', DB_TOKEN: 'deploy/b' }, port: 8080 };
  const built = serviceEnvironment(lk, (ref) => held[ref] ?? null);
  assert.deepEqual(built, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/surety/home', TMPDIR: '/tmp', MODE: 'x', APP_TOKEN: 'value-a', DB_TOKEN: 'value-b', PORT: '8080' } });
  assert.deepEqual(serviceEnvironment({ ...lk, secrets: { APP_TOKEN: 'deploy/c' } }, (ref) => held[ref] ?? null), { unheld: 'deploy/c' });
});

test('a check\'s secret variable and the definition field', () => {
  assert.equal(checkSecretVariable('deploy/m332_chk'), 'SURETY_SECRET_M332_CHK');
  const governed = { ...defaultGoverned(), check_commands: { target: { path: '/usr/bin/true' } } };
  const def = (extra) => JSON.stringify({ schema: 1, key: 'k', kind: 'post_deploy_behavior', command: ['target'], timeout_s: 10, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'], ...extra });
  const ok = parseDefinition('defs/k.json', 'k', def({ secrets: ['deploy/a'] }), governed, []);
  assert.deepEqual([ok.errors, ok.definition?.secrets], [[], ['deploy/a']]);
  const none = parseDefinition('defs/k.json', 'k', def({}), governed, []);
  assert.equal('secrets' in none.definition, false, 'absent, the definition (and its fingerprint) is as before');
  const ws = parseDefinition('defs/k.json', 'k', JSON.stringify({ schema: 1, key: 'k', kind: 'smoke', command: ['target'], timeout_s: 10, gate_kinds: ['stage'], secrets: ['deploy/a'] }), governed, []);
  assert.deepEqual(ws.errors.map((e) => e.code), ['invalid_value'], 'a workspace check naming secrets is invalid_value');
  for (const bad of [['backend/claude/api_key'], ['deploy/a', 'deploy/a'], 'deploy/a']) {
    assert.ok(parseDefinition('defs/k.json', 'k', def({ secrets: bad }), governed, []).errors.length > 0, `refused: ${JSON.stringify(bad)}`);
  }
});

test('surety env: each command is one request to one route', () => {
  const p = ['--project', 'prj_1'];
  assert.deepEqual(parseEnv(['config', 'alpha', ...p, '--resolve-secrets']), { method: 'POST', path: '/v1/projects/prj_1/environments/alpha/config/resolve-secrets', body: {} });
  assert.deepEqual(parseEnv(['open', 'alpha', ...p]), { method: 'POST', path: '/v1/projects/prj_1/environments/alpha/relay', body: {} });
  assert.deepEqual(parseEnv(['close', 'alpha', ...p]), { method: 'DELETE', path: '/v1/projects/prj_1/environments/alpha/relay', body: null });
  assert.deepEqual(parseEnv(['logs', 'alpha', ...p, '--collect']), { method: 'POST', path: '/v1/projects/prj_1/environments/alpha/logs', body: {} });
  assert.deepEqual(parseEnv(['logs', 'alpha', ...p]), { method: 'GET', path: '/v1/projects/prj_1/environments/alpha/logs', body: null });
  assert.deepEqual(parseEnv(['teardown', 'alpha', ...p, '--preempt']), { method: 'POST', path: '/v1/projects/prj_1/environments/alpha/teardown', body: { preempt: true } });
  assert.deepEqual(parseEnv(['teardown', 'alpha', ...p]), { method: 'POST', path: '/v1/projects/prj_1/environments/alpha/teardown', body: {} });
  for (const bad of [[], ['open'], ['open', 'alpha'], ['open', 'alpha', ...p, '--preempt'], ['config', 'alpha', ...p], ['frob', 'alpha', ...p]]) assert.equal(typeof parseEnv(bad), 'string', `usage: ${bad.join(' ')}`);
});

test('a read of a service of unknown supervision keeps match results, hashes and numeric ids only', () => {
  const read = {
    target: 'app',
    method: 'tree_digest',
    expected: `sha256:${'a'.repeat(64)}`,
    read: `sha256:${'b'.repeat(64)}`,
    match: 'differs',
    instance: { pid: 42, start_time: 7 },
    generation: 1,
    at: '2026-10-10T00:00:00.000Z',
    duration_ms: 3,
    detail: { field: 'argv', expected: ['/usr/bin/node', 'server.js'], read: ['secret-in-title'], why: 'the arguments differ' },
  };
  const kept = withheldRead(read);
  assert.deepEqual(kept, { ...read, detail: { field: 'argv', withheld: 'redaction_unavailable' } });
  assert.ok(!JSON.stringify(kept).includes('secret-in-title'));
  assert.deepEqual(withheldRead({ ...read, read: 'free text', detail: null }).read, 'unread', 'a read that is no digest is withheld as unread');
});

test('S1 (i): a collected log is published as whole lines only, within its bound', () => {
  const secret = 'S3CRETvalue-0123456789abcdef';
  // A write split across reads: the capture ends with a prefix of the secret.
  const capture = Buffer.from(`first line\ntoken=${secret}\ntoken=${secret.slice(0, 12)}`);
  const out = wholeLinesWithin(capture, 1024).toString();
  assert.equal(out, `first line\ntoken=${secret}\n`, 'the line not yet ended is left out');
  // Cut at its front: the partial first line is dropped too.
  const cut = wholeLinesWithin(Buffer.from(`token=${secret}\nsecond\nthird\n`), 16).toString();
  assert.equal(cut, 'second\nthird\n', 'the last 16 bytes begin inside the secret\'s line, which is dropped');
  assert.equal(wholeLinesWithin(Buffer.from('no line end at all'), 100).length, 0);
});

test('S1 (ii): a check\'s output cut between its head and tail masks a held secret\'s fragment at each edge', () => {
  const value = 'm332-chk-secret-7f3a9c1e5b2d4f60';
  holdSecret('deploy/s1_unit', value);
  // The head ends with a prefix of the value; the tail starts with a suffix.
  const max = 64;
  const c = new OutputCapture(max);
  c.push(Buffer.from(`${'a'.repeat(20)}KEY=${value.slice(0, 8)}`)); // 32 bytes: the head, ending with a prefix
  c.push(Buffer.from('x'.repeat(100))); // dropped between
  c.push(Buffer.from(`${value.slice(-10)}${'z'.repeat(22)}`)); // 32 bytes: the tail, starting with a suffix
  assert.ok(c.dropped > 0, 'the fixture is live: bytes were dropped between head and tail');
  const out = c.bytes().toString();
  assert.ok(!out.includes(value.slice(0, 8)), `the head's trailing prefix is masked (${out})`);
  assert.ok(!out.includes(value.slice(-10)), `the tail's leading suffix is masked (${out})`);
  assert.ok(out.includes('[REDACTED]') && out.startsWith('a'.repeat(20)) && out.endsWith('z'.repeat(22)), 'the rest is kept');
  // Nothing dropped: the parts are contiguous, nothing is masked here (the redactor sees the whole).
  const whole = new OutputCapture(max);
  whole.push(Buffer.from(`KEY=${value.slice(0, 8)}`));
  assert.equal(whole.bytes().toString(), `KEY=${value.slice(0, 8)}`);
  // The stated minimum: a fragment shorter than CUT_FRAGMENT_MIN bytes is left.
  const short = new OutputCapture(max);
  short.push(Buffer.from(`${'a'.repeat(32 - (CUT_FRAGMENT_MIN - 1))}${value.slice(0, CUT_FRAGMENT_MIN - 1)}`));
  short.push(Buffer.from('x'.repeat(100)));
  short.push(Buffer.from('z'.repeat(32)));
  assert.ok(short.bytes().toString().startsWith('a'.repeat(32 - (CUT_FRAGMENT_MIN - 1)) + value.slice(0, CUT_FRAGMENT_MIN - 1)), 'a fragment under the minimum is left');
});
