// M106, the Reviewer's powers (M2 slice 10, kernel lane). M2 plan §3.1
// M106; D2 §5 C2, K7, K8 (D2-C02, D2-C03); E41, E44 item 2, E48 item 3,
// E56 item 3; F §6.3; SEAM.md §§69, 74, 76, 77, 121.
//
// Two restrictions on a Reviewer that will be a real agent (C2). Any
// lowering of a finding from Critical requires the human through
// `severity_lower`, the Reviewer proposing it, and the Reviewer cannot
// apply its own proposal by proposing it again (K7); High to Medium goes
// the way M51 pins. A tightening's classification is an effect
// precondition re-checked at application, and until D3's classifier is
// qualified a Reviewer's approval of a tightening is a recommendation: the
// proposal stays unapplied until the human's `check_correction_tightening`
// (K8), which changes the accepted M37 and M53 cases that had the Reviewer
// apply it (COVERAGE.md, "M2 slice 10": a K8 change, not a weakening). Each
// classifier dependency changed between the human's approval and the effect
// invalidates the intent with no git write, and no approval turns a
// non-passed check into a pass.
//
// The cases of (a), (b) and (d) are expected to fail on the engine these
// tests were written against; (c) fails at its classification step
// (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, answerAndHoldEffect, assertEffectInvalidated, consume, decision, decisionsOn, intentsOf, openDecision, untilKilled } from './harness/decisions.mjs';
import { CHECK_FILE, PROTECTED_FILES, assertApplied, assertNotApplied, capturedProposal, check, correction, effectiveVersion, finding, installChecks, installGatedPlan, nominated, passAll, passedInventory, postResult, proposalsOf, raiseFindings, reasonSubjects, review, reviewerApproves, stageGate, waitApplied } from './harness/gates.mjs';
import { armBarrier } from './harness/journal.mjs';
import { isoNow, newId } from './harness/ids.mjs';
import { commitOnRef, refOid, treeOf } from './harness/repos.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';

const KIND = 'check_correction_tightening';

// A T1 candidate with one check passed and one failed, and two findings a
// Verifier raised on it: one Critical, one High. The failure is recorded
// while the stage's work is verifying on the candidate, so under Q2 (D3
// §2.10; E90 item 2) it would send the stage back to its Builder; this row is
// not about that repair, so at repair_attempts_max 0 the work is parked
// instead (objection 030).
async function withFindings(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { files: PROTECTED_FILES, policy: { repair_attempts_max: 0 } });
  const project = ctx.project.id;
  const k = (await installChecks(fx.engine, project, [check('login', { requirements: ['R1'] }), check('import', { requirements: ['R1'] })])).id;
  await passAll(fx.engine, project, ctx.candidate.id, [k.login]);
  await postResult(fx.engine, project, { candidate: ctx.candidate.id, check: k.import, exit_status: 1 });
  const [critical, high] = await raiseFindings(fx, project, ctx.candidate.id, [
    { category: 'defect', severity: 'critical', message: 'imported rows overwrite existing ones' },
    { category: 'defect', severity: 'high', message: 'totals are wrong for refunded orders' },
  ], { kind: 'verification' });
  const lower = (id, to) => review(fx, project, ctx.candidate.id, { severity_changes: [{ finding: id, to }] });
  const checkStates = async () => (await stageGate(fx, ctx)).check_states;
  return { fx, ctx, project, k, critical, high, lower, checkStates };
}

const severity = (fx, id) => finding(fx.home, id).effective_severity;

// The human's approval of a tightening, consumed and killed at the intent
// (SEAM.md §76): the effect is pending when the engine stops. Returns once
// the engine has killed itself.
async function approvedAndKilled(ctx) {
  const { fx, project, decision: previewed } = ctx;
  await armBarrier(fx.engine, 'intent.recorded', 'kill');
  answer(fx.engine, project.id, previewed, 'approve').catch(() => null);
  await untilKilled(fx, project.id);
  assert.equal(decision(fx.home, previewed.id).status, 'consumed', 'the answer was consumed before the kill');
  assert.equal(intentsOf(fx.home, previewed.id)[0]?.status, 'pending', 'its effect is pending');
}

// After a restart, the pending effect is revalidated and invalidated with no git write.
async function assertInvalidatedOnRestart(ctx, what) {
  const { fx, project, decision: previewed } = ctx;
  await fx.start();
  const intent = await tickUntil(fx.engine, project.id, () => intentsOf(fx.home, previewed.id).find((row) => !['pending', 'executing'].includes(row.status)), { what: `the pending effect to be revalidated (${what})` });
  assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], `${what}: the effect is invalidated, not made`);
  assert.equal(intentsOf(fx.home, previewed.id).length, 1, `${what}: and no second intent was recorded`);
  assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'classified', `${what}: no git write; the proposal awaits an approval again`);
}

describe('M106 the Reviewer\'s powers', () => {
  test('(a) a Reviewer\'s lowering from Critical is a proposal for the human: the finding stays Critical and blocking, the Reviewer\'s later result changes nothing, and High to Medium goes the way M51 pins', async (t) => {
    const { fx, ctx, project, critical, high, lower } = await withFindings(t);
    await lower(critical.id, 'high');
    assert.equal(severity(fx, critical.id), 'critical', 'a Reviewer lowers nothing from Critical');
    const previewed = await openDecision(fx, project, 'severity_lower', critical.id);
    assert.deepEqual({ severity: previewed.manifest.effective_severity, to: previewed.manifest.to }, { severity: 'critical', to: 'high' }, 'the lowering is asked of the human');
    assert.ok(reasonSubjects(await stageGate(fx, ctx), 'FINDING_BLOCKING').includes(critical.id), 'the finding still blocks');

    // The Reviewer proposes the same lowering again: it cannot apply its own proposal.
    await lower(critical.id, 'high');
    assert.equal(severity(fx, critical.id), 'critical', 'the Reviewer\'s later result changes nothing');
    const open = decisionsOn(fx.home, 'severity_lower', critical.id).filter((row) => row.status === 'open');
    assert.deepEqual(open.map((row) => [row.id, row.preview_hash]), [[previewed.id, previewed.preview_hash]], 'the one open question is the one already asked');
    assert.ok(reasonSubjects(await stageGate(fx, ctx), 'FINDING_BLOCKING').includes(critical.id), 'and the finding still blocks');

    await lower(high.id, 'medium');
    assert.equal(severity(fx, high.id), 'high', 'High to Medium is out of the blocking range: for the human, as M51 pins');
    await openDecision(fx, project, 'severity_lower', high.id);
  });

  test('(b) a Reviewer-approved tightening is a recommendation: the proposal stays unapplied and the effective version unchanged until the human\'s check_correction_tightening, which applies it with the human as its approver', async (t) => {
    const ctx = await correction(t, 'tightening');
    const { fx, project, proposal, decision: previewed, previous } = ctx;
    await reviewerApproves(fx, project, proposal);
    for (let i = 0; i < 3; i++) await tick(fx.engine, project.id);
    assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'classified', 'the Reviewer\'s approval applied nothing: the proposal still awaits an approval');
    assert.equal(effectiveVersion(fx.home, project.id).id, previous.id, 'the effective version is unchanged');
    assert.deepEqual([decision(fx.home, previewed.id).status, decision(fx.home, previewed.id).preview_hash], ['open', previewed.preview_hash], 'the human\'s decision is still open, with the preview it had');

    await consume(fx, project.id, previewed, 'approve');
    await waitApplied(fx, project, proposal);
    assertApplied(fx, project, { proposal, previous, headBefore: ctx.headBefore, authority: 'human', changeKind: 'tightening' });
  });

  test('(c) each classifier dependency changed between the human\'s approval and the effect invalidates the intent with no git write: the proposal\'s tree, its base, the approved specification, its classification, the effective version', async (t) => {
    // 1. The proposal's tree, replaced in the store with the engine stopped at the intent.
    {
      const ctx = await correction(t, 'tightening');
      const replaced = treeOf(ctx.project.repo.path, commitOnRef(ctx.project.repo.path, null, { [CHECK_FILE]: '{"expect": 200, "body": "ok", "replaced": true}\n' }, { parent: ctx.proposal.base_revision, message: 'fixture: another tree' }));
      await approvedAndKilled(ctx);
      withStore(ctx.fx.home, (db) => db.prepare('UPDATE "protected_proposals" SET "tree_id" = ? WHERE "id" = ?').run(replaced, ctx.proposal.id), { readonly: false });
      await assertInvalidatedOnRestart(ctx, 'the tree');
    }
    // 2. The proposal's base, replaced with another commit of the repository.
    {
      const ctx = await correction(t, 'tightening');
      const another = commitOnRef(ctx.project.repo.path, null, { 'docs/note.md': 'another base\n' }, { parent: ctx.headBefore, message: 'fixture: another commit, on no ref' });
      await approvedAndKilled(ctx);
      withStore(ctx.fx.home, (db) => db.prepare('UPDATE "protected_proposals" SET "base_revision" = ? WHERE "id" = ?').run(another, ctx.proposal.id), { readonly: false });
      await assertInvalidatedOnRestart(ctx, 'the base');
    }
    // 3. The approved specification: the baseline gains a requirement while the effect is held.
    {
      const ctx = await correction(t, 'tightening');
      const { fx, project, decision: previewed } = ctx;
      const held = await answerAndHoldEffect(fx, project.id, previewed, 'approve');
      const plan = await installGatedPlan(fx.engine, project.id, { requirements: ['R1'], stages: [{ number: 1, goal: 'a stage of the changed specification', implements: ['R1'] }] });
      fx.scripted.script(plan.stages[0].work_item, [script.crash()]);
      await assertEffectInvalidated(fx, previewed, held);
      assert.equal(assertNotApplied(fx, ctx, ctx.headBefore).status, 'classified', 'the specification: no git write; the proposal awaits an approval again');
    }
    // 4. The classification, replaced in the store with the engine stopped at the intent.
    {
      const ctx = await correction(t, 'tightening');
      await approvedAndKilled(ctx);
      withStore(ctx.fx.home, (db) => db.prepare(`UPDATE "protected_proposals" SET "classified_change_kind" = 'loosening' WHERE "id" = ?`).run(ctx.proposal.id), { readonly: false });
      await ctx.fx.start();
      const intent = await tickUntil(ctx.fx.engine, ctx.project.id, () => intentsOf(ctx.fx.home, ctx.decision.id).find((row) => !['pending', 'executing'].includes(row.status)), { what: 'the pending effect to be revalidated (the classification)' });
      assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], 'the classification: the effect is invalidated, not made');
      const row = assertNotApplied(ctx.fx, ctx, ctx.headBefore);
      assert.notEqual(row.status, 'applied', 'no git write');
    }
    // 5. The effective version. No engine path can apply a second proposal
    // while the first's effect is paused (the effects step is the tick's, and
    // one tick runs at a time), so the version in force is changed in the
    // store with the engine stopped at the intent, as rows M45, M51 and M53
    // change a dependency no path changes while the question stands
    // (SEAM.md §65): the effective version is superseded by a copy of itself,
    // a version with the same set. The intent bound the old version's id.
    {
      const ctx = await correction(t, 'tightening');
      const { fx, project, decision: previewed, previous } = ctx;
      assert.equal(previewed.manifest.effective_protected_version, previous.id, 'the fixture is live: the preview bound the effective version');
      await approvedAndKilled(ctx);
      const successorId = newId('pv_');
      withStore(
        fx.home,
        (db) => {
          const row = db.prepare('SELECT * FROM "protected_versions" WHERE "id" = ?').get(previous.id);
          const columns = Object.keys(row);
          const copy = { ...row, id: successorId, created_at: isoNow(), seq: row.seq + 1, change_kind: 'tightening', proposal: null, approved_by: 'fixture: the same set, authorized again', approver_authority: 'human', approved_at: isoNow(), applied_by_operation: null, authorized: 1, effective_from: isoNow(), superseded_by: null };
          // One effective version at a time: the old one is superseded before the copy is in, with the reference deferred.
          db.exec('BEGIN');
          db.pragma('defer_foreign_keys = ON');
          db.prepare('UPDATE "protected_versions" SET "superseded_by" = ? WHERE "id" = ?').run(successorId, previous.id);
          db.prepare(`INSERT INTO "protected_versions" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(copy);
          db.exec('COMMIT');
        },
        { readonly: false },
      );
      await fx.start();
      assert.equal(effectiveVersion(fx.home, project.id).id, successorId, 'the fixture is live: another version is in force');
      const intent = await tickUntil(fx.engine, project.id, () => intentsOf(fx.home, previewed.id).find((row) => !['pending', 'executing'].includes(row.status)), { what: 'the pending effect to be revalidated (the effective version)' });
      assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], 'the effective version: the effect is invalidated, not made');
      const row = proposalsOf(fx.home, project.id).find((found) => found.id === ctx.proposal.id);
      assert.deepEqual([row.status, row.resulting_version, refOid(project.repo.path, project.repo.ref)], ['classified', null, ctx.headBefore], 'no git write; the proposal awaits an approval again');
      const next = await openDecision(fx, project.id, KIND, ctx.proposal.id);
      assert.equal(next.manifest.effective_protected_version, successorId, 'the next generation binds the version now in force');
    }
  });

  test('(d) neither the human\'s lowering approval nor the human\'s tightening approval turns a failed or a missing required check into a pass', async (t) => {
    const { fx, ctx, project, k, critical, high, lower, checkStates } = await withFindings(t);
    const more = await installChecks(fx.engine, project, [check('export', { requirements: ['R1'] })]);
    const before = await checkStates();
    assert.deepEqual(before, { ...passedInventory(k), [k.login]: 'passed', [k.import]: 'failed', [more.id.export]: 'missing' }, 'the fixture is live: one passed, one failed, one missing (beside the inventory of the tier, passed: M3 slice 20, SEAM.md §226)');

    await lower(critical.id, 'high');
    await consume(fx, project, await openDecision(fx, project, 'severity_lower', critical.id), 'approve');
    assert.equal(severity(fx, critical.id), 'high', 'the human lowered the finding');
    assert.deepEqual(await checkStates(), before, 'no check state changed with the lowering');
    assert.equal(severity(fx, high.id), 'high');

    const proposal = await capturedProposal(fx, ctx.project, { changeKind: 'tightening' });
    await consume(fx, project, await openDecision(fx, project, KIND, proposal.id), 'approve');
    await waitApplied(fx, ctx.project, proposal);
    const after = await checkStates();
    assert.deepEqual(Object.values(after).filter((state) => state === 'passed'), [], `no check is passed by the approval of a tightening (states: ${JSON.stringify(after)})`);
  });
});
