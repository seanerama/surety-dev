// M110, one qualification per start (M2 slice 11, written for slice 12).
// M2 plan §3.2 M110 (a)'s active row, (d), (e); D2 §2.6, §6, §7.1, K2,
// N05, A.3, A.4 (D2-H03 and the row half of D2-H01); E58 item 8; SEAM.md
// §§114, 123, 124.
//
// A passing start writes one host_qualifications row, active, with every
// check's observed value, the probe suite's results, a mechanism
// fingerprint and an evidence record, and emits host.qualified; the next
// passing start writes a new active row and lapses the previous one, which
// is never reactivated; while ui_bootstrap is true the row is written and
// never active, real dispatch is refused and the engine read says the
// exception is in force.
//
// Listed under manifest slice 12, not 11: a pass needs H9 and H10, which
// the probe suite of slice 12 establishes (M2 build spec §9: "H9 passes for
// the first time" in slice 12; SEAM.md §123). On the slice-11 engine every
// case here fails at the absent row, honestly: the host is not eligible
// until the suite exists. The slice-12 Verifier may extend the probes'
// assertions; the row's shape is pinned here.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { readRun } from './harness/reads.mjs';
import { holdSecret, recordRow } from './harness/records.mjs';
import { addWork, assertRunEnded, requestTick, waitForRun } from './harness/runs.mjs';
import { HOST_CHECK_IDS, assertEngineInScope, checkOf, hostSection, sandboxEngine } from './harness/sandbox/lane.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, PARK_ON_REFUSAL, StandIn, apiKeyRef, directUpdateRefused, eventsNamed, hostId, installTrustEntry, useBackend } from './harness/trust.mjs';

const PROBE_IDS = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);
const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));
const hostRows = (home) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "host_qualifications" ORDER BY rowid').all()).map((r) => ({ ...r, checks: json(r.checks), probes: json(r.probes), tool_versions: json(r.tool_versions) }));

// One active row of a passing start, as D2 A.3 and SEAM.md §123 shape it.
function assertActiveRow(fx, info) {
  const rows = hostRows(fx.home);
  const active = rows.filter((r) => r.status === 'active');
  assert.equal(active.length, 1, `one active host_qualifications row (rows: ${rows.map((r) => `${r.id}:${r.status}`).join(', ') || 'none'})`);
  const row = active[0];
  assert.equal(row.incarnation, info.incarnation, 'the active row is this incarnation\'s');
  assert.equal(row.host_id, hostId(), 'host_id is the installation\'s identity');
  assert.ok(typeof row.kernel === 'string' && row.kernel.length > 0, 'the kernel is recorded');
  for (const tool of ['unshare', 'setpriv', 'ip', 'systemd', 'node']) assert.ok(row.tool_versions[tool], `tool_versions records ${tool}`);
  assert.ok(typeof row.mechanism_fingerprint === 'string' && row.mechanism_fingerprint.length >= 16, 'a mechanism fingerprint');
  assert.deepEqual(row.checks.map((c) => c.id), HOST_CHECK_IDS, 'checks H1 to H13 in order');
  for (const c of row.checks) {
    assert.ok(['passed', 'failed', 'not_exercised'].includes(c.result), `check ${c.id} has a result`);
    assert.ok('observed' in c, `check ${c.id} has an observed value`);
  }
  for (const id of HOST_CHECK_IDS.filter((x) => x !== 'H13')) assert.equal(row.checks.find((c) => c.id === id).result, 'passed', `a pass has ${id} passed`);
  assert.deepEqual(row.probes.map((p) => p.id), PROBE_IDS, 'probes P1 to P20 in order');
  for (const p of row.probes) {
    assert.ok(typeof p.target_seeded === 'boolean', `probe ${p.id} says whether its target was seeded`);
    assert.ok('negative' in p && 'control' in p, `probe ${p.id} records its negative and its control`);
    assert.ok(['passed', 'failed', 'not_exercised'].includes(p.result), `probe ${p.id} has a result`);
  }
  assert.equal(row.bootstrap_exception, 0);
  const evidence = recordRow(fx.home, row.evidence);
  assert.ok(evidence && evidence.kind === 'qualification_evidence' && evidence.published === 1 && evidence.project === null, `the row's evidence is a published engine-scoped qualification_evidence record (${JSON.stringify(evidence)})`);
  const qualified = eventsNamed(fx.home, 'host.qualified').filter((e) => e.subject?.host_qualification === row.id);
  assert.equal(qualified.length, 1, 'one host.qualified for the row');
  const host = hostSection(info);
  assert.deepEqual([host.eligible, host.source, host.host_qualification, host.mechanism_fingerprint], [true, 'qualification', row.id, row.mechanism_fingerprint], 'the engine read reports the eligibility the row gives');
  assert.deepEqual([host.failed_checks, host.not_exercised_checks], [[], []]);
  assert.equal(host.message, null);
  for (const id of HOST_CHECK_IDS) assert.equal(checkOf(host, id).result, row.checks.find((c) => c.id === id).result, `the engine read agrees with the row on ${id}`);
  return row;
}

describe('M110 one qualification per start', () => {
  test('(a) a passing start writes one active host_qualifications row with checks, probes, a mechanism fingerprint and an evidence record, emits host.qualified, and the host is eligible', async (t) => {
    const fx = await sandboxEngine(t);
    const info = await fx.engine.engineInfo();
    await assertEngineInScope(fx);
    assertActiveRow(fx, info);
  });

  test('(d) a second start: a new active row, the previous lapsed with lapsed_at and lapsed_reason and host.qualification_lapsed; a lapsed row is never reactivated', async (t) => {
    const fx = await sandboxEngine(t);
    const first = assertActiveRow(fx, await fx.engine.engineInfo());
    await fx.engine.stop();
    const engine = await fx.start();
    const second = assertActiveRow(fx, await engine.engineInfo());
    assert.notEqual(second.id, first.id, 'a new row');
    const lapsed = hostRows(fx.home).find((r) => r.id === first.id);
    assert.equal(lapsed.status, 'lapsed');
    assert.ok(lapsed.lapsed_at, 'lapsed_at is set');
    assert.ok(typeof lapsed.lapsed_reason === 'string' && lapsed.lapsed_reason.length > 0, `lapsed_reason is set (${lapsed.lapsed_reason})`);
    const events = eventsNamed(fx.home, 'host.qualification_lapsed').filter((e) => e.subject?.host_qualification === first.id);
    assert.equal(events.length, 1, 'one host.qualification_lapsed for the previous row');
    await engine.stop();
    const attempt = directUpdateRefused(fx.home, `UPDATE "host_qualifications" SET "status" = 'active', "lapsed_at" = NULL, "lapsed_reason" = NULL WHERE "id" = ?`, first.id);
    assert.equal(attempt.refused, true, `the store refuses to reactivate a lapsed row (${attempt.code})`);
    assert.match(attempt.code, /^SQLITE_CONSTRAINT/);
    assert.equal(hostRows(fx.home).find((r) => r.id === first.id).status, 'lapsed');
  });

  test('(e) a start with ui_bootstrap true: the checks run and the row is written but never active, real dispatch is refused isolation_unqualified, and the engine read says the exception is in force', async (t) => {
    const fx = await sandboxEngine(t, { config: { ui_bootstrap: true } });
    const info = await fx.engine.engineInfo();
    assert.equal(info.bootstrap_exception, true, 'the exception is in force');
    const host = hostSection(info);
    for (const id of HOST_CHECK_IDS.filter((x) => x !== 'H13')) assert.equal(checkOf(host, id).result, 'passed', `${id} ran and passed under the exception`);
    const rows = hostRows(fx.home);
    const mine = rows.filter((r) => r.incarnation === info.incarnation);
    assert.equal(mine.length, 1, 'the row is written');
    assert.equal(mine[0].bootstrap_exception, 1, 'and marked bootstrap_exception');
    assert.notEqual(mine[0].status, 'active', 'and is not active');
    assert.deepEqual(rows.filter((r) => r.status === 'active'), [], 'no row is active while the exception is in force (N05)');
    assert.equal(host.eligible, false);
    assert.equal(host.host_qualification, null);
    assert.deepEqual(eventsNamed(fx.home, 'host.qualified'), [], 'no host.qualified');

    const standIn = new StandIn(join(fx.root, 'standin'));
    const project = (await addGitProject(fx)).id;
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), 'sk-test-key-for-the-stand-in-0110');
    await useBackend(fx.engine, project, BACKENDS.claude, { roles: ['verifier'], extra: PARK_ON_REFUSAL });
    await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    assert.equal((await readRun(fx.engine, project, run.id)).code, 'isolation_unqualified');
    assert.equal(standIn.launches().length, 0);
  });
});
