// M435, the authoring proposal's class and the actual protected coverage
// (slice 37; kernel lane). M5 plan §3.7 M435 (c), (e); D6-W04; D6 §6.2; D3
// §3.1; Q9; B07, N04; carried item (v) (slice 35's ruling 9:
// `AUTHORING_INCOMPLETE` on `alpha_authorize`); SEAM.md §§216, 351, 439
//
//   (c) the proposal's class as the classifier computes it, never assumed:
//       phase 1's, which writes `check_commands`, `unclassifiable` and routed
//       to the human although the classifier is `authoritative`; phase 2's,
//       adding only checks under new declared inputs, a `tightening` applied
//       by the Reviewer, with `protected_proposals.fingerprint_changes` †
//       `[]` on both (no existing check's input fingerprint moved); a later
//       addition beside an existing check with default inputs (`tree-lint`,
//       no `inputs`, so the whole protected tree): not `tightening` although
//       the Verifier asked for one, `tree-lint` affected `input_changed`, and
//       its fingerprint change recorded on the proposal
//       (`fingerprint_changes` [{check: "tree-lint", from, to}], from ≠ to);
//   (e) the actual protected coverage against the planned obligations: phase
//       1 authored without `integration` and with `accept-r2` covering R2.1
//       alone (T1, so the phase nominates at the completion of building):
//       `AUTHORING_INCOMPLETE` naming R2.2 on the `phase` gate and on
//       `alpha_authorize` (the owner's deploy request refused
//       `authorization_not_issued` with it among its reasons); a correction
//       that restores the coverage, applied: neither gate carries it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { definitionText } from './harness/checks/fixtures.mjs';
import { requestDeployment } from './harness/deploy/kernel.mjs';
import { ROUTED_KINDS, alphaReady, candidatesOfProject, nextPhasePublished, phaseCompleted, planOfPhase, pump, protectedVersionsOf } from './harness/journey/drive.mjs';
import { CHECK_PROGRAMS, authoringFiles } from './harness/journey/reference.mjs';
import { addWork } from './harness/runs.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { authoringWith, go, openOf, pausedDeveloping, proposalRows, until } from './harness/exec37/authoring.mjs';

const json = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

// The proposal a `check_authoring` run of `plan` captured (its work's subject names the plan).
function authoringProposal(home, project, planId) {
  const ids = withStore(home, (db) =>
    db
      .prepare(`SELECT p."id" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" JOIN "work_items" w ON w."id" = r."work_item" WHERE p."project" = ? AND w."kind" = 'check_authoring' AND json_extract(w."subject", '$.phase_plan') = ? ORDER BY p."seq"`)
      .all(project, planId)
      .map((r) => r.id),
  );
  return proposalRows(home, project).filter((r) => ids.includes(r.id));
}

// A check with default inputs (no `inputs` member: the whole protected tree, D3 §3.1).
const TREE_LINT = Object.freeze({ '.surety/checks/defs/tree-lint.json': definitionText('tree-lint', { kind: 'security_lint', command: ['node', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: ['stage', 'alpha_authorize'] }) });

describe('M435 the proposal\'s class and the coverage', () => {
  test('(c) phase 1 unclassifiable to the human under authoritative; phase 2 a tightening the Reviewer applies; fingerprint_changes [] on both', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t);
    await go(fx, p);
    const done1 = await phaseCompleted(fx, ctx, 1);
    const [first] = authoringProposal(fx.home, p.id, plan.id);
    assert.ok(first, 'phase 1\'s authoring proposal');
    assert.equal(first.classified_change_kind, 'unclassifiable', 'phase 1\'s proposal writes check_commands: unclassifiable');
    assert.ok(ctx.humanActs.some((a) => a.kind === 'check_correction_unclassifiable'), `routed to the human under authoritative (Q9) (${JSON.stringify(ctx.humanActs)})`);
    assert.equal(first.approver_authority, 'human', 'applied on the human\'s answer');
    assert.ok(done1, 'phase 1 completes');
    const plan2 = await nextPhasePublished(fx, ctx, 2);
    const second = await pump(fx, ctx, () => authoringProposal(fx.home, p.id, plan2.id).find((x) => x.status === 'applied'), { what: 'phase 2\'s authoring applied', max: 40 });
    assert.equal(second.classified_change_kind, 'tightening', 'phase 2 adds checks under new declared inputs only: a tightening');
    assert.equal(second.approver_authority, 'reviewer', 'applied by the Reviewer under authoritative');
    for (const [label, row] of [['phase 1', first], ['phase 2', second]]) {
      const fresh = proposalRows(fx.home, p.id).find((x) => x.id === row.id);
      assert.deepEqual(fresh.fingerprint_changes, [], `${label}: protected_proposals.fingerprint_changes † is [] (no existing check's input fingerprint moved) (${JSON.stringify(fresh.fingerprint_changes)})`);
    }
  });

  test('(c) a later addition beside a default-inputs check: the classifier\'s class, not the requested tightening; the fingerprint change of tree-lint recorded on the proposal', async (t) => {
    const { fx, p, ctx } = await pausedDeveloping(t);
    fx.scripted.kindScript('check_authoring', [authoringWith(1, { add: TREE_LINT }), authoringWith(2, { changeKind: 'tightening' })]);
    await go(fx, p);
    await phaseCompleted(fx, ctx, 1);
    const plan2 = await nextPhasePublished(fx, ctx, 2);
    const second = await pump(fx, ctx, () => authoringProposal(fx.home, p.id, plan2.id).find((x) => x.classified_change_kind), { what: 'phase 2\'s authoring classified', max: 40 });
    assert.equal(second.requested_change_kind, 'tightening', 'the Verifier asked for a tightening');
    assert.notEqual(second.classified_change_kind, 'tightening', `never an assumed tightening: tree-lint's default inputs cover the tree the proposal adds to (classified ${second.classified_change_kind})`);
    const classification = json(second.classification);
    const affected = (classification?.affected_checks ?? []).find((a) => a.check === 'tree-lint');
    assert.ok(affected?.reasons?.includes('input_changed'), `tree-lint affected input_changed (${JSON.stringify(classification?.affected_checks)})`);
    const changes = proposalRows(fx.home, p.id).find((x) => x.id === second.id).fingerprint_changes;
    const entry = (changes ?? []).find((c) => c.check === 'tree-lint');
    assert.ok(entry, `fingerprint_changes † names tree-lint (${JSON.stringify(changes)})`);
    assert.ok(typeof entry.from === 'string' && typeof entry.to === 'string' && entry.from !== entry.to, `with its fingerprint before and after, differing (${JSON.stringify(entry)})`);
    assert.ok(!(changes ?? []).some((c) => ['accept-r1', 'accept-r2', 'integration', 'integration-lib', 'lint', 'smoke', 'operation'].includes(c.check)), `no check with declared inputs outside the change is listed (${JSON.stringify(changes)})`);
  });

  test('(e) a planned criterion no protected check covers: AUTHORING_INCOMPLETE naming R2.2 on phase and on alpha_authorize; the coverage restored: neither carries it', async (t) => {
    const { fx, p, ctx, plan } = await pausedDeveloping(t, { tier: 'T1' });
    const files = { ...authoringFiles(1) };
    delete files['.surety/checks/defs/integration.json'];
    delete files['.surety/checks/tests/integration.test.mjs'];
    const r2 = JSON.parse(files['.surety/checks/defs/accept-r2.json']);
    files['.surety/checks/defs/accept-r2.json'] = `${JSON.stringify({ ...r2, covers: { criteria: ['R2.1'] } }, null, 2)}\n`;
    fx.scripted.kindScript('check_authoring', [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)), { proposal: { rationale: 'Phase 1\'s checks, R2.2 left uncovered.', requested_change_kind: 'unclassifiable' } })]);
    await go(fx, p);
    const c = await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { what: 'the T1 nomination at the completion of building', max: 120 });
    const phaseRes = await fx.engine.post(`/v1/projects/${p.id}/candidates/${c.id}/gates/phase`, { phase_plan: plan.id });
    assert.equal(phaseRes.status, 200, `POST …/gates/phase (→ ${phaseRes.status} ${phaseRes.text})`);
    const phaseNames = (phaseRes.body?.evaluation?.reasons ?? []).filter((r) => r.code === 'AUTHORING_INCOMPLETE').flatMap((r) => r.subjects ?? []);
    // The exact subject (the slice-37 review; SEAM.md §449): the planned
    // obligation's shortfall, `stage 2:R2.2`; R2.2 was not deferred, so no
    // `deferred:` subject.
    assert.ok(phaseNames.includes('stage 2:R2.2'), `AUTHORING_INCOMPLETE naming stage 2:R2.2 on the phase gate (${JSON.stringify(phaseRes.body?.evaluation?.reasons)})`);
    assert.ok(!phaseNames.some((s) => String(s).startsWith('deferred:')), `and no deferred: subject (${JSON.stringify(phaseNames)})`);
    await alphaReady(fx, ctx);
    const refused = await requestDeployment(fx.engine, p.id, c.id, 'alpha');
    assertRefused(refused, 409, 'authorization_not_issued', 'the owner\'s deploy request with R2.2 unauthored');
    const deployNames = (refused.body?.subject?.reasons ?? []).filter((r) => r.code === 'AUTHORING_INCOMPLETE').flatMap((r) => r.subjects ?? []);
    assert.ok(deployNames.includes('stage 2:R2.2'), `AUTHORING_INCOMPLETE naming stage 2:R2.2 on alpha_authorize (B07; slice 35's ruling 9) (${JSON.stringify(refused.body?.subject?.reasons)})`);
    assert.ok(!deployNames.some((s) => String(s).startsWith('deferred:')), `and no deferred: subject (${JSON.stringify(deployNames)})`);
    // The coverage restored: a correction adding `integration` and accept-r2 covering R2.2 again.
    const before = protectedVersionsOf(fx.home, p.id).length;
    fx.scripted.kindScript('check_correction', roleThat([step.write('.surety/checks/defs/integration.json', authoringFiles(1)['.surety/checks/defs/integration.json']), step.write('.surety/checks/tests/integration.test.mjs', CHECK_PROGRAMS['.surety/checks/tests/integration.test.mjs']), step.write('.surety/checks/defs/accept-r2.json', authoringFiles(1)['.surety/checks/defs/accept-r2.json'])], { proposal: { rationale: 'R2.2 covered again.', requested_change_kind: 'tightening' } }));
    await addWork(fx.engine, p.id, 'check_correction');
    // Applied means effective: the version row is recorded unauthorized with
    // the application's journal intent and takes effect only when its
    // ref_update finalizes (SEAM.md §69; as M37 shows). A gate evaluated in
    // between reads the old version, GIT_JOURNAL_PENDING with it, so the
    // wait is for the new version authorized and effective.
    await until(fx, ctx, () => protectedVersionsOf(fx.home, p.id).slice(before).find((v) => v.authorized === 1 && v.effective_from !== null), { what: 'the correction applied and effective', max: 30, answerKinds: ROUTED_KINDS });
    const again = await fx.engine.post(`/v1/projects/${p.id}/candidates/${c.id}/gates/phase`, { phase_plan: plan.id });
    assert.equal(again.status, 200, again.text);
    assert.ok(!(again.body?.evaluation?.reasons ?? []).some((r) => r.code === 'AUTHORING_INCOMPLETE'), `the phase gate no longer carries AUTHORING_INCOMPLETE (${JSON.stringify(again.body?.evaluation?.reasons)})`);
    const deployAgain = await requestDeployment(fx.engine, p.id, c.id, 'alpha');
    assert.ok(!(deployAgain.body?.subject?.reasons ?? []).some((r) => r.code === 'AUTHORING_INCOMPLETE'), `alpha_authorize no longer carries AUTHORING_INCOMPLETE (→ ${deployAgain.status} ${deployAgain.text})`);
    assert.equal(openOf(fx.home, p.id, 'blocker').length, 0, 'no blocker raised on the way');
    assert.ok(planOfPhase(fx.home, p.id, 1).length >= 1);
  });
});
