// M6 slice 44, approval, holds, staleness and the plan (M508, M512, M513,
// M514, M515, M517, M530; SEAM.md §§512 to 519). Built on slices 40 to 43's
// harness (reference.mjs, drive.mjs, check41.mjs, assets43.mjs) and pinned
// beside it:
//
// - three more variants of the reference project "Pantry":
//   **Pantry in two phases** (`TWO_PHASE`): phase 1 the API and the web page
//   (R1, R2), phase 2 the Android app and R4, an unmarked requirement (the
//   count), so that a phase-2 plan can give R4 to a UI stage no screen
//   covers (M508);
//   **Pantry of four screens** (`FOUR`): R2 and R4 on the web (the list, the
//   add form), R3 and R5 on Android, R6 an unmarked API requirement; its
//   design draws one screen per requirement (S1 to S4), each screen using
//   one interface, so a change can stale some screens and not others (M515);
//   **Pantry with no `ui` module** (`API_ONLY`, M513 (d));
// - the batch's specification for any design and base (`batchSpec`): the
//   design's criteria under their requirements, one human-test requirement
//   per target numbered after the highest key;
// - a Pantry designed and approved through the owner's routes
//   (`designedPantry`), its UI stages left unbuilt unless the case builds
//   them;
// - the owner's specification change through his route
//   (`ownerChange`), a later Architect session (`laterArchitect`), the
//   owner-invoked review (`ownerReview`), the engine's clock (`engineNow`);
// - reads of the design class: `design_screens`, `stage_screens`, every
//   `design_due` of a project, the impact's `design` class.
//
// Nothing here starts, stops or signals a process but the scripted roles and
// the engine's own commands in the test's home. Nothing the Designer writes
// is run by anyone (BS6 §4.1 rule 21).

import assert from 'node:assert/strict';

import { definitionText } from '../checks/fixtures.mjs';
import { consume, decision, decisionsOfKind } from '../decisions.mjs';
import { eventsOfType } from '../journal.mjs';
import { pump, specRevisions } from '../journey/drive.mjs';
import { impactOf } from '../journey/change36.mjs';
import { postChange } from '../journey/review31b.mjs';
import { roleThat } from '../gitruns.mjs';
import { advanceClock } from '../runs.mjs';
import { step } from '../scripted.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, turnResult, turnThatWrites } from '../sessions.mjs';
import { postCloseRaw } from '../session-lane.mjs';
import { withStore } from '../store.mjs';
import { ADR_KEY, ARCHITECTURE_MD, MODULES_JSON, REQUIREMENTS, ROADMAP_JSON, SPEC_MODULES, STAGES, T2_KINDS, TARGETS_LINE, authoringFiles, specText } from './reference.mjs';
import { designScripts, inventoryOf, openDesigner, scriptBuilders, toPublished } from './drive.mjs';
import { BEFORE_BUILD, KERNEL_KINDS, approveBatch, assertPassed, checkSession, designModel, filesOf, scriptVariant, untilBatch } from './check41.mjs';

export const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const clone = (v) => structuredClone(v);
const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);

export const TWO_DAYS = 172_800;
export const DESIGN_KINDS = Object.freeze(['design_approval', 'design_due', 'design_verdicts']);

// ---- the specification -----------------------------------------------------------------------

const keyNumber = (key) => Number(String(key).replace(/^R/, ''));
export const nextKey = (reqs) => Math.max(0, ...reqs.map((r) => keyNumber(r.key))) + 1;

// The specification in TPL's shape for a list of requirements (reference.mjs's specText).
export const specOf = ({ version, requirements, targets = TARGETS_LINE, crossPlatform, modules = SPEC_MODULES, log = [] }) =>
  specText({ version, requirements, targets, ...(crossPlatform === undefined ? {} : { crossPlatform }), modules, changeLog: log });

// The batched change's specification for a design (D7 §7.1, §7.3; SEAM.md
// §486): each design criterion under its requirement (numbered after the
// requirement's last criterion); one human-test requirement per target,
// marked **Human test.** and **Surface:** ui (<target>), numbered after the
// highest key of `base`, at `phaseOf(target)` in the index. `humanKind`:
// `added` for a first design, `text_changed` for a later one whose human
// tests replace earlier ones (`humanKeys` then names their keys).
// Returns {text, changes, humanKeys, requirements}.
export function batchSpec({ base, criteria, version = 2, phaseOf = () => 1, humanKind = 'added', humanKeys: given = null, targets = TARGETS_LINE, modules = SPEC_MODULES, log = [] }) {
  const reqs = base.map((r) => ({ ...r, criteria: [...(r.criteria ?? [])] }));
  const changes = [];
  for (const c of criteria.criteria ?? []) {
    const r = reqs.find((x) => x.key === c.requirement);
    assert.ok(r, `the base has ${c.requirement}`);
    r.criteria.push({ id: `${r.key}.${r.criteria.length + 1}`, text: c.text });
    if (!changes.some((x) => x.key === r.key)) changes.push({ key: r.key, kind: 'criteria_added', reason: 'the approved design\'s criteria' });
  }
  const humanKeys = {};
  let next = nextKey(reqs);
  for (const h of criteria.human_tests ?? []) {
    const key = given?.[h.target] ?? `R${next++}`;
    humanKeys[h.target] = key;
    const req = { key, title: `The ${h.target} UI matches the approved design`, phase: phaseOf(h.target), surface: `ui (${h.target})`, statement: `A person judges the ${h.target} UI against the approved design.`, human_test: h.text, criteria: [] };
    const at = reqs.findIndex((x) => x.key === key);
    if (at >= 0) reqs[at] = req;
    else reqs.push(req);
    changes.push({ key, kind: humanKind, reason: `the ${h.target} human test of the approved design` });
  }
  const text = specOf({ version, requirements: reqs, targets, modules, log: [...log, { version, date: '2026-10-17', change: 'The approved design\'s criteria and human tests', by: 'Sean' }] });
  return { text, changes, humanKeys, requirements: reqs };
}

// The Spec Writer's one-shot writing `text` with `changes` (B.7).
export const specWriter = (text, changes) => roleThat([step.write('.surety/spec/spec.md', text)], { summary: 'the change', changes });

// ---- Pantry in two phases (M508) ------------------------------------------------------------

export const R4_COUNT = Object.freeze({
  key: 'R4',
  title: 'The pantry\'s count',
  phase: 2,
  statement: 'The service reports how many items the pantry holds.',
  criteria: [{ id: 'R4.1', text: 'Given two items, when a client requests GET /api/count, then it answers 200 with the JSON body {"count": 2}.' }],
});
export const TWO_PHASE_REQUIREMENTS = Object.freeze([REQUIREMENTS[0], REQUIREMENTS[1], { ...REQUIREMENTS[2], phase: 2 }, R4_COUNT]);
export const TWO_PHASE_ROADMAP = Object.freeze({
  version: 1,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'the pantry API and the web page', modules: ['api', 'web'], requirement_ids: ['R1', 'R2'], depends_on: [] },
    { number: 2, goal: 'the pantry on Android, and its count', modules: ['api', 'web', 'mobile'], requirement_ids: ['R3', 'R4'], depends_on: [1] },
  ],
});
export const TWO_PHASE = Object.freeze({
  spec: specText({ requirements: TWO_PHASE_REQUIREMENTS }),
  files: { roadmap: TWO_PHASE_ROADMAP, stages: [STAGES[0], STAGES[1]] },
  base: TWO_PHASE_REQUIREMENTS,
  // Both targets' last UI stages are in phase 2 (SEAM.md §486's rule: phase 2 has no plan, its roadmap modules hold web and mobile).
  phaseOf: () => 2,
});
// Phase 2's stages: the Android app (R3), and R4 on the API or on a UI module.
export const PHASE_TWO_STAGES = Object.freeze({
  android: { number: 3, goal: 'the Android app', tasks: ['write mobile/App.js from the approved design'], modules: ['mobile'], implements: ['R3'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R3.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
  countApi: { number: 4, goal: 'the count', tasks: ['serve GET /api/count'], modules: ['api'], implements: ['R4'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R4.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
  countWeb: { number: 4, goal: 'the count on the page', tasks: ['show the count on web/index.html'], modules: ['web'], implements: ['R4'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R4.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
});

// An Architect replan writing phase `phase`'s plan of `stages` (B.5, `screens`
// per stage where given), prepared against the versions given and the head;
// with `roadmap` (and `roadmapMd`) a roadmap revision too.
// A plan written with a roadmap revision is prepared against that revision's
// version (as final153.mjs's delivery replan is).
export function replanWith({ phase = 2, stages, spec_version = 2, architecture_version = 1, roadmap_version = 1, roadmap = null, roadmapMd = null }) {
  const plan = { phase, prepared_against: { spec_version, architecture_version, roadmap_version: roadmap ? roadmap.version : roadmap_version, revision: '__HEAD__' }, stages, conformance: 'within_baseline' };
  return {
    steps: [
      ...(roadmap ? [step.write('.surety/roadmap/roadmap.json', json(roadmap)), step.write('.surety/roadmap/roadmap.md', roadmapMd ?? `# Roadmap\n\n${roadmap.phases.map((p) => `${p.number}. ${p.goal}`).join('\n')}\n`)] : []),
      { write: { path: `.surety/phases/phase-${phase}.json`, content: json(plan), substitute_head: true } },
      step.write(`.surety/phases/phase-${phase}.md`, `# Phase ${phase}\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`),
      step.result({ status: 'completed', summary: `phase ${phase} planned`, plan: `phase-${phase}`, ...(roadmap ? { roadmap_revision: true } : {}), conformance: 'within_baseline', adrs_changed: [] }),
    ],
  };
}

// The project's roadmap as the store holds it now (its newest revision, which
// may be the engine's placing of the design's human tests, SEAM.md §486),
// and a revision of it for a replan to write: `edit(phases)` changes a copy
// of the phases; `moved` lists the requirements it moves.
export function currentRoadmap(home, project) {
  const r = rows(home, 'SELECT * FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1', project)[0];
  assert.ok(r, 'the project has a roadmap');
  const phases = parse(r.phases);
  return { version: r.version, phases: (Array.isArray(phases) ? phases : phases?.phases ?? []).map((p) => ({ number: p.number, goal: p.goal, modules: p.modules, requirement_ids: p.requirement_ids, depends_on: p.depends_on ?? [] })) };
}
export function roadmapRevision(home, project, edit, { moved = [] } = {}) {
  const now = currentRoadmap(home, project);
  return { version: now.version + 1, architecture_version: 1, phases: edit(clone(now.phases)), ...(moved.length > 0 ? { moved_requirements: moved } : {}) };
}

// Phase 1's check authoring, then each later phase's: phase 1's files and
// one more smoke check, so a later phase's proposal is never empty (a tightening).
const SMOKE_LATER = '.surety/checks/defs/smoke-later.json';
export const LATER_AUTHORING = roleThat(
  Object.entries({ ...authoringFiles(), [SMOKE_LATER]: definitionText('smoke-later', { inputs: [], kind: 'smoke', command: ['node', '--check', 'server.mjs'], timeout_s: 60, gate_kinds: ['stage'] }) }).map(([path, text]) => step.write(path, text)),
  { proposal: { rationale: 'The later phase\'s checks: one more smoke check.', requested_change_kind: 'tightening' } },
);
const phaseOneAuthoring = (extra = {}) => roleThat(Object.entries({ ...authoringFiles(), ...extra }).map(([path, text]) => step.write(path, text)), { proposal: { rationale: 'The Verifier authors phase 1\'s checks before any stage builds.', requested_change_kind: 'unclassifiable' } });
export const PHASE_ONE_AUTHORING = phaseOneAuthoring();
// `extra`: more files of phase 1's authoring (a variant's checks of its own criteria).
export const authoringByPhase = (fx, extra = {}) => fx.scripted.kindScript('check_authoring', [phaseOneAuthoring(extra), LATER_AUTHORING, LATER_AUTHORING, LATER_AUTHORING, LATER_AUTHORING]);

// ---- Pantry of four screens (M515) ---------------------------------------------------------

const crit = (key, text) => [{ id: `${key}.1`, text }];
export const FOUR_REQUIREMENTS = Object.freeze([
  REQUIREMENTS[0],
  REQUIREMENTS[1],
  REQUIREMENTS[2],
  { key: 'R4', title: 'Adding an item in the browser', phase: 1, surface: 'ui (web)', statement: 'A user adds an item to the pantry in a web browser.', criteria: crit('R4', 'Given the web module, when web/index.html is read, then it holds a form whose inputs are named name and quantity.') },
  { key: 'R5', title: 'Adding an item on Android', phase: 1, surface: 'ui (android)', statement: 'A user adds an item to the pantry in the Android app.', criteria: crit('R5', 'Given the mobile module, when mobile/App.js is read, then it names TextInput.') },
  { key: 'R6', title: 'The service\'s health', phase: 1, statement: 'The service answers whether it is up.', criteria: crit('R6', 'Given the service is running, when a client requests GET /health, then it answers 200 with the JSON body {"ok": true}.') },
]);
export const FOUR_STAGES = Object.freeze([
  { ...STAGES[0], implements: ['R1', 'R6'], validation: { ...STAGES[0].validation, criteria: ['R1.1', 'R1.2', 'R6.1'] } },
  { ...STAGES[1], implements: ['R2', 'R4'], validation: { ...STAGES[1].validation, criteria: ['R2.1', 'R4.1'] } },
  { ...STAGES[2], implements: ['R3', 'R5'], validation: { ...STAGES[2].validation, criteria: ['R3.1', 'R5.1'] } },
]);
export const FOUR_ROADMAP = Object.freeze({ ...ROADMAP_JSON, phases: [{ ...ROADMAP_JSON.phases[0], requirement_ids: FOUR_REQUIREMENTS.map((r) => r.key) }] });
// R4.1, R5.1 and R6.1's checks (the kernel lane records their exits; their programs are the reference's).
const coverOf = (key, criterion, test) => ({ [`.surety/checks/defs/${key}.json`]: definitionText(key, { inputs: ['.surety/checks/wrapper.mjs', `.surety/checks/tests/${test}`], kind: 'acceptance', command: ['node', '.surety/checks/wrapper.mjs', `.surety/checks/tests/${test}`], timeout_s: 120, gate_kinds: ['stage', 'alpha_authorize'], covers: { criteria: [criterion] } }) });
const FOUR_CHECKS = Object.freeze({ ...coverOf('accept-r4', 'R4.1', 'web.test.mjs'), ...coverOf('accept-r5', 'R5.1', 'mobile.test.mjs'), ...coverOf('accept-r6', 'R6.1', 'api.test.mjs') });
export const FOUR = Object.freeze({ spec: specText({ requirements: FOUR_REQUIREMENTS }), files: { roadmap: FOUR_ROADMAP, stages: FOUR_STAGES }, base: FOUR_REQUIREMENTS, phaseOf: () => 1, checks: FOUR_CHECKS });
// Which interface and requirement each screen of the four-screen design draws.
export const FOUR_SCREENS = Object.freeze({
  S1: { target: 'web', requirement: 'R2', interface: 'list-items', step: 'F1.1' },
  S2: { target: 'android', requirement: 'R3', interface: 'list-items', step: 'F1.1' },
  S3: { target: 'web', requirement: 'R4', interface: 'add-item', step: 'F1.2' },
  S4: { target: 'android', requirement: 'R5', interface: 'add-item', step: 'F1.2' },
});

const mockup = (key, target, simulated) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${key} Pantry (${target}${simulated ? ', simulated' : ''})</title><link rel="stylesheet" href="../../tokens.css"></head>
<body>
<main>
<h1>Pantry</h1>
<p data-state="empty">Nothing in the pantry yet.</p>
</main>
</body>
</html>
`;

// The four-screen design from designModel's (check41.mjs): S1 (web) and S2
// (android) draw the list (list-items, its states, android's permission
// state), S3 (web) and S4 (android) the add form (add-item, its states and
// inputs); S3 and S4 are reached by a push from S1 and S2. Returns the model.
export function fourScreenModel(inventory) {
  const base = designModel(inventory);
  const m = clone(base);
  const byTarget = Object.fromEntries(base.screens.screens.map((s) => [s.target, s]));
  const screens = [];
  const mockups = {};
  const entries = [];
  for (const [key, def] of Object.entries(FOUR_SCREENS)) {
    const from = byTarget[def.target];
    assert.ok(from, `the inventory has a ${def.target} target`);
    const path = `mockups/${def.target}/${key.toLowerCase()}.html`;
    const states = from.states.filter((s) => (s.obligation.interface ? s.obligation.interface === def.interface : def.interface === 'list-items')).map((s) => ({ ...s, mockup: path }));
    const conventions = clone(from.conventions);
    if (def.target === 'web') conventions.route = def.interface === 'list-items' ? '/' : '/add';
    if (def.target === 'android' && def.interface === 'add-item') conventions.back = 'back:S2';
    screens.push({
      ...clone(from),
      key,
      requirements: [def.requirement],
      interfaces: [def.interface],
      flow_steps: [def.step],
      states,
      inputs: def.interface === 'add-item' ? clone(from.inputs) : [],
      conventions,
    });
    const simulated = from.target !== 'web';
    const entry = clone(base.design.mockups.find((x) => x.screens.includes(from.key)));
    entries.push({ ...entry, path, screens: [key] });
    mockups[path] = mockup(key, def.target, simulated);
  }
  m.screens = { screens };
  m.mockups = mockups;
  m.design.mockups = entries;
  m.navigation = {
    targets: [
      { target: 'web', entries: ['S1'], edges: [{ from: 'S1', to: 'S3', trigger: 'add an item', kind: 'push' }] },
      { target: 'android', entries: ['S2'], edges: [{ from: 'S2', to: 'S4', trigger: 'add an item', kind: 'push' }] },
    ],
  };
  m.flows.flows[0].requirements = ['R2', 'R3', 'R4', 'R5'];
  m.criteria.human_tests = m.criteria.human_tests.map((h) => {
    const keys = Object.entries(FOUR_SCREENS).filter(([, d]) => d.target === h.target).map(([k]) => k);
    return { ...h, screens: keys, not_checkable_yet: keys.flatMap((screen) => h.not_checkable_yet.map((x) => ({ screen, convention: x.convention }))) };
  });
  m.keyOf = { web: 'S1', android: 'S2' };
  return m;
}

// ---- Pantry with no `ui` module (M513 (d)) ---------------------------------------------------

const R1_ONLY = { ...REQUIREMENTS[0] };
export const API_ONLY = Object.freeze({
  spec: specText({ requirements: [R1_ONLY], targets: null, crossPlatform: null, modules: [SPEC_MODULES[0]] }),
  files: {
    // The API module alone, its interfaces consumed by no module of this map.
    modules: { ...MODULES_JSON, modules: [{ ...MODULES_JSON.modules[0], interfaces: MODULES_JSON.modules[0].interfaces.map((i) => ({ ...i, consumed_by: [] })) }], mapping_from_spec: [MODULES_JSON.mapping_from_spec[0]] },
    roadmap: { ...ROADMAP_JSON, phases: [{ ...ROADMAP_JSON.phases[0], goal: 'the pantry API', modules: ['api'], requirement_ids: ['R1'] }] },
    stages: [STAGES[0]],
  },
});

// ---- a Pantry designed and approved through the owner's routes -------------------------------

// Pantry of `variant` ({spec, files, base, phaseOf}) published under
// `policy`; its roles scripted (each later phase's authoring a tightening);
// a Designer session drawing `model(inventory)` (designModel's by default),
// saved (its check passing) and closed; the batch raised and, unless
// `approve` is false, approved through the owner's routes. The UI stages
// are dispatched only as the case pumps. Returns {p, ctx, inventory, model,
// v2, batch, approved}.
// With `findings`, the same Designer session's first turn reports them (D7
// §4.5; B.12) before the design's turn, and their owner questions are left
// open (M512 (k), F29: a requirement_conflict open from the design to Alpha).
export async function designedPantry(fx, { policy = BEFORE_BUILD, name, variant = null, model: draw = designModel, approve = true, answerKinds = KERNEL_KINDS, findings = null } = {}) {
  const { p } = await toPublished(fx, { policy, name, ...(variant ? { spec: variant.spec, files: variant.files } : {}) });
  const inventory = inventoryOf(p);
  const model = draw(inventory);
  const v2 = batchSpec({ base: variant?.base ?? REQUIREMENTS, criteria: model.criteria, phaseOf: variant?.phaseOf ?? (() => 1) });
  const ctx = scriptVariant(fx, p, v2);
  authoringByPhase(fx, variant?.checks ?? {});
  ctx.answerKinds = [...answerKinds];
  let run = null;
  if (findings) {
    run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [{ steps: [step.result(turnResult({ reply: 'What the inventory lacks, first.', findings }))] }]);
    await sayAndSettle(fx, p.id, run.id, 'Is anything missing from the inventory?');
  }
  const out = await checkSession(fx, p.id, [{ name: 'the design', model }], run ? { run } : {});
  assertPassed(out.saves[0].res, 'the design');
  const closed = await postCloseRaw(fx, p.id, out.run.id, {});
  assert.equal(closed.status, 200, `the Designer's close (${closed.text?.slice(0, 600)})`);
  const batch = await untilBatch(fx, ctx);
  const approved = approve ? await approveBatch(fx, ctx, batch) : null;
  return { p, ctx, inventory, model, v2, batch, approved, session: out.run };
}

// designModel's design with one design criterion on R2 (`tokens_only`, web,
// D7 §7.2): its batch's spec change adds R2.2, whose check the correction
// must author, so the approved design is not ready until that correction is
// applied (D7 §7.5).
export const R2_TOKENS_CRITERION = Object.freeze({ requirement: 'R2', text: 'Given the web module, when web/app.css is read, then every colour, size, spacing, radius and duration in it is a custom property defined in web/tokens.css.', kind: 'tokens_only', targets: ['web'], paths: ['web/app.css', 'web/tokens.css'] });
export function designWithCriterion(inventory) {
  const m = designModel(inventory);
  m.criteria.criteria = [clone(R2_TOKENS_CRITERION)];
  return m;
}

// A later design: a Designer session writing `model` whole, saved and closed. Returns {run, save, close}.
export async function laterDesign(fx, project, model, { say = 'Revise the design.' } = {}) {
  const out = await checkSession(fx, project, [{ name: say, model }]);
  const close = await postCloseRaw(fx, project, out.run.id, {});
  return { run: out.run, save: out.saves[0].res, close };
}

// The model's human tests' texts revised (a later design's batch then carries a change, as M526 does).
export function revisedHumanTests(model, version = 2) {
  const m = clone(model);
  m.design.version = version;
  m.criteria.human_tests = m.criteria.human_tests.map((h) => ({ ...h, text: `${h.text.replace(/version \d+/, `version ${version}`)} Revised.` }));
  return m;
}

// ---- the owner's acts through his routes ------------------------------------------------------

// The owner's change: the Spec Writer scripted to write `text` with
// `changes`; the request posted; its spec_change approved (or answered
// `answer`); returns {request, decision, version (the new spec version row, or null)}.
export async function ownerChange(fx, ctx, { text, changes, say = 'The owner\'s change.', answer = 'approve', max = 60 }) {
  fx.scripted.kindScript('spec_change', specWriter(text, changes));
  const before = specRevisions(fx.home, ctx.project).length;
  const request = await postChange(fx, ctx, say);
  const row = await pump(fx, ctx, () => decisionsOfKind(fx.home, ctx.project, 'spec_change').find((d) => d.status === 'open' && d.subject_id === request.id), { what: `the spec_change about ${request.id}`, max });
  const answered = await consume(fx, ctx.project, row, answer);
  const version = answer === 'approve' ? await pump(fx, ctx, () => (specRevisions(fx.home, ctx.project).length > before ? specRevisions(fx.home, ctx.project).at(-1) : undefined), { what: 'the new specification version', max: 20 }) : null;
  return { request, decision: answered, version };
}

// A later Architect session writing `files` ({path: text}), saved and
// closed; every decision its close raised answered approve (D6 §3.4).
// Returns {run, saved, closed}.
export async function laterArchitect(fx, project, files, { say = 'Revise the architecture.' } = {}) {
  const run = await openSession(fx, project, 'architect');
  scriptTurns(fx, run.id, [turnThatWrites(files, { reply: 'The architecture is revised.', done: true })]);
  await sayAndSettle(fx, project, run.id, say);
  const saved = await saveSession(fx, project, run.id);
  const closed = await closeSession(fx, project, run.id);
  for (const d of closed.decisions ?? []) await consume(fx, project, decision(fx.home, d.id), 'approve');
  return { run, saved, closed };
}
export const architectureMd = (note) => `${ARCHITECTURE_MD}\n${note}\n`;
export const modulesJson = (edit) => {
  const m = clone(MODULES_JSON);
  edit(m);
  return json(m);
};

// The owner-invoked review (D7 §10.5; SEAM.md §502): POST …/design/reviews
// {target, build_ref}; one turn writing `files` (the review file and, for
// deltas, a revised design); saved and closed. Returns {run, opened, close}.
export async function ownerReview(fx, project, { target = 'android', build_ref = 'pantry-android 0.1.0 (build 7)', files, say = 'This is what I saw on my phone.' }) {
  const opened = await fx.engine.post(`/v1/projects/${project}/design/reviews`, { target, build_ref });
  assert.equal(opened.status, 201, `POST …/design/reviews opens the review (SEAM.md §502) (→ ${opened.status} ${opened.text?.slice(0, 400)})`);
  const run = opened.body?.run;
  scriptTurns(fx, run.id, [{ steps: [...Object.entries(files).map(([path, content]) => (Buffer.isBuffer(content) ? step.writeBytes(path, content) : step.write(path, content))), step.result(turnResult({ reply: 'The review is written.', artifact_changed: true, done: true }))] }]);
  await sayAndSettle(fx, project, run.id, say);
  await saveSession(fx, project, run.id);
  const close = await postCloseRaw(fx, project, run.id, {});
  return { run, opened, close };
}
// A review file (B.14) of an owner build; `screens` its verdicts.
export const reviewFileOf = ({ target = 'android', build_ref = 'pantry-android 0.1.0 (build 7)', screens, design_version = 1, revised_design = false, first_design = false }) =>
  json({ design_version, subject: { kind: 'owner_build', target, build_ref }, screens, revised_design, first_design });

// The batch a review's close raised (D7 §10.3, §10.6): `design_verdicts`
// confirmed (when the close raised it), then `design_approval` approved once
// its `approve` carries no blocker, then the batched `spec_change` approved,
// each through the owner's route; the new specification version awaited.
// Returns {verdicts, approval, change, version}.
export async function approveReviewBatch(fx, ctx, { verdicts: expectVerdicts = true, max = 40 } = {}) {
  const before = specRevisions(fx.home, ctx.project).length;
  let verdicts = null;
  if (expectVerdicts === true) {
    verdicts = await pump(fx, ctx, () => decisionsOfKind(fx.home, ctx.project, 'design_verdicts').find((d) => d.status === 'open'), { what: 'design_verdicts raised at the review\'s close', max });
    const res = await fx.engine.post(`/v1/projects/${ctx.project}/decisions/${verdicts.id}/answer`, { option: 'confirm', preview_hash: verdicts.preview_hash });
    assert.equal(res.status, 200, `design_verdicts confirmed (${res.text})`);
  }
  const unblocked = (d) => d.status === 'open' && ((d.options ?? []).find((o) => o.key === 'approve')?.blockers ?? []).length === 0;
  // `verdicts: 'any'`: a design_verdicts the close may or may not raise, confirmed if it is open.
  const approval = await pump(fx, ctx, async () => {
    if (expectVerdicts === 'any') {
      const v = decisionsOfKind(fx.home, ctx.project, 'design_verdicts').find((d) => d.status === 'open');
      if (v) {
        const res = await fx.engine.post(`/v1/projects/${ctx.project}/decisions/${v.id}/answer`, { option: 'confirm', preview_hash: v.preview_hash });
        assert.equal(res.status, 200, `design_verdicts confirmed (${res.text})`);
        verdicts = v;
      }
    }
    return decisionsOfKind(fx.home, ctx.project, 'design_approval').find(unblocked);
  }, { what: 'design_approval open with approve unblocked', max });
  const a = await fx.engine.post(`/v1/projects/${ctx.project}/decisions/${approval.id}/answer`, { option: 'approve', preview_hash: approval.preview_hash });
  assert.equal(a.status, 200, `design_approval approved (${a.text})`);
  const change = await pump(fx, ctx, () => decisionsOfKind(fx.home, ctx.project, 'spec_change').find((d) => d.status === 'open' && (!approval.batch_key || d.batch_key === approval.batch_key)), { what: 'the batched spec_change', max });
  await consume(fx, ctx.project, change, 'approve');
  const version = await pump(fx, ctx, () => (specRevisions(fx.home, ctx.project).length > before ? specRevisions(fx.home, ctx.project).at(-1) : undefined), { what: 'the review\'s specification version', max });
  return { verdicts, approval, change, version };
}

// The engine's clock now (the controlled clock moved by one second).
export async function engineNow(fx) {
  const res = await advanceClock(fx.engine, 1);
  assert.ok(res.body?.now, `the controlled clock answers its time (${res.text})`);
  return res.body.now;
}

// ---- reads ------------------------------------------------------------------------------------

export const designScreens = (home, revision) => rows(home, 'SELECT * FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"', revision).map((s) => ({ ...s, requirements: parse(s.requirements), interfaces: parse(s.interfaces) }));
export const screenStatus = (home, revision) => Object.fromEntries(designScreens(home, revision).map((s) => [s.key, s.status]));
export const staleKeys = (home, revision) => designScreens(home, revision).filter((s) => s.status === 'stale').map((s) => s.key).sort();
export const stageScreens = (home, project) =>
  rows(home, 'SELECT b.*, s."number" AS "stage_number", s."phase_plan" AS "phase_plan" FROM "stage_screens" b JOIN "stages" s ON s."id" = b."stage" WHERE s."project" = ? ORDER BY b.rowid', project);
export const designDues = (home, project) => decisionsOfKind(home, project, 'design_due');
export const openDues = (home, project) => designDues(home, project).filter((d) => d.status === 'open');
export const staleEvents = (home, project) => eventsOfType(home, 'design.stale').filter((e) => e.subject?.project === project);
export const escalations = (home, id) => eventsOfType(home, 'decision.escalated').filter((e) => e.subject?.decision === id);
export const waivedEvents = (home, project) => eventsOfType(home, 'design.waived').filter((e) => e.subject?.project === project);
export const latestRequest = (home, project) => one(home, 'SELECT * FROM "spec_change_requests" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1', project);
// The impact's design class (D7 §9; G8; SEAM.md §515): {screens: [{screen, target}], requirements}.
export function designClassOf(home, request) {
  const impact = impactOf(home, request);
  assert.ok(impact.design && typeof impact.design === 'object', `the impact carries its design class (SEAM.md §515) (${Object.keys(impact).join(', ')})`);
  return impact.design;
}
export const screenPairs = (cls) => (cls.screens ?? []).map((s) => `${s.screen}/${s.target}`).sort();
// The current approved design revision (by insertion).
export const currentRevision = (home, project) => rows(home, 'SELECT * FROM "design_revisions" WHERE "project" = ? AND "status" IN (\'approved\', \'approved_without_criteria\') ORDER BY rowid DESC LIMIT 1', project)[0] ?? null;
export const revisionsOf = (home, project) => rows(home, 'SELECT * FROM "design_revisions" WHERE "project" = ? ORDER BY rowid', project);
export const policyEffective = (home, project) => parse(rows(home, 'SELECT "effective" FROM "policy_revisions" WHERE "project" = ? ORDER BY "revision" DESC LIMIT 1', project)[0]?.effective);
export const stageIdsOf = (home, project, numbers, phase = 1) => {
  const plan = one(home, 'SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "phase_number" = ? ORDER BY rowid DESC LIMIT 1', project, phase);
  return numbers.map((n) => one(home, 'SELECT "id" FROM "stages" WHERE "phase_plan" = ? AND "number" = ?', plan?.id ?? '', n)?.id ?? null);
};

export { designScripts, openDesigner, scriptBuilders, filesOf };
