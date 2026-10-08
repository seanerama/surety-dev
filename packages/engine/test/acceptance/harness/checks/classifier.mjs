// Helpers for the M3 rows of slice 19, the classifier (M224 to M228; SEAM.md
// §§215 to 220): projects whose protected set holds a governed file,
// definitions with declared or default inputs and the requirement index;
// proposals made by a Verifier's run or by the policy route and classified by
// the engine itself (never the classification fixture of SEAM §67); the
// classification as D3 A.3 records it; the classifier's version and the
// engine setting `classifier_authority`; the instruments that change a bound
// input between a correction's preview and its effect.
//
// Kernel lane: the classifier reads trees, the governed file and the
// requirement index, and runs nothing (D3 §3.1). No check runs here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODES, answer, approvalsOf, assertPreview, decision, decisionsOn, intentsOf, untilKilled } from '../decisions.mjs';
import { writeEngineConfig } from '../engine.mjs';
import { GOVERNED_FILE, assertNotApplied, capturedProposal, effectiveVersion, governedEdit, protectedVersions, proposalsOf } from '../gates.mjs';
import { permittedEdit, roleThat, runToEnd, waitForCandidates } from '../gitruns.mjs';
import { armBarrier } from '../journal.mjs';
import { gitQuiet, refOid } from '../repos.mjs';
import { addWork, tickUntil, workItem } from '../runs.mjs';
import { script, step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { KERNEL_COMMANDS, checkProject, defPath, definitionText, governedText, installIndexedPlan, versionRead } from './fixtures.mjs';

export { GOVERNED_FILE, KERNEL_COMMANDS, defPath };

// ---- D3 A.2's enumerations ----------------------------------------------------------------

export const REASONS = Object.freeze({
  strict: ['check_added', 'criteria_added', 'gate_kinds_added', 'tier_floor_lowered', 'required_key_added_with_check'],
  loosening: ['check_removed', 'required_key_removed', 'criteria_removed', 'areas_removed', 'gate_kinds_removed', 'tier_floor_raised', 'root_removed'],
  unclassifiable: ['root_layout_changed', 'governed_field_changed', 'execution_field_changed', 'input_changed', 'required_key_added_alone', 'discovery_error', 'unhandled_change', 'no_strict_change'],
  neutral: ['neutral_file_changed'],
});
const GROUP = Object.fromEntries(Object.entries(REASONS).flatMap(([group, reasons]) => reasons.map((reason) => [reason, group])));
export const AFFECTED_REASONS = Object.freeze(['added', 'removed', 'definition_changed', 'input_changed', 'required_changed', 'applicability_changed']);

// ---- the protected set's files ------------------------------------------------------------

// A check's own declared input file (one per check, so that a change to one
// check's input is in no other check's manifest).
export const RUN = (key) => `.surety/checks/run/${key}.txt`;
export const README = '.surety/checks/README.md';

// The files of a protected set: the governed file, one definition per key of
// `defs` ({key: fields}), and `files`.
export function protectedFiles({ governed, defs, files = {} }) {
  const out = { [GOVERNED_FILE]: governedText(governed), ...files };
  for (const [key, fields] of Object.entries(defs)) out[defPath(key)] = definitionText(key, fields);
  return out;
}

// Verifier steps that write a definition, the governed file, a file.
export const writeDef = (key, fields) => step.write(defPath(key), definitionText(key, fields));
export const writeGov = (fields) => step.write(GOVERNED_FILE, governedText(fields));

// ---- a project with an index, its first stage nominated ---------------------------------------

// A T1 project whose integration branch holds `files` (protectedFiles' form)
// and whose approved spec registers `index` through the plan fixture (SEAM
// §179). The plan's one stage implements every requirement; its Builder
// makes the permitted edit and asks for the nomination, so the project has
// a candidate and its one-run slot is free again before any proposal. The
// effective version has no discovery error (the fixture is live), or, with
// `withErrors`, has at least one (M228 (c): an error of P0's own). Returns
// {id, repo, base, plan, stage, candidate, version: <the version read>}.
export async function classifierProject(fx, { files, index, tier = 'T1', withErrors = false }) {
  const p = await checkProject(fx, { files, tier });
  const plan = await installIndexedPlan(fx.engine, p.id, { index, stages: [{ number: 1, goal: 'the first stage', implements: index.map((row) => row.key) }] });
  const item = plan.stages[0].work_item;
  fx.scripted.script(item, [roleThat([permittedEdit()], { nominate: true })]);
  await runToEnd(fx, p.id, item);
  const [candidate] = await waitForCandidates(fx, p.id);
  const version = await versionRead(fx.engine, p.id, effectiveVersion(fx.home, p.id).id);
  if (withErrors) assert.ok(version.discovery_errors.length > 0, 'the fixture is live: the effective version has a discovery error');
  else assert.deepEqual(version.discovery_errors, [], `the fixture is live: the effective version has no discovery error (${JSON.stringify(version.discovery_errors)})`);
  assert.equal(version.change_kind, 'initial', 'project creation classifies its first version initial (D3-C01)');
  return { ...p, plan, stage: plan.stages[0].id, candidate, version, base: refOid(p.repo.path, p.repo.ref) };
}

// A new approved spec revision through the plan fixture (SEAM §219): `index`
// is the whole index as it now stands. The plan fixture requires a stage;
// its Builder exits without a result on every launch, so nothing of it is
// integrated and the integration branch does not move.
export async function reviseSpec(fx, projectId, index) {
  const plan = await installIndexedPlan(fx.engine, projectId, { index, stages: [{ number: 1, goal: 'a stage of the revised spec', implements: [] }] });
  fx.scripted.script(plan.stages[0].work_item, [script.crash(), script.crash(), script.crash(), script.crash(), script.crash()]);
  return plan;
}

// The revision's stage has used its repairs and is parked, so no run of it
// is under way when a case kills the engine or waits on the run slot.
export const stageSettled = (fx, projectId, plan) =>
  tickUntil(fx.engine, projectId, () => workItem(fx.home, plan.stages[0].work_item)?.status === 'parked', { max: 16, what: "the spec revision's stage to be parked" });

// ---- proposals --------------------------------------------------------------------------

// A Verifier's check_correction run whose `steps` change the protected set
// only: captured as a proposal, never given to the classification fixture.
export const verifierProposal = (fx, project, steps) => capturedProposal(fx, project, { changeKind: null, steps });

// A human's governed edit through the policy route (SEAM §66).
export const policyProposal = (fx, project, change) => governedEdit(fx, project, change);

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export function proposalRow(home, projectId, id) {
  const row = proposalsOf(home, projectId).find((found) => found.id === id);
  assert.ok(row, `proposal ${id} exists`);
  return { ...row, classification: json(row.classification), recommendations: json(row.recommendations) };
}

// The engine's own classification of a proposal (D3 §1.6: at a tick after
// its capture). Returns {row, c}: the proposal row and its classification.
export async function engineClassification(fx, projectId, proposal, { max = 4 } = {}) {
  return tickUntil(
    fx.engine,
    projectId,
    () => {
      const row = proposalRow(fx.home, projectId, proposal.id);
      const c = row.classification;
      return c && typeof c.change_kind === 'string' ? { row, c } : undefined;
    },
    { max, what: `the engine's own classification of proposal ${proposal.id} (D3 §§1.6, 3; SEAM.md §216)` },
  );
}

// The classifier version the engine runs (SEAM §217).
export async function runningClassifier(engine) {
  const info = await engine.engineInfo();
  assert.ok(Number.isInteger(info.classifier_version) && info.classifier_version > 0, `GET /v1/engine names the running classifier_version, a positive integer (SEAM.md §217) (classifier_version: ${JSON.stringify(info.classifier_version)})`);
  return info.classifier_version;
}

// ---- reading a classification ---------------------------------------------------------------

const counted = (elements) => elements.filter((e) => e.reason !== 'neutral_file_changed' && e.reason !== 'no_strict_change');
const show = (elements) => JSON.stringify(elements.map((e) => (e.check ? `${e.reason}:${e.check}` : e.path ? `${e.reason}@${e.path}` : e.reason)));

// "reason" matches any element with that reason; "reason:check" also its check key.
const matches = (spec, e) => {
  const [reason, check] = spec.split(':');
  return e.reason === reason && (check === undefined || e.check === check);
};

// Match every spec to a distinct element; returns the elements left over, or
// null if a spec has no element.
function takeAll(specs, elements) {
  const left = [...elements];
  for (const spec of specs) {
    const i = left.findIndex((e) => matches(spec, e));
    if (i < 0) return null;
    left.splice(i, 1);
  }
  return left;
}

// D3 §3.1's rule over a list of elements.
export function kindOf(elements) {
  if (elements.some((e) => GROUP[e.reason] === 'unclassifiable')) return 'unclassifiable';
  const strict = elements.some((e) => GROUP[e.reason] === 'strict');
  const loose = elements.some((e) => GROUP[e.reason] === 'loosening');
  if (!strict && !loose) return 'unclassifiable';
  return loose ? 'loosening' : 'tightening';
}

// One classification against what D3 §3.1 says of its proposal (SEAM §216).
// expected: {kind, exact?: [spec], contains?: [spec], allow?: [reason], neutral?: [path]}.
//  - exact: the elements other than neutral_file_changed and no_strict_change
//    are exactly these;
//  - contains: they include these, and every other one is of the
//    unclassifiable group or named in `allow` (a delta never hides behind,
//    or adds, a strict or loosening element of its own);
//  - neutral: a neutral-only proposal: no counted element, a
//    neutral_file_changed element naming each path, and no_strict_change.
// Always: every reason is D3 A.2's; the class is never `initial`, is the
// class D3's rule gives for the recorded elements, is the stored class, and
// routes the proposal; the classifier_version is the running one.
export function assertClassification({ row, c }, expected, { label, running }) {
  assert.notEqual(c.change_kind, 'initial', `${label}: nothing but project creation is initial (D3-C01)`);
  assert.ok(Array.isArray(c.elements), `${label}: the classification lists its elements (${JSON.stringify(c)})`);
  for (const e of c.elements) assert.ok(GROUP[e.reason], `${label}: every element's reason is a ClassificationReason (${JSON.stringify(e)})`);
  assert.equal(c.change_kind, kindOf(c.elements), `${label}: the class is the one D3 §3.1's rule gives for the elements recorded (${show(c.elements)})`);
  assert.equal(c.change_kind, expected.kind, `${label}: classified ${expected.kind} (elements: ${show(c.elements)})`);
  assert.equal(row.classified_change_kind, c.change_kind, `${label}: the stored class is the classification's`);
  assert.equal(row.status, c.change_kind === 'tightening' ? 'classified' : 'awaiting_human', `${label}: routed by its class (SEAM.md §69)`);
  assert.equal(c.classifier_version, running, `${label}: the classification records the running classifier_version`);
  const got = counted(c.elements);
  if (expected.neutral !== undefined) {
    assert.deepEqual(got, [], `${label}: a neutral-only proposal has no element but neutral ones (${show(c.elements)})`);
    for (const path of expected.neutral) assert.ok(c.elements.some((e) => e.reason === 'neutral_file_changed' && e.path === path), `${label}: neutral_file_changed names ${path} (${show(c.elements)})`);
    assert.ok(c.elements.some((e) => e.reason === 'no_strict_change'), `${label}: and the class's reason, no_strict_change, is recorded (${show(c.elements)})`);
  }
  if (expected.exact !== undefined) {
    const left = takeAll(expected.exact, got);
    assert.ok(left !== null && left.length === 0, `${label}: the elements are exactly ${JSON.stringify(expected.exact)} (got ${show(got)})`);
  }
  if (expected.contains !== undefined) {
    const left = takeAll(expected.contains, got);
    assert.ok(left !== null, `${label}: no difference vanishes: the elements include ${JSON.stringify(expected.contains)} (got ${show(got)})`);
    const allow = expected.allow ?? [];
    const extra = left.filter((e) => GROUP[e.reason] !== 'unclassifiable' && !allow.includes(e.reason));
    assert.deepEqual(extra, [], `${label}: no other strict or loosening element is made of the change (got ${show(got)})`);
  }
}

// The classification's affected checks as {key: reasons}, each entry checked
// against D3 A.2 (SEAM §216).
export function affectedOf(c, label) {
  assert.ok(Array.isArray(c.affected_checks), `${label}: the classification lists its affected checks (${JSON.stringify(c)})`);
  const out = {};
  for (const entry of c.affected_checks) {
    assert.equal(typeof entry.check, 'string', `${label}: an affected entry names a check key (${JSON.stringify(entry)})`);
    assert.ok(Array.isArray(entry.reasons) && entry.reasons.length > 0, `${label}: every affected entry states its reasons (N01) (${JSON.stringify(entry)})`);
    for (const reason of entry.reasons) assert.ok(AFFECTED_REASONS.includes(reason), `${label}: ${reason} is an AffectedReason`);
    assert.ok(!(entry.check in out), `${label}: ${entry.check} is listed once`);
    out[entry.check] = [...entry.reasons].sort();
  }
  return out;
}

// ---- a regular file's mode, changed by the Verifier ---------------------------------------------

// A commit object, on `parent`, whose tree is the parent's with `entries`
// ({path: {content, mode}}) replaced. No ref is made or moved. The
// Verifier's `git restore --source=<commit> -- <path>` then writes the file with its
// mode into the workspace, which a scripted role cannot chmod in the kernel
// lane (SEAM §216). `git restore` (worktree only) leaves the workspace's
// index as it was: `git checkout` would change it, which is a ref_violation
// (SEAM §28).
export function objectCommit(repo, parent, entries) {
  const index = join(repo, '.git', `fixture-index-${process.hrtime.bigint()}`);
  const env = { GIT_INDEX_FILE: index };
  gitQuiet(repo, ['read-tree', parent], { env });
  for (const [path, { content, mode = '100644' }] of Object.entries(entries)) {
    const oid = gitQuiet(repo, ['hash-object', '-w', '--stdin'], { input: content });
    gitQuiet(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`], { env });
  }
  const tree = gitQuiet(repo, ['write-tree'], { env });
  return gitQuiet(repo, ['commit-tree', tree, '-p', parent, '-m', 'fixture: a mode for the Verifier to check out']);
}

// Verifier steps that make `path` executable, its content unchanged.
export function chmodSteps(project, path, content) {
  const commit = objectCommit(project.repo.path, refOid(project.repo.path, project.repo.ref), { [path]: { content, mode: '100755' } });
  return [step.git('restore', `--source=${commit}`, '--', path)];
}

// ---- the engine's configuration, between starts --------------------------------------------------

// Merge `changes` into $SURETY_HOME/config.json; a key given as undefined is
// removed. For an engine that is stopped: it reads the file at its start.
export function setEngineConfig(fx, changes) {
  const current = JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8'));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete current[key];
    else current[key] = value;
  }
  writeEngineConfig(fx.home, current);
}

export const CLASSIFIER_FLAG = '--harness-classifier-version';
export const BEFORE_REVALIDATION = 'protected_application.before_revalidation';

// ---- an approval, its effect, and its withdrawal -----------------------------------------------

// The human's `approve`, consumed, and the engine killed at `intent.recorded`
// (SEAM §76): the effect is pending when the engine stops.
export async function approveAndKill(fx, projectId, previewed) {
  await armBarrier(fx.engine, 'intent.recorded', 'kill');
  answer(fx.engine, projectId, previewed, 'approve').catch(() => null);
  await untilKilled(fx, projectId);
  assert.equal(decision(fx.home, previewed.id).status, 'consumed', 'the answer was consumed before the kill');
  assert.equal(intentsOf(fx.home, previewed.id)[0]?.status, 'pending', 'its effect is pending');
}

// After a restart, the pending effect is revalidated and invalidated.
export async function assertReplayRefused(fx, projectId, previewed, what) {
  const intent = await tickUntil(fx.engine, projectId, () => intentsOf(fx.home, previewed.id).find((row) => !['pending', 'executing'].includes(row.status)), { what: `the pending effect to be revalidated (${what})` });
  assert.deepEqual([intent.status, intent.invalidated_reason], ['invalidated', CODES.intent_invalidated], `${what}: the replayed effect is invalidated EFFECT_PRECONDITION_CHANGED, not made`);
  assert.equal(intentsOf(fx.home, previewed.id).length, 1, `${what}: and no second intent was recorded`);
}

// The approval is withdrawn and nothing was applied: the proposal awaits an
// approval again, names no approver, and no version of it is authorized or
// effective (D3 §3.3; SEAM §§76, 104).
export function assertWithdrawn(fx, ctx, what) {
  const row = assertNotApplied(fx, ctx, ctx.headBefore);
  assert.ok(['classified', 'awaiting_human'].includes(row.status), `${what}: the proposal awaits an approval again (it is ${row.status})`);
  assert.deepEqual([row.approver, row.approver_authority], [null, null], `${what}: the approval is withdrawn`);
  const versions = protectedVersions(fx.home, ctx.project.id).filter((version) => version.proposal === ctx.proposal.id);
  assert.ok(versions.every((version) => version.authorized === 0 && version.effective_from === null), `${what}: no version of the proposal is authorized or effective`);
  return row;
}

// After an approval's effect was invalidated, the next generation of the
// decision about the proposal is open (SEAM §76: the consumed decision keeps
// its approval and stays consumed; a Reviewer's approval has no decision).
// Its preview is another, its manifest differs in each key of `changed`, and
// it carries no approval.
export async function nextAfterWithdrawal(fx, projectId, kind, proposal, previous, { changed = [], max = 6 } = {}) {
  const next = await tickUntil(
    fx.engine,
    projectId,
    () => decisionsOn(fx.home, kind, proposal.id).find((row) => row.status === 'open' && row.id !== previous?.id),
    { max, what: `the next generation of ${kind} about ${proposal.id}` },
  );
  assertPreview(next);
  if (previous) {
    assert.equal(next.semantic_generation, previous.semantic_generation + 1, 'the next generation follows the one whose effect was withdrawn');
    assert.notEqual(next.preview_hash, previous.preview_hash, 'a changed dependency is a changed preview');
    for (const key of [changed].flat()) assert.notDeepEqual(next.manifest[key], previous.manifest[key], `the manifests differ in "${key}", the dependency that changed`);
  }
  assert.equal(approvalsOf(fx.home, next.id).length, 0, 'the next generation starts with no approval');
  return next;
}

// A Reviewer's run on review work about the proposal, approving it. Not
// waited for: the caller waits (for a barrier, a kill, the run's end).
export async function reviewerApproval(fx, projectId, proposal) {
  const item = await addWork(fx.engine, projectId, 'review', { subject: { proposal: proposal.id } });
  fx.scripted.script(item, [roleThat([], { proposal_approval: { proposal: proposal.id, reason: 'The approved spec requires the new check.' } })]);
  return item;
}

// Remove a validation-scope approval from the store (the engine stopped):
// the instrument for "the scope approval changed" (SEAM §218).
export function removeScopeApprovals(home, proposalId) {
  withStore(home, (db) => db.prepare('DELETE FROM "scope_approvals" WHERE "proposal" = ?').run(proposalId), { readonly: false });
}
