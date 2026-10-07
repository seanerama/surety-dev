// Helpers for the M3 rows of slice 16, "which result decides" (M206 to
// M209; SEAM.md §§189 to 194): the scripted check boundary of the kernel
// lane, the operator route, projects whose checks are discovered, and the
// reads of a candidate's results and of the gate's per-check entries.
//
// Kernel lane only. The engine admits no execution here (the runner switch,
// SEAM.md §177): an execution moves only when a test moves it through the
// scripted check boundary (§190), and its result is then the one the
// engine records in that transition.

import assert from 'node:assert/strict';

import { addItem, permittedEdit, roleThat, waitForCandidates } from '../gitruns.mjs';
import { getRow, runsOf, tick, tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { step } from '../scripted.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, checkProject, defPath, executionRow, gateCheckEntries, governedText, installIndexedPlan, requestChecks, smoke } from './fixtures.mjs';

// ---- the scripted check boundary (SEAM.md §190) -----------------------------------------------

// Move an execution one step along D3 A.5. `result` (exit_status, signaled,
// deadline_hit, orphans, output) goes with `to: 'recorded'` only. Returns
// the route's answer: {execution: {id, status}, check_result: {id, execution_seq} | null}.
export async function stepExecution(engine, execution, to, result = {}) {
  const res = await engine.post('/v1/harness/fixtures/check-execution', { execution, to, ...result });
  assert.equal(res.status, 200, `the scripted check boundary moves ${execution} to ${to} (SEAM.md §190) (body: ${res.text})`);
  assert.equal(res.body?.execution?.status, to, `the execution is ${to} (body: ${res.text})`);
  return res.body;
}

// Move an execution through each status of `path` in turn.
export async function drive(engine, execution, path, result = {}) {
  let last;
  for (const to of path) last = await stepExecution(engine, execution, to, to === 'recorded' ? result : {});
  return last;
}

export const TO_RUNNING = Object.freeze(['materializing', 'running']);
export const TO_RECORDED = Object.freeze(['materializing', 'running', 'collecting', 'recorded']);

// A queued execution run to its recorded result. Returns the result {id, execution_seq}.
export async function recordExit(engine, execution, exit_status, extra = {}) {
  const answer = await drive(engine, execution, TO_RECORDED, { exit_status, ...extra });
  assert.ok(answer.check_result?.id, `recording ${execution} answers with its result (body: ${JSON.stringify(answer)})`);
  return answer.check_result;
}

// ---- the operator route (SEAM.md §180) --------------------------------------------------------

// Register executions of the candidate's required checks (all, or `keys`).
// Returns {key: execution id}.
export async function operatorRequest(engine, project, candidate, keys) {
  const res = await requestChecks(engine, project, candidate, keys === undefined ? {} : { keys });
  assert.equal(res.status, 202, `the operator route registers (SEAM.md §180) (body: ${res.text})`);
  return Object.fromEntries(res.body.executions.map((x) => [x.key, x.id]));
}

// ---- reads ------------------------------------------------------------------------------------

// The result row an execution's recording wrote (check_results.execution).
export const resultOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').all(execution));

export const evaluationRow = (home, id) => getRow(home, 'gate_evaluations', id);

export const candidateRow = (home, id) => getRow(home, 'candidates', id);

// The per-check entry of an evaluation for a check id (SEAM.md §183).
export function entryOf(evaluation, checkId) {
  const entries = gateCheckEntries(evaluation);
  assert.ok(entries[checkId], `the evaluation has a checks entry for ${checkId} (keys: ${Object.keys(entries).join(', ')})`);
  return entries[checkId];
}

// The executions of one key of a candidate, oldest registration first.
export const executionsOfKey = (rows, key) => rows.filter((x) => x.key === key);

export { executionRow };

// ---- projects whose checks are discovered -----------------------------------------------------

// A T1 project whose governed file names KERNEL_COMMANDS and whose
// definitions are smoke checks `keys` at both gates (every one required); a
// plan whose one stage implements R1 (criterion R1.1). Smoke checks cover no
// criterion, so they are release obligations and each nomination registers
// them (SEAM.md §180).
export async function discoveredProject(fx, keys) {
  const files = { [GOVERNED_FILE]: governedText({ check_commands: KERNEL_COMMANDS }) };
  for (const key of keys) files[defPath(key)] = smoke(key);
  const p = await checkProject(fx, { files, tier: 'T1' });
  const plan = await installIndexedPlan(fx.engine, p.id, { index: [{ key: 'R1', criteria: ['R1.1'] }], stages: [{ number: 1, goal: 'the first stage', implements: ['R1'] }] });
  return { ...p, plan, stage: plan.stages[0] };
}

// The stage's Builder asks for the nomination (T1); tick until the candidate
// exists and every key has its nomination registration. Returns the candidate.
export async function nominateStage(fx, p, keys) {
  fx.scripted.script(p.stage.work_item, [roleThat([permittedEdit()], { nominate: true })]);
  await tick(fx.engine, p.id);
  const [candidate] = await waitForCandidates(fx, p.id);
  await tickUntil(
    fx.engine,
    p.id,
    () => {
      const rows = withStore(fx.home, (db) =>
        db.prepare(`SELECT c."key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."candidate" = ? AND json_extract(x."trigger", '$.source') = 'nomination'`).all(candidate.id),
      );
      return keys.every((k) => rows.some((r) => r.key === k)) ? true : undefined;
    },
    { max: 6, what: `the nomination registrations of ${keys.join(', ')}` },
  );
  return candidate;
}

// The next candidate of a T1 project: a fixture fix whose Builder asks for
// the nomination (gates.mjs `successor`, for a project of either kind).
export async function nextCandidate(fx, project) {
  const before = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "candidates" WHERE "project" = ?').get(project).n);
  const fix = await addItem(fx, project, 'fix');
  fx.scripted.script(fix, [roleThat([step.write(`src/fix-${before}.js`, `export const fix = ${before};\n`)], { nominate: true })]);
  await tickUntil(fx.engine, project, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
  return (await waitForCandidates(fx, project, before + 1)).at(-1);
}
