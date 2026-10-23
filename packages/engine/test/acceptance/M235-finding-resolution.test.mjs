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
//
// E152 item 3 (Sean, 2026-10-16; D3 §2.11 amended; SEAM.md §470): a finding
// that names no criterion, whose named check covers no criterion and is
// required in the evaluated scope, is resolved by `fix` when that check
// passes after the disposition; the owner may ask for a check to be
// corrected (`correct_check`) without a conflict finding. Case (g). Case
// (c)'s finding with no criterion names `login`, which covers R1.1, so it
// stays as it was.
//
// Objection 209 (findings F19, F26, F33 of the M535 Waterlog recovery
// attempt; Sean's ruling of 2026-10-23, errata E179 item 8; the Verifier's
// answer `docs/acceptance/objections/
// 209-M535-fix-left-verifying-on-a-superseded-candidate.answer.md`): case (a)'s required
// result ("resolved ...; the fix completes") for two fixes the run left
// `verifying` for ever, each judged by the minimum both of the answers left to
// Sean satisfy: the finding resolved by an evaluation and the fix complete, or
// an open owner question naming the fix or its finding; a fix complete with
// its finding unresolved is a drop (harness/checks/stuck-fix.mjs
// `judgedOrAsked`). (a) F26: a finding a Verifier's check_correction run
// raises (its work names no candidate), dispositioned `fix` by the owner, its
// fix's candidate verified with `login` passing after the disposition and the
// stage gate the engine evaluates by itself satisfied. (a) F33: a plain fix
// whose candidate a later fix's candidate supersedes, the stage verified
// before either, `login` passing on both fix candidates after the
// dispositions, every verification complete, the engine ticked.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, test } from 'node:test';

import { consume, openDecision } from './harness/decisions.mjs';
import { acceptedRun, postResult, raiseFindings, reasonSubjects, review, stageGate, successor } from './harness/gates.mjs';
import { permittedEdit, roleThat, roleThatHolds, runToHold, waitForCandidates } from './harness/gitruns.mjs';
import { eventsOfType, outOfBand, workItemsOf } from './harness/journal.mjs';
import { readGate } from './harness/reads.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { commitOnRef } from './harness/repos.mjs';
import { addWork, answerDecision, runsOf, scriptedEngine, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { waitFor } from './harness/engine.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { buildAndNominate, checkIds, def, findingRow, missingFor, missingVerifications, registrationsBy, repairProject, workFor } from './harness/checks/repair.mjs';
import { ALPHA_ONLY, ALPHA_ONLY_REQUIRED, defect, fixProject, fixState, fixUnjudged, legacyShape, ownerFix, supersededFix, uncandidatedFix, unjudgedFix, verified } from './harness/checks/stuck-fix.mjs';

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
  // The step pin in one change before the plan exists (SEAM.md §§348, 363).
  const p = await repairProject(fx, { defs: DEFS, governed: { required_checks: REQUIRED }, index: INDEX, policy: { autonomy: 'step' } });
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
const candidatesOfProject = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));

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

  // E104 (Sean, 2026-10-08): the integration of a fix that names a finding is a nomination point at
  // every tier, T1 included, with no Builder request. Found by Sean's second real run: the real fix
  // Builder returned nominate:false, nothing nominated the fixed code at T1, and the finding could
  // never resolve (COVERAGE.md, "M3 slice 22: Sean's real run, second try").
  test("(f) E104: at T1 a fix naming a finding whose Builder does not ask for the nomination (nominate false) is nominated by the engine at its integration; the covering required check runs on that candidate and the finding resolves", async (t) => {
    const { fx, p, candidate: c1, ctx } = await project(t);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(p.id)).tier, 'T1', 'the fixture is live: a T1 project');
    const [found] = await raiseFindings(fx, p.id, c1.id, [finding('M235-f: an expired session is accepted', { check: 'login', criterion: 'R1.1' })], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
    assert.ok(fix, 'the fixture is live: the engine registered the fix (E43)');
    fx.scripted.script(fix.id, [roleThat([step.write('src/fix-f.js', 'export const fixed = true;\n')], { nominate: false })]);
    await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix.id), 'continue');
    const run = await tickUntil(fx.engine, p.id, () => (runsOf(fx.home, fix.id)[0]?.state === 'ended' ? runsOf(fx.home, fix.id)[0] : undefined), { what: "the fix's Builder run to end" });
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the fix Builder's run, nominate false, was accepted (${run.reason_text})`);
    const c2 = await tickUntil(fx.engine, p.id, () => candidatesOfProject(fx.home, p.id)[1], { max: 8, what: "the engine's nomination of the fix's integration (E104: no Builder request needed at T1)" });
    const reg = await tickUntil(fx.engine, p.id, () => {
      const r = registrationsBy(fx.home, c2.id);
      return REQUIRED.every((k) => r[k]) ? r : undefined;
    }, { max: 6, what: "the fix candidate's nomination registrations" });
    const results = {};
    for (const key of REQUIRED) results[key] = await recordExit(fx.engine, reg[key].id, 0, { output: `${key} passed on the fix candidate\n` });
    const resolving = await stageGate(fx, ctx, c2);
    const row = findingRow(fx.home, found.id);
    assert.equal(row.status, 'resolved', `the finding is resolved (reasons ${JSON.stringify(resolving.reasons)})`);
    assert.deepEqual(row.resolution_verification, { evaluation: resolving.id, check_result: results.login.id }, 'through the covering required check, login, on the engine-nominated candidate');
    assert.equal(workItem(fx.home, fix.id).status, 'complete', 'and the fix completes');
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
      policy: { autonomy: 'step' },
    });
    const [s1, s2] = p.stages.map((s) => s.work_item);
    fx.scripted.script(s1, [roleThat([permittedEdit()], { nominate: true })]);
    // Under K2 stage 2's Builder runs beside stage 1's, and which candidate
    // holds which stage depends on how their integrations and nominations
    // interleave (one candidate may hold both, objection 109). Stage 2's
    // Builder holds before it writes until candidate 1 exists, so candidate 2
    // is stage 2's (objection 115; SEAM §463).
    fx.scripted.script(s2, [roleThatHolds([], [step.write('src/stage-2.js', 'export const stage = 2;\n')], { nominate: true })]);
    await runToHold(fx, p.id, s2);
    if (runsOf(fx.home, s1).length === 0) await tick(fx.engine, p.id);
    await waitForRun(fx.home, s1, { state: 'ended' });
    const [c1] = await waitForCandidates(fx, p.id, 1);
    assert.ok(JSON.parse(c1.held_work).includes(s1) && !JSON.parse(c1.held_work).includes(s2), `the fixture is live: candidate 1 is stage 1's alone (${c1.held_work})`);
    fx.scripted.release(s2);
    await waitForRun(fx.home, s2, { state: 'ended' });
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

  // E152 item 3 (Sean, 2026-10-16; D3 §2.11 amended): a finding that names no criterion, whose named
  // check covers no criterion and is required in the evaluated scope (a phase-only, smoke, static or
  // lint check), is resolved by `fix` when that check passes after the disposition; and the owner may
  // ask for a check to be corrected (`correct_check`) without a conflict finding. Found by loop 3: a
  // phase-only static check failed on a comment, and nothing could resolve it (SEAM.md §470).
  test("(g) E152 item 3: a finding naming no criterion and the failing check `smoke`, which covers no criterion and is required in the stage's scope, is put to the owner with `fix` and `correct_check` offered; dispositioned fix, it routes no check_correction and is resolved when `smoke` passes by an execution registered after the disposition", async (t) => {
    // M235's project with `repair_attempts_max` 0 pinned with the step pin before the plan
    // (objection 030; SEAM.md §§234, 363): the failing smoke parks the stage's work (Q2)
    // instead of launching a repair that would supersede the candidate or hold the project.
    const fx = await scriptedEngine(t);
    const p = await repairProject(fx, { defs: DEFS, governed: { required_checks: REQUIRED }, index: INDEX, policy: { autonomy: 'step', repair_attempts_max: 0 } });
    const { candidate: c1, reg } = await buildAndNominate(fx, p, { keys: REQUIRED });
    const ctx = { project: p, stage: p.stages[0].id, candidate: c1 };
    const ids = checkIds(fx.home, p.id);
    const failed = await recordExit(fx.engine, reg.smoke.id, 1, { output: 'smoke failed: a banned word in a comment\n' });
    const [found] = await raiseFindings(fx, p.id, c1.id, [finding('M235-g: the smoke check fails on the candidate', { check: 'smoke' })], { kind: 'verification' });
    assert.equal(findingRow(fx.home, found.id).criterion, null, 'the fixture is live: the finding names no criterion');
    const before = await stageGate(fx, ctx);
    assert.equal(before.check_states[ids.smoke], 'failed', `the fixture is live: smoke, required and covering no criterion, failed on the candidate (result ${failed.id})`);

    // T1 queues no review, so the finding is owed to the owner (SEAM.md §466).
    const owed = await openDecision(fx, p.id, 'finding_disposition', found.id, { max: 6 });
    assert.equal(owed.scope, 'disposition_owed', 'the owner is asked the owed question');
    const offered = owed.options.map((o) => o.key);
    assert.ok(offered.includes('fix'), `fix is offered: smoke can now show the finding fixed (offered ${JSON.stringify(offered)})`);
    assert.ok(offered.includes('correct_check'), `correct_check is offered without a conflict finding (offered ${JSON.stringify(offered)})`);

    await consume(fx, p.id, owed, 'fix');
    const row = findingRow(fx.home, found.id);
    assert.deepEqual([row.status, row.disposition], ['dispositioned', 'fix'], 'the owner dispositioned it fix');
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', found.id), [], 'a finding its criterion-less required check can show fixed routes no check_correction');

    const { smoke } = await passFresh(fx, p.id, c1.id, ['smoke']);
    assert.ok(withResult(fx, smoke.id).execution_seq > findingRow(fx.home, found.id).disposition_seq, 'the fixture is live: the pass was registered after the disposition');
    const resolving = await stageGate(fx, ctx);
    assert.equal(resolving.check_states[ids.smoke], 'passed', 'the fixture is live: smoke passed');
    const after = findingRow(fx.home, found.id);
    assert.equal(after.status, 'resolved', `the finding is resolved (reasons ${JSON.stringify(resolving.reasons)})`);
    assert.deepEqual(after.resolution_verification, { evaluation: resolving.id, check_result: smoke.id }, "by that evaluation and smoke's result");
    assert.deepEqual(missingFor(resolving, found.id), [], 'no missing verification is named for it');
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

  // ---- Objection 209 under Sean's rulings of 2026-10-23 (errata E180; SEAM.md §562) ----------------------------------

  test("(a) F26, D-1 and D-2 (objection 209; E180): a finding a Verifier's check_correction run raises (its work names no candidate, its reported scope candidate) is stored at project scope, its reported scope and the reason kept in finding.raised; dispositioned fix by the owner, its fix's candidate verified with login passing after the disposition, the stage gate the engine evaluates by itself resolves it and the fix completes; no blocker is raised", async (t) => {
    const fx = await scriptedEngine(t);
    const s = await uncandidatedFix(fx);
    const st = fixState(fx.home, s.p.id, s.fix.id, s.finding.id);
    assert.ok(
      st.finding?.status === 'resolved' && st.fix === 'complete',
      `F26 (D-1, D-2): a judgeable fix must resolve its finding and complete: the fix ${s.fix.id} is ${st.fix} and its finding ${s.finding.id} ${st.finding?.status}, ` +
        `although login passed on the fix's candidate ${s.c2.id} after the disposition and the engine's own stage gate there was satisfied; ` +
        `the finding is stored scope ${st.finding?.scope}, candidate ${st.finding?.candidate}, which applies to no candidate (gates.ts findingApplies), and no evaluation read it ` +
        `(read by ${JSON.stringify(st.read_by)} of ${JSON.stringify(st.evaluations.map((e) => [e.candidate, e.gate_kind, e.outcome]))}); the owner was told ${JSON.stringify((s.owed.options ?? []).find((o) => o.key === 'fix')?.consequence_text)}`,
    );
    const by = st.finding.resolution_verification;
    const evaluation = st.evaluations.find((e) => e.id === by.evaluation);
    assert.deepEqual([evaluation?.candidate, evaluation?.gate_kind], [s.c2.id, 'stage'], `resolved by a stage evaluation of the fix's candidate (${JSON.stringify(evaluation)})`);
    assert.equal(by.check_result, s.results.login.id, "through login's result on the fix's candidate, registered after the disposition");
    // D-1: stored at project scope; the reported scope and the reason kept in the audit record.
    const row = findingRow(fx.home, s.finding.id);
    assert.deepEqual([row.scope, row.candidate, row.subject_id], ['project', null, s.p.id], `D-1: a role finding with no source candidate is stored at project scope (stored ${JSON.stringify([row.scope, row.candidate, row.subject_id])})`);
    const raised = eventsOfType(fx.home, 'finding.raised').filter((e) => e.subject?.finding === s.finding.id);
    assert.equal(raised.length, 1, 'one finding.raised');
    assert.deepEqual(
      [raised[0].payload?.scope, raised[0].payload?.reported_scope, raised[0].payload?.scope_reason],
      ['project', 'candidate', 'no_source_candidate'],
      `D-1: finding.raised records the scope applied, the scope the role reported and the reason for the normalization (payload ${JSON.stringify(raised[0].payload)})`,
    );
    // A judgeable fix is judged, never asked about: no blocker of any reason about it.
    assert.deepEqual(fixUnjudged(fx.home, s.fix.id), [], 'no fix_unjudged blocker about it');
    const open = withStore(fx.home, (db) => db.prepare(`SELECT "id", "kind" FROM "decisions" WHERE "subject_id" = ? AND "status" = 'open'`).all(s.fix.id));
    assert.deepEqual(open, [], `and no open question about it (${JSON.stringify(open)})`);
  });

  test("(a) F33, D-2 (objection 209; E180): two plain fixes whose findings were raised after their stage was verified, fix 1's candidate superseded by fix 2's before it was verified (holding fix 1 by ancestry), fix 2's candidate verified with login passing after both dispositions: the engine schedules the stage gate on that current candidate by itself, which resolves both findings from its own results and completes both fixes; no superseded candidate's result is evidence, no other candidate is evaluated, the verified stage is not reopened and its scope gains no check", async (t) => {
    const fx = await scriptedEngine(t);
    const s = await supersededFix(fx, { verifyC2: false });
    // A superseded candidate's pass, recorded after both dispositions: never evidence (D3 Q9).
    const ids = checkIds(fx.home, s.p.id);
    const stale = await postResult(fx.engine, s.p.id, { candidate: s.c2.id, check: ids.login, exit_status: 0 });
    await tick(fx.engine, s.p.id, { rounds: 4 });
    const disposedAt = s.findings.map((f) => f.disposition_at).sort()[0];
    for (const [i, fix] of s.fixes.entries()) {
      const f = s.findings[i];
      const st = fixState(fx.home, s.p.id, fix.id, f.id);
      assert.ok(
        st.finding?.status === 'resolved' && st.fix === 'complete',
        `F33 (D-2): a judgeable fix must resolve its finding and complete: fix ${i + 1} ${fix.id} is ${st.fix}, held by ${JSON.stringify(st.holders)} and by ${s.c3.id} by ancestry, its finding ${f.id} ${st.finding?.status}, ` +
          `although login passed on ${s.c3.id}, the current candidate holding it, after the disposition and that candidate's verification is complete: no gate was scheduled for it ` +
          `(evaluations: ${JSON.stringify(st.evaluations.map((e) => [e.candidate, e.gate_kind, e.outcome]))}); gates.ts dueStageGates makes due only a verifying stage_build's gates or an asset_updated fix's`,
      );
      const by = st.finding.resolution_verification;
      const evaluation = st.evaluations.find((e) => e.id === by.evaluation);
      assert.deepEqual([evaluation?.candidate, evaluation?.gate_kind], [s.c3.id, 'stage'], `fix ${i + 1}: resolved by a stage evaluation of the current candidate (${JSON.stringify(evaluation)})`);
      assert.equal(by.check_result, s.onC3.login.id, `fix ${i + 1}: from the current candidate's own login result, never the superseded one's (${stale.id})`);
      assert.ok(s.onC3.login.execution_seq > f.disposition_seq, `fix ${i + 1}: fresh evidence, registered after the disposition`);
    }
    const evaluations = withStore(fx.home, (db) => db.prepare('SELECT "id", "candidate", "gate_kind", "stage", "check_states", "created_at" FROM "gate_evaluations" WHERE "project" = ? ORDER BY rowid').all(s.p.id));
    const later = evaluations.filter((e) => e.created_at >= disposedAt);
    assert.deepEqual([...new Set(later.map((e) => e.candidate))], [s.c3.id], `after the dispositions only the current holder is evaluated: neither the superseded candidate nor candidate 1, which does not hold the fixes (${JSON.stringify(later.map((e) => [e.candidate, e.gate_kind]))})`);
    const before = evaluations.find((e) => e.candidate === s.c1.id && e.gate_kind === 'stage');
    for (const e of later.filter((x) => x.gate_kind === 'stage')) {
      assert.deepEqual(Object.keys(JSON.parse(e.check_states)).sort(), Object.keys(JSON.parse(before.check_states)).sort(), `the stage scope evaluated is the stage's own, no check added to make an evaluation (${e.check_states})`);
    }
    const stageWork = workItem(fx.home, s.stage);
    assert.equal(stageWork.status, 'complete', 'the verified stage is not reopened: its work still complete');
    const stageEvents = eventsOfType(fx.home, 'work.advanced').concat(eventsOfType(fx.home, 'work.transitioned')).filter((e) => e.subject?.work_item === s.stage && e.at >= disposedAt);
    assert.deepEqual(stageEvents.map((e) => [e.type, e.payload?.from, e.payload?.to]), [], 'and no transition of it after the dispositions');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "status" FROM "stages" WHERE "id" = ?').get(s.p.stages[0].id)).status, 'verified', 'the stage still verified');
    for (const fix of s.fixes) assert.deepEqual(fixUnjudged(fx.home, fix.id), [], `no fix_unjudged blocker about a judgeable fix ${fix.id}`);
  });

  test("(c) D-3 (objection 209; E180): a fix no supported evaluation can judge (its named check login required at alpha_authorize only, in no stage scope of the candidate holding it) gets exactly one actionable fix_unjudged blocker naming the fix, its finding, the check and the missing prerequisite, never while its run or its candidate's verification is in flight; repeated ticks raise no second; retry re-judges and dispatches no Builder; cancel cancels the fix only, the finding unresolved and its owed disposition presented again", async (t) => {
    const fx = await scriptedEngine(t);
    const { p, c1, ctx } = await fixProject(fx, { defs: ALPHA_ONLY, required: ALPHA_ONLY_REQUIRED });
    await verified(fx, p, c1, { required: ALPHA_ONLY_REQUIRED });
    const stage = p.stages[0].work_item;
    await tickUntil(fx.engine, p.id, () => workItem(fx.home, stage).status === 'complete', { max: 8, what: 'the stage verified on candidate 1' });
    const [found] = await raiseFindings(fx, p.id, c1.id, [defect('D-3: login refuses a valid session')], { kind: 'verification' });
    const { fix } = await ownerFix(fx, p, found);
    assert.deepEqual(workFor(fx.home, p.id, 'check_correction', found.id), [], 'the fixture is live: login, a required acceptance check covering R1.1 at alpha_authorize, verifies the finding (no missing verification, no check_correction)');
    // Ordinary work in flight is not the condition: the fix's run held, then its candidate's verification pending.
    fx.scripted.script(fix.id, [roleThatHolds([], [step.write('src/fix-d3.js', 'export const fixed = true;\n')], { nominate: true })]);
    await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix.id), 'continue');
    await runToHold(fx, p.id, fix.id);
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.deepEqual(fixUnjudged(fx.home, fix.id), [], "the fix's run in flight: no fix_unjudged");
    fx.scripted.release(fix.id);
    await waitForRun(fx.home, fix.id, { state: 'ended' });
    const [, c2] = await waitForCandidates(fx, p.id, 2);
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.deepEqual(fixUnjudged(fx.home, fix.id), [], "its candidate's verification pending: no fix_unjudged");
    await verified(fx, p, c2, { required: ALPHA_ONLY_REQUIRED });
    await tick(fx.engine, p.id, { rounds: 4 });
    const raised = fixUnjudged(fx.home, fix.id);
    const st = fixState(fx.home, p.id, fix.id, found.id);
    assert.equal(
      raised.length,
      1,
      `D-3: a fix no supported evaluation can judge gets one fix_unjudged blocker: ${raised.length} raised; the fix ${fix.id} is ${st.fix}, its finding ${st.finding?.status}, nothing asked about either (${JSON.stringify(st.asked)}), ` +
        `login passed on ${c2.id} after the disposition but no stage scope requires it and no evaluation read it (${JSON.stringify(st.evaluations.map((e) => [e.candidate, e.gate_kind, e.outcome]))})`,
    );
    const [blocker] = raised;
    assert.equal(blocker.status, 'open', 'open');
    assert.deepEqual([blocker.dependency_manifest.cause, blocker.dependency_manifest.finding, blocker.dependency_manifest.check], ['fix_unjudged', found.id, 'login'], `naming the finding and the check (${JSON.stringify(blocker.dependency_manifest)})`);
    assert.ok(typeof blocker.dependency_manifest.missing === 'string' && blocker.dependency_manifest.missing.length > 0, `and the missing prerequisite (${JSON.stringify(blocker.dependency_manifest.missing)})`);
    for (const named of [fix.id, found.id, 'login']) assert.ok(blocker.question.includes(named), `its question names ${named} (${blocker.question})`);
    assert.deepEqual((blocker.options ?? []).map((o) => o.key).sort(), ['cancel', 'retry'], `retry or cancel (${JSON.stringify((blocker.options ?? []).map((o) => o.key))})`);
    assert.equal(workItem(fx.home, fix.id).status, 'verifying', 'the fix not sent back');
    const checksAdded = withStore(fx.home, (db) => db.prepare(`SELECT "check_states" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage'`).all(c2.id)).filter((e) => Object.keys(JSON.parse(e.check_states)).includes(checkIds(fx.home, p.id).login));
    assert.deepEqual(checksAdded, [], 'no stage scope gains login to manufacture an evaluation');
    await tick(fx.engine, p.id, { rounds: 4 });
    assert.equal(fixUnjudged(fx.home, fix.id).length, 1, 'repeated ticks raise no second');
    const runsBefore = runsOf(fx.home, fix.id).length;
    // retry: eligibility judged again; still impossible, so no Builder run and the question asked again, once.
    await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix.id), 'retry');
    await tick(fx.engine, p.id, { rounds: 5 });
    assert.equal(runsOf(fx.home, fix.id).length, runsBefore, 'retry dispatches no Builder run while evaluation stays impossible');
    assert.equal(workItem(fx.home, fix.id).status, 'verifying', 'the fix still verifying, not eligible');
    assert.equal(fixUnjudged(fx.home, fix.id, { open: true }).length, 1, 'still unjudgeable: one fix_unjudged open again, never none (no silent hold)');
    assert.ok(fixUnjudged(fx.home, fix.id).length <= 2, `no automatic retry loop: at most one more raised (${fixUnjudged(fx.home, fix.id).length})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(fixUnjudged(fx.home, fix.id).length <= 2 && fixUnjudged(fx.home, fix.id, { open: true }).length === 1, true, 'and no more on further ticks');
    // cancel: the fix only; the finding unresolved, its owed disposition presented again.
    const cancelledBefore = workItemsOf(fx.home, p.id).filter((w) => w.status === 'cancelled').map((w) => w.id);
    await consume(fx, p.id, await openDecision(fx, p.id, 'blocker', fix.id), 'cancel');
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(workItem(fx.home, fix.id).status, 'cancelled', 'cancel cancels the fix');
    assert.deepEqual(workItemsOf(fx.home, p.id).filter((w) => w.status === 'cancelled').map((w) => w.id).filter((id) => !cancelledBefore.includes(id)), [fix.id], 'and nothing else');
    assert.notEqual(findingRow(fx.home, found.id).status, 'resolved', 'the finding unresolved');
    const owedAgain = withStore(fx.home, (db) => db.prepare(`SELECT "id", "scope" FROM "decisions" WHERE "kind" = 'finding_disposition' AND "subject_id" = ? AND "status" = 'open'`).all(found.id));
    assert.equal(owedAgain.length, 1, `its owed finding_disposition presented again (${JSON.stringify(owedAgain)})`);
    assert.equal(runsOf(fx.home, fix.id).length, runsBefore, 'no Builder run');
    assert.equal(workItem(fx.home, stage).status, 'complete', 'the stage untouched');
  });

  test("(a) D-1 legacy rows (objection 209; E180): findings already stored with scope candidate and no candidate (the shape the engine wrote before D-1, made in the test's own store with the engine stopped) are read by future evaluations as project findings: a dispositioned fix one is resolved when its check passes after the disposition and its fix completes, an open one stands at the gate; neither row's stored scope is rewritten and an evaluation recorded before is unchanged", async (t) => {
    const fx = await scriptedEngine(t);
    const { p, c1, ctx } = await fixProject(fx);
    // An evaluation recorded before: candidate 1's stage gate, its checks not yet run.
    const historical = await stageGate(fx, ctx, c1);
    const columns = (id) => withStore(fx.home, (db) => db.prepare('SELECT "id", "candidate", "gate_kind", "outcome", "reasons", "check_states", "inputs_snapshot", "inputs_hash", "missing_verifications" FROM "gate_evaluations" WHERE "id" = ?').get(id));
    const then = columns(historical.id);
    const { run } = await acceptedRun(fx, p.id, 'check_correction', {
      result: { findings: [defect('legacy: dispositioned fix', { scope: 'candidate' }), defect('legacy: left open', { scope: 'candidate' })] },
    });
    const [fixed, open] = withStore(fx.home, (db) => db.prepare('SELECT * FROM "findings" WHERE "source_run" = ? ORDER BY "seq"').all(run.id));
    const { fix } = await ownerFix(fx, p, fixed);
    const c2 = await successor(fx, ctx, { work: fix.id });
    const stored = await legacyShape(fx, p.id, [fixed.id, open.id]);
    assert.deepEqual(stored.map((r) => [r.scope, r.candidate]), [['candidate', null], ['candidate', null]], 'the fixture is live: both rows in the malformed shape');
    const results = await verified(fx, p, c2);
    await tick(fx.engine, p.id, { rounds: 4 });
    const st = fixState(fx.home, p.id, fix.id, fixed.id);
    assert.ok(
      st.finding?.status === 'resolved' && st.fix === 'complete',
      `D-1 legacy: a stored finding with scope candidate and no candidate must be read as a project finding by future evaluations: the dispositioned one ${fixed.id} is ${st.finding?.status}, its fix ${st.fix}, ` +
        `read by ${JSON.stringify(st.read_by)} of ${JSON.stringify(st.evaluations.map((e) => [e.candidate, e.gate_kind, e.outcome]))}, although login passed on ${c2.id} after its disposition`,
    );
    assert.equal(st.finding.resolution_verification.check_result, results.login.id, "resolved through login's fresh result on the fix's candidate");
    const latest = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'stage' ORDER BY rowid DESC LIMIT 1`).get(c2.id));
    const unsatisfied = (JSON.parse(latest.reasons) ?? []).filter((r) => r.code === 'FINDING_UNSATISFIED').flatMap((r) => r.subjects ?? []);
    assert.ok(unsatisfied.includes(open.id), `the open legacy finding stands at the gate as a project finding (FINDING_UNSATISFIED: ${JSON.stringify(unsatisfied)})`);
    assert.deepEqual([fixed.id, open.id].map((id) => [findingRow(fx.home, id).scope, findingRow(fx.home, id).candidate]), [['candidate', null], ['candidate', null]], "neither row's stored scope is rewritten");
    assert.deepEqual(columns(historical.id), then, 'the evaluation recorded before is unchanged');
  });
  test("(c) D-3, the blocked fix (objection 209; E180; Sean's acceptance of 2026-10-23: a blocked fix may stay verifying \"provided the blocker is visible, prevents inappropriate dispatch and is distinguished from runnable work by the harness\"): its fix_unjudged blocker is open and readable through the decisions reads, naming the fix, its finding and check; while it is open, nothing is dispatched for the fix and no Builder runs, however many ticks of the unpaused project", async (t) => {
    const fx = await scriptedEngine(t);
    const s = await unjudgedFix(fx);
    // Visible: in the open decisions read and the decision read, with its cause and what it names.
    const list = await fx.engine.get(`/v1/projects/${s.p.id}/decisions`);
    assert.equal(list.status, 200, 'the decisions read answers');
    assert.ok(JSON.stringify(list.body).includes(s.blocker.id), `the blocker is in the open decisions read (${JSON.stringify(list.body).slice(0, 400)})`);
    const one = await fx.engine.get(`/v1/projects/${s.p.id}/decisions/${s.blocker.id}`);
    assert.equal(one.status, 200, 'the decision read answers');
    const text = JSON.stringify(one.body);
    for (const named of ['fix_unjudged', s.fix.id, s.finding.id, 'login']) assert.ok(text.includes(named), `the decision read shows ${named} (${text.slice(0, 600)})`);
    // Held from dispatch: the project unpaused, ticks run; no run of the fix, no Builder run of anything.
    const builders = () => withStore(fx.home, (db) => db.prepare(`SELECT "id", "work_item", "role" FROM "runs" WHERE "project" = ? AND "role" = 'builder' ORDER BY rowid`).all(s.p.id));
    const runsBefore = builders();
    await tick(fx.engine, s.p.id, { rounds: 6 });
    assert.deepEqual(builders(), runsBefore, 'no Builder run while the blocker is open');
    assert.deepEqual([workItem(fx.home, s.fix.id).status, runsOf(fx.home, s.fix.id).length], ['verifying', 1], 'the fix still verifying, its one run the one that built it');
    assert.deepEqual(fixUnjudged(fx.home, s.fix.id, { open: true }).map((d) => d.id), [s.blocker.id], 'the same blocker still open, alone');
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
