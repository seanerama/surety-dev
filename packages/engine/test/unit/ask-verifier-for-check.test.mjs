// Developer tests for the owner's request for the missing deployment check
// (DECISIONS item 43; the owner's words of 2026-11-24: "On the Everyday
// Workspace card that says the behavioral check is missing, provide one
// action: 'Ask Verifier to write the check.' ... Repeated clicks and
// refreshes should reuse the same work. ... For manual policy, that click
// is the owner's instruction to start authoring. For automatic deployment,
// use the existing policy authorization when it already covers the work.";
// M7 plan §3f M627).
//
// Against a scratch store with the engine's migrations, foreign keys off (as
// alpha-gap-authoring.test.mjs and serving-check-visibility.test.mjs): the
// route's transaction (requestEnvironmentChecks) through the production
// evaluateGate, its answers and refusals, `reused`, who asked; the
// readiness's `authoring` in each state and its `offer`. Then the route on
// the kernel lane through the engine's API.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AT,
  BEHAVES,
  CHECKS,
  ENGINE_ACTOR,
  OWNER,
  ask,
  authorings,
  authorizeEvaluations,
  count,
  decide,
  evaluateGate,
  nextExecutionSeq,
  post,
  proposalOf,
  readProject,
  readiness,
  requestDeployment,
  roleModelOf,
  runFor,
  store,
  transact,
  version,
} from './deploy-ask-fixtures.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { GAP_AUTHORING_STATES } = await import(join(dist, 'store', 'transitions', 'alpha-gap.js'));

const BLOCKED_ON_BEHAVIOUR = { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' };

test('the served names: five authoring states', () => {
  assert.deepEqual([...GAP_AUTHORING_STATES], ['none', 'queued', 'running', 'awaiting_review', 'applied']);
});

test("before the request: blocked on the behavioural check, authoring none with the owner's request offered and its consequence naming the Verifier and its model", async (t) => {
  const fx = await store(t);
  const r = readiness(fx);
  assert.equal(r.state, 'blocked', JSON.stringify(r));
  assert.deepEqual(r.blocker, BLOCKED_ON_BEHAVIOUR);
  const rm = roleModelOf(fx.db, 'prj_1', 'verifier');
  // The model the Verifier's run records (runs.ts: model_verifier, the
  // schema's default here), not the backend's (objection 232).
  const on = `the configured model sonnet${rm.provider !== 'sonnet' ? ` (${rm.provider})` : ''}`;
  const refused = rm.resolution === 'refused' ? ` The Verifier role's backend is refused now (${rm.refusal}): the run is dispatched only once it resolves.` : '';
  assert.deepEqual(r.authoring, {
    state: 'none',
    work_item: null,
    run: null,
    proposal: null,
    decision: null,
    offer: {
      method: 'POST',
      path: '/v1/projects/prj_1/environments/alpha/request-checks',
      consequence_text: `Queues a Verifier check-authoring run on ${on}: it writes the missing post_deploy_behavior check as a proposal you review; nothing is deployed.${refused}`,
    },
  });
  assert.equal(readProject(fx.db, { project: 'prj_1', trees: [fx.tree] }).project.now.primary_action, null, 'never deploy while blocked');
  assert.deepEqual(authorings(fx.db), [], 'a read queues nothing');
  assert.deepEqual(authorizeEvaluations(fx.db), [], 'a read evaluates nothing');
});

test("objection 232: the consequence names the model the Verifier's run records (the project's model_verifier), the backend and its refusal beside it", async (t) => {
  const fx = await store(t, { effective: { model_verifier: 'sonnet-avb-verifier' } });
  const rm = roleModelOf(fx.db, 'prj_1', 'verifier');
  const refused = rm.resolution === 'refused' ? ` The Verifier role's backend is refused now (${rm.refusal}): the run is dispatched only once it resolves.` : '';
  assert.equal(
    readiness(fx).authoring.offer.consequence_text,
    `Queues a Verifier check-authoring run on the configured model sonnet-avb-verifier (${rm.provider}): it writes the missing post_deploy_behavior check as a proposal you review; nothing is deployed.${refused}`,
  );
});

test("the owner's request: 202 queued, one authoring_gap check_authoring naming the gate, the environment, what is missing and who asked; no deployment; again: reused, the same work", async (t) => {
  const fx = await store(t);
  const first = ask(fx);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const [w] = authorings(fx.db);
  assert.deepEqual(first.body, { work_item: w.id, state: 'queued', proposal: null, decision: null, reused: false, requested_by: 'human' });
  assert.deepEqual([w.trigger_source, w.trigger_id, w.status], ['authoring_gap', 'plan_1', 'eligible']);
  const { deployment } = JSON.parse(w.trigger_evidence);
  assert.equal(deployment.gate, 'alpha_authorize');
  assert.equal(deployment.environment, 'alpha');
  assert.equal(deployment.candidate, 'cand_1');
  assert.deepEqual(deployment.missing, { kinds: ['post_deploy_behavior'], criteria: [], areas: [] });
  assert.equal(deployment.requested_by, 'human');
  assert.deepEqual(deployment.targets, [{ name: 'web', variable: 'SURETY_TARGET_WEB' }]);
  // The evaluation the gap rests on: the environment's, with no
  // authorization; nothing proposed, issued, requested or deployed.
  const [ev] = authorizeEvaluations(fx.db);
  assert.equal(deployment.evaluation, ev.id);
  assert.equal(ev.authorization, null);
  assert.deepEqual(JSON.parse(ev.reasons).find((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE'), { code: 'ACCEPTANCE_SCOPE_INCOMPLETE', subjects: ['kind:post_deploy_behavior'] });
  assert.equal(fx.db.prepare('SELECT environment FROM acceptance_scopes WHERE id = ?').get(ev.scope).environment, 'env_1');
  for (const table of ['deployment_authorizations', 'deployment_requests', 'artifacts']) assert.equal(count(fx.db, table), 0, `${table}: nothing`);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE kind = 'deploy'`).get().n, 0);

  const again = ask(fx);
  assert.deepEqual([again.status, again.body], [202, { work_item: w.id, state: 'queued', proposal: null, decision: null, reused: true, requested_by: 'human' }]);
  assert.equal(authorings(fx.db).length, 1, 'no second work item');
  assert.equal(authorizeEvaluations(fx.db).length, 1, 'a repeat evaluates nothing');

  const r = readiness(fx);
  assert.deepEqual([r.state, r.blocker], ['blocked', BLOCKED_ON_BEHAVIOUR]);
  assert.deepEqual(r.authoring, { state: 'queued', work_item: w.id, run: null, proposal: null, decision: null, offer: null });
  assert.match(r.reason, new RegExp(`the Verifier's authoring of it \\(work item ${w.id}\\) is queued`), r.reason);
});

test('the readiness follows the authoring: running with its run, awaiting_review with the proposal and the open decision, applied once approved; then the checks run again; then ready', async (t) => {
  const fx = await store(t);
  const { work_item: w } = ask(fx).body;
  fx.db.prepare(`UPDATE work_items SET status = 'executing' WHERE id = ?`).run(w);
  runFor(fx.db, 'run_1', w, 'executing');
  let r = readiness(fx);
  assert.deepEqual(r.authoring, { state: 'running', work_item: w, run: 'run_1', proposal: null, decision: null, offer: null });
  assert.match(r.reason, /is running \(run run_1\)/);
  assert.deepEqual(ask(fx).body, { work_item: w, state: 'running', proposal: null, decision: null, reused: true, requested_by: 'human' });

  // The run captured its proposal and ended; the authoring waits for it.
  fx.db.prepare(`UPDATE runs SET state = 'ended' WHERE id = 'run_1'`).run();
  proposalOf(fx.db, 'pp_1', 'run_1', 'classified');
  fx.db.prepare(`UPDATE work_items SET status = 'awaiting_decision' WHERE id = ?`).run(w);
  r = readiness(fx);
  assert.deepEqual(r.authoring, { state: 'awaiting_review', work_item: w, run: 'run_1', proposal: 'pp_1', decision: null, offer: null }, 'its question not raised yet');
  decide(fx.db, 'dec_1', 'pp_1');
  r = readiness(fx);
  assert.deepEqual(r.authoring, { state: 'awaiting_review', work_item: w, run: 'run_1', proposal: 'pp_1', decision: 'dec_1', offer: null });
  assert.deepEqual([r.state, r.blocker], ['blocked', BLOCKED_ON_BEHAVIOUR]);
  assert.match(r.reason, /proposed the check \(proposal pp_1\), which waits for its review: your answer on decision dec_1/);
  assert.deepEqual(ask(fx).body, { work_item: w, state: 'awaiting_review', proposal: 'pp_1', decision: 'dec_1', reused: true, requested_by: 'human' });

  // The owner approves: being applied.
  fx.db.prepare(`UPDATE decisions SET status = 'consumed' WHERE id = 'dec_1'`).run();
  fx.db.prepare(`UPDATE protected_proposals SET status = 'approved' WHERE id = 'pp_1'`).run();
  r = readiness(fx);
  assert.deepEqual(r.authoring, { state: 'applied', work_item: w, run: 'run_1', proposal: 'pp_1', decision: null, offer: null });
  assert.match(r.reason, /approved and is being applied/);

  // Applied: version 2 with the behavioural check, the candidate's checks
  // queued again under it; the authoring complete.
  fx.db.prepare(`UPDATE protected_versions SET superseded_by = 'pv_2' WHERE id = 'pv_1'`).run();
  version(fx.db, 'pv_2', 2, 'fp2', [...CHECKS, BEHAVES]);
  fx.db.prepare(`UPDATE protected_proposals SET status = 'applied', resulting_version = 'pv_2' WHERE id = 'pp_1'`).run();
  fx.db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(w);
  transact(fx.db, ENGINE_ACTOR, (tx) => {
    for (const [key] of CHECKS) {
      tx.db
        .prepare(
          `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at) VALUES (?, ?, 'prj_1', ?, ?, 'cand_1', 'r', 'pv_2', 'direct', ?, ?, ?, 'queued', ?)`,
        )
        .run(`cx_${key}`, tx.at, `chk_${key}_pv_2`, key, nextExecutionSeq(tx, 'prj_1'), JSON.stringify({ source: 'protected_application', id: 'pp_1', generation: 1 }), `pa:${key}`, tx.at);
    }
  });
  r = readiness(fx);
  assert.deepEqual([r.state, r.blocker], ['blocked', { what: 'checks_running', subject: null }], JSON.stringify(r));
  assert.deepEqual(r.authoring, { state: 'applied', work_item: w, run: 'run_1', proposal: 'pp_1', decision: null, offer: null }, 'what made the version is said beside the checks running');

  for (const [key] of CHECKS) {
    const { check_result } = post(fx.db, `chk_${key}_pv_2`, 'pv_2');
    fx.db.prepare(`UPDATE check_executions SET status = 'recorded', result = ? WHERE id = ?`).run(check_result.id, `cx_${key}`);
  }
  r = readiness(fx);
  assert.equal(r.state, 'ready', JSON.stringify(r));
  assert.equal(r.authoring, undefined);
});

test('a parked authoring waits for the owner: awaiting_review naming the blocker decision; a held one is queued', async (t) => {
  const fx = await store(t);
  const { work_item: w } = ask(fx).body;
  fx.db.prepare(`UPDATE work_items SET status = 'parked' WHERE id = ?`).run(w);
  fx.db
    .prepare(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status) VALUES ('dec_b', ?, 'prj_1', 2, 'blocker', 'work_item', ?, 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, 'open')`,
    )
    .run(AT, w, AT);
  assert.deepEqual(readiness(fx).authoring, { state: 'awaiting_review', work_item: w, run: null, proposal: null, decision: 'dec_b', offer: null });
  fx.db.prepare(`UPDATE work_items SET status = 'held' WHERE id = ?`).run(w);
  assert.equal(readiness(fx).authoring.state, 'queued');
});

test('an authoring that ended leaving the gap (its proposal rejected): none, offered again; the owner asks again, the next generation', async (t) => {
  const fx = await store(t);
  const { work_item: w } = ask(fx).body;
  runFor(fx.db, 'run_1', w, 'ended');
  proposalOf(fx.db, 'pp_1', 'run_1', 'rejected');
  fx.db.prepare(`UPDATE work_items SET status = 'complete' WHERE id = ?`).run(w);
  const r = readiness(fx);
  assert.deepEqual([r.authoring.state, r.authoring.work_item, r.authoring.offer?.method], ['none', null, 'POST']);
  const again = ask(fx);
  assert.equal(again.status, 202);
  assert.equal(again.body.reused, false);
  const items = authorings(fx.db);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.trigger_generation), [1, 2]);
  assert.equal(again.body.work_item, items[1].id);
});

test("under on_phase_complete the policy's refused request queued the authoring: the owner's request answers it, reused, requested_by policy; no second work item", async (t) => {
  const fx = await store(t, { policy: 'on_phase_complete' });
  const SEALED = { digest: 'sha256:' + 'd'.repeat(64), manifest: [], path: '/nowhere/artifact', bytes: 1, entries: 1, reused: 'new' };
  const refused = transact(fx.db, ENGINE_ACTOR, (tx) =>
    requestDeployment(tx, { project: 'prj_1', candidate: 'cand_1', environment: 'alpha', sealed: SEALED, specFingerprint: 's', builder: 'b', facts: fx.facts, requested_by: 'policy' }, (tx2, a) => evaluateGate(tx2, a)),
  );
  assert.equal(refused.status, 409);
  const [w] = authorings(fx.db);
  assert.equal(JSON.parse(w.trigger_evidence).deployment.requested_by, 'policy');
  const evaluations = authorizeEvaluations(fx.db).length;
  const res = ask(fx);
  assert.deepEqual([res.status, res.body], [202, { work_item: w.id, state: 'queued', proposal: null, decision: null, reused: true, requested_by: 'policy' }]);
  assert.equal(authorings(fx.db).length, 1);
  assert.equal(authorizeEvaluations(fx.db).length, evaluations);
  // An authoring recorded before `requested_by` was: read from the request
  // that refused (the policy's records no outcome while it waits).
  fx.db.prepare('UPDATE work_items SET trigger_evidence = ? WHERE id = ?').run(JSON.stringify({ deployment: { ...JSON.parse(w.trigger_evidence).deployment, requested_by: undefined } }), w.id);
  assert.equal(ask(fx).body.requested_by, 'policy');
});

test("the owner's deployment request refused on the gap records requested_by human on the authoring it queues", async (t) => {
  const fx = await store(t);
  const SEALED = { digest: 'sha256:' + 'd'.repeat(64), manifest: [], path: '/nowhere/artifact', bytes: 1, entries: 1, reused: 'new' };
  transact(fx.db, OWNER, (tx) =>
    requestDeployment(tx, { project: 'prj_1', candidate: 'cand_1', environment: 'alpha', sealed: SEALED, specFingerprint: 's', builder: 'b', facts: fx.facts, requested_by: 'human' }, (tx2, a) => evaluateGate(tx2, a)),
  );
  const [w] = authorings(fx.db);
  assert.equal(JSON.parse(w.trigger_evidence).deployment.requested_by, 'human');
  assert.equal(ask(fx).body.requested_by, 'human');
});

test('refusals: nothing_missing (the effective version has the check), recording nothing; no_candidate; not_hostable; an unknown environment', async (t) => {
  const has = await store(t, { behaves: true });
  const r = readiness(has);
  assert.notEqual(r.blocker?.what, 'required_check_missing', JSON.stringify(r));
  const none = ask(has);
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'nothing_missing');
  assert.match(none.body.reason, /^Nothing a Verifier could write is missing from the alpha deployment of candidate cand_1: alpha_authorize names SIGNOFF_MISSING, and none of it is a check a Verifier writes\.$/, none.body.reason);
  assert.deepEqual(authorings(has.db), []);
  assert.deepEqual(authorizeEvaluations(has.db), [], 'the refusal records nothing');

  const fx = await store(t);
  const beta = ask(fx, 'beta');
  assert.deepEqual([beta.status, beta.body.code], [409, 'not_hostable'], JSON.stringify(beta.body));
  assert.match(beta.body.reason, /^The environment beta cannot host this output: /);
  const unknown = ask(fx, 'gamma');
  assert.deepEqual([unknown.status, unknown.body.code], [404, 'not_found']);
  fx.db.prepare(`DELETE FROM roadmap_revisions`).run();
  const incomplete = ask(fx);
  assert.deepEqual([incomplete.status, incomplete.body.code], [409, 'no_candidate']);
  assert.match(incomplete.body.reason, /build of project prj_1 is not complete/);
  fx.db.prepare(`UPDATE candidates SET superseded_by = 'cand_x'`).run();
  const noCandidate = ask(fx, 'alpha', { candidate: null, facts: null });
  assert.deepEqual([noCandidate.status, noCandidate.body.code], [409, 'no_candidate']);
  assert.match(noCandidate.body.reason, /has no current candidate/);
  assert.deepEqual(authorings(fx.db), []);
});

// ---- on the kernel lane ----------------------------------------------------------------------

import { consume, openDecision } from '../acceptance/harness/decisions.mjs';
import { definitionText } from '../acceptance/harness/checks/fixtures.mjs';
import { KERNEL_KINDS } from '../acceptance/harness/design/check41.mjs';
import { stageWork } from '../acceptance/harness/design/drive.mjs';
import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { roleThat } from '../acceptance/harness/gitruns.mjs';
import { journeyContext, phaseCompleted } from '../acceptance/harness/journey/drive.mjs';
import { scriptedEngine, tick, tickUntil } from '../acceptance/harness/runs.mjs';
import { recordChecks } from '../acceptance/harness/prototype.mjs';
import { step } from '../acceptance/harness/scripted.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { configContent, putConfig, qualifyByFixture, requestDeployment as requestOverApi } from '../acceptance/harness/deploy/kernel.mjs';
import { PAGE_AUTHORING, PAGE_BUILT, pagePublished, pageScripts } from '../acceptance/harness/deploy/static-journey.mjs';

const SERVER = 'web/server.mjs';
const SERVICE_BUILT = Object.freeze({
  ...PAGE_BUILT,
  'web/index.html': '<!doctype html><p>notes</p>\n',
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
const authoringRun = (files) => roleThat(writes(files), { proposal: { rationale: 'The Verifier authors the checks.', requested_change_kind: 'unclassifiable' } });

describe('the owner asks for the missing check on the kernel lane: offered, queued, reused, authored, approved, applied, ready, requested', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'notes-ask' });
    J.p = p;
    pageScripts(fx);
    // Phase 1's authoring writes no behavioural check; the next authoring
    // (the one the owner asks for) writes it.
    fx.scripted.kindScript('check_authoring', [authoringRun(PAGE_AUTHORING), ...[1, 2, 3].map(() => authoringRun(WITH_BEHAVIOUR))]);
    const w = stageWork(fx.home, p.id, 1);
    fx.scripted.script(w.id, [0, 1, 2].map(() => roleThat(writes(SERVICE_BUILT))));
    const ctx = journeyContext(fx, p, { lane: 'kernel' });
    ctx.answerKinds = [...KERNEL_KINDS];
    await phaseCompleted(fx, ctx, 1, { max: 160 });
    await qualifyByFixture(fx.engine);
    const res = await putConfig(fx.engine, p.id, 'alpha', configContent({ start: [process.execPath, SERVER], port: 18671 }));
    assert.ok([200, 201].includes(res.status), res.text);
    const read = async () => (await fx.engine.get(`/v1/projects/${p.id}`)).body.project;
    for (let i = 0; i < 8 && (await read()).build.deploy_readiness.blocker?.what !== 'required_check_missing'; i++) await fx.engine.post(`/v1/projects/${p.id}/tick`, {});
    J.before = await read();
    J.acts = () => withStore(fx.home, (db) => db.prepare(`SELECT payload FROM events WHERE type = 'api.act' ORDER BY seq`).all().map((e) => JSON.parse(e.payload)));
    J.actsBefore = J.acts().length;
    J.first = await fx.engine.post(J.before.build.deploy_readiness.authoring?.offer?.path ?? `/v1/projects/${p.id}/environments/alpha/request-checks`, {});
    J.second = await fx.engine.post(`/v1/projects/${p.id}/environments/alpha/request-checks`, {});
    J.items = () => withStore(fx.home, (db) => db.prepare(`SELECT id, status, trigger_evidence FROM work_items WHERE project = ? AND kind = 'check_authoring' AND trigger_source = 'authoring_gap'`).all(p.id));
    J.itemsAfter = J.items();
    J.actsAfter = J.acts().slice(J.actsBefore);
    J.queued = await read();
    J.runModel = async () => withStore(fx.home, (db) => db.prepare(`SELECT model_requested FROM runs WHERE work_item = ? ORDER BY rowid LIMIT 1`).get(J.first.body.work_item)?.model_requested ?? null);
    const proposalOfItem = () =>
      withStore(fx.home, (db) => db.prepare(`SELECT p.id, p.status FROM protected_proposals p JOIN runs r ON r.id = p.run WHERE r.work_item = ? ORDER BY p.seq DESC LIMIT 1`).get(J.first.body.work_item));
    await tickUntil(fx.engine, p.id, () => proposalOfItem(), { max: 40, what: "the Verifier's proposal captured" });
    J.proposal = proposalOfItem();
    J.recordedModel = await J.runModel();
    const decisionOpen = () => withStore(fx.home, (db) => db.prepare(`SELECT id, kind FROM decisions WHERE subject_type = 'protected_proposal' AND subject_id = ? AND status = 'open'`).get(J.proposal.id));
    await tickUntil(fx.engine, p.id, () => decisionOpen() || ['applied', 'approved'].includes(proposalOfItem().status), { max: 40, what: 'its question raised (or approved by its Reviewer)' });
    J.reviewing = await read();
    const open = decisionOpen();
    if (open) {
      J.decision = await openDecision(fx, p.id, open.kind, J.proposal.id, { max: 8 });
      await consume(fx, p.id, J.decision, 'approve');
    }
    await tickUntil(fx.engine, p.id, () => proposalOfItem().status === 'applied', { max: 40, what: 'the proposal applied' });
    J.applied = await read();
    for (let i = 0; i < 8 && (await read()).build.deploy_readiness.state !== 'ready'; i++) {
      await recordChecks(fx, p.id);
      await tick(fx.engine, p.id);
    }
    J.ready = await read();
    J.candidate = J.ready.checks?.candidate ?? J.queued.checks?.candidate;
    J.deploy = await requestOverApi(fx.engine, p.id, J.candidate, 'alpha');
    // DECISIONS item 44: refused for the sign-off alone, the review it
    // queued named; the readiness waits for it; signed, the request again.
    if (J.deploy.status === 409) {
      J.waiting = await read();
      const reviewDone = () => withStore(fx.home, (db) => db.prepare(`SELECT status FROM work_items WHERE id = ?`).get(J.deploy.body.subject.review?.work_item ?? '')?.status === 'complete');
      await tickUntil(fx.engine, p.id, () => reviewDone() || undefined, { max: 40, what: "the Reviewer's review complete" });
      J.signed = await read();
      J.again = await requestOverApi(fx.engine, p.id, J.candidate, 'alpha');
    }
  });
  after(() => shared.cleanup());

  test('before: blocked on the behavioural check, authoring none with the offer', () => {
    const r = J.before.build.deploy_readiness;
    assert.deepEqual([r.state, r.blocker], ['blocked', BLOCKED_ON_BEHAVIOUR], JSON.stringify(r));
    assert.equal(r.authoring?.state, 'none', JSON.stringify(r));
    assert.equal(r.authoring.offer.path, `/v1/projects/${J.p.id}/environments/alpha/request-checks`);
    assert.match(r.authoring.offer.consequence_text, /^Queues a Verifier check-authoring run on the configured model .+: it writes the missing post_deploy_behavior check as a proposal you review; nothing is deployed\./);
  });

  test("objection 232: the offer named the model the Verifier's run then recorded as requested", () => {
    assert.ok(J.recordedModel, 'the run recorded a model');
    assert.ok(J.before.build.deploy_readiness.authoring.offer.consequence_text.startsWith(`Queues a Verifier check-authoring run on the configured model ${J.recordedModel} (`), `${J.recordedModel}: ${J.before.build.deploy_readiness.authoring.offer.consequence_text}`);
  });

  test('the request 202 queued; again 202 reused with the same work item; one authoring; each an api.act of the route', () => {
    assert.equal(J.first.status, 202, J.first.text);
    assert.deepEqual({ ...J.first.body, work_item: typeof J.first.body.work_item }, { work_item: 'string', state: 'queued', proposal: null, decision: null, reused: false, requested_by: 'human' });
    assert.equal(J.second.status, 202, J.second.text);
    assert.equal(J.second.body.work_item, J.first.body.work_item);
    assert.equal(J.second.body.reused, true);
    assert.equal(J.itemsAfter.length, 1);
    const path = `/v1/projects/${J.p.id}/environments/alpha/request-checks`;
    assert.deepEqual(
      J.actsAfter.filter((a) => a.path === path).map((a) => [a.method, a.status]),
      [
        ['POST', 202],
        ['POST', 202],
      ],
    );
    const r = J.queued.build.deploy_readiness;
    assert.equal(r.state, 'blocked');
    assert.ok(['queued', 'running'].includes(r.authoring.state), JSON.stringify(r.authoring));
    assert.equal(r.authoring.work_item, J.first.body.work_item);
    assert.equal(r.authoring.offer, null);
  });

  test("the Verifier's proposal reviewed and applied; the checks run again; ready; the deployment then requested", () => {
    const reviewing = J.reviewing.build.deploy_readiness;
    assert.ok(J.decision, "the proposal's question is the owner's");
    assert.deepEqual([reviewing.state, reviewing.blocker?.what], ['blocked', 'required_check_missing']);
    assert.deepEqual([reviewing.authoring?.state, reviewing.authoring?.proposal, reviewing.authoring?.decision], ['awaiting_review', J.proposal.id, J.decision.id], JSON.stringify(reviewing));
    const applied = J.applied.build.deploy_readiness;
    assert.deepEqual([applied.state, applied.blocker?.what, applied.authoring?.state, applied.authoring?.proposal], ['blocked', 'checks_running', 'applied', J.proposal.id], JSON.stringify(applied));
    assert.equal(J.ready.build.deploy_readiness.state, 'ready', JSON.stringify(J.ready.build.deploy_readiness));
    // The applied version changed the acceptance content: on a tier that
    // requires the Reviewer's sign-off the request is refused for it alone
    // and asks the Reviewer (alpha-review.ts); nothing else stands.
    if (J.deploy.status === 409) {
      assert.deepEqual(J.deploy.body.subject.reasons.map((r) => r.code), ['SIGNOFF_MISSING'], J.deploy.text);
      assert.equal(J.deploy.body.subject.review?.state, 'queued', J.deploy.text);
      const w = J.waiting.build.deploy_readiness;
      assert.deepEqual([w.state, w.blocker, w.review?.work_item], ['blocked', { what: 'signoff_pending', subject: 'SIGNOFF_MISSING' }, J.deploy.body.subject.review.work_item], JSON.stringify(w));
      assert.match(w.reason, /^Waiting for Reviewer sign-off/);
      assert.equal(J.signed.build.deploy_readiness.state, 'ready', JSON.stringify(J.signed.build.deploy_readiness));
      assert.equal(J.again.status, 201, J.again.text);
    } else assert.equal(J.deploy.status, 201, J.deploy.text);
  });
});
