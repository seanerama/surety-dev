// M225, declared inputs, root changes, the policy route (M3 slice 19; kernel
// lane). M3 plan §3.5 M225; D3-C05, D3-C06; B02; Q3; D3 §§1.3, 3.1, 3.2;
// AD §8.2's adversarial table; SEAM.md §§66, 215 to 220.
//
// (a) A new check whose files lie outside every existing check's inputs,
// the root layout unchanged, is a tightening when the existing checks
// declare their inputs, and unclassifiable under default inputs, where the
// new files are in every existing check's manifest. (b) A governed edit
// adding a root is unclassifiable under declared and default inputs alike,
// for a project whose retained check runs a protected runner that discovers
// the candidate's tests under the directory the new root would hide (AD
// §B02's counterexample; whether that check would then pass is row M238's,
// in the project lane). (c) A root removed is a loosening, through the
// policy route and through a Verifier's run alike: the same function gives
// the same class and elements. (d) A program change is unclassifiable.
//
// Expected to fail on `main`: no classifier runs. `GET /v1/engine` names no
// `classifier_version`, and no proposal is classified by the engine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GOVERNED_FILE, KERNEL_COMMANDS, RUN, assertClassification, classifierProject, engineClassification, policyProposal, protectedFiles, runningClassifier, verifierProposal, writeDef, writeGov } from './harness/checks/classifier.mjs';
import { fileAt } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const INDEX = [{ key: 'R1', criteria: ['R1.1'] }];
const RUNNER = '.surety/checks/run/runner.mjs';
// A protected runner as AD §B02 describes it: it discovers the candidate's
// tests under tests/ and src/, refuses an empty suite, and propagates the
// test process's exit. Its text only; nothing runs in the kernel lane.
const RUNNER_TEXT = [
  "import { spawnSync } from 'node:child_process';",
  "import { readdirSync, existsSync } from 'node:fs';",
  "const found = ['tests', 'src'].filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.test.mjs')).map((f) => `${d}/${f}`));",
  "if (found.length === 0) process.exit(2);",
  "process.exit(spawnSync(process.execPath, ['--test', ...found], { stdio: 'inherit' }).status ?? 1);",
  '',
].join('\n');
const SOURCE = {
  'tests/base.test.mjs': "import { test } from 'node:test';\ntest('a passing baseline', () => {});\n",
  'src/app.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('a failing source test', () => assert.equal(1, 2));\n",
};

// The retained check `runner` and a smoke check `s`, with declared inputs or
// with none (default inputs, Q3).
function project({ declared }) {
  const inputs = (paths) => (declared ? { inputs: paths } : {});
  const defs = {
    runner: { kind: 'acceptance', command: ['probe', RUNNER], timeout_s: 60, covers: { criteria: ['R1.1'] }, gate_kinds: ['stage'], ...inputs([RUNNER]) },
    s: { kind: 'smoke', command: ['probe', 's'], timeout_s: 60, gate_kinds: ['stage'], ...inputs([RUN('s')]) },
  };
  const governed = { protected_paths: ['.surety/checks/'], check_commands: KERNEL_COMMANDS };
  return { governed, defs, files: protectedFiles({ governed, defs, files: { [RUNNER]: RUNNER_TEXT, [RUN('s')]: 'the input of s\n', ...SOURCE } }) };
}

const NEW_CHECK = (declared) => [
  writeDef('n', { kind: 'smoke', command: ['probe', 'n'], timeout_s: 60, gate_kinds: ['stage'], ...(declared ? { inputs: [RUN('n')] } : {}) }),
  step.write(RUN('n'), 'the input of n\n'),
];

async function setUp(t, declared) {
  const fx = await scriptedEngine(t);
  const shape = project({ declared });
  const p = await classifierProject(fx, { files: shape.files, index: INDEX });
  const running = await runningClassifier(fx.engine);
  return { fx, p, shape, running };
}

describe('M225 declared inputs, root changes, the policy route', () => {
  test("(a) a new check outside every existing check's inputs is a tightening with declared inputs, and unclassifiable under default inputs", async (t) => {
    for (const declared of [true, false]) {
      const { fx, p, running } = await setUp(t, declared);
      const got = await engineClassification(fx, p.id, await verifierProposal(fx, p, NEW_CHECK(declared)));
      if (declared) assertClassification(got, { kind: 'tightening', exact: ['check_added:n'] }, { label: 'declared inputs', running });
      else assertClassification(got, { kind: 'unclassifiable', contains: ['input_changed:runner', 'input_changed:s', 'check_added:n'] }, { label: 'default inputs', running });
    }
  });

  test('(b) a governed edit adding a root is unclassifiable under declared and default inputs, where the retained runner discovers the source the root would hide', async (t) => {
    for (const declared of [true, false]) {
      const { fx, p, running } = await setUp(t, declared);
      const proposal = await policyProposal(fx, p, { protected_paths: ['.surety/checks/', 'src/'] });
      assertClassification(await engineClassification(fx, p.id, proposal), { kind: 'unclassifiable', contains: ['root_layout_changed'] }, { label: `${declared ? 'declared' : 'default'} inputs, root src/ added`, running });
    }
  });

  test('(c) a root removed is a loosening, and the policy route and a Verifier classify the same tree alike', async (t) => {
    const { fx, p, governed } = await setUpWithSecondRoot(t);
    const running = await runningClassifier(fx.engine);
    const removed = { ...governed, protected_paths: ['.surety/checks/'] };
    const viaPolicy = await policyProposal(fx, p, { protected_paths: removed.protected_paths });
    const viaRun = await verifierProposal(fx, p, [writeGov(removed)]);
    assert.deepEqual(governedIn(p, viaRun), governedIn(p, viaPolicy), 'the fixture is live: both proposals hold the same governed fields');
    const a = await engineClassification(fx, p.id, viaPolicy);
    const b = await engineClassification(fx, p.id, viaRun);
    assertClassification(a, { kind: 'loosening', exact: ['root_removed'] }, { label: 'a root removed through the policy route', running });
    assertClassification(b, { kind: 'loosening', exact: ['root_removed'] }, { label: 'the same removal by a Verifier', running });
    const shape = (got) => [got.c.change_kind, got.c.elements.map((e) => `${e.reason}:${e.check ?? ''}:${e.path ?? ''}`).sort()];
    assert.deepEqual(shape(b), shape(a), 'one function: the same class and the same elements, whoever proposed the change');
  });

  test('(d) a program change through the policy route is unclassifiable', async (t) => {
    const { fx, p, running } = await setUp(t, true);
    const proposal = await policyProposal(fx, p, { check_commands: { probe: { path: '/usr/bin/env' } } });
    assertClassification(await engineClassification(fx, p.id, proposal), { kind: 'unclassifiable', contains: ['governed_field_changed'] }, { label: "the program check_commands names changed", running });
  });
});

// A project with declared inputs whose governed file names a second root,
// docs/protected/, holding no check's input.
async function setUpWithSecondRoot(t) {
  const fx = await scriptedEngine(t);
  const shape = project({ declared: true });
  const governed = { ...shape.governed, protected_paths: ['.surety/checks/', 'docs/protected/'] };
  const files = protectedFiles({ governed, defs: shape.defs, files: { [RUNNER]: RUNNER_TEXT, [RUN('s')]: 'the input of s\n', ...SOURCE, 'docs/protected/notes.md': 'notes\n' } });
  const p = await classifierProject(fx, { files, index: INDEX });
  return { fx, p, governed };
}

// The governed fields in a proposal's tree.
const governedIn = (p, proposal) => JSON.parse(fileAt(p.repo.path, proposal.tree_id, GOVERNED_FILE));
