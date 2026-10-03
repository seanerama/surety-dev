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
//           {"result": <any JSON value>}
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
//                                                           outcome logged as a `probe` entry (see runProbe)
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
import { appendFileSync, closeSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function chooseScript(workItem, index) {
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

// One probe action (M2 slice 11, SEAM.md §127; rows M116 (c), M117). Each
// logs one `probe` entry: {action, ...what it found}. Nothing here decides
// anything: the host side corroborates every claim (M2 plan §2.4).
async function runProbe(spec) {
  const entry = { action: spec.action };
  const errorOf = (err) => err?.code ?? String(err);
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
    } else if (step.result !== undefined) emit({ type: 'result', result: step.result });
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
