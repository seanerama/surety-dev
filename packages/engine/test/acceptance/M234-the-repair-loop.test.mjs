// M234, the repair loop (M3 slice 21; kernel lane). M3 plan §3.7 M234;
// D3 §2.10 (Q2, decided (a), with T13's conditions), D3-R20, D3-R21; D1
// §4.3; SEAM.md §§228 to 230, 232.
//
// A `fix` and a `stage_build` in `verifying` whose repair check fails at the
// item's current candidate is sent back to its Builder once (`verifying →
// eligible`, `repair_attempts` + 1), in the transition that records the
// failure, with every failed repair check's output in the next run's context
// (in the kernel lane, the scripted launch request's `check_outputs`, SEAM
// §229). Only the latest registration's state counts; `skipped`, `missing`,
// `stale` and a superseded candidate's result never consume a repair; a
// restart or a repeated tick takes no second repair for the same candidate;
// several failed checks of one build spend one repair; the same failure on
// an unchanged tree counts toward `no_progress_max`, and either limit parks
// with a blocker naming the checks; a conflict finding from the Builder's run
// wins over the repair and takes D3 §5 X2's route.
//
// Kernel lane: checks discovered from the project's definitions, registered
// at nomination and moved through the scripted check boundary (SEAM.md
// §190); case (f) declares its checks with the fixture after the nomination
// so that no registration stands between a fixture result and the gate
// (SEAM.md §189).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { openDecision } from './harness/decisions.mjs';
import { changePolicy, workItemsOf } from './harness/journal.mjs';
import { check, installChecks, nominated, postResult, raiseFindings, review, stageGate, successor } from './harness/gates.mjs';
import { permittedEdit, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { pauseProject, resumeProject, runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { candidateRow, drive, operatorRequest, recordExit } from './harness/checks/selection.mjs';
import {
  buildAndNominate,
  checkIds,
  checkOutputs,
  itemRow,
  launchesOf,
  outputOf,
  registrationsBy,
  repairProject,
  repairsOf,
  resultEvent,
  stepsOf,
  x2Blocker,
} from './harness/checks/repair.mjs';

const REPAIR_WRITE = roleThat([step.write('src/repair.js', 'export const repaired = true;\n')]);
const treeOf = (repo, rev) => gitQuiet(repo, ['rev-parse', `${rev}^{tree}`]);

// The context a repair run was given: each failed repair check's key, check, result and output record.
const told = (launch) => checkOutputs(launch).map((o) => [o.key, o.check, o.check_result, o.output]);
const expected = (home, ids, failed) =>
  Object.entries(failed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, result]) => [key, ids[key], result.id, outputOf(home, result.id)]);

// Asks for ticks until the item's (n+1)-th run has ended. Returns the run.
const runEnded = (fx, project, item, n) =>
  tickUntil(fx.engine, project, () => (runsOf(fx.home, item)[n]?.state === 'ended' ? runsOf(fx.home, item)[n] : undefined), { what: `run ${n + 1} of ${item} to end` });

// A project at T1 (acc covering R1.1, smoke), its stage built and nominated,
// the stage's Builder scripted for a second run that writes a file.
async function builtStage(t, { config, second = REPAIR_WRITE, first } = {}) {
  const fx = await scriptedEngine(t, config === undefined ? {} : { config });
  const p = await repairProject(fx);
  const scripts = [first ?? roleThat([permittedEdit()], { nominate: true }), second];
  const b = await buildAndNominate(fx, p, { scripts });
  assert.equal(itemRow(fx.home, b.item).status, 'verifying', "the fixture is live: the nomination moved the stage's work to verifying");
  return { fx, p, ...b, ids: checkIds(fx.home, p.id) };
}

describe('M234 the repair loop', () => {
  test("(a) a stage_build: a failed required check of its stage scope at its current candidate sends it back once, in the transition that records the failure, repair_attempts + 1, with the failed output (and only it) in the next run's context", async (t) => {
    const { fx, p, item, candidate, reg, ids } = await builtStage(t);
    await recordExit(fx.engine, reg.smoke.id, 0, { output: 'smoke passed\n' });
    assert.equal(itemRow(fx.home, item).status, 'verifying', 'a passing check sends nothing back');

    const failed = await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-a: the acceptance check failed\n' });
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts], ['eligible', 1], 'with no tick: the stage_build is sent back, verifying → eligible, one repair counted');
    const repairs = repairsOf(fx.home, item);
    assert.equal(repairs.length, 1, 'one verifying → eligible step');
    assert.equal(repairs[0].tx, resultEvent(fx.home, failed.id)?.tx, 'in the transaction that recorded the failed result (D3 §2.10: reconciled in every transition that records a result)');
    assert.equal(row.check_repair?.candidate, candidate.id, 'work_items.check_repair names the candidate the repair was taken for (D3 A.3)');

    await runEnded(fx, p.id, item, 1);
    const launch = launchesOf(fx, item)[1];
    assert.deepEqual(told(launch), expected(fx.home, ids, { acc: failed }), "the repair run's context names the failed check's result and output record, and not the passing check's");
  });

  test("(a) a fix: its named check failing on the fix's candidate sends it back once; another check failing there, and the stage's checks, send nothing back", async (t) => {
    const fx = await scriptedEngine(t);
    const p = await repairProject(fx);
    const { item: stageItem, candidate: c1 } = await buildAndNominate(fx, p);
    const ids = checkIds(fx.home, p.id);
    const [found] = await raiseFindings(fx, p.id, c1.id, [{ category: 'defect', severity: 'medium', message: 'the session survives a logout', check: 'acc', criterion: 'R1.1' }], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix' }] });
    const fix = workItemsOf(fx.home, p.id).find((w) => w.kind === 'fix' && w.subject?.finding === found.id);
    assert.ok(fix, 'the fixture is live: the engine registered the fix for the disposition (E43)');
    const c2 = await successor(fx, { project: p }, { work: fix.id });
    fx.scripted.script(fix.id, [roleThat([]), roleThat([step.write('src/fix-repair.js', 'export const again = true;\n')])]);
    assert.equal(itemRow(fx.home, fix.id).status, 'verifying', "the fixture is live: the fix is verifying on its candidate");
    const reg = await tickUntil(fx.engine, p.id, () => {
      const r = registrationsBy(fx.home, c2.id);
      return r.acc && r.smoke ? r : undefined;
    }, { max: 6, what: "the fix candidate's registrations" });

    await recordExit(fx.engine, reg.smoke.id, 1, { output: 'M234-fix: smoke failed\n' });
    assert.deepEqual([itemRow(fx.home, fix.id).status, repairsOf(fx.home, fix.id).length], ['verifying', 0], "a check the finding does not name is no repair check of the fix: nothing is sent back");

    const failed = await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-fix: the named check failed\n' });
    const row = itemRow(fx.home, fix.id);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, fix.id).length], ['eligible', 1, 1], 'the named check failed on the fix candidate: the fix is sent back once');
    assert.equal(row.check_repair?.candidate, c2.id, "the repair is taken for the fix's candidate");
    assert.deepEqual([itemRow(fx.home, stageItem).status, repairsOf(fx.home, stageItem).length], ['verifying', 0], "the stage's work is not sent back: its current candidate is candidate 1, whose checks have no result");

    await runEnded(fx, p.id, fix.id, 1);
    assert.deepEqual(told(launchesOf(fx, fix.id)[1]), expected(fx.home, ids, { acc: failed }), "the fix's repair run is told of its named check's failure");
  });

  test('(b) a failure recorded before the item reached verifying sends it back once it is there', async (t) => {
    const { fx, p, item, reg, ids } = await builtStage(t);
    // The harness's transition route (SEAM.md §15) parks the item in awaiting_decision; its continuation is verifying.
    const away = await fx.engine.post(`/v1/harness/work/${item}/transition`, { to: 'awaiting_decision' });
    assert.equal(away.status, 200, `the fixture is live: the item leaves verifying (body: ${away.text})`);
    const failed = await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-b: failed while the item was elsewhere\n' });
    assert.deepEqual([itemRow(fx.home, item).status, itemRow(fx.home, item).repair_attempts], ['awaiting_decision', 0], 'not verifying: nothing is sent back yet');

    const back = await fx.engine.post(`/v1/harness/work/${item}/transition`, { to: 'verifying' });
    assert.equal(back.status, 200, `the item returns to its continuation (body: ${back.text})`);
    await tick(fx.engine, p.id, { rounds: 1 });
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.repair_attempts, repairsOf(fx.home, item).length], [1, 1], 'by the next tick at the latest, the failure recorded earlier sends it back once (D3 §2.10: reconciled durable state, not the result\'s arrival)');
    await runEnded(fx, p.id, item, 1);
    assert.deepEqual(told(launchesOf(fx, item)[1]), expected(fx.home, ids, { acc: failed }), "and the repair run is told of it");
  });

  test('(c) an earlier registration failing after a newer one passed sends nothing back', async (t) => {
    const { fx, p, item, candidate, reg } = await builtStage(t);
    const { acc: older } = await operatorRequest(fx.engine, p.id, candidate.id, ['acc']);
    const { acc: newer } = await operatorRequest(fx.engine, p.id, candidate.id, ['acc']);
    await recordExit(fx.engine, newer, 0);
    await recordExit(fx.engine, older, 1, { output: 'an older registration failing late\n' });
    await recordExit(fx.engine, reg.acc.id, 1, { output: 'the oldest, failing last\n' });
    await tick(fx.engine, p.id);
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['verifying', 0, 0], 'only the latest registration counts: its pass stands, and nothing is sent back');
  });

  test("(d) several required checks of one build failing spend one repair, and the repair run is told of each", async (t) => {
    const { fx, p, item, reg, ids } = await builtStage(t);
    const smoke = await recordExit(fx.engine, reg.smoke.id, 1, { output: 'M234-d: smoke failed\n' });
    const acc = await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-d: acceptance failed\n' });
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.repair_attempts, repairsOf(fx.home, item).length], [1, 1], 'two failed checks of one candidate: one repair');
    await runEnded(fx, p.id, item, 1);
    assert.deepEqual(told(launchesOf(fx, item)[1]), expected(fx.home, ids, { acc, smoke }), "the repair run's context names both failed checks' outputs (every failed repair check at the candidate when it is dispatched)");
  });

  test('(e) repeated ticks, a restart, and a later failure of the same candidate take no second repair', async (t) => {
    const { fx, p, item, candidate } = await builtStage(t);
    await pauseProject(fx.engine, p.id);
    const reg = registrationsBy(fx.home, candidate.id);
    await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-e\n' });
    const first = itemRow(fx.home, item);
    assert.deepEqual([first.status, first.repair_attempts], ['eligible', 1], 'the fixture is live: the repair is taken in the recording transition, the project paused');
    await tick(fx.engine, p.id);
    await tick(fx.engine, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id);
    const { acc: again } = await operatorRequest(fx.engine, p.id, candidate.id, ['acc']);
    await recordExit(fx.engine, again, 1, { output: 'M234-e: the same candidate fails again\n' });
    await tick(fx.engine, p.id);
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.repair_attempts, repairsOf(fx.home, item).length], [1, 1], 'one repair for the item, candidate and generation, however many ticks, restarts and failures');
    assert.deepEqual(row.check_repair?.candidate, first.check_repair?.candidate, 'check_repair still names the candidate it was taken for');

    await resumeProject(fx.engine, p.id);
    await runEnded(fx, p.id, item, 1);
    await tick(fx.engine, p.id);
    assert.equal(runsOf(fx.home, item).length, 2, 'one repair run, and no other');
  });

  test("(f) skipped, missing, stale, and a superseded candidate's failure consume no repair", async (t) => {
    const fx = await scriptedEngine(t, { config: { check_infra_retries_max: 0 } });
    const ctx = await nominated(fx);
    const project = ctx.project.id;
    const item = ctx.items[0];
    const c1 = ctx.candidate;
    // Declared after the nomination, so nothing registers them (SEAM.md §189).
    const k = (await installChecks(fx.engine, project, [check('sk', { requirements: ['R1'] }), check('ms', { kind: 'smoke' }), check('st', { kind: 'smoke' }), check('sp', { kind: 'smoke' })])).id;
    assert.equal(itemRow(fx.home, item).status, 'verifying', 'the fixture is live: the stage work is verifying on candidate 1');

    await postResult(fx.engine, project, { candidate: c1.id, check: k.sk, exit_status: null, execution_established: false });
    const { ms } = await operatorRequest(fx.engine, project, c1.id, ['ms']);
    await drive(fx.engine, ms, ['materializing', 'interrupted']);
    await postResult(fx.engine, project, { candidate: c1.id, check: k.st, exit_status: 1, source_revision: ctx.project.base });
    const states = (await stageGate(fx, ctx)).check_states;
    assert.deepEqual([states[k.sk], states[k.ms], states[k.st]], ['skipped', 'missing', 'stale'], 'the fixture is live: skipped, missing (interrupted, no row) and stale');
    await tick(fx.engine, project);
    assert.deepEqual([itemRow(fx.home, item).status, itemRow(fx.home, item).repair_attempts, repairsOf(fx.home, item).length], ['verifying', 0, 0], 'none of them is the Builder\'s doing: no repair');

    const c2 = await successor(fx, ctx);
    assert.equal(candidateRow(fx.home, c1.id).superseded_by, c2.id, 'the fixture is live: candidate 1 is superseded');
    await postResult(fx.engine, project, { candidate: c1.id, check: k.sp, exit_status: 1 });
    await tick(fx.engine, project);
    assert.deepEqual([itemRow(fx.home, item).repair_attempts, repairsOf(fx.home, item).length], [0, 0], "a superseded candidate's failure triggers nothing (D3 §2.5)");
  });

  test('(g) the repair limit parks the item with a blocker naming the failed check', async (t) => {
    const { fx, p, item, reg, ids } = await builtStage(t);
    await changePolicy(fx.engine, p.id, { repair_attempts_max: 0 });
    await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-g\n' });
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['parked', 0, 0], 'at repair_attempts_max the item is parked instead of sent back');
    assert.equal(stepsOf(fx.home, item, 'verifying', 'parked').length, 1, 'verifying → parked');
    assert.equal(row.blocker?.reason, 'repair_attempts_max', 'the blocker names the limit');
    assert.ok((row.blocker?.checks ?? []).includes(ids.acc), `the blocker names the failed check (SEAM.md §229) (blocker ${JSON.stringify(row.blocker)})`);
    await openDecision(fx, p.id, 'blocker', item);
    await tick(fx.engine, p.id);
    assert.equal(runsOf(fx.home, item).length, 1, 'and no run is dispatched for it');
  });

  test('(g) the same failure on an unchanged tree counts toward no_progress_max, which parks the item with a blocker naming the check', async (t) => {
    // The repair run writes the bytes the candidate already has and asks for the nomination: the next candidate's tree is the same.
    const { fx, p, item, candidate: c1, reg, ids } = await builtStage(t, { second: roleThat([permittedEdit()], { nominate: true }) });
    await changePolicy(fx.engine, p.id, { no_progress_max: 1 });
    await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-g: the same failure\n' });
    assert.equal(itemRow(fx.home, item).repair_attempts, 1, 'the fixture is live: the first failure is repaired');
    await runEnded(fx, p.id, item, 1);
    const c2 = (await waitForCandidates(fx, p.id, 2))[1];
    assert.equal(treeOf(p.repo.path, c2.revision), treeOf(p.repo.path, c1.revision), "the fixture is live: the repair's candidate has the same tree");
    const reg2 = await tickUntil(fx.engine, p.id, () => registrationsBy(fx.home, c2.id).acc, { max: 6, what: "candidate 2's acc registration" });
    await recordExit(fx.engine, reg2.id, 1, { output: 'M234-g: the same failure\n' });
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['parked', 1, 1], 'the same failure on the same tree: no second repair, parked');
    assert.equal(row.blocker?.reason, 'no_progress_max', 'the blocker names no_progress_max');
    assert.ok((row.blocker?.checks ?? []).includes(ids.acc), `the blocker names the failed check (blocker ${JSON.stringify(row.blocker)})`);
  });

  test("(h) a conflict finding in the Builder's run wins over the repair: the item takes D3 §5 X2's route, and no repair is taken", async (t) => {
    const objection = { check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message: 'M234-h: the acceptance check contradicts the interface the stage names' };
    const { fx, p, item, reg } = await builtStage(t, { first: roleThat([permittedEdit()], { nominate: true, objections: [objection] }) });
    await recordExit(fx.engine, reg.acc.id, 1, { output: 'M234-h\n' });
    await tick(fx.engine, p.id);
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['awaiting_decision', 0, 0], 'the conflict route instead of a repair');
    await x2Blocker(fx, p.id, item);
    await tick(fx.engine, p.id);
    assert.equal(runsOf(fx.home, item).length, 1, 'no second Builder run');
  });
});

