// Developer tests for migration 0053 (DECISIONS item 57, the owner's rulings
// D1 to D8 and WO1 Q1 of 2026-11-26): the four rebuilt tables keep every row
// as it was, the widened enumerations take their new values and refuse any
// other, the added columns read NULL on rows recorded before (never a value
// inferred), and the two new tables hold their constraints.
//
// A scratch store: migrations 0001 to 0052 applied from a copy of the
// directory, rows written, then 0053 applied over them as an engine upgrade
// would.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { migrate } = await import(join(root, 'dist', 'store', 'migrate.js'));
const { exportContract } = await import(join(root, 'dist', 'contract', 'document.js'));

const AT = '2026-11-26T00:00:00.000Z';
const MIGRATION = '0053_one_approval_of_a_maintenance_brief.sql';

function upgraded(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-0053-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = join(dir, 'before');
  mkdirSync(before);
  for (const f of readdirSync(join(root, 'migrations'))) if (f !== MIGRATION) copyFileSync(join(root, 'migrations', f), join(before, f));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, before);
  // Rows recorded before the migration, one of each rebuilt table and of the
  // tables that gain a column.
  db.prepare(`INSERT INTO "projects" ("id", "created_at", "name", "tier", "dev_repo_path", "integration_branch", "baseline_state", "registration_state", "management") VALUES ('prj_1', ?, 'p', 'T1', '/r', 'main', 'idea', 'registered', 'none')`).run(AT);
  db.prepare(
    `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "semantic_generation", "scope", "question", "options", "dependency_manifest", "transition_schema_version", "preview_hash", "evidence", "blocked_while_open", "raised_at", "status")
     VALUES ('dec_1', ?, 'prj_1', 1, 'blocker', 'work_item', 'wi_1', 1, 'subject', 'q', '[]', '{}', 1, 'h', '{}', '[]', ?, 'consumed')`,
  ).run(AT, AT);
  db.prepare(`INSERT INTO "approvals" ("id", "created_at", "project", "decision", "actor", "consequence", "subject_type", "subject_id", "consumed_at") VALUES ('appr_1', ?, 'prj_1', 'dec_1', 'human', 'c', 'work_item', 'wi_1', ?)`).run(AT, AT);
  db.prepare(
    `INSERT INTO "protected_versions" ("id", "created_at", "project", "seq", "fingerprint", "check_ids", "change_kind", "approved_by", "approver_authority", "approved_at", "authorized", "roots", "fingerprint_scheme")
     VALUES ('pv_1', ?, 'prj_1', 1, 'fp', '[]', 'initial', 'human', 'human', ?, 1, '[]', 'manifest')`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO "protected_proposals" ("id", "created_at", "project", "seq", "proposed_by", "base_revision", "tree_id", "diff_hash", "requested_change_kind", "status", "approver", "approver_authority", "approved_at", "resulting_version")
     VALUES ('pp_1', ?, 'prj_1', 1, 'human', 'abc', 'tree', 'diff', 'tightening', 'applied', 'human', 'reviewer', ?, 'pv_1')`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO "findings" ("id", "created_at", "project", "seq", "scope", "subject_id", "category", "message", "proposed_severity", "effective_severity", "status", "disposition", "disposition_authority", "disposition_by", "created_seq")
     VALUES ('fnd_1', ?, 'prj_1', 1, 'project', 'prj_1', 'defect', 'm', 'low', 'low', 'dispositioned', 'fix', 'human', 'human', 7)`,
  ).run(AT);
  db.prepare(`INSERT INTO "prototype_iterations" ("id", "created_at", "project", "seq", "mode", "status", "limits_json") VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', 'alpha_ready', '{}')`).run(AT);
  const snapshot = (table) => db.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all();
  const was = Object.fromEntries(['decisions', 'approvals', 'protected_versions', 'protected_proposals', 'findings', 'prototype_iterations'].map((t) => [t, snapshot(t)]));
  migrate(db, join(root, 'migrations'));
  return { db, was, snapshot };
}

test('0053: every row of the rebuilt tables is kept as it was, and the added columns read NULL on rows recorded before it (not recorded, never inferred)', (t) => {
  const { db, was, snapshot } = upgraded(t);
  assert.equal(db.prepare('SELECT "name" FROM "schema_migrations" ORDER BY "seq" DESC LIMIT 1').get().name, MIGRATION);
  for (const [table, rows] of Object.entries(was)) {
    const now = snapshot(table);
    assert.equal(now.length, rows.length, `${table}: as many rows`);
    for (let i = 0; i < rows.length; i++) for (const [k, v] of Object.entries(rows[i])) assert.equal(now[i][k], v, `${table}.${k} kept`);
  }
  assert.equal(snapshot('approvals')[0].delegation, null, 'an approval recorded before 0053 has no delegation recorded');
  const f = snapshot('findings')[0];
  assert.deepEqual([f.bound_plan, f.bound_spec_revision, f.scope_reason], [null, null, null]);
  const it = snapshot('prototype_iterations')[0];
  assert.deepEqual([it.target_environment, it.target_config, it.target_config_identity, it.preparation_authority, it.preparation_allowance, it.clock_basis], [null, null, null, null, null, null]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // The trigger dropped for the rebuild is back, unchanged.
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE "type" = 'trigger' AND "name" = 'trust_entries_activation'`).get());
});

test('0053: the widened enumerations take policy, plan and deployment_target_approval, and still refuse any other value', (t) => {
  const { db } = upgraded(t);
  db.prepare(`UPDATE "findings" SET "disposition_authority" = 'policy', "scope" = 'plan' WHERE "id" = 'fnd_1'`).run();
  db.prepare(`UPDATE "protected_versions" SET "approver_authority" = 'policy' WHERE "id" = 'pv_1'`).run();
  db.prepare(`UPDATE "protected_proposals" SET "approver_authority" = 'policy' WHERE "id" = 'pp_1'`).run();
  db.prepare(`UPDATE "decisions" SET "kind" = 'deployment_target_approval' WHERE "id" = 'dec_1'`).run();
  assert.throws(() => db.prepare(`UPDATE "findings" SET "disposition_authority" = 'agent' WHERE "id" = 'fnd_1'`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`UPDATE "findings" SET "scope" = 'phase' WHERE "id" = 'fnd_1'`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`UPDATE "decisions" SET "kind" = 'deployment_approval' WHERE "id" = 'dec_1'`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`UPDATE "prototype_iterations" SET "preparation_authority" = 'human' WHERE "id" = 'it_1'`).run(), /CHECK constraint failed/);
});

test('0053: one open excluded interval per iteration and reason; a closed one beside it is allowed', (t) => {
  const { db } = upgraded(t);
  const ins = db.prepare(`INSERT INTO "prototype_clock_exclusions" ("id", "created_at", "project", "iteration", "reason", "from_at", "to_at") VALUES (?, ?, 'prj_1', 'it_1', ?, ?, ?)`);
  ins.run('ex_1', AT, 'paused', AT, null);
  ins.run('ex_2', AT, 'paused', AT, AT);
  ins.run('ex_3', AT, 'parked_on_blocker', AT, null);
  assert.throws(() => ins.run('ex_4', AT, 'paused', AT, null), /UNIQUE constraint failed/);
  assert.throws(() => ins.run('ex_5', AT, 'waiting', AT, AT), /CHECK constraint failed/);
  const act = db.prepare(
    `INSERT INTO "delegated_actions" ("id", "created_at", "project", "iteration", "kind", "subject_type", "subject_id", "authorized_by_kind", "authorized_by", "performed_by") VALUES (?, ?, 'prj_1', 'it_1', ?, 'plan_bundle', 'b_1', ?, 'dec_1', 'policy:rapid_prototype')`,
  );
  act.run('da_1', AT, 'plan_published', 'decision');
  assert.throws(() => act.run('da_2', AT, 'plan_approved', 'decision'), /CHECK constraint failed/);
  assert.throws(() => act.run('da_3', AT, 'plan_published', 'owner'), /CHECK constraint failed/);
});

test('0053: the contract states the widened enumerations and the new tables from the migrated schema', () => {
  const doc = exportContract();
  assert.deepEqual(doc.enums.Authority, ['role', 'reviewer', 'human', 'policy']);
  assert.deepEqual(doc.enums.FindingScope, ['project', 'lineage', 'candidate', 'plan']);
  assert.ok(doc.enums.DecisionKind.includes('deployment_target_approval'));
  assert.equal(doc.tables.findings.fields.bound_plan.references, 'phase_plans');
  assert.equal(doc.tables.delegated_actions.fields.kind.enum, 'DelegatedActionKind');
  assert.equal(doc.tables.prototype_clock_exclusions.fields.reason.enum, 'ClockExclusionReason');
  assert.equal(doc.decisions.deployment_target_approval.enabled, true);
  assert.equal(doc.config.project.prototype_preparation_allowance.default, 'off');
  assert.equal(doc.config.project.prototype_preparation_model.widening, 'changed_while_allowed');
});
