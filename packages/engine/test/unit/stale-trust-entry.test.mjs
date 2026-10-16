// Developer tests for a trust entry made stale by a change of the host's
// mechanism (D2 §4.1: "an incompatible mechanism ... requires
// requalification"; §7.2, Q7; real loop run 4, 2026-10-16: an unattended
// systemd upgrade changed the mechanism fingerprint mid-run, both claude
// entries stayed active, every dispatch was refused, and the work parked
// behind a question naming no reason and offering only a retry that could
// not succeed). The fingerprint changes; the entry is recorded stale at the
// start; each item refused for it is held, not refused again into a park;
// one owner question names the entry and the exact `surety qualify`
// command; an entry of the new mechanism, qualified and activated, releases
// the items. A parked item's question names its last refusal. Against a
// scratch store with the engine's migrations.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { answerQueued, reviewDecisions } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { beginEnd, finishRun, dispatchBlocker } = await import(join(dist, 'store', 'transitions', 'runs.js'));
const trust = await import(join(dist, 'store', 'transitions', 'trust.js'));
const { proposeEntry, proposeAttempt } = await import(join(dist, 'store', 'transitions', 'qualification.js'));
const { hostIdentity, ISOLATION_MECHANISM, BOUNDARY_MECHANISM } = await import(join(dist, 'trust', 'host.js'));
const { holdReasonOf } = await import(join(dist, 'scheduler', 'holds.js'));
const { dispatchCandidates } = await import(join(dist, 'store', 'reads.js'));
const { readWork } = await import(join(dist, 'store', 'projections.js'));

const HUMAN = { actor_kind: 'human', actor_id: null, request_id: null };
const AT = '2026-10-16T11:08:00.000Z';

function store(t, policy = {}) {
  setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  migrate(db, join(root, 'migrations'));
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`,
    AT,
  );
  run(
    `INSERT INTO policy_revisions (id, created_at, project, revision, git_path, git_blob, changed_by, changed_at, diff_summary, widens_authority, committed, effective)
     VALUES ('pr_1', ?, 'prj_1', 1, '.surety/policy.json', 'b', 'test', ?, '', 0, 1, ?)`,
    AT,
    AT,
    JSON.stringify({ backend_builder: 'claude', backend_verifier: 'claude', ...policy }),
  );
  run(`UPDATE projects SET policy_revision = 'pr_1' WHERE id = 'prj_1'`);
  for (const inc of ['inc_1', 'inc_2']) run(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES (?, ?, 1, ?, 'boot')`, inc, AT, AT);
  for (const id of ['rec_E1', 'rec_E2', 'rec_B1']) {
    run(
      `INSERT INTO records (id, created_at, project, kind, path, sha256, bytes, redaction_version, published, post_scan) VALUES (?, ?, 'prj_1', 'qualification_evidence', ?, ?, 1, 'r1', 1, 'clean')`,
      id,
      AT,
      id,
      'a'.repeat(64),
    );
  }
  return db;
}

const hostRow = (db, incarnation, mechanism) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    trust.recordHostQualification(tx, { incarnation, host_id: hostIdentity(), kernel: 'k', tool_versions: {}, mechanism_fingerprint: mechanism, checks: [], probes: [], evidence: 'rec_E1' }),
  );

// An entry of `claude` for Sonnet under the current host qualification,
// proposed by its attempt and activated by the owner's trust_activation.
function activeEntry(db) {
  const hq = trust.currentHostQualification(db).id;
  const made = transact(db, ENGINE_ACTOR, (tx) => {
    const { attempt } = proposeAttempt(tx, {
      backend: 'claude',
      version: '2.1.288',
      binary_path: '/opt/claude',
      binary_sha256: '1'.repeat(64),
      help_sha256: '2'.repeat(64),
      template: 't',
      template_version: '1',
      model: 'claude-sonnet-5-5',
      auth_mode: 'subscription_token',
      host_qualification: hq,
      profile_fingerprint: 'prof-1',
      fixture_project: 'prj_1',
      candidate_egress: ['api.anthropic.com'],
      canary_deadlines: { positive: 900, cancellation: 600, containment: 900 },
      spend: { cap: null, estimate: 1, label: 'estimate', overshoot: 'deadline' },
    });
    return proposeEntry(tx, {
      backend: 'claude',
      version: '2.1.288',
      binary_path: '/opt/claude',
      binary_sha256: '1'.repeat(64),
      help_sha256: '2'.repeat(64),
      mode: 'one_shot_headless',
      template: 't',
      template_version: '1',
      model: 'claude-sonnet-5-5',
      auth_mode: 'subscription_token',
      capabilities: { tools: ['Read'], denied: ['Agent'], features_disabled: [], delegation_verified: true },
      host_id: hostIdentity(),
      host_qualification: hq,
      isolation: ISOLATION_MECHANISM,
      boundary: BOUNDARY_MECHANISM,
      profile_fingerprint: 'prof-1',
      egress_hosts: ['api.anthropic.com'],
      usage_granularity: 'model_call',
      usage_semantics: 'cumulative',
      cost_reporting: 'reported',
      enforceable_boundaries: [{ boundary: 'invocation', mechanism: 'dispatch_check', evidence: 'rec_B1', overshoot: 'deadline' }],
      result_channel: 'file',
      session_qualified: false,
      provider_files: { locations: [], persistence_flags: [], excluded: [] },
      term_to_exit_ms: null,
      qualification_attempt: attempt.id,
      evidence: ['rec_E1', 'rec_E2'],
    });
  });
  answer(db, null, made.decision, 'approve');
  assert.equal(trust.getEntry(db, made.entry.id).status, 'active', 'the fixture is live: the entry is active');
  return made.entry.id;
}

const decision = (db, id) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
const answer = (db, project, id, option) =>
  transact(db, HUMAN, (tx) => answerQueued(tx, { project, decision: id, option, preview_hash: decision(db, id).preview_hash, note: null, facts: {} }));
const workItem = (db, id) => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
const openRequalification = (db) => db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_type = 'trust_entry' AND status = 'open'`).all();

let seq = 0;
function addItem(db, id, kind) {
  db.prepare(
    `INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold)
     VALUES (?, ?, 'prj_1', ?, ?, '{}', 'eligible', 'test', ?, 1, 0, 0, 0, 0)`,
  ).run(id, AT, ++seq, kind, id);
}

// One dispatch of the item, refused before launch as the choke point refuses
// it: the run claimed, its end begun `refused` / `preflight_refused` with the
// resolution's refusal as its detail, and ended (D1 §15.1; runs/end.ts).
function refuseOnce(db, itemId) {
  const item = workItem(db, itemId);
  const role = item.kind === 'stage_build' ? 'builder' : 'verifier';
  const r = trust.resolveBackend(db, { project: 'prj_1', role, scripted: null });
  assert.equal(r.kind, 'refused', `the dispatch of ${itemId} is refused (${JSON.stringify(r)})`);
  const run = `run_${itemId}_${++seq}`;
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined)
     VALUES (?, ?, 'prj_1', ?, ?, ?, 'one_shot', 'claimed', 'claude', 'unqualified', 'sonnet', ?, ?, 0)`,
  ).run(run, AT, ++seq, itemId, role, 'a'.repeat(40), AT);
  db.prepare(`UPDATE work_items SET status = 'claimed', prior_status = 'eligible' WHERE id = ?`).run(itemId);
  transact(db, ENGINE_ACTOR, (tx) => {
    beginEnd(tx, { run, outcome: 'refused', reason: 'preflight_refused', reasonText: r.code, detail: { code: r.code, reason: r.reason, what_to_do: r.what_to_do, subject: r.subject } });
    finishRun(tx, { run, invocations: {}, recovery: null });
  });
  return { run, refusal: r };
}

test('a changed mechanism: the stale entry is recorded at the start; each refused item is held, not parked; one question names the exact requalification; an activated entry of the new mechanism releases them', (t) => {
  const db = store(t);
  hostRow(db, 'inc_1', 'bf6b44da-mech');
  const stale = activeEntry(db);
  addItem(db, 'wi_build', 'stage_build');
  addItem(db, 'wi_author', 'check_authoring');
  assert.equal(dispatchBlocker(db, workItem(db, 'wi_build'), { check: false }), null, 'the fixture is live: before the change both are dispatchable');

  // The next start's host qualification has another mechanism fingerprint.
  transact(db, ENGINE_ACTOR, (tx) => trust.lapseEarlierQualifications(tx, 'inc_2'));
  const hq2 = hostRow(db, 'inc_2', '4ac9f98c-mech');
  const qualified = db.prepare(`SELECT payload FROM events WHERE type = 'host.qualified' AND json_extract(subject, '$.host_qualification') = ?`).get(hq2.id);
  const recorded = JSON.parse(qualified.payload).requalification_required;
  assert.deepEqual(recorded.map((e) => [e.trust_entry, e.entry_mechanism_fingerprint]), [[stale, 'bf6b44da-mech']], 'the start records the entry that needs requalification');
  assert.equal(trust.getEntry(db, stale).status, 'active', 'the entry is not revoked by that alone (SEAM.md §150)');

  // The first refusal of each item: counted once, the item held, not parked.
  const { refusal } = refuseOnce(db, 'wi_build');
  assert.equal(refusal.subject.requalification_required, true);
  assert.match(refusal.what_to_do, /surety qualify claude --mode one_shot_headless --model claude-sonnet-5-5 --auth-mode subscription_token --egress api\.anthropic\.com --canary-deadline positive=900 --canary-deadline cancellation=600 --canary-deadline containment=900/);
  refuseOnce(db, 'wi_author');
  for (const id of ['wi_build', 'wi_author']) {
    const row = workItem(db, id);
    assert.deepEqual([row.status, row.preflight_refusals, row.blocker], ['eligible', 1, null], `${id}: eligible, one refusal counted, no park`);
  }

  // One owner question for the entry, holding both, naming the command.
  const open = openRequalification(db);
  assert.equal(open.length, 1, 'one open question');
  const q = open[0];
  assert.deepEqual([q.project, q.subject_id], ['prj_1', stale]);
  assert.deepEqual(JSON.parse(q.blocked_while_open).work_items, ['wi_build', 'wi_author'], 'it holds both items');
  assert.match(q.question, new RegExp(`entry ${stale} for the model claude-sonnet-5-5`));
  assert.match(q.question, /Requalify it: surety qualify claude --mode one_shot_headless --model claude-sonnet-5-5 --auth-mode subscription_token/);
  assert.deepEqual(JSON.parse(q.options).map((o) => o.key), ['acknowledge']);
  for (const id of ['wi_build', 'wi_author']) {
    const blocker = dispatchBlocker(db, workItem(db, id), { check: false });
    assert.equal(blocker, 'held by an open decision');
    assert.equal(holdReasonOf(blocker), 'open_decision', 'a hold the pace read counts');
  }
  const shown = readWork(db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_build');
  assert.deepEqual([shown.blocker?.reason, shown.blocker?.decision], ['requalification_required', q.id], 'the work read names the cause and the question');

  // Ticks and decision reviews dispatch nothing and refuse nothing again.
  transact(db, ENGINE_ACTOR, (tx) => reviewDecisions(tx, { project: 'prj_1', channel: 'none' }));
  assert.equal(openRequalification(db)[0].id, q.id, 'the question stands while the entry is stale');
  assert.deepEqual(dispatchCandidates(db).find((p) => p.project === 'prj_1').items, [], 'nothing is a dispatch candidate');

  // Acknowledged: still held, on the requalification itself, and shown.
  answer(db, 'prj_1', q.id, 'acknowledge');
  const after = dispatchBlocker(db, workItem(db, 'wi_build'), { check: false });
  assert.equal(after, `waits for the requalification of trust entry ${stale}`);
  const ack = readWork(db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_author');
  assert.deepEqual([ack.blocker?.reason, ack.blocker?.trust_entry], ['requalification_required', stale]);
  assert.match(ack.blocker.what_to_do, /surety qualify claude/);
  assert.deepEqual(dispatchCandidates(db).find((p) => p.project === 'prj_1').items, []);

  // The owner requalifies: an entry of the new mechanism, activated.
  const fresh = activeEntry(db);
  assert.equal(trust.resolveBackend(db, { project: 'prj_1', role: 'builder', scripted: null }).entry?.id, fresh, 'the role resolves to the new entry');
  for (const id of ['wi_build', 'wi_author']) assert.equal(dispatchBlocker(db, workItem(db, id), { check: false }), null, `${id} is released`);
  assert.deepEqual(dispatchCandidates(db).find((p) => p.project === 'prj_1').items.map((i) => i.id).sort(), ['wi_author', 'wi_build'], 'and both are dispatched at the next tick');
  assert.equal(readWork(db, { project: 'prj_1' }).work_items.find((w) => w.id === 'wi_build').blocker, null);
});

test('an open requalification question no longer stands once an entry of the current mechanism is active: the next review invalidates it', (t) => {
  const db = store(t);
  hostRow(db, 'inc_1', 'mech-a');
  activeEntry(db);
  addItem(db, 'wi_build', 'stage_build');
  transact(db, ENGINE_ACTOR, (tx) => trust.lapseEarlierQualifications(tx, 'inc_2'));
  hostRow(db, 'inc_2', 'mech-b');
  refuseOnce(db, 'wi_build');
  const [q] = openRequalification(db);
  assert.ok(q, 'the question is raised');
  activeEntry(db);
  transact(db, ENGINE_ACTOR, (tx) => reviewDecisions(tx, { project: 'prj_1', channel: 'none' }));
  assert.deepEqual([decision(db, q.id).status, decision(db, q.id).invalidated_reason], ['invalidated', 'the question no longer stands']);
  assert.equal(dispatchBlocker(db, workItem(db, 'wi_build'), { check: false }), null, 'the item is dispatchable');
});

test("a refusal another cause makes is not held; a parked item's question names its last refusal's reason and what to do", (t) => {
  const db = store(t, { preflight_refusals_max: 1 });
  hostRow(db, 'inc_1', 'mech-a');
  activeEntry(db);
  transact(db, ENGINE_ACTOR, (tx) => trust.lapseEarlierQualifications(tx, 'inc_2'));
  hostRow(db, 'inc_2', 'mech-b');
  addItem(db, 'wi_build', 'stage_build');
  // At its limit the one refusal parks, as before (M134 (g)); the question
  // now says why and what would clear it.
  const { run } = refuseOnce(db, 'wi_build');
  const row = workItem(db, 'wi_build');
  assert.deepEqual([row.status, JSON.parse(row.blocker).reason], ['parked', 'preflight_refusals_max']);
  const d = db.prepare(`SELECT * FROM decisions WHERE kind = 'blocker' AND subject_type = 'work_item' AND subject_id = 'wi_build' AND status = 'open'`).get();
  assert.match(d.question, /refused before launch as often as policy allows \(its last refusal, run /);
  assert.ok(d.question.includes(`run ${run}: backend_refused: claude's entry`), d.question);
  assert.match(d.question, /needs requalification on this host\. Requalify it: surety qualify claude --mode one_shot_headless --model claude-sonnet-5-5/);
  assert.equal(openRequalification(db).length, 0, 'the parked item has its own question');

  // No entry at all (not a requalification): refused, counted, not held.
  const other = store(t);
  addItem(other, 'wi_x', 'stage_build');
  hostRow(other, 'inc_1', 'mech-a');
  refuseOnce(other, 'wi_x');
  assert.deepEqual([workItem(other, 'wi_x').status, workItem(other, 'wi_x').preflight_refusals], ['eligible', 1]);
  assert.equal(dispatchBlocker(other, workItem(other, 'wi_x'), { check: false }), null, 'retried at the next tick, as before (M11)');
  assert.equal(openRequalification(other).length, 0);
});
