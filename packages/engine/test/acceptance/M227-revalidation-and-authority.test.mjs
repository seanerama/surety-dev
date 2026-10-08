// M227, revalidation and authority (M3 slice 19; kernel lane). M3 plan §3.5
// M227; D3-C07, D3-C08; T10; Q5; K8; D3 §3.3, A.3, A.7; D1 §10.5; SEAM.md
// §§76, 101, 104, 121, 215 to 220.
//
// A correction's whole binding is an effect precondition. (a), (b) Between
// the human's approval and its effect, each of the spec's criteria, the
// spec's areas, the validation-scope approval, the classifier version, the
// setting `classifier_authority` and the proposal's discovery is changed in
// turn, the class staying `unclassifiable` throughout: each time the intent
// is invalidated `EFFECT_PRECONDITION_CHANGED`, the approval withdrawn,
// nothing applied, and the next generation raised showing the change. The
// first two are changed while the effect is held; the other four while the
// engine is down, so the effect is a replay after a restart. (The effective
// version is M106 (c)'s case.) (a) A Reviewer's approval under
// `authoritative` is withdrawn the same way when the spec's criteria change
// before its application, the class staying `tightening`. (c) Under
// `recommend` a Reviewer's approval of a tightening is a recommendation and
// applies nothing; under `authoritative` naming another version it reads as
// `recommend`; naming the running version it applies, after revalidation,
// with the Reviewer as approver. (d) The setting changed while a Reviewer's
// application is pending stops it, and the proposal goes to the human; (b) a
// Reviewer's application replayed after a restart under another classifier
// version is refused.
//
// Expected to fail on `main`: no classifier runs. `GET /v1/engine` names no
// `classifier_version`; `main` also refuses the configuration key
// `classifier_authority` and the flag `--harness-classifier-version`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BEFORE_REVALIDATION,
  CLASSIFIER_FLAG,
  KERNEL_COMMANDS,
  RUN,
  approveAndKill,
  assertClassification,
  assertReplayRefused,
  assertWithdrawn,
  classifierProject,
  engineClassification,
  nextAfterWithdrawal,
  proposalRow,
  protectedFiles,
  removeScopeApprovals,
  reviewerApproval,
  reviseSpec,
  runningClassifier,
  setEngineConfig,
  stageSettled,
  verifierProposal,
  writeDef,
  writeGov,
} from './harness/checks/classifier.mjs';
import { answerAndHoldEffect, assertEffectInvalidated, consume, decisionsOn, nextGeneration, openDecision, reachBarrier, untilKilled } from './harness/decisions.mjs';
import { assertApplied, assertNotApplied, effectiveVersion, protectedVersions, reviewerApproves, scopeApproval, waitApplied } from './harness/gates.mjs';
import { armBarrier } from './harness/journal.mjs';
import { releaseBarrier } from './harness/engine.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const INDEX = [
  { key: 'R1', criteria: ['R1.1', 'R1.2'] },
  { key: 'R2', areas: ['authentication'], criteria: ['R2.1'] },
];
// Two spec revisions that leave every class as it was: a criterion added to
// R1, which no definition names; an area added to R2, which no check covers.
const MORE_CRITERIA = [{ ...INDEX[0], criteria: ['R1.1', 'R1.2', 'R1.3'] }, INDEX[1]];
const MORE_AREAS = [MORE_CRITERIA[0], { ...INDEX[1], areas: ['authentication', 'personal_data'] }];

const GOV = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS, result_collection: { output_max_bytes: 131072 }, required_checks: ['a', 's'] };
const acceptanceDef = (key) => ({ kind: 'acceptance', command: ['probe', key], timeout_s: 60, covers: { criteria: ['R1.1'] }, gate_kinds: ['stage'], inputs: [RUN(key)] });
const DEFS = { a: acceptanceDef('a'), s: { kind: 'smoke', command: ['probe', 's'], timeout_s: 60, gate_kinds: ['stage'], inputs: [RUN('s')] } };
const FILES = protectedFiles({ governed: GOV, defs: DEFS, files: { [RUN('a')]: 'the input of a\n', [RUN('s')]: 'the input of s\n' } });

const NEW_N = [writeDef('n', acceptanceDef('n')), step.write(RUN('n'), 'the input of n\n')];
// A tightening: a new check, outside every existing check's inputs, not required.
const TIGHTENING = NEW_N;
// An unclassifiable correction that changes the required set: the new check
// made required, and an existing check's input changed.
const UNCLASSIFIABLE = [...NEW_N, writeGov({ ...GOV, required_checks: ['a', 's', 'n'] }), step.write(RUN('a'), 'the input of a, corrected\n')];

const TIGHT = 'check_correction_tightening';
const UNCL = 'check_correction_unclassifiable';

// A project with the baseline, a correction captured on it and classified by
// the engine as `kind`. Returns the context assertNotApplied and the
// withdrawal helpers take.
const EXPECTED = {
  tightening: { kind: 'tightening', exact: ['check_added:n'] },
  unclassifiable: { kind: 'unclassifiable', contains: ['check_added:n', 'required_key_added_with_check:n', 'input_changed:a'] },
};

async function correctionOn(fx, steps, kind) {
  const project = await classifierProject(fx, { files: FILES, index: INDEX });
  const previous = effectiveVersion(fx.home, project.id);
  const proposal = await verifierProposal(fx, project, steps);
  const running = await runningClassifier(fx.engine);
  assertClassification(await engineClassification(fx, project.id, proposal), EXPECTED[kind], { label: `the ${kind} correction`, running });
  return { project, previous, proposal, headBefore: refOid(project.repo.path, project.repo.ref) };
}

const classOf = (fx, ctx) => proposalRow(fx.home, ctx.project.id, ctx.proposal.id).classification?.change_kind;
const approveOption = (row) => row.options.find((o) => o.key === 'approve');
const configured = async (fx) => (await fx.engine.engineInfo()).config?.classifier_authority?.value;

// The open decision of `kind` about the proposal whose manifest satisfies `ok`.
const openWhere = (fx, ctx, kind, ok, what) =>
  tickUntil(fx.engine, ctx.project.id, () => decisionsOn(fx.home, kind, ctx.proposal.id).find((row) => row.status === 'open' && ok(row)), { max: 6, what });

// The Reviewer's approval is withdrawn: the proposal is classified again with
// no approver, nothing is applied, and the human's question is open again.
async function reviewerWithdrawn(fx, ctx, what) {
  await tickUntil(fx.engine, ctx.project.id, () => proposalRow(fx.home, ctx.project.id, ctx.proposal.id).status === 'classified', { max: 6, what: `${what}: the Reviewer's approval to be withdrawn` });
  assertWithdrawn(fx, ctx, what);
  assert.equal(classOf(fx, ctx), 'tightening', `${what}: the class is unchanged`);
}

describe('M227 revalidation and authority', () => {
  test("(a), (b) each bound input changed between the human's approval and its effect, the class unchanged, invalidates the intent, withdraws the approval, applies nothing and raises the next generation; a replay after a restart is refused", async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await correctionOn(fx, UNCLASSIFIABLE, 'unclassifiable');
    const V = await runningClassifier(fx.engine);
    const pid = ctx.project.id;

    // The required set changes, so the validation-scope approval is needed first.
    let gen = await openDecision(fx, pid, UNCL, ctx.proposal.id);
    assert.ok(approveOption(gen).blockers.includes('APPROVAL_MISSING'), 'the fixture is live: approve waits for the validation-scope approval');
    await scopeApproval(fx.engine, pid, ctx.proposal.id);
    gen = await nextGeneration(fx, pid, gen, { changed: 'scope_approval' });
    assert.deepEqual(approveOption(gen).blockers, [], 'approve can be chosen');
    assert.equal(gen.manifest.classifier_version, V, 'the manifest binds the running classifier_version (D3 §3.3)');
    assert.deepEqual(gen.manifest.classifier_authority, await configured(fx), 'the manifest binds classifier_authority as configured');
    assert.ok(gen.manifest.discovery !== undefined && gen.manifest.discovery !== null, "the manifest binds the proposal's discovery");

    const withdrawn = async (what, changed) => {
      assertWithdrawn(fx, ctx, what);
      assert.equal(classOf(fx, ctx), 'unclassifiable', `${what}: the class is unchanged`);
      gen = await nextAfterWithdrawal(fx, pid, UNCL, ctx.proposal, gen, { changed });
    };

    // Held at the intent: the spec's criteria, then its areas.
    for (const [what, index] of [['the spec\'s criteria', MORE_CRITERIA], ['the spec\'s areas', MORE_AREAS]]) {
      const held = await answerAndHoldEffect(fx, pid, gen, 'approve');
      const plan = await reviseSpec(fx, pid, index);
      await assertEffectInvalidated(fx, gen, held);
      await withdrawn(what, 'spec_revision');
      await stageSettled(fx, pid, plan);
    }

    // Killed at the intent, changed while the engine is down, replayed after the restart.
    await approveAndKill(fx, pid, gen);
    removeScopeApprovals(fx.home, ctx.proposal.id);
    await fx.start();
    await assertReplayRefused(fx, pid, gen, 'the validation-scope approval withdrawn');
    await withdrawn('the validation-scope approval withdrawn', 'scope_approval');
    assert.ok(approveOption(gen).blockers.includes('APPROVAL_MISSING'), 'approve waits for a validation-scope approval again');
    await scopeApproval(fx.engine, pid, ctx.proposal.id);
    gen = await nextGeneration(fx, pid, gen, { changed: 'scope_approval' });

    const args = [CLASSIFIER_FLAG, String(V + 1)];
    await approveAndKill(fx, pid, gen);
    await fx.start({ args });
    assert.equal(await runningClassifier(fx.engine), V + 1, 'the fixture is live: another classifier version runs');
    await assertReplayRefused(fx, pid, gen, 'the classifier version');
    await withdrawn('the classifier version', 'classifier_version');
    assert.equal(gen.manifest.classifier_version, V + 1, 'the next generation binds the classifier that runs now');

    await approveAndKill(fx, pid, gen);
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version: V + 1 } });
    await fx.start({ args });
    await assertReplayRefused(fx, pid, gen, 'classifier_authority');
    await withdrawn('classifier_authority', 'classifier_authority');

    // The engine's output bound lowered under the governed output_max_bytes:
    // the proposal's discovery now has an error, and the class is still unclassifiable.
    await approveAndKill(fx, pid, gen);
    setEngineConfig(fx, { check_output_max_bytes: 65536 });
    await fx.start({ args });
    await assertReplayRefused(fx, pid, gen, "the proposal's discovery");
    await withdrawn("the proposal's discovery", 'discovery');
    assert.ok(approveOption(gen).blockers.includes('CHECK_DEFINITION_INVALID'), 'with an error in its discovery, approve is blocked (L5)');
    assertNotApplied(fx, ctx, ctx.headBefore);
  });

  test("(c) recommend: a Reviewer's approval is a recommendation; authoritative for another version reads as recommend; for the running version it applies after revalidation, and (a) is withdrawn when a bound input changes first", async (t) => {
    const fx = await scriptedEngine(t);
    const V = await runningClassifier(fx.engine);

    for (const [what, authority] of [['recommend, the default', undefined], ['authoritative naming another version', { mode: 'authoritative', version: V + 1 }]]) {
      if (authority !== undefined) {
        await fx.engine.stop();
        setEngineConfig(fx, { classifier_authority: authority });
        await fx.start();
        assert.deepEqual((await fx.engine.engineInfo()).config.classifier_authority, { value: authority, source: 'file' }, `${what}: the setting is read as configured`);
      } else {
        assert.deepEqual((await fx.engine.engineInfo()).config.classifier_authority, { value: { mode: 'recommend' }, source: 'default' }, `${what}: the default is recommend`);
      }
      const ctx = await correctionOn(fx, TIGHTENING, 'tightening');
      await openDecision(fx, ctx.project.id, TIGHT, ctx.proposal.id);
      const { run } = await reviewerApproves(fx, ctx.project, ctx.proposal);
      await tick(fx.engine, ctx.project.id, { rounds: 3 });
      const row = assertNotApplied(fx, ctx, ctx.headBefore);
      assert.equal(row.status, 'classified', `${what}: the Reviewer's approval applied nothing; the proposal awaits an approval`);
      assert.ok(proposalRow(fx.home, ctx.project.id, ctx.proposal.id).recommendations.some((r) => r.run === run.id), `${what}: the approval is recorded as the Reviewer's recommendation`);
      assert.ok(decisionsOn(fx.home, TIGHT, ctx.proposal.id).some((d) => d.status === 'open'), `${what}: the human's decision is open`);
    }

    // authoritative, naming the running version.
    await fx.engine.stop();
    setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version: V } });
    await fx.start();
    const ctx = await correctionOn(fx, TIGHTENING, 'tightening');
    const pid = ctx.project.id;
    const first = await openDecision(fx, pid, TIGHT, ctx.proposal.id);

    // (a) The spec's criteria change between the Reviewer's approval and its application.
    await armBarrier(fx.engine, BEFORE_REVALIDATION, 'pause');
    await reviewerApproval(fx, pid, ctx.proposal);
    await reachBarrier(fx, pid, BEFORE_REVALIDATION);
    const pending = proposalRow(fx.home, pid, ctx.proposal.id);
    assert.deepEqual([pending.status, pending.approver_authority], ['approved', 'reviewer'], 'the Reviewer\'s approval is recorded, its application not begun');
    const plan = await reviseSpec(fx, pid, MORE_CRITERIA);
    await releaseBarrier(fx.engine, BEFORE_REVALIDATION);
    await reviewerWithdrawn(fx, ctx, "the spec's criteria changed before the Reviewer's application");
    await stageSettled(fx, pid, plan);
    const again = await openWhere(fx, ctx, TIGHT, (d) => JSON.stringify(d.manifest.spec_revision) !== JSON.stringify(first.manifest.spec_revision), 'the human\'s question, asked again on the revised spec');
    assert.notEqual(again.id, first.id, 'a new generation is asked');

    // The Reviewer approves again, nothing changes, and the application is made.
    const { run } = await reviewerApproves(fx, ctx.project, ctx.proposal);
    await waitApplied(fx, ctx.project, ctx.proposal);
    assertApplied(fx, ctx.project, { proposal: ctx.proposal, previous: ctx.previous, headBefore: ctx.headBefore, authority: 'reviewer', changeKind: 'tightening' });
    assert.equal(proposalRow(fx.home, pid, ctx.proposal.id).approver, run.id, 'the Reviewer\'s run is the approver');
    assert.deepEqual(decisionsOn(fx.home, TIGHT, ctx.proposal.id).filter((d) => d.status === 'open'), [], 'the human\'s decision is closed');
  });

  test("(d) the setting changed while a Reviewer's application is pending stops it and the proposal goes to the human; (b) a Reviewer's application replayed after a restart under another classifier version is refused", async (t) => {
    const fx = await scriptedEngine(t);
    const V = await runningClassifier(fx.engine);
    const authoritative = { mode: 'authoritative', version: V };
    await fx.engine.stop();
    setEngineConfig(fx, { classifier_authority: authoritative });
    await fx.start();

    // (d) Killed before the application's revalidation; restarted under recommend.
    const d = await correctionOn(fx, TIGHTENING, 'tightening');
    await armBarrier(fx.engine, BEFORE_REVALIDATION, 'kill');
    await reviewerApproval(fx, d.project.id, d.proposal);
    await untilKilled(fx, d.project.id);
    assert.equal(proposalRow(fx.home, d.project.id, d.proposal.id).status, 'approved', 'the fixture is live: the Reviewer\'s application is pending');
    setEngineConfig(fx, { classifier_authority: undefined });
    await fx.start();
    await reviewerWithdrawn(fx, d, 'the setting changed to recommend while pending');
    const human = await openWhere(fx, d, TIGHT, (row) => row.manifest.classifier_authority?.mode === 'recommend', 'the proposal to go to the human');
    await consume(fx, d.project.id, human, 'approve');
    await waitApplied(fx, d.project, d.proposal);
    assertApplied(fx, d.project, { proposal: d.proposal, previous: d.previous, headBefore: d.headBefore, authority: 'human', changeKind: 'tightening' });

    // (b) Killed after the application's journal intent; restarted with another classifier running.
    await fx.engine.stop();
    setEngineConfig(fx, { classifier_authority: authoritative });
    await fx.start();
    const b = await correctionOn(fx, TIGHTENING, 'tightening');
    await armBarrier(fx.engine, 'journal.commit_tree.intent_committed', 'kill');
    await reviewerApproval(fx, b.project.id, b.proposal);
    await untilKilled(fx, b.project.id);
    const intended = protectedVersions(fx.home, b.project.id).filter((version) => version.proposal === b.proposal.id);
    assert.equal(intended.length, 1, 'the fixture is live: the application\'s intended version is recorded');
    assert.equal(refOid(b.project.repo.path, b.project.repo.ref), b.headBefore, 'and no git effect was made');
    await fx.start({ args: [CLASSIFIER_FLAG, String(V + 1)] });
    await reviewerWithdrawn(fx, b, 'the replay under another classifier version');
    await openWhere(fx, b, TIGHT, (row) => row.manifest.classifier_version === V + 1, 'the proposal to go to the human, bound to the classifier that runs');
    for (let i = 0; i < 2; i++) await tick(fx.engine, b.project.id);
    assertWithdrawn(fx, b, 'the refused replay, after further ticks');
  });
});
