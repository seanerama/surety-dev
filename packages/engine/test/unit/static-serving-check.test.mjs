// Developer tests for the engine's serving check (SHAPES.md §3) and the
// owner's ruling of 2026-10-29 on it: the program, run here as this test's
// child against the engine's static server (also this test's child), passes
// only on the deployment's identity, the entry page and every referenced
// local asset byte-identical to the sealed manifest, and lists each path
// with its served and expected SHA-256; its definition is closed; and on the
// kernel lane (the scripted deployment adapter and check boundary standing
// in where M301's do) a static site's alpha_complete is met by the serving
// check passed, recorded as serving verified and never acceptance, failed
// by it failed, while a node service with only a serving check is still
// short of its post_deploy_behavior check; a static configuration makes the
// engine propose the check itself, and no Verifier is asked to author it.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRefused } from '../acceptance/harness/fixtures.mjs';
import { sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine, tickUntil } from '../acceptance/harness/runs.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { def, defPath } from '../acceptance/harness/checks/scope.mjs';
import { recordExit } from '../acceptance/harness/checks/selection.mjs';
import { DEPLOY_DEFS, SERVICE_FILES, candidateRow, configContent, completeRound, deployToRound, deployable, requestDeployment } from '../acceptance/harness/deploy/kernel.mjs';
import { SITE, writeTree } from './static-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const server = join(dist, 'design', 'preview', 'server.mjs');
const program = join(dist, 'checks', 'programs', 'static-serving.mjs');
const { SERVING_DESCRIPTION, SERVING_COMMAND, parseDefinition, defaultGoverned } = await import(join(dist, 'checks', 'schema.js'));
const { SERVING_PROGRAM_DESCRIPTION, servingProgramPath } = await import(join(dist, 'checks', 'programs', 'path.js'));
const { htmlReferences, moduleSpecifiers } = await import(program);
const { servingDefinition } = await import(join(dist, 'deploy', 'serving-install.js'));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifestOf = (files) =>
  Object.keys(files)
    .sort()
    .map((p) => [p, 'file', '100644', Buffer.byteLength(files[p]), sha(Buffer.from(files[p]))]);
const digestOf = (m) => `sha256:${sha(JSON.stringify(m))}`;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const up = async (port) => {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((r) => {
      const q = http.request({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        res.resume();
        r(true);
      });
      q.on('error', () => r(false));
      q.end();
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the server did not start');
};

// The engine's server over `served`, as this test's child; the program run
// against it with the manifest of `sealed`.
async function runCheck(t, { served, sealed = served, env = {} }) {
  const tmp = mkdtempSync(join(tmpdir(), 'serving-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeTree(join(tmp, 'app'), served);
  const port = await freePort();
  const child = spawn(process.execPath, [server, '--static', '--root=.', '--entry=index.html'], { cwd: join(tmp, 'app'), env: { PATH: '/usr/bin:/bin', PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  await up(port);
  const manifest = manifestOf(sealed);
  const digest = digestOf(manifest);
  const r = spawnSync(process.execPath, [program], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      SURETY_SERVING_URL: `http://127.0.0.1:${port}`,
      SURETY_STATIC_ROOT: '.',
      SURETY_STATIC_ENTRY: 'index.html',
      SURETY_ARTIFACT_DIGEST: digest,
      SURETY_DEPLOYED_ARTIFACT_DIGEST: digest,
      SURETY_ARTIFACT_MANIFEST: JSON.stringify(manifest),
      ...env,
    },
    timeout: 30_000,
  });
  const lines = r.stdout.trim().split('\n');
  return { code: r.status, lines, summary: JSON.parse(lines.at(-1)), rows: lines.filter((l) => l.split('\t').length === 5).slice(1).map((l) => l.split('\t')) };
}

test('the program says what it is: its description is the engine\'s, word for word, and its program is a file of the install', () => {
  assert.equal(SERVING_DESCRIPTION, 'serving check: the entry page and its referenced assets are served from the deployed artifact; not application behaviour, not visual acceptance');
  assert.equal(SERVING_PROGRAM_DESCRIPTION, SERVING_DESCRIPTION);
  assert.equal(servingProgramPath(), program);
});

test('references: script src, link href, img and source src and srcset, inline module imports; module specifiers static, re-exported and dynamic', () => {
  const { refs, inlineModules } = htmlReferences('<!-- <script src="gone.js"></script> --><script src="a.js"></script><link rel=stylesheet href=\'b.css\'><img src="c.png" srcset="c1.png 1x, c2.png 2x"><picture><source srcset="d.webp"></picture><a href="e.html">x</a><script type="module">import x from "./f.js"; import "./g.js";</script>');
  assert.deepEqual(refs, ['a.js', 'b.css', 'c.png', 'c1.png', 'c2.png', 'd.webp']);
  assert.deepEqual(inlineModules.flatMap(moduleSpecifiers), ['./f.js', './g.js']);
  assert.deepEqual(moduleSpecifiers("import { a } from './a.js';\nexport * from '../b.mjs';\nimport 'react';\nconst m = import('./c.js');\n// import './comment.js'\n"), ['./a.js', '../b.mjs', 'react', './c.js']);
});

test('passes on the entry and every referenced local asset byte-identical, one level of imports; its output lists each path with served and expected digests', async (t) => {
  const r = await runCheck(t, { served: SITE });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.lines[0], SERVING_DESCRIPTION, 'the first line says what it is and is not');
  assert.equal(r.summary.serving_verified, true);
  assert.equal(r.summary.statement, 'serving verified; not functional or visual acceptance');
  const byPath = Object.fromEntries(r.rows.map((row) => [row[0], row]));
  for (const p of ['index.html', 'style.css', 'js/app.js', 'img/logo.svg', 'js/lap.js']) {
    assert.ok(byPath[p], `${p} is listed (rows: ${JSON.stringify(r.rows)})`);
    assert.equal(byPath[p][1], sha(Buffer.from(SITE[p])), `${p}: served`);
    assert.equal(byPath[p][2], sha(Buffer.from(SITE[p])), `${p}: expected`);
    assert.equal(byPath[p][4], 'match');
  }
  assert.equal(byPath['js/lap.js'][4], 'match', 'the referenced module\'s import, one level deep');
});

test('fails when one asset\'s served bytes differ from the sealed artifact\'s', async (t) => {
  const r = await runCheck(t, { served: { ...SITE, 'style.css': 'body { color: red; }\n' }, sealed: SITE });
  assert.equal(r.code, 1);
  assert.equal(r.summary.serving_verified, false);
  assert.equal(r.rows.find((row) => row[0] === 'style.css')[4], 'differs');
});

test('fails when a referenced local asset is not served (404)', async (t) => {
  const { 'js/lap.js': _gone, ...served } = SITE;
  const r = await runCheck(t, { served, sealed: SITE });
  assert.equal(r.code, 1);
  const row = r.rows.find((x) => x[0] === 'js/lap.js');
  assert.deepEqual([row[3], row[4]], ['404', 'not_served']);
});

test('fails when the deployment\'s identity does not hold: the manifest is not the deployed digest\'s, or the execution is bound to another', async (t) => {
  const other = `sha256:${'0'.repeat(64)}`;
  const a = await runCheck(t, { served: SITE, env: { SURETY_DEPLOYED_ARTIFACT_DIGEST: other, SURETY_ARTIFACT_DIGEST: other } });
  assert.equal(a.code, 1);
  assert.equal(a.summary.identity.holds, false);
  const b = await runCheck(t, { served: SITE, env: { SURETY_ARTIFACT_DIGEST: other } });
  assert.equal(b.code, 1);
  const c = await runCheck(t, { served: SITE, env: { SURETY_ARTIFACT_MANIFEST: '' } });
  assert.equal(c.code, 2, 'a variable missing: not checked, never passed');
});

test('the definition is closed: the engine\'s command only, both requires, alpha_complete only, no secret, egress, covers or other origin', () => {
  const g = defaultGoverned();
  const parse = (fields) => parseDefinition('.surety/checks/defs/s.json', 's', JSON.stringify({ schema: 1, key: 's', ...fields }), g, []);
  const ok = { kind: 'post_deploy_serving', command: [SERVING_COMMAND], timeout_s: 60, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'], inputs: [] };
  assert.deepEqual(parse(ok).errors, []);
  const engineWritten = servingDefinition(600);
  assert.deepEqual(parseDefinition('.surety/checks/defs/surety-static-serving.json', 'surety-static-serving', JSON.stringify(engineWritten), g, []).errors, [], 'what the engine proposes is a valid definition');
  const codes = (fields) => parse({ ...ok, ...fields }).errors.map((e) => `${e.path.split('#')[1]}:${e.code}`);
  assert.deepEqual(codes({ command: ['probe'] }), ['/command:invalid_value']);
  assert.deepEqual(codes({ command: [SERVING_COMMAND, '--x'] }), ['/command:invalid_value']);
  assert.deepEqual(codes({ requires: ['environment'] }), ['/requires:invalid_value']);
  assert.deepEqual(codes({ gate_kinds: ['alpha_complete', 'alpha_authorize'] }), ['/gate_kinds:invalid_value']);
  assert.deepEqual(codes({ secrets: ['deploy/token'] }), ['/secrets:invalid_value']);
  assert.ok(codes({ egress: ['example.org'] }).includes('/egress:invalid_value'));
  assert.deepEqual(codes({ origin: 'developer' }), ['/origin:invalid_value']);
  assert.deepEqual(codes({ covers: { criteria: ['R1.1'] } }).includes('/covers:covers_not_allowed'), true);
  // Any other kind with the engine's command name is refused as before (not in check_commands).
  assert.deepEqual(parse({ ...ok, kind: 'post_deploy_behavior' }).errors.map((e) => e.code), ['program_not_allowed']);
});

// ---- the owner's ruling on the kernel lane -------------------------------------------------

const SERVE = def('post_deploy_serving', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'], command: ['surety-static-serving'], inputs: [] });
const STATIC = { mode: 'static', start: undefined };
const evaluations = (home, candidate, kind) => withStore(home, (db) => db.prepare('SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = ? ORDER BY rowid').all(candidate, kind));
const engineProposals = (home, project) => withStore(home, (db) => db.prepare(`SELECT * FROM "protected_proposals" WHERE "project" = ? AND "proposed_by" = 'engine'`).all(project));
const authoringWork = (home, project) => withStore(home, (db) => db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring'`).all(project));

describe('a static site\'s deployment-specific requirement met by the engine\'s serving check (the owner\'s ruling of 2026-10-29), on the kernel lane', () => {
  const shared = sharedFixture();
  let fx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('a static_site candidate whose serving check passed: alpha_authorize issued with no ACCEPTANCE_SCOPE_INCOMPLETE, alpha_complete satisfied with serving_verified, no Verifier asked', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } });
    assert.deepEqual(engineProposals(fx.home, ctx.project), [], 'the project has its serving check: the engine proposes none');
    const { execution } = await deployToRound(ctx);
    assert.equal(execution.key, 'serve');
    const [authorize] = evaluations(fx.home, ctx.candidate.id, 'alpha_authorize');
    assert.equal(authorize.outcome, 'satisfied', authorize.reasons);
    await completeRound(ctx, execution);
    const complete = evaluations(fx.home, ctx.candidate.id, 'alpha_complete').at(-1);
    assert.equal(complete.outcome, 'satisfied', complete.reasons);
    assert.ok(!JSON.parse(complete.reasons).some((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE'));
    const serving = JSON.parse(complete.serving);
    assert.equal(serving.serving_verified, true);
    assert.equal(serving.execution, execution.id);
    assert.equal(serving.key, 'serve');
    assert.equal(serving.statement, 'serving verified; not functional or visual acceptance');
    assert.ok(!('accepted' in serving), 'never an acceptance');
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'alpha_deployed');
    const read = (await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}`)).body.candidate;
    assert.equal(read.gates.alpha_complete.serving.serving_verified, true, 'the candidate read records it');
    const env = (await fx.engine.get(`/v1/projects/${ctx.project}/environments/alpha`)).body.environment;
    assert.equal(env.last_verified.serving.execution, execution.id, 'the deployment read records it');
    assert.deepEqual(authoringWork(fx.home, ctx.project), [], 'no Verifier check_authoring');
  });

  test('the same static_site candidate with its serving check failed: alpha_complete not satisfied, nothing recorded as serving verified', async () => {
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } });
    const { execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    const complete = await tickUntil(fx.engine, ctx.project, () => evaluations(fx.home, ctx.candidate.id, 'alpha_complete').at(-1), { max: 12, what: 'the completion evaluated' });
    assert.equal(complete.outcome, 'not_satisfied');
    assert.equal(complete.serving, null);
    assert.equal(candidateRow(fx.home, ctx.candidate.id).progress, 'developing');
  });

  test('a node_service candidate with only a serving check: still ACCEPTANCE_SCOPE_INCOMPLETE kind:post_deploy_behavior, as before', async () => {
    const files = { 'package.json': '{"name":"svc","scripts":{"start":"node server.js"}}\n', 'index.html': '<!doctype html><p>ops</p>\n' };
    const ctx = await deployable(fx, { files, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } });
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'the request');
    const incomplete = res.body.subject.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);
    assert.ok(incomplete.includes('kind:post_deploy_behavior'), JSON.stringify(res.body.subject.reasons));
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT "output_kind" FROM "artifacts" WHERE "project" = ?').get(ctx.project).output_kind), 'node_service');
  });

  test('a static configuration with no serving check: the engine proposes it (proposed_by engine), the gap names kind:post_deploy_serving, and no Verifier is asked', async () => {
    // The project's own checks list their inputs file by file (as the
    // Verifier's guide asks), so adding a definition changes none of them.
    const defs = { acc: { ...DEPLOY_DEFS.acc, inputs: [defPath('acc')] }, smoke: { ...DEPLOY_DEFS.smoke, inputs: [defPath('smoke')] } };
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs });
    const proposals = engineProposals(fx.home, ctx.project);
    assert.equal(proposals.length, 1, 'the engine proposed its serving check with the static configuration');
    const proposal = proposals[0];
    assert.deepEqual([proposal.proposed_by, proposal.run, proposal.requested_change_kind], ['engine', null, 'tightening']);
    assert.ok(proposal.rationale, 'its rationale record says why');
    const event = withStore(fx.home, (db) => db.prepare(`SELECT "payload" FROM "events" WHERE "type" = 'protected.proposed' AND json_extract("subject", '$.proposal') = ?`).get(proposal.id));
    assert.deepEqual([JSON.parse(event.payload).proposed_by, JSON.parse(event.payload).engine_authored], ['engine', 'post_deploy_serving']);
    const again = await fx.engine.request('PUT', `/v1/projects/${ctx.project}/environments/beta/config`, { body: configContent({ ...STATIC, port: 8081 }) });
    assert.equal(again.body.serving_check?.state, 'pending', `a second static environment proposes nothing more (${again.text})`);
    const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'alpha');
    assertRefused(res, 409, 'authorization_not_issued', 'the request');
    const incomplete = res.body.subject.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects);
    assert.deepEqual(incomplete, ['kind:post_deploy_serving']);
    assert.deepEqual(authoringWork(fx.home, ctx.project), [], 'no Verifier check_authoring for the engine\'s own check');
    // From here it is any proposal: classified at a tick, as its class routes it.
    const classified = await tickUntil(fx.engine, ctx.project, () => {
      const p = withStore(fx.home, (db) => db.prepare('SELECT * FROM "protected_proposals" WHERE "id" = ?').get(proposal.id));
      return p.classified_change_kind !== null ? p : undefined;
    }, { max: 8, what: 'the engine\'s proposal classified' });
    assert.equal(classified.classified_change_kind, 'tightening', classified.classification);
    assert.deepEqual(JSON.parse(classified.classification).elements, [{ reason: 'check_added', check: 'surety-static-serving' }]);
    assert.equal(classified.status, 'classified', 'a tightening, routed as every tightening is (the owner\'s decision under recommend)');
    assert.deepEqual(JSON.parse(classified.boundary_errors ?? '[]'), []);
  });

  test('a service configuration proposes nothing', async () => {
    const ctx = await deployable(fx, { files: { 'package.json': '{"scripts":{"start":"node server.js"}}\n' } });
    assert.deepEqual(engineProposals(fx.home, ctx.project), []);
    void SERVICE_FILES;
  });
});
