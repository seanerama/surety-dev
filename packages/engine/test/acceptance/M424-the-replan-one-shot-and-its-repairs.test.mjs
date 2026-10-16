// M424, the replan one-shot and its repairs (slice 34; kernel lane). M5
// plan §3.4 M424 (a) to (e); D6-A04, D6-A05; D6 §3.5, §5.6; Q2; reading 3;
// B02, B03; the driver's rulings (2026-10-13: one automatic repair, then a
// blocker offering `retry` and `cancel` whose question names the Architect
// session route); SEAM.md §§350, 352, 403. (f) is
// `M424-a-replan-under-a-moving-baseline`.
//
// (a) at phase 1's completion `replan` is dispatched as an Architect one-shot
//     (no session) under `deadline_architect`: running just before it,
//     `timed_out` / `deadline` past it;
// (b) its package: the approved spec and index, the ADR, the roadmap and
//     module map, the completed plan with each stage's `integrated_revision`,
//     the phase evaluation, findings, deferrals and objections (a Builder's
//     objection among them), the generation; never the first Architect
//     session's transcript;
// (c) a refused plan (R9, which the spec lacks): the run `failed` /
//     `invalid_result` naming the reason, its `plan_checks` row `refused`;
// (d) one automatic repair with the reasons in its package, refused again;
//     then a `blocker` on the replan work offering `retry` and `cancel` and
//     naming the Architect session route; a session is admitted beside it;
// (e) the repair counted durably: a restart between the refusal and the
//     repair replenishes nothing (two runs, never three); a manual re-entry
//     (the owner's Architect session) revives nothing: no phase-2 plan
//     published, the proposal `stale` or `refused` with its refusal evidence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CONTRACT } from './harness/fixtures.mjs';
import { builderScript, evaluationsOfKind, planChecks, planOfPhase, readPlan, specRevisions, stagesOfPlan } from './harness/journey/drive.mjs';
import { ADR_001 } from './harness/journey/reference.mjs';
import { UNKNOWN_KEY, replanDumpedAndHeld, replanRuns, replanUnknownRequirement, untilReplanHolds } from './harness/journey/replan34.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { fileAt, refOid } from './harness/repos.mjs';
import { advanceClockInSteps, decisionsAbout, pauseProject, resumeProject, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { closeSession, openSession, packageOf, say, scriptTurns, turnThatSays } from './harness/sessions.mjs';
import { withStore } from './harness/store.mjs';

const DEADLINE = CONTRACT.project.deadline_architect.default;
// Clock steps well inside the default lease TTL; the held replan heartbeats (as M15's).
const CLOCK = { stepSeconds: Math.floor(CONTRACT.engine.lease_ttl.default / 2), pauseMs: 1200 };
// What the first Architect session said and was told (drive.mjs's architectSession).
const SESSION_TEXTS = ['Design Tally from the approved specification and plan phase 1.', 'Architecture, module map, one ADR, the roadmap and the plan for phase 1.'];
const OBJECTION = { check: 'accept-r2', criterion: 'R2.1', category: 'contract_conflict', message: 'M424-objection: R2.1 does not say the content type' };
// The replan package's files (the Builder's design, SEAM.md §403), by name without extension.
const PACKAGE_FILES = ['spec', 'index', 'roadmap', 'module_map', 'plan', 'evaluation', 'findings', 'deferrals', 'objections', 'generation'];
const byName = (pkg) => Object.fromEntries(Object.entries(pkg ?? {}).map(([path, text]) => [path.split('/').at(-1).replace(/\.[^.]*$/, ''), text]));

describe('M424 the replan one-shot and its repairs', () => {
  test('(a) the replan an Architect one-shot under deadline_architect; (b) its package from durable records, never the session\'s transcript', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    // Stage 2's Builder files an objection (the check passes; filing alone triggers nothing).
    fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2, { objections: [OBJECTION] }), builderScript(3), builderScript(4)]);
    fx.scripted.kindScript('replan', [replanDumpedAndHeld()]);
    const launch = await untilReplanHolds(fx, ctx);
    const [run] = replanRuns(fx.home, p.id);
    assert.ok(run, 'a replan run exists');
    assert.equal(run.id, launch.run, 'the held launch is its run');
    // (a) a one-shot of the Architect.
    assert.equal(run.role, 'architect', 'the Architect');
    assert.notEqual(run.kind, 'session', `a one-shot run, not a session (${run.kind})`);
    assert.equal(run.session_state ?? null, null, 'with no session state');
    // (b) the package.
    const pkg = packageOf(fx, run.id);
    assert.ok(pkg, 'the replan dumped its package');
    const files = byName(pkg);
    for (const name of PACKAGE_FILES) assert.ok(typeof files[name] === 'string', `the package holds ${name} (files: ${Object.keys(pkg).join(', ')})`);
    const plan = planOfPhase(fx.home, p.id, 1)[0];
    const [spec] = specRevisions(fx.home, p.id);
    const specText = fileAt(p.repo.path, refOid(p.repo.path, p.repo.ref), '.surety/spec/spec.md');
    assert.ok(files.spec.includes('### R1. Sum two numbers') && files.spec.includes('R4.1'), 'the approved specification');
    assert.ok(specText.includes(files.spec.split('\n').find((l) => l.startsWith('### R2')) ?? '\u0000'), 'as the integration branch holds it');
    assert.ok(files.index.includes('R2.2'), 'the index');
    assert.ok(Object.values(pkg).some((x) => typeof x === 'string' && x.includes(ADR_001.split('\n').find((l) => l.includes('Node')) ?? '\u0000')), 'every ADR');
    assert.ok(files.roadmap.includes('count the sums and show the stats'), 'the roadmap');
    assert.ok(files.module_map.includes('sum-route'), 'the module map');
    for (const s of stagesOfPlan(fx.home, plan.id)) {
      assert.match(s.integrated_revision ?? '', /^[0-9a-f]{40}$/, `stage ${s.number} integrated`);
      assert.ok(files.plan.includes(s.integrated_revision), `the completed plan names stage ${s.number}'s integrated_revision`);
    }
    const phaseEval = evaluationsOfKind(fx.home, p.id, 'phase').at(-1);
    assert.ok(phaseEval && files.evaluation.includes(phaseEval.id), `the phase evaluation (${phaseEval?.id})`);
    assert.ok(files.objections.includes('M424-objection'), 'the open objection');
    assert.ok(files.generation.includes(String(plan.generation)) && files.generation.includes(String(spec.version)), 'the generation the package belongs to');
    for (const said of SESSION_TEXTS) {
      assert.ok(!Object.values(pkg).some((x) => typeof x === 'string' && x.includes(said)), `the session's transcript is not in the package ("${said}")`);
    }
    // (a) deadline_architect: running just before it, timed out past it.
    await advanceClockInSteps(fx.engine, DEADLINE - 60, CLOCK);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.notEqual(replanRuns(fx.home, p.id)[0].state, 'ended', 'still running a minute before deadline_architect');
    await advanceClockInSteps(fx.engine, 120, CLOCK);
    const ended = await tickUntil(fx.engine, p.id, () => (replanRuns(fx.home, p.id)[0].state === 'ended' ? replanRuns(fx.home, p.id)[0] : undefined), { max: 6, what: 'the replan to end past deadline_architect' });
    assert.deepEqual([ended.outcome, ended.reason_class], ['timed_out', 'deadline'], 'timed out by deadline_architect');
  });

  test('(c) a refused plan fails invalid_result naming the reason; (d) one repair with the reasons in its package, then a blocker offering retry and cancel and naming the session route; (e) a restart replenishes nothing; a manual re-entry revives nothing', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    // The first replan holds (heartbeating) before it writes, so the restart
    // can be placed between its refusal and the repair (objection 120; SEAM
    // §469): under K1 the refused run's end requests the tick that dispatches
    // the repair, so the project is paused before the run is released, and
    // dispatches nothing until it is resumed after the restart (D1 §8.4).
    const held = replanUnknownRequirement();
    fx.scripted.kindScript('replan', [{ ...held, steps: [step.hold('gate', { heartbeat_ms: 250 }), ...held.steps] }, replanUnknownRequirement({ dump: true }), replanUnknownRequirement(), replanUnknownRequirement()]);
    await untilReplanHolds(fx, ctx);
    assert.ok(planOfPhase(fx.home, p.id, 1).some((x) => (x.active === 1 || x.active === true) && x.completed_at), 'the fixture is live: phase 1 completed before the replan');
    await pauseProject(fx.engine, p.id);
    fx.scripted.release('all');
    // (c) the first run refused.
    const first = await tickUntil(fx.engine, p.id, () => replanRuns(fx.home, p.id).find((r) => r.state === 'ended'), { max: 6, what: 'the first replan run to end' });
    assert.deepEqual([first.outcome, first.reason_class], ['failed', 'invalid_result'], `the refused plan fails the run (${first.reason_text})`);
    assert.match(first.reason_text ?? '', /PLAN_UNKNOWN_REQUIREMENT/, 'naming the reason');
    assert.ok((first.reason_text ?? '').includes(UNKNOWN_KEY), `and its subject ${UNKNOWN_KEY}`);
    const refusedCheck = planChecks(fx.home, p.id).find((c) => c.outcome === 'refused' && JSON.stringify(c.reasons).includes('PLAN_UNKNOWN_REQUIREMENT'));
    assert.ok(refusedCheck, `a plan_checks row records the refusal (${JSON.stringify(planChecks(fx.home, p.id).map((c) => [c.outcome, c.reasons]))})`);
    assert.equal(replanRuns(fx.home, p.id).length, 1, 'the fixture is live: the repair is not yet dispatched (the project is paused)');
    // (e) a restart between the refusal and the repair.
    await fx.engine.kill();
    await fx.start();
    await resumeProject(fx.engine, p.id);
    // (d) the repair, refused again, then the blocker.
    const item = replanRuns(fx.home, p.id)[0].work_item;
    const blocker = await tickUntil(fx.engine, p.id, () => decisionsAbout(fx.home, item, 'blocker').find((d) => d.status === 'open'), { max: 12, what: 'the blocker on the replan work' });
    const runs = replanRuns(fx.home, p.id);
    assert.equal(runs.length, 2, `one automatic repair: two runs in all, the restart replenishing nothing (${runs.map((r) => [r.outcome, r.reason_class]).join(' ')})`);
    assert.deepEqual([runs[1].outcome, runs[1].reason_class], ['failed', 'invalid_result'], 'the repair refused too');
    const repairPkg = packageOf(fx, runs[1].id);
    assert.ok(repairPkg, 'the repair dumped its package');
    assert.ok(Object.values(repairPkg).some((x) => typeof x === 'string' && x.includes('PLAN_UNKNOWN_REQUIREMENT') && x.includes(UNKNOWN_KEY)), `the repair's package carries the reasons (files: ${Object.keys(repairPkg).join(', ')})`);
    const options = JSON.parse(blocker.options).map((o) => o.key);
    for (const o of ['retry', 'cancel']) assert.ok(options.includes(o), `the blocker offers ${o} (${JSON.stringify(options)})`);
    assert.match(JSON.stringify(blocker), /sessions?\b[^"]*architect|architect[^"]*sessions?/i, 'its question names the Architect session route');
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(replanRuns(fx.home, p.id).length, 2, 'no third run after more ticks');
    // (e) a manual re-entry: the owner's Architect session, which changes nothing.
    const session = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, session.id, [turnThatSays('I read the refused plan.')]);
    await say(fx, p.id, session.id, 'Look at the refused plan.');
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${session.id}/close`, {});
    if (closed.status !== 200) await closeSession(fx, p.id, session.id, { refuse: true });
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(planOfPhase(fx.home, p.id, 2).filter((x) => x.published_at).length, 0, 'no phase-2 plan published: the refused proposal is not revived');
    const read = await readPlan(fx, p.id);
    const phaseTwo = (read.proposals ?? []).filter((x) => x.phase === 2);
    assert.ok(phaseTwo.length > 0, `the refused proposal is listed (${JSON.stringify(read.proposals)})`);
    for (const x of phaseTwo) assert.ok(['stale', 'refused'].includes(x.status), `a phase-2 proposal is stale or refused, never ${x.status}`);
    const still = withStore(fx.home, (db) => db.prepare('SELECT "outcome", "reasons" FROM "plan_checks" WHERE "id" = ?').get(refusedCheck.id));
    assert.equal(still.outcome, 'refused', 'its refusal evidence kept');
    assert.match(still.reasons, /PLAN_UNKNOWN_REQUIREMENT/);
  });
});
