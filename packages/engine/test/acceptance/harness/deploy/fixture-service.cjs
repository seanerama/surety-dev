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
//                    for at most 120 s; once the child answers on the port
//                    (or after 10 s), wait 1 s and exit 0 (M311 (b))
//   exec-program     answer, then execve /usr/bin/sleep 120 (M311 (c))
//   exec-args        answer, then execve the runtime with other arguments
//   reexec-same      answer, then execve the runtime with the identical
//                    argument vector: the one /proc/self/cmdline holds, as
//                    the init started it (process.argv is not it: Node makes
//                    argv[1] absolute) (M311 (f))
//   title            set process.title (M311 (g); CD4)
//   fill-tmp         write 64 KiB blocks to /tmp until refused or 8 MiB
//   fill-inodes      create empty files in /tmp until refused or 4,096
//   print-marker     write one marker line to its standard output and error
//   title-secret     (slice 28) set process.title to the value of the variable
//                    SURETY_TEST_SECRET_VAR names (M334 (d): mutable process
//                    metadata holding a held secret)
//   flood            (slice 28) write 256 KiB of filler lines to its standard
//                    output, then one line `FLOOD-END-<MARK>` (M334 (c))
//   split-secret     (the slice-28 review, S1) write `SPLIT-<MARK> token=` and
//                    the first 20 characters of the held secret, with no line
//                    end; after SURETY_TEST_SPLIT_PAUSE_MS milliseconds
//                    (default 90,000) write the rest of the value and `\n`
//
// Slice 28 (SEAM.md §314), the held secret the test gave it, unguarded since
// it writes only to its own output and answers only its own caller:
//   SURETY_TEST_SECRET_VAR names one variable of its environment. Once
//   listening it writes `SECRET-OUT-<MARK> <value>` to its standard output
//   and error; with SURETY_TEST_SECRET_EVERY_MS it writes the same line again
//   every that many milliseconds (at least 500) for as long as it runs.
//   GET /secret      200 {"value": <that variable's value>} (a response to a
//                    check carrying the secret)

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT);
const MARK = process.env.MARK ?? '';
const SECRET_VAR = process.env.SURETY_TEST_SECRET_VAR ?? '';
const secretValue = () => (SECRET_VAR !== '' ? (process.env[SECRET_VAR] ?? '') : '');
const SECRET_EVERY_MS = Number(process.env.SURETY_TEST_SECRET_EVERY_MS ?? 0);
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
  // The parent's listener may still be closing: retry a taken port, at most 20 times.
  let tries = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 20) {
      tries += 1;
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 100);
    } else process.exit(3);
  });
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
        // Exit only once the child holds the port (it answers `child`), or after 10 s; then 1 s more.
        const until = Date.now() + 10_000;
        const exitSoon = () => setTimeout(() => process.exit(0), 1000);
        const ask = () => {
          if (Date.now() > until) return exitSoon();
          const q = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1000 }, (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => (body === 'child' ? exitSoon() : setTimeout(ask, 50)));
            r.on('error', () => setTimeout(ask, 50));
          });
          q.on('timeout', () => q.destroy());
          q.on('error', () => setTimeout(ask, 50));
        };
        ask();
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
        // The very argument vector it was started with, byte for byte, as the kernel holds it.
        const raw = fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0');
        if (raw.at(-1) === '') raw.pop();
        process.execve(process.execPath, raw, process.env);
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
    'title-secret': (res) => {
      process.title = secretValue();
      json(res, 200, { act: 'title-secret' });
    },
    flood: (res) => {
      const line = `${'f'.repeat(1023)}\n`;
      for (let i = 0; i < 256; i++) process.stdout.write(line);
      process.stdout.write(`FLOOD-END-${MARK}\n`);
      json(res, 200, { act: 'flood', bytes: 256 * 1024 });
    },
    'split-secret': (res) => {
      const v = secretValue();
      process.stdout.write(`SPLIT-${MARK} token=${v.slice(0, 20)}`);
      setTimeout(() => process.stdout.write(`${v.slice(20)}\n`), Number(process.env.SURETY_TEST_SPLIT_PAUSE_MS ?? 90_000));
      json(res, 200, { act: 'split-secret' });
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
    if (url.pathname === '/secret') return json(res, 200, { value: secretValue() });
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
    if (SECRET_VAR !== '') {
      const say = () => {
        process.stdout.write(`SECRET-OUT-${MARK} ${secretValue()}\n`);
        process.stderr.write(`SECRET-OUT-${MARK} ${secretValue()}\n`);
      };
      say();
      if (SECRET_EVERY_MS > 0) setInterval(say, Math.max(500, SECRET_EVERY_MS));
    }
  });
}
