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
//                           descendant
//   boundary.json           read by the engine's scripted boundary, never by this program
//
// With no script at all the program holds until it is killed: nothing
// completes unless a test said so.
//
// A script: {"steps": [step, ...], "on_term": "exit" | "ignore" | {"steps": [...], "then": "exit" | "ignore"}}
// Steps:    {"usage": {"semantics": "cumulative" | "delta", "raw": {...}}}
//           {"heartbeat": true}
//           {"write": {"path": "<relative to the workspace>", "content": "<text>"}}
//           {"sleep_ms": <n>}
//           {"hold": "<name>", "heartbeat_ms": <n, default 1000; 0 = silent>}
//           {"result": <any JSON value>}
//           {"stdout": "<raw text written as is>"}
//           {"exit": <code>}
//           {"descendant": {"holds_stdout": <bool, default true>, "on_term": "exit" | "ignore"}}
// After the last step the program exits 0.
//
// A descendant is one more process the role starts and does not wait for:
// this program again, as `child.mjs descendant <on_term>`. It stays in the
// role's process group and inherits its environment, so it carries the
// role's domain marker, and it outlives the role. It follows no script and
// writes nothing to stdout, but unless holds_stdout is false it keeps the
// role's stdout open, so whoever reads that pipe sees no end of file while
// it lives. SIGTERM ends it, or is ignored, as on_term says. The role goes
// on to its next step once the descendant has installed its signal handling,
// and logs a `descendant` entry with the descendant's pid, start time and
// process group.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

// The engine may be dead (a crash test kills it); a role that outlives its
// engine keeps running, so a broken pipe is not an error here.
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});
const emit = (value) => {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    // see above
  }
};

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
function finish(code) {
  log('exit', { code });
  const leave = () => process.exit(code);
  setTimeout(leave, 500);
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
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', spec.on_term ?? 'exit'], { stdio: ['ignore', stdout, 'ignore'] });
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

async function runSteps(steps, ctx) {
  for (const step of steps ?? []) {
    if (step.usage !== undefined) emit({ type: 'usage', semantics: step.usage.semantics ?? 'cumulative', raw: step.usage.raw ?? {} });
    else if (step.heartbeat !== undefined) emit({ type: 'heartbeat' });
    else if (step.write !== undefined) {
      const target = isAbsolute(step.write.path) ? step.write.path : resolve(process.cwd(), step.write.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, step.write.content ?? '');
    } else if (step.sleep_ms !== undefined) await sleep(step.sleep_ms);
    else if (step.hold !== undefined) {
      log('holding', { hold: step.hold });
      const every = step.heartbeat_ms ?? 1000;
      let last = Date.now();
      while (!released(step.hold, ctx.keys)) {
        await sleep(25);
        if (every > 0 && Date.now() - last >= every) {
          emit({ type: 'heartbeat' });
          last = Date.now();
        }
      }
      log('released', { hold: step.hold });
    } else if (step.result !== undefined) emit({ type: 'result', result: step.result });
    else if (step.stdout !== undefined) process.stdout.write(step.stdout);
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
