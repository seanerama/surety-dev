// M123, the protected set is read-only to every role but the Verifier (M2
// slice 12, sandbox lane). M2 plan §3.4 M123; D2 §2.3, A.6 P19 (D2-I11);
// D1 §7.3; AR P19; SEAM.md §§66, 132, 137, 141.
//
// For a Builder, a Reviewer and an Architect, each protected root of the
// effective version is a read-only tree inside the workspace: writing,
// truncating, renaming away, renaming over, hard-linking, writing through a
// symbolic link, changing the mode and unlinking a protected file, and
// creating, renaming and changing a protected directory, are each refused
// to the role itself, in the sandbox, before any validation; after the run
// the checkout holds no change under a root, and the role's own permitted
// edit is committed. The Verifier's protected write is not refused: it
// becomes a proposal only, as row M36 pins. After a protected application
// the next run sees the new effective version's files, still read-only.
//
// Two roots, in the governed file: `.surety/checks/` and `acceptance/`
// (SEAM.md §66: a root is a path prefix ending in `/`; the plan's "a file
// and a directory" is read as a protected file and a protected directory,
// each probed under both roots).
//
// SAFETY: the role's operations are confined to workspace-relative paths
// by the role program and are guarded like every acting probe (SEAM.md
// §141).
//
// Every case here is expected to fail on the engine these tests were
// written against, which overlays nothing (COVERAGE.md, "M2 slice 12").

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { sha256Hex } from './harness/engine.mjs';
import { CHECK_FILE, GOVERNED_FILE, capturedProposal, effectiveVersion, humanApplies, proposalsOf, protectedFingerprint } from './harness/gates.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit } from './harness/gitruns.mjs';
import { assertCommitted } from './harness/journal.mjs';
import { gitQuiet, refOid } from './harness/repos.mjs';
import { addWork, getRow } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { byPath, probedRun } from './harness/sandbox/view.mjs';
import { step } from './harness/scripted.mjs';

const ROOTS = ['.surety/checks/', 'acceptance/'];
const CONTRACT = 'acceptance/contract.txt';
const FILES = Object.freeze({
  // M3 slice 15 (objection 022; SEAM.md §187): no required key without a definition.
  [GOVERNED_FILE]: `${JSON.stringify({ protected_paths: ROOTS })}\n`,
  [CHECK_FILE]: '{"expect": 200}\n',
  [CONTRACT]: 'the accepted contract\n',
});
// What a read-only tree answers a writer with.
const REFUSALS = ['EROFS', 'EACCES', 'EPERM', 'EXDEV', 'EBUSY'];
const FILE_OPS = ['write', 'truncate', 'rename_away', 'rename_over', 'hard_link', 'write_through_symlink', 'chmod', 'unlink'];
const DIR_OPS = ['dir_create', 'dir_mkdir', 'dir_chmod', 'dir_rename_away'];

async function protectedProject(t) {
  const fx = await sandboxEngine(t);
  const project = await addGitProject(fx, { tier: 'T1', files: FILES });
  const version = effectiveVersion(fx.home, project.id);
  assert.equal(version.fingerprint, protectedFingerprint(project.repo.path, project.base, ROOTS), 'the targets are seeded: the effective protected version covers both roots');
  return { fx, project, version };
}

// The role's two rounds of P19: a protected file of one root with the other
// root as the protected directory, and the reverse.
const p19 = (act) => [act.protectedOps(CHECK_FILE, 'acceptance', { label: 'checks-file' }), act.protectedOps(CONTRACT, '.surety/checks', { label: 'acceptance-file' })];

function assertEveryOpRefused(probe, role) {
  for (const label of ['checks-file', 'acceptance-file']) {
    const p = probe('protected_ops', label);
    assert.equal(p.outcome, 'ran', `${role}: the role attempted every operation (${JSON.stringify(p)})`);
    const done = Object.fromEntries(p.ops.map((o) => [o.op, o]));
    for (const op of [...FILE_OPS, ...DIR_OPS]) {
      assert.ok(done[op], `${role}, ${label}: ${op} was attempted (ops: ${p.ops.map((o) => o.op).join(', ')})`);
      assert.deepEqual([done[op].outcome, REFUSALS.includes(done[op].error)], ['refused', true], `${role}, ${label}: ${op} is refused by a read-only tree (${JSON.stringify(done[op])})`);
    }
    assert.equal(p.ops.some((o) => o.op === 'write_through_hard_link'), false, `${role}, ${label}: no hard link was made to write through`);
    assert.equal(p.after, p.before, `${role}, ${label}: the role still reads the protected file as it was`);
  }
}

// Host-side, after the run: nothing under a root changed in the checkout.
function assertCheckoutProtectedUnchanged(fx, run, role) {
  const checkout = getRow(fx.home, 'workspaces', run.workspace).path;
  assert.equal(gitQuiet(checkout, ['status', '--porcelain', '--untracked-files=all', '--', ...ROOTS]), '', `${role}: host-read, the materialized workspace holds no change under a protected root`);
  for (const [path, content] of Object.entries(FILES)) assert.equal(readFileSync(join(checkout, path), 'utf8'), content, `${role}: host-read, ${path} is as the base has it`);
  for (const stray of ['acceptance/new-by-role.txt', '.surety/checks/new-by-role.txt', 'acceptance/new-by-role', '.surety/checks/new-by-role']) assert.equal(existsSync(join(checkout, stray)), false, `${role}: host-read, nothing was created under a root (${stray})`);
}

describe('M123 the protected set is read-only to every role but the Verifier', () => {
  test('(a) a Builder: every operation on a protected file and a protected directory of each root is refused; after termination the checkout holds no change under a root; control: its source edit is committed', async (t) => {
    const { fx, project, version } = await protectedProject(t);
    const item = await addItem(fx, project.id, 'fix');
    const { run, probe } = await probedRun(fx, project.id, item, { acts: p19, after: [permittedEdit()] });
    assertEveryOpRefused(probe, 'builder');
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: project.base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assertCheckoutProtectedUnchanged(fx, run, 'builder');
    assert.equal(effectiveVersion(fx.home, project.id).id, version.id, 'the effective version is unchanged');
    assert.deepEqual(proposalsOf(fx.home, project.id), [], 'and no proposal was captured from a Builder');
  });

  test('(a) a Reviewer: every operation is refused; the checkout holds no change under a root; control: it writes and reads a file of its own workspace', async (t) => {
    const { fx, project } = await protectedProject(t);
    const item = await addWork(fx.engine, project.id, 'review');
    const { run, probe, ended } = await probedRun(fx, project.id, item, {
      acts: p19,
      after: [step.write('reviewer-scratch.txt', 'written by the reviewer\n'), step.probe('read_back', { path: 'reviewer-scratch.txt' }), step.delete('reviewer-scratch.txt')],
    });
    assertEveryOpRefused(probe, 'reviewer');
    assert.equal(probe('read_back').content, 'written by the reviewer\n', 'control: the role writes its workspace');
    assert.deepEqual([ended.outcome, ended.reason_class], ['completed', 'none'], `the Reviewer's run, which left nothing, completes (${ended.reason_text})`);
    assertCheckoutProtectedUnchanged(fx, run, 'reviewer');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'and nothing was committed');
  });

  test('(a) an Architect: every operation is refused; the checkout holds no change under a root; control: its own artifact is committed', async (t) => {
    const { fx, project } = await protectedProject(t);
    const item = await addItem(fx, project.id, 'replan');
    const adr = '.surety/adrs/0001-a-decision.md';
    const { run, probe } = await probedRun(fx, project.id, item, { acts: p19, after: [step.write(adr, '# a decision\n')] });
    assertEveryOpRefused(probe, 'architect');
    assertCommitted(fx, run.id, { kind: 'intent', parent: project.base, integrated: true, changes: { [adr]: 'A' } });
    assertCheckoutProtectedUnchanged(fx, run, 'architect');
  });

  test("(b) the Verifier's protected write is not refused in the sandbox and becomes a proposal only: no ordinary commit, the effective version unchanged", async (t) => {
    const { fx, project, version } = await protectedProject(t);
    const content = '{"expect": 200, "body": "ok"}\n';
    const proposal = await capturedProposal(fx, project, { changeKind: null, steps: [step.write(CHECK_FILE, content), step.probe('read_back', { path: CHECK_FILE })] });
    assert.deepEqual([proposal.status, proposal.proposed_by, proposal.base_revision], ['captured', 'verifier_run', project.base], 'a captured proposal on the run\'s base (row M36\'s shape)');
    const [launch] = fx.scripted.launches({ run: proposal.run });
    assert.equal(fx.scripted.probes(launch.invocation, 'read_back')[0].content, content, 'the Verifier wrote the protected file in its workspace and read it back');
    assert.equal(gitQuiet(project.repo.path, ['cat-file', '-p', `${proposal.tree_id}:${CHECK_FILE}`]), content.trim(), 'the proposal\'s tree holds what the Verifier wrote');
    assert.equal(refOid(project.repo.path, project.repo.ref), project.base, 'no ordinary commit: the integration branch is where it was');
    assert.equal(effectiveVersion(fx.home, project.id).id, version.id, 'the effective protected version is unchanged');
  });

  test("(c) after a protected application the next run's protected tree is the new effective version's, and still read-only", async (t) => {
    const { fx, project, version } = await protectedProject(t);
    const content = '{"expect": 200, "body": "ok"}\n';
    const proposal = await capturedProposal(fx, project, { changeKind: null, content });
    const applied = await humanApplies(fx, project, proposal, 'tightening');
    assert.notEqual(applied.id, version.id, 'the fixture is live: a new protected version is effective');
    const base = refOid(project.repo.path, project.repo.ref);

    const item = await addItem(fx, project.id, 'fix');
    const { run, probe } = await probedRun(fx, project.id, item, {
      before: [step.probe('open_paths', { paths: [CHECK_FILE, CONTRACT] })],
      acts: p19,
      after: [permittedEdit()],
    });
    const opened = byPath(probe('open_paths'));
    assert.deepEqual([opened[CHECK_FILE].outcome, opened[CHECK_FILE].sha256], ['opened', sha256Hex(content)], 'the role reads the applied version\'s check file');
    assert.equal(opened[CONTRACT].sha256, sha256Hex(FILES[CONTRACT]), 'and the root the application left alone as it was');
    assertEveryOpRefused(probe, 'builder, after the application');
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: base, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
    assert.equal(effectiveVersion(fx.home, project.id).id, applied.id);
  });
});
