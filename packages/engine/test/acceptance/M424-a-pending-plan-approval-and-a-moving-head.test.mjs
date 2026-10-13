// M424, a routed replan's pending approval under a moving head (slice 34,
// the review's gap; kernel lane). M5 plan §3.4 M424 (f); D6 §5.3 clause 2,
// §5.4, §5.5; B02, B03; the driver's ruling (2026-10-13; SEAM.md §405).
//
// Phase 2's replan revises ADR-001, so its bundle is routed to the owner
// (`plan_approval`, with `architecture_approval` where the engine raises the
// pair). While that approval is pending:
// - a harmless head move (the owner's policy commit) re-raises the pending
//   decisions as their next generation, still binding the same bundle, and the
//   bundle stays publishable through them: approved, phase 2 is published from
//   it;
// - a head move that changes a bound input (a spec change approved) marks the
//   bundle `stale`, with no open decision for it.
// Never a `proposed` bundle with no open decision binding it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer, decision, decisionsOfKind } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { ROUTED_KINDS, ownerPolicy, planOfPhase, readPlan, specChangeScript, specRevisions } from './harness/journey/drive.mjs';
import { ADR_001_REVISED, ADR_KEY } from './harness/journey/reference.mjs';
import { replanScript, replanWith } from './harness/journey/replan34.mjs';
import { journeyProject, postChange, pumpNoIdle } from './harness/journey/review31b.mjs';
import { refOid } from './harness/repos.mjs';
import { tick } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const PAIR = ['architecture_approval', 'plan_approval'];
const replanChangingTheArchitecture = () => replanWith({ architecture_version: 2, before: [step.write(`.surety/adrs/${ADR_KEY}.md`, ADR_001_REVISED)] });

// The open decisions of the pair binding `bundle`.
const openFor = (home, project, bundle) => PAIR.flatMap((kind) => decisionsOfKind(home, project, kind)).filter((d) => d.status === 'open' && d.manifest?.bundle === bundle);
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

// Phase 1 complete and phase 2's routed bundle pending the owner. Returns {fx, p, ctx, bundle, pending}.
async function pendingRoutedBundle(t) {
  const { fx, p, ctx } = await journeyProject(t);
  fx.scripted.kindScript('replan', [replanChangingTheArchitecture(), replanScript({ spec_version: 2, architecture_version: 2 }), replanScript({ spec_version: 2, architecture_version: 2 })]);
  fx.scripted.defaultScript(script.complete());
  const approval = await pumpNoIdle(fx, ctx, () => decisionsOfKind(fx.home, p.id, 'plan_approval').find((d) => d.status === 'open'), {
    what: 'phase 2\'s plan_approval pending',
    max: 600,
    answerKinds: ROUTED_KINDS.filter((k) => k !== 'plan_approval'),
  });
  const bundle = approval.manifest?.bundle;
  assert.ok(bundle, `the approval binds a bundle (${JSON.stringify(approval.manifest)})`);
  return { fx, p, ctx, bundle, pending: openFor(fx.home, p.id, bundle) };
}

// Every bundle the plan read lists `proposed` has an open decision binding it.
async function assertNoOrphanProposal(fx, p) {
  const read = await readPlan(fx, p.id);
  for (const x of (read.proposals ?? []).filter((y) => y.status === 'proposed')) {
    assert.ok(openFor(fx.home, p.id, x.bundle).length > 0, `the proposed bundle ${x.bundle} has an open decision binding it (${JSON.stringify(read.proposals)})`);
  }
  return read;
}

describe('M424 a routed replan\'s pending approval under a moving head', () => {
  test('a harmless head move re-raises the pending decisions as their next generation; the bundle stays publishable through them', async (t) => {
    const { fx, p, bundle, pending } = await pendingRoutedBundle(t);
    const before = refOid(p.repo.path, p.repo.ref);
    await ownerPolicy(fx, p.id, { deadline_reviewer: 900 });
    assert.notEqual(refOid(p.repo.path, p.repo.ref), before, 'the policy change moved the head');
    // Each pending decision either still open, or invalidated with its next generation open on the same bundle.
    const next = await ticksUntil(
      fx,
      p,
      () => {
        const open = openFor(fx.home, p.id, bundle);
        const kinds = new Set(pending.map((d) => d.kind));
        return [...kinds].every((k) => open.some((d) => d.kind === k)) ? open : undefined;
      },
      'the pending decisions open on the same bundle after the head moved',
    );
    for (const d of pending) {
      const now = decision(fx.home, d.id);
      if (now.status !== 'open') assert.equal(now.status, 'invalidated', `an earlier generation is invalidated, never consumed (${d.kind}: ${now.status})`);
    }
    await assertNoOrphanProposal(fx, p);
    for (const d of next) {
      const res = await answer(fx.engine, p.id, decision(fx.home, d.id), 'approve');
      assert.equal(res.status, 200, `the owner approves ${d.kind} through its current generation (→ ${res.status} ${res.text})`);
    }
    const published = await ticksUntil(fx, p, () => planOfPhase(fx.home, p.id, 2).find((x) => x.published_at), 'phase 2 to be published');
    assert.equal(published.bundle, bundle, 'published from the bundle that was pending');
  });

  test('a head move that changes a bound input (a spec change approved) marks the pending bundle stale, with no open decision for it', async (t) => {
    const { fx, p, ctx, bundle } = await pendingRoutedBundle(t);
    fx.scripted.kindScript('spec_change', specChangeScript());
    await postChange(fx, ctx, 'Two clarifications: R2.1 names the content type; R4 counts successful sums only.');
    await pumpNoIdle(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', answerKinds: ['spec_change'] });
    await tick(fx.engine, p.id, { rounds: 2 });
    const read = await assertNoOrphanProposal(fx, p);
    const proposal = (read.proposals ?? []).find((x) => x.bundle === bundle);
    assert.equal(proposal?.status, 'stale', `the bundle is stale (${JSON.stringify(read.proposals)})`);
    assert.deepEqual(openFor(fx.home, p.id, bundle), [], 'no open decision binds it');
    assert.equal(planOfPhase(fx.home, p.id, 2).filter((x) => x.published_at && x.bundle === bundle).length, 0, 'nothing published from it');
  });
});
