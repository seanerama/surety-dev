// Developer tests for the downloadable Alpha deliverable (SHAPES.md §4; the
// owner's instruction and ruling of 2026-10-29): the zip written with
// Node's zlib, the same files giving the same bytes, read back here by this
// test's own reader (not the engine's); the platform, instructions and
// prerequisites by output kind and the verification texts, verbatim; and
// over HTTP on a disposable kernel-lane engine: 409 deliverable_not_ready
// before the candidate's phase gate is satisfied, 404 for a candidate that
// is not the project's, then the metadata, the download's headers and bytes
// (exactly the candidate's tracked files but .surety/, each with its
// SHA-256), the same bytes on a second read, and nothing started by any of
// it: no run, no work item, no operation, no decision.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 as zcrc32, inflateRawSync } from 'node:zlib';

import { assertRefused } from '../acceptance/harness/fixtures.mjs';
import { evaluate, sharedFixture } from '../acceptance/harness/gates.mjs';
import { scriptedEngine } from '../acceptance/harness/runs.mjs';
import { withStore } from '../acceptance/harness/store.mjs';
import { def } from '../acceptance/harness/checks/scope.mjs';
import { DEPLOY_DEFS, deployable } from '../acceptance/harness/deploy/kernel.mjs';
import { SITE } from './static-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { writeZip, readZip, crc32 } = await import(join(dist, 'deploy', 'zip.js'));
const { platformOf, slugOf, PACKAGE_VERIFIED, EXECUTION_NOT_TESTED, NO_INSTRUCTIONS } = await import(join(dist, 'deploy', 'deliverable.js'));

const sha = (b) => createHash('sha256').update(b).digest('hex');

// This test's own reader: the end record, the central directory, each
// local header, raw inflate, and zlib's CRC-32.
function unzip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'an end of central directory record');
  const n = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28);
    const skip = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const mode = (buf.readUInt32LE(at + 38) >>> 16) & 0o777;
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    at += 46 + nlen + skip;
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const bytes = method === 0 ? Buffer.from(data) : inflateRawSync(data);
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`);
    assert.equal(bytes.length, usize, `${name}: its size`);
    assert.equal(zcrc32(bytes), crc, `${name}: its CRC-32`);
    out.push({ name, bytes, mode, date, time });
  }
  return out;
}

test('the zip: every entry stored or deflated with its CRC-32, the same files and instant giving the same bytes, read back by this test\'s own reader', () => {
  const files = [
    { name: 'index.html', bytes: Buffer.from(SITE['index.html'].repeat(20)) },
    { name: 'img/x.bin', bytes: Buffer.from([0, 1, 2, 3, 255]), mode: 0o755 },
    { name: 'empty.txt', bytes: Buffer.alloc(0) },
  ];
  const at = new Date('2026-10-29T12:34:56Z');
  const z = writeZip(files, at);
  assert.ok(z.equals(writeZip(files, at)), 'deterministic');
  assert.ok(!z.equals(writeZip(files, new Date('2026-10-30T00:00:00Z'))), 'the instant is in the bytes');
  const back = unzip(z);
  assert.deepEqual(back.map((e) => e.name), files.map((f) => f.name), 'in the order given');
  for (let i = 0; i < files.length; i++) assert.ok(back[i].bytes.equals(files[i].bytes), files[i].name);
  assert.deepEqual(back.map((e) => e.mode), [0o644, 0o755, 0o644]);
  assert.deepEqual(new Set(back.map((e) => `${e.date}:${e.time}`)).size, 1, 'one timestamp');
  assert.equal(back[0].date, ((2026 - 1980) << 9) | (10 << 5) | 29);
  assert.deepEqual(readZip(z).map((e) => e.name), files.map((f) => f.name), 'the engine\'s reader agrees');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'the CRC-32 check value');
  assert.throws(() => writeZip([{ name: '../x', bytes: Buffer.alloc(1) }], at), /relative path/);
  assert.throws(() => writeZip([{ name: '/etc/x', bytes: Buffer.alloc(1) }], at), /relative path/);
});

test('platform, instructions and prerequisites by output kind; the verification texts', () => {
  const s = platformOf('static_site', { start: null, node: null });
  assert.deepEqual(s.platform, { kind: 'static_site', intended: 'any modern web browser, served from a local static file server', hosting_required: false });
  assert.deepEqual(s.instructions, ['Unzip; serve the folder with any static file server (ES modules do not load from file://); open index.html.']);
  const n = platformOf('node_service', { start: 'node server.js', node: 'v22.22.0' });
  assert.equal(n.platform.kind, 'node_service');
  assert.equal(n.platform.hosting_required, true);
  assert.ok(n.instructions.some((i) => i.includes('npm start') && i.includes('node server.js')));
  assert.ok(n.prerequisites[0].includes('v22.22.0'));
  assert.ok(platformOf('node_service', { start: null, node: null }).prerequisites[0].includes('does not know'), 'an unknown runtime version is said to be unknown');
  const u = platformOf('unknown', { start: null, node: null });
  assert.deepEqual([u.platform.kind, u.instructions], ['unknown', ['No run instructions are known for this output']]);
  assert.equal(NO_INSTRUCTIONS, 'No run instructions are known for this output');
  assert.equal(PACKAGE_VERIFIED, 'every entry of the package re-read and matched to the sealed artifact by sha256');
  assert.equal(EXECUTION_NOT_TESTED, 'the program was not run on any platform by the engine; hosted checks are separate');
  assert.deepEqual([slugOf('Lap Lab!'), slugOf('  '), slugOf('Ünïcode_Name 2')], ['lap-lab', 'project', 'n-code-name-2']);
});

// ---- over HTTP on a disposable engine --------------------------------------------------------

const SERVE = def('post_deploy_serving', { gates: ['alpha_complete'], requires: ['environment', 'artifact_digest'], command: ['surety-static-serving'], inputs: [] });

function download(fx, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: fx.engine.port, path, method: 'GET', agent: false, headers: { host: fx.engine.authority, 'x-surety-token': fx.engine.token(), connection: 'close' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// What nothing here may start or raise.
const counts = (home, project) =>
  withStore(home, (db) => ({
    runs: db.prepare('SELECT COUNT(*) AS n FROM "runs" WHERE "project" = ?').get(project).n,
    work: db.prepare('SELECT COUNT(*) AS n FROM "work_items" WHERE "project" = ?').get(project).n,
    operations: db.prepare('SELECT COUNT(*) AS n FROM "operations" WHERE "project" = ?').get(project).n,
    decisions: db.prepare('SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ?').get(project).n,
  }));

// The candidate's tracked files but .surety/, read from its repository.
function trackedFiles(repo, revision) {
  const names = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-z', '--name-only', revision], { encoding: 'utf8' }).split('\0').filter((p) => p !== '' && !p.startsWith('.surety/'));
  return Object.fromEntries(names.sort().map((p) => [p, execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${revision}:${p}`])]));
}

describe('the deliverable over the engine\'s API (kernel lane)', () => {
  const shared = sharedFixture();
  let fx;
  let ctx;
  before(async () => {
    fx = await scriptedEngine(shared.context);
    ctx = await deployable(fx, { files: SITE, config: { mode: 'static', start: undefined }, defs: { acc: DEPLOY_DEFS.acc, smoke: DEPLOY_DEFS.smoke, serve: SERVE } });
  });
  after(() => shared.cleanup());

  test('409 deliverable_not_ready before the candidate\'s phase gate is satisfied; 404 for a candidate that is not the project\'s', async () => {
    const before = counts(fx.home, ctx.project);
    const res = await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`);
    assertRefused(res, 409, 'deliverable_not_ready', 'before the phase gate');
    assert.match(res.body.reason, /phase gate/);
    assertRefused(await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable/download`), 409, 'deliverable_not_ready', 'the download too');
    assertRefused(await fx.engine.get(`/v1/projects/${ctx.project}/candidates/cand_nope/deliverable`), 404, 'not_found', 'an unknown candidate');
    assertRefused(await fx.engine.get(`/v1/projects/${ctx.project}/candidates/cand_nope/deliverable/download`), 404, 'not_found', 'an unknown candidate');
    assert.deepEqual(counts(fx.home, ctx.project), before, 'nothing started or raised');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deliverables"').get().n), 0);
  });

  test('ready once the phase gate is satisfied: the metadata, the download\'s headers and bytes (the candidate\'s files, each by SHA-256), the same bytes again, nothing started', async () => {
    // The phase gate satisfied, as test setup: the candidate's stage
    // evaluation, recorded again as a satisfied `phase` evaluation (labelled
    // here as the fixture it is; a whole phase is M5's journey).
    const stage = await evaluate(fx.engine, ctx.project, ctx.candidate.id, 'stage', { stage: ctx.p.stages[0].id }, { inventory: false });
    withStore(
      fx.home,
      (db) => {
        const row = db.prepare('SELECT * FROM "gate_evaluations" WHERE "id" = ?').get(stage.id);
        const cols = Object.keys(row);
        const copy = { ...row, id: 'gate_FIXTUREPHASE0000000000000', gate_kind: 'phase', outcome: 'satisfied', reasons: '[]', stale: 0, stage: null };
        db.prepare(`INSERT INTO "gate_evaluations" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => copy[c]));
      },
      { readonly: false },
    );
    const before = counts(fx.home, ctx.project);
    const res = await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`);
    assert.equal(res.status, 200, res.text);
    const d = res.body.deliverable;
    const cand = withStore(fx.home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "id" = ?').get(ctx.candidate.id));
    const project = withStore(fx.home, (db) => db.prepare('SELECT * FROM "projects" WHERE "id" = ?').get(ctx.project));
    const r7 = cand.revision.slice(0, 7);
    assert.deepEqual(
      [d.candidate, d.revision, d.format, d.version, d.filename, d.ready, d.not_ready_reason],
      [cand.id, cand.revision, 'zip', `${cand.seq}-${r7}`, `${slugOf(project.name)}-${cand.seq}-${r7}.zip`, true, null],
    );
    assert.match(d.artifact_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(d.platform, { kind: 'static_site', intended: 'any modern web browser, served from a local static file server', hosting_required: false });
    assert.deepEqual(d.instructions, ['Unzip; serve the folder with any static file server (ES modules do not load from file://); open index.html.']);
    assert.ok(Array.isArray(d.prerequisites));
    assert.deepEqual(d.verification, {
      package: { state: 'verified', what: 'every entry of the package re-read and matched to the sealed artifact by sha256' },
      execution: { state: 'not_tested', what: 'the program was not run on any platform by the engine; hosted checks are separate' },
    });
    assert.equal(d.download, `/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable/download`);

    const got = await download(fx, d.download);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/zip');
    assert.equal(got.headers['content-disposition'], `attachment; filename="${d.filename}"`);
    assert.equal(got.headers['content-length'], String(d.bytes));
    assert.equal(got.headers['x-surety-sha256'], d.sha256);
    assert.equal(got.bytes.length, d.bytes);
    assert.equal(sha(got.bytes), d.sha256);
    const entries = unzip(got.bytes);
    const tracked = trackedFiles(project.dev_repo_path, cand.revision);
    assert.deepEqual(entries.map((e) => e.name), Object.keys(tracked), 'exactly the tracked files but .surety/, in the manifest\'s order');
    for (const e of entries) assert.equal(sha(e.bytes), sha(tracked[e.name]), `${e.name}: its SHA-256`);
    assert.ok(entries.some((e) => e.name === 'index.html') && !entries.some((e) => e.name.startsWith('.surety/')));
    const art = withStore(fx.home, (db) => db.prepare('SELECT * FROM "deliverables" WHERE "candidate" = ?').all(ctx.candidate.id));
    assert.equal(art.length, 1);
    assert.ok(art[0].path.endsWith(`/artifacts/${ctx.project}/${d.artifact_digest.slice(7)}.zip`), art[0].path);
    // Again: the same bytes, the same row.
    const again = await download(fx, d.download);
    assert.ok(again.bytes.equals(got.bytes));
    assert.equal(again.headers['x-surety-sha256'], d.sha256);
    assert.deepEqual((await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`)).body.deliverable, d);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deliverables"').get().n), 1, 'built once');
    assert.deepEqual(counts(fx.home, ctx.project), before, 'no run, no work item, no operation, no decision');
    // A package whose bytes changed on disk is never served or said verified.
    chmodSync(art[0].path, 0o644);
    appendFileSync(art[0].path, 'x');
    const changed = await fx.engine.get(`/v1/projects/${ctx.project}/candidates/${ctx.candidate.id}/deliverable`);
    assertRefused(changed, 409, 'deliverable_not_ready', 'a changed package');
    assert.match(changed.body.reason, /no longer verifies/);
    assertRefused(await fx.engine.get(d.download), 409, 'deliverable_not_ready', 'its download');
  });
});
