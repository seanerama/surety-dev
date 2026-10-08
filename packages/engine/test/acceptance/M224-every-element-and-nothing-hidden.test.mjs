// M224, every element, and nothing hidden (M3 slice 19; kernel lane). M3
// plan §3.5 M224; D3-C01 to D3-C04, D3-C11; B02; T03; D3 §§1.6, 3.1, 3.2,
// A.2 ClassificationReason, A.3 protected_proposals.classification; SEAM.md
// §§215 to 220.
//
// The engine classifies every captured proposal itself, at a tick after its
// capture, against the effective version's discovery and the requirement
// index; the classification fixture of SEAM §67 is never used here. Each
// proposal changes one thing (or one thing beside one other) on a baseline
// whose checks declare their own input files, so each change's elements can
// be named. (a) Project creation is `initial` and no classification is.
// (b) Each strict element alone is a tightening with its reason; a root
// addition is not among them. (c) Each loosening element alone, and beside
// a strict one, is a loosening; a root removal is one. (d) Each
// unclassifiable element beside a strict one and beside a loosening one is
// unclassifiable with both elements recorded; a discovery error alone and a
// neutral-only change are unclassifiable. (e) Each schema field's isolated
// delta is classified and none vanishes; the deltas with no explicit rule
// (a `phase` change, an added sensitive area) and the type and mode of an
// input stay unclassifiable beside a new strict check. Every classification
// records the running `classifier_version`.
//
// Expected to fail on `main`: no classifier runs. `GET /v1/engine` names no
// `classifier_version`, and no proposal is classified by the engine.

import { describe, test } from 'node:test';

import { REASONS, KERNEL_COMMANDS, README, RUN, assertClassification, chmodSteps, classifierProject, defPath, engineClassification, policyProposal, protectedFiles, runningClassifier, verifierProposal, writeDef, writeGov } from './harness/checks/classifier.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

// ---- the baseline ---------------------------------------------------------------------------

const INDEX = [
  { key: 'R1', criteria: ['R1.1', 'R1.2'] },
  { key: 'R2', areas: ['authentication', 'personal_data'], criteria: ['R2.1'] },
];

const ROOTS = ['.surety/checks/', 'docs/protected/'];
const GOV = { protected_paths: ROOTS, check_commands: KERNEL_COMMANDS, runner_config: { direct: { egress_allow: ['example.test'] } }, required_checks: ['a', 'b', 'f', 'g', 's', 'x'] };
const base = (key, kind, more = {}) => ({ kind, command: ['probe', key], timeout_s: 60, inputs: [RUN(key)], ...more });
const DEFS = {
  a: base('a', 'acceptance', { covers: { criteria: ['R1.1'] }, gate_kinds: ['stage'], tier_floor: 'T2', phase: 1 }),
  b: base('b', 'acceptance', { covers: { criteria: ['R1.1', 'R1.2'] }, gate_kinds: ['stage', 'alpha_authorize'] }),
  f: base('f', 'sensitivity_floor', { covers: { sensitive_areas: ['authentication', 'personal_data'] }, gate_kinds: ['stage'] }),
  g: base('g', 'sensitivity_floor', { covers: { sensitive_areas: ['authentication'] }, gate_kinds: ['stage'] }),
  s: base('s', 'smoke', { gate_kinds: ['stage'] }),
  x: base('x', 'post_deploy_behavior', { gate_kinds: ['alpha_complete'], requires: ['environment'] }),
  o: base('o', 'smoke', { gate_kinds: ['stage'] }),
};
const FILES = {
  ...Object.fromEntries(Object.keys(DEFS).map((key) => [RUN(key), `the input of ${key}\n`])),
  [README]: '# the checks\n',
  'docs/protected/notes.md': 'notes under the second root\n',
  'docs/protected/sub/keep.md': 'kept under a narrower root\n',
};

// A definition of the baseline with `change` applied; a field given as
// undefined is removed.
function changed(key, change) {
  const out = { ...DEFS[key], ...change };
  for (const [k, v] of Object.entries(change)) if (v === undefined) delete out[k];
  return out;
}
const edit = (key, change) => [writeDef(key, changed(key, change))];
const gov = (change) => [writeGov({ ...GOV, ...change })];

// The companions of section (d): a new check `n` (strict, alone a
// tightening) and `b` losing a gate kind (loosening, alone a loosening).
const ADD_N = [writeDef('n', base('n', 'smoke', { gate_kinds: ['stage'] })), step.write(RUN('n'), 'the input of n\n')];
const STRICT_N = 'check_added:n';
const LOOSE_B = edit('b', { gate_kinds: ['stage'] });
const LOOSE_B_EL = 'gate_kinds_removed:b';

// One shared fixture per section: a scripted engine and a project with the
// baseline; each case is one proposal on it, captured and classified.
async function section(t) {
  const fx = await scriptedEngine(t);
  const project = await classifierProject(fx, { files: protectedFiles({ governed: GOV, defs: DEFS, files: FILES }), index: INDEX });
  let running;
  const one = async (label, make, expected) => {
    const proposal = typeof make === 'function' ? await make() : await verifierProposal(fx, project, make);
    running ??= await runningClassifier(fx.engine);
    assertClassification(await engineClassification(fx, project.id, proposal), expected, { label, running });
  };
  return { fx, project, one };
}

describe('M224 every element, and nothing hidden', () => {
  test('(a), (b) project creation is initial and nothing else is; each strict element alone is a tightening with its reason', async (t) => {
    const { one } = await section(t);
    const cases = [
      ['a check added with a valid definition', ADD_N, ['check_added:n']],
      ['covers.criteria gaining a value', edit('a', { covers: { criteria: ['R1.1', 'R1.2'] } }), ['criteria_added:a']],
      ['gate_kinds gaining a value', edit('a', { gate_kinds: ['stage', 'alpha_authorize'] }), ['gate_kinds_added:a']],
      ['tier_floor lowered', edit('a', { tier_floor: 'T1' }), ['tier_floor_lowered:a']],
      ['tier_floor removed', edit('a', { tier_floor: undefined }), ['tier_floor_lowered:a']],
      ['a key added to required_checks together with its new check', [...ADD_N, ...gov({ required_checks: [...GOV.required_checks, 'n'] })], ['check_added:n', 'required_key_added_with_check:n']],
    ];
    for (const [label, steps, exact] of cases) await one(label, steps, { kind: 'tightening', exact });
    // A root addition is not among them: (e) and M225 (b) classify it unclassifiable.
  });

  test('(c) each loosening element alone, and beside a strict one, is a loosening; a root removal is one', async (t) => {
    const { fx, project, one } = await section(t);
    const cases = [
      ['a check removed', [step.delete(defPath('o'))], 'check_removed:o'],
      ['a key removed from required_checks', gov({ required_checks: GOV.required_checks.filter((key) => key !== 'b') }), 'required_key_removed:b'],
      ['covers.criteria losing a value', edit('b', { covers: { criteria: ['R1.1'] } }), 'criteria_removed:b'],
      ['covers.sensitive_areas losing a value', edit('f', { covers: { sensitive_areas: ['authentication'] } }), 'areas_removed:f'],
      ['gate_kinds losing a value', LOOSE_B, LOOSE_B_EL],
      ['tier_floor raised', edit('a', { tier_floor: 'T3' }), 'tier_floor_raised:a'],
      ['tier_floor added', edit('b', { tier_floor: 'T2' }), 'tier_floor_raised:b'],
      ['a root removed from protected_paths', gov({ protected_paths: ['.surety/checks/'] }), 'root_removed'],
    ];
    for (const [label, steps, element] of cases) await one(`${label}, alone`, steps, { kind: 'loosening', exact: [element] });
    for (const [label, steps, element] of cases) await one(`${label}, beside a new check`, [...steps, ...ADD_N], { kind: 'loosening', exact: [element, STRICT_N] });
    // The policy route classifies the same root removal by the same rule (M225 (c) compares the two).
    await one('a root removed through the policy route', () => policyProposal(fx, project, { protected_paths: ['.surety/checks/'] }), { kind: 'loosening', exact: ['root_removed'] });
  });

  test('(d) each unclassifiable element beside a strict one and beside a loosening one is unclassifiable, with every element recorded; a discovery error alone and neutral changes only are unclassifiable', async (t) => {
    const { one } = await section(t);
    const unclassifiable = [
      ['a root added', gov({ protected_paths: [...ROOTS, 'docs/extra/'] }), 'root_layout_changed'],
      ['a program added to check_commands', gov({ check_commands: { ...KERNEL_COMMANDS, other: { path: '/usr/bin/false' } } }), 'governed_field_changed'],
      ["an existing check's timeout_s", edit('s', { timeout_s: 120 }), 'execution_field_changed:s'],
      ["an existing check's input file", [step.write(RUN('a'), 'the input of a, changed\n')], 'input_changed:a'],
      ['a key added to required_checks for a check that already existed', gov({ required_checks: [...GOV.required_checks, 'o'] }), 'required_key_added_alone:o'],
      ['a definition that is not JSON', [step.write(defPath('broken'), '{"schema": 1, "key": ')], 'discovery_error'],
      ['an added sensitive area', edit('g', { covers: { sensitive_areas: ['authentication', 'personal_data'] } }), 'unhandled_change:g'],
    ];
    for (const [label, steps, element] of unclassifiable) {
      await one(`${label}, beside a new check`, [...steps, ...ADD_N], { kind: 'unclassifiable', contains: [element, STRICT_N] });
      await one(`${label}, beside a loosening`, [...steps, ...LOOSE_B], { kind: 'unclassifiable', contains: [element, LOOSE_B_EL] });
    }
    await one('a definition that is not JSON, alone', [step.write(defPath('broken'), '{"schema": 1, "key": ')], { kind: 'unclassifiable', contains: ['discovery_error'] });
    await one('neutral changes only', [step.write(README, '# the checks, reworded\n'), step.write('docs/protected/notes.md', 'notes, reworded\n')], { kind: 'unclassifiable', neutral: [README, 'docs/protected/notes.md'] });
  });

  test("(e) each schema field's isolated delta is classified, and none vanishes", async (t) => {
    const { fx, project, one } = await section(t);
    const policy = (change) => () => policyProposal(fx, project, change);
    const moved = [];
    for (const [key, fields] of Object.entries(DEFS)) moved.push(step.write(`.surety/checks/definitions/${key}.json`, JSON.stringify({ schema: 1, key, ...fields }, null, 2)), step.delete(defPath(key)));
    const cases = [
      // The governed fields (D3 §3.2): every change but a root removal (c) and a required_checks removal (c).
      ['protected_paths: a root added', policy({ protected_paths: [...ROOTS, 'docs/extra/'] }), { contains: ['root_layout_changed'] }],
      ['protected_paths: a root narrowed', policy({ protected_paths: ['.surety/checks/', 'docs/protected/sub/'] }), { contains: ['root_layout_changed'], allow: ['root_removed'] }],
      ['check_commands', policy({ check_commands: { ...KERNEL_COMMANDS, other: { path: '/usr/bin/false' } } }), { contains: ['governed_field_changed'] }],
      ['check_discovery (the definitions moved with it)', [...moved, ...gov({ check_discovery: { definitions: '.surety/checks/definitions/' } })], { contains: ['governed_field_changed'] }],
      ['runner_config', policy({ runner_config: { direct: { egress_allow: ['example.test'], timeout_max_s: 900 } } }), { contains: ['governed_field_changed'] }],
      ['result_collection', policy({ result_collection: { output_max_bytes: 131072 } }), { contains: ['governed_field_changed'] }],
      ['required_checks: an existing check added', policy({ required_checks: [...GOV.required_checks, 'o'] }), { contains: ['required_key_added_alone:o'] }],
      // A definition's fields: criteria, sensitive-area loss, gate kinds and tier floor are (b) and (c).
      ['kind', edit('s', { kind: 'security_lint' }), { contains: ['execution_field_changed:s'] }],
      ['origin', edit('s', { origin: 'developer' }), { contains: ['execution_field_changed:s'] }],
      ['command', edit('s', { command: ['probe', 's', '--strict'] }), { contains: ['execution_field_changed:s'] }],
      ['cwd', edit('s', { cwd: 'src' }), { contains: ['execution_field_changed:s'] }],
      ['env', edit('s', { env: { MODE: 'strict' } }), { contains: ['execution_field_changed:s'] }],
      ['timeout_s', edit('s', { timeout_s: 120 }), { contains: ['execution_field_changed:s'] }],
      ['runner_class', edit('s', { runner_class: 'container' }), { contains: ['execution_field_changed:s'] }],
      ['requires', edit('x', { requires: ['environment', 'artifact_digest'] }), { contains: ['execution_field_changed:x'] }],
      ['inputs', [step.write(RUN('s2'), 'a second input of s\n'), ...edit('s', { inputs: [RUN('s'), RUN('s2')] })], { contains: ['execution_field_changed:s'] }],
      ['egress', edit('s', { egress: ['example.test'] }), { contains: ['execution_field_changed:s'] }],
      ['covers.sensitive_areas gaining a value (no explicit rule)', edit('g', { covers: { sensitive_areas: ['authentication', 'personal_data'] } }), { contains: ['unhandled_change:g'] }],
      ['phase (no explicit rule)', edit('a', { phase: 2 }), { contains: ['unhandled_change:a'] }],
      // An input manifest: content, mode, type.
      ["an input's content", [step.write(RUN('a'), 'the input of a, changed\n')], { contains: ['input_changed:a'] }],
      ["an input's executable bit", () => verifierProposal(fx, project, chmodSteps(project, RUN('a'), FILES[RUN('a')])), { contains: ['input_changed:a'] }],
      ['an input replaced by a symlink', [step.delete(RUN('a')), step.symlink(RUN('a'), 'b.txt')], { contains: ['discovery_error'] }],
    ];
    for (const [label, make, expected] of cases) await one(label, make, { kind: 'unclassifiable', ...expected });
  });

  test('(e) each delta with no explicit rule, and the type and mode of an input, stay unclassifiable beside a new strict check', async (t) => {
    const { fx, project, one } = await section(t);
    const cases = [
      ['a phase change', edit('a', { phase: 2 }), 'unhandled_change:a'],
      ['an added sensitive area', edit('g', { covers: { sensitive_areas: ['authentication', 'personal_data'] } }), 'unhandled_change:g'],
      ['a symlink for a regular input', [step.delete(RUN('a')), step.symlink(RUN('a'), 'b.txt')], 'discovery_error'],
      ['an executable-mode change', null, 'input_changed:a'],
    ];
    for (const [label, steps, element] of cases) {
      const make = steps ?? (() => verifierProposal(fx, project, [...chmodSteps(project, RUN('a'), FILES[RUN('a')]), ...ADD_N]));
      await one(`${label}, beside a new check`, steps === null ? make : [...steps, ...ADD_N], { kind: 'unclassifiable', contains: [element, STRICT_N] });
    }
  });
});

// Every reason the cases above expect is one of D3 A.2's (a typo here would make a case vacuous).
const expectedReasons = ['check_added', 'criteria_added', 'gate_kinds_added', 'tier_floor_lowered', 'required_key_added_with_check', 'check_removed', 'required_key_removed', 'criteria_removed', 'areas_removed', 'gate_kinds_removed', 'tier_floor_raised', 'root_removed', 'root_layout_changed', 'governed_field_changed', 'execution_field_changed', 'input_changed', 'required_key_added_alone', 'discovery_error', 'unhandled_change'];
for (const reason of expectedReasons) if (!Object.values(REASONS).flat().includes(reason)) throw new Error(`M224 names ${reason}, which is no ClassificationReason`);
