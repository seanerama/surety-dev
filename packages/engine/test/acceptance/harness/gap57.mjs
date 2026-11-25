// The obsolete deployment-gap authoring of DECISIONS item 57 (work order 1;
// rows M641 and M642, slice 50; kernel lane). The investigator's replay
// (surety-evidence batch-2026-11-25, maintenance-approvals/WO1, its probe)
// restated in the prototype harness's own terms: the real refusal route, no
// store write.
//
// A T1 rapid prototype reaches its Alpha on candidate c1 (iteration 1: R1,
// R2, R3 in phase 1). Iteration 2's brief approves spec version 2, which adds
// R1.2 and R3.2 to the delivered R1 and R3 and moves R1 and R3 to a new phase
// 2 (as production moved R1 to R5); `partial` also adds R2.2 to R2, left in
// phase 1 and still delivered by c1. While iteration 2's replan is eligible
// (the project paused through the owner's route), the owner's redeploy of c1
// is refused ACCEPTANCE_SCOPE_INCOMPLETE and queues a `check_authoring`
// (trigger `authoring_gap`, iteration 1's plan, evidence naming c1 and the
// missing criteria). The replan's first run holds at `rp` until released;
// its plan publishes phase 2 (one stage implementing R1 and R3, published
// without the owner; `approval`: three stages, which the plan check routes
// to the owner's plan_approval, the production order). Phase 2's own check
// authoring writes the reference checks and accept-r1b / accept-r3b covering
// R1.2 and R3.2.
//
// Nothing here asserts a row's clause; it asserts only that the step it
// takes happened (a step that did not happen is a named failure).

import assert from 'node:assert/strict';

import { requestDeployment } from './deploy/kernel.mjs';
import { waitFor } from './engine.mjs';
import { eventsOfType } from './journal.mjs';
import {
  CHECK_FILES,
  PROTO,
  REQS,
  answerOpen,
  briefToAlpha,
  builderOwn,
  candidatesOfProject,
  iterationRead,
  json,
  kindNext,
  modelBrief,
  observedCurrent,
  ok,
  prepScript,
  protoEngine,
  pump,
  result,
  specText,
  statusIs,
  toBrief,
  usage,
  write,
} from './prototype.mjs';
import { tick } from './runs.mjs';
import { step } from './scripted.mjs';
import { withStore } from './store.mjs';

export const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
const J = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
export const show = (v) => JSON.stringify(v);

// ---- spec version 2 ---------------------------------------------------------------------------

const R12 = '- R1.2 Given a task with a long title, when it is listed, then the whole title is shown.\n';
const R32 = '- R3.2 Given a done task, when the list is reloaded, then it is still listed as done.\n';
const R22 = '- R2.2 Given three tasks, when a user lists them, then the count is shown.\n';
export function specV2({ partial = false } = {}) {
  let s = specText({ version: 2, reqs: REQS, changeLog: [{ version: 2, change: 'Long titles shown whole; done state kept on reload' }] });
  s = s.replace(`- R1.1 ${REQS[0].crit}\n`, `- R1.1 ${REQS[0].crit}\n${R12}`).replace(`- R3.1 ${REQS[2].crit}\n`, `- R3.1 ${REQS[2].crit}\n${R32}`);
  s = s.replace('| R1 | Add a task | 1 | none | R1.1 |', '| R1 | Add a task | 2 | none | R1.1, R1.2 |').replace('| R3 | Finish a task | 1 | none | R3.1 |', '| R3 | Finish a task | 2 | none | R3.1, R3.2 |');
  if (partial) s = s.replace(`- R2.1 ${REQS[1].crit}\n`, `- R2.1 ${REQS[1].crit}\n${R22}`).replace('| R2 | List tasks | 1 | none | R2.1 |', '| R2 | List tasks | 1 | none | R2.1, R2.2 |');
  assert.ok(s.includes('R1.2') && s.includes('R3.1, R3.2') && (!partial || s.includes('R2.1, R2.2')), 'spec version 2 text built');
  return s;
}

// ---- iteration 2's plan, phase 2 ----------------------------------------------------------------

const ROADMAP2 = {
  version: 2,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'the task list, end to end', modules: ['app'], requirement_ids: ['R2'], depends_on: [] },
    { number: 2, goal: 'long titles and done state kept', modules: ['app'], requirement_ids: ['R1', 'R3'], depends_on: [1] },
  ],
};
const STAGE2 = { number: 1, goal: 'long titles and done kept', tasks: ['long titles and done kept'], modules: ['app'], implements: ['R1', 'R3'], adrs: [], depends_on: [], validation: { criteria: ['R1.1', 'R1.2', 'R3.1', 'R3.2'], kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] };
const STAGES_APPROVAL = [
  { ...STAGE2, number: 1, goal: 'long titles', tasks: ['long titles'], implements: ['R1'], validation: { ...STAGE2.validation, criteria: ['R1.1', 'R1.2'] } },
  { ...STAGE2, number: 2, goal: 'done kept', tasks: ['done kept'], implements: ['R3'], validation: { ...STAGE2.validation, criteria: ['R3.1', 'R3.2'] } },
  { ...STAGE2, number: 3, goal: 'both together', tasks: ['both together'], implements: ['R1', 'R3'], depends_on: [1, 2] },
];
const planScript = (hold, approval) => ({
  on_term: 'exit',
  steps: [
    usage(1800, 0, 700),
    ...(hold ? [{ hold: 'rp', heartbeat_ms: 250 }] : []),
    write('.surety/roadmap/roadmap.json', json(ROADMAP2)),
    write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list (R2).\n2. Long titles and done kept (R1, R3).\n'),
    { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: 2, architecture_version: 1, roadmap_version: 2, revision: '__HEAD__' }, stages: approval ? STAGES_APPROVAL : [STAGE2], conformance: 'within_baseline' }), substitute_head: true } },
    write('.surety/phases/phase-2.md', '# Phase 2\n\n- Stage 1: long titles and done kept\n'),
    result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance: 'within_baseline' }),
  ],
});

const def = (key, fields) => json({ schema: 1, key, ...fields });
const G2 = ['stage', 'alpha_authorize'];
const covering = (key, criterion) => ({ [`.surety/checks/defs/${key}.json`]: def(key, { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: G2, covers: { criteria: [criterion] } }) });
export const PHASE2_CHECKS = Object.freeze({ ...CHECK_FILES, ...covering('accept-r1b', 'R1.2'), ...covering('accept-r3b', 'R3.2') });
const phase2Authoring = { steps: [step.probe('context_dump'), usage(900, 100, 300), ...Object.entries(PHASE2_CHECKS).map(([p, c]) => write(p, c)), result({ proposal: { rationale: "phase 2's checks", requested_change_kind: 'unclassifiable' } })] };

// A gap authoring's Verifier (were it dispatched): it writes a check per
// criterion and reports a high defect on each against the old candidate.
export const gapScript = (criteria) => ({
  on_term: 'exit',
  steps: [
    step.probe('context_dump'),
    usage(900, 100, 300),
    ...criteria.map((k) => Object.entries(covering(`gap-${k.toLowerCase().replace('.', '-')}`, k)).map(([p, c]) => write(p, c))[0]),
    result({
      proposal: { rationale: `the gap checks for ${criteria.join(', ')}`, requested_change_kind: 'tightening' },
      findings: criteria.map((k) => ({ category: 'defect', severity: 'high', message: `candidate 1 does not meet ${k}`, check: `gap-${k.toLowerCase().replace('.', '-')}`, criterion: k })),
    }),
  ],
});

// ---- the store, read ----------------------------------------------------------------------------

export const itemRow = (home, id) => rows(home, 'SELECT * FROM "work_items" WHERE "id" = ?', id).map((r) => ({ ...r, subject: J(r.subject), trigger_evidence: J(r.trigger_evidence) }))[0];
export const gapItems = (home, p) =>
  rows(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = 'authoring_gap' ORDER BY "seq"`, p).map((r) => ({ ...r, subject: J(r.subject), trigger_evidence: J(r.trigger_evidence) }));
export const runsOn = (home, item) => rows(home, 'SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"', item);
export const findingsOf = (home, p) => rows(home, 'SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"', p);
export const plansOf = (home, p) => rows(home, 'SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid', p).map((r) => ({ ...r, completion_binding: J(r.completion_binding), verification: J(r.verification) }));
export const phase2Plan = (home, p) => plansOf(home, p).find((x) => x.phase_number === 2 && ['published', 'completed'].includes(x.status)) ?? null;
export const cancelledOf = (home, item) => eventsOfType(home, 'work.cancelled').filter((e) => e.subject?.work_item === item);
export const holdsOf = (home, item) => eventsOfType(home, 'work.hold_began').filter((e) => e.subject?.work_item === item);
// What came from an item: its runs, the findings they raised, and every
// decision about the item, its runs' proposals or their findings.
export function fromItem(home, item) {
  const runs = runsOn(home, item).map((r) => r.id);
  const inList = (xs) => (xs.length === 0 ? "('')" : `(${xs.map((x) => `'${x}'`).join(',')})`);
  const findings = rows(home, `SELECT "id", "criterion", "status" FROM "findings" WHERE "source_run" IN ${inList(runs)}`);
  const proposals = rows(home, `SELECT "id" FROM "protected_proposals" WHERE "run" IN ${inList(runs)}`).map((r) => r.id);
  const decisions = rows(home, `SELECT "id", "kind", "status" FROM "decisions" WHERE "subject_id" IN ${inList([item, ...runs, ...proposals, ...findings.map((f) => f.id)])}`);
  return { runs, findings, proposals, decisions };
}
// The checks of the effective protected version covering a criterion.
export const effectiveCovering = (home, p, criterion) =>
  rows(
    home,
    `SELECT c."key", c."criteria" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version"
      WHERE v."project" = ? AND v."authorized" = 1 AND v."effective_from" IS NOT NULL AND v."superseded_by" IS NULL`,
    p,
  ).filter((c) => (J(c.criteria) ?? []).includes(criterion)).map((c) => c.key);

// ---- the journey --------------------------------------------------------------------------------

export async function restart(fx) {
  await fx.engine.stop();
  await fx.start();
}

// The refusal and its gap item, the project paused, the replan eligible
// (held at `rp` once launched). Returns the fixture's ids.
export async function oldAlphaRefused(t, { name, port, approval = false, partial = false }) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  const { id: p, it } = await toBrief(fx, { name });
  const env = await briefToAlpha(fx, p, it.id, { port });
  await observedCurrent(fx, p, it.id);
  const c1 = candidatesOfProject(fx.home, p).at(-1);
  assert.ok(c1, 'the fixture is live: iteration 1 at its Alpha on a candidate');
  const plan1 = plansOf(fx.home, p).find((x) => x.phase_number === 1);
  const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, { change: 'Show long titles whole and keep done tasks done after a reload.' }), 201, 'iterate');
  const two = made.iteration.id;
  kindNext(fx, 'brief_preparation', [prepScript({ spec: specV2({ partial }), brief: modelBrief({ objectives: ['R1: a user adds a task; long titles are shown whole', 'R2: a user lists the tasks', 'R3: a user finishes a task; done stays done after reload'] }) })], prepScript());
  await answerOpen(fx, p, PROTO.preparation.decision);
  await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
  kindNext(fx, 'replan', [planScript(true, approval), planScript(false, approval), planScript(false, approval)], planScript(false, approval));
  kindNext(fx, 'check_authoring', [phase2Authoring, phase2Authoring], phase2Authoring);
  kindNext(fx, 'stage_build', [builderOwn('src/titles.mjs', 'export const whole = (t) => t;\n')], builderOwn('src/titles.mjs', 'export const whole = (t) => t;\n'));
  await ok(fx.engine.post(`/v1/projects/${p}/pause`, {}), 200, 'the owner pauses the project');
  await answerOpen(fx, p, 'spec_approval');
  const replan = () => rows(fx.home, `SELECT "id", "status" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' ORDER BY "seq" DESC`, p)[0];
  const R = await waitFor(() => (replan()?.status === 'eligible' ? replan().id : undefined), { what: "iteration 2's replan eligible" });
  const findingsBefore = findingsOf(fx.home, p).length;
  const refusal = await requestDeployment(fx.engine, p, c1.id, 'alpha');
  assert.equal(refusal.status, 409, `the fixture is live: the redeploy of c1 is refused (→ ${refusal.status} ${refusal.text})`);
  const subjects = (refusal.body?.subject?.reasons ?? []).filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects ?? []);
  const criteria = partial ? ['R1.2', 'R2.2', 'R3.2'] : ['R1.2', 'R3.2'];
  assert.deepEqual([...subjects].sort(), criteria, `the fixture is live: refused ACCEPTANCE_SCOPE_INCOMPLETE ${criteria} (${refusal.text})`);
  const gaps = gapItems(fx.home, p);
  assert.equal(gaps.length, 1, `the fixture is live: the refusal queued one gap authoring (${show(gaps.map((g) => [g.id, g.status]))})`);
  const G = gaps[0];
  assert.deepEqual([G.trigger_id, G.trigger_evidence?.deployment?.candidate, G.trigger_evidence?.deployment?.missing?.criteria], [plan1.id, c1.id, criteria], `the fixture is live: on iteration 1's plan, naming c1 and the criteria (${show(G)})`);
  fx.scripted.script(G.id, [gapScript(criteria), gapScript(criteria)]);
  return { fx, p, it, two, env, c1, plan1, R, G: G.id, criteria, findingsBefore };
}

// Tick until phase 2's plan is published (answering `plan_approval` only
// when `approve`), or `rounds` pass. Returns the plan row or null.
export async function untilPublished(fx, p, { approve = false, rounds = 20 } = {}) {
  for (let i = 0; i < rounds; i++) {
    const plan = phase2Plan(fx.home, p);
    if (plan) return plan;
    if (approve) {
      const open = (await ok(fx.engine.get(`/v1/projects/${p}/decisions`), 200, 'GET …/decisions')).decisions;
      for (const d of open.filter((x) => x.kind === 'plan_approval')) await ok(fx.engine.post(`/v1/projects/${p}/decisions/${d.id}/answer`, { option: 'approve', preview_hash: d.preview_hash }), 200, 'the owner approves the plan');
    }
    await tick(fx.engine, p, { rounds: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
  return phase2Plan(fx.home, p);
}

export const replanRuns = (fx, R) => runsOn(fx.home, R);
export const iterationStatus = async (fx, p, it) => (await iterationRead(fx, p, it)).iteration.status;
