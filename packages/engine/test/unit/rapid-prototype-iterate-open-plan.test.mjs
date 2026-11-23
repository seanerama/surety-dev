// Developer tests for a continuing iteration over its predecessor's open
// plan (the defect observed on the live engine on 2026-11-23): an iteration
// that ended with its phase plan open (limit_reached, stopped, failed) left
// that plan published and active, and the next iteration's first plan,
// checked and passed, was refused `plan_generation_stale`, leaving the
// iteration building with nothing dispatchable. Iterate now closes the open
// plan (prototype/iterate.ts): the predecessor's receipt, runs, ledger rows
// and outcome untouched, its integrated stage kept as history, its unbuilt
// stage cancelled; the new iteration's first plan published under the
// prototype policy as generation 1 of its phase. A store iterated before
// the fix says so in the iteration's next step and the project's NOW.
//
// The harness is rapid-prototype-brief.test.mjs's: a scratch store with the
// engine's migrations; the finalizers' transactions called as the journal
// calls them; no engine, backend process or host resource is started.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { prepareNewProject } = await import(join(dist, 'setup', 'projects.js'));
const { bootstrapProject } = await import(join(dist, 'store', 'transitions', 'project.js'));
const R = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { raiseDecision, consumeDecision, getDecision } = await import(join(dist, 'store', 'transitions', 'decisions.js'));
const { publishWhole } = await import(join(dist, 'store', 'transitions', 'records.js'));
const { registerRef, integrationRef } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { parkWork } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { getWorkItem, transitionWork } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { recordIterationAlpha } = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const { parseSpecification } = await import(join(dist, 'spec', 'semantics.js'));
const { finalizeApproved } = await import(join(dist, 'spec', 'approval-effect.js'));
const { finalizeReplan, replanBaseline } = await import(join(dist, 'plan', 'bundle.js'));
const { checkPlan } = await import(join(dist, 'plan', 'check.js'));
const { readIteration, iterationReceipt } = await import(join(dist, 'prototype', 'iterations.js'));
const B = await import(join(dist, 'prototype', 'brief.js'));
const { markHolds } = await import(join(dist, 'scheduler', 'holds.js'));
const { iterate } = await import(join(dist, 'prototype', 'iterate.js'));
const { readProject } = await import(join(dist, 'store', 'projections.js'));
const { replanFacts, replanPromptText, prototypePlanText } = await import(join(dist, 'plan', 'replan-package.js'));

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {}, incarnation: 'inc_1' });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-28T00:00:00.000Z';

// ---- the products a scripted Spec Writer and Architect would leave ------------------------

const REQS = [
  { key: 'R1', title: 'Add a task', statement: 'A user adds a task with a title.', crit: 'Given the app is running, when a user posts a title, then the task is listed.' },
  { key: 'R2', title: 'List tasks', statement: 'A user lists the tasks.', crit: 'Given two tasks, when a user requests the list, then both are listed in order.' },
  { key: 'R3', title: 'Finish a task', statement: 'A user marks a task done.', crit: 'Given a task, when a user marks it done, then it is listed as done.' },
  { key: 'R4', title: 'Remove a task', statement: 'A user removes a task.', crit: 'Given a task, when a user removes it, then it is no longer listed.' },
  { key: 'R5', title: 'Count tasks', statement: 'A user reads how many tasks are open.', crit: 'Given three tasks of which one is done, when a user asks, then 2 is answered.' },
  { key: 'R6', title: 'Share tasks', statement: 'A user shares a list.', crit: 'Given a list, when a user shares it, then a link is answered.' },
];

function specText(n = 3, version = 1) {
  const reqs = REQS.slice(0, n);
  return `# Tasks

**Spec version:** ${version}
**Status:** draft
**Tier:** T1
**Owner:** Sean

## 1. Purpose

A small task list, to show the idea.

## 2. Non-goals

- Accounts

## 3. Users and situations

One person on this host.

## 4. Requirements

${reqs.map((r) => `### ${r.key}. ${r.title}\n\n${r.statement}\n\n**Rationale.** The prototype shows it.\n\n**Sensitive areas:** none\n\n**Acceptance criteria**\n\n- ${r.key}.1 ${r.crit}\n`).join('\n')}
## 5. Requirement index

| Key | Title | Phase | Sensitive areas | Criteria |
|---|---|---|---|---|
${reqs.map((r) => `| ${r.key} | ${r.title} | 1 | none | ${r.key}.1 |`).join('\n')}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
| app | \`server.mjs\`, \`src/\` | none |

**Protected paths**

- \`.surety/checks/\`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | the owner's prototype target | the post-deploy behaviour check passes against it |

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
${version > 1 ? `| ${version} | 2026-10-29 | The owner's change | Sean |\n` : ''}`;
}

const modelBrief = (n = 3, over = {}) => ({
  app: 'Tasks',
  for: 'one person trying the idea',
  experience: 'Open the page, add tasks, finish them.',
  included: ['adding, listing and finishing tasks'],
  objectives: REQS.slice(0, n).map((r) => `${r.key}: ${r.statement}`),
  mocked: ['no login'],
  left_out: [],
  assumptions: ['Assumption: one user at a time'],
  limitations: ['tasks are lost on restart'],
  constraints: ["Node's own modules only"],
  estimates: { runs: [5, 8], tokens: [400_000, 900_000], usd: [0, 0], minutes: 30 },
  ...over,
});

const MODULES = { version: 1, modules: [{ name: 'app', paths: ['server.mjs', 'src/'], sensitive_areas: [], interfaces: [{ name: 'tasks', kind: 'http', path: '/tasks', description: 'the task list' }] }], mapping_from_spec: [{ spec_module: 'app', to: ['app'] }] };
const roadmapOf = (phases) => ({ version: 1, architecture_version: 1, phases });
const stage = (number, keys, depends = []) => ({
  number,
  goal: `stage ${number}`,
  implements: keys,
  modules: ['app'],
  tasks: [`build ${keys.join(', ')}`],
  depends_on: depends,
  validation: { criteria: keys.map((k) => `${k}.1`), kinds: ['acceptance', 'smoke'], sensitive_areas: [] },
  integration_obligations: [],
  adrs: [],
});

// ---- the scratch store --------------------------------------------------------------------

function scratch(t) {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-rpio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'scratch'), { recursive: true });
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  db.prepare(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`).run(AT, AT);
  const rt = { home, scratch: join(home, 'scratch'), setting: () => 30 };
  let n = 0;
  const create = async () => {
    const prepared = await prepareNewProject(rt, { name: 'Tasks', idea: 'A small task list app.', dev_repo_path: join(dir, `app${++n}`), mode: 'rapid_prototype' });
    const made = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared));
    db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(made.project.id);
    transact(db, ENGINE_ACTOR, (tx) => registerRef(tx, { project: made.project.id, ref: integrationRef('main'), kind: 'integration', expected: 'sha_boot' }));
    return made.project;
  };
  return { db, create };
}

const iteration = (db, id) => db.prepare('SELECT * FROM prototype_iterations WHERE id = ?').get(id);
const decisionsOf = (db, project, kind) => db.prepare('SELECT * FROM decisions WHERE project = ? AND kind = ? ORDER BY seq').all(project, kind);
const events = (db, type) => db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => JSON.parse(e.payload));
const answer = (db, project, d, option = 'approve') => transact(db, HUMAN, (tx) => answerQueued(tx, { project, decision: d.id, option, preview_hash: d.preview_hash, note: null }));
const itemsOf = (db, project, kind) => db.prepare('SELECT * FROM work_items WHERE project = ? AND kind = ? ORDER BY seq').all(project, kind);

// A run of a work item claimed through the dispatch transaction, launched,
// with `raw` usage, ended `outcome`.
function claim(db, project, workItem) {
  const c = transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project, workItem, incarnation: 'inc_1', scripted: 'scripted-1' }));
  assert.ok(c, `work item ${workItem} is dispatched`);
  return { run: c.run, inv: db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(c.run).id, dom: db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(c.run).id };
}
function launch(db, r, raw) {
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: r.run, invocation: r.inv });
    R.recordLaunch(tx, { run: r.run, invocation: r.inv, domain: r.dom, pid: 999999, pgid: 999999, startTime: null });
  });
  if (raw) transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: r.run, generation: 1, invocation: r.inv, semantics: 'cumulative', raw }));
}
function end(db, r, outcome = 'completed', reason = 'none') {
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: r.run, outcome, reason }));
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: r.dom, observed: true }));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: r.run, invocations: { [r.inv]: 'ended' }, recovery: null }));
}
const setStatus = (db, item, status) => db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(status, item);

// The brief preparation as its acceptance and integration finalizer would
// make it (runs/accept.ts briefOf, then the integration's finalizer): the
// specification parsed, the model's brief validated and completed with the
// served facts, its record, and recordPreparedBrief in the finalizer's
// transaction. Returns the spec_approval raised.
let recordSeq = 0;
function prepareBrief(db, project, { n = 3, version = 1, brief = modelBrief(n), outcome = 'completed' } = {}) {
  const item = itemsOf(db, project, 'brief_preparation').at(-1);
  const r = claim(db, project, item.id);
  launch(db, r, { input_tokens: 1000, cache_read_tokens: 0, output_tokens: 200 });
  const parsed = parseSpecification(specText(n, version));
  assert.equal(parsed.readable, true);
  const model = B.validateModelBrief(brief, parsed.representation);
  if ('refused' in model) {
    end(db, r, 'failed', 'invalid_result');
    return { run: r.run, refused: model.refused };
  }
  const facts = transact(db, ENGINE_ACTOR, (tx) => B.briefFacts(tx.db, { project, run: r.run, environments: parsed.representation.environments.map((e) => e.name) }));
  const full = B.composeBrief(model.brief, facts, AT);
  assert.equal(B.briefShapeProblem(full), null);
  const record = `rec_brief_${++recordSeq}`;
  transact(db, ENGINE_ACTOR, (tx) => publishWhole(tx, { id: record, project, run: r.run, kind: 'prototype_brief', path: record, sha256: 'a'.repeat(64), bytes: 10, redactionVersion: '1' }));
  setStatus(db, item.id, 'integrated');
  const decision = transact(db, ENGINE_ACTOR, (tx) =>
    B.recordPreparedBrief(tx, { project, run: r.run, work_item: item.id, prepared: { brief: full, record, digest: 'd', blob: `blob_${recordSeq}`, semantic_digest: parsed.digest, representation: parsed.representation, findings: parsed.findings } }),
  );
  end(db, r, outcome);
  return { run: r.run, record, brief: full, decision: getDecisionRow(db, decision) };
}
const getDecisionRow = (db, id) => (id ? db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) : null);

// The spec approval's effect, as its journaled commit's finalizer runs it.
function applySpecApproval(db, project, d) {
  const intent = db.prepare('SELECT id FROM effect_intents WHERE decision = ?').get(d.id);
  assert.ok(intent, 'approve records the effect intent');
  const blob = db.prepare(`SELECT git_blob FROM spec_semantics WHERE run = ? ORDER BY rowid DESC LIMIT 1`).get(d.subject_id).git_blob;
  return transact(db, ENGINE_ACTOR, (tx) => finalizeApproved(tx, { id: 'op_spec', project }, { purpose: 'spec_approved', ref: integrationRef('main'), ref_kind: 'integration', new_oid: 'sha_spec', run: d.subject_id, decision: d.id, intent: intent.id, blob }));
}

// The first plan as the Architect's acceptance and integration finalizer
// would record it (runs/accept.ts replanOf, plan/bundle.ts finalizeReplan).
function firstPlan(db, project, { stages = [stage(1, ['R1', 'R2']), stage(2, ['R3'], [1])], phases = [{ number: 1, goal: 'show the idea', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }], modules = MODULES } = {}) {
  const item = itemsOf(db, project, 'replan').at(-1);
  const r = claim(db, project, item.id);
  launch(db, r, { input_tokens: 2000, output_tokens: 500 });
  const base = transact(db, ENGINE_ACTOR, (tx) => replanBaseline(tx.db, { project, head: 'sha_spec', work_item: item.id }));
  assert.equal(base.first_plan, true);
  assert.equal(base.baseline.approved, null, 'planned against no approved architecture');
  const roadmap = roadmapOf(phases);
  const plan = { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'sha_spec' }, stages, conformance: 'within_baseline' };
  const artifacts = { modules, roadmap, adrs: {}, adr_front_matter: {}, architecture_text: 'One module.', plan };
  const check = checkPlan({ ...base.baseline, architecture_version: 1, roadmap_version: 1, roadmap_architecture_version: 1 }, artifacts);
  const bundle = `rec_bundle_${++recordSeq}`;
  transact(db, ENGINE_ACTOR, (tx) => publishWhole(tx, { id: bundle, project, run: r.run, kind: 'plan_check', path: bundle, sha256: 'b'.repeat(64), bytes: 10, redactionVersion: '1' }));
  setStatus(db, item.id, 'integrated');
  transact(db, ENGINE_ACTOR, (tx) => registerRef(tx, { project, ref: integrationRef('main'), kind: 'integration', expected: 'sha_plan' }));
  const prepared = { bundle, obligations_record: null, phase: 1, head: 'sha_plan', blobs: {}, content: { modules, roadmap, roadmap_changed: true, plan, adrs: {}, architecture_text: 'One module.' }, check, spec_revision: base.spec_revision, architecture_revision: null, roadmap_revision: null, versions: { architecture: 1, roadmap: 1, phase_plan: 1 }, diff: null, declared: {}, replaces: null };
  const published = transact(db, ENGINE_ACTOR, (tx) => finalizeReplan(tx, { project, run: r.run, prepared, integrated: 'sha_plan', base: 'sha_spec' }));
  end(db, r);
  return { run: r.run, bundle, check, published };
}


// A later iteration's plan of phase 1, against the architecture and roadmap
// its predecessor published (unchanged here), as runs/accept.ts and the
// integration finalizer would record it.
function laterPlan(db, project, { head, stages = [stage(1, ['R1', 'R2', 'R3'])], phases = [{ number: 1, goal: 'show the idea', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }] } = {}) {
  const item = itemsOf(db, project, 'replan').at(-1);
  const r = claim(db, project, item.id);
  launch(db, r, { input_tokens: 2000, output_tokens: 500 });
  const base = transact(db, ENGINE_ACTOR, (tx) => replanBaseline(tx.db, { project, head, work_item: item.id }));
  assert.equal(base.first_plan, true);
  assert.notEqual(base.baseline.approved, null, 'planned against the approved architecture');
  const roadmap = roadmapOf(phases);
  const plan = { phase: 1, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 1, revision: head }, stages, conformance: 'within_baseline' };
  const artifacts = { modules: MODULES, roadmap, adrs: {}, adr_front_matter: {}, architecture_text: 'One module.', plan };
  const check = checkPlan(base.baseline, artifacts);
  const bundle = `rec_bundle_${++recordSeq}`;
  transact(db, ENGINE_ACTOR, (tx) => publishWhole(tx, { id: bundle, project, run: r.run, kind: 'plan_check', path: bundle, sha256: 'b'.repeat(64), bytes: 10, redactionVersion: '1' }));
  setStatus(db, item.id, 'integrated');
  const integrated = `${head}_plan`;
  transact(db, ENGINE_ACTOR, (tx) => registerRef(tx, { project, ref: integrationRef('main'), kind: 'integration', expected: integrated }));
  const prepared = { bundle, obligations_record: null, phase: 1, head: integrated, blobs: {}, content: { modules: MODULES, roadmap, roadmap_changed: false, plan, adrs: {}, architecture_text: 'One module.' }, check, spec_revision: base.spec_revision, architecture_revision: base.architecture_revision, roadmap_revision: base.roadmap_revision, versions: { architecture: 1, roadmap: 1, phase_plan: 1 }, diff: null, declared: {}, replaces: null };
  const published = transact(db, ENGINE_ACTOR, (tx) => finalizeReplan(tx, { project, run: r.run, prepared, integrated, base: head }));
  // The integration's finalizer completes the Architect's work in the same
  // transaction (store/transitions/finalize.ts).
  setStatus(db, item.id, 'complete');
  end(db, r);
  return { item: item.id, run: r.run, bundle, check, published };
}

// Iteration 1 through its policy-published first plan; stage 1 integrated
// and verifying, stage 2 not built; ended limit_reached with the plan open.
async function iterationOneEndedOpen(t) {
  const { db, create } = scratch(t);
  const p = await create();
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval')[0]);
  const b = prepareBrief(db, p.id);
  answer(db, p.id, b.decision);
  applySpecApproval(db, p.id, b.decision);
  const plan = firstPlan(db, p.id);
  assert.ok(plan.published, 'iteration 1 published its first plan');
  const [s1, s2] = db.prepare('SELECT * FROM stages WHERE phase_plan = ? ORDER BY number').all(plan.published);
  db.prepare(`UPDATE stages SET status = 'integrated', integrated_revision = 'sha_s1' WHERE id = ?`).run(s1.id);
  setStatus(db, s1.work_item, 'verifying');
  db.prepare(`UPDATE prototype_iterations SET status = 'limit_reached', ended_at = ?, outcome_reason = 'the runtime limit was reached', next_step = 'iterate or discard' WHERE id = ?`).run(AT, p.iteration);
  return { db, p, plan: plan.published, s1, s2 };
}

// The predecessor as its owner reads it: row, runs, ledger rows, receipt.
function predecessorState(db, p) {
  const receipt = iterationReceipt(db, { project: p.id, iteration: p.iteration });
  // Served now (the envelope), current guidance (Iterate itself moves it), or the app's sum
  // across iterations: not the predecessor's own record.
  for (const k of ['generated_at', 'served_at', 'snapshot_seq', 'app_totals', 'controls']) delete receipt[k];
  return {
    row: iteration(db, p.iteration),
    runs: db.prepare('SELECT * FROM runs WHERE iteration = ? ORDER BY seq').all(p.iteration),
    ledger: db.prepare('SELECT l.* FROM ledger_rows l JOIN runs r ON r.id = l.run WHERE r.iteration = ? ORDER BY l.rowid').all(p.iteration),
    receipt,
  };
}

test("Iterate closes the predecessor's open plan: its integrated stage kept as history, its unbuilt stage cancelled; the predecessor's receipt, runs, ledger rows and outcome untouched", async (t) => {
  const { db, p, plan, s1, s2 } = await iterationOneEndedOpen(t);
  const before = predecessorState(db, p);
  assert.ok(before.runs.length > 0 && before.ledger.length > 0, 'iteration 1 has runs and ledger rows to keep');
  const made = transact(db, HUMAN, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: 'Show the count.' }));
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.closed_plans, [{ phase_plan: plan, phase: 1, generation: 1, cancelled: [s2.id], superseded: [s1.id] }]);
  const row = db.prepare('SELECT * FROM phase_plans WHERE id = ?').get(plan);
  assert.deepEqual([row.status, row.active, row.replaced_by, row.completed_at, row.routing, row.approved_by], ['replaced', 0, null, null, 'policy_authorized', 'policy:rapid_prototype']);
  assert.deepEqual(JSON.parse(row.replacement), { closed_by: 'iterated', iteration: p.iteration, successor: made.body.iteration.id, cancelled: [s2.id], superseded: [s1.id] });
  const one = db.prepare('SELECT * FROM stages WHERE id = ?').get(s1.id);
  assert.deepEqual([one.status, one.integrated_revision, typeof one.cancelled_at], ['integrated', 'sha_s1', 'string'], 'the integrated stage is history: its status and revision kept');
  const two = db.prepare('SELECT * FROM stages WHERE id = ?').get(s2.id);
  assert.deepEqual([two.status, typeof two.cancelled_at], ['cancelled', 'string']);
  for (const w of [s1.work_item, s2.work_item]) assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(w).status, 'cancelled', 'its work cancelled by Iterate (R7)');
  assert.equal(db.prepare(`SELECT 1 FROM phase_plans WHERE project = ? AND status = 'published' AND active = 1`).get(p.id), undefined, 'no plan of the project is open');
  assert.deepEqual(events(db, 'prototype.iteration_iterated')[0].closed_plans, made.body.closed_plans);
  assert.deepEqual(predecessorState(db, p), before, 'the predecessor as its owner reads it is unchanged');
});

test("the continuing iteration's first plan lands: published policy_authorized as generation 1 of phase 1, its own stages and check authoring, the iteration building on it", async (t) => {
  const { db, p, plan: old } = await iterationOneEndedOpen(t);
  const two = transact(db, HUMAN, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: 'Show the count.' })).body.iteration.id;
  const before = predecessorState(db, p);
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval').at(-1));
  const b = prepareBrief(db, p.id, { version: 2 });
  answer(db, p.id, b.decision);
  applySpecApproval(db, p.id, b.decision);
  assert.equal(db.prepare('SELECT version FROM spec_revisions WHERE project = ? ORDER BY version DESC').get(p.id).version, 2);
  const item = itemsOf(db, p.id, 'replan').at(-1);
  assert.deepEqual([item.trigger_source, item.trigger_id, item.status], ['prototype_first_plan', two, 'eligible']);
  // The Architect is told what it continues, never that nothing is approved.
  const facts = replanFacts(db, item);
  assert.deepEqual([facts.open_plan, facts.trigger_subject.replaces], [null, null], 'no open plan to replace');
  const text = replanPromptText(facts).join('\n');
  assert.match(text, /continues an earlier one that ended before its phase 1 was complete\. That plan was closed when this iteration began: none of its stages is kept/);
  assert.doesNotMatch(text, /Nothing is approved yet/);
  assert.match(prototypePlanText({ iteration: 'x', bounds: { phases: 1, max_stages: 2 }, brief: null }).join('\n'), /Nothing is approved yet but its brief/, "a first iteration's text is as it was");

  const plan = laterPlan(db, p.id, { head: 'sha_spec2' });
  assert.equal(plan.check.outcome, 'passed', JSON.stringify(plan.check.reasons));
  assert.ok(plan.published, 'published at once');
  assert.deepEqual(events(db, 'plan.generation_refused'), [], 'nothing refused');
  assert.deepEqual(decisionsOf(db, p.id, 'architecture_approval').concat(decisionsOf(db, p.id, 'plan_approval')), [], 'no owner question');
  const pp = db.prepare('SELECT * FROM phase_plans WHERE id = ?').get(plan.published);
  assert.deepEqual([pp.phase_number, pp.generation, pp.status, pp.active, pp.routing, pp.approved_by, pp.bundle], [1, 1, 'published', 1, 'policy_authorized', 'policy:rapid_prototype', plan.bundle]);
  const stages = db.prepare('SELECT * FROM stages WHERE phase_plan = ?').all(plan.published);
  assert.equal(stages.length, 1);
  assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(stages[0].work_item).status, 'eligible', 'its own stage work');
  assert.ok(pp.check_authoring, "the phase's check authoring registered with the plan");
  assert.equal(db.prepare('SELECT status FROM phase_plans WHERE id = ?').get(old).status, 'replaced', "the predecessor's plan stays closed");
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  const it = iteration(db, two);
  assert.deepEqual([it.phase_plan, it.plan_bundle, it.status, it.next_step], [plan.published, plan.bundle, 'building', 'none: building']);
  assert.equal(readIteration(db, { project: p.id, iteration: two }).plan.routing, 'policy_authorized');
  assert.deepEqual(predecessorState(db, p), before, 'the predecessor is untouched by its successor\'s plan');
});

test('a completed plan is history: Iterate closes nothing', async (t) => {
  const { db, p, plan } = await iterationOneEndedOpen(t);
  db.prepare(`UPDATE phase_plans SET status = 'completed', completed_at = ? WHERE id = ?`).run(AT, plan);
  const row = db.prepare('SELECT * FROM phase_plans WHERE id = ?').get(plan);
  const stages = db.prepare('SELECT * FROM stages WHERE phase_plan = ? ORDER BY number').all(plan);
  const made = transact(db, HUMAN, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: null }));
  assert.deepEqual(made.body.closed_plans, []);
  assert.deepEqual(db.prepare('SELECT * FROM phase_plans WHERE id = ?').get(plan), row);
  assert.deepEqual(db.prepare('SELECT * FROM stages WHERE phase_plan = ? ORDER BY number').all(plan), stages);
});

test('a store iterated before the fix: the first plan refused stale is said in the next step and NOW, and Stop then Iterate closes the open plan', async (t) => {
  const { db, p, plan: old } = await iterationOneEndedOpen(t);
  const two = transact(db, HUMAN, (tx) => iterate(tx, { project: p.id, iteration: p.iteration, change: 'Show the count.' })).body.iteration.id;
  // As the live store was: the predecessor's plan left open.
  db.prepare(`UPDATE phase_plans SET status = 'published', active = 1, replacement = NULL WHERE id = ?`).run(old);
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval').at(-1));
  const b = prepareBrief(db, p.id, { version: 2 });
  answer(db, p.id, b.decision);
  applySpecApproval(db, p.id, b.decision);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(iteration(db, two).next_step, 'none: building', 'while the first plan is being made, nothing more is claimed');
  const plan = laterPlan(db, p.id, { head: 'sha_spec2' });
  assert.equal(plan.check.outcome, 'passed');
  assert.equal(plan.published, null);
  const refused = events(db, 'plan.generation_refused');
  assert.equal(refused.length, 1);
  assert.match(refused[0].cause, /phase 1 has an open plan/);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  const it = iteration(db, two);
  assert.equal(it.status, 'building');
  assert.equal(it.next_step, `none can be dispatched: the first plan (bundle ${plan.bundle}) was not published: phase 1 has an open plan (${old}); a replacement is the early-replacement route's; stop this iteration and iterate, or discard`);
  const now = readProject(db, { project: p.id }).project.now;
  assert.equal(now.state, 'idle');
  assert.equal(now.reason, `Prototype iteration 2 is building, but ${it.next_step}.`);
  // The owner's way on: Stop (here its effect only), then Iterate.
  db.prepare(`UPDATE prototype_iterations SET status = 'stopped', ended_at = ? WHERE id = ?`).run(AT, two);
  const three = transact(db, HUMAN, (tx) => iterate(tx, { project: p.id, iteration: two, change: null }));
  assert.deepEqual(three.body.closed_plans.map((c) => c.phase_plan), [old]);
  assert.equal(db.prepare(`SELECT 1 FROM phase_plans WHERE project = ? AND status = 'published' AND active = 1`).get(p.id), undefined);
});
