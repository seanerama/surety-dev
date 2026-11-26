// Verifier 2's helpers for rows M636, M637, M639 and M643 (the owner's M7
// plan §3j; DECISIONS item 57, Sean's rulings D2, D3, D5, D6 of
// 2026-11-26; slice 50; kernel lane). Nothing here asserts a row's clause;
// it asserts only that the step it takes happened (a step that did not
// happen is a named failure, never a silent skip).
//
// - recordWith / pumpWith: the prototype harness's scripted check boundary
//   (SEAM.md §190) and its pump, with each queued execution's exit status
//   chosen by `exitOf(execution)` (key, candidate, protected version)
//   instead of always 0.
// - the store, read; the served shapes, searched.
//
// SAFETY (BS6 §4.1; E64): only the test's own engine is driven; nothing is
// signalled here.

import { setTimeout as sleep } from 'node:timers/promises';

import { advanceClock, tick } from './runs.mjs';
import { answer, idle, iterationRows, openDecisionsRead, workOfProject } from './prototype.mjs';
import { withStore } from './store.mjs';

export const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
export const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
export const J = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
export const show = (v) => JSON.stringify(v);

// ---- the scripted check boundary with chosen exits -------------------------------------------

export const queuedWith = (home, project) =>
  rows(
    home,
    `SELECT x."id", x."key", x."candidate", x."protected_version", k."seq" AS "candidate_seq" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate"
      WHERE k."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`,
    project,
  );

// Every queued execution of the project moved to recorded with exitOf(x).
// Returns what was recorded: [{id, key, candidate, protected_version, exit}].
export async function recordWith(fx, project, exitOf = () => 0, log = []) {
  for (const x of queuedWith(fx.home, project)) {
    const exit = exitOf(x);
    let recorded = true;
    for (const to of ['materializing', 'running', 'collecting', 'recorded']) {
      const res = await fx.engine.post('/v1/harness/fixtures/check-execution', { execution: x.id, to, ...(to === 'recorded' ? { exit_status: exit } : {}) });
      if (res.status !== 200) {
        recorded = false;
        break; // superseded or cancelled meanwhile
      }
    }
    if (recorded) log.push({ ...x, exit });
  }
  return log;
}

// prototype.mjs pump, the check boundary recording exitOf(x).
export async function pumpWith(fx, project, done, { answer: kinds = [], max = 60, what = 'the journey to advance', exitOf = () => 0, acts = [], log = [] } = {}) {
  for (let i = 0; ; i++) {
    const v = await done();
    if (v !== undefined && v !== null && v !== false) return v;
    if (i >= max) {
      const open = (await openDecisionsRead(fx, project)).map((d) => d.kind);
      const its = iterationRows(fx.home, project).map((r) => [r.seq, r.status, r.next_step, r.outcome_reason]);
      const work = workOfProject(fx.home, project)
        .filter((w) => !['complete', 'cancelled'].includes(w.status))
        .map((w) => `${w.kind}:${w.status}:${String(w.blocker ?? '').slice(0, 200)}`);
      throw new Error(`${what}: not reached in ${max} ticks (iterations: ${show(its)}; open decisions: ${show(open)}; work: ${show(work)}; acts: ${show(acts)}; engine stderr: ${fx.engine.proc.out.stderr.slice(-1500)})`);
    }
    await idle(fx, project);
    await recordWith(fx, project, exitOf, log);
    for (const d of await openDecisionsRead(fx, project)) {
      if (!kinds.includes(d.kind)) continue;
      const res = await answer(fx, project, d, 'approve');
      acts.push({ kind: d.kind, id: d.id, status: res.status });
    }
    await tick(fx.engine, project);
    await idle(fx, project);
  }
}

// The controlled clock (SEAM.md §425) advanced `seconds` in steps, the
// project ticked after each (no run is under way when this is used).
export async function advanceTicking(fx, project, seconds, step = 1800) {
  let left = seconds;
  while (left > 0) {
    const s = Math.min(step, left);
    await advanceClock(fx.engine, s);
    left -= s;
    await tick(fx.engine, project, { rounds: 1 });
    await sleep(100);
  }
}

// ---- the store ---------------------------------------------------------------------------------

export const findingRow = (home, id) => {
  const f = one(home, 'SELECT * FROM "findings" WHERE "id" = ?', id);
  return f && { ...f, severity_history: J(f.severity_history), resolution_verification: J(f.resolution_verification) };
};
export const findingsOfProject = (home, p) => rows(home, 'SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"', p);
export const decisionsAbout = (home, subjectId, kind = null) =>
  rows(home, `SELECT * FROM "decisions" WHERE "subject_id" = ?${kind ? ' AND "kind" = ?' : ''} ORDER BY "seq"`, ...(kind ? [subjectId, kind] : [subjectId]));
export const openDecisionsAbout = (home, subjectId) => rows(home, `SELECT * FROM "decisions" WHERE "subject_id" = ? AND "status" = 'open' ORDER BY "seq"`, subjectId);
export const proposalRow = (home, id) => one(home, 'SELECT * FROM "protected_proposals" WHERE "id" = ?', id);
export const proposalsOfRun = (home, run) => rows(home, 'SELECT * FROM "protected_proposals" WHERE "run" = ? ORDER BY "seq"', run);
export const versionsOfProposal = (home, proposal) => rows(home, 'SELECT * FROM "protected_versions" WHERE "proposal" = ? ORDER BY "seq"', proposal);
export const workRow = (home, id) => {
  const w = one(home, 'SELECT * FROM "work_items" WHERE "id" = ?', id);
  return w && { ...w, subject: J(w.subject), trigger_evidence: J(w.trigger_evidence), blocker: J(w.blocker) };
};
export const workOfKind = (home, p, kind) => rows(home, 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', p, kind).map((w) => ({ ...w, subject: J(w.subject), trigger_evidence: J(w.trigger_evidence) }));
export const runsOfItem = (home, item) => rows(home, 'SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"', item);
export const resultsOf = (home, candidate, key) =>
  rows(home, 'SELECT r.* FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."candidate" = ? AND c."key" = ? ORDER BY r."created_at", r.rowid', candidate, key);
export const columnsOf = (home, table) => withStore(home, (db) => db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
export const eventsAbout = (home, id) =>
  rows(home, 'SELECT "seq", "type", "subject", "payload" FROM "events" ORDER BY "seq"')
    .map((e) => ({ ...e, subject: J(e.subject), payload: J(e.payload) }))
    .filter((e) => show(e.subject).includes(id));

// ---- served shapes, searched -------------------------------------------------------------------

// Every value under `key` anywhere in v (depth-first).
export function valuesAt(v, key, out = []) {
  if (Array.isArray(v)) for (const x of v) valuesAt(x, key, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === key) out.push(x);
      valuesAt(x, key, out);
    }
  }
  return out;
}
// Every object anywhere in v for which pred holds.
export function objectsWhere(v, pred, out = []) {
  if (Array.isArray(v)) for (const x of v) objectsWhere(x, pred, out);
  else if (v && typeof v === 'object') {
    if (pred(v)) out.push(v);
    for (const x of Object.values(v)) objectsWhere(x, pred, out);
  }
  return out;
}
export function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}
// The reading of "its evidence naming why policy did not cover it": in the
// served decision, either an entry whose key names the policy (a key
// starting `policy_`, other than `policy_revision`) with a non-empty string
// reason, or a sentence (at least 20 characters) naming the policy
// (/polic/i) and why (one of the case's terms). Returns the reasons found.
export const POLICY_WHY = /brief|scope|criteri|command|runner|execut|loosen|weaken|unclassif|iteration|allowance|repair|verif|reproduc|candidate/i;
export function whyNotPolicy(decision) {
  const keyed = [];
  objectsWhere(decision, (o) => {
    for (const [k, v] of Object.entries(o)) if (/^policy_/.test(k) && k !== 'policy_revision' && typeof v === 'string' && v.trim() !== '') keyed.push(`${k}: ${v}`);
    return false;
  });
  return [...keyed, ...stringsOf(decision).filter((s) => s.length >= 20 && /polic/i.test(s) && POLICY_WHY.test(s))];
}

// ---- check trees the classifier can call a tightening ------------------------------------------
//
// A definition that declares no `inputs` takes every file under the
// protected roots as its input manifest (checks/schema.ts expandInputs, the
// default of Q3 (a)), so any added or changed file under .surety/checks/
// is `input_changed` for every such check and the proposal is
// unclassifiable (checks/classify.ts). The trees below declare `inputs: []`
// on every definition, so that an added check or an added criterion is the
// classifier's tightening.
const jsonText = (v) => `${JSON.stringify(v, null, 2)}\n`;
export const narrowInputs = (files) =>
  Object.fromEntries(Object.entries(files).map(([path, content]) => (path.includes('/defs/') ? [path, jsonText({ ...JSON.parse(content), inputs: [] })] : [path, content])));

// ---- M641's fixture with narrow inputs ----------------------------------------------------------
//
// harness/gap57.mjs oldAlphaRefused restated, every check (iteration 1's,
// phase 2's) declaring `inputs: []`. Returns the same ids.
import assert from 'node:assert/strict';
import { requestDeployment } from './deploy/kernel.mjs';
import { waitFor } from './engine.mjs';
import { PHASE2_CHECKS, gapItems, gapScript, plansOf, specV2 } from './gap57.mjs';
import {
  CHECK_FILES as BASE_FILES,
  answerOpen as answerKind,
  authoringScript as authoring,
  briefToAlpha,
  builderOwn,
  candidatesOfProject,
  kindNext as kindNextOf,
  modelBrief,
  observedCurrent,
  ok as okOf,
  prepScript,
  protoEngine,
  pump as pumpOf,
  result as resultOf,
  statusIs,
  toBrief,
  usage as usageOf,
  write as writeOf,
} from './prototype.mjs';
import { step as stepOf } from './scripted.mjs';

export const NARROW_FILES = Object.freeze(narrowInputs(BASE_FILES));
export const NARROW_PHASE2 = Object.freeze(narrowInputs(PHASE2_CHECKS));

const GAP_ROADMAP2 = {
  version: 2,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'the task list, end to end', modules: ['app'], requirement_ids: ['R2'], depends_on: [] },
    { number: 2, goal: 'long titles and done state kept', modules: ['app'], requirement_ids: ['R1', 'R3'], depends_on: [1] },
  ],
};
const GAP_STAGE2 = { number: 1, goal: 'long titles and done kept', tasks: ['long titles and done kept'], modules: ['app'], implements: ['R1', 'R3'], adrs: [], depends_on: [], validation: { criteria: ['R1.1', 'R1.2', 'R3.1', 'R3.2'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] };
const GAP_THREE = [
  { ...GAP_STAGE2, number: 1, goal: 'long titles', tasks: ['long titles'], implements: ['R1'], validation: { ...GAP_STAGE2.validation, criteria: ['R1.1', 'R1.2'] } },
  { ...GAP_STAGE2, number: 2, goal: 'done kept', tasks: ['done kept'], implements: ['R3'], validation: { ...GAP_STAGE2.validation, criteria: ['R3.1', 'R3.2'] } },
  { ...GAP_STAGE2, number: 3, goal: 'both together', tasks: ['both together'], implements: ['R1', 'R3'], depends_on: [1, 2] },
];
export const gapPlanScript = ({ hold = false, approval = false } = {}) => ({
  on_term: 'exit',
  steps: [
    usageOf(1800, 0, 700),
    ...(hold ? [{ hold: 'rp', heartbeat_ms: 250 }] : []),
    writeOf('.surety/roadmap/roadmap.json', jsonText(GAP_ROADMAP2)),
    writeOf('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list (R2).\n2. Long titles and done kept (R1, R3).\n'),
    { write: { path: '.surety/phases/phase-2.json', content: jsonText({ phase: 2, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: approval ? GAP_THREE : [GAP_STAGE2], conformance: 'within_baseline' }), substitute_head: true } },
    writeOf('.surety/phases/phase-2.md', '# Phase 2\n'),
    resultOf({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});
const phase2Authoring = (files) => ({ steps: [stepOf.probe('context_dump'), usageOf(900, 100, 300), ...Object.entries(files).map(([p, c]) => writeOf(p, c)), resultOf({ proposal: { rationale: "phase 2's checks", requested_change_kind: 'unclassifiable' } })] });

export async function narrowGapRefused(t, { name, port, partial = false, approval = false, phase2Files = NARROW_PHASE2 }) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  kindNextOf(fx, 'check_authoring', [authoring({ files: NARROW_FILES })], authoring({ files: NARROW_FILES }));
  const { id: p, it } = await toBrief(fx, { name });
  const env = await briefToAlpha(fx, p, it.id, { port });
  await observedCurrent(fx, p, it.id);
  const c1 = candidatesOfProject(fx.home, p).at(-1);
  const plan1 = plansOf(fx.home, p).find((x) => x.phase_number === 1);
  const made = await okOf(fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, { change: 'Show long titles whole and keep done tasks done after a reload.' }), 201, 'iterate');
  const two = made.iteration.id;
  kindNextOf(fx, 'brief_preparation', [prepScript({ spec: specV2({ partial }), brief: modelBrief({ objectives: ['R1: a user adds a task; long titles are shown whole', 'R2: a user lists the tasks', 'R3: a user finishes a task; done stays done after reload'] }) })], prepScript());
  await answerKind(fx, p, 'prototype_preparation_approval');
  await pumpOf(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
  kindNextOf(fx, 'replan', [gapPlanScript({ hold: true, approval }), gapPlanScript({ approval }), gapPlanScript({ approval })], gapPlanScript({ approval }));
  kindNextOf(fx, 'check_authoring', [phase2Authoring(phase2Files), phase2Authoring(phase2Files)], phase2Authoring(phase2Files));
  kindNextOf(fx, 'stage_build', [builderOwn('src/titles.mjs', 'export const whole = (t) => t;\n')], builderOwn('src/titles.mjs', 'export const whole = (t) => t;\n'));
  await okOf(fx.engine.post(`/v1/projects/${p}/pause`, {}), 200, 'the owner pauses the project');
  await answerKind(fx, p, 'spec_approval');
  const replan = () => rows(fx.home, `SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' ORDER BY "seq" DESC`, p)[0];
  const R = await waitFor(() => (replan()?.status === 'eligible' ? replan().id : undefined), { what: "iteration 2's replan eligible" });
  const refusal = await requestDeployment(fx.engine, p, c1.id, 'alpha');
  assert.equal(refusal.status, 409, `the fixture is live: the redeploy of c1 is refused (→ ${refusal.status} ${refusal.text})`);
  const criteria = partial ? ['R1.2', 'R2.2', 'R3.2'] : ['R1.2', 'R3.2'];
  const gaps = gapItems(fx.home, p);
  assert.equal(gaps.length, 1, 'the fixture is live: the refusal queued one gap authoring');
  const G = gaps[0];
  assert.deepEqual(G.trigger_evidence?.deployment?.missing?.criteria, criteria, 'the fixture is live: naming the criteria');
  fx.scripted.script(G.id, [gapScript(criteria), gapScript(criteria)]);
  return { fx, p, it, two, env, c1, plan1, R, G: G.id, criteria };
}
