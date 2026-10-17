// Developer tests for the slice-46 review's fixes: the design criteria's
// map to their specification ids (B1: by text, under "new", in order when
// reworded, duplicates in order, a miss kept with why, the resolved
// targets; the readers read the map, a miss stated unmatched); and the pace
// read's design figures (S1: the human wait counted only while the decision
// held the stage, cut to its lifetime; S2: a session's tokens unknown when a
// turn's usage was not recorded whole).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { criterionMap, mappedCriteria } = await import(join(dist, 'design', 'criterion-map.js'));
const { designPace } = await import(join(dist, 'design', 'pace.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));

const P = 'prj_1';
const req = (key, criteria, extra = {}) => ({ key, title: key, statement: 's', criteria: criteria.map(([id, text]) => ({ id, text })), sensitive_areas: [], human_test: false, descriptive: false, phase_hint: 1, origin: 'intended', blocked_by_questions: [], ...extra });

test('B1: each design criterion is mapped to the id its change added, by text (whitespace aside), duplicates in order, a reworded one in order, "new" under the added requirements', () => {
  const rep = {
    targets: ['web', 'android'],
    requirements: [
      req('R2', [['R2.1', 'Old.'], ['R2.2', 'Tokens  only.'], ['R2.3', 'Same text.'], ['R2.4', 'Same text.']]),
      req('R3', [['R3.1', 'Old three.'], ['R3.2', 'The Android logo is   the effective one, reworded.']]),
      req('R5', [['R5.1', 'The favicon is the effective favicon.']], { surface: 'ui', surface_targets: ['web'] }),
      req('R6', [], { human_test: true }),
    ],
  };
  const criteria = [
    { requirement: 'R2', text: 'Tokens only.', kind: 'tokens_only', targets: ['web'], paths: ['web/app.css'] },
    { requirement: 'R2', text: 'Same text.', kind: 'label_with_unit', targets: ['web'], paths: ['web/index.html'] },
    { requirement: 'R2', text: 'Same text.', kind: 'focus_visible', targets: [], paths: ['web/app.css'] },
    { requirement: 'R3', text: 'The Android logo is the effective one.', kind: 'asset_parity', targets: ['android'], paths: ['mobile/logo.svg'], slot: 'logo', variant: 'full' },
    { requirement: 'new', text: 'The favicon is the effective favicon.', kind: 'asset_parity', paths: ['web/favicon.svg'], slot: 'favicon', variant: 'default' },
    { requirement: 'R9', text: 'Nothing.', kind: 'contrast_aa', targets: ['web'], paths: ['web/app.css'] },
  ];
  const screens = [
    { key: 'S1', target: 'web', requirements: ['R2'] },
    { key: 'S2', target: 'android', requirements: ['R3'] },
  ];
  const m = criterionMap({ criteria, screens, rep, added_criteria: ['R2.2', 'R2.3', 'R2.4', 'R3.2', 'R5.1'], added_requirements: ['R5', 'R6'] });
  assert.deepEqual(m.map((e) => [e.index, e.id, e.how]), [
    [0, 'R2.2', 'text'],
    [1, 'R2.3', 'text'],
    [2, 'R2.4', 'text'],
    [3, 'R3.2', 'order'],
    [4, 'R5.1', 'text'],
    [5, null, null],
  ]);
  assert.equal(m[4].requirement_key, 'R5', 'a "new" criterion under the requirement the change added');
  assert.deepEqual(m[4].targets, ['web'], "its targets: the new requirement's surface targets");
  assert.deepEqual(m[2].targets, ['web'], 'no targets named: those of the screens of its requirement');
  assert.match(m[5].why, /no requirement R9/);
  // A human-test requirement the change added takes no "new" criterion.
  const h = criterionMap({ criteria: [{ requirement: 'new', text: 'x', kind: 'human' }], screens: [], rep, added_criteria: [], added_requirements: ['R6'] });
  assert.equal(h[0].id, null);
  // A later design keeping an earlier criterion: the specification's own.
  const kept = criterionMap({ criteria: [{ requirement: 'R2', text: 'Old.', kind: 'tokens_only', targets: ['web'], paths: ['a.css'] }], screens, rep, added_criteria: [], added_requirements: [] });
  assert.deepEqual([kept[0].id, kept[0].how], ['R2.1', 'existing']);
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES (?, ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', 'x')`).run(P, T(0));
  return db;
}
const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const revision = (db, id, status, content, map) =>
  db
    .prepare(`INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "revision", "blobs", "origin", "targets", "status", "content", "criterion_map") VALUES (?, ?, ?, 1, 'full', 'r', '{}', 'intended', '[]', ?, ?, ?)`)
    .run(id, T(0), P, status, JSON.stringify(content), map === null ? null : JSON.stringify(map));

test('B1: the readers read the map; a criterion with no id, or a design approved without criteria, is stated unmatched with why', (t) => {
  const db = scratch(t);
  const content = { criteria: { criteria: [{ requirement: 'R2', text: 'a', kind: 'tokens_only', paths: ['x.css'] }, { requirement: 'R9', text: 'b', kind: 'contrast_aa', paths: ['y.css'] }] } };
  revision(db, 'dsg_1', 'approved', content, [
    { index: 0, requirement: 'R2', kind: 'tokens_only', id: 'R2.4', requirement_key: 'R2', targets: ['web'], how: 'order' },
    { index: 1, requirement: 'R9', kind: 'contrast_aa', id: null, requirement_key: null, targets: ['web'], how: null, why: 'the specification has no requirement R9' },
  ]);
  const m = mappedCriteria(db, P);
  assert.deepEqual(m.mapped.map((e) => [e.id, e.targets]), [['R2.4', ['web']]]);
  assert.deepEqual(m.unmatched, [{ index: 1, requirement: 'R9', kind: 'contrast_aa', text: 'b', why: 'the specification has no requirement R9' }]);
  revision(db, 'dsg_2', 'approved_without_criteria', content, null);
  const w = mappedCriteria(db, P);
  assert.equal(w.mapped.length, 0);
  assert.equal(w.unmatched.length, 2);
  assert.match(w.unmatched[0].why, /without its criteria/);
});

function decision(db, id, kind, raised, { status = 'consumed', answeredAt = null, subject = id } = {}) {
  seq += 1;
  db.prepare(
    `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "semantic_generation", "scope", "question", "options", "dependency_manifest", "transition_schema_version", "preview_hash", "evidence", "blocked_while_open", "raised_at", "status", "answer")
     VALUES (?, ?, ?, ?, ?, 'design_revision', ?, 1, 'project', 'q', '[]', '{}', 1, 'h', '{}', 0, ?, ?, ?)`,
  ).run(id, T(raised), P, seq, kind, subject, T(raised), status, answeredAt === null ? null : JSON.stringify({ option: 'approve', at: T(answeredAt) }));
}
function event(db, type, subject, at) {
  seq += 1;
  db.prepare(`INSERT INTO "events" ("created_at", "seq", "at", "type", "subject", "actor_kind", "payload", "tx") VALUES (?, ?, ?, ?, ?, 'engine', '{}', ?)`).run(T(at), 10_000 + seq, T(at), type, JSON.stringify(subject), `tx_${seq}`);
}

test('S1: a UI stage\'s human wait counts each decision only while it held the stage, cut to its lifetime; the union counts an overlap once; a later asset-only approval is not counted', (t) => {
  const db = scratch(t);
  db.prepare(
    `INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "depends_on", "held_intervals", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold")
     VALUES ('wi_ui', ?, ?, 1, 'stage_build', '{"stage":"stg_2"}', 'complete', ?, ?, 'test', 't', 1, 0, 0, 0, 0)`,
  ).run(T(0), P, JSON.stringify([{ milestone: 'design_ready' }]), JSON.stringify([{ reason: 'design_pending', from: T(10), to: T(100) }]));
  event(db, 'work.complete', { project: P, work_item: 'wi_ui' }, 200);
  decision(db, 'dec_due', 'design_due', 0, { answeredAt: 50 });
  decision(db, 'dec_appr', 'design_approval', 40, { answeredAt: 120 });
  // The asset-only approval after the stage completed held nothing of it.
  decision(db, 'dec_asset', 'design_approval', 300, { answeredAt: 310 });
  // A design_due the engine closed itself (decision.invalidated): counted, never dropped.
  decision(db, 'dec_due2', 'design_due', 60, { status: 'invalidated' });
  event(db, 'decision.invalidated', { project: P, decision: 'dec_due2' }, 70);
  const s = designPace(db, P).ui_stages.find((x) => x.work_item === 'wi_ui');
  assert.deepEqual(s.human_wait, { design_due: 50, design_approval: 60, union: 90 });
  assert.equal(s.design_pending_seconds, 90);
});

test('S1: a decision still open while the stage is held is unknown; one open after the stage completed is not counted', (t) => {
  const db = scratch(t);
  db.prepare(
    `INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "depends_on", "held_intervals", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold")
     VALUES ('wi_ui', ?, ?, 1, 'stage_build', '{"stage":"stg_2"}', 'complete', ?, ?, 'test', 't', 1, 0, 0, 0, 0)`,
  ).run(T(0), P, JSON.stringify([{ milestone: 'design_ready' }]), JSON.stringify([{ reason: 'design_pending', from: T(0), to: T(100) }]));
  event(db, 'work.complete', { project: P, work_item: 'wi_ui' }, 150);
  decision(db, 'dec_due', 'design_due', 0, { answeredAt: 20 });
  decision(db, 'dec_late', 'design_approval', 400, { status: 'open' });
  let w = designPace(db, P).ui_stages[0].human_wait;
  assert.deepEqual(w, { design_due: 20, design_approval: 0, union: 20 });
  decision(db, 'dec_open', 'design_due', 30, { status: 'open' });
  w = designPace(db, P).ui_stages[0].human_wait;
  assert.ok(typeof w.design_due === 'object' && typeof w.design_due.unknown === 'string', `design_due unknown (${JSON.stringify(w)})`);
  assert.ok(typeof w.union === 'object' && typeof w.union.unknown === 'string');
});

test("S2: a Designer session's tokens are unknown when any of its turns' usage was not recorded whole, never the sum of the rows that were", (t) => {
  const db = scratch(t);
  db.prepare(
    `INSERT INTO "runs" ("id", "created_at", "project", "seq", "role", "kind", "state", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined", "started_at", "finished_at")
     VALUES ('run_d', ?, ?, 1, 'designer', 'session', 'ended', 'scripted', '1', 'opus', 'r', '2099-01-01T00:00:00.000Z', 0, ?, ?)`,
  ).run(T(0), P, T(0), T(60));
  const row = (id, complete, billable) =>
    db
      .prepare(
        `INSERT INTO "ledger_rows" ("id", "created_at", "project", "invocation", "run", "role", "provider", "model_requested", "raw_usage", "normalization_version", "billable_in", "cached_in", "out", "usage_complete", "cost_status", "day_utc")
         VALUES (?, ?, ?, ?, 'run_d', 'designer', 'scripted', 'opus', '{}', '1', ?, 10, 5, ?, 'unknown', '2026-10-17')`,
      )
      .run(id, T(1), P, `inv_${id}`, billable, complete);
  row('led_1', 1, 100);
  const whole = designPace(db, P).designer_sessions[0].tokens;
  assert.deepEqual(whole, { billable: 100, cached_in: 10, output: 5 });
  row('led_2', 0, 50);
  const part = designPace(db, P).designer_sessions[0].tokens;
  for (const k of ['billable', 'cached_in', 'output']) assert.ok(typeof part[k] === 'object' && /usage_complete/.test(part[k].unknown), `${k} unknown (${JSON.stringify(part)})`);
});
