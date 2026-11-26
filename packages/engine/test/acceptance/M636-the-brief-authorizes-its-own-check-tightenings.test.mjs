// M636, the brief authorizes its own check tightenings within its criteria
// (slice 50; kernel lane). The owner's M7 plan §3j, row M636; Sean's ruling
// D2 of 2026-11-26 (DECISIONS item 57): "The brief can authorize tighter
// checks tied to its criteria using the approved commands and execution
// permissions. A proposal that changes what can execute, weakens existing
// coverage, or cannot be classified comes to me. Keep the check diff
// available and retain candidate verification."; D3 §3.3; E13.
//
// The classifier runs as configured: the harness engine sets no
// `classifier_authority`, so it is the default `recommend` (checks/
// classify.ts DEFAULT_AUTHORITY), the project T1, and no Reviewer
// intervenes (under `recommend` no review work is made for a proposal;
// each case asserts none was). The fixture: a T1 rapid prototype at its
// Alpha (iteration 1: R1 to R3 and their checks); iteration 2's brief
// approved (spec version 2 adds R4, phase 2 of one stage); phase 2's own
// check authoring writes the case's tree.
//
// (a) phase 2's authoring adds accept-r4 covering R4.1, a criterion of the
//     approved spec revision, same check_commands, only adding: applied
//     once, `approver_authority` `policy`, `approved_by`
//     `policy:rapid_prototype`; no `check_correction_tightening` decision;
//     `protected.approved` names the authority and the brief decision; the
//     proposal's diff stays readable; the next candidate is nominated at the
//     new version and its verification retained;
// (b) the same for a tightening of an existing check (accept-r1 also covers
//     R4.1: an added assertion as the classifier sees it, criteria_added);
// (c) a check added for a criterion outside the brief's spec revision
//     (R9.1); (d) check_commands changed (what can execute); (e) a loosening
//     (accept-r3 removed) and an unclassifiable proposal (accept-r1's
//     timeout changed): each the owner's question as today, its evidence
//     naming why the policy did not cover it;
// (f) a proposal from another iteration's plan (M641 (d)'s narrowed gap
//     authoring of iteration 1's plan, a classifier tightening within
//     spec v2's criteria) and one made while no brief is approved (iteration
//     2 preparing, the owner's `correct_check` on a finding of iteration 1):
//     each the owner's tightening question, its evidence naming why;
// (g) a restart between the capture and the classification: one
//     application, one version.
//
// Readings this file makes (the report says them):
// - "applied once" is read as the proposal `applied` with exactly one
//   protected version from it, effective, and one `protected.approved`.
// - "names the brief decision" is read as iteration 2's `brief_decision`
//   id anywhere in that event's payload.
// - "the diff stays readable" is read as the proposal's `diff_hash` or
//   `tree_id` served by GET …/protected-versions/:v for the new version or
//   by a delegated-action entry of the iteration read.
// - "the next candidate is verified against the new version" is read as the
//   first candidate nominated after the application having
//   `nominated_protected_version` the new version and a `verification` work
//   item about it.
// - "its evidence naming why" is read as a sentence of the served decision
//   (GET …/decisions/:d) naming the policy (/polic/i) and why
//   (harness/item57v2.mjs whyNotPolicy).
// - (c) R9.1 is in no requirement index (the registered one is spec
//   version 2, the brief's own); a check covering it is unclassifiable by
//   the classifier's own rule (discovery_error), so (c) asks the
//   unclassifiable question; (d) changes check_commands only (runner_config
//   is not exercised).
// - (g): the restart is taken at the first observation of the proposal
//   `captured` with no class; if the class is already recorded when first
//   observed, the restart is taken then and the report says so.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program and
// the scripted deployment adapter in the test's own home; nothing signalled
// but the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gapItems, gapScript, phase2Plan, restart, runsOn, untilPublished } from './harness/gap57.mjs';
import { waitFor } from './harness/engine.mjs';
import { pauseProject, resumeProject, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import {
  CHECK_FILE_R4,
  CHECK_KINDS,
  answer,
  answerOpen,
  authoringScript,
  briefToAlpha,
  candidatesOfProject,
  decisionRead,
  idle,
  iterationRead,
  iterationRow,
  kindNext,
  observedCurrent,
  ok,
  protoEngine,
  pump,
  recordChecks,
  result,
  scriptDeploy,
  secondIterationScripts,
  statusIs,
  toBrief,
  usage,
  workOfProject,
  write,
} from './harness/prototype.mjs';
import { NARROW_FILES, decisionsAbout, eventsAbout, narrowGapRefused, narrowInputs, objectsWhere, proposalRow, proposalsOfRun, rows, show, versionsOfProposal, whyNotPolicy, workOfKind } from './harness/item57v2.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const FILES = NARROW_FILES;
const parse = (path) => JSON.parse(FILES[path]);
const R1 = '.surety/checks/defs/accept-r1.json';
const R3 = '.surety/checks/defs/accept-r3.json';
const POLICY = '.surety/checks/protected-policy.json';
const CORRECTION_KINDS = CHECK_KINDS;

const R4 = narrowInputs(CHECK_FILE_R4);
const TREES = {
  a: { ...FILES, ...R4 },
  b: { ...FILES, [R1]: json({ ...parse(R1), covers: { criteria: ['R1.1', 'R4.1'] } }) },
  c: { ...FILES, ...R4, '.surety/checks/defs/accept-r9.json': json({ ...parse(R1), key: 'accept-r9', covers: { criteria: ['R9.1'] } }) },
  d: { ...FILES, ...R4, [POLICY]: json({ ...parse(POLICY), check_commands: { ...parse(POLICY).check_commands, probe2: { path: '/usr/bin/env' } } }) },
  loosening: { ...Object.fromEntries(Object.entries(FILES).filter(([k]) => k !== R3)), ...R4 },
  unclassifiable: { ...FILES, ...R4, [R1]: json({ ...parse(R1), timeout_s: 120 }) },
};

// Iteration 1 at its Alpha; iteration 2's brief approved, phase 2's
// authoring to write `tree`. Returns {fx, p, it1, two, brief}.
const DELETES = { loosening: [R3] };
const authoringOf = (tree, deletes = []) => ({
  steps: [usage(900, 100, 300), ...deletes.map((path) => step.delete(path)), ...Object.entries(tree).map(([path, c]) => write(path, c)), result({ proposal: { rationale: "phase 2's checks", requested_change_kind: 'unclassifiable' } })],
});
async function iteration2(t, { name, port, tree, deletes = [] }) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  kindNext(fx, 'check_authoring', [authoringScript({ files: FILES })], authoringScript({ files: FILES }));
  const { id: p, it } = await toBrief(fx, { name });
  const env = await briefToAlpha(fx, p, it.id, { port });
  await observedCurrent(fx, p, it.id);
  const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, { change: 'Show the number of open tasks at the top.' }), 201, 'iterate');
  const two = made.iteration.id;
  secondIterationScripts(fx);
  kindNext(fx, 'check_authoring', [authoringOf(tree, deletes)], authoringScript({ files: FILES }));
  await scriptDeploy(fx, env);
  await answerOpen(fx, p, 'prototype_preparation_approval');
  await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
  await answerOpen(fx, p, 'spec_approval');
  const brief = iterationRow(fx.home, two).brief_decision;
  assert.ok(brief, "the fixture is live: iteration 2's brief approved by its decision");
  return { fx, p, it1: it.id, two, brief };
}

// Phase 2's own authoring item (iteration 2's plan) and its proposal.
const phase2Authoring = (fx, p) => {
  const plan = rows(fx.home, `SELECT "id", "check_authoring" FROM "phase_plans" WHERE "project" = ? AND "phase_number" = 2 ORDER BY rowid DESC`, p)[0];
  return plan?.check_authoring ?? null;
};
const proposalOfItem = (fx, item) => runsOn(fx.home, item).flatMap((r) => proposalsOfRun(fx.home, r.id)).at(-1) ?? null;
const reviewsOf = (fx, p, proposal) => rows(fx.home, `SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'review' AND "trigger_source" = 'protected_proposal' AND "trigger_id" = ?`, p, proposal);

// Pumped (no owner answer) until `done(P)` holds for phase 2's proposal.
async function untilProposal(fx, p, done, what, itemOf = () => phase2Authoring(fx, p)) {
  return pump(
    fx,
    p,
    () => {
      const item = itemOf();
      const P = item && proposalOfItem(fx, item);
      return P && done(proposalRow(fx.home, P.id)) ? proposalRow(fx.home, P.id) : undefined;
    },
    { max: 60, what },
  );
}

async function assertAppliedByPolicy(J, P, what) {
  const { fx, p, two, brief } = J;
  assert.equal(P.classified_change_kind, 'tightening', `${what}: the fixture is live: classified tightening (${show(JSON.parse(P.classification ?? 'null')?.elements)})`);
  const versions = versionsOfProposal(fx.home, P.id);
  assert.equal(P.status, 'applied', `${what}: applied (${P.status})`);
  assert.equal(versions.length, 1, `${what}: exactly one version from it (${show(versions.map((v) => v.id))})`);
  const V = versions[0];
  assert.ok(V.effective_from !== null && V.authorized === 1, `${what}: the version effective`);
  assert.deepEqual([P.approver_authority, P.approver], ['policy', 'policy:rapid_prototype'], `${what}: approved by the policy (${show([P.approver_authority, P.approver])})`);
  assert.deepEqual([V.approver_authority, V.approved_by], ['policy', 'policy:rapid_prototype'], `${what}: the version's approval the policy's (${show([V.approver_authority, V.approved_by])})`);
  assert.deepEqual(decisionsAbout(fx.home, P.id).filter((d) => CORRECTION_KINDS.includes(d.kind)).map((d) => [d.kind, d.status]), [], `${what}: no check_correction question about it`);
  assert.deepEqual(reviewsOf(fx, p, P.id), [], `${what}: no Reviewer (recommend: no review work)`);
  const approved = eventsAbout(fx.home, P.id).filter((e) => e.type === 'protected.approved');
  assert.equal(approved.length, 1, `${what}: one protected.approved (${show(approved.map((e) => e.payload))})`);
  assert.equal(approved[0].payload?.authority, 'policy', `${what}: protected.approved names the authority`);
  assert.ok(show(approved[0].payload).includes(brief), `${what}: and the brief decision ${brief} (${show(approved[0].payload)})`);
  const served = (await ok(fx.engine.get(`/v1/projects/${p}/protected-versions/${V.id}`), 200, 'GET …/protected-versions/:v')).version;
  const it = await iterationRead(fx, p, two);
  const delegated = objectsWhere(it, (o) => show(o).includes(P.id) && (o.kind === 'tightening_applied' || 'authorized_by' in o));
  const diffServed = [served, ...delegated].some((x) => show(x).includes(P.diff_hash) || show(x).includes(P.tree_id));
  assert.ok(diffServed, `${what}: the proposal's diff readable (diff_hash ${P.diff_hash} or tree ${P.tree_id}) from the version read or the delegation record (version: ${show(served).slice(0, 1500)}; delegated: ${show(delegated)})`);
  return V;
}

async function assertNextCandidateAt(J, V, what) {
  const { fx, p } = J;
  const before = candidatesOfProject(fx.home, p).map((c) => c.id);
  const next = await pump(
    fx,
    p,
    () => {
      const c = candidatesOfProject(fx.home, p).find((x) => !before.includes(x.id) || Date.parse(x.created_at) >= Date.parse(V.effective_from));
      return c && workOfKind(fx.home, p, 'verification').some((w) => w.subject?.candidate === c.id) ? c : undefined;
    },
    { max: 60, what: `${what}: the next candidate and its verification` },
  );
  assert.equal(next.nominated_protected_version, V.id, `${what}: the next candidate nominated at the new version (${next.nominated_protected_version})`);
}

async function assertAsked(J, P, kind, what) {
  const { fx, p } = J;
  assert.notEqual(P.status, 'applied', `${what}: not applied by the policy (${P.status}, ${P.approver_authority})`);
  assert.notEqual(P.approver_authority, 'policy', `${what}: no policy approval`);
  const open = decisionsAbout(fx.home, P.id, kind).filter((d) => d.status === 'open');
  assert.equal(open.length, 1, `${what}: the owner's ${kind} question (${show(decisionsAbout(fx.home, P.id).map((d) => [d.kind, d.status]))})`);
  assert.deepEqual(reviewsOf(fx, p, P.id), [], `${what}: no Reviewer (recommend)`);
  const d = await decisionRead(fx, p, open[0].id);
  assert.ok(whyNotPolicy(d).length > 0, `${what}: its evidence names why the policy did not cover it (served: ${show(d).slice(0, 2500)})`);
}

// Ticked one round at a time until phase 2's proposal is first seen; returns it if still captured with no class, else null.
async function capturedProposal(J) {
  const { fx, p } = J;
  for (let i = 0; i < 60; i++) {
    await idle(fx, p);
    const item = phase2Authoring(fx, p);
    const P = item && proposalOfItem(fx, item);
    if (P) {
      const row = proposalRow(fx.home, P.id);
      return row.status === 'captured' && row.classified_change_kind === null ? row : null;
    }
    await recordChecks(fx, p);
    await tick(fx.engine, p, { rounds: 1 });
  }
  return null;
}

const classified = (P) => P.status !== 'captured' && P.classified_change_kind !== null;
const appliedOrAsked = (fx) => (P) => P.status === 'applied' || decisionsAbout(fx.home, P.id).some((d) => CORRECTION_KINDS.includes(d.kind) && d.status === 'open');

describe('M636 the brief authorizes its own check tightenings within its criteria', () => {
  for (const [c, label] of [
    ['a', "(a) phase 2's authoring adds accept-r4 for R4.1"],
    ['b', '(b) an existing check tightened for a criterion of the brief (accept-r1 also covers R4.1)'],
  ]) {
    test(`${label}: applied once by the policy, no question, the brief decision named, the diff readable, the next candidate verified at the new version`, { timeout: 600_000 }, async (t) => {
      const J = await iteration2(t, { name: `M636 ${c}`, port: 18660 + c.charCodeAt(0) - 97, tree: TREES[c] });
      const P = await untilProposal(J.fx, J.p, appliedOrAsked(J.fx), `phase 2's proposal applied or asked (${c})`);
      const V = await assertAppliedByPolicy(J, P, `(${c})`);
      await assertNextCandidateAt(J, V, `(${c})`);
    });
  }

  for (const [c, kind, label] of [
    ['c', 'check_correction_unclassifiable', '(c) a check for a criterion outside the brief\'s spec revision'],
    ['d', 'check_correction_unclassifiable', '(d) check_commands changed (what can execute)'],
    ['loosening', 'check_correction_loosening', '(e) a loosening'],
    ['unclassifiable', 'check_correction_unclassifiable', '(e) an unclassifiable proposal'],
  ]) {
    test(`${label}: the owner's question as today, its evidence naming why the policy did not cover it`, { timeout: 600_000 }, async (t) => {
      const J = await iteration2(t, { name: `M636 ${c}`, port: 18670 + Object.keys(TREES).indexOf(c), tree: TREES[c], deletes: DELETES[c] ?? [] });
      const P = await untilProposal(J.fx, J.p, (x) => classified(x) && decisionsAbout(J.fx.home, x.id).some((d) => CORRECTION_KINDS.includes(d.kind)), `phase 2's proposal classified and asked (${c})`);
      assert.equal(`check_correction_${P.classified_change_kind}`, kind, `the fixture is live: classified ${kind.replace('check_correction_', '')}`);
      await assertAsked(J, P, kind, label);
    });
  }

  test("(f) a proposal from another iteration's plan (iteration 1's narrowed gap authoring): the owner's tightening question, its evidence naming why", { timeout: 600_000 }, async (t) => {
    const J = await narrowGapRefused(t, { name: 'M636 f1', port: 18680, partial: true });
    const { fx, p, R, G } = J;
    await resumeProject(fx.engine, p);
    await tick(fx.engine, p, { rounds: 1 });
    await waitFor(() => (runsOn(fx.home, R).find((r) => r.state !== 'ended') ? true : undefined), { what: "iteration 2's replan run live", timeoutMs: 60_000 });
    await pauseProject(fx.engine, p);
    fx.scripted.release('all', 'rp');
    await waitFor(() => (runsOn(fx.home, R).some((r) => r.state === 'ended') && !runsOn(fx.home, R).some((r) => r.state !== 'ended') ? true : undefined), { what: "the replan's run ended", timeoutMs: 120_000 });
    assert.ok(phase2Plan(fx.home, p) ?? (await untilPublished(fx, p)), "the fixture is live: phase 2's plan published");
    await tick(fx.engine, p, { rounds: 2 });
    const N = gapItems(fx.home, p).find((w) => w.id !== G);
    assert.ok(N, 'the fixture is live: the narrowed gap authoring of iteration 1\'s plan');
    fx.scripted.script(N.id, [gapScript(['R2.2']), gapScript(['R2.2'])]);
    await resumeProject(fx.engine, p);
    const P = await untilProposal(fx, p, (x) => classified(x) && decisionsAbout(fx.home, x.id).some((d) => CORRECTION_KINDS.includes(d.kind)), "the narrowed authoring's proposal classified and asked", () => N.id);
    assert.equal(P.classified_change_kind, 'tightening', `the fixture is live: a classifier tightening (${show(JSON.parse(P.classification ?? 'null')?.elements)})`);
    await assertAsked({ ...J }, P, 'check_correction_tightening', "(f) another iteration's plan");
  });

  test("(f) a proposal made while no brief is approved (the current iteration's approval removed between capture and classification, a labelled store write): the owner's tightening question, its evidence naming why", { timeout: 600_000 }, async (t) => {
    const J = await iteration2(t, { name: 'M636 f2', port: 18681, tree: TREES.a });
    const { fx, p, two } = J;
    const captured = await capturedProposal(J);
    assert.ok(captured, 'the fixture is live: the proposal observed captured, not yet classified');
    // FIXTURE TAMPERING (labelled): the current iteration as one whose brief is not approved (approved_at NULL), the proposal still unclassified.
    withStore(fx.home, (db) => db.prepare('UPDATE "prototype_iterations" SET "approved_at" = NULL WHERE "id" = ?').run(two), { readonly: false });
    assert.equal(iterationRow(fx.home, two).approved_at, null, 'the fixture is live: no approved brief');
    await tick(fx.engine, p, { rounds: 2 });
    const P = proposalRow(fx.home, captured.id);
    assert.equal(P.classified_change_kind, 'tightening', `the fixture is live: a classifier tightening (${show(JSON.parse(P.classification ?? 'null')?.elements)})`);
    await assertAsked(J, P, 'check_correction_tightening', '(f) no brief approved');
  });

  test('(g) a restart between the capture and the classification: one application, one version', { timeout: 600_000 }, async (t) => {
    const J = await iteration2(t, { name: 'M636 g', port: 18690, tree: TREES.a });
    const { fx, p } = J;
    const captured = await capturedProposal(J);
    const restartedAt = captured ? 'captured' : 'already classified (or not observed)';
    await restart(fx);
    assert.ok(captured, 'the fixture is live: the proposal observed captured before the restart');
    t.diagnostic(`(g) restart taken with the proposal ${restartedAt}`);
    const P = await untilProposal(fx, p, (x) => x.status === 'applied', 'the proposal applied after the restart');
    await tick(fx.engine, p, { rounds: 3 });
    await assertAppliedByPolicy(J, proposalRow(fx.home, P.id), '(g)');
    assert.equal(rows(fx.home, 'SELECT "id" FROM "protected_versions" WHERE "project" = ? AND "proposal" = ?', p, P.id).length, 1, '(g) one version');
    assert.equal(workOfProject(fx.home, p).filter((w) => w.kind === 'review').length, 0, '(g) no Reviewer');
  });
});
