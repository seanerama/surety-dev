// Post-deploy behaviour check of the Workshop Cut Planner: judges the running
// service from outside, through SURETY_TARGET_APP.
//
// It asks the service for its page (GET /), the stylesheet and scripts the
// page references and every module those scripts import, as a browser does,
// and mirrors what the service answers into a scratch public/. It then runs
// the served page in the check DOM (../run/lib/page.mjs, one child process per
// session) and acts as the woodworker (./scenario.mjs): a 3 mm blade, a
// 2400 mm board and two 800 mm pieces must be drawn as piece 800, kerf 3,
// piece 800, kerf 3, offcut 794, and reopening the page must restore it.
// Everything the service answers is untrusted: sizes and file counts are
// bounded, only same-origin paths are followed, and the verdict is judged
// from the report each child prints. Exits nonzero on any failure.
//
//   SURETY_TARGET_APP=http://127.0.0.1:<port> node .surety/checks/post-deploy/user-operation.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageRunner = path.join(here, '..', 'run', 'lib', 'page.mjs');
const scenarioFile = path.join(here, 'scenario.mjs');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 64;

let failed = false;
const check = (cond, msg, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : ''}`);
  if (!cond) failed = true;
  return cond;
};
const finish = () => { console.log(failed ? 'user-operation: FAILED' : 'user-operation: passed'); process.exit(failed ? 1 : 0); };

const target = process.env.SURETY_TARGET_APP || '';
let base;
try { base = new URL(target); } catch { base = null; }
if (!check(base && base.protocol === 'http:', 'SURETY_TARGET_APP names an http address', target)) finish();

function get(urlPath) {
  return new Promise((res) => {
    const u = new URL(urlPath, base);
    const req = http.request({ host: u.hostname, port: u.port || 80, method: 'GET', path: u.pathname + u.search, timeout: 10000 }, (r) => {
      const chunks = [];
      let size = 0;
      r.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('answer larger than ' + MAX_BYTES + ' bytes')); return; } chunks.push(c); });
      r.on('end', () => res({ status: r.statusCode, type: String(r.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => res({ status: 0, error: e.message, type: '', body: '' }));
    req.end();
  });
}

// The same-origin path a reference names, or null.
function samePath(ref, from) {
  if (/^(data|blob|javascript):/i.test(ref)) return null;
  let u;
  try { u = new URL(ref, new URL(from, base)); } catch { return null; }
  if (u.origin !== base.origin) return { external: u.href };
  return { path: decodeURIComponent(u.pathname) };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cutplanner-deploy-'));
const publicDir = path.join(scratch, 'public');
fs.mkdirSync(publicDir);
function store(urlPath, body) {
  const file = path.normalize(path.join(publicDir, urlPath));
  if (!file.startsWith(publicDir + path.sep)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return true;
}

try {
  // The page, as a browser first asks for it.
  let page = { status: 0 };
  for (let i = 0; i < 20; i++) {
    page = await get('/');
    if (page.status) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(page.status === 200, 'GET / answers 200', { status: page.status, error: page.error });
  check(/^text\/html\b/i.test(page.type), 'GET / is text/html', page.type);
  if (!check(/<html|<!doctype html/i.test(page.body || ''), 'GET / is an HTML page', (page.body || '').slice(0, 300))) finish();
  check(/blade/i.test(page.body) && /\bmm\b|millimet/i.test(page.body), 'the page offers a blade-width field in mm', null);
  store('/index.html', page.body);

  // The stylesheets and scripts it references, and every module they import.
  const refs = [...page.body.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);
  const queue = [];
  const seen = new Set();
  const external = [];
  for (const r of refs) {
    const p = samePath(r, '/');
    if (!p) continue;
    if (p.external) { external.push(p.external); continue; }
    if (!seen.has(p.path)) { seen.add(p.path); queue.push(p.path); }
  }
  check(external.length === 0, 'the page loads nothing from another host', external);
  check([...seen].some((p) => /\.m?js$/.test(p)), 'the page references its script', [...seen]);
  while (queue.length) {
    const p = queue.shift();
    if (seen.size > MAX_FILES) { check(false, `the page needs at most ${MAX_FILES} files`, seen.size); break; }
    const r = await get(p);
    check(r.status === 200, `GET ${p} answers 200`, { status: r.status, error: r.error });
    if (r.status !== 200) continue;
    if (/\.m?js$/.test(p)) {
      check(/^(text|application)\/javascript\b/i.test(r.type), `GET ${p} is served as JavaScript`, r.type);
      const specs = [...r.body.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] || m[2]);
      for (const s of specs) {
        if (!/^(\.{0,2}\/)/.test(s) && !/^https?:/.test(s)) continue;
        const q = samePath(s, p);
        if (!q) continue;
        if (q.external) { check(false, `${p} imports nothing from another host`, q.external); continue; }
        if (!seen.has(q.path)) { seen.add(q.path); queue.push(q.path); }
      }
    } else if (/\.css$/.test(p)) {
      check(/^text\/css\b/i.test(r.type), `GET ${p} is served as text/css`, r.type);
    }
    if (!store(p, r.body)) check(false, `${p} maps into the page's files`, p);
  }
  if (failed) finish();

  // The woodworker's operation on the served page, one child per session.
  const { scenarios } = await import(new URL('./scenario.mjs', import.meta.url).href);
  const def = scenarios.deploy;
  console.log(def.title);
  let storage = {};
  let carry = null;
  let total = 0;
  for (let i = 0; i < def.sessions.length; i++) {
    const nonce = 'CPREPORT' + randomBytes(12).toString('hex') + ':';
    const r = spawnSync(process.execPath, [pageRunner, scenarioFile, 'deploy', String(i)], {
      cwd: scratch,
      env: { ...process.env, CP_NONCE: nonce, CP_STORAGE: JSON.stringify(storage), CP_CARRY: JSON.stringify(carry) },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith(nonce));
    console.log(`-- session ${i + 1} of ${def.sessions.length}`);
    if (!line || r.status !== 0) {
      check(false, 'the page process ends with its report', { status: r.status, signal: r.signal, error: r.error && r.error.message, output: ((r.stderr || '') + (r.stdout || '')).slice(-1500) });
      break;
    }
    const rep = JSON.parse(line.slice(nonce.length));
    for (const a of rep.assertions) {
      total++;
      console.log(`  ${a.ok ? 'ok  ' : 'FAIL'} ${a.msg}${!a.ok && a.detail ? '\n       ' + a.detail : ''}`);
      if (!a.ok) failed = true;
    }
    for (const n of rep.navigations || []) check(false, 'the page does not navigate away', n);
    for (const e of rep.pageErrors.slice(0, 5)) console.log(`  page error: ${e.slice(0, 600)}`);
    for (const n of rep.notes.slice(0, 5)) console.log(`  note: ${n}`);
    if (!check(rep.done, 'the session completes')) break;
    if (!check(rep.assertions.length > 0, 'the session made assertions')) break;
    storage = rep.storage || {};
    carry = rep.carry;
  }
  check(total > 0, 'the operation was judged', total);
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
finish();
