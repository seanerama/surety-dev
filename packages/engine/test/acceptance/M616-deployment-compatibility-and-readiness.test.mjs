// M616, deployment compatibility before the build; readiness apart from
// completion (slice 49; kernel lane). M7 plan §3b M616; D4 §13.4 (the
// owner's instruction of 2026-10-29: "Before a build begins, Surety should
// establish that the selected target can host the intended output—or
// clearly explain the missing capability. 'Build complete' must distinguish
// completed implementation from readiness to deploy"); D6 §6.2; SEAM.md
// §§572, 573.
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
//     when unconfigured, else null.
//
// Every project is the design journey's reference project in a variant
// (harness/deploy/static-journey.mjs), reaching its published plan through
// the owner's routes (D6 §1 steps 1 to 4); the browser app is built to its
// phase's completion on the kernel lane. Nothing is deployed.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { eventsOfType } from './harness/journal.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, configure } from './harness/deploy/kernel.mjs';
import { pageBuilt, pagePublished, servicePublished, silentPublished } from './harness/deploy/static-journey.mjs';

const BUILD_DONE = 'The planned build and its automated gates are complete.';
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
    assert.equal(J.inService.now.state, 'build_complete', JSON.stringify(J.inService.now));
    assert.equal(J.inService.now.reason, `${BUILD_DONE} It can be deployed to alpha (Node service, local_service service mode).`);
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
