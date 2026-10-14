// M405, the plan published atomically, by the authorized finalizer only
// (slice 31a; kernel lane). M5 plan §3.1 M405; D6-P06, D6-A06 in part; D6
// §5.5; K4; B02, B08; D1 §7.8; SEAM.md §347.
//
// (a) a committed and approved plan's finalizer: in one transaction after the
//     authority check, the `phase_plans` row (generation 1, active), the
//     `stages` with `depends_on` resolved and `validation`, the planned
//     obligations record, one `stage_build` per stage from the trigger
//     (plan, <stage>, 1) depending on its stages' stage-code milestone and on
//     the phase's authoring readiness, the `check_authoring` item from
//     (phase_plan, <plan>, 1); `plan.published`; nothing else creates stage work;
// (b) a kill between the approval's consumption and its effect, then recovery:
//     published exactly once, no duplicate work;
// (c) a plan for phase 3 while phase 1 is open: `phase_not_next`; a second
//     plan for the open phase outside the replacement route: refused
//     `plan_generation_stale`;
// (d) `installFixturePlan` as a labelled caller of the production
//     `registerPlan`: the fixture's rows labelled, the production path's not;
// (e) a checkpoint carrying a plan with no approval: nothing published, no
//     work, the plan `proposed`; `finalizeIntegration` registers nothing;
// (f) two Architect proposals committed for one phase: at most one published,
//     replaying each finalizer changes nothing; one active generation, no
//     duplicate work.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { answer } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { installGatedPlan } from './harness/gates.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { armBarrier, eventsOfType } from './harness/journal.mjs';
import {
  NOTHING,
  activePlan,
  architectSession,
  createWithIdea,
  eventsAbout,
  nothingPublished,
  phasePlansOf,
  readPlan,
  recordOf,
  specSession,
  stagesOfPlan,
  visionSession,
  waitPublished,
  workOf,
} from './harness/journey/drive.mjs';
import { STAGES, architectFiles, phasePlan } from './harness/journey/reference.mjs';
import { authoringScript } from './harness/journey/drive.mjs';
import { refOid } from './harness/repos.mjs';
import { scriptedEngine, tick, waitForIdle } from './harness/runs.mjs';
import { closeRefused, closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatWrites } from './harness/sessions.mjs';
import { waitFor } from './harness/engine.mjs';
import { withStore } from './harness/store.mjs';

async function readyForArchitect(fx) {
  const p = await createWithIdea(fx);
  await visionSession(fx, p.id);
  await specSession(fx, p.id);
  return p;
}

const stageWork = (home, project) => workOf(home, project, 'stage_build');
const authoringWork = (home, project) => workOf(home, project, 'check_authoring');

// The one publication, read whole: {plan, stages, builds, authoring}.
function publication(home, project) {
  const plan = activePlan(home, project);
  return { plan, stages: plan ? stagesOfPlan(home, plan.id) : [], builds: stageWork(home, project), authoring: authoringWork(home, project), events: eventsAbout(home, 'plan.published', project) };
}

function assertOnePublication(home, project, what) {
  const pub = publication(home, project);
  assert.ok(pub.plan, `${what}: a plan is active`);
  assert.deepEqual([phasePlansOf(home, project).length, pub.plan.generation, pub.stages.length, pub.builds.length, pub.authoring.length, pub.events.length], [1, 1, 2, 2, 1, 1], `${what}: one plan, generation 1, two stages, two stage_build items, one check_authoring, one plan.published`);
  return pub;
}

describe('M405 the plan published atomically, by the authorized finalizer only', () => {
  test('(a) the finalizer\'s writes: the plan row, stages with depends_on and validation, the obligations record, stage work from (plan, stage, 1) depending on the milestones, check_authoring from (phase_plan, plan, 1); plan.published; nothing else creates stage work', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo);
    const pub = assertOnePublication(fx.home, p.id, 'after both answers');
    const { plan, stages, builds, authoring } = pub;
    assert.deepEqual([plan.phase_number, plan.generation, Boolean(plan.active), plan.approved_by, plan.routing], [1, 1, true, 'human', 'human'], `the plan row (${JSON.stringify(plan)})`);
    assert.equal(plan.bundle, arch.decisions.architecture_approval.manifest.bundle, 'bound to the approved bundle');
    assert.ok(recordOf(fx.home, plan.planned_obligations), 'the planned obligations record exists');
    assert.ok(plan.published_at, 'published_at');
    const [s1, s2] = stages;
    assert.deepEqual([s1.depends_on, s2.depends_on], [[], [s1.id]], 'depends_on resolved to stage ids');
    assert.deepEqual(s2.validation, STAGES[1][1].validation, 'validation as proposed');
    assert.deepEqual(s2.tasks, STAGES[1][1].tasks);
    const byStage = Object.fromEntries(builds.map((w) => [w.subject?.stage, w]));
    for (const s of stages) {
      const w = byStage[s.id];
      assert.ok(w, `stage ${s.number} has its stage_build`);
      assert.deepEqual([w.trigger_source, w.trigger_id, w.trigger_generation], ['plan', s.id, 1], `from the trigger (plan, stage ${s.number}, 1)`);
      assert.equal(w.id, s.work_item, 'and the stage names it');
    }
    const milestones = (w) => (w.depends_on ?? []).map((d) => (typeof d === 'string' ? { id: d } : d));
    assert.ok(milestones(byStage[s1.id]).some((d) => d.milestone === 'authoring_ready' && d.phase_plan === plan.id), `stage 1 depends on the phase's authoring readiness (${JSON.stringify(byStage[s1.id].depends_on)})`);
    assert.ok(milestones(byStage[s2.id]).some((d) => d.milestone === 'stage_code' && d.stage === s1.id), `stage 2 depends on stage 1's stage-code milestone (${JSON.stringify(byStage[s2.id].depends_on)})`);
    assert.ok(milestones(byStage[s2.id]).some((d) => d.milestone === 'authoring_ready' && d.phase_plan === plan.id), 'and on the authoring readiness');
    assert.deepEqual([authoring[0].trigger_source, authoring[0].trigger_id, authoring[0].trigger_generation], ['phase_plan', plan.id, 1], 'check_authoring from (phase_plan, plan, 1)');
    assert.equal(stageWork(fx.home, p.id).every((w) => w.status === 'eligible' || w.status === 'held'), true, 'the stage work waits on its milestones');
    // Nothing else creates stage work.
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.equal(stageWork(fx.home, p.id).length, 2, 'no further stage work from ticks');
    const read = await readPlan(fx, p.id);
    assert.deepEqual([read.plan?.id, read.plan?.generation, read.plan?.stages?.length], [plan.id, 1, 2], `the plan read shows it (${JSON.stringify(read.plan)})`);
  });

  test('(b) a kill between the approval\'s consumption and its effect, then recovery: published exactly once, no duplicate work', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const arch = await architectSession(fx, p.id, p.repo, { answer: 'architecture_approval' });
    await armBarrier(fx.engine, 'intent.recorded', 'kill');
    const pending = answer(fx.engine, p.id, arch.decisions.plan_approval, 'approve').catch((err) => err);
    // The engine kills itself at the barrier if the effect is intended there; a
    // publication written in the answer's own transaction never reaches it.
    const died = await waitFor(
      async () => {
        if (!fx.engine.isRunning()) return true;
        await fx.engine.post(`/v1/projects/${p.id}/tick`, {}).catch(() => null);
        return undefined;
      },
      { timeoutMs: 15_000, intervalMs: 300, what: 'the engine to kill itself at intent.recorded' },
    ).catch(() => false);
    await pending;
    if (died) await fx.start();
    await waitPublished(fx, p.id);
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    assertOnePublication(fx.home, p.id, died ? 'after the kill and two recoveries' : 'after two restarts');
    assert.equal(eventsOfType(fx.home, 'plan.published').length, 1, 'one plan.published in the whole store');
  });

  test('(c) a plan for phase 3 while phase 1 is open is phase_not_next; a second plan for the open phase outside the replacement route is plan_generation_stale', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    // Phase 3 before anything is published: not the next phase.
    const three = await architectSession(fx, p.id, p.repo, {
      answer: 'none',
      over: { '.surety/phases/phase-1.json': null, '.surety/phases/phase-1.md': null, '.surety/phases/phase-3.json': phasePlan(3, { revision: refOid(p.repo.path, p.repo.ref), stages: STAGES[2] }), '.surety/phases/phase-3.md': '# Phase 3\n' },
    });
    assertRefused(three.closeRes, 409, 'phase_not_next', 'a plan for phase 3 while phase 1 is open');
    await closeSession(fx, p.id, three.run.id, { refuse: true });
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING);
    // Phase 1 published; then a second plan for phase 1. M5 slice 37 (D6 K1;
    // objection 100; SEAM.md §447): the publication makes phase 1's
    // check_authoring eligible, and its requested tick dispatches it at once,
    // so its Verifier is scripted with phase 1's authoring (a proposal, which
    // goes to the owner as unclassifiable and launches nothing further) and
    // the project is let go idle before the session opens (a one-shot holding
    // the project refuses it session_busy, D6-S08).
    fx.scripted.kindScript('check_authoring', authoringScript(1));
    await architectSession(fx, p.id, p.repo);
    const published = assertOnePublication(fx.home, p.id, 'phase 1');
    await waitFor(
      () => {
        const runs = withStore(fx.home, (db) => db.prepare(`SELECT r."state", w."kind" FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ?`).all(p.id));
        return runs.some((r) => r.kind === 'check_authoring' && r.state === 'ended') && runs.every((r) => r.state === 'ended') ? true : undefined;
      },
      { what: 'phase 1\'s check_authoring run ended and the project idle' },
    );
    const run = await openSession(fx, p.id, 'architect');
    const other = phasePlan(1, { revision: refOid(p.repo.path, p.repo.ref), stages: [{ ...STAGES[1][0], goal: 'the sum library, again' }, STAGES[1][1]] });
    scriptTurns(fx, run.id, [turnThatWrites({ '.surety/phases/phase-1.json': `${JSON.stringify(other, null, 2)}\n` }, { reply: 'Another plan for phase 1.', done: true })]);
    await sayAndSettle(fx, p.id, run.id, 'Replan phase 1.');
    await saveSession(fx, p.id, run.id);
    await closeRefused(fx, p.id, run.id, 409, 'plan_generation_stale');
    await closeSession(fx, p.id, run.id, { refuse: true });
    await tick(fx.engine, p.id, { rounds: 2 });
    const after = assertOnePublication(fx.home, p.id, 'after the refused second plan');
    assert.equal(after.plan.id, published.plan.id, 'the published plan is unchanged');
    assert.equal(after.stages[0].goal, STAGES[1][0].goal, 'and so are its stages');
  });

  test('(d) installFixturePlan is a labelled caller of the production registerPlan: the fixture\'s rows carry the label, the production publication\'s do not; both register stage work from (plan, stage, 1)', async (t) => {
    const fx = await scriptedEngine(t);
    // The fixture's path, as M1 to M4 use it.
    const fixtureProject = await addGitProject(fx, { tier: 'T2' });
    const fixture = await installGatedPlan(fx.engine, fixtureProject.id, { requirements: ['R1'], stages: [{ number: 1, goal: 'the fixture stage', implements: ['R1'] }] });
    const [fixtureRow] = phasePlansOf(fx.home, fixtureProject.id);
    assert.equal(fixtureRow.approved_by, 'test fixture', 'the fixture\'s plan is labelled');
    const fixtureEvents = eventsOfType(fx.home, 'work.created').filter((e) => e.subject?.work_item === fixture.stages[0].work_item);
    assert.ok(fixtureEvents.every((e) => e.payload?.test_fixture === true), `the fixture's work events carry test_fixture (${JSON.stringify(fixtureEvents.map((e) => e.payload))})`);
    const fixtureWork = workOf(fx.home, fixtureProject.id, 'stage_build')[0];
    assert.deepEqual([fixtureWork.trigger_source, fixtureWork.trigger_generation], ['plan', 1], 'the fixture registers through the production trigger');
    // The production path.
    const p = await readyForArchitect(fx);
    await architectSession(fx, p.id, p.repo);
    const pub = assertOnePublication(fx.home, p.id, 'the production publication');
    assert.equal(pub.plan.approved_by, 'human', 'approved by the human, no label');
    const events = [...eventsAbout(fx.home, 'plan.published', p.id), ...eventsOfType(fx.home, 'work.created').filter((e) => pub.builds.some((w) => w.id === e.subject?.work_item))];
    assert.ok(events.length > 0 && events.every((e) => e.payload?.test_fixture !== true), 'no event of the production publication carries the fixture label');
    assert.deepEqual([pub.builds[0].trigger_source, pub.builds[0].trigger_generation], ['plan', 1], 'the same trigger identity');
  });

  test('(e) a checkpoint carrying a plan with no approval: nothing published, no work, the plan proposed; finalizeIntegration registers nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const run = await openSession(fx, p.id, 'architect');
    const files = architectFiles({ revision: refOid(p.repo.path, p.repo.ref) });
    scriptTurns(fx, run.id, [turnThatWrites(files, { reply: 'Saved as a draft.' })]);
    await sayAndSettle(fx, p.id, run.id, 'Draft the plan.');
    const saved = await saveSession(fx, p.id, run.id);
    assert.equal(saved.saved, true);
    await tick(fx.engine, p.id, { rounds: 3 });
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'nothing published, no work');
    const read = await readPlan(fx, p.id);
    assert.equal(read.plan, null, 'no plan');
    assert.ok((read.proposals ?? []).some((x) => x.phase === 1 && x.status === 'proposed'), `the checkpoint's plan is listed proposed (${JSON.stringify(read.proposals)})`);
    assert.deepEqual(eventsAbout(fx.home, 'plan.published', p.id), []);
    await closeSession(fx, p.id, run.id, { refuse: true });
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(nothingPublished(fx.home, p.id), NOTHING, 'and a refused close registers nothing either');
  });

  test('(f) two Architect proposals for one phase: at most one published; replaying each finalizer (the answers again, a restart) changes nothing; one active generation, no duplicate work', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await readyForArchitect(fx);
    const first = await architectSession(fx, p.id, p.repo, { answer: 'none' });
    const second = await architectSession(fx, p.id, p.repo, { answer: 'none', plan: phasePlan(1, { revision: refOid(p.repo.path, p.repo.ref), stages: [{ ...STAGES[1][0], goal: 'the library, second proposal' }, STAGES[1][1]] }) });
    const tryBundle = async (bundle) => {
      const a = await answer(fx.engine, p.id, bundle.decisions.architecture_approval, 'approve');
      if (a.status !== 200) return a;
      return answer(fx.engine, p.id, bundle.decisions.plan_approval, 'approve');
    };
    const r1 = await tryBundle(first);
    let winner = first;
    if (r1.status === 200) {
      await waitPublished(fx, p.id);
      const r2 = await tryBundle(second);
      assertRefused(r2, 409, ['plan_generation_stale', 'decision_stale', 'decision_invalidated'], 'the second proposal');
    } else {
      assertRefused(r1, 409, ['decision_stale', 'decision_invalidated'], 'the first proposal');
      const r2 = await tryBundle(second);
      assert.equal(r2.status, 200, `the second proposal publishes (${r2.text})`);
      await waitPublished(fx, p.id);
      winner = second;
      const again = await tryBundle(first);
      assertRefused(again, 409, ['plan_generation_stale', 'decision_stale', 'decision_invalidated'], 'the first proposal after the second published');
    }
    const pub = assertOnePublication(fx.home, p.id, 'after both proposals');
    assert.equal(pub.stages[0].goal, winner === first ? STAGES[1][0].goal : 'the library, second proposal', 'the published stages are the winner\'s');
    // Replays: the consumed answers again, then a restart.
    for (const row of Object.values(winner.decisions)) assertRefused(await answer(fx.engine, p.id, row, 'approve'), 409, ['decision_consumed', 'decision_stale', 'decision_invalidated'], 'a replayed answer');
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    const after = assertOnePublication(fx.home, p.id, 'after the replays');
    assert.equal(after.plan.id, pub.plan.id);
    assert.deepEqual(after.builds.map((w) => w.id).sort(), pub.builds.map((w) => w.id).sort(), 'the same work items, no duplicate');
  });
});
