// M627, the owner asks for the missing deployment check (slice 49; kernel
// lane). M7 plan §3f M627; D4 §4.1 J4, §13.4; D6 §6.2; DECISIONS item 43.
// Sean, 2026-11-24, verbatim: "Take the manual-policy dead end next. On the
// Everyday Workspace card that says the behavioral check is missing, provide
// one action: “Ask Verifier to write the check.” … Repeated clicks and
// refreshes should reuse the same work. … For manual policy, that click is
// the owner's instruction to start authoring. For automatic deployment, use
// the existing policy authorization when it already covers the work."
//
// (a) under `alpha_deploy: manual`, a Node service whose effective protected
//     version lacks the required `post_deploy_behavior` check: before,
//     `deploy_readiness` `blocked`, `blocker {required_check_missing,
//     kind:post_deploy_behavior}`, `authoring {state: 'none', offer: {method:
//     'POST', path, consequence_text}}`, the consequence text naming the
//     Verifier role and its configured model. The owner's `POST
//     …/environments/:e/request-checks {}`: 202 `{work_item, state: 'queued',
//     reused: false, requested_by: 'human', proposal: null, decision: null}`;
//     one `check_authoring` work item, trigger `authoring_gap`, its evidence
//     naming the gate, the environment and `missing {kinds:
//     ['post_deploy_behavior']}`; no deployment request recorded as the
//     owner's; no deployment made. Again: 202, the same work item, `reused:
//     true`; still one work item, one run. The project read's `authoring`:
//     `queued`, `running` with the run, `awaiting_review` with the proposal
//     and the open decision; `blocked` throughout, `offer` null. The owner
//     approves: `applied`, the candidate's checks run again (`blocked`,
//     `checks_running`), then `ready`; a deployment request then issued (201).
// (b) under `on_phase_complete`, the policy's refused request having queued
//     the authoring: the owner's request answers 202 `reused: true` with that
//     work item, `requested_by: 'policy'`; no second work item.
// (c) 409 `nothing_missing` with the engine's reason when the effective
//     version has the check, nothing queued; 409 `no_candidate` before any
//     candidate.
// (d) each owner request emits `api.act` with actor `human` and the route;
//     nothing a GET does queues work.
//
// Readings this file makes (the report says them):
// - `work_item` in the route's answer is read as the work item's id, served
//   either as the id or as an object carrying it ({id}); which one is
//   reported.
// - "one run" is read once the authoring has started: before its first tick
//   the queued work item has no run; after it, exactly one, whatever the
//   repeats.
// - "applied" is read where the readiness still carries `authoring` after the
//   owner's approval; once the applied version holds the check, the blocker
//   is no longer `required_check_missing` and the readiness reads
//   `checks_running`, then `ready`.
// - The applied check changes the acceptance content the candidate's Reviewer
//   sign-off binds (M626's reading 4): the first request after `ready` may be
//   refused SIGNOFF_MISSING alone (row M628); it is then made again once the
//   engine's Reviewer has signed off, and must be issued (the row as amended
//   by the driver's companion 8b74035b).
//
// The projects are M626's Node service (M616's browser-app variant of the
// design journey's reference project, its Builder's tree a `node_service`
// serving `web/`), configured in service mode with no `serving` declared, so
// no serving-check proposal of the engine's stands beside the Verifier's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { consume, decisionsOn } from './harness/decisions.mjs';
import { KERNEL_KINDS } from './harness/design/check41.mjs';
import { stageWork, toPublished } from './harness/design/drive.mjs';
import { proposalsOf, sharedFixture } from './harness/gates.mjs';
import { roleThat, roleThatHolds, runToHold } from './harness/gitruns.mjs';
import { journeyContext, phaseCompleted } from './harness/journey/drive.mjs';
import { idle, recordChecks } from './harness/prototype.mjs';
import { runsOf, scriptedEngine, tick } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, putConfig, qualifyByFixture, requestDeployment } from './harness/deploy/kernel.mjs';
import { PAGE_AUTHORING, PAGE_BUILT, PAGE_FILES, PAGE_POLICY, PAGE_SPEC, pageScripts } from './harness/deploy/static-journey.mjs';

// The model the project configures for its Verifier: a name no default
// carries, so the consequence text can only name it by reading the policy.
const VERIFIER_MODEL = 'sonnet-m627-verifier';
const CHECK_DECISIONS = ['check_correction_tightening', 'check_correction_unclassifiable', 'check_correction_loosening'];
const ROUTE = (project, env = 'alpha') => `/v1/projects/${project}/environments/${env}/request-checks`;
const MISSING = Object.freeze({ what: 'required_check_missing', subject: 'kind:post_deploy_behavior' });

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const parse = (text) => (text === null || text === undefined ? null : JSON.parse(text));
const gapAuthoring = (home, project) =>
  all(home, `SELECT "id", "status", "trigger_source", "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = 'authoring_gap' ORDER BY rowid`, project).map((w) => ({
    ...w,
    trigger_evidence: parse(w.trigger_evidence),
  }));
const workCount = (home, project) => all(home, 'SELECT COUNT(*) AS n FROM "work_items" WHERE "project" = ?', project)[0].n;
const ownerRequests = (home, project) => all(home, `SELECT "id", "outcome" FROM "deployment_requests" WHERE "project" = ? AND "requested_by" = 'human'`, project);
const policyRequests = (home, project) => all(home, `SELECT "id", "outcome", "candidate" FROM "deployment_requests" WHERE "project" = ? AND "requested_by" = 'policy'`, project);
const deployments = (home, project) => ({
  operations: all(home, `SELECT "id" FROM "operations" WHERE "project" = ? AND "kind" = 'deploy'`, project).length,
  work: all(home, `SELECT "id" FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy'`, project).length,
  issued: all(home, `SELECT a."id" FROM "deployment_authorizations" a JOIN "candidates" c ON c."id" = a."candidate" WHERE c."project" = ? AND a."status" IN ('issued', 'consumed')`, project).length,
});
const maxSeq = (home) => all(home, 'SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"')[0].n;
const routeActs = (home, project, since = 0) =>
  all(home, `SELECT "seq", "actor_kind", "payload" FROM "events" WHERE "type" = 'api.act' AND "seq" > ? ORDER BY "seq"`, since)
    .map((e) => ({ ...e, payload: parse(e.payload) }))
    .filter((e) => e.payload?.path === ROUTE(project));
const proposalStatus = (home, id) => all(home, 'SELECT "status" FROM "protected_proposals" WHERE "id" = ?', id)[0]?.status ?? null;
const behaviourKeys = (home, project) =>
  all(
    home,
    `SELECT c."key" FROM "checks" c JOIN "protected_versions" v ON v."id" = c."protected_version" WHERE v."project" = ? AND v."authorized" = 1 AND v."effective_from" IS NOT NULL AND v."superseded_by" IS NULL AND c."kind" = 'post_deploy_behavior'`,
    project,
  ).map((r) => r.key);

// The route's answer's work item, served as the id or as {id}.
const itemOf = (res) => {
  const w = res?.body?.work_item;
  return typeof w === 'string' ? w : (w?.id ?? null);
};

// ---- the projects ----------------------------------------------------------------------------

// M626's Node service: M616's page with a package.json start script
// (`node_service`), the directory it serves and its start program.
const SERVER = 'web/server.mjs';
const SERVICE_BUILT = Object.freeze({
  ...PAGE_BUILT,
  'web/index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><ul id="items"></ul></body></html>\n',
  [SERVER]: "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n",
});
const SERVICE_CONFIG = (port) => configContent({ start: [process.execPath, SERVER], port });

// The required post_deploy_behavior check of the alpha_complete scope (as
// M626's), its input listed file by file.
const BEHAVIOUR_PROGRAM = '.surety/checks/post-deploy/operation.mjs';
const BEHAVIOUR_FILES = Object.freeze({
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
const WITH_BEHAVIOUR = Object.freeze({ ...PAGE_AUTHORING, ...BEHAVIOUR_FILES });

const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));

// The Verifier asked for the deployment gap: it writes the behavioural
// check, waits at a hold (the test reads `running`), and proposes it.
const GAP_AUTHORING = roleThatHolds(writes(BEHAVIOUR_FILES), [], {
  proposal: { rationale: 'The Verifier writes the required post_deploy_behavior check the Alpha deployment lacks.', requested_change_kind: 'tightening' },
});

// M626's builtWith: the published plan built to its phase's completion,
// the Verifier's phase-1 authoring given.
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

const published = (fx, name, policy = {}) => toPublished(fx, { policy: { ...PAGE_POLICY, model_verifier: VERIFIER_MODEL, ...policy }, name, spec: PAGE_SPEC, files: PAGE_FILES });

async function writeConfig(fx, project, name, content) {
  const res = await putConfig(fx.engine, project, name, content);
  assert.ok([200, 201].includes(res.status), `PUT …/environments/${name}/config (→ ${res.status} ${res.text})`);
  return res;
}

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

// Every read an owner's screen takes: the project, its environments, the environment.
async function everyRead(fx, project) {
  const p = await projectBody(fx, project);
  for (const path of [`/v1/projects/${project}/environments`, `/v1/projects/${project}/environments/alpha`, `/v1/projects/${project}/work`, `/v1/projects/${project}/decisions`]) {
    const r = await fx.engine.get(path);
    assert.equal(r.status, 200, `GET ${path} (→ ${r.status} ${r.text})`);
  }
  return p;
}

const ask = (fx, project, env = 'alpha') => fx.engine.post(ROUTE(project, env), {});

// The open check-correction decision about a proposal, ticking until raised.
async function openCheckDecision(fx, project, proposal, { max = 10 } = {}) {
  for (let i = 0; i <= max; i++) {
    const open = CHECK_DECISIONS.flatMap((k) => decisionsOn(fx.home, k, proposal)).filter((d) => d.status === 'open');
    if (open.length > 0) {
      assert.equal(open.length, 1, `one open decision about ${proposal} (${JSON.stringify(open.map((d) => [d.id, d.kind]))})`);
      return open[0];
    }
    await tick(fx.engine, project);
    await idle(fx, project);
  }
  throw new Error(`no open check-correction decision about ${proposal} after ${max} ticks`);
}

// ---- (a) manual: blocked → request check → review proposal → ready → deploy ----------------------

describe('M627 (a) under manual policy: the owner asks for the missing behavioural check, again, through the authoring and its approval, to an issued deployment', () => {
  const shared = sharedFixture();
  const J = { acts: [] };
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await published(fx, 'pantry-ask-a');
    J.p = p;
    await builtWith(fx, p, { built: SERVICE_BUILT });
    await qualifyByFixture(fx.engine);
    await settled(fx, p.id);
    await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18671));
    await settled(fx, p.id);
    fx.scripted.kindScript('check_authoring', GAP_AUTHORING);
    J.seq0 = maxSeq(fx.home);
    // (d) the reads queue nothing.
    J.workBeforeReads = workCount(fx.home, p.id);
    J.before = await everyRead(fx, p.id);
    await everyRead(fx, p.id);
    J.workAfterReads = workCount(fx.home, p.id);
    J.gapBefore = gapAuthoring(fx.home, p.id);
    J.deploymentsBefore = deployments(fx.home, p.id);
    // The owner's request.
    J.first = await ask(fx, p.id);
    J.acts.push(J.first.status);
    J.gapFirst = gapAuthoring(fx.home, p.id);
    J.ownerAfterFirst = ownerRequests(fx.home, p.id);
    J.deploymentsAfterFirst = deployments(fx.home, p.id);
    J.queued = await projectBody(fx, p.id);
    // Again, while queued.
    J.again = await ask(fx, p.id);
    J.acts.push(J.again.status);
    J.gapAgain = gapAuthoring(fx.home, p.id);
    const item = itemOf(J.first);
    J.item = item;
    if (J.first.status !== 202 || !item) return;
    J.runsQueued = runsOf(fx.home, item).length;
    // The Verifier's run, held.
    J.held = await runToHold(fx, p.id, item);
    J.runModel = all(fx.home, 'SELECT "model_requested" FROM "runs" WHERE "id" = ?', J.held.run.id)[0]?.model_requested ?? null;
    J.running = await projectBody(fx, p.id);
    J.againRunning = await ask(fx, p.id);
    J.acts.push(J.againRunning.status);
    J.runsRunning = runsOf(fx.home, item).length;
    fx.scripted.release(item);
    await idle(fx, p.id);
    J.proposal = proposalsOf(fx.home, p.id).find((x) => x.run === J.held.run.id) ?? null;
    if (!J.proposal) return;
    J.decision = await openCheckDecision(fx, p.id, J.proposal.id);
    J.review = await projectBody(fx, p.id);
    J.againReview = await ask(fx, p.id);
    J.acts.push(J.againReview.status);
    J.gapReview = gapAuthoring(fx.home, p.id);
    J.runsReview = runsOf(fx.home, item).length;
    J.ownerBeforeApproval = ownerRequests(fx.home, p.id);
    J.deploymentsBeforeApproval = deployments(fx.home, p.id);
    // The owner approves.
    await consume(fx, p.id, J.decision, 'approve');
    J.approvedRead = await projectBody(fx, p.id);
    J.after = [];
    for (let i = 0; i < 10 && proposalStatus(fx.home, J.proposal.id) !== 'applied'; i++) {
      await tick(fx.engine, p.id);
      await idle(fx, p.id);
    }
    J.appliedStatus = proposalStatus(fx.home, J.proposal.id);
    J.applied = await projectBody(fx, p.id);
    J.after.push(J.applied.build.deploy_readiness);
    for (let i = 0; i < 10 && J.after.at(-1).state !== 'ready'; i++) {
      await recordChecks(fx, p.id);
      await tick(fx.engine, p.id);
      await idle(fx, p.id);
      J.after.push((await projectBody(fx, p.id)).build.deploy_readiness);
    }
    J.ready = await projectBody(fx, p.id);
    J.keys = behaviourKeys(fx.home, p.id);
    // The deployment request, made again once the Reviewer has signed off
    // when the applied version renewed the sign-off.
    const candidate = J.ready.checks.candidate;
    J.deploy = [await requestDeployment(fx.engine, p.id, candidate, 'alpha')];
    for (let i = 0; i < 12 && J.deploy.at(-1).status === 409; i++) {
      await tick(fx.engine, p.id);
      await idle(fx, p.id);
      J.deploy.push(await requestDeployment(fx.engine, p.id, candidate, 'alpha'));
    }
  });
  after(async () => {
    J.fx?.scripted.release('all');
    await shared.cleanup();
  });

  test('(a) before: blocked, required_check_missing kind:post_deploy_behavior; authoring none with the offer, its consequence naming the Verifier and its configured model', (t) => {
    const d = J.before.build.deploy_readiness;
    t.diagnostic(`readiness before: ${JSON.stringify(d)}`);
    assert.equal(J.before.deployment_compatibility.output_kind, 'node_service', J.before.deployment_compatibility.reason);
    assert.equal(d.state, 'blocked', JSON.stringify(d));
    assert.deepEqual(d.blocker, MISSING, JSON.stringify(d));
    assert.equal(J.before.now.primary_action, null, JSON.stringify(J.before.now));
    const a = d.authoring;
    assert.ok(a && typeof a === 'object', `the blocked readiness carries authoring (${JSON.stringify(d)})`);
    assert.equal(a.state, 'none', JSON.stringify(a));
    for (const k of ['work_item', 'run', 'proposal', 'decision']) assert.equal(a[k] ?? null, null, `${k} null before any request (${JSON.stringify(a)})`);
    assert.ok(a.offer && typeof a.offer === 'object', `the offer (${JSON.stringify(a)})`);
    assert.equal(a.offer.method, 'POST');
    assert.equal(a.offer.path, ROUTE(J.p.id), JSON.stringify(a.offer));
    assert.equal(typeof a.offer.consequence_text, 'string');
    assert.match(a.offer.consequence_text, /Verifier/, `names the Verifier role (${a.offer.consequence_text})`);
    // The model configured for the Verifier: the project's model_verifier,
    // which the Verifier's run records as the model it requests
    // (runs.ts, model_requested).
    t.diagnostic(`the Verifier's run requests the model ${J.runModel}`);
    assert.equal(J.runModel, VERIFIER_MODEL, 'the run records the configured model as the one it requests');
    assert.ok(a.offer.consequence_text.includes(VERIFIER_MODEL), `names the model configured for the Verifier, ${VERIFIER_MODEL} (${a.offer.consequence_text})`);
  });

  test('(a) the request: 202 {work_item, queued, reused false, requested_by human, proposal null, decision null}; one check_authoring, trigger authoring_gap, its evidence the gate, the environment and what is missing', (t) => {
    t.diagnostic(`first: ${J.first.status} ${J.first.text}`);
    assert.equal(J.first.status, 202, J.first.text);
    assert.deepEqual(J.gapBefore, [], 'no authoring asked before the request');
    assert.equal(J.gapFirst.length, 1, `one check_authoring for the gap (${JSON.stringify(J.gapFirst)})`);
    const w = J.gapFirst[0];
    t.diagnostic(`work_item served as ${typeof J.first.body.work_item === 'string' ? 'the id' : 'an object'}: ${JSON.stringify(J.first.body.work_item)}`);
    assert.equal(J.item, w.id, 'the answer names the work item');
    const b = J.first.body;
    assert.deepEqual([b.state, b.reused, b.requested_by, b.proposal, b.decision], ['queued', false, 'human', null, null], J.first.text);
    assert.equal(w.trigger_source, 'authoring_gap');
    const ev = w.trigger_evidence?.deployment;
    assert.equal(ev?.gate, 'alpha_authorize', JSON.stringify(w.trigger_evidence));
    assert.equal(ev.environment, 'alpha');
    assert.deepEqual(ev.missing?.kinds, ['post_deploy_behavior'], JSON.stringify(ev.missing));
    for (const k of ['criteria', 'areas']) assert.deepEqual(ev.missing[k] ?? [], [], `nothing else missing (${JSON.stringify(ev.missing)})`);
    assert.match(JSON.stringify(w.trigger_evidence), /"requested_by":"human"/, `the evidence records who asked (${JSON.stringify(w.trigger_evidence)})`);
  });

  test('(a) no deployment request recorded as the owner\'s; no deployment made', () => {
    assert.deepEqual(J.ownerAfterFirst, [], 'no deployment request of the owner\'s after the request');
    assert.deepEqual(J.ownerBeforeApproval, [], 'nor through the authoring');
    const none = { operations: 0, work: 0, issued: 0 };
    assert.deepEqual(J.deploymentsBefore, none);
    assert.deepEqual(J.deploymentsAfterFirst, none, 'nothing deployed by the request');
    assert.deepEqual(J.deploymentsBeforeApproval, none, 'nothing deployed through the authoring');
  });

  test('(a) again, and at every state: 202, the same work item, reused true; still one work item, one run', () => {
    assert.equal(J.again.status, 202, J.again.text);
    assert.equal(itemOf(J.again), J.item, J.again.text);
    assert.deepEqual([J.again.body.reused, J.again.body.state, J.again.body.requested_by], [true, 'queued', 'human'], J.again.text);
    assert.equal(J.gapAgain.length, 1, 'still one work item');
    assert.equal(J.runsQueued, 0, 'queued: no run yet');
    assert.equal(J.againRunning?.status, 202, J.againRunning?.text);
    assert.equal(itemOf(J.againRunning), J.item);
    assert.deepEqual([J.againRunning.body.reused, J.againRunning.body.state], [true, 'running'], J.againRunning.text);
    assert.equal(J.runsRunning, 1, 'one run');
    assert.ok(J.proposal && J.decision, 'the Verifier\'s proposal captured and its question raised');
    assert.equal(J.againReview?.status, 202, J.againReview?.text);
    assert.equal(itemOf(J.againReview), J.item);
    const b = J.againReview.body;
    assert.deepEqual([b.reused, b.state, b.proposal, b.decision], [true, 'awaiting_review', J.proposal.id, J.decision.id], J.againReview.text);
    assert.equal(J.gapReview.length, 1, 'still one work item');
    assert.equal(J.runsReview, 1, 'still one run');
  });

  test('(a) the project read\'s authoring: queued, running with the run, awaiting_review with the proposal and the open decision; blocked throughout, offer null', (t) => {
    const states = [
      ['queued', J.queued, { work_item: J.item }],
      ['running', J.running, { work_item: J.item, run: J.held?.run.id }],
      ['awaiting_review', J.review, { work_item: J.item, proposal: J.proposal?.id, decision: J.decision?.id }],
    ];
    for (const [state, r, named] of states) {
      assert.ok(r, `${state} was read`);
      const d = r.build.deploy_readiness;
      t.diagnostic(`${state}: ${JSON.stringify(d)}`);
      assert.equal(d.state, 'blocked', `${state}: ${JSON.stringify(d)}`);
      assert.deepEqual(d.blocker, MISSING, `${state}: ${JSON.stringify(d)}`);
      assert.equal(r.now.primary_action === 'deploy', false, `${state}: never deploy while blocked (${JSON.stringify(r.now)})`);
      assert.equal(d.authoring?.state, state, `${state}: ${JSON.stringify(d.authoring)}`);
      assert.equal(d.authoring.offer, null, `${state}: no offer once the work is asked for`);
      for (const [k, v] of Object.entries(named)) assert.equal(d.authoring[k], v, `${state}: ${k} named (${JSON.stringify(d.authoring)})`);
    }
  });

  test('(a) the owner approves: applied, the checks run again (blocked checks_running), then ready; a deployment request then issued (201)', (t) => {
    t.diagnostic(`at the approval: ${JSON.stringify(J.approvedRead?.build.deploy_readiness)}`);
    t.diagnostic(`after: ${JSON.stringify((J.after ?? []).map((d) => [d.state, d.blocker ?? null, d.authoring?.state ?? null]))}`);
    t.diagnostic(`deployment requests: ${JSON.stringify((J.deploy ?? []).map((r) => [r.status, r.body?.code ?? null, (r.body?.subject?.reasons ?? []).map((x) => x.code)]))}`);
    assert.equal(J.appliedStatus, 'applied', 'the Verifier\'s proposal applied');
    assert.equal(J.keys.length, 1, `the effective version has the behavioural check (${JSON.stringify(J.keys)})`);
    for (const d of [J.approvedRead.build.deploy_readiness, ...J.after]) {
      if (d.authoring) assert.equal(d.authoring.state, 'applied', `after the approval, authoring reads applied (${JSON.stringify(d.authoring)})`);
      if (d.state === 'blocked') assert.ok(['required_check_missing', 'checks_running'].includes(d.blocker?.what), JSON.stringify(d));
    }
    assert.ok(
      [J.approvedRead.build.deploy_readiness, ...J.after].some((d) => d.authoring?.state === 'applied' || d.blocker?.what === 'checks_running'),
      'applied, then the checks running, is seen before ready',
    );
    const running = J.after.find((d) => d.blocker?.what === 'checks_running');
    if (running) assert.deepEqual([running.state, running.blocker], ['blocked', { what: 'checks_running', subject: null }], JSON.stringify(running));
    const ready = J.ready.build.deploy_readiness;
    assert.equal(ready.state, 'ready', JSON.stringify(ready));
    assert.equal(J.ready.now.primary_action, 'deploy', JSON.stringify(J.ready.now));
    const [first] = J.deploy;
    if (first.status === 409) {
      assert.deepEqual((first.body.subject?.reasons ?? []).map((x) => x.code), ['SIGNOFF_MISSING'], `issued, or refused only for the sign-off the applied version renews (${first.text})`);
      assert.ok(['queued', 'running'].includes(first.body.subject?.review?.state), `the Reviewer's review queued, said in the refusal (M628) (${first.text})`);
    }
    const last = J.deploy.at(-1);
    assert.equal(last.status, 201, `issued (→ ${last.status} ${last.text})`);
    assert.equal(last.body.authorization?.status, 'issued', last.text);
  });

  test('(d) each owner request emits api.act, actor human, the route; the reads queued nothing', () => {
    assert.equal(J.workAfterReads, J.workBeforeReads, 'no GET queued work');
    const acts = routeActs(J.fx.home, J.p.id, J.seq0);
    assert.deepEqual(
      acts.map((e) => [e.actor_kind, e.payload.method, e.payload.status]),
      J.acts.map((s) => ['human', 'POST', s]),
      JSON.stringify(acts),
    );
  });
});

// ---- (b) on_phase_complete: the policy's refused request queued it ------------------------------

describe('M627 (b) under on_phase_complete: the policy\'s refused request queued the authoring; the owner\'s request reuses it', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await published(fx, 'pantry-ask-b', { alpha_deploy: 'on_phase_complete', deploy_auto_retries_max: 0 });
    J.p = p;
    await builtWith(fx, p, { built: SERVICE_BUILT });
    fx.scripted.kindScript('check_authoring', GAP_AUTHORING);
    await qualifyByFixture(fx.engine);
    await settled(fx, p.id);
    await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18672));
    // The policy requests at a tick, is refused for the gap, and the
    // Verifier is asked; its run then waits at its hold.
    for (let i = 0; i < 8 && gapAuthoring(fx.home, p.id).length === 0; i++) await tick(fx.engine, p.id);
    J.policy = policyRequests(fx.home, p.id);
    J.gapBefore = gapAuthoring(fx.home, p.id);
    J.seq0 = maxSeq(fx.home);
    J.res = await ask(fx, p.id);
    J.again = await ask(fx, p.id);
    J.gapAfter = gapAuthoring(fx.home, p.id);
    J.owner = ownerRequests(fx.home, p.id);
    J.read = await projectBody(fx, p.id);
  });
  after(async () => {
    J.fx?.scripted.release('all');
    await shared.cleanup();
  });

  test('(b) the owner\'s request: 202 reused true with the policy\'s work item, requested_by policy; no second work item', (t) => {
    t.diagnostic(`policy requests: ${JSON.stringify(J.policy)}; owner's: ${J.res.status} ${J.res.text}`);
    // The policy's request refused for the gap while the authoring it asked
    // for is under way settles like *_PENDING: no `not_issued` is recorded
    // under its key (deploy.ts), so the authoring is what shows it.
    assert.ok(J.policy.every((r) => r.outcome !== 'pending'), `the policy's request not issued (${JSON.stringify(J.policy)})`);
    assert.equal(J.gapBefore.length, 1, `the policy's refused request queued the authoring before any act of the owner's (${JSON.stringify(J.gapBefore)})`);
    assert.equal(J.gapBefore[0].trigger_evidence?.deployment?.gate, 'alpha_authorize', JSON.stringify(J.gapBefore[0].trigger_evidence));
    assert.equal(J.res.status, 202, J.res.text);
    assert.equal(itemOf(J.res), J.gapBefore[0].id, J.res.text);
    assert.deepEqual([J.res.body.reused, J.res.body.requested_by], [true, 'policy'], J.res.text);
    assert.ok(['queued', 'running'].includes(J.res.body.state), J.res.text);
    assert.equal(itemOf(J.again), J.gapBefore[0].id, J.again.text);
    assert.deepEqual([J.again.body.reused, J.again.body.requested_by], [true, 'policy'], J.again.text);
    assert.deepEqual(J.gapAfter.map((w) => w.id), [J.gapBefore[0].id], 'no second work item');
    assert.deepEqual(J.owner, [], 'no deployment request recorded as the owner\'s');
    const a = J.read.build.deploy_readiness.authoring;
    assert.ok(a && ['queued', 'running'].includes(a.state) && a.work_item === J.gapBefore[0].id && a.offer === null, JSON.stringify(J.read.build.deploy_readiness));
  });

  test('(d) both requests emit api.act, actor human, the route', () => {
    const acts = routeActs(J.fx.home, J.p.id, J.seq0);
    assert.deepEqual(acts.map((e) => [e.actor_kind, e.payload.method, e.payload.status]), [J.res.status, J.again.status].map((s) => ['human', 'POST', s]), JSON.stringify(acts));
  });
});

// ---- (c) refusals ----------------------------------------------------------------------------

describe('M627 (c) refusals: no candidate yet; nothing a Verifier could write is missing', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await published(fx, 'pantry-ask-c');
    J.p = p;
    // The environment configured before any candidate (an environment the
    // owner has not configured is none the engine deploys to: the route, as
    // a deployment request, answers 404 for it).
    await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18673));
    J.seq0 = maxSeq(fx.home);
    J.workBeforeCandidate = workCount(fx.home, p.id);
    J.noCandidate = await ask(fx, p.id);
    J.workAfterCandidate = workCount(fx.home, p.id);
    await builtWith(fx, p, { built: SERVICE_BUILT, authoring: WITH_BEHAVIOUR });
    await qualifyByFixture(fx.engine);
    await settled(fx, p.id);
    J.workBeforeReads = workCount(fx.home, p.id);
    J.read = await everyRead(fx, p.id);
    await everyRead(fx, p.id);
    J.workAfterReads = workCount(fx.home, p.id);
    J.gapBefore = gapAuthoring(fx.home, p.id);
    J.nothing = await ask(fx, p.id);
    J.gapAfter = gapAuthoring(fx.home, p.id);
    J.workAfter = workCount(fx.home, p.id);
  });
  after(() => shared.cleanup());

  test('(c) before any candidate: 409 no_candidate, nothing queued', () => {
    assert.equal(J.noCandidate.status, 409, J.noCandidate.text);
    assert.equal(J.noCandidate.body.code, 'no_candidate', J.noCandidate.text);
    assert.ok(typeof J.noCandidate.body.reason === 'string' && J.noCandidate.body.reason.length > 0, J.noCandidate.text);
    assert.equal(J.workAfterCandidate, J.workBeforeCandidate, 'nothing queued');
  });

  test('(c) the effective version has the check: 409 nothing_missing with the engine\'s reason, nothing queued', () => {
    assert.equal(J.read.build.deploy_readiness.state, 'ready', JSON.stringify(J.read.build.deploy_readiness));
    assert.equal(J.nothing.status, 409, J.nothing.text);
    assert.equal(J.nothing.body.code, 'nothing_missing', J.nothing.text);
    assert.ok(typeof J.nothing.body.reason === 'string' && J.nothing.body.reason.length > 0, J.nothing.text);
    assert.deepEqual(J.gapAfter, J.gapBefore, 'no authoring asked');
    assert.equal(J.workAfter, J.workBeforeReads, 'nothing queued');
  });

  test('(d) the refused requests emit api.act, actor human, the route; the reads queued nothing', () => {
    assert.equal(J.workAfterReads, J.workBeforeReads, 'no GET queued work');
    const acts = routeActs(J.fx.home, J.p.id, J.seq0);
    assert.deepEqual(acts.map((e) => [e.actor_kind, e.payload.method, e.payload.status]), [J.noCandidate.status, J.nothing.status].map((s) => ['human', 'POST', s]), JSON.stringify(acts));
  });
});
