// Test-owned post-deploy check program for row M314 (the service link;
// SEAM.md §268). The engine runs it as the `behaves` check inside a `check`
// domain; `installLinkCheck` (host.mjs) writes it with a shebang naming the
// test's node. Node built-ins only, no relative imports.
//
// It probes the service link: it asks SURETY_TARGET_APP (which the engine
// relays to the frozen generation), and, to show the link reaches that
// generation and nothing else, it also tries addresses it must not reach.
// It is an instrument in BS4 §4.1 rule 8's sense, so it fails closed: every
// step but `tree`, `get`, `hold` and `sleep` runs only once it reads its own
// containment from inside (`--host-ns`: its pid, net and mnt namespaces
// differ from the host's, pid 1 is no system init, at most 16 processes);
// any failed read is a refusal (exit 94). The test's half writes the plan
// only after reading the check's containment from the host. It signals
// nothing and starts no process; every wait is bounded.
//
// --hold <name> --release-dir <dir> --host-ns <pid:[n],net:[n],mnt:[n]>
// It waits (<=280 s) for <dir>/<name>, a plan {"steps":[Step],"exit":<n>},
// runs the steps, writes one line `SURETY-LINK-REPORT <json>`
// ({target, guard, steps:[{...step, result}], listeners:[{port, accepted}]}),
// and exits with `exit`. Steps:
//   {do:"tree"}                         entries under cwd (no link followed, <=5000)
//   {do:"get", path}                    one GET to SURETY_TARGET_APP (15 s)
//   {do:"reach", host, port, timeout_ms?}  one TCP attempt, `GET /hello` sent;
//                                       {reached, bytes, error, ms}
//   {do:"unix", path}                   one connection to a unix socket path
//   {do:"listen", port}                 listen on 127.0.0.1:<port> for the rest
//                                       of the plan; counted in `listeners`
//   {do:"open", id, path}               a GET to the target kept open and read
//   {do:"wait_closed", id, max_s}       wait until connection <id> ends; {closed, ms, bytes}
//   {do:"unread", path, pause_s, idle_s}  a GET to the target, nothing read for
//                                       pause_s, then drained; {ended, bytes}
//   {do:"many", count, path, timeout_ms}  <count> connections at once; each {reached, ms}
//   {do:"hold", name}                   wait (<=280 s) for <dir>/<name>
//   {do:"sleep", ms}                    wait (<=120 s)

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import net from 'node:net';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const opts = { hold: null, releaseDir: null, hostNs: null };
while (argv.length > 0) {
  const flag = argv.shift();
  if (flag === '--hold') opts.hold = argv.shift() ?? null;
  else if (flag === '--release-dir') opts.releaseDir = argv.shift() ?? null;
  else if (flag === '--host-ns') opts.hostNs = argv.shift() ?? null;
}

const out = (line) => {
  const buf = Buffer.from(`${line}\n`);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off, buf.length - off);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE = new Set(['tree', 'get', 'hold', 'sleep']);
const target = process.env.SURETY_TARGET_APP ?? null;
const targetAddr = () => {
  const u = new URL(target);
  return { host: u.hostname, port: Number(u.port) };
};

function guardReasons() {
  const reasons = [];
  const host = {};
  for (const part of (opts.hostNs ?? '').split(',')) {
    const kind = part.slice(0, part.indexOf(':'));
    if (['pid', 'net', 'mnt'].includes(kind)) host[kind] = part;
  }
  for (const kind of ['pid', 'net', 'mnt']) {
    let mine = null;
    try {
      mine = readlinkSync(`/proc/self/ns/${kind}`);
    } catch {
      mine = null;
    }
    if (!/^[a-z]+:\[\d+\]$/.test(host[kind] ?? '')) reasons.push(`no host ${kind} namespace given`);
    if (mine === null) reasons.push(`own ${kind} namespace unreadable`);
    else if (mine === host[kind]) reasons.push(`in the host's ${kind} namespace`);
  }
  try {
    const init = readFileSync('/proc/1/comm', 'utf8').trim();
    if (['systemd', 'init', 'upstart', 'launchd'].includes(init)) reasons.push(`pid 1 is a system init (${init})`);
  } catch {
    reasons.push('pid 1 unreadable');
  }
  try {
    if (readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length > 16) reasons.push('more than 16 processes visible');
  } catch {
    reasons.push('/proc unlistable');
  }
  return reasons;
}

async function holdFor(name) {
  const file = join(opts.releaseDir ?? '/nonexistent', name);
  const until = Date.now() + 280_000;
  while (!existsSync(file)) {
    if (Date.now() > until) return null;
    await sleep(100);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8') || 'null');
  } catch {
    return null;
  }
}

function tree() {
  const root = process.cwd();
  const entries = [];
  const visit = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= 5000) return;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      entries.push({ path: relative(root, full), type });
      if (type === 'dir') visit(full);
    }
  };
  visit(root);
  return { cwd: root, entries };
}

// One GET over the service link (the engine relays it to the frozen
// generation), on a connection of its own (`agent: false`): Node's global
// agent keeps connections alive, and the link logs connections, not requests
// (SEAM.md §268; objection 040).
function get(path) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(path, target);
    } catch (err) {
      return resolve({ status: null, body: null, error: `bad_url:${err.message}` });
    }
    const req = request(url, { method: 'GET', timeout: 15_000, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < 4096) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096), error: null }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: null, body: null, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ status: null, body: null, error: err.code ?? String(err) }));
    req.end();
  });
}

// One TCP attempt to host:port in this namespace, a request written. A
// destination other than the link's socket has no route inside the domain,
// so this shows it cannot be reached.
function reach(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let bytes = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ...r, ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write('GET /hello HTTP/1.0\r\n\r\n'));
    sock.on('data', (c) => {
      bytes += c.length;
      finish({ reached: true, bytes, error: null });
    });
    sock.on('timeout', () => finish({ reached: false, bytes, error: 'timeout' }));
    sock.on('error', (err) => finish({ reached: false, bytes, error: err.code ?? String(err) }));
    sock.on('close', () => finish({ reached: bytes > 0, bytes, error: bytes > 0 ? null : 'closed' }));
  });
}

function unix(path) {
  return new Promise((resolve) => {
    const sock = net.connect(path);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(4000);
    sock.on('connect', () => finish({ connected: true, error: null }));
    sock.on('timeout', () => finish({ connected: false, error: 'timeout' }));
    sock.on('error', (err) => finish({ connected: false, error: err.code ?? String(err) }));
  });
}

const open = new Map();
const listeners = [];

function openConn(id, path) {
  const addr = targetAddr();
  const started = Date.now();
  const sock = net.connect(addr);
  const rec = { id, started, bytes: 0, closed: false, error: null };
  open.set(id, rec);
  sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`));
  sock.on('data', (c) => (rec.bytes += c.length));
  sock.on('error', (err) => (rec.error = err.code ?? String(err)));
  sock.on('close', () => {
    rec.closed = true;
    rec.ms = Date.now() - started;
  });
  rec.sock = sock;
  return { opened: true };
}

async function waitClosed(id, maxS) {
  const rec = open.get(id);
  if (!rec) return { closed: null, error: 'no such connection' };
  const until = Date.now() + maxS * 1000;
  while (!rec.closed && Date.now() < until) await sleep(50);
  rec.sock?.destroy();
  return { closed: rec.closed, ms: rec.ms ?? Date.now() - rec.started, bytes: rec.bytes, error: rec.error };
}

async function unread(path, pauseS, idleS) {
  return new Promise((resolve) => {
    const sock = net.connect(targetAddr());
    let bytes = 0;
    let paused = true;
    sock.on('connect', () => {
      sock.pause();
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
      setTimeout(() => {
        paused = false;
        sock.resume();
      }, pauseS * 1000);
    });
    let idle = setTimeout(() => finish('idle'), (pauseS + idleS) * 1000);
    sock.on('data', (c) => {
      bytes += c.length;
      if (!paused) {
        clearTimeout(idle);
        idle = setTimeout(() => finish('idle'), idleS * 1000);
      }
    });
    const finish = (ended) => {
      clearTimeout(idle);
      sock.destroy();
      resolve({ ended, bytes });
    };
    sock.on('close', () => finish('closed'));
    sock.on('error', (err) => finish(err.code ?? String(err)));
    setTimeout(() => finish('max'), (pauseS + idleS + 30) * 1000).unref();
  });
}

async function many(count, path, timeoutMs) {
  return Promise.all(Array.from({ length: count }, () => reach(targetAddr().host, targetAddr().port, timeoutMs)));
}

function listen(port) {
  return new Promise((resolve) => {
    const entry = { port, accepted: 0 };
    const srv = net.createServer((c) => {
      entry.accepted += 1;
      c.destroy();
    });
    srv.on('error', (err) => {
      entry.error = err.code ?? String(err);
      resolve(entry);
    });
    srv.listen(port, '127.0.0.1', () => {
      listeners.push({ entry, srv });
      resolve(entry);
    });
  });
}

async function runStep(s) {
  switch (s.do) {
    case 'tree':
      return tree();
    case 'get':
      return get(s.path ?? '/hello');
    case 'reach':
      return reach(s.host, s.port, s.timeout_ms);
    case 'unix':
      return unix(s.path);
    case 'listen':
      return listen(s.port);
    case 'open':
      return openConn(s.id, s.path ?? '/hello');
    case 'wait_closed':
      return waitClosed(s.id, s.max_s ?? 30);
    case 'unread':
      return unread(s.path ?? '/hello', s.pause_s ?? 1, s.idle_s ?? 2);
    case 'many':
      return many(s.count ?? 2, s.path ?? '/hello', s.timeout_ms ?? 4000);
    case 'hold':
      return { held: (await holdFor(s.name)) !== null };
    case 'sleep':
      await sleep(Math.min(s.ms ?? 0, 120_000));
      return { slept: s.ms };
    default:
      return { error: `unknown step ${s.do}` };
  }
}

async function main() {
  const guard = guardReasons();
  const plan = opts.hold !== null ? await holdFor(opts.hold) : { steps: [{ do: 'get', path: '/hello' }], exit: 0 };
  if (plan === null) {
    out(`SURETY-LINK-REPORT ${JSON.stringify({ target, guard, error: 'hold_timeout' })}`);
    process.exit(98);
  }
  const steps = [];
  for (const s of plan.steps ?? []) {
    if (!SAFE.has(s.do) && guard.length > 0) {
      steps.push({ ...s, result: { refused: guard } });
      continue;
    }
    steps.push({ ...s, result: await runStep(s) });
  }
  for (const { srv } of listeners) srv.close();
  out(`SURETY-LINK-REPORT ${JSON.stringify({ target, guard, steps, listeners: listeners.map((l) => l.entry) })}`);
  process.exit(Number.isInteger(plan.exit) ? plan.exit : 0);
}

main().catch((err) => {
  out(`SURETY-LINK-REPORT ${JSON.stringify({ error: String(err) })}`);
  process.exit(97);
});
