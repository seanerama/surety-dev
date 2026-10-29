// M611, a disposable local-service Alpha, started, verified and torn down;
// availability consistent across modes (the owner's draft M7 plan §3, row
// M611; request §6; rulings R6, S3 of 2026-10-28; D4; SEAM.md §§575, 576).
// Sandbox lane: real `role` and `check` domains, the real `local_service`
// adapter (`--harness-deploy-adapter real`), no model.
//
//   (a) a rapid prototype built from its brief, by the scripted roles in
//       real domains, its checks run by the real runner, its candidate
//       deployed by the prototype policy on a real transient user unit:
//       the unit active, the identity read, alpha.current healthy with
//       observed_at within the freshness bound.
//   (b) alpha_deployed, and the iteration's Alpha, only from the current
//       attempt's verification round: not while its post-deploy check holds.
//   (c) teardown: the unit gone, alpha.current null, candidates.progress no
//       longer alpha_deployed; the deployment row, alpha_at and the
//       observation history kept.
//   (d) a planned project's candidate deployed and torn down on its own
//       real unit: the same two meanings, no claim of current availability
//       and the historical record kept (M301 (f) restated, objection 220).
//   (e) on a real unit (the owner's instruction of 2026-10-29: "Include
//       replacement/teardown observations on a real unit"; SEAM.md §582):
//       iteration 1's candidate A deployed and observed; iteration 2's
//       candidate B deployed on the same environment: A's claim withdrawn
//       at B's finalization, before B's verification (candidate.alpha_replaced
//       in that transaction; iteration 1 `replaced`, next_step no longer
//       open_alpha, outcome.recorded kept); the observation of A made before
//       that finalization reads unknown/expired with ended_by; after B's own
//       observation and a teardown, the same with ended_by the teardown. The
//       kernel half of (e) is M611-replacement-and-ended-observations-on-the-
//       scripted-target.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only units are the ones the
// engine creates under this file's own home's prefix; the test acts on no
// unit and signals nothing. The fixture service is used in its benign
// routes only (no act); the check program only asks it for /hello. The file
// ends with the operator's guard, which reports any leftover by exact name.
// This host's checks (H12: memory) may refuse a sandbox-lane start under
// load: the slice-50 gate runs on mini-hp01 (Sean's rule of 2026-10-12).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { acceptance, defPath, definitionText, governedText, smoke } from './harness/checks/fixtures.mjs';
import { attemptsOf, candidateRow, environmentRecord, operationsOf, roundsOf, unitPrefix, verificationsOf } from './harness/deploy/kernel.mjs';
import {
  FIXTURE_SERVICE,
  RELEASE,
  cgroupsNamed,
  deployHeld,
  heldCheck,
  hostEnvironment,
  hostDeployable,
  newestOperation,
  operatorGuard,
  releaseCheck,
  serviceOf,
  teardownOnHost,
  ticksUntil,
  unitShow,
  unitsOfHome,
  verificationOf,
} from './harness/deploy/host.mjs';
import { historyOf, observeOnHost } from './harness/deploy/observe.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  CHECK_KINDS,
  PROTO,
  REQ4,
  REQS,
  answer,
  authoringScript,
  currentIt,
  firstPlanScript,
  iterationRead,
  kindNext,
  modelBrief,
  newApp,
  ok,
  openDecisionsRead,
  prepScript,
  result,
  secondPlanScript,
  specText,
  usage,
  write,
} from './harness/prototype.mjs';

// The historical deployment record of a candidate, and its current claim.
const history = (home, candidate, environment) => ({
  progress: candidateRow(home, candidate).progress,
  requests: withStore(home, (db) => db.prepare('SELECT * FROM "deployment_requests" WHERE "candidate" = ? ORDER BY rowid').all(candidate)),
  advanced: eventsOfType(home, 'candidate.advanced').filter((e) => e.subject?.candidate === candidate),
  evaluations: withStore(home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' ORDER BY rowid`).all(candidate)),
  observations: historyOf(home, environment),
});

// Ticks of the project in real time, answering as the owner only the check
// corrections; the checks are run by the real runner (nothing recorded by
// the harness).
async function drive(fx, project, done, { timeoutMs = 900_000, what } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > until) {
      const its = withStore(fx.home, (db) => db.prepare('SELECT "seq", "status", "next_step", "outcome_reason" FROM "prototype_iterations" WHERE "project" = ?').all(project));
      throw new Error(`${what}: not reached within ${timeoutMs} ms (iterations: ${JSON.stringify(its)}; open: ${JSON.stringify((await openDecisionsRead(fx, project)).map((d) => d.kind))}; stderr: ${fx.engine.proc.out.stderr.slice(-2000)})`);
    }
    for (const d of await openDecisionsRead(fx, project)) if (CHECK_KINDS.includes(d.kind)) await answer(fx, project, d);
    await tick(fx.engine, project, { rounds: 1, timeoutMs: 180_000 });
    await sleep(300);
  }
}

describe('M611 a disposable local-service Alpha, started, verified and torn down; availability consistent across modes', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  before(async () => {
    guard = operatorGuard();
    // The planned project (M307's fixture: a T1 candidate, its workspace
    // checks recorded by the real runner, the runner and the adapter
    // qualified by their fixtures) and, on the same engine, the prototype.
    const ctx = await hostDeployable(shared.context, guard);
    const { fx, prog } = ctx;
    J.fx = fx;
    J.ctx = ctx;

    // (d) the planned candidate on its own real unit: deployed, verified, completed, torn down.
    const penv = await hostEnvironment(ctx, 'alpha');
    J.penv = penv;
    const planned = await deployHeld(ctx, penv);
    releaseCheck(ctx, planned.svc, { get: ['/hello'], exit: 0 });
    await verificationOf(ctx, planned.op);
    await ticksUntil(fx, ctx.project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'the planned candidate alpha_deployed' });
    J.planned = { op: planned.op, svc: planned.svc, atCompletion: history(fx.home, ctx.candidate.id, penv.id) };
    J.planned.teardown = await teardownOnHost(ctx, penv);
    J.planned.after = { ...history(fx.home, ctx.candidate.id, penv.id), unit: unitShow(planned.svc.unit, ['LoadState']), units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, penv.id))) };

    // The prototype: its checks are the real runner's programs, its Builder
    // writes the fixture service as server.js.
    const target = join(prog.dir, 'target-check.mjs');
    const files = {
      '.surety/checks/protected-policy.json': governedText({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: prog.program }, target: { path: target } }, runner_config: { direct: { read_paths: prog.readPaths } } }),
      [defPath('accept-r1')]: acceptance('accept-r1', ['R1.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
      [defPath('accept-r2')]: acceptance('accept-r2', ['R2.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
      [defPath('accept-r3')]: acceptance('accept-r3', ['R3.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
      [defPath('smoke')]: smoke('smoke', { command: ['probe', 'exit', '0'], timeout: 120 }),
      [defPath('behaves')]: definitionText('behaves', { kind: 'post_deploy_behavior', command: ['target', '--hold', RELEASE, '--release-dir', prog.releaseDir], timeout_s: 300, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
    };
    // By each kind's launch ordinal in this engine (the planned project's
    // launches came first), every later launch keeping the same script.
    const builder = (path, content) => ({ steps: [usage(1500, 500, 700), write(path, content), result()] });
    kindNext(fx, 'brief_preparation', [], prepScript());
    kindNext(fx, 'replan', [], firstPlanScript());
    kindNext(fx, 'check_authoring', [], authoringScript({ files }));
    kindNext(fx, 'stage_build', [builder('server.js', FIXTURE_SERVICE)], builder('src/s2.mjs', 'export const s2 = 2;\n'));
    kindNext(fx, 'verification', [], { steps: [usage(300, 0, 100), result()] });
    kindNext(fx, 'phase_verification', [], { steps: [usage(300, 0, 100), result({ signoffs: [{ scope: 'phase' }] })] });
    kindNext(fx, 'fix', [], { steps: [usage(300, 0, 100), result()] });

    const { id: p } = await newApp(fx, { name: 'Tasks on a unit' });
    const pctx = { ...ctx, project: p, envs: {} };
    J.p = p;
    J.pctx = pctx;
    const env = await hostEnvironment(pctx, 'alpha');
    J.env = env;
    const it = await currentIt(fx, p);
    J.it = it.id;
    const prep = (await openDecisionsRead(fx, p)).find((d) => d.kind === PROTO.preparation.decision);
    assert.equal((await answer(fx, p, prep)).status, 200, 'the preparation approved');
    await drive(fx, p, async () => ((await iterationRead(fx, p, it.id)).iteration.status === 'awaiting_brief_approval' ? true : undefined), { what: 'the brief' });
    const spec = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'spec_approval');
    assert.equal((await answer(fx, p, spec)).status, 200, 'the brief approved');

    // The policy's deployment, held at its post-deploy check: the host read now.
    J.held = await drive(fx, p, () => heldCheck(pctx, env), { what: "the prototype's post-deploy check to hold" });
    J.op = newestOperation(pctx, env);
    const svc = serviceOf(pctx, env, J.op);
    J.svc = svc;
    J.atHold = { show: unitShow(svc.unit, ['LoadState', 'ActiveState']), read: await iterationRead(fx, p, it.id), candidate: J.op.subject?.candidate ? candidateRow(fx.home, J.op.subject.candidate) : null };
    releaseCheck(pctx, svc, { get: ['/hello'], exit: 0 });
    J.verification = await verificationOf(pctx, J.op);
    J.ready = await drive(fx, p, async () => {
      const r = await iterationRead(fx, p, it.id);
      return r.iteration.status === 'alpha_ready' ? r : undefined;
    }, { what: 'alpha_ready' });
    J.observation = await observeOnHost(pctx, env, ticksUntil);
    J.current = await iterationRead(fx, p, it.id);
    J.atCompletion = history(fx.home, J.ready.alpha.candidate, env.id);

    // The teardown.
    J.teardown = await teardownOnHost(pctx, env);
    J.afterTeardown = {
      read: await iterationRead(fx, p, it.id),
      show: unitShow(svc.unit, ['LoadState']),
      units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, env.id))),
      cgroups: cgroupsNamed(unitPrefix(fx.home, env.id)),
      history: history(fx.home, J.ready.alpha.candidate, env.id),
    };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) the prototype\'s candidate deployed on a real transient user unit: the unit active, the identity read, alpha.current healthy with observed_at within the freshness bound', () => {
    const { atHold, svc, verification, current, observation, fx, env } = J;
    assert.ok(svc.unit.startsWith(unitPrefix(fx.home, env.id)), `the unit carries this home's prefix for the environment (${svc.unit})`);
    assert.deepEqual([atHold.show?.LoadState, atHold.show?.ActiveState], ['loaded', 'active'], `the manager has the unit active (${JSON.stringify(atHold.show)})`);
    const reads = verification.row.identity_reads;
    assert.deepEqual(reads.map((r) => [r.bracket, r.match]), [['first', 'match'], ['second', 'match']], 'the identity read from the unit, twice, matching');
    for (const r of reads) assert.deepEqual([r.instance?.pid, r.instance?.start_time], [svc.app.pid, svc.app.start_time], 'of the recorded application instance');
    assert.equal(observation.condition, 'healthy', `the observer's read of the running generation: healthy (${JSON.stringify(observation)})`);
    const now = current.alpha.current;
    assert.ok(now, `alpha.current is served (${JSON.stringify(current.alpha)})`);
    assert.equal(now.healthy, true);
    const bound = 90;
    const age = (Date.parse(current.served_at) - Date.parse(now.observed_at)) / 1000;
    assert.ok(age >= 0 && age <= bound, `observed_at within the freshness bound (${age} s of ${bound})`);
    assert.equal(current.alpha.environment?.id, env.id);
    assert.equal(current.iteration.status, 'alpha_ready');
  });

  test('(b) alpha_deployed only from the current attempt\'s verification round: not while its post-deploy check holds', () => {
    const { atHold, op, verification, ready, fx, atCompletion } = J;
    assert.equal(atHold.read.iteration.status !== 'alpha_ready', true, `while the round's check holds the iteration is not alpha_ready (${atHold.read.iteration.status})`);
    assert.equal(atHold.read.alpha.deployed_at, null, 'and has no Alpha');
    assert.equal(atHold.candidate?.progress, 'developing', 'its candidate is not alpha_deployed while the check holds');
    const attempts = attemptsOf(fx.home, op.id);
    const rounds = roundsOf(fx.home, op.id);
    assert.equal(verification.row.outcome, 'verified');
    assert.equal(verification.round.id, rounds.at(-1).id, 'the verification is of the operation\'s newest round');
    assert.equal(verification.round.attempt, attempts.at(-1).id, "the round is the current attempt's");
    assert.equal(verification.row.attempt, attempts.at(-1).id, 'the verification is the current attempt\'s');
    assert.deepEqual(verificationsOf(fx.home, rounds.at(-1).id).map((v) => v.outcome), ['verified']);
    assert.equal(atCompletion.progress, 'alpha_deployed');
    assert.equal(atCompletion.advanced.length, 1, 'candidate.advanced once');
    assert.equal(atCompletion.advanced[0].payload?.operation, op.id, 'from this operation\'s completion');
    assert.equal(ready.alpha.candidate, op.subject?.candidate, "the iteration's candidate is the deployed one");
    assert.ok(Date.parse(ready.iteration.alpha_at) >= Date.parse(verification.row.computed_at ?? verification.row.created_at), `Alpha recorded after the verification (${ready.iteration.alpha_at}; ${verification.row.computed_at})`);
  });

  test('(c) teardown: the unit gone, alpha.current null, candidates.progress no longer alpha_deployed; the deployment row, alpha_at and the observation history kept', () => {
    const { afterTeardown: a, svc, ready, atCompletion, teardown: op, env } = J;
    assert.equal(a.show?.LoadState, 'not-found', `the unit is gone (${JSON.stringify(a.show)})`);
    assert.deepEqual(a.units, [], 'no unit of the environment\'s prefix is loaded');
    assert.deepEqual(a.cgroups, [], 'no cgroup of it');
    assert.equal(a.read.alpha.current, null, 'alpha.current null');
    assert.equal(a.history.progress, 'developing', 'the candidate no longer alpha_deployed');
    const withdrawn = eventsOfType(J.fx.home, 'candidate.alpha_withdrawn').filter((e) => e.subject?.candidate === ready.alpha.candidate);
    assert.deepEqual(withdrawn.map((e) => [e.payload.environment, e.payload.operation]), [[env.id, op.id]], 'withdrawn once, by the teardown');
    assert.deepEqual(a.history.requests, atCompletion.requests, 'the deployment row kept');
    assert.deepEqual([a.read.iteration.status, a.read.iteration.alpha_at, a.read.alpha.deployed_at, a.read.alpha.deployment_request], ['alpha_ready', ready.iteration.alpha_at, ready.alpha.deployed_at, ready.alpha.deployment_request], 'the outcome and alpha_at kept');
    assert.deepEqual(a.history.observations.slice(0, atCompletion.observations.length), atCompletion.observations, 'the observation history kept');
    assert.deepEqual(a.history.advanced, atCompletion.advanced, 'candidate.advanced kept');
    assert.deepEqual(a.history.evaluations, atCompletion.evaluations);
    assert.ok(svc.unit);
  });

  test('(d) a planned project\'s candidate on its own real unit, torn down: no claim of current availability, the historical record kept', () => {
    const { planned, ctx, penv, fx } = J;
    const { atCompletion, after: a, teardown: op } = planned;
    assert.equal(atCompletion.progress, 'alpha_deployed', 'at completion the planned candidate was alpha_deployed');
    assert.equal(atCompletion.advanced.length, 1);
    assert.equal(a.unit?.LoadState, 'not-found', 'its unit is gone');
    assert.deepEqual(a.units, []);
    assert.equal(a.progress, 'developing', 'after the teardown: no claim of current availability');
    const withdrawn = eventsOfType(fx.home, 'candidate.alpha_withdrawn').filter((e) => e.subject?.candidate === ctx.candidate.id);
    assert.deepEqual(withdrawn.map((e) => [e.payload.from, e.payload.to, e.payload.environment, e.payload.operation]), [['alpha_deployed', 'developing', penv.id, op.id]]);
    assert.deepEqual(a.requests, atCompletion.requests, 'the deployment row kept');
    assert.ok(a.requests.every((r) => r.outcome === 'deployed'));
    assert.deepEqual(a.advanced, atCompletion.advanced, 'candidate.advanced kept');
    assert.deepEqual(a.evaluations, atCompletion.evaluations, 'the alpha_complete evaluation kept');
    assert.deepEqual(a.observations.slice(0, atCompletion.observations.length), atCompletion.observations);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "prototype_iterations" WHERE "project" = ?').get(ctx.project).n), 0, 'a planned project: no iteration');
  });
});

// ---- (e) on a real unit ------------------------------------------------------------------

// The prototype's checks, run by the real runner (as the describe above).
function protoFiles(prog) {
  const target = join(prog.dir, 'target-check.mjs');
  return {
    '.surety/checks/protected-policy.json': governedText({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: prog.program }, target: { path: target } }, runner_config: { direct: { read_paths: prog.readPaths } } }),
    [defPath('accept-r1')]: acceptance('accept-r1', ['R1.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('accept-r2')]: acceptance('accept-r2', ['R2.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('accept-r3')]: acceptance('accept-r3', ['R3.1'], { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('smoke')]: smoke('smoke', { command: ['probe', 'exit', '0'], timeout: 120 }),
    [defPath('behaves')]: definitionText('behaves', { kind: 'post_deploy_behavior', command: ['target', '--hold', RELEASE, '--release-dir', prog.releaseDir], timeout_s: 300, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
  };
}

// The environment as it stands: the read, the list's entry, the stored observation and the history.
async function envNow(fx, p, env) {
  const read = await fx.engine.get(`/v1/projects/${p}/environments/${env.name}`);
  assert.equal(read.status, 200, read.text);
  const list = await fx.engine.get(`/v1/projects/${p}/environments`);
  assert.equal(list.status, 200, list.text);
  return { read: read.body.environment, listed: list.body.environments.find((e) => e.name === env.name), stored: environmentRecord(fx.home, env.id)?.observed ?? null, history: historyOf(fx.home, env.id) };
}

// The observation stored before `op` was finalized reads as ended by it, the
// stored observation untouched. On a real unit the observer runs on the
// engine's clock: if it installed a newer observation between the
// finalization and the read, that newer one is current and of the state
// after the finalization (never a claim of what ran before), and the earlier
// one is kept in the history; the case says which it read.
function assertEndedBy(t, now, before, op, kind, { generation }) {
  const fin = Date.parse(op.finalized_at);
  assert.ok(Number.isFinite(fin), `the operation ${op.id} was finalized (${op.finalized_at})`);
  assert.ok(before.stored?.observed_at && Date.parse(before.stored.observed_at) < fin, `an observation was made before the finalization (${before.stored?.observed_at})`);
  assert.ok(now.history.some((h) => h.id === before.history.at(-1)?.id), 'the earlier observation is kept in the history');
  if (Date.parse(now.stored.observed_at) < fin) {
    t.diagnostic(`read the observation of ${now.stored.observed_at}, made before the ${kind} was finalized at ${op.finalized_at}`);
    const o = now.read.observed;
    assert.deepEqual([o.condition, o.freshness, o.stored_condition, o.observed_at], ['unknown', 'expired', now.stored.condition, now.stored.observed_at], JSON.stringify(o));
    assert.deepEqual([o.ended_by?.kind, o.ended_by?.operation, o.ended_by?.finalized_at], [kind, op.id, op.finalized_at], JSON.stringify(o.ended_by));
    assert.equal(o.expires_at, op.finalized_at);
    assert.equal(now.listed.state, 'unknown');
    assert.deepEqual([now.listed.observed.ended_by?.kind, now.listed.observed.ended_by?.operation], [kind, op.id]);
  } else {
    t.diagnostic(`a newer observation (${now.stored.observed_at}) was installed after the ${kind}'s finalization (${op.finalized_at}) and before the read`);
    assert.equal(now.read.observed.ended_by, undefined, 'the newer observation is current');
    if (kind === 'deployment') assert.equal(now.stored.deployment_generation, generation, 'and of the new deployment\'s generation');
    else assert.notEqual(now.read.observed.condition, 'healthy', 'and claims nothing runs');
  }
}

describe('M611 (e) on a real unit: a newer deployment replaces the Alpha and ends the earlier observation; a teardown ends the next', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  before(async () => {
    guard = operatorGuard();
    const ctx = await hostDeployable(shared.context, guard);
    const { fx, prog } = ctx;
    J.fx = fx;
    const files = protoFiles(prog);
    const builder = (path, content) => ({ steps: [usage(1500, 500, 700), write(path, content), result()] });
    kindNext(fx, 'brief_preparation', [], prepScript());
    kindNext(fx, 'replan', [], firstPlanScript());
    kindNext(fx, 'check_authoring', [], authoringScript({ files }));
    kindNext(fx, 'stage_build', [builder('server.js', FIXTURE_SERVICE)], builder('src/s2.mjs', 'export const s2 = 2;\n'));
    kindNext(fx, 'verification', [], { steps: [usage(300, 0, 100), result()] });
    kindNext(fx, 'phase_verification', [], { steps: [usage(300, 0, 100), result({ signoffs: [{ scope: 'phase' }] })] });
    kindNext(fx, 'fix', [], { steps: [usage(300, 0, 100), result()] });

    const { id: p } = await newApp(fx, { name: 'Tasks replaced on a unit' });
    const pctx = { ...ctx, project: p, envs: {} };
    J.p = p;
    const env = await hostEnvironment(pctx, 'alpha');
    J.env = env;
    const one = (await currentIt(fx, p)).id;
    J.one = one;
    const prep = (await openDecisionsRead(fx, p)).find((d) => d.kind === PROTO.preparation.decision);
    assert.equal((await answer(fx, p, prep)).status, 200, 'the preparation approved');
    await drive(fx, p, async () => ((await iterationRead(fx, p, one)).iteration.status === 'awaiting_brief_approval' ? true : undefined), { what: 'the brief' });
    assert.equal((await answer(fx, p, (await openDecisionsRead(fx, p)).find((d) => d.kind === 'spec_approval'))).status, 200, 'the brief approved');
    await drive(fx, p, () => heldCheck(pctx, env), { what: "iteration 1's post-deploy check to hold" });
    J.op1 = newestOperation(pctx, env);
    J.svc1 = serviceOf(pctx, env, J.op1);
    releaseCheck(pctx, J.svc1, { get: ['/hello'], exit: 0 });
    await verificationOf(pctx, J.op1);
    await drive(fx, p, async () => ((await iterationRead(fx, p, one)).iteration.status === 'alpha_ready' ? true : undefined), { what: "iteration 1's Alpha" });
    J.obs1 = await observeOnHost(pctx, env, ticksUntil);
    J.oneAtAlpha = await iterationRead(fx, p, one);
    J.A = J.oneAtAlpha.alpha.candidate;
    J.beforeReplacement = await envNow(fx, p, env);

    // Iteration 2 (S4: one bounded phase of its own) built in real domains and deployed on the same environment.
    const reqs2 = [...REQS, REQ4];
    kindNext(fx, 'brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: reqs2, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: reqs2.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
    kindNext(fx, 'replan', [secondPlanScript()], firstPlanScript());
    kindNext(fx, 'check_authoring', [authoringScript({ files: { ...files, [defPath('accept-r4')]: acceptance('accept-r4', ['R4.1'], { command: ['probe', 'exit', '0'], timeout: 120 }) } })], authoringScript({ files }));
    kindNext(fx, 'stage_build', [builder('src/count.mjs', 'export const open = (ts) => ts.filter((t) => !t.done).length;\n')], builder('src/s2.mjs', 'export const s2 = 2;\n'));
    const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${one}/iterate`, { change: 'Show the number of open tasks at the top.' }), 201, 'POST …/iterate');
    const two = made.iteration.id;
    J.two = two;
    const prep2 = (await openDecisionsRead(fx, p)).find((d) => d.kind === PROTO.preparation.decision);
    assert.equal((await answer(fx, p, prep2)).status, 200, "iteration 2's preparation approved");
    await drive(fx, p, async () => ((await iterationRead(fx, p, two)).iteration.status === 'awaiting_brief_approval' ? true : undefined), { what: "iteration 2's brief" });
    assert.equal((await answer(fx, p, (await openDecisionsRead(fx, p)).find((d) => d.kind === 'spec_approval'))).status, 200, "iteration 2's brief approved");
    // B's deployment, held at its post-deploy check: finalized, not verified.
    await drive(fx, p, () => {
      const op = newestOperation(pctx, env);
      return op && op.id !== J.op1.id ? heldCheck(pctx, env) : undefined;
    }, { what: "iteration 2's post-deploy check to hold" });
    J.op2 = newestOperation(pctx, env);
    J.atHold = {
      op: operationsOf(fx.home, p, 'deploy').find((o) => o.id === J.op2.id),
      one: await iterationRead(fx, p, one),
      A: candidateRow(fx.home, J.A),
      B: J.op2.subject?.candidate ? candidateRow(fx.home, J.op2.subject.candidate) : null,
      replaced: eventsOfType(fx.home, 'candidate.alpha_replaced'),
      finalized: eventsOfType(fx.home, 'operation.finalized').filter((e) => e.subject?.operation === J.op2.id),
      verifications: roundsOf(fx.home, J.op2.id).flatMap((r) => verificationsOf(fx.home, r.id)),
      env: await envNow(fx, p, env),
      generation: attemptsOf(fx.home, J.op2.id).at(-1)?.deployment_generation ?? null,
    };
    J.svc2 = serviceOf(pctx, env, J.op2);
    releaseCheck(pctx, J.svc2, { get: ['/hello'], exit: 0 });
    await verificationOf(pctx, J.op2);
    await drive(fx, p, async () => ((await iterationRead(fx, p, two)).iteration.status === 'alpha_ready' ? true : undefined), { what: "iteration 2's Alpha" });
    J.obs2 = await observeOnHost(pctx, env, ticksUntil);
    J.twoAtAlpha = await iterationRead(fx, p, two);
    J.beforeTeardown = await envNow(fx, p, env);
    J.td = await teardownOnHost(pctx, env);
    J.afterTeardown = { env: await envNow(fx, p, env), two: await iterationRead(fx, p, two), units: unitsOfHome(fx.home).filter((u) => u.unit.startsWith(unitPrefix(fx.home, env.id))) };
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(e) replacement on a real unit: A\'s claim withdrawn at B\'s finalization, before B\'s verification; candidate.alpha_replaced in that transaction', () => {
    const { atHold: h, A } = J;
    assert.ok(h.op?.finalized_at, `B's deployment operation is finalized while its check holds (${JSON.stringify(h.op)})`);
    assert.ok(h.B && h.B.id !== A, 'B is another candidate');
    assert.deepEqual(h.verifications.map((v) => v.outcome).filter((x) => x === 'verified'), [], 'B is not verified yet');
    assert.equal(h.A.progress, 'developing', 'A no longer claims current availability');
    const ev = h.replaced.filter((e) => e.subject?.candidate === A);
    assert.equal(ev.length, 1, `candidate.alpha_replaced once for A (${JSON.stringify(h.replaced.map((e) => e.payload))})`);
    assert.deepEqual([ev[0].payload.from, ev[0].payload.to, ev[0].payload.environment, ev[0].payload.operation, ev[0].payload.replaced_by], ['alpha_deployed', 'developing', J.env.id, J.op2.id, h.B.id]);
    assert.equal(h.finalized.length, 1);
    assert.equal(ev[0].tx, h.finalized[0].tx, "in B's finalizing transaction");
  });

  test('(e) replacement on a real unit: iteration 1 replaced, no current Alpha, next_step current guidance, outcome.recorded kept', () => {
    const { atHold: h, oneAtAlpha } = J;
    assert.equal(oneAtAlpha.alpha.current_state, 'available', oneAtAlpha.alpha.current_reason);
    assert.equal(h.one.alpha.current_state, 'replaced', h.one.alpha.current_reason);
    assert.equal(h.one.alpha.current, null);
    assert.equal(h.one.outcome.next_step, PROTO.next_steps.alpha_gone);
    assert.deepEqual(h.one.outcome.recorded, oneAtAlpha.outcome.recorded, 'the recorded outcome unchanged');
    assert.equal(h.one.outcome.recorded?.next_step, 'open_alpha');
    assert.deepEqual([h.one.iteration.alpha_at, h.one.alpha.candidate, h.one.alpha.deployment_request], [oneAtAlpha.iteration.alpha_at, oneAtAlpha.alpha.candidate, oneAtAlpha.alpha.deployment_request], 'its Alpha history kept');
  });

  test('(e) the observation of A made before B\'s finalization: unknown, expired, ended_by the deployment; the stored observation untouched', (t) => {
    assertEndedBy(t, J.atHold.env, J.beforeReplacement, J.atHold.op, 'deployment', { generation: J.atHold.generation });
  });

  test('(e) teardown on a real unit: B\'s observation ended by the teardown; iteration 2 torn_down, its recorded outcome kept; no unit left', (t) => {
    assert.equal(J.twoAtAlpha.alpha.current_state, 'available', J.twoAtAlpha.alpha.current_reason);
    assertEndedBy(t, J.afterTeardown.env, J.beforeTeardown, J.td, 'teardown', {});
    assert.equal(J.afterTeardown.two.alpha.current_state, 'torn_down');
    assert.equal(J.afterTeardown.two.alpha.current, null);
    assert.equal(J.afterTeardown.two.outcome.next_step, PROTO.next_steps.alpha_gone);
    assert.deepEqual(J.afterTeardown.two.outcome.recorded, J.twoAtAlpha.outcome.recorded);
    assert.deepEqual(J.afterTeardown.units, [], 'no unit of the environment\'s prefix is left');
  });
});
