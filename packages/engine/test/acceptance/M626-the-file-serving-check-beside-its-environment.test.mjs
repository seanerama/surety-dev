// M626, the file-serving check beside its environment; the deployment
// answer for a service (slice 49; kernel lane). M7 plan §3e M626; D4 §13.2,
// §13.4; D1 §3.5; DECISIONS items 41 and 42. Sean, 2026-11-24, verbatim:
// "The pending proposal should be visible. For a service that declares
// serving, show its check status beside the relevant environment in the
// project read and Everyday Workspace. … Keep Deploy available whenever the
// engine would accept the request. A pending proposal alone adds no
// deployment gate. If the required behavioral check is missing, name that as
// the blocker. Cover both cases …"
//
// Each entry of the project read's `environments[]`, of `GET …/environments`
// and `environment` of `GET …/environments/:e` carries `serving_check`:
// `{kind: 'post_deploy_serving', declared: {mode, root, entry} | null, state,
// check, proposal, decision, holds_deployment, reason}` (DECISIONS item 42).
//
// (a) a service configuration declaring `serving` while the project has a
//     required `post_deploy_behavior` check: the engine's proposal captured
//     (`proposed`, the proposal named, `decision` null), its question raised
//     (`awaiting_decision`, the decision named), approved (`approved`), applied
//     (`present` with the check's key); `declared` {mode: 'service', root,
//     entry} throughout; `holds_deployment` false; the readiness `ready`
//     throughout, its reason stating the serving check's state;
//     `primary_action` `deploy`; a deployment request admitted at every step.
// (b) the same configuration while the project has no `post_deploy_behavior`
//     check: readiness `blocked`, `blocker {what: 'required_check_missing',
//     subject: 'kind:post_deploy_behavior'}`, `decision` null, the reason
//     naming the behavioural check and what writes it; `primary_action` null;
//     the status's readiness sentence names it; `serving_check` as (a); a
//     request refused `authorization_not_issued` with ACCEPTANCE_SCOPE_INCOMPLETE
//     kind:post_deploy_behavior and the Verifier's authoring queued as today.
// (c) a static site in static mode, the engine's proposal pending:
//     `holds_deployment` true, `awaiting_decision` with the decision named;
//     readiness `blocked`, `blocker {what: 'serving_check_pending', subject:
//     'kind:post_deploy_serving'}`, `decision` the same id.
// (d) a service configuration declaring no `serving`: `declared` null,
//     `not_proposed` with the reason; or `present` with `declared` null when
//     the project already has the check; `holds_deployment` false.
// (e) an environment with no configuration: `serving_check` null.
// Everywhere: `unread` when the facts cannot be read, never `not_proposed`;
// no state served as a default.
//
// Readings this file makes (the report says them):
// - "ready throughout" in (a) is read at each state of the proposal. The
//   applied version makes the candidate's checks run again (M616 (e)); while
//   they run the readiness is `blocked` for them (`checks_running`), never
//   for the serving check; `present` is read once they have passed.
// - `primary_action` `deploy` in (a) is read where no decision is open. While
//   the proposal's question is open, NOW ranks the open decision first
//   (`waiting_on_you`, `answer_decision`; M616 (e) unchanged); the readiness
//   stays `ready` beside it. (Both this and the `checks_running` window made
//   explicit in the row by the driver's companion 0355f858.)
// - "a deployment request admitted" in (a): until the last step the adapter
//   is left unqualified, so no deployment is made in the middle of the
//   sequence; the request is refused, and its reasons are only
//   ADAPTER_UNQUALIFIED (nothing of the serving check, no scope gap). At
//   `present` the adapter is qualified and the request is issued.
//
// The projects are M616's (harness/deploy/static-journey.mjs): the design
// journey's reference project in its browser-app variant, built to its
// phase's completion on the kernel lane. A service here is the Builder's
// tree with a package.json start script (`node_service`, the only output
// local_service hosts in service mode), serving `web/`. Nothing is deployed
// but the final request of (a), which the scripted adapter answers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { definitionText } from './harness/checks/fixtures.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { KERNEL_KINDS } from './harness/design/check41.mjs';
import { stageWork } from './harness/design/drive.mjs';
import { effectiveVersion, proposalsOf, sharedFixture } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { journeyContext, phaseCompleted } from './harness/journey/drive.mjs';
import { recordChecks } from './harness/prototype.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, putConfig, qualifyByFixture, requestDeployment } from './harness/deploy/kernel.mjs';
import { PAGE_AUTHORING, PAGE_BUILT, STATIC_PAGE_BUILT, pagePublished, pageScripts } from './harness/deploy/static-journey.mjs';

const BUILD_DONE = 'The planned build and its automated gates are complete.';
const READINESS = JSON.parse(readFileSync(new URL('./contract/static-preview.json', import.meta.url), 'utf8')).readiness_states;
// DECISIONS item 42: the states `serving_check.state` takes.
const SERVING_STATES = ['present', 'awaiting_decision', 'approved', 'proposed', 'not_proposed', 'unread'];
const SERVING_FIELDS = ['kind', 'declared', 'state', 'check', 'proposal', 'decision', 'holds_deployment', 'reason'];

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const engineProposals = (home, project) => proposalsOf(home, project).filter((x) => x.proposed_by === 'engine');
const proposalStatus = (home, id) => all(home, 'SELECT "status" FROM "protected_proposals" WHERE "id" = ?', id)[0]?.status ?? null;
const gapAuthoring = (home, project) =>
  all(home, `SELECT "id", "status", "trigger_source", "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = 'authoring_gap' ORDER BY rowid`, project).map((w) => ({
    ...w,
    trigger_evidence: w.trigger_evidence === null ? null : JSON.parse(w.trigger_evidence),
  }));
const servingKeys = (home, project) => all(home, `SELECT "key" FROM "checks" WHERE "protected_version" = ? AND "kind" = 'post_deploy_serving'`, effectiveVersion(home, project).id).map((c) => c.key);

// ---- the projects ----------------------------------------------------------------------------

// The service's Builder writes M616's page (a package.json whose start
// script names a server: `node_service`), the directory its service serves
// and the program the configuration starts, under the module's own `web/`
// (a deployment request refuses a start program that is not a file of the
// sealed artifact).
const SERVED = Object.freeze({ root: 'web', entry: 'index.html' });
const SERVER = 'web/server.mjs';
const SERVICE_BUILT = Object.freeze({
  ...PAGE_BUILT,
  'web/index.html': '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><ul id="items"></ul></body></html>\n',
  [SERVER]: "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('ok')).listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n",
});

// The phase-1 authoring with a required post_deploy_behavior check of the
// alpha_complete scope beside M616's four (as the design reference's
// `operation`), its input listed file by file so the engine's proposal
// classifies as a tightening.
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

// M616's pageBuilt, with the Verifier's phase-1 authoring given.
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

// A service configuration in service mode, `serving` given or left out.
const SERVICE_CONFIG = (port, serving) => configContent({ start: [process.execPath, SERVER], port, ...(serving === undefined ? {} : { serving }) });
const STATIC_CONFIG = (port) => configContent({ mode: 'static', start: undefined, port, static: { root: '.', entry: 'index.html' } });

async function writeConfig(fx, project, name, content) {
  const res = await putConfig(fx.engine, project, name, content);
  assert.ok([200, 201].includes(res.status), `PUT …/environments/${name}/config (→ ${res.status} ${res.text})`);
  return res;
}

// ---- the three reads -------------------------------------------------------------------------

// The project read, `GET …/environments` and `GET …/environments/:e` of
// environment `name`, taken together: {project, entries: {project, list, single}}.
async function reads(fx, project, name = 'alpha') {
  const p = await fx.engine.get(`/v1/projects/${project}`);
  assert.equal(p.status, 200, `GET /v1/projects/${project} (→ ${p.status} ${p.text})`);
  const l = await fx.engine.get(`/v1/projects/${project}/environments`);
  assert.equal(l.status, 200, `GET …/environments (→ ${l.status} ${l.text})`);
  const s = await fx.engine.get(`/v1/projects/${project}/environments/${name}`);
  assert.equal(s.status, 200, `GET …/environments/${name} (→ ${s.status} ${s.text})`);
  return {
    project: p.body.project,
    entries: {
      'the project read': (p.body.project.environments ?? []).find((e) => e.name === name),
      'GET …/environments': (l.body.environments ?? []).find((e) => e.name === name),
      'GET …/environments/:e': s.body.environment,
    },
  };
}

// `serving_check` of the environment on all three reads: present on each
// entry, the same on each; returned.
function servingCheck(r) {
  const values = Object.entries(r.entries).map(([where, entry]) => {
    assert.ok(entry, `${where} serves the environment`);
    assert.ok(Object.hasOwn(entry, 'serving_check'), `${where}: the entry carries serving_check (keys: ${Object.keys(entry).join(', ')})`);
    return [where, entry.serving_check];
  });
  const [[, first]] = values;
  for (const [where, value] of values.slice(1)) assert.deepEqual(value, first, `${where} serves the same serving_check as the project read`);
  if (first !== null) {
    for (const k of SERVING_FIELDS) assert.ok(Object.hasOwn(first, k), `serving_check has ${k} (${JSON.stringify(first)})`);
    assert.equal(first.kind, 'post_deploy_serving');
    assert.ok(SERVING_STATES.includes(first.state), `a state of the shape (${first.state})`);
    assert.equal(typeof first.holds_deployment, 'boolean', 'holds_deployment is a boolean');
    assert.ok(typeof first.reason === 'string' && first.reason.length > 0, `with the engine's sentence (${JSON.stringify(first)})`);
  }
  return first;
}

// The refusal's reasons, as {code: subjects}.
const reasonsOf = (res) => Object.fromEntries((res.body?.subject?.reasons ?? []).map((x) => [x.code, x.subjects ?? []]));
const namesServing = (res) => JSON.stringify(res.body?.subject?.reasons ?? []).includes('post_deploy_serving');

// ---- (a) and (d) present: a service with its behavioural check ---------------------------------

describe('M626 (a) a service declaring serving, its behavioural check required: the proposal beside the environment at every state; ready throughout; a request admitted', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-serve-a' });
    J.p = p;
    await builtWith(fx, p, { built: SERVICE_BUILT, authoring: WITH_BEHAVIOUR });
    J.built = await reads(fx, p.id);
    J.config = await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18661, SERVED));
    J.proposal = engineProposals(fx.home, p.id)[0];
    J.proposed = await reads(fx, p.id);
    J.req = { proposed: await requestDeployment(fx.engine, p.id, J.proposed.project.checks.candidate, 'alpha') };
    if (!J.proposal) return;
    J.decision = await openDecision(fx, p.id, 'check_correction_tightening', J.proposal.id, { max: 8 });
    J.asked = await reads(fx, p.id);
    J.req.asked = await requestDeployment(fx.engine, p.id, J.asked.project.checks.candidate, 'alpha');
    await consume(fx, p.id, J.decision, 'approve');
    J.approvedStatus = proposalStatus(fx.home, J.proposal.id);
    J.approved = await reads(fx, p.id);
    J.req.approved = await requestDeployment(fx.engine, p.id, J.approved.project.checks.candidate, 'alpha');
    J.pendingOps = all(fx.home, `SELECT o."id", s."journal_kind" AS "kind", s."state" FROM "operations" o JOIN "git_journal_state" s ON s."operation" = o."id" WHERE o."id" IN (SELECT value FROM json_each(?))`, JSON.stringify(reasonsOf(J.req.approved).GIT_JOURNAL_PENDING ?? []));
    await tickUntil(fx.engine, p.id, () => (proposalStatus(fx.home, J.proposal.id) === 'applied' ? true : undefined), { max: 8, what: "the engine's serving check applied" });
    J.applied = await reads(fx, p.id);
    for (let i = 0; i < 8 && (await reads(fx, p.id)).project.build.deploy_readiness.state !== 'ready'; i++) {
      await recordChecks(fx, p.id);
      await tick(fx.engine, p.id);
    }
    J.present = await reads(fx, p.id);
    J.keys = servingKeys(fx.home, p.id);
    // (d), the project already having the check: another environment
    // configured in service mode declaring no serving.
    await writeConfig(fx, p.id, 'beta', SERVICE_CONFIG(18662));
    J.beta = await reads(fx, p.id, 'beta');
    J.alphaBeside = await reads(fx, p.id);
    // The request at `present`, the adapter qualified now.
    // The applied version changed the content the candidate's Reviewer
    // sign-off binds: the first request may be refused SIGNOFF_MISSING alone,
    // which queues the Reviewer (alpha-review.ts); requested again once it
    // has signed off.
    await qualifyByFixture(fx.engine);
    const candidate = J.alphaBeside.project.checks.candidate;
    J.req.present = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
    J.req.again = [];
    for (let i = 0, last = J.req.present; i < 12 && last.status === 409; i++) {
      await tick(fx.engine, p.id);
      last = await requestDeployment(fx.engine, p.id, candidate, 'alpha');
      J.req.again.push(last);
    }
  });
  after(() => shared.cleanup());

  test('(a) the fixture: a Node service, its environment hostable in service mode, the engine\'s proposal captured on the configuration declaring serving', () => {
    assert.equal(J.built.project.build.complete, true);
    assert.equal(J.built.project.deployment_compatibility.output_kind, 'node_service', J.built.project.deployment_compatibility.reason);
    assert.ok(J.proposal, `the engine proposed its serving check (proposals: ${JSON.stringify(proposalsOf(J.fx.home, J.p.id).map((x) => [x.id, x.proposed_by, x.status]))})`);
    assert.equal(J.config.body.serving_check?.proposal, J.proposal.id, `the configuration's answer names it (${JSON.stringify(J.config.body.serving_check)})`);
  });

  test('(a) proposed: the proposal named, no decision yet, declared {mode: service, root, entry}, not holding deployment', () => {
    const sc = servingCheck(J.proposed);
    assert.equal(sc?.state, 'proposed', JSON.stringify(sc));
    assert.equal(sc.proposal, J.proposal.id);
    assert.equal(sc.decision, null, 'its question is not raised yet');
    assert.equal(sc.check, null, 'no check present');
    assert.deepEqual(sc.declared, { mode: 'service', ...SERVED });
    assert.equal(sc.holds_deployment, false, 'a pending proposal alone adds no deployment gate');
  });

  test('(a) awaiting_decision: the open check_correction_tightening decision named', () => {
    const sc = servingCheck(J.asked);
    assert.equal(sc?.state, 'awaiting_decision', JSON.stringify(sc));
    assert.equal(sc.decision, J.decision.id, 'the open decision named');
    assert.equal(sc.proposal, J.proposal.id);
    assert.equal(sc.check, null);
    assert.deepEqual(sc.declared, { mode: 'service', ...SERVED });
    assert.equal(sc.holds_deployment, false);
  });

  test('(a) approved: approved by the owner, not yet applied', () => {
    assert.equal(J.approvedStatus, 'approved', `read while the proposal is approved and not applied (${J.approvedStatus})`);
    const sc = servingCheck(J.approved);
    assert.equal(sc?.state, 'approved', JSON.stringify(sc));
    assert.equal(sc.proposal, J.proposal.id);
    assert.equal(sc.decision, null, 'the decision is answered');
    assert.equal(sc.check, null);
    assert.deepEqual(sc.declared, { mode: 'service', ...SERVED });
    assert.equal(sc.holds_deployment, false);
  });

  test('(a) present: the check\'s key, once applied', () => {
    assert.equal(J.keys.length, 1, `one serving check in the effective version (${JSON.stringify(J.keys)})`);
    for (const [what, r] of [['the checks running', J.applied], ['the checks passed', J.present]]) {
      const sc = servingCheck(r);
      assert.equal(sc?.state, 'present', `${what}: ${JSON.stringify(sc)}`);
      assert.equal(sc.check, J.keys[0], `${what}: the present check's key`);
      assert.equal(sc.decision, null);
      assert.deepEqual(sc.declared, { mode: 'service', ...SERVED });
      assert.equal(sc.holds_deployment, false);
    }
  });

  test('(a) the readiness ready at every state of the proposal, its reason stating the serving check\'s state; never blocked by it', () => {
    const states = { proposed: J.proposed, awaiting_decision: J.asked, approved: J.approved, present: J.present };
    for (const [what, r] of Object.entries(states)) {
      const d = r.project.build.deploy_readiness;
      assert.equal(d.state, 'ready', `${what}: ${JSON.stringify(d)}`);
      assert.equal(d.environment, 'alpha');
      assert.match(d.reason, /^The environment alpha can host this output \(Node service\) with local_service in service mode\./, `${what}: ${d.reason}`);
      assert.match(d.reason, /serving check/i, `${what}: the reason states the serving check's state (${d.reason})`);
      assert.equal(d.blocker ?? null, null, `${what}: no blocker while ready`);
      for (const s of ['deployment_checks_authoring', 'request_again']) assert.ok(!(d.follows ?? []).includes(s), `${what}: ${s} cannot follow a request that would be authorized (${JSON.stringify(d.follows)})`);
    }
    assert.notEqual(J.proposed.project.build.deploy_readiness.reason, J.present.project.build.deploy_readiness.reason, 'the reason changes with the serving check\'s state');
    // The applied version made the candidate's checks run again: blocked for them, not for the serving check.
    const running = J.applied.project.build.deploy_readiness;
    if (running.state !== 'ready') {
      assert.equal(running.state, 'blocked', JSON.stringify(running));
      assert.deepEqual(running.blocker, { what: 'checks_running', subject: null }, JSON.stringify(running));
      assert.match(running.reason, /automated checks are running/, `blocked for the checks (${running.reason})`);
    }
  });

  test('(a) primary_action deploy where no decision is open; with the proposal\'s question open, the decision first in NOW and the readiness ready beside it', () => {
    for (const [what, r] of [['proposed', J.proposed], ['approved', J.approved], ['present', J.present]]) {
      assert.equal(r.project.now.state, 'build_complete', `${what}: ${JSON.stringify(r.project.now)}`);
      assert.equal(r.project.now.primary_action, 'deploy', `${what}: ${JSON.stringify(r.project.now)}`);
      assert.ok(r.project.now.reason.startsWith(`${BUILD_DONE} It is ready to request deployment to alpha (Node service, local_service service mode)`), `${what}: ${r.project.now.reason}`);
    }
    assert.deepEqual([J.asked.project.now.state, J.asked.project.now.primary_action], ['waiting_on_you', 'answer_decision'], JSON.stringify(J.asked.project.now));
  });

  // The adapter left unqualified until `present` (no deployment in the
  // middle of the sequence): ADAPTER_UNQUALIFIED; and, read at the instant
  // of the approval, a git operation of the project's journal in flight
  // (GIT_JOURNAL_PENDING, a reason that settles at the next tick, D6 K2),
  // never the serving check or a scope gap.
  const OTHER = ['ADAPTER_UNQUALIFIED', 'GIT_JOURNAL_PENDING'];
  test('(a) a deployment request admitted at every step: refused only for the adapter left unqualified (and a journal operation settling), nothing of the serving check; issued at present', (t) => {
    t.diagnostic(`journal operations in flight at the approval's request: ${JSON.stringify(J.pendingOps)}`);
    for (const what of ['proposed', 'asked', 'approved']) {
      const res = J.req[what];
      assert.equal(res.status, 409, `${what}: ${res.status} ${res.text}`);
      assert.equal(res.body.code, 'authorization_not_issued');
      const codes = Object.keys(reasonsOf(res));
      assert.ok(codes.includes('ADAPTER_UNQUALIFIED') && codes.every((c) => OTHER.includes(c)), `${what}: the adapter, nothing else lasting (${JSON.stringify(res.body.subject?.reasons)}; journal operations ${JSON.stringify(J.pendingOps)})`);
      assert.equal(namesServing(res), false, `${what}: nothing of the serving check`);
    }
    const first = J.req.present;
    t.diagnostic(`at present: the first request ${first.status} ${JSON.stringify(first.body?.subject?.reasons ?? null)}; requested again ${J.req.again.length} time(s), last ${J.req.again.at(-1)?.status ?? '-'}`);
    if (first.status === 409) {
      assert.deepEqual(Object.keys(reasonsOf(first)), ['SIGNOFF_MISSING'], `present, qualified: issued, or refused only for the sign-off the applied version renews (${first.text})`);
      assert.match(first.body.what_to_do, /Reviewer/, first.body.what_to_do);
      for (const res of J.req.again.slice(0, -1)) assert.equal(namesServing(res), false, res.text);
    }
    const res = first.status === 409 ? J.req.again.at(-1) : first;
    assert.ok(res && [200, 201].includes(res.status), `present, qualified: issued (→ ${res?.status} ${res?.text})`);
    assert.equal(res.body.authorization?.status, 'issued', res.text);
  });

  test('(d) the project already having the check: a service configuration declaring no serving reads present with declared null, not holding deployment', () => {
    const sc = servingCheck(J.beta);
    assert.equal(sc?.state, 'present', JSON.stringify(sc));
    assert.equal(sc.declared, null, 'no serving declared');
    assert.equal(sc.check, J.keys[0]);
    assert.equal(sc.proposal ?? null, null);
    assert.equal(sc.holds_deployment, false);
    assert.equal(servingCheck(J.alphaBeside)?.state, 'present', 'alpha\'s unchanged beside it');
  });
});

// ---- (b) a service without its behavioural check ----------------------------------------------

describe('M626 (b) a service declaring serving with no behavioural check: blocked, naming the missing required check; the serving check beside the environment as (a)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-serve-b' });
    J.p = p;
    await builtWith(fx, p, { built: SERVICE_BUILT });
    await qualifyByFixture(fx.engine);
    await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18663, SERVED));
    J.proposal = engineProposals(fx.home, p.id)[0];
    J.proposed = await reads(fx, p.id);
    if (J.proposal) {
      J.decision = await openDecision(fx, p.id, 'check_correction_tightening', J.proposal.id, { max: 8 });
      J.asked = await reads(fx, p.id);
    }
    J.gapBefore = gapAuthoring(fx.home, p.id);
    J.req = await requestDeployment(fx.engine, p.id, J.proposed.project.checks.candidate, 'alpha');
    J.gapAfter = gapAuthoring(fx.home, p.id);
  });
  after(() => shared.cleanup());

  const BEHAVIOUR = /post_deploy_behavior|behaviou?ral/i;

  test('(b) blocked: blocker required_check_missing kind:post_deploy_behavior, no decision, the reason naming the behavioural check and what writes it', () => {
    for (const [what, r] of [['proposed', J.proposed], ['awaiting_decision', J.asked]]) {
      assert.ok(r, `${what} was read`);
      const d = r.project.build.deploy_readiness;
      assert.equal(d.state, 'blocked', `${what}: ${JSON.stringify(d)}`);
      assert.deepEqual(d.blocker, { what: 'required_check_missing', subject: 'kind:post_deploy_behavior' }, `${what}: ${JSON.stringify(d)}`);
      assert.equal(d.decision, null, `${what}: no decision settles it (the serving check's does not)`);
      assert.equal(d.environment, 'alpha');
      assert.match(d.reason, BEHAVIOUR, `${what}: the reason names the behavioural check (${d.reason})`);
      assert.match(d.reason, /Verifier/, `${what}: and what writes it (${d.reason})`);
      assert.ok(READINESS.includes(d.state));
    }
  });

  test('(b) primary_action null; the status\'s readiness sentence names the missing check', () => {
    const now = J.proposed.project.now;
    assert.equal(now.state, 'build_complete', JSON.stringify(now));
    assert.equal(now.primary_action, null, 'never deploy while blocked; no decision settles it');
    assert.ok(now.reason.startsWith(`${BUILD_DONE} `), now.reason);
    assert.match(now.reason.slice(BUILD_DONE.length), BEHAVIOUR, now.reason);
    assert.notEqual(J.asked.project.now.primary_action, 'deploy', JSON.stringify(J.asked.project.now));
  });

  test('(b) serving_check beside the environment as (a): proposed, then awaiting_decision; declared service; not holding deployment', () => {
    assert.ok(J.proposal, 'the engine proposed its serving check');
    const proposed = servingCheck(J.proposed);
    assert.deepEqual([proposed?.state, proposed.proposal, proposed.decision, proposed.check], ['proposed', J.proposal.id, null, null], JSON.stringify(proposed));
    const asked = servingCheck(J.asked);
    assert.deepEqual([asked?.state, asked.proposal, asked.decision, asked.check], ['awaiting_decision', J.proposal.id, J.decision.id, null], JSON.stringify(asked));
    for (const sc of [proposed, asked]) {
      assert.deepEqual(sc.declared, { mode: 'service', ...SERVED });
      assert.equal(sc.holds_deployment, false);
    }
  });

  test('(b) a request refused authorization_not_issued with ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior; the Verifier\'s authoring queued as today', () => {
    assert.equal(J.req.status, 409, J.req.text);
    assert.equal(J.req.body.code, 'authorization_not_issued');
    const reasons = reasonsOf(J.req);
    assert.deepEqual(reasons.ACCEPTANCE_SCOPE_INCOMPLETE, ['kind:post_deploy_behavior'], JSON.stringify(J.req.body.subject?.reasons));
    assert.equal(namesServing(J.req), false, 'nothing of the serving check');
    assert.deepEqual(J.gapBefore, [], 'no authoring asked before the request');
    assert.equal(J.gapAfter.length, 1, `one check_authoring for the deployment gap (${JSON.stringify(J.gapAfter)})`);
    const ev = J.gapAfter[0].trigger_evidence?.deployment;
    assert.equal(ev?.gate, 'alpha_authorize', JSON.stringify(J.gapAfter[0].trigger_evidence));
    assert.equal(ev.environment, 'alpha');
    assert.deepEqual(ev.missing, { kinds: ['post_deploy_behavior'], criteria: [], areas: [] });
    assert.match(J.req.body.what_to_do, /being authored/, J.req.body.what_to_do);
  });
});

// ---- (c) a static site, the engine's proposal pending ------------------------------------------

describe('M626 (c) a static site in static mode, its serving check pending: holding deployment; blocked serving_check_pending with the decision', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-static-c' });
    await builtWith(fx, p, { built: STATIC_PAGE_BUILT });
    await writeConfig(fx, p.id, 'alpha', STATIC_CONFIG(18664));
    J.proposal = engineProposals(fx.home, p.id)[0];
    J.proposed = await reads(fx, p.id);
    if (J.proposal) {
      J.decision = await openDecision(fx, p.id, 'check_correction_tightening', J.proposal.id, { max: 8 });
      J.asked = await reads(fx, p.id);
    }
  });
  after(() => shared.cleanup());

  test('(c) awaiting_decision with the decision named, holding deployment, declared static', () => {
    assert.ok(J.proposal && J.asked, 'the engine proposed its serving check and its question was raised');
    assert.equal(J.asked.project.deployment_compatibility.output_kind, 'static_site', J.asked.project.deployment_compatibility.reason);
    const sc = servingCheck(J.asked);
    assert.equal(sc?.state, 'awaiting_decision', JSON.stringify(sc));
    assert.equal(sc.decision, J.decision.id);
    assert.equal(sc.proposal, J.proposal.id);
    assert.equal(sc.holds_deployment, true, 'a static site in static mode: its absence refuses a request');
    assert.deepEqual(sc.declared, { mode: 'static', root: '.', entry: 'index.html' });
    const before = servingCheck(J.proposed);
    assert.deepEqual([before?.state, before.decision, before.holds_deployment], ['proposed', null, true], JSON.stringify(before));
  });

  test('(c) blocked, blocker serving_check_pending kind:post_deploy_serving, decision the same id (M616 (e), the blocker added)', () => {
    const d = J.asked.project.build.deploy_readiness;
    assert.equal(d.state, 'blocked', JSON.stringify(d));
    assert.deepEqual(d.blocker, { what: 'serving_check_pending', subject: 'kind:post_deploy_serving' }, JSON.stringify(d));
    assert.equal(d.decision, J.decision.id);
    const p = J.proposed.project.build.deploy_readiness;
    assert.deepEqual([p.state, p.decision], ['blocked', null], JSON.stringify(p));
    assert.deepEqual(p.blocker, { what: 'serving_check_pending', subject: 'kind:post_deploy_serving' }, JSON.stringify(p));
  });
});

// ---- (d) and (e): a service declaring no serving; an environment not configured -----------------

describe('M626 (d), (e) a service configuration declaring no serving; an environment with no configuration', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-serve-d' });
    J.p = p;
    J.published = await reads(fx, p.id);
    await builtWith(fx, p, { built: SERVICE_BUILT, authoring: WITH_BEHAVIOUR });
    J.built = await reads(fx, p.id);
    await writeConfig(fx, p.id, 'alpha', SERVICE_CONFIG(18665));
    J.proposals = engineProposals(fx.home, p.id);
    J.configured = await reads(fx, p.id);
  });
  after(() => shared.cleanup());

  test('(e) no configuration: serving_check null on all three reads, the entry otherwise as today', () => {
    for (const [what, r] of [['at the publication', J.published], ['built', J.built]]) {
      assert.equal(servingCheck(r), null, `${what}: no configuration, no serving check beside it`);
      for (const [where, entry] of Object.entries(r.entries)) {
        assert.equal(entry.name, 'alpha', `${what}, ${where}`);
        assert.match(entry.id, /^env_/, `${what}, ${where}`);
        // The list entries carry the observed state (D1 §3.5); the
        // environment read its stored read (SEAM.md §255), `observed` among it.
        const today = where === 'GET …/environments/:e' ? ['observed', 'conditions', 'supervision'] : ['state', 'observed'];
        for (const k of today) assert.ok(k in entry, `${what}, ${where}: ${k}, the entry as today (${Object.keys(entry).join(', ')})`);
      }
    }
    assert.equal(J.built.project.build.deploy_readiness.state, 'unconfigured');
  });

  test('(d) declared null, not_proposed with the reason that no serving root and entry is declared; not holding deployment', () => {
    assert.deepEqual(J.proposals, [], 'nothing proposed for a service declaring no serving');
    const sc = servingCheck(J.configured);
    assert.equal(sc?.state, 'not_proposed', JSON.stringify(sc));
    assert.equal(sc.declared, null);
    assert.equal(sc.proposal, null);
    assert.equal(sc.decision, null);
    assert.equal(sc.check, null);
    assert.equal(sc.holds_deployment, false);
    assert.match(sc.reason, /serving/i, sc.reason);
    assert.match(sc.reason, /declares? no serving|no serving root|does not declare/i, `the reason says the configuration declares no serving root and entry (${sc.reason})`);
  });

  test('(d) its readiness: ready, the behavioural check in place; no serving gate', () => {
    const d = J.configured.project.build.deploy_readiness;
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(J.configured.project.now.primary_action, 'deploy');
  });
});
