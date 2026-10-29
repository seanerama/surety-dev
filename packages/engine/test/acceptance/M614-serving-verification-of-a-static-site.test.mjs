// M614, serving verification of a static site (slice 49; kernel lane). M7
// plan §3b M614; D4 §13.2 (amending §5.1, D3 §4.3 and J4; the owner's
// ruling of 2026-10-29, verbatim: "An engine-executed serving check may
// satisfy the deployment-specific post-deploy requirement for a static site.
// It must verify the deployed artifact's identity, entry page and required
// local assets. Record this as serving verified, not functional or visual
// acceptance. Existing application checks and human-review requirements
// remain unchanged. … no paid Verifier run solely to prove static files are
// served"), §5.1, §5.4; D3 §4.3; SEAM.md §§577, 578.
//
// (a) a `static_site` project's environment configured in static mode:
//     exactly one required `post_deploy_serving` check, authored by the
//     engine (proposed by the engine, no Verifier run, no `check_authoring`
//     work item), `gate_kinds` with `alpha_complete`, `requires` environment
//     and artifact_digest — the owner applying it as any tightening;
// (b) the serving check against a deployment whose entry and assets match:
//     passed; `alpha_complete` satisfied, `serving_verified: true` naming
//     the execution; no `ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior`;
//     the output lists each path with served and expected digests;
// (c) one asset's bytes differ; a referenced asset 404: failed, the path
//     named; the verification not `verified`;
// (d) a `node_service` candidate with only a serving check:
//     `ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior`, as before;
// (e) what the records say: "serving verified; not functional or visual
//     acceptance"; no `accepted`; no review or sign-off satisfied; D4 §5.4.
//
// The kernel lane has no check domain: the round's serving execution moves
// through the scripted check boundary (SEAM.md §190) as every kernel
// post-deploy check does. What the program itself prints and decides,
// (b)'s listing and (c), is read by running the engine's own program
// (dist/checks/programs/static-serving.mjs) as this test's child against
// the engine's static server over the deployment's sealed artifact (and a
// changed copy of it), with the variables the engine gives it: the
// recorded manifest and the execution's and the deployment's digests. The
// program run by the engine in a real check domain is M613 (d)'s.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { consume, openDecision } from './harness/decisions.mjs';
import { effectiveVersion, evaluationsOf, proposalsOf, sharedFixture, signoffsOf } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { defPath } from './harness/checks/scope.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  DEPLOY_DEFS,
  artifactsOf,
  candidateRow,
  completeRound,
  deployToRound,
  deployable,
  environmentRecord,
  requestDeployment,
  roundsOf,
  verificationsOf,
} from './harness/deploy/kernel.mjs';
import {
  NODE_FILES,
  SERVE,
  SERVING_DESCRIPTION,
  SERVING_STATEMENT,
  SITE,
  SITE_ASSETS,
  STATIC,
  WITH_SERVE,
  changedCopy,
  keysDeep,
  overwrite,
  readJson,
  remove,
  runServingProgram,
  serveDir,
  sha256,
} from './harness/deploy/static.mjs';

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const runsOfRole = (home, project, role) => all(home, 'SELECT * FROM "runs" WHERE "project" = ? AND "role" = ?', project, role);
const authoringWork = (home, project) => all(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring'`, project);
const incompleteSubjects = (reasons) => readJson(reasons).filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);

// The scope's deployment-specific requirement for a candidate, as the
// request's refusal names it.
async function refusedSubjects(fx, ctx) {
  const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
  assertRefused(res, 409, 'authorization_not_issued', 'the request');
  return res.body.subject.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);
}

describe('M614 (a) the engine authors the serving check of a static site configured in static mode', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    // The project's own checks list their inputs file by file, so a
    // definition added beside them changes none of them (the Builder's
    // record: the engine's proposal then classifies as a tightening).
    const defs = { acc: { ...DEPLOY_DEFS.acc, inputs: [defPath('acc')] }, smoke: { ...DEPLOY_DEFS.smoke, inputs: [defPath('smoke')] } };
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs });
    Object.assign(J, { fx, ctx });
    J.proposals = proposalsOf(fx.home, ctx.project);
    J.atConfig = { verifierRuns: runsOfRole(fx.home, ctx.project, 'verifier').length, authoring: authoringWork(fx.home, ctx.project).length };
    const proposal = J.proposals.find((p) => p.proposed_by === 'engine');
    J.proposal = proposal;
    if (proposal) {
      J.decision = await openDecision(fx, ctx.project, 'check_correction_tightening', proposal.id, { max: 8 });
      await consume(fx, ctx.project, J.decision, 'approve');
      J.applied = await tickUntil(fx.engine, ctx.project, () => proposalsOf(fx.home, ctx.project).find((p) => p.id === proposal.id && p.status === 'applied'), { max: 8, what: 'the engine\'s proposal applied' });
      J.version = effectiveVersion(fx.home, ctx.project);
      J.checks = all(fx.home, 'SELECT * FROM "checks" WHERE "project" = ? AND "protected_version" = ?', ctx.project, J.version.id);
    }
    J.atEnd = { verifierRuns: runsOfRole(fx.home, ctx.project, 'verifier').length, authoring: authoringWork(fx.home, ctx.project).length };
  });
  after(() => shared.cleanup());

  test('(a) one proposal, proposed by the engine: no run, no Verifier run, no check_authoring work item', () => {
    const engine = J.proposals.filter((p) => p.proposed_by === 'engine');
    assert.equal(engine.length, 1, `the engine proposed its serving check with the static configuration (proposals: ${JSON.stringify(J.proposals.map((p) => [p.proposed_by, p.status]))})`);
    assert.equal(engine[0].run, null, 'no run proposed it');
    assert.deepEqual(J.atConfig, { verifierRuns: 0, authoring: 0 });
    assert.deepEqual(J.atEnd, { verifierRuns: 0, authoring: 0 }, 'nor after it was applied');
    const event = eventsOfType(J.fx.home, 'protected.proposed').find((e) => e.subject?.proposal === engine[0].id);
    assert.deepEqual([event?.payload?.proposed_by, event?.payload?.engine_authored], ['engine', 'post_deploy_serving'], 'its event says the engine authored it');
  });

  test('(a) applied as any tightening by the owner: exactly one required post_deploy_serving check, alpha_complete, requiring the environment and the artifact digest', () => {
    assert.ok(J.applied, 'the proposal was applied');
    assert.equal(J.version.proposal, J.proposal.id, 'the effective protected version is the engine\'s proposal\'s');
    const serving = J.checks.filter((c) => c.kind === 'post_deploy_serving');
    assert.equal(serving.length, 1, `exactly one serving check in the effective version (${JSON.stringify(J.checks.map((c) => [c.key, c.kind]))})`);
    const [c] = serving;
    assert.equal(c.required, 1, 'required');
    assert.ok(readJson(c.gate_kinds).includes('alpha_complete'), `gate_kinds ${c.gate_kinds}`);
    assert.deepEqual(readJson(c.requires).sort(), ['artifact_digest', 'environment']);
    assert.deepEqual(readJson(c.definition).command, ['surety-static-serving'], "its command is the engine's own program");
  });
});

describe('M614 (b), (c), (e) the serving check against a deployment', () => {
  const shared = sharedFixture();
  const P = {};
  const F = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    // (b): a static site whose serving check passes.
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    const { operation, execution } = await deployToRound(ctx);
    Object.assign(P, { fx, ctx, operation, execution });
    P.artifact = artifactsOf(fx.home, ctx.project).find((a) => a.digest === execution.artifact_digest);
    await completeRound(ctx, execution);
    P.round = roundsOf(fx.home, operation.id).at(-1);
    P.verification = verificationsOf(fx.home, P.round.id).at(-1);
    P.complete = evaluationsOf(fx.home, ctx.candidate.id, 'alpha_complete').at(-1);
    P.record = environmentRecord(fx.home, ctx.env.id);
    P.candidateRead = await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}`);
    P.envRead = await fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`);
    P.result = one(fx.home, 'SELECT * FROM "check_results" WHERE "execution" = ?', execution.id);
    // (c): the same site, its serving check failed.
    const ctx2 = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    const failed = await deployToRound(ctx2);
    await recordExit(fx.engine, failed.execution.id, 1);
    F.round = await tickUntil(fx.engine, ctx2.project, () => {
      const r = roundsOf(fx.home, failed.operation.id).at(-1);
      return r && verificationsOf(fx.home, r.id).at(-1) ? r : undefined;
    }, { max: 12, what: 'the failed round\'s verification' });
    F.verification = verificationsOf(fx.home, F.round.id).at(-1);
    F.complete = evaluationsOf(fx.home, ctx2.candidate.id, 'alpha_complete').at(-1);
    F.candidate = candidateRow(fx.home, ctx2.candidate.id);
  });
  after(() => shared.cleanup());

  test('(b) the deployment\'s serving check passed: alpha_complete satisfied, serving_verified naming the execution, no ACCEPTANCE_SCOPE_INCOMPLETE', () => {
    assert.equal(P.execution.key, 'serve');
    assert.equal(P.complete.outcome, 'satisfied', P.complete.reasons);
    assert.deepEqual(incompleteSubjects(P.complete.reasons), [], 'no ACCEPTANCE_SCOPE_INCOMPLETE, kind:post_deploy_behavior or other');
    const serving = readJson(P.complete.serving);
    assert.equal(serving.serving_verified, true);
    assert.equal(serving.execution, P.execution.id, 'it names the execution');
    assert.equal(serving.key, 'serve');
    assert.equal(P.verification.outcome, 'verified');
    assert.equal(candidateRow(P.fx.home, P.ctx.candidate.id).progress, 'alpha_deployed');
  });

  test('(b) the engine\'s program over the deployed artifact: passes, and its output lists each path with served and expected digests', (t) => serveAndRun(t, P, null, (r) => {
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(r.lines[0], SERVING_DESCRIPTION, 'the output first says what the check is and is not');
    const byPath = Object.fromEntries(r.rows.map((row) => [row[0], row]));
    for (const p of ['index.html', ...SITE_ASSETS]) {
      assert.ok(byPath[p], `${p} is listed (${JSON.stringify(r.rows)})`);
      assert.deepEqual([byPath[p][1], byPath[p][2], byPath[p][4]], [sha256(SITE[p]), sha256(SITE[p]), 'match'], `${p}: served and expected digests`);
    }
    assert.equal(r.summary?.serving_verified, true);
    assert.equal(r.summary?.statement, SERVING_STATEMENT);
  }));

  test('(c) one asset\'s bytes differ: the program fails naming that path', (t) => serveAndRun(t, P, (dir) => overwrite(dir, 'style.css', 'body { color: red; }\n'), (r) => {
    assert.equal(r.code, 1, r.lines.join('\n'));
    const row = r.rows.find((x) => x[0] === 'style.css');
    assert.ok(row, `style.css is named (${JSON.stringify(r.rows)})`);
    assert.deepEqual([row[1], row[2], row[4]], [sha256('body { color: red; }\n'), sha256(SITE['style.css']), 'differs']);
    assert.equal(r.summary?.serving_verified, false);
  }));

  test('(c) a referenced asset answers 404: the program fails naming that path', (t) => serveAndRun(t, P, (dir) => remove(dir, 'js/lap.js'), (r) => {
    assert.equal(r.code, 1, r.lines.join('\n'));
    const row = r.rows.find((x) => x[0] === 'js/lap.js');
    assert.ok(row, `js/lap.js is named (${JSON.stringify(r.rows)})`);
    assert.deepEqual([row[3], row[4]], ['404', 'not_served']);
    assert.equal(r.summary?.serving_verified, false);
  }));

  test('(c) the round\'s serving check failed: the verification not verified, alpha_complete not satisfied, nothing recorded as serving verified', () => {
    assert.notEqual(F.verification.outcome, 'verified', `the verification is ${F.verification.outcome}`);
    assert.equal(F.verification.serving, null);
    assert.equal(F.complete?.outcome ?? 'not evaluated', F.complete ? 'not_satisfied' : 'not evaluated');
    if (F.complete) assert.equal(F.complete.serving, null);
    assert.notEqual(F.candidate.progress, 'alpha_deployed');
  });

  test('(e) every record says "serving verified; not functional or visual acceptance": the verification, last_verified, the alpha_complete evaluation, the candidate read', () => {
    assert.equal(P.candidateRead.status, 200, P.candidateRead.text);
    assert.equal(P.envRead.status, 200, P.envRead.text);
    const records = {
      verification: readJson(P.verification.serving),
      last_verified: P.record.last_verified?.serving,
      alpha_complete: readJson(P.complete.serving),
      candidate_read: P.candidateRead.body.candidate?.gates?.alpha_complete?.serving,
      environment_read: P.envRead.body.environment?.last_verified?.serving,
    };
    for (const [where, s] of Object.entries(records)) {
      assert.ok(s, `${where} records serving`);
      assert.deepEqual(
        { serving_verified: s.serving_verified, execution: s.execution, key: s.key, statement: s.statement },
        { serving_verified: true, execution: P.execution.id, key: 'serve', statement: SERVING_STATEMENT },
        `${where}: serving verified, the execution, and the statement verbatim`,
      );
      assert.ok(s.check, `${where}: names the check`);
      assert.ok('result' in s, `${where}: names the result`);
      assert.equal(keysDeep(s).has('accepted'), false, `${where}: never accepted`);
    }
  });

  test('(e) no acceptance, review or sign-off satisfied by it; D4 §5.4: it is the check\'s recorded pass, not the adapter\'s receipt or a claim', () => {
    for (const [where, value] of [['alpha_complete', readJson(P.complete.satisfiers)], ['verification', readJson(P.verification.behavioral_results)], ['candidate read', P.candidateRead.body.candidate]]) {
      assert.equal(keysDeep(value ?? {}).has('accepted'), false, `${where}: no \`accepted\``);
    }
    assert.deepEqual(signoffsOf(P.fx.home, P.ctx.candidate.id), [], 'no sign-off recorded or satisfied');
    // The nomination's own verification work stands as it did (held on its
    // own question); nothing of it, and no review, was completed or counted.
    assert.deepEqual(all(P.fx.home, `SELECT "kind", "status" FROM "work_items" WHERE "project" = ? AND "kind" IN ('review', 'verification') AND "status" = 'complete'`, P.ctx.project), [], 'no review or verification work completed');
    assert.equal(runsOfRole(P.fx.home, P.ctx.project, 'verifier').length, 0, 'no Verifier ran for it');
    assert.equal(runsOfRole(P.fx.home, P.ctx.project, 'reviewer').length, 0, 'no Reviewer ran for it');
    const serving = readJson(P.complete.serving);
    assert.equal(serving.result, P.result?.id, 'the serving record names the check result the engine recorded for the execution');
    assert.equal(P.result?.exit_status, 0, 'which is the check\'s pass, recorded through the check boundary');
    const kind = one(P.fx.home, 'SELECT "kind" FROM "checks" WHERE "id" = ?', serving.check)?.kind;
    assert.equal(kind, 'post_deploy_serving', 'the check named is the serving check');
  });
});

// The engine's static server over the deployment's sealed artifact (changed
// by `edit` in a copy, if given), the engine's program against it with the
// recorded manifest and the digests the engine binds; `check(result)`.
async function serveAndRun(t, P, edit, check) {
  assert.ok(P.artifact?.path, 'the deployment\'s sealed artifact is on disk');
  const dir = edit === null ? P.artifact.path : changedCopy(t, P.artifact.path, edit);
  const port = await serveDir(t, dir);
  const deployed = P.operation.subject?.artifact_digest;
  assert.equal(deployed, P.execution.artifact_digest, "the execution is bound to the deployment's artifact");
  assert.equal(P.artifact.digest, deployed, 'and the recorded manifest is that artifact\'s');
  check(runServingProgram({ port, manifest: P.artifact.manifest, executionDigest: P.execution.artifact_digest, deployedDigest: deployed }));
}

describe('M614 (d) a node_service candidate with only a serving check', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    J.servingOnly = await refusedSubjects(fx, await deployable(fx, { files: NODE_FILES, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } }));
    J.none = await refusedSubjects(fx, await deployable(fx, { files: NODE_FILES, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke } }));
  });
  after(() => shared.cleanup());

  test('(d) ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior, exactly as with no post-deploy check at all', () => {
    assert.ok(J.servingOnly.includes('kind:post_deploy_behavior'), JSON.stringify(J.servingOnly));
    assert.ok(J.none.includes('kind:post_deploy_behavior'), JSON.stringify(J.none));
    assert.deepEqual(J.servingOnly, J.none, 'the serving check changes nothing for a Node service');
    assert.equal(J.servingOnly.includes('kind:post_deploy_serving'), false);
  });
});
