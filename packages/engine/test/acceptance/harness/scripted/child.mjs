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
//           {"close_stdout": true}
//           {"exit": <code>}
//           {"descendant": {"holds_stdout": <bool, default true>, "on_term": "exit" | "ignore", "chatter_ms": <n, default 0>}}
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
import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    else if (step.stdout_fill !== undefined) {
      const chunk = 'x'.repeat(1 << 20);
      for (let left = step.stdout_fill.bytes; left > 0; left -= chunk.length) writeOut(left >= chunk.length ? chunk : chunk.slice(0, left));
    }
    else if (step.close_stdout !== undefined) await closeStdout();
    else if (step.descendant !== undefined) await startDescendant(step.descendant);
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
