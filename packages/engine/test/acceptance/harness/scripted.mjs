// The test side of the scripted backend and the scripted execution boundary
// (SEAM.md §§13–14). A test owns one scripted directory per engine home: it
// holds the role program the engine launches (a copy of scripted/child.mjs),
// the scripts that program follows, the boundary's instructions, and the log
// the program writes of every launch.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { waitFor } from './engine.mjs';
import { isAlive, procStartTime, signalPid } from './proc.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'scripted', 'child.mjs');

// The slice-2 structured result (SEAM.md §13): exactly these two fields.
export const VALID_RESULT = Object.freeze({ status: 'completed', summary: 'scripted role finished' });

// The protocol line that carries a valid result, without its line ending.
export const RESULT_LINE = JSON.stringify({ type: 'result', result: VALID_RESULT });

// The protocol lines a `usage` and a `result` step write, without their line
// ending, exactly as scripted/child.mjs writes them: a test that knows a
// role's script knows the role's standard output byte for byte.
export const usageLine = (raw, semantics = 'cumulative') => JSON.stringify({ type: 'usage', semantics, raw });
export const resultLine = (value = VALID_RESULT) => JSON.stringify({ type: 'result', result: value });

// Script steps, as scripted/child.mjs documents them.
export const step = {
  usage: (raw, semantics = 'cumulative') => ({ usage: { semantics, raw } }),
  heartbeat: () => ({ heartbeat: true }),
  write: (path, content) => ({ write: { path, content } }),
  // A file of `bytes` bytes of filler.
  writeFill: (path, bytes) => ({ write: { path, fill: bytes } }),
  // `count` files of `bytes` bytes each in the directory `dir`.
  writeMany: (dir, count, bytes = 1) => ({ write_many: { dir, count, bytes } }),
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
  // The role's result (SEAM.md §143). In the kernel lane, the `result` line
  // on stdout, as in M1. In the sandbox lane, the value is written to
  // /surety/out/result.json and then the line is sent: the line is the
  // terminal success event, the file is the result.
  result: (value = VALID_RESULT) => ({ result: value }),
  // M2 slice 13 (SEAM.md §143): the result file without the event, and the
  // event without the file.
  resultFile: (value = VALID_RESULT) => ({ result_file: value }),
  resultEvent: (value = VALID_RESULT) => ({ result_event: value }),
  exit: (code) => ({ exit: code }),
  // Raw text on the role's stdout, exactly as given: no line ending is added.
  stdout: (text) => ({ stdout: text }),
  // Raw bytes on the role's stdout, exactly as given: a write may end inside
  // a multibyte character.
  stdoutBytes: (bytes) => ({ stdout_b64: Buffer.from(bytes).toString('base64') }),
  // `bytes` bytes of filler on the role's stdout, with no line ending.
  stdoutFill: (bytes) => ({ stdout_fill: { bytes } }),
  // Close the role's stdout for good; the role goes on with its next steps.
  closeStdout: () => ({ close_stdout: true }),
  // One more process that carries the role's domain marker and outlives the
  // role. By default it keeps the role's stdout open and ends on SIGTERM.
  descendant: (opts = {}) => ({ descendant: opts }),
  // M2 slice 11 (SEAM.md §127; D2 A.6 P16): a detached daemon that
  // setsid()s, clears its environment, double-forks and appends to
  // pings/<name>.jsonl in the scripted directory every ping_ms (default
  // 100); it ignores SIGTERM unless on_term is 'exit'.
  daemon: (name, { on_term = 'ignore', ping_ms = 100 } = {}) => ({ daemon: { name, on_term, ping_ms } }),
  // M2 slice 11 (SEAM.md §127): one probe action, logged as a `probe` entry.
  // `signal_all` is refused here: it is scripted only through signalAll().
  probe: (action, args = {}) => {
    if (action === 'signal_all') throw new Error('script signal_all through step.signalAll(hostPidNamespace()): it kills every process the role can see (SEAM.md §127, "The guard")');
    if (GUARDED_ACTIONS.includes(action)) throw new Error(`script ${action} through acting(hostNamespaces()): it writes, connects or executes, and runs only inside a sandbox (SEAM.md §141)`);
    return { probe: { action, ...args } };
  },
  // P13's action (row M117 (a)): SIGKILL to every pid the role sees, then
  // kill(-1, SIGKILL). It carries the host's pid namespace so that the role
  // program refuses to run it anywhere but in another one (SEAM.md §127,
  // "The guard"); a test releases the role into it only after it has seen,
  // from the host, that the role is in a pid namespace of its own.
  signalAll: (hostPidNs) => {
    if (typeof hostPidNs !== 'string' || !/^pid:\[\d+\]$/.test(hostPidNs)) throw new Error(`signalAll needs the host's pid namespace, as hostPidNamespace() reads it (got ${JSON.stringify(hostPidNs)})`);
    return { probe: { action: 'signal_all', host_pid_ns: hostPidNs } };
  },
  // The guard of signalAll alone: what the role would decide, with no signal sent.
  signalAllCheck: (hostPidNs) => ({ probe: { action: 'signal_all_check', host_pid_ns: hostPidNs } }),
};

// M2 slice 12 (SEAM.md §141): the probe actions that write outside the
// role's own files, connect or execute. The role program runs one only when
// its step carries the host's pid, network and mount namespaces and its own
// are three others (scripted/child.mjs, containmentRefusal); `step.probe`
// refuses to script one, and `acting(hostNamespaces())` scripts them. A test
// releases a role into one only after it has read, from the host, that the
// role is contained (harness/sandbox/view.mjs, assertContained).
// M2 slice 13 (SEAM.md §144) adds `result_shape`, `kill_parent` and
// `spawn_until_refused`, each bounded and behind the same guard.
export const GUARDED_ACTIONS = Object.freeze(['write_probe', 'git_path_probe', 'protected_ops', 'shm_roundtrip', 'unix_connect', 'tcp_connect', 'http_request', 'proxy_connect', 'proxy_flood', 'proxy_concurrent', 'exec_probe', 'result_shape', 'kill_parent', 'spawn_until_refused']);
const NS_KINDS = ['pid', 'net', 'mnt'];
const nsForm = (kind, value) => typeof value === 'string' && new RegExp(`^${kind}:\\[\\d+\\]$`).test(value);

// The host's pid, network and mount namespaces, as the test process sees its own.
export const hostNamespaces = () => Object.fromEntries(NS_KINDS.map((kind) => [kind, readlinkSync(`/proc/self/ns/${kind}`)]));
// Those of a host process; a kind that cannot be read is null (which a test
// must treat as "not shown to be contained").
export function namespacesOf(pid) {
  return Object.fromEntries(
    NS_KINDS.map((kind) => {
      try {
        return [kind, readlinkSync(`/proc/${pid}/ns/${kind}`)];
      } catch {
        return [kind, null];
      }
    }),
  );
}

// The acting probes, each carrying the host's namespaces (the role
// program's half of the guard). `label` tells two probes of one action apart.
export function acting(hostNs) {
  for (const kind of NS_KINDS) if (!nsForm(kind, hostNs?.[kind])) throw new Error(`acting() needs the host's ${kind} namespace, as hostNamespaces() reads it (got ${JSON.stringify(hostNs?.[kind])})`);
  const one = (action, args = {}) => ({ probe: { action, host_ns: { ...hostNs }, ...args } });
  return {
    // Create or overwrite a file at `path` (absolute, or relative to the workspace).
    write: (path, args = {}) => one('write_probe', { path, ...args }),
    // P4, P5: where git resolves `name` (config, hooks), what is there, and
    // a write at it (`create`: a new file of that name inside it).
    gitPath: (name, args = {}) => one('git_path_probe', { name, ...args }),
    // P19: every way of changing the protected file and directory given (workspace-relative).
    protectedOps: (file, dir, args = {}) => one('protected_ops', { file, dir, ...args }),
    // The role's own /dev/shm: a file written and read back.
    shm: (name, args = {}) => one('shm_roundtrip', { name, ...args }),
    // A unix socket: {abstract} | {path} | {own: true}.
    unixConnect: (target, args = {}) => one('unix_connect', { ...target, ...args }),
    // TCP connections to [{host, port}] (or 'proxy': the forwarder HTTPS_PROXY names), nothing sent.
    tcpConnect: (targets, args = {}) => one('tcp_connect', { targets, ...args }),
    // One HTTP request to host:port, if a connection opens.
    httpRequest: (host, port, request, args = {}) => one('http_request', { host, port, ...request, ...args }),
    // One CONNECT through the role's proxy (scripted/child.mjs, proxyConnect).
    proxyConnect: (authority, args = {}) => one('proxy_connect', { authority, ...args }),
    // `count` CONNECTs one after another, tallied by answer.
    proxyFlood: (authority, count, args = {}) => one('proxy_flood', { authority, count, ...args }),
    // `count` tunnels opened at once and held for hold_ms.
    proxyConcurrent: (authority, count, args = {}) => one('proxy_concurrent', { authority, count, ...args }),
    // One program as an argument array, no shell.
    exec: (argv, args = {}) => one('exec_probe', { argv, ...args }),
    // M2 slice 13 (SEAM.md §144). What is at /surety/out/result.json:
    // 'host_fifo_link' ({target}: a FIFO in a short directory of the
    // test's own under /tmp), 'device_link' (to /dev/zero), 'fifo',
    // 'oversize' ({bytes}: a well-formed result of exactly that size), or
    // 'rewriter' ({every_ms, on_term}: a descendant that rewrites the file
    // by write-then-rename with `marker <n>` and logs each n after the rename).
    resultShape: (shape, args = {}) => one('result_shape', { shape, ...args }),
    // A descendant that sends the role SIGKILL after delay_ms (row M130 (e)).
    killParent: (args = {}) => one('kill_parent', args),
    // At most `max` (≤ 8) `sleep` children, one at a time, until a spawn is
    // refused; all killed and awaited afterwards (row M130 (h)).
    spawnUntilRefused: (args = {}) => one('spawn_until_refused', args),
  };
}

// The host's pid namespace, as the test process sees its own.
export const hostPidNamespace = () => readlinkSync('/proc/self/ns/pid');
// The pid namespace of a host process, or null when it cannot be read
// (which a test must treat as "not shown to be sandboxed").
export function pidNamespaceOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

// What the role program logged of its result file (SEAM.md §143): the last
// `result_file` entry of an invocation, {outcome, bytes, sha256}, or undefined.
export const resultFileOf = (scripted, invocation) => scripted.eventsOfInvocation(invocation, 'result_file').at(-1);

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

  // What was logged on behalf of one invocation (the role, its daemons and
  // probes), optionally of one event. In the sandbox lane pids restart per
  // domain (SEAM.md §125), so the invocation is the key, not the pid.
  eventsOfInvocation(invocation, event) {
    return this.log().filter((e) => e.invocation === invocation && (event === undefined || e.event === event));
  }

  // The `probe` entries of one invocation, by action.
  probes(invocation, action) {
    return this.eventsOfInvocation(invocation, 'probe').filter((e) => action === undefined || e.action === action);
  }

  // The daemons a role started (SEAM.md §127), each as the role logged it:
  // {name, ready, daemon_pid (in the sandbox's pid namespace), daemon_session, daemon_parent, daemon_env_count}.
  daemons(invocation) {
    return this.eventsOfInvocation(invocation, 'daemon');
  }

  // The ping lines a daemon wrote so far (SEAM.md §127).
  pings(name) {
    const file = join(this.dir, 'pings', `${name}.jsonl`);
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8');
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
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
        // The invocation is matched as well as the pid: in the sandbox lane
        // pids restart in every domain (SEAM.md §125), and an earlier role's
        // entry under the same pid is not this launch's.
        return this.eventsOf(launch.pid, 'holding').some((e) => e.hold === name && (launch.invocation === null || e.invocation === launch.invocation)) ? launch : undefined;
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
    // Pids read from a log a role wrote: only what may be signalled at all
    // (proc.mjs, `signallable`); already gone is not an error.
    for (const pid of pids) if (signalPid(pid, 'SIGKILL')) killed.push(pid);
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
