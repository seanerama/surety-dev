// The scripted role program (SEAM.md §13). The engine's `scripted` backend
// launches this file for every invocation; it stands in for a coding agent
// and makes no model call. It is the Verifier's code, so what a "role" did,
// and how many times one was launched, is recorded by the test side and not
// by the engine under test.
//
// It is copied into each test's scripted directory and must stay
// self-contained: Node built-ins only, no relative imports.
//
// Layout of the scripted directory (the directory this file is in):
//   child.mjs               this program
//   scripts/<work item>.json   an array of scripts; launch n of that work
//                              item runs element n-1
//   scripts/default.json    one script, for a launch with no script of its own
//   release/<key>.<name>    a file whose existence releases the hold <name>;
//                           <key> is the invocation id, the work item id or "all"
//   launches.jsonl          appended by this program: launch, holding, signal, exit,
//                           descendant, stdout_closed
//   boundary.json           read by the engine's scripted boundary, never by this program
//
// With no script at all the program holds until it is killed: nothing
// completes unless a test said so.
//
// A script: {"steps": [step, ...], "on_term": "exit" | "ignore" | {"steps": [...], "then": "exit" | "ignore"}}
// Steps:    {"usage": {"semantics": "cumulative" | "delta", "raw": {...}}}
//           {"heartbeat": true}
//           {"write": {"path": "<relative to the workspace, or absolute>", "content": "<text>"}}
//           {"write": {"path": "...", "fill": <n>}}        n bytes of filler instead of content
//           {"write_many": {"dir": "<path>", "count": <n>, "bytes": <m>}}   n files of m bytes each in a directory
//           {"delete": "<path>"}                            a file or a whole directory
//           {"rename": {"from": "<path>", "to": "<path>"}}
//           {"symlink": {"path": "<path>", "target": "<target, written as given>"}}
//           {"git": ["<argument>", ...]}                    git, run in the workspace
//           {"sleep_ms": <n>}
//           {"hold": "<name>", "heartbeat_ms": <n, default 1000; 0 = silent>}
//           {"result": <any JSON value>}                    M2 slice 13 (SEAM.md §143): in a sandbox (where
//                                                           /surety/out is a directory) the value is first
//                                                           written to /surety/out/result.json, then the
//                                                           `result` line goes to stdout, which is the terminal
//                                                           success event; outside one, the line only
//           {"result_file": <any JSON value>}               M2 slice 13: the file only, no line (no event)
//           {"result_event": <any JSON value>}              M2 slice 13: the line only (the event), no file
//           {"canary": {"mode": "obey" | "wrong_result" | "finish_early" | "say_denied" | "forge_reports" | "result_only"}}
//                                                           M2 slice 13 part 2 (SEAM.md §149): a qualification
//                                                           canary's role, following /surety/context/canary.json
//           {"stdout": "<raw text written as is>"}
//           {"stdout_fill": {"bytes": <n>}}                 n bytes of filler, no line ending
//           {"stdout_b64": "<base64>"}                      those bytes written as is: a write can end inside a multibyte character
//           {"close_stdout": true}
//           {"exit": <code>}
//           {"descendant": {"holds_stdout": <bool, default true>, "on_term": "exit" | "ignore", "chatter_ms": <n, default 0>}}
//           {"daemon": {"name": "<name>", "on_term": "exit" | "ignore", "ping_ms": <n, default 100>}}
//                                                           M2 slice 11 (SEAM.md §127): a detached daemon that
//                                                           setsid()s, clears its environment, double-forks and
//                                                           appends a line to pings/<name>.jsonl every ping_ms
//           {"probe": {"action": "<action>", ...}}          M2 slice 11 (SEAM.md §127): one probe action, its
//                                                           outcome logged as a `probe` entry (see runProbe).
//                                                           M2 slice 12 (SEAM.md §141) adds the actions of rows
//                                                           M119 to M128; every one that writes outside the
//                                                           role's own files, connects or executes is GUARDED
//                                                           (see containmentRefusal) and refuses outside a sandbox
// After the last step the program exits 0.
//
// The program exits, after its last step or at an {"exit": ...} step, only
// once everything it wrote to stdout has left the process. However much it
// wrote and however slowly it is read, nothing it wrote is dropped by its
// own exit. (If the reader is gone, the write fails and the program leaves.)
//
// File steps ({"write"}, {"delete"}, {"rename"}, {"symlink"}) take paths
// relative to the workspace, the program's working directory, or absolute
// ones: a role runs as the engine's user and can reach outside its
// workspace, which is what the validation tests script. {"git": [...]} runs
// the git binary in the workspace with those arguments and a small
// environment of its own, as a role with a shell could; its exit status and
// output are logged as a `git` entry and never stop the script.
//
// {"stdout": ...} writes its text and nothing else: no line ending is added,
// so a script can end the role's output with a line that has none.
// {"close_stdout": true} closes the role's standard output for good, once
// what was written before it has left the process: whoever reads the pipe
// sees the end of the stream (unless a descendant still holds it) while the
// role goes on with its next steps. From then on the role writes nothing to
// stdout: later usage, heartbeat, result and stdout steps, and the heartbeats
// of a hold, are dropped. It logs a `stdout_closed` entry.
//
// A descendant is one more process the role starts and does not wait for:
// this program again, as `child.mjs descendant <on_term>`. It stays in the
// role's process group and inherits its environment, so it carries the
// role's domain marker, and it outlives the role. It follows no script and
// writes nothing to stdout (unless chatter_ms is given: then it writes a
// line that is no protocol line, "descendant chatter", that often), but
// unless holds_stdout is false it keeps the role's stdout open, so whoever
// reads that pipe sees no end of file while it lives. SIGTERM ends it, or is
// ignored, as on_term says. The role goes
// on to its next step once the descendant has installed its signal handling,
// and logs a `descendant` entry with the descendant's pid, start time and
// process group.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const logFile = join(dir, 'launches.jsonl');

// Field n of /proc/<pid>/stat, counted as proc(5) does. The command name
// (field 2) may contain spaces, so fields are counted from the last ')'.
function statField(n, pid = 'self') {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[n - 3];
}

// A line of /proc/self/status by its key, or null.
function statusField(key) {
  try {
    const line = readFileSync('/proc/self/status', 'utf8').split('\n').find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

// In the sandbox lane the role runs in its own pid namespace (SEAM.md
// §125): `pid` is its pid there, which the host joins to a host pid through
// NSpid. A daemon with a cleared environment (SEAM.md §127) takes its
// invocation from its arguments instead.
const identity = {
  invocation: process.env.SURETY_INVOCATION ?? null,
  domain: process.env.SURETY_DOMAIN ?? null,
  pid: process.pid,
};

function log(event, fields = {}) {
  try {
    appendFileSync(logFile, `${JSON.stringify({ event, ...identity, at: new Date().toISOString(), ...fields })}\n`);
  } catch {
    // The log is evidence for the test; losing a line must not change what the role does.
  }
}

// A role outlives its engine, but not its test: when the scripted directory
// is removed, which a test does when it finishes, the program exits.
setInterval(() => {
  if (!existsSync(join(dir, 'child.mjs'))) process.exit(0);
}, 1000).unref();

// Descendant mode: `child.mjs descendant <on_term>`, started by a role's
// {"descendant": ...} step. It reads no request, follows no script and never
// writes to stdout; it only stays, holding whatever it inherited, until it
// is signalled or its scripted directory is removed.
if (process.argv[2] === 'descendant') {
  const onTerm = process.argv[3] === 'ignore' ? 'ignore' : 'exit';
  process.on('SIGTERM', () => {
    log('signal', { signal: 'SIGTERM', descendant: true });
    if (onTerm === 'exit') process.exit(143);
  });
  log('descendant_ready', { on_term: onTerm });
  const chatterMs = Number(process.argv[4] ?? 0);
  if (chatterMs > 0) {
    process.stdout.on('error', () => {});
    setInterval(() => {
      try {
        process.stdout.write('descendant chatter\n');
      } catch {
        // the reader is gone
      }
    }, chatterMs);
  }
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

// Daemon mode (M2 slice 11, SEAM.md §127; D2 A.6 P16): `child.mjs daemon-fork
// <json>` is the intermediate of a double fork: it starts `child.mjs daemon
// <json>` detached (setsid, a cleared environment, no inherited descriptor)
// and exits at once, so the daemon's parent is the init of its pid
// namespace, not the role. The daemon logs `daemon_ready` with its own pid
// and session, then appends a line to pings/<name>.jsonl every ping_ms for
// as long as it lives. SIGTERM ends it or is ignored, as on_term says. The
// invocation is carried in the options, since the environment is empty.
if (process.argv[2] === 'daemon-fork' || process.argv[2] === 'daemon') {
  const opts = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  identity.invocation = opts.invocation ?? null;
  identity.domain = opts.domain ?? null;
  if (process.argv[2] === 'daemon-fork') {
    const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', process.argv[3]], { detached: true, env: {}, stdio: 'ignore' });
    daemon.unref();
    log('daemon_forked', { name: opts.name, daemon_pid: daemon.pid ?? null });
    process.exit(daemon.pid === undefined ? 1 : 0);
  }
  const onTerm = opts.on_term === 'ignore' ? 'ignore' : 'exit';
  process.on('SIGTERM', () => {
    log('signal', { signal: 'SIGTERM', daemon: true, name: opts.name });
    if (onTerm === 'exit') process.exit(143);
  });
  mkdirSync(join(dir, 'pings'), { recursive: true });
  const pings = join(dir, 'pings', `${opts.name}.jsonl`);
  log('daemon_ready', {
    name: opts.name,
    on_term: onTerm,
    session: Number(statField(6)),
    pgrp: Number(statField(5)),
    parent: Number(statField(4)),
    env_count: Object.keys(process.env).length,
    nspid: statusField('NSpid'),
  });
  let n = 0;
  setInterval(() => {
    try {
      appendFileSync(pings, `${JSON.stringify({ event: 'ping', name: opts.name, pid: process.pid, n: ++n, at: new Date().toISOString() })}\n`);
    } catch {
      // the directory may be gone: the test is over
    }
  }, opts.ping_ms ?? 100);
  await new Promise(() => {});
}

// M2 slice 13 (SEAM.md §143; D2 §1.4): the role's result file. It exists
// only inside a sandbox, where /surety/out is a directory of the domain's
// volatile filesystem; on a host there is no /surety and uid 1000 cannot
// make one, so nothing outside a sandbox is ever written by these.
const OUT_DIR = '/surety/out';
const RESULT_FILE = '/surety/out/result.json';
function outDirPresent() {
  try {
    return lstatSync(OUT_DIR).isDirectory();
  } catch {
    return false;
  }
}

// Rewriter mode (M2 slice 13, SEAM.md §144; row M129 (a)): `child.mjs
// rewriter <json>`, started by the guarded `result_shape` action with shape
// `rewriter`. Every every_ms it writes a result whose summary is
// `marker <n>` to result.json.tmp, renames it over result.json, and only
// then logs a `rewrite` entry with n. So the file never holds a marker
// earlier than the last one logged, and at most the one after it. SIGTERM
// is ignored unless on_term is 'exit'. It inherits the role's environment,
// so it carries the role's markers.
if (process.argv[2] === 'rewriter') {
  const opts = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  if (!outDirPresent()) {
    log('rewriter_refused', { reason: 'no /surety/out: not in a sandbox' });
    process.exit(1);
  }
  process.on('SIGTERM', () => {
    log('signal', { signal: 'SIGTERM', rewriter: true });
    if (opts.on_term === 'exit') process.exit(143);
  });
  let n = 0;
  setInterval(() => {
    n += 1;
    try {
      writeFileSync(`${RESULT_FILE}.tmp`, JSON.stringify({ status: 'completed', summary: `marker ${n}` }));
      renameSync(`${RESULT_FILE}.tmp`, RESULT_FILE);
      log('rewrite', { n });
    } catch (err) {
      log('rewrite_error', { n, error: err?.code ?? String(err) });
    }
  }, Math.max(20, Number(opts.every_ms ?? 100)));
  await new Promise(() => {});
}

// Killer mode (M2 slice 13, SEAM.md §144; row M130 (e)): `child.mjs killer
// <json>`, started by the guarded `kill_parent` action. After delay_ms it
// sends SIGKILL to the role that started it, and to nothing else: only when
// its own parent is still exactly that process (the pid the role passed),
// greater than 1. It logs what it did and exits.
if (process.argv[2] === 'killer') {
  const opts = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  await sleep(Math.min(5000, Math.max(0, Number(opts.delay_ms ?? 200))));
  const target = opts.target;
  const parent = process.ppid;
  if (!Number.isInteger(target) || target <= 1 || parent !== target) {
    log('killer', { target, parent, sent: false, reason: 'the parent is not the role that started this process' });
    process.exit(1);
  }
  try {
    process.kill(target, 'SIGKILL');
    log('killer', { target, parent, sent: true });
  } catch (err) {
    log('killer', { target, parent, sent: false, reason: err?.code ?? String(err) });
  }
  process.exit(0);
}

// The engine may be dead (a crash test kills it); a role that outlives its
// engine keeps running, so a broken pipe is not an error here.
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});
// Set by a {"close_stdout": true} step: descriptor 1 is gone, and nothing is
// written to it again.
let stdoutClosed = false;
const writeOut = (text) => {
  if (stdoutClosed) return;
  try {
    process.stdout.write(text);
  } catch {
    // see above
  }
};
const emit = (value) => writeOut(`${JSON.stringify(value)}\n`);

// Close the role's stdout while the role lives. What was written before has
// left the process first; the descriptor itself is closed, because Node does
// not close descriptor 1 when the stream object is ended or destroyed.
async function closeStdout() {
  if (stdoutClosed) return;
  await new Promise((done) => {
    try {
      process.stdout.write('', () => done());
    } catch {
      done();
    }
  });
  stdoutClosed = true;
  try {
    closeSync(1);
    log('stdout_closed');
  } catch (err) {
    log('stdout_close_error', { message: err.message });
  }
}

async function readRequest() {
  const chunks = [];
  const done = new Promise((res) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', res);
    process.stdin.on('close', res);
  });
  await Promise.race([done, sleep(10_000)]);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return { request: null, request_error: 'no request arrived on stdin' };
  try {
    return { request: JSON.parse(text.split('\n')[0]) };
  } catch (err) {
    return { request: null, request_error: `request is not JSON: ${err.message}`, request_text: text.slice(0, 200) };
  }
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// How many launches this work item has had before this one.
function priorLaunches(workItem) {
  if (!existsSync(logFile)) return 0;
  let n = 0;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'launch' && entry.work_item === workItem) n++;
    } catch {
      // a torn line is not a launch
    }
  }
  return n;
}

const HOLD_FOREVER = { steps: [{ hold: 'unscripted' }] };

// A canary's launch (M2 slice 13 part 2; SEAM.md §149) follows
// scripts/canary-<kind>.json, its n-th launch of that kind element n-1.
function priorCanaryLaunches(kind) {
  if (!existsSync(logFile)) return 0;
  let n = 0;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.includes('"canary_kind"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'launch' && entry.canary_kind === kind) n++;
    } catch {
      // a torn line is not a launch
    }
  }
  return n;
}

function chooseScript(workItem, index) {
  const canary = readCanary();
  if (canary !== null && typeof canary.kind === 'string' && /^[a-z]+$/.test(canary.kind)) {
    const list = readJson(join(dir, 'scripts', `canary-${canary.kind}.json`));
    const n = priorCanaryLaunches(canary.kind);
    if (Array.isArray(list) && list[n] !== undefined) return { script: list[n], source: `canary-${canary.kind}` };
  }
  const own = workItem ? readJson(join(dir, 'scripts', `${workItem}.json`)) : undefined;
  if (Array.isArray(own) && own[index] !== undefined) return { script: own[index], source: 'work_item' };
  const fallback = readJson(join(dir, 'scripts', 'default.json'));
  if (fallback !== undefined) return { script: fallback, source: 'default' };
  return { script: HOLD_FOREVER, source: 'unscripted' };
}

// Exit once what was written to stdout has left the process. Never resolves.
// There is no time limit: a reader that is slow gets everything, and a
// reader that is gone fails the write, which ends the wait.
function finish(code) {
  log('exit', { code });
  const leave = () => process.exit(code);
  if (stdoutClosed) leave();
  try {
    process.stdout.write('', leave);
  } catch {
    leave();
  }
  return new Promise(() => {});
}

const released = (name, keys) => keys.some((key) => key && existsSync(join(dir, 'release', `${key}.${name}`)));

// Has the descendant with this pid logged that it is ready?
function loggedReady(pid) {
  if (!existsSync(logFile)) return false;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.includes('descendant_ready')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'descendant_ready' && entry.pid === pid) return true;
    } catch {
      // a torn line is not an entry
    }
  }
  return false;
}

// Start a descendant (see the head of this file) and wait until it is ready.
async function startDescendant(spec) {
  const stdout = spec.holds_stdout === false ? 'ignore' : 'inherit';
  const args = [fileURLToPath(import.meta.url), 'descendant', spec.on_term ?? 'exit', String(spec.chatter_ms ?? 0)];
  const descendant = spawn(process.execPath, args, { stdio: ['ignore', stdout, 'ignore'] });
  descendant.on('error', (err) => log('descendant_error', { message: err.message }));
  descendant.unref();
  if (descendant.pid === undefined) return void log('descendant_error', { message: 'the descendant could not be started' });
  for (let waited = 0; waited < 5000 && !loggedReady(descendant.pid); waited += 25) await sleep(25);
  log('descendant', {
    descendant_pid: descendant.pid,
    descendant_start_time: statField(22, descendant.pid),
    descendant_pgrp: Number(statField(5, descendant.pid)),
    holds_stdout: spec.holds_stdout !== false,
    on_term: spec.on_term ?? 'exit',
    ready: loggedReady(descendant.pid),
  });
}

// Has the daemon named `name` logged that it is ready? Returns its entry.
function daemonReady(name) {
  if (!existsSync(logFile)) return null;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line.includes('daemon_ready')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'daemon_ready' && entry.name === name) return entry;
    } catch {
      // a torn line is not an entry
    }
  }
  return null;
}

// Start a daemon through the double fork (see "Daemon mode") and wait until
// it is ready; log a `daemon` entry with what the daemon reported of itself.
async function startDaemon(spec) {
  const opts = Buffer.from(JSON.stringify({ name: spec.name, on_term: spec.on_term ?? 'ignore', ping_ms: spec.ping_ms ?? 100, invocation: identity.invocation, domain: identity.domain })).toString('base64');
  const fork = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon-fork', opts], { stdio: 'ignore' });
  await new Promise((done) => fork.once('exit', done));
  let ready = null;
  for (let waited = 0; waited < 5000 && !(ready = daemonReady(spec.name)); waited += 25) await sleep(25);
  log('daemon', {
    name: spec.name,
    ready: ready !== null,
    daemon_pid: ready?.pid ?? null,
    daemon_session: ready?.session ?? null,
    daemon_parent: ready?.parent ?? null,
    daemon_env_count: ready?.env_count ?? null,
  });
}

// THE GUARD OF `signal_all` (SEAM.md §127, "The guard"). That action sends
// SIGKILL to every process this one can see and then calls kill(-1,
// SIGKILL). Inside a sandbox's own pid namespace that reaches the role's
// own child and nothing else, which is what row M117 (a) shows. On a host,
// run by a role an engine launched WITHOUT a pid namespace, it kills every
// process of the user: it did exactly that once (2026-10-03, on the
// slice-10 engine, which has no sandbox; ../COVERAGE.md, "M2 slice 11",
// "The incident"). So the action fails closed: it runs only if every one of
// these holds, and any read that fails is a refusal.
//   - the step carries `host_pid_ns`, the host's pid namespace as the test
//     read it (`readlink /proc/self/ns/pid` on the host), and this process's
//     own pid namespace is a different one;
//   - pid 1, as this process sees it, is not a system's init;
//   - this process sees at most SIGNAL_ALL_MAX_VISIBLE processes.
// Returns the reasons to refuse; an empty list means it may run. It sends
// no signal and starts no process.
const SIGNAL_ALL_MAX_VISIBLE = 16;
const SYSTEM_INITS = ['systemd', 'init', 'launchd'];
function signalAllRefusal(spec) {
  const reasons = [];
  let own = null;
  try {
    own = readlinkSync('/proc/self/ns/pid');
  } catch {
    own = null;
  }
  if (typeof spec.host_pid_ns !== 'string' || !/^pid:\[\d+\]$/.test(spec.host_pid_ns)) reasons.push('the step names no host pid namespace');
  if (own === null || !/^pid:\[\d+\]$/.test(own)) reasons.push('this process cannot read its own pid namespace');
  else if (own === spec.host_pid_ns) reasons.push(`this process is in the host's pid namespace (${own})`);
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
  else if (visible > SIGNAL_ALL_MAX_VISIBLE) reasons.push(`${visible} processes are visible, more than a sandbox holds`);
  return { reasons, own, init, visible };
}

// THE GUARD OF EVERY ACTING PROBE OF SLICE 12 (SEAM.md §141; E64 item 2).
// The actions named in GUARDED write outside the role's own files, connect
// to a socket or an address, or execute a host tool. Inside a sandbox they
// reach nothing but the sandbox; run by a role an engine launched on the
// host they would reach the host's files, its network and its user manager.
// So each fails closed, as `signal_all` does: it runs only if every one of
// these holds, and any read that fails is a refusal.
//   - the step carries `host_ns`, the host's pid, network and mount
//     namespaces as the test read its own (`readlink /proc/self/ns/<kind>`),
//     and this process's own three are each a different one;
//   - pid 1, as this process sees it, is not a system's init;
//   - this process sees at most SIGNAL_ALL_MAX_VISIBLE processes.
// Returns the reasons to refuse; an empty list means it may run. It writes
// nothing, connects to nothing and starts no process.
// M2 slice 13 (SEAM.md §144) adds `result_shape` (a link, a FIFO or an
// oversize file at /surety/out/result.json, or a descendant that rewrites
// it), `kill_parent` (a descendant that SIGKILLs the role) and
// `spawn_until_refused` (at most eight `sleep` children, one at a time,
// until a spawn is refused). None of them exhausts anything: each is
// bounded by its own count, and each runs only behind this guard.
const GUARDED = new Set(['write_probe', 'git_path_probe', 'protected_ops', 'shm_roundtrip', 'unix_connect', 'tcp_connect', 'http_request', 'proxy_connect', 'proxy_flood', 'proxy_concurrent', 'exec_probe', 'result_shape', 'kill_parent', 'spawn_until_refused', 'canary_actions', 'volatile_shapes', 'fork_to_limit', 'allocate_to_limit', 'write_to_limit', 'create_to_limit', 'stdout_flood', 'canary_link_edit', 'workspace_chmod']);
function containmentRefusal(spec) {
  const reasons = [];
  const own = {};
  for (const kind of ['pid', 'net', 'mnt']) {
    const form = new RegExp(`^${kind}:\\[\\d+\\]$`);
    let mine = null;
    try {
      mine = readlinkSync(`/proc/self/ns/${kind}`);
    } catch {
      mine = null;
    }
    own[kind] = mine;
    const theirs = spec.host_ns?.[kind];
    if (typeof theirs !== 'string' || !form.test(theirs)) reasons.push(`the step names no host ${kind} namespace`);
    if (mine === null || !form.test(mine)) reasons.push(`this process cannot read its own ${kind} namespace`);
    else if (mine === theirs) reasons.push(`this process is in the host's ${kind} namespace (${mine})`);
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
  else if (visible > SIGNAL_ALL_MAX_VISIBLE) reasons.push(`${visible} processes are visible, more than a sandbox holds`);
  return { reasons, own, init, visible };
}

// THE EXHAUSTION INSTRUMENTS (M2 slice 13 part 3; SEAM.md §155; E64 item 2,
// E69). They run only on the exhaustion host's lane, and only behind three
// independent stops:
//   1. section 141's guard (containmentRefusal): the role's own pid, net and
//      mnt namespaces are not the host's, pid 1 is no system init, at most
//      16 processes are visible;
//   2. the case's caps, carried in the step, must be at or below Sean's
//      (E69 item 1: pids.max 64, memory.max 64 MiB, 1 MiB and 64 inodes of
//      volatile storage), and a limit the role can read from inside (the
//      volatile filesystem's size and inodes, by statfs) must not exceed the
//      case's; anything else is a refusal;
//   3. each loop stops by itself, whatever the kernel does, at the ceilings
//      below. The test releases a role into them only after it has read
//      from the host the role contained and the domain's limits equal to
//      the case's (harness/sandbox/limits.mjs, assertDomainCaps).
// THE SELF-BOUNDS (E69 item 1; do not raise them):
const SEAN_CAPS = Object.freeze({ pids_max: 64, memory_max: 64 * 1024 * 1024, writable_bytes: 1024 * 1024, writable_inodes: 64 });
const FORK_CEILING = 96; // at most 96 `sleep` children, which never fork
const ALLOC_CEILING = 128 * 1024 * 1024; // at most 128 MiB allocated
const WRITE_CEILING_FACTOR = 2; // at most twice the storage bound written
const INODE_CEILING = 128; // at most 128 files created
const FLOOD_CEILING = 4 * 1024 * 1024; // at most 4 MiB written to stdout
const EXHAUSTING = new Set(['fork_to_limit', 'allocate_to_limit', 'write_to_limit', 'create_to_limit', 'stdout_flood']);

function capsRefusal(spec) {
  const reasons = [];
  const caps = spec.caps;
  if (caps === null || typeof caps !== 'object') return ['the step carries no caps'];
  for (const [k, max] of Object.entries(SEAN_CAPS)) {
    if (!Number.isSafeInteger(caps[k]) || caps[k] <= 0) reasons.push(`the step's ${k} is not a positive integer (${JSON.stringify(caps[k])})`);
    else if (caps[k] > max) reasons.push(`the step's ${k} ${caps[k]} is above the cap ${max}`);
  }
  // What the role can read of its own limits: the volatile filesystem.
  try {
    const st = statfsSync('/surety/home');
    const bytes = Number(st.blocks) * Number(st.bsize);
    if (bytes > caps.writable_bytes) reasons.push(`the volatile filesystem holds ${bytes} bytes, more than the case's ${caps.writable_bytes}`);
    if (Number(st.files) > caps.writable_inodes) reasons.push(`the volatile filesystem has ${st.files} inodes, more than the case's ${caps.writable_inodes}`);
  } catch (err) {
    reasons.push(`the volatile filesystem cannot be read (${err?.code ?? String(err)})`);
  }
  return reasons;
}

const sha256Of = (data) => createHash('sha256').update(data).digest('hex');
const codeOf = (err) => err?.code ?? String(err);
const typeOf = (st) =>
  st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : st.isSocket() ? 'socket' : st.isFIFO() ? 'fifo' : st.isCharacterDevice() ? 'char' : st.isBlockDevice() ? 'block' : 'other';
const unescapeMount = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

// Entries of a directory tree, without following links, bounded: each
// {name (relative to the root), type, target (a link's)}.
function listTree(root, { recursive = false, max = 4000, skip = [] } = {}) {
  const out = [];
  const queue = [''];
  let truncated = false;
  while (queue.length > 0) {
    const rel = queue.shift();
    let names;
    try {
      names = readdirSync(join(root, rel), { withFileTypes: true });
    } catch (err) {
      if (rel === '') throw err;
      out.push({ name: rel, type: 'dir', error: codeOf(err) });
      continue;
    }
    for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= max) {
        truncated = true;
        break;
      }
      const name = rel === '' ? d.name : `${rel}/${d.name}`;
      const type = d.isFile() ? 'file' : d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isSocket() ? 'socket' : d.isFIFO() ? 'fifo' : d.isCharacterDevice() ? 'char' : d.isBlockDevice() ? 'block' : 'other';
      const item = { name, type };
      if (type === 'symlink') {
        try {
          item.target = readlinkSync(join(root, name));
        } catch (err) {
          item.error = codeOf(err);
        }
      }
      out.push(item);
      if (recursive && type === 'dir' && !skip.includes(name)) queue.push(name);
    }
  }
  return { entries: out, truncated };
}

// The proxy the role was given (D2 §1.2: HTTPS_PROXY names the in-sandbox
// forwarder), as {host, port}, or null.
function proxyOf() {
  const value = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!value) return null;
  try {
    const url = new URL(value);
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), value };
  } catch {
    return null;
  }
}

// One TCP connection attempt: {outcome: 'connected' | 'failed' | 'timeout', error, elapsed_ms, socket}.
function tcpOpen(host, port, timeoutMs) {
  return new Promise((done) => {
    const began = performance.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (outcome, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome !== 'connected') socket.destroy();
      done({ outcome, error: error ?? null, elapsed_ms: Math.round(performance.now() - began), socket: outcome === 'connected' ? socket : null });
    };
    const timer = setTimeout(() => finish('timeout', 'ETIMEDOUT'), timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('error', (err) => finish('failed', codeOf(err)));
  });
}

// One CONNECT through the role's proxy (D2 §2.4). Options: payload_b64 (bytes
// sent once the tunnel answers 200), expect_back (read as many bytes back),
// flood_bytes (write that many bytes and read nothing: a slow reader),
// linger_ms (stay and watch for the tunnel's end), keepalive_ms (a byte that
// often while lingering, each echo read), request ({method, path, headers}:
// an HTTP request sent through an open tunnel), timeout_ms (for the answer).
async function proxyConnect(spec) {
  const out = { authority: spec.authority };
  const proxy = proxyOf();
  out.proxy = proxy?.value ?? null;
  if (proxy === null) return { ...out, outcome: 'no_proxy' };
  const began = performance.now();
  const opened = await tcpOpen(proxy.host, proxy.port, spec.timeout_ms ?? 5000);
  if (opened.outcome !== 'connected') return { ...out, outcome: 'proxy_unreachable', error: opened.error };
  const socket = opened.socket;
  socket.on('error', (err) => {
    out.socket_error = codeOf(err);
  });
  let closedAt = null;
  let ended = null;
  socket.on('end', () => {
    ended ??= 'eof';
    closedAt ??= performance.now();
  });
  socket.on('close', (hadError) => {
    ended ??= hadError ? 'reset' : 'eof';
    closedAt ??= performance.now();
  });
  let buffer = Buffer.alloc(0);
  let wake = null;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  const until = async (test, ms) => {
    const deadline = performance.now() + ms;
    while (!test()) {
      if (ended !== null && !test()) return false;
      const left = deadline - performance.now();
      if (left <= 0) return false;
      await new Promise((r) => {
        wake = r;
        setTimeout(r, Math.min(left, 100));
      });
      wake = null;
    }
    return true;
  };
  socket.write(`CONNECT ${spec.authority} HTTP/1.1\r\nHost: ${spec.authority}\r\n\r\n`);
  const answered = await until(() => buffer.includes('\r\n\r\n'), spec.timeout_ms ?? 5000);
  out.elapsed_ms = Math.round(performance.now() - began);
  if (!answered) {
    out.outcome = 'no_answer';
    out.closed = ended;
    socket.destroy();
    return out;
  }
  const head = buffer.subarray(0, buffer.indexOf('\r\n\r\n')).toString('latin1');
  buffer = buffer.subarray(buffer.indexOf('\r\n\r\n') + 4);
  out.outcome = 'answered';
  out.status_line = head.split('\r\n')[0];
  out.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(out.status_line)?.[1] ?? NaN);
  const tunnelBegan = performance.now();
  out.sent = 0;
  if (out.status === 200) {
    if (spec.payload_b64 !== undefined) {
      const payload = Buffer.from(spec.payload_b64, 'base64');
      socket.write(payload);
      out.sent += payload.length;
      if (spec.expect_back) await until(() => buffer.length >= payload.length, spec.timeout_ms ?? 5000);
    }
    if (spec.request !== undefined) {
      const lines = [`${spec.request.method ?? 'GET'} ${spec.request.path} HTTP/1.1`, ...Object.entries(spec.request.headers ?? {}).map(([k, v]) => `${k}: ${v}`), '', ''];
      socket.write(lines.join('\r\n'));
      await until(() => buffer.includes('\r\n'), spec.timeout_ms ?? 5000);
      out.tunnelled_status_line = buffer.toString('latin1').split('\r\n')[0].slice(0, 200);
    }
    if (spec.flood_bytes !== undefined) {
      // A slow reader: write, and take nothing.
      socket.pause();
      const chunk = Buffer.alloc(65536, 0x5a);
      for (let left = spec.flood_bytes; left > 0 && ended === null && !socket.destroyed; left -= chunk.length) {
        const more = socket.write(chunk);
        out.sent += chunk.length;
        if (!more) await Promise.race([new Promise((r) => socket.once('drain', r)), sleep(250)]);
      }
      out.flooded = true;
      await sleep(spec.flood_wait_ms ?? 1500);
      socket.resume();
    }
    if (spec.linger_ms !== undefined) {
      const deadline = performance.now() + spec.linger_ms;
      let lastBeat = performance.now();
      while (ended === null && performance.now() < deadline) {
        if (spec.keepalive_ms !== undefined && performance.now() - lastBeat >= spec.keepalive_ms) {
          try {
            socket.write(Buffer.from([0x2e]));
            out.sent += 1;
          } catch {
            // the tunnel is gone
          }
          lastBeat = performance.now();
        }
        await sleep(50);
      }
    }
  } else if (spec.linger_ms !== undefined) await until(() => ended !== null, Math.min(spec.linger_ms, 2000));
  out.received = buffer.length;
  out.received_sha256 = sha256Of(buffer);
  out.closed = ended ?? 'open';
  out.closed_after_ms = closedAt === null ? null : Math.round(closedAt - tunnelBegan);
  socket.destroy();
  return out;
}

// One probe action (M2 slice 11, SEAM.md §127; rows M116 (c), M117; M2 slice
// 12, SEAM.md §141; rows M119 to M128). Each logs one `probe` entry:
// {action, ...what it found}. Nothing here decides anything: the host side
// corroborates every claim (M2 plan §2.4).
async function runProbe(spec) {
  const entry = { action: spec.action };
  if (spec.label !== undefined) entry.label = spec.label;
  const errorOf = (err) => err?.code ?? String(err);
  if (GUARDED.has(spec.action)) {
    // Fails closed outside a sandbox (see containmentRefusal).
    const guard = containmentRefusal(spec);
    entry.guard = guard;
    if (guard.reasons.length > 0) {
      entry.outcome = 'refused_unsandboxed';
      log('probe', entry);
      return;
    }
    if (EXHAUSTING.has(spec.action)) {
      const caps = capsRefusal(spec);
      entry.caps_guard = caps;
      if (caps.length > 0) {
        entry.outcome = 'refused_caps';
        log('probe', entry);
        return;
      }
    }
  }
  try {
    switch (spec.action) {
      case 'mountinfo':
        entry.mountinfo = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean);
        break;
      case 'cgroup_migrate': {
        // Write our own pid, as this pid namespace numbers it, into another
        // cgroup's cgroup.procs. The kernel refuses a migration out of the
        // cgroup namespace's root under nsdelegate (D2 §3.1).
        entry.to = spec.to;
        entry.before = readFileSync('/proc/self/cgroup', 'utf8').trim();
        try {
          writeFileSync(join(spec.to, 'cgroup.procs'), `${process.pid}\n`);
          entry.outcome = 'written';
        } catch (err) {
          entry.outcome = 'refused';
          entry.error = errorOf(err);
        }
        entry.after = readFileSync('/proc/self/cgroup', 'utf8').trim();
        break;
      }
      case 'signal_all_check': {
        // The guard alone: what `signal_all` would decide here. No signal.
        const guard = signalAllRefusal(spec);
        entry.outcome = guard.reasons.length === 0 ? 'would_run' : 'refused_unsandboxed';
        entry.guard = guard;
        break;
      }
      case 'signal_all': {
        // Fails closed outside a sandbox's own pid namespace (see the guard).
        const guard = signalAllRefusal(spec);
        entry.guard = guard;
        if (guard.reasons.length > 0) {
          entry.outcome = 'refused_unsandboxed';
          break;
        }
        // A child of our own as the control, then every pid /proc shows,
        // then kill(-1, SIGKILL). The results are logged per pid.
        const control = spawn('sleep', ['300'], { stdio: 'ignore' });
        await new Promise((done) => control.once('spawn', done));
        const seen = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
        entry.seen = seen;
        entry.results = {};
        for (const pid of seen) {
          if (pid === process.pid) continue;
          try {
            process.kill(pid, 'SIGKILL');
            entry.results[pid] = 'sent';
          } catch (err) {
            entry.results[pid] = errorOf(err);
          }
        }
        try {
          process.kill(-1, 'SIGKILL');
          entry.kill_all = 'sent';
        } catch (err) {
          entry.kill_all = errorOf(err);
        }
        const exit = await Promise.race([new Promise((done) => control.once('exit', (code, signal) => done({ code, signal }))), sleep(3000, null)]);
        entry.control = { pid: control.pid, exit };
        entry.after = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
        entry.outcome = 'ran';
        break;
      }
      case 'init_fd':
        try {
          entry.init_fd = readdirSync('/proc/1/fd');
          entry.outcome = 'listed';
        } catch (err) {
          entry.outcome = 'refused';
          entry.error = errorOf(err);
        }
        try {
          entry.init_cmdline = readFileSync('/proc/1/cmdline', 'latin1').split('\0').filter(Boolean);
        } catch (err) {
          entry.init_cmdline_error = errorOf(err);
        }
        break;
      case 'net_unix': {
        // Our own abstract socket, then the namespace's unix socket table.
        const name = `\0surety-probe-${process.pid}`;
        const server = net.createServer();
        await new Promise((done, fail) => server.listen(name, done).once('error', fail));
        entry.own = name.slice(1);
        entry.net_unix = readFileSync('/proc/net/unix', 'utf8').split('\n').filter(Boolean);
        await new Promise((done) => server.close(done));
        break;
      }
      case 'self_status': {
        entry.cap_eff = statusField('CapEff');
        entry.no_new_privs = statusField('NoNewPrivs');
        entry.uid = statusField('Uid');
        entry.gid = statusField('Gid');
        entry.nspid = statusField('NSpid');
        entry.fds = {};
        for (const fd of readdirSync('/proc/self/fd')) {
          try {
            entry.fds[fd] = readlinkSync(`/proc/self/fd/${fd}`);
          } catch (err) {
            entry.fds[fd] = `unreadable:${errorOf(err)}`;
          }
        }
        break;
      }
      case 'mount_attempt': {
        const target = at(spec.target ?? 'probe-mount');
        mkdirSync(target, { recursive: true });
        const done = spawnSync('mount', ['-t', 'tmpfs', 'none', target], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
        entry.status = done.status;
        entry.signal = done.signal;
        entry.error = done.error ? errorOf(done.error) : null;
        entry.stderr = (done.stderr ?? '').slice(0, 500);
        entry.mounted = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((l) => l.includes(` ${target} `));
        break;
      }
      case 'read_back': {
        const target = at(spec.path);
        entry.path = spec.path;
        try {
          entry.content = readFileSync(target, 'utf8');
          entry.outcome = 'read';
        } catch (err) {
          entry.outcome = 'failed';
          entry.error = errorOf(err);
        }
        break;
      }
      // ---- M2 slice 12: reads (unguarded: they change nothing) ----------------
      case 'open_paths': {
        // Open each path for reading, never blocking; of a regular file,
        // read at most 64 KiB and log its size and the hash of what was read.
        entry.results = (spec.paths ?? []).slice(0, 400).map((path) => {
          const r = { path };
          let fd = null;
          try {
            fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
            const st = fstatSync(fd);
            r.type = typeOf(st);
            if (st.isFile()) {
              const buf = Buffer.alloc(65536);
              const n = readSync(fd, buf, 0, buf.length, 0);
              r.size = st.size;
              r.read = n;
              r.sha256 = sha256Of(buf.subarray(0, n));
            }
            r.outcome = 'opened';
          } catch (err) {
            r.outcome = 'failed';
            r.error = errorOf(err);
          } finally {
            if (fd !== null) {
              try {
                closeSync(fd);
              } catch {
                // nothing to close
              }
            }
          }
          return r;
        });
        break;
      }
      case 'list_dirs': {
        entry.results = (spec.paths ?? []).slice(0, 100).map((path) => {
          try {
            return { path, outcome: 'listed', ...listTree(path, { recursive: spec.recursive === true, max: spec.max ?? 4000, skip: spec.skip ?? [] }) };
          } catch (err) {
            return { path, outcome: 'failed', error: errorOf(err) };
          }
        });
        break;
      }
      case 'stat_paths': {
        entry.results = (spec.paths ?? []).slice(0, 400).map((path) => {
          try {
            const st = spec.follow === false ? lstatSync(path) : statSync(path);
            return { path, outcome: 'found', type: typeOf(st), dev: String(st.dev), ino: String(st.ino), mode: st.mode & 0o7777, size: st.size, nlink: st.nlink };
          } catch (err) {
            return { path, outcome: 'failed', error: errorOf(err) };
          }
        });
        break;
      }
      case 'mount_table': {
        // The role's own mount table, and for each mount point what is
        // mounted there (device and inode), so that the host can tell that a
        // bind is the very directory the plan names.
        entry.mountinfo = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean);
        entry.points = {};
        for (const line of entry.mountinfo) {
          const point = unescapeMount(line.split(' ')[4]);
          try {
            const st = statSync(point);
            entry.points[point] = { type: typeOf(st), dev: String(st.dev), ino: String(st.ino) };
          } catch (err) {
            entry.points[point] = { error: errorOf(err) };
          }
        }
        break;
      }
      case 'context_dump': {
        // Every file under the context package (or `root`), without following
        // links, bounded: its size and hash, and its text where it is small.
        const root = spec.root ?? '/surety/context';
        entry.root = root;
        let total = 0;
        try {
          const { entries, truncated } = listTree(root, { recursive: true, max: spec.max ?? 2000 });
          entry.truncated = truncated;
          entry.files = entries.map((e) => {
            if (e.type !== 'file') return e;
            try {
              const st = lstatSync(join(root, e.name));
              const item = { ...e, size: st.size, mode: st.mode & 0o7777 };
              if (st.size <= 262144 && total + st.size <= 1024 * 1024) {
                const bytes = readFileSync(join(root, e.name));
                total += bytes.length;
                item.sha256 = sha256Of(bytes);
                item.text = bytes.toString('utf8');
              }
              return item;
            } catch (err) {
              return { ...e, error: errorOf(err) };
            }
          });
          entry.outcome = 'dumped';
        } catch (err) {
          entry.outcome = 'failed';
          entry.error = errorOf(err);
        }
        break;
      }
      case 'handover': {
        // What this process was handed (D2 §1.2): its argument array as the
        // kernel shows it, its parent, its environment by name and by the
        // hash of each value (never the values), its working directory.
        entry.cmdline = readFileSync('/proc/self/cmdline', 'latin1').split('\0').filter((a, i, all) => !(i === all.length - 1 && a === ''));
        entry.ppid = Number(statField(4));
        try {
          entry.parent_comm = readFileSync(`/proc/${entry.ppid}/comm`, 'utf8').trim();
          entry.parent_cmdline = readFileSync(`/proc/${entry.ppid}/cmdline`, 'latin1').split('\0').filter(Boolean);
        } catch (err) {
          entry.parent_error = errorOf(err);
        }
        entry.env_hashes = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, sha256Of(v)]));
        entry.cwd = process.cwd();
        try {
          entry.exe = readlinkSync('/proc/self/exe');
        } catch (err) {
          entry.exe_error = errorOf(err);
        }
        break;
      }
      // ---- M2 slice 12: acting probes (GUARDED: see containmentRefusal) -----
      case 'write_probe': {
        // Create or overwrite one file, at an absolute path or one relative
        // to the workspace. What it wrote is left where it is.
        entry.path = spec.path;
        try {
          writeFileSync(at(spec.path), spec.content ?? 'written by the role\n');
          entry.outcome = 'written';
        } catch (err) {
          entry.outcome = 'refused';
          entry.error = errorOf(err);
        }
        break;
      }
      case 'git_path_probe': {
        // P4, P5 (D2 A.6): where git resolves one of its own paths
        // (`git rev-parse --git-path <name>`), what is there, and whether
        // a file can be created or written at it.
        const done = spawnSync('git', ['rev-parse', '--git-path', spec.name], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.cwd(), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
        entry.name = spec.name;
        entry.status = done.status;
        entry.stderr = (done.stderr ?? '').slice(0, 500);
        if (done.status !== 0) {
          entry.outcome = 'unresolved';
          break;
        }
        const resolved = resolve(process.cwd(), done.stdout.trim());
        entry.resolved = resolved;
        try {
          const st = statSync(resolved);
          entry.type = typeOf(st);
          if (st.isDirectory()) entry.listing = readdirSync(resolved).sort();
        } catch (err) {
          entry.type = `absent:${errorOf(err)}`;
        }
        // A directory: a new file inside it; a file: an append to it.
        const target = spec.create !== undefined ? join(resolved, spec.create) : resolved;
        entry.target = target;
        try {
          if (spec.create !== undefined) writeFileSync(target, spec.content ?? '#!/bin/sh\necho planted by the role\n', { mode: 0o755 });
          else appendFileSync(target, spec.content ?? '\n[probe]\n\tliteral = written\n');
          entry.write = { outcome: 'written' };
        } catch (err) {
          entry.write = { outcome: 'refused', error: errorOf(err) };
        }
        entry.outcome = 'probed';
        break;
      }
      case 'protected_ops': {
        // P19 (D2 A.6): every way of changing a protected file and a
        // protected directory, each attempted and its result logged. Paths
        // are relative to the workspace and may not leave it.
        const inside = (p) => typeof p === 'string' && !isAbsolute(p) && !p.split('/').includes('..');
        if (!inside(spec.file) || !inside(spec.dir)) {
          entry.outcome = 'refused_path';
          break;
        }
        const scratch = `.probe-scratch-${process.pid}`;
        const ops = [];
        const attempt = (op, fn) => {
          try {
            fn();
            ops.push({ op, outcome: 'done' });
            return true;
          } catch (err) {
            ops.push({ op, outcome: 'refused', error: errorOf(err) });
            return false;
          }
        };
        mkdirSync(scratch, { recursive: true });
        entry.before = (() => {
          try {
            return sha256Of(readFileSync(spec.file));
          } catch (err) {
            return `unreadable:${errorOf(err)}`;
          }
        })();
        attempt('write', () => writeFileSync(spec.file, 'overwritten by the role\n'));
        attempt('truncate', () => truncateSync(spec.file, 0));
        attempt('rename_away', () => renameSync(spec.file, join(scratch, 'moved-away')));
        writeFileSync(join(scratch, 'replacement'), 'a replacement by the role\n');
        attempt('rename_over', () => renameSync(join(scratch, 'replacement'), spec.file));
        if (attempt('hard_link', () => linkSync(spec.file, join(scratch, 'hard')))) attempt('write_through_hard_link', () => writeFileSync(join(scratch, 'hard'), 'through the hard link\n'));
        symlinkSync(resolve(spec.file), join(scratch, 'alias'));
        attempt('write_through_symlink', () => writeFileSync(join(scratch, 'alias'), 'through the alias\n'));
        attempt('chmod', () => chmodSync(spec.file, 0o777));
        attempt('unlink', () => unlinkSync(spec.file));
        attempt('dir_create', () => writeFileSync(join(spec.dir, 'new-by-role.txt'), 'created by the role\n'));
        attempt('dir_mkdir', () => mkdirSync(join(spec.dir, 'new-by-role')));
        attempt('dir_chmod', () => chmodSync(spec.dir, 0o777));
        attempt('dir_rename_away', () => renameSync(spec.dir, join(scratch, 'dir-moved-away')));
        entry.ops = ops;
        entry.after = (() => {
          try {
            return sha256Of(readFileSync(spec.file));
          } catch (err) {
            return `unreadable:${errorOf(err)}`;
          }
        })();
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch (err) {
          entry.scratch_error = errorOf(err);
        }
        entry.outcome = 'ran';
        break;
      }
      case 'shm_roundtrip': {
        // The role's own /dev/shm: what it holds, a file written and read back.
        const file = join('/dev/shm', spec.name);
        try {
          entry.before = readdirSync('/dev/shm').sort();
          writeFileSync(file, spec.content ?? 'the role\'s own shm file\n');
          entry.read = readFileSync(file, 'utf8');
          entry.after = readdirSync('/dev/shm').sort();
          entry.outcome = 'round_trip';
        } catch (err) {
          entry.outcome = 'failed';
          entry.error = errorOf(err);
        }
        break;
      }
      case 'unix_connect': {
        // A unix socket: an abstract name, a path, or (own) one this process
        // listens on itself, which is the control.
        let server = null;
        let target = spec.path ?? null;
        if (spec.own === true) {
          target = `\0surety-role-own-${process.pid}`;
          server = net.createServer((c) => c.end());
          await new Promise((done, fail) => server.listen(target, done).once('error', fail));
        } else if (spec.abstract !== undefined) target = `\0${spec.abstract}`;
        entry.target = target === null ? null : target.replace(/^\0/, '@');
        const result = await new Promise((done) => {
          const socket = net.connect({ path: target });
          const timer = setTimeout(() => {
            socket.destroy();
            done({ outcome: 'timeout', error: 'ETIMEDOUT' });
          }, spec.timeout_ms ?? 1500);
          socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            done({ outcome: 'connected' });
          });
          socket.once('error', (err) => {
            clearTimeout(timer);
            done({ outcome: 'failed', error: errorOf(err) });
          });
        });
        Object.assign(entry, result);
        if (server !== null) await new Promise((done) => server.close(done));
        break;
      }
      case 'tcp_connect': {
        // A TCP connection to each target; a connection that opens is closed
        // at once and nothing is sent on it.
        entry.results = [];
        // 'proxy': the forwarder HTTPS_PROXY names (the role's control).
        const proxy = proxyOf();
        const targets = spec.targets === 'proxy' ? (proxy === null ? [] : [{ host: proxy.host, port: proxy.port }]) : (spec.targets ?? []);
        for (const t of targets.slice(0, 64)) {
          const r = await tcpOpen(t.host, t.port, spec.timeout_ms ?? 1500);
          r.socket?.destroy();
          entry.results.push({ host: t.host, port: t.port, outcome: r.outcome, error: r.error, elapsed_ms: r.elapsed_ms });
        }
        break;
      }
      case 'http_request': {
        // One HTTP request to host:port, if a connection opens at all.
        const opened = await tcpOpen(spec.host, spec.port, spec.timeout_ms ?? 1500);
        entry.host = spec.host;
        entry.port = spec.port;
        if (opened.outcome !== 'connected') {
          entry.outcome = 'no_connection';
          entry.error = opened.error;
          break;
        }
        const socket = opened.socket;
        const lines = [`${spec.method ?? 'GET'} ${spec.path} HTTP/1.1`, ...Object.entries(spec.headers ?? {}).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', ''];
        const answer = await new Promise((done) => {
          let text = '';
          const timer = setTimeout(() => done(text), spec.timeout_ms ?? 1500);
          socket.on('data', (c) => {
            text += c.toString('latin1');
            if (text.includes('\r\n')) {
              clearTimeout(timer);
              done(text);
            }
          });
          socket.on('error', () => {
            clearTimeout(timer);
            done(text);
          });
          socket.write(lines.join('\r\n'));
        });
        socket.destroy();
        entry.outcome = answer === '' ? 'no_response' : 'response';
        entry.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? NaN);
        break;
      }
      case 'proxy_connect':
        Object.assign(entry, await proxyConnect(spec));
        break;
      case 'proxy_flood': {
        // Many CONNECTs one after another, tallied by answer: the egress
        // log's bound (row M128 (f)).
        const began = performance.now();
        entry.statuses = {};
        entry.attempts = 0;
        for (let i = 0; i < (spec.count ?? 0); i++) {
          if (performance.now() - began > (spec.max_ms ?? 60_000)) break;
          const r = await proxyConnect({ authority: spec.authority.replace('%n', String(i)), timeout_ms: spec.timeout_ms ?? 3000 });
          entry.attempts++;
          const key = r.outcome === 'answered' ? String(r.status) : r.outcome;
          entry.statuses[key] = (entry.statuses[key] ?? 0) + 1;
          if (r.outcome === 'no_proxy' || r.outcome === 'proxy_unreachable') break;
        }
        entry.elapsed_ms = Math.round(performance.now() - began);
        break;
      }
      case 'proxy_concurrent': {
        // `count` tunnels opened at once and held: the concurrent limit.
        entry.results = await Promise.all(
          Array.from({ length: spec.count ?? 0 }, async (_, i) => {
            await sleep(i * (spec.stagger_ms ?? 150));
            const r = await proxyConnect({ authority: spec.authority, timeout_ms: spec.timeout_ms ?? 5000, linger_ms: spec.hold_ms ?? 3000, keepalive_ms: 500 });
            return { n: i, outcome: r.outcome, status: r.status ?? null, closed: r.closed ?? null, closed_after_ms: r.closed_after_ms ?? null, error: r.error ?? null };
          }),
        );
        break;
      }
      case 'exec_probe': {
        // One program, as an argument array (no shell), with a small
        // environment of the step's own.
        const done = spawnSync(spec.argv[0], spec.argv.slice(1), {
          encoding: 'utf8',
          timeout: spec.timeout_ms ?? 5000,
          env: spec.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        });
        entry.argv = spec.argv;
        entry.status = done.status;
        entry.signal = done.signal;
        entry.error = done.error ? errorOf(done.error) : null;
        entry.stdout = (done.stdout ?? '').slice(0, 2000);
        entry.stderr = (done.stderr ?? '').slice(0, 2000);
        entry.outcome = 'ran';
        break;
      }
      // ---- M2 slice 13: the result file's shapes and the exit classes (GUARDED) -------
      case 'result_shape': {
        // P18 (D2 A.6) and row M129: what is at /surety/out/result.json.
        // Only that one path (and its .tmp sibling, for the rewriter) is
        // ever touched, and only where /surety/out is a directory.
        entry.shape = spec.shape;
        if (!outDirPresent()) {
          entry.outcome = 'no_out_dir';
          break;
        }
        rmSync(RESULT_FILE, { force: true });
        if (spec.shape === 'host_fifo_link') {
          // A link to a FIFO the test holds on the host: only a path in a
          // short directory of the test's own under /tmp.
          if (typeof spec.target !== 'string' || !/^\/tmp\/surety-fifo-[A-Za-z0-9]{6}\/[a-z]{1,16}$/.test(spec.target)) {
            entry.outcome = 'refused_target';
            break;
          }
          symlinkSync(spec.target, RESULT_FILE);
          entry.target = spec.target;
        } else if (spec.shape === 'device_link') {
          symlinkSync('/dev/zero', RESULT_FILE);
          entry.target = '/dev/zero';
        } else if (spec.shape === 'fifo') {
          const done = spawnSync('mkfifo', ['-m', '600', RESULT_FILE], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
          entry.status = done.status;
          entry.error = done.error ? errorOf(done.error) : null;
          entry.stderr = (done.stderr ?? '').slice(0, 500);
        } else if (spec.shape === 'oversize') {
          // A well-formed result of exactly `bytes` bytes, so that its size
          // is the only thing wrong with it.
          const base = JSON.stringify({ status: 'completed', summary: '' }).length;
          const bytes = Number(spec.bytes);
          if (!Number.isInteger(bytes) || bytes <= base || bytes > 16 * 1024 * 1024 + 1) {
            entry.outcome = 'refused_size';
            break;
          }
          writeFileSync(RESULT_FILE, JSON.stringify({ status: 'completed', summary: 'x'.repeat(bytes - base) }));
        } else if (spec.shape === 'rewriter') {
          const opts = Buffer.from(JSON.stringify({ every_ms: spec.every_ms ?? 100, on_term: spec.on_term ?? 'ignore' })).toString('base64');
          const rewriter = spawn(process.execPath, [fileURLToPath(import.meta.url), 'rewriter', opts], { stdio: 'ignore' });
          rewriter.on('error', (err) => log('rewriter_error', { message: err.message }));
          rewriter.unref();
          entry.rewriter_pid = rewriter.pid ?? null;
          // Go on once it has rewritten the file at least once.
          const rewrote = () => {
            try {
              return readFileSync(logFile, 'utf8').split('\n').some((l) => l.includes('"rewrite"') && l.includes(`"invocation":${JSON.stringify(identity.invocation)}`));
            } catch {
              return false;
            }
          };
          for (let waited = 0; waited < 5000 && !rewrote(); waited += 25) await sleep(25);
          entry.ready = rewrote();
        } else {
          entry.outcome = 'unknown_shape';
          break;
        }
        try {
          const st = lstatSync(RESULT_FILE);
          entry.type = typeOf(st);
          entry.size = st.size;
        } catch (err) {
          entry.type = `absent:${errorOf(err)}`;
        }
        entry.outcome = 'shaped';
        break;
      }
      case 'kill_parent': {
        // Row M130 (e): a descendant of the role sends the role SIGKILL. The
        // descendant checks that its parent is still exactly this process.
        const opts = Buffer.from(JSON.stringify({ target: process.pid, delay_ms: spec.delay_ms ?? 300 })).toString('base64');
        const killer = spawn(process.execPath, [fileURLToPath(import.meta.url), 'killer', opts], { stdio: 'ignore' });
        killer.on('error', (err) => log('killer_error', { message: err.message }));
        entry.killer_pid = killer.pid ?? null;
        entry.outcome = killer.pid === undefined ? 'not_spawned' : 'spawned';
        log('probe', entry);
        // Wait to be killed; if that does not happen, say so and go on.
        await sleep(Math.min(30_000, spec.wait_ms ?? 20_000));
        log('kill_parent_survived', {});
        return;
      }
      case 'spawn_until_refused': {
        // Row M130 (h): `sleep` children, one at a time, at most `max` (never
        // more than eight), until a spawn is refused; then every one is
        // killed and awaited. The children never fork.
        const max = Math.min(8, Math.max(1, Number(spec.max ?? 6)));
        const seconds = String(Math.min(120, Math.max(1, Number(spec.seconds ?? 60))));
        const children = [];
        entry.attempts = 0;
        entry.refused = null;
        for (let i = 0; i < max; i++) {
          entry.attempts++;
          const child = spawn('sleep', [seconds], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
          const outcome = await new Promise((done) => {
            child.once('spawn', () => done({ ok: true }));
            child.once('error', (err) => done({ ok: false, error: errorOf(err) }));
          });
          if (!outcome.ok) {
            entry.refused = { attempt: i + 1, error: outcome.error };
            break;
          }
          children.push(child);
        }
        entry.spawned = children.length;
        await Promise.all(
          children.map(
            (child) =>
              new Promise((done) => {
                if (child.exitCode !== null || child.signalCode !== null) return done();
                child.once('exit', done);
                child.kill('SIGKILL');
              }),
          ),
        );
        entry.outcome = entry.refused === null ? 'never_refused' : 'refused';
        break;
      }
      case 'volatile_shapes': {
        // M2 slice 13 part 2 (SEAM.md §152; row M132): small files, links
        // and FIFOs on the domain's volatile filesystem only (under
        // /surety/home, /surety/out or /tmp, no ".."), at most 16 of each,
        // each file at most 64 KiB: what the provider-files inventory walks.
        if (!outDirPresent()) {
          entry.outcome = 'no_out_dir';
          break;
        }
        const ok = (p) => typeof p === 'string' && /^\/(surety\/home|surety\/out|tmp)\//.test(p) && !p.split('/').includes('..');
        entry.made = [];
        for (const f of (spec.files ?? []).slice(0, 16)) {
          if (!ok(f.path) || !(Number(f.bytes ?? 0) <= 65536)) {
            entry.made.push({ path: f.path, outcome: 'refused_path' });
            continue;
          }
          mkdirSync(dirname(f.path), { recursive: true });
          writeFileSync(f.path, f.content ?? Buffer.alloc(Number(f.bytes ?? 1), 'v'));
          entry.made.push({ path: f.path, type: 'file' });
        }
        for (const l of (spec.links ?? []).slice(0, 16)) {
          if (!ok(l.path)) {
            entry.made.push({ path: l.path, outcome: 'refused_path' });
            continue;
          }
          mkdirSync(dirname(l.path), { recursive: true });
          symlinkSync(l.target, l.path);
          entry.made.push({ path: l.path, type: 'symlink', target: l.target });
        }
        for (const f of (spec.fifos ?? []).slice(0, 16)) {
          if (!ok(f)) {
            entry.made.push({ path: f, outcome: 'refused_path' });
            continue;
          }
          mkdirSync(dirname(f), { recursive: true });
          const done = spawnSync('mkfifo', ['-m', '600', f], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
          entry.made.push({ path: f, type: 'fifo', status: done.status });
        }
        entry.outcome = 'made';
        break;
      }
      case 'fork_to_limit': {
        // M133 (a): one control fork, then `sleep` children one at a time
        // until a spawn is refused or FORK_CEILING; all killed and awaited.
        const children = [];
        entry.ceiling = FORK_CEILING;
        entry.forks = 0;
        entry.failure = null;
        const one = () => {
          const child = spawn('sleep', ['300'], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
          return new Promise((done) => {
            child.once('spawn', () => done({ ok: true, child }));
            child.once('error', (err) => done({ ok: false, error: errorOf(err) }));
          });
        };
        const control = await one();
        entry.control = control.ok ? 'spawned' : `failed:${control.error}`;
        if (control.ok) children.push(control.child);
        while (control.ok && children.length < FORK_CEILING) {
          const r = await one();
          if (!r.ok) {
            entry.failure = r.error;
            break;
          }
          children.push(r.child);
        }
        entry.forks = children.length;
        log('probe', { ...entry, step: 'at_limit' });
        if (spec.hold_ms) await sleep(Math.min(30_000, spec.hold_ms));
        await Promise.all(children.map((c) => new Promise((done) => (c.exitCode !== null || c.signalCode !== null ? done() : (c.once('exit', done), c.kill('SIGKILL'))))));
        entry.outcome = entry.failure === null ? 'ceiling_reached' : 'refused';
        break;
      }
      case 'allocate_to_limit': {
        // M133 (b), M130 (f), (g): a control allocation of 1 MiB, then 1 MiB
        // at a time, every page touched, until `hold_bytes` (then held) or
        // ALLOC_CEILING; progress logged every 4 MiB, so the log says how far
        // it got before the kernel ended it.
        const MIB = 1024 * 1024;
        const kept = [];
        const target = Math.min(ALLOC_CEILING, spec.hold_bytes ?? ALLOC_CEILING);
        entry.ceiling = ALLOC_CEILING;
        kept.push(Buffer.alloc(MIB, 1));
        entry.control = { allocated: MIB };
        log('probe', { action: spec.action, step: 'control', control: { allocated: MIB } });
        let allocated = MIB;
        while (allocated + MIB <= target) {
          kept.push(Buffer.alloc(MIB, 1));
          allocated += MIB;
          if (allocated % (4 * MIB) === 0) log('probe', { action: spec.action, step: 'progress', allocated, ceiling: ALLOC_CEILING });
        }
        entry.allocated = allocated;
        entry.outcome = spec.hold_bytes ? 'holding' : 'ceiling_reached';
        log('probe', { ...entry, step: 'done' });
        if (spec.hold_bytes) {
          globalThis.__suretyKept = kept;
          return;
        }
        return;
      }
      case 'write_to_limit': {
        // M133 (c): a control write of 4 KiB, then 64 KiB at a time to one
        // file under the volatile home until ENOSPC or twice the bound;
        // the fill is removed afterwards unless `keep`.
        const file = '/surety/home/fill.bin';
        const control = '/surety/home/control.bin';
        const ceiling = WRITE_CEILING_FACTOR * spec.caps.writable_bytes;
        entry.ceiling = ceiling;
        entry.size = spec.caps.writable_bytes;
        try {
          writeFileSync(control, Buffer.alloc(4096, 'c'));
          entry.control = 'written';
        } catch (err) {
          entry.control = `failed:${errorOf(err)}`;
        }
        const chunk = Buffer.alloc(64 * 1024, 'f');
        let written = 0;
        entry.stop = 'ceiling';
        const fd = openSync(file, 'w');
        try {
          while (written + chunk.length <= ceiling) {
            try {
              written += writeSync(fd, chunk);
            } catch (err) {
              entry.stop = errorOf(err);
              break;
            }
          }
        } finally {
          closeSync(fd);
        }
        entry.written = written;
        log('probe', { ...entry, step: 'at_limit' });
        if (spec.hold_ms) await sleep(Math.min(30_000, spec.hold_ms));
        if (!spec.keep) rmSync(file, { force: true });
        rmSync(control, { force: true });
        entry.outcome = 'ran';
        break;
      }
      case 'create_to_limit': {
        // M133 (d): one control file, then empty files until ENOSPC or
        // INODE_CEILING; removed afterwards.
        const dir = '/surety/home/inodes';
        mkdirSync(dir, { recursive: true });
        try {
          writeFileSync(join(dir, 'control'), '');
          entry.control = 'created';
        } catch (err) {
          entry.control = `failed:${errorOf(err)}`;
        }
        let made = 0;
        entry.stop = 'ceiling';
        entry.ceiling = INODE_CEILING;
        entry.inodes = spec.caps.writable_inodes;
        for (let i = 0; i < INODE_CEILING; i++) {
          try {
            writeFileSync(join(dir, `f${i}`), '');
            made++;
          } catch (err) {
            entry.stop = errorOf(err);
            break;
          }
        }
        entry.made = made;
        log('probe', { ...entry, step: 'at_limit' });
        rmSync(dir, { recursive: true, force: true });
        entry.outcome = 'ran';
        break;
      }
      case 'stdout_flood': {
        // M133 (f), (g): `lines` lines of `line_bytes` bytes on stdout (the
        // last byte of each a line ending), at most FLOOD_CEILING in all.
        const lines = Math.max(1, Number(spec.lines ?? 1));
        const each = Math.max(2, Number(spec.line_bytes ?? 1024));
        if (lines * each > FLOOD_CEILING) {
          entry.outcome = 'refused_ceiling';
          break;
        }
        const line = `${'z'.repeat(each - 1)}\n`;
        let sent = 0;
        for (let i = 0; i < lines; i++) {
          if (!process.stdout.write(line)) await new Promise((done) => process.stdout.once('drain', done));
          sent += each;
        }
        entry.sent = sent;
        entry.outcome = 'flooded';
        break;
      }
      case 'canary_link_edit': {
        // The slice-13 review's S3 (SEAM.md, "Amended after the slice-13
        // review"): the positive canary's edit made a symbolic link to a file
        // outside the workspace that holds the expected text. The target is
        // in the scripted directory (bound at its host path), so a reader on
        // the host that follows the link finds the expected text there.
        const c = readCanary();
        if (c === null || c.kind !== 'positive' || !c.edit?.path || isAbsolute(c.edit.path) || c.edit.path.split('/').includes('..')) {
          entry.outcome = 'no_positive_canary';
          break;
        }
        const target = join(dir, `canary-link-target-${process.pid}.txt`);
        writeFileSync(target, c.edit.content);
        mkdirSync(dirname(at(c.edit.path)), { recursive: true });
        rmSync(at(c.edit.path), { force: true });
        symlinkSync(target, at(c.edit.path));
        entry.path = c.edit.path;
        entry.target = target;
        entry.outcome = 'linked';
        break;
      }
      case 'workspace_chmod': {
        // The slice-13 review's S4: a directory of the workspace made
        // unreadable (workspace-relative paths only, never "..").
        if (typeof spec.path !== 'string' || isAbsolute(spec.path) || spec.path.split('/').includes('..')) {
          entry.outcome = 'refused_path';
          break;
        }
        try {
          chmodSync(at(spec.path), Number(spec.mode ?? 0));
          entry.outcome = 'changed';
        } catch (err) {
          entry.outcome = 'failed';
          entry.error = errorOf(err);
        }
        break;
      }
      case 'canary_actions': {
        // M2 slice 13 part 2 (SEAM.md §149; row M135): the containment
        // canary's actions, each the argument array the engine wrote in
        // /surety/context/canary.json, run with no shell, one at a time.
        const canary = readCanary();
        // E83 (SEAM.md §173): the probe program, named by `probe`, run once
        // with no arguments; its output is what the role reports.
        if (canary?.kind === 'containment' && typeof canary.probe === 'string') {
          if (!canary.probe.startsWith('/surety/context/')) {
            entry.outcome = 'refused_probe_path';
            break;
          }
          const done = spawnSync(canary.probe, [], { encoding: 'utf8', timeout: 60_000, env: { ...process.env } });
          probeOutput = done.stdout ?? '';
          entry.ran = [{ name: 'probe', status: done.status, signal: done.signal, error: done.error ? errorOf(done.error) : null, stdout: probeOutput.slice(0, 1000) }];
          entry.outcome = 'ran';
          break;
        }
        if (canary === null || canary.kind !== 'containment' || !Array.isArray(canary.actions)) {
          entry.outcome = 'no_containment_canary';
          break;
        }
        entry.ran = [];
        for (const a of canary.actions.slice(0, 32)) {
          if (!Array.isArray(a?.argv) || typeof a.argv[0] !== 'string' || !a.argv[0].startsWith('/')) {
            entry.ran.push({ name: a?.name ?? null, outcome: 'refused_argv' });
            continue;
          }
          const done = spawnSync(a.argv[0], a.argv.slice(1), { encoding: 'utf8', timeout: 20_000, env: { ...process.env } });
          entry.ran.push({ name: a.name ?? null, status: done.status, signal: done.signal, error: done.error ? errorOf(done.error) : null, stdout: (done.stdout ?? '').slice(0, 1000) });
        }
        entry.outcome = 'ran';
        break;
      }
      default:
        entry.outcome = 'unknown_action';
    }
  } catch (err) {
    entry.outcome = 'threw';
    entry.error = errorOf(err);
  }
  log('probe', entry);
}

// A path a file step names: relative to the workspace, or absolute.
const at = (path) => (isAbsolute(path) ? path : resolve(process.cwd(), path));

// What the containment canary's probe program printed (E83; SEAM.md §173),
// or null when it was not run.
let probeOutput = null;

// The canary's instructions (M2 slice 13 part 2; SEAM.md §149), as the
// engine wrote them into the context package, or null.
function readCanary() {
  try {
    return JSON.parse(readFileSync('/surety/context/canary.json', 'utf8'));
  } catch {
    return null;
  }
}

// One canary step: what a canary's role does with its instructions.
async function runCanary(spec) {
  const c = readCanary();
  const mode = spec.mode ?? 'obey';
  if (c === null) return void log('canary', { mode, outcome: 'no_canary' });
  log('canary', { mode, kind: c.kind, outcome: 'started' });
  const finishWith = (value) => {
    if (outDirPresent()) writeResultFile(value);
    emit({ type: 'result', result: value });
  };
  if (mode === 'say_denied' || mode === 'forge_reports') {
    for (const a of Array.isArray(c.actions) ? c.actions : [{ name: 'probe' }]) {
      if (mode === 'say_denied') writeOut(`denied: ${a?.name ?? 'action'}\n`);
      else emit({ type: 'probe', action: a?.name ?? null, outcome: 'denied', forged_by: 'the backend' });
    }
    finishWith(c.result ?? containmentReport(c));
    return;
  }
  if (mode === 'result_only') return void finishWith(c.result ?? containmentReport(c));
  if (c.kind === 'positive') {
    if (c.edit?.path && typeof c.edit.content === 'string' && !isAbsolute(c.edit.path) && !c.edit.path.split('/').includes('..')) {
      mkdirSync(dirname(at(c.edit.path)), { recursive: true });
      writeFileSync(at(c.edit.path), c.edit.content);
    }
    finishWith(mode === 'wrong_result' ? { status: 'completed', summary: 'not the result the canary asked for' } : c.result);
    return;
  }
  if (c.kind === 'cancellation') {
    if (mode === 'finish_early') return void finishWith(c.result ?? { status: 'completed', summary: 'finished early' });
    if (typeof c.barrier === 'string' && c.barrier.startsWith('/surety/out/') && outDirPresent()) {
      writeFileSync(c.barrier, 'barrier\n');
      log('canary', { mode, kind: c.kind, outcome: 'barrier_written', barrier: c.barrier });
    }
    await sleep(Math.min(600, Math.max(1, Number(c.wait_seconds ?? 600))) * 1000);
    return;
  }
  // containment: the actions are the guarded `canary_actions` probe; this
  // step only ends the role with the canary's result (before E83) or its
  // report of the probe's output (E83; SEAM.md §173).
  finishWith(c.result ?? containmentReport(c));
}

// The containment canary's report under E83 (SEAM.md §173): the probe's
// output verbatim, or the empty text when the role did not run it.
function containmentReport(c) {
  if (typeof c?.probe !== 'string') return { status: 'completed', summary: 'canary' };
  return { status: 'completed', summary: 'the sanctioned containment check: the probe program run once; its output follows verbatim', probe_output: probeOutput ?? '' };
}

// Write the role's result to /surety/out/result.json, as JSON text, and log
// what was written (its length and hash: a test compares the engine's
// record with it). Outside a sandbox nothing is written; that is logged.
function writeResultFile(value) {
  if (!outDirPresent()) return void log('result_file', { outcome: 'no_out_dir' });
  const text = JSON.stringify(value);
  try {
    writeFileSync(RESULT_FILE, text);
    log('result_file', { outcome: 'written', bytes: Buffer.byteLength(text), sha256: sha256Of(text) });
  } catch (err) {
    log('result_file', { outcome: 'failed', error: err?.code ?? String(err) });
  }
}

async function runSteps(steps, ctx) {
  for (const step of steps ?? []) {
    if (step.usage !== undefined) emit({ type: 'usage', semantics: step.usage.semantics ?? 'cumulative', raw: step.usage.raw ?? {} });
    else if (step.heartbeat !== undefined) emit({ type: 'heartbeat' });
    else if (step.write !== undefined) {
      const target = at(step.write.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, step.write.fill !== undefined ? Buffer.alloc(step.write.fill, 'x') : (step.write.content ?? ''));
    } else if (step.write_many !== undefined) {
      const target = at(step.write_many.dir);
      mkdirSync(target, { recursive: true });
      const content = Buffer.alloc(step.write_many.bytes ?? 1, 'x');
      for (let i = 0; i < step.write_many.count; i++) writeFileSync(join(target, `file-${String(i).padStart(6, '0')}.txt`), content);
    } else if (step.delete !== undefined) rmSync(at(step.delete), { recursive: true, force: true });
    else if (step.rename !== undefined) {
      mkdirSync(dirname(at(step.rename.to)), { recursive: true });
      renameSync(at(step.rename.from), at(step.rename.to));
    } else if (step.symlink !== undefined) {
      mkdirSync(dirname(at(step.symlink.path)), { recursive: true });
      symlinkSync(step.symlink.target, at(step.symlink.path));
    } else if (step.git !== undefined) {
      const done = spawnSync('git', step.git, { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.cwd(), GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
      log('git', { args: step.git, status: done.status, stdout: (done.stdout ?? '').slice(0, 2000), stderr: (done.stderr ?? '').slice(0, 2000) });
    } else if (step.sleep_ms !== undefined) await sleep(step.sleep_ms);
    else if (step.hold !== undefined) {
      log('holding', { hold: step.hold });
      const every = step.heartbeat_ms ?? 1000;
      // Timed on the monotonic clock: by the wall clock, a host whose clock
      // steps back (SEAM.md §§23, 39) made a held role skip its heartbeats for
      // as long as the step, and a second and more went by without one.
      let last = performance.now();
      while (!released(step.hold, ctx.keys)) {
        await sleep(25);
        if (every > 0 && performance.now() - last >= every) {
          emit({ type: 'heartbeat' });
          last = performance.now();
        }
      }
      log('released', { hold: step.hold });
    } else if (step.result !== undefined) {
      // In a sandbox: the file first, then the terminal success event.
      if (outDirPresent()) writeResultFile(step.result);
      emit({ type: 'result', result: step.result });
    } else if (step.result_file !== undefined) writeResultFile(step.result_file);
    else if (step.result_event !== undefined) emit({ type: 'result', result: step.result_event });
    else if (step.stdout !== undefined) writeOut(step.stdout);
    else if (step.stdout_b64 !== undefined) writeOut(Buffer.from(step.stdout_b64, 'base64'));
    else if (step.stdout_fill !== undefined) {
      const chunk = 'x'.repeat(1 << 20);
      for (let left = step.stdout_fill.bytes; left > 0; left -= chunk.length) writeOut(left >= chunk.length ? chunk : chunk.slice(0, left));
    }
    else if (step.close_stdout !== undefined) await closeStdout();
    else if (step.descendant !== undefined) await startDescendant(step.descendant);
    else if (step.daemon !== undefined) await startDaemon(step.daemon);
    else if (step.probe !== undefined) await runProbe(step.probe);
    else if (step.canary !== undefined) await runCanary(step.canary);
    else if (step.exit !== undefined) await finish(step.exit);
    else {
      log('bad_step', { step });
      await finish(96);
    }
  }
}

const { request, ...requestProblem } = await readRequest();
const workItem = request?.work_item ?? null;
const index = priorLaunches(workItem);
const { script, source } = chooseScript(workItem, index);
const ctx = { keys: [identity.invocation, workItem, 'all'] };

log('launch', {
  run: request?.run ?? null,
  project: request?.project ?? null,
  work_item: workItem,
  work_kind: request?.work_kind ?? null,
  role: request?.role ?? null,
  workspace: request?.workspace ?? null,
  request_keys: request ? Object.keys(request).sort() : null,
  ...requestProblem,
  launch_index: index,
  script_source: source,
  canary_kind: readCanary()?.kind ?? null,
  pgrp: Number(statField(5)),
  session: Number(statField(6)),
  nspid: statusField('NSpid'),
  start_time: statField(22),
  cwd: process.cwd().split(sep).join('/'),
  env_keys: Object.keys(process.env).sort(),
  // Values are not logged; their hashes let a test show that none of them is a secret it knows.
  env_value_hashes: Object.values(process.env).map((v) => createHash('sha256').update(v).digest('hex')),
  argv: process.argv.slice(2),
});

const onTerm = script.on_term ?? 'exit';
let terminating = false;
process.on('SIGTERM', () => {
  log('signal', { signal: 'SIGTERM' });
  if (onTerm === 'ignore') return;
  if (terminating) return;
  terminating = true;
  if (onTerm === 'exit') return void finish(143);
  runSteps(onTerm.steps, ctx).then(() => {
    if ((onTerm.then ?? 'exit') === 'exit') finish(0);
  });
});

await runSteps(script.steps, ctx);
if (!terminating) await finish(0);
// A SIGTERM handler is still running its own steps, or was told to stay.
setInterval(() => {}, 1 << 30);
