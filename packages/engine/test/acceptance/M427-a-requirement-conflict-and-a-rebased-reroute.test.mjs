// M427 (e) and (f) (slice 35; kernel lane). M5 plan §3.5 M427; D6-P05;
// D6 §5.4 (a `requirement_conflict` the Architect reports is a finding routed
// to `change_spec`, D3 X2, never a silent change), §5.3 item 2 (a rebased
// proposal rechecked and rerouted against the new bundle); B03; SEAM.md
// §§406, 410.
//
// (e) the replan's result carries a `requirement_conflict` finding: the
//     finding recorded from that run, a blocker about the replan offering
//     `change_spec`, and no spec version, change request or spec change work
//     made by it;
// (f) a replan revising ADR-001 holds; the owner's policy commit moves the
//     head; released, its commit is re-based and rechecked: the plan check
//     that routes it binds the bundle at the moved head, and it routes to
//     the owner.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { changeRequests, ownerPolicy, specRevisions, workOf } from './harness/journey/drive.mjs';
import { checkOfApproval, journey35, nextReplanOutcome, replan35, replanRunsOf, phaseCompleteNoPlanAnswer } from './harness/journey/plan35.mjs';
import { ADR_001_REVISED, ADR_KEY } from './harness/journey/reference.mjs';
import { pumpNoIdle } from './harness/journey/review31b.mjs';
import { findingsOf } from './harness/gates.mjs';
import { refOid } from './harness/repos.mjs';
import { withStore } from './harness/store.mjs';

const CONFLICT = { category: 'requirement_conflict', severity: 'medium', message: 'R4 cannot be planned: /stats has no defined period, and R3 counts since the process started.', criterion: 'R4.1' };

describe('M427 (e) and (f)', () => {
  test('(e) a requirement_conflict in the replan\'s result: a finding of that run routed to change_spec; nothing of the spec changed', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('replan', [replan35({ result: { findings: [CONFLICT] } }), replan35({ result: { findings: [CONFLICT] } })]);
    await phaseCompleteNoPlanAnswer(fx, ctx, 1);
    const run = await pumpNoIdle(fx, ctx, () => replanRunsOf(fx.home, p.id).find((r) => r.state === 'ended'), { what: 'the replan run to end', max: 60 });
    const finding = await pumpNoIdle(fx, ctx, () => findingsOf(fx.home, p.id).find((f) => f.category === 'requirement_conflict'), { what: 'the conflict to be recorded', max: 10 }).catch(() => null);
    assert.ok(finding, `the Architect's requirement_conflict is recorded as a finding (run ${run.outcome}/${run.reason_class}: ${run.reason_text})`);
    assert.equal(finding.source_run, run.id, 'from the replan\'s run');
    const item = run.work_item;
    const blocker = await pumpNoIdle(fx, ctx, () => decisionsOn(fx.home, 'blocker', item).find((d) => d.status === 'open'), { what: 'the blocker about the replan', max: 10 }).catch(() => null);
    assert.ok(blocker, 'a blocker about the replan routes the conflict (D3 X2)');
    assert.ok(blocker.options.map((o) => o.key).includes('change_spec'), `offering change_spec (${JSON.stringify(blocker.options.map((o) => o.key))})`);
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'no spec version made by it');
    assert.deepEqual(changeRequests(fx.home, p.id), [], 'no change request');
    assert.deepEqual(workOf(fx.home, p.id, 'spec_change'), [], 'no spec change work before the owner\'s answer');
  });

  test('(f) a rebased proposal is rechecked and rerouted against the bundle at the moved head', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('replan', [replan35({ architecture_version: 2, hold: true, files: { [`.surety/adrs/${ADR_KEY}.md`]: ADR_001_REVISED } })]);
    await pumpNoIdle(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_kind: 'replan' }).at(-1);
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0 ? launch : undefined;
    }, { what: 'phase 1 complete and the replan holding', max: 600 });
    const before = refOid(p.repo.path, p.repo.ref);
    await ownerPolicy(fx, p.id, { deadline_reviewer: 900 });
    const moved = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(moved, before, 'the policy commit moved the head');
    fx.scripted.release('all', 'gate');
    const out = await nextReplanOutcome(fx, ctx, 2, { runs: new Set(), approvals: new Set(), published: new Set() });
    assert.ok(out.approval, `the ADR change routes to the owner after the re-base (${JSON.stringify(out.failed ? [out.failed.reason_class, out.failed.reason_text] : Object.keys(out))})`);
    const check = checkOfApproval(fx.home, p.id, out.approval);
    assert.equal(check.routing, 'human');
    assert.ok((check.changes_adrs?.changed ?? []).includes(ADR_KEY), `the recheck computed the change against the new bundle (${JSON.stringify(check.changes_adrs)})`);
    const head = withStore(fx.home, (db) => db.prepare('SELECT "head" FROM "plan_bundles" WHERE "id" = ?').get(check.bundle)?.head);
    assert.equal(head, moved, `the routing check binds the bundle at the moved head ${moved}, not ${before}`);
  });
});
