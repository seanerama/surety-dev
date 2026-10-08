// M235, finding resolution (M3 slice 21; kernel lane). M3 plan §3.7 M235;
// D3 §2.11 (F2, decided option (c), E90 item 4), §7.1 L8, §7.4 Q8 (E91
// item 2); Astra's T20; D3-F01; SEAM.md §§74, 191, 228, 231.
//
// A finding names the criterion it breaks and a check. Dispositioned `fix`,
// it is resolved by an evaluation of a candidate it applies to if and only
// if the named check is, at the effective version, of origin `acceptance`,
// covers that criterion and is in the required set of the evaluation's
// scope; it is `passed` there by an execution registered after the
// disposition; and its evidence is intact. Anything less leaves it
// unresolved. A finding whose named check cannot verify its criterion (it
// names no criterion, or no required acceptance check of the version covers
// it through the named check) stays unresolved, the gate read names the
// missing verification, and the engine registers `check_correction` work
// for the Verifier, triggered by the finding, once, chained. An invalidated
// resolving execution reopens the finding. A finding naming a criterion
// outside the index is an invalid result, and nothing is stored.
//
// The project (T1): R1 with criteria R1.1 and R1.2, R2 with R2.1; the
// stage implements R1 only. Discovered checks: `login` (acceptance, R1.1),
// `other` (acceptance, R1.2), `smoke`, `dev` (origin developer), all
// required; `optional` (acceptance, R1.1), not in `required_checks`.
//
// The former insufficient resolution (M1's SEAM §74: a finding with a check
// and no criterion, resolved when its check passed after the disposition)
// is pinned as now refused in case (c) (AD §8.3; COVERAGE.md, "M3 slice 21").
//
// S2 (E100 item 2; SEAM.md §235): condition 2 reads "in the required set of
// one of the candidate's scopes" (the union registration uses), and a
// missing verification is named and routed only when no scope of the
// finding's candidate requires the named check as an acceptance-origin
// check covering the criterion. The S2 case has its own two-stage project.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { openDecision } from './harness/decisions.mjs';
import { postResult, raiseFindings, reasonSubjects, review, stageGate, successor } from './harness/gates.mjs';
import { permittedEdit, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { eventsOfType, outOfBand, workItemsOf } from './harness/journal.mjs';
import { readGate } from './harness/reads.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { addWork, answerDecision, runsOf, scriptedEngine, tick, tickUntil, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { waitFor } from './harness/engine.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { buildAndNominate, checkIds, def, findingRow, missingFor, missingVerifications, registrationsBy, repairProject, workFor } from './harness/checks/repair.mjs';

const DEFS = Object.freeze({
  login: def('acceptance', { criteria: ['R1.1'] }),
  other: def('acceptance', { criteria: ['R1.2'] }),
  smoke: def('smoke'),
  dev: def('smoke', { origin: 'developer' }),
  optional: def('acceptance', { criteria: ['R1.1'] }),
});
const REQUIRED = ['login', 'other', 'smoke', 'dev'];
const INDEX = [
  { key: 'R1', criteria: ['R1.1', 'R1.2'] },
  { key: 'R2', criteria: ['R2.1'] },
];

// S2's project (E100 item 2): stage 1 implements R1 (`login` covers R1.1),
// stage 2 implements R2 (`pay` covers R2.1); `deep` covers R1.1 and is in
// `required_checks`, but its tier floor T2 keeps it out of every scope of a
// T1 candidate.
const CROSS = Object.freeze({
  login: def('acceptance', { criteria: ['R1.1'] }),
  pay: def('acceptance', { criteria: ['R2.1'] }),
  smoke: def('smoke'),
  deep: def('acceptance', { criteria: ['R1.1'], tier_floor: 'T2' }),
});

const finding = (message, extra = {}) => ({ category: 'defect', severity: 'medium', message, ...extra });

// The project, its stage built and nominated: candidate 1 with its
// nomination registrations of the four required checks (queued).
async function project(t) {
  const fx = await scriptedEngine(t);
  const p = await repairProject(fx, { defs: DEFS, governed: { required_checks: REQUIRED }, index: INDEX });
  const b = await buildAndNominate(fx, p, { keys: REQUIRED });
  return { fx, p, ...b, ctx: { project: p, stage: p.stages[0].id, candidate: b.candidate }, ids: checkIds(fx.home, p.id) };
}

// A new registration of each key on the candidate, recorded passing, with output. Returns {key: result}.
async function passFresh(fx, project, candidate, keys) {
  const out = {};
  for (const key of keys) {
    const { [key]: x } = await operatorRequest(fx.engine, project, candidate, [key]);
    out[key] = await recordExit(fx.engine, x, 0, { output: `${key} passed\n` });
    out[key].execution = x;
  }
  return out;
}

const status = (fx, id) => findingRow(fx.home, id).status;

describe('M235 finding resolution', () => {
  test("(a) the named check is a required acceptance check covering the finding's criterion, passed on the fix's candidate by an execution registered after the disposition, its evidence intact: the finding is resolved, naming the evaluation and the execution, and the fix completes", async (t) => {
    const { fx, p, candidate: c1, ctx } = await project(t);
    const [found] = await raiseFindings(fx, p.id, c1.id, [finding('M235-a: a session survives logout', { check: 'login', criterion: 'R1.1' })], { kind: 'verification' });
    assert.equal(findingRow(fx.home, found.id).criterion, 'R1.1', 'the finding is stored with the criterion it names (D3 A.3)');
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
    assert.ok(fix, 'the fixture is live: the engine registered the fix (E43)');
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', found.id), [], 'a finding its named check can verify routes no check_correction work');

    const c2 = await successor(fx, ctx, { work: fix.id });
    const reg = await tickUntil(fx.engine, p.id, () => {
      const r = registrationsBy(fx.home, c2.id);
      return REQUIRED.every((k) => r[k]) ? r : undefined;
    }, { max: 6, what: "the fix candidate's nomination registrations" });
    const results = {};
    for (const key of REQUIRED) results[key] = await recordExit(fx.engine, reg[key].id, 0, { output: `${key} passed on the fix candidate\n` });
    const resolving = await stageGate(fx, ctx, c2);
    assert.deepEqual(missingVerifications(resolving, 'the resolving evaluation').filter((m) => m.finding === found.id), [], 'no missing verification is named for it');

    const row = findingRow(fx.home, found.id);
    assert.equal(row.status, 'resolved', `the finding is resolved (reasons ${JSON.stringify(resolving.reasons)})`);
    assert.deepEqual(row.resolution_verification, { evaluation: resolving.id, check_result: results.login.id }, 'resolution_verification names the evaluation and the result');
    const result = withResult(fx, results.login.id);
    assert.equal(result.execution, reg.login.id, "that result is the execution registered at the fix candidate's nomination, after the disposition");
    assert.ok(result.execution_seq > row.disposition_seq, 'registered after the disposition (the watermark, SEAM.md §191)');
    assert.equal(eventsOfType(fx.home, 'finding.resolved').filter((e) => e.subject?.finding === found.id).length, 1, 'finding.resolved is emitted');
    assert.equal(workItem(fx.home, fix.id).status, 'complete', 'the fix completes with its finding\'s resolution');
  });

  test("(a) S2 (E100 item 2): a regression finding on stage 2's candidate naming stage 1's check `login` and R1.1 is resolved by `login` passing on the fix's candidate after the disposition, as a required check of one of the candidate's scopes; stage 2's gate is then free of it and no check_correction is routed. Contrast: a check covering R1.1 that none of the candidate's scopes requires resolves nothing and is routed", async (t) => {
    const fx = await scriptedEngine(t);
    const p = await repairProject(fx, {
      defs: CROSS,
      governed: { required_checks: Object.keys(CROSS) },
      index: INDEX,
      stages: [
        { number: 1, goal: 'stage one', implements: ['R1'] },
        { number: 2, goal: 'stage two', implements: ['R2'] },
      ],
    });
    const [s1, s2] = p.stages.map((s) => s.work_item);
    fx.scripted.script(s1, [roleThat([permittedEdit()], { nominate: true })]);
    fx.scripted.script(s2, [roleThat([step.write('src/stage-2.js', 'export const stage = 2;\n')], { nominate: true })]);
    await tickUntil(fx.engine, p.id, () => [s1, s2].every((item) => runsOf(fx.home, item)[0]?.state === 'ended'), { max: 24, what: "both stages' Builder runs to end" });
    const c2 = (await waitForCandidates(fx, p.id, 2))[1];
    assert.ok(JSON.parse(c2.held_work).includes(s2), "the fixture is live: candidate 2 is stage 2's");
    const ids = checkIds(fx.home, p.id);

    const [regress, contrast] = await raiseFindings(fx, p.id, c2.id, [
      finding('M235-S2: stage two broke the login', { check: 'login', criterion: 'R1.1' }),
      finding('M235-S2 contrast: a check no scope of the candidate requires', { check: 'deep', criterion: 'R1.1' }),
    ], { kind: 'verification' });
    await review(fx, p.id, c2.id, { dispositions: [regress, contrast].map((f) => ({ finding: f.id, disposition: 'fix' })) });
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', regress.id), [], "`login` is a required acceptance check covering R1.1 in one of candidate 2's scopes: no check_correction is routed");
    assert.equal(workFor(fx.home, p.id, 'check_correction', contrast.id).length, 1, "contrast: `deep` (tier floor T2, a T1 project) is required in none of candidate 2's scopes: one check_correction is routed with the disposition");
    const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === regress.id);
    assert.ok(fix, 'the fixture is live: the engine registered the fix (E43)');

    const c3 = await successor(fx, { project: p }, { work: fix.id });
    const reg = await tickUntil(fx.engine, p.id, () => registrationsBy(fx.home, c3.id).login, { max: 6, what: "the fix candidate's registration of login" });
    const passed = await recordExit(fx.engine, reg.id, 0, { output: 'login passed on the fix candidate\n' });
    const deep = await postResult(fx.engine, p.id, { candidate: c3.id, check: ids.deep, exit_status: 0 });
    const disposed = findingRow(fx.home, regress.id).disposition_seq;
    assert.ok(withResult(fx, passed.id).execution_seq > disposed && deep.execution_seq > findingRow(fx.home, contrast.id).disposition_seq, 'the fixture is live: both passes were registered after their dispositions');

    const ctx2 = { project: p, stage: p.stages[1].id };
    const resolving = await stageGate(fx, ctx2, c3);
    const row = findingRow(fx.home, regress.id);
    assert.equal(row.status, 'resolved', `stage 2's evaluation of the fix's candidate resolves the finding: login is required in one of the candidate's scopes (reasons ${JSON.stringify(resolving.reasons)})`);
    assert.deepEqual(row.resolution_verification, { evaluation: resolving.id, check_result: passed.id }, 'by that evaluation and login\'s result');
    assert.deepEqual(missingFor(resolving, regress.id), [], 'no missing verification is named for it');
    const after = await stageGate(fx, ctx2, c3);
    for (const code of ['FINDING_UNSATISFIED', 'FINDING_BLOCKING']) assert.ok(!reasonSubjects(after, code).includes(regress.id), `stage 2's gate is free of the finding (${code})`);
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', regress.id), [], 'and no check_correction was routed for it');

    assert.equal(status(fx, contrast.id), 'dispositioned', 'contrast: `deep` passing after the disposition resolves nothing');
    assert.ok(reasonSubjects(after, 'FINDING_UNSATISFIED').includes(contrast.id), 'contrast: it still stands at the gate');
    assert.equal(missingFor(after, contrast.id).length, 1, 'contrast: the gate names its missing verification');
    assert.equal(workFor(fx.home, p.id, 'check_correction', contrast.id).length, 1, 'contrast: still one check_correction');
  });

  test('(b) an unrelated green check, a developer check, a check outside the required set, a check not covering the criterion, a pass registered before the disposition: none resolves; the covering required check registered after does (control)', async (t) => {
    const { fx, p, candidate: c1, ctx, ids } = await project(t);
    const reported = await raiseFindings(fx, p.id, c1.id, [
      finding('M235-b: unrelated green check', { check: 'smoke', criterion: 'R1.1' }),
      finding('M235-b: developer check', { check: 'dev', criterion: 'R1.1' }),
      finding('M235-b: outside the required set', { check: 'optional', criterion: 'R1.1' }),
      finding('M235-b: not covering the criterion', { check: 'other', criterion: 'R1.1' }),
      finding('M235-b: passed before the disposition', { check: 'login', criterion: 'R1.1' }),
    ], { kind: 'verification' });
    const [unrelated, developer, outside, uncovering, early] = reported;
    // A registration of login made before the dispositions, recorded after them.
    const { login: before } = await operatorRequest(fx.engine, p.id, c1.id, ['login']);
    await review(fx, p.id, c1.id, { dispositions: reported.map((f) => ({ finding: f.id, disposition: 'fix' })) });
    await passFresh(fx, p.id, c1.id, ['smoke', 'dev', 'other']);
    await postResult(fx.engine, p.id, { candidate: c1.id, check: ids.optional, exit_status: 0 });
    await recordExit(fx.engine, before, 0, { output: 'login passed, registered before the dispositions\n' });

    const evaluation = await stageGate(fx, ctx);
    for (const key of ['smoke', 'dev', 'other', 'login']) assert.equal(evaluation.check_states[ids[key]], 'passed', `the fixture is live: ${key} passed`);
    for (const [what, f] of [['an unrelated green check', unrelated], ['a developer check', developer], ['a check outside the required set', outside], ['a check not covering the criterion', uncovering], ['a pass registered before the disposition', early]]) {
      assert.equal(status(fx, f.id), 'dispositioned', `${what}: the finding is not resolved`);
      assert.ok(reasonSubjects(evaluation, 'FINDING_UNSATISFIED').includes(f.id), `${what}: it still stands at the gate`);
    }

    // The control: the covering required check, registered after the disposition, passing.
    await passFresh(fx, p.id, c1.id, ['login']);
    await stageGate(fx, ctx);
    assert.equal(status(fx, early.id), 'resolved', 'login registered after the disposition resolves the finding naming it');
    for (const f of [unrelated, developer, outside, uncovering]) assert.equal(status(fx, f.id), 'dispositioned', `and still not ${f.message}`);
  });

  test('(b) a pass whose output record is missing does not resolve; the same check passing with its record does (control)', async (t) => {
    const { fx, p, candidate: c1, ctx } = await project(t);
    const [found] = await raiseFindings(fx, p.id, c1.id, [finding('M235-b: evidence missing', { check: 'login', criterion: 'R1.1' })], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const { login } = await passFresh(fx, p.id, c1.id, ['login']);
    const record = recordRow(fx.home, withResult(fx, login.id).output);
    await fx.engine.stop();
    rmSync(recordFile(fx.home, record));
    await fx.start();
    const evaluation = await stageGate(fx, ctx);
    assert.ok(reasonSubjects(evaluation, 'EVIDENCE_MISSING').includes(record.id), `the fixture is live: the record is missing (reasons ${JSON.stringify(evaluation.reasons)})`);
    assert.equal(status(fx, found.id), 'dispositioned', 'a pass with its output record missing resolves nothing (D3 §2.11 (4))');

    await passFresh(fx, p.id, c1.id, ['login']);
    await stageGate(fx, ctx);
    assert.equal(status(fx, found.id), 'resolved', 'the control: a later registration passing with its record resolves it');
  });

  test("(c) a finding naming no criterion, and one whose criterion no required acceptance check covers through its check: unresolved though the check passes after the disposition; the gate read names the missing verification; one check_correction item each for the Verifier, triggered by the finding, chained, registered with the disposition and once", async (t) => {
    const { fx, p, candidate: c1, ctx } = await project(t);
    const reported = await raiseFindings(fx, p.id, c1.id, [
      // M1's form (SEAM.md §74 as built): a check and no criterion. Now refused.
      finding('M235-c: no criterion', { check: 'login' }),
      finding('M235-c: a criterion no covering check verifies', { check: 'login', criterion: 'R2.1' }),
      finding('M235-c: the control', { check: 'login', criterion: 'R1.1' }),
    ], { kind: 'verification' });
    const [none, uncovered, control] = reported;
    await review(fx, p.id, c1.id, { dispositions: reported.map((f) => ({ finding: f.id, disposition: 'fix' })) });

    const dispositioned = (id) => eventsOfType(fx.home, 'finding.dispositioned').find((e) => e.subject?.finding === id);
    const created = (id) => eventsOfType(fx.home, 'work.created').find((e) => e.subject?.work_item === id);
    for (const [what, f] of [['no criterion', none], ['an uncovered criterion', uncovered]]) {
      const routed = workFor(fx.home, p.id, 'check_correction', f.id);
      assert.equal(routed.length, 1, `${what}: one check_correction item, registered with the disposition and no tick (D3 §2.11; Q8 (a))`);
      const [w] = routed;
      assert.deepEqual([w.subject?.finding, w.trigger_id, w.status], [f.id, f.id, 'eligible'], `${what}: it names the finding and is triggered by it`);
      assert.equal(created(w.id)?.tx, dispositioned(f.id)?.tx, `${what}: in the transaction that records the fix disposition`);
      assert.ok(created(w.id)?.payload?.test_fixture !== true, `${what}: the engine's, not a fixture's`);
      const boundary = await openDecision(fx, p.id, 'blocker', w.id);
      assert.deepEqual(boundary.options.map((o) => o.key).sort(), ['cancel', 'continue'], `${what}: chained: it waits at the chain boundary`);
      assert.equal(runsOf(fx.home, w.id).length, 0, `${what}: no run`);
    }
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', control.id), [], 'the control routes none');

    await passFresh(fx, p.id, c1.id, ['login']);
    const evaluation = await stageGate(fx, ctx);
    assert.equal(evaluation.check_states[checkIds(fx.home, p.id).login], 'passed', 'the fixture is live: login passed, registered after the dispositions');
    assert.equal(status(fx, control.id), 'resolved', 'the control is resolved by that evaluation');
    for (const [what, f] of [['no criterion', none], ['an uncovered criterion', uncovered]]) {
      assert.equal(status(fx, f.id), 'dispositioned', `${what}: not resolved (former resolution now refused)`);
      assert.ok(reasonSubjects(evaluation, 'FINDING_UNSATISFIED').includes(f.id), `${what}: a subject of FINDING_UNSATISFIED as before`);
      assert.equal(missingFor(evaluation, f.id).length, 1, `${what}: the evaluation names the missing verification (SEAM.md §231)`);
    }
    assert.deepEqual(missingFor(evaluation, control.id), [], 'none for the control');
    const read = (await readGate(fx.engine, p.id, c1.id, 'stage')).evaluation;
    for (const f of [none, uncovered]) assert.equal(missingFor(read, f.id).length, 1, 'the gate read names it as the evaluation recorded it');
    const [m] = missingFor(evaluation, uncovered.id);
    assert.deepEqual([m.criterion, m.check], ['R2.1', 'login'], 'naming the finding\'s criterion and check');

    await tick(fx.engine, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id);
    await stageGate(fx, ctx);
    for (const f of [none, uncovered]) assert.equal(workFor(fx.home, p.id, 'check_correction', f.id).length, 1, 'still one each, after ticks, a restart and another evaluation');
  });

  test('(d) the resolving execution invalidated: the finding reopens', async (t) => {
    const { fx, p, candidate: c1, ctx } = await project(t);
    const [found] = await raiseFindings(fx, p.id, c1.id, [finding('M235-d', { check: 'login', criterion: 'R1.1' })], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const { login } = await passFresh(fx, p.id, c1.id, ['login']);
    await stageGate(fx, ctx);
    assert.equal(status(fx, found.id), 'resolved', 'the fixture is live: resolved');

    commitOnRef(p.repo.path, p.repo.ref, { 'src/hotfix.js': 'export const hotfix = true;\n' }, { message: 'developer: a commit the engine did not make' });
    await tick(fx.engine, p.id);
    const [observed] = outOfBand(fx.home, p.id);
    await answerDecision(fx.engine, p.id, observed.decision.id, 'adopt');
    await waitFor(() => withResult(fx, login.id).invalidated_at !== null, { what: 'the resolving result to be invalidated' });
    await waitFor(() => status(fx, found.id) === 'open', { what: 'the finding to reopen' });
    assert.equal(eventsOfType(fx.home, 'finding.reopened').filter((e) => e.subject?.finding === found.id).length, 1, 'finding.reopened is emitted');
  });

  test('(e) a finding naming a criterion not in the index is an invalid result: nothing is stored', async (t) => {
    const { fx, p, candidate: c1 } = await project(t);
    // A failed run returns its work to `eligible` (D1 §4.3), so the Verifier is dispatched again: that
    // launch completes with no findings (objection 032), and the refused first run is what is read.
    fx.scripted.defaultScript(script.complete());
    const { run } = await roleRunOf(fx, p.id, c1.id, [finding('M235-e', { check: 'login', criterion: 'R9.9' })]);
    assert.deepEqual([run.outcome, run.reason_class], ['failed', 'invalid_result'], `the run is failed / invalid_result (${run.reason_text})`);
    assert.ok(String(run.reason_text ?? '').includes('R9.9'), `its reason names the criterion (${run.reason_text})`);
    assert.deepEqual(findingsOfProject(fx, p.id), [], 'no finding is stored');
  });
});


const withResult = (fx, id) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(id));
const findingsOfProject = (fx, project) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "findings" WHERE "project" = ?').all(project));

// A Verifier's run on the candidate (fixture work, not chained) reporting `findings`; it may be refused.
async function roleRunOf(fx, project, candidate, findings) {
  const item = await addWork(fx.engine, project, 'verification', { subject: { candidate } });
  fx.scripted.script(item, [roleThat([], { findings })]);
  const run = await tickUntil(fx.engine, project, () => (runsOf(fx.home, item)[0]?.state === 'ended' ? runsOf(fx.home, item)[0] : undefined), { what: "the Verifier's run to end" });
  return { item, run };
}
