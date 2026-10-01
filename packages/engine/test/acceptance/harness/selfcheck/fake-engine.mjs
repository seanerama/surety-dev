// Stand-in for `surety serve`, used only by run.mjs to exercise the harness's
// process and HTTP plumbing: start, wait, refuse, stop, and the requests the
// slice-2 helpers of ../runs.mjs send. It is not a model of the engine: every
// answer below is canned.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import Database from 'better-sqlite3';

const home = process.env.SURETY_HOME;
const cfgPath = join(home, 'config.json');
const config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
if ('bad' in config) {
  process.stderr.write('a log line\n');
  process.stderr.write(`${JSON.stringify({ code: 'unknown_field', reason: 'r', what_to_do: 'w', subject: { field: 'bad' } })}\n`);
  process.exit(4);
}
const tokenPath = join(home, 'api.token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
const token = readFileSync(tokenPath, 'utf8').trim();
let mode = 'restricted';

// A store with the two tables the slice-2 helpers read.
const db = new Database(join(home, 'store.db'));
db.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, options TEXT NOT NULL, preview_hash TEXT NOT NULL, status TEXT NOT NULL);`);

const triggers = new Map();
const work = new Map();
let serial = 0;
const ulid = () => String(++serial).padStart(26, '0');
const refusal = (code) => ({ code, reason: 'r', what_to_do: 'w', subject: {} });

// One tick at a time; a request during a tick makes another follow it.
let ticking = false;
let flagged = false;
function runTick() {
  if (ticking) return void (flagged = true);
  ticking = true;
  setTimeout(() => {
    db.prepare(`INSERT INTO events (type) VALUES ('engine.tick')`).run();
    ticking = false;
    if (flagged) {
      flagged = false;
      runTick();
    }
  }, 120);
}

function route(method, path, body) {
  const s = path.split('/').slice(1);
  if (method === 'GET') return [200, { mode }];
  if (path === '/v1/harness/fixtures/trigger') {
    if (body.kind === 'deploy') return [501, refusal('unsupported')];
    const key = [body.project, body.trigger_source, body.trigger_id, body.trigger_generation].join('|');
    if (triggers.has(key)) return [200, { work_item: { id: triggers.get(key) }, created: false }];
    const id = `wi_${ulid()}`;
    triggers.set(key, id);
    work.set(id, 'eligible');
    return [201, { work_item: { id }, created: true }];
  }
  if (s[1] === 'harness' && s[2] === 'work' && s[4] === 'transition') {
    if (body.to === 'integrating') return [409, refusal('illegal_transition')];
    work.set(s[3], body.to);
    return [200, { work_item: { id: s[3], status: body.to } }];
  }
  if (s[1] === 'projects' && s[3] === 'tick') {
    runTick();
    return [202, {}];
  }
  if (s[1] === 'projects' && s[3] === 'runs' && s[5] === 'stop') {
    if (s[4] === 'run_ENDED') return [409, refusal('illegal_transition')];
    if (body.preview_hash === undefined) {
      const id = `dec_${ulid()}`;
      db.prepare('INSERT INTO decisions (id, options, preview_hash, status) VALUES (?, ?, ?, ?)').run(id, '[{"key":"acknowledge"},{"key":"confirm"}]', `hash-${id}`, 'open');
      return [409, { ...refusal('confirm_required'), subject: { decision: id, preview_hash: `hash-${id}` } }];
    }
    const open = db.prepare(`SELECT * FROM decisions WHERE preview_hash = ? AND status = 'open'`).get(body.preview_hash);
    return open ? [200, { run: { id: s[4] } }] : [409, refusal('decision_stale')];
  }
  if (s[1] === 'projects' && s[3] === 'decisions' && s[5] === 'answer') {
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(s[4]);
    if (!row || row.preview_hash !== body.preview_hash) return [409, refusal('decision_stale')];
    return [200, {}];
  }
  if (path === '/v1/harness/clock/advance') return [200, { now: new Date(Date.now() + body.seconds * 1000).toISOString() }];
  if (path === '/v1/harness/allocate') return [200, { invocation: `inv_${'0'.repeat(25)}1` }];
  return [404, refusal('not_found')];
}

const server = http.createServer((req, res) => {
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.headers['x-surety-token'] !== token) return send(401, { code: 'token_required', reason: 'r', what_to_do: 'w', subject: null });
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    send(...route(req.method, req.url, text === '' ? {} : JSON.parse(text)));
  });
});
server.listen(config.api_port, '127.0.0.1', () => setTimeout(() => (mode = 'full'), 300));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
