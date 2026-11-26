// One approval of an ordinary maintenance brief (DECISIONS item 57, Sean's
// rulings D1–D8 and WO1 Q1 of 2026-11-26; the owner's M7 plan §3j, rows
// M635, M638, M640, M644, M645; slice 50, kernel lane). The prototype
// harness's journeys (harness/prototype.mjs) and the item-57 replay's
// specification version 2 (harness/gap57.mjs specV2), restated for the
// rulings' rows: iteration 1 at its Alpha, iteration 2's brief approved, and
// the plans the scripted Architect writes for phase 2.
//
// Nothing here asserts a row's clause; it asserts only that the step it
// takes happened (a step that did not happen is a named failure). The
// readers below search a served or recorded value for a named fact without
// presuming a nesting the row does not give (the rows name the top-level
// fields; where they name a fact but not its field, the fact is looked for).

import assert from 'node:assert/strict';

import { adrText } from './journey/reference.mjs';
import { specV2 } from './gap57.mjs';
import {
  MODULES,
  ROADMAP,
  answerOpen,
  briefToAlpha,
  iterationRead,
  json,
  kindNext,
  modelBrief,
  ok,
  prepScript,
  protoEngine,
  pump,
  result,
  statusIs,
  toBrief,
  usage,
  write,
} from './prototype.mjs';
import { withStore } from './store.mjs';

export const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));
export const one = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).get(...p));
export const J = (t) => (typeof t === 'string' ? JSON.parse(t) : (t ?? null));
export const show = (v) => JSON.stringify(v)?.slice(0, 2500);

// ---- looking for a fact in a value -----------------------------------------------------------

// Every [path, key, value] of a value, depth first (arrays by index).
export function entries(v, path = '') {
  const out = [];
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      out.push([p, k, x]);
      out.push(...entries(x, p));
    }
  }
  return out;
}
// The values of the keys matching `re` anywhere in `v`.
export const valuesOfKey = (v, re) => entries(v).filter(([, k]) => re.test(k)).map(([, , x]) => x);
// Whether `v` holds `needle` as a value (a scalar equal to it, or a string containing it).
export const holds = (v, needle) =>
  entries({ v }).some(([, , x]) => x === needle || (typeof x === 'string' && typeof needle === 'string' && needle !== '' && x.includes(needle)));

// ---- restarts --------------------------------------------------------------------------------

export async function restart(fx) {
  await fx.engine.stop();
  await fx.start();
}

// ---- iteration 2: spec version 2 (R1.2, R3.2 added; R1, R3 moved to phase 2) -----------------

export const ITERATION2_CHANGE = 'Show long titles whole and keep done tasks done after a reload.';
export const OBJECTIVES2 = Object.freeze(['R1: a user adds a task; long titles are shown whole', 'R2: a user lists the tasks', 'R3: a user finishes a task; done stays done after reload']);
export const prep2 = () => prepScript({ spec: specV2(), brief: modelBrief({ objectives: [...OBJECTIVES2] }) });

// Iteration 2's phase 2 (the plan the scripted Architect writes): phase 2
// added to the roadmap (R1 and R3 moved there, R2 left in phase 1), its
// stages implementing only R1 and R3 (the brief's), and, as asked:
// `modules` a changed module map, `adr` one ADR added, `stages` 2 or 3,
// `conformance` what the plan declares (the package's generic text invites
// `uncertain`), `hold` a hold before the products are written.
export const MODULES_CHANGED = Object.freeze({
  ...MODULES,
  modules: [{ ...MODULES.modules[0], interfaces: [...MODULES.modules[0].interfaces, { name: 'task-titles', kind: 'http', path: '/tasks/titles', description: 'the whole titles of the tasks' }] }],
});
export const MODULES_CAMERA = Object.freeze({
  ...MODULES_CHANGED,
  modules: [{ ...MODULES_CHANGED.modules[0], surface: 'ui', targets: [{ target: 'macos', ui_technology: 'swiftui' }], platform_permissions: [{ target: 'macos', permission: 'camera', why: 'to scan a task list' }] }],
});
export const ADR_KEY2 = 'ADR-001';
const stage2 = (number, goal, implements_, depends, criteria) => ({ number, goal, tasks: [goal], modules: ['app'], implements: implements_, adrs: [], depends_on: depends, validation: { criteria, kinds: ['acceptance', 'smoke'], sensitive_areas: [] }, integration_obligations: [] });
export const PHASE2_STAGES = Object.freeze([stage2(1, 'long titles shown whole', ['R1'], [], ['R1.1', 'R1.2']), stage2(2, 'done kept after reload', ['R3'], [1], ['R3.1', 'R3.2'])]);
export const PHASE2_THREE = Object.freeze([...PHASE2_STAGES, stage2(3, 'both together', ['R1', 'R3'], [1, 2], ['R1.1', 'R1.2', 'R3.1', 'R3.2'])]);

export function phase2Plan({ modules = null, adr = false, stages = PHASE2_STAGES, conformance = 'uncertain', hold = null } = {}) {
  const architecture = modules !== null || adr;
  const av = architecture ? 2 : 1;
  const roadmap = {
    version: 2,
    architecture_version: av,
    phases: [
      { ...ROADMAP.phases[0], requirement_ids: ['R2'] },
      { number: 2, goal: 'long titles and done state kept', modules: ['app'], requirement_ids: ['R1', 'R3'], depends_on: [1] },
    ],
  };
  return {
    on_term: 'exit',
    steps: [
      usage(1800, 0, 700),
      ...(hold ? [{ hold, heartbeat_ms: 250 }] : []),
      ...(modules ? [write('.surety/architecture/modules.json', json(modules))] : []),
      ...(adr ? [write(`.surety/adrs/${ADR_KEY2}.md`, adrText({ key: ADR_KEY2 }))] : []),
      write('.surety/roadmap/roadmap.json', json(roadmap)),
      write('.surety/roadmap/roadmap.md', '# Roadmap\n\n1. The task list (R2).\n2. Long titles and done kept (R1, R3).\n'),
      { write: { path: '.surety/phases/phase-2.json', content: json({ phase: 2, prepared_against: { spec_version: 2, architecture_version: av, roadmap_version: 2, revision: '__HEAD__' }, stages, conformance }), substitute_head: true } },
      write('.surety/phases/phase-2.md', `# Phase 2\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`),
      result({ summary: "iteration 2's plan: phase 2", plan: 'phase-2', conformance }),
    ],
  };
}

// ---- the journey to iteration 2's approved brief ---------------------------------------------

// Iteration 1 at its Alpha (environment alpha on `port`); Iterate with the
// change; iteration 2's preparation approved and its brief (spec version 2)
// prepared. `afterAlpha(fx, p, it)` runs before Iterate. `plan` is the
// script of iteration 2's replan; `before(fx, p)` runs
// before the brief is approved (the project may be paused there). With
// `approve`, the brief is approved. Returns the fixture's ids.
export async function toIteration2(t, { name, port, plan, approve = true, before, afterAlpha, config = { lease_ttl: 600 } }) {
  const fx = await protoEngine(t, { config });
  const { id: p, it } = await toBrief(fx, { name });
  const env = await briefToAlpha(fx, p, it.id, { port });
  if (afterAlpha) await afterAlpha(fx, p, it.id);
  const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it.id}/iterate`, { change: ITERATION2_CHANGE }), 201, 'iterate');
  const two = made.iteration.id;
  kindNext(fx, 'brief_preparation', [prep2()], prepScript());
  await answerOpen(fx, p, 'prototype_preparation_approval');
  await pump(fx, p, statusIs(fx, p, two, 'awaiting_brief_approval'), { what: "iteration 2's brief" });
  if (plan) kindNext(fx, 'replan', [plan, plan, plan], plan);
  if (before) await before(fx, p);
  let briefDecision = null;
  if (approve) briefDecision = await answerOpen(fx, p, 'spec_approval');
  return { fx, p, it, one: it.id, two, env, briefDecision };
}

export const iterationRowOf = (home, id) => one(home, 'SELECT * FROM "prototype_iterations" WHERE "id" = ?', id);
export const decisionsOfKinds = (home, p, kinds) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" IN (${kinds.map(() => '?').join(',')}) ORDER BY "seq"`, p, ...kinds);

// Iteration 2's plan, once routed: published (the iteration names its phase
// plan) or put to the owner (awaiting_owner, the next step naming the plan's
// approval). Returns {routed: 'published'|'owner', read}.
export async function planRouted(fx, p, two, { max = 40 } = {}) {
  return pump(
    fx,
    p,
    async () => {
      const r = await iterationRead(fx, p, two);
      if (iterationRowOf(fx.home, two)?.phase_plan) return { routed: 'published', read: r };
      if (r.iteration.status === 'awaiting_owner' && (r.outcome.next_step ?? '').startsWith('approve the plan')) return { routed: 'owner', read: r };
      return undefined;
    },
    { max, what: "iteration 2's plan routed (published, or put to the owner)" },
  );
}

export const assertOneOf = (actual, allowed, what) => assert.ok(allowed.some((a) => a === actual), `${what}: ${show(actual)} is one of ${show(allowed)}`);
