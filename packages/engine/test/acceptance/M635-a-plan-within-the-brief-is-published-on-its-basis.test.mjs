// M635, a later iteration's plan within the approved brief is published on
// its recorded basis (slice 50; kernel lane). The owner's M7 plan §3j, row
// M635; Sean's ruling D1 of 2026-11-26 ("Judge the plan against the approved
// brief using the actual changes. Updating the roadmap for a later iteration
// is routine. Ask me when the plan exceeds the stage bound, introduces a
// permission, asset, or tier outside the brief, or the engine cannot
// establish that it fits. Record the basis when it proceeds
// automatically."); R1, S4; brief.ts withinPrototypeBounds, routeFirstPlan.
//
// The fixture (harness/brief57.mjs): a T1 rapid prototype, iteration 1 at
// its Alpha; iteration 2's brief approved (specification version 2 adds
// R1.2 and R3.2 to the delivered R1 and R3, which move to phase 2). The
// scripted Architect writes iteration 2's plan:
//   (a) phase 2 added to roadmap.json, modules.json changed (an interface
//       added to `app`), one ADR added, two stages implementing only R1 and
//       R3 (the brief's), no new permission, asset or tier; phase-2.json and
//       the run's result declare `conformance: uncertain` (the package's
//       generic text invites it). Published by the policy: no
//       architecture_approval or plan_approval; the bundle's
//       approvals.policy_authorized carries {policy, iteration, bounds,
//       policy_revision, basis}; `basis` names the brief decision, its spec
//       revision and digest, the computed changes (the roadmap version
//       allocated, architecture changed true, the ADR key, the module diff)
//       and the declared conformance as recorded; the event
//       prototype.plan_policy_authorized carries the same basis; iteration
//       2's owner_approvals count unchanged.
//   (b) the same plan with three stages: the pair raised together, the next
//       step naming "3 stages; a prototype's has at most 2".
//   (c) the same plan adding a platform permission (camera) absent from the
//       approved module map: the pair raised naming the permission.
//   (d) the same plan when the plan check computes uncertainty (the
//       project's phase_size narrowed to {min 1, max 1} before Iterate,
//       so the two-stage plan is outside it): the pair raised naming what
//       the engine could not establish; never treated as within.
//   (e) the base raises the pair on (a) (brief.ts:824 routes the declared
//       `uncertain`): (a)'s plan is never routed to the owner on the
//       declared value alone; the declared value is recorded in the basis.
//
// Readings this file makes (the report says them):
// - The row names `basis`'s facts, not their field names: each is looked
//   for in `basis` (harness/brief57.mjs valuesOfKey/holds): the brief
//   decision id, the approved spec revision id, a digest equal to the brief
//   record's sha256 or the spec revision's; a key naming the roadmap with
//   value 2; a key naming the architecture with value true; ADR-001; a key
//   naming modules with a non-empty value; a key naming the declared
//   conformance with value `uncertain`.
// - "The pair raised together": an open architecture_approval and an open
//   plan_approval under one batch key.
// - (d) is the phase_size alternative the row allows ("or whose phase_size
//   check computes uncertainty"); an unreadable modules.json in the bundle
//   is refused by the plan's own schema check before routing (B.3), so it
//   is not the row's "cannot establish" case.
//
// SAFETY (BS6 §4.1; E64): kernel lane; the scripted role program and the
// scripted deployment adapter in the test's own home; nothing signalled but
// the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ADR_KEY2,
  MODULES_CAMERA,
  MODULES_CHANGED,
  PHASE2_THREE,
  decisionsOfKinds,
  holds,
  iterationRowOf,
  one,
  phase2Plan,
  planRouted,
  rows,
  show,
  toIteration2,
  valuesOfKey,
} from './harness/brief57.mjs';
import { changePolicy } from './harness/journal.mjs';
import { eventsFor, iterationRead } from './harness/prototype.mjs';

const PAIR = ['architecture_approval', 'plan_approval'];
const A_PLAN = { modules: MODULES_CHANGED, adr: true, conformance: 'uncertain' };

async function routed(t, { name, port, plan, afterAlpha }) {
  const F = await toIteration2(t, { name, port, plan: phase2Plan(plan), afterAlpha });
  const { fx, p, two } = F;
  const approvalsAfterBrief = (await iterationRead(fx, p, two)).owner_approvals;
  const out = await planRouted(fx, p, two);
  return { ...F, ...out, approvalsAfterBrief };
}

// The pair, open and as one batch, for iteration 2's bundle; the next step
// names `bound`.
function assertPair(R, bound, what) {
  const { fx, p, two, read } = R;
  const raised = decisionsOfKinds(fx.home, p, PAIR).filter((d) => d.status === 'open');
  assert.deepEqual(raised.map((d) => d.kind).sort(), PAIR, `${what}: architecture_approval and plan_approval raised (${show(raised.map((d) => [d.kind, d.status]))}; routed ${R.routed}; next step ${read.outcome.next_step})`);
  assert.ok(raised[0].batch_key && raised[0].batch_key === raised[1].batch_key, `${what}: together, under one batch key`);
  assert.equal(read.iteration.status, 'awaiting_owner');
  assert.ok((read.outcome.next_step ?? '').includes(bound), `${what}: the next step names ${JSON.stringify(bound)} (${read.outcome.next_step})`);
  assert.equal(iterationRowOf(fx.home, two).phase_plan, null, `${what}: no phase plan published for iteration 2`);
  assert.deepEqual(eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', two), [], `${what}: not published by the policy`);
}

describe('M635 a later iteration\'s plan within the approved brief is published on its recorded basis', () => {
  test('(a) phase 2 added, modules.json changed, one ADR, two stages within the brief, declared uncertain: published by policy with its basis recorded; no architecture or plan approval; owner_approvals unchanged', { timeout: 600_000 }, async (t) => {
    const R = await routed(t, { name: 'M635 a', port: 18635, plan: A_PLAN });
    const { fx, p, two } = R;
    const it2 = iterationRowOf(fx.home, two);
    const asked = decisionsOfKinds(fx.home, p, PAIR);
    assert.deepEqual(asked.map((d) => [d.kind, d.status]), [], `no architecture_approval or plan_approval raised (routed ${R.routed}; next step ${R.read.outcome.next_step}; the base raises both: brief.ts:824)`);
    assert.equal(R.routed, 'published', 'published');
    assert.ok(it2.plan_bundle, 'the iteration names its bundle');
    const bundle = one(fx.home, 'SELECT * FROM "plan_bundles" WHERE "id" = ?', it2.plan_bundle);
    const approvals = JSON.parse(bundle.approvals);
    const pa = approvals.policy_authorized;
    for (const k of ['policy', 'iteration', 'bounds', 'policy_revision', 'basis']) assert.ok(pa && k in pa, `policy_authorized carries ${k} (${show(pa)})`);
    assert.deepEqual([pa.policy, pa.iteration], ['rapid_prototype', two], 'the policy and the iteration');
    const basis = pa.basis;
    assert.ok(basis && typeof basis === 'object', `basis recorded (${show(basis)})`);
    // The brief decision, its spec revision and digest.
    assert.ok(it2.brief_decision && holds(basis, it2.brief_decision), `basis names the brief decision ${it2.brief_decision} (${show(basis)})`);
    assert.ok(it2.brief_spec_revision && holds(basis, it2.brief_spec_revision), `basis names the approved spec revision ${it2.brief_spec_revision}`);
    const rec = one(fx.home, 'SELECT "sha256" FROM "records" WHERE "id" = ?', it2.brief_record);
    const spec = one(fx.home, 'SELECT * FROM "spec_revisions" WHERE "id" = ?', it2.brief_spec_revision);
    const digests = [rec?.sha256, spec?.semantic_digest, spec?.git_blob].filter((x) => typeof x === 'string' && x !== '');
    assert.ok(digests.some((d) => holds(basis, d)), `basis names the brief's (or its spec revision's) digest (${show(digests)}; ${show(basis)})`);
    // The computed changes.
    assert.ok(valuesOfKey(basis, /roadmap/i).some((v) => v === 2 || holds(v, 2)), `basis names the roadmap version allocated, 2 (${show(basis)})`);
    assert.ok(valuesOfKey(basis, /architecture/i).some((v) => v === true || (v && typeof v === 'object' && Object.values(v).includes(true))), `basis says the architecture changed, true (${show(basis)})`);
    assert.ok(holds(basis, ADR_KEY2), `basis names the ADR key ${ADR_KEY2}`);
    assert.ok(valuesOfKey(basis, /module/i).some((v) => v !== null && v !== false && (typeof v !== 'object' || Object.keys(v).length > 0)), `basis carries the module diff (${show(basis)})`);
    assert.ok(valuesOfKey(basis, /declared|conformance/i).some((v) => v === 'uncertain' || holds(v, 'uncertain')), `basis records the declared conformance, uncertain (${show(basis)})`);
    // The event carries the same basis.
    const ev = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', two);
    assert.equal(ev.length, 1, 'one prototype.plan_policy_authorized for iteration 2');
    assert.deepEqual(ev[0].payload.basis, basis, 'the event carries the same basis');
    // The owner's approvals of the iteration unchanged.
    const after = (await iterationRead(fx, p, two)).owner_approvals;
    assert.equal(after.count, R.approvalsAfterBrief.count, `owner_approvals count unchanged (${show(R.approvalsAfterBrief)} → ${show(after)})`);
    // The architecture published with the plan (the policy, never a human approval).
    assert.deepEqual(rows(fx.home, 'SELECT "version" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version"', p).map((r) => r.version), [1, 2], 'the changed architecture published as version 2');
  });

  test('(b) the same plan with three stages: the pair raised together, the next step naming "3 stages; a prototype\'s has at most 2"', { timeout: 600_000 }, async (t) => {
    const R = await routed(t, { name: 'M635 b', port: 18636, plan: { ...A_PLAN, stages: PHASE2_THREE } });
    assertPair(R, "3 stages; a prototype's has at most 2", '(b)');
  });

  test('(c) the same plan adding a platform permission absent from the approved module map: the pair raised naming the permission', { timeout: 600_000 }, async (t) => {
    const R = await routed(t, { name: 'M635 c', port: 18637, plan: { ...A_PLAN, modules: MODULES_CAMERA } });
    assertPair(R, 'camera', '(c)');
  });

  test('(d) the plan check computes uncertainty (phase_size): the pair raised naming what the engine could not establish, never treated as within', { timeout: 600_000 }, async (t) => {
    const R = await routed(t, {
      name: 'M635 d',
      port: 18638,
      plan: A_PLAN,
      afterAlpha: async (fx, p) => {
        await changePolicy(fx.engine, p, { phase_size: { min: 1, max: 1 } });
      },
    });
    assertPair(R, 'phase_size', '(d)');
  });

  test('(e) the base routed (a) to the owner on the declared `uncertain` alone: never so, and the declared value recorded in the basis', { timeout: 600_000 }, async (t) => {
    const R = await routed(t, { name: 'M635 e', port: 18639, plan: A_PLAN });
    const { fx, two } = R;
    const toOwner = eventsFor(fx.home, 'prototype.plan_routed_to_owner', 'iteration', two);
    assert.deepEqual(toOwner.map((e) => e.payload.outside), [], `not routed to the owner (the base: ${show(toOwner.map((e) => e.payload.outside))})`);
    const it2 = iterationRowOf(fx.home, two);
    const pa = JSON.parse(one(fx.home, 'SELECT "approvals" FROM "plan_bundles" WHERE "id" = ?', it2.plan_bundle)?.approvals ?? 'null')?.policy_authorized;
    assert.ok(pa?.basis && valuesOfKey(pa.basis, /declared|conformance/i).some((v) => v === 'uncertain' || holds(v, 'uncertain')), `the declared uncertain recorded in the basis, not routed on (${show(pa)})`);
  });
});
