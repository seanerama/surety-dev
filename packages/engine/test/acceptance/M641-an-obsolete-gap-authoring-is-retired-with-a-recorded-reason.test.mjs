// M641, an obsolete gap authoring is retired with a recorded reason, never
// dispatched (slice 50; kernel lane). The owner's M7 plan §3i, row M641; D6
// §5.7; R7, R8; M545's pattern; M627 (post_deploy_behavior kinds and areas);
// DECISIONS items 52 (continued) and 57 work order 1.
//
// Found on Workshop Cut Planner iteration 2 (2026-11-25): a refused redeploy
// of the previous Alpha queued a `check_authoring` (trigger authoring_gap)
// for criteria the approved brief had just added; it dispatched a Verifier
// before the new phase plan was published, authored checks against the old
// candidate and raised high project-scope findings the owner had to
// disposition. The fixture is the investigator's replay on the real refusal
// route (harness/gap57.mjs): iteration 1 at Alpha on c1; iteration 2's spec
// adds R1.2 and R3.2 and moves R1 and R3 to phase 2; the owner's redeploy of
// c1 is refused ACCEPTANCE_SCOPE_INCOMPLETE [R1.2, R3.2] and queues the gap
// item G on iteration 1's plan; iteration 2's replan publishes phase 2,
// whose stages implement R1 and R3. Every check result is the scripted
// boundary's (exit 0). No fixture write to the store.
//
// (a) the replan publishes phase 2 (the project paused around the
//     publication, as the replay's scenario A): G cancelled, end_cause
//     `superseded`, one work.cancelled whose payload `reason` names phase 2's
//     plan, its own check authoring and R1.2, R3.2; no run, no finding, no
//     decision from G; phase 2's own authoring dispatches and the applied
//     checks cover R1.2 and R3.2;
// (b) phase 2's plan needs plan_approval (three stages; the production
//     order, no pause after the replan starts): G not dispatched while the
//     replan runs, nor while the bundle awaits the owner (the work read
//     names it held); approved and published, G retired as in (a);
// (c) restarts after the queueing, after the publication (before the next
//     tick) and after the retirement: one retirement, never revived, zero
//     runs;
// (d) a partial gap (R2.2 also added to R2, which stays in phase 1 and c1
//     still delivers): G not dispatched; a narrowed next generation of the
//     same trigger names R2.2 only; its package names R2.2 only; the finding
//     its Verifier raises on R2.2 is kept;
// (e) a kinds-only gap (M627's post_deploy_behavior: iteration 1's first
//     authoring writes no behaviour check, the policy's request is refused
//     and queues the authoring): dispatched, never held, never retired.
//
// Readings this file makes (the report says them):
// - "a reason" is read as the `reason` string of G's work.cancelled payload.
// - "held" in (b) is read as the work read's `held` on G (the engine's
//   served hold, work.hold_began), with no run on G.
// - (e)'s kinds-only gap arises in iteration 1, when no replan is under
//   way: this fixture could not make a kinds-only gap coincide with an
//   unfinished replan; (e) asserts it is dispatched with no hold recorded
//   and completes, never cancelled.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program and
// the scripted deployment adapter in the test's own home; nothing signalled
// but the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import {
  cancelledOf,
  effectiveCovering,
  findingsOf,
  fromItem,
  gapItems,
  gapScript,
  holdsOf,
  itemRow,
  oldAlphaRefused,
  phase2Plan,
  restart,
  runsOn,
  show,
  untilPublished,
} from './harness/gap57.mjs';
import { CHECK_FILES, CHECK_KINDS, authoringScript, briefToAlpha, kindNext, ok, protoEngine, pump, toBrief } from './harness/prototype.mjs';
import { pauseProject, resumeProject, tick } from './harness/runs.mjs';

const live = (fx, item) => runsOn(fx.home, item).find((r) => r.state !== 'ended');
const brief = (fx, item) => {
  const w = itemRow(fx.home, item);
  return w && { id: w.id, status: w.status, end_cause: w.end_cause, runs: runsOn(fx.home, item).map((r) => [r.id, r.state]) };
};

// The replan dispatched (the project resumed), then the project paused while
// its run holds; released, its run ends and phase 2's plan publishes (ticked
// while paused). `restarts` 1: before the resume; 2: right after the
// publication, before the harness ticks again.
async function publishPaused(J, { restarts = false } = {}) {
  const { fx, p, R } = J;
  if (restarts) await restart(fx);
  await resumeProject(fx.engine, p);
  await tick(fx.engine, p, { rounds: 1 });
  await waitFor(() => (live(fx, R) ? true : undefined), { what: "iteration 2's replan run live", timeoutMs: 60_000 });
  await pauseProject(fx.engine, p);
  fx.scripted.release('all', 'rp');
  await waitFor(() => (runsOn(fx.home, R).some((r) => r.state === 'ended') && !live(fx, R) ? true : undefined), { what: "the replan's run ended", timeoutMs: 120_000 });
  let plan = await waitFor(() => phase2Plan(fx.home, p) ?? undefined, { what: 'phase 2 published at the run end', timeoutMs: 3000 }).catch(() => null);
  if (!plan) plan = await untilPublished(fx, p);
  assert.ok(plan, `the fixture is live: phase 2's plan published (G: ${show(brief(fx, J.G))})`);
  if (restarts) await restart(fx);
  return plan;
}

// Resumed and ticked until G is no longer waiting: cancelled, or a run on it.
async function untilSettled(fx, p, G) {
  await resumeProject(fx.engine, p);
  for (let i = 0; i < 12; i++) {
    const w = itemRow(fx.home, G);
    if (w.status === 'cancelled' || runsOn(fx.home, G).length > 0) break;
    await tick(fx.engine, p, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
}

// G retired: cancelled `superseded` once, its reason naming the plan, its
// own check authoring and `moved`; nothing from it.
function assertRetired(J, plan2, moved) {
  const { fx, p, G, findingsBefore } = J;
  const w = itemRow(fx.home, G);
  const from = fromItem(fx.home, G);
  assert.deepEqual(from.runs, [], `no run on the obsolete gap authoring ${G} (${show(brief(fx, G))}; findings from it ${show(from.findings)}; decisions ${show(from.decisions)})`);
  assert.deepEqual([w.status, w.end_cause], ['cancelled', 'superseded'], `the obsolete gap authoring is cancelled with end_cause superseded (${show(brief(fx, G))})`);
  const events = cancelledOf(fx.home, G);
  assert.equal(events.length, 1, `one work.cancelled for it (${show(events.map((e) => e.payload))})`);
  const reason = events[0].payload?.reason;
  assert.equal(typeof reason, 'string', `its payload carries a reason (${show(events[0].payload)})`);
  for (const named of [plan2.id, plan2.check_authoring, ...moved]) assert.ok(named && reason.includes(named), `the reason names ${named} (phase 2's plan, its check authoring, the criteria): ${reason}`);
  assert.deepEqual(from.findings, [], 'no finding from it');
  assert.deepEqual(from.decisions, [], 'no decision from it');
  assert.equal(findingsOf(fx.home, p).length, findingsBefore, `no finding recorded since the refusal (${show(findingsOf(fx.home, p).map((f) => [f.id, f.criterion, f.source_run]))})`);
}

describe('M641 an obsolete gap authoring is retired with a recorded reason, never dispatched', () => {
  test("(a) phase 2 published: G cancelled superseded, the reason naming the plan, its authoring and R1.2, R3.2; nothing from G; phase 2's own authoring dispatches and its checks cover the criteria", { timeout: 600_000 }, async (t) => {
    const J = await oldAlphaRefused(t, { name: 'M641 a', port: 18641 });
    const { fx, p, G } = J;
    const plan2 = await publishPaused(J);
    await untilSettled(fx, p, G);
    assertRetired(J, plan2, ['R1.2', 'R3.2']);
    // Phase 2's own authoring dispatches; its proposal approved, its checks cover the criteria.
    const covered = await pump(fx, p, () => (['R1.2', 'R3.2'].every((k) => effectiveCovering(fx.home, p, k).length > 0) ? true : undefined), { answer: CHECK_KINDS, max: 40, what: "phase 2's checks covering R1.2 and R3.2 applied" });
    assert.ok(covered);
    assert.ok(runsOn(fx.home, plan2.check_authoring).length >= 1, `phase 2's own check authoring ${plan2.check_authoring} dispatched`);
    assert.deepEqual([effectiveCovering(fx.home, p, 'R1.2'), effectiveCovering(fx.home, p, 'R3.2')], [['accept-r1b'], ['accept-r3b']], "the criteria are covered by phase 2's own checks");
    assert.deepEqual(runsOn(fx.home, G), [], 'still no run on G');
  });

  test("(b) the plan needs plan_approval: G held, not dispatched, while the replan runs and while the bundle awaits approval; published, G retired", { timeout: 600_000 }, async (t) => {
    const J = await oldAlphaRefused(t, { name: 'M641 b', port: 18642, approval: true });
    const { fx, p, R, G } = J;
    await resumeProject(fx.engine, p);
    await tick(fx.engine, p, { rounds: 1 });
    await waitFor(() => (live(fx, R) ? true : undefined), { what: "iteration 2's replan run live", timeoutMs: 60_000 });
    await tick(fx.engine, p, { rounds: 2 });
    assert.deepEqual(runsOn(fx.home, G).map((r) => r.id), [], `G not dispatched while the replan runs (${show(brief(fx, G))})`);
    fx.scripted.release('all', 'rp');
    await waitFor(() => (runsOn(fx.home, R).some((r) => r.state === 'ended') && !live(fx, R) ? true : undefined), { what: "the replan's run ended", timeoutMs: 120_000 });
    const openApproval = async () => (await ok(fx.engine.get(`/v1/projects/${p}/decisions`), 200, 'GET …/decisions')).decisions.find((d) => d.kind === 'plan_approval');
    let approval;
    for (let i = 0; i < 10 && !(approval = await openApproval()); i++) {
      await tick(fx.engine, p, { rounds: 1 });
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(approval, `the fixture is live: the bundle awaits the owner's plan_approval (G: ${show(brief(fx, G))})`);
    assert.equal(phase2Plan(fx.home, p), null, 'the fixture is live: phase 2 not yet published');
    await tick(fx.engine, p, { rounds: 3 });
    assert.deepEqual(runsOn(fx.home, G).map((r) => [r.id, r.state, r.created_at]), [], `G not dispatched while the bundle awaits plan_approval (${show(brief(fx, G))})`);
    assert.ok(!['cancelled', 'complete'].includes(itemRow(fx.home, G).status), `G waits (${show(brief(fx, G))})`);
    const served = (await ok(fx.engine.get(`/v1/projects/${p}/work`), 200, 'GET …/work')).work_items.find((w) => w.id === G);
    assert.ok(served?.held, `the work read names G held (${show(served)}; hold events ${show(holdsOf(fx.home, G).map((e) => e.payload))})`);
    const plan2 = await untilPublished(fx, p, { approve: true });
    assert.ok(plan2, 'the fixture is live: approved, phase 2 published');
    await untilSettled(fx, p, G);
    assertRetired(J, plan2, ['R1.2', 'R3.2']);
  });

  test('(c) restarts after the queueing, after the publication and after the retirement: one retirement, never revived, zero runs', { timeout: 600_000 }, async (t) => {
    const J = await oldAlphaRefused(t, { name: 'M641 c', port: 18643 });
    const { fx, p, G } = J;
    const plan2 = await publishPaused(J, { restarts: true });
    await untilSettled(fx, p, G);
    assertRetired(J, plan2, ['R1.2', 'R3.2']);
    await restart(fx);
    await tick(fx.engine, p, { rounds: 3 });
    assertRetired(J, plan2, ['R1.2', 'R3.2']);
    const revived = gapItems(fx.home, p).filter((w) => w.id !== G && (w.trigger_evidence?.deployment?.missing?.criteria ?? []).some((k) => ['R1.2', 'R3.2'].includes(k)));
    assert.deepEqual(revived.map((w) => [w.id, w.status]), [], 'no other authoring asked for R1.2 or R3.2');
  });

  test('(d) a partial gap: G not dispatched; a narrowed next generation names R2.2 only, its package names it, and the finding on R2.2 is kept', { timeout: 600_000 }, async (t) => {
    const J = await oldAlphaRefused(t, { name: 'M641 d', port: 18644, partial: true });
    const { fx, p, G } = J;
    const g = itemRow(fx.home, G);
    const plan2 = await publishPaused(J);
    await tick(fx.engine, p, { rounds: 2 });
    const narrowed = () => gapItems(fx.home, p).filter((w) => w.id !== G);
    const N = narrowed()[0];
    assert.deepEqual(runsOn(fx.home, G).map((r) => r.id), [], `G not dispatched (${show(brief(fx, G))})`);
    assert.ok(N, `a narrowed next generation of the gap authoring (gap items: ${show(gapItems(fx.home, p).map((w) => [w.id, w.status, w.trigger_generation, w.trigger_evidence?.deployment?.missing]))})`);
    assert.equal(narrowed().length, 1, 'one');
    assert.deepEqual([N.trigger_id, N.trigger_generation > g.trigger_generation], [g.trigger_id, true], `the same trigger's next generation (${show([N.trigger_id, N.trigger_generation])})`);
    assert.deepEqual(N.trigger_evidence?.deployment?.missing, { kinds: [], criteria: ['R2.2'], areas: [] }, `naming R2.2 only (${show(N.trigger_evidence)})`);
    assert.equal(N.trigger_evidence?.deployment?.candidate, J.c1.id, 'for c1');
    assert.equal(itemRow(fx.home, G).status, 'cancelled', `G ended (${show(brief(fx, G))})`);
    const reason = cancelledOf(fx.home, G)[0]?.payload?.reason ?? '';
    for (const named of [plan2.id, 'R1.2', 'R3.2']) assert.ok(reason.includes(named), `G's reason names ${named}: ${reason}`);
    const narrowScript = gapScript(['R2.2']);
    fx.scripted.script(N.id, [narrowScript, narrowScript]);
    await resumeProject(fx.engine, p);
    const run = await pump(fx, p, () => runsOn(fx.home, N.id).find((r) => r.state === 'ended'), { answer: CHECK_KINDS, max: 40, what: 'the narrowed authoring run' });
    const launch = fx.scripted.launches({ run: run.id })[0];
    const dump = launch && fx.scripted.probes(launch.invocation, 'context_dump').at(-1);
    const authoring = JSON.parse((dump?.files ?? []).find((f) => f.name === 'authoring.json')?.text ?? 'null');
    assert.deepEqual(authoring?.deployment?.missing?.criteria, ['R2.2'], `its package names R2.2 only (${show(authoring?.deployment)})`);
    const raised = findingsOf(fx.home, p).filter((f) => f.source_run === run.id);
    assert.deepEqual(raised.map((f) => f.criterion), ['R2.2'], `its Verifier's finding on R2.2 recorded (${show(raised)})`);
    await tick(fx.engine, p, { rounds: 3 });
    const kept = findingsOf(fx.home, p).find((f) => f.id === raised[0].id);
    assert.deepEqual([kept.status, kept.subject_id, kept.criterion], ['open', raised[0].subject_id, 'R2.2'], `the genuine finding kept on its subject (${show(kept)})`);
    assert.deepEqual(runsOn(fx.home, G), [], 'still no run on G');
  });

  test('(e) a kinds-only gap (post_deploy_behavior): dispatched, never held, never retired', { timeout: 600_000 }, async (t) => {
    const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
    const withoutBehaviour = Object.fromEntries(Object.entries(CHECK_FILES).filter(([path]) => !path.endsWith('/operation.json')));
    kindNext(fx, 'check_authoring', [authoringScript({ files: withoutBehaviour })], authoringScript());
    const { id: p, it } = await toBrief(fx, { name: 'M641 e' });
    await briefToAlpha(fx, p, it.id, { port: 18645 });
    const gaps = gapItems(fx.home, p).filter((w) => w.trigger_evidence?.deployment);
    assert.equal(gaps.length, 1, `the fixture is live: one gap authoring asked for the deployment (${show(gaps.map((w) => [w.id, w.status, w.trigger_evidence]))})`);
    const K = gaps[0];
    assert.deepEqual(K.trigger_evidence.deployment.missing, { kinds: ['post_deploy_behavior'], criteria: [], areas: [] }, 'the fixture is live: kinds only');
    await tick(fx.engine, p, { rounds: 3 });
    const w = itemRow(fx.home, K.id);
    assert.equal(runsOn(fx.home, K.id).length, 1, `dispatched once (${show(runsOn(fx.home, K.id).map((r) => [r.id, r.outcome]))})`);
    assert.equal(w.status, 'complete', `completed, never retired (${show([w.status, w.end_cause])})`);
    assert.notEqual(w.end_cause, 'superseded');
    assert.deepEqual(cancelledOf(fx.home, K.id), [], 'no work.cancelled for it');
    assert.deepEqual(holdsOf(fx.home, K.id).map((e) => e.payload), [], 'never held');
  });
});
