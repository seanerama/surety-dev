// M625 (e), a Python service serving a directory on a real unit (slice 50;
// sandbox lane). M7 plan §3d M625 (e); DECISIONS item 40, Sean 2026-11-24:
// "a Python service serves public/ from a sealed repository, and Surety
// verifies the bytes actually served against that directory. Include a
// changed-file case that must fail verification." D4 §13.2, §9.2; SEAM.md
// §§256 to 259 (M307's lane). Cases (a) to (d) are the kernel file
// M625-a-service-serving-a-directory.
//
// A repository holding the site under `public/` and `server.py` (Lap-Lab's
// shape; harness/deploy/python-service.mjs), deployed by the real
// `local_service` adapter in service mode under the adapter qualification
// stand-in (SEAM.md §248), as M307 and M613 (d) deploy: the configuration's
// `runtime` the host's /usr/bin/python3 pinned by path and its SHA-256
// (read at run time), `start` `python3 server.py`, `serving {root: public,
// entry: index.html}`. The unit runs server.py over /surety/app/public on
// 127.0.0.1 and the configured port. The round's checks run in real check
// domains: the behaviour check (held, released with GET / only) and the
// engine's serving check, which must pass listing each path relative to
// `public` with served and expected SHA-256.
//
// The changed-file case, honestly: the sealed artifact must stay unchanged
// while the service serves other bytes for one file under public/. The
// unit's root is read-only, so the change is made by the service itself:
// a second configuration version of the same environment adds the variable
// SURETY_TEST_SERVE_CHANGED=style.css; server.py then copies public/ file
// by file into its own volatile $TMPDIR, replaces that one file's bytes
// and serves the copy. The same candidate is deployed again (the same
// sealed artifact, by digest); the round's serving check must fail naming
// style.css `differs` with the served and the sealed digests, the
// verification `failed`. Then the operator's teardown: no unit of the
// environment's prefix left. Nothing else is touched (M4 build spec §4.1
// rules 1 and 2): the file ends with the operator's guard (row M313).
//
// SAFETY (BS4 §4.1; E64; SEAM.md §257). The only units are those the
// engine creates under this test's own home's prefix; the test stops none,
// signals nothing and reads the host only. If /usr/bin/python3 is missing
// the file fails with that reason (a skip is not a pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { defPath, definitionText } from './harness/checks/fixtures.mjs';
import { artifactsOf, candidateRow, configure, deploy, environmentRecord, roundsOf, unitPrefix, verificationsOf } from './harness/deploy/kernel.mjs';
import { exeShaOf, cmdlineOf, heldCheck, hostDeployable, hostEnvironment, newestOperation, operatorGuard, releaseCheck, serviceOf, teardownOnHost, ticksUntil, unitsOfHome, verificationOf } from './harness/deploy/host.mjs';
import { withStore } from './harness/store.mjs';
import { SERVING_DESCRIPTION, SITE, SITE_ASSETS, readJson, sha256 } from './harness/deploy/static.mjs';
import { CHANGED_PATH, CHANGED_TEXT, CHANGE_VARIABLE, PYTHON_SITE, SERVED_ROOT, SERVING, pythonRuntime, requirePython } from './harness/deploy/python-service.mjs';

// The serving check's result and printed output of a deployment operation's round.
function servingOf(ctx, op) {
  const result = withStore(ctx.fx.home, (db) =>
    db
      .prepare(
        `SELECT r.*, x."toolchain", x."id" AS "execution_id" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" JOIN "check_executions" x ON x."id" = r."execution"
         WHERE c."key" = 'serve' AND json_extract(x."deployment", '$.operation') = ? ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(op.id),
  );
  const record = result?.output ? withStore(ctx.fx.home, (db) => db.prepare('SELECT "path" FROM "records" WHERE "id" = ?').get(result.output)) : null;
  const text = record ? readFileSync(join(ctx.fx.home, 'records', record.path), 'utf8') : '';
  const rows = text
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((r) => r.length === 5 && r[0] !== 'path' && r[0] !== 'identity');
  return { result, text, rows };
}

describe('M625 (e) a Python service serving public/ on a real unit: verified against the sealed directory; a changed file fails; torn down', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  before(async () => {
    J.py = requirePython(pythonRuntime());
    guard = operatorGuard();
    const serve = definitionText('serve', { kind: 'post_deploy_serving', command: ['surety-static-serving'], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'], inputs: [] });
    const ctx = await hostDeployable(shared.context, guard, { files: { ...PYTHON_SITE, [defPath('serve')]: serve } });
    const env = await hostEnvironment(ctx, 'alpha', { runtime: { path: J.py.path, sha256: J.py.sha256 }, start: [J.py.path, 'server.py'], serving: SERVING });
    Object.assign(J, { ctx, env, fx: ctx.fx });
    // The first deployment: server.py over public/ of the sealed artifact.
    J.request = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    J.held = await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env, { key: 'behaves' }), { what: 'the behaviour check to hold', timeoutMs: 600_000 });
    J.op = newestOperation(ctx, env);
    J.svc = serviceOf(ctx, env, J.op);
    J.app = J.svc.app?.pid ? { exe: exeShaOf(J.svc.app.pid), argv: cmdlineOf(J.svc.app.pid) } : null;
    releaseCheck(ctx, J.svc, { get: ['/'], exit: 0 });
    J.verification = await verificationOf(ctx, J.op);
    J.serving = servingOf(ctx, J.op);
    J.completed = await ticksUntil(ctx.fx, ctx.project, () => (candidateRow(ctx.fx.home, ctx.candidate.id).progress === 'alpha_deployed' ? true : undefined), { what: 'alpha_deployed' });
    J.artifact = artifactsOf(ctx.fx.home, ctx.project).find((a) => a.digest === J.op.subject?.artifact_digest);
    // The changed-file case: a second configuration version whose service
    // serves a changed copy of public/; the same candidate deployed again.
    J.changedContent = { ...env.content, env: { ...env.content.env, [CHANGE_VARIABLE]: CHANGED_PATH } };
    J.changedConfig = await configure(ctx.fx.engine, ctx.project, 'alpha', J.changedContent);
    J.request2 = await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    J.held2 = await ticksUntil(ctx.fx, ctx.project, () => {
      const h = heldCheck(ctx, env, { key: 'behaves' });
      return h && h.execution.id !== J.held.execution.id ? h : undefined;
    }, { what: "the second round's behaviour check to hold", timeoutMs: 600_000 });
    J.op2 = newestOperation(ctx, env);
    J.svc2 = serviceOf(ctx, env, J.op2);
    releaseCheck(ctx, J.svc2, { get: ['/'], exit: 0 });
    J.verification2 = await verificationOf(ctx, J.op2);
    J.serving2 = servingOf(ctx, J.op2);
    J.artifactsAfter = artifactsOf(ctx.fx.home, ctx.project);
    J.record2 = environmentRecord(ctx.fx.home, env.id);
    // The operator's teardown.
    J.teardown = await teardownOnHost(ctx, env);
    J.after = unitsOfHome(ctx.fx.home).filter((u) => u.unit.startsWith(unitPrefix(ctx.fx.home, env.id)));
    J.afterRead = (await ctx.fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment;
  });
  after(async () => {
    try {
      guard?.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(e) the unit runs python3 server.py: the configured runtime by path and SHA-256, the start command as configured', () => {
    assert.equal(J.request.authorization.status, 'issued');
    assert.deepEqual(J.env.content.runtime, { path: '/usr/bin/python3', sha256: J.py.sha256 });
    assert.deepEqual(J.svc.app.argv, ['/usr/bin/python3', 'server.py'], `the application recorded (${JSON.stringify(J.svc.app)})`);
    assert.ok(J.app, 'the application process was read from the host');
    assert.equal(J.app.exe, J.py.sha256, "host-read: the running program's binary is the pinned Python");
    assert.equal(J.app.argv.at(-1), 'server.py', JSON.stringify(J.app.argv));
  });

  test('(e) the round verified: the engine\'s serving check ran in a real check domain and passed, each path listed relative to public with served and expected SHA-256', () => {
    assert.equal(J.verification.row.outcome, 'verified', JSON.stringify(J.verification.row));
    assert.equal(J.serving.result?.exit_status, 0, J.serving.text || JSON.stringify(J.serving.result));
    assert.match(JSON.parse(J.serving.result.toolchain).path, /checks\/programs\/static-serving\.mjs$/);
    assert.ok(J.serving.text.startsWith(`${SERVING_DESCRIPTION}\n`), J.serving.text);
    for (const p of ['index.html', ...SITE_ASSETS]) assert.ok(J.serving.text.includes(`${p}\t${sha256(SITE[p])}\t${sha256(SITE[p])}\t200\tmatch`), `${p} in ${J.serving.text}`);
    assert.equal(J.serving.rows.some((r) => r[0].startsWith(`${SERVED_ROOT}/`)), false, 'paths are relative to the root');
    assert.equal(J.completed, true, 'alpha_deployed');
  });

  test('(e) the changed file: the same sealed artifact, the service serving other bytes for style.css; the round\'s serving check failed naming it with both digests; the verification failed', () => {
    assert.equal(J.request2.authorization.status, 'issued');
    assert.equal(J.op2.subject?.artifact_digest, J.op.subject?.artifact_digest, 'the same sealed artifact, by digest');
    assert.equal(J.artifactsAfter.filter((a) => a.digest === J.op.subject.artifact_digest).length, 1, 'one artifact of that digest');
    assert.equal(J.artifact?.status, 'sealed');
    const onDisk = readJson(J.artifact.manifest).find((e) => e[0] === `${SERVED_ROOT}/${CHANGED_PATH}`);
    assert.equal(onDisk?.[4], sha256(SITE[CHANGED_PATH]), 'the sealed manifest still records the original bytes');
    assert.equal(J.serving2.result?.exit_status, 1, J.serving2.text || JSON.stringify(J.serving2.result));
    const row = J.serving2.rows.find((r) => r[0] === CHANGED_PATH);
    assert.ok(row, `${CHANGED_PATH} is named (${J.serving2.text})`);
    assert.deepEqual(row.slice(1), [sha256(CHANGED_TEXT), sha256(SITE[CHANGED_PATH]), '200', 'differs']);
    for (const p of ['index.html', 'js/app.js', 'js/lap.js', 'img/logo.svg']) assert.equal(J.serving2.rows.find((r) => r[0] === p)?.[4], 'match', `${p} still matches`);
    assert.equal(J.verification2.row.outcome, 'failed', JSON.stringify(J.verification2.row));
    assert.equal(J.record2.attempted?.outcome, 'verification_failed', JSON.stringify(J.record2.attempted));
    assert.equal(J.record2.last_verified?.operation, J.op.id, 'last_verified stays the first deployment\'s');
  });

  test('(e) teardown: no unit of the environment\'s prefix left, nothing runs', () => {
    assert.ok(J.teardown, 'the teardown was applied');
    assert.deepEqual(J.after, [], 'no unit of the environment\'s prefix is left');
    assert.equal(J.afterRead.running, null, 'after it, nothing runs');
    assert.ok(roundsOf(J.fx.home, J.op.id).flatMap((r) => verificationsOf(J.fx.home, r.id)).some((v) => v.outcome === 'verified'), 'the first verification kept');
  });
});
