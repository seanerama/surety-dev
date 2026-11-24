// Developer tests for "Waiting for Reviewer sign-off" (DECISIONS item 44;
// the owner's words of 2026-11-24: "When a deployment request queues the
// Reviewer, show 'Waiting for Reviewer sign-off' as soon as the engine
// confirms it, so the owner can tell that the click advanced the
// project."; M7 plan §3f M628).
//
// Against the scratch store of deploy-ask-fixtures.mjs (a T2 Node service,
// its build complete), its effective version holding the behavioural
// check, so a deployment request lacks only the tier's Reviewer sign-off:
// the refusal's `subject.review` naming the review the engine queued (or
// finds under way), none beside another lasting reason; the readiness
// `blocked` `signoff_pending` with `review`, its reason beginning "Waiting
// for Reviewer sign-off", NOW naming it; once signed off, `ready` and the
// request issued.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AT, ENGINE_ACTOR, OWNER, evaluateGate, readProject, requestDeployment, runFor, store, transact } from './deploy-ask-fixtures.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { BLOCKERS } = await import(join(dist, 'deploy', 'compatibility.js'));
const { REVIEW_WAIT_STATES } = await import(join(dist, 'store', 'transitions', 'alpha-review.js'));
const { recordReport } = await import(join(dist, 'store', 'transitions', 'findings.js'));
const { contentHash } = await import(join(dist, 'store', 'transitions', 'evidence.js'));
const { recordCheckResult } = await import(join(dist, 'store', 'transitions', 'baseline.js'));

const SEALED = { digest: 'sha256:' + 'd'.repeat(64), manifest: [], path: '/nowhere/artifact', bytes: 1, entries: 1, reused: 'new' };
const request = (fx, requested_by = 'human') =>
  transact(fx.db, requested_by === 'human' ? OWNER : ENGINE_ACTOR, (tx) =>
    requestDeployment(tx, { project: 'prj_1', candidate: 'cand_1', environment: 'alpha', sealed: SEALED, specFingerprint: 's', builder: 'b', facts: fx.facts, requested_by }, (tx2, a) => evaluateGate(tx2, a)),
  );
const project = (fx) => readProject(fx.db, { project: 'prj_1', trees: [fx.tree] }).project;
const reviews = (db) => db.prepare(`SELECT * FROM work_items WHERE kind = 'review' AND trigger_id = 'cand_1' ORDER BY trigger_generation`).all();
const codes = (res) => res.body.subject.reasons.map((r) => r.code);
const WAITING = /^Waiting for Reviewer sign-off: a deployment request to alpha was refused for the candidate's missing Reviewer sign-off alone \(SIGNOFF_MISSING\), and the engine's review of candidate cand_1 \(work item (\S+)\) (is queued|is under way \(run \S+\)|waits for your answer); once the Reviewer signs off, the deployment can be requested again\. The environment alpha can host this output \(Node service\) with local_service in service mode\.$/;

// The Reviewer's run on the review, signing what it was asked for (as
// alpha-gap-authoring.test.mjs's reviewerSigns).
function reviewerSigns(db, review) {
  db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(review);
  const hash = contentHash(db, 'prj_1', db.prepare(`SELECT * FROM candidates WHERE id = 'cand_1'`).get());
  db.prepare(
    `INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined, result_value, content_hash) VALUES ('run_sign', ?, 'prj_1', 900, ?, 'reviewer', 'one_shot', 'validating', 'scripted', '1', 'm', 'r', ?, 0, ?, ?)`,
  ).run(AT, review, AT, JSON.stringify({ report: { signoffs: [{ scope: 'candidate' }] } }), hash);
  transact(db, ENGINE_ACTOR, (tx) => recordReport(tx, { run: 'run_sign' }));
  db.prepare(`UPDATE runs SET state = 'ended' WHERE id = 'run_sign'`).run();
  db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ? AND status = 'executing'`).run(review);
}

test('the served names: signoff_pending among the blockers; three review states', () => {
  assert.deepEqual([...BLOCKERS], ['required_check_missing', 'serving_check_pending', 'checks_running', 'checks_unread', 'signoff_pending']);
  assert.deepEqual([...REVIEW_WAIT_STATES], ['queued', 'running', 'awaiting_owner']);
});

test("the owner's request refused for the sign-off alone names the review it queued; the readiness waits for Reviewer sign-off, NOW names it; again: the same review; running; then signed off, ready, issued", async (t) => {
  const fx = await store(t, { behaves: true });
  assert.equal(project(fx).build.deploy_readiness.state, 'ready', 'before any request: ready to request deployment (the request asks the Reviewer)');

  const refused = request(fx);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'authorization_not_issued');
  assert.deepEqual(codes(refused), ['SIGNOFF_MISSING']);
  const [review] = reviews(fx.db);
  assert.ok(review, 'the engine queued its review (alpha-review.ts)');
  assert.deepEqual(refused.body.subject.review, { state: 'queued', work_item: review.id });

  let p = project(fx);
  let r = p.build.deploy_readiness;
  assert.equal(r.state, 'blocked', JSON.stringify(r));
  assert.deepEqual(r.blocker, { what: 'signoff_pending', subject: 'SIGNOFF_MISSING' });
  assert.deepEqual(r.review, { state: 'queued', work_item: review.id, run: null });
  assert.equal(r.decision, null);
  assert.match(r.reason, WAITING);
  assert.equal(WAITING.exec(r.reason)[1], review.id);
  assert.notEqual(p.now.primary_action, 'deploy');
  assert.match(p.now.reason, /The planned build and its automated gates are complete\. It cannot be deployed to alpha yet: waiting for Reviewer sign-off: /, p.now.reason);
  assert.ok(p.now.reason.includes(review.id), 'NOW names the review');

  // Again while it is queued: the same review named, no second.
  const again = request(fx);
  assert.deepEqual([again.status, again.body.subject.review], [409, { state: 'queued', work_item: review.id }]);
  assert.equal(reviews(fx.db).length, 1);

  // Its Reviewer's run live.
  fx.db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(review.id);
  runFor(fx.db, 'run_r', review.id, 'executing', 'reviewer');
  r = project(fx).build.deploy_readiness;
  assert.deepEqual([r.state, r.review], ['blocked', { state: 'running', work_item: review.id, run: 'run_r' }]);
  assert.match(r.reason, /is under way \(run run_r\)/);
  assert.deepEqual(request(fx).body.subject.review, { state: 'running', work_item: review.id });
  assert.equal(reviews(fx.db).length, 1);

  // Signed off: ready, and the request issued.
  fx.db.prepare(`UPDATE runs SET state = 'ended' WHERE id = 'run_r'`).run();
  reviewerSigns(fx.db, review.id);
  r = project(fx).build.deploy_readiness;
  assert.equal(r.state, 'ready', JSON.stringify(r));
  assert.equal(r.review, undefined);
  const issued = request(fx);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
});

test('a review parked behind a question to the owner: awaiting_owner', async (t) => {
  const fx = await store(t, { behaves: true });
  request(fx);
  const [review] = reviews(fx.db);
  fx.db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = ?`).run(review.id);
  const r = project(fx).build.deploy_readiness;
  assert.deepEqual([r.blocker.what, r.review], ['signoff_pending', { state: 'awaiting_owner', work_item: review.id, run: null }]);
  assert.match(r.reason, /waits for your answer/);
  assert.deepEqual(request(fx).body.subject.review, { state: 'awaiting_owner', work_item: review.id });
});

test("the policy's request (settling on the review) names it too", async (t) => {
  const fx = await store(t, { behaves: true, policy: 'on_phase_complete' });
  const res = request(fx, 'policy');
  assert.equal(res.status, 409);
  assert.match(res.body.reason, /the policy requests it again/);
  const [review] = reviews(fx.db);
  assert.deepEqual(res.body.subject.review, { state: 'queued', work_item: review.id });
});

test('a refusal with SIGNOFF_MISSING beside another lasting reason carries no subject.review, and the readiness does not wait for the sign-off', async (t) => {
  const fx = await store(t, { behaves: true });
  // A failed result of a required check: CHECK_NOT_PASSED, lasting.
  transact(fx.db, ENGINE_ACTOR, (tx) => recordCheckResult(tx, { project: 'prj_1', check: 'chk_smoke_pv_1', candidate: 'cand_1', exit_status: 1 }, {}));
  const res = request(fx);
  assert.equal(res.status, 409);
  assert.deepEqual(codes(res).sort(), ['CHECK_NOT_PASSED', 'SIGNOFF_MISSING']);
  assert.equal(res.body.subject.review, undefined);
  assert.deepEqual(reviews(fx.db), [], 'no review asked while a check fails');
  const r = project(fx).build.deploy_readiness;
  assert.notEqual(r.blocker?.what, 'signoff_pending', JSON.stringify(r));
  assert.equal(r.review, undefined);
});
