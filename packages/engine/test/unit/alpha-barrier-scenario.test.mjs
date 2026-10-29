// The adopted-project Alpha barrier through one concrete scenario (the
// owner's request of 2026-10-29: "Explain in one concrete before/after
// example what the proposed adopted-project barrier reversal permits or
// prevents"). It drives adopt/conformance.ts alphaBarrier and
// inConformancePhase, as built now (follow-up B: the barrier reads history),
// through: phase 1 (conformance) complete; the owner's deploy of c-1 (the
// adopted source A) verified; then either a finalized teardown of alpha
// (prototype.ts withdrawAlpha) or a change-phase candidate c-2 replacing c-1
// there (prototype.ts replaceAlpha); then the change-phase plan's
// publication (bundle.ts: markStale of the whole project).
//
// The expected values are this branch's. The values of the M5-accepted code
// (main fec0d67e: no withdrawal on teardown, no replacement rule, the
// barrier reading `progress = alpha_deployed`) and of E5 (4bb74433:
// withdrawal on teardown, no replacement rule, the same barrier) are quoted
// in the comments from those commits' code, not asserted here.

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
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { alphaBarrier, inConformancePhase, conformancePhaseComplete } = await import(join(dist, 'adopt', 'conformance.js'));
const { withdrawAlpha, replaceAlpha } = await import(join(dist, 'store', 'transitions', 'prototype.js'));
const { markStale } = await import(join(dist, 'store', 'transitions', 'evidence.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-29T00:00:00.000Z';
const A = 'a'.repeat(40);
const DIGEST_A = 'd'.repeat(64);
const DIGEST_B = 'e'.repeat(64);

// An adopted project (source A) whose phase 1, its conformance phase, is
// complete, with c-1 (A's candidate) nominated and an environment alpha.
function adopted(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surety-barrier-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management, adoption)
     VALUES ('prj_a', ?, 'sums', 'T1', ?, 'main', 'spec_ready', 'registered', '{}', ?)`,
  ).run(AT, join(dir, 'repo'), JSON.stringify({ pinned_revision: A, source_digest: DIGEST_A, mode: 'full' }));
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, current_generation) VALUES ('env_alpha', ?, 'prj_a', 'alpha', 'local_service', 'x', '{}', 1)`).run(AT);
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at) VALUES ('plan_1', ?, 'prj_a', 1, ?, 'p1.json', 1, 1, 'completed', ?)`).run(AT, A, AT);
  candidate(db, 'c1', 1, DIGEST_A);
  return db;
}
function candidate(db, id, seq, digest) {
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, held_work, source_digest) VALUES (?, ?, 'prj_a', ?, ?, 'lin_1', ?, 'engine_cadence', 'developing', '[]', ?)`,
  ).run(id, AT, seq, `${seq}`.repeat(40), AT, digest);
}
let opSeq = 0;
// A deploy operation of `candidate` to alpha, finalized (applied), with its
// request `outcome` (deployed: verified and completed).
function deployment(db, n, candidateId, outcome) {
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, outcome) VALUES (?, ?, 'prj_a', ?, 'human', ?, 'env_alpha', ?, ?)`).run(`dreq_${n}`, AT, `k${n}`, candidateId, `auth_${n}`, outcome);
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, authorization, finalized_at)
     VALUES (?, ?, 'prj_a', ?, 'deploy', '{"environment":"env_alpha"}', '{}', ?, 1, 'succeeded', ?, ?, ?)`,
  ).run(`op_${n}`, AT, ++opSeq, `key_${n}`, AT, `auth_${n}`, AT);
}
// The owner's deploy of c-1 verified: its request deployed, alpha_complete
// satisfied and current, and the advance recorded in the evaluation's
// transaction (candidate.advanced, D4 §5.5).
function alphaOfC1(db) {
  deployment(db, 1, 'c1', 'deployed');
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale)
     VALUES ('ge_c1', ?, 'prj_a', 'sc_1', 'c1', 'alpha_complete', ?, 'h', '{}', '{}', 'satisfied', '[]', '[]', 0)`,
  ).run(AT, AT);
  transact(db, ENGINE_ACTOR, (tx) => {
    tx.db.prepare(`UPDATE candidates SET progress = 'alpha_deployed' WHERE id = 'c1'`).run();
    tx.emit('candidate.advanced', { project: 'prj_a', candidate: 'c1' }, { from: 'developing', to: 'alpha_deployed' });
  });
}
const state = (db) => {
  const b = alphaBarrier(db, 'prj_a');
  return { open: b.open, candidate: b.candidate, conformance_phase: inConformancePhase(db, 'prj_a'), c1: db.prepare(`SELECT progress FROM candidates WHERE id = 'c1'`).get().progress };
};
const CLOSED = { open: false, candidate: null, conformance_phase: true };

test('the barrier before and after the adopted code reaches Alpha: closed (CONFORMANCE_ALPHA_PENDING) until c-1 is deployed and verified, then open (the replan step may create the change-phase replan)', (t) => {
  const db = adopted(t);
  assert.ok(conformancePhaseComplete(db, 'prj_a'), 'phase 1 complete');
  assert.deepEqual(state(db), { ...CLOSED, c1: 'developing' });
  assert.match(alphaBarrier(db, 'prj_a').reason, /^CONFORMANCE_ALPHA_PENDING: .*waits for the owner's deployment of the adopted code and its verification$/);
  alphaOfC1(db);
  // (i), (ii) and (iii) alike: open, c-1 named.
  assert.deepEqual(state(db), { open: true, candidate: 'c1', conformance_phase: false, c1: 'alpha_deployed' });
});

test('scenario T: alpha torn down after the barrier opened, before the change-phase plan is published: the barrier stays open (as M5 had it); then the publication marks c-1\'s alpha_complete stale and closes it, in every version', (t) => {
  const db = adopted(t);
  alphaOfC1(db);
  // The teardown finalized (deploy.ts finalizeDeploy → withdrawAlpha).
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => withdrawAlpha(tx, { project: 'prj_a', environment: 'env_alpha', operation: 'op_td' })), ['c1']);
  // (iii), follow-up B: c-1 developing now, its advance recorded: open.
  //   (i)  main fec0d67e: no withdrawal on teardown; c-1 stays alpha_deployed: open.
  //   (ii) E5 4bb74433: withdrawn as here, and the barrier read
  //        `if (c.progress !== 'alpha_deployed') continue;`: closed,
  //        CONFORMANCE_ALPHA_PENDING, inConformancePhase true.
  assert.deepEqual(state(db), { open: true, candidate: 'c1', conformance_phase: false, c1: 'developing' });
  // The change-phase plan published (plan/bundle.ts: markStale of the
  // project): every gate evaluation of the project is stale, c-1's
  // alpha_complete with it, and the barrier needs it not stale. Identical
  // in (i), (ii) and (iii): that line did not change.
  transact(db, ENGINE_ACTOR, (tx) => markStale(tx, { project: 'prj_a' }));
  assert.deepEqual(state(db), { ...CLOSED, c1: 'developing' });
});

test('scenario R: a change-phase candidate c-2 replaces c-1 on alpha. c-2 exists only after the change-phase plan is published, so the barrier is already closed (stale) when it does, in every version; the replacement changes nothing observable. Taken out of that order, (iii) keeps it open as M5 did', (t) => {
  const db = adopted(t);
  alphaOfC1(db);
  // The reachable order: the change-phase plan published first (c-2 is
  // built by its stage work), which marks c-1's alpha_complete stale.
  transact(db, ENGINE_ACTOR, (tx) => markStale(tx, { project: 'prj_a' }));
  assert.deepEqual(state(db), { ...CLOSED, c1: 'alpha_deployed' }, 'closed by the stale evaluation, c-1 still alpha_deployed: (i), (ii), (iii) alike');
  candidate(db, 'c2', 2, DIGEST_B);
  // c-2's deploy applied (finalized), its verification still ahead.
  deployment(db, 2, 'c2', 'pending');
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => replaceAlpha(tx, { project: 'prj_a', environment: 'env_alpha', operation: 'op_2', candidate: 'c2' })), ['c1']);
  //   (i)  main fec0d67e: no replacement rule; c-1 stays alpha_deployed; closed (stale).
  //   (ii) E5 4bb74433: no replacement rule either; closed (stale).
  //   (iii) here: c-1 developing (replaced); closed (stale).
  assert.deepEqual(state(db), { ...CLOSED, c1: 'developing' });
  // c-2 is not A's: it never opens the barrier, deployed and verified or not.
  db.prepare(`UPDATE deployment_requests SET outcome = 'deployed' WHERE id = 'dreq_2'`).run();
  db.prepare(`UPDATE candidates SET progress = 'alpha_deployed' WHERE id = 'c2'`).run();
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale)
     VALUES ('ge_c2', ?, 'prj_a', 'sc_2', 'c2', 'alpha_complete', ?, 'h', '{}', '{}', 'satisfied', '[]', '[]', 0)`,
  ).run(AT, AT);
  assert.deepEqual(state(db), { ...CLOSED, c1: 'developing' });
});

test('scenario R out of the reachable order (a replacement while c-1\'s alpha_complete is still current): (iii) open, as (i) and (ii) were; (ii) applied to this branch would close it', (t) => {
  const db = adopted(t);
  alphaOfC1(db);
  candidate(db, 'c2', 2, DIGEST_B);
  deployment(db, 2, 'c2', 'pending');
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => replaceAlpha(tx, { project: 'prj_a', environment: 'env_alpha', operation: 'op_2', candidate: 'c2' })), ['c1']);
  //   (i), (ii): no replacement rule; c-1 stays alpha_deployed: open.
  //   (ii) applied to this branch (the barrier line reverted, the
  //        replacement rule kept): c-1 developing: closed.
  assert.deepEqual(state(db), { open: true, candidate: 'c1', conformance_phase: false, c1: 'developing' });
});
