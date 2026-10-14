// M428, the phase gate and T1 nomination (slice 35; kernel lane). M5 plan
// §3.5 M428; D6-F01; D6 §5.8; K5; D3 §4.2; reading 8; B06; the driver's
// rulings of 2026-10-13 (the gate route `{phase_plan}`; a roadmap-only
// session moving R3 into the open phase; ordering, not counts); SEAM.md
// §§406, 411.
//
// (a), (b), (f) at T1: no candidate and no execution after one integration;
//     at the completion of building and authoring one candidate by engine
//     cadence, no Builder request; every execution on it registered after
//     the nomination; `verification` work after the registrations; the
//     stage and `phase` evaluations after the last result; completion with
//     no `phase_verification`;
// (c), (h) at T2, phase 2: the `phase`-only check never executed on a stage
//     candidate, executed with the earlier-stage checks on the final
//     candidate; the first `phase` evaluation after their results, none on
//     an earlier candidate; `phase_verification` registered after it;
// (d) the gate route on stage 3's candidate: an evaluation of `phase` whose
//     required set holds R4's check though R4 is not delivered, no
//     completion; a missing or unknown plan is 400 `invalid_value`; then a
//     check that passed on phase 1's candidate fails on phase 2's final one:
//     not satisfied naming it, phase 2 not complete;
// (e) `AUTHORING_INCOMPLETE` naming `stage 2:R2.2` when no protected check
//     covers it (T1); `PLAN_REQUIREMENT_UNPLANNED` naming `phase 1:R3` after
//     the owner approves a roadmap moving R3 into the open phase 1, which
//     then does not complete;
// (g) M3's `unsupported` case for the gate route replaced (M44's straddle).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { recordExit } from './harness/checks/selection.mjs';
import { consume, decision } from './harness/decisions.mjs';
import { evaluationsOf, scopeOf } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import {
  ROUTED_KINDS,
  candidatesOfProject,
  checkRows,
  evaluationsOfKind,
  executionsOf,
  nextPhasePublished,
  openDecisions,
  phaseCompleted,
  planOfPhase,
  pump,
  queuedExecutions,
  runsOfProject,
  stagesOfPlan,
  workOf,
} from './harness/journey/drive.mjs';
import { journey35, phaseOf, roadmapWith } from './harness/journey/plan35.mjs';
import { authoringFiles } from './harness/journey/reference.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { answer } from './harness/decisions.mjs';
import { tick } from './harness/runs.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { step } from './harness/scripted.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { withStore } from './harness/store.mjs';

const active = (p) => (p.active === 1 || p.active === true);
// The seq of the first and last event of `type` that names any of `ids`.
function seqs(home, type, ids) {
  const list = eventsOfType(home, type).filter((e) => ids.some((id) => JSON.stringify(e).includes(id))).map((e) => e.seq);
  return { first: list.length ? Math.min(...list) : null, last: list.length ? Math.max(...list) : null, count: list.length };
}
const keyIds = (home, project, key) => checkRows(home, project).filter((c) => c.key === key).map((c) => c.id);
const gateRoute = (fx, project, candidate, body) => fx.engine.post(`/v1/projects/${project}/candidates/${candidate}/gates/phase`, body);

describe('M428 the phase gate and T1 nomination', () => {
  test('(a), (b), (f) T1: one integration nominates nothing; at the completion of building one candidate by engine cadence, its checks registered and run, verification, then the stage and phase evaluations; complete with no phase_verification', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1' });
    let ordinary = null;
    const done = await pump(fx, ctx, () => {
      const stages = stagesOfPlan(fx.home, plan.id);
      if (!ordinary && stages[0].status === 'integrated' && !['integrated', 'verified'].includes(stages[1].status)) {
        ordinary = { candidates: candidatesOfProject(fx.home, p.id).length, executions: executionsCount(fx, p.id) };
      }
      return planOfPhase(fx.home, p.id, 1).find((x) => active(x) && x.completed_at);
    }, { what: 'phase 1 to complete at T1', max: 160 });
    assert.deepEqual(ordinary, { candidates: 0, executions: 0 }, '(f) an ordinary T1 integration: no candidate, no execution');
    const [c] = candidatesOfProject(fx.home, p.id);
    assert.equal(candidatesOfProject(fx.home, p.id).length, 1, 'one candidate for the phase');
    assert.equal(c.nominated_by, 'engine_cadence', 'by engine cadence');
    const builderRequests = fx.scripted.launches({ work_kind: 'stage_build' }).length;
    assert.ok(builderRequests >= 2, 'the Builders ran, none asking for a nomination (the journey\'s scripts)');
    const ready = eventsOfType(fx.home, 'phase.authoring_ready').filter((e) => JSON.stringify(e).includes(plan.id)).map((e) => e.seq);
    const nominated = seqs(fx.home, 'candidate.nominated', [c.id]);
    assert.ok(ready.length && nominated.first > Math.max(...ready), 'nominated after authoring readiness');
    const xs = executionsOf(fx.home, c.id).map((x) => x.id);
    const registered = seqs(fx.home, 'check.registered', xs);
    const results = seqs(fx.home, 'check.result', xs);
    assert.ok(registered.count > 0 && registered.first > nominated.first, `every execution registered after the nomination (${JSON.stringify({ nominated, registered })})`);
    const verification = workOf(fx.home, p.id, 'verification').filter((w) => JSON.stringify(w.subject ?? {}).includes(c.id)).map((w) => w.id);
    assert.ok(verification.length > 0, 'verification work for the candidate');
    // Dispatched: the first event naming a run of that work.
    const vRuns = runsOfProject(fx.home, p.id).filter((r) => verification.includes(r.work_item)).map((r) => r.id);
    assert.ok(vRuns.length > 0, 'a Verifier dispatched');
    const vDispatched = Math.min(...vRuns.map((id) => withStore(fx.home, (db) => db.prepare('SELECT MIN("seq") AS s FROM "events" WHERE "subject" LIKE ? OR "payload" LIKE ?').get(`%${id}%`, `%${id}%`).s ?? Infinity)));
    assert.ok(vDispatched > registered.last, `the Verifier dispatched after the registrations (${JSON.stringify({ vDispatched, registered })})`);
    const evaluations = [...evaluationsOf(fx.home, c.id, 'stage'), ...evaluationsOf(fx.home, c.id, 'phase')].map((e) => e.id);
    const evaluated = seqs(fx.home, 'gate.evaluated', evaluations);
    assert.ok(evaluated.first > results.last, `the stage and phase evaluations after the last result (${JSON.stringify({ evaluated, results })})`);
    assert.ok(evaluationsOf(fx.home, c.id, 'phase').some((e) => e.outcome === 'satisfied'), 'the phase gate satisfied on that candidate');
    assert.deepEqual(workOf(fx.home, p.id, 'phase_verification'), [], 'no phase_verification at T1 (the driver\'s ruling)');
    assert.ok(done.completed_at);
  });

  test('(c), (h) T2 phase 2: the phase-only check only on the final candidate, with the earlier-stage checks; the first phase evaluation after their results; none on an earlier candidate; phase_verification after it', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    const done1 = await phaseCompleted(fx, ctx, 1);
    const plan2 = await nextPhasePublished(fx, ctx, 2);
    const done = await phaseCompleted(fx, ctx, 2);
    const final = done.completion_binding.candidate;
    const seq1 = candidatesOfProject(fx.home, p.id).find((c) => c.id === done1.completion_binding.candidate).seq;
    const phase2Candidates = candidatesOfProject(fx.home, p.id).filter((c) => c.seq > seq1).map((c) => c.id);
    assert.ok(phase2Candidates.length >= 2, `stage candidates and the final one in phase 2 (${phase2Candidates.length})`);
    const regression = keyIds(fx.home, p.id, 'phase-regression');
    for (const c of phase2Candidates.filter((id) => id !== final)) {
      assert.deepEqual(executionsOf(fx.home, c).filter((x) => regression.includes(x.check)).map((x) => x.id), [], `(h) the phase-only check never executed on stage candidate ${c}`);
      assert.deepEqual(evaluationsOf(fx.home, c, 'phase').map((e) => e.id), [], `(c) no phase evaluation on earlier candidate ${c}`);
    }
    const onFinal = executionsOf(fx.home, final);
    const keysOnFinal = new Set(onFinal.map((x) => x.key));
    for (const key of ['phase-regression', 'accept-r1', 'accept-r2', 'accept-r3', 'accept-r4']) assert.ok(keysOnFinal.has(key), `(h) ${key} executed on the final candidate (${[...keysOnFinal].join(', ')})`);
    const phaseResults = seqs(fx.home, 'check.result', onFinal.filter((x) => ['phase-regression', 'accept-r1'].includes(x.key)).map((x) => x.id));
    const phaseEvals = evaluationsOf(fx.home, final, 'phase').map((e) => e.id);
    const firstEval = seqs(fx.home, 'gate.evaluated', phaseEvals);
    assert.ok(firstEval.first > phaseResults.last, `(c) the first phase evaluation after the phase checks' results (${JSON.stringify({ firstEval, phaseResults })})`);
    const pv = workOf(fx.home, p.id, 'phase_verification').filter((w) => JSON.stringify(w).includes(plan2.id) || JSON.stringify(w).includes(final)).map((w) => w.id);
    assert.ok(pv.length > 0, 'phase_verification registered for phase 2');
    assert.ok(seqs(fx.home, 'work.created', pv).first > firstEval.first, 'phase_verification registered after the phase evaluation (the driver\'s ruling)');
  });

  test('(d) the gate route on stage 3\'s candidate: R4\'s check required though R4 is undelivered, no completion; a bad plan 400; then accept-r1, passed on phase 1, failing on phase 2\'s final candidate: not satisfied naming it, phase 2 not complete; (g) the route is no longer unsupported', async (t) => {
    const { fx, p, ctx } = await journey35(t);
    const done1 = await phaseCompleted(fx, ctx, 1);
    const plan2 = await nextPhasePublished(fx, ctx, 2);
    const exits = (x) => (x.key === 'accept-r1' && x.candidate !== done1.completion_binding.candidate ? 1 : 0);
    // Objection 083: stage 3's candidate is the first nominated after phase 1's completion candidate.
    const seq1 = candidatesOfProject(fx.home, p.id).find((c) => c.id === done1.completion_binding.candidate).seq;
    const c3 = await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id).find((c) => c.seq > seq1), { what: 'stage 3\'s candidate', max: 80, exits });
    // (g), (d): the route.
    const res = await gateRoute(fx, p.id, c3.id, { phase_plan: plan2.id });
    assert.equal(res.status, 200, `POST …/gates/phase evaluates (the driver's ruling 2; M3's unsupported replaced) (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.evaluation?.gate_kind, 'phase');
    const scope = scopeOf(fx.home, evaluationsOf(fx.home, c3.id, 'phase').at(-1));
    const r4 = keyIds(fx.home, p.id, 'accept-r4');
    assert.ok(r4.some((id) => scope.required.includes(id)), `R4's check required though R4 is not delivered at stage 3's candidate (D3 §4.2 (b)) (required ${JSON.stringify(scope.required)})`);
    const r1 = keyIds(fx.home, p.id, 'accept-r1');
    assert.ok(r1.some((id) => scope.required.includes(id)), 'and phase 1\'s checks: every required check of this and earlier phases');
    assert.equal(planOfPhase(fx.home, p.id, 2).find(active).completed_at ?? null, null, 'the route completes nothing');
    for (const body of [{}, { phase_plan: 'pp_00000000000000000000000000' }]) {
      const bad = await gateRoute(fx, p.id, c3.id, body);
      assert.equal(bad.status, 400, `${JSON.stringify(body)}: 400 (→ ${bad.status} ${bad.text})`);
      assert.equal(bad.body?.code, 'invalid_value');
    }
    // The final candidate: accept-r1 fails there though it passed on phase 1's.
    const evaluated = await pump(fx, ctx, () => {
      const finals = candidatesOfProject(fx.home, p.id).filter((c) => executionsOf(fx.home, c.id).some((x) => x.key === 'phase-regression' && x.status === 'recorded'));
      return finals.map((c) => evaluationsOf(fx.home, c.id, 'phase').find((e) => e.outcome === 'not_satisfied')).find(Boolean);
    }, { what: 'the phase evaluated on phase 2\'s final candidate', max: 160, exits });
    const reasons = JSON.parse(evaluated.reasons ?? '[]');
    assert.ok(r1.some((id) => JSON.stringify(reasons).includes(id)), `not satisfied naming accept-r1: historical verification counts for nothing (${JSON.stringify(reasons)})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(planOfPhase(fx.home, p.id, 2).find(active).completed_at ?? null, null, 'phase 2 not complete');
  });

  test('(e) AUTHORING_INCOMPLETE naming stage 2:R2.2 when no protected check covers it (T1)', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t, { tier: 'T1' });
    // Phase 1's authoring without `integration`, and accept-r2 covering R2.1 alone.
    const files = { ...authoringFiles(1) };
    delete files['.surety/checks/defs/integration.json'];
    const r2 = JSON.parse(files['.surety/checks/defs/accept-r2.json']);
    files['.surety/checks/defs/accept-r2.json'] = `${JSON.stringify({ ...r2, covers: { criteria: ['R2.1'] } }, null, 2)}\n`;
    fx.scripted.kindScript('check_authoring', [roleThat(Object.entries(files).map(([path, content]) => step.write(path, content)), { proposal: { rationale: 'Phase 1\'s checks, R2.2 left uncovered.', requested_change_kind: 'unclassifiable' } })]);
    const [c] = [await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id)[0], { what: 'the T1 nomination at the completion of building and authoring', max: 120 })];
    const evaluation = await pump(fx, ctx, () => evaluationsOf(fx.home, c.id, 'phase').find((e) => e.outcome === 'not_satisfied'), { what: 'the phase evaluated on the T1 candidate', max: 40 });
    const reasons = JSON.parse(evaluation.reasons ?? '[]');
    const incomplete = reasons.filter((r) => r.code === 'AUTHORING_INCOMPLETE').flatMap((r) => r.subjects ?? []);
    assert.ok(incomplete.includes('stage 2:R2.2'), `AUTHORING_INCOMPLETE naming stage 2:R2.2 (${JSON.stringify(reasons)})`);
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id).completed_at ?? null, null, 'phase 1 not complete');
  });

  test('(e) a roadmap moving R3 into the open phase 1, approved: PLAN_REQUIREMENT_UNPLANNED naming phase 1:R3; phase 1 does not complete', async (t) => {
    const { fx, p, ctx, plan } = await journey35(t);
    // Carry phase 1 until both stages are integrated and no run is under way; leave stage 2's checks queued.
    let session = null;
    for (let i = 0; i < 200 && !session; i++) {
      const stages = stagesOfPlan(fx.home, plan.id);
      const quiet = runsOfProject(fx.home, p.id).every((r) => r.state === 'ended');
      if (stages.every((s) => ['integrated', 'verified'].includes(s.status)) && quiet) {
        const res = await fx.engine.post(`/v1/projects/${p.id}/sessions`, { role: 'architect' });
        if (res.status === 201) session = res.body.run;
        break;
      }
      for (const x of queuedExecutions(fx.home, p.id)) if (executionRow(fx.home, x.id)?.status === 'queued') await recordExit(fx.engine, x.id, 0).catch(() => null);
      for (const d of openDecisions(fx.home, p.id)) if (ROUTED_KINDS.includes(d.kind)) await answer(fx.engine, p.id, d, d.options.some((o) => o.key === 'approve') ? 'approve' : d.options[0].key);
      await tick(fx.engine, p.id, { rounds: 1 });
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(session, 'an Architect session opened after phase 1\'s integrations');
    const roadmap = roadmapWith({ phases: [{ ...phaseOf(1), requirement_ids: ['R1', 'R2', 'R3'] }, { ...phaseOf(2), requirement_ids: ['R4'] }] });
    scriptTurns(fx, session.id, [turnThatWrites({ '.surety/roadmap/roadmap.json': `${JSON.stringify(roadmap, null, 2)}\n` }, { reply: 'R3 moved into phase 1.', done: true })]);
    await sayAndSettle(fx, p.id, session.id, 'Move R3 into phase 1.');
    await saveSession(fx, p.id, session.id);
    const closed = await closeSession(fx, p.id, session.id);
    assert.ok((closed.decisions ?? []).length > 0, `the roadmap change routes to the owner (the driver's ruling 3) (${JSON.stringify(closed)})`);
    for (const d of closed.decisions) await consume(fx, p.id, decision(fx.home, d.id), 'approve');
    const settled = await pump(fx, ctx, () => {
      if (planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id)?.completed_at) return { completed: true };
      const e = evaluationsOfKind(fx.home, p.id, 'phase').find((x) => JSON.stringify(x.reasons ?? []).includes('PLAN_REQUIREMENT_UNPLANNED'));
      return e ? { evaluation: e } : undefined;
    }, { what: 'the phase gate naming the unplanned R3', max: 60 });
    assert.ok(!settled.completed, `phase 1 completed with R3 assigned to it and no stage implementing it (${JSON.stringify(evaluationsOfKind(fx.home, p.id, 'phase').map((e) => [e.outcome, e.reasons]))})`);
    const { evaluation } = settled;
    const subjects = (evaluation.reasons ?? []).filter((r) => r.code === 'PLAN_REQUIREMENT_UNPLANNED').flatMap((r) => r.subjects ?? []);
    assert.ok(subjects.includes('phase 1:R3'), `naming phase 1:R3 (${JSON.stringify(evaluation.reasons)})`);
    await tick(fx.engine, p.id, { rounds: 4 });
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.id === plan.id).completed_at ?? null, null, 'phase 1 does not complete until a replan covers R3');
  });
});

function executionsCount(fx, project) {
  return candidatesOfProject(fx.home, project).reduce((n, c) => n + executionsOf(fx.home, c.id).length, 0);
}
