// M628, waiting for Reviewer sign-off (slice 49; kernel lane). M7 plan §3f
// M628; D3 §4.1; D4 §4.1; D6 §6.8; DECISIONS item 44. Sean, 2026-11-24,
// verbatim: "Track SIGNOFF_MISSING separately. When a deployment request
// queues the Reviewer, show “Waiting for Reviewer sign-off” as soon as the
// engine confirms it, so the owner can tell that the click advanced the
// project."
//
// (a) a candidate whose `alpha_authorize` lacks only the tier's Reviewer
//     sign-off (T2): the owner's deployment request refused 409
//     `authorization_not_issued` with SIGNOFF_MISSING the only reason and
//     `subject.review {state: 'queued', work_item}` naming the review the
//     engine queued (one `review` work item for the candidate and content, as
//     alpha-review.ts); `deploy_readiness` `blocked`, `blocker {what:
//     'signoff_pending', subject: 'SIGNOFF_MISSING'}`, `review {state,
//     work_item, run}`, the reason beginning "Waiting for Reviewer sign-off";
//     `primary_action` never `deploy` (null, or `tick` while the queued review
//     is eligible and not yet dispatched; the driver's companion 8b74035b);
//     the NOW sentence names it. The request made again
//     while the review is under way: 409 with `subject.review` `queued` or
//     `running`, no second review. The Reviewer signs off (scripted): `ready`;
//     the request again issued (201).
// (b) a refusal with SIGNOFF_MISSING beside another lasting reason carries no
//     `subject.review`, and the readiness names the other blocker as today.
//
// The fixture is M626 (a)'s: a Node service declaring serving whose project
// has its required post_deploy_behavior check; the engine's serving check
// proposed, approved and applied. The applied version changes the acceptance
// content the candidate's Reviewer sign-off binds, so the candidate then
// lacks only that sign-off (M626's reading 4; alpha-review.ts). (b) is the
// same service without its behavioural check (M626 (b)): after the serving
// check is applied, a request is refused for the missing behavioural check
// beside the sign-off.
//
// Readings this file makes (the report says them):
// - "queued" in the first refusal is the state at the answer; the engine may
//   start the review at its next tick, so the read after reads `queued` or
//   `running`, and the hold the scripted Reviewer waits at shows `running`
//   with its run.
// - `review.state` `awaiting_owner` (DECISIONS item 44) is not exercised: the
//   scripted Reviewer signs off.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { KERNEL_KINDS } from './harness/design/check41.mjs';
import { stageWork } from './harness/design/drive.mjs';
import { proposalsOf, sharedFixture } from './harness/gates.mjs';
import { roleThat, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { journeyContext, phaseCompleted } from './harness/journey/drive.mjs';
import { idle, recordChecks } from './harness/prototype.mjs';
import { runsOf, scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, putConfig, qualifyByFixture, requestDeployment } from './harness/deploy/kernel.mjs';
import { PAGE_AUTHORING, PAGE_BUILT, pagePublished, pageScripts } from './harness/deploy/static-journey.mjs';

const SIGNOFF = Object.freeze({ what: 'signoff_pending', subject: 'SIGNOFF_MISSING' });

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));
const engineProposals = (home, project) => proposalsOf(home, project).filter((x) => x.proposed_by === 'engine');
const proposalStatus = (home, id) => all(home, 'SELECT "status" FROM "protected_proposals" WHERE "id" = ?', id)[0]?.status ?? null;
// The engine's reviews of the candidate (alpha-review.ts reviewsOf), oldest first.
const reviewsOf = (home, project, candidate) =>
  all(home, `SELECT "id", "status", "trigger_generation", "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'review' AND "trigger_source" = 'verification' AND "trigger_id" = ? ORDER BY rowid`, project, candidate).map((w) => ({
    ...w,
    trigger_evidence: parse(w.trigger_evidence),
  }));
const alphaReviews = (home, project, candidate) => reviewsOf(home, project, candidate).filter((w) => w.trigger_evidence?.gate === 'alpha_authorize');
const queuedExecutions = (home, project) => all(home, `SELECT x."id" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" = 'queued'`, project);
const codesOf = (res) => (res.body?.subject?.reasons ?? []).map((r) => r.code);
const reviewItem = (r) => {
  const w = r?.work_item;
  return typeof w === 'string' ? w : (w?.id ?? null);
};

// ---- the projects (M626's) -------------------------------------------------------------------

const SERVED = Object.freeze({ root: 'web', entry: 'index.html' });
const SERVER = 'web/server.mjs';
const SERVICE_BUILT = Object.freeze({
  ...PAGE_BUILT,
  'web/index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><ul id="items"></ul></body></html>\n',
  [SERVER]: "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n",
});
const BEHAVIOUR_PROGRAM = '.surety/checks/post-deploy/operation.mjs';
const WITH_BEHAVIOUR = Object.freeze({
  ...PAGE_AUTHORING,
  [BEHAVIOUR_PROGRAM]: "const r = await fetch(process.env.SURETY_TARGET_APP ?? 'http://127.0.0.1:8080/');\nprocess.exit(r.ok ? 0 : 1);\n",
  '.surety/checks/defs/operation.json': definitionText('operation', {
    inputs: [BEHAVIOUR_PROGRAM],
    kind: 'post_deploy_behavior',
    command: ['node', BEHAVIOUR_PROGRAM],
    timeout_s: 120,
    gate_kinds: ['alpha_complete'],
    requires: ['environment', 'artifact_digest'],
  }),
});
const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));

async function builtWith(fx, p, { built, authoring = PAGE_AUTHORING }) {
  pageScripts(fx);
  fx.scripted.kindScript('check_authoring', [0, 1, 2, 3].map(() => roleThat(writes(authoring), { proposal: { rationale: "The Verifier authors phase 1's checks before any stage builds.", requested_change_kind: 'unclassifiable' } })));
  const w = stageWork(fx.home, p.id, 1);
  assert.ok(w, 'the published plan has its stage_build work item');
  fx.scripted.script(w.id, [0, 1, 2].map(() => roleThat(writes(built))));
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  return phaseCompleted(fx, ctx, 1, { max: 160 });
}

const SERVICE_CONFIG = (port) => configContent({ start: [process.execPath, SERVER], port, serving: SERVED });

async function settled(fx, project) {
  await idle(fx, project);
  await tick(fx.engine, project);
  await idle(fx, project);
}

async function projectBody(fx, project) {
  const p = await fx.engine.get(`/v1/projects/${project}`);
  assert.equal(p.status, 200, `GET /v1/projects/${project} (→ ${p.status} ${p.text})`);
  return p.body.project;
}

// The service built, configured declaring serving, and the engine's serving
// check proposed, approved by the owner and applied, the candidate's checks
// passed again. Returns the project read after.
async function servingApplied(fx, p, { authoring }) {
  await builtWith(fx, p, { built: SERVICE_BUILT, authoring });
  await qualifyByFixture(fx.engine);
  await settled(fx, p.id);
  const res = await putConfig(fx.engine, p.id, 'alpha', SERVICE_CONFIG(authoring === WITH_BEHAVIOUR ? 18681 : 18682));
  assert.ok([200, 201].includes(res.status), `PUT …/environments/alpha/config (→ ${res.status} ${res.text})`);
  const [proposal] = engineProposals(fx.home, p.id);
  assert.ok(proposal, 'the engine proposed its serving check');
  const decision = await openDecision(fx, p.id, 'check_correction_tightening', proposal.id, { max: 8 });
  await consume(fx, p.id, decision, 'approve');
  for (let i = 0; i < 8 && proposalStatus(fx.home, proposal.id) !== 'applied'; i++) {
    await tick(fx.engine, p.id);
    await idle(fx, p.id);
  }
  assert.equal(proposalStatus(fx.home, proposal.id), 'applied', "the engine's serving check applied");
  // The applied version makes the candidate's checks run again: their
  // executions recorded (exit 0) until none is queued and the readiness no
  // longer waits for them (for the service with its behavioural check, until
  // `ready`).
  let read = await projectBody(fx, p.id);
  for (let i = 0; i < 8; i++) {
    const d = read.build.deploy_readiness;
    if (queuedExecutions(fx.home, p.id).length === 0 && d.blocker?.what !== 'checks_running' && (authoring !== WITH_BEHAVIOUR || d.state === 'ready')) break;
    await recordChecks(fx, p.id);
    await tick(fx.engine, p.id);
    await idle(fx, p.id);
    read = await projectBody(fx, p.id);
  }
  return read;
}

// The engine's Reviewer, asked for the sign-off: it waits at a hold (the
// test reads `running`), then signs the candidate off.
const HELD_REVIEW = { steps: [step.hold('gate'), { review_auto: { reason: 'The candidate meets its acceptance scope.' } }] };

// ---- (a) the sign-off alone ------------------------------------------------------------------

describe('M628 (a) a candidate lacking only the Reviewer sign-off: the request queues the review and says so; the readiness waits for it; signed off, issued', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-signoff-a' });
    J.p = p;
    J.readyBefore = await servingApplied(fx, p, { authoring: WITH_BEHAVIOUR });
    const candidate = J.readyBefore.checks.candidate;
    J.candidate = candidate;
    fx.scripted.kindScript('review', HELD_REVIEW);
    J.reviewsBefore = alphaReviews(fx.home, p.id, candidate);
    J.first = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
    J.reviewsFirst = alphaReviews(fx.home, p.id, candidate);
    J.queued = await projectBody(fx, p.id);
    J.again = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
    J.reviewsAgain = alphaReviews(fx.home, p.id, candidate);
    const item = J.reviewsFirst.at(-1)?.id;
    if (J.first.status !== 409 || !item) return;
    J.item = item;
    J.held = await runToHold(fx, p.id, item);
    J.running = await projectBody(fx, p.id);
    J.againRunning = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
    J.reviewsRunning = alphaReviews(fx.home, p.id, candidate);
    J.runs = runsOf(fx.home, item).length;
    fx.scripted.release(item);
    await idle(fx, p.id);
    J.signed = await projectBody(fx, p.id);
    for (let i = 0; i < 8 && J.signed.build.deploy_readiness.state !== 'ready'; i++) {
      await tick(fx.engine, p.id);
      await idle(fx, p.id);
      J.signed = await projectBody(fx, p.id);
    }
    J.issued = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
  });
  after(async () => {
    J.fx?.scripted.release('all');
    await shared.cleanup();
  });

  test('(a) the fixture: ready before the request, the serving check applied', (t) => {
    t.diagnostic(`readiness before the request: ${JSON.stringify(J.readyBefore.build.deploy_readiness)}`);
    assert.equal(J.readyBefore.build.deploy_readiness.state, 'ready', JSON.stringify(J.readyBefore.build.deploy_readiness));
    assert.deepEqual(J.reviewsBefore, [], 'no review asked for the deployment before the request');
  });

  test('(a) the request refused authorization_not_issued, SIGNOFF_MISSING the only reason, subject.review {queued, work_item} naming the one review the engine queued', (t) => {
    t.diagnostic(`first: ${J.first.status} ${J.first.text}`);
    assert.equal(J.first.status, 409, J.first.text);
    assert.equal(J.first.body.code, 'authorization_not_issued');
    assert.deepEqual(codesOf(J.first), ['SIGNOFF_MISSING'], J.first.text);
    assert.equal(J.reviewsFirst.length, 1, `one review asked for the candidate and content (${JSON.stringify(J.reviewsFirst)})`);
    const ev = J.reviewsFirst[0].trigger_evidence;
    assert.equal(ev.acceptance_content_hash.length > 0, true, JSON.stringify(ev));
    const r = J.first.body.subject?.review;
    assert.ok(r && typeof r === 'object', `subject.review (${J.first.text})`);
    assert.equal(r.state, 'queued', JSON.stringify(r));
    assert.equal(reviewItem(r), J.reviewsFirst[0].id, JSON.stringify(r));
  });

  test('(a) the readiness: blocked signoff_pending, review {state, work_item, run}, the reason beginning "Waiting for Reviewer sign-off"; primary_action never deploy; the NOW sentence names it', (t) => {
    for (const [what, read, states, run] of [
      ['after the request', J.queued, ['queued', 'running'], undefined],
      ['the review running', J.running, ['running'], J.held?.run.id],
    ]) {
      assert.ok(read, `${what} was read`);
      const d = read.build.deploy_readiness;
      t.diagnostic(`${what}: ${JSON.stringify(d)}; now ${JSON.stringify(read.now)}`);
      assert.equal(d.state, 'blocked', `${what}: ${JSON.stringify(d)}`);
      assert.deepEqual(d.blocker, SIGNOFF, `${what}: ${JSON.stringify(d)}`);
      assert.ok(d.review && typeof d.review === 'object', `${what}: review (${JSON.stringify(d)})`);
      assert.ok(states.includes(d.review.state), `${what}: ${JSON.stringify(d.review)}`);
      assert.equal(reviewItem(d.review), J.item ?? J.reviewsFirst[0]?.id, `${what}: the review's work item (${JSON.stringify(d.review)})`);
      assert.ok(Object.hasOwn(d.review, 'run'), `${what}: review.run (${JSON.stringify(d.review)})`);
      if (run !== undefined) assert.equal(d.review.run, run, `${what}: the run named`);
      if (d.review.state === 'queued') assert.equal(d.review.run, null, `${what}: no run while queued`);
      assert.ok(d.reason.startsWith('Waiting for Reviewer sign-off'), `${what}: ${d.reason}`);
      // Never deploy: null, or `tick` while the queued review is eligible and
      // not yet dispatched (the driver's companion 8b74035b).
      assert.ok(read.now.primary_action === null || (read.now.primary_action === 'tick' && d.review.state === 'queued'), `${what}: ${JSON.stringify(read.now)}`);
      assert.match(read.now.reason, /waiting for Reviewer sign-off/i, `${what}: the NOW sentence names it (${read.now.reason})`);
    }
  });

  test('(a) the request again while the review is under way: 409 with subject.review queued or running; no second review', () => {
    for (const [what, res, states] of [
      ['queued', J.again, ['queued', 'running']],
      ['running', J.againRunning, ['running']],
    ]) {
      assert.equal(res?.status, 409, `${what}: ${res?.text}`);
      assert.equal(res.body.code, 'authorization_not_issued');
      assert.deepEqual(codesOf(res), ['SIGNOFF_MISSING'], res.text);
      const r = res.body.subject?.review;
      assert.ok(r && states.includes(r.state), `${what}: ${JSON.stringify(r)}`);
      assert.equal(reviewItem(r), J.item, `${what}: the same review`);
    }
    assert.deepEqual(J.reviewsAgain.map((w) => w.id), [J.item], 'no second review (queued)');
    assert.deepEqual(J.reviewsRunning.map((w) => w.id), [J.item], 'no second review (running)');
    assert.equal(J.runs, 1, 'one run of the review');
  });

  test('(a) the Reviewer signs off: ready; the request again issued (201)', () => {
    const d = J.signed.build.deploy_readiness;
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(d.blocker ?? null, null);
    assert.equal(J.signed.now.primary_action, 'deploy', JSON.stringify(J.signed.now));
    assert.equal(J.issued.status, 201, J.issued.text);
    assert.equal(J.issued.body.authorization?.status, 'issued', J.issued.text);
  });
});

// ---- (b) the sign-off beside another lasting reason ----------------------------------------------

describe('M628 (b) SIGNOFF_MISSING beside the missing behavioural check: no subject.review; the readiness names the other blocker', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-signoff-b' });
    J.p = p;
    J.prior = await servingApplied(fx, p, { authoring: PAGE_AUTHORING });
    const candidate = J.prior.checks.candidate;
    // Whatever the request asks of the roles waits at a hold.
    fx.scripted.kindScript('review', HELD_REVIEW);
    fx.scripted.kindScript('check_authoring', roleThatHolds([], [], { proposal: { rationale: 'held', requested_change_kind: 'tightening' } }));
    J.reviewsBefore = alphaReviews(fx.home, p.id, candidate);
    J.res = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
    J.reviewsAfter = alphaReviews(fx.home, p.id, candidate);
    J.read = await projectBody(fx, p.id);
  });
  after(async () => {
    J.fx?.scripted.release('all');
    await shared.cleanup();
  });

  test('(b) refused with SIGNOFF_MISSING beside ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior: no subject.review, no review queued', (t) => {
    t.diagnostic(`request: ${J.res.status} ${J.res.text}`);
    assert.equal(J.res.status, 409, J.res.text);
    assert.equal(J.res.body.code, 'authorization_not_issued');
    const codes = codesOf(J.res);
    assert.ok(codes.includes('SIGNOFF_MISSING') && codes.includes('ACCEPTANCE_SCOPE_INCOMPLETE'), `the sign-off beside another lasting reason (${JSON.stringify(J.res.body.subject?.reasons)})`);
    assert.equal(J.res.body.subject?.review ?? null, null, `no subject.review (${JSON.stringify(J.res.body.subject)})`);
    assert.deepEqual(J.reviewsAfter, J.reviewsBefore, 'no review asked for the deployment');
  });

  test('(b) the readiness names the other blocker as today: blocked, required_check_missing kind:post_deploy_behavior; no review', (t) => {
    const d = J.read.build.deploy_readiness;
    t.diagnostic(JSON.stringify(d));
    assert.equal(d.state, 'blocked', JSON.stringify(d));
    assert.deepEqual(d.blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' }, JSON.stringify(d));
    assert.equal(d.review ?? null, null, JSON.stringify(d));
    assert.ok(!d.reason.startsWith('Waiting for Reviewer sign-off'), d.reason);
  });
});
