// M643, a finding binds to what it observed; a parked replan holds the
// dependent task until the plan resolves (slice 50; kernel lane). The
// owner's M7 plan §3j, row M643; Sean's ruling D6 of 2026-11-26 (DECISIONS
// item 57): "Bind observations about an implementation to the candidate
// inspected. Bind missing check coverage to the applicable plan and spec
// revision. Reserve project-wide findings for evidence that actually
// applies across versions. When a replan parks, surface the dependency
// immediately and keep the obsolete task out of dispatch. Elapsed time alone
// must never release it. Re-evaluate it when the plan is approved,
// replaced, or abandoned."; D6 §5.7; E180; reconciles with M641.
//
// The fixture is M641's (harness/gap57.mjs): iteration 1 at Alpha on c1;
// iteration 2's spec adds R1.2 and R3.2 (and, `partial`, R2.2 to R2, still
// delivered by c1); the owner's redeploy of c1 is refused and queues the gap
// authoring G on iteration 1's plan, naming c1.
//
// (a) the partial gap: the narrowed next generation N runs; its Verifier's
//     implementation finding F (high, R2.2) is stored scope `candidate`,
//     candidate c1, never project; it does not apply to a sibling built
//     under phase 2's plan (that candidate's gate evaluations never name F);
// (b) phase 2's own check authoring (names no candidate) reports missing
//     coverage (high, R3.2): stored scope `plan`, bound to phase 2's plan and
//     iteration 2's approved spec revision; it blocks a phase or Alpha gate
//     of that plan's candidate; the iteration discarded (the plan
//     abandoned), it is closed with reason `plan_replaced`;
// (c) the same run's finding reported scope `project` keeps project scope,
//     its stated reason recorded (its message) and not re-scoped;
// (d) the replan parks (its one repair spent) while G waits: at once the
//     work read serves G `held_by {replan, status: 'parked', decision}`, NOW
//     names it, and the blocker question's evidence lists G;
// (e) the controlled clock advanced 48 h with ticks: G stays held, zero runs;
// (f) retried and its plan approved: G retired as M641 (a); separately the
//     plan rejected and so replaced by the next replan: still held (naming
//     the replacement), then retired against the replacement's plan;
//     separately the iteration discarded (the plan abandoned): G cancelled
//     `superseded` with reason `plan_abandoned`, never dispatched;
// (g) the base: (a)'s finding stored at project scope (findings.ts:184).
//
// Readings this file makes (the report says them):
// - "does not apply to a sibling" is read through the gate evaluations of
//   the first candidate nominated after c1 (phase 2's stage): none of their
//   reasons names F, while F is open and high.
// - "blocks that plan's phase gate and Alpha" is read as a `phase` or
//   `alpha_authorize` evaluation of phase 2's candidate not satisfied with
//   F among its reasons. "Not a later plan's": once closed, F names no
//   evaluation recorded after its closure (vacuous where none follows).
// - "closed (reason plan_replaced)" is read as F no longer `open` and an
//   event about F whose payload names `plan_replaced`.
// - (c)'s "stated reason recorded" is read as the finding's message as the
//   role reported it and no `normalized` entry in its finding.raised; it
//   holds on the base too (a preservation case).
// - NOW's dependency is read as an object anywhere in the project read's
//   `now` with `replan` the parked replan and `status` 'parked'.
// - "the blocker question's evidence lists the held item" is read as G's id
//   in the served blocker decision.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program and
// the scripted deployment adapter in the test's own home; nothing signalled
// but the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { PHASE2_CHECKS, cancelledOf, fromItem, gapItems, gapScript, itemRow, oldAlphaRefused, phase2Plan, runsOn, untilPublished } from './harness/gap57.mjs';
import { CHECK_KINDS, answer, confirmed, decisionRead, iterationRow, kindNext, ok, openDecisionsRead, pump, result, usage, workRead, write } from './harness/prototype.mjs';
import { pauseProject, resumeProject, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { advanceTicking, eventsAbout, findingRow, findingsOfProject, objectsWhere, rows, show } from './harness/item57v2.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const fail = () => ({ on_term: 'exit', steps: [usage(300, 0, 100), { exit: 3 }] });

// Iteration 2's plan needing plan_approval (M641's `approval` plan, three
// stages), restated from harness/gap57.mjs.
const ROADMAP2 = {
  version: 2,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'the task list, end to end', modules: ['app'], requirement_ids: ['R2'], depends_on: [] },
    { number: 2, goal: 'long titles and done state kept', modules: ['app'], requirement_ids: ['R1', 'R3'], depends_on: [1] },
  ],
};
const STAGE2 = { number: 1, goal: 'long titles and done kept', tasks: ['long titles and done kept'], modules: ['app'], implements: ['R1', 'R3'], adrs: [], depends_on: [], validation: { criteria: ['R1.1', 'R1.2', 'R3.1', 'R3.2'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] };
const THREE = [
  { ...STAGE2, number: 1, goal: 'long titles', tasks: ['long titles'], implements: ['R1'], validation: { ...STAGE2.validation, criteria: ['R1.1', 'R1.2'] } },
  { ...STAGE2, number: 2, goal: 'done kept', tasks: ['done kept'], implements: ['R3'], validation: { ...STAGE2.validation, criteria: ['R3.1', 'R3.2'] } },
  { ...STAGE2, number: 3, goal: 'both together', tasks: ['both together'], implements: ['R1', 'R3'], depends_on: [1, 2] },
];
const approvalPlan = () => ({
  on_term: 'exit',
  steps: [
    usage(1800, 0, 700),
    write('.surety/roadmap/roadmap.json', json(ROADMAP2)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list (R2).\n2. Long titles and done kept (R1, R3).\n'),
    { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: THREE, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 1: long titles\n- Stage 2: done kept\n- Stage 3: both together\n'),
    result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});

// Phase 2's own authoring, reporting missing coverage (b) and a project-wide finding (c).
const COVERAGE = 'missing coverage: no check of phase 2 asserts that a done task is still done after the list is reloaded (R3.2)';
const ACROSS = 'applies across versions: the protected policy runs every check through the probe command /usr/bin/true, which passes whatever any version of the app does';
const reportingAuthoring = () => ({
  steps: [
    step.probe('context_dump'),
    usage(900, 100, 300),
    ...Object.entries(PHASE2_CHECKS).map(([p, c]) => write(p, c)),
    result({
      proposal: { rationale: "phase 2's checks", requested_change_kind: 'unclassifiable' },
      findings: [
        { category: 'defect', severity: 'high', message: COVERAGE, criterion: 'R3.2' },
        { category: 'hygiene', severity: 'low', scope: 'project', message: ACROSS },
      ],
    }),
  ],
});

const live = (fx, item) => runsOn(fx.home, item).find((r) => r.state !== 'ended');
const evalsOf = (home, candidate) => rows(home, 'SELECT * FROM "gate_evaluations" WHERE "candidate" = ? ORDER BY rowid', candidate);
const names = (e, id) => String(e.reasons ?? '').includes(id);
const raisedOf = (home, f) => eventsAbout(home, f).find((e) => e.type === 'finding.raised');

// M641's publication with the project paused around it (its scenario A).
async function publishPaused(J) {
  const { fx, p, R } = J;
  await resumeProject(fx.engine, p);
  await tick(fx.engine, p, { rounds: 1 });
  await waitFor(() => (live(fx, R) ? true : undefined), { what: "iteration 2's replan run live", timeoutMs: 60_000 });
  await pauseProject(fx.engine, p);
  fx.scripted.release('all', 'rp');
  await waitFor(() => (runsOn(fx.home, R).some((r) => r.state === 'ended') && !live(fx, R) ? true : undefined), { what: "the replan's run ended", timeoutMs: 120_000 });
  let plan = await waitFor(() => phase2Plan(fx.home, p) ?? undefined, { what: 'phase 2 published at the run end', timeoutMs: 3000 }).catch(() => null);
  if (!plan) plan = await untilPublished(fx, p);
  assert.ok(plan, "the fixture is live: phase 2's plan published");
  return plan;
}

// The first candidate after c1 with an evaluation of one of `kinds`.
const laterCandidate = (fx, p, c1, kinds) => {
  const cs = rows(fx.home, 'SELECT * FROM "candidates" WHERE "project" = ? AND "seq" > ? ORDER BY "seq"', p, c1.seq);
  return cs.find((c) => evalsOf(fx.home, c.id).some((e) => kinds.includes(e.gate_kind))) ?? null;
};

describe('M643 (a), (g) an implementation finding binds to the candidate it inspected', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const J = await oldAlphaRefused(shared.context, { name: 'M643 a', port: 18643, partial: true });
    const { fx, p, G } = J;
    const plan2 = await publishPaused(J);
    await tick(fx.engine, p, { rounds: 2 });
    const N = gapItems(fx.home, p).find((w) => w.id !== G);
    assert.ok(N, `the fixture is live: the narrowed gap authoring (${show(gapItems(fx.home, p).map((w) => [w.id, w.status]))})`);
    fx.scripted.script(N.id, [gapScript(['R2.2']), gapScript(['R2.2'])]);
    await resumeProject(fx.engine, p);
    const run = await pump(fx, p, () => runsOn(fx.home, N.id).find((r) => r.state === 'ended'), { answer: CHECK_KINDS, max: 40, what: 'the narrowed authoring run' });
    const F = findingsOfProject(fx.home, p).find((f) => f.source_run === run.id && f.criterion === 'R2.2');
    assert.ok(F, `the fixture is live: its Verifier's finding on R2.2 recorded (${show(findingsOfProject(fx.home, p).map((f) => [f.id, f.criterion, f.scope]))})`);
    const sibling = await pump(fx, p, () => laterCandidate(fx, p, J.c1, ['stage', 'phase', 'alpha_authorize']) ?? undefined, { answer: CHECK_KINDS, max: 60, what: "a candidate of phase 2's plan evaluated" });
    await tick(fx.engine, p, { rounds: 2 });
    Object.assign(S, { ...J, plan2, N, run, F, sibling });
  });
  after(() => shared.cleanup());

  test('(a) N\'s finding is stored scope candidate, candidate c1, and never names a gate of the sibling built under phase 2\'s plan', () => {
    const { fx, c1, F, sibling } = S;
    const f = findingRow(fx.home, F.id);
    assert.deepEqual([f.scope, f.candidate, f.subject_id], ['candidate', c1.id, c1.id], `stored scope candidate on c1, the candidate N's evidence names (${show([f.scope, f.candidate, f.subject_id])})`);
    assert.deepEqual([f.status, f.effective_severity], ['open', 'high'], 'the fixture is live: open and high (it would block wherever it applied)');
    const evals = evalsOf(fx.home, sibling.id);
    const naming = evals.filter((e) => names(e, F.id));
    assert.deepEqual(naming.map((e) => [e.gate_kind, e.outcome]), [], `it does not apply to ${sibling.id}, built under phase 2's plan (its evaluations: ${show(evals.map((e) => [e.gate_kind, e.outcome, e.reasons]))})`);
  });

  test('(g) the base reproduction: the finding is not normalized to project scope (findings.ts:184)', () => {
    const { fx, F } = S;
    const raised = raisedOf(fx.home, F.id);
    assert.ok(raised, 'its finding.raised event');
    assert.notEqual(findingRow(fx.home, F.id).scope, 'project', 'not stored at project scope');
    assert.ok(!show(raised.payload).includes('no_source_candidate'), `not normalized as from a run naming no candidate (${show(raised.payload)})`);
  });
});

describe('M643 (b), (c) missing coverage binds to its plan and spec revision; a project finding stays project', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const J = await oldAlphaRefused(shared.context, { name: 'M643 b', port: 18644 });
    const { fx, p, two } = J;
    kindNext(fx, 'check_authoring', [reportingAuthoring(), reportingAuthoring()], reportingAuthoring());
    const plan2 = await publishPaused(J);
    await resumeProject(fx.engine, p);
    const run = await pump(fx, p, () => runsOn(fx.home, plan2.check_authoring).find((r) => r.state === 'ended'), { answer: CHECK_KINDS, max: 40, what: "phase 2's own authoring run" });
    const mine = findingsOfProject(fx.home, p).filter((f) => f.source_run === run.id);
    const Fp = mine.find((f) => f.message === COVERAGE);
    const Fx = mine.find((f) => f.message === ACROSS);
    assert.ok(Fp && Fx, `the fixture is live: both findings recorded (${show(mine.map((f) => [f.id, f.scope, f.message.slice(0, 40)]))})`);
    Object.assign(S, { ...J, plan2, run, Fp, Fx, spec2: iterationRow(fx.home, two).brief_spec_revision });
  });
  after(() => shared.cleanup());

  test("(b) stored scope plan, bound to phase 2's plan and the approved spec revision; it blocks a phase or Alpha gate of that plan's candidate; the plan abandoned, it is closed plan_replaced", async () => {
    const { fx, p, two, c1, plan2, Fp, spec2 } = S;
    const f = findingRow(fx.home, Fp.id);
    assert.equal(f.scope, 'plan', `stored scope plan (${f.scope})`);
    assert.equal(f.bound_plan, plan2.id, `bound to phase 2's plan ${plan2.id} (${show(f.bound_plan)})`);
    assert.ok(spec2, 'the fixture is live: iteration 2 records its brief spec revision');
    assert.equal(f.bound_spec_revision, spec2, `bound to the approved spec revision ${spec2} (${show(f.bound_spec_revision)})`);
    const blocked = await pump(
      fx,
      p,
      () => {
        const c = laterCandidate(fx, p, c1, ['phase', 'alpha_authorize']);
        const e = c && evalsOf(fx.home, c.id).find((x) => ['phase', 'alpha_authorize'].includes(x.gate_kind) && x.outcome !== 'satisfied' && names(x, Fp.id));
        return e ? { c, e } : undefined;
      },
      { answer: CHECK_KINDS, max: 60, what: "a phase or Alpha gate of phase 2's candidate held by the plan finding" },
    );
    assert.ok(blocked.e, `it blocks ${blocked.e.gate_kind} of ${blocked.c.id}`);
    await confirmed(fx, `/v1/projects/${p}/iterations/${two}/discard`);
    await tick(fx.engine, p, { rounds: 3 });
    const closed = findingRow(fx.home, Fp.id);
    assert.notEqual(closed.status, 'open', `closed once the plan is abandoned (${closed.status})`);
    const why = eventsAbout(fx.home, Fp.id).filter((e) => show(e.payload).includes('plan_replaced'));
    assert.ok(why.length > 0, `an event about it names plan_replaced (${show(eventsAbout(fx.home, Fp.id).map((e) => [e.type, e.payload]))})`);
    const closedSeq = why[0].seq;
    const later = rows(fx.home, 'SELECT "id", "reasons" FROM "gate_evaluations" WHERE "project" = ? AND "seq" > ?', p, closedSeq).filter((e) => names(e, Fp.id));
    assert.deepEqual(later.map((e) => e.id), [], 'no evaluation after its closure names it');
  });

  test('(c) the finding reported scope project keeps project scope, its stated reason recorded, not re-scoped', () => {
    const { fx, Fx } = S;
    const f = findingRow(fx.home, Fx.id);
    assert.deepEqual([f.scope, f.candidate], ['project', null], `project scope kept (${show([f.scope, f.candidate])})`);
    assert.equal(f.message, ACROSS, "the role's stated reason recorded");
    const raised = raisedOf(fx.home, Fx.id);
    assert.ok(raised && !('normalized' in (raised.payload ?? {})), `not re-scoped (${show(raised?.payload)})`);
  });
});

// The replan parks while G waits. `plans`: iteration 2's replan launches.
async function parkedReplan(t, name, port, plans) {
  const J = await oldAlphaRefused(t, { name, port, approval: true });
  const { fx, p, R, G } = J;
  kindNext(fx, 'replan', [fail(), fail(), ...plans], approvalPlan());
  await resumeProject(fx.engine, p);
  await pump(fx, p, () => (itemRow(fx.home, R).status === 'parked' ? true : undefined), { max: 20, what: "iteration 2's replan parked after its repair" });
  const blocker = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'blocker' && d.subject_id === R);
  assert.ok(blocker, 'the fixture is live: the blocker question about the replan is open');
  assert.deepEqual(runsOn(fx.home, G), [], 'the fixture is live: G never dispatched');
  return { ...J, blocker };
}
const servedG = async (fx, p, G) => (await workRead(fx, p)).find((w) => w.id === G);
function assertHeldBy(w, { replan, status, decision }, what) {
  const h = w?.held_by;
  assert.ok(h, `${what}: the work read serves held_by on G (${show(w)})`);
  assert.equal(h.replan, replan, `${what}: naming the replan ${replan} (${show(h)})`);
  assert.equal(h.status, status, `${what}: its status ${status}`);
  if (decision !== undefined) assert.equal(h.decision, decision, `${what}: and its decision ${decision}`);
}
function assertRetired(J, plan, extra = []) {
  const { fx, G } = J;
  const w = itemRow(fx.home, G);
  const from = fromItem(fx.home, G);
  assert.deepEqual(from.runs, [], `no run on G (${show([w.status, w.end_cause])})`);
  assert.deepEqual([w.status, w.end_cause], ['cancelled', 'superseded'], 'G cancelled, end_cause superseded');
  const events = cancelledOf(fx.home, G);
  assert.equal(events.length, 1, 'one work.cancelled');
  const reason = events[0].payload?.reason ?? '';
  for (const n of [...(plan ? [plan.id, plan.check_authoring] : []), ...extra]) assert.ok(n && reason.includes(n), `the reason names ${n}: ${reason}`);
  assert.deepEqual([from.findings, from.decisions], [[], []], 'nothing from G');
}

describe('M643 (d), (e), (f) a parked replan holds the dependent gap authoring until the plan resolves', () => {
  test('(d) at once: held_by in the work read and NOW, the blocker evidence lists G; (e) 48 h with ticks: still held, zero runs; (f) retried and approved: G retired', { timeout: 900_000 }, async (t) => {
    const J = await parkedReplan(t, 'M643 d', 18645, [approvalPlan()]);
    const { fx, p, R, G, blocker } = J;
    assertHeldBy(await servedG(fx, p, G), { replan: R, status: 'parked', decision: blocker.id }, '(d)');
    const project = (await ok(fx.engine.get(`/v1/projects/${p}`), 200, 'GET /v1/projects/:p')).project;
    const inNow = objectsWhere(project.now, (o) => o.replan === R && o.status === 'parked');
    assert.ok(inNow.length > 0, `(d) NOW names the dependency (${show(project.now)})`);
    const d = await decisionRead(fx, p, blocker.id);
    assert.ok(show(d).includes(G), `(d) the blocker question's evidence lists G ${G} (${show(d).slice(0, 3000)})`);
    // (e)
    await advanceTicking(fx, p, 48 * 3600, 6 * 3600);
    assert.deepEqual(runsOn(fx.home, G), [], '(e) 48 h later: zero runs on G');
    assert.ok(!['cancelled', 'complete'].includes(itemRow(fx.home, G).status), `(e) G still waits (${itemRow(fx.home, G).status})`);
    assertHeldBy(await servedG(fx, p, G), { replan: R, status: 'parked' }, '(e)');
    // (f) retried, its plan approved.
    const res = await answer(fx, p, blocker, 'retry');
    assert.equal(res.status, 200, `the owner retries the replan (→ ${res.status} ${res.text})`);
    const plan2 = await untilPublished(fx, p, { approve: true, rounds: 30 });
    assert.ok(plan2, '(f) the retried replan published once approved');
    for (let i = 0; i < 6 && itemRow(fx.home, G).status !== 'cancelled'; i++) await tick(fx.engine, p, { rounds: 1 });
    assertRetired(J, plan2);
  });

  test('(f) the plan rejected and replaced by the next replan: still held, naming the replacement; retired against its plan', { timeout: 900_000 }, async (t) => {
    const J = await parkedReplan(t, 'M643 f2', 18646, [approvalPlan(), approvalPlan()]);
    const { fx, p, R, G, blocker } = J;
    assert.equal((await answer(fx, p, blocker, 'retry')).status, 200, 'the owner retries the replan');
    const pa = await pump(fx, p, async () => (await openDecisionsRead(fx, p)).find((d) => d.kind === 'plan_approval'), { max: 30, what: 'the retried plan awaiting approval' });
    assert.equal((await answer(fx, p, pa, 'reject')).status, 200, 'the owner rejects the plan');
    await tick(fx.engine, p, { rounds: 1 });
    const R2 = rows(fx.home, `SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "id" <> ? ORDER BY "seq" DESC`, p, R)[0]?.id;
    assert.ok(R2, 'the fixture is live: the next replan generation, the replacement');
    assertHeldBy(await servedG(fx, p, G), { replan: R2, status: itemRow(fx.home, R2).status }, '(f) replaced');
    assert.deepEqual(runsOn(fx.home, G), [], '(f) G not dispatched');
    const plan2 = await untilPublished(fx, p, { approve: true, rounds: 30 });
    assert.ok(plan2, "the replacement's plan published once approved");
    for (let i = 0; i < 6 && itemRow(fx.home, G).status !== 'cancelled'; i++) await tick(fx.engine, p, { rounds: 1 });
    assertRetired(J, plan2);
  });

  test('(f) the iteration discarded (the plan abandoned): G cancelled superseded, reason plan_abandoned, never dispatched', { timeout: 900_000 }, async (t) => {
    const J = await parkedReplan(t, 'M643 f3', 18647, []);
    const { fx, p, two, G } = J;
    await confirmed(fx, `/v1/projects/${p}/iterations/${two}/discard`);
    for (let i = 0; i < 6 && itemRow(fx.home, G).status !== 'cancelled'; i++) await tick(fx.engine, p, { rounds: 1 });
    await tick(fx.engine, p, { rounds: 2 });
    assertRetired(J, null, ['plan_abandoned']);
  });
});
