// M5 slice 37 (rows M437, M438; SEAM.md §427): the scripted envelope of
// the kernel lane, admission reads, and the three-stage phase of the
// reference project with its stages scripted by work item. Kernel lane: the
// scripted backend, the scripted check boundary; nothing here acts on a
// process but the test's own engine and its scripted roles.
//
// The scripted envelope † (`POST /v1/harness/envelope`, harness mode, kernel
// lane only): `{mem_available: <bytes> | "unreadable" | null,
// memory_current?: {<domain id>: <bytes> | "unreadable"}, default_current?:
// <bytes>}` → 200. While it is set, kernel-lane admission applies the
// as-built rule (reserve + Σ admitted maxima + service reservations +
// self-test reservations + unoccupied shared check capacity ≤ MemAvailable +
// Σ memory.current of the accounted domains) to the kernel lane's
// non-terminated domain rows at their recorded `memory_max`; `null` clears
// it (the kernel lane then has no memory arithmetic). `max_concurrent_domains`
// applies on the kernel lane whether or not it is set.

import assert from 'node:assert/strict';

import { waitFor } from '../engine.mjs';
import { listWork } from '../reads.mjs';
import { addWork, pauseProject, resumeProject, runsOf, runsOfProject, tick } from '../runs.mjs';
import { VALID_RESULT, step } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { builderScript, stagesOfPlan, workOf } from '../journey/drive.mjs';
import { journey35 } from '../journey/plan35.mjs';
import { ROADMAP3, S1, S2, S3, authoring3 } from '../journey/review35.mjs';
import { findingsOf } from '../gates.mjs';

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

// ---- the scripted envelope ------------------------------------------------------------------

export async function setEnvelope(fx, body) {
  const res = await fx.engine.post('/v1/harness/envelope', body);
  assert.equal(res.status, 200, `POST /v1/harness/envelope ${JSON.stringify(body)} (the kernel lane's scripted envelope †; → ${res.status} ${res.text})`);
  return res.body;
}
export const clearEnvelope = (fx) => setEnvelope(fx, { mem_available: null });

// ---- admission reads -------------------------------------------------------------------------

// The work read's entry for `item` (its `dispatch_hold`, its status).
export async function workRead(fx, project, item) {
  return (await listWork(fx.engine, project)).work_items.find((w) => w.id === item);
}
export const holdOf = async (fx, project, item) => (await workRead(fx, project, item))?.dispatch_hold ?? null;
export const liveRuns = (home, project) => runsOfProject(home, project).filter((r) => r.state !== 'ended');
export const domainsOfRun = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "run" = ? ORDER BY rowid').all(run));
export const domainOfItem = (home, item) => {
  const [run] = runsOf(home, item);
  return run ? domainsOfRun(home, run.id)[0] ?? null : null;
};
export const eventsNamed = (home, type) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "type" = ? ORDER BY "seq"').all(type)).map((e) => ({ ...e, subject: JSON.parse(e.subject ?? '{}'), payload: JSON.parse(e.payload ?? 'null') }));

// Whether a launch of `item` is holding at `name` now.
export function holding(fx, item, name = 'gate') {
  const launch = fx.scripted.launches({ work_item: item }).at(-1);
  return launch && fx.scripted.eventsOf(launch.pid, 'holding').some((e) => e.name === undefined || e.name === name) ? launch : undefined;
}

// `n` items of `kind` in `project`, each scripted to hold at `gate` and then
// complete. Returns their ids.
export async function heldItems(fx, project, n, { kind = 'verification', addWork } = {}) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const item = await addWork(fx.engine, project, kind);
    fx.scripted.script(item, [{ steps: [step.hold('gate', { heartbeat_ms: 250 }), step.result()] }]);
    items.push(item);
  }
  return items;
}

// Ticks (one request per round) until `probe` answers; never waits for runs to end.
export async function ticksUntil(fx, project, probe, { max = 40, what = 'the expected state' } = {}) {
  for (let i = 0; i <= max; i++) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i === max) break;
    await tick(fx.engine, project, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${what}: not reached within ${max} ticks`);
}

// A few ticks with nothing expected to change, then the state.
export async function settle(fx, project, rounds = 3) {
  await tick(fx.engine, project, { rounds });
  await new Promise((r) => setTimeout(r, 300));
}

// ---- the reference project's three-stage phase 1 ----------------------------------------------

// Phase 1 of three stages (R1, R2, R3): stage 2 depends on stage 1, stage 3
// on nothing (an independent stage, D6 §6.4), on the journey's path to
// `developing` (journey35: the production approvals and publication), at
// `tier`. The stages' work items are scripted by id (`scripts`: {1, 2, 3}
// → a script) before readiness, so no stage's launch takes another's script.
// Returns {fx, p, ctx, plan, stages: {1, 2, 3}, items: {1, 2, 3}}.
export async function threeStages(t, { tier = 'T2', policy = {}, scripts = {}, envelope } = {}) {
  const J = await journey35(t, { tier, policy, over: ROADMAP3, stages: [S1, { ...S2, depends_on: [1] }, { ...S3, depends_on: [] }] });
  const { fx, p, plan } = J;
  fx.scripted.kindScript('check_authoring', [authoring3]);
  if (envelope !== undefined) await setEnvelope(fx, envelope);
  const rows = stagesOfPlan(fx.home, plan.id);
  const stages = Object.fromEntries([1, 2, 3].map((n) => [n, rows.find((s) => s.number === n)]));
  for (const n of [1, 2, 3]) assert.ok(stages[n], `the fixture is live: stage ${n} was published (${JSON.stringify(rows.map((s) => s.number))})`);
  const items = Object.fromEntries([1, 2, 3].map((n) => [n, stageItem(fx.home, p.id, stages[n])]));
  for (const n of [1, 2, 3]) {
    assert.ok(items[n], `the fixture is live: stage ${n} has its stage_build work`);
    fx.scripted.script(items[n], [scripts[n] ?? builderScript(n === 3 ? 3 : n)]);
  }
  assert.equal(runsOf(fx.home, items[1]).length + runsOf(fx.home, items[2]).length + runsOf(fx.home, items[3]).length, 0, 'the fixture is live: no stage was built before its script');
  return { ...J, stages, items };
}

// The two-stage phase 1 of the reference project (stage 2 depends on 1), as
// threeStages, its stages scripted by work item.
export async function twoStages(t, { tier = 'T2', policy = {}, scripts = {}, envelope } = {}) {
  const J = await journey35(t, { tier, policy });
  const { fx, p, plan } = J;
  if (envelope !== undefined) await setEnvelope(fx, envelope);
  const rows = stagesOfPlan(fx.home, plan.id);
  const stages = Object.fromEntries([1, 2].map((n) => [n, rows.find((s) => s.number === n)]));
  const items = Object.fromEntries([1, 2].map((n) => [n, stageItem(fx.home, p.id, stages[n])]));
  for (const n of [1, 2]) fx.scripted.script(items[n], [scripts[n] ?? builderScript(n)]);
  assert.equal(runsOf(fx.home, items[1]).length + runsOf(fx.home, items[2]).length, 0, 'the fixture is live: no stage was built before its script');
  return { ...J, stages, items };
}

export const stageItem = (home, project, stage) => workOf(home, project, 'stage_build').find((w) => w.subject?.stage === stage.id)?.id ?? null;
export const stageRow = (home, plan, n) => stagesOfPlan(home, plan).find((s) => s.number === n);
export const workRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(id));

// The `work.dependency_met` events of a work item †.
export const dependencyMet = (home, item) => eventsNamed(home, 'work.dependency_met').filter((e) => e.subject?.work_item === item);

// A Builder that holds at `gate`, then writes stage `n`'s files.
export const heldBuilder = (n) => ({ steps: [step.hold('gate', { heartbeat_ms: 250 }), ...builderScript(n).steps] });

export { waitFor };

// A fix that names a finding (objection 092): a Verifier's finding on
// `candidate` (a Low defect naming `criterion`), dispositioned `fix` by a
// Reviewer's run, so the fix's integration is a cadence point and nominates
// the fixed code at every tier (E43; E104; SEAM.md §§42, 224); a fix naming
// no finding nominates nothing. `script` is the fix's role script, set by
// kind before the disposition so its first launch follows it. The two role
// runs are fixtures' work items (SEAM.md §15), each scripted while the
// project is paused (K1: new eligible work requests a tick), and each waited
// for by ticks that do not wait for the project's other runs, which a case
// may hold. Returns {finding, item}: the finding row and the fix work item.
async function fixtureRun(fx, project, kind, subject, result) {
  await pauseProject(fx.engine, project);
  const item = await addWork(fx.engine, project, kind, { subject });
  fx.scripted.script(item, [{ steps: [step.result({ ...VALID_RESULT, ...result })] }]);
  await resumeProject(fx.engine, project);
  const run = await ticksUntil(fx, project, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { what: `the fixture's ${kind} run to end` });
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the ${kind} run was accepted (${run.reason_text})`);
  return run;
}
// The finding names its criterion and the acceptance check covering it
// (`accept-r1` covers R1.1 in the reference project): a `fix` finding is
// resolved only by that check passing on a candidate it applies to (SEAM.md
// §§74, 191, 221), so a finding with no check would block its phase forever.
export async function findingFix(fx, project, candidate, script, { criterion = 'R1.1', check = 'accept-r1', message = 'src/sum.mjs: a string operand is concatenated, not added.' } = {}) {
  fx.scripted.kindScript('fix', [script]);
  const beforeFix = new Set(workOf(fx.home, project, 'fix').map((w) => w.id));
  const beforeFindings = findingsOf(fx.home, project).length;
  await fixtureRun(fx, project, 'verification', { candidate }, { findings: [{ category: 'defect', severity: 'low', message, criterion, check }] });
  const [finding] = findingsOf(fx.home, project).slice(beforeFindings);
  assert.ok(finding, 'the fixture is live: the Verifier\'s finding is recorded');
  await fixtureRun(fx, project, 'review', { candidate: finding.candidate }, { dispositions: [{ finding: finding.id, disposition: 'fix' }] });
  const item = await waitFor(() => workOf(fx.home, project, 'fix').find((w) => !beforeFix.has(w.id))?.id, { what: 'the fix work the disposition made' });
  return { finding, item };
}
