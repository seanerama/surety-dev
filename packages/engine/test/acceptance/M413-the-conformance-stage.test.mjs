// M413, the conformance stage: its lifecycle, its source and its `fix` rule
// (slice 32; kernel lane). M5 plan §3.2 M413; D6-R05, D6-R06; D6 §8.1 step 5,
// §8.3; K11; reading 10; B11, B12; E142 item 3 (no repair before
// conformance: the adopted project is visibly blocked); SEAM.md §382. On the
// scripted check boundary (§190), the adopted fixture at T1.
//   (a) at publication: the `conformance: true` stage `source_bound` to A,
//       `integrated`, no `stage_build`; c-1 nominated `engine_cadence`, its
//       application source A (the tree outside `.surety/` equal to A's) while
//       the integration head carries the engine's commits;
//       `stage.conformance_integrated`, `conformance.source_bound`;
//   (b) `PLAN_CONFORMANCE_MISPLACED`: a conformance stage in a project that
//       is not adopted; a second conformance stage;
//   (c) checks, verification and the gate with no `stage_build` and no
//       fixture work; the stage does not complete from the absence of
//       stage-build work while its checks have no result;
//   (d) the projection: equal with the engine's commits on the branch (a);
//       an application-source file changed, a mode changed, and the stage's
//       source binding moved (a store write, labelled fixture tampering):
//       `CONFORMANCE_SOURCE_MOVED` each;
//   (e) the stage implements the confirmed set of phase 1, not the `defect`;
//       a plan listing the `defect` requirement in it is refused;
//   (f) a failing required check on a confirmed requirement: the finding's
//       `fix` records the remediation and changes nothing else (no fix work,
//       the check still failed, the gate unsatisfied); a roadmap revision
//       moving the requirement changes nothing; `accept` and `defer` do not
//       override it; a High finding in a sensitive area blocks Alpha (the
//       sensitive-area variant: `service` classified, the floor's check); a
//       protected correction of the check, with fresh evidence, is what
//       satisfies the gate (K11's reach into M234 and M235: a conformance
//       `fix` resolves nothing, neither weakened);
//   (g) the stage gate is due and the stage's work completes through the
//       conformance lifecycle, not through stage-build rows.
// Not written here (SEAM.md §382): the spec-change way out, and a
// conformance stage in phase 2 (slice 35's, through the replan path). On the
// kernel lane check verdicts are scripted; the adopted copy's real verdict is
// M408's on the project lane.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { commitEntries } from './harness/checks/fixtures.mjs';
import { consume, decisionsOfKind } from './harness/decisions.mjs';
import { evaluationsOf, findingsOf, raiseFindings, reasonSubjects, review, roleRun } from './harness/gates.mjs';
import { alphaReady, architectSession, checkRows, createWithIdea, roadmapRevisions, eventsAbout, evaluationsOfKind, resultsOf, specSession, visionSession, workOf } from './harness/journey/drive.mjs';
import { STAGES, phasePlan as tallyPlan } from './harness/journey/reference.mjs';
import { commitOnRef, gitQuiet } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { FULL_ANSWERS, adoptProject, advance, chooseMode, keysOf, confirmAndApprove, conformanceStages, gateReasons, retrofitArchitectSession, retrofitEngine, retrofitSpecSession, toConformancePublished } from './harness/retrofit/drive.mjs';
import { FLOOR_CHECK, MODULES_JSON_SENSITIVE, MODULES_SENSITIVE, SENSITIVE_AREA, conformanceStage, phasePlan, retrofitArchitectFiles, retrofitSpecText, roadmapJson, sensitiveConformanceStage, serviceCheck } from './harness/retrofit/products.mjs';
import { SERVER_MJS, refOid } from './harness/retrofit/repo.mjs';

// The application-source projection as test-side git reads it: every entry
// outside `.surety/`, with its mode and blob.
const projection = (repo, rev) =>
  gitQuiet(repo, ['ls-tree', '-r', rev])
    .split('\n')
    .filter((l) => l && !l.split('\t')[1].startsWith('.surety/'))
    .sort();
const resultsOfKey = (home, project, key) =>
  withStore(home, (db) => db.prepare('SELECT r.* FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND c."key" = ? ORDER BY r."execution_seq"').all(project, key));
const candidates = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').all(project));
const stageGates = (home, project) => evaluationsOfKind(home, project, 'stage');
const reasonsOfLast = (home, project) => gateReasons(stageGates(home, project).at(-1));
const nominated = (fx, ctx) => advance(fx, ctx, () => candidates(fx.home, ctx.project)[0], { what: 'c-1 to be nominated', exits: () => null });

async function published(t, opts) {
  const fx = await retrofitEngine(t);
  return { fx, ...(await toConformancePublished(fx, opts)) };
}

// Ticks after a change; then the checks pass; the last stage gate's reasons.
async function afterChange(fx, ctx) {
  await advance(fx, ctx, () => (stageGates(fx.home, ctx.project).length > 0 && reasonsOfLast(fx.home, ctx.project).length > 0 ? true : undefined), { what: 'a stage gate with its reasons', max: 20 }).catch(() => null);
  return reasonsOfLast(fx.home, ctx.project);
}

// An out-of-band commit on the integration branch, adopted by the owner.
async function adoptedOutOfBand(fx, p, commit) {
  const sha = commit();
  const row = await advance(fx, { project: p.id }, () => decisionsOfKind(fx.home, p.id, 'out_of_band_change').find((d) => d.status === 'open'), { what: 'the out-of-band decision', exits: () => null, max: 8 });
  await consume(fx, p.id, row, 'adopt');
  return sha;
}

describe('M413 the conformance stage', () => {
  test('(a) bound to A at publication, integrated, no stage_build; c-1 nominated by engine cadence, its application source A; (c) the stage does not complete without its checks\' results', async (t) => {
    const { fx, p, ctx } = await published(t);
    const [stage] = conformanceStages(fx.home, p.id);
    assert.ok(stage, 'one conformance stage');
    assert.equal(stage.source_revision, p.A, 'bound to A');
    assert.ok(['source_bound', 'nominated', 'verifying'].includes(stage.conformance_state), `its lifecycle begins source_bound (${stage.conformance_state})`);
    assert.equal(stage.status, 'integrated', 'marked integrated at publication');
    assert.equal(eventsAbout(fx.home, 'conformance.source_bound', p.id).length, 1, 'conformance.source_bound');
    assert.equal(eventsAbout(fx.home, 'stage.conformance_integrated', p.id).length, 1, 'stage.conformance_integrated');
    const c1 = await nominated(fx, ctx);
    assert.equal(c1.nominated_by, 'engine_cadence', 'nominated by engine cadence');
    assert.notEqual(c1.revision, p.A, 'the integration head carries the engine\'s commits');
    assert.deepEqual(projection(p.repo.path, c1.revision), projection(p.repo.path, p.A), 'c-1\'s application source is A');
    assert.match(stage.conformance_source_digest ?? '', /^[0-9a-f]{64}$|^sha256:/, 'the conformance digest recorded');
    // (c) no stage_build, no fixture work; held checks: the stage does not complete.
    for (let i = 0; i < 4; i++) await tick(fx.engine, p.id, { rounds: 1 });
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build'), [], 'no stage_build work');
    const now = conformanceStages(fx.home, p.id)[0];
    assert.notEqual(now.conformance_state, 'conformed', 'not conformed while its checks have no result');
    assert.ok(!stageGates(fx.home, p.id).some((e) => e.outcome === 'satisfied'), 'no satisfied stage gate');
  });

  test('(c) checks registered and run on c-1, the gate satisfied, conformed; (g) the stage\'s work completes through the conformance lifecycle', async (t) => {
    const { fx, p, ctx } = await published(t);
    const c1 = await nominated(fx, ctx);
    await advance(fx, ctx, () => (conformanceStages(fx.home, p.id)[0]?.conformance_state === 'conformed' ? true : undefined), { what: 'the stage to be conformed', max: 30 });
    const results = resultsOf(fx.home, p.id).filter((r) => r.candidate === c1.id);
    assert.ok(results.length >= 4, `its checks ran on c-1 (${results.length} results)`);
    assert.equal(stageGates(fx.home, p.id).filter((e) => e.candidate === c1.id).at(-1)?.outcome, 'satisfied', 'the stage gate satisfied on the approved set');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build'), [], 'never a stage_build row');
    const conformanceWork = workOf(fx.home, p.id, 'conformance');
    assert.ok(conformanceWork.every((w) => w.status === 'complete'), `any conformance work item complete (${JSON.stringify(conformanceWork.map((w) => w.status))})`);
  });

  test('(b) PLAN_CONFORMANCE_MISPLACED: a conformance stage in a project that is not adopted', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    await visionSession(fx, p.id);
    await specSession(fx, p.id);
    const revision = refOid(p.repo.path, p.repo.ref);
    const plan = tallyPlan(1, { revision, stages: STAGES[1].map((s) => (s.number === 1 ? { ...s, tasks: [], conformance: true } : s)) });
    const arch = await architectSession(fx, p.id, p.repo, { plan, answer: 'none' });
    assert.equal(arch.closeRes.status, 422, `refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
    assert.match(JSON.stringify(arch.closeRes.body?.subject ?? {}), /PLAN_CONFORMANCE_MISPLACED/, 'PLAN_CONFORMANCE_MISPLACED');
  });

  test('(b) PLAN_CONFORMANCE_MISPLACED: a second conformance stage; (e) a conformance stage listing the defect requirement refused', async (t) => {
    for (const [label, stages, expect] of [
      ['a second conformance stage', [conformanceStage(), conformanceStage({ number: 2, implements: ['R1'] })], /PLAN_CONFORMANCE_MISPLACED/],
      ['the defect in the conformance stage', [conformanceStage({ implements: ['R1', 'R2', 'R3', 'R4'] })], /PLAN_REQUIREMENT_UNPLANNED|PLAN_MODULE_OUTSIDE_PHASE|R4/],
    ]) {
      const fx2 = await retrofitEngine(t);
      const q = await adoptProject(fx2);
      await chooseMode(fx2, q.id, 'full');
      await retrofitSpecSession(fx2, q.id);
      await confirmAndApprove(fx2, q.id, FULL_ANSWERS);
      const revision = refOid(q.repo.path, q.repo.ref);
      const arch = await retrofitArchitectSession(fx2, q.id, q.repo, { plan: phasePlan(1, { revision, stages }), answer: 'none' });
      assert.equal(arch.closeRes.status, 422, `${label}: refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
      assert.match(JSON.stringify(arch.closeRes.body?.subject ?? {}), expect, `${label}: the reason names it`);
    }
  });

  test('(d) an application-source file changed, a mode changed: CONFORMANCE_SOURCE_MOVED each', async (t) => {
    for (const [label, change] of [
      ['an application-source file changed', (repo) => commitOnRef(repo.path, repo.ref, { 'server.mjs': `${SERVER_MJS}// edited\n` })],
      ['a mode changed', (repo) => commitEntries(repo.path, repo.ref, { 'server.mjs': { content: SERVER_MJS, mode: '100755' } }, 'developer: chmod +x server.mjs')],
    ]) {
      const { fx, p, ctx } = await published(t);
      await nominated(fx, ctx);
      await adoptedOutOfBand(fx, p, () => change(p.repo));
      const reasons = await afterChange(fx, ctx);
      assert.ok(reasons.includes('CONFORMANCE_SOURCE_MOVED'), `${label}: CONFORMANCE_SOURCE_MOVED (${JSON.stringify(reasons)})`);
      assert.notEqual(conformanceStages(fx.home, p.id)[0].conformance_state, 'conformed', `${label}: not conformed`);
    }
  });

  test('(d) the stage\'s source binding moved (a store write: fixture tampering): CONFORMANCE_SOURCE_MOVED at the next tick', async (t) => {
    const { fx, p, ctx } = await published(t);
    await nominated(fx, ctx);
    const [stage] = conformanceStages(fx.home, p.id);
    // FIXTURE TAMPERING (labelled): the binding points at the pushed commit, not A.
    withStore(fx.home, (db) => db.prepare('UPDATE "stages" SET "source_revision" = ? WHERE "id" = ?').run(p.repo.pushed, stage.id), { readonly: false });
    const reasons = await afterChange(fx, ctx);
    assert.ok(reasons.includes('CONFORMANCE_SOURCE_MOVED'), `the moved binding is found (${JSON.stringify(reasons)})`);
  });

  test('(e) the stage implements the confirmed set of phase 1, not the defect', async (t) => {
    const { fx, p } = await published(t);
    const [stage] = conformanceStages(fx.home, p.id);
    // `implements` holds requirement ids (§70; objection 075): read back as keys.
    assert.deepEqual(keysOf(fx.home, p.id, stage.implements).sort(), ['R1', 'R2', 'R3'], 'R1 to R3, never R4');
  });

  test('(f) a failing required check: fix records the remediation and changes nothing; accept and defer do not override it; a protected correction with fresh evidence satisfies the gate', async (t) => {
    const { fx, p, ctx } = await published(t);
    let failing = true;
    const exits = (x) => (x.key === 'accept-r2' && failing ? 1 : 0);
    const c1 = await nominated(fx, ctx);
    await advance(fx, ctx, () => (stageGates(fx.home, p.id).some((e) => e.candidate === c1.id) ? true : undefined), { what: 'the stage gate on c-1', exits, max: 20 });
    assert.notEqual(stageGates(fx.home, p.id).at(-1).outcome, 'satisfied', 'the fixture is live: accept-r2 failed and the gate is unsatisfied');
    const [found] = await raiseFindings(fx, p.id, c1.id, [{ category: 'defect', severity: 'medium', message: 'GET /sum does not answer the confirmed body', check: 'accept-r2', criterion: 'R2.1' }], { kind: 'verification' });
    const remediation = 'Phase 2: correct /sum\'s body.';
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix', remediation }] });
    await advance(fx, ctx, () => undefined, { exits, max: 4 }).catch(() => null);
    const after = findingsOf(fx.home, p.id).find((f) => f.id === found.id);
    assert.equal(after.resolved_at ?? null, null, 'fix: the finding unresolved');
    assert.match(after.remediation ?? '', /correct \/sum/, 'the proposed remediation recorded (§382 †)');
    assert.deepEqual(workOf(fx.home, p.id, 'fix'), [], 'no fix work in the conformance phase');
    const last = resultsOfKey(fx.home, p.id, 'accept-r2').filter((r) => r.candidate === c1.id && !r.invalidated_at).at(-1);
    assert.ok(last && last.exit_status !== 0, `the check still failed (${JSON.stringify(last)})`);
    assert.notEqual(stageGates(fx.home, p.id).at(-1).outcome, 'satisfied', 'the gate unsatisfied: conformance blocked');
    for (const disposition of ['accept', 'defer']) {
      await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition }] }).catch(() => null);
      await advance(fx, ctx, () => undefined, { exits, max: 3 }).catch(() => null);
      assert.notEqual(stageGates(fx.home, p.id).at(-1).outcome, 'satisfied', `${disposition}: never over a failed required check`);
    }
    // The way out: the check is wrong, the Verifier corrects it through the protected path.
    await roleRun(fx, p.id, 'check_correction', { subject: { finding: found.id }, steps: [{ write: { path: '.surety/checks/tests/sum-route.test.mjs', content: serviceCheck('R2.1 (corrected): GET /sum?a=2&b=3 answers 200 {"sum": 5}', [{ path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } }]) } }], result: { proposal: { rationale: 'The check was wrong; the owner confirmed the behaviour.', requested_change_kind: 'unclassifiable' } } });
    failing = false;
    await advance(fx, ctx, () => (stageGates(fx.home, p.id).at(-1)?.outcome === 'satisfied' ? true : undefined), { what: 'the gate satisfied after the correction', exits, max: 30 });
    const evidence = resultsOfKey(fx.home, p.id, 'accept-r2');
    assert.ok(evidence.some((r) => r.invalidated_at && r.exit_status !== 0), 'the failed evidence invalidated by the correction');
    assert.ok(evidence.some((r) => !r.invalidated_at && r.exit_status === 0), 'and fresh evidence passes');
  });

  test('(f) a High finding in a sensitive area blocks Alpha of the adopted code: alpha_authorize not satisfied, FINDING_BLOCKING naming it, no authorization issued', async (t) => {
    // The sensitive-area variant (SEAM.md §382): `service` classified, the stage validating the area, the floor's check.
    const fx = await retrofitEngine(t, { extraAuthoring: FLOOR_CHECK });
    const J = await toConformancePublished(fx, { spec: retrofitSpecText({ modules: MODULES_SENSITIVE }), architect: { modules: MODULES_JSON_SENSITIVE, stages: [sensitiveConformanceStage()] } });
    const { p, ctx } = J;
    const ready = await alphaReady(fx, ctx);
    const c1 = await nominated(fx, ctx);
    await advance(fx, ctx, () => (conformanceStages(fx.home, p.id)[0]?.conformance_state === 'conformed' ? true : undefined), { what: 'conformance, every check passing', max: 30 });
    assert.ok(checkRows(fx.home, p.id).some((c) => c.key === 'floor'), 'the fixture is live: the floor\'s check is in force');
    const [high] = await raiseFindings(fx, p.id, c1.id, [{ category: 'defect', severity: 'high', message: 'the service echoes its PORT secret in an error', sensitive_area: SENSITIVE_AREA }], { kind: 'verification' });
    const res = await fx.engine.post(`/v1/projects/${p.id}/deployments`, { candidate: c1.id, environment: ready.env.name });
    assert.notEqual(res.body?.authorization?.status, 'issued', `no Alpha of the adopted code (→ ${res.status} ${res.text})`);
    const row = evaluationsOf(fx.home, c1.id, 'alpha_authorize').at(-1);
    const evaluation = row && { ...row, reasons: typeof row.reasons === 'string' ? JSON.parse(row.reasons) : row.reasons };
    assert.ok(evaluation, 'alpha_authorize evaluated for c-1');
    assert.notEqual(evaluation.outcome, 'satisfied', 'not satisfied');
    assert.ok([...reasonSubjects(evaluation, 'FINDING_BLOCKING')].includes(high.id), `FINDING_BLOCKING names the High finding in the sensitive area (${JSON.stringify(evaluation.reasons)})`);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deployment_authorizations" WHERE "candidate" = ? AND "status" = \'issued\'').get(c1.id).n), 0, 'no authorization issued');
  });

  test('(f) a roadmap revision moving the failing requirement to phase 2 changes nothing: verdict, delivered set and gate; no Alpha', async (t) => {
    const { fx, p, ctx } = await published(t);
    const exits = (x) => (x.key === 'accept-r2' ? 1 : 0);
    await alphaReady(fx, ctx);
    const c1 = await nominated(fx, ctx);
    await advance(fx, ctx, () => (stageGates(fx.home, p.id).some((e) => e.candidate === c1.id) ? true : undefined), { what: 'the stage gate on c-1', exits, max: 20 });
    const before = conformanceStages(fx.home, p.id)[0];
    const revision = refOid(p.repo.path, p.repo.ref);
    const files = retrofitArchitectFiles({ revision, roadmap: { ...roadmapJson({ phase1: ['R1', 'R3'], phase2: ['R2', 'R4'] }), version: 2 } });
    delete files['.surety/phases/phase-1.json'];
    delete files['.surety/phases/phase-1.md'];
    // A later Architect session with phase 1's plan open is architecture-only: it raises `architecture_approval` alone
    // (D6 §3.4, §5.2; M404 (e); objection 075), which the owner approves.
    const arch = await retrofitArchitectSession(fx, p.id, p.repo, { files, answer: 'none' });
    assert.ok(arch.decisions.architecture_approval, `the close raised architecture_approval (${arch.closeRes.text})`);
    await consume(fx, p.id, arch.decisions.architecture_approval, 'approve');
    await advance(fx, ctx, () => undefined, { exits, max: 4 }).catch(() => null);
    const now = conformanceStages(fx.home, p.id)[0];
    assert.deepEqual(roadmapRevisions(fx.home, p.id).map((r) => r.version), [1, 2], 'the roadmap revision recorded');
    assert.deepEqual(JSON.parse(now.implements).sort(), JSON.parse(before.implements).sort(), 'the conformance stage\'s delivered set unchanged');
    assert.notEqual(stageGates(fx.home, p.id).at(-1).outcome, 'satisfied', 'the gate unchanged');
    const res = await fx.engine.post(`/v1/projects/${p.id}/deployments`, { candidate: c1.id, environment: 'alpha' });
    assert.notEqual(res.body?.authorization?.status, 'issued', `no Alpha (→ ${res.status} ${res.text})`);
  });
});
