// M615, the downloadable deliverable (slice 49; kernel lane). M7 plan §3b
// M615; D4 §13.3 (the owner's instruction and ruling of 2026-10-29: "No
// additional owner approval is required to download an already-prepared
// deliverable through an authenticated request with access to that project.
// Downloading must not start agents, deploy anything or execute the
// program"), §3.1; SEAM.md §§577, 578.
//
// (a) `GET …/candidates/:c/deliverable` for a `static_site` candidate whose
//     phase gate is satisfied: ready, the package's identity, platform,
//     instructions, prerequisites and the two verifications apart;
// (b) before the gate is satisfied: 409 `deliverable_not_ready` with the
//     reason; an unknown candidate: 404;
// (c) `…/deliverable/download` twice: the headers, the entries exactly the
//     sealed artifact's files by SHA-256 (read by this test's own zip
//     reader), the second download byte-identical;
// (d) what the download does not do: no run, work item, operation,
//     decision or deployment; the only requirement the API token;
// (e) a `node_service` candidate: hosting required, the start command in the
//     instructions and the runtime version in the prerequisites, clearly
//     visible there (the owner's ruling of 2026-10-29 on objection 222).
//
// The phase gate is satisfied through the engine's own gate route (`POST
// …/gates/phase` with the published plan, M428 (d)), not by a fixture row.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { evaluationsOf, sharedFixture } from './harness/gates.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { DEPLOY_DEFS, configContent, deployable } from './harness/deploy/kernel.mjs';
import { NODE_FILES, SITE, STATIC, WITH_SERVE, engineBytes, readJson, sha256, unzip } from './harness/deploy/static.mjs';

const VERIFIED = { state: 'verified', what: 'every entry of the package re-read and matched to the sealed artifact by sha256' };
const NOT_TESTED = { state: 'not_tested', what: 'the program was not run on any platform by the engine; hosted checks are separate' };

const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const all = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));

// What reading or downloading may not create (D4 §13.3; the ruling).
const created = (home, project) => ({
  runs: one(home, 'SELECT COUNT(*) AS n FROM "runs" WHERE "project" = ?', project).n,
  work_items: one(home, 'SELECT COUNT(*) AS n FROM "work_items" WHERE "project" = ?', project).n,
  operations: one(home, 'SELECT COUNT(*) AS n FROM "operations" WHERE "project" = ?', project).n,
  decisions: one(home, 'SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ?', project).n,
  deployment_requests: one(home, 'SELECT COUNT(*) AS n FROM "deployment_requests" WHERE "project" = ?', project).n,
  authorizations: one(home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations" a JOIN "candidates" k ON k."id" = a."candidate" WHERE k."project" = ?', project).n,
  verifications: one(home, 'SELECT COUNT(*) AS n FROM "deployment_verifications" WHERE "project" = ?', project).n,
  check_executions: one(home, 'SELECT COUNT(*) AS n FROM "check_executions" WHERE "project" = ?', project).n,
});

// The candidate's phase gate evaluated through the engine's route; asserted satisfied.
async function phaseGate(fx, ctx) {
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/gates/phase`, { phase_plan: ctx.p.plan.plan.id });
  assert.equal(res.status, 200, `POST …/gates/phase (→ ${res.status} ${res.text})`);
  assert.equal(res.body.evaluation.outcome, 'satisfied', `the phase gate is satisfied (${res.text})`);
  return res.body.evaluation;
}

// The candidate's tracked files but .surety/, read from its repository by git.
function trackedFiles(repo, revision) {
  const names = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', revision], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => p !== '' && !p.startsWith('.surety/'));
  return Object.fromEntries(names.sort().map((p) => [p, execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${revision}:${p}`])]));
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

describe('M615 the downloadable deliverable of a static site', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const ctx = await deployable(fx, { files: SITE, config: STATIC, defs: WITH_SERVE });
    Object.assign(J, { fx, ctx });
    const base = `/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`;
    J.base = base;
    // (b): before the phase gate.
    J.beforeGate = { created: created(fx.home, ctx.project), read: await fx.engine.get(base), download: await fx.engine.get(`${base}/download`) };
    J.unknown = { read: await fx.engine.get(`/v1/projects/${ctx.project}/candidates/cand_01M62S00000000000000000000/deliverable`), download: await fx.engine.get(`/v1/projects/${ctx.project}/candidates/cand_01M62S00000000000000000000/deliverable/download`) };
    J.afterRefusals = created(fx.home, ctx.project);
    J.deliverablesBefore = one(fx.home, 'SELECT COUNT(*) AS n FROM "deliverables"').n;
    // The phase gate satisfied; then the reads and two downloads.
    J.gate = await phaseGate(fx, ctx);
    J.atGate = created(fx.home, ctx.project);
    J.noToken = await engineBytes(fx, base, { token: false });
    J.noTokenDownload = await engineBytes(fx, `${base}/download`, { token: false });
    J.read = await fx.engine.get(base);
    J.first = await engineBytes(fx, `${base}/download`);
    J.second = await engineBytes(fx, `${base}/download`);
    J.readAgain = await fx.engine.get(base);
    J.atEnd = created(fx.home, ctx.project);
    J.candidate = one(fx.home, 'SELECT * FROM "candidates" WHERE "id" = ?', ctx.candidate.id);
    J.project = one(fx.home, 'SELECT * FROM "projects" WHERE "id" = ?', ctx.project);
    J.rows = all(fx.home, 'SELECT * FROM "deliverables" WHERE "candidate" = ?', ctx.candidate.id);
  });
  after(() => shared.cleanup());

  test('(b) before the phase gate is satisfied: 409 deliverable_not_ready with the reason, for the read and the download; nothing built', () => {
    assertRefused(J.beforeGate.read, 409, 'deliverable_not_ready', 'the read before the phase gate');
    assert.match(J.beforeGate.read.body.reason, /phase gate/, 'the reason names the phase gate');
    assertRefused(J.beforeGate.download, 409, 'deliverable_not_ready', 'the download before the phase gate');
    assert.equal(J.deliverablesBefore, 0, 'no package was built');
    assert.deepEqual(evaluationsOf(J.fx.home, J.ctx.candidate.id, 'phase').length, 1, 'the one phase evaluation is the route\'s, made after');
  });

  test('(b) an unknown candidate: 404 for the read and the download', () => {
    assertRefused(J.unknown.read, 404, 'not_found', 'an unknown candidate\'s deliverable');
    assertRefused(J.unknown.download, 404, 'not_found', 'an unknown candidate\'s download');
  });

  test('(a) ready: format zip, version <seq>-<revision7>, the filename naming the project and both, bytes and sha256, the platform, instructions and prerequisites, the package verified and the execution not tested', () => {
    assert.equal(J.read.status, 200, J.read.text);
    const d = J.read.body.deliverable;
    const r7 = J.candidate.revision.slice(0, 7);
    const version = `${J.candidate.seq}-${r7}`;
    assert.equal(d.ready, true);
    assert.equal(d.not_ready_reason, null);
    assert.equal(d.candidate, J.ctx.candidate.id);
    assert.equal(d.revision, J.candidate.revision);
    assert.equal(d.format, 'zip');
    assert.equal(d.version, version);
    assert.equal(d.filename, `${slug(J.project.name)}-${version}.zip`, 'the filename names the project, the sequence and the revision');
    assert.ok(Number.isInteger(d.bytes) && d.bytes > 0, `bytes (${d.bytes})`);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.match(d.artifact_digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(d.platform, { kind: 'static_site', intended: 'any modern web browser, served from a local static file server', hosting_required: false });
    assert.ok(Array.isArray(d.instructions) && d.instructions.length > 0, 'instructions are given');
    assert.ok(d.instructions.some((i) => i.includes('index.html') && /static file server/.test(i)), `the instructions name the entry and a static file server (${JSON.stringify(d.instructions)})`);
    assert.ok(Array.isArray(d.prerequisites) && d.prerequisites.length > 0, `prerequisites are given (${JSON.stringify(d.prerequisites)})`);
    assert.deepEqual(d.verification, { package: VERIFIED, execution: NOT_TESTED }, 'package verification and execution testing stated apart, with their sentences');
    assert.equal(d.download, `${J.base}/download`);
  });

  test('(c) the download: application/zip, attachment with the filename, Content-Length the bytes, X-Surety-Sha256 the sha256', () => {
    const d = J.read.body.deliverable;
    assert.equal(J.first.status, 200);
    assert.equal(J.first.headers['content-type'], 'application/zip');
    assert.equal(J.first.headers['content-disposition'], `attachment; filename="${d.filename}"`);
    assert.equal(J.first.headers['content-length'], String(d.bytes));
    assert.equal(J.first.headers['x-surety-sha256'], d.sha256);
    assert.equal(J.first.bytes.length, d.bytes);
    assert.equal(sha256(J.first.bytes), d.sha256);
  });

  test('(c) the entries unzip to exactly the sealed artifact\'s files, each with its SHA-256; the second download is byte-identical', () => {
    const d = J.read.body.deliverable;
    const entries = unzip(J.first.bytes);
    const tracked = trackedFiles(J.project.dev_repo_path, J.candidate.revision);
    assert.deepEqual(entries.map((e) => e.name).sort(), Object.keys(tracked).sort(), 'exactly the candidate\'s tracked files, .surety/ apart (D4 §3.1)');
    for (const e of entries) assert.equal(sha256(e.bytes), sha256(tracked[e.name]), `${e.name}: its SHA-256`);
    for (const p of Object.keys(SITE)) assert.ok(entries.some((e) => e.name === p), `the site's ${p} is in the package`);
    // The sealed artifact's manifest (D4 §3.1, the projection a deployment seals).
    const [row] = J.rows;
    const manifest = readJson(row.manifest);
    assert.equal(d.artifact_digest, `sha256:${sha256(row.manifest)}`, 'the package is bound to the artifact digest of its manifest');
    assert.deepEqual(manifest.map((m) => [m[0], m[4]]).sort(), entries.map((e) => [e.name, sha256(e.bytes)]).sort(), 'each entry matches the sealed manifest by path and SHA-256');
    assert.ok(J.second.bytes.equals(J.first.bytes), 'the second download is byte-identical');
    assert.equal(J.second.headers['x-surety-sha256'], d.sha256);
    assert.deepEqual(J.readAgain.body.deliverable, d, 'the read again is the same');
    assert.equal(J.rows.length, 1, 'one package, built once');
  });

  test('(d) no run, work item, operation, decision or deployment created by the reads and downloads; the only requirement the API token', () => {
    assert.deepEqual(J.afterRefusals, J.beforeGate.created, 'the refusals created nothing');
    assert.deepEqual(J.atEnd, J.atGate, 'the reads and both downloads created nothing');
    for (const [what, res] of [['the read', J.noToken], ['the download', J.noTokenDownload]]) {
      assert.ok([401, 403].includes(res.status), `${what} without the API token is refused (→ ${res.status} ${res.bytes.toString('utf8').slice(0, 300)})`);
      assert.notEqual(res.headers['content-type'], 'application/zip', `${what} without the token serves no package`);
    }
    assert.equal(J.read.status, 200, 'with the token, and no approval asked, it is served');
    assert.equal(one(J.fx.home, `SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ? AND "status" = 'open' AND "kind" LIKE '%deliver%'`, J.ctx.project).n, 0, 'no approval is raised for it');
  });
});

describe('M615 (e) the deliverable of a node_service candidate', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const ctx = await deployable(fx, { files: NODE_FILES, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, behaves: DEPLOY_DEFS.behaves }, config: configContent() });
    Object.assign(J, { fx, ctx });
    await phaseGate(fx, ctx);
    J.read = await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`);
  });
  after(() => shared.cleanup());

  test('(e) hosting required; the start command given in the instructions', () => {
    assert.equal(J.read.status, 200, J.read.text);
    const d = J.read.body.deliverable;
    assert.equal(d.ready, true);
    assert.equal(d.platform.kind, 'node_service');
    assert.equal(d.platform.hosting_required, true);
    assert.ok(d.instructions.some((i) => i.includes('node server.js')), `the instructions give the start command (${JSON.stringify(d.instructions)})`);
    assert.deepEqual(d.verification, { package: VERIFIED, execution: NOT_TESTED });
  });

  // The owner's ruling of 2026-10-29 on objection 222 (the plan's M615 (e),
  // main c54152cb): the runtime version belongs in the prerequisites,
  // clearly visible there, and need not be repeated in the instructions; the
  // start command stays in the instructions (the case above).
  test('(e) the runtime version in the prerequisites, clearly visible there (the version the environment pins; objection 222 as ruled)', () => {
    const d = J.read.body.deliverable;
    assert.ok(Array.isArray(d.prerequisites) && d.prerequisites.length > 0, `the deliverable serves its prerequisites (${JSON.stringify(d.prerequisites)})`);
    const named = d.prerequisites.filter((i) => typeof i === 'string' && i.includes(`Node.js ${process.version}`));
    assert.equal(named.length, 1, `exactly one prerequisite names the runtime and its version, Node.js ${process.version}, the one the environment pins (prerequisites ${JSON.stringify(d.prerequisites)})`);
    assert.ok(!d.instructions.some((i) => i.includes('Node.js') && !i.includes(process.version)), `no instruction names another Node.js version (${JSON.stringify(d.instructions)})`);
  });
});
