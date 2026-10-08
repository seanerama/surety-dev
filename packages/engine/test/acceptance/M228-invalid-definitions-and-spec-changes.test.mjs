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
// classifies, and the human approves, applies. (c) An error in the
// effective version's own discovery is never ignored (D3 §1.4: a dropped
// check is a loosening nobody approved): a proposal whose discovery does
// not reproduce it identically is unclassifiable, with an `unhandled_change`
// element naming the error's path (the driver's ruling, SEAM §216). Three
// proposals: P0's invalid required definition deleted and the required set
// rewritten round a new check; that definition repaired in place beside a
// new check; and a governed-file error of P0 removed beside a new check.
//
// Expected to fail on `main`: no classifier runs. `GET /v1/engine` names no
// `classifier_version`, and no proposal is classified by the engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GOVERNED_FILE, KERNEL_COMMANDS, RUN, assertClassification, classifierProject, defPath, engineClassification, protectedFiles, reviseSpec, runningClassifier, stageSettled, verifierProposal, writeDef, writeGov } from './harness/checks/classifier.mjs';
import { codesAt, versionRead } from './harness/checks/fixtures.mjs';
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

// The effective version's discovery errors.
const effectiveErrors = async (fx, p) => (await versionRead(fx.engine, p.id, effectiveVersion(fx.home, p.id).id)).discovery_errors;
// Every error of P0 that P1 does not reproduce identically is named by an
// `unhandled_change` element: at the error's path, or at its file.
function assertP0ErrorsNamed(c, p0errors, label) {
  const p1 = c.discovery?.errors ?? [];
  const same = (a, b) => a.path === b.path && a.code === b.code;
  const lost = p0errors.filter((e) => !p1.some((f) => same(e, f)));
  assert.ok(lost.length > 0, `${label}: the fixture is live: an error of P0 is not reproduced by the proposal (P0: ${JSON.stringify(p0errors)}; P1: ${JSON.stringify(p1)})`);
  for (const e of lost) {
    const named = c.elements.some((el) => el.reason === 'unhandled_change' && (el.path === e.path || el.path === e.path.split('#')[0]));
    assert.ok(named, `${label}: an unhandled_change element names P0's error at ${e.path} (${e.code}) (elements: ${JSON.stringify(c.elements)})`);
  }
}

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

  test("(c) an error in the effective version's own discovery that the proposal does not reproduce makes it unclassifiable, with an unhandled_change element naming the error's path", async (t) => {
    const fx = await scriptedEngine(t);
    const running = await runningClassifier(fx.engine);
    const K = defPath('k');
    const NEW_N = [writeDef('n', acceptanceDef('n', ['R1.1'])), step.write(RUN('n'), 'the input of n\n')];

    // P0: k covers R1.2 and is required, and its definition has an unknown field.
    const gov = { ...GOV, required_checks: ['a', 'k'] };
    const defs = { a: acceptanceDef('a', ['R1.1']), k: { ...acceptanceDef('k', ['R1.2']), surprise: 1 } };
    const p = await classifierProject(fx, { files: protectedFiles({ governed: gov, defs, files: { [RUN('a')]: 'the input of a\n', [RUN('k')]: 'the input of k\n' } }), index: INDEX, withErrors: true });
    const p0 = await effectiveErrors(fx, p);
    assert.ok(codesAt({ discovery_errors: p0 }, K).includes('unknown_field'), `the fixture is live: the effective version has unknown_field at ${K} (${JSON.stringify(p0)})`);

    // A dropped check is never a tightening. k's removal from the required
    // set may also be recorded as a loosening; k's definition, once valid,
    // as an added check: neither hides the error of P0.
    const cases = [
      ["P0's invalid definition deleted, the required set rewritten round a new required check", [step.delete(K), ...NEW_N, writeGov({ ...gov, required_checks: ['a', 'n'] })], ['check_added:n', 'required_key_added_with_check:n'], ['required_key_removed', 'check_removed']],
      ["P0's invalid definition repaired in place, beside a new check", [writeDef('k', acceptanceDef('k', ['R1.2'])), ...NEW_N], ['check_added:n'], ['check_added', 'required_key_added_with_check']],
    ];
    for (const [label, steps, contains, allow] of cases) {
      const { row, c } = await engineClassification(fx, p.id, await verifierProposal(fx, p, steps));
      assert.deepEqual(c.discovery?.errors, [], `${label}: the fixture is live: the proposal's own discovery has no error (${JSON.stringify(c.discovery)})`);
      assertClassification({ row, c }, { kind: 'unclassifiable', contains: ['unhandled_change', ...contains], allow }, { label, running });
      assertP0ErrorsNamed(c, p0, label);
    }

    // A governed-file error of P0, removed beside a new check.
    const direct = { egress_allow: ['example.test'] };
    const q = await classifierProject(fx, { files: protectedFiles({ governed: { ...GOV, runner_config: { direct: { ...direct, surprise: 1 } } }, defs: DEFS, files: { [RUN('b')]: 'the input of b\n' } }), index: INDEX, withErrors: true });
    const q0 = await effectiveErrors(fx, q);
    assert.ok(codesAt({ discovery_errors: q0 }, GOVERNED_FILE).includes('unknown_field'), `the fixture is live: the effective version has unknown_field in ${GOVERNED_FILE} (${JSON.stringify(q0)})`);
    const label = "P0's unknown runner_config.direct member removed, beside a new check";
    const { row, c } = await engineClassification(fx, q.id, await verifierProposal(fx, q, [writeGov({ ...GOV, runner_config: { direct } }), ...NEW_N]));
    assert.deepEqual(c.discovery?.errors, [], `${label}: the fixture is live: the proposal's own discovery has no error (${JSON.stringify(c.discovery)})`);
    assertClassification({ row, c }, { kind: 'unclassifiable', contains: ['unhandled_change', 'check_added:n'], allow: ['required_key_added_with_check'] }, { label, running });
    assertP0ErrorsNamed(c, q0, label);
  });
});
