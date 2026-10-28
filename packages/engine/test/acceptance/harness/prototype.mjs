// Rapid prototype to Alpha, the M7 rows (M601 to M612; the owner's draft
// plan docs/acceptance/sdlc-M7-acceptance-plan.md; SEAM.md §575). The
// kernel lane's prototype: an engine with the scripted backend
// (runs.mjs scriptedEngine), apps made through `POST /v1/projects/new`,
// the products each role writes by work kind (the role program's
// `kind-<kind>` scripts, SEAM.md §350), the scripted check boundary
// (§190: each queued execution moved to recorded, exit 0, by the harness
// route) and the scripted deployment adapter with the qualification
// fixture (§§247, 248). Nothing here asserts a row's clause; it asserts only
// that the step it takes happened (a step that did not happen is a named
// failure, never a silent skip).
//
// The products are those of the Builder's developer demonstration
// (test/unit/rapid-prototype-demo.test.mjs, slice E5), restated here in the
// harness's own terms: a three-requirement task list, its first plan (one
// phase, two stages), its protected checks, and iteration 2's fourth
// requirement with its own phase-2 plan.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { configure, configContent, qualifyByFixture, scriptCall } from './deploy/kernel.mjs';
import { waitFor } from './engine.mjs';
import { changePolicy, eventsOfType } from './journal.mjs';
import { getRow, scriptedEngine, tick, waitForIdle } from './runs.mjs';
import { withStore } from './store.mjs';

// The Verifier's prototype table (contract/prototype.json; SEAM.md §575).
export const PROTO = JSON.parse(readFileSync(new URL('../contract/prototype.json', import.meta.url), 'utf8'));
export const CONFIG = JSON.parse(readFileSync(new URL('../contract/config.json', import.meta.url), 'utf8'));
export const LIMIT_KEYS = Object.freeze(Object.keys(CONFIG.project).filter((k) => k.startsWith('prototype_')));

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const parse = (t) => (typeof t === 'string' ? JSON.parse(t) : t);

// ---- the products the scripted roles write -------------------------------------------------

export const REQS = Object.freeze([
  { key: 'R1', title: 'Add a task', statement: 'A user adds a task with a title.', crit: 'Given the app is running, when a user posts a title, then the task is listed.' },
  { key: 'R2', title: 'List tasks', statement: 'A user lists the tasks.', crit: 'Given two tasks, when a user requests the list, then both are listed in order.' },
  { key: 'R3', title: 'Finish a task', statement: 'A user marks a task done.', crit: 'Given a task, when a user marks it done, then it is listed as done.' },
]);
export const REQ4 = Object.freeze({ key: 'R4', title: 'Count open tasks', statement: 'A user sees how many tasks are open.', crit: 'Given two open tasks and one done, when a user lists the tasks, then 2 open tasks are counted.', phase: 2 });
export const EXTRA_REQS = Object.freeze([
  { key: 'R4', title: 'Due dates', statement: 'A user gives a task a due date.', crit: 'Given a task, when a user sets a due date, then the date is listed with it.' },
  { key: 'R5', title: 'Sort by due date', statement: 'A user sorts the tasks by due date.', crit: 'Given two dated tasks, when a user sorts, then the earlier is first.' },
]);

export function specText({ version = 1, purpose = 'A small task list, to show the idea.', changeLog = [], reqs = REQS, environment = 'alpha' } = {}) {
  return `# Tasks

**Spec version:** ${version}
**Status:** draft
**Tier:** T1
**Owner:** Sean

## 1. Purpose

${purpose}

## 2. Non-goals

- Accounts

## 3. Users and situations

One person on this host.

## 4. Requirements

${reqs.map((r) => `### ${r.key}. ${r.title}\n\n${r.statement}\n\n**Rationale.** The prototype shows it.\n\n**Sensitive areas:** none\n\n**Acceptance criteria**\n\n- ${r.key}.1 ${r.crit}\n`).join('\n')}
## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria |
|---|---|---|---|---|
${reqs.map((r) => `| ${r.key} | ${r.title} | ${r.phase ?? 1} | none | ${r.key}.1 |`).join('\n')}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
| app | \`server.mjs\`, \`server.js\`, \`src/\` | none |

**Protected paths**

- \`.surety/checks/\`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| ${environment} | the owner's prototype target | the post-deploy behaviour check passes against it |

- **Target:** \`local_service\`, target \`app\`.
- **Runtime and start command:** \`node server.mjs\`.
- **Port:** \`PORT\`.
- **Excluded from the artifact:** none.
- **Required post-deploy behaviour check:** GET /tasks answers 200.
- **Stable arguments:** the service does not change its process title or arguments.

## 8. Constraints

- Node's own modules only.

## 9. Interfaces and data

HTTP on this host; JSON; no persistent data.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-28 | First approved version | Sean |
${changeLog.map((c) => `| ${c.version} | 2026-10-28 | ${c.change} | Sean |`).join('\n')}
`;
}

export const LIMITATIONS = Object.freeze(['tasks are lost when the service restarts', 'one user at a time; no login']);
export const modelBrief = (over = {}) => ({
  app: 'Tasks',
  for: 'one person trying the idea',
  experience: 'Open the page, add tasks, finish them.',
  included: ['adding, listing and finishing tasks'],
  objectives: REQS.map((r) => `${r.key}: ${r.statement}`),
  mocked: ['no login'],
  left_out: ['sharing a list'],
  assumptions: ['one user at a time'],
  limitations: [...LIMITATIONS],
  constraints: ["Node's own modules only"],
  estimates: { runs: [6, 9], tokens: [400_000, 900_000], usd: [0, 0], minutes: 30 },
  ...over,
});

// The scripted provider's usage (scripted-1: input, cache reads and output, each counted once).
export const usage = (input, cached, out) => ({ usage: { semantics: 'cumulative', raw: { input_tokens: input, cache_read_tokens: cached, output_tokens: out } } });
export const write = (path, content) => ({ write: { path, content } });
export const result = (extra = {}) => ({ result: { status: 'completed', summary: 'scripted role finished', ...extra } });

export const prepScript = ({ brief = modelBrief(), spec = specText(), use = usage(1200, 300, 400) } = {}) => ({ steps: [...(use ? [use] : []), write('.surety/spec/spec.md', spec), result({ summary: 'the brief and its minimal specification', brief })] });

export const MODULES = Object.freeze({ version: 1, modules: [{ name: 'app', paths: ['server.mjs', 'server.js', 'src/'], sensitive_areas: [], interfaces: [{ name: 'tasks', kind: 'http', path: '/tasks', description: 'the task list' }] }], mapping_from_spec: [{ spec_module: 'app', to: ['app'] }] });
export const ROADMAP = Object.freeze({ version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'the task list, end to end', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }] });
const stage = (number, goal, implements_, depends) => ({ number, goal, tasks: [goal], modules: ['app'], implements: implements_, adrs: [], depends_on: depends, validation: { criteria: implements_.map((k) => `${k}.1`), kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] });
export const STAGES = Object.freeze([stage(1, 'add and list tasks', ['R1', 'R2'], []), stage(2, 'finish a task', ['R3'], [1])]);
export const INDEPENDENT_STAGES = Object.freeze(STAGES.map((s) => ({ ...s, depends_on: [] })));
export const THREE_STAGES = Object.freeze([stage(1, 'add tasks', ['R1'], []), stage(2, 'list tasks', ['R2'], [1]), stage(3, 'finish a task', ['R3'], [2])]);

export const firstPlanScript = ({ use = usage(2000, 0, 900), stages = STAGES, modules = MODULES } = {}) => ({
  steps: [
    use,
    write('.surety/architecture/architecture.md', "# Tasks: architecture\n\nOne module, `app`: `server.mjs` with Node's own `http`, and helpers under `src/`.\n"),
    write('.surety/architecture/modules.json', json(modules)),
    write('.surety/roadmap/roadmap.json', json(ROADMAP)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list, end to end (R1, R2, R3).\n'),
    { write: { path: '.surety/phases/phase-1.json', content: json({ phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: '__HEAD__' }, stages, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-1.md', `# Phase 1\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`),
    result({ summary: 'the first plan', plan: 'phase-1', conformance: 'within_baseline' }),
  ],
});

export const ROADMAP2 = Object.freeze({ version: 2, architecture_version: 1, phases: [...ROADMAP.phases, { number: 2, goal: 'the open count', modules: ['app'], requirement_ids: ['R4'], depends_on: [1] }] });
export const STAGES2 = Object.freeze([stage(1, 'count the open tasks', ['R4'], [])]);
export const secondPlanScript = ({ use = usage(1800, 0, 700) } = {}) => ({
  steps: [
    use,
    write('.surety/roadmap/roadmap.json', json(ROADMAP2)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list, end to end (R1, R2, R3).\n2. The open count (R4).\n'),
    { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: STAGES2, conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 1: count the open tasks\n'),
    result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});

const def = (key, fields) => json({ schema: 1, key, ...fields });
const GATES = ['stage', 'alpha_authorize'];
export const CHECK_FILES = Object.freeze({
  '.surety/checks/protected-policy.json': json({ protected_paths: ['.surety/checks/'], check_commands: { probe: { path: '/usr/bin/true' } } }),
  '.surety/checks/defs/accept-r1.json': def('accept-r1', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
  '.surety/checks/defs/accept-r2.json': def('accept-r2', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R2.1'] } }),
  '.surety/checks/defs/accept-r3.json': def('accept-r3', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
  '.surety/checks/defs/smoke.json': def('smoke', { kind: 'smoke', command: ['probe'], timeout_s: 60, gate_kinds: GATES }),
  '.surety/checks/defs/operation.json': def('operation', { kind: 'post_deploy_behavior', command: ['probe'], timeout_s: 60, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
});
export const CHECK_FILE_R4 = Object.freeze({ '.surety/checks/defs/accept-r4.json': def('accept-r4', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: GATES, covers: { criteria: ['R4.1'] } }) });
export const authoringScript = ({ use = usage(900, 100, 300), files = CHECK_FILES } = {}) => ({
  steps: [use, ...Object.entries(files).map(([p, c]) => write(p, c)), result({ proposal: { rationale: "The Verifier authors the prototype's checks before any stage builds.", requested_change_kind: 'unclassifiable' } })],
});
export const SERVER = "import { createServer } from 'node:http';\nconst tasks = [];\ncreateServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(tasks)); }).listen(Number(process.env.PORT), '127.0.0.1');\n";
export const builderScript = (n, { use = usage(1500, 500, 700) } = {}) => ({
  steps: [use, n === 1 ? write('server.mjs', SERVER) : write(`src/s${n}.mjs`, `export const s${n} = ${n};\n`), result()],
});
export const builderOwn = (path, content, { use = usage(1500, 500, 700) } = {}) => ({ steps: [use, write(path, content), result()] });
// A Builder run that reports what it observed and holds until it is released or signalled.
export const holdingBuilder = (hold, { use = usage(1000, 0, 200) } = {}) => ({ steps: [use, { hold, heartbeat_ms: 250 }], on_term: 'exit' });

// The scripts every prototype of an engine follows by default (a launch with
// its own work-item or run script follows that one instead).
export function defaultScripts(fx) {
  fx.scripted.kindScript('brief_preparation', prepScript());
  fx.scripted.kindScript('replan', firstPlanScript());
  fx.scripted.kindScript('check_authoring', authoringScript());
  fx.scripted.kindScript('stage_build', builderScript(1));
  fx.scripted.kindScript('verification', { steps: [usage(300, 0, 100), result()] });
  fx.scripted.kindScript('phase_verification', { steps: [usage(300, 0, 100), result({ signoffs: [{ scope: 'phase' }] })] });
  fx.scripted.kindScript('fix', { steps: [usage(300, 0, 100), result()] });
  fx.scripted.defaultScript({ steps: [usage(100, 0, 50), result()] });
}

// The launches of a work kind so far (the role program's own log).
export const launchesOf = (fx, kind) => fx.scripted.launches({ work_kind: kind }).length;
// The next launches of `kind` follow `scripts`; each earlier ordinal keeps
// `before`, and so does every launch after them (a launch past the end of a
// kind's array follows the default script, which writes nothing).
export function kindNext(fx, kind, scripts, before) {
  fx.scripted.kindScript(kind, [...Array(launchesOf(fx, kind)).fill(before), ...scripts, ...Array(100).fill(before)]);
}

// ---- the engine and the owner's routes ------------------------------------------------------

// A kernel-lane engine with the scripted backend and the prototype's default scripts.
export async function protoEngine(t, { config = {} } = {}) {
  const fx = await scriptedEngine(t, { config });
  defaultScripts(fx);
  return fx;
}

export async function ok(res, status, what) {
  const r = await res;
  assert.equal(r.status, status, `${what} (→ ${r.status} ${r.text?.slice(0, 2000)})`);
  return r.body;
}

// POST /v1/projects/new: returns the answer as given (status and body).
export function postNew(fx, { name, idea = 'A small task list app: add, list and finish tasks.', mode = 'rapid_prototype', tier, extra = {} } = {}) {
  const n = ++fx.repos;
  const body = { name, idea, dev_repo_path: join(fx.root, `app-${n}`), ...(mode ? { mode } : {}), ...(tier ? { tier } : {}), ...extra };
  return fx.engine.post('/v1/projects/new', body);
}

// A new app, registered. A rapid prototype is created unpaused (S1); a
// planned app paused, and resumed here only when `resume` is true.
export async function newApp(fx, { resume = true, ...opts } = {}) {
  const res = await postNew(fx, opts);
  assert.equal(res.status, 201, `POST /v1/projects/new (${opts.mode === undefined ? 'rapid_prototype' : opts.mode}) (→ ${res.status} ${res.text})`);
  const id = res.body?.project?.id;
  assert.match(id ?? '', /^proj_/, `the answer names the project (${res.text})`);
  await waitFor(() => getRow(fx.home, 'projects', id)?.registration_state === 'registered', { what: `project ${id} registered` });
  if (opts.mode === null && resume) await ok(fx.engine.post(`/v1/projects/${id}/resume`, {}), 200, 'POST …/resume');
  return { id, res };
}

export const projectRead = async (fx, id) => (await ok(fx.engine.get(`/v1/projects/${id}`), 200, `GET /v1/projects/${id}`)).project;
export const iterationsRead = (fx, p) => ok(fx.engine.get(`/v1/projects/${p}/iterations`), 200, 'GET …/iterations');
export const iterationRead = (fx, p, i) => ok(fx.engine.get(`/v1/projects/${p}/iterations/${i}`), 200, 'GET …/iterations/:i');
export const currentIt = async (fx, p) => (await iterationsRead(fx, p)).iterations.at(-1);
export const openDecisionsRead = async (fx, p) => (await ok(fx.engine.get(`/v1/projects/${p}/decisions`), 200, 'GET …/decisions')).decisions;
export const decisionRead = async (fx, p, id) => (await ok(fx.engine.get(`/v1/projects/${p}/decisions/${id}`), 200, 'GET …/decisions/:d')).decision;
export const workRead = async (fx, p) => (await ok(fx.engine.get(`/v1/projects/${p}/work`), 200, 'GET …/work')).work_items;
export const policyRead = (fx, p) => ok(fx.engine.get(`/v1/projects/${p}/policy`), 200, 'GET …/policy');
export const answer = (fx, p, d, option = 'approve') => fx.engine.post(`/v1/projects/${p}/decisions/${d.id}/answer`, { option, preview_hash: d.preview_hash });
export async function answerOpen(fx, p, kind, option = 'approve') {
  const open = await openDecisionsRead(fx, p);
  const d = open.find((x) => x.kind === kind);
  assert.ok(d, `an open ${kind} is served (open: ${JSON.stringify(open.map((x) => x.kind))})`);
  await ok(answer(fx, p, d, option), 200, `answering ${kind} ${option}`);
  return d;
}

// ---- the store, read --------------------------------------------------------------------------

export const iterationRow = (home, id) => one(home, 'SELECT * FROM "prototype_iterations" WHERE "id" = ?', id);
export const iterationRows = (home, project) => rows(home, 'SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq"', project);
export const runsOfIteration = (home, it) => rows(home, 'SELECT r.*, w."kind" AS "work_kind" FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? ORDER BY r."seq"', it);
export const runsOfProjectRows = (home, project) => rows(home, 'SELECT r.*, w."kind" AS "work_kind" FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."project" = ? ORDER BY r."seq"', project);
export const workOfProject = (home, project) => rows(home, 'SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"', project);
export const ledgerOfInvocation = (home, inv) => rows(home, 'SELECT * FROM "ledger_rows" WHERE "invocation" = ? ORDER BY rowid', inv);
export const receiptsOfRun = (home, run) => rows(home, 'SELECT * FROM "invocation_receipts" WHERE "run" = ? ORDER BY rowid', run).map((r) => ({ ...r, budget_snapshot: parse(r.budget_snapshot) }));
export const decisionsOfProject = (home, project, kind) => rows(home, 'SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', project, kind).map((d) => ({ ...d, dependency_manifest: parse(d.dependency_manifest) }));
export const policyRevisionRows = (home, project) => rows(home, 'SELECT * FROM "policy_revisions" WHERE "project" = ? ORDER BY "revision"', project);
export const candidatesOfProject = (home, project) => rows(home, 'SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"', project);
export const deploymentRequestsOf = (home, project) => rows(home, 'SELECT * FROM "deployment_requests" WHERE "project" = ? ORDER BY rowid', project);
export const recordsOfKind = (home, project, kind) => rows(home, 'SELECT * FROM "records" WHERE "project" = ? AND "kind" = ? ORDER BY rowid', project, kind);
export const eventsFor = (home, type, key, id) => eventsOfType(home, type).filter((e) => e.subject?.[key] === id);
export const maxSeq = (home) => one(home, 'SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').n;
export const countRows = (home, table, where = '1 = 1', ...params) => one(home, `SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`, ...params).n;

// Runs of the project still under way (a session between turns is not).
export const runsUnderWay = (home, project) =>
  rows(home, `SELECT "id" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' AND "quarantined" = 0 AND NOT ("kind" = 'session' AND "session_state" IN ('open_idle', 'allocated', 'closed', 'closing'))`, project);

// ---- the scripted boundaries and the pump -----------------------------------------------------

const queuedExecutions = (home, project) =>
  rows(home, `SELECT x."id" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`, project);

// The kernel lane's scripted check boundary (SEAM.md §190): each queued
// execution of the project moved to recorded with exit 0.
export async function recordChecks(fx, project) {
  for (const { id } of queuedExecutions(fx.home, project)) {
    for (const to of ['materializing', 'running', 'collecting', 'recorded']) {
      const res = await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: id, to, ...(to === 'recorded' ? { exit_status: 0 } : {}) });
      if (res.status !== 200) break; // superseded or cancelled meanwhile
    }
  }
}

export const idle = (fx, project, timeoutMs = 120_000) => waitFor(() => runsUnderWay(fx.home, project).length === 0, { timeoutMs, what: `the runs of ${project} to end` });

export const CHECK_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening']);

// Tick until `done` answers, recording queued check executions (exit 0) and
// answering, as the owner, only the kinds given (each answer recorded in
// `acts`); never any other.
export async function pump(fx, project, done, { answer: kinds = [], max = 60, what = 'the journey to advance', acts = [], wait = true } = {}) {
  for (let i = 0; ; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i >= max) {
      const open = (await openDecisionsRead(fx, project)).map((d) => d.kind);
      const its = iterationRows(fx.home, project).map((r) => [r.seq, r.status, r.next_step, r.outcome_reason]);
      const work = workOfProject(fx.home, project).filter((w) => !['complete', 'cancelled'].includes(w.status)).map((w) => `${w.kind}:${w.status}:${w.held ?? ''}:${String(w.blocker ?? '').slice(0, 200)}`);
      throw new Error(`${what}: not reached in ${max} ticks (iterations: ${JSON.stringify(its)}; open decisions: ${JSON.stringify(open)}; work: ${JSON.stringify(work)}; acts: ${JSON.stringify(acts)}; engine stderr: ${fx.engine.proc.out.stderr.slice(-1500)})`);
    }
    if (wait) await idle(fx, project);
    await recordChecks(fx, project);
    for (const d of await openDecisionsRead(fx, project)) {
      if (!kinds.includes(d.kind)) continue;
      const res = await answer(fx, project, d, 'approve');
      acts.push({ kind: d.kind, id: d.id, status: res.status });
    }
    await tick(fx.engine, project);
    if (wait) await idle(fx, project);
    else await sleep(300);
  }
}

export const statusIs = (fx, p, it, status) => async () => ((await iterationRead(fx, p, it)).iteration.status === status ? true : undefined);

// The owner's local_service configuration of environment alpha (D4 A.2);
// the scripted adapter stands in for the unit, its deploy answers scripted,
// and the adapter qualified by the fixture (SEAM.md §§247, 248).
export async function alphaReady(fx, project, { name = 'alpha', port = 18080, answers = [{ result: 'issued', apply: true }] } = {}) {
  const done = await configure(fx.engine, project, name, configContent({ start: [process.execPath, 'server.mjs'], port }));
  const env = { ...done.environment, name };
  if (answers) await scriptCall(fx.engine, env.id, 'deploy', answers);
  await qualifyByFixture(fx.engine);
  return env;
}

// A policy submission as the owner makes it: a widening confirmed through
// its decision. Returns {status, prototype}: what the submission said of
// the prototype's current iteration.
export async function ownerPolicy(fx, p, change, what = 'the policy change') {
  const res = await fx.engine.post(`/v1/projects/${p}/policy`, change);
  if (res.status === 409) {
    assert.equal(res.body?.code, 'confirm_required', `${what}: a widening asks the owner (→ ${res.text})`);
    const d = await decisionRead(fx, p, res.body.subject.decision);
    await ok(answer(fx, p, d), 200, `the owner approves ${what}`);
    return { status: 409, widening: d, prototype: res.body.subject.prototype, res };
  }
  assert.ok([200, 201, 202].includes(res.status), `${what} (→ ${res.status} ${res.text})`);
  return { status: res.status, widening: null, prototype: res.body?.prototype, res };
}

// The iteration's limits once a change is committed.
export const limitsCommitted = (fx, p, it, key, value) => waitFor(async () => ((await iterationRead(fx, p, it)).iteration.limits[key] === value ? true : undefined), { what: `${key} ${value} committed on the iteration` });

// The owner's confirmed command (Stop, Discard, a run's stop): the first
// request answers 409 confirm_required with the preview; the second carries
// its hash. Returns {ask, done}.
export async function confirmed(fx, path) {
  const ask = await fx.engine.post(path, {});
  assert.equal(ask.status, 409, `${path} asks for its confirmation (→ ${ask.status} ${ask.text})`);
  assert.equal(ask.body?.code, 'confirm_required');
  const done = await ok(fx.engine.post(path, { preview_hash: ask.body.subject.preview_hash }), 200, `${path} confirmed`);
  return { ask, done };
}

// A prototype to the brief awaiting approval: created, its preparation
// approved, the brief prepared. Returns {id, it}.
// With `policy`, the owner first tightens the project's policy (changePolicy:
// applied directly, its revision awaited); a preparation question that
// bound the earlier policy is asked again (POST …/prepare) when it no longer
// stands.
export async function toBrief(fx, { policy, ...opts } = {}) {
  const { id } = await newApp(fx, opts);
  const it = await currentIt(fx, id);
  if (policy) await tightened(fx, id, it.id, policy);
  await answerOpen(fx, id, 'prototype_preparation_approval');
  await pump(fx, id, statusIs(fx, id, it.id, 'awaiting_brief_approval'), { what: 'the brief' });
  return { id, it };
}

export async function tightened(fx, id, it, policy) {
  await changePolicy(fx.engine, id, policy);
  await tick(fx.engine, id);
  if (!(await openDecisionsRead(fx, id)).some((d) => d.kind === 'prototype_preparation_approval')) {
    await ok(fx.engine.post(`/v1/projects/${id}/iterations/${it}/prepare`, {}), 201, 'POST …/prepare after the policy change');
  }
}

// From the brief to alpha_ready: the brief approved, alpha configured, the
// build pumped, the check correction answered by the owner.
export async function briefToAlpha(fx, p, it, { port = 18080, acts = [], max = 100 } = {}) {
  await answerOpen(fx, p, 'spec_approval');
  const env = await alphaReady(fx, p, { port });
  await pump(fx, p, statusIs(fx, p, it, 'alpha_ready'), { answer: CHECK_KINDS, acts, max, what: 'alpha_ready' });
  return env;
}

// Every invocation once, each figure the sum of the invocations' own:
// nothing counted twice, and no unknown shown as 0 (R9; D2 C4).
export function assertAccounted(read, what) {
  const invs = read.usage.runs.flatMap((r) => r.invocations);
  assert.equal(new Set(invs.map((i) => i.id)).size, invs.length, `${what}: every invocation once`);
  assert.equal(read.usage.totals.invocations, invs.length, `${what}: invocations counted`);
  assert.equal(read.usage.totals.agent_runs, read.usage.runs.length, `${what}: agent_runs counts runs`);
  const sum = (k) => invs.reduce((a, i) => (i.usage[k] === null ? a : (a ?? 0) + i.usage[k]), null);
  for (const k of ['billable_in', 'cached_in', 'out']) assert.equal(read.usage.totals.tokens[k], sum(k), `${what}: ${k} is the sum of the invocations' own`);
  const allowance = invs.reduce((a, i) => (i.unknown_allowance_tokens === null ? a : (a ?? 0) + i.unknown_allowance_tokens), null);
  assert.equal(read.usage.totals.unknown_allowance_tokens, allowance, `${what}: the unknown allowances apart, summed once`);
  if (invs.some((i) => i.usage.state === 'pending' || i.usage.state === 'incomplete')) assert.equal(read.usage.totals.tokens.total_is, 'lower_bound', `${what}: a lower bound while any usage is not complete`);
  const c = read.remaining.committed;
  if (c.total_tokens !== null) assert.equal(c.total_tokens, c.settled_tokens + c.unknown_allowance_tokens + c.under_way_observed_tokens + c.under_way_reserved_tokens, `${what}: committed is settled + allowances + under way`);
}

// The deploy answers for a further deployment or a teardown of `env`.
export const scriptDeploy = (fx, env) => scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
export const scriptTeardown = (fx, env) => scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);

export { json };

// Iteration 2's products (S4: one bounded phase of its own): the brief's
// fourth requirement in spec version 2, the phase-2 plan of one stage, its
// check, and the Builder's file. The scripts follow the kinds' launches so
// far; later launches keep the first iteration's.
export function secondIterationScripts(fx) {
  const reqs2 = [...REQS, REQ4];
  kindNext(fx, 'brief_preparation', [prepScript({ spec: specText({ version: 2, reqs: reqs2, changeLog: [{ version: 2, change: 'Show the number of open tasks at the top' }] }), brief: modelBrief({ objectives: reqs2.map((r) => `${r.key}: ${r.statement}`), included: ['adding, listing and finishing tasks', 'the number of open tasks'] }) })], prepScript());
  kindNext(fx, 'replan', [secondPlanScript()], firstPlanScript());
  kindNext(fx, 'check_authoring', [authoringScript({ files: { ...CHECK_FILES, ...CHECK_FILE_R4 } })], authoringScript());
  kindNext(fx, 'stage_build', [builderOwn('src/count.mjs', 'export const open = (ts) => ts.filter((t) => !t.done).length;\n')], builderScript(1));
}

// The environment observed (the observer runs off the tick once due: the
// engine's clock advanced past its cadence, SEAM.md §291) until the
// iteration's Alpha is current.
export async function observedCurrent(fx, p, it) {
  const res = await fx.engine.post('/v1/harness/clock/advance', { seconds: 31 });
  assert.equal(res.status, 200, `the clock advanced (${res.text})`);
  return pump(fx, p, async () => (await iterationRead(fx, p, it)).alpha.current ?? undefined, { what: 'an observation of alpha' });
}

// Iterate from `from` with `change`; iteration 2 driven to its own Alpha.
export async function iterateToAlpha(fx, p, from, env, { change = 'Show the number of open tasks at the top.', acts = [] } = {}) {
  const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${from}/iterate`, { change }), 201, 'POST …/iterate');
  const two = made.iteration.id;
  secondIterationScripts(fx);
  await scriptDeploy(fx, env);
  await answerOpen(fx, p, 'prototype_preparation_approval');
  await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
  await answerOpen(fx, p, 'spec_approval');
  await pump(fx, p, statusIs(fx, p, two, 'alpha_ready'), { answer: CHECK_KINDS, acts, max: 100, what: "iteration 2's own Alpha" });
  return { made, two };
}
