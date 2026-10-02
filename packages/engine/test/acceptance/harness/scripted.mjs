// The test side of the scripted backend and the scripted execution boundary
// (SEAM.md §§13–14). A test owns one scripted directory per engine home: it
// holds the role program the engine launches (a copy of scripted/child.mjs),
// the scripts that program follows, the boundary's instructions, and the log
// the program writes of every launch.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { waitFor } from './engine.mjs';
import { isAlive, procStartTime } from './proc.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'scripted', 'child.mjs');

// The slice-2 structured result (SEAM.md §13): exactly these two fields.
export const VALID_RESULT = Object.freeze({ status: 'completed', summary: 'scripted role finished' });

// The protocol line that carries a valid result, without its line ending.
export const RESULT_LINE = JSON.stringify({ type: 'result', result: VALID_RESULT });

// Script steps, as scripted/child.mjs documents them.
export const step = {
  usage: (raw, semantics = 'cumulative') => ({ usage: { semantics, raw } }),
  heartbeat: () => ({ heartbeat: true }),
  write: (path, content) => ({ write: { path, content } }),
  // A file of `bytes` bytes of filler.
  writeFill: (path, bytes) => ({ write: { path, fill: bytes } }),
  // Remove a file or a whole directory.
  delete: (path) => ({ delete: path }),
  rename: (from, to) => ({ rename: { from, to } }),
  // A symbolic link at `path` whose target is written as given.
  symlink: (path, target) => ({ symlink: { path, target } }),
  // git, run by the role in its workspace with these arguments (the engine
  // performs git; a role with a shell can still run it).
  git: (...args) => ({ git: args }),
  sleep: (ms) => ({ sleep_ms: ms }),
  hold: (name = 'gate', opts = {}) => ({ hold: name, ...opts }),
  result: (value = VALID_RESULT) => ({ result: value }),
  exit: (code) => ({ exit: code }),
  // Raw text on the role's stdout, exactly as given: no line ending is added.
  stdout: (text) => ({ stdout: text }),
  // `bytes` bytes of filler on the role's stdout, with no line ending.
  stdoutFill: (bytes) => ({ stdout_fill: { bytes } }),
  // Close the role's stdout for good; the role goes on with its next steps.
  closeStdout: () => ({ close_stdout: true }),
  // One more process that carries the role's domain marker and outlives the
  // role. By default it keeps the role's stdout open and ends on SIGTERM.
  descendant: (opts = {}) => ({ descendant: opts }),
};

// Whole scripts for the common cases.
export const script = {
  // Finish at once with a valid result.
  complete: (before = []) => ({ steps: [...before, step.result()] }),
  // Run `before`, wait at a hold until released, then finish with a valid result.
  holdThenComplete: (name = 'gate', before = []) => ({ steps: [...before, step.hold(name), step.result()] }),
  // Wait at a hold and never finish by itself; `on_term` says what SIGTERM does.
  hold: (name = 'gate', { before = [], on_term = 'exit', heartbeat_ms } = {}) => ({
    steps: [...before, step.hold(name, heartbeat_ms === undefined ? {} : { heartbeat_ms })],
    on_term,
  }),
  // Exit without a result: an adapter infrastructure error.
  crash: (code = 3, before = []) => ({ steps: [...before, step.exit(code)] }),
  // Send something that is not a valid result.
  invalid: (value, before = []) => ({ steps: [...before, step.result(value)] }),
  // Finish with a valid result whose line has no line ending, and exit 0: the
  // last thing the role writes is an unterminated line (E27 item 1).
  completeUnterminated: (before = []) => ({ steps: [...before, step.stdout(RESULT_LINE)] }),
};

// What SIGTERM does to a held role: send a late "success" and then go, or stay.
export const lateSuccess = (then = 'exit') => ({ steps: [step.result()], then });

export const BOUNDARY = Object.freeze({ auto: 'auto', running: 'running', terminated: 'terminated', unknown: 'unknown' });

export class Scripted {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'release'), { recursive: true });
    copyFileSync(CHILD, join(dir, 'child.mjs'));
    this.instructions = { default: BOUNDARY.auto, domains: {} };
  }

  get flag() {
    return ['--harness-scripted', this.dir];
  }

  get logFile() {
    return join(this.dir, 'launches.jsonl');
  }

  #writeJson(file, value) {
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, file);
  }

  // Launch n of `workItem` follows scripts[n-1].
  script(workItem, scripts) {
    this.#writeJson(join(this.dir, 'scripts', `${workItem}.json`), Array.isArray(scripts) ? scripts : [scripts]);
  }

  // Every launch that has no script of its own follows this one.
  defaultScript(one) {
    this.#writeJson(join(this.dir, 'scripts', 'default.json'), one);
  }

  // Release the hold `name` for an invocation id, a work item id, or 'all'.
  release(key = 'all', name = 'gate') {
    writeFileSync(join(this.dir, 'release', `${key}.${name}`), '');
  }

  // The boundary's instructions (SEAM.md §14), written atomically.
  boundary({ default: fallback, domains } = {}) {
    if (fallback !== undefined) this.instructions.default = fallback;
    if (domains !== undefined) this.instructions.domains = { ...this.instructions.domains, ...domains };
    for (const value of [this.instructions.default, ...Object.values(this.instructions.domains)]) {
      if (!Object.values(BOUNDARY).includes(value)) throw new Error(`unknown boundary instruction ${value}`);
    }
    this.#writeJson(join(this.dir, 'boundary.json'), this.instructions);
  }

  // Everything the role program logged, in order. A last line that has no
  // line ending yet is an entry a process is still writing: it is left for
  // the next read.
  log() {
    if (!existsSync(this.logFile)) return [];
    const text = readFileSync(this.logFile, 'utf8');
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  }

  // Launch entries, optionally for one work item, run or invocation.
  launches(filter = {}) {
    return this.log().filter((e) => e.event === 'launch' && Object.entries(filter).every(([k, v]) => e[k] === v));
  }

  // What one launched process logged after its launch entry.
  eventsOf(pid, event) {
    return this.log().filter((e) => e.pid === pid && (event === undefined || e.event === event));
  }

  // The descendants the roles started (scripted/child.mjs), each as
  // {pid, start_time, pgrp, parent, domain, invocation, holds_stdout, on_term,
  // ready}: `pid` and `start_time` are the descendant's own, so isLive()
  // takes an entry as it takes a launch; `parent` is the role's pid.
  descendants(filter = {}) {
    return this.log()
      .filter((e) => e.event === 'descendant')
      .map((e) => ({
        pid: e.descendant_pid,
        start_time: e.descendant_start_time,
        pgrp: e.descendant_pgrp,
        parent: e.pid,
        domain: e.domain,
        invocation: e.invocation,
        holds_stdout: e.holds_stdout,
        on_term: e.on_term,
        ready: e.ready,
      }))
      .filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
  }

  async waitForDescendant(filter = {}, { timeoutMs } = {}) {
    return waitFor(() => this.descendants(filter)[0], { timeoutMs, what: `a descendant matching ${JSON.stringify(filter)}` });
  }

  async waitForLaunch(filter = {}, { count = 1, timeoutMs } = {}) {
    return waitFor(
      () => {
        const found = this.launches(filter);
        return found.length >= count ? found : undefined;
      },
      { timeoutMs, what: `${count} launch(es) matching ${JSON.stringify(filter)}` },
    );
  }

  // The launch matching `filter` (the latest) has reached the hold `name`.
  async waitForHolding(filter = {}, name = 'gate', { timeoutMs } = {}) {
    return waitFor(
      () => {
        const launch = this.launches(filter).at(-1);
        if (!launch) return undefined;
        return this.eventsOf(launch.pid, 'holding').some((e) => e.hold === name) ? launch : undefined;
      },
      { timeoutMs, what: `a launch matching ${JSON.stringify(filter)} to reach hold "${name}"` },
    );
  }

  // Is the process of this launch entry still the same live process?
  isLive(launch) {
    return processIsLive(launch.pid, launch.start_time);
  }

  // Kill every scripted child of this directory that is still alive: the ones
  // in the launch log, the descendants they logged, and any that was started
  // so recently that it has not logged yet, found by its command line. Tests
  // call this when they finish, so no role or descendant outlives its test.
  // (A child, role or descendant, also exits by itself once this directory
  // is removed.)
  killStrays() {
    const logged = [...this.launches(), ...this.descendants()];
    const pids = new Set(logged.filter((entry) => this.isLive(entry)).map((entry) => entry.pid));
    const program = join(this.dir, 'child.mjs');
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').includes(program)) pids.add(Number(name));
      } catch {
        // gone, or not ours to read
      }
    }
    const killed = [];
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch {
        // already gone
      }
    }
    return killed;
  }
}

// A pid names the same process only while its start time is unchanged. A
// process that has exited and not yet been reaped (a zombie) is not live.
export function processIsLive(pid, startTime) {
  if (!isAlive(pid)) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return false;
    return procStartTime(pid) === String(startTime);
  } catch {
    return false;
  }
}
