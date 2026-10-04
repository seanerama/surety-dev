// M132, secrets never reach disk; volatile before disk; provider files (M2
// slice 13 part 2, sandbox lane). M2 plan §3.6 M132; D2 §2.5, §3.7, §4.3,
// K4 (D2-S01 to D2-S08); D1 §14.2; E37 item 2; E58 item 1; E67 item 5; AR
// B08, B09; SEAM.md §§57, 135, 143, 152.
//
// A role holding a registered secret writes it to its output, its result,
// its volatile home, /tmp and a workspace file. The transcript is redacted;
// the result, the provider files and the materialization that would carry
// it are refused, with the Critical security finding and
// evidence.secret_refused, the integration branch untouched and the run
// failed / infra_error (SEAM §152's fixed outcome). The secret in the home
// alone refuses the provider files and nothing else. A crash before
// collection loses the volatile filesystem: nothing of it is on disk, the
// result and provider files are recorded missing. The domain never swaps.
// The inventory lists every writable location without following a link or
// opening a FIFO; each collection bound, lowered by the harness, marks the
// record truncated and the run's evidence incomplete. The record has one
// shape, and a credential file is listed as excluded, never retained.
//
// SAFETY (E64 item 2; SEAM.md §§141, 152): every write outside the
// workspace is a guarded action, released only after the host has read
// that the role is contained, and touches only the volatile filesystem.
// Nothing fills anything: a handful of files of a few KiB, against bounds
// the harness lowers (--harness-collect-bounds, the collect_slow fault).
// The secret is a test-made string held by the engine's resolver.
//
// Every case is expected to fail on the engine these tests were written
// against (main at e1f6e73; COVERAGE.md, "M2 slice 13 (part 2)").

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { armFault, waitFor } from './harness/engine.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { findingsOf } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, changePolicy } from './harness/journal.mjs';
import { readRun } from './harness/reads.mjs';
import { filesHolding, holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { addProject, addWork, assertRunEnded, getRow, run as runRow, stopRun, waitForRunState } from './harness/runs.mjs';
import { eventsOf, roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { runRecords } from './harness/sandbox/result.mjs';
import { armedRole } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';
import { git } from './harness/git.mjs';

const COLLECT_DEADLINE = CONTRACT.engine.collect_deadline.min;
const escaped = (s) => JSON.stringify(s).slice(1, -1);
const holds = (text, secret) => text.includes(secret) || text.includes(escaped(secret));
const recordText = (home, id) => readFileSync(recordFile(home, recordRow(home, id)), 'utf8');

async function secretProject(t, { config = {}, args = [] } = {}) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2, ...config }, start: false });
  await fx.start({ args });
  const project = await addGitProject(fx);
  await changePolicy(fx.engine, project.id, { repair_attempts_max: 0 });
  // A secret whose JSON-escaped form differs from its raw form.
  const secret = `sk-held-"secret"\\${randomBytes(10).toString('hex')}`;
  await holdSecret(fx.engine, 'm132/secret', secret);
  return { fx, project, secret };
}

const refs = (repo) => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']);

async function providerFiles(fx, project, runId) {
  const shown = await readRun(fx.engine, project, runId);
  const c = shown.provider_files_collection;
  assert.ok(c && typeof c === 'object', `the run read has provider_files_collection (keys: ${Object.keys(shown).join(', ')})`);
  return c;
}

const providerRecordOf = (fx, runId) => {
  const rows = runRecords(fx.home, runId, 'provider_files');
  assert.ok(rows.length <= 1, `at most one provider_files record per domain (${rows.length})`);
  return rows[0] ? { row: rows[0], doc: JSON.parse(recordText(fx.home, rows[0].id)) } : null;
};

function assertScreenHit(fx, project, runId, ended, what) {
  assertRunEnded(fx.home, runId, { outcome: 'failed', reason_class: 'infra_error', launched: true, recovery: false });
  assert.match(ended.reason_text ?? '', /secret_refused/, `the run's reason names the refusal (${ended.reason_text})`);
  const refused = eventsOf(fx.home, 'run', runId, 'evidence.secret_refused');
  assert.ok(refused.length >= 1, 'evidence.secret_refused is emitted');
  assert.ok(refused.some((e) => e.payload?.what === what), `one names ${what} (${JSON.stringify(refused.map((e) => e.payload))})`);
  const found = findingsOf(fx.home, project).filter((f) => f.source_run === runId && f.category === 'security' && f.effective_severity === 'critical');
  assert.ok(found.length >= 1, `the Critical security finding is raised (${JSON.stringify(findingsOf(fx.home, project).map((f) => [f.category, f.effective_severity, f.source_run]))})`);
}

describe('M132 secrets never reach disk; volatile before disk; provider files', () => {
  test('(a) after termination: the transcript is redacted; the result, the provider files and the materialization holding the secret are refused (evidence.secret_refused, the Critical security finding); the branch unchanged; the run failed / infra_error; nothing under the engine home holds it', async (t) => {
    const { fx, project, secret } = await secretProject(t);
    const before = refs(project.repo.path);
    const item = await addWork(fx.engine, project.id, 'fix');
    const role = await armedRole(fx, project.id, item, {
      before: [step.stdout(`a line holding ${secret}\n`), step.write('src/leak.txt', `the key is ${secret}\n`)],
      acts: (act) => [act.write('/surety/home/notes.txt', { content: `home ${secret}\n` }), act.write('/tmp/scratch.txt', { content: `tmp ${secret}\n` })],
      result: { summary: `done with ${secret}` },
    });
    const ended = await role.release();
    assert.deepEqual(role.probes('write_probe').map((p) => p.outcome), ['written', 'written'], 'the fixture is live: the role wrote the secret into its home and /tmp');
    assertScreenHit(fx, project.id, role.run.id, ended, 'materialization');

    const run = runRow(fx.home, role.run.id);
    assert.ok(run.transcript, 'the run has its transcript');
    assert.ok(!holds(recordText(fx.home, run.transcript), secret), 'the transcript holds neither the secret nor its JSON-escaped form');
    assert.equal(run.result, null, 'the result that holds the secret is not published');
    for (const r of runRecords(fx.home, role.run.id)) {
      if (r.published === 1 && r.path) assert.ok(!holds(recordText(fx.home, r.id), secret), `record ${r.id} (${r.kind}) holds neither form`);
    }
    assert.equal((await providerFiles(fx, project.id, role.run.id)).outcome, 'refused', 'the provider files, which hold the secret, are refused');
    assert.equal(refs(project.repo.path), before, 'no ref moved: the materialization was refused');
    const checkout = getRow(fx.home, 'workspaces', role.run.workspace).path;
    assert.equal(existsSync(join(checkout, 'src/leak.txt')), false, 'host-read: the file holding the secret is not in the checkout');
    assert.deepEqual(filesHolding(fx.home, secret), [], 'no file under the engine home holds the secret');
    assert.deepEqual(filesHolding(fx.home, escaped(secret)), [], 'nor its JSON-escaped form');
  });

  test("(b) the secret in the volatile home only: the provider_files publication refused with the finding; the run's other records published", async (t) => {
    const { fx, project, secret } = await secretProject(t);
    const item = await addWork(fx.engine, project.id, 'fix');
    const role = await armedRole(fx, project.id, item, {
      before: [step.write('src/plain.txt', 'nothing secret\n')],
      acts: (act) => [act.write('/surety/home/notes.txt', { content: `home ${secret}\n` })],
    });
    const ended = await role.release();
    assertScreenHit(fx, project.id, role.run.id, ended, 'provider_files');
    const c = await providerFiles(fx, project.id, role.run.id);
    assert.deepEqual([c.outcome, c.record], ['refused', null], `the provider files are refused (${JSON.stringify(c)})`);
    assert.equal(providerRecordOf(fx, role.run.id), null, 'no provider_files record');
    const run = runRow(fx.home, role.run.id);
    assert.equal(recordRow(fx.home, run.transcript)?.published, 1, 'the transcript is published');
    const result = runRecords(fx.home, role.run.id, 'result');
    assert.equal(result.length, 1, 'the result is published');
    assert.ok(!holds(recordText(fx.home, result[0].id), secret));
  });

  test('(c) I18: SIGKILL at collect.before_read, then a restart: nothing under the engine home holds the secret or the home\'s contents; the run recovered, result null, the result and the provider files recorded missing', async (t) => {
    const { fx, project, secret } = await secretProject(t);
    const marker = `home-content-${randomBytes(8).toString('hex')}`;
    const item = await addWork(fx.engine, project.id, 'fix');
    await armBarrier(fx.engine, 'collect.before_read', 'kill');
    const role = await armedRole(fx, project.id, item, {
      acts: (act) => [act.write('/surety/home/notes.txt', { content: `${marker} ${secret}\n` }), act.write('/tmp/scratch.txt', { content: `${marker}\n` })],
    });
    fx.scripted.release(item, 'armed');
    await waitFor(() => (fx.engine.isRunning() ? undefined : true), { timeoutMs: 60_000, what: 'the engine to kill itself at collect.before_read' });
    await fx.start();
    const ended = await waitForRunState(fx.home, role.run.id, 'ended', { timeoutMs: 60_000 });
    assert.deepEqual([ended.outcome, ended.reason_class], ['recovered', 'recovered'], 'recovery ended the run');
    assert.equal(ended.result, null, 'no result');
    const shown = await readRun(fx.engine, project.id, role.run.id);
    assert.equal(shown.result_collection?.outcome, 'missing', `the result is recorded missing (${JSON.stringify(shown.result_collection)})`);
    assert.equal(shown.provider_files_collection?.outcome, 'missing', `the provider files are recorded missing (${JSON.stringify(shown.provider_files_collection)})`);
    for (const needle of [secret, escaped(secret), marker]) assert.deepEqual(filesHolding(fx.home, needle), [], `no file under the engine home holds ${needle === marker ? 'the home\'s contents' : 'the secret'}`);
  });

  test("(d) swap: the domain's memory.swap.max reads 0 during the run", async (t) => {
    const fx = await sandboxEngine(t);
    const project = (await addProject(fx)).id;
    const item = await addWork(fx.engine, project, 'verification');
    const { run, domain } = await roleHolding(fx, project, item, { on_term: 'exit' });
    assert.equal(readFileSync(join(domain.cgroup_path, 'memory.swap.max'), 'utf8').trim(), '0', 'host-read: memory.swap.max is 0 while the role runs');
    await stopRun(fx.engine, project, run.id);
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 40_000 });
  });

  test('(e) T06: the inventory lists every writable location with sizes, a link with its target (not followed, not duplicated), a FIFO (never opened), within collect_deadline; each bound reached (entries, bytes, the deadline), lowered by the harness, marks the record truncated and the run\'s evidence incomplete', async (t) => {
    // The inventory itself, no bound reached.
    {
      const { fx, project } = await secretProject(t, { config: { collect_deadline: COLLECT_DEADLINE } });
      const item = await addWork(fx.engine, project.id, 'fix');
      const role = await armedRole(fx, project.id, item, {
        acts: (act) => [act.volatileShapes({ files: [{ path: '/surety/home/a.txt', bytes: 300 }, { path: '/surety/home/sub/b.txt', bytes: 700 }, { path: '/tmp/t.txt', bytes: 50 }], links: [{ path: '/surety/home/link-to-a', target: '/surety/home/a.txt' }], fifos: ['/surety/home/pipe'] })],
      });
      const ended = await role.release();
      assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the fixture is live: no bound is reached (${ended.reason_text})`);
      const pf = providerRecordOf(fx, role.run.id);
      assert.ok(pf, 'one provider_files record');
      const at = Object.fromEntries(pf.doc.locations.map((l) => [l.path, l]));
      assert.deepEqual([at['/surety/home/a.txt']?.size, at['/surety/home/sub/b.txt']?.size, at['/tmp/t.txt']?.size], [300, 700, 50], `every writable location with its size (${JSON.stringify(pf.doc.locations.map((l) => l.path))})`);
      assert.deepEqual([at['/surety/home/link-to-a']?.type, at['/surety/home/link-to-a']?.target, at['/surety/home/link-to-a']?.retained], ['symlink', '/surety/home/a.txt', false], 'the link recorded with its target, not followed');
      assert.equal(pf.doc.locations.filter((l) => l.size === 300 && l.type === 'file').length, 1, 'its target not duplicated');
      assert.deepEqual([at['/surety/home/pipe']?.type, at['/surety/home/pipe']?.retained], ['fifo', false], 'the FIFO listed, never opened');
      assert.deepEqual([pf.doc.truncated, pf.doc.complete], [false, true]);
    }
    // Each bound, one engine each, lowered by the harness (SEAM.md §152).
    const cases = [
      { what: 'collect_entries_max', args: ['--harness-collect-bounds', 'entries=4,bytes=1048576'], files: Array.from({ length: 6 }, (_, i) => ({ path: `/surety/home/e${i}.txt`, bytes: 10 })), value: 4 },
      { what: 'provider_files_max_bytes', args: ['--harness-collect-bounds', 'entries=100,bytes=4096'], files: Array.from({ length: 3 }, (_, i) => ({ path: `/surety/home/b${i}.txt`, bytes: 2048 })), value: 4096 },
      { what: 'collect_deadline', args: [], fault: { point: 'collect_slow', delay_ms: 2000, times: 1_000_000 }, files: Array.from({ length: 4 }, (_, i) => ({ path: `/surety/home/d${i}.txt`, bytes: 10 })), value: COLLECT_DEADLINE },
    ];
    for (const c of cases) {
      const { fx, project } = await secretProject(t, { config: { collect_deadline: COLLECT_DEADLINE }, args: c.args });
      if (c.fault) await armFault(fx.engine, c.fault);
      const item = await addWork(fx.engine, project.id, 'fix');
      const role = await armedRole(fx, project.id, item, { acts: (act) => [act.volatileShapes({ files: c.files })] });
      const ended = await role.release();
      assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'infra_error'], `${c.what}: evidence incomplete is never completed (${ended.reason_text})`);
      assert.match(ended.reason_text ?? '', new RegExp(c.what), `${c.what}: the run's reason names the bound`);
      const pf = providerRecordOf(fx, role.run.id);
      assert.ok(pf, `${c.what}: the record is published, truncated`);
      assert.deepEqual([pf.doc.truncated, pf.doc.complete, pf.doc.limit?.key, pf.doc.limit?.value], [true, false, c.what, c.value], `${c.what}: truncated at the bound (${JSON.stringify({ truncated: pf.doc.truncated, complete: pf.doc.complete, limit: pf.doc.limit })})`);
      assert.equal((await providerFiles(fx, project.id, role.run.id)).outcome, 'truncated', `${c.what}: provider_files_collection says so`);
    }
  });

  test('(f) the record\'s shape: one provider_files record per domain with locations, persistence flags and exclusions; a credential-named file in the home listed under excluded, never retained', async (t) => {
    const { fx, project } = await secretProject(t);
    const item = await addWork(fx.engine, project.id, 'fix');
    const credential = `machine api.provider.example login role password not-a-real-${randomBytes(6).toString('hex')}\n`;
    const role = await armedRole(fx, project.id, item, {
      acts: (act) => [act.volatileShapes({ files: [{ path: '/surety/home/notes.txt', bytes: 20 }, { path: '/surety/home/.netrc', content: credential }] })],
    });
    const ended = await role.release();
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the fixture is live (${ended.reason_text})`);
    const pf = providerRecordOf(fx, role.run.id);
    assert.ok(pf, 'one provider_files record for the domain');
    assert.deepEqual([pf.row.published, pf.row.project], [1, project.id]);
    for (const key of ['locations', 'persistence_flags', 'excluded', 'truncated', 'limit', 'complete']) assert.ok(key in pf.doc, `the record has ${key} (${Object.keys(pf.doc).join(', ')})`);
    assert.ok(pf.doc.excluded.some((e) => e.path === '/surety/home/.netrc' && e.reason === 'credential'), `the credential file is excluded (${JSON.stringify(pf.doc.excluded)})`);
    const netrc = pf.doc.locations.find((l) => l.path === '/surety/home/.netrc');
    assert.ok(!netrc || (netrc.retained === false && netrc.content_base64 === undefined), 'never retained');
    assert.ok(!recordText(fx.home, pf.row.id).includes(credential.trim()) && !recordText(fx.home, pf.row.id).includes(Buffer.from(credential).toString('base64')), 'the record holds nothing of it');
    const notes = pf.doc.locations.find((l) => l.path === '/surety/home/notes.txt');
    assert.deepEqual([notes?.type, notes?.retained, Buffer.from(notes?.content_base64 ?? '', 'base64').length], ['file', true, 20], 'an ordinary file is retained, its content in the record');
    const c = await providerFiles(fx, project.id, role.run.id);
    assert.deepEqual([c.outcome, c.record], ['published', pf.row.id]);
  });
});
