// Smoke check of the static server: starts `node server.mjs` on a free port
// as a child process and asks it for the page, its stylesheet and its script.
// Exits nonzero on any failed expectation or if the server does not answer.

import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const free = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const port = await free();
const child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
let exited = null;
child.on('exit', (code, sig) => { exited = `exit ${code}${sig ? ' signal ' + sig : ''}`; });

function request(method, path) {
  return new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, timeout: 5000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, type: String(r.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => res({ status: 0, error: e.message, type: '', body: '' }));
    req.end();
  });
}

let failed = false;
const check = (cond, msg, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${!cond && detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : ''}`);
  if (!cond) failed = true;
  return cond;
};

try {
  let page = null;
  for (let i = 0; i < 100 && !exited; i++) {
    page = await request('GET', '/');
    if (page.status) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(!exited, 'node server.mjs keeps running', exited);
  check(page && page.status === 200, 'GET / answers 200', page && { status: page.status, error: page.error });
  check(page && /^text\/html\b/i.test(page.type), 'GET / is text/html', page && page.type);
  check(page && /<html|<!doctype html/i.test(page.body), 'GET / is an HTML page', page && page.body.slice(0, 300));
  const css = await request('GET', '/styles.css');
  check(css.status === 200 && /^text\/css\b/i.test(css.type), 'GET /styles.css answers 200 text/css', { status: css.status, type: css.type });
  const js = await request('GET', '/js/app.mjs');
  check(js.status === 200 && /^(text|application)\/javascript\b/i.test(js.type), 'GET /js/app.mjs answers 200 text/javascript', { status: js.status, type: js.type });
  const refs = [...(page ? page.body : '').matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'));
  check(refs.some((u) => /styles\.css/.test(u)) && refs.some((u) => /app\.mjs/.test(u)), 'the page references /styles.css and /js/app.mjs', refs);
  for (const u of refs) {
    const r = await request('GET', u.startsWith('/') ? u : '/' + u);
    check(r.status === 200, `the page's ${u} loads (200)`, r.status);
  }
  const ext = [...(page ? page.body : '').matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)].map((m) => m[1]);
  check(ext.length === 0, 'the page loads nothing from another host', ext);
  const missing = await request('GET', '/no-such-file.txt');
  check(missing.status === 404, 'GET of a missing file answers 404', missing.status);
  const escape = await request('GET', '/%2e%2e/server.mjs');
  check(escape.status === 404 && !/createServer/.test(escape.body), 'a path escaping public/ answers 404', escape.status);
  const post = await request('POST', '/');
  check(post.status === 405, 'POST / answers 405', post.status);
} finally {
  child.kill('SIGKILL');
}
if (failed && out.trim()) console.log('server output: ' + out.slice(-1500));
console.log(failed ? 'smoke: FAILED' : 'smoke: passed');
process.exit(failed ? 1 : 0);
