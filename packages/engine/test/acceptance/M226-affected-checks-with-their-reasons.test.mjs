// M226, affected checks (M3 slice 19; kernel lane). M3 plan §3.5 M226;
// D3-P09; N01; D3 §1.6, A.2 AffectedReason, A.3; SEAM.md §§215 to 220. With
// M210 (a)'s `input_changed` observation, which slice 17 moved here.
//
// A classification's `affected_checks` lists every check whose definition,
// input identity, required membership or applicability changes, each with
// its reasons, and no check nothing happened to. (a) One proposal adds,
// removes, and changes a definition, an input, the required membership and
// the applicability of one check each; an untouched check is not listed.
// (b) An existing required key removed with no definition change (a list
// introduced that omits it) is listed `required_changed`, though no check
// fingerprint changes. (c) Under default inputs any protected file changed
// lists every check. (d) M210 (a): an executable bit changed, and the same
// input replaced by a symlink, list the check `input_changed`.
//
// Expected to fail on `main`: no classifier runs, so no proposal is
// classified by the engine and none has affected checks.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { KERNEL_COMMANDS, README, RUN, affectedOf, chmodSteps, classifierProject, defPath, engineClassification, policyProposal, protectedFiles, verifierProposal, writeDef, writeGov } from './harness/checks/classifier.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const INDEX = [{ key: 'R1', criteria: ['R1.1'] }];
const smoke = (key, more = {}) => ({ kind: 'smoke', command: ['probe', key], timeout_s: 60, gate_kinds: ['stage'], inputs: [RUN(key)], ...more });
const inputsOf = (keys) => Object.fromEntries(keys.map((key) => [RUN(key), `the input of ${key}\n`]));

async function setUp(t, { governed, defs, files }) {
  const fx = await scriptedEngine(t);
  const p = await classifierProject(fx, { files: protectedFiles({ governed, defs, files }), index: INDEX });
  return { fx, p };
}

const affectedFor = async (fx, p, proposal, label) => affectedOf((await engineClassification(fx, p.id, proposal)).c, label);

describe('M226 affected checks', () => {
  test('(a) checks added, removed, definition-, input-, required- and applicability-changed are each listed with their reasons; an untouched check is not', async (t) => {
    const keys = ['a', 'b', 's', 't', 'u', 'o'];
    const defs = Object.fromEntries(keys.map((key) => [key, smoke(key)]));
    const governed = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS, required_checks: ['a', 'b', 's', 't', 'u'] };
    const { fx, p } = await setUp(t, { governed, defs, files: inputsOf(keys) });
    const proposal = await verifierProposal(fx, p, [
      writeDef('n', smoke('n')), step.write(RUN('n'), 'the input of n\n'), // added
      step.delete(defPath('o')), // removed (o is not required)
      writeDef('s', smoke('s', { timeout_s: 90 })), // definition changed
      step.write(RUN('a'), 'the input of a, changed\n'), // input changed
      writeGov({ ...governed, required_checks: ['a', 's', 't', 'u'] }), // b no longer required
      writeDef('t', smoke('t', { gate_kinds: ['stage', 'alpha_authorize'] })), // applicability changed
    ]);
    const label = 'one proposal of every kind of change';
    const affected = await affectedFor(fx, p, proposal, label);
    for (const [key, reason] of [['n', 'added'], ['o', 'removed'], ['s', 'definition_changed'], ['t', 'applicability_changed']]) {
      assert.ok(affected[key]?.includes(reason), `${label}: ${key} is listed with ${reason} (affected: ${JSON.stringify(affected)})`);
    }
    assert.deepEqual(affected.a, ['input_changed'], `${label}: a, whose input alone changed, is listed input_changed and nothing else (affected: ${JSON.stringify(affected)})`);
    assert.deepEqual(affected.b, ['required_changed'], `${label}: b, whose definition is unchanged, is listed required_changed and nothing else (affected: ${JSON.stringify(affected)})`);
    assert.ok(!('u' in affected), `${label}: u, which nothing changed, is not listed (affected: ${JSON.stringify(affected)})`);
  });

  test('(b) an existing required key removed with no definition change is listed required_changed: a list introduced that omits it', async (t) => {
    const defs = { a: smoke('a'), b: smoke('b') };
    const governed = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS };
    const { fx, p } = await setUp(t, { governed, defs, files: inputsOf(['a', 'b']) });
    const proposal = await policyProposal(fx, p, { required_checks: ['a'] });
    const got = await engineClassification(fx, p.id, proposal);
    const label = 'required_checks introduced as ["a"]';
    const affected = affectedOf(got.c, label);
    assert.deepEqual(affected, { b: ['required_changed'] }, `${label}: b is listed required_changed though its fingerprint is unchanged, and a, still required, is not listed (affected: ${JSON.stringify(affected)})`);
    assert.ok(got.c.elements.some((e) => e.reason === 'required_key_removed' && e.check === 'b'), `${label}: the classification names b leaving the required set (elements: ${JSON.stringify(got.c.elements)})`);
  });

  test('(c) under default inputs any protected file changed lists every check, input_changed', async (t) => {
    const defs = { d1: { kind: 'smoke', command: ['probe', 'd1'], timeout_s: 60, gate_kinds: ['stage'] }, d2: { kind: 'smoke', command: ['probe', 'd2'], timeout_s: 60, gate_kinds: ['stage'] } };
    const governed = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS };
    const { fx, p } = await setUp(t, { governed, defs, files: { [README]: '# the checks\n' } });
    const label = 'a README under the root changed, default inputs';
    const affected = await affectedFor(fx, p, await verifierProposal(fx, p, [step.write(README, '# the checks, reworded\n')]), label);
    assert.deepEqual(Object.keys(affected).sort(), ['d1', 'd2'], `${label}: every check is listed (affected: ${JSON.stringify(affected)})`);
    for (const key of ['d1', 'd2']) assert.ok(affected[key].includes('input_changed'), `${label}: ${key} is listed input_changed`);
  });

  test("(d) M210 (a): an input's executable bit changed, and the input replaced by a symlink, each list its check input_changed", async (t) => {
    const defs = { a: smoke('a'), b: smoke('b') };
    const governed = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS };
    const files = inputsOf(['a', 'b']);
    const { fx, p } = await setUp(t, { governed, defs, files });
    for (const [label, steps] of [
      ['the executable bit of a\'s input', chmodSteps(p, RUN('a'), files[RUN('a')])],
      ['a\'s input replaced by a symlink', [step.delete(RUN('a')), step.symlink(RUN('a'), 'b.txt')]],
    ]) {
      const affected = await affectedFor(fx, p, await verifierProposal(fx, p, steps), label);
      assert.ok(affected.a?.includes('input_changed'), `${label}: a is listed input_changed (affected: ${JSON.stringify(affected)})`);
      assert.ok(!('b' in affected), `${label}: b, whose input is unchanged, is not listed (affected: ${JSON.stringify(affected)})`);
    }
  });
});
