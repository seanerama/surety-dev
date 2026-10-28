// M604, one brief approval authorizes the build; the first plan is
// policy-authorized (the owner's draft M7 plan §3, row M604; rulings R1, S4
// of 2026-10-28; F §9.1; E139 Q9; SEAM.md §575). Kernel lane.
//
//   (a) the brief approved: approved_at set, status building, the spec
//       applied, the Architect's one-shot dispatched.
//   (b) the Architect's bundle, one phase of two stages within the brief:
//       published with routing policy_authorized, approved_by
//       policy:rapid_prototype, no approval row, plan_bundle and phase_plan
//       on the iteration.
//   (c) three stages; a new platform permission: the architecture_approval
//       and plan_approval batch raised, status awaiting_owner, the next step
//       naming the bound exceeded.
//   (d) the check-correction question raised as today; status
//       awaiting_owner with "review automated-check changes"; the owner's
//       answers for one iteration are exactly preparation, brief and check.
//   (e) a planned project's first bundle: the owner batch, as M5.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { architectSession, createWithIdea, specSession, visionSession } from './harness/journey/drive.mjs';
import {
  CHECK_KINDS,
  MODULES,
  PROTO,
  THREE_STAGES,
  alphaReady,
  answer,
  answerOpen,
  decisionsOfProject,
  eventsFor,
  firstPlanScript,
  iterationRead,
  iterationRow,
  kindNext,
  openDecisionsRead,
  protoEngine,
  pump,
  runsOfIteration,
  statusIs,
  toBrief,
  workOfProject,
} from './harness/prototype.mjs';
import { withStore } from './harness/store.mjs';

const approvalsOf = (home, project) => withStore(home, (db) => db.prepare('SELECT a.* FROM "approvals" a JOIN "decisions" d ON d."id" = a."decision" WHERE d."project" = ? ORDER BY a.rowid').all(project));
const bundleRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "plan_bundles" WHERE "id" = ?').get(id));
const phasePlanRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "phase_plans" WHERE "id" = ?').get(id));

describe('M604 one brief approval authorizes the build; the first plan is policy-authorized', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) the brief approved: approved_at set, status building, the spec applied, the Architect\'s one-shot dispatched', async () => {
    const { fx } = S;
    const { id, it } = await toBrief(fx, { name: 'Tasks within' });
    S.within = { id, it: it.id };
    await answerOpen(fx, id, 'spec_approval');
    const row = iterationRow(fx.home, it.id);
    assert.ok(row.approved_at, 'approved_at is set');
    assert.equal(row.status, 'building');
    const rev = withStore(fx.home, (db) => db.prepare('SELECT * FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"').all(id));
    assert.deepEqual(rev.map((r) => [r.version, r.id]), [[1, row.brief_spec_revision]], 'the spec applied: revision 1, the iteration\'s');
    assert.equal(eventsFor(fx.home, 'prototype.brief_approved', 'iteration', it.id).length, 1);
    const plan = workOfProject(fx.home, id).filter((w) => w.kind === 'replan');
    assert.deepEqual(plan.map((w) => [w.trigger_source, w.trigger_id]), [['prototype_first_plan', it.id]], 'the Architect\'s one-shot replan registered for the iteration');
    await pump(fx, id, () => runsOfIteration(fx.home, it.id).find((r) => r.work_kind === 'replan' && r.state === 'ended'), { what: 'the first plan\'s run' });
    const [run] = runsOfIteration(fx.home, it.id).filter((r) => r.work_kind === 'replan');
    assert.deepEqual([run.role, run.kind, run.iteration], ['architect', 'one_shot', it.id], 'dispatched to the Architect, a one-shot run of the iteration');
  });

  test('(b) one phase of two stages within the brief: published policy_authorized by policy:rapid_prototype, no approval row, plan_bundle and phase_plan on the iteration', async () => {
    const { fx } = S;
    const { id, it } = S.within;
    const read = await pump(fx, id, async () => {
      const r = await iterationRead(fx, id, it);
      return r.plan?.bundle_status === 'published' ? r : undefined;
    }, { what: 'the first plan published' });
    assert.deepEqual([read.plan.routing, read.plan.approved_by], [PROTO.routing, PROTO.publisher]);
    assert.deepEqual(Object.keys(read.plan.approvals), ['policy_authorized'], 'the bundle\'s approvals: the policy only');
    const row = iterationRow(fx.home, it);
    assert.deepEqual([row.plan_bundle, row.phase_plan], [read.plan.bundle, read.plan.phase_plan], 'the iteration records the bundle and the phase plan');
    assert.equal(bundleRow(fx.home, row.plan_bundle).status, 'published');
    const pp = phasePlanRow(fx.home, row.phase_plan);
    assert.deepEqual([pp.routing, pp.approved_by, pp.phase_number], [PROTO.routing, PROTO.publisher, 1]);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "stages" WHERE "phase_plan" = ?').get(row.phase_plan).n), 2, 'two stages');
    assert.deepEqual(decisionsOfProject(fx.home, id, 'architecture_approval').concat(decisionsOfProject(fx.home, id, 'plan_approval')), [], 'no architecture or plan approval was raised');
    const approvals = approvalsOf(fx.home, id);
    assert.ok(approvals.every((a) => !['architecture_approval', 'plan_approval'].includes(withStore(fx.home, (db) => db.prepare('SELECT "kind" FROM "decisions" WHERE "id" = ?').get(a.decision).kind))), 'no approval row for the plan');
    const authorized = eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', it);
    assert.equal(authorized.length, 1);
    assert.deepEqual([authorized[0].payload.stages, authorized[0].payload.phases], [2, 1]);
  });

  test('(d) the check correction raised as today: awaiting_owner, "review automated-check changes"; the owner\'s answers for the iteration are exactly preparation, brief and check', async () => {
    const { fx } = S;
    const { id, it } = S.within;
    const asked = await pump(fx, id, async () => (await openDecisionsRead(fx, id)).find((d) => CHECK_KINDS.includes(d.kind)), { what: 'the check correction' });
    await pump(fx, id, async () => ((await iterationRead(fx, id, it)).iteration.status === 'awaiting_owner' ? true : undefined), { max: 3, what: 'the iteration awaiting the owner' });
    const read = await iterationRead(fx, id, it);
    assert.deepEqual([read.iteration.status, read.outcome.next_step], ['awaiting_owner', 'review automated-check changes']);
    assert.equal(asked.kind, 'check_correction_unclassifiable', 'raised as today: the Verifier\'s authoring is unclassifiable');
    await alphaReady(fx, id);
    const acts = [];
    await pump(fx, id, statusIs(fx, id, it, 'alpha_ready'), { answer: CHECK_KINDS, acts, max: 100, what: 'alpha_ready' });
    const done = await iterationRead(fx, id, it);
    assert.deepEqual(Object.keys(done.owner_approvals.by_kind).sort(), [...PROTO.owner_kinds].sort(), `the owner's answers: preparation, brief and check (${JSON.stringify(done.owner_approvals)})`);
    assert.equal(done.owner_approvals.count, 3);
    assert.ok(Object.values(done.owner_approvals.by_kind).every((n) => n === 1));
    // Every consumed decision of the project is one of those three.
    const consumed = withStore(fx.home, (db) => db.prepare(`SELECT "kind", "answer" FROM "decisions" WHERE "project" = ? AND "status" = 'consumed'`).all(id));
    assert.deepEqual(consumed.map((d) => d.kind).sort(), [...PROTO.owner_kinds].sort(), 'no other question was answered for the iteration');
  });

  for (const [label, name, script, bound] of [
    ['three stages', 'Tasks three', firstPlanScript({ stages: THREE_STAGES }), /^approve the plan \(architecture_approval and plan_approval\): outside the prototype bounds: .*the plan has 3 stages; a prototype's has at most 2/],
    [
      'a new platform permission',
      'Tasks camera',
      firstPlanScript({ modules: { ...MODULES, modules: [{ ...MODULES.modules[0], surface: 'ui', targets: [{ target: 'macos', ui_technology: 'swiftui' }], platform_permissions: [{ target: 'macos', permission: 'camera', why: 'to scan a task list' }] }] } }),
      /^approve the plan \(architecture_approval and plan_approval\): outside the prototype bounds: .*the module map asks for platform permission\(s\): app: camera \(macos\)/,
    ],
  ]) {
    test(`(c) ${label}: the architecture_approval and plan_approval batch raised, awaiting_owner, the next step naming the bound exceeded`, async () => {
      const { fx } = S;
      const { id, it } = await toBrief(fx, { name });
      kindNext(fx, 'replan', [script], firstPlanScript());
      await answerOpen(fx, id, 'spec_approval');
      const read = await pump(fx, id, async () => {
        const r = await iterationRead(fx, id, it.id);
        return r.iteration.status === 'awaiting_owner' && (r.outcome.next_step ?? '').startsWith('approve the plan') ? r : undefined;
      }, { what: `${label}: the plan routed to the owner` });
      assert.match(read.outcome.next_step, bound, 'the next step names the bound exceeded');
      const arch = decisionsOfProject(fx.home, id, 'architecture_approval');
      const plan = decisionsOfProject(fx.home, id, 'plan_approval');
      assert.deepEqual([arch.map((d) => d.status), plan.map((d) => d.status)], [['open'], ['open']], 'both raised, open');
      assert.ok(arch[0].batch_key && arch[0].batch_key === plan[0].batch_key, 'as one batch');
      const routed = eventsFor(fx.home, 'prototype.plan_routed_to_owner', 'iteration', it.id);
      assert.equal(routed.length, 1);
      assert.equal(eventsFor(fx.home, 'prototype.plan_policy_authorized', 'iteration', it.id).length, 0, 'not published by the policy');
      assert.equal(iterationRow(fx.home, it.id).phase_plan, null, 'no phase plan published');
      assert.deepEqual(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "phase_plans" WHERE "project" = ? AND ("active" = 1 OR "status" = 'published')`).get(id).n), 0, 'no phase plan published or active');
    assert.equal(workOfProject(fx.home, id).filter((w) => w.kind === 'stage_build').length, 0, 'no stage registered');
    });
  }

  test('(e) a planned project\'s first bundle: the owner batch, as M5', async () => {
    const { fx } = S;
    const project = await createWithIdea(fx);
    await visionSession(fx, project.id);
    await specSession(fx, project.id);
    const arch = await architectSession(fx, project.id, project.repo, { answer: 'none' });
    assert.ok(arch.decisions.architecture_approval && arch.decisions.plan_approval, `the close raised architecture_approval and plan_approval (${JSON.stringify(arch.closed)})`);
    assert.equal(arch.decisions.architecture_approval.batch_key, arch.decisions.plan_approval.batch_key, 'under one batch key');
    assert.deepEqual([arch.decisions.architecture_approval.status, arch.decisions.plan_approval.status], ['open', 'open']);
    assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "phase_plans" WHERE "project" = ? AND "routing" = 'policy_authorized'`).get(project.id).n), 0, 'nothing published by a policy');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "prototype_iterations" WHERE "project" = ?').get(project.id).n), 0, 'no iteration');
    assert.deepEqual(eventsFor(fx.home, 'prototype.plan_policy_authorized', 'project', project.id), []);
    // Approved by the owner, published as M5 publishes it.
    for (const kind of ['architecture_approval', 'plan_approval']) {
      const res = await answer(fx, project.id, arch.decisions[kind]);
      assert.equal(res.status, 200, `${kind} approved (→ ${res.text})`);
    }
    const pp = await pump(fx, project.id, () => withStore(fx.home, (db) => db.prepare(`SELECT * FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" = 'published'`).get(project.id)), { max: 8, what: 'the planned project\'s plan published' });
    assert.notEqual(pp.routing, PROTO.routing, `published by the owner's approval, not the prototype policy (${pp.routing}, ${pp.approved_by})`);
    assert.notEqual(pp.approved_by, PROTO.publisher);
  });
});
