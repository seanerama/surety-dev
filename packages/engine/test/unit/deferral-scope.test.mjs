// A phase authoring's deferrals are the phase's own (D6 §6.2, D6-W06; found
// by the real loop run 1, Mechanica: phase 1's authoring deferred phase 2's
// trajectory criteria to the interface `trajectory.launch` of the Physics
// module, which phase 1's stage 1 touched).
//   (a) a deferral naming a criterion the plan does not owe is refused, with
//       a message the Verifier can act on;
//   (b) such an obligation already recorded holds no gate, dispatches no
//       follow-up, is resolved with an event, and its idle follow-up is
//       cancelled;
//   (c) an interface prerequisite is met only when every active stage of the
//       plan whose modules hold the interface has integrated.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { authoringShortfall } = await import(join(dist, 'plan', 'phase.js'));
const { criteriaOwed, deferralRefsInvalid, followUpsDue, resolveUnowedDeferrals } = await import(join(dist, 'plan', 'deferral.js'));

const AT = '2026-10-16T00:00:00.000Z';

// Phase 1 of a Mechanica-like project: the Physics module holds the
// interfaces `physics.step` (phase 1) and `trajectory.launch` (phase 2).
const MODULES = { modules: { modules: [{ name: 'Physics', interfaces: [{ name: 'physics.step' }, { name: 'trajectory.launch' }] }, { name: 'Server', interfaces: [{ name: 'GET /state' }] }] } };
const PLANNED = [
  { scope: { kind: 'stage', number: 1 }, tier: 'T2', criteria: ['R1.1', 'R2.1'], kinds: [], sensitive_areas: [] },
  { scope: { kind: 'stage', number: 2 }, tier: 'T2', criteria: ['R5.1'], kinds: [], sensitive_areas: [] },
  { scope: { kind: 'phase', number: 1 }, tier: 'T2', criteria: ['R1.1', 'R2.1', 'R5.1'], kinds: [], sensitive_areas: [] },
];

function store(t, { planned = PLANNED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/repo', 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT);
  db.prepare(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status) VALUES ('b_1', ?, 'prj_1', 'h', '{}', ?, '{}', 'published')`).run(AT, JSON.stringify(MODULES));
  db.prepare(
    `INSERT INTO plan_checks (id, created_at, project, bundle, phase_number, outcome, reasons, conformance, changes_architecture, changes_adrs, changes_roadmap, changes_goals, roadmap_revision, needs_spec_change, routing, obligations)
     VALUES ('pc_1', ?, 'prj_1', 'b_1', 1, 'passed', '[]', 'within_baseline', '{}', '{}', '{}', 0, 0, 0, 'registered', ?)`,
  ).run(AT, planned === null ? 'not json' : JSON.stringify(planned));
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation, bundle, "check") VALUES ('plan_1', ?, 'prj_1', 1, 'r', 'x', 'published', 1, 1, 'b_1', 'pc_1')`).run(AT);
  let seq = 0;
  const h = {
    db,
    run: (sql, ...a) => db.prepare(sql).run(...a),
    stage: (id, number, status, modules, validation = []) =>
      db
        .prepare(
          `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, depends_on, validation)
           VALUES (?, ?, 'prj_1', 'plan_1', ?, 'g', ?, '[]', '[]', ?, '[]', ?)`,
        )
        .run(id, AT, number, JSON.stringify(modules), status, JSON.stringify({ criteria: validation, kinds: [], sensitive_areas: [] })),
    owe: (id, criterion, prerequisite) =>
      db
        .prepare(`INSERT INTO check_obligations (id, created_at, project, criteria, generation, reason, prerequisite, follow_up, phase_plan) VALUES (?, ?, 'prj_1', ?, 1, 'deferred_authoring', ?, ?, 'plan_1')`)
        .run(id, AT, JSON.stringify([criterion]), JSON.stringify(prerequisite), JSON.stringify({ trigger_source: 'deferred_authoring', trigger_id: id, trigger_generation: 1 })),
    item: (id, triggerId, status) =>
      db
        .prepare(
          `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
           VALUES (?, ?, 'prj_1', ?, 'check_authoring', '{"phase_plan":"plan_1"}', ?, 'deferred_authoring', ?, 1, 0, 0, 0, 0)`,
        )
        .run(id, AT, ++seq, status, triggerId),
    followUps: () => db.prepare(`SELECT id, trigger_id, status FROM work_items WHERE kind = 'check_authoring' AND trigger_source = 'deferred_authoring' ORDER BY seq`).all(),
    obligation: (id) => db.prepare('SELECT * FROM check_obligations WHERE id = ?').get(id),
    events: (type) => db.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => ({ ...e, subject: JSON.parse(e.subject), payload: JSON.parse(e.payload) })),
  };
  return h;
}

const d = (criterion, prerequisite) => ({ criterion, reason: 'not yet', prerequisite });

// ---- (a) ------------------------------------------------------------------------------------

test('(a) the criteria a plan owes are its planned obligations\' and its stages\' validation; unknown when the plan check is unreadable or the plan is a fixture\'s', (t) => {
  const h = store(t);
  h.stage('s1', 1, 'planned', ['Physics'], ['R1.1', 'R12.1']);
  assert.deepEqual([...criteriaOwed(h.db, 'plan_1')].sort(), ['R1.1', 'R12.1', 'R2.1', 'R5.1']);
  const u = store(t, { planned: null });
  assert.equal(criteriaOwed(u.db, 'plan_1'), null, 'an unreadable plan check: unknown, never none');
  u.run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation) VALUES ('plan_f', ?, 'prj_1', 2, 'r', 'x', 'published', 1, 1)`, AT);
  assert.equal(criteriaOwed(u.db, 'plan_f'), null, 'a fixture plan records no planned obligations: unknown');
});

test('(a) a deferral naming a criterion the phase does not owe is refused, naming each such criterion and what to do; an owed one is accepted', (t) => {
  const h = store(t);
  h.stage('s1', 1, 'planned', ['Physics']);
  h.stage('s2', 2, 'planned', ['Server']);
  assert.equal(deferralRefsInvalid(h.db, 'plan_1', [d('R5.1', { interface: 'GET /state' })]), null, 'an owed criterion deferred to an interface of the map');
  const one = deferralRefsInvalid(h.db, 'plan_1', [d('R5.1', { stage: 2 }), d('R10.1', { interface: 'trajectory.launch' })]);
  assert.match(one, /the deferral of R10\.1 names a criterion phase 1 does not owe/);
  assert.match(one, /authored with the phase that owes it/);
  assert.match(one, /leave it out of deferred_criteria/);
  assert.doesNotMatch(one, /deferral of R5\.1/, 'the owed one is not named');
  const many = deferralRefsInvalid(h.db, 'plan_1', [d('R3.1', { interface: 'trajectory.launch' }), d('R10.2', { interface: 'trajectory API' })]);
  assert.match(many, /the deferrals of R3\.1, R10\.2 name criteria phase 1 does not owe/, 'every foreign criterion at once, before the interface it names');
  // The prerequisite rules stand for an owed criterion.
  assert.match(deferralRefsInvalid(h.db, 'plan_1', [d('R1.1', { interface: 'trajectory API' })]), /trajectory API/);
});

test('(a) an unknown owed set refuses nothing on scope', (t) => {
  const h = store(t, { planned: null });
  h.stage('s1', 1, 'planned', ['Physics']);
  assert.equal(deferralRefsInvalid(h.db, 'plan_1', [d('R10.1', { interface: 'trajectory.launch' })]), null);
});

// ---- (b) ------------------------------------------------------------------------------------

test('(b) a recorded deferral the phase does not owe holds no AUTHORING_INCOMPLETE; an owed one still does', (t) => {
  const h = store(t);
  h.stage('s1', 1, 'integrated', ['Physics']);
  h.owe('obl_r10', 'R10.1', { interface: 'trajectory.launch' });
  h.owe('obl_r5', 'R5.1', { stage: 2 });
  const shortfall = authoringShortfall(h.db, 'plan_1', 'pv_none');
  assert.ok(shortfall.includes('deferred:R5.1'), JSON.stringify(shortfall));
  assert.ok(!shortfall.includes('deferred:R10.1'), JSON.stringify(shortfall));
});

test('(b) followUpsDue resolves an unowed deferral with an event, raises no follow-up for it and cancels its idle one; a running one is left; an owed one is untouched', (t) => {
  const h = store(t);
  h.stage('s1', 1, 'integrated', ['Physics']);
  h.stage('s2', 2, 'planned', ['Server']);
  h.owe('obl_r10_1', 'R10.1', { interface: 'trajectory.launch' });
  h.owe('obl_r10_2', 'R10.2', { interface: 'trajectory.launch' });
  h.owe('obl_r10_3', 'R10.3', { interface: 'trajectory.launch' });
  h.owe('obl_r5', 'R5.1', { stage: 2 });
  h.item('w_parked', 'obl_r10_1', 'parked');
  h.item('w_running', 'obl_r10_2', 'executing');
  const made = transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1'));
  assert.equal(made, 0, 'no follow-up for a criterion the phase does not owe');
  for (const id of ['obl_r10_1', 'obl_r10_2', 'obl_r10_3']) {
    const o = h.obligation(id);
    assert.ok(o.resolved_at, `${id} resolved`);
    assert.equal(o.resolved_by, 'plan_1');
  }
  assert.equal(h.obligation('obl_r5').resolved_at, null, 'the owed deferral stays');
  const resolved = h.events('check.obligation_resolved');
  assert.deepEqual(resolved.map((e) => e.subject.check_obligation).sort(), ['obl_r10_1', 'obl_r10_2', 'obl_r10_3']);
  assert.ok(resolved.every((e) => e.payload.how === 'not_owed_by_phase' && e.payload.phase_plan === 'plan_1'));
  const items = Object.fromEntries(h.followUps().map((w) => [w.id, w.status]));
  assert.equal(items.w_parked, 'cancelled', 'the parked follow-up is cancelled');
  assert.equal(items.w_running, 'executing', 'a running one ends as it ends');
  assert.equal(h.followUps().length, 2, 'nothing new raised');
  // Idempotent: a second pass resolves nothing more.
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => resolveUnowedDeferrals(tx, 'prj_1')), 0);
  assert.equal(h.events('check.obligation_resolved').length, 3);
});

test('(b) an unknown owed set resolves nothing', (t) => {
  const h = store(t, { planned: null });
  h.stage('s1', 1, 'integrated', ['Physics']);
  h.owe('obl_r10', 'R10.1', { interface: 'trajectory.launch' });
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => resolveUnowedDeferrals(tx, 'prj_1')), 0);
  assert.equal(h.obligation('obl_r10').resolved_at, null);
});

// ---- (c) ------------------------------------------------------------------------------------

test('(c) an interface prerequisite waits for every active stage whose modules hold it, not the first', (t) => {
  const h = store(t, { planned: [{ scope: { kind: 'phase', number: 1 }, tier: 'T2', criteria: ['R1.1', 'R3.1'], kinds: [], sensitive_areas: [] }] });
  h.stage('s1', 1, 'integrated', ['Physics']);
  h.stage('s2', 2, 'integrated', ['Server']);
  h.stage('s3', 3, 'planned', ['Physics']);
  h.owe('obl_r3', 'R3.1', { interface: 'trajectory.launch' });
  h.owe('obl_r1', 'R1.1', { stage: 1 });
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 1, 'the stage prerequisite is met; the interface is not while stage 3 has not integrated');
  assert.deepEqual(h.followUps().map((w) => w.trigger_id), ['obl_r1']);
  h.run(`UPDATE stages SET status = 'integrated', parked_at = ? WHERE id = 's3'`, AT);
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 0, 'a parked holder meets nothing');
  h.run(`UPDATE stages SET parked_at = NULL WHERE id = 's3'`);
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 1, 'every holder integrated: the follow-up, once');
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 0, 'once');
});

test('(c) a cancelled holder does not hold the interface prerequisite', (t) => {
  const h = store(t, { planned: [{ scope: { kind: 'phase', number: 1 }, tier: 'T2', criteria: ['R3.1'], kinds: [], sensitive_areas: [] }] });
  h.stage('s1', 1, 'integrated', ['Physics']);
  h.stage('s3', 3, 'planned', ['Physics']);
  h.run(`UPDATE stages SET cancelled_at = ? WHERE id = 's3'`, AT);
  h.owe('obl_r3', 'R3.1', { interface: 'trajectory.launch' });
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 1);
});
