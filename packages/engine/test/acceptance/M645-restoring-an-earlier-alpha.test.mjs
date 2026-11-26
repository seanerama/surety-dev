// M645, restoring an earlier Alpha (slice 50; kernel lane). The owner's M7
// plan §3j, row M645; Sean's ruling WO1 Q1 of 2026-11-26 ("Verify the exact
// candidate against the spec and checks that qualified that Alpha. Apply
// current environment authorization and safety policy as well. Show which
// version was restored. Restoring iteration 1 must neither claim iteration 2
// passed nor queue work to implement iteration 2."); D4 §4.1; DECISIONS item
// 54 (closed by this row); evidence.ts deliveryOf.
//
// The fixture (harness/brief57.mjs): a T1 rapid prototype, iteration 1 at
// its Alpha on candidate c1 (spec v1, protected version V1, scope S1
// recorded by the evaluation that authorized it); iteration 2's brief
// approved (spec v2 adds R1.2 and R3.2 to the delivered R1 and R3).
//   (a) before plan 2 publishes (iteration 2's replan run held at `rp`) and
//   (b) after it (phase 2's own authoring ended; iteration 2 at rest, nothing
//       under way), the owner restores iteration 1's Alpha (POST
//       …/iterations/:i1/restore) to the same environment: authorized
//       against S1 (its spec revision, its required checks, its protected
//       version) plus the current environment configuration and adapter
//       qualification; the environment read serves `restored {iteration: 1,
//       candidate, spec_revision v1, protected_version, qualified_by
//       evaluation, restored_at}`; no `check_authoring` gap item, no
//       ACCEPTANCE_SCOPE_INCOMPLETE refusal on v2's criteria; iteration 2's
//       status, candidate, deployment_request and receipt unchanged; no work
//       item but the restore's deployment;
//   (c) a finding applying to c1 opened since (phase 2's authoring reports a
//       high defect at project scope): refused naming the finding;
//   (d) the environment's configuration changed since, or its adapter
//       qualification lapsed since: refused naming the configuration or the
//       qualification (the current authorization applies);
//   (e) a restart right after the restore is requested: one deployment.
//   The base: (a) refused ACCEPTANCE_SCOPE_INCOMPLETE and a gap item queued
//   (the owner's only route there, POST …/deployments of c1); (b) authorized
//   with R1/R3 absent from the scope (WO1). On the base the restore route
//   does not exist; each case's failure records what POST …/deployments of
//   c1 answers instead.
//
// Readings this file makes (the report says them):
// - `iteration: 1` is read as iteration 1's sequence number or its id;
//   `spec_revision v1` as spec revision 1's id or the number 1;
//   `qualified_by` as the evaluation behind iteration 1's authorization
//   (iteration.deployment_request → deployment_authorizations.evaluation).
// - "authorized against S1": the restore's authorization is for c1 and its
//   evaluation's acceptance scope names spec revision 1 and S1's effective
//   protected version, never spec revision 2.
// - "receipt unchanged": iteration 2's owner_approvals, owner_answers and
//   delegated_actions (where served) and its brief, deepEqual before and
//   after the restore.
// - "one deployment": one more deploy work item for c1 and one more
//   adapter deploy call on alpha.
//
// SAFETY (BS6 §4.1; E64): kernel lane; the scripted role program and the
// scripted deployment adapter in the test's own home; nothing signalled but
// the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { one, phase2Plan, restart, rows, show, toIteration2 } from './harness/brief57.mjs';
import { adapterState, configContent, configure, effectCalls, environmentRead, lapseByFixture, requestDeployment } from './harness/deploy/kernel.mjs';
import { waitFor } from './harness/engine.mjs';
import { gapItems, phase2Plan as publishedPhase2, runsOn } from './harness/gap57.mjs';
import { CHECK_FILES, iterationRead, kindNext, pump, result, runsUnderWay, scriptDeploy, usage, write } from './harness/prototype.mjs';

const restoreOf = (fx, p, it, body = {}) => fx.engine.post(`/v1/projects/${p}/iterations/${it}/restore`, body);
const deployItemsFor = (home, p, candidate) =>
  rows(home, `SELECT w."id", w."status" FROM "work_items" w JOIN "deployment_authorizations" a ON a."id" = w."trigger_id" WHERE w."project" = ? AND w."kind" = 'deploy' AND a."candidate" = ? ORDER BY w."seq"`, p, candidate);
const workIds = (home, p) => rows(home, 'SELECT "id", "kind" FROM "work_items" WHERE "project" = ? ORDER BY "seq"', p);
const specRev = (home, p, v) => one(home, 'SELECT * FROM "spec_revisions" WHERE "project" = ? AND "version" = ?', p, v);

// Iteration 1's Alpha as qualified: its candidate, request, authorization,
// evaluation and acceptance scope.
function qualified(fx, one1) {
  const it = one(fx.home, 'SELECT * FROM "prototype_iterations" WHERE "id" = ?', one1);
  const req = one(fx.home, 'SELECT * FROM "deployment_requests" WHERE "id" = ?', it.deployment_request);
  const auth = one(fx.home, 'SELECT * FROM "deployment_authorizations" WHERE "id" = ?', req.authorization);
  const ev = one(fx.home, 'SELECT * FROM "gate_evaluations" WHERE "id" = ?', auth.evaluation);
  const scope = one(fx.home, 'SELECT * FROM "acceptance_scopes" WHERE "id" = ?', ev.scope);
  return { it, req, auth, ev, scope, candidate: it.candidate };
}

// What iteration 2 is: what the restore must leave as it was.
async function iteration2(fx, p, two) {
  const r = await iterationRead(fx, p, two);
  return { status: r.iteration.status, candidate: r.alpha.candidate, deployment_request: r.alpha.deployment_request, owner_approvals: r.owner_approvals, owner_answers: r.owner_answers ?? null, delegated_actions: r.delegated_actions ?? null, brief: r.brief };
}

// On the base the route is absent: what the owner's only route answers.
async function baseRoute(fx, p, c1) {
  const res = await requestDeployment(fx.engine, p, c1, 'alpha');
  return `POST …/deployments of c1 instead → ${res.status} ${res.text.slice(0, 600)}; gap items ${show(gapItems(fx.home, p).map((g) => [g.id, g.status, g.trigger_evidence?.deployment?.missing]))}`;
}

async function restoreTaken(fx, p, Q, res) {
  if (![200, 201, 202].includes(res.status)) {
    const instead = res.status === 404 ? await baseRoute(fx, p, Q.candidate) : '';
    assert.fail(`the restore of iteration 1's Alpha is taken (→ ${res.status} ${res.text.slice(0, 800)}) ${instead}`);
  }
  assert.doesNotMatch(res.text, /ACCEPTANCE_SCOPE_INCOMPLETE/, 'no ACCEPTANCE_SCOPE_INCOMPLETE on v2\'s criteria');
}

// The restore authorized against S1 and its deployment done; the facts of (a) and (b).
async function assertRestored(F, Q, before, res, { workBefore, deploysBefore, callsBefore }) {
  const { fx, p, two } = F;
  await restoreTaken(fx, p, Q, res);
  await pump(fx, p, () => (deployItemsFor(fx.home, p, Q.candidate).length > deploysBefore && deployItemsFor(fx.home, p, Q.candidate).at(-1).status === 'complete' ? true : undefined), { max: 20, wait: false, what: 'the restore\'s deployment' });
  const auths = rows(fx.home, 'SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? ORDER BY rowid', Q.candidate);
  const auth = auths.at(-1);
  assert.notEqual(auth.id, Q.auth.id, 'a new authorization for the restore');
  const scope = one(fx.home, 'SELECT s.* FROM "gate_evaluations" e JOIN "acceptance_scopes" s ON s."id" = e."scope" WHERE e."id" = ?', auth.evaluation);
  const v1 = specRev(fx.home, p, 1);
  const v2 = specRev(fx.home, p, 2);
  assert.deepEqual([scope?.spec_revision, scope?.effective_protected_version], [v1.id, Q.scope.effective_protected_version], `authorized against S1: spec revision 1 and its protected version (scope ${show(scope && { spec_revision: scope.spec_revision, pv: scope.effective_protected_version, required: scope.required_check_ids })}; v2 ${v2.id})`);
  assert.deepEqual(JSON.parse(scope.required_check_ids ?? '[]').sort(), JSON.parse(Q.scope.required_check_ids ?? '[]').sort(), "S1's required checks");
  const env = await environmentRead(fx.engine, p, 'alpha');
  const r = env.restored;
  assert.ok(r && typeof r === 'object', `the environment read serves restored (${show(env.restored)})`);
  for (const k of ['iteration', 'candidate', 'spec_revision', 'protected_version', 'qualified_by', 'restored_at']) assert.ok(k in r, `restored.${k} (${show(r)})`);
  assert.ok([1, F.one].includes(r.iteration), `restored.iteration names iteration 1 (${r.iteration})`);
  assert.equal(r.candidate, Q.candidate, 'restored.candidate is c1');
  assert.ok([1, v1.id].includes(r.spec_revision), `restored.spec_revision is v1 (${r.spec_revision})`);
  assert.equal(r.protected_version, Q.scope.effective_protected_version, 'restored.protected_version is S1\'s');
  assert.equal(r.qualified_by, Q.ev.id, 'restored.qualified_by is the evaluation that qualified that Alpha');
  assert.equal(typeof r.restored_at, 'string');
  assert.deepEqual(gapItems(fx.home, p).map((g) => [g.id, g.status]), [], 'no check_authoring gap item');
  assert.deepEqual(await iteration2(fx, p, two), before, "iteration 2's status, candidate, deployment_request and receipt unchanged");
  const added = workIds(fx.home, p).filter((w) => !workBefore.includes(w.id));
  assert.deepEqual(added.map((w) => w.kind), ['deploy'], `no work item but the restore's deployment (${show(added)})`);
  assert.equal(effectCalls(await adapterState(fx.engine, F.env.id)).length, callsBefore + 1, 'one adapter deploy call');
}

const marks = async (F, Q) => ({
  workBefore: workIds(F.fx.home, F.p).map((w) => w.id),
  deploysBefore: deployItemsFor(F.fx.home, F.p, Q.candidate).length,
  callsBefore: effectCalls(await adapterState(F.fx.engine, F.env.id)).length,
});

// Phase 2's own authoring: the reference checks, its proposal put to the owner.
const authoring2 = (findings = []) => ({ steps: [usage(900, 100, 300), ...Object.entries(CHECK_FILES).map(([path, c]) => write(path, c)), result({ proposal: { rationale: "phase 2's checks", requested_change_kind: 'unclassifiable' }, ...(findings.length ? { findings } : {}) })] });

// Iteration 2 at rest after its plan published: its authoring ran; nothing under way
// (its stages held for authoring readiness, or its question waiting for the owner).
async function afterPublication(F, { findings } = {}) {
  const { fx, p } = F;
  kindNext(fx, 'check_authoring', [authoring2(findings)], authoring2());
  const plan = await pump(fx, p, () => publishedPhase2(fx.home, p) ?? undefined, { max: 20, what: 'phase 2 published' });
  await pump(fx, p, () => (plan.check_authoring && runsOn(fx.home, plan.check_authoring).some((r) => r.state === 'ended') && runsUnderWay(fx.home, p).length === 0 ? true : undefined), { max: 20, what: "phase 2's authoring ended, nothing under way" });
  await pump(fx, p, () => undefined, { max: 2, what: 'two ticks at rest' }).catch(() => null);
  assert.equal(runsUnderWay(fx.home, p).length, 0, `the fixture is live: iteration 2 at rest (${(await iterationRead(fx, p, F.two)).iteration.status})`);
  return plan;
}

describe('M645 restoring an earlier Alpha', () => {
  test('(a) before plan 2 publishes: restored against S1 and the current environment; restored served; no gap item, no ACCEPTANCE_SCOPE_INCOMPLETE; iteration 2 untouched', { timeout: 600_000 }, async (t) => {
    const F = await toIteration2(t, { name: 'M645 a', port: 18645, plan: phase2Plan({ conformance: 'within_baseline', hold: 'rp' }) });
    const { fx, p, two } = F;
    await waitFor(() => (rows(fx.home, `SELECT r."id" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? AND w."kind" = 'replan' AND r."state" <> 'ended'`, two).length > 0 ? true : undefined), { what: "iteration 2's replan run live (held)", timeoutMs: 60_000 });
    assert.equal(publishedPhase2(fx.home, p), null, 'the fixture is live: plan 2 not published');
    const Q = qualified(fx, F.one);
    await scriptDeploy(fx, F.env);
    const m = await marks(F, Q);
    const before = await iteration2(fx, p, two);
    const res = await restoreOf(fx, p, F.one, { environment: 'alpha' });
    await assertRestored(F, Q, before, res, m);
    assert.equal(publishedPhase2(fx.home, p), null, 'plan 2 still not published (its run held)');
    fx.scripted.release('all', 'rp');
  });

  test('(b) after plan 2 publishes: restored against S1; restored served; no gap item; iteration 2 untouched', { timeout: 600_000 }, async (t) => {
    const F = await toIteration2(t, { name: 'M645 b', port: 18646, plan: phase2Plan({ conformance: 'within_baseline' }) });
    const { fx, p, two } = F;
    await afterPublication(F);
    const Q = qualified(fx, F.one);
    await scriptDeploy(fx, F.env);
    const m = await marks(F, Q);
    const before = await iteration2(fx, p, two);
    const res = await restoreOf(fx, p, F.one, { environment: 'alpha' });
    await assertRestored(F, Q, before, res, m);
  });

  test('(c) a finding applying to c1 opened since: the restore refused naming the finding', { timeout: 600_000 }, async (t) => {
    const F = await toIteration2(t, { name: 'M645 c', port: 18647, plan: phase2Plan({ conformance: 'within_baseline' }) });
    const { fx, p } = F;
    await afterPublication(F, { findings: [{ category: 'defect', severity: 'high', scope: 'project', message: 'every version lists finished tasks as open after a reload', criterion: 'R3.1' }] });
    const f = rows(fx.home, `SELECT * FROM "findings" WHERE "project" = ? AND "scope" = 'project' AND "status" = 'open' ORDER BY "seq"`, p);
    assert.equal(f.length, 1, `the fixture is live: one open project-scope finding (${show(rows(fx.home, 'SELECT "id", "scope", "status", "criterion" FROM "findings" WHERE "project" = ?', p))})`);
    const Q = qualified(fx, F.one);
    const before = await marks(F, Q);
    const res = await restoreOf(fx, p, F.one, { environment: 'alpha' });
    const instead = res.status === 404 ? await baseRoute(fx, p, Q.candidate) : '';
    assert.ok(res.status >= 400 && res.status < 500 && res.status !== 404, `refused (→ ${res.status} ${res.text.slice(0, 800)}) ${instead}`);
    assert.ok(res.text.includes(f[0].id), `the refusal names the finding ${f[0].id} (${res.text.slice(0, 800)})`);
    await pump(fx, p, () => undefined, { max: 2, wait: false, what: 'two ticks' }).catch(() => null);
    assert.equal(deployItemsFor(fx.home, p, Q.candidate).length, before.deploysBefore, 'nothing deployed');
  });

  for (const [label, change, names] of [
    ['its configuration changed', async (F) => configure(F.fx.engine, F.p, 'alpha', configContent({ start: [process.execPath, 'server.mjs'], port: 18699 })), /config/i],
    ['its adapter qualification lapsed', async (F) => lapseByFixture(F.fx.engine, one(F.fx.home, `SELECT "id" FROM "adapter_qualifications" ORDER BY rowid DESC LIMIT 1`)?.id), /qualif/i],
  ]) {
    test(`(d) the environment's ${label.replace('its ', '')} since: the restore refused naming it`, { timeout: 600_000 }, async (t) => {
      const F = await toIteration2(t, { name: `M645 d ${label.split(' ')[1]}`, port: label.includes('config') ? 18648 : 18649, plan: phase2Plan({ conformance: 'within_baseline' }) });
      const { fx, p } = F;
      await afterPublication(F);
      const Q = qualified(fx, F.one);
      await change(F);
      const before = await marks(F, Q);
      const res = await restoreOf(fx, p, F.one, { environment: 'alpha' });
      const instead = res.status === 404 ? await baseRoute(fx, p, Q.candidate) : '';
      assert.ok(res.status >= 400 && res.status < 500 && res.status !== 404, `refused (→ ${res.status} ${res.text.slice(0, 800)}) ${instead}`);
      assert.match(res.text, names, `the refusal names ${label.includes('config') ? 'the configuration' : 'the qualification'} (${res.text.slice(0, 800)})`);
      await pump(fx, p, () => undefined, { max: 2, wait: false, what: 'two ticks' }).catch(() => null);
      assert.equal(deployItemsFor(fx.home, p, Q.candidate).length, before.deploysBefore, 'nothing deployed');
    });
  }

  test('(e) a restart right after the restore is requested: one deployment', { timeout: 600_000 }, async (t) => {
    const F = await toIteration2(t, { name: 'M645 e', port: 18650, plan: phase2Plan({ conformance: 'within_baseline' }) });
    const { fx, p } = F;
    await afterPublication(F);
    const Q = qualified(fx, F.one);
    await scriptDeploy(fx, F.env);
    const m = await marks(F, Q);
    const res = await restoreOf(fx, p, F.one, { environment: 'alpha' });
    await restart(fx);
    await restoreTaken(fx, p, Q, res);
    await pump(fx, p, () => (deployItemsFor(fx.home, p, Q.candidate).slice(m.deploysBefore).some((w) => w.status === 'complete') ? true : undefined), { max: 20, wait: false, what: 'the restore\'s deployment after the restart' });
    await pump(fx, p, () => undefined, { max: 3, wait: false, what: 'three ticks' }).catch(() => null);
    assert.equal(deployItemsFor(fx.home, p, Q.candidate).length, m.deploysBefore + 1, `one deploy item for the restore (${show(deployItemsFor(fx.home, p, Q.candidate))})`);
    assert.equal(effectCalls(await adapterState(fx.engine, F.env.id)).length, m.callsBefore + 1, 'one adapter deploy call');
  });
});
