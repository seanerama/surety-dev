// The project-lane journey of row M401, in two files (SEAM.md §357): the
// shared fixture. File 1 (`M401-the-journey-from-an-idea-to-phase-two`) runs
// D6 §1 steps 1 to 9 on the project lane; file 2
// (`M401-the-journey-from-phase-two-to-alpha`) reaches the same point on the
// kernel lane's production path in the same home, restarts that home on the
// project lane, and runs steps 10 to 12 and the end there. Both reach every
// state through the owner's routes and the engine's transitions; neither
// installs a plan, candidate, phase check, readiness or authorization by
// fixture (BS5 §4.1 rule 20; the row).
//
// SAFETY (BS5 §4.1; E64). The only unit is the engine's own under the test
// home's prefix; nothing here acts on a unit or signals a process but the
// test's own engine (`fx.engine.kill()`, the verified kill). The caller
// brackets the file with `operatorGuard` and ends any environment in
// `finally` (`endJourney`).

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { activeQualification, waitSelfTest } from '../checks/execution.mjs';
import { runningClassifier, setEngineConfig } from '../checks/classifier.mjs';
import { consume, decision } from '../decisions.mjs';
import { RUNTIME, configContent, configure, unitPrefix } from '../deploy/kernel.mjs';
import { cgroupsNamed, endEnvironment, realAdapterStarts, unitsOfHome } from '../deploy/host.mjs';
import { qualifyByCommand } from '../deploy/qualify.mjs';
import { freePort, waitFor } from '../engine.mjs';
import { sandboxEngine } from '../sandbox/lane.mjs';
import { SESSION_IDLE_STATES } from '../runs.mjs';
import { storePath, withStore } from '../store.mjs';
import {
  architectSession,
  authoringReady,
  candidatesOfProject,
  createWithIdea,
  deploymentRequests,
  eventsAbout,
  journeyContext,
  journeyScripts,
  nextPhasePublished,
  phaseCompleted,
  planOfPhase,
  projectRow,
  specSession,
  visionSession,
  waitPublished,
  workOf,
  ROUTED_KINDS,
} from './drive.mjs';

// The project's policy (the row; §356): `phase`, `on_phase_complete`, no
// automatic deploy retry, the service's memory bound, an identity read per tick.
// `phase_size` (slice 35; SEAM.md §406): Tally's two-stage phases.
export const PROJECT_POLICY = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1, phase_size: { min: 2, max: 5 } });

const SELF_TEST = ['--harness-runner-self-test', 'run'];

// The qualification row of the previous start, which this start's self-test
// is not; null before any engine has made the home's store (objection 068).
const previousQualification = (fx) => (existsSync(storePath(fx.home)) ? (activeQualification(fx.home)?.id ?? null) : null);

// The engine of either file: a sandbox-lane fixture on the real adapter,
// every project-lane start carrying the runner self-test, the classifier
// `authoritative` naming the running version (the ruling). `lane`: 'project'
// starts on the project lane; 'kernel' starts the same home on the kernel
// lane (`fx.startKernel`) for a seed that `toProjectLane` carries on from.
// `config`: further engine keys, set with the classifier's before the second
// start (M408's `domain_memory_max` 4 GiB of objection 076, SEAM.md §386,
// was dropped in slice 37 when the per-profile maxima became the default).
export async function journeyEngine(t, guard, { lane = 'project', config = {} } = {}) {
  const fx = realAdapterStarts(await sandboxEngine(t, { start: false }));
  guard.track(fx);
  const inner = fx.start;
  fx.start = (opts = {}) => (opts.harness === false ? inner(opts) : inner({ ...opts, args: [...(opts.args ?? []), ...SELF_TEST] }));
  const start = async () => {
    if (lane === 'kernel') return fx.startKernel();
    const previous = previousQualification(fx);
    await fx.start();
    return waitSelfTest(fx, { notRow: previous });
  };
  await start();
  const version = await runningClassifier(fx.engine);
  setEngineConfig(fx, { classifier_authority: { mode: 'authoritative', version }, ...config });
  await fx.engine.kill();
  await start();
  journeyScripts(fx);
  return fx;
}

// D6 §1 steps 1 to 9 on whichever lane the engine is on: the project created
// with the idea, the three sessions, the consolidated approval answered by
// the owner, phase 1's authoring, its two stages, its completion and the
// replan publishing phase 2. Returns the observations the row's (a) to (g)
// read: {p, ctx, created, vision, spec, beforeAnswer, plan, authoring,
// phase1, afterPhase1, phase2Plan}.
export async function toPhaseTwoPublished(fx, { lane }) {
  const J = {};
  // 1. The project, created with the idea.
  const p = await createWithIdea(fx, { tier: 'T2', policy: PROJECT_POLICY });
  const ctx = journeyContext(fx, p, { lane, tier: 'T2' });
  // The journey's classifier is authoritative: phase 2's tightening is the
  // Reviewer's (SEAM.md §351); the owner answers the other routed kinds
  // (objection 105; SEAM.md §451).
  ctx.answerKinds = ROUTED_KINDS.filter((k) => k !== 'check_correction_tightening');
  Object.assign(J, { p, ctx });
  J.created = { row: projectRow(fx.home, p.id), events: eventsAbout(fx.home, 'project.created', p.id) };
  // 2. Vision. 3. The Spec Writer, a defective save then the whole.
  J.vision = await visionSession(fx, p.id);
  J.spec = await specSession(fx, p.id);
  // 4. The Architect, its close read before the owner answers both rows.
  const arch = await architectSession(fx, p.id, p.repo, { answer: 'none' });
  J.beforeAnswer = { arch, snapshot: { plans: planOfPhase(fx.home, p.id, 1).length, work: workOf(fx.home, p.id).length, baseline: projectRow(fx.home, p.id).baseline_state } };
  for (const kind of ['architecture_approval', 'plan_approval']) await consume(fx, p.id, decision(fx.home, arch.decisions[kind].id), 'approve');
  J.plan = await waitPublished(fx, p.id);
  // 5 to 8: phase 1 under `phase`, the toolchain proposal the one routed act.
  // `max` bounds the kernel-lane seed's ticks; on the project lane the pump is
  // bounded by time and by the engine's events (objection 071; SEAM §375).
  J.authoring = { ready: await authoringReady(fx, ctx, 1, { max: 60 }) };
  J.phase1 = await phaseCompleted(fx, ctx, 1, { max: 240 });
  J.afterPhase1 = { candidates: candidatesOfProject(fx.home, p.id), requests: deploymentRequests(fx.home, p.id) };
  // 9. The replan publishes phase 2 by computed routing.
  J.phase2Plan = await nextPhasePublished(fx, ctx, 2, { max: 60 });
  return J;
}

// What of the project is in flight (SEAM.md §474): a run not ended and not
// quarantined (an idle session, `allocated` or `open_idle`, is not in
// flight), and a check execution past `queued`.
const inFlight = (home, project) =>
  withStore(home, (db) => [
    ...db
      .prepare(`SELECT "id", "kind", "role", "state", "session_state" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' AND "quarantined" = 0`)
      .all(project)
      .filter((r) => !(r.kind === 'session' && SESSION_IDLE_STATES.includes(r.session_state))),
    ...db
      .prepare(`SELECT x."id", 'check_execution' AS "kind", x."status" AS "state" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" IN ('materializing', 'running', 'collecting')`)
      .all(project),
  ]);

// The seeded home carried on: the project paused through the owner's route,
// what it has in flight waited for to end on the kernel-lane engine, that
// engine killed (the verified kill) and the same home started on the project
// lane, its runner self-tested at this start, and the project resumed.
// Returns the moment of the switch (ISO) and its event seq, both read before
// the resume, after which every candidate is nominated and every run started
// on the project lane; `waited` names what was in flight at the pause.
//
// The wait (E154 item 6 (4); E156 Q1; SEAM.md §474): the engine's own
// requested tick claims phase 2's authoring run within ~100 ms of the seed's
// last tick, and a kill that lands while that run is claimed or running ends
// it `recovered` at the restart and leaves its item `held` (D1 §8.4), which
// the journey never resumes (§472). Pausing stops new dispatch (a paused
// project's work is not claimed); a run already claimed carries on to its end.
export async function toProjectLane(fx, ctx) {
  const project = ctx.project;
  assert.ok(project, 'the journey context names its project');
  const paused = await fx.engine.post(`/v1/projects/${project}/pause`, {});
  assert.equal(paused.status, 200, `the project paused before the switch (${paused.status} ${paused.text})`);
  const waited = inFlight(fx.home, project).map((r) => ({ id: r.id, kind: r.kind, role: r.role ?? null, state: r.state }));
  await waitFor(() => inFlight(fx.home, project).length === 0, {
    timeoutMs: 180_000,
    what: `nothing of the project in flight before the switch (at the pause: ${JSON.stringify(waited)})`,
  });
  const previous = previousQualification(fx);
  await fx.engine.kill();
  const atKill = inFlight(fx.home, project);
  assert.deepEqual(atKill, [], `nothing of the project was in flight when the kernel-lane engine was killed (${JSON.stringify(atKill)})`);
  await fx.start();
  const qualification = await waitSelfTest(fx, { notRow: previous });
  ctx.lane = 'project';
  const seq = withStore(fx.home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);
  const at = new Date().toISOString();
  const resumed = await fx.engine.post(`/v1/projects/${project}/resume`, {});
  assert.equal(resumed.status, 200, `the project resumed on the project lane (${resumed.status} ${resumed.text})`);
  return { at, seq, qualification, waited };
}

// D6 §1 step 12: the adapter qualified by command in the test's home, then
// `alpha` configured by the owner (the engine's node, `server.mjs`, a free
// port, no secret). Returns {env, cli}.
export async function alphaByCommand(fx, ctx) {
  const cli = qualifyByCommand(fx);
  assert.equal(cli.status, 0, `surety qualify-adapter local_service exits 0 in the test's home (stdout ${cli.stdout.slice(0, 400)}; stderr ${cli.stderr.slice(0, 400)})`);
  const content = configContent({ adapter_version: cli.body.adapter_version, port: await freePort(), start: [RUNTIME.path, 'server.mjs'] });
  const configured = await configure(fx.engine, ctx.project, 'alpha', content);
  return { env: { ...configured.environment, name: 'alpha', config: configured.config, content }, cli };
}

// The environment ended by the engine's own teardown, waited for, and the
// prefix read afterwards (units, cgroups, runtime files). Returns what was read.
export async function endJourney(fx, project, env) {
  const ended = await endEnvironment({ fx, project, envs: {} }, env);
  const prefix = unitPrefix(fx.home, env.id);
  return {
    ended,
    units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(prefix)),
    cgroups: cgroupsNamed(prefix),
    runFiles: (() => {
      try {
        return readdirSync(join(fx.home, 'run'), { recursive: true }).filter((n) => String(n).includes(env.id));
      } catch {
        return [];
      }
    })(),
  };
}
