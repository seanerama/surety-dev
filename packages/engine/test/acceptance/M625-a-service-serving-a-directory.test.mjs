// M625, serving verification of a service that serves a directory (slice
// 49; kernel lane, cases (a) to (d) and (f); case (e), the real unit, is the
// sandbox file M625-a-python-service-on-a-real-unit). M7 plan §3d M625;
// DECISIONS item 40, Sean 2026-11-24, verbatim: "The acceptance case is the
// one we just hit: a Python service serves public/ from a sealed
// repository, and Surety verifies the bytes actually served against that
// directory. Include a changed-file case that must fail verification."
// D4 §13.2 (extended to service mode), §3.2; D3 §4.3; SHAPES.md §§2, 3.
//
// What was hit (Lap-Lab Prototype iteration 3): in service mode the
// engine's serving check compared the served tree against artifact root
// `.` while the Python service served `public/`, so every path read
// `not_in_artifact` and the check could never pass.
//
// (a) `PUT …/config` in service mode accepts `serving: {root, entry}`,
//     validated as `static.root`/`static.entry` are (defaults `.` and
//     `index.html`); `static` stays static mode's only; `serving` is
//     refused in static mode; the environment read states the serving root
//     and entry of the current configuration and of the running
//     generation; the configuration identity changes with it; at
//     deployment the entry must be a file of the sealed artifact under the
//     root, else 422 `config_invalid` naming `serving.entry` before
//     anything is authorized.
// (b) the serving check against a deployment whose Python service serves
//     `public/` of the sealed artifact: passed, listing each path relative
//     to the root with served and expected SHA-256; `alpha_complete`
//     satisfied; nothing recorded as `serving_verified` (the output kind is
//     not `static_site`); the declared root frozen with the deployment.
// (c) a changed file: that path `differs` with both digests, exit 1; a
//     served path the artifact has no file for under the root:
//     `not_in_artifact`, exit 1; the round's verification not `verified`,
//     `alpha_complete` not satisfied, the blocker raised as today.
// (d) no `serving`: root `.` and entry `index.html`, today's behaviour.
// (f) (added 2026-11-24, DECISIONS item 41) a service configuration
//     declaring `serving` while the project has no serving check: the
//     engine proposes its own serving check through M614 (a)'s flow (the
//     answer's `serving_check` `proposed` naming it; provenance engine; no
//     Verifier run, no check_authoring work item), applied by the owner as a
//     tightening; a present or pending check reused (`present`/`pending`, no
//     new proposal, no second approval); the behavioural check still
//     required (`ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior`); a
//     service omitting `serving` proposes nothing.
// (a), sharpened the same day (Sean, on objection 231): the environment
//     read's `serving` and `running.serving` asserted by those two paths.
//
// The kernel lane has no check domain: the round's serving execution moves
// through the scripted check boundary (SEAM.md §190), as in M614. What the
// program prints and decides is read by running the engine's own program
// (dist/checks/programs/static-serving.mjs) as this test's child against
// the fixture's server.py, run by the host's /usr/bin/python3 with cwd the
// deployment's sealed artifact (or a changed copy of it), with the
// variables the engine gives it and the declared root. The variables the
// engine itself hands a real check domain are case (e)'s.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { consume, decisionsOfKind, decisionsOn, openDecision } from './harness/decisions.mjs';
import { effectiveVersion, evaluationsOf, proposalsOf, sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { defPath } from './harness/checks/scope.mjs';
import { recordExit } from './harness/checks/selection.mjs';
import { scriptedEngine, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  DEPLOY_DEFS,
  artifactsOf,
  candidateRow,
  configContent,
  configsOf,
  configure,
  deploy,
  deployWork,
  deployable,
  environmentRecord,
  operationRow,
  operationsOf,
  postDeployExecutions,
  putConfig,
  requestDeployment,
  roundsOf,
  scriptCall,
  tickSome,
  verificationsOf,
} from './harness/deploy/kernel.mjs';
import { SERVE, SERVING_DESCRIPTION, SERVING_STATEMENT, SITE, SITE_ASSETS, STATIC, changedCopy, overwrite, readJson, runServingProgram, sha256 } from './harness/deploy/static.mjs';
import { CHANGED_PATH, CHANGED_TEXT, PYTHON_SITE, SERVED_ROOT, SERVING, holdsSpec, pythonRuntime, pythonService, requirePython, servePython, servingSpecsIn } from './harness/deploy/python-service.mjs';

const PY = pythonRuntime();
// The checks: acceptance and smoke in the workspace; the round's required
// post-deploy checks, a behaviour check (a service's deployment-specific
// requirement, D4 §5.1, unchanged) and the serving check.
const DEFS = Object.freeze({ acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, behaves: DEPLOY_DEFS.behaves, serve: SERVE });

const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const environmentRead = async (fx, project, name) => {
  const res = await fx.engine.get(`/v1/projects/${project}/environments/${name}`);
  assert.equal(res.status, 200, `the environment read of ${name} (→ ${res.status} ${res.text})`);
  return res.body.environment;
};
const reasonCodes = (reasons) => (readJson(reasons) ?? []).map((r) => r.code);
const issuedAuthorizations = (home, candidate) => all(home, `SELECT * FROM "deployment_authorizations" WHERE "candidate" = ?`, candidate);

// A deployable project whose service is server.py over public/, configured with `config`.
const pythonDeployable = (fx, config = {}, { defs = DEFS } = {}) => deployable(fx, { files: PYTHON_SITE, config: pythonService(requirePython(PY), config), defs });

// An applying deploy scripted, the request made, ticks until the round's
// two post-deploy executions are registered. Returns {request, operation, executions: {key: execution}}.
async function deployToRoundOfTwo(ctx) {
  const { fx, project, candidate, env } = ctx;
  await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
  const request = await deploy(fx.engine, project, candidate.id, env.name);
  const xs = await tickUntil(fx.engine, project, () => {
    const found = postDeployExecutions(fx.home, candidate.id);
    return found.length >= 2 ? found : undefined;
  }, { max: 16, what: "the round to register its two post-deploy checks" });
  const [operation] = operationsOf(fx.home, project, 'deploy');
  return { request, operation, executions: Object.fromEntries(xs.map((x) => [x.key, x])) };
}

// ---- (a) the configuration --------------------------------------------------------------

describe('M625 (a) a service-mode configuration declaring the directory its service serves', () => {
  const shared = sharedFixture();
  let fx;
  let base;
  before(async () => {
    fx = await scriptedEngine(shared.context);
    // A project to write configurations against: configured first with no
    // `serving` (today's configuration), which every case leaves as it is.
    base = await pythonDeployable(fx, { serving: null });
  });
  after(() => shared.cleanup());

  test('(a) serving {root: "public", entry: "index.html"} in service mode: accepted, the content holding it, mode service, no static part', async () => {
    const res = await putConfig(fx.engine, base.project, 'beta', configContent(pythonService(requirePython(PY))));
    assert.equal(res.status, 201, `PUT …/environments/beta/config with serving (→ ${res.status} ${res.text})`);
    const [version] = configsOf(fx.home, res.body.environment.id);
    assert.deepEqual(version.content.serving, SERVING, 'the version\'s content holds the declared serving root and entry');
    assert.equal('mode' in version.content, false, 'no mode added: a service configuration as written');
    assert.equal('static' in version.content, false, 'no static part');
    const read = await environmentRead(fx, base.project, 'beta');
    assert.equal(read.mode, 'service');
    assert.equal('static' in read, false, 'the read has no static part in service mode');
    assert.deepEqual(read.serving, SERVING, 'environment.serving states the current configuration\'s serving root and entry');
    assert.equal(read.running, null, 'nothing runs in beta: no running generation, so no running serving');
  });

  test('(a) the defaults, as static mode\'s: entry index.html when only the root is given; root "." and entry index.html for an empty serving', async () => {
    const rootOnly = await putConfig(fx.engine, base.project, 'gamma', configContent(pythonService(requirePython(PY), { serving: { root: 'public' } })));
    assert.equal(rootOnly.status, 201, rootOnly.text);
    assert.deepEqual(configsOf(fx.home, rootOnly.body.environment.id)[0].content.serving, { root: 'public', entry: 'index.html' }, 'the entry defaulted and filled in the content');
    const empty = await putConfig(fx.engine, base.project, 'delta', configContent(pythonService(requirePython(PY), { serving: {} })));
    assert.equal(empty.status, 201, empty.text);
    assert.deepEqual(configsOf(fx.home, empty.body.environment.id)[0].content.serving, { root: '.', entry: 'index.html' }, 'both defaulted and filled in the content');
  });

  const refusals = [
    ['an absolute root', { root: '/srv/public', entry: 'index.html' }, 'serving.root'],
    ['a root climbing out', { root: '../public', entry: 'index.html' }, 'serving.root'],
    ['a root with a .. segment', { root: 'public/../secret', entry: 'index.html' }, 'serving.root'],
    ['an empty root', { root: '', entry: 'index.html' }, 'serving.root'],
    ['a root that is not a string', { root: 7, entry: 'index.html' }, 'serving.root'],
    ['a root longer than 256 characters', { root: 'p'.repeat(257), entry: 'index.html' }, 'serving.root'],
    ['an absolute entry', { root: 'public', entry: '/index.html' }, 'serving.entry'],
    ['an entry climbing out of the root', { root: 'public', entry: '../server.py' }, 'serving.entry'],
    ['an entry of "."', { root: 'public', entry: '.' }, 'serving.entry'],
    ['an empty entry', { root: 'public', entry: '' }, 'serving.entry'],
    ['a key that is not root or entry', { root: 'public', entry: 'index.html', listing: true }, 'serving'],
    ['serving not an object', 'public', 'serving'],
  ];
  for (const [what, serving, field] of refusals) {
    test(`(a) ${what}: refused 422 config_invalid naming ${field}, nothing written`, async () => {
      const name = `r${refusals.findIndex((r) => r[0] === what)}`;
      const res = await putConfig(fx.engine, base.project, name, configContent(pythonService(requirePython(PY), { serving })));
      assertRefused(res, 422, 'config_invalid', what);
      assert.equal(res.body.subject.field, field, `the refusal names ${field} (${res.text})`);
      assert.equal((await fx.engine.get(`/v1/projects/${base.project}/environments/${name}`)).status, 404, 'no environment was made');
    });
  }

  test('(a) static stays a field of static mode only: refused 422 in service mode naming static, unchanged', async () => {
    const res = await putConfig(fx.engine, base.project, 'eps', configContent(pythonService(requirePython(PY), { serving: null, static: { root: 'public', entry: 'index.html' } })));
    assertRefused(res, 422, 'config_invalid', 'static in service mode');
    assert.equal(res.body.subject.field, 'static');
  });

  test('(a) serving is refused in static mode: 422 config_invalid naming serving, nothing written', async () => {
    const res = await putConfig(fx.engine, base.project, 'zeta', configContent({ ...STATIC, serving: SERVING }));
    assertRefused(res, 422, 'config_invalid', 'serving in static mode');
    assert.equal(res.body.subject.field, 'serving');
    assert.equal((await fx.engine.get(`/v1/projects/${base.project}/environments/zeta`)).status, 404, 'no environment was made');
  });

  test('(a) the configuration identity changes with serving: none, public, another root; the same content written again is the same identity', async () => {
    const py = requirePython(PY);
    const none = await configure(fx.engine, base.project, 'eta', configContent(pythonService(py, { serving: null })));
    const withPublic = await configure(fx.engine, base.project, 'eta', configContent(pythonService(py)));
    const withSite = await configure(fx.engine, base.project, 'eta', configContent(pythonService(py, { serving: { root: 'site', entry: 'index.html' } })));
    const withEntry = await configure(fx.engine, base.project, 'eta', configContent(pythonService(py, { serving: { root: 'site', entry: 'home.html' } })));
    const ids = [none, withPublic, withSite, withEntry].map((c) => c.config.config_identity);
    assert.equal(new Set(ids).size, 4, `each serving gives its own identity (${JSON.stringify(ids)})`);
    const again = await putConfig(fx.engine, base.project, 'eta', configContent(pythonService(py, { serving: { root: 'site', entry: 'home.html' } })));
    assert.equal(again.status, 200, `the same content again is the current version (→ ${again.status} ${again.text})`);
    assert.equal(again.body.config.config_identity, ids[3]);
  });
});

// ---- (a) the entry at deployment --------------------------------------------------------

describe('M625 (a) at deployment the entry must be a file of the sealed artifact under the root', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  const cases = [
    ['an entry the root does not hold', { root: 'public', entry: 'missing.html' }],
    ['a root the artifact does not hold', { root: 'site', entry: 'index.html' }],
    ['an entry that is a directory', { root: 'public', entry: 'js' }],
    ['an entry of the artifact outside the root (server.py at "."), named under public', { root: 'public', entry: 'server.py' }],
  ];
  for (const [what, serving] of cases) {
    test(`(a) ${what}: the request refused 422 config_invalid naming serving.entry; nothing authorized, no deploy work, no operation`, async () => {
      const ctx = await pythonDeployable(fx, { serving });
      await scriptCall(fx.engine, ctx.env.id, 'deploy', [{ result: 'issued', apply: true }]);
      const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
      assertRefused(res, 422, 'config_invalid', what);
      assert.equal(res.body.subject.field, 'serving.entry', `the refusal names serving.entry (${res.text})`);
      assert.deepEqual(issuedAuthorizations(fx.home, ctx.candidate.id), [], 'no authorization recorded');
      assert.deepEqual(deployWork(fx.home, ctx.project), [], 'no deploy work item');
      assert.deepEqual(operationsOf(fx.home, ctx.project, 'deploy'), [], 'no deploy operation');
    });
  }
});

// ---- (b), (c) the serving check against the deployment --------------------------------

describe('M625 (b), (c) the serving check against a deployment whose Python service serves public/', () => {
  const shared = sharedFixture();
  const P = {};
  const F = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    P.fx = fx;
    // (b): the deployment whose round passes.
    const ctx = await pythonDeployable(fx);
    P.ctx = ctx;
    P.readConfigured = await environmentRead(fx, ctx.project, 'alpha');
    const { operation, executions } = await deployToRoundOfTwo(ctx);
    Object.assign(P, { operation, executions });
    P.artifact = artifactsOf(fx.home, ctx.project).find((a) => a.digest === executions.serve.artifact_digest);
    await recordExit(fx.engine, executions.behaves.id, 0);
    await recordExit(fx.engine, executions.serve.id, 0);
    P.deployed = await tickUntil(fx.engine, ctx.project, () => (candidateRow(fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { max: 12, what: 'the candidate to be alpha_deployed' });
    P.round = roundsOf(fx.home, operation.id).at(-1);
    P.verification = verificationsOf(fx.home, P.round.id).at(-1);
    P.complete = evaluationsOf(fx.home, ctx.candidate.id, 'alpha_complete').at(-1);
    P.record = environmentRecord(fx.home, ctx.env.id);
    P.frozen = operationRow(fx.home, operation.id).finalizer_inputs;
    P.readDeployed = await environmentRead(fx, ctx.project, 'alpha');
    // A configuration version written after the deployment, declaring another root.
    P.later = await configure(fx.engine, ctx.project, 'alpha', configContent(pythonService(requirePython(PY), { serving: { root: 'site', entry: 'index.html' } })));
    P.frozenAfter = operationRow(fx.home, operation.id).finalizer_inputs;
    P.readLater = await environmentRead(fx, ctx.project, 'alpha');
    // (c): the same project shape, its serving check failed.
    const ctx2 = await pythonDeployable(fx);
    F.ctx = ctx2;
    const failed = await deployToRoundOfTwo(ctx2);
    F.operation = failed.operation;
    await recordExit(fx.engine, failed.executions.behaves.id, 0);
    await recordExit(fx.engine, failed.executions.serve.id, 1);
    F.round = await tickUntil(fx.engine, ctx2.project, () => {
      const r = roundsOf(fx.home, failed.operation.id).at(-1);
      return r && verificationsOf(fx.home, r.id).at(-1) ? r : undefined;
    }, { max: 12, what: "the failed round's verification" });
    F.verification = verificationsOf(fx.home, F.round.id).at(-1);
    F.work = await tickUntil(fx.engine, ctx2.project, () => {
      const w = deployWork(fx.home, ctx2.project).at(-1);
      return w && w.status !== 'executing' && w.status !== 'ready' ? w : undefined;
    }, { max: 12, what: 'the deploy work item to settle after the failed verification' });
    F.complete = evaluationsOf(fx.home, ctx2.candidate.id, 'alpha_complete').at(-1);
    F.candidate = candidateRow(fx.home, ctx2.candidate.id);
    F.record = environmentRecord(fx.home, ctx2.env.id);
    F.blockers = decisionsOn(fx.home, 'blocker', F.work.id);
  });
  after(() => shared.cleanup());

  test('(b) the round with the serving check passed: verified, alpha_complete satisfied, the candidate alpha_deployed', () => {
    assert.equal(P.executions.serve.key, 'serve');
    assert.equal(P.verification.outcome, 'verified');
    assert.equal(P.complete.outcome, 'satisfied', P.complete.reasons);
    assert.equal(P.deployed, true);
  });

  test('(b) nothing recorded as serving verified for an output that is not a static site: the verification, the evaluation, last_verified', () => {
    assert.equal(P.verification.serving, null, 'the verification records no serving');
    assert.equal(P.complete.serving ?? null, null, 'the alpha_complete evaluation records no serving');
    assert.equal(P.record.last_verified?.serving, undefined, 'last_verified carries no serving');
    for (const [where, v] of [['verification', P.verification], ['alpha_complete', P.complete], ['last_verified', P.record.last_verified]]) {
      assert.equal(JSON.stringify(v).includes('serving_verified'), false, `${where}: no serving_verified anywhere`);
    }
  });

  test('(b) the declared root and entry frozen with the deployment; a configuration version written later leaves them', () => {
    assert.ok(holdsSpec(P.frozen, SERVING), `the deployment's frozen inputs hold serving ${JSON.stringify(SERVING)} (specs found: ${JSON.stringify(servingSpecsIn(P.frozen))})`);
    assert.equal(P.later.config.version > 1, true, 'a later version was written');
    assert.deepEqual(P.frozenAfter, P.frozen, 'the deployment\'s frozen inputs are unchanged by the later version');
    assert.equal(holdsSpec(P.frozenAfter, { root: 'site', entry: 'index.html' }), false, 'and do not take its root');
  });

  test('(a) the environment read states the serving root and entry of the current configuration and of the running generation', () => {
    // Focused (Sean, 2026-11-24, on objection 231): environment.serving and
    // environment.running.serving read by those two paths, so that a read
    // stating the two values the other way round fails.
    assert.deepEqual(P.readConfigured.serving, SERVING, 'configured, before any deployment: environment.serving');
    assert.equal(P.readConfigured.running, null, 'before any deployment: no running generation');
    assert.ok(P.readDeployed.running, 'the deployment runs');
    assert.deepEqual(P.readDeployed.serving, SERVING, 'deployed: environment.serving (the configuration deployed)');
    assert.deepEqual(P.readDeployed.running.serving, SERVING, 'deployed: environment.running.serving (what the deployment froze)');
    assert.equal(P.readLater.mode, 'service');
    assert.deepEqual(P.readLater.serving, { root: 'site', entry: 'index.html' }, 'after a later configuration version declaring root site: environment.serving is the current configuration\'s');
    assert.deepEqual(P.readLater.running.serving, SERVING, 'and environment.running.serving is still the running generation\'s, root public');
    assert.equal(P.readLater.running.generation, P.readDeployed.running.generation, 'the same running generation');
  });

  test('(b) the engine\'s program with the declared root against server.py over public/ of the sealed artifact: passed, each path listed relative to the root with served and expected digests', (t) => serveAndRun(t, P, null, { root: SERVED_ROOT }, (r) => {
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(r.lines[0], SERVING_DESCRIPTION);
    const byPath = Object.fromEntries(r.rows.map((row) => [row[0], row]));
    for (const p of ['index.html', ...SITE_ASSETS]) {
      assert.ok(byPath[p], `${p} is listed relative to the root (${JSON.stringify(r.rows)})`);
      assert.deepEqual([byPath[p][1], byPath[p][2], byPath[p][3], byPath[p][4]], [sha256(SITE[p]), sha256(SITE[p]), '200', 'match'], `${p}: served and expected digests`);
    }
    assert.equal(r.rows.some((row) => row[0].startsWith(`${SERVED_ROOT}/`)), false, 'no path is listed with the root prefixed');
    assert.equal(r.summary?.serving_verified, true);
    assert.equal(r.summary?.statement, SERVING_STATEMENT);
  }));

  test('(c) one file under public/ served with other bytes: failed (exit 1), that path listed differs with both digests', (t) => serveAndRun(t, P, (dir) => overwrite(dir, `${SERVED_ROOT}/${CHANGED_PATH}`, CHANGED_TEXT), { root: SERVED_ROOT }, (r) => {
    assert.equal(r.code, 1, r.lines.join('\n'));
    const row = r.rows.find((x) => x[0] === CHANGED_PATH);
    assert.ok(row, `${CHANGED_PATH} is named (${JSON.stringify(r.rows)})`);
    assert.deepEqual([row[1], row[2], row[3], row[4]], [sha256(CHANGED_TEXT), sha256(SITE[CHANGED_PATH]), '200', 'differs']);
    for (const p of ['index.html', 'js/app.js', 'js/lap.js', 'img/logo.svg']) assert.equal(r.rows.find((x) => x[0] === p)?.[4], 'match', `${p} still matches`);
    assert.equal(r.summary?.serving_verified, false);
  }));

  test('(c) a served path the artifact has no file for under the root: not_in_artifact, failed (exit 1)', (t) => serveAndRun(t, P, (dir) => {
    // The served copy's entry references one more stylesheet, served from
    // the copy and absent from the sealed artifact.
    overwrite(dir, `${SERVED_ROOT}/index.html`, SITE['index.html'].replace('</head>', '<link rel="stylesheet" href="extra.css"></head>'));
    writeFileSync(join(dir, SERVED_ROOT, 'extra.css'), 'p { margin: 0; }\n');
  }, { root: SERVED_ROOT }, (r) => {
    assert.equal(r.code, 1, r.lines.join('\n'));
    const row = r.rows.find((x) => x[0] === 'extra.css');
    assert.ok(row, `extra.css is named (${JSON.stringify(r.rows)})`);
    assert.deepEqual([row[1], row[2], row[3], row[4]], [sha256('p { margin: 0; }\n'), '-', '200', 'not_in_artifact']);
    assert.equal(r.summary?.serving_verified, false);
  }));

  test('(c) the round\'s serving check failed: the verification failed, alpha_complete not satisfied naming it, nothing recorded as verified', () => {
    assert.equal(F.verification.outcome, 'failed', `the verification is ${F.verification.outcome}`);
    assert.equal(F.verification.serving, null);
    assert.equal(F.record.last_verified ?? null, null, 'last_verified not written');
    assert.equal(F.record.attempted?.outcome, 'verification_failed', JSON.stringify(F.record.attempted));
    assert.ok(F.complete, 'alpha_complete was evaluated for the deployment');
    assert.equal(F.complete.outcome, 'not_satisfied');
    assert.ok(reasonCodes(F.complete.reasons).includes('DEPLOY_VERIFICATION_FAILED'), F.complete.reasons);
    assert.notEqual(F.candidate.progress, 'alpha_deployed');
  });

  test('(c) the blocker raised as today: the deploy work item awaiting a decision on its refused completion, an open blocker question', () => {
    assert.equal(F.work.status, 'awaiting_decision', JSON.stringify(F.work));
    const blocker = readJson(F.work.blocker);
    assert.match(blocker?.reason ?? '', /^deploy_completion_refused:.*DEPLOY_VERIFICATION_FAILED/, JSON.stringify(blocker));
    assert.equal(blocker.operation, F.operation.id);
    assert.ok(F.blockers.some((d) => d.status === 'open'), `an open blocker decision on the work item (${JSON.stringify(F.blockers.map((d) => [d.id, d.status]))})`);
  });
});

// server.py over the deployment's sealed artifact (changed by `edit` in a
// copy, if given), the engine's program against it with the recorded
// manifest, the digests the engine binds, and `opts` (the root); `check(result)`.
async function serveAndRun(t, P, edit, opts, check) {
  assert.ok(P.artifact?.path, "the deployment's sealed artifact is on disk");
  const dir = edit === null ? P.artifact.path : changedCopy(t, P.artifact.path, edit);
  const port = await servePython(t, dir);
  const deployed = P.operation.subject?.artifact_digest;
  const execution = P.executions.serve;
  assert.equal(deployed, execution.artifact_digest, "the execution is bound to the deployment's artifact");
  assert.equal(P.artifact.digest, deployed, "and the recorded manifest is that artifact's");
  check(runServingProgram({ port, manifest: P.artifact.manifest, executionDigest: execution.artifact_digest, deployedDigest: deployed, ...opts }));
}

// ---- (d) no serving declared ------------------------------------------------------------

describe('M625 (d) a service configuration declaring no directory: root "." and entry index.html, today\'s behaviour', () => {
  const shared = sharedFixture();
  const D = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    D.fx = fx;
    const ctx = await pythonDeployable(fx, { serving: null });
    D.ctx = ctx;
    D.version = configsOf(fx.home, ctx.env.id)[0];
    D.read = await environmentRead(fx, ctx.project, 'alpha');
    const { request, operation, executions } = await deployToRoundOfTwo(ctx);
    Object.assign(D, { request, operation, executions });
    D.artifact = artifactsOf(fx.home, ctx.project).find((a) => a.digest === executions.serve.artifact_digest);
    D.frozen = operationRow(fx.home, operation.id).finalizer_inputs;
  });
  after(() => shared.cleanup());

  test('(d) the content as written: no serving added, mode service, no static part', () => {
    assert.equal('serving' in D.version.content, false, `nothing added to the content (${JSON.stringify(D.version.content)})`);
    assert.equal('mode' in D.version.content, false);
    assert.equal(D.read.mode, 'service');
    assert.equal('static' in D.read, false);
  });

  test('(d) the deployment request issued as today though the artifact has no index.html at "." (no entry refusal without a declared serving)', () => {
    assert.equal(D.request.authorization.status, 'issued');
    const paths = readJson(D.artifact.manifest).map((e) => e[0]);
    assert.equal(paths.includes('index.html'), false, 'the sealed tree has no index.html at its root');
    assert.ok(paths.includes(`${SERVED_ROOT}/index.html`));
    assert.equal(holdsSpec(D.frozen, SERVING), false, `the deployment froze no public root (${JSON.stringify(servingSpecsIn(D.frozen))})`);
  });

  test('(d) the engine\'s program with the default root "." against server.py over public/: every path not_in_artifact, failed — the finding of Lap-Lab iteration 3, unchanged without a declared root', (t) => serveAndRun(t, D, null, {}, (r) => {
    assert.equal(r.code, 1, r.lines.join('\n'));
    const fetched = r.rows.filter((row) => row[0] !== 'identity' && row[4] !== 'not_local');
    assert.ok(fetched.length >= 1 + SITE_ASSETS.length, JSON.stringify(r.rows));
    for (const row of fetched) assert.deepEqual([row[2], row[3], row[4]], ['-', '200', 'not_in_artifact'], `${row[0]}: served, and not in the artifact at "."`);
  }));

  test('(d) the contrast: the same program over the same sealed artifact and the same server, given root public, passes — only the root it is handed differs', (t) => serveAndRun(t, D, null, { root: SERVED_ROOT }, (r) => {
    assert.equal(r.code, 0, r.lines.join('\n'));
    for (const p of ['index.html', ...SITE_ASSETS]) assert.equal(r.rows.find((row) => row[0] === p)?.[4], 'match', `${p} (${JSON.stringify(r.rows)})`);
  }));
});

// ---- (f) the serving-check proposal for a service that declares serving -----------------
//
// DECISIONS item 41; Sean 2026-11-24, verbatim: "When a service explicitly
// declares serving: {root, entry}, use the existing engine-authored proposal
// flow if the serving check is absent. Reuse a present or pending check so
// repeat configuration creates no duplicate approval. Keep the service's
// behavioral check required: matching file bytes establishes artifact
// identity, while the behavioral check establishes what the running service
// does. Services that omit serving retain today's behavior." The flow is
// M614 (a)'s (the static configuration's): provenance engine, no Verifier
// run, no check_authoring work item, the owner applying it as a tightening.

const runsOfRole = (home, project, role) => all(home, 'SELECT * FROM "runs" WHERE "project" = ? AND "role" = ?', project, role);
const authoringWork = (home, project) => all(home, `SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring'`, project);
const engineProposals = (home, project) => proposalsOf(home, project).filter((p) => p.proposed_by === 'engine');
const tighteningDecisions = (home, project) => decisionsOfKind(home, project, 'check_correction_tightening');
const proposalSummary = (home, project) => JSON.stringify(proposalsOf(home, project).map((p) => [p.id, p.proposed_by, p.status]));

// The project's own checks list their inputs file by file, so a definition
// added beside them changes none of them (as M614 (a): the engine's
// proposal then classifies as a tightening).
const listed = (...keys) => Object.fromEntries(keys.map((k) => [k, { ...DEPLOY_DEFS[k], inputs: [defPath(k)] }]));

// The deployment-specific requirement as the request's refusal names it (M614 (d)).
async function refusedSubjects(fx, ctx) {
  const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
  assertRefused(res, 409, 'authorization_not_issued', 'the request');
  return res.body.subject.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);
}

describe('M625 (f) a service declaring serving with no serving check: the engine proposes its serving check, the owner applies it, a present check is reused', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const py = requirePython(PY);
    // A service with no post-deploy check of its own (acceptance and smoke
    // only), configured first without serving: nothing to propose.
    const ctx = await pythonDeployable(fx, { serving: null }, { defs: listed('acc', 'smoke') });
    Object.assign(J, { fx, ctx });
    J.beforeServing = proposalsOf(fx.home, ctx.project);
    // The configuration declaring serving {root: public, entry: index.html}.
    J.res = await putConfig(fx.engine, ctx.project, 'alpha', configContent(pythonService(py)));
    J.proposals = proposalsOf(fx.home, ctx.project);
    J.atConfig = { verifierRuns: runsOfRole(fx.home, ctx.project, 'verifier').length, authoring: authoringWork(fx.home, ctx.project).length };
    const proposal = J.proposals.find((p) => p.proposed_by === 'engine');
    J.proposal = proposal;
    if (proposal) {
      J.decision = await openDecision(fx, ctx.project, 'check_correction_tightening', proposal.id, { max: 8 });
      await consume(fx, ctx.project, J.decision, 'approve');
      J.applied = await tickUntil(fx.engine, ctx.project, () => proposalsOf(fx.home, ctx.project).find((p) => p.id === proposal.id && p.status === 'applied'), { max: 8, what: "the engine's proposal applied" });
      J.version = effectiveVersion(fx.home, ctx.project);
      J.checks = all(fx.home, 'SELECT * FROM "checks" WHERE "project" = ? AND "protected_version" = ?', ctx.project, J.version.id);
    }
    J.atEnd = { verifierRuns: runsOfRole(fx.home, ctx.project, 'verifier').length, authoring: authoringWork(fx.home, ctx.project).length };
    // Reuse of the present check: the same configuration written again, and
    // other service configurations declaring serving (another environment
    // with the same serving; another with another root).
    J.same = await putConfig(fx.engine, ctx.project, 'alpha', configContent(pythonService(py)));
    J.another = await putConfig(fx.engine, ctx.project, 'beta', configContent(pythonService(py)));
    J.otherRoot = await putConfig(fx.engine, ctx.project, 'gamma', configContent(pythonService(py, { serving: { root: 'site', entry: 'index.html' } })));
    await tickSome(fx, ctx.project, 3);
    J.reuse = { proposals: proposalsOf(fx.home, ctx.project), decisions: tighteningDecisions(fx.home, ctx.project) };
    // The behavioural requirement with only the engine's serving check in place.
    J.subjects = J.applied ? await refusedSubjects(fx, ctx) : null;
  });
  after(() => shared.cleanup());

  test('(f) the configuration response states serving_check proposed, naming the engine\'s proposal', () => {
    assert.deepEqual(J.beforeServing.filter((p) => p.proposed_by === 'engine'), [], 'nothing proposed while the service declared no serving');
    assert.equal(J.res.status, 201, `PUT …/environments/alpha/config with serving (→ ${J.res.status} ${J.res.text})`);
    const sc = J.res.body.serving_check;
    assert.equal(sc?.state, 'proposed', `serving_check.state (serving_check: ${JSON.stringify(sc)}; proposals: ${proposalSummary(J.fx.home, J.ctx.project)})`);
    assert.ok(J.proposal, 'an engine proposal exists');
    assert.equal(sc.proposal, J.proposal.id, 'serving_check names the engine\'s proposal');
  });

  test('(f) one proposal, proposed by the engine: no run, no Verifier run, no check_authoring work item', () => {
    const engine = J.proposals.filter((p) => p.proposed_by === 'engine');
    assert.equal(engine.length, 1, `the engine proposed its serving check with the service configuration declaring serving (proposals: ${JSON.stringify(J.proposals.map((p) => [p.proposed_by, p.status]))})`);
    assert.equal(engine[0].run, null, 'no run proposed it');
    assert.deepEqual(J.atConfig, { verifierRuns: 0, authoring: 0 });
    assert.deepEqual(J.atEnd, { verifierRuns: 0, authoring: 0 }, 'nor after it was applied');
    const event = eventsOfType(J.fx.home, 'protected.proposed').find((e) => e.subject?.proposal === engine[0].id);
    assert.deepEqual([event?.payload?.proposed_by, event?.payload?.engine_authored], ['engine', 'post_deploy_serving'], 'its event says the engine authored it');
  });

  test('(f) applied as any tightening by the owner: exactly one required post_deploy_serving check, alpha_complete, requiring the environment and the artifact digest', () => {
    assert.ok(J.applied, `the proposal was applied (proposals: ${proposalSummary(J.fx.home, J.ctx.project)})`);
    assert.equal(J.version.proposal, J.proposal.id, 'the effective protected version is the engine\'s proposal\'s');
    const serving = J.checks.filter((c) => c.kind === 'post_deploy_serving');
    assert.equal(serving.length, 1, `exactly one serving check in the effective version (${JSON.stringify(J.checks.map((c) => [c.key, c.kind]))})`);
    const [c] = serving;
    assert.equal(c.required, 1, 'required');
    assert.ok(readJson(c.gate_kinds).includes('alpha_complete'), `gate_kinds ${c.gate_kinds}`);
    assert.deepEqual(readJson(c.requires).sort(), ['artifact_digest', 'environment']);
    assert.deepEqual(readJson(c.definition).command, ['surety-static-serving'], "its command is the engine's own program");
  });

  test('(f) a present serving check is reused: another service configuration declaring serving states present; no new proposal, no second approval', () => {
    assert.ok(J.applied, 'the engine\'s serving check was applied (the case above)');
    for (const [what, res] of [['beta, the same serving', J.another], ['gamma, another root', J.otherRoot]]) {
      assert.equal(res.status, 201, `${what} (→ ${res.status} ${res.text})`);
      assert.equal(res.body.serving_check?.state, 'present', `${what}: serving_check ${JSON.stringify(res.body.serving_check)}`);
      assert.equal(res.body.serving_check.proposal ?? null, null, `${what}: no proposal named`);
    }
    // The same content again is the current version (200, nothing written):
    // whatever its answer says of the serving check, it proposes nothing.
    assert.equal(J.same.status, 200, `the same configuration again (→ ${J.same.status} ${J.same.text})`);
    if (J.same.body.serving_check !== undefined) assert.equal(J.same.body.serving_check.state, 'present', JSON.stringify(J.same.body.serving_check));
    assert.deepEqual(J.reuse.proposals.filter((p) => p.proposed_by === 'engine').map((p) => p.id), [J.proposal.id], `one engine proposal still (${JSON.stringify(J.reuse.proposals.map((p) => [p.id, p.proposed_by, p.status]))})`);
    assert.deepEqual(J.reuse.decisions.map((d) => d.subject_id), [J.proposal.id], 'one approval decision, the one answered');
  });

  test('(f) the behavioural check stays required: with only the engine\'s serving check, the request names ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior', () => {
    assert.ok(J.applied, 'the engine\'s serving check was applied (the case above)');
    assert.ok(J.subjects.includes('kind:post_deploy_behavior'), JSON.stringify(J.subjects));
    assert.equal(J.subjects.includes('kind:post_deploy_serving'), false, JSON.stringify(J.subjects));
  });
});

describe('M625 (f) a pending serving-check proposal is reused: no second proposal, no duplicate approval', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const py = requirePython(PY);
    const ctx = await pythonDeployable(fx, { serving: null }, { defs: listed('acc', 'smoke') });
    Object.assign(J, { fx, ctx });
    J.first = await putConfig(fx.engine, ctx.project, 'alpha', configContent(pythonService(py)));
    J.proposal = engineProposals(fx.home, ctx.project)[0];
    // Its question raised and not answered: the proposal pending.
    if (J.proposal) J.decision = await openDecision(fx, ctx.project, 'check_correction_tightening', J.proposal.id, { max: 8 });
    J.same = await putConfig(fx.engine, ctx.project, 'alpha', configContent(pythonService(py)));
    J.another = await putConfig(fx.engine, ctx.project, 'beta', configContent(pythonService(py)));
    J.otherRoot = await putConfig(fx.engine, ctx.project, 'gamma', configContent(pythonService(py, { serving: { root: 'site', entry: 'index.html' } })));
    await tickSome(fx, ctx.project, 3);
    J.proposals = proposalsOf(fx.home, ctx.project);
    J.decisions = tighteningDecisions(fx.home, ctx.project);
  });
  after(() => shared.cleanup());

  test('(f) the first service configuration declaring serving: proposed', () => {
    assert.equal(J.first.status, 201, J.first.text);
    assert.equal(J.first.body.serving_check?.state, 'proposed', `serving_check ${JSON.stringify(J.first.body.serving_check)}; proposals: ${proposalSummary(J.fx.home, J.ctx.project)}`);
    assert.ok(J.proposal, 'an engine proposal exists');
    assert.equal(J.first.body.serving_check.proposal, J.proposal.id);
    assert.ok(J.decision, 'its approval question is open');
  });

  test('(f) written again while it is pending: another service configuration declaring serving states pending; one engine proposal, one approval decision', () => {
    assert.ok(J.proposal, `an engine proposal exists (proposals: ${proposalSummary(J.fx.home, J.ctx.project)})`);
    for (const [what, res] of [['beta, the same serving', J.another], ['gamma, another root', J.otherRoot]]) {
      assert.equal(res.status, 201, `${what} (→ ${res.status} ${res.text})`);
      assert.equal(res.body.serving_check?.state, 'pending', `${what}: serving_check ${JSON.stringify(res.body.serving_check)}`);
      assert.equal(res.body.serving_check.proposal ?? null, null, `${what}: no new proposal named`);
    }
    assert.equal(J.same.status, 200, `the same configuration again (→ ${J.same.status} ${J.same.text})`);
    if (J.same.body.serving_check !== undefined) assert.equal(J.same.body.serving_check.state, 'pending', JSON.stringify(J.same.body.serving_check));
    assert.deepEqual(J.proposals.filter((p) => p.proposed_by === 'engine').map((p) => p.id), [J.proposal.id], `one engine proposal (${JSON.stringify(J.proposals.map((p) => [p.id, p.proposed_by, p.status]))})`);
    assert.deepEqual(J.decisions.map((d) => [d.subject_id, d.status]), [[J.proposal.id, 'open']], 'one approval decision, still open: no duplicate');
  });
});

describe('M625 (f) the behavioural check stays required for a service whose only post-deploy check is the serving check', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    // The serving check in the project's own protected set, serving declared.
    J.servingOnly = await refusedSubjects(fx, await pythonDeployable(fx, {}, { defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } }));
    // No post-deploy check, no serving declared (nothing proposed).
    J.none = await refusedSubjects(fx, await pythonDeployable(fx, { serving: null }, { defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke } }));
  });
  after(() => shared.cleanup());

  test('(f) ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior, exactly as with no post-deploy check at all (M614 (d))', () => {
    assert.ok(J.servingOnly.includes('kind:post_deploy_behavior'), JSON.stringify(J.servingOnly));
    assert.ok(J.none.includes('kind:post_deploy_behavior'), JSON.stringify(J.none));
    assert.deepEqual(J.servingOnly, J.none, 'the serving check changes nothing for a service');
    assert.equal(J.servingOnly.includes('kind:post_deploy_serving'), false);
  });
});

describe('M625 (f) a service configuration omitting serving: no proposal, today\'s behaviour', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const py = requirePython(PY);
    // No serving check, a behaviour check; serving omitted from every configuration.
    const ctx = await pythonDeployable(fx, { serving: null }, { defs: listed('acc', 'smoke', 'behaves') });
    Object.assign(J, { fx, ctx });
    J.res = await putConfig(fx.engine, ctx.project, 'beta', configContent(pythonService(py, { serving: null })));
    await tickSome(fx, ctx.project, 3);
    J.proposals = proposalsOf(fx.home, ctx.project);
    J.decisions = tighteningDecisions(fx.home, ctx.project);
    J.work = { verifierRuns: runsOfRole(fx.home, ctx.project, 'verifier').length, authoring: authoringWork(fx.home, ctx.project).length };
  });
  after(() => shared.cleanup());

  test('(f) nothing proposed: no engine proposal, no approval decision, no Verifier run, no check_authoring work item', () => {
    assert.equal(J.res.status, 201, J.res.text);
    assert.deepEqual(J.proposals.filter((p) => p.proposed_by === 'engine'), [], `no engine proposal (${JSON.stringify(J.proposals.map((p) => [p.id, p.proposed_by, p.status]))})`);
    assert.deepEqual(J.decisions, [], 'no approval decision');
    assert.deepEqual(J.work, { verifierRuns: 0, authoring: 0 });
    // The answer proposes nothing: no serving_check (today's answer for a
    // service) or one stating not_proposed with its reason.
    const sc = J.res.body.serving_check;
    if (sc !== undefined) {
      assert.equal(sc.state, 'not_proposed', JSON.stringify(sc));
      assert.equal(sc.proposal ?? null, null, JSON.stringify(sc));
      assert.equal(typeof sc.reason, 'string', `with its reason (${JSON.stringify(sc)})`);
    }
  });
});
