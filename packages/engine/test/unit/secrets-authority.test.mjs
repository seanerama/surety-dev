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
const { withheldRead } = await import(join(dist, 'deploy', 'withhold.js'));

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
