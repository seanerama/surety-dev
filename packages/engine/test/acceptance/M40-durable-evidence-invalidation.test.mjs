// M40, durable evidence invalidation (slice 5). Plan §3.4 M40; build spec §6
// correction 17; RN §3 B17; D1 §§7.6, 7.9, 9.2, 9.3(3), 9.3(8), 9.5, D1-09,
// D1-11; Review B17; SEAM.md §72.
//
// Invalidating a check result is a durable fact about the result, separate
// from the staleness of an evaluation that used it. A result that an
// out-of-band adoption invalidated still has every binding the scope asks
// for (the candidate's revision, the effective protected version, the
// runner), and selection must reject it all the same, after a restart too:
// the old pass cannot reappear. The gate then needs a new execution.
// (Invalidation by a protected change, where the binding itself stops
// matching, is asserted in row M37.)
//
// With it, three cases earlier rows left for the slice that has gates: an
// out-of-band observation blocks the gates of its project without hiding
// the ledger (M24, M62; in the first case); a secret found later in a
// record raises a Critical project finding and takes the evidence away
// from a gate that was satisfied (M64); evidence a gate evaluation refers
// to is retained, and evidence whose bytes are gone is reported missing and
// never read as empty (M65).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { acceptedRun, check, checkResult, findingsOf, installChecks, nominated, passAll, reasonCodes, reasonSubjects, stageGate } from './harness/gates.mjs';
import { outOfBand } from './harness/journal.mjs';
import { getLedger, ledgerRows } from './harness/ledger.mjs';
import { readRecord, recordFile, recordRow, registerDetector, waitForPostScan } from './harness/records.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { advanceClock, answerDecision, getRow, scriptedEngine, tick } from './harness/runs.mjs';

const RETENTION_DAYS = 90; // record_retention_days, the default (contract/config.json)

// A candidate whose stage gate is satisfied by one passing check, whose
// execution left `output` as its evidence record.
async function passed(t, output = 'login check: ok\n') {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx);
  const project = ctx.project.id;
  const checks = await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] })]);
  const [result] = await passAll(fx.engine, project, ctx.candidate.id, [checks.id.login], { output });
  const first = await stageGate(fx, ctx);
  assert.equal(first.outcome, 'satisfied', `the fixture is live: the stage gate is satisfied (reasons: ${reasonCodes(first).join(', ')})`);
  const row = checkResult(fx.home, result.id);
  return { fx, ctx, project, login: checks.id.login, result: row, evidence: recordRow(fx.home, row.output), first };
}

const bindings = (row) => ({ check: row.check, candidate: row.candidate, source_revision: row.source_revision, protected_version: row.protected_version, runner_class: row.runner_class, exit_status: row.exit_status, execution_seq: row.execution_seq });

describe('M40 an invalidated result stays invalidated', () => {
  test('a pass invalidated by an adopted out-of-band change, its bindings unchanged, is not selected again, before or after a restart; a new execution satisfies the gate', async (t) => {
    const { fx, ctx, project, login, result, first } = await passed(t);
    // A developer commits on the integration branch by hand.
    commitOnRef(ctx.project.repo.path, ctx.project.repo.ref, { 'src/hotfix.js': 'export const hotfix = true;\n' }, { message: 'developer: a commit the engine did not make' });
    await tick(fx.engine, project);
    const [observed] = outOfBand(fx.home, project);
    assert.ok(observed, 'the fixture is live: the commit was observed out of band');

    // While it is unreconciled the gate is blocked, and the accounting is still there.
    const blocked = await stageGate(fx, ctx);
    assert.ok(reasonCodes(blocked).includes('OUT_OF_BAND_CHANGE'), `an unreconciled out-of-band change blocks the gate (reasons: ${reasonCodes(blocked).join(', ') || 'none'})`);
    const ledger = await getLedger(fx.engine, project);
    assert.deepEqual(ledger.rows.map((row) => row.id), ledgerRows(fx.home, project).map((row) => row.id), 'the ledger is read as before: a blocked gate hides no accounting');
    assert.ok(ledger.rows.length >= 1);

    await answerDecision(fx.engine, project, observed.decision.id, 'adopt');
    await waitFor(() => outOfBand(fx.home, project)[0].disposition === 'adopt', { what: 'the adoption to be recorded' });

    // Two durable facts: the result is invalidated, and the evaluation that used it is stale.
    const assertInvalidated = async (when) => {
      const row = checkResult(fx.home, result.id);
      assert.ok(row.invalidated_at, `${when}: the result is invalidated`);
      assert.deepEqual(bindings(row), bindings(result), `${when}: its bindings are what they were`);
      assert.equal(getRow(fx.home, 'gate_evaluations', first.id).stale, 1, `${when}: the evaluation it satisfied is stale`);
      const evaluation = await stageGate(fx, ctx);
      assert.equal(evaluation.check_states[login], 'stale', `${when}: the old pass is not selected`);
      assert.deepEqual(reasonCodes(evaluation), ['CHECK_NOT_PASSED'], `${when}: the gate says what it needs`);
      assert.deepEqual(reasonSubjects(evaluation, 'CHECK_NOT_PASSED'), [login]);
    };
    await assertInvalidated('after the adoption');
    await fx.engine.kill();
    await fx.start();
    await assertInvalidated('after a restart');

    await passAll(fx.engine, project, ctx.candidate.id, [login]);
    const renewed = await stageGate(fx, ctx);
    assert.deepEqual([renewed.outcome, renewed.check_states[login]], ['satisfied', 'passed'], 'a new applicable execution satisfies the gate');
    assert.ok(checkResult(fx.home, result.id).invalidated_at, 'and the old result is still invalidated');
  });
});

describe('M40 evidence that cannot be used', () => {
  test('a secret found later in an evidence record raises a Critical project finding and takes the evidence from a gate that was satisfied', async (t) => {
    const { fx, ctx, project, evidence, first } = await passed(t, 'login check: ok (ticket MARKER-482913)\n');
    await waitForPostScan(fx.home, evidence.id, 'clean');
    await registerDetector(fx.engine, 'fixture-marker', 'MARKER-[0-9]{6}');
    await waitForPostScan(fx.home, evidence.id, 'hit');

    const findings = await waitFor(() => {
      const found = findingsOf(fx.home, project);
      return found.length > 0 ? found : undefined;
    }, { what: 'the finding of the post-write scan' });
    assert.equal(findings.length, 1, 'one finding for one hit');
    const [found] = findings;
    assert.deepEqual(
      { scope: found.scope, category: found.category, severity: found.effective_severity, source_run: found.source_run, status: found.status },
      { scope: 'project', category: 'security', severity: 'critical', source_run: null, status: 'open' },
      'a Critical security finding on the project, raised by the engine and by no run',
    );
    assert.equal(recordRow(fx.home, evidence.id).post_scan_finding, found.id, 'the record names its finding');

    const again = await stageGate(fx, ctx);
    assert.equal(again.outcome, 'not_satisfied', 'the gate that was satisfied no longer is');
    for (const code of ['FINDING_BLOCKING', 'EVIDENCE_MISSING']) assert.ok(reasonCodes(again).includes(code), `${code} (reasons: ${reasonCodes(again).join(', ')})`);
    assert.ok(reasonSubjects(again, 'FINDING_BLOCKING').includes(found.id));
    assert.equal(getRow(fx.home, 'gate_evaluations', first.id).stale, 1, 'and its earlier evaluation is stale');
  });

  test('evidence a gate evaluation refers to is retained past the retention period, while a record nothing refers to expires', async (t) => {
    const { fx, ctx, project, evidence } = await passed(t);
    // A finished run of work that is complete: nothing refers to its records.
    const { run } = await acceptedRun(fx, project, 'review', { subject: { candidate: ctx.candidate.id } });
    await advanceClock(fx.engine, (RETENTION_DAYS + 1) * 86_400);
    await tick(fx.engine, project);
    await waitFor(() => recordRow(fx.home, run.transcript).path === null, { what: 'the unreferenced transcript to expire' });
    assert.notEqual(recordRow(fx.home, evidence.id).path, null, 'the evidence of the evaluation is retained');
    assert.equal((await readRecord(fx.engine, project, evidence.id)).status, 200, 'and is still served');
  });

  test('evidence whose bytes are gone is reported missing by the gate that depends on it, not read as empty', async (t) => {
    const { fx, ctx, evidence } = await passed(t);
    await fx.engine.stop();
    rmSync(recordFile(fx.home, evidence));
    await fx.start();
    const again = await stageGate(fx, ctx);
    assert.equal(again.outcome, 'not_satisfied');
    assert.ok(reasonSubjects(again, 'EVIDENCE_MISSING').includes(evidence.id), `the gate names the missing evidence (reasons: ${reasonCodes(again).join(', ')})`);
  });
});
