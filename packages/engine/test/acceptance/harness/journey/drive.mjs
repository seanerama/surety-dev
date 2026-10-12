// The first journey's steps on the scripted backend (D6 §1; BS5 §3, §8; M5
// plan §3.1; SEAM.md §§342 to 348), each a function a row's file calls as far
// as its cases need, answering every human act of D6 §1 through the owner's
// production routes and installing nothing by fixture (BS5 §4.1 rule 20).
// Slice 31a (M402 to M405): steps 1 to 4, the idea to `developing`.
//
// Each step returns what it observed; the files read the store, git and the
// routes afterwards. Nothing here asserts a row's clause; it asserts only
// that the journey is live (a step that did not happen is a failure here,
// named, not a silent skip).

import assert from 'node:assert/strict';
import { join } from 'node:path';

import { confirmRequired, consume, decision, decisionsOfKind } from '../decisions.mjs';
import { eventsOfType, changePolicy, getPolicy } from '../journal.mjs';
import { waitFor } from '../engine.mjs';
import { makeProjectRepo, refOid } from '../repos.mjs';
import { getRow, tick, tickUntil, waitForIdle } from '../runs.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnThatSays, turnThatWrites } from '../sessions.mjs';
import { withStore } from '../store.mjs';
import { ADR_KEY, IDEA_BRIEF, IDEA_RECORD, PROJECT_NAME, SPEC, SPEC_DEFECTIVE, TIER, architectFiles } from './reference.mjs';

// ---- step 1: the project created with the idea (D6 §1 step 1; SEAM.md §345) ----------------------

// `POST /v1/projects` with `idea` (the brief's text), on a repository of the
// test's own holding one README. Returns {id, repo, base, res}.
export async function createWithIdea(fx, { idea = IDEA_BRIEF, name = PROJECT_NAME, tier = TIER, files = { 'README.md': '# Tally\n' }, policy } = {}) {
  const n = ++fx.repos;
  const repo = makeProjectRepo(join(fx.root, `repo-${n}`), { files });
  const body = { name, tier, dev_repo_path: repo.path, integration_branch: repo.branch };
  if (idea !== undefined) body.idea = idea;
  const res = await fx.engine.post('/v1/projects', body);
  assert.equal(res.status, 201, `POST /v1/projects${idea === undefined ? '' : ' with idea'} (SEAM.md §345) (→ ${res.status} ${res.text})`);
  const id = res.body?.project?.id;
  assert.match(id ?? '', /^proj_/, `the response names the project (${res.text})`);
  await waitFor(() => getRow(fx.home, 'projects', id)?.registration_state === 'registered', { what: `project ${id} to be registered` });
  if (policy !== undefined) await ownerPolicy(fx, id, policy);
  return { id, repo, base: refOid(repo.path, repo.ref), res };
}

// Sean's decision of 2026-10-12 (SEAM.md §364): loosening `autonomy`
// (step → stage → phase) or `alpha_deploy` (manual → on_phase_complete) on an
// existing project is a policy widening, answered 409 `confirm_required`
// and applied on the owner's approval; tightening applies directly.
const AUTONOMY_RANK = Object.freeze({ step: 0, stage: 1, phase: 2 });
export function wideningKeys(effective, change) {
  return Object.keys(change).filter(
    (k) =>
      (k === 'autonomy' && AUTONOMY_RANK[change[k]] > AUTONOMY_RANK[effective.autonomy ?? 'phase']) ||
      (k === 'alpha_deploy' && change[k] === 'on_phase_complete' && (effective.alpha_deploy ?? 'manual') !== 'on_phase_complete'),
  );
}

// The owner's policy change: its ordinary keys by `changePolicy` (200), then
// any loosening of `autonomy` or `alpha_deploy` through its confirmation, the
// `policy_widening` decision approved by the owner. Returns the effective policy.
export async function ownerPolicy(fx, project, change) {
  const { effective } = await getPolicy(fx.engine, project);
  const widening = wideningKeys(effective, change);
  const ordinary = Object.fromEntries(Object.entries(change).filter(([k]) => !widening.includes(k)));
  if (Object.keys(ordinary).length > 0) await changePolicy(fx.engine, project, ordinary);
  if (widening.length === 0) return (await getPolicy(fx.engine, project)).effective;
  const wide = Object.fromEntries(widening.map((k) => [k, change[k]]));
  const previewed = await confirmRequired(fx, `/v1/projects/${project}/policy`, wide);
  await consume(fx, project, previewed, 'approve');
  return waitFor(
    async () => {
      const { effective: now } = await getPolicy(fx.engine, project);
      return widening.every((k) => now[k] === change[k]) ? now : undefined;
    },
    { what: `the owner's widening of ${widening.join(', ')} to be effective` },
  );
}

export const projectRow = (home, id) => getRow(home, 'projects', id);
export async function readProjectRaw(fx, id) {
  const res = await fx.engine.get(`/v1/projects/${id}`);
  assert.equal(res.status, 200, `GET /v1/projects/${id} (→ ${res.status} ${res.text})`);
  return res.body;
}

// ---- step 2: the Vision session (D6 §1 step 2; §3.1) ----------------------------------------------

// Two turns, the second writing `.surety/idea.md` (the record given), a save,
// a close raising `idea_accept`; answered `approve` when `answer` is true.
export async function visionSession(fx, project, { record = IDEA_RECORD, answer = true, firstTurn = turnThatSays('What should the dashboard show first: the count or the sum of sums?') } = {}) {
  const run = await openSession(fx, project, 'vision');
  scriptTurns(fx, run.id, [firstTurn, turnThatWrites({ '.surety/idea.md': record }, { reply: 'I rewrote the idea record with the identity block.', done: true })]);
  const t1 = await sayAndSettle(fx, project, run.id, 'Tally sums two numbers over HTTP and counts the sums it served, for a workshop dashboard.');
  const t2 = await sayAndSettle(fx, project, run.id, 'The count first. Write the idea record.');
  const saved = await saveSession(fx, project, run.id);
  const closed = await closeSession(fx, project, run.id);
  const raised = (closed.decisions ?? []).filter((d) => d.kind === 'idea_accept');
  let answered = null;
  if (answer) {
    assert.equal(raised.length, 1, `the close raised one idea_accept (${JSON.stringify(closed)})`);
    answered = await consume(fx, project, decision(fx.home, raised[0].id), 'approve');
  }
  return { run, turns: [t1, t2], saved, closed, decisions: raised, answered };
}

// ---- step 3: the Spec Writer session (D6 §1 step 3; §3.2; the ruling's parse depth) ---------------

// Turn 1 writes a specification with one defect (R2.2 in the index, absent
// from §4) and saves; turn 2 writes the whole specification and saves; the
// close raises `spec_approval`, answered `approve`. Returns every answer.
export async function specSession(fx, project, { first = SPEC_DEFECTIVE, second = SPEC, answer = true, dumpSecond = false } = {}) {
  const run = await openSession(fx, project, 'spec_writer');
  const second_ = turnThatWrites({ '.surety/spec/spec.md': second }, { reply: 'The index and section 4 now agree.', done: true });
  if (dumpSecond) second_.steps.unshift({ probe: { action: 'context_dump' } });
  scriptTurns(fx, run.id, [turnThatWrites({ '.surety/spec/spec.md': first }, { reply: 'A first draft of the specification.' }), second_]);
  const t1 = await sayAndSettle(fx, project, run.id, 'Write the specification from the idea record: two phases, T2.');
  const save1 = await saveSession(fx, project, run.id);
  const t2 = await sayAndSettle(fx, project, run.id, 'Fix what the engine reported.');
  const save2 = await saveSession(fx, project, run.id);
  const closed = await closeSession(fx, project, run.id);
  const raised = (closed.decisions ?? []).filter((d) => d.kind === 'spec_approval');
  let answered = null;
  if (answer) {
    assert.equal(raised.length, 1, `the close raised one spec_approval (${JSON.stringify(closed)})`);
    answered = await consume(fx, project, decision(fx.home, raised[0].id), 'approve');
  }
  return { run, turns: [t1, t2], saves: [save1, save2], closed, decisions: raised, answered };
}

// ---- step 4: the Architect session and the consolidated approval (D6 §1 step 4; §3.3, §3.4, §5.5) ---

// One turn writing the architecture, the module map, the ADR, the roadmap and
// phase 1's plan (prepared against the head at open), a save, a close raising
// `architecture_approval` + `plan_approval` under one batch key. `files`
// replaces the products (`architectFiles`'s `over`); `answer`: 'both'
// (default), 'architecture', 'plan' or 'none'. Returns what was observed and
// the two decision rows.
export async function architectSession(fx, project, repo, { over = {}, plan, answer = 'both', close = {}, publishTicks = 6 } = {}) {
  const run = await openSession(fx, project, 'architect');
  const revision = refOid(repo.path, repo.ref);
  const files = architectFiles({ revision, over, ...(plan === undefined ? {} : { plan }) });
  scriptTurns(fx, run.id, [turnThatWrites(files, { reply: 'Architecture, module map, one ADR, the roadmap and the plan for phase 1.', done: true })]);
  const t1 = await sayAndSettle(fx, project, run.id, 'Design Tally from the approved specification and plan phase 1.');
  const saved = await saveSession(fx, project, run.id);
  const res = await fx.engine.post(`/v1/projects/${project}/sessions/${run.id}/close`, close);
  const out = { run, revision, files, turn: t1, saved, closeRes: res, closed: res.status === 200 ? res.body : null, decisions: {}, answered: {}, published: null };
  if (res.status !== 200) return out;
  for (const d of res.body.decisions ?? []) out.decisions[d.kind] = decision(fx.home, d.id);
  const want = answer === 'both' ? ['architecture_approval', 'plan_approval'] : answer === 'none' ? [] : [answer];
  for (const kind of want) {
    assert.ok(out.decisions[kind], `the close raised ${kind} (${JSON.stringify(res.body)})`);
    out.answered[kind] = await consume(fx, project, out.decisions[kind], 'approve');
  }
  if (answer === 'both') out.published = await waitPublished(fx, project, { max: publishTicks });
  return out;
}

// Ticks until the project has an active phase plan (the publication).
export const waitPublished = (fx, project, { max = 6 } = {}) =>
  tickUntil(fx.engine, project, () => activePlan(fx.home, project) ?? undefined, { max, what: 'the plan to be published' });

// The idea to `developing` in one call: steps 1 to 4 with every human act
// answered. Returns every step's observations.
export async function toDeveloping(fx, opts = {}) {
  const project = await createWithIdea(fx, opts.create);
  const vision = opts.skipVision ? null : await visionSession(fx, project.id, opts.vision);
  const spec = await specSession(fx, project.id, opts.spec);
  const architect = await architectSession(fx, project.id, project.repo, opts.architect);
  return { project, vision, spec, architect };
}

// ---- readers ---------------------------------------------------------------------------------

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const json = (text) => (text === null || text === undefined ? text : typeof text === 'string' ? JSON.parse(text) : text);

export const specRevisions = (home, project) => rows(home, 'SELECT * FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"', project);
export const requirementsOf = (home, project) => rows(home, 'SELECT * FROM "requirements" WHERE "project" = ? ORDER BY "key"', project).map((r) => ({ ...r, criteria: json(r.criteria), sensitive_areas: json(r.sensitive_areas) }));
export const modulesOf = (home, project) => rows(home, 'SELECT * FROM "modules" WHERE "project" = ? ORDER BY "name"', project).map((m) => ({ ...m, paths: json(m.paths), sensitive_areas: json(m.sensitive_areas) }));
export const environmentsOf = (home, project) => rows(home, 'SELECT * FROM "environments" WHERE "project" = ? ORDER BY "name"', project);
export const architectureRevisions = (home, project) => rows(home, 'SELECT * FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version"', project);
export const roadmapRevisions = (home, project) => rows(home, 'SELECT * FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version"', project).map((r) => ({ ...r, phases: json(r.phases) }));
export const phasePlansOf = (home, project) => rows(home, 'SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid', project).map((p) => ({ ...p, completion_binding: json(p.completion_binding) }));
export const activePlan = (home, project) => phasePlansOf(home, project).find((p) => p.active === 1 || p.active === true) ?? null;
export const stagesOfPlan = (home, plan) => rows(home, 'SELECT * FROM "stages" WHERE "phase_plan" = ? ORDER BY "number"', plan).map((s) => ({ ...s, depends_on: json(s.depends_on), validation: json(s.validation), tasks: json(s.tasks), implements: json(s.implements) }));
export const stagesOfProject = (home, project) => rows(home, 'SELECT * FROM "stages" WHERE "project" = ? ORDER BY rowid', project);
export const workOf = (home, project, kind) => rows(home, kind === undefined ? 'SELECT * FROM "work_items" WHERE "project" = ? ORDER BY "seq"' : 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', ...(kind === undefined ? [project] : [project, kind])).map((w) => ({ ...w, subject: json(w.subject), depends_on: json(w.depends_on) }));
export const planChecks = (home, project) => rows(home, 'SELECT * FROM "plan_checks" WHERE "project" = ? ORDER BY rowid', project).map((c) => ({ ...c, reasons: json(c.reasons), changes_architecture: json(c.changes_architecture), changes_adrs: json(c.changes_adrs), changes_roadmap: json(c.changes_roadmap) }));
export const baselineTexts = (home, project, kind) => rows(home, 'SELECT * FROM "baseline_texts" WHERE "project" = ? AND "kind" = ? ORDER BY "key"', project, kind);
export const recordOf = (home, id) => one(home, 'SELECT * FROM "records" WHERE "id" = ?', id);
export const revisionRows = (home, project) => rows(home, 'SELECT * FROM "revisions" WHERE "project" = ? ORDER BY rowid', project);
export const eventsAbout = (home, type, project) => eventsOfType(home, type).filter((e) => e.subject?.project === project);
export const decisionsOf = (home, project, kind) => decisionsOfKind(home, project, kind);

// The two approval rows of an Architect close, found in the store by batch key.
export const batchOf = (home, project, batchKey) => rows(home, 'SELECT * FROM "decisions" WHERE "project" = ? AND "batch_key" = ? ORDER BY "kind"', project, batchKey);

// The route reads of D6 A.8 (SEAM.md §346).
export async function readSpec(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/spec`);
  assert.equal(res.status, 200, `GET …/spec (→ ${res.status} ${res.text})`);
  return res.body;
}
export async function readPlan(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/plan`);
  assert.equal(res.status, 200, `GET …/plan (→ ${res.status} ${res.text})`);
  return res.body;
}

// Nothing of the baseline, no stage and no work exists for the project but
// what `allowKinds` of work permits (the state M403 (g) and M405 (e) read).
export function nothingPublished(home, project, { allowKinds = [] } = {}) {
  return {
    architecture_revisions: architectureRevisions(home, project).length,
    roadmap_revisions: roadmapRevisions(home, project).length,
    phase_plans: phasePlansOf(home, project).length,
    stages: stagesOfProject(home, project).length,
    work: workOf(home, project).filter((w) => !allowKinds.includes(w.kind)).length,
  };
}
export const NOTHING = Object.freeze({ architecture_revisions: 0, roadmap_revisions: 0, phase_plans: 0, stages: 0, work: 0 });

export { ADR_KEY };

// ============================================================================================
// Slice 31b (M406, M407, M401): D6 §1 steps 5 to 12 on the scripted backend
// (SEAM.md §§350 to 355). The journey proceeds under `autonomy: phase`: the
// harness ticks, scripts each role by its work kind (§350), drives the
// kernel lane's scripted check boundary, and answers only the decisions D6
// §1 routes to the owner (the toolchain proposal, the spec change), each
// answer recorded as the harness's.

import { recordExit } from '../checks/selection.mjs';
import { executionsOf } from '../checks/fixtures.mjs';
import { configContent, configure, qualifyByFixture, scriptCall } from '../deploy/kernel.mjs';
import { roleThat } from '../gitruns.mjs';
import { script, step } from '../scripted.mjs';
import { BUILDER_FILES, CHANGE_REQUEST, CORRECTED_SERVICE_TEST, SPEC_V2, STAGES, authoringFiles, phasePlanMd } from './reference.mjs';

export const JOURNEY_POLICY = Object.freeze({ autonomy: 'phase', alpha_deploy: 'on_phase_complete' });
// The decisions D6 §1 routes to the owner within the journey; the harness
// answers these and no other kind (a `blocker` or a `plan_approval` is a
// failure of the autonomous path, which M401 (g) reads from `humanActs`).
export const ROUTED_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_tightening', 'check_correction_loosening', 'spec_change', 'plan_approval']);

const writes = (files, { head = false } = {}) => Object.entries(files).map(([path, text]) => (head ? { write: { path, content: text, substitute_head: true } } : step.write(path, text)));
const text = (v) => `${JSON.stringify(v, null, 2)}\n`;

// phase-2.json as the Architect's replan writes it: prepared against the
// versions given and the workspace's HEAD (substituted by the role program).
export const replanScript = ({ spec_version = 1, architecture_version = 1, roadmap_version = 1 } = {}) => ({
  steps: [
    ...writes({ '.surety/phases/phase-2.json': text({ phase: 2, prepared_against: { spec_version, architecture_version, roadmap_version, revision: '__HEAD__' }, stages: STAGES[2], conformance: 'within_baseline' }), '.surety/phases/phase-2.md': phasePlanMd(2) }, { head: true }),
    step.result({ status: 'completed', summary: 'phase 2 planned', plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});
export const authoringScript = (phase) => roleThat(writes(authoringFiles(phase)), { proposal: { rationale: `The Verifier authors phase ${phase}'s checks before any stage builds.`, requested_change_kind: phase === 1 ? 'unclassifiable' : 'tightening' } });
export const builderScript = (stage, extra = {}) => roleThat(writes(BUILDER_FILES[stage]), extra);
export const specChangeScript = () => roleThat(writes({ '.surety/spec/spec.md': SPEC_V2 }), { changes: [{ key: 'R2', kind: 'criteria_changed', reason: 'CR-1: R2.1 names the content type' }, { key: 'R4', kind: 'text_changed', reason: 'CR-1: only successful sums are counted' }] });
export const correctionScript = () => roleThat(writes({ '.surety/checks/tests/service.test.mjs': CORRECTED_SERVICE_TEST }), { proposal: { rationale: 'CR-1 changed R2.1\'s text; the check now reads the content type.', requested_change_kind: 'tightening' } });

// The journey's scripts by work kind (§350). `omit` drops files from a
// phase's authoring (M407 (c): no post-deploy check); `tier` T1 Builders ask
// for no nomination (B06: the phase nominates).
export function journeyScripts(fx, { omit = {} } = {}) {
  const authoring = (phase) => {
    const files = { ...authoringFiles(phase) };
    for (const path of omit[phase] ?? []) delete files[path];
    return roleThat(writes(files), { proposal: { rationale: `The Verifier authors phase ${phase}'s checks.`, requested_change_kind: phase === 1 ? 'unclassifiable' : 'tightening' } });
  };
  // An array: launch n of the kind follows element n-1; an object: every launch of the kind.
  fx.scripted.kindScript('check_authoring', [authoring(1), authoring(2), authoring(2), authoring(2)]);
  fx.scripted.kindScript('stage_build', [builderScript(1), builderScript(2), builderScript(3), builderScript(4), builderScript(4)]);
  fx.scripted.kindScript('verification', script.complete());
  fx.scripted.kindScript('review', { steps: [{ review_auto: { reason: 'The approved specification requires these checks.' } }] });
  fx.scripted.kindScript('phase_verification', roleThat([], { signoffs: [{ scope: 'phase' }] }));
  fx.scripted.kindScript('replan', [replanScript(), replanScript({ spec_version: 2 }), replanScript({ spec_version: 2 })]);
  fx.scripted.kindScript('spec_change', specChangeScript());
  fx.scripted.kindScript('check_correction', correctionScript());
  fx.scripted.kindScript('fix', roleThat([]));
  fx.scripted.defaultScript(script.complete());
}

// ---- the pump --------------------------------------------------------------------------------

export const queuedExecutions = (home, project) =>
  rows(home, `SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`, project);
export const openDecisions = (home, project) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "status" = 'open' ORDER BY "id"`, project).map((r) => ({ ...r, options: json2(r.options) }));
const json2 = (t) => (t === null || t === undefined ? t : JSON.parse(t));

// Tick the project until `done` answers, doing on the way what the journey's
// harness does: in the kernel lane, record every queued check execution's
// exit (`exits(x)`, 0 by default); answer the routed decisions as the owner
// (recorded in `ctx.humanActs`); never answer any other kind. `max` ticks.
export async function pump(fx, ctx, done, { max = 80, what = 'the journey to advance', exits = () => 0, answer = 'approve' } = {}) {
  const { project } = ctx;
  ctx.humanActs ??= [];
  ctx.ticks ??= 0;
  for (let i = 0; i < max; i++) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    if (ctx.lane !== 'project') {
      for (const x of queuedExecutions(fx.home, project)) await recordExit(fx.engine, x.id, exits(x));
    }
    for (const d of openDecisions(fx.home, project)) {
      if (!ROUTED_KINDS.includes(d.kind)) continue;
      const option = d.options.some((o) => o.key === answer) ? answer : d.options[0].key;
      const res = await fx.engine.post(`/v1/projects/${project}/decisions/${d.id}/answer`, { option, preview_hash: d.preview_hash });
      ctx.humanActs.push({ kind: d.kind, id: d.id, option, status: res.status, at: new Date().toISOString() });
    }
    // One tick, then every run it started ended (the journey's scripts all
    // finish by themselves); the project lane's real domains take longer.
    const long = ctx.lane === 'project' ? { timeoutMs: 600_000 } : {};
    await tick(fx.engine, project, { rounds: 1, ...long });
    await waitForIdle(fx.home, project, long);
    ctx.ticks++;
    if (ctx.lane === 'project') await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: not reached within ${max} ticks (human acts so far: ${JSON.stringify(ctx.humanActs)})`);
}

// ---- readers for the build ---------------------------------------------------------------------

export const candidatesOfProject = (home, project) => rows(home, 'SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"', project);
export const evaluationsOfKind = (home, project, kind) => rows(home, 'SELECT * FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = ? ORDER BY rowid', project, kind).map((e) => ({ ...e, reasons: json2(e.reasons) }));
export const signoffsOfProject = (home, project) => rows(home, 'SELECT s.* FROM "signoffs" s JOIN "candidates" k ON k."id" = s."candidate" WHERE k."project" = ? ORDER BY s.rowid', project).map((s) => ({ ...s, binding: json2(s.binding) }));
export const resultsOf = (home, project) => rows(home, 'SELECT * FROM "check_results" WHERE "project" = ? ORDER BY "execution_seq"', project);
export const checkRows = (home, project) => rows(home, 'SELECT * FROM "checks" WHERE "project" = ? ORDER BY rowid', project);
export const protectedVersionsOf = (home, project) => rows(home, 'SELECT * FROM "protected_versions" WHERE "project" = ? ORDER BY "seq"', project);
export const proposalsOf = (home, project) => rows(home, 'SELECT * FROM "protected_proposals" WHERE "project" = ? ORDER BY "seq"', project);
export const obligationsOf = (home, project) => rows(home, 'SELECT * FROM "check_obligations" WHERE "project" = ? ORDER BY rowid', project).map((o) => ({ ...o, criteria: json2(o.criteria) }));
export const changeRequests = (home, project) => rows(home, 'SELECT * FROM "spec_change_requests" WHERE "project" = ? ORDER BY "seq"', project);
export const deploymentRequests = (home, project) => rows(home, 'SELECT * FROM "deployment_requests" WHERE "project" = ? ORDER BY rowid', project).map((r) => ({ ...r, request_key: json2(r.request_key) }));
export const authorizationsOfProject = (home, project) => rows(home, 'SELECT a.* FROM "deployment_authorizations" a JOIN "candidates" k ON k."id" = a."candidate" WHERE k."project" = ? ORDER BY a.rowid', project);
export const runsOfProject = (home, project) => rows(home, 'SELECT * FROM "runs" WHERE "project" = ? ORDER BY "seq"', project);
export const ledgerOf = (home, project) => rows(home, 'SELECT * FROM "ledger_rows" WHERE "project" = ? ORDER BY rowid', project);
export const hostObservations = (home) => rows(home, 'SELECT * FROM "host_observations" ORDER BY rowid');
export const planOfPhase = (home, project, phase) => phasePlansOf(home, project).filter((p) => p.phase_number === phase);
export { executionsOf };

// ---- steps 5 to 12 ------------------------------------------------------------------------------

// The journey's context: {fx, project, repo, lane, tier, humanActs, ticks}.
export function journeyContext(fx, p, { lane = 'kernel', tier = 'T2' } = {}) {
  return { fx, project: p.id, repo: p.repo, lane, tier, humanActs: [], ticks: 0 };
}

// Step 5: the phase's check authoring applied and the phase ready (§351).
export const authoringReady = (fx, ctx, phase, opts = {}) =>
  pump(fx, ctx, () => planOfPhase(fx.home, ctx.project, phase).find((p) => (p.active === 1 || p.active === true) && p.authoring_ready_at) ?? undefined, { what: `phase ${phase}'s authoring readiness`, ...opts });

// Steps 6 to 8: the phase complete (§352): `completed_at` on its active plan.
export const phaseCompleted = (fx, ctx, phase, opts = {}) =>
  pump(fx, ctx, () => planOfPhase(fx.home, ctx.project, phase).find((p) => (p.active === 1 || p.active === true) && p.completed_at) ?? undefined, { what: `phase ${phase} to complete`, max: 160, ...opts });

// Step 9: the next phase published by the replan (§352).
export const nextPhasePublished = (fx, ctx, phase, opts = {}) =>
  pump(fx, ctx, () => planOfPhase(fx.home, ctx.project, phase).find((p) => (p.active === 1 || p.active === true) && p.published_at) ?? undefined, { what: `phase ${phase} to be published by the replan`, ...opts });

// Step 11: CR-1 submitted through the owner's route and carried to its
// approval and effects (§353): spec version 2.
export async function changeRequest(fx, ctx, { text = CHANGE_REQUEST } = {}) {
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text });
  assert.equal(res.status, 201, `POST …/spec/change-requests (SEAM.md §353) (→ ${res.status} ${res.text})`);
  const request = res.body?.request;
  assert.match(request?.id ?? '', /^scr_/, `the answer names the request (${res.text})`);
  ctx.humanActs.push({ kind: 'spec_change_request', id: request.id, option: 'submit', status: res.status, at: new Date().toISOString() });
  const approved = await pump(fx, ctx, () => specRevisions(fx.home, ctx.project).find((r) => r.version === 2) ?? undefined, { what: 'spec version 2 to be approved', max: 60 });
  return { request, approved, res: res.body };
}

// Step 12: the environment configured by the owner and the adapter
// qualified (kernel: by the fixture, scripted adapter); `answers` script the
// scripted adapter's deploy. Returns {env, qualification}.
export async function alphaReady(fx, ctx, { name = 'alpha', port = 8080, answers = [{ result: 'issued', apply: true }], qualify = true } = {}) {
  const content = configContent({ start: [process.execPath, 'server.mjs'], port });
  const configured = await configure(fx.engine, ctx.project, name, content);
  const env = { ...configured.environment, name, config: configured.config, content };
  if (answers) await scriptCall(fx.engine, env.id, 'deploy', answers);
  const qualification = qualify ? await qualifyByFixture(fx.engine, { adapter_version: content.adapter_version }) : null;
  return { env, qualification };
}

// The candidate `alpha_deployed` (§354).
export const alphaDeployed = (fx, ctx, opts = {}) =>
  pump(fx, ctx, () => candidatesOfProject(fx.home, ctx.project).find((c) => c.progress === 'alpha_deployed') ?? undefined, { what: 'a candidate to be alpha_deployed', max: 80, ...opts });

// The pace read (§355).
export async function readPace(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}/pace`);
  assert.equal(res.status, 200, `GET …/pace (→ ${res.status} ${res.text})`);
  return res.body;
}

// Every leaf figure of a pace read: [path, value].
export function paceLeaves(value, path = []) {
  if (value === null || typeof value !== 'object') return [[path.join('.'), value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => paceLeaves(v, [...path, String(i)]));
  if ('unknown' in value && Object.keys(value).length <= 2) return [[path.join('.'), value]];
  return Object.entries(value).flatMap(([k, v]) => paceLeaves(v, [...path, k]));
}
