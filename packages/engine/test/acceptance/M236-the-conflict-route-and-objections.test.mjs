// M236, the conflict route and objections (M3 slice 21; kernel lane). M3
// plan §3.7 M236; D3 §5 X2, §2.10 (its last sentence), A.3 (`objections`);
// E89 item 2; Astra's T14; D3-X02; SEAM.md §§228, 232.
//
// A Builder objects to a check through its result's `objections`
// (`{check, criterion?, category, message}`), and a Verifier reports a
// finding of category `requirement_conflict` or `contract_conflict`. A
// valid conflict about a work item stops its automatic repair: when the
// objected check fails at the item's current candidate, the item goes to
// `awaiting_decision` with a `blocker` whose options are `correct_check`,
// `change_spec`, `retry` and `cancel`, and each does what it says. No answer
// changes a check state; the objected check stays in force; nothing a
// Builder sends edits the spec. An objection naming an unknown, a
// foreign-project or an unrelated check or criterion is invalid: no finding,
// no blocker, no spec change. A replayed objection is deduplicated.
//
// Kernel lane: checks discovered, registered at nomination and moved
// through the scripted check boundary (SEAM.md §190). Every role without a
// script of its own completes and changes nothing, so the Verifier's run a
// `correct_check` answer dispatches ends by itself.
//
// S3 (the driver's ruling under D3 §5 X2, 2026-10-08; SEAM.md §235): a
// `correct_check` answer holds the item while the check_correction work it
// registered is not ended and its proposal is neither applied nor rejected;
// an unrelated protected application does not release it; when the
// correction ends with no new version, the X2 blocker is raised again.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { acceptedRun, capturedProposal, humanApplies, stageGate } from './harness/gates.mjs';
import { addItem, permittedEdit, roleThat } from './harness/gitruns.mjs';
import { pauseProject, runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { defPath, definitionText } from './harness/checks/fixtures.mjs';
import { operatorRequest, recordExit } from './harness/checks/selection.mjs';
import {
  ACC_SMOKE,
  buildAndNominate,
  checkIds,
  def,
  findingsBy,
  itemRow,
  ofKind,
  openBlockers,
  repairProject,
  repairsOf,
  requirementsOf,
  workFor,
  x2Blocker,
  x2Blockers,
} from './harness/checks/repair.mjs';

const objection = (message, extra = {}) => ({ check: 'acc', criterion: 'R1.1', category: 'contract_conflict', message, ...extra });

// The effective version's checks: {key: {id, required}}.
const versionChecks = (home, project) =>
  Object.fromEntries(
    withStore(home, (db) =>
      db
        .prepare(
          `SELECT c."key", c."id", c."required" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version"
           WHERE v."project" = ? AND v."authorized" = 1 AND v."effective_from" IS NOT NULL AND v."superseded_by" IS NULL`,
        )
        .all(project)
        .map((r) => [r.key, { id: r.id, required: r.required }]),
    ),
  );

// A T1 project (acc covering R1.1, smoke); its stage's Builder reports
// `objections` with the build and asks for the nomination; the objected
// check then fails on the candidate. Returns the item at its X2 blocker.
async function objected(t, { objections = [objection('M236: the acceptance check contradicts the interface')] } = {}) {
  const fx = await scriptedEngine(t);
  fx.scripted.defaultScript(script.complete());
  const p = await repairProject(fx);
  const b = await buildAndNominate(fx, p, { scripts: [roleThat([permittedEdit()], { nominate: true, objections })] });
  const spec = requirementsOf(fx.home, p.id);
  const recorded = findingsBy(fx.home, p.id, (f) => f.source_run === b.run.id);
  await recordExit(fx.engine, b.reg.acc.id, 1, { output: 'M236: the objected check failed\n' });
  const blocker = await x2Blocker(fx, p.id, b.item);
  return { fx, p, ...b, spec, recorded, blocker, ctx: { project: p, stage: p.stages[0].id, candidate: b.candidate }, ids: checkIds(fx.home, p.id) };
}

// What no answer may change: the check's state, the check in force, the spec.
async function assertNothingRelaxed(o, what) {
  const { fx, p, ctx, ids, spec } = o;
  const evaluation = await stageGate(fx, ctx);
  assert.equal(evaluation.check_states[ids.acc], 'failed', `${what}: the objected check's state is unchanged (failed)`);
  assert.deepEqual(versionChecks(fx.home, p.id).acc, { id: ids.acc, required: 1 }, `${what}: the objected check stays in force, required, at the same version`);
  assert.deepEqual(requirementsOf(fx.home, p.id), spec, `${what}: the spec is unchanged`);
}

describe('M236 the conflict route and objections', () => {
  test("(a) a Builder's objection is recorded as a conflict finding of its run, and when the objected check fails, repair stops and D3 §5 X2's blocker is raised", async (t) => {
    const o = await objected(t);
    const { fx, p, item, run } = o;
    assert.equal(o.recorded.length, 1, 'one finding records the objection');
    const [f] = o.recorded;
    assert.deepEqual([f.category, f.check, f.criterion, f.source_run], ['contract_conflict', 'acc', 'R1.1', run.id], "it has the objection's category, check and criterion, and names the Builder's run");
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['awaiting_decision', 0, 0], 'no repair: the item awaits the decision');
    await tick(fx.engine, p.id);
    assert.equal(runsOf(fx.home, item).length, 1, 'no Builder run is dispatched');
    await assertNothingRelaxed(o, 'raised');
  });

  test('(a) retry: the person sees no conflict, and the item takes its one repair', async (t) => {
    const o = await objected(t);
    await consume(o.fx, o.p.id, o.blocker, 'retry');
    const row = await tickUntil(o.fx.engine, o.p.id, () => (itemRow(o.fx.home, o.item).repair_attempts === 1 ? itemRow(o.fx.home, o.item) : undefined), { max: 2, what: 'the repair' });
    assert.equal(repairsOf(o.fx.home, o.item).length, 1, 'one verifying → eligible step');
    assert.notEqual(row.status, 'awaiting_decision');
    await assertNothingRelaxed(o, 'retry');
  });

  test('(a) cancel: the item is cancelled, and nothing is repaired', async (t) => {
    const o = await objected(t);
    await consume(o.fx, o.p.id, o.blocker, 'cancel');
    await tick(o.fx.engine, o.p.id);
    const row = itemRow(o.fx.home, o.item);
    assert.deepEqual([row.status, row.repair_attempts, runsOf(o.fx.home, o.item).length], ['cancelled', 0, 1], 'cancelled, with no repair and no run');
    await assertNothingRelaxed(o, 'cancel');
  });

  test('(a) correct_check: check_correction work for the Verifier, triggered by the objection, and no repair', async (t) => {
    const o = await objected(t);
    const [f] = o.recorded;
    await consume(o.fx, o.p.id, o.blocker, 'correct_check');
    const routed = workFor(o.fx.home, o.p.id, 'check_correction', f.id);
    assert.equal(routed.length, 1, 'one check_correction item, triggered by the finding');
    assert.equal(routed[0].trigger_id, f.id);
    await tick(o.fx.engine, o.p.id);
    const row = itemRow(o.fx.home, o.item);
    assert.deepEqual([row.repair_attempts, runsOf(o.fx.home, o.item).length], [0, 1], 'the Builder is not sent back');
    await assertNothingRelaxed(o, 'correct_check');
  });

  test("(a) correct_check (S3, the driver's ruling): the correction cancelled with no new version, the X2 blocker is raised again with its four options", async (t) => {
    const o = await objected(t);
    const { fx, p, item } = o;
    const [f] = o.recorded;
    await consume(fx, p.id, o.blocker, 'correct_check');
    const [correction] = workFor(fx.home, p.id, 'check_correction', f.id);
    assert.ok(correction, 'the fixture is live: correct_check registered check_correction work');
    // No tick has run since the answer, so the correction has no run; the harness route (SEAM.md §15) cancels it.
    assert.equal(runsOf(fx.home, correction.id).length, 0, 'the fixture is live: the correction has not run');
    const cancelled = await fx.engine.post(`/v1/harness/work/${correction.id}/transition`, { to: 'cancelled' });
    assert.equal(cancelled.status, 200, `the correction is cancelled (body: ${cancelled.text})`);
    await tick(fx.engine, p.id);
    const again = await x2Blocker(fx, p.id, item);
    assert.notEqual(again.id, o.blocker.id, 'a new X2 blocker about the item, offering correct_check, change_spec, retry and cancel again');
    const row = itemRow(fx.home, item);
    assert.deepEqual([row.status, row.repair_attempts, repairsOf(fx.home, item).length], ['awaiting_decision', 0, 0], 'the correction ended with no new version: the item awaits the person again, with no repair');
    await assertNothingRelaxed(o, 'the correction cancelled');
  });

  test("(a) correct_check (S3, the driver's ruling): an unrelated protected application while the correction is open releases nothing: the objected check failing again at the new version takes no repair and raises no blocker", async (t) => {
    const o = await objected(t);
    const { fx, p, item } = o;
    const [f] = o.recorded;
    // An unrelated protected change, captured before the answer and applied while the correction is open: a new smoke check.
    const unrelated = await capturedProposal(fx, p, { changeKind: null, steps: [step.write(defPath('extra'), definitionText('extra', def('smoke')))] });
    // Paused, so no run is dispatched and the correction stays open. A pause holds no reconciliation back: a repair is
    // taken in the transaction that records the failure (M234 (e)).
    await pauseProject(fx.engine, p.id);
    await consume(fx, p.id, o.blocker, 'correct_check');
    const [correction] = workFor(fx.home, p.id, 'check_correction', f.id);
    assert.ok(correction, 'the fixture is live: correct_check registered check_correction work');
    const before = versionChecks(fx.home, p.id).acc.id;
    await humanApplies(fx, p, unrelated, 'tightening');
    assert.notEqual(versionChecks(fx.home, p.id).acc.id, before, 'the fixture is live: a new version is effective');
    assert.deepEqual([itemRow(fx.home, correction.id).status, runsOf(fx.home, correction.id).length], ['eligible', 0], 'the fixture is live: the correction is still open');

    const { acc } = await operatorRequest(fx.engine, p.id, o.candidate.id, ['acc']);
    await recordExit(fx.engine, acc, 1, { output: 'M236-S3: the objected check fails again at the new version\n' });
    await tick(fx.engine, p.id);
    const held = itemRow(fx.home, item);
    assert.deepEqual([held.status, held.repair_attempts, repairsOf(fx.home, item).length], ['verifying', 0, 0], 'the hold stands: no repair');
    assert.deepEqual(openBlockers(fx.home, item), [], 'and no blocker');
  });

  test('(a) change_spec: spec_change work is raised and the spec is not edited', async (t) => {
    const o = await objected(t);
    const [f] = o.recorded;
    await consume(o.fx, o.p.id, o.blocker, 'change_spec');
    assert.equal(workFor(o.fx.home, o.p.id, 'spec_change', f.id).length, 1, 'one spec_change item, triggered by the finding (F §3.8)');
    await tick(o.fx.engine, o.p.id);
    assert.deepEqual([itemRow(o.fx.home, o.item).repair_attempts, runsOf(o.fx.home, o.item).length], [0, 1], 'the Builder is not sent back');
    await assertNothingRelaxed(o, 'change_spec');
  });

  test("(a) a Verifier's conflict finding about the candidate stops the stage's repair and raises the same blocker", async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    const p = await repairProject(fx);
    const b = await buildAndNominate(fx, p);
    await acceptedRun(fx, p.id, 'verification', {
      subject: { candidate: b.candidate.id },
      result: { findings: [{ category: 'requirement_conflict', severity: 'medium', message: 'M236: R1.1 contradicts the stage goal', check: 'acc', criterion: 'R1.1' }] },
    });
    await recordExit(fx.engine, b.reg.acc.id, 1, { output: 'M236: failed\n' });
    const blocker = await x2Blocker(fx, p.id, b.item);
    assert.deepEqual([itemRow(fx.home, b.item).status, itemRow(fx.home, b.item).repair_attempts], ['awaiting_decision', 0], 'no repair');
    const [f] = findingsBy(fx.home, p.id, (row) => row.category === 'requirement_conflict');
    await consume(fx, p.id, blocker, 'change_spec');
    assert.equal(workFor(fx.home, p.id, 'spec_change', f.id).length, 1, "the Verifier's route to a spec change (D3 §2.11)");
  });

  test('(b) an objection naming an unknown, a foreign-project or an unrelated check or criterion: no finding, no blocker, no spec change', async (t) => {
    const fx = await scriptedEngine(t);
    fx.scripted.defaultScript(script.complete());
    // A second project, whose own check `qonly` the first does not have.
    await repairProject(fx, { defs: { ...ACC_SMOKE, qonly: def('smoke') } });
    const p = await repairProject(fx, {
      defs: { acc: def('acceptance', { criteria: ['R1.1'] }), acc2: def('acceptance', { criteria: ['R2.1'] }), smoke: def('smoke') },
      index: [
        { key: 'R1', criteria: ['R1.1'] },
        { key: 'R2', criteria: ['R2.1'] },
      ],
      stages: [
        { number: 1, goal: 'stage one', implements: ['R1'] },
        { number: 2, goal: 'stage two', implements: ['R2'] },
      ],
    });
    const spec = requirementsOf(fx.home, p.id);
    // One run per entry, each on a work item of its own: three fixture fixes, and each stage's Builder for the unrelated references.
    const fixes = [await addItem(fx, p.id, 'fix'), await addItem(fx, p.id, 'fix'), await addItem(fx, p.id, 'fix')];
    const cases = [
      ['an unknown check', fixes[0], objection('M236-b unknown', { check: 'nosuch' })],
      ['a foreign-project check', fixes[1], { check: 'qonly', category: 'contract_conflict', message: 'M236-b foreign' }],
      ['an unknown criterion', fixes[2], objection('M236-b unknown criterion', { criterion: 'R9.9' })],
      ["an unrelated check (stage two's, objected by stage one's Builder)", p.stages[0].work_item, objection('M236-b unrelated check', { check: 'acc2', criterion: 'R2.1' })],
      ["an unrelated criterion (stage one's, objected by stage two's Builder)", p.stages[1].work_item, objection('M236-b unrelated criterion', { check: 'acc2', criterion: 'R1.1' })],
    ];
    for (const [, item, o] of cases) fx.scripted.script(item, [roleThat([step.write(`src/${o.message.replace(/\W+/g, '-')}.js`, 'export const x = 1;\n')], { objections: [o] })]);
    for (const [what, item, o] of cases) {
      const run = await tickUntil(fx.engine, p.id, () => (runsOf(fx.home, item)[0]?.state === 'ended' ? runsOf(fx.home, item)[0] : undefined), { what: `the run carrying ${what}` });
      assert.deepEqual(findingsBy(fx.home, p.id, (f) => f.message === o.message || f.source_run === run.id), [], `${what}: no finding is recorded for the entry`);
    }
    await tick(fx.engine, p.id);
    assert.deepEqual(x2Blockers(fx.home, p.id), [], 'no blocker of D3 §5 X2 is raised');
    assert.deepEqual([ofKind(fx.home, p.id, 'spec_change'), ofKind(fx.home, p.id, 'check_correction')], [[], []], 'no spec_change and no check_correction work');
    assert.deepEqual(requirementsOf(fx.home, p.id), spec, 'the spec is unchanged');
  });

  test('(c) a replayed objection is deduplicated: one finding, one blocker', async (t) => {
    const o = objection('M236-c: replayed');
    const r = await objected(t, { objections: [o, { ...o }] });
    assert.equal(r.recorded.length, 1, 'one finding for the objection sent twice');
    assert.equal(x2Blockers(r.fx.home, r.p.id).length, 1, 'one blocker');
  });
});
