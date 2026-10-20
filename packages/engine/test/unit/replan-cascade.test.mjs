// Developer tests for E172 item 7 S2 (Sean's ruling of 2026-10-20,
// "cascade"; the driver's ruling on a vanished dependency, E174; SEAM.md
// §556): a kept stage built on a stage the early replacement supersedes is
// superseded with it, transitively, and rebuilt; the plan check counts an
// omitted rebuilt stage's dependencies and lets the replacement list it
// with new inputs; the replan package names the rebuilt stages apart.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { classifyStages, keptOf, rebuiltInput } = await import(join(dist, 'plan', 'replace.js'));
const { checkPlan, executionInputsDigest, REBUILT_STAGE_RULE } = await import(join(dist, 'plan', 'check.js'));
const { replanPromptText } = await import(join(dist, 'plan', 'replan-package.js'));

const AT = '2026-10-20T00:00:00.000Z';

// One plan of stages [number, status, depends_on numbers, work status],
// each with its own work item; returns the db and the ids by number.
function store(t, stages) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`, AT);
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status) VALUES ('plan_1', ?, 'prj_1', 1, 'h', 'p', 1, 1, 'published')`, AT);
  const ids = Object.fromEntries(stages.map(([n]) => [n, `stage_${n}`]));
  for (const [n, status, deps, work] of stages) {
    run(
      `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, adrs, tasks, depends_on, validation, integration_obligations, generation, execution_inputs_digest, conformance, work_item)
       VALUES (?, ?, 'prj_1', 'plan_1', ?, ?, '["lib"]', '["R1"]', '["R1"]', ?, '[]', ?, ?, ?, '[]', 1, ?, 0, ?)`,
      ids[n],
      AT,
      n,
      `goal ${n}`,
      status,
      JSON.stringify([`task ${n}`]),
      JSON.stringify(deps.map((d) => ids[d])),
      JSON.stringify({ criteria: ['R1.1'], kinds: ['acceptance'], sensitive_areas: [] }),
      `digest ${n}`,
      `work_${n}`,
    );
    run(
      `INSERT INTO work_items (id, created_at, project, kind, trigger_source, trigger_id, trigger_generation, subject, status, seq, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
       VALUES (?, ?, 'prj_1', 'stage_build', 'plan', ?, 1, ?, ?, ?, 0, 0, 0, 0)`,
      `work_${n}`,
      AT,
      ids[n],
      JSON.stringify({ stage: ids[n] }),
      work,
      n,
    );
  }
  return { db, ids };
}

test('the cascade: a kept stage built on the trigger\'s own subject is superseded with it, transitively; one built on a kept stage stays kept', (t) => {
  // 1 the subject (integrated, parked); 2 on 1, 3 on 2; 4 on nothing; 5 on 4.
  const { db, ids } = store(t, [
    [1, 'integrated', [], 'parked'],
    [2, 'integrated', [1], 'complete'],
    [3, 'verified', [2], 'complete'],
    [4, 'integrated', [], 'complete'],
    [5, 'integrated', [4], 'complete'],
  ]);
  const classes = classifyStages(db, 'plan_1', new Map(), 'work_1');
  assert.deepEqual(
    Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, classes.get(ids[n])])),
    { 1: 'superseded', 2: 'superseded', 3: 'superseded', 4: 'kept', 5: 'kept' },
  );
  const kept = keptOf(db, 'plan_1', 'work_1');
  assert.deepEqual(
    kept.map((k) => [k.number, k.rebuilt ?? false, k.depends_on ?? null]),
    [
      [2, true, [1]],
      [3, true, [2]],
      [4, false, null],
      [5, false, null],
    ],
  );
  // With no subject nothing is superseded: every built stage is kept.
  assert.ok(keptOf(db, 'plan_1', null).every((k) => k.rebuilt === undefined));
});

test('a rebuilt stage is registered from its own inputs as built, its dependencies by number', (t) => {
  const { db, ids } = store(t, [
    [1, 'integrated', [], 'parked'],
    [2, 'integrated', [1], 'complete'],
  ]);
  const input = rebuiltInput(db, ids[2]);
  assert.deepEqual(input, {
    number: 2,
    goal: 'goal 2',
    implements: ['R1'],
    modules: ['lib'],
    tasks: ['task 2'],
    depends_on: [1],
    validation: { criteria: ['R1.1'], kinds: ['acceptance'], sensitive_areas: [] },
    integration_obligations: [],
    adrs: [],
    conformance: false,
    execution_inputs_digest: 'digest 2',
  });
});

// A replacement's check: phase 1 implements R1 and R2; `kept` as keptOf
// gives it; the file lists `stages`.
function check(kept, stages) {
  const baseline = {
    spec_version: 1,
    requirements: [
      { key: 'R1', criteria: ['R1.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
      { key: 'R2', criteria: ['R2.1'], sensitive_areas: [], withdrawn: false, blocked_by_questions: [] },
    ],
    questions: [],
    architecture_version: 1,
    roadmap_version: 1,
    head: 'h',
    project_tier: 'T1',
    completed_phases: [],
    approved: null,
    kept,
  };
  const modules = { version: 1, modules: [{ name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] };
  const roadmap = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'one', modules: ['lib'], requirement_ids: ['R1', 'R2'], depends_on: [] }] };
  const plan = { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'h' }, stages, conformance: 'within_baseline' };
  return checkPlan(baseline, { modules, roadmap, adrs: {}, adr_front_matter: {}, architecture_text: null, plan });
}
const stage = (number, implements_, depends_on = [], tasks = ['t']) => ({
  number,
  goal: `g${number}`,
  tasks,
  modules: ['lib'],
  implements: [implements_],
  adrs: [],
  depends_on,
  validation: { criteria: [`${implements_}.1`], kinds: ['acceptance', 'smoke'], sensitive_areas: [] },
  integration_obligations: [],
});
const subjects = (r, code) => r.reasons.find((x) => x.code === code)?.subjects ?? [];

test('the check: an omitted rebuilt stage passes while its dependency number stays; vanished, PLAN_UNKNOWN_STAGE names it; listed with new inputs it is no duplicate', () => {
  const s2 = stage(2, 'R2', [1]);
  const rebuilt2 = { number: 2, digest: executionInputsDigest(s2), implements: ['R2'], validated: ['R2.1'], rebuilt: true, depends_on: [1] };
  // Stage 1 replaced under its number; stage 2 omitted: rebuilt as built.
  const kept = check([rebuilt2], [stage(1, 'R1', [], ['changed'])]);
  assert.equal(kept.outcome, 'passed', JSON.stringify(kept.reasons));
  // Stage 1 dropped for a stage 3: stage 2's dependency vanished.
  const gone = check([rebuilt2], [stage(3, 'R1')]);
  assert.equal(gone.outcome, 'refused');
  assert.deepEqual(subjects(gone, 'PLAN_UNKNOWN_STAGE'), ['stage 2 -> 1']);
  // Listing stage 2 with new inputs resolves it, and is no duplicate.
  const listed = check([rebuilt2], [stage(3, 'R1'), stage(2, 'R2', [3], ['new'])]);
  assert.equal(listed.outcome, 'passed', JSON.stringify(listed.reasons));
  // A kept stage (not rebuilt) listed with other inputs is still one.
  const dup = check([{ ...rebuilt2, rebuilt: undefined, depends_on: undefined }], [stage(1, 'R1'), stage(2, 'R2', [1], ['new'])]);
  assert.deepEqual(subjects(dup, 'PLAN_DUPLICATE_STAGE'), ['stage 2: kept (integrated) with other inputs']);
  // An omitted rebuilt stage closing a cycle with a listed one is a cycle.
  const loop = check([rebuilt2], [stage(1, 'R1', [2])]);
  assert.ok(subjects(loop, 'PLAN_CYCLE').length > 0, JSON.stringify(loop.reasons));
});

test("the replan package names the rebuilt stages apart and states the rule", () => {
  const facts = {
    repo: '/r',
    trigger: { source: 'blocker_replan', id: 'work_1', generation: 1 },
    trigger_subject: { replaces: { phase_plan: 'pp_1', generation: 1 }, evidence: null, stale: null, rejected: null },
    generation: { spec_revision: null, architecture_revision: null, roadmap_revision: null, plan: { id: 'pp_1', phase_number: 1, generation: 1 }, spec_evidence_generation: 1 },
    spec_text: null,
    index: [],
    roadmap: null,
    module_map: {},
    completed_plan: null,
    open_plan: null,
    phase_evaluation: null,
    findings: [],
    deferrals: { findings: [], obligations: [] },
    objections: [],
    refusal: null,
    kept: [],
    rebuilt: [{ number: 2, implements: ['R2'], depends_on: [1] }],
  };
  const text = replanPromptText(facts).join('\n');
  assert.ok(text.includes('Rebuilt stages: stage 2 (implements R2; depends on stage 1).'), text);
  assert.ok(text.includes(REBUILT_STAGE_RULE));
  assert.ok(!text.includes('Kept stages:'));
  assert.ok(!replanPromptText({ ...facts, rebuilt: undefined }).join('\n').includes('Rebuilt stages:'));
});
