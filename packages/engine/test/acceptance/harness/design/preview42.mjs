// M6 slice 42, the preview (M510, M511, M520; SEAM.md §§498 to 503). Built
// on slice 40's and 41's harness (reference.mjs, drive.mjs, check41.mjs):
//
// - the preview's names as the store and the host hold them: the reserved
//   environment `design-preview`, its engine-written configuration, its
//   deploy and teardown operations, the sealed directory, the unit
//   `surety-<h>-design-preview-g<n>.service` and its domain;
// - a preview deployed on the kernel lane's scripted adapter, its deploy
//   answered at the barrier `preview.sealed` (SEAM.md §499);
// - the engine's own server run by the test on the kernel lane, as the
//   configuration starts it, in the sealed directory, a child of the test
//   on 127.0.0.1 (SEAM.md §500): the server's responses with no unit;
// - raw HTTP reads (a path sent as written, bytes kept as bytes), the index
//   and the frame read as markup, a ustar archive read entry by entry;
// - the host's listeners on a port, read from /proc/net (as M337 reads them);
// - the end of a sandbox file: the project paused and nothing of it in
//   flight; a preview unit left by the file found by exact name.
//
// SAFETY (BS6 §4.1 rules 1, 2, 8, 21 to 24; E64). A unit is read by its exact
// name or from the user manager's list filtered here to this home's hash; the
// only act on one is `stopPreviewLeftovers`, after the engine's own `--stop`,
// by an exact name matching `surety-<this home's hash>-design-preview-g<n>.service`.
// The only process the test starts is the engine's own server on the kernel
// lane, its own child, ended through its own handle after its command line
// is read back. Nothing the Designer wrote is run: mockups are bytes over
// HTTP, never opened in a browser or executed (rules 21, 22).

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';

import { CLI, freePort, releaseBarrier, waitFor } from '../engine.mjs';
import { gitEnv } from '../git.mjs';
import { listTree } from '../repos.mjs';
import { SESSION_IDLE_STATES, tickUntil } from '../runs.mjs';
import { withStore } from '../store.mjs';
import { cgroupsNamed, listUnits, unitShow } from '../deploy/host.mjs';
import { armBarrier, attemptIntent, attemptsOf, configsOf, homeHash, operationsOf, scriptCall, tickToBarrier } from '../deploy/kernel.mjs';
import { cli, designEvents } from './drive.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const one = (home, sql, ...params) => rows(home, sql, ...params)[0] ?? null;
const parse = (v) => (v === null || v === undefined ? v : typeof v === 'string' ? JSON.parse(v) : v);
export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
// A digest as recorded, `sha256:<hex>` or `<hex>`, as its hex.
export const hexOf = (digest) => String(digest ?? '').replace(/^sha256:/, '');

// ---- the names (SEAM.md §§488, 499) ------------------------------------------------------------

export const PREVIEW_ENV = 'design-preview';
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
// D7 A.7; BS6 §11.1 (trial values, E156 Q4).
export const PREVIEW_MEMORY_MAX = 256 * MIB;
export const PREVIEW_TTL_DEFAULT = 86400;
export const PREVIEW_TTL_MIN = 3600;
// The frame's fixed sentence (D7 §5.7), verbatim.
export const BANNER_SENTENCE = 'Not native behaviour: back, safe areas, permissions, gestures, window chrome and menus are drawn, not exercised.';
// The banner's text for a `simulates` declaration (SEAM.md §500).
export const bannerOf = ({ target, form_factor, layout }) => `Simulation of ${target} (${form_factor ? `${form_factor}, ` : ''}${layout}). ${BANNER_SENTENCE}`;

// The engine's install: the directory holding the CLI's `dist/`.
export const ENGINE_INSTALL = dirname(dirname(CLI));

// ---- the host, read only ------------------------------------------------------------------------

export const previewPrefix = (home) => `surety-${homeHash(home)}-design-preview-`;
export const previewUnitName = (home, generation) => `${previewPrefix(home)}g${generation}.service`;
const ownPreviewUnit = (home) => new RegExp(`^surety-${homeHash(home)}-design-preview-g[1-9][0-9]*\\.service$`);

// The loaded units of this home's preview, by the list filtered to its prefix.
export function previewUnits(home) {
  const all = listUnits();
  assert.ok(all !== null, 'the user units can be listed (systemctl --user list-units): what is loaded is otherwise unknown');
  return all.filter((u) => u.unit.startsWith(previewPrefix(home)));
}
// Every loaded unit of this home's hash, any environment (SEAM.md §474's confinement).
export function homeUnits(home) {
  const all = listUnits();
  assert.ok(all !== null, 'the user units can be listed');
  return all.filter((u) => u.unit.startsWith(`surety-${homeHash(home)}-`)).map((u) => u.unit).sort();
}
export const previewCgroups = (home) => cgroupsNamed(previewPrefix(home));

// A cgroup's memory.max, read from the host (a number, `max`, or null if unread).
export function memoryMaxOf(cgroupPath) {
  try {
    const v = readFileSync(`${cgroupPath}/memory.max`, 'utf8').trim();
    return v === 'max' ? 'max' : Number(v);
  } catch {
    return null;
  }
}

// Listeners on a TCP port, from /proc/net/tcp and tcp6 (M337's read):
// [{family, local, inode}], `local` as the kernel writes it (127.0.0.1 is 0100007F).
export function hostListeners(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out = [];
  for (const [family, path] of [['tcp', '/proc/net/tcp'], ['tcp6', '/proc/net/tcp6']]) {
    let lines = [];
    try {
      lines = readFileSync(path, 'utf8').split('\n').slice(1);
    } catch {
      continue;
    }
    for (const l of lines) {
      const f = l.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(`:${hex}`) && f[3] === '0A') out.push({ family, local: f[1], inode: f[9] });
    }
  }
  return out;
}

// After a sandbox file: a preview unit of this home still loaded is asked to
// stop by the engine's own command, then, if still there, stopped by its exact
// name (rule 1). Returns the names found (the file fails on any).
export function stopPreviewLeftovers(fx, project) {
  let left = previewUnits(fx.home).map((u) => u.unit);
  if (left.length === 0) return [];
  if (project) cli(fx, ['design', 'preview', '--stop', '--project', project], { timeoutMs: 120_000 });
  left = previewUnits(fx.home).map((u) => u.unit);
  for (const name of left) {
    assert.ok(ownPreviewUnit(fx.home).test(name), `${name} is exactly this home's preview unit`);
    spawnSync('systemctl', ['--user', 'stop', '--', name], { encoding: 'utf8', timeout: 60_000 });
    const after = unitShow(name, ['LoadState', 'ActiveState']);
    if (after?.LoadState === 'loaded' && after?.ActiveState === 'failed') spawnSync('systemctl', ['--user', 'reset-failed', '--', name], { encoding: 'utf8', timeout: 30_000 });
    console.log(`# note: ${name} was left loaded by the file and stopped by the test by its exact name`);
  }
  return left;
}

// ---- the store (SEAM.md §499) ---------------------------------------------------------------------

export const previewEnvRow = (home, project) => one(home, 'SELECT * FROM "environments" WHERE "project" = ? AND "name" = ? ORDER BY rowid', project, PREVIEW_ENV);
export const previewConfig = (home, environment) => configsOf(home, environment).at(-1) ?? null;
export function previewOps(home, project, kind = 'deploy') {
  const env = previewEnvRow(home, project);
  return env ? operationsOf(home, project, kind).filter((o) => o.target?.environment === env.id) : [];
}
export const lastAttempt = (home, op) => attemptsOf(home, op.id).at(-1) ?? null;
export const sealedPathOf = (home, op) => lastAttempt(home, op)?.capability?.sealed_path ?? null;
export const intentOf = (home, op) => {
  const a = lastAttempt(home, op);
  return a ? attemptIntent(home, a.id) : null;
};
export const deployedEvents = (home, project) => designEvents(home, 'design.preview_deployed', project);
export const tornDownEvents = (home, project) => designEvents(home, 'design.preview_torn_down', project);
export const countOf = (home, sql, ...params) => one(home, sql, ...params)?.n ?? 0;
export const domainOfAttempt = (home, attempt) => {
  const r = one(home, 'SELECT * FROM "execution_domains" WHERE "attempt" = ?', attempt);
  return r ? { ...r, reservation: parse(r.reservation) } : null;
};
// A teardown operation applied (D4 §4.6): finalized, its last attempt's last reconciliation read `applied`.
export function teardownApplied(home, op) {
  const a = attemptsOf(home, op.id).at(-1);
  return op.finalized_at !== null && a?.reconciliation_reads?.at(-1)?.result === 'applied';
}

// ---- git: the design tree at a revision, as bytes -----------------------------------------------

// {path relative to .surety/design/: Buffer} of a commit's `.surety/design/`
// (`rev` a commit), or of a tree object (`tree` true: `rev` is the tree id).
export function designTreeAt(repo, rev, { tree = false } = {}) {
  const listed = listTree(repo, tree ? rev : `${rev}:.surety/design`);
  const out = {};
  for (const [path, spec] of Object.entries(listed)) {
    const [, type, oid] = spec.split(' ');
    if (type !== 'blob') continue;
    out[path] = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'cat-file', 'blob', oid], { env: gitEnv(repo), maxBuffer: 64 * MIB });
  }
  return out;
}

// Two {path: Buffer} maps hold the same paths with the same bytes.
export function assertSameFiles(actual, expected, what) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${what}: the same paths`);
  for (const path of Object.keys(expected)) assert.ok(Buffer.from(actual[path]).equals(Buffer.from(expected[path])), `${what}: ${path} byte for byte`);
}

// ---- the preview requested, deployed on the kernel lane (SEAM.md §499) -----------------------------

export const previewRoute = (fx, project, body) => fx.engine.post(`/v1/projects/${project}/design/preview`, body);
const barrierWaiting = async (fx, name) => (await fx.engine.get('/v1/harness/barriers')).body?.barriers?.some((b) => b.name === name && b.state === 'waiting') ?? false;

// POST …/design/preview {revision} with the deploy answered at `preview.sealed`
// on the scripted adapter; ticks until the next `design.preview_deployed`.
// Returns {res, env, event, op}.
export async function previewOnKernel(fx, project, { revision = 'checkpoint', answers = [{ result: 'issued', apply: true }] } = {}) {
  const before = deployedEvents(fx.home, project).length;
  await armBarrier(fx.engine, 'preview.sealed', 'pause');
  let settled = null;
  const asked = previewRoute(fx, project, { revision }).then((r) => (settled = r));
  await waitFor(async () => settled !== null || (await barrierWaiting(fx, 'preview.sealed')), { timeoutMs: 60_000, what: 'the preview request answered or the engine at preview.sealed' });
  if (settled !== null) assert.ok(settled.status >= 200 && settled.status < 300, `POST …/design/preview {revision: ${revision}} is accepted (SEAM.md §499) (→ ${settled.status} ${settled.text?.slice(0, 600)})`);
  if (!(await barrierWaiting(fx, 'preview.sealed'))) await tickToBarrier(fx, project, 'preview.sealed');
  const env = previewEnvRow(fx.home, project);
  assert.ok(env, 'the reserved environment design-preview is a row of the project once the preview is asked for (SEAM.md §499)');
  await scriptCall(fx.engine, env.id, 'deploy', answers);
  await releaseBarrier(fx.engine, 'preview.sealed');
  const res = await asked;
  assert.ok(res.status >= 200 && res.status < 300, `POST …/design/preview {revision: ${revision}} is accepted (→ ${res.status} ${res.text?.slice(0, 600)})`);
  const event = await tickUntil(fx.engine, project, () => deployedEvents(fx.home, project)[before], { max: 16, what: 'design.preview_deployed' });
  return { res, env, event, op: previewOps(fx.home, project).at(-1) ?? null };
}

// ---- the engine's server run by the test on the kernel lane (SEAM.md §500) -------------------------

// The configuration's `start` run in the sealed directory, with the
// configuration's `env` and PORT, as the service domain starts it (D4 §9.2),
// as a plain child of the test on 127.0.0.1. Returns {port, child, out, stop}.
export async function runPreviewServer(config, sealed, { tmp }) {
  assert.ok(Array.isArray(config?.start) && config.start.length >= 2, `the reserved environment's configuration starts a program (SEAM.md §499) (${JSON.stringify(config?.start)})`);
  const port = await freePort();
  const [cmd, ...args] = config.start;
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: tmp, TMPDIR: tmp, ...(config.env ?? {}), PORT: String(port) };
  const child = spawn(cmd, args, { cwd: sealed, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => (out.stdout += c));
  child.stderr.on('data', (c) => (out.stderr += c));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let argv = [];
    try {
      argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
    } catch {
      return;
    }
    if (argv[0] !== cmd) return; // not the process this test started: nothing is signalled
    child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 10_000, what: 'the server the test started to end' }).catch(() => child.kill('SIGKILL'));
  };
  try {
    await waitFor(async () => child.exitCode !== null || (await rawRequest(port, 'GET', '/')).status !== null, { timeoutMs: 15_000, what: `the engine's server to answer on 127.0.0.1:${port}` });
  } catch (err) {
    await stop();
    throw new Error(`${err.message} (stdout ${out.stdout.slice(0, 400)}; stderr ${out.stderr.slice(0, 800)})`);
  }
  assert.equal(child.exitCode, null, `the engine's server runs (exit ${child.exitCode}; stderr ${out.stderr.slice(0, 800)})`);
  return { port, child, out, stop };
}

// ---- HTTP, bytes kept as bytes ---------------------------------------------------------------------

// One request to 127.0.0.1:<port> with `path` sent exactly as written.
// {status, headers, bytes} or {status: null, error}.
export function rawRequest(port, method, path, { headers = {}, body, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const sent = { host: `127.0.0.1:${port}`, connection: 'close', ...headers };
    if (body !== undefined) sent['content-length'] = String(Buffer.byteLength(body));
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, method, path, headers: sent, setHost: false, agent: false, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
        res.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
      });
    } catch (err) {
      resolve({ status: null, error: err.code ?? String(err) });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: null, error: err.code ?? String(err) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
// A GET of the engine's API with the test's token, its body as bytes.
export function engineBytes(fx, path) {
  return rawRequest(fx.engine.port, 'GET', path, { headers: { host: fx.engine.authority, 'x-surety-token': fx.engine.token() } });
}
export const textOf = (res) => (res?.bytes ? res.bytes.toString('utf8') : '');

// ---- markup, read as text (SEAM.md §500) ----------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
export const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map((m) => [m[1].toLowerCase(), decode(m[3] ?? m[4] ?? m[5] ?? '')]));

// The index's entries: every `<a>` carrying `data-path` (SEAM.md §500).
export function indexEntries(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (a['data-path'] !== undefined) out.push({ path: a['data-path'], target: a['data-target'], capability: a['data-capability'], href: a.href });
  }
  return out;
}

// The engine's frame for a simulated mockup (D7 §5.7; SEAM.md §500): the
// banner element `id="surety-simulation-banner"` with the fixed text, before
// the one iframe, `sandbox="allow-scripts"` exactly, no `srcdoc`, its `src`
// naming the mockup's path; never the mockup's bytes.
export function assertFrame(res, { path, mockup, target, form_factor, layout }, what) {
  assert.equal(res.status, 200, `${what}: answered 200 (→ ${res.status} ${res.error ?? textOf(res).slice(0, 300)})`);
  assert.match(String(res.headers?.['content-type'] ?? ''), /^text\/html/, `${what}: text/html`);
  if (mockup) assert.ok(!res.bytes.equals(Buffer.from(mockup)), `${what}: not the mockup's bytes bare`);
  const html = textOf(res);
  const banner = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bid\s*=\s*["']surety-simulation-banner["'][^>]*>([\s\S]*?)<\/\1\s*>/.exec(html);
  assert.ok(banner, `${what}: the engine's banner (id="surety-simulation-banner") (${html.slice(0, 600)})`);
  const text = decode(banner[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  assert.equal(text, bannerOf({ target, form_factor, layout }), `${what}: the banner names the target, form factor and layout and says it is a simulation (D7 §5.7)`);
  const iframes = [...html.matchAll(/<iframe\b[^>]*>/gi)];
  assert.equal(iframes.length, 1, `${what}: one iframe (${iframes.map((m) => m[0]).join(' ')})`);
  const a = attrsOf(iframes[0][0]);
  assert.equal(a.sandbox, 'allow-scripts', `${what}: the iframe's sandbox allows scripts and not same origin, nor any navigation of the frame (${iframes[0][0]})`);
  assert.ok(!('srcdoc' in a), `${what}: the iframe loads the mockup by src, not srcdoc`);
  let src = a.src ?? '';
  try {
    src = decodeURIComponent(src);
  } catch {
    // kept as written
  }
  assert.ok(src.includes(path), `${what}: the iframe's src names ${path} (${a.src})`);
  assert.ok(banner.index < iframes[0].index, `${what}: the banner stands outside and before the iframe`);
  return { html, banner: text, iframe: a };
}

// ---- export (SEAM.md §501) -------------------------------------------------------------------------

// A ustar archive's regular files: {path: Buffer}; a pax `path` record names
// the next entry. Fails on anything that is not ustar.
export function untar(buf) {
  const out = {};
  const str = (h, at, n) => {
    const s = h.subarray(at, at + n);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? n : z).toString('utf8');
  };
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    assert.equal(str(h, 257, 5), 'ustar', `a ustar header at ${off}`);
    const name = str(h, 0, 100);
    const prefix = str(h, 345, 155);
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    if (type === '0') out[full.replace(/^\.\//, '')] = Buffer.from(data);
  }
  return out;
}

// SIMULATIONS.txt's records: every line not empty and not starting `#`, split on tabs.
export const simulationRecords = (text) =>
  String(text)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('\t'));

// ---- the end of a sandbox file ------------------------------------------------------------------

// What of the project is in flight (as harness/journey/project.mjs reads it, SEAM.md §474).
export const inFlight = (home, project) =>
  withStore(home, (db) => [
    ...db
      .prepare(`SELECT "id", "kind", "role", "state", "session_state" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' AND "quarantined" = 0`)
      .all(project)
      .filter((r) => !(r.kind === 'session' && SESSION_IDLE_STATES.includes(r.session_state))),
    ...db
      .prepare(`SELECT x."id", 'check_execution' AS "kind", x."status" AS "state" FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ? AND x."status" IN ('materializing', 'running', 'collecting')`)
      .all(project),
  ]);

// The project paused through the owner's route and nothing of it left in flight.
export async function quiesce(fx, project, { timeoutMs = 300_000 } = {}) {
  const paused = await fx.engine.post(`/v1/projects/${project}/pause`, {});
  assert.equal(paused.status, 200, `the project paused at the end (${paused.status} ${paused.text})`);
  await waitFor(() => inFlight(fx.home, project).length === 0, { timeoutMs, what: `nothing of the project in flight (${JSON.stringify(inFlight(fx.home, project))})` });
}

// The non-terminated domains of a project other than `except` (the kernel lane's envelope counts them).
export const liveDomains = (home, project, except = []) => rows(home, `SELECT "id", "profile", "status" FROM "execution_domains" WHERE "project" = ? AND "status" <> 'terminated'`, project).filter((d) => !except.includes(d.id));
