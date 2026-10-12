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

import { consume, decision, decisionsOfKind } from '../decisions.mjs';
import { eventsOfType, changePolicy } from '../journal.mjs';
import { waitFor } from '../engine.mjs';
import { makeProjectRepo, refOid } from '../repos.mjs';
import { getRow, tickUntil } from '../runs.mjs';
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
  if (policy !== undefined) await changePolicy(fx.engine, id, policy);
  return { id, repo, base: refOid(repo.path, repo.ref), res };
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
