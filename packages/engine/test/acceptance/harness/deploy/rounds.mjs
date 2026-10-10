// Rounds, re-verification and completion for the M4 slice-25 rows, "verify
// behaviourally" (M314 to M319, and M305 (d) deferred here; SEAM.md §§265 to
// 271). Reads and requests only: nothing here creates a unit, runs
// systemd-run or systemctl, or signals a process. Used by the kernel-lane
// files on the scripted deployment adapter (SEAM.md §247) and by the
// sandbox-lane files beside harness/deploy/host.mjs.

import assert from 'node:assert/strict';

import { recordExit, stepExecution } from '../checks/selection.mjs';
import { tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { adapterState, candidateRow, environmentRecord, evaluateAlphaComplete, operationsOf, postDeployExecutions, roundsOf, setTarget, verificationsOf } from './kernel.mjs';

const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);

// ---- the re-verification route (SEAM.md §266) ----------------------------------------------

export const requestVerify = (engine, project, operation, body = {}) => engine.post(`/v1/projects/${project}/operations/${operation}/verify`, body);

// A new round of the operation's latest attempt, registered in the request:
// returns {id, round, operation, attempt}.
export async function verifyAgain(engine, project, operation) {
  const res = await requestVerify(engine, project, operation);
  assert.equal(res.status, 202, `POST …/operations/${operation}/verify registers a new round (SEAM.md §266) (body: ${res.text})`);
  assert.match(res.body?.round?.id ?? '', /^vr_/, `the answer names the round (body: ${res.text})`);
  assert.ok(Number.isInteger(res.body.round.round), `the answer gives the round's number (body: ${res.text})`);
  return res.body.round;
}

// ---- rounds, rows and executions -------------------------------------------------------------

export const roundRow = (home, id) => {
  const r = withStore(home, (db) => db.prepare('SELECT * FROM "verification_rounds" WHERE "id" = ?').get(id));
  return r && { ...r, required_checks: json(r.required_checks) };
};

// The verification row of a round (one per round), or undefined.
export const rowOf = (home, round) => verificationsOf(home, round)[0];

// Every post-deploy execution the engine registered for a round, by its
// binding (`check_executions.deployment.round`) only, whatever its trigger:
// a recovery retry of a round's execution keeps its deployment binding and
// has the trigger source `recovery` (SEAM.md §204; D4 §5.3 item 7;
// objection 039).
export const executionsOfRound = (home, candidate, round) =>
  withStore(home, (db) => db.prepare(`SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? ORDER BY x."execution_seq"`).all(candidate))
    .map((x) => ({ ...x, trigger: json(x.trigger), deployment: json(x.deployment) }))
    .filter((x) => x.deployment?.round === round);

// The executions of a round once at least `n` are registered, asking for ticks meanwhile.
export const roundExecutions = (ctx, round, { n = 1, max = 16 } = {}) =>
  tickUntil(
    ctx.fx.engine,
    ctx.project,
    () => {
      const found = executionsOfRound(ctx.fx.home, ctx.candidate.id, round);
      return found.length >= n ? found : undefined;
    },
    { max, what: `round ${round} to register its post-deploy check${n > 1 ? 's' : ''}` },
  );

// The row of a round, asking for ticks until it is recorded.
export const rowWhen = (ctx, round, { max = 16 } = {}) => tickUntil(ctx.fx.engine, ctx.project, () => rowOf(ctx.fx.home, round), { max, what: `the verification row of round ${round}` });

// The operation's newest round.
export const newestRound = (home, operation) => roundsOf(home, operation).at(-1);

// Each queued execution of a round recorded with `exit` (kernel lane, SEAM.md §190).
export async function recordRound(ctx, round, exit = 0) {
  const out = [];
  for (const x of executionsOfRound(ctx.fx.home, ctx.candidate.id, round)) if (x.status === 'queued') out.push(await recordExit(ctx.fx.engine, x.id, exit));
  return out;
}

export { recordExit, stepExecution };

// ---- completion ---------------------------------------------------------------------------------

export const alphaCompleteRows = (home, candidate) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' ORDER BY rowid`).all(candidate)).map((r) => ({ ...r, reasons: json(r.reasons) }));

// alpha_complete evaluated through its route for the operation; returns the evaluation object.
export async function completion(engine, project, candidate, operation) {
  const res = await evaluateAlphaComplete(engine, project, candidate, operation);
  assert.equal(res.status, 200, `alpha_complete is evaluated for ${operation} (SEAM.md §249) (body: ${res.text})`);
  return res.body.evaluation;
}

export const reasonCodesOf = (evaluation) => [...new Set((evaluation?.reasons ?? []).map((r) => r.code))].sort();

export const progressOf = (home, candidate) => candidateRow(home, candidate).progress;

// ---- the scripted target (SEAM.md §247) ---------------------------------------------------------

// Change the scripted target of an environment with `change(target)`, which
// returns the new target ({complete, units, resources}).
export async function changeTarget(engine, environment, change) {
  const { target } = await adapterState(engine, environment);
  const next = change(structuredClone({ complete: target.complete, units: target.units, resources: target.resources ?? [] }));
  await setTarget(engine, environment, next);
  return next;
}

export const callsOf = async (engine, environment, call) => (await adapterState(engine, environment)).calls.filter((c) => c.call === call);

// ---- the work read (SEAM.md §§98, 168; D4 A.2 WorkItem hold) ------------------------------------

export async function workEntry(engine, project, item) {
  const res = await engine.get(`/v1/projects/${project}/work`);
  assert.equal(res.status, 200, `the work read answers (body: ${res.text})`);
  const list = res.body.work ?? res.body.work_items ?? res.body.items ?? [];
  return list.find((w) => w.id === item) ?? null;
}

export { environmentRecord, operationsOf, roundsOf, verificationsOf };
