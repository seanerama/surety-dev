// Developer tests for the slice-37 review's findings that are store
// transitions or pure reads: M1 and N2 (the envelope's reads), M3 (the
// integration lease and the project's journal), M4 (a phase's own authoring
// obligations), M5 (a deferral's references), M8 and N10 (build_first's
// owed authoring; a parked prerequisite), N1 (a stage's own repair under
// `stage`), N4 (an attempt's profile under the ceiling), the generation class
// rule (a dispatch hold is no class change), and an approved proposal that
// conflicts with the head. Against scratch stores, foreign keys off, the rows
// the minimum each read needs; nothing reaches the host but /proc/meminfo and
// statfs of a scratch directory.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings, attemptProfileMax } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { envelopeHold, setEnvelope, setScriptedEnvelope } = await import(join(dist, 'store', 'transitions', 'envelope.js'));
const { acquireIntegrationLease } = await import(join(dist, 'store', 'transitions', 'integration-lease.js'));
const { Journal } = await import(join(dist, 'journal', 'driver.js'));
const { authoringShortfall } = await import(join(dist, 'plan', 'phase.js'));
const { deferralRefsInvalid, recordAuthoringPending, followUpsDue, recordDeferrals } = await import(join(dist, 'plan', 'deferral.js'));
const { boundaryFalls } = await import(join(dist, 'scheduler', 'autonomy.js'));
const { dependencyManifest, workClass } = await import(join(dist, 'spec', 'change.js'));
const { applicationConflicts } = await import(join(dist, 'store', 'transitions', 'classification.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' });

const AT = '2026-10-14T00:00:00.000Z';
const GiB = 1024 ** 3;

function store(t) {
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
  let seq = 0;
  const h = {
    db,
    dir,
    run: (sql, ...a) => db.prepare(sql).run(...a),
    item: (id, kind, subject, status = 'eligible', trigger = ['test', id]) =>
      db
        .prepare(
          `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
           VALUES (?, ?, 'prj_1', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0)`,
        )
        .run(id, AT, ++seq, kind, JSON.stringify(subject), status, trigger[0], trigger[1]),
    plan: (id, phase, bundle = null) =>
      db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, status, active, generation, bundle) VALUES (?, ?, 'prj_1', ?, 'r', 'x', 'published', 1, 1, ?)`).run(id, AT, phase, bundle),
    stage: (id, plan, number, status, extra = {}) =>
      db
        .prepare(
          `INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, depends_on, work_item, parked_at)
           VALUES (?, ?, 'prj_1', ?, ?, 'g', ?, '[]', '[]', ?, ?, ?, ?)`,
        )
        .run(id, AT, plan, number, JSON.stringify(extra.modules ?? []), status, JSON.stringify(extra.depends_on ?? []), extra.work_item ?? null, extra.parked_at ?? null),
    runOf: (id, workItem, state = 'ended') =>
      db
        .prepare(
          `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
           VALUES (?, ?, 'prj_1', ?, ?, 'builder', 'one_shot', ?, 'scripted', '1', 'm', ?, ?, 0)`,
        )
        .run(id, AT, ++seq, workItem, state, 'a'.repeat(40), AT),
  };
  return h;
}

// ---- M1 and N2: the envelope's reads ---------------------------------------------------

const stubOf = (rows) => ({ prepare: () => ({ all: () => rows, get: () => undefined }) });
const dom = (over) => ({ id: 'd', cgroup_path: null, profile: 'role', reservation: null, project: 'p', status: 'allocated', observation: null, memory_max: GiB, cgroup_inode: null, bound: 0, ...over });

test("M1: a claimed domain whose cgroup is not made yet holds nothing; a made one whose memory.current cannot be read holds admission", (t) => {
  const home = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  setEnvelope({ real: true, max_concurrent_domains: 8, host_reserve_memory: 1, host_reserve_disk: 0, domain_memory_max: GiB, domain_writable_bytes: 0, home });
  setScriptedEnvelope(null);
  t.after(() => setEnvelope(null));
  const notYet = dom({ id: 'claimed', cgroup_path: join(home, 'not-made-yet'), cgroup_inode: null, memory_max: 1024 });
  const hold = envelopeHold(stubOf([notYet]), { kind: 'role', memory: 1024 });
  assert.ok(hold === null || hold.subject.unreadable !== 'memory.current', `not unreadable: ${JSON.stringify(hold)}`);
  mkdirSync(join(home, 'made'));
  const made = dom({ id: 'made', cgroup_path: join(home, 'made'), cgroup_inode: 42, memory_max: 1024 });
  const held = envelopeHold(stubOf([made]), { kind: 'role', memory: 1024 });
  assert.deepEqual([held?.subject.unreadable, held?.subject.domain], ['memory.current', 'made']);
});

test('N2: a service whose reservation cannot be read holds admission; it is never 0 bytes', (t) => {
  setEnvelope({ real: false, max_concurrent_domains: 8, host_reserve_memory: 1, host_reserve_disk: 0, domain_memory_max: GiB, domain_writable_bytes: 0, home: '/nonexistent' });
  setScriptedEnvelope(null);
  t.after(() => setEnvelope(null));
  const svc = dom({ id: 'svc', profile: 'service', status: 'launched', reservation: 'not json' });
  const hold = envelopeHold(stubOf([svc]), { kind: 'role', memory: 1024 });
  assert.deepEqual([hold?.subject.unreadable, hold?.subject.domain], ['reservation', 'svc']);
  const readable = dom({ id: 'svc2', profile: 'service', status: 'launched', reservation: JSON.stringify({ memory: 1024, check_capacity: 1024 }) });
  assert.equal(envelopeHold(stubOf([readable]), { kind: 'role', memory: 1024 }), null);
});

// ---- M3: the integration lease and the project's journal ------------------------------------

test('M3: the lease is taken over only from a holder that is gone; a live holder of this incarnation is waited for', (t) => {
  const { db } = store(t);
  const take = (incarnation, at) => transact(db, ENGINE_ACTOR, (tx) => acquireIntegrationLease(tx, { project: 'prj_1', run: 'r', incarnation }));
  const first = take('inc_1');
  assert.ok(first);
  assert.equal(take('inc_1'), null, 'held by a live holder of this incarnation: waited for');
  assert.ok(take('inc_2'), 'an earlier incarnation\'s holder is gone: taken over');
  db.prepare(`UPDATE leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE resource_kind = 'integration' AND released_at IS NULL`).run();
  assert.ok(take('inc_2'), 'past its lease_ttl: taken over');
});

test("M3: the project's journal is one holder at a time across writers, and reentrant within one", async () => {
  const leases = [];
  let next = 0;
  const rt = {
    incarnation: 'inc_1',
    engine: async (op, a) => {
      if (op === 'integration.acquire') {
        leases.push(`+${a.run}`);
        return `lease_${++next}`;
      }
      if (op === 'integration.release') leases.push(`-${a.lease}`);
      return null;
    },
  };
  const j = new Journal(rt);
  const order = [];
  const slow = j.withProject(
    'prj_1',
    async () => {
      order.push('a:start');
      // Nested: the same holder runs at once.
      await j.withProject('prj_1', async () => order.push('a:nested'));
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
    },
    'a',
  );
  const other = j.withProject('prj_1', async () => order.push('b'), 'b');
  await Promise.all([slow, other]);
  assert.deepEqual(order, ['a:start', 'a:nested', 'a:end', 'b']);
  assert.deepEqual(leases, ['+a', '-lease_1', '+b', '-lease_2'], 'one durable lease per holder, the nested call took none');
});

// ---- M4, M5, M8, N10: a phase's authoring obligations ----------------------------------------

test("M4: a phase's AUTHORING_INCOMPLETE names its own plan's deferrals, not another phase's", (t) => {
  const h = store(t);
  h.plan('plan_1', 1);
  h.plan('plan_2', 2);
  const owe = (id, plan, criterion) =>
    h.run(`INSERT INTO check_obligations (id, created_at, project, criteria, generation, reason, prerequisite, follow_up, phase_plan) VALUES (?, ?, 'prj_1', ?, 1, 'deferred_authoring', '{"stage":1}', '{}', ?)`, id, AT, JSON.stringify([criterion]), plan);
  owe('obl_1', 'plan_1', 'R1.1');
  owe('obl_2', 'plan_2', 'R2.1');
  assert.deepEqual(authoringShortfall(h.db, 'plan_1', 'pv_none'), ['deferred:R1.1']);
  assert.deepEqual(authoringShortfall(h.db, 'plan_2', 'pv_none'), ['deferred:R2.1']);
});

test("M5: a deferral's prerequisite must be a stage of the plan or an interface of its module map", (t) => {
  const h = store(t);
  h.run(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status) VALUES ('b_1', ?, 'prj_1', 'h', '{}', ?, '{}', 'published')`, AT, JSON.stringify({ modules: { modules: [{ name: 'service', interfaces: [{ name: 'GET /sum' }] }] } }));
  h.plan('plan_1', 1, 'b_1');
  h.stage('s1', 'plan_1', 1, 'planned');
  const d = (prerequisite) => [{ criterion: 'R1.1', reason: 'not yet', prerequisite }];
  assert.equal(deferralRefsInvalid(h.db, 'plan_1', d({ stage: 1 })), null);
  assert.equal(deferralRefsInvalid(h.db, 'plan_1', d({ interface: 'GET /sum' })), null);
  assert.match(deferralRefsInvalid(h.db, 'plan_1', d({ stage: 4 })), /stage 4/);
  assert.match(deferralRefsInvalid(h.db, 'plan_1', d({ interface: 'GET /nope' })), /GET \/nope/);
});

test("M8 and N10: build_first leaves an authoring_pending obligation; its follow-up is raised once every stage has integrated and none is parked, and its applied proposal resolves it", (t) => {
  const h = store(t);
  h.plan('plan_1', 1);
  h.stage('s1', 'plan_1', 1, 'integrated');
  h.stage('s2', 'plan_1', 2, 'integrated', { parked_at: AT });
  const obligation = transact(h.db, ENGINE_ACTOR, (tx) => recordAuthoringPending(tx, { project: 'prj_1', phase_plan: 'plan_1', decision: 'dec_1' }));
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 0, 'a parked stage meets nothing (N10)');
  h.run(`UPDATE stages SET parked_at = NULL WHERE id = 's2'`);
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 1, 'every stage integrated: the follow-up is raised');
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => followUpsDue(tx, 'prj_1')), 0, 'once');
  const follow = h.db.prepare(`SELECT * FROM work_items WHERE kind = 'check_authoring' AND trigger_source = 'authoring_pending'`).get();
  assert.equal(follow.trigger_id, obligation);
  // The follow-up's proposal applied resolves the obligation.
  h.runOf('run_f', follow.id);
  h.run(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('prop_f', ?, 'prj_1', 1, 'verifier_run', 'run_f', 'b', 't', 'd', 'tightening', 'applied')`, AT);
  transact(h.db, ENGINE_ACTOR, (tx) => recordDeferrals(tx, { project: 'prj_1', proposal: 'prop_f' }));
  assert.ok(h.db.prepare('SELECT resolved_at FROM check_obligations WHERE id = ?').get(obligation).resolved_at);
});

// ---- N1: a stage's own repair under `stage` -------------------------------------------------

test("N1: under `stage`, a stage's own repair Builder is inside its chain; the next stage's Builder is not", (t) => {
  const h = store(t);
  h.run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective) VALUES ('pr_1', ?, 'prj_1', 1, 'x', 'b', 'h', ?, '', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ autonomy: 'stage' }),
  );
  h.run(`UPDATE projects SET policy_revision = 'pr_1' WHERE id = 'prj_1'`);
  h.plan('plan_1', 1);
  h.item('wi_1', 'stage_build', { stage: 's1' }, 'eligible');
  h.item('wi_2', 'stage_build', { stage: 's2' }, 'eligible');
  h.stage('s1', 'plan_1', 1, 'building', { work_item: 'wi_1' });
  h.stage('s2', 'plan_1', 2, 'planned', { work_item: 'wi_2', depends_on: ['s1'] });
  h.runOf('run_1', 'wi_1');
  const row = (id) => h.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  assert.equal(boundaryFalls(h.db, row('wi_1')), false, "stage 1's repair runs unattended");
  assert.equal(boundaryFalls(h.db, row('wi_2')), true, "stage 2's Builder waits at the boundary");
});

// ---- N4 --------------------------------------------------------------------------------------

test("N4: a qualification attempt's profile is under the ceiling", (t) => {
  const h = store(t);
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1', domain_memory_max: 2 * GiB });
  t.after(() => setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {}, incarnation: 'inc_1' }));
  const cols = h.db.prepare('PRAGMA table_info(qualification_attempts)').all().filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
  const values = Object.fromEntries(cols.map((c) => [c, c === 'created_at' ? AT : 'x']));
  values.id = 'qa_1';
  values.auth_mode = 'subscription_token';
  values.status = 'proposed';
  values.profile = JSON.stringify({ memory_max: 8 * GiB });
  const keys = Object.keys(values);
  h.db.prepare(`INSERT INTO qualification_attempts (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => values[k]));
  assert.equal(attemptProfileMax(h.db, 'qa_1'), 2 * GiB);
});

// ---- the generation class --------------------------------------------------------------------

test("the generation class: a dispatch hold leaves the manifest's generation unchanged; an owner's hold changes it", (t) => {
  const h = store(t);
  h.item('wi_1', 'stage_build', {}, 'eligible');
  const manifest = () => dependencyManifest(h.db, { project: 'prj_1', phases: [], stages: [], keys: [], checks: [], findings: [], results: [], work: ['wi_1'] }).work;
  const before = manifest();
  h.run(`UPDATE work_items SET held = 'depends_on', held_intervals = '[{"from":"${AT}","reason":"depends_on"}]' WHERE id = 'wi_1'`);
  assert.deepEqual(manifest(), before, 'a dispatch hold is no class change');
  h.run(`UPDATE work_items SET held = 'resource_envelope' WHERE id = 'wi_1'`);
  assert.deepEqual(manifest(), before);
  h.run(`UPDATE work_items SET status = 'awaiting_decision' WHERE id = 'wi_1'`);
  assert.notDeepEqual(manifest(), before, 'awaiting a decision is owner-held');
  assert.deepEqual(['active', 'held', 'held', 'held', 'terminal'], ['executing', 'parked', 'awaiting_decision', 'held', 'complete'].map(workClass));
});

// ---- an approved proposal that conflicts with the head ---------------------------------------

test('an approved proposal whose changes conflict with the head is rejected naming the conflict; the authoring item waiting for it repairs, never left awaiting nothing', (t) => {
  const h = store(t);
  h.plan('plan_1', 1);
  h.item('wi_a', 'check_authoring', { phase_plan: 'plan_1' }, 'awaiting_decision');
  h.runOf('run_a', 'wi_a');
  h.run(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('prop_a', ?, 'prj_1', 1, 'verifier_run', 'run_a', 'b', 't', 'd', 'tightening', 'approved')`, AT);
  h.run(`UPDATE work_items SET blocker = ?, continuation = 'executing' WHERE id = 'wi_a'`, JSON.stringify({ reason: 'correction_proposed', raised_at: AT, proposal: 'prop_a' }));
  assert.equal(transact(h.db, ENGINE_ACTOR, (tx) => applicationConflicts(tx, { proposal: 'prop_a', intent: null, head: 'c'.repeat(40), reason: 'conflict' })), true);
  assert.equal(h.db.prepare(`SELECT status FROM protected_proposals WHERE id = 'prop_a'`).get().status, 'rejected');
  const item = h.db.prepare(`SELECT status FROM work_items WHERE id = 'wi_a'`).get();
  assert.notEqual(item.status, 'awaiting_decision', `the item is not left waiting on nothing (${item.status})`);
});
