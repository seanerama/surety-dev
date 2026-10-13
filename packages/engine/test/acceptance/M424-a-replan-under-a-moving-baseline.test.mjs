// M424 (f), a replan under a moving baseline (slice 34; kernel lane). M5
// plan §3.4 M424 (f); D6-A04; D6 §5.3 clause 2, §5.6; B03; SEAM.md §403.
//
// The replan dispatched at phase 1's completion holds before its result; while
// it holds, the baseline moves; released, its commit is rechecked:
// - a spec change approved while it runs (the owner's request proposed during
//   phase 1, approved during the hold): `PLAN_STALE_BASELINE`, the proposal
//   `stale`, nothing prepared against spec 1 published;
// - a roadmap revision approved while it runs (an Architect session's
//   `architecture_approval` raised after phase 1's last integration, answered
//   during the hold): `PLAN_STALE_BASELINE`;
// - a harmless head move (the owner's policy change, an engine commit):
//   re-based and published by `engine:plan_check`, prepared against the head
//   it was re-based on.
// The project's one run at a time (as built until slice 37) and its one
// session admit no session or one-shot beside the held replan, so each
// competing change is a decision raised before the hold and answered during
// it, or an owner's commit.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decision, decisionsOfKind } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { ROUTED_KINDS, ownerPolicy, planChecks, planOfPhase, readPlan, roadmapRevisions, runsOfProject, specChangeScript, specRevisions, stagesOfPlan } from './harness/journey/drive.mjs';
import { ROADMAP_JSON } from './harness/journey/reference.mjs';
import { replanHeld, replanRuns, replanScript, untilReplanHolds } from './harness/journey/replan34.mjs';
import { journeyProject, postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { refOid } from './harness/repos.mjs';
import { tick } from './harness/runs.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const release = (fx) => fx.scripted.release('all', 'gate');
// Ticks (without waiting for idle) until `done` answers.
const ticksUntil = (fx, p, done, what) =>
  waitFor(
    async () => {
      const v = await done();
      if (v) return v;
      await tick(fx.engine, p.id, { rounds: 1 });
      return undefined;
    },
    { timeoutMs: 60_000, intervalMs: 200, what },
  );
const firstReplanEnded = (fx, p) => ticksUntil(fx, p, () => replanRuns(fx.home, p.id).find((r) => r.state === 'ended'), 'the first replan run to end');
// The latest decision of `kind`, open if one is.
const latest = (home, project, kind) => {
  const rows = decisionsOfKind(home, project, kind);
  return rows.find((r) => r.status === 'open') ?? rows.at(-1) ?? null;
};

// The first run refused on recheck with PLAN_STALE_BASELINE; nothing of phase 2
// published from it; the proposal listed stale.
async function assertStale(fx, p, ended) {
  assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'invalid_result'], `the commit's recheck refuses the plan (${ended.reason_text})`);
  assert.match(ended.reason_text ?? '', /PLAN_STALE_BASELINE/, 'naming PLAN_STALE_BASELINE');
  assert.ok(planChecks(fx.home, p.id).some((c) => c.outcome === 'refused' && JSON.stringify(c.reasons).includes('PLAN_STALE_BASELINE')), 'the plan_checks row records it');
  assert.equal(planOfPhase(fx.home, p.id, 2).filter((x) => x.published_at).length, 0, 'nothing of phase 2 published from the stale proposal');
  const read = await readPlan(fx, p.id);
  assert.ok((read.proposals ?? []).some((x) => x.phase === 2 && x.status === 'stale'), `the proposal is listed stale (${JSON.stringify(read.proposals)})`);
}

describe('M424 (f) a replan under a moving baseline', () => {
  test('a spec change approved while the replan runs: rechecked on commit, PLAN_STALE_BASELINE', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanHeld(), replanScript({ spec_version: 2 }), replanScript({ spec_version: 2 })]);
    fx.scripted.kindScript('spec_change', specChangeScript());
    // The owner's request, proposed during phase 1 and left for the owner.
    await postChange(fx, ctx, 'Two clarifications: R2.1 names the content type; R4 counts successful sums only.');
    await untilReplanHolds(fx, ctx, { answerKinds: ROUTED_KINDS.filter((k) => k !== 'spec_change') });
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'spec version 1 while the replan started');
    const change = latest(fx.home, p.id, 'spec_change');
    assert.equal(change?.status, 'open', 'the change awaits the owner');
    const res = await answer(fx.engine, p.id, decision(fx.home, change.id), 'approve');
    assert.equal(res.status, 200, `the owner approves the change during the hold (→ ${res.status} ${res.text})`);
    await ticksUntil(fx, p, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), 'spec version 2');
    release(fx);
    await assertStale(fx, p, await firstReplanEnded(fx, p));
  });

  test('a roadmap revision approved while the replan runs: rechecked on commit, PLAN_STALE_BASELINE', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanHeld(), replanScript({ roadmap_version: 2 }), replanScript({ roadmap_version: 2 })]);
    // An Architect session revising phase 2's goal, opened in a quiet moment
    // after phase 1's last integration (its checks queued, no role run), so
    // no later commit of phase 1 moves the head under its approval; the
    // approval left for the owner.
    const session = await pumpNoIdle(
      fx,
      ctx,
      async () => {
        const stages = stagesOfPlan(fx.home, planOfPhase(fx.home, p.id, 1)[0].id);
        if (!stages.every((st) => ['integrated', 'verified'].includes(st.status))) return undefined;
        if (runsOfProject(fx.home, p.id).some((r) => r.state !== 'ended')) return undefined;
        const res = await fx.engine.post(`/v1/projects/${p.id}/sessions`, { role: 'architect' });
        return res.status === 201 ? res.body.run : undefined;
      },
      { what: 'an Architect session after phase 1\'s last integration', max: 400 },
    );
    const roadmap = { ...ROADMAP_JSON, version: 2, phases: [ROADMAP_JSON.phases[0], { ...ROADMAP_JSON.phases[1], goal: 'count the sums, then show them on /stats' }] };
    scriptTurns(fx, session.id, [turnThatWrites({ '.surety/roadmap/roadmap.json': json(roadmap) }, { reply: 'Phase 2\'s goal restated.', done: true })]);
    await sayAndSettle(fx, p.id, session.id, 'Restate phase 2\'s goal.');
    await saveSession(fx, p.id, session.id);
    const closed = await closeSession(fx, p.id, session.id);
    assert.ok((closed.decisions ?? []).some((d) => d.kind === 'architecture_approval'), `the close raised architecture_approval (${JSON.stringify(closed)})`);
    await untilReplanHolds(fx, ctx, { answerKinds: ROUTED_KINDS.filter((k) => k !== 'plan_approval') });
    assert.deepEqual(roadmapRevisions(fx.home, p.id).map((r) => r.version), [1], 'roadmap version 1 while the replan started');
    const approval = latest(fx.home, p.id, 'architecture_approval');
    assert.equal(approval?.status, 'open', `the revision awaits the owner (${approval?.status})`);
    const res = await answer(fx.engine, p.id, decision(fx.home, approval.id), 'approve');
    assert.equal(res.status, 200, `the owner approves the revision during the hold (→ ${res.status} ${res.text})`);
    await ticksUntil(fx, p, () => roadmapRevisions(fx.home, p.id).find((r) => r.version === 2), 'roadmap version 2');
    release(fx);
    await assertStale(fx, p, await firstReplanEnded(fx, p));
  });

  test('a harmless head move while the replan runs (the owner\'s policy commit): re-based and published by engine:plan_check', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanHeld()]);
    await untilReplanHolds(fx, ctx);
    const before = refOid(p.repo.path, p.repo.ref);
    await ownerPolicy(fx, p.id, { deadline_reviewer: 900 });
    const moved = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(moved, before, 'the policy change is an engine commit on the integration branch');
    release(fx);
    const published = await ticksUntil(fx, p, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), 'phase 2 to be published');
    assert.deepEqual([published.approved_by, published.routing], ['engine:plan_check', 'registered'], 'published by computed routing');
    assert.equal(published.prepared_against_revision, moved, 'prepared against the head it was re-based on');
    const [first] = replanRuns(fx.home, p.id);
    assert.equal(first.outcome, 'completed', 'the replan itself, not a repair, was published');
    assert.ok(planChecks(fx.home, p.id).some((c) => c.outcome === 'passed' && (c.plan === published.id || c.id === published.check)), 'its plan check passed');
  });
});
