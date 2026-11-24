// M631, a refused policy Alpha request reconsidered when a check registered
// before the evaluation passes afterwards (M7 plan §3h, row M631; DECISIONS
// item 51 finding 1, second priority; D4 §4.1; D3 §4.3; SEAM.md §425).
// Sean, 2026-11-24: "1 · Alpha deployment. Prove that when a required check
// was registered before the policy evaluation and passes afterward, the
// engine reconsiders the refused request. Repeated ticks must not create
// duplicate requests. An outstanding or failed check must still block
// authorization."
//
// Kernel lane, the scripted backend and deployment adapter: a rapid
// prototype (its policy `alpha_deploy` `on_phase_complete`, the engine's
// automatic Alpha request; the row's "`alpha_deploy: automatic`" is read as
// that value, the only one under which the engine requests by itself,
// SEAM.md §354) whose checks add K, `alpha-k`, required in the
// `alpha_authorize` scope only, so the phase completes while K's execution on
// the candidate is registered and not run. Every time a new execution of K is
// registered the controlled clock is stepped back (`POST
// /v1/harness/clock/advance {"seconds": -N}`, SEAM.md §425) before the next
// tick, so the policy's `alpha_authorize` evaluation, which follows K's
// registration in the store, carries an earlier wall stamp than K's execution
// `created_at`. K is moved to `running` before that evaluation.
//
// READINGS (the report says them):
// - The evaluation refuses CHECK_NOT_PASSED on K, but the engine records no
//   `not_issued` under the key for it: a reason whose result is still to
//   come settles (deploy.ts requestDeployment, `settling`), and the policy
//   requests again at a later tick. "(L) the literal path" pins what happens
//   then. The stall of finding 1 (deploy.ts reopenableWait, the candidate's
//   latest evaluation read "as at" its wall stamp) needs the key already
//   `not_issued` from an earlier refusal while the newer evaluation is the
//   settling one (the state real visual run 2 met: "the key kept the
//   not_issued of the gap's refusal"). Cases (a) to (d) put that row there
//   by a LABELLED STORE WRITE: one `deployment_requests` row, `requested_by`
//   policy, `outcome` not_issued, `reason` null, under the engine's own key
//   for the candidate and configuration (D4 A.3: {project, completion_binding,
//   candidate, environment_configuration}, canonical); no event, no other row.
// - "exactly one new policy deployment_requests row": the store keeps one
//   row per key and requester (UNIQUE (project, request_key, requested_by),
//   migration 0024; deploy.ts recordRequest takes the row on), so the request
//   made again is read as that row issued (an issued authorization, the
//   outcome no longer not_issued) with exactly one issued authorization and
//   one deploy work item for the candidate; a second request would be a
//   second authorization or a second row.
//   (L) without the row: no request recorded while K runs; K passes; one
//       policy request, issued;
//   (a) K passes; ticks: the refused request reconsidered, issued;
//   (b) repeated ticks after that: no second request;
//   (c) K outstanding (running): no request, the read blocked on the
//       running checks; then K fails: no authorization issued, the latest
//       evaluation (the owner's gate read) naming K CHECK_NOT_PASSED, failed;
//   (d) equal wall stamps: the clock seam moves whole seconds and cannot put
//       two writes in one millisecond, so the equality is ARRANGED BY A
//       LABELLED STORE WRITE of K's execution `created_at` (a wall stamp
//       only) to the evaluation's `created_at`, with no clock step; then as (a);
//   (e) rows that predate the ordering fact: see the case at the end.
//
// SAFETY: no unit, no systemctl, no host process; the only engine stopped
// is the test's own (`t.after`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { advanceClock, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { newId } from './harness/ids.mjs';
import { CHECK_FILES, CHECK_KINDS, SERVER, alphaReady, answer, answerOpen, authoringScript, deploymentRequestsOf, idle, openDecisionsRead, projectRead, protoEngine, result, toBrief, usage, write } from './harness/prototype.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const K = 'alpha-k';
const K_FILE = { '.surety/checks/defs/alpha-k.json': json({ schema: 1, key: K, kind: 'smoke', command: ['probe'], timeout_s: 60, gate_kinds: ['alpha_authorize'] }) };
// The step back: far beyond the wall time between K's registration and the evaluation on this lane (seconds).
const STEP = 60;
const PACKAGE = json({ name: 'tasks', private: true, type: 'module', scripts: { start: 'node server.mjs' } });

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const kExecutions = (home, project) =>
  rows(home, `SELECT x.* FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND c."key" = ? ORDER BY x."execution_seq"`, project, K);
const authorizeEvaluations = (home, project) =>
  rows(home, `SELECT * FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'alpha_authorize' ORDER BY rowid`, project).map((e) => ({ ...e, reasons: JSON.parse(e.reasons ?? '[]') }));
const policyRequests = (home, project) => deploymentRequestsOf(home, project).filter((r) => r.requested_by === 'policy');
const issued = (home, candidate) => rows(home, `SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "status" <> 'proposed' ORDER BY rowid`, candidate);
const deployItems = (home, project) => rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy' ORDER BY "seq"`, project);

// D4 A.3's key, as deploy.ts requestKey makes it (common.ts canonical: JSON, object keys sorted).
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The kernel lane's check boundary (SEAM.md §190): an execution moved through `route`.
async function move(fx, execution, route, exit) {
  for (const to of route) {
    const res = await fx.engine.post('/v1/harness/fixtures/check-execution', { execution, to, ...(to === 'recorded' ? { exit_status: exit } : {}) });
    assert.equal(res.status, 200, `the execution ${execution} moved to ${to} (→ ${res.status} ${res.text})`);
  }
}
// Every queued execution of the project but K's, recorded passing.
async function recordAllButK(fx, project) {
  const queued = rows(fx.home, `SELECT x."id" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued' AND c."key" <> ? ORDER BY x."execution_seq"`, project, K);
  for (const { id } of queued) {
    for (const to of ['materializing', 'running', 'collecting', 'recorded']) {
      const res = await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: id, to, ...(to === 'recorded' ? { exit_status: 0 } : {}) });
      if (res.status !== 200) break; // superseded or cancelled meanwhile
    }
  }
}

// Tick until `done` answers: every queued execution but K's recorded passing,
// the owner's check-correction questions approved (as prototype.mjs pump).
// With `step`, each newly registered execution of K is moved to `running`
// and the clock stepped back before the next tick.
async function drive(fx, project, done, { max = 100, what, step = false, seen = new Set() }) {
  for (let i = 0; ; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i >= max) throw new Error(`${what}: not reached in ${max} ticks (requests ${JSON.stringify(policyRequests(fx.home, project).map((r) => [r.outcome, r.reason]))}; K ${JSON.stringify(kExecutions(fx.home, project).map((x) => [x.id, x.status]))})`);
    await idle(fx, project);
    await recordAllButK(fx, project);
    for (const x of kExecutions(fx.home, project)) {
      if (seen.has(x.id) || x.status !== 'queued') continue;
      seen.add(x.id);
      await move(fx, x.id, ['materializing', 'running']);
      if (step) await advanceClock(fx.engine, -STEP);
    }
    for (const d of await openDecisionsRead(fx, project)) if (CHECK_KINDS.includes(d.kind)) await answer(fx, project, d, 'approve');
    await tick(fx.engine, project);
    await idle(fx, project);
  }
}

// The prototype to the policy's evaluation refused on K, K registered on the
// phase's candidate and running; with `step` the clock stepped back between
// them. With `refusedRow`, the key's earlier not_issued row put there (the
// labelled store write of the readings above).
async function evaluatedOnK(t, { port, step, refusedRow }) {
  const fx = await protoEngine(t);
  fx.scripted.kindScript('check_authoring', authoringScript({ files: { ...CHECK_FILES, ...K_FILE } }));
  // The Builder's tree a Node service the deployment read can tell (a package.json start script), so the owner's read reaches the checks.
  fx.scripted.kindScript('stage_build', { steps: [usage(1500, 500, 700), write('server.mjs', SERVER), write('package.json', PACKAGE), result()] });
  const { id: p } = await toBrief(fx, { name: `Tasks M631 ${port}` });
  await answerOpen(fx, p, 'spec_approval');
  const env = await alphaReady(fx, p, { port });
  const ev = await drive(fx, p, () => authorizeEvaluations(fx.home, p).at(-1), { what: "the policy's alpha_authorize evaluation", step });
  const k = kExecutions(fx.home, p).find((x) => x.candidate === ev.candidate);
  assert.ok(k, `the fixture is live: K is registered on the evaluated candidate (${JSON.stringify(kExecutions(fx.home, p).map((x) => [x.candidate, x.status]))})`);
  assert.equal(k.status, 'running', 'K is running, its result to come');
  assert.deepEqual([...new Set(ev.reasons.map((r) => r.code))], ['CHECK_NOT_PASSED'], `the evaluation refuses CHECK_NOT_PASSED alone (${JSON.stringify(ev.reasons)})`);
  assert.deepEqual(ev.reasons.flatMap((r) => r.subjects ?? []), [k.check], 'on K alone');
  const registered = eventsOfType(fx.home, 'check.registered').filter((e) => e.subject?.check_execution === k.id);
  const evaluated = eventsOfType(fx.home, 'gate.evaluated').filter((e) => e.subject?.evaluation === ev.id);
  assert.equal(registered.length, 1);
  assert.equal(evaluated.length, 1);
  assert.ok(registered[0].seq < evaluated[0].seq, `by store order K's registration (seq ${registered[0].seq}) precedes the evaluation (seq ${evaluated[0].seq})`);
  if (step) assert.ok(k.created_at > ev.created_at, `the clock step inverts the stamps: K's created_at ${k.created_at} > the evaluation's ${ev.created_at}`);
  else assert.ok(k.created_at <= ev.created_at, `without a step the stamps are in order (${k.created_at} ≤ ${ev.created_at})`);
  const recorded = policyRequests(fx.home, p);
  let refused = null;
  if (refusedRow) {
    assert.deepEqual(recorded, [], `READING: the settling refusal recorded no outcome under its key (${JSON.stringify(recorded)})`);
    // FIXTURE TAMPERING (labelled): the key's earlier refusal, not_issued, as an engine records it (deploy.ts recordRequest).
    const [plan] = rows(fx.home, `SELECT "completion_binding" FROM "phase_plans" WHERE "project" = ? AND "completed_at" IS NOT NULL AND "completion_binding" IS NOT NULL ORDER BY "phase_number" DESC, rowid DESC`, p)
      .map((r) => JSON.parse(r.completion_binding))
      .filter((b) => b?.candidate === ev.candidate);
    assert.ok(plan, 'the phase completed on the evaluated candidate');
    const config = rows(fx.home, 'SELECT "current_config" FROM "environments" WHERE "id" = ?', env.id)[0].current_config;
    const key = canonical({ project: p, completion_binding: plan, candidate: ev.candidate, environment_configuration: config });
    const id = newId('dreq_');
    withStore(fx.home, (db) => db.prepare(`INSERT INTO "deployment_requests" ("id", "created_at", "project", "request_key", "requested_by", "candidate", "environment", "authorization", "work_item", "outcome", "reason") VALUES (?, ?, ?, ?, 'policy', ?, ?, NULL, NULL, 'not_issued', NULL)`).run(id, ev.created_at, p, key, ev.candidate, env.id), { readonly: false });
    refused = policyRequests(fx.home, p).find((r) => r.id === id);
  }
  return { fx, p, env, k, ev, refused };
}

// Ticks (each run of the project left to end, every check but K recorded) until `done`; undefined after `max`.
async function ticksUntil(fx, p, done, { max = 8 } = {}) {
  for (let i = 0; i < max; i++) {
    const v = done();
    if (v) return v;
    await idle(fx, p);
    await recordAllButK(fx, p);
    await tick(fx.engine, p);
  }
  await idle(fx, p);
  return done() || undefined;
}

const describeRequests = (fx, p, candidate) => JSON.stringify({ requests: policyRequests(fx.home, p).map((r) => [r.id, r.outcome, r.reason, r.authorization]), authorizations: issued(fx.home, candidate).map((a) => [a.id, a.status]), deploys: deployItems(fx.home, p).length });

// The refused request reconsidered and issued, once: one issued authorization, its row no longer not_issued, one deploy item.
async function assertReconsideredOnce(fx, p, J, what) {
  const reconsidered = await ticksUntil(fx, p, () => issued(fx.home, J.k.candidate).length > 0);
  assert.ok(reconsidered, `${what}: the engine reconsiders the refused request once K has passed: an authorization issued for the candidate (${describeRequests(fx, p, J.k.candidate)})`);
  const rowsNow = policyRequests(fx.home, p).filter((r) => r.candidate === J.k.candidate);
  assert.equal(rowsNow.length, 1, `${what}: the key's one policy row (${describeRequests(fx, p, J.k.candidate)})`);
  assert.notEqual(rowsNow[0].outcome, 'not_issued', `${what}: the request issued, K being the only reason (${JSON.stringify(rowsNow[0])})`);
  assert.equal(issued(fx.home, J.k.candidate).length, 1, `${what}: exactly one authorization issued`);
  assert.equal(rowsNow[0].authorization, issued(fx.home, J.k.candidate)[0].id, `${what}: the row carries it`);
  assert.equal(deployItems(fx.home, p).length, 1, `${what}: one deploy work item`);
}

describe('M631 a refused policy Alpha request reconsidered by store order', () => {
  test('(L) the literal path: K registered before the evaluation, stamped after it; no outcome recorded while K runs; K passes: one policy request, issued', async (t) => {
    const J = await evaluatedOnK(t, { port: 18631, step: true, refusedRow: false });
    const { fx, p, k } = J;
    assert.deepEqual(policyRequests(fx.home, p), [], 'the settling refusal recorded nothing under its key');
    await tick(fx.engine, p, { rounds: 3 });
    assert.deepEqual(policyRequests(fx.home, p), [], 'nothing while K runs');
    assert.deepEqual(issued(fx.home, k.candidate), [], 'nothing authorized while K runs');
    await move(fx, k.id, ['collecting', 'recorded'], 0);
    await assertReconsideredOnce(fx, p, J, '(L)');
    await tick(fx.engine, p, { rounds: 6 });
    assert.equal(issued(fx.home, k.candidate).length, 1, `(L) no second authorization across further ticks (${describeRequests(fx, p, k.candidate)})`);
    assert.equal(policyRequests(fx.home, p).length, 1, '(L) no second request row');
  });

  test('(a) the key refused not_issued, the newer evaluation stamped before K\'s registration: K passes; the request reconsidered, issued, once; (b) no second request across further ticks', async (t) => {
    const J = await evaluatedOnK(t, { port: 18632, step: true, refusedRow: true });
    const { fx, p, k } = J;
    await tick(fx.engine, p, { rounds: 3 });
    assert.deepEqual(issued(fx.home, k.candidate), [], 'nothing authorized while K runs');
    assert.equal(policyRequests(fx.home, p)[0]?.outcome, 'not_issued', 'the key stays not_issued while K runs');
    await move(fx, k.id, ['collecting', 'recorded'], 0);
    await assertReconsideredOnce(fx, p, J, '(a)');
    // (b) repeated ticks: never a second.
    await tick(fx.engine, p, { rounds: 6 });
    await idle(fx, p);
    await tick(fx.engine, p, { rounds: 4 });
    assert.equal(issued(fx.home, k.candidate).length, 1, `(b) no second authorization across ten ticks (${describeRequests(fx, p, k.candidate)})`);
    assert.equal(policyRequests(fx.home, p).length, 1, '(b) no second request row');
    assert.equal(deployItems(fx.home, p).length, 1, '(b) one deploy work item');
  });

  test('(c) K outstanding: no request, the read blocked on the running checks; K failed: no authorization issued, the latest evaluation naming K failed', async (t) => {
    const J = await evaluatedOnK(t, { port: 18633, step: true, refusedRow: true });
    const { fx, p, k } = J;
    await tick(fx.engine, p, { rounds: 4 });
    await idle(fx, p);
    await tick(fx.engine, p, { rounds: 2 });
    assert.deepEqual(issued(fx.home, k.candidate), [], '(c) nothing authorized while K is running');
    assert.deepEqual(policyRequests(fx.home, p).map((r) => r.outcome), ['not_issued'], '(c) no request while K is running');
    const read = (await projectRead(fx, p)).build?.deploy_readiness;
    assert.equal(read?.state, 'blocked', `(c) the owner's read: blocked while K runs (${JSON.stringify(read)})`);
    assert.deepEqual(read?.blocker, { what: 'checks_running', subject: null }, `(c) waiting on the running check (${JSON.stringify(read)})`);
    await move(fx, k.id, ['collecting', 'recorded'], 1);
    await ticksUntil(fx, p, () => false, { max: 6 });
    assert.deepEqual(issued(fx.home, k.candidate), [], `(c) K failed: nothing authorized (${describeRequests(fx, p, k.candidate)})`);
    assert.ok(policyRequests(fx.home, p).every((r) => r.outcome === 'not_issued'), `(c) K failed: the refusal lasting (${describeRequests(fx, p, k.candidate)})`);
    assert.equal(deployItems(fx.home, p).length, 0, '(c) no deploy work');
    const latest = authorizeEvaluations(fx.home, p).at(-1);
    const res = await fx.engine.get(`/v1/projects/${p}/candidates/${k.candidate}/gates/alpha_authorize`);
    assert.equal(res.status, 200, `the owner's gate read (→ ${res.status} ${res.text})`);
    const served = res.body.evaluation;
    assert.equal(served.id, latest.id, 'the gate read serves the latest evaluation');
    assert.ok(served.reasons.some((r) => r.code === 'CHECK_NOT_PASSED' && (r.subjects ?? []).includes(k.check)), `(c) it names K CHECK_NOT_PASSED (${JSON.stringify(served.reasons)})`);
    assert.equal(served.check_states?.[k.check], 'failed', `(c) K's state failed (${JSON.stringify(served.check_states)})`);
    const n = authorizeEvaluations(fx.home, p).length;
    await ticksUntil(fx, p, () => false, { max: 4 });
    assert.deepEqual(issued(fx.home, k.candidate), [], '(c) the failure is lasting: nothing authorized');
    assert.equal(authorizeEvaluations(fx.home, p).length, n, '(c) never a loop: no further evaluation');
  });

  test('(d) the registration and the evaluation stamped the same millisecond (a labelled store write): as (a)', async (t) => {
    const J = await evaluatedOnK(t, { port: 18634, step: false, refusedRow: true });
    const { fx, p, k, ev } = J;
    // FIXTURE TAMPERING (labelled): K's execution created_at made equal to the evaluation's. Only that wall stamp is written.
    const order = () => [eventsOfType(fx.home, 'check.registered').find((e) => e.subject?.check_execution === k.id)?.seq, eventsOfType(fx.home, 'gate.evaluated').find((e) => e.subject?.evaluation === ev.id)?.seq];
    const before = order();
    withStore(fx.home, (db) => db.prepare('UPDATE "check_executions" SET "created_at" = ? WHERE "id" = ?').run(ev.created_at, k.id), { readonly: false });
    assert.equal(kExecutions(fx.home, p).find((x) => x.id === k.id).created_at, ev.created_at, 'the fixture is live: the two stamps are equal to the millisecond');
    assert.deepEqual(order(), before, 'the store order of the two facts untouched');
    assert.ok(before[0] < before[1], 'K registered before the evaluation, by seq');
    await move(fx, k.id, ['collecting', 'recorded'], 0);
    await assertReconsideredOnce(fx, p, J, '(d)');
    await tick(fx.engine, p, { rounds: 6 });
    assert.equal(issued(fx.home, k.candidate).length, 1, '(d) no second authorization across further ticks');
    assert.equal(policyRequests(fx.home, p).length, 1, '(d) no second request row');
  });
});
