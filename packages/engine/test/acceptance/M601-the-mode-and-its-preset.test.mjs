// M601, the mode and its preset (the owner's draft M7 plan §3, row M601;
// request §5; rulings R4, S1, S5 of 2026-10-28; SEAM.md §575). Kernel lane.
//
//   (a) `POST /v1/projects/new` with `mode: rapid_prototype` and no tier:
//       201, T1, the first iteration `preparing`; the project not paused and
//       nothing dispatched, no run and no work item, until the owner approves
//       the preparation (S1). With tier T2, and with an unknown mode: 400,
//       nothing created.
//   (b) a planned app created beside it: paused, no iteration, no policy
//       revision (the schema defaults effective, as M5), no prototype
//       question.
//   (c) the prototype's bootstrap policy: revision 1 holding the preset
//       (S5: budget_run_billable_tokens 5,000,000), widens_authority 0, no
//       policy_widening.
//   (d) the five limit keys: the contract's defaults on the iteration and in
//       the effective policy; each out-of-range value refused 400; lowering
//       one applies directly; raising one is a widening the owner confirms.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { getRow, tick } from './harness/runs.mjs';
import {
  CONFIG,
  LIMIT_KEYS,
  PROTO,
  countRows,
  currentIt,
  decisionsOfProject,
  iterationRead,
  iterationsRead,
  limitsCommitted,
  newApp,
  openDecisionsRead,
  ownerPolicy,
  policyRead,
  policyRevisionRows,
  postNew,
  projectRead,
  protoEngine,
  runsOfProjectRows,
  workOfProject,
  workRead,
} from './harness/prototype.mjs';

const DEFAULTS = Object.fromEntries(LIMIT_KEYS.map((k) => [k, CONFIG.project[k].default]));

describe('M601 the mode and its preset', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) rapid_prototype with no tier: 201, T1, iteration 1 preparing; the project unpaused and nothing dispatched until the preparation approval; T2 and an unknown mode refused 400, nothing created', async () => {
    const { fx } = S;
    const projectsBefore = countRows(fx.home, 'projects');
    const t2 = await postNew(fx, { name: 'Proto T2', tier: 'T2' });
    assert.equal(t2.status, 400, `a rapid prototype at T2 is refused (→ ${t2.status} ${t2.text})`);
    assert.equal(t2.body?.subject?.field, 'tier', `the refusal names the tier (${t2.text})`);
    const unknown = await postNew(fx, { name: 'Proto odd', mode: 'sketch' });
    assert.equal(unknown.status, 400, `an unknown mode is refused (→ ${unknown.status} ${unknown.text})`);
    assert.equal(unknown.body?.subject?.field, 'mode', `the refusal names the mode (${unknown.text})`);
    assert.equal(countRows(fx.home, 'projects'), projectsBefore, 'the refused requests created no project');

    const { id, res } = await newApp(fx, { name: 'Tasks' });
    S.proto = id;
    assert.equal(res.status, 201);
    assert.equal(res.body.project.mode, 'rapid_prototype', 'the answer names the mode');
    assert.match(res.body.project.iteration ?? '', /^it_/, 'and the first iteration');
    const read = await projectRead(fx, id);
    assert.deepEqual([read.mode, read.tier], ['rapid_prototype', PROTO.tier], 'a rapid prototype, built at T1 when no tier is given');
    assert.deepEqual(read.prototype, { iteration: res.body.project.iteration, status: 'preparing' }, 'the project read serves its current iteration, preparing');
    assert.equal(read.paused, false, 'created unpaused (S1)');
    const row = getRow(fx.home, 'projects', id);
    assert.deepEqual([row.mode, row.tier, row.paused], ['rapid_prototype', 'T1', 0], 'the store says the same');
    const list = (await iterationsRead(fx, id)).iterations;
    assert.deepEqual(list.map((i) => [i.id, i.seq, i.status, i.predecessor]), [[res.body.project.iteration, 1, 'preparing', null]], 'one iteration, seq 1, preparing');

    // Nothing is dispatched before the preparation is authorized: the scheduler runs, and finds nothing.
    await tick(fx.engine, id);
    await tick(fx.engine, id);
    assert.deepEqual(await workRead(fx, id), [], 'no work item before the preparation approval');
    assert.deepEqual(workOfProject(fx.home, id), [], 'none in the store');
    assert.deepEqual(runsOfProjectRows(fx.home, id), [], 'no run');
    assert.deepEqual((await openDecisionsRead(fx, id)).map((d) => d.kind), ['prototype_preparation_approval'], 'only the preparation is asked');
    assert.equal((await projectRead(fx, id)).paused, false, 'still unpaused');

    // The approval creates the one preparation item, and nothing else.
    const d = (await openDecisionsRead(fx, id))[0];
    const answered = await fx.engine.post(`/v1/projects/${id}/decisions/${d.id}/answer`, { option: 'approve', preview_hash: d.preview_hash });
    assert.equal(answered.status, 200, answered.text);
    const items = workOfProject(fx.home, id);
    assert.deepEqual(items.map((w) => w.kind), [PROTO.preparation.work_kind], 'after the approval: exactly one work item, the brief preparation');
  });

  test('(b) a planned app beside it: paused, no iteration, no policy revision (the schema defaults effective, as M5), no prototype question', async () => {
    const { fx } = S;
    const { id } = await newApp(fx, { name: 'Planned beside', mode: null, tier: 'T2', resume: false });
    S.planned = id;
    const read = await projectRead(fx, id);
    assert.deepEqual([read.mode, read.tier, read.paused, read.prototype], ['planned', 'T2', true, null], 'a planned app is created paused, with no prototype');
    assert.deepEqual((await iterationsRead(fx, id)).iterations, [], 'no iteration');
    assert.equal(countRows(fx.home, 'prototype_iterations', '"project" = ?', id), 0);
    assert.deepEqual(policyRevisionRows(fx.home, id), [], 'no bootstrap policy revision');
    const policy = await policyRead(fx, id);
    for (const [k, spec] of Object.entries(CONFIG.project)) {
      if (k.startsWith('$') || spec.default === undefined) continue;
      assert.deepEqual(policy.effective[k], spec.default, `${k}: the contract's default is effective`);
    }
    assert.deepEqual(await openDecisionsRead(fx, id), [], 'no decision is raised for it');
    assert.equal(decisionsOfProject(fx.home, id, 'prototype_preparation_approval').length, 0);
    await tick(fx.engine, id);
    assert.deepEqual(workOfProject(fx.home, id), [], 'nothing is dispatched for it');
  });

  test('(c) the prototype\'s bootstrap policy: revision 1 holding the preset, widens_authority 0, no policy_widening', async () => {
    const { fx } = S;
    const id = S.proto;
    const revs = policyRevisionRows(fx.home, id);
    assert.equal(revs.length, 1, 'one policy revision');
    const [rev] = revs;
    assert.deepEqual([rev.revision, rev.widens_authority, rev.committed, rev.git_path], [1, 0, 1, '.surety/policy.json'], 'revision 1, committed, widening nothing');
    assert.deepEqual(JSON.parse(rev.diff_summary), PROTO.preset, 'its change is the preset');
    const effective = JSON.parse(rev.effective);
    for (const [k, v] of Object.entries(PROTO.preset)) assert.deepEqual(effective[k], v, `${k} is the preset's`);
    assert.equal(effective.budget_run_billable_tokens, 5_000_000, 'S5: the per-run limit 5,000,000');
    const policy = await policyRead(fx, id);
    assert.equal(policy.revision, 1);
    for (const [k, v] of Object.entries(PROTO.preset)) assert.deepEqual(policy.effective[k], v, `GET …/policy: ${k}`);
    for (const k of LIMIT_KEYS) assert.equal(policy.effective[k], DEFAULTS[k], `GET …/policy: ${k} is the contract default`);
    assert.equal(decisionsOfProject(fx.home, id, 'policy_widening').length, 0, 'no policy_widening was asked');
    const changed = eventsOfType(fx.home, 'policy.changed').filter((e) => e.subject?.project === id);
    assert.equal(changed.length, 1);
    assert.deepEqual([changed[0].payload.revision, changed[0].payload.widens_authority, changed[0].payload.bootstrap, changed[0].payload.mode], [1, false, true, 'rapid_prototype']);
  });

  test('(d) the five limit keys: the contract\'s defaults; out-of-range values refused 400; lowering applies directly; raising is a widening the owner confirms', async () => {
    const { fx } = S;
    const id = S.proto;
    assert.equal(LIMIT_KEYS.length, 5, `five prototype limit keys in the contract table (${LIMIT_KEYS})`);
    const it = await currentIt(fx, id);
    const read = await iterationRead(fx, id, it.id);
    for (const k of LIMIT_KEYS) assert.equal(read.iteration.limits[k], DEFAULTS[k], `the iteration snapshots ${k} = ${DEFAULTS[k]}`);
    assert.equal(read.iteration.limits.budget_run_billable_tokens, 5_000_000, 'and the per-run limit');
    assert.deepEqual(DEFAULTS, { prototype_budget_tokens: 1_500_000, prototype_budget_usd_estimated: 15, prototype_runtime_seconds: 2700, prototype_repairs_per_stage: 2, prototype_repairs_per_iteration: 4 }, 'R4: the defaults');

    const revisionBefore = (await policyRead(fx, id)).revision;
    for (const k of LIMIT_KEYS) {
      const spec = CONFIG.project[k];
      for (const value of [spec.min - 1, spec.max + 1, 'x']) {
        const res = await fx.engine.post(`/v1/projects/${id}/policy`, { [k]: value });
        assert.equal(res.status, 400, `${k} = ${JSON.stringify(value)} is refused (→ ${res.status} ${res.text})`);
      }
      if (spec.integer !== false) {
        const res = await fx.engine.post(`/v1/projects/${id}/policy`, { [k]: spec.min + 0.5 });
        assert.equal(res.status, 400, `${k} takes whole numbers only (→ ${res.status} ${res.text})`);
      }
    }
    assert.equal((await policyRead(fx, id)).revision, revisionBefore, 'no refused value made a revision');

    // Lowering applies directly.
    const lowered = await ownerPolicy(fx, id, { prototype_repairs_per_iteration: 3 }, 'lowering the repairs per iteration');
    assert.equal(lowered.widening, null, 'a lowering is no widening');
    await limitsCommitted(fx, id, it.id, 'prototype_repairs_per_iteration', 3);
    // Raising each is a widening, answered 409 and applied on the owner's approval.
    for (const k of LIMIT_KEYS) {
      const value = k === 'prototype_repairs_per_iteration' ? 5 : CONFIG.project[k].default + (CONFIG.project[k].integer === false ? 5 : k === 'prototype_budget_tokens' ? 500_000 : 1);
      const raised = await ownerPolicy(fx, id, { [k]: value }, `raising ${k}`);
      assert.ok(raised.widening, `raising ${k} is a widening`);
      assert.equal(raised.widening.kind, 'policy_widening');
      await limitsCommitted(fx, id, it.id, k, value);
    }
  });
});
