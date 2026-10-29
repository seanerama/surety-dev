// M616, deployment compatibility before the build; readiness apart from
// completion (slice 49; kernel lane). M7 plan §3b M616; D4 §13.4 (the
// owner's instruction of 2026-10-29: "Before a build begins, Surety should
// establish that the selected target can host the intended output—or
// clearly explain the missing capability. 'Build complete' must distinguish
// completed implementation from readiness to deploy"); D6 §6.2; SEAM.md
// §§577, 578.
//
// (a) a plan bundle published for a browser app with an environment
//     declared by the specification: `deployment.compatibility_evaluated`
//     once; `output_kind static_site`, the environment `unconfigured`,
//     `hosting_required false`; the plan not blocked, no decision raised;
// (b) the environment configured in service mode: `unsupported`, the
//     missing capability naming static mode; then in static mode: `hostable`;
// (c) a Node service's bundle: `node_service`, `hosting_required true`;
//     silence: `unknown` with the reason, never hostable;
// (d) a candidate's tree disagreeing with the architecture: the tree's kind
//     served with the disagreement in the reason;
// (e) `build.deploy_readiness` and the `build_complete` status:
//     `not_complete` while building; then each readiness with its reason and
//     environment; the status's first sentence "The planned build and its
//     automated gates are complete." followed by the readiness sentence;
//     `primary_action` `deploy` only when ready, `configure_environment`
//     when unconfigured, else null; and (the owner's ruling of 2026-10-29,
//     the plan's M616 (e)) `blocked` while the engine would refuse a deploy
//     now: a static page whose engine serving check is proposed and not yet
//     applied (the reason naming the proposal and, while its question is
//     open, the decision, served as `decision`, `primary_action`
//     `answer_decision`), then the candidate's checks running (the reason
//     naming them); never `deploy` while blocked; `ready` once they pass.
//     The relay's `host` and `url` on the environment read need a real unit
//     (the scripted adapter opens no relay): M613 (d)'s file reads them.
//
// Every project is the design journey's reference project in a variant
// (harness/deploy/static-journey.mjs), reaching its published plan through
// the owner's routes (D6 §1 steps 1 to 4); the browser app is built to its
// phase's completion on the kernel lane. Nothing is deployed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { consume, openDecision, reject } from './harness/decisions.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { proposalsOf, sharedFixture } from './harness/gates.mjs';
import { recordChecks } from './harness/prototype.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, configure } from './harness/deploy/kernel.mjs';
import { STATIC_PAGE_BUILT, pageBuilt, pagePublished, servicePublished, silentPublished } from './harness/deploy/static-journey.mjs';

const BUILD_DONE = 'The planned build and its automated gates are complete.';
// The owner's ruling of 2026-10-29 (objection 226): `ready` means ready to
// request deployment, not verified and not open, and says what follows.
const READY_TO_REQUEST = (where) => `${BUILD_DONE} It is ready to request deployment to alpha (${where}), not verified and not open: `;
const FOLLOWS_END = / follow before the preview opens\b/;
async function listSummary(fx, id) {
  const res = await fx.engine.get('/v1/projects');
  assert.equal(res.status, 200, `GET /v1/projects (→ ${res.status} ${res.text})`);
  return res.body.projects.find((x) => x.id === id);
}
// The readiness states the plan's M616 (e) names (contract/static-preview.json, SEAM.md §579).
const READINESS = JSON.parse(readFileSync(new URL('./contract/static-preview.json', import.meta.url), 'utf8')).readiness_states;
const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

const compatibilityEvents = (home, project) => eventsOfType(home, 'deployment.compatibility_evaluated').filter((e) => e.subject?.project === project);
async function projectRead(fx, project) {
  const res = await fx.engine.get(`/v1/projects/${project}`);
  assert.equal(res.status, 200, `GET /v1/projects/${project} (→ ${res.status} ${res.text})`);
  return res.body.project;
}
const decisionsOf = (home, project) => all(home, 'SELECT "id", "kind", "status", "created_at" FROM "decisions" WHERE "project" = ? ORDER BY rowid', project);
const STATIC_CONFIG = (port) => configContent({ mode: 'static', start: undefined, port });
const SERVICE_CONFIG = (port) => configContent({ start: [process.execPath, 'server.mjs'], port });

describe('M616 (a), (d), (e) a browser app: its compatibility at publication, its readiness through its build', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx);
    J.p = p;
    J.atPublish = {
      events: compatibilityEvents(fx.home, p.id),
      published: eventsOfType(fx.home, 'plan.published').filter((e) => e.subject?.project === p.id),
      read: await projectRead(fx, p.id),
      env: (await fx.engine.get(`/v1/projects/${p.id}/environments/alpha`)).body?.environment,
      decisions: decisionsOf(fx.home, p.id),
      stageWork: all(fx.home, `SELECT "id", "status", "blocker" FROM "work_items" WHERE "project" = ? AND "kind" = 'stage_build'`, p.id),
    };
    J.building = await projectRead(fx, p.id);
    J.built = await pageBuilt(fx, p);
    J.complete = await projectRead(fx, p.id);
    J.candidates = all(fx.home, 'SELECT "id", "revision" FROM "candidates" WHERE "project" = ? ORDER BY "seq"', p.id);
    J.eventsAtComplete = compatibilityEvents(fx.home, p.id);
    await configure(fx.engine, p.id, 'alpha', STATIC_CONFIG(18631));
    J.inStatic = await projectRead(fx, p.id);
    await configure(fx.engine, p.id, 'alpha', SERVICE_CONFIG(18631));
    J.inService = await projectRead(fx, p.id);
  });
  after(() => shared.cleanup());

  test('(a) deployment.compatibility_evaluated once, at the plan\'s publication', () => {
    assert.equal(J.atPublish.published.length, 1, 'the plan was published once');
    assert.equal(J.atPublish.events.length, 1, `one evaluation (${JSON.stringify(J.atPublish.events.map((e) => e.payload))})`);
    const [e] = J.atPublish.events;
    assert.equal(e.payload.trigger, 'plan_published');
    assert.equal(e.payload.output_kind, 'static_site');
    assert.equal(e.payload.hosting_required, false);
    assert.ok(e.seq > J.atPublish.published[0].seq - 2 && e.seq < J.atPublish.published[0].seq + 2, `recorded with the publication (event ${e.seq}, plan.published ${J.atPublish.published[0].seq})`);
  });

  test('(a) output_kind static_site, the environment the specification declares unconfigured, hosting_required false', () => {
    const c = J.atPublish.read.deployment_compatibility;
    assert.equal(c.output_kind, 'static_site');
    assert.equal(c.hosting_required, false);
    assert.equal(c.environments.length, 1);
    assert.deepEqual([c.environments[0].name, c.environments[0].state, c.environments[0].adapter, c.environments[0].mode], ['alpha', 'unconfigured', null, null]);
    assert.ok(typeof c.reason === 'string' && c.reason.includes('web browser (html_css)'), `the reason says what the kind was read from (${c.reason})`);
    assert.deepEqual(J.atPublish.env?.deployment_compatibility?.environments, c.environments, 'the environment read serves its entry');
  });

  test('(a) the plan not blocked, no decision raised by it', () => {
    assert.equal(J.atPublish.stageWork.length, 1, 'the stage\'s work item was created');
    for (const w of J.atPublish.stageWork) {
      assert.ok(!['cancelled', 'parked'].includes(w.status), `the stage work is not parked or cancelled (${w.status})`);
      assert.doesNotMatch(w.blocker ?? '', /deploy|compatib|environment|hosting/i, 'no hold names the deployment');
    }
    const open = J.atPublish.decisions.filter((d) => d.status === 'open');
    assert.deepEqual(open, [], `no decision is open at the publication (${JSON.stringify(J.atPublish.decisions)})`);
    assert.deepEqual(J.atPublish.decisions.map((d) => d.kind).sort(), ['architecture_approval', 'plan_approval', 'spec_approval'], 'the owner\'s questions are the journey\'s own, nothing more');
  });

  test('(d) a candidate\'s tree disagreeing with the architecture: the tree\'s kind, with the disagreement in the reason', () => {
    assert.ok(J.candidates.length >= 1, 'the build nominated a candidate');
    const c = J.complete.deployment_compatibility;
    assert.equal(c.output_kind, 'node_service', `the tree's package.json start script decides (${c.reason})`);
    assert.match(c.reason, /package\.json start script/);
    assert.match(c.reason, /The approved architecture says otherwise \(.*web browser.*\); the candidate's tree decides\./, c.reason);
    assert.equal(c.hosting_required, true);
    assert.ok(J.eventsAtComplete.some((e) => e.payload.trigger === 'candidate_nominated' && e.payload.output_kind === 'node_service'), 'the nomination evaluated it from the tree');
  });

  test('(e) not_complete while building', () => {
    assert.equal(J.building.build.complete, false);
    assert.equal(J.building.build.deploy_readiness.state, 'not_complete');
    assert.equal(J.building.build.deploy_readiness.environment, 'alpha');
    assert.ok(J.building.build.deploy_readiness.reason.length > 0);
    assert.notEqual(J.building.now.state, 'build_complete');
  });

  test('(e) complete, the environment not configured: unconfigured, configure_environment; the text keeps implementation apart from deployment', () => {
    assert.equal(J.complete.build.complete, true);
    assert.deepEqual(J.complete.build.deploy_readiness, { state: 'unconfigured', reason: 'The environment alpha is not configured for hosting yet.', environment: 'alpha' });
    assert.equal(J.complete.now.state, 'build_complete', JSON.stringify(J.complete.now));
    assert.equal(J.complete.now.reason, `${BUILD_DONE} Its environment alpha is not configured for hosting yet.`);
    assert.equal(J.complete.now.primary_action, 'configure_environment');
  });

  test('(e) complete, configured where it cannot be hosted: unsupported with the missing capability, no primary action', () => {
    const r = J.inStatic.build.deploy_readiness;
    assert.equal(r.state, 'unsupported');
    assert.equal(r.environment, 'alpha');
    assert.match(r.reason, /^The environment alpha cannot host this output: .*configure the environment in service mode\.$/, r.reason);
    assert.equal(J.inStatic.now.state, 'build_complete', JSON.stringify(J.inStatic.now));
    assert.ok(J.inStatic.now.reason.startsWith(`${BUILD_DONE} Its environment alpha cannot host this output: `), J.inStatic.now.reason);
    assert.equal(J.inStatic.now.primary_action, null);
  });

  test('(e) complete, configured where it can be hosted: ready, deploy', () => {
    const r = J.inService.build.deploy_readiness;
    assert.equal(r.state, 'ready');
    assert.equal(r.environment, 'alpha');
    assert.match(r.reason, /^The environment alpha can host this output \(Node service\) with local_service in service mode\./, r.reason);
    // Objection 226, the owner's ruling of 2026-10-29: ready to request
    // deployment, not verified and not open; what follows is named.
    assert.equal(r.means, 'request_deployment');
    assert.deepEqual(r.follows, ['deployment_checks_authoring', 'approval', 'request_again', 'deployment', 'verification'], 'no deployment-specific post-deploy check yet: its authoring, its approval, the request again, the deployment and its verification');
    assert.match(r.reason, /Ready to request deployment, not verified and not open: /, r.reason);
    assert.equal(J.inService.now.state, 'build_complete', JSON.stringify(J.inService.now));
    assert.ok(J.inService.now.reason.startsWith(READY_TO_REQUEST('Node service, local_service service mode')), J.inService.now.reason);
    assert.match(J.inService.now.reason, FOLLOWS_END, J.inService.now.reason);
    assert.match(J.inService.now.reason, /approval/, 'it says the approval follows');
    assert.match(J.inService.now.reason, /verification/, 'and the verification');
    assert.equal(J.inService.now.primary_action, 'deploy');
    assert.doesNotMatch(J.inService.now.reason, /visual|accept|production/i, 'nothing claims acceptance or production readiness');
  });
});

describe('M616 (b) a browser app\'s environment configured in service mode, then in static mode', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-page-b' });
    J.p = p;
    await configure(fx.engine, p.id, 'alpha', SERVICE_CONFIG(18632));
    J.service = { read: await projectRead(fx, p.id), events: compatibilityEvents(fx.home, p.id) };
    await configure(fx.engine, p.id, 'alpha', STATIC_CONFIG(18632));
    J.static = { read: await projectRead(fx, p.id), events: compatibilityEvents(fx.home, p.id) };
  });
  after(() => shared.cleanup());

  test('(b) service mode: unsupported, the missing capability naming static mode', () => {
    const [e] = J.service.read.deployment_compatibility.environments;
    assert.deepEqual([e.name, e.adapter, e.mode, e.state], ['alpha', 'local_service', 'service', 'unsupported']);
    assert.match(e.missing_capability, /static mode/, e.missing_capability);
    assert.match(e.reason, /cannot host this output/);
    assert.deepEqual(J.service.events.map((x) => [x.payload.trigger, x.payload.environments.map((y) => y.state)]), [['plan_published', ['unconfigured']], ['environment_configured', ['unsupported']]]);
  });

  test('(b) static mode: hostable', () => {
    const [e] = J.static.read.deployment_compatibility.environments;
    assert.deepEqual([e.name, e.adapter, e.mode, e.state, e.missing_capability], ['alpha', 'local_service', 'static', 'hostable', null]);
    assert.equal(J.static.read.deployment_compatibility.output_kind, 'static_site');
    assert.equal(J.static.events.at(-1).payload.trigger, 'environment_configured');
    assert.equal(J.static.events.length, 3, 'one evaluation per configuration');
  });
});

describe('M616 (c) a Node service\'s bundle; silence', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p: service } = await servicePublished(fx);
    J.service = await projectRead(fx, service.id);
    J.serviceEvents = compatibilityEvents(fx.home, service.id);
    const { p: silent } = await silentPublished(fx);
    J.silent = await projectRead(fx, silent.id);
    await configure(fx.engine, silent.id, 'alpha', SERVICE_CONFIG(18633));
    J.silentService = await projectRead(fx, silent.id);
    await configure(fx.engine, silent.id, 'alpha', STATIC_CONFIG(18633));
    J.silentStatic = await projectRead(fx, silent.id);
  });
  after(() => shared.cleanup());

  test('(c) a Node service\'s bundle: node_service, hosting_required true', () => {
    const c = J.service.deployment_compatibility;
    assert.equal(c.output_kind, 'node_service');
    assert.equal(c.hosting_required, true);
    assert.match(c.reason, /node server\.mjs/, c.reason);
    assert.deepEqual(J.serviceEvents.map((e) => [e.payload.trigger, e.payload.output_kind, e.payload.hosting_required]), [['plan_published', 'node_service', true]]);
  });

  test('(c) silence: unknown with the reason; hosting_required not guessed', () => {
    const c = J.silent.deployment_compatibility;
    assert.equal(c.output_kind, 'unknown');
    assert.equal(c.hosting_required, null);
    assert.match(c.reason, /api/, `the reason names what is not known (${c.reason})`);
  });

  test('(c) silence: never hostable, in service mode or in static mode', () => {
    for (const [mode, read] of [['service', J.silentService], ['static', J.silentStatic]]) {
      const [e] = read.deployment_compatibility.environments;
      assert.deepEqual([e.mode, e.state], [mode, 'unknown'], `${mode} mode: ${JSON.stringify(e)}`);
      assert.match(e.reason, /unknown/);
    }
  });
});

// The plan's M616 (e) as the owner's ruling of 2026-10-29 amends it
// (SEAM.md §579): readiness tells the truth while the engine would refuse a
// deployment request now. A browser app whose Builder writes a static page
// (STATIC_PAGE_BUILT: the tree agrees, `static_site`), built to its phase's
// completion, then its environment configured in static mode: the engine
// proposes its serving check (D4 §13.2), the owner is asked, approves, the
// version is applied, and the candidate's checks run again.
describe('M616 (e) a static page\'s readiness while the engine would refuse a deployment: blocked, then ready', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const { p } = await pagePublished(fx, { name: 'pantry-static' });
    J.p = p;
    await pageBuilt(fx, p, { built: STATIC_PAGE_BUILT });
    J.built = await projectRead(fx, p.id);
    await configure(fx.engine, p.id, 'alpha', STATIC_CONFIG(18634));
    J.proposals = proposalsOf(fx.home, p.id).filter((x) => x.proposed_by === 'engine');
    J.proposed = await projectRead(fx, p.id);
    const proposal = J.proposals[0];
    J.decision = await openDecision(fx, p.id, 'check_correction_tightening', proposal.id, { max: 8 });
    J.asked = await projectRead(fx, p.id);
    J.askedListed = await listSummary(fx, p.id);
    await consume(fx, p.id, J.decision, 'approve');
    J.approved = await projectRead(fx, p.id);
    J.approvedStatus = proposalsOf(fx.home, p.id).find((x) => x.id === proposal.id).status;
    await tickUntil(fx.engine, p.id, () => proposalsOf(fx.home, p.id).find((x) => x.id === proposal.id && x.status === 'applied'), { max: 8, what: "the engine's serving check applied" });
    J.applied = await projectRead(fx, p.id);
    for (let i = 0; i < 8 && (await projectRead(fx, p.id)).build.deploy_readiness.state !== 'ready'; i++) {
      await recordChecks(fx, p.id);
      await tick(fx.engine, p.id);
    }
    J.ready = await projectRead(fx, p.id);
    J.readyListed = await listSummary(fx, p.id);
    // The phase-completion path (the owner's instruction of 2026-10-29): the
    // stored phase gate, made stale by the applied version, re-evaluated by
    // the tick after the checks ended; no client asked for it (this file
    // never calls …/gates/phase).
    J.candidate = J.ready.checks.candidate;
    J.phaseEvaluations = all(fx.home, `SELECT "id", "outcome", "stale", "computed_at" FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'phase' ORDER BY rowid`, J.candidate);
    J.appliedAt = all(fx.home, `SELECT "at" FROM "events" WHERE "type" = 'protected.applied' AND json_extract("subject", '$.project') = ? ORDER BY "seq"`, p.id).at(-1)?.at ?? null;
    J.phaseEvents = all(fx.home, `SELECT "actor_kind", "request_id", "payload" FROM "events" WHERE "type" = 'gate.evaluated' AND json_extract("subject", '$.candidate') = ? ORDER BY "seq"`, J.candidate).filter((e) => JSON.parse(e.payload).gate_kind === 'phase');
    J.deliverable = await fx.engine.get(`/v1/projects/${p.id}/candidates/${J.candidate}/deliverable`);
  });
  after(() => shared.cleanup());

  const BLOCKED = /^The environment alpha can host this output \(static site\) with local_service in static mode, but a deployment would be refused now: /;

  test('(e) every readiness served is one of the plan\'s states, blocked among them', () => {
    assert.deepEqual([...READINESS].sort(), ['blocked', 'not_complete', 'ready', 'unconfigured', 'unknown', 'unsupported']);
    for (const [what, read] of Object.entries(J).filter(([, v]) => v?.build?.deploy_readiness)) assert.ok(READINESS.includes(read.build.deploy_readiness.state), `${what}: ${read.build.deploy_readiness.state}`);
  });

  test('(e) built, a static site, its environment not configured: unconfigured', () => {
    assert.equal(J.built.build.complete, true);
    assert.equal(J.built.deployment_compatibility.output_kind, 'static_site', J.built.deployment_compatibility.reason);
    assert.equal(J.built.build.deploy_readiness.state, 'unconfigured');
    assert.equal(J.proposals.length, 1, 'configured in static mode, the engine proposed its serving check');
  });

  test('(e) the serving check proposed, its question not yet raised: blocked naming the proposal, no decision; the status keeps implementation apart and offers no deploy', () => {
    const r = J.proposed.build.deploy_readiness;
    assert.equal(r.state, 'blocked', JSON.stringify(r));
    assert.equal(r.environment, 'alpha');
    assert.equal(r.decision, null, 'no decision settles it yet');
    assert.match(r.reason, BLOCKED, r.reason);
    assert.ok(r.reason.includes(J.proposals[0].id), `the reason names the engine's proposal (${r.reason})`);
    assert.equal(J.proposed.now.state, 'build_complete', JSON.stringify(J.proposed.now));
    assert.ok(J.proposed.now.reason.startsWith(`${BUILD_DONE} It cannot be deployed to alpha yet: `), J.proposed.now.reason);
    assert.equal(J.proposed.now.primary_action, null, 'never deploy while blocked');
  });

  test('(e) its question open: blocked, the decision served and named, primary_action answer_decision', () => {
    const r = J.asked.build.deploy_readiness;
    assert.equal(r.state, 'blocked', JSON.stringify(r));
    assert.equal(r.decision, J.decision.id, 'the decision that settles it is served');
    assert.match(r.reason, BLOCKED, r.reason);
    assert.ok(r.reason.includes(J.proposals[0].id) && r.reason.includes(J.decision.id), `the reason names the proposal and the decision (${r.reason})`);
    assert.equal(J.asked.now.primary_action, 'answer_decision');
    assert.equal(J.asked.now.state, 'waiting_on_you', 'a decision waiting comes first in NOW');
  });

  test('(e) an open decision first in the primary status, the build\'s completion a separate fact on the project read and the list summary', () => {
    for (const [what, read] of [['the project read', J.asked], ['the list summary', J.askedListed]]) {
      assert.ok(read, `${what} serves the project`);
      assert.deepEqual([read.now.state, read.now.primary_action], ['waiting_on_you', 'answer_decision'], `${what}: the open approval ranks first (${JSON.stringify(read.now)})`);
      assert.ok(read.build && typeof read.build === 'object', `${what}: build is served (${JSON.stringify(read.build)})`);
      assert.equal(read.build.complete, true, `${what}: the build is complete`);
      assert.match(read.build.completed_at ?? '', /^\d{4}-\d{2}-\d{2}T/, `${what}: completed_at`);
      assert.equal(read.build.deploy_readiness.state, 'blocked', `${what}: its readiness beside it`);
      assert.equal(read.build.deploy_readiness.decision, J.decision.id);
    }
    assert.deepEqual(J.askedListed.build, J.asked.build, 'the same fact on both reads');
    assert.equal(J.built.build.completed_at, J.asked.build.completed_at, 'completed_at is the build\'s completion, unchanged by the configuration and the question');
  });

  test('(e) approved and not yet applied: still blocked, no decision, no deploy', () => {
    assert.notEqual(J.approvedStatus, 'applied', `read before the version is applied (${J.approvedStatus})`);
    const r = J.approved.build.deploy_readiness;
    assert.equal(r.state, 'blocked', JSON.stringify(r));
    assert.equal(r.decision, null);
    assert.match(r.reason, BLOCKED, r.reason);
    assert.ok(r.reason.includes(J.proposals[0].id), r.reason);
    assert.notEqual(J.approved.now.primary_action, 'deploy');
  });

  test('(e) applied, the candidate\'s checks running again: blocked naming the checks, no deploy', () => {
    const r = J.applied.build.deploy_readiness;
    assert.equal(r.state, 'blocked', JSON.stringify(r));
    assert.equal(r.decision, null);
    assert.match(r.reason, BLOCKED, r.reason);
    assert.match(r.reason, /the candidate's automated checks are running \(\d+ of \d+ completed\)/, r.reason);
    assert.ok(J.applied.checks.queued + J.applied.checks.running > 0, `checks under way (${JSON.stringify(J.applied.checks)})`);
    assert.notEqual(J.applied.now.primary_action, 'deploy');
  });

  test('(e) the phase-completion path: the stale phase gate re-evaluated by the tick after the checks ended; readiness and the deliverable ready with no client asking for the gate', () => {
    assert.ok(J.appliedAt, 'the serving check\'s version was applied');
    const ev = J.phaseEvaluations;
    assert.ok(ev.length >= 2, `the phase gate was evaluated at the phase's completion and again (${JSON.stringify(ev)})`);
    assert.ok(ev.slice(0, -1).some((e) => e.stale === 1), 'the applied version made the earlier evaluation stale');
    const last = ev.at(-1);
    assert.deepEqual([last.outcome, last.stale], ['satisfied', 0], `the newest phase evaluation is satisfied and current (${JSON.stringify(last)})`);
    assert.ok(Date.parse(last.computed_at) > Date.parse(J.appliedAt), `re-evaluated after the version was applied (${last.computed_at} > ${J.appliedAt})`);
    assert.ok(J.phaseEvents.length >= 1, `gate.evaluated events of the phase gate (${JSON.stringify(J.phaseEvents)})`);
    assert.deepEqual([J.phaseEvents.at(-1).actor_kind, J.phaseEvents.at(-1).request_id], ['engine', null], 'the re-evaluation is the engine\'s own, at a tick, not a request');
    assert.equal(J.ready.build.deploy_readiness.state, 'ready');
    assert.equal(J.deliverable.status, 200, `the deliverable is served (→ ${J.deliverable.status} ${J.deliverable.text})`);
    assert.equal(J.deliverable.body.deliverable.ready, true, JSON.stringify(J.deliverable.body));
    assert.deepEqual(J.readyListed.build, J.ready.build, 'the list summary serves the same build fact');
  });

  test('(e) the checks passed: ready, deploy', () => {
    const r = J.ready.build.deploy_readiness;
    assert.equal(r.state, 'ready', JSON.stringify(r));
    assert.equal(r.means, 'request_deployment', 'ready to request deployment, not verified');
    assert.deepEqual(r.follows, ['deployment', 'verification'], 'its serving check in place: the deployment and its verification follow');
    assert.equal(J.ready.now.state, 'build_complete');
    assert.ok(J.ready.now.reason.startsWith(READY_TO_REQUEST('static site, local_service static mode')), J.ready.now.reason);
    assert.match(J.ready.now.reason, FOLLOWS_END, J.ready.now.reason);
    assert.match(J.ready.now.reason, /verification/);
    assert.equal(J.ready.now.primary_action, 'deploy');
  });
});

// The owner's ruling of 2026-10-29 (objection 226): "If a serving check has
// not yet been proposed, readiness may mean ready to request deployment,
// not 'verified' or 'ready to open.' State that approval and verification
// follow." The static page configured in static mode; the owner rejects the
// engine's proposal, so no serving check is in place or pending.
describe('M616 (e) a static page whose serving check is not proposed: ready to request deployment; its proposal, approval, the deployment and its verification follow', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await pagePublished(fx, { name: 'pantry-static-none' });
    await pageBuilt(fx, p, { built: STATIC_PAGE_BUILT });
    await configure(fx.engine, p.id, 'alpha', STATIC_CONFIG(18635));
    const proposal = proposalsOf(fx.home, p.id).find((x) => x.proposed_by === 'engine');
    const d = await openDecision(fx, p.id, 'check_correction_tightening', proposal.id, { max: 8 });
    await reject(fx, p.id, d);
    J.status = await tickUntil(fx.engine, p.id, () => {
      const x = proposalsOf(fx.home, p.id).find((y) => y.id === proposal.id);
      return x && !['captured', 'classified', 'awaiting_human', 'approved'].includes(x.status) ? x.status : undefined;
    }, { max: 8, what: "the engine's proposal settled by the rejection" });
    J.read = await projectRead(fx, p.id);
  });
  after(() => shared.cleanup());

  test('(e) ready to request deployment, not verified and not open; the proposal, the approval, the deployment and its verification follow', () => {
    assert.notEqual(J.status, 'applied', `the proposal was not applied (${J.status})`);
    const r = J.read.build.deploy_readiness;
    assert.equal(r.state, 'ready', JSON.stringify(r));
    assert.equal(r.means, 'request_deployment');
    assert.deepEqual(r.follows, ['serving_check_proposal', 'approval', 'deployment', 'verification']);
    assert.ok(READINESS.includes(r.state));
    assert.equal(J.read.now.state, 'build_complete', JSON.stringify(J.read.now));
    assert.ok(J.read.now.reason.startsWith(READY_TO_REQUEST('static site, local_service static mode')), J.read.now.reason);
    assert.match(J.read.now.reason, FOLLOWS_END, J.read.now.reason);
    assert.match(J.read.now.reason, /approval/, 'it states that the approval follows');
    assert.match(J.read.now.reason, /verification/, 'and the verification');
    assert.doesNotMatch(J.read.now.reason, /can be deployed|is verified|is open/i, 'never verified or open');
    assert.equal(J.read.now.primary_action, 'deploy');
  });
});
