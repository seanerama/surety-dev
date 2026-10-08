// The test-owned check program of M3 slices 15, 17 and 18 (SEAM.md §§182,
// 198, 201, 207). The engine's check runner executes it as a check's own process
// inside a `check` domain: a `check_commands` entry names the installed copy
// (`installCheckProgram` in fixtures.mjs writes it with a shebang naming the
// test's node), and the definition's `command[1..]` are its arguments.
//
// It is benign by construction. It signals nothing and opens no descriptor
// it did not inherit; only `detach-child` starts a process, one that sleeps. It reads its working directory, the
// files it is told to digest and the existence of one release file, writes
// to its standard output and exits. Every wait it makes is bounded. Node
// built-ins only, no relative imports.
//
// Two modes act (slice 17), and five more (slice 18), and each fails closed
// outside a check domain (E64; BS3 §4 rule 1; the guard of SEAM.md §141,
// copied here): `write` opens existing workspace files for writing, `fetch`
// connects to the proxy its environment names, `ignore-term` ignores
// SIGTERM, `detach-child` starts one detached child that only sleeps,
// `flood` writes many bytes, `print` writes the text it is given, and
// `alloc` (the exhaustion lane's only) allocates memory up to a ceiling of
// its own. None of them signals anything. Each acts only when the
// program is told the host's pid, network and mount namespaces
// (`--host-ns`) and its own are three others, pid 1 is no system init, and
// it sees at most 16 processes; any read that fails is a refusal (exit 94,
// nothing done). The test's half: it releases a held program into either
// mode only after reading its containment from the host.
//
// Arguments, options first, then one mode:
//   --say <text>        write <text> and a line ending to standard output (repeatable)
//   --report            write one line `SURETY-CHECK-REPORT <json>`: its cwd, its pid,
//                       whether `.git` exists in its cwd, every entry under its cwd
//                       (no link followed, at most 5000) and the digests asked for
//   --digest <path>     SHA-256 of that file's bytes, relative to the cwd (repeatable)
//   --hold <name>       wait until <release-dir>/<name> exists (at most 180 s) before the mode
//   --release-dir <dir> where the release files are (a test path in read_paths)
//   --host-ns <ns>      the host's namespaces, `pid:[n],net:[n],mnt:[n]` (the guard's input)
// Modes:
//   exit <n>                      exit with status n
//   expect <source> <expected>    exit 0 if the two files' bytes are equal, else 1
//   term-exit0 <max ms>           wait for SIGTERM and exit 0 on it; exit 99 after <max ms>
//   write <path>...               (guarded) open each existing workspace-relative file for
//                                 writing without creating it and write one line at its start;
//                                 then one line `SURETY-CHECK-WRITE <json>`: each attempt's
//                                 outcome (`ok`, or the error code) and each file's SHA-256
//                                 afterwards; exit 0
//   fetch <host>...               (guarded) for each host, one connection to the proxy that
//                                 HTTPS_PROXY names and one `CONNECT <host>:443`, reading the
//                                 status line (at most 15 s); then one line
//                                 `SURETY-CHECK-FETCH <json>`: the proxy named (null when there
//                                 is no HTTPS_PROXY, and then nothing is attempted) and each
//                                 host's status line or error; exit 0
//   ignore-term <max ms>          (guarded) install a SIGTERM handler that only writes one line
//                                 `SURETY-CHECK ignored SIGTERM` and does not exit; write
//                                 `SURETY-CHECK ignoring SIGTERM`; wait (at most 120 s); exit 99
//   detach-child <ms>             (guarded) start one child, `child-sleep <ms>`, detached in a
//                                 session of its own with standard input, output and error
//                                 closed; write `SURETY-CHECK-DETACHED <json>` ({"pid"}, the
//                                 child's pid as this program sees it); exit 0 at once
//   child-sleep <ms>              sleep (at most 120 s) and exit 0; started only by detach-child
//   flood <bytes>                 (guarded) write floor(bytes / 1024) lines of 1024 bytes,
//                                 alternately to standard output (`O <seq> ooo…`) and standard
//                                 error (`E <seq> eee…`), <seq> ten digits from 0; then exit 0.
//                                 At most 16 GiB; above it, refused (exit 95)
//   print <text>...               (guarded) write each text and a line ending to standard
//                                 output; exit 0
//   alloc <cap bytes>             (guarded; the exhaustion lane only, SEAM.md §212) refuse a cap
//                                 above 64 MiB, and a memory.max it can read above the cap; then
//                                 allocate 1 MiB at a time, every page touched, writing
//                                 `SURETY-CHECK-ALLOC <bytes>` every 4 MiB, up to twice the cap
//                                 (at most 128 MiB); exit 97 if it got there alive

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import net from 'node:net';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOLD_MAX_MS = 180_000;
const TERM_WAIT_MAX_MS = 120_000;
const WALK_MAX = 5000;
const FETCH_WAIT_MAX_MS = 15_000;
const MAX_VISIBLE = 16;
const SYSTEM_INITS = ['systemd', 'init', 'launchd'];
const SLEEP_MAX_MS = 120_000;
const LINE_BYTES = 1024;
const FLOOD_CEILING = 16 * 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
// E69's memory cap (SEAM.md §155): the alloc mode refuses any cap above it.
const ALLOC_CAP_MAX = 64 * MIB;

const out = (text) =>
  new Promise((resolve) => {
    process.stdout.write(`${text}\n`, () => resolve());
  });

async function leave(code) {
  await new Promise((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}

const args = process.argv.slice(2);
const opts = { say: [], digest: [], report: false, hold: null, releaseDir: null, hostNs: null };
while (args.length > 0 && args[0].startsWith('--')) {
  const flag = args.shift();
  if (flag === '--report') opts.report = true;
  else if (flag === '--say') opts.say.push(args.shift() ?? '');
  else if (flag === '--digest') opts.digest.push(args.shift() ?? '');
  else if (flag === '--hold') opts.hold = args.shift() ?? null;
  else if (flag === '--release-dir') opts.releaseDir = args.shift() ?? null;
  else if (flag === '--host-ns') opts.hostNs = args.shift() ?? null;
  else {
    await out(`SURETY-CHECK unknown option ${flag}`);
    await leave(90);
  }
}
const [mode, ...rest] = args;

function walk(root) {
  const entries = [];
  const visit = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      entries.push({ path: relative(root, dir) || '.', type: 'unreadable', error: err.code ?? String(err) });
      return;
    }
    for (const name of names) {
      if (entries.length >= WALK_MAX) return;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        entries.push({ path: relative(root, full), type: 'unreadable', error: err.code ?? String(err) });
        continue;
      }
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      entries.push({ path: relative(root, full), type });
      if (type === 'dir') visit(full);
    }
  };
  visit(root);
  return entries;
}

function digestOf(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (err) {
    return `error:${err.code ?? String(err)}`;
  }
}

// The instrument's half of the guard (SEAM.md §141): the reasons it refuses
// to act, none when it is contained.
function containmentRefusal() {
  const reasons = [];
  const host = {};
  for (const part of (opts.hostNs ?? '').split(',')) {
    const kind = part.slice(0, part.indexOf(':'));
    if (['pid', 'net', 'mnt'].includes(kind)) host[kind] = part;
  }
  for (const kind of ['pid', 'net', 'mnt']) {
    const form = new RegExp(`^${kind}:\\[\\d+\\]$`);
    let mine = null;
    try {
      mine = readlinkSync(`/proc/self/ns/${kind}`);
    } catch {
      mine = null;
    }
    if (typeof host[kind] !== 'string' || !form.test(host[kind])) reasons.push(`no host ${kind} namespace given`);
    if (mine === null || !form.test(mine)) reasons.push(`its own ${kind} namespace cannot be read`);
    else if (mine === host[kind]) reasons.push(`it is in the host's ${kind} namespace`);
  }
  let init = null;
  try {
    init = readFileSync('/proc/1/comm', 'utf8').trim();
  } catch {
    init = null;
  }
  if (init === null) reasons.push('pid 1 cannot be read');
  else if (SYSTEM_INITS.includes(init)) reasons.push(`pid 1 is a system's init (${init})`);
  let visible = null;
  try {
    visible = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
  } catch {
    visible = null;
  }
  if (visible === null) reasons.push('/proc cannot be listed');
  else if (visible > MAX_VISIBLE) reasons.push(`${visible} processes are visible`);
  return reasons;
}

async function guarded() {
  const reasons = containmentRefusal();
  if (reasons.length === 0) return;
  await out(`SURETY-CHECK refused ${JSON.stringify(reasons)}`);
  await leave(94);
}

// Write all of `buf` to `fd`, synchronously. A standard stream may be a
// non-blocking pipe: EAGAIN waits a millisecond and tries again, for at most
// 60 s in all. Any other error, or the wait, ends the attempt (false).
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
let waitedMs = 0;
function writeWhole(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      if (err.code !== 'EAGAIN' || waitedMs >= 60_000) return false;
      Atomics.wait(PAUSE, 0, 0, 1);
      waitedMs += 1;
    }
  }
  return true;
}

// A workspace-relative path, never absolute and never through `..`.
function workspacePath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..')) return null;
  return join(process.cwd(), p);
}

// One CONNECT through the proxy: its status line, or how the attempt ended.
function connectThrough(proxy, host) {
  return new Promise((resolve) => {
    let done = false;
    let got = '';
    const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) });
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ host, ...value });
    };
    const timer = setTimeout(() => finish({ status: null, error: 'timeout' }), FETCH_WAIT_MAX_MS);
    socket.once('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    socket.on('data', (chunk) => {
      got += chunk.toString('latin1');
      const end = got.indexOf('\r\n');
      if (end >= 0) finish({ status: got.slice(0, end), error: null });
    });
    socket.once('error', (err) => finish({ status: null, error: err.code ?? String(err) }));
    socket.once('close', () => finish({ status: null, error: 'closed' }));
  });
}

for (const text of opts.say) await out(text);

if (opts.report) {
  const cwd = process.cwd();
  const report = {
    cwd,
    pid: process.pid,
    git_present: existsSync(join(cwd, '.git')),
    entries: walk(cwd),
    digests: Object.fromEntries(opts.digest.map((p) => [p, digestOf(join(cwd, p))])),
  };
  await out(`SURETY-CHECK-REPORT ${JSON.stringify(report)}`);
}

if (opts.hold !== null) {
  if (opts.releaseDir === null) {
    await out('SURETY-CHECK hold without --release-dir');
    await leave(91);
  }
  const file = join(opts.releaseDir, opts.hold);
  const started = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - started > HOLD_MAX_MS) {
      await out(`SURETY-CHECK hold ${opts.hold} timed out`);
      await leave(98);
    }
    await sleep(100);
  }
  await out(`SURETY-CHECK released ${opts.hold}`);
}

if (mode === 'exit') {
  await leave(Number.isInteger(Number(rest[0])) ? Number(rest[0]) : 92);
} else if (mode === 'expect') {
  const [source, expected] = rest;
  let same = false;
  try {
    same = readFileSync(join(process.cwd(), source)).equals(readFileSync(join(process.cwd(), expected)));
  } catch (err) {
    await out(`SURETY-CHECK expect could not read: ${err.code ?? String(err)}`);
  }
  await out(`SURETY-CHECK expect ${source} ${same ? 'matches' : 'differs from'} ${expected}`);
  await leave(same ? 0 : 1);
} else if (mode === 'term-exit0') {
  const max = Math.min(Number(rest[0]) || TERM_WAIT_MAX_MS, TERM_WAIT_MAX_MS);
  process.on('SIGTERM', () => {
    process.stdout.write('SURETY-CHECK got SIGTERM, exiting 0\n', () => process.exit(0));
  });
  await out('SURETY-CHECK waiting for SIGTERM');
  await sleep(max);
  await out('SURETY-CHECK no SIGTERM arrived');
  await leave(99);
} else if (mode === 'write') {
  await guarded();
  const results = [];
  for (const p of rest) {
    const full = workspacePath(p);
    if (full === null) {
      results.push({ path: p, outcome: 'not_a_workspace_path' });
      continue;
    }
    try {
      const fd = openSync(full, 'r+');
      try {
        writeSync(fd, 'SURETY-CHECK-WROTE\n', 0);
      } finally {
        closeSync(fd);
      }
      results.push({ path: p, outcome: 'ok' });
    } catch (err) {
      results.push({ path: p, outcome: err.code ?? String(err) });
    }
  }
  const after = Object.fromEntries(rest.map((p) => [p, workspacePath(p) === null ? null : digestOf(workspacePath(p))]));
  await out(`SURETY-CHECK-WRITE ${JSON.stringify({ results, after })}`);
  await leave(0);
} else if (mode === 'fetch') {
  await guarded();
  const named = process.env.HTTPS_PROXY ?? null;
  const results = [];
  if (named !== null) {
    let proxy = null;
    try {
      proxy = new URL(named);
    } catch {
      proxy = null;
    }
    for (const host of rest) results.push(proxy === null ? { host, status: null, error: 'unparsable_proxy' } : await connectThrough(proxy, host));
  }
  await out(`SURETY-CHECK-FETCH ${JSON.stringify({ proxy: named, results })}`);
  await leave(0);
} else if (mode === 'ignore-term') {
  await guarded();
  const max = Math.min(Number(rest[0]) || TERM_WAIT_MAX_MS, TERM_WAIT_MAX_MS);
  process.on('SIGTERM', () => {
    process.stdout.write('SURETY-CHECK ignored SIGTERM\n');
  });
  await out('SURETY-CHECK ignoring SIGTERM');
  await sleep(max);
  await out('SURETY-CHECK no end came');
  await leave(99);
} else if (mode === 'detach-child') {
  await guarded();
  const ms = String(Math.min(Number(rest[0]) || 0, SLEEP_MAX_MS));
  const child = spawn(process.execPath, [process.argv[1], 'child-sleep', ms], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  await out(`SURETY-CHECK-DETACHED ${JSON.stringify({ pid: child.pid ?? null })}`);
  await leave(0);
} else if (mode === 'child-sleep') {
  await sleep(Math.min(Number(rest[0]) || 0, SLEEP_MAX_MS));
  process.exit(0);
} else if (mode === 'flood') {
  await guarded();
  const bytes = Number(rest[0]);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > FLOOD_CEILING) {
    await out(`SURETY-CHECK flood of ${rest[0]} bytes refused (at most ${FLOOD_CEILING})`);
    await leave(95);
  }
  const lines = Math.floor(bytes / LINE_BYTES);
  for (let seq = 0; seq < lines; seq++) {
    const stream = seq % 2 === 0 ? 'O' : 'E';
    const head = `${stream} ${String(seq).padStart(10, '0')} `;
    const line = `${head}${(stream === 'O' ? 'o' : 'e').repeat(LINE_BYTES - head.length - 1)}\n`;
    if (!writeWhole(stream === 'O' ? 1 : 2, Buffer.from(line))) process.exit(96);
  }
  await leave(0);
} else if (mode === 'print') {
  await guarded();
  for (const text of rest) await out(text);
  await leave(0);
} else if (mode === 'alloc') {
  await guarded();
  const cap = Number(rest[0]);
  const reasons = [];
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > ALLOC_CAP_MAX) reasons.push(`the cap ${rest[0]} is not a positive integer at or below ${ALLOC_CAP_MAX}`);
  let limit = null;
  try {
    limit = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
  } catch {
    limit = null;
  }
  // Inside a check domain memory.max is normally not visible (no cgroupfs);
  // then the test's host-side reading of it is the bound (SEAM.md §212).
  if (limit !== null && (limit === 'max' || !(Number(limit) <= cap))) reasons.push(`memory.max reads ${limit}, above the cap ${cap}`);
  if (reasons.length > 0) {
    await out(`SURETY-CHECK alloc refused ${JSON.stringify(reasons)}`);
    await leave(94);
  }
  const kept = [];
  const ceiling = Math.min(2 * cap, 2 * ALLOC_CAP_MAX);
  let allocated = 0;
  while (allocated + MIB <= ceiling) {
    kept.push(Buffer.alloc(MIB, 1));
    allocated += MIB;
    if (allocated % (4 * MIB) === 0) await out(`SURETY-CHECK-ALLOC ${allocated}`);
  }
  globalThis.__suretyKept = kept;
  await out(`SURETY-CHECK alloc reached its ceiling ${ceiling} alive`);
  await leave(97);
} else {
  await out(`SURETY-CHECK unknown mode ${mode}`);
  await leave(93);
}
