// Developer tests for Rapid prototype slice E3 (migration 0045; the owner's
// rulings R1, R3 and R5 of 2026-10-28): the preparation authorization, the
// brief and its validation, the brief on spec_approval, the first plan
// published by the prototype policy within its bounds or routed to the
// owner, and the iteration's status through the whole path; with one
// disposable demonstration of that path on the scripted backend.
//
// A scratch store with the engine's migrations and a scratch git repository
// under the harness, so that the scripted backend is every role's default.
// The steps the main thread does with git (the preparation's and the
// Architect's commits, their journaled integrations, the spec approval's
// change-log commit) are not run: their finalizers' transactions are called
// as the journal calls them, with the products the acceptance would have
// prepared (prototype/brief.ts composeBrief; plan/check.ts checkPlan). No
// engine process, backend process, deployment or host resource is started.

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

function specText(n = 3) {
  const reqs = REQS.slice(0, n);
  return `# Tasks

**Spec version:** 1
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
`;
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
  const dir = mkdtempSync(join(tmpdir(), 'surety-rpe3-'));
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
function prepareBrief(db, project, { n = 3, brief = modelBrief(n), outcome = 'completed' } = {}) {
  const item = itemsOf(db, project, 'brief_preparation').at(-1);
  const r = claim(db, project, item.id);
  launch(db, r, { input_tokens: 1000, cache_read_tokens: 0, output_tokens: 200 });
  const parsed = parseSpecification(specText(n));
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

// ---- tests --------------------------------------------------------------------------------

test('the preparation authorization: raised with the iteration; role, model, per-run limit, cost estimate and "exactly one run"; scripted says no paid work; reject leaves preparing', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  const [d] = decisionsOf(db, p.id, 'prototype_preparation_approval');
  assert.ok(d, 'raised when the iteration was created');
  assert.deepEqual([d.status, d.subject_type, d.subject_id], ['open', 'prototype_iteration', p.iteration]);
  const m = JSON.parse(d.dependency_manifest);
  for (const k of B.PREPARATION_KEYS) assert.ok(k in m, `the manifest binds ${k}`);
  // Slice E5 (S5): the run's effective allowance, the per-run limit
  // (5,000,000) capped at what the iteration has left (1,500,000).
  assert.deepEqual([m.role, m.provider, m.model, m.run_token_limit, m.estimated_usd, m.paid, m.authorizes], ['spec_writer', 'scripted', 'scripted', 1_500_000, null, false, 'exactly one brief_preparation run']);
  assert.match(d.question, /the Spec Writer \(role spec_writer\) on scripted model scripted/);
  assert.match(d.question, /Its effective token limit is 1500000 billable tokens: the per-run limit of 5000000, capped at what the iteration has left of its token allowance\. The scripted provider is unpaid: no paid work follows\./);
  assert.match(d.question, /counted in the prototype's totals as its own subtotal/);
  assert.match(d.question, /Approving authorizes exactly one preparation run/);
  assert.equal(iteration(db, p.iteration).next_step, 'approve preparation or discard');
  assert.deepEqual(itemsOf(db, p.id, 'brief_preparation'), [], 'nothing dispatched before the answer');
  answer(db, p.id, d, 'reject');
  assert.deepEqual([iteration(db, p.iteration).status, iteration(db, p.iteration).next_step], ['preparing', 'approve preparation or discard']);
  assert.deepEqual(itemsOf(db, p.id, 'brief_preparation'), []);
  // Asked again on the owner's request.
  const again = transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: p.iteration }));
  assert.equal(again.status, 201);
  assert.equal(decisionsOf(db, p.id, 'prototype_preparation_approval').filter((x) => x.status === 'open').length, 1);
  // Slice E5b (row M602 (d); objection 221): asked again while that one is
  // open, refused, naming it; nothing more is raised.
  const open = decisionsOf(db, p.id, 'prototype_preparation_approval').find((x) => x.status === 'open');
  assert.throws(
    () => transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: p.iteration })),
    (e) => e.status === 409 && e.code === 'illegal_transition' && e.reason === `Iteration 1's brief preparation is already awaiting your authorization (decision ${open.id}).` && e.whatToDo === 'Answer or reject that decision first.' && e.subject.decision === open.id,
  );
  assert.equal(decisionsOf(db, p.id, 'prototype_preparation_approval').filter((x) => x.status === 'open').length, 1);
});

test('a paid provider: the question states the provider, model and the estimate at the price table, never a cap', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  const rev = db.prepare('SELECT p.policy_revision AS id, r.effective FROM projects p JOIN policy_revisions r ON r.id = p.policy_revision WHERE p.id = ?').get(p.id);
  db.prepare('UPDATE policy_revisions SET effective = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(rev.effective), backend_spec_writer: 'claude', model_spec_writer: 'claude-sonnet-5-5' }), rev.id);
  const m = transact(db, ENGINE_ACTOR, (tx) => B.preparationManifest(tx.db, p.iteration));
  assert.deepEqual([m.provider, m.model, m.paid, m.estimated_usd, m.resolution], ['claude', 'claude-sonnet-5-5', true, 15, 'refused']);
  assert.match(m.estimate_basis, /^1500000 billable tokens at the output rate of claude-sonnet-5-5 in price table anthropic-list/);
  // The open question no longer matches its manifest: reviewed, it is invalidated and asked again by the owner's request.
  const [old] = decisionsOf(db, p.id, 'prototype_preparation_approval');
  transact(db, ENGINE_ACTOR, (tx) => tx.db.prepare(`UPDATE decisions SET status = 'invalidated' WHERE id = ?`).run(old.id));
  transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: p.iteration }));
  const d = decisionsOf(db, p.id, 'prototype_preparation_approval').at(-1);
  assert.match(d.question, /on claude model claude-sonnet-5-5/);
  assert.match(d.question, /an estimated \$15\.00 at most .*: an estimate, not a cap\./);
  assert.match(JSON.parse(d.options).find((o) => o.key === 'approve').consequence_text, /paid by your provider account, up to 1500000 billable tokens \(estimated \$15\.00 at most, not a cap\)/);
});

test('the brief: 3 to 5 objectives, one per requirement, each named; engine fields refused from the model; a smaller scope lists what is left out', () => {
  const rep3 = parseSpecification(specText(3)).representation;
  const rep5 = parseSpecification(specText(5)).representation;
  const rep6 = parseSpecification(specText(6)).representation;
  const rep2 = parseSpecification(specText(2)).representation;
  assert.ok('brief' in B.validateModelBrief(modelBrief(3), rep3));
  assert.ok('brief' in B.validateModelBrief(modelBrief(5), rep5));
  assert.match(B.validateModelBrief(modelBrief(6), rep6).refused, /brief\.objectives lists 6: a prototype has 3 to 5 observable objectives \(R3\); if the idea does not fit, propose a smaller scope and list what is left out in brief\.left_out; never drop a requirement silently/);
  assert.match(B.validateModelBrief(modelBrief(2), rep2).refused, /brief\.objectives lists 2/);
  assert.match(B.validateModelBrief(modelBrief(3), rep5).refused, /lists 3 and the specification has 5 requirement\(s\)/);
  assert.match(B.validateModelBrief(modelBrief(3, { objectives: ['R1: a', 'R2: b', 'R2: c'] }), rep3).refused, /no objective names requirement R3/);
  assert.match(B.validateModelBrief(modelBrief(3, { target: { environment: 'alpha' } }), rep3).refused, /brief\.target is the engine's to fill/);
  assert.match(B.validateModelBrief(modelBrief(3, { colour: 'red' }), rep3).refused, /brief\.colour is not a field of the brief/);
  assert.match(B.validateModelBrief(modelBrief(3, { estimates: { runs: 'many' } }), rep3).refused, /brief\.estimates must be/);
  assert.match(B.validateModelBrief({ ...modelBrief(3), app: '' }, rep3).refused, /brief\.app must be a non-empty string/);
  // An idea too large for five: the brief proposes five and lists the rest.
  const smaller = B.validateModelBrief(modelBrief(5, { left_out: ['R6 sharing: left out, beyond five objectives'] }), rep5);
  assert.deepEqual(smaller.brief.left_out, ['R6 sharing: left out, beyond five objectives']);
  assert.equal(smaller.brief.objectives.length, 5);
});

test('withinPrototypeBounds: one phase, at most two stages, every requirement covered, no permission, asset or tier override, not uncertain', () => {
  const content = (over = {}) => ({ roadmap: roadmapOf([{ number: 1, goal: 'g', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }]), plan: { phase: 1, stages: [stage(1, ['R1', 'R2']), stage(2, ['R3'])] }, modules: MODULES, adrs: {}, ...over });
  const keys = { requirement_keys: ['R1', 'R2', 'R3'] };
  assert.deepEqual(B.withinPrototypeBounds(content(), keys).outside, []);
  assert.equal(B.withinPrototypeBounds(content(), keys).within, true);
  const three = B.withinPrototypeBounds(content({ plan: { phase: 1, stages: [stage(1, ['R1']), stage(2, ['R2']), stage(3, ['R3'])] } }), keys);
  assert.deepEqual(three.outside, ['the plan has 3 stages; a prototype\'s has at most 2']);
  const twoPhases = B.withinPrototypeBounds(content({ roadmap: roadmapOf([{ number: 1, goal: 'g', modules: ['app'], requirement_ids: ['R1', 'R2'], depends_on: [] }, { number: 2, goal: 'h', modules: ['app'], requirement_ids: ['R3'], depends_on: [1] }]), plan: { phase: 1, stages: [stage(1, ['R1', 'R2'])] } }), keys);
  assert.deepEqual(twoPhases.outside, ["the roadmap has 2 phase(s); a prototype's has exactly 1", 'requirement(s) R3 of the approved brief are implemented by no stage of the one phase']);
  const perm = B.withinPrototypeBounds(content({ modules: { ...MODULES, modules: [{ ...MODULES.modules[0], platform_permissions: [{ target: 'web', permission: 'camera', why: 'x' }], tier_override: 'T3' }] } }), keys);
  assert.deepEqual(perm.outside, ['the module map asks for platform permission(s): app: camera (web)', 'module(s) app (T3) override the prototype\'s tier']);
  assert.deepEqual(B.withinPrototypeBounds(content(), keys, { conformance: 'uncertain', uncertain: ['phase_size'] }).outside, ['the plan check found it uncertain: phase_size']);
});

test('withinPrototypeBounds for a later iteration (S4): its own single phase, the next one and the roadmap\'s last, at most two stages, within the approved brief, adding no permission, asset path or tier the approved module map does not hold', () => {
  const p1 = { number: 1, goal: 'g', modules: ['app'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] };
  const p2 = { number: 2, goal: 'h', modules: ['app'], requirement_ids: ['R4'], depends_on: [1] };
  const content = (over = {}) => ({ roadmap: roadmapOf([p1, p2]), plan: { phase: 2, stages: [stage(1, ['R4'])] }, modules: MODULES, adrs: {}, ...over });
  const ctx = { requirement_keys: ['R1', 'R2', 'R3', 'R4'], phase: 2, earlier_implemented: ['R1', 'R2', 'R3'], approved_modules: MODULES.modules };
  const ok = B.withinPrototypeBounds(content(), ctx);
  assert.deepEqual([ok.within, ok.outside, ok.facts.expected_phase, ok.facts.plan_phase], [true, [], 2, 2]);
  assert.deepEqual(B.withinPrototypeBounds(content({ plan: { phase: 2, stages: [stage(1, ['R4']), stage(2, ['R4']), stage(3, ['R4'])] } }), ctx).outside, ["the plan has 3 stages; a prototype's has at most 2"]);
  assert.deepEqual(B.withinPrototypeBounds(content({ roadmap: roadmapOf([p1, p2, { number: 3, goal: 'later', modules: ['app'], requirement_ids: [], depends_on: [2] }]) }), ctx).outside, ['the roadmap has 3 phase(s) (1, 2, 3); a prototype adds exactly 1 phase per iteration: phase 2, after the 1 completed, and none after it']);
  assert.deepEqual(B.withinPrototypeBounds(content({ plan: { phase: 2, stages: [stage(1, ['R1'])] } }), ctx).outside, ['requirement(s) R4 of the approved brief are implemented by no stage of phase 2 nor of the 1 completed']);
  assert.deepEqual(B.withinPrototypeBounds(content({ plan: { phase: 2, stages: [stage(1, ['R4', 'R9'])] } }), ctx).outside, ["the plan implements R9, beyond the approved brief's requirements"]);
  assert.deepEqual(B.withinPrototypeBounds(content(), { ...ctx, phase: 3 }).outside, ['the roadmap has 2 phase(s) (1, 2); a prototype adds exactly 1 phase per iteration: phase 3, after the 2 completed, and none after it', 'the plan is for phase 2, not phase 3']);
  // A permission the approved map already holds is not new; a new one is.
  const camera = [{ ...MODULES.modules[0], platform_permissions: [{ target: 'web', permission: 'camera', why: 'x' }] }];
  assert.deepEqual(B.withinPrototypeBounds(content({ modules: { ...MODULES, modules: camera } }), { ...ctx, approved_modules: camera }).outside, []);
  assert.deepEqual(B.withinPrototypeBounds(content({ modules: { ...MODULES, modules: camera } }), ctx).outside, ['the module map asks for platform permission(s): app: camera (web)']);
});

test('demonstration on the scripted backend: idea to alpha_ready through preparation, brief, policy-authorized first plan, check approval and the build', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  const it0 = iteration(db, p.iteration);
  assert.deepEqual([it0.status, it0.next_step], ['preparing', 'approve preparation or discard']);

  // 1. The preparation authorized: one brief_preparation item, for the Spec Writer.
  const [prep] = decisionsOf(db, p.id, 'prototype_preparation_approval');
  assert.match(prep.question, /no paid work follows/);
  answer(db, p.id, prep);
  const [item] = itemsOf(db, p.id, 'brief_preparation');
  assert.deepEqual([item.status, JSON.parse(item.subject).decision, R.ROLE_OF.brief_preparation], ['eligible', prep.id, 'spec_writer']);
  assert.deepEqual([iteration(db, p.iteration).status, iteration(db, p.iteration).next_step], ['preparing', 'wait: the brief is being prepared']);
  assert.equal(events(db, 'prototype.preparation_authorized')[0].run_token_limit, 1_500_000, "the preparation run's effective allowance (S5)");

  // 2. The run: attributed to the iteration; the brief recorded; spec_approval raised with the brief in its manifest.
  const b1 = prepareBrief(db, p.id);
  assert.equal(db.prepare('SELECT iteration FROM runs WHERE id = ?').get(b1.run).iteration, p.iteration);
  assert.equal(db.prepare('SELECT status FROM work_items WHERE id = ?').get(item.id).status, 'complete');
  assert.equal(b1.decision.kind, 'spec_approval');
  assert.deepEqual([b1.decision.subject_type, b1.decision.subject_id], ['run', b1.run]);
  const m1 = JSON.parse(b1.decision.dependency_manifest);
  assert.deepEqual([m1.brief_record, m1.brief_version, m1.iteration, m1.spec_version, m1.current_brief_record], [b1.record, 1, p.iteration, 1, b1.record]);
  assert.match(b1.decision.question, new RegExp(`^Approve the prototype brief \\(record ${b1.record}, brief version 1\\)`));
  assert.deepEqual(JSON.parse(b1.decision.options).map((o) => o.key), ['approve', 'reject']);
  let it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.brief_decision, it.brief_record, it.brief_spec_revision], ['awaiting_brief_approval', b1.decision.id, b1.record, null]);
  // The brief as the console renders it: the engine's fields from what it serves.
  assert.deepEqual(Object.keys(b1.brief), [...B.BRIEF_FIELDS]);
  assert.deepEqual(b1.brief.target.environment, 'alpha');
  assert.equal(b1.brief.target.kind, 'local_service');
  assert.doesNotMatch(`${b1.brief.target.description} ${b1.brief.target.exposure_note}`, /private/i, 'never "private" unless the configuration says loopback only');
  assert.match(b1.brief.target.exposure_note, /has no configuration recorded yet: its port and who can reach it are not known, and the engine has not checked its exposure/);
  assert.deepEqual(b1.brief.models, [{ provider: 'scripted', model: 'scripted', roles: ['spec_writer', 'architect', 'verifier', 'builder'] }]);
  assert.deepEqual([b1.brief.limits.prototype_budget_tokens, b1.brief.limits.prototype_runtime_seconds], [1_500_000, 2700]);
  assert.match(b1.brief.limits.reservation_rule, /the lower of the per-run limit \(budget_run_billable_tokens 5000000\) and what the iteration has left/);
  assert.deepEqual([b1.brief.preparation.runs, b1.brief.preparation.tokens, b1.brief.preparation.usd, typeof b1.brief.preparation.authorized_at], [1, null, null, 'string']);
  assert.equal(b1.brief.stop_conditions.length, B.STOP_CONDITIONS.length);

  // 3. A changed brief (a second preparation) invalidates the first spec_approval.
  transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: p.iteration }));
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval').at(-1));
  const b2 = prepareBrief(db, p.id, { brief: modelBrief(3, { app: 'Tasks, second brief' }) });
  const first = getDecisionRow(db, b1.decision.id);
  assert.deepEqual([first.status, first.invalidated_reason], ['invalidated', `a later brief (record ${b2.record}, version 1) was prepared`]);
  assert.throws(() => answer(db, p.id, first), (e) => e.code === 'decision_invalidated', 'the old brief cannot be approved');
  it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.brief_decision, it.brief_record], ['awaiting_brief_approval', b2.decision.id, b2.record]);
  assert.equal(JSON.parse(b2.decision.dependency_manifest).brief_record, b2.record);
  assert.equal(b2.brief.preparation.runs, 2);

  // 4. The brief approved: the existing application; approved_at; building; the first plan asked of the Architect.
  answer(db, p.id, b2.decision);
  applySpecApproval(db, p.id, b2.decision);
  it = iteration(db, p.iteration);
  const spec = db.prepare('SELECT id, version FROM spec_revisions WHERE project = ?').get(p.id);
  assert.deepEqual([it.status, it.brief_spec_revision, it.brief_decision, typeof it.approved_at, spec.version], ['building', spec.id, b2.decision.id, 'string', 1]);
  const [replan] = itemsOf(db, p.id, 'replan');
  assert.deepEqual([replan.status, replan.trigger_source, replan.trigger_id], ['eligible', 'prototype_first_plan', p.iteration]);

  // 5. The first plan within the bounds: published policy_authorized, never a human approval.
  const plan = firstPlan(db, p.id);
  assert.equal(plan.check.outcome, 'passed', JSON.stringify(plan.check.reasons));
  assert.ok(plan.published, 'published at once');
  assert.deepEqual(decisionsOf(db, p.id, 'architecture_approval').concat(decisionsOf(db, p.id, 'plan_approval')), [], 'no owner question');
  const pp = db.prepare('SELECT routing, approved_by, bundle FROM phase_plans WHERE id = ?').get(plan.published);
  assert.deepEqual([pp.routing, pp.approved_by, pp.bundle], ['policy_authorized', 'policy:rapid_prototype', plan.bundle]);
  const bundle = db.prepare('SELECT status, approvals FROM plan_bundles WHERE id = ?').get(plan.bundle);
  assert.equal(bundle.status, 'published');
  assert.deepEqual(Object.keys(JSON.parse(bundle.approvals)), ['policy_authorized']);
  assert.equal(db.prepare('SELECT approved_by FROM architecture_revisions WHERE project = ?').get(p.id).approved_by, 'policy:rapid_prototype');
  const approvedEv = events(db, 'baseline.plan_approved').at(-1);
  assert.deepEqual([approvedEv.routing, approvedEv.approved_by], ['policy_authorized', 'policy:rapid_prototype']);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE subject_type = 'plan_bundle'`).get().n, 0, 'no approval row: not a human approval');
  it = iteration(db, p.iteration);
  assert.deepEqual([it.plan_bundle, it.phase_plan, it.status], [plan.bundle, plan.published, 'building']);
  let read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual([read.plan.routing, read.plan.approved_by, read.plan.bundle_status], ['policy_authorized', 'policy:rapid_prototype', 'published']);

  // 6. The check approval stays (R2): while a check_correction question is open the iteration awaits the owner.
  const [authoring] = itemsOf(db, p.id, 'check_authoring');
  assert.ok(authoring, 'the phase\'s check authoring registered with the plan');
  const v = claim(db, p.id, authoring.id);
  launch(db, v, { input_tokens: 500, output_tokens: 100 });
  end(db, v);
  // The proposal it captured and its classification are M5's (fixtures here); the question about it is the owner's.
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('pp_1', ?, ?, 1, 'verifier_run', ?, 'sha_plan', 'tree', 'hash', 'unclassifiable', 'awaiting_human')`).run(AT, p.id, v.run);
  db.pragma('foreign_keys = ON');
  const check = transact(db, ENGINE_ACTOR, (tx) => raiseDecision(tx, { project: p.id, kind: 'check_correction_unclassifiable', subjectType: 'protected_proposal', subjectId: 'pp_1', question: 'Review automated-check changes', options: [{ key: 'approve', label: 'Apply', consequence: 'applied', effect: {} }, { key: 'reject', label: 'Reject', consequence: 'rejected', effect: {} }], manifest: {} }));
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step], ['awaiting_owner', 'review automated-check changes']);
  transact(db, HUMAN, (tx) => consumeDecision(tx, getDecision(tx, check.id), 'approve', null));
  db.prepare(`UPDATE phase_plans SET authoring_ready_at = ? WHERE id = ?`).run(AT, plan.published);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.deepEqual([iteration(db, p.iteration).status, iteration(db, p.iteration).next_step], ['building', 'none: building']);

  // 7. A stage's work parked fails the iteration with its reason; the owner's retry returns it to building.
  // Slice E5 (S5): the timed-out run below is charged its effective
  // allowance less what it observed (C4); under the default 1,500,000 that
  // allowance is all the iteration had left. The allowance is raised here
  // (and the day's unknown-token limit with it), as what is under test is
  // the parked work's status, not the limits.
  const lim = db.prepare('SELECT limits_json FROM prototype_iterations WHERE id = ?').get(p.iteration);
  db.prepare('UPDATE prototype_iterations SET limits_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(lim.limits_json), prototype_budget_tokens: 20_000_000 }), p.iteration);
  db.prepare(`UPDATE policy_revisions SET effective = json_set(effective, '$.budget_day_unknown_tokens', 50000000) WHERE project = ?`).run(p.id);
  const builds = itemsOf(db, p.id, 'stage_build');
  assert.equal(builds.length, 2, 'two stages, each its Builder\'s work');
  const sb = claim(db, p.id, builds[0].id);
  launch(db, sb, { input_tokens: 3000, output_tokens: 900 });
  end(db, sb, 'timed_out', 'deadline');
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  it = iteration(db, p.iteration);
  assert.equal(it.status, 'failed');
  assert.match(it.outcome_reason, new RegExp(`^stage_build work ${builds[0].id} parked: deadline; its last run ${sb.run} ended timed_out`));
  assert.equal(it.next_step, 'retry or cancel the parked work (its blocker), or discard');
  transact(db, ENGINE_ACTOR, (tx) => transitionWork(tx, getWorkItem(tx, builds[0].id), 'eligible', { blocker: null }, { cause: 'test_retry' }));
  db.prepare(`UPDATE decisions SET status = 'invalidated' WHERE kind = 'blocker' AND project = ? AND status = 'open'`).run(p.id);
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.deepEqual([iteration(db, p.iteration).status, iteration(db, p.iteration).ended_at], ['building', null]);
  const sb2 = claim(db, p.id, builds[0].id);
  assert.equal(db.prepare('SELECT iteration FROM runs WHERE id = ?').get(sb2.run).iteration, p.iteration, 'the retried work is the iteration\'s');
  launch(db, sb2, { input_tokens: 3000, output_tokens: 900 });
  end(db, sb2);

  // 8. The candidate deployed to Alpha (M4's machinery; a fixture here) and the E1 hook: alpha_ready.
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, current_generation) VALUES ('env_a', ?, ?, 'alpha_fx', 'local_service', 'x', '{}', 1)`).run(AT, p.id);
  // Nominated on the approved brief's spec revision (slice E4: only a candidate of the iteration's own brief is its Alpha).
  db.prepare(`INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, spec_revision) VALUES ('cand_a', ?, ?, 1, 'sha_plan', 'lin', ?, 'engine_cadence', 'alpha_deployed', ?)`).run(AT, p.id, AT, spec.id);
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, outcome) VALUES ('dreq_a', ?, ?, 'k', 'policy', 'cand_a', 'env_a', 'deployed')`).run(AT, p.id);
  db.pragma('foreign_keys = ON');
  transact(db, ENGINE_ACTOR, (tx) => recordIterationAlpha(tx, { project: p.id, candidate: 'cand_a', request: 'dreq_a', operation: 'op_a' }));
  it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step], ['alpha_ready', 'open_alpha']);

  // 9. The receipt: the preparation subtotal and the three owner approvals, as served.
  const receipt = iterationReceipt(db, { project: p.id, iteration: p.iteration });
  assert.deepEqual(receipt.usage.totals.preparation, { runs: 2, tokens: 2 * 1200, usd: null }, 'two preparation runs; scripted cost unknown, never 0');
  assert.equal(receipt.usage.totals.agent_runs, 2 + 1 + 1 + 2, 'two preparations, the plan, the authoring, two builder runs');
  assert.deepEqual(receipt.owner_approvals.by_kind, { prototype_preparation_approval: 2, spec_approval: 1, check_correction_unclassifiable: 1 });
  assert.equal(receipt.owner_approvals.count, 4, 'two preparations authorized (one per brief), the brief, the check');
  assert.equal(typeof receipt.time.preparation_seconds, 'number');
  assert.ok(receipt.time.preparation_seconds >= 0);
  assert.deepEqual([receipt.plan.routing, receipt.outcome.status], ['policy_authorized', 'alpha_ready']);
  assert.deepEqual(receipt.iteration.brief, { spec_revision: spec.id, decision: b2.decision.id, record: b2.record, version: 1 });
});

test('the three approvals of the initial paid flow: one preparation, one brief, one check', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval')[0]);
  const b = prepareBrief(db, p.id);
  answer(db, p.id, b.decision);
  applySpecApproval(db, p.id, b.decision);
  const plan = firstPlan(db, p.id);
  const [authoring] = itemsOf(db, p.id, 'check_authoring');
  const v = claim(db, p.id, authoring.id);
  end(db, v);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('pp_2', ?, ?, 1, 'verifier_run', ?, 'sha_plan', 'tree', 'hash', 'unclassifiable', 'awaiting_human')`).run(AT, p.id, v.run);
  db.pragma('foreign_keys = ON');
  const check = transact(db, ENGINE_ACTOR, (tx) => raiseDecision(tx, { project: p.id, kind: 'check_correction_unclassifiable', subjectType: 'protected_proposal', subjectId: 'pp_2', question: 'q', options: [{ key: 'approve', label: 'a', consequence: 'c', effect: {} }], manifest: {} }));
  transact(db, HUMAN, (tx) => consumeDecision(tx, getDecision(tx, check.id), 'approve', null));
  const read = readIteration(db, { project: p.id, iteration: p.iteration });
  assert.equal(read.owner_approvals.count, 3);
  assert.deepEqual(read.owner_approvals.by_kind, { prototype_preparation_approval: 1, spec_approval: 1, check_correction_unclassifiable: 1 });
  assert.equal(read.plan.routing, 'policy_authorized', 'the plan is no fourth approval');
  assert.deepEqual(read.usage.totals.preparation, { runs: 1, tokens: 1200, usd: null });
  assert.ok(plan.published);
});

test('a first plan outside the bounds: the ordinary architecture_approval and plan_approval batch, the iteration awaiting the owner with what was outside', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval')[0]);
  const b = prepareBrief(db, p.id);
  answer(db, p.id, b.decision);
  applySpecApproval(db, p.id, b.decision);
  const plan = firstPlan(db, p.id, { stages: [stage(1, ['R1']), stage(2, ['R2']), stage(3, ['R3'])] });
  assert.equal(plan.check.outcome, 'passed');
  assert.equal(plan.published, null, 'not published');
  const arch = decisionsOf(db, p.id, 'architecture_approval');
  const pl = decisionsOf(db, p.id, 'plan_approval');
  assert.deepEqual([arch.length, pl.length, arch[0].batch_key, pl[0].batch_key, arch[0].scope], [1, 1, plan.bundle, plan.bundle, plan.bundle]);
  const it = iteration(db, p.iteration);
  assert.equal(it.status, 'awaiting_owner');
  assert.equal(it.next_step, "approve the plan (architecture_approval and plan_approval): outside the prototype bounds: the plan has 3 stages; a prototype's has at most 2; the plan check found it uncertain: phase_size: 3 stages, outside {min 1, max 2}");
  assert.equal(it.plan_bundle, plan.bundle);
  assert.deepEqual(events(db, 'prototype.plan_routed_to_owner')[0].outside, ["the plan has 3 stages; a prototype's has at most 2", 'the plan check found it uncertain: phase_size: 3 stages, outside {min 1, max 2}']);
  // The tick keeps the plan's next step while its question is open.
  transact(db, ENGINE_ACTOR, (tx) => markHolds(tx));
  assert.equal(iteration(db, p.iteration).next_step, it.next_step);
  assert.equal(db.prepare('SELECT status FROM plan_bundles WHERE id = ?').get(plan.bundle).status, 'proposed');
});

test('a failed preparation is never repaired: its work cancelled, the iteration preparing with "prepare again or discard"; a rejected brief likewise', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval')[0]);
  const bad = prepareBrief(db, p.id, { n: 6, brief: modelBrief(6) });
  assert.match(bad.refused, /lists 6/);
  const [item] = itemsOf(db, p.id, 'brief_preparation');
  assert.equal(item.status, 'cancelled', 'exactly one run was authorized: no repair');
  let it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step], ['preparing', 'prepare again or discard']);
  assert.match(it.outcome_reason, /the brief preparation run .* ended failed \(invalid_result\)/);
  assert.equal(events(db, 'prototype.preparation_failed').length, 1);
  // Prepare again: a new authorization, a new run, a brief; rejected.
  transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: p.iteration }));
  answer(db, p.id, decisionsOf(db, p.id, 'prototype_preparation_approval').at(-1));
  const b = prepareBrief(db, p.id);
  answer(db, p.id, b.decision, 'reject');
  it = iteration(db, p.iteration);
  assert.deepEqual([it.status, it.next_step, it.approved_at], ['preparing', 'prepare again or discard', null]);
  assert.match(it.outcome_reason, /the brief \(version 1\) was rejected by decision/);
  assert.deepEqual(itemsOf(db, p.id, 'replan'), [], 'no plan asked for');
  assert.throws(() => transact(db, HUMAN, (tx) => B.requestPreparation(tx, { project: p.id, iteration: 'it_none' })), (e) => e.status === 404);
});

test('the preparation run\'s package: the task, the brief instructions and the brief field of its result schema', () => {
  const facts = { iteration: 'it_1', iteration_seq: 1, idea_path: '.surety/idea.md', idea_version: 1, objectives: { ...B.OBJECTIVES }, model_fields: B.MODEL_FIELDS, engine_fields: B.ENGINE_FIELDS, previous: null };
  const text = B.briefPreparationText(facts).join('\n');
  assert.match(text, /3 to 5 requirements, each an observable objective/);
  assert.match(text, /propose a smaller scope: keep the objectives that show the idea best, and list everything you leave out in `left_out`\. Never drop a requirement silently/);
  assert.match(text, /Do not report version, prepared_at, target, models, preparation, limits, stop_conditions: the engine fills them/);
  assert.deepEqual(B.BRIEF_RESULT_SCHEMA.required, [...B.MODEL_FIELDS]);
  assert.deepEqual([B.BRIEF_RESULT_SCHEMA.properties.objectives.minItems, B.BRIEF_RESULT_SCHEMA.properties.objectives.maxItems], [3, 5]);
});

test('the brief\'s target is the configuration\'s real exposure: a port and no bind address, never "private"; unconfigured, unknown', async (t) => {
  const { db, create } = scratch(t);
  const p = await create();
  const run = db.prepare('SELECT id FROM runs LIMIT 1').get()?.id ?? 'run_none';
  let f = B.briefFacts(db, { project: p.id, run, environments: ['alpha', 'beta'] });
  assert.deepEqual([f.target.environment, f.target.kind, f.version], ['alpha', 'local_service', 1]);
  assert.match(f.target.exposure_note, /has no configuration recorded yet/);
  assert.match(f.target.description, /The specification also names beta; the prototype deploys to alpha only\./);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_x', ?, ?, 'alpha', 'local_service', 'x', '{}')`).run(AT, p.id);
  db.prepare(`INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES ('cfg_1', ?, ?, 'env_x', 1, ?, 'id', '[]', 'current', 'human', ?)`).run(AT, p.id, JSON.stringify({ adapter: 'local_service', port: 8123 }), AT);
  db.pragma('foreign_keys = ON');
  f = B.briefFacts(db, { project: p.id, run, environments: ['alpha'] });
  assert.match(f.target.description, /on port 8123/);
  assert.equal(f.target.exposure_note, 'The service listens on port 8123 of this host. The configuration sets no bind address: whether it is reachable only from this host (loopback) or from your network depends on how the application binds, which the engine has not checked.');
  assert.doesNotMatch(JSON.stringify(f.target), /private/i);
  assert.equal(B.briefFacts(db, { project: p.id, run, environments: [] }).target.environment, null);
  assert.equal(f.preparation, null, 'no preparation run: none');
});
