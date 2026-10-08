// M228, invalid definitions and spec changes (M3 slice 19; kernel lane). M3
// plan §3.5 M228; D3-C09, D3-C10; L5; D3 §§1.4, 3.4, §7.1 L5; SEAM.md §§178,
// 179, 215 to 220. With row M11's contradiction at the protected path (bucket
// C of the triage leaves here: M3 plan §4.4).
//
// (a) A proposal whose discovery has an error is unclassifiable, with a
// `discovery_error` element, and its `approve` carries
// `CHECK_DEFINITION_INVALID`; `reject` works. Two proposals: a definition
// naming a criterion the index does not have (`criterion_unknown`), and a
// definition that is not JSON. (b) A spec revision removing a criterion a
// definition of the effective version names gives that version
// `criterion_unknown`, and every gate of the project
// `ACCEPTANCE_SCOPE_INCOMPLETE` naming it, until a correction the engine
// classifies, and the human approves, applies.
//
// Expected to fail on `main`: no classifier runs. `GET /v1/engine` names no
// `classifier_version`, and no proposal is classified by the engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KERNEL_COMMANDS, RUN, assertClassification, classifierProject, defPath, engineClassification, protectedFiles, reviseSpec, runningClassifier, stageSettled, verifierProposal, writeDef } from './harness/checks/classifier.mjs';
import { versionRead } from './harness/checks/fixtures.mjs';
import { answer, assertQuestionClosed, consume, openDecision, reject } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { alphaTarget, assertApplied, assertProposalRejected, effectiveVersion, reasonSubjects, stageGate, waitApplied } from './harness/gates.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const INDEX = [{ key: 'R1', criteria: ['R1.1', 'R1.2'] }];
const GOV = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS };
const acceptanceDef = (key, criteria) => ({ kind: 'acceptance', command: ['probe', key], timeout_s: 60, covers: { criteria }, gate_kinds: ['stage', 'alpha_authorize'], inputs: [RUN(key)] });
const DEFS = { b: acceptanceDef('b', ['R1.1', 'R1.2']) };
const FILES = protectedFiles({ governed: GOV, defs: DEFS, files: { [RUN('b')]: 'the input of b\n' } });
const KIND = 'check_correction_unclassifiable';

const approveOption = (row) => row.options.find((o) => o.key === 'approve');

describe('M228 invalid definitions and spec changes', () => {
  test('(a) a proposal with a discovery error, criterion_unknown included, is unclassifiable; approve carries CHECK_DEFINITION_INVALID and is refused; reject works', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await classifierProject(fx, { files: FILES, index: INDEX });
    const running = await runningClassifier(fx.engine);
    const previous = effectiveVersion(fx.home, p.id);
    const headBefore = refOid(p.repo.path, p.repo.ref);
    const cases = [
      ['a definition naming a criterion the index does not have', [writeDef('ghost', acceptanceDef('ghost', ['R9.1'])), step.write(RUN('ghost'), 'the input of ghost\n')]],
      ['a definition that is not JSON', [step.write(defPath('broken'), '{"schema": 1, "key": ')]],
    ];
    for (const [i, [label, steps]] of cases.entries()) {
      const proposal = await verifierProposal(fx, p, steps);
      assertClassification(await engineClassification(fx, p.id, proposal), { kind: 'unclassifiable', contains: ['discovery_error'], allow: ['check_added'] }, { label, running });
      const decision = await openDecision(fx, p.id, KIND, proposal.id);
      assert.ok(approveOption(decision)?.blockers?.includes('CHECK_DEFINITION_INVALID'), `${label}: approve carries CHECK_DEFINITION_INVALID (L5) (options: ${JSON.stringify(decision.options)})`);
      assertRefused(await answer(fx.engine, p.id, decision, 'approve'), 409, 'illegal_transition', `${label}: approving`);
      if (i === 0) {
        // reject works: the proposal is rejected and the question closed.
        const rejected = await reject(fx, p.id, decision);
        assertProposalRejected(fx, { project: p, previous, proposal, headBefore });
        await assertQuestionClosed(fx, p.id, rejected);
      }
    }
    assert.equal(effectiveVersion(fx.home, p.id).id, previous.id, 'nothing was applied');
  });

  test('(b) a spec revision removing a criterion a definition names gives the effective version criterion_unknown and every gate ACCEPTANCE_SCOPE_INCOMPLETE, until a correction applies', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await classifierProject(fx, { files: FILES, index: INDEX });
    const running = await runningClassifier(fx.engine);
    const ctx = { project: p, candidate: p.candidate, stage: p.stage };
    const alpha = await alphaTarget(fx, ctx);
    const gates = async () => [['stage', await stageGate(fx, ctx)], ['alpha_authorize', await alpha.evaluate()]];
    const namesB = (evaluation) => reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE').filter((subject) => typeof subject === 'string' && subject.startsWith(defPath('b')));

    for (const [kind, evaluation] of await gates()) assert.deepEqual(namesB(evaluation), [], `the fixture is live: before the revision, the ${kind} gate names no error of b`);

    // The spec drops R1.2, which b names.
    await stageSettled(fx, p.id, await reviseSpec(fx, p.id, [{ key: 'R1', criteria: ['R1.1'] }]));
    const before = effectiveVersion(fx.home, p.id);
    const v = await versionRead(fx.engine, p.id, before.id);
    const unknown = v.discovery_errors.filter((e) => e.code === 'criterion_unknown' && e.path.startsWith(defPath('b')));
    assert.equal(unknown.length, 1, `the effective version gains criterion_unknown at b's definition (errors: ${JSON.stringify(v.discovery_errors)})`);
    for (const [kind, evaluation] of await gates()) {
      assert.equal(evaluation.outcome, 'not_satisfied', `${kind}: not satisfied`);
      assert.ok(namesB(evaluation).includes(unknown[0].path), `${kind}: ACCEPTANCE_SCOPE_INCOMPLETE names ${unknown[0].path} (reasons: ${JSON.stringify(evaluation.reasons)})`);
    }

    // The Verifier's correction: b covers what the spec has. The engine
    // classifies it; the human approves; it applies.
    const headBefore = refOid(p.repo.path, p.repo.ref);
    const proposal = await verifierProposal(fx, p, [writeDef('b', acceptanceDef('b', ['R1.1']))]);
    assertClassification(await engineClassification(fx, p.id, proposal), { kind: 'loosening', exact: ['criteria_removed:b'] }, { label: 'the correction', running });
    for (const [kind, evaluation] of await gates()) assert.ok(namesB(evaluation).length > 0, `${kind}: still incomplete while the correction is not applied`);
    await consume(fx, p.id, await openDecision(fx, p.id, 'check_correction_loosening', proposal.id), 'approve');
    await waitApplied(fx, p, proposal);
    const after = assertApplied(fx, p, { proposal, previous: before, headBefore, authority: 'human', changeKind: 'loosening' });
    assert.deepEqual((await versionRead(fx.engine, p.id, after.id)).discovery_errors, [], 'the corrected version has no discovery error');
    for (const [kind, evaluation] of await gates()) assert.deepEqual(namesB(evaluation), [], `${kind}: once the correction applies, ACCEPTANCE_SCOPE_INCOMPLETE names no error of b`);
  });
});
