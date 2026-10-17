// Developer tests for the driver's rulings on objection 166: a design batch
// is not raised while a correction of the protected checks is undecided (its
// question open), or approved and not applied yet; a correction its own
// obligations caused never defers it. Its work waits `awaiting_decision` with the blocker
// `design_batch_deferred` naming the corrections; nothing is asked; the wait
// is explained (awaiting.ts), so it is never a silent one; once no
// correction is pending, the batch is raised (here: refused at raise, the
// design being no longer proposed, so the path from deferral to the raise is
// exercised without a full design). Against a scratch store with the
// engine's migrations.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { finalizeProposal, raiseDeferredBatches, settleDeferredBatch } = await import(join(dist, 'spec', 'change.js'));
const { deferredBatches, pendingCorrections } = await import(join(dist, 'design', 'approval.js'));
const { registerAwaiting, settleAwaitingItem } = await import(join(dist, 'store', 'transitions', 'awaiting.js'));

const asked = [];
registerAwaiting({
  raiseQuestion: (_tx, a) => {
    asked.push(a);
    return { id: 'dec_blocker' };
  },
  correctionKind: () => undefined,
  proposalDecided: () => {},
  dropBlocker: () => {},
  deferredBatch: (tx, item) => settleDeferredBatch(tx, item),
});

function store() {
  const db = new Database(':memory:');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold", "repair_due", "chain")
     VALUES ('wi_sc', 't', 'p', 1, 'spec_change', '{}', 'executing', 'engine', 'x', 1, 0, 0, 0, 0, 0, 0)`,
  ).run();
  db.prepare(`INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "request_text", "source", "status", "work_item") VALUES ('scr_1', 't', 'p', 1, 'the design', 'design', 'requested', 'wi_sc')`).run();
  db.prepare(
    `INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "git_path", "revision", "blobs", "origin", "targets", "narrowings", "status", "assets_held", "findings", "spec_change_request")
     VALUES ('dsg_1', 't', 'p', 1, 'full', '.surety/design/design.json', 'r1', '{}', 'intended', '[]', '[]', 'proposed', '[]', '[]', 'scr_1')`,
  ).run();
  db.prepare(
    `INSERT INTO "protected_proposals" ("id", "created_at", "project", "seq", "proposed_by", "base_revision", "tree_id", "diff_hash", "affected_checks", "requested_change_kind", "status", "changes_required_set", "recommendations")
     VALUES ('prop_1', 't', 'p', 1, 'verifier_run', 'b', 't', 'h', '[]', 'unclassifiable', 'approved', 0, '[]')`,
  ).run();
  return db;
}

const inputs = {
  purpose: 'spec_change',
  ref: 'refs/surety/spec-change/1',
  ref_kind: 'spec_change',
  new_oid: 'c0ffee',
  request: 'scr_1',
  run: 'run_1',
  blob: 'blob_1',
  digest: null,
  representation: null,
  findings: [],
  readable: false,
  impact: { requirements: [] },
  impact_record: null,
};
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const decisions = (db) => db.prepare('SELECT "kind" FROM "decisions"').all().map((d) => d.kind);

test('a design proposal recorded while an approved correction is not applied raises nothing: its work waits, the blocker naming the correction', () => {
  const db = store();
  assert.deepEqual(pendingCorrections(db, 'p').map((c) => [c.proposal, c.status]), [['prop_1', 'approved']]);
  const out = transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  assert.deepEqual(out, { request: 'scr_1', decision: null, deferred: ['prop_1'] });
  assert.deepEqual(decisions(db), [], 'neither design_approval nor spec_change is raised');
  assert.equal(one(db, 'SELECT "status" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').status, 'proposed', 'the proposal is recorded');
  const w = one(db, 'SELECT "status", "blocker" FROM "work_items" WHERE "id" = ?', 'wi_sc');
  assert.equal(w.status, 'awaiting_decision');
  const blocker = JSON.parse(w.blocker);
  assert.equal(blocker.reason, 'design_batch_deferred');
  assert.deepEqual(blocker.pending_corrections, ['prop_1']);
  // What the design read shows (rule 25).
  const shown = deferredBatches(db, 'p');
  assert.equal(shown.length, 1);
  assert.deepEqual([shown[0].spec_change_request, shown[0].design_revision, shown[0].work_item, shown[0].pending_corrections], ['scr_1', 'dsg_1', 'wi_sc', [{ proposal: 'prop_1', status: 'approved', question: null }]]);
  assert.match(shown[0].reason, /correction/);
  // The wait is explained: no blocker question is raised for it.
  asked.length = 0;
  assert.equal(
    transact(db, ENGINE_ACTOR, (tx) => settleAwaitingItem(tx, 'wi_sc')),
    true,
  );
  assert.deepEqual(asked, [], 'no blocker question while the correction is pending');
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => raiseDeferredBatches(tx, 'p')), [], "the design's tick raises nothing while it is pending");
  assert.deepEqual(decisions(db), []);
});

test('with no approved correction pending, a design proposal is not deferred', () => {
  const db = store();
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'applied' WHERE "id" = 'prop_1'`).run();
  // The design no longer proposed: the batch's raise refuses it, so no full design is needed here.
  db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = 'dsg_1'`).run();
  const out = transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  assert.equal(out.deferred, undefined);
  assert.equal(one(db, 'SELECT "status", "failure" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').failure, 'design_batch_refused: the design is no longer proposed', 'raised at once (and refused, the design being superseded)');
});

test('once the correction is applied, the deferred batch is raised (here refused at raise, the design superseded), and its work no longer waits', () => {
  const db = store();
  transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  assert.equal(deferredBatches(db, 'p').length, 1);
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'applied' WHERE "id" = 'prop_1'`).run();
  db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = 'dsg_1'`).run();
  asked.length = 0;
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => settleAwaitingItem(tx, 'wi_sc')), true);
  assert.deepEqual(asked, [], 'no blocker question: the batch itself was taken up');
  const r = one(db, 'SELECT "status", "failure" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1');
  assert.deepEqual([r.status, r.failure], ['failed', 'design_batch_refused: the design is no longer proposed']);
  assert.equal(one(db, 'SELECT "status" FROM "work_items" WHERE "id" = ?', 'wi_sc').status, 'complete');
  assert.deepEqual(deferredBatches(db, 'p'), [], 'nothing deferred any more');
});

test('a correction whose approval is withdrawn back to the owner is undecided, so still pending; rejected, the batch is taken up', () => {
  const db = store();
  transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'awaiting_human' WHERE "id" = 'prop_1'`).run();
  db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = 'dsg_1'`).run();
  assert.deepEqual(pendingCorrections(db, 'p').map((c) => c.status), ['awaiting_human']);
  assert.deepEqual(transact(db, ENGINE_ACTOR, (tx) => raiseDeferredBatches(tx, 'p')), []);
  assert.equal(one(db, 'SELECT "status" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').status, 'proposed', 'still deferred');
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'rejected' WHERE "id" = 'prop_1'`).run();
  assert.deepEqual(pendingCorrections(db, 'p'), []);
  transact(db, ENGINE_ACTOR, (tx) => raiseDeferredBatches(tx, 'p'));
  assert.equal(one(db, 'SELECT "status" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').status, 'failed');
  assert.equal(one(db, 'SELECT "status" FROM "work_items" WHERE "id" = ?', 'wi_sc').status, 'complete');
});

test('an undecided correction, its question open, defers the batch too; the design read names the question', () => {
  const db = store();
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'awaiting_human' WHERE "id" = 'prop_1'`).run();
  db.prepare(
    `INSERT INTO "decisions" ("id", "created_at", "project", "seq", "kind", "subject_type", "subject_id", "status", "options", "dependency_manifest", "preview_hash", "semantic_generation",
       "scope", "question", "transition_schema_version", "evidence", "blocked_while_open", "raised_at")
     VALUES ('dec_c1', 't', 'p', 1, 'check_correction_unclassifiable', 'protected_proposal', 'prop_1', 'open', '[]', '{}', 'h', 1, 'project', 'q', 1, '{}', '{}', 't')`,
  ).run();
  const out = transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  assert.deepEqual(out.deferred, ['prop_1']);
  assert.deepEqual(decisions(db), ['check_correction_unclassifiable'], 'only the correction is asked: the batch is not');
  assert.deepEqual(deferredBatches(db, 'p')[0].pending_corrections, [{ proposal: 'prop_1', status: 'awaiting_human', question: 'dec_c1' }]);
  asked.length = 0;
  assert.equal(transact(db, ENGINE_ACTOR, (tx) => settleAwaitingItem(tx, 'wi_sc')), true);
  assert.deepEqual(asked, [], 'the wait is on the open question');
  // Rejected: no longer pending; the batch is taken up (here refused at raise, the design superseded).
  db.prepare(`UPDATE "protected_proposals" SET "status" = 'rejected' WHERE "id" = 'prop_1'`).run();
  db.prepare(`UPDATE "decisions" SET "status" = 'consumed' WHERE "id" = 'dec_c1'`).run();
  db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = 'dsg_1'`).run();
  transact(db, ENGINE_ACTOR, (tx) => raiseDeferredBatches(tx, 'p'));
  assert.equal(one(db, 'SELECT "status" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').status, 'failed');
});

test("no cycle: a correction the request's own obligations caused never defers that request's batch; it defers another's", () => {
  const db = store();
  // prop_1 is the proposal of the check_correction item scr_1's obligations registered.
  db.prepare(
    `INSERT INTO "work_items" ("id", "created_at", "project", "seq", "kind", "subject", "status", "trigger_source", "trigger_id", "trigger_generation", "repair_attempts", "no_progress_count", "preflight_refusals", "dispatch_hold", "repair_due", "chain")
     VALUES ('wi_cc', 't', 'p', 2, 'check_correction', '{"request":"scr_1"}', 'awaiting_decision', 'spec_obligation', 'scr_1', 1, 0, 0, 0, 0, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO "runs" ("id", "created_at", "project", "seq", "work_item", "role", "kind", "state", "backend", "backend_version", "model_requested", "base_revision", "deadline_at", "quarantined")
     VALUES ('run_cc', 't', 'p', 1, 'wi_cc', 'verifier', 'one_shot', 'ended', 'scripted', '1', 'm', 'b', 't', 0)`,
  ).run();
  db.prepare(`UPDATE "protected_proposals" SET "run" = 'run_cc', "status" = 'awaiting_human' WHERE "id" = 'prop_1'`).run();
  assert.deepEqual(pendingCorrections(db, 'p', 'scr_1'), [], "scr_1's own correction is not pending for scr_1");
  assert.deepEqual(pendingCorrections(db, 'p', 'scr_2').map((c) => c.proposal), ['prop_1'], 'it is for another request');
  assert.deepEqual(pendingCorrections(db, 'p').map((c) => c.proposal), ['prop_1']);
  // finalizeProposal of scr_1 is not deferred by it (raised at once; refused here, the design superseded).
  db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = 'dsg_1'`).run();
  const out = transact(db, ENGINE_ACTOR, (tx) => finalizeProposal(tx, { id: 'op_1', project: 'p' }, inputs));
  assert.equal(out.deferred, undefined, 'not deferred by its own correction');
  assert.equal(one(db, 'SELECT "status" FROM "spec_change_requests" WHERE "id" = ?', 'scr_1').status, 'failed');
});
