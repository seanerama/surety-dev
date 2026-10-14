// M437 (c), (d), (e): pipelining and parallel builds (M5 slice 37; kernel
// lane). M5 plan §3.7 M437; D6-X05; D6 §6.4; K2; B08, B09; D1 §7.5;
// SEAM.md §§43, 427
//
// The reference project on the journey's own path (journey35), its stages'
// Builders scripted by work item, under the kernel lane's scripted envelope
// † admitting two role domains (`MemAvailable` 10 GiB: the reserve 2 GiB and
// two at `role_memory_max` 4 GiB) or three (14 GiB).
//   (c) stage 2's Builder runs while stage 1's Verifier runs, on stage 1's
//       integrated code, and a third eligible item waits
//       `resource_envelope`; two independent stages build at once in two
//       workspaces;
//   (d) a fix of stage 1 integrating after stage 2's build is rebased onto
//       it and its candidate supersedes; stage 2's stage gate is evaluated
//       on a candidate holding both; the pre-rebase Reviewer sign-off and
//       the old candidate's evidence are not copied to the successor (the
//       late earlier-stage fix is a new candidate); a fix whose write a
//       protected change made protected while it ran is refused on the
//       rebased successor;
//   (e) two integrations released together serialize under the lease (the
//       later rebased onto the earlier); three runs of one project at once;
//       one run per work item; no project run count (`max_concurrent_runs`
//       refused at the policy route, `unknown_field`). A session admits no
//       one-shot beside it on its project: M419 (a), (d), (e), not re-run.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { governedEdit, humanApplies } from './harness/gates.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { ROUTED_KINDS, builderScript, candidatesOfProject, signoffsOfProject } from './harness/journey/drive.mjs';
import { pumpHolding } from './harness/journey/change36.mjs';
import { revisionsOf } from './harness/journal.mjs';
import { assertOneRunPerItem } from './harness/invariants.mjs';
import { refOid } from './harness/repos.mjs';
import { addWork, runsOf } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { GIB, findingFix, heldBuilder, holding, holdOf, liveRuns, stageRow, threeStages, twoStages, workRow } from './harness/exec37/envelope.mjs';

const NO_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const TWO = Object.freeze({ mem_available: 10 * GIB, default_current: 0 });
const THREE = Object.freeze({ mem_available: 14 * GIB, default_current: 0 });
const HELD_VERIFIER = { steps: [step.hold('gate', { heartbeat_ms: 250 }), step.result()] };
const advance = (J, done, { exits = () => 0, what, max = 120 } = {}) =>
  pumpHolding(J.fx, J.ctx, done, { exits: (x) => exits(x), hold: (x) => exits(x) === null, answerKinds: NO_PLAN, what, max });
const heldFix = (files) => ({ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...Object.entries(files).map(([path, text]) => step.write(path, text)), step.result()] });
const isAncestor = (repo, a, b) => {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const workspacesOf = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "workspaces" WHERE "run" = ?').all(run));
const stageEvaluations = (home, stage) => withStore(home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "gate_kind" = 'stage' AND "stage" = ? ORDER BY rowid`).all(stage));
const resultsOn = (home, candidate) =>
  withStore(home, (db) => db.prepare('SELECT r.*, x."candidate" AS "execution_candidate" FROM "check_results" r LEFT JOIN "check_executions" x ON x."id" = r."execution" WHERE r."candidate" = ? ORDER BY r.rowid').all(candidate));

describe('M437 pipelining and parallel builds', () => {
  test('(c) with the envelope admitting two, stage 2\'s Builder runs on stage 1\'s integration while stage 1\'s Verifier runs; a third item waits resource_envelope', async (t) => {
    const J = await twoStages(t, { envelope: TWO, scripts: { 1: builderScript(1), 2: heldBuilder(2) } });
    const { fx, p, plan, items } = J;
    fx.scripted.kindScript('verification', HELD_VERIFIER);
    const both = await advance(J, () => {
      const verifier = fx.scripted.launches({ work_kind: 'verification' }).find((l) => fx.scripted.eventsOf(l.pid, 'holding').length > 0);
      return verifier && holding(fx, items[2]) ? verifier : undefined;
    }, { what: 'stage 1\'s Verifier and stage 2\'s Builder running at once' });
    assert.ok(both, 'both held');
    assert.equal(liveRuns(fx.home, p.id).length, 2, `two runs of the project at once (${JSON.stringify(liveRuns(fx.home, p.id).map((r) => r.role))})`);
    const s1 = stageRow(fx.home, plan.id, 1);
    assert.equal(s1.status, 'integrated', 'stage 1 integrated, its verification under way');
    const [run2] = runsOf(fx.home, items[2]);
    assert.ok(isAncestor(p.repo.path, s1.integrated_revision, run2.base_revision), `stage 2's Builder starts on stage 1's integrated code (${s1.integrated_revision} an ancestor of ${run2.base_revision})`);
    // A third eligible item: the envelope holds it.
    const third = await addWork(fx.engine, p.id, 'fix');
    await advance(J, () => holdOf(fx, p.id, third), { what: 'the third item\'s hold', max: 10, exits: () => null });
    const hold = await holdOf(fx, p.id, third);
    assert.deepEqual([hold?.code, runsOf(fx.home, third).length], ['resource_envelope', 0], `the third waits resource_envelope with no run (${JSON.stringify(hold)})`);
    fx.scripted.release('all', 'gate');
  });

  test('(c) two independent stages build at once, in two workspaces', async (t) => {
    const J = await threeStages(t, { envelope: TWO, scripts: { 1: heldBuilder(1), 3: heldBuilder(3) } });
    const { fx, p, items } = J;
    await advance(J, () => (holding(fx, items[1]) && holding(fx, items[3]) ? true : undefined), { what: 'stages 1 and 3 building at once' });
    const [r1] = runsOf(fx.home, items[1]);
    const [r3] = runsOf(fx.home, items[3]);
    const w1 = workspacesOf(fx.home, r1.id);
    const w3 = workspacesOf(fx.home, r3.id);
    assert.equal(w1.length, 1, 'stage 1\'s run has its workspace');
    assert.equal(w3.length, 1, 'stage 3\'s run has its workspace');
    assert.notEqual(w1[0].path, w3[0].path, 'two workspaces');
    assert.equal(liveRuns(fx.home, p.id).length, 2, 'two runs of one project at once');
    fx.scripted.release('all', 'gate');
  });

  test('(d) a fix of stage 1 integrating after stage 2\'s build: rebased, its candidate supersedes, stage 2\'s gate on a candidate holding both; nothing copied', async (t) => {
    const J = await twoStages(t, { envelope: TWO, scripts: { 1: builderScript(1), 2: heldBuilder(2) } });
    const { fx, p, plan, items } = J;
    // Stage 1 verified (its Reviewer's sign-off bound at claim), stage 2's Builder held.
    await advance(J, () => (stageRow(fx.home, plan.id, 1).status === 'verified' && holding(fx, items[2]) ? true : undefined), { what: 'stage 1 verified and stage 2 building' });
    const c1 = candidatesOfProject(fx.home, p.id).at(-1);
    const signedC1 = signoffsOfProject(fx.home, p.id).filter((s) => s.candidate === c1.id);
    assert.ok(signedC1.length > 0, 'the fixture is live: stage 1\'s candidate has its Reviewer\'s sign-off');
    // A late fix of stage 1, building beside stage 2's Builder: a finding on
    // stage 1's candidate dispositioned `fix`, so its integration nominates
    // (E104; objection 092).
    const { item: fix } = await findingFix(fx, p.id, c1.id, heldFix({ 'src/sum.mjs': 'export const sum = (a, b) => Number(a) + Number(b);\n' }));
    await advance(J, () => holding(fx, fix), { what: 'the fix building beside stage 2', exits: () => null });
    // Stage 2 integrates first; its candidate's checks left queued.
    fx.scripted.release(items[2], 'gate');
    const c2 = await advance(J, () => (stageRow(fx.home, plan.id, 2).integrated_revision ? candidatesOfProject(fx.home, p.id).find((c) => c.seq > c1.seq) : undefined), { what: 'stage 2 integrated and nominated', exits: () => null });
    const s2 = stageRow(fx.home, plan.id, 2);
    // Then the fix: rebased onto stage 2's integration.
    fx.scripted.release(fix, 'gate');
    const c3 = await advance(J, () => candidatesOfProject(fx.home, p.id).find((c) => c.seq > c2.seq), { what: 'the fix integrated and its candidate nominated', exits: () => null });
    const [fixRun] = runsOf(fx.home, fix);
    assert.deepEqual([fixRun.outcome, fixRun.reason_class], ['completed', 'none'], `the fix integrates (${fixRun.reason_text})`);
    // The fix's commit on the branch: its engine commit that the fix candidate
    // holds (the snapshot before the rebase is not on the branch). Revisions
    // are read by ancestry, never by id or time order.
    const fixRevisions = revisionsOf(fx.home, { run: fixRun.id });
    const rebased = fixRevisions.find((r) => r.kind === 'engine_commit' && isAncestor(p.repo.path, r.sha, c3.revision));
    assert.ok(rebased, `the fix is integrated as an engine commit the fix candidate holds (${JSON.stringify(fixRevisions.map((r) => [r.kind, r.sha, r.parent_sha]))})`);
    assert.ok(isAncestor(p.repo.path, s2.integrated_revision, rebased.sha), 'the rebased fix sits on stage 2\'s integration');
    assert.ok(isAncestor(p.repo.path, s2.integrated_revision, c3.revision) && isAncestor(p.repo.path, rebased.sha, c3.revision), 'the fix\'s candidate holds both by ancestry');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "superseded_by" FROM "candidates" WHERE "id" = ?').get(c2.id)).superseded_by, c3.id, 'the fix candidate supersedes stage 2\'s');
    // Nothing copied to the successor at its nomination.
    assert.equal(signoffsOfProject(fx.home, p.id).filter((s) => s.candidate === c3.id).length, 0, 'no sign-off copied to the successor');
    assert.equal(resultsOn(fx.home, c3.id).length, 0, 'no result copied to the successor');
    // Stage 2's stage gate decides on the successor.
    const onC3 = await advance(J, () => stageEvaluations(fx.home, s2.id).find((e) => e.candidate === c3.id), { what: 'stage 2\'s stage gate evaluated on the fix candidate' });
    assert.ok(onC3, 'stage 2\'s gate evaluated on a candidate holding both');
    for (const r of resultsOn(fx.home, c3.id)) assert.equal(r.execution_candidate, c3.id, 'every result on the successor is from an execution on it');
    assert.ok(!stageEvaluations(fx.home, s2.id).some((e) => e.candidate === c2.id && e.outcome === 'satisfied' && e.stale === 0), 'no current satisfied stage-2 evaluation on the superseded candidate');
  });

  test('(d) a fix whose write a protected change made protected while it ran is refused on the rebased successor', async (t) => {
    const J = await twoStages(t, { envelope: TWO, scripts: { 1: builderScript(1), 2: heldBuilder(2) } });
    const { fx, p, plan, items } = J;
    await advance(J, () => (stageRow(fx.home, plan.id, 1).status === 'verified' && holding(fx, items[2]) ? true : undefined), { what: 'stage 1 verified and stage 2 building' });
    const fix = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(fix, [heldFix({ 'docs/notes.md': '# Notes\n' })]);
    await advance(J, () => holding(fx, fix), { what: 'the fix building beside stage 2', exits: () => null });
    // The owner's protected change, applied while both run: docs/ protected.
    const proposal = await governedEdit(fx, p, { protected_paths: ['.surety/checks/', 'docs/'] });
    await humanApplies(fx, p, proposal, 'tightening');
    const head = refOid(p.repo.path, p.repo.ref);
    fx.scripted.release(fix, 'gate');
    const ended = await advance(J, () => runsOf(fx.home, fix).find((r) => r.state === 'ended'), { what: 'the fix\'s run ended', exits: () => null });
    assert.notEqual(ended.outcome, 'completed', `the rebased fix writing a now-protected path is refused (${ended.outcome} ${ended.reason_class} ${ended.reason_text})`);
    assert.match(`${ended.reason_class} ${ended.reason_text}`, /diff_violation|protected/, 'naming the protected path');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing of the fix integrated');
    fx.scripted.release('all', 'gate');
  });

  test('(e) integrations released together serialize; three runs of one project at once; one run per work item; no project run count', async (t) => {
    // `budget_run_billable_tokens` at its minimum (a tightening), so the day
    // budget's reservation of each run under way (D1 §13.3; D6 §6.5, a
    // separate bound) admits a third run of the project (objection 091, the
    // driver's ruling).
    const J = await threeStages(t, { envelope: THREE, policy: { budget_run_billable_tokens: CONTRACT.project.budget_run_billable_tokens.min }, scripts: { 1: heldBuilder(1), 3: heldBuilder(3) } });
    const { fx, p, plan, items } = J;
    await advance(J, () => (holding(fx, items[1]) && holding(fx, items[3]) ? true : undefined), { what: 'stages 1 and 3 building at once' });
    const fix = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(fix, [heldFix({ 'docs/extra.md': '# Extra\n' })]);
    await advance(J, () => holding(fx, fix), { what: 'a third run of the project', exits: () => null });
    assert.equal(liveRuns(fx.home, p.id).length, 3, 'three runs of one project at once: no project run count bounds admission');
    // The two Builders released together: their integrations serialize under the lease.
    fx.scripted.release(items[1], 'gate');
    fx.scripted.release(items[3], 'gate');
    await advance(J, () => (stageRow(fx.home, plan.id, 1).integrated_revision && stageRow(fx.home, plan.id, 3).integrated_revision ? true : undefined), { what: 'stages 1 and 3 integrated', exits: () => null });
    const a = stageRow(fx.home, plan.id, 1).integrated_revision;
    const b = stageRow(fx.home, plan.id, 3).integrated_revision;
    assert.ok(isAncestor(p.repo.path, a, b) !== isAncestor(p.repo.path, b, a), `one integration is on the other: serial (${a}, ${b})`);
    const later = isAncestor(p.repo.path, a, b) ? items[3] : items[1];
    const [laterRun] = runsOf(fx.home, later);
    assert.ok(revisionsOf(fx.home, { run: laterRun.id }).some((r) => r.kind === 'engine_commit'), 'the later integration rebased onto the earlier');
    fx.scripted.release(fix, 'gate');
    await advance(J, () => runsOf(fx.home, fix).find((r) => r.state === 'ended'), { what: 'the fix ended', exits: () => 0 });
    withStore(fx.home, (db) => assertOneRunPerItem(db, p.id));
    const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, { max_concurrent_runs: 3 });
    assert.deepEqual([res.status, res.body?.code, res.body?.subject?.field], [400, 'unknown_field', 'max_concurrent_runs'], `max_concurrent_runs is not a project setting (→ ${res.status} ${res.text})`);
    assert.ok(workRow(fx.home, items[2]), 'the fixture is live');
  });
});
