// M638, automatic deployment is bound to the brief's environment; any other
// needs a decision before dispatch (slice 50; kernel lane). The owner's M7
// plan §3j, row M638; Sean's ruling D4 of 2026-11-26 ("Bind automatic
// deployment to the environment named in the approved brief. A second
// configured environment requires a decision before dispatch."); D4 §4.1,
// §5.2; deploy.ts policyRequestDue, requestDeployment.
//
// The fixture: a T1 rapid prototype whose specification's §7 names
// environment `local`. Before its preparation is approved the owner
// configures `local` (config identity I) and a second environment `demo`,
// both on the scripted local_service adapter, qualified by the fixture
// (SEAM.md §§247, 248); `demo` sorts first (policyRequestDue reads the
// environments ORDER BY "name", deploy.ts:882). The brief names `local` and
// is approved; the build is pumped (the owner answers only the check
// correction questions).
//   (a) the phase completes: the policy requests `local` only; for `demo` a
//       `deployment_target_approval` decision is raised previewing the
//       candidate, environment, adapter, adapter version, port, exposure
//       note, config identity and the consequence; no authorization,
//       intent, work item or adapter call for `demo` across ticks and a
//       restart;
//   (b) the owner's POST …/deployments {environment: demo} answers 409
//       `confirm_required` naming the decision and its preview hash;
//       nothing dispatched;
//   (c) approve: one authorization and one deploy item for `demo`; reject
//       (a fixture of its own): none, the request recorded `not_issued`
//       `owner_rejected`;
//   (d) `local`'s configuration changed after the brief (identity I′): the
//       policy's request asks the same decision for `local` (the binding is
//       to the identity, not the name); nothing deployed to `local`;
//   (e) the base deploys `demo` with no question: across the journey no
//       authorization, operation or adapter call for `demo` precedes an
//       answer to its decision.
//
// Readings this file makes (the report says them):
// - "previewing …" is read as: the decision read (GET …/decisions/:d) holds
//   keys candidate, environment, adapter, adapter_version, port,
//   exposure_note, config_identity and consequence (anywhere in it), with
//   demo's values where the fixture knows them.
// - "the request recorded `not_issued` `owner_rejected`": a
//   deployment_requests row for `demo` with outcome not_issued and reason
//   owner_rejected.
// - "intent": an `operations` row for the environment.
//
// SAFETY (BS6 §4.1; E64): kernel lane; the scripted role program and the
// scripted deployment adapter in the test's own home; nothing signalled but
// the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { restart, rows, show, valuesOfKey } from './harness/brief57.mjs';
import { adapterState, configContent, configure, effectCalls, qualifyByFixture, requestDeployment, scriptCall } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  CHECK_KINDS,
  answer,
  answerOpen,
  candidatesOfProject,
  decisionRead,
  deploymentRequestsOf,
  newApp,
  openDecisionsRead,
  prepScript,
  protoEngine,
  pump,
  specText,
  statusIs,
} from './harness/prototype.mjs';
import { tick } from './harness/runs.mjs';

const KIND = 'deployment_target_approval';
const PREVIEW_KEYS = ['candidate', 'environment', 'adapter', 'adapter_version', 'port', 'exposure_note', 'config_identity', 'consequence'];

const authsOf = (home, env) => rows(home, 'SELECT * FROM "deployment_authorizations" WHERE "environment" = ? ORDER BY rowid', env);
const opsOf = (home, env) => rows(home, `SELECT "id", "kind", "status" FROM "operations" WHERE "kind" IN ('deploy', 'rollback', 'teardown') AND json_extract("target", '$.environment') = ? ORDER BY rowid`, env);
const deployItemsOf = (home, p, env) =>
  rows(home, `SELECT w."id", w."status" FROM "work_items" w JOIN "deployment_authorizations" a ON a."id" = w."trigger_id" WHERE w."project" = ? AND w."kind" = 'deploy' AND a."environment" = ? ORDER BY w."seq"`, p, env);
const targetDecisions = (home, p) => rows(home, `SELECT * FROM "decisions" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"`, p, KIND);

// What reached an environment: authorizations, intents, deploy items and the adapter's deploy calls.
async function reached(fx, p, env) {
  return { authorizations: authsOf(fx.home, env.id).map((a) => [a.id, a.status]), operations: opsOf(fx.home, env.id), deploy_items: deployItemsOf(fx.home, p, env.id), adapter_deploys: effectCalls(await adapterState(fx.engine, env.id)).length };
}
const NOTHING = { authorizations: [], operations: [], deploy_items: [], adapter_deploys: 0 };

// The two environments configured and qualified, the brief (naming `local`)
// prepared and approved.
async function twoEnvironments(fx, { name, ports }) {
  fx.scripted.kindScript('brief_preparation', prepScript({ spec: specText({ environment: 'local' }) }));
  const { id: p } = await newApp(fx, { name });
  const local = await configure(fx.engine, p, 'local', configContent({ start: [process.execPath, 'server.mjs'], port: ports[0] }));
  const demo = await configure(fx.engine, p, 'demo', configContent({ start: [process.execPath, 'server.mjs'], port: ports[1] }));
  for (const e of [local, demo]) await scriptCall(fx.engine, e.environment.id, 'deploy', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
  await qualifyByFixture(fx.engine);
  const it = (await fx.engine.get(`/v1/projects/${p}/iterations`)).body.iterations.at(-1);
  await answerOpen(fx, p, 'prototype_preparation_approval');
  await pump(fx, p, statusIs(fx, p, it.id, 'awaiting_brief_approval'), { what: 'the brief' });
  const brief = (await fx.engine.get(`/v1/projects/${p}/iterations/${it.id}`)).body.brief;
  assert.equal(brief?.target?.environment, 'local', `the fixture is live: the brief names local (${show(brief?.target)})`);
  await answerOpen(fx, p, 'spec_approval');
  return { p, it: it.id, local: { ...local.environment, name: 'local', config: local.config }, demo: { ...demo.environment, name: 'demo', config: demo.config } };
}

// Pumped until the phase completed and the policy acted: the iteration at
// alpha_ready, or a deployment_target_approval open; then three more ticks.
async function phaseCompleted(fx, p, it) {
  await pump(
    fx,
    p,
    async () => {
      if ((await openDecisionsRead(fx, p)).some((d) => d.kind === KIND)) return true;
      const r = (await fx.engine.get(`/v1/projects/${p}/iterations/${it}`)).body;
      return r?.iteration?.status === 'alpha_ready' ? true : undefined;
    },
    { answer: CHECK_KINDS, max: 100, what: 'the phase completed and the policy acted' },
  );
  await pump(fx, p, () => undefined, { answer: CHECK_KINDS, max: 3, what: 'three more ticks' }).catch(() => null);
}

function assertPreview(d, env, what) {
  for (const k of PREVIEW_KEYS) assert.ok(valuesOfKey(d, new RegExp(`^${k}$`)).length > 0, `${what}: the decision previews ${k} (${show(d)})`);
  const envs = valuesOfKey(d, /^environment$/);
  assert.ok(envs.some((v) => v === env.name || v === env.id || (v && (v.name === env.name || v.id === env.id))), `${what}: the environment is ${env.name} (${show(envs)})`);
  assert.ok(valuesOfKey(d, /^config_identity$/).includes(env.config.config_identity), `${what}: the config identity is ${env.name}'s current one`);
  assert.ok(valuesOfKey(d, /^adapter$/).includes('local_service'), `${what}: the adapter`);
  assert.ok(valuesOfKey(d, /^adapter_version$/).some((v) => String(v) === '1'), `${what}: the adapter version`);
}

describe('M638 automatic deployment is bound to the brief\'s environment; any other needs a decision before dispatch', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context, { config: { lease_ttl: 600 } });
  });
  after(() => shared.cleanup());

  test('(a) the phase completes: the policy requests local only; demo gets a deployment_target_approval previewing its target; nothing for demo across ticks and a restart', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const F = await twoEnvironments(fx, { name: 'M638 a', ports: [18638, 18639] });
    S.a = F;
    const { p, local, demo } = F;
    await phaseCompleted(fx, p, F.it);
    const demoNow = await reached(fx, p, demo);
    S.demoBefore = demoNow;
    assert.deepEqual(demoNow, NOTHING, `nothing reached demo before any decision (the base deploys it: ${show(demoNow)})`);
    const policyRequests = deploymentRequestsOf(fx.home, p).filter((r) => r.requested_by === 'policy');
    assert.ok(policyRequests.some((r) => r.environment === local.id && r.outcome !== 'not_issued'), `the policy requested local (${show(policyRequests.map((r) => [r.environment, r.outcome, r.reason]))})`);
    assert.ok(policyRequests.filter((r) => r.environment === demo.id).every((r) => r.outcome === 'not_issued'), 'no request issued for demo');
    const ds = targetDecisions(fx.home, p);
    assert.equal(ds.length, 1, `one deployment_target_approval raised (${show(ds.map((d) => [d.subject_type, d.subject_id, d.status]))})`);
    assert.equal(ds[0].status, 'open');
    const d = await decisionRead(fx, p, ds[0].id);
    S.decision = d;
    assertPreview(d, demo, '(a)');
    const c = candidatesOfProject(fx.home, p).at(-1);
    assert.ok(valuesOfKey(d, /^candidate$/).some((v) => v === c.id || v?.id === c.id), `the candidate previewed is the phase's (${c.id})`);
    assert.ok(deployItemsOf(fx.home, p, local.id).length >= 1, 'local was deployed');
    await tick(fx.engine, p, { rounds: 3 });
    await restart(fx);
    await tick(fx.engine, p, { rounds: 3 });
    assert.deepEqual(await reached(fx, p, demo), NOTHING, 'still nothing for demo after ticks and a restart');
    assert.equal(targetDecisions(fx.home, p).length, 1, 'and still one decision');
  });

  test('(e) the base deployed demo with no question: nothing reached demo before an answer to its decision', { timeout: 600_000 }, async () => {
    assert.ok(S.a, 'the fixture of (a) ran');
    assert.deepEqual(S.demoBefore, NOTHING, `no authorization, intent, deploy item or adapter call for demo before any answer (${show(S.demoBefore)})`);
    assert.ok(S.decision, 'a deployment_target_approval asked first');
  });

  test('(b) the owner\'s POST …/deployments {environment: demo}: 409 confirm_required naming the decision and its preview hash; nothing dispatched', { timeout: 600_000 }, async () => {
    const { fx } = S;
    assert.ok(S.a && S.decision, 'the fixture of (a) ran and raised the decision');
    const { p, demo } = S.a;
    const c = candidatesOfProject(fx.home, p).at(-1);
    const res = await requestDeployment(fx.engine, p, c.id, 'demo');
    assert.equal(res.status, 409, `refused 409 (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.code, 'confirm_required', `confirm_required (${res.text})`);
    const open = targetDecisions(fx.home, p).filter((x) => x.status === 'open');
    assert.equal(open.length, 1, 'one decision open');
    assert.ok(res.text.includes(open[0].id), `the answer names the decision ${open[0].id} (${res.text})`);
    assert.ok(res.text.includes(open[0].preview_hash), `and its preview hash (${res.text})`);
    await tick(fx.engine, p, { rounds: 2 });
    assert.deepEqual(await reached(fx, p, demo), NOTHING, 'nothing dispatched');
  });

  test('(c) approve: one authorization and one deploy item for demo', { timeout: 600_000 }, async () => {
    const { fx } = S;
    assert.ok(S.a, 'the fixture of (a) ran');
    const { p, demo } = S.a;
    const [open] = targetDecisions(fx.home, p).filter((x) => x.status === 'open');
    assert.ok(open, 'the decision is open');
    const d = await decisionRead(fx, p, open.id);
    const res = await answer(fx, p, d, 'approve');
    assert.equal(res.status, 200, `approved (→ ${res.status} ${res.text})`);
    await pump(fx, p, () => (deployItemsOf(fx.home, p, demo.id).some((w) => w.status === 'complete') ? true : undefined), { max: 20, what: "demo's deployment" });
    await tick(fx.engine, p, { rounds: 2 });
    const r = await reached(fx, p, demo);
    assert.equal(r.authorizations.length, 1, `one authorization for demo (${show(r)})`);
    assert.equal(r.deploy_items.length, 1, `one deploy item for demo (${show(r)})`);
  });

  test('(c) reject: no authorization; the request recorded not_issued owner_rejected', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const F = await twoEnvironments(fx, { name: 'M638 r', ports: [18640, 18641] });
    const { p, demo } = F;
    await phaseCompleted(fx, p, F.it);
    const [open] = targetDecisions(fx.home, p).filter((x) => x.status === 'open');
    assert.ok(open, `a deployment_target_approval for demo is open (demo: ${show(await reached(fx, p, demo))})`);
    const res = await answer(fx, p, await decisionRead(fx, p, open.id), 'reject');
    assert.equal(res.status, 200, `rejected (→ ${res.status} ${res.text})`);
    await tick(fx.engine, p, { rounds: 3 });
    assert.deepEqual(await reached(fx, p, demo), NOTHING, 'none for demo');
    const reqs = deploymentRequestsOf(fx.home, p).filter((r) => r.environment === demo.id);
    assert.ok(reqs.some((r) => r.outcome === 'not_issued' && r.reason === 'owner_rejected'), `the request recorded not_issued owner_rejected (${show(reqs.map((r) => [r.requested_by, r.outcome, r.reason]))})`);
  });

  test('(d) local\'s configuration changed after the brief: the policy asks the same decision for local; nothing deployed to local', { timeout: 600_000 }, async () => {
    const { fx } = S;
    const F = await twoEnvironments(fx, { name: 'M638 d', ports: [18642, 18643] });
    const { p, local } = F;
    const changed = await configure(fx.engine, p, 'local', configContent({ start: [process.execPath, 'server.mjs'], port: 18644 }));
    assert.notEqual(changed.config.config_identity, local.config.config_identity, 'the fixture is live: a new identity I′');
    await pump(
      fx,
      p,
      async () => ((await openDecisionsRead(fx, p)).some((d) => d.kind === KIND) || deployItemsOf(fx.home, p, local.id).length > 0 ? true : undefined),
      { answer: CHECK_KINDS, max: 100, what: 'the phase completed and the policy acted' },
    );
    await tick(fx.engine, p, { rounds: 3 });
    const now = { ...local, config: changed.config };
    assert.deepEqual(await reached(fx, p, local), NOTHING, `nothing deployed to local under I′ (${show(await reached(fx, p, local))})`);
    const forLocal = [];
    for (const x of targetDecisions(fx.home, p).filter((y) => y.status === 'open')) {
      const d = await decisionRead(fx, p, x.id);
      if (valuesOfKey(d, /^environment$/).some((v) => v === 'local' || v === local.id || v?.name === 'local' || v?.id === local.id)) forLocal.push(d);
    }
    assert.equal(forLocal.length, 1, `a deployment_target_approval for local (${show(targetDecisions(fx.home, p).map((y) => [y.subject_id, y.status]))})`);
    assertPreview(forLocal[0], now, '(d)');
  });
});
