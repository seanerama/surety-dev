// The fixture service of the M4 slice-24 rows (SEAM.md §258): a
// dependency-free Node HTTP server the tests commit into a project's
// revision as `server.js`, so that the engine projects, seals and deploys
// it. It runs only as the application of a `service` domain the engine
// started in a transient user unit of the test's own disposable home.
// CommonJS, Node built-ins only, no relative imports.
//
// It listens on 127.0.0.1:$PORT. Its routes:
//   GET /hello       200 {"ok": true, "mark", "pid", "argv", "cwd", "port"}
//   GET /version     200 {"revision": "forged-…"}: a version string the
//                    application makes up (M311 (e)); it changes nothing
//   GET /probe       200 the outcomes of its start-up write probes
//   GET /act/<mode>  a guarded act (below); 403 {"refused": [reasons]}
//                    when the guard refuses; 404 for an unknown mode
//
// The start-up probes write only inside its own domain, and only when the
// guard passes: they try to write and rename under /surety/app and /surety
// (each must fail), and write a marker in /tmp, /surety/home and
// /surety/state (each must succeed); /tmp's marker is written only if
// absent, with a value of this start's own, so a later instance shows
// whether an earlier one's /tmp survived (M310 (b)).
//
// The acts (E64's two halves, SEAM.md §§141, 258). Each acts only when the
// service establishes from inside that it is contained: its pid, network
// and mount namespaces are not the host's (the test passes the host's in
// SURETY_TEST_HOST_NS, `pid:[n],net:[n],mnt:[n]`), pid 1 is no system init,
// and it sees at most 16 processes; any read that fails is a refusal. The
// test's half: it calls an act (through its post-deploy check program and
// the engine's service link) only after reading from the host that the
// unit carries its own home's prefix and that this process is in the
// unit's cgroup. None of the acts signals any process.
//   exit             answer, then exit 0
//   detach           answer, close the listener, start one child of its
//                    own, detached in a session of its own with every
//                    standard stream closed, which listens on the same port
//                    for at most 120 s; then exit 0 (M311 (b))
//   exec-program     answer, then execve /usr/bin/sleep 120 (M311 (c))
//   exec-args        answer, then execve the runtime with other arguments
//   reexec-same      answer, then execve the runtime with identical
//                    arguments (M311 (f))
//   title            set process.title (M311 (g); CD4)
//   fill-tmp         write 64 KiB blocks to /tmp until refused or 8 MiB
//   fill-inodes      create empty files in /tmp until refused or 4,096
//   print-marker     write one marker line to its standard output and error

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT);
const MARK = process.env.MARK ?? '';
const MAX_VISIBLE = 16;
const SYSTEM_INITS = ['systemd', 'init', 'upstart', 'launchd'];

function containmentRefusal() {
  const reasons = [];
  const host = {};
  for (const part of (process.env.SURETY_TEST_HOST_NS ?? '').split(',')) {
    const kind = part.slice(0, part.indexOf(':'));
    if (['pid', 'net', 'mnt'].includes(kind)) host[kind] = part;
  }
  for (const kind of ['pid', 'net', 'mnt']) {
    const form = new RegExp(`^${kind}:\\[\\d+\\]$`);
    let mine = null;
    try {
      mine = fs.readlinkSync(`/proc/self/ns/${kind}`);
    } catch {
      mine = null;
    }
    if (typeof host[kind] !== 'string' || !form.test(host[kind])) reasons.push(`no host ${kind} namespace given`);
    if (mine === null || !form.test(mine)) reasons.push(`its own ${kind} namespace cannot be read`);
    else if (mine === host[kind]) reasons.push(`it is in the host's ${kind} namespace`);
  }
  let init = null;
  try {
    init = fs.readFileSync('/proc/1/comm', 'utf8').trim();
  } catch {
    init = null;
  }
  if (init === null) reasons.push('pid 1 cannot be read');
  else if (SYSTEM_INITS.includes(init)) reasons.push(`pid 1 is a system's init (${init})`);
  let visible = null;
  try {
    visible = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
  } catch {
    visible = null;
  }
  if (visible === null) reasons.push('/proc cannot be listed');
  else if (visible > MAX_VISIBLE) reasons.push(`${visible} processes are visible`);
  return reasons;
}

const attempt = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err.code ?? String(err);
  }
};

// ---- the child of `detach` ------------------------------------------------------------------

if (process.argv.includes('--detached-child')) {
  const server = http.createServer((q, s) => s.end('child'));
  server.on('error', () => process.exit(3));
  server.listen(PORT, '127.0.0.1');
  setTimeout(() => process.exit(0), 120_000).unref();
  // Keep the event loop alive while listening; the timer above bounds it.
  setInterval(() => {}, 60_000);
} else {
  main();
}

function main() {
  const guard = containmentRefusal();
  const probes = { guard };
  if (guard.length === 0) {
    probes.write_app = attempt(() => fs.writeFileSync('/surety/app/.probe-write', 'x'));
    probes.write_surety = attempt(() => fs.writeFileSync('/surety/.probe-write', 'x'));
    probes.rename_app = attempt(() => fs.renameSync('/surety/app', '/surety/app-moved'));
    const marker = '/tmp/fixture-marker';
    let tmpValue = null;
    if (fs.existsSync(marker)) tmpValue = fs.readFileSync(marker, 'utf8');
    else {
      tmpValue = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
      probes.write_tmp = attempt(() => fs.writeFileSync(marker, tmpValue));
    }
    probes.tmp_marker = tmpValue;
    probes.write_home = attempt(() => fs.writeFileSync('/surety/home/fixture-marker', 'x'));
    probes.write_state = attempt(() => fs.writeFileSync('/surety/state/fixture-marker', 'x'));
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  let server = null;
  const later = (fn) => setTimeout(fn, 150);

  const acts = {
    exit: (res) => {
      json(res, 200, { act: 'exit' });
      later(() => process.exit(0));
    },
    detach: (res) => {
      json(res, 200, { act: 'detach' });
      later(() => {
        server.close();
        const child = spawn(process.execPath, ['server.js', '--detached-child'], { detached: true, stdio: 'ignore', env: process.env, cwd: process.cwd() });
        child.unref();
        setTimeout(() => process.exit(0), 1000);
      });
    },
    'exec-program': (res) => {
      json(res, 200, { act: 'exec-program' });
      later(() => process.execve('/usr/bin/sleep', ['sleep', '120'], process.env));
    },
    'exec-args': (res) => {
      json(res, 200, { act: 'exec-args' });
      later(() => {
        server.close();
        process.execve(process.execPath, [process.execPath, 'server.js', '--other-arguments'], process.env);
      });
    },
    'reexec-same': (res) => {
      json(res, 200, { act: 'reexec-same', argv: process.argv });
      later(() => {
        server.close();
        // The very argument vector it was started with: argv0 as given, then the rest.
        process.execve(process.execPath, [process.argv0, ...process.argv.slice(1)], process.env);
      });
    },
    title: (res) => {
      process.title = 'surety-fixture-renamed';
      json(res, 200, { act: 'title', title: process.title });
    },
    'fill-tmp': (res) => {
      const block = Buffer.alloc(65536, 0x61);
      let bytes = 0;
      let error = null;
      let fd = null;
      try {
        fd = fs.openSync('/tmp/fill', 'w');
        while (bytes < 8 * 1024 * 1024) {
          fs.writeSync(fd, block);
          bytes += block.length;
        }
      } catch (err) {
        error = err.code ?? String(err);
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      json(res, 200, { act: 'fill-tmp', bytes, error });
    },
    'fill-inodes': (res) => {
      let count = 0;
      let error = null;
      try {
        fs.mkdirSync('/tmp/inodes', { recursive: true });
        while (count < 4096) {
          fs.writeFileSync(`/tmp/inodes/f${count}`, '');
          count += 1;
        }
      } catch (err) {
        error = err.code ?? String(err);
      }
      json(res, 200, { act: 'fill-inodes', count, error });
    },
    'print-marker': (res) => {
      process.stdout.write(`APP-OUTPUT-${MARK}-act\n`);
      process.stderr.write(`APP-OUTPUT-${MARK}-act\n`);
      json(res, 200, { act: 'print-marker' });
    },
  };

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
    if (url.pathname === '/hello') return json(res, 200, { ok: true, mark: MARK, pid: process.pid, argv: process.argv, cwd: process.cwd(), port: PORT });
    if (url.pathname === '/version') return json(res, 200, { revision: `forged-${'0'.repeat(40)}` });
    if (url.pathname === '/probe') return json(res, 200, probes);
    const act = /^\/act\/([a-z-]+)$/.exec(url.pathname)?.[1];
    if (act !== undefined) {
      if (!Object.hasOwn(acts, act)) return json(res, 404, { error: `no act ${act}` });
      const reasons = containmentRefusal();
      if (reasons.length > 0) return json(res, 403, { refused: reasons });
      return acts[act](res);
    }
    return json(res, 404, { error: 'no such route' });
  });
  server.on('error', (err) => {
    process.stderr.write(`fixture service: ${err.code ?? err}\n`);
    process.exit(2);
  });
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`APP-OUTPUT-${MARK}-stdout\n`);
    process.stderr.write(`APP-OUTPUT-${MARK}-stderr\n`);
  });
}
