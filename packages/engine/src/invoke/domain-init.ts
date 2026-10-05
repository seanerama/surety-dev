// The domain init (D2 §§1.1, 2.2, 2.3, 3.2, 3.5): engine code that runs as
// process 1 of the sandbox's pid namespace, in two stages, one program.
//
// `setup`: root of the sandbox's outer user namespace (the engine's uid mapped
// to 0). It asks the engine for the mount plan, builds the role's root from
// it (a small tmpfs, the plan's read-only binds in one `mount --all`, the
// volatile filesystem, a private /proc, /dev and /dev/shm), brings up
// loopback, pivots into the new root and drops the old one. Then it execs the
// init stage through a nested user namespace in which the engine's uid is
// uid 1000 (not root), under `no_new_privs`, into an execute-only copy of the
// engine's node: so the init runs without capabilities and is not dumpable,
// and role code, the same kernel uid, can neither read its descriptors,
// environment or memory through /proc nor attach to it (D2 §2.3, P13).
//
// `init`: asks the engine for the backend's argument array, environment,
// working directory and standard input; reports `ready` and starts the backend
// only on the engine's word; relays its standard output to the engine; reports
// its exit; answers a fresh challenge (D2 §3.5) with the nonce and the
// backend's state as the init observes it; on the engine's `term`, sends TERM
// to every process of the sandbox and exits once none is left. It handles no
// signal: as process 1 of its pid namespace it cannot be signalled by role
// code, and node's SIGUSR1 inspector is disabled. If the engine goes away the
// init keeps the backend running: the boundary, not the init, ends it.
//
// The channel to the engine is the init's standard input and output, which
// the launcher had; role code gets only the pipes the init makes for it.
//
// This file imports nothing of the engine's: it is bound read-only into the
// sandbox on its own.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { constants } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { createInterface } from 'node:readline';

type Msg = Record<string, unknown>;

// Descriptors inherited without close-on-exec, closed (D2 §§2.2, 2.3; A.6
// P14): whatever this process was given beyond its standard streams never
// reaches the next exec. A copy of invoke/descriptors.ts (this file imports
// nothing of the engine's).
function closeInherited(): void {
  let names: string[];
  try {
    names = readdirSync('/proc/self/fd');
  } catch {
    return;
  }
  for (const n of names) {
    const fd = Number(n);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      const m = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
      if (m && (parseInt(m[1]!, 8) & 0o2000000) === 0) closeSync(fd);
    } catch {
      // closed meanwhile
    }
  }
}


let channelOpen = true;
const queue: Msg[] = [];
let waiter: ((m: Msg | null) => void) | null = null;
const handlers: ((m: Msg) => void)[] = [];

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let msg: Msg;
  try {
    msg = JSON.parse(line) as Msg;
  } catch {
    return;
  }
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(msg);
    return;
  }
  if (handlers.length > 0) for (const h of handlers) h(msg);
  else queue.push(msg);
});
lines.on('close', () => {
  channelOpen = false;
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(null);
  }
  onChannelLost();
});

// The engine is gone. The backend and whatever it started go on: the
// boundary, not the init, ends them. Once nothing is left, there is nobody to
// report to, and the init goes too.
let onChannelLost: () => void = () => {};
process.stdout.on('error', () => {
  channelOpen = false;
});

function send(msg: Msg): void {
  if (!channelOpen) return;
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    channelOpen = false;
  }
}

function next(): Promise<Msg | null> {
  const queued = queue.shift();
  if (queued) return Promise.resolve(queued);
  if (!channelOpen) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

// ---- setup -------------------------------------------------------------------------------------

interface Entry {
  path: string; // relative to the new root, or to the volatile filesystem for `vol` entries
  kind: 'dir' | 'file' | 'symlink' | 'copy' | 'chardev';
  target?: string;
  content?: string;
  // `copy`: a host file the engine wrote into the domain's area, copied in
  // (the git view's index).
  source?: string;
  mode?: number;
}

interface Plan {
  stage: string;
  vol: string;
  rootBytes: number;
  volBytes: number;
  volInodes: number;
  volDirs: string[];
  skeleton: Entry[];
  // fstab lines, the targets absolute host paths under `stage`.
  fstab: string[];
  // Entries made after the first table, inside mounted filesystems, and the
  // second table's mounts on them.
  late: Entry[];
  lateFstab: string[];
  tools: { mount: string; umount: string; pivot_root: string; ip: string; unshare: string; setpriv: string; mknod?: string };
  uid: number;
  gid: number;
  initNode: string; // in the new root
  initScript: string; // in the new root
  // The start-up trial (D2 §6 H11): mount an overlay whose upper layer is on
  // the volatile filesystem, write through it, and report.
  overlayTrial?: boolean;
  // Entries made on the volatile filesystem before the first table (the git
  // view's directory and index), relative to it.
  volEntries?: Entry[];
  // Tell the engine once the volatile filesystem and the workspace's overlay
  // are mounted, and wait for its word: the engine takes hold of both from
  // outside, so that what the role leaves there outlives the sandbox until
  // the engine has screened and materialized it (D2 §§2.3, 2.5).
  holdVolatile?: boolean;
  // The workspace's mount point under `stage`, for the hold.
  workspaceMount?: string;
}

function overlayTrial(plan: Plan): { ok: boolean; detail: string } {
  const base = join(plan.vol, '.overlay-trial');
  const [lower, upper, work, merged] = ['lower', 'upper', 'work', 'merged'].map((d) => join(base, d)) as [string, string, string, string];
  try {
    for (const d of [lower, upper, work, merged]) mkdirSync(d, { recursive: true });
    writeFileSync(join(lower, 'kept'), 'lower');
    run(plan.tools.mount, ['-t', 'overlay', 'surety-overlay', '-o', `lowerdir=${lower},upperdir=${upper},workdir=${work}`, merged]);
    writeFileSync(join(merged, 'kept'), 'changed');
    writeFileSync(join(merged, 'new'), 'new');
    const lowerKept = readFileSync(join(lower, 'kept'), 'utf8') === 'lower';
    const upperHas = readFileSync(join(upper, 'kept'), 'utf8') === 'changed';
    run(plan.tools.umount, [merged]);
    return { ok: lowerKept && upperHas, detail: lowerKept && upperHas ? 'an overlay with its upper layer on the volatile tmpfs took writes; its lower layer stayed unchanged' : 'the overlay did not keep its layers apart' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    let where = '';
    try {
      const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
        .split('\n')
        .filter((l) => l.split(' ')[4] === dirname(cmd) || l.split(' ')[4] === '/');
      where = ` (${mounts.join(' | ')}; cwd ${process.cwd()})`;
    } catch {
      // nothing more to say
    }
    throw new Error(`${[cmd, ...args].join(' ')}: ${(r.stderr || r.error?.message || `status ${r.status}`).trim()}${where}`);
  }
}

let mknod: string | null = null;

function make(root: string, e: Entry): void {
  const at = join(root, e.path);
  mkdirSync(dirname(at), { recursive: true });
  if (e.kind === 'chardev') {
    // A 0:0 character device, the only one an unprivileged namespace may
    // make: a mount point that lists as a device.
    if (mknod === null) throw new Error('mknod is not among the tools');
    run(mknod, [at, 'c', '0', '0']);
    return;
  }
  if (e.kind === 'dir') {
    mkdirSync(at, { recursive: true, mode: e.mode ?? 0o755 });
    if (e.mode !== undefined) chmodSync(at, e.mode);
  } else if (e.kind === 'symlink') symlinkSync(e.target!, at);
  else if (e.kind === 'copy') {
    copyFileSync(e.source!, at);
    chmodSync(at, e.mode ?? 0o644);
  } else {
    writeFileSync(at, e.content ?? '');
    if (e.mode !== undefined) chmodSync(at, e.mode);
  }
}

async function setup(): Promise<void> {
  send({ t: 'hello', stage: 'setup' });
  const msg = await next();
  if (!msg || msg.t !== 'plan') process.exit(0);
  const plan = msg.plan as Plan;
  try {
    const { tools } = plan;
    mknod = tools.mknod ?? null;
    run(tools.mount, ['-t', 'tmpfs', '-o', `size=${plan.rootBytes},mode=0755,nosuid`, 'surety-root', plan.stage]);
    run(tools.mount, ['-t', 'tmpfs', '-o', `size=${plan.volBytes},nr_inodes=${plan.volInodes},mode=0755,nosuid,nodev`, 'surety-volatile', plan.vol]);
    for (const d of plan.volDirs) mkdirSync(join(plan.vol, d), { recursive: true, mode: 0o755 });
    for (const e of plan.volEntries ?? []) make(plan.vol, e);
    for (const e of plan.skeleton) make(plan.stage, e);
    const fstab = join(plan.vol, '.fstab');
    writeFileSync(fstab, `${plan.fstab.join('\n')}\n`);
    run(tools.mount, ['--all', '--fstab', fstab]);
    unlinkSync(fstab);
    if (plan.holdVolatile) {
      // The engine opens the volatile filesystem and the workspace's overlay
      // from outside (through /proc/<this process>/root) while both are
      // still reachable by path, and answers.
      send({ t: 'volatile' });
      const held = await next();
      if (!held || held.t !== 'volatile_held') throw new Error('the engine did not take hold of the volatile filesystem');
    }
    for (const e of plan.late) make(plan.stage, e);
    if (plan.lateFstab.length > 0) {
      writeFileSync(fstab, `${plan.lateFstab.join('\n')}\n`);
      run(tools.mount, ['--all', '--fstab', fstab]);
      unlinkSync(fstab);
    }
    if (plan.overlayTrial) send({ t: 'overlay', ...overlayTrial(plan) });
    run(tools.ip, ['link', 'set', 'lo', 'up']);
    process.chdir(plan.stage);
    mkdirSync('.oldroot');
    run(tools.pivot_root, ['.', '.oldroot']);
    process.chdir('/');
    run(tools.umount, ['-l', '/.oldroot']);
    rmdirSync('/.oldroot');
    run(tools.mount, ['-o', 'remount,ro,bind', '/']);
  } catch (err) {
    send({ t: 'setup_failed', detail: (err as Error).message });
    setTimeout(() => process.exit(70), 50);
    return;
  }
  send({ t: 'setup_done' });
  // The init stage: a nested user namespace in which the engine's uid is not
  // root; `setpriv` sets no_new_privs and, being exec'd as a non-root uid,
  // runs without capabilities; the init is then exec'd from an execute-only
  // file, so it is not dumpable (see the head of this file).
  closeInherited();
  const p = process as unknown as { execve(file: string, args: string[], env: Record<string, string>): never };
  p.execve(
    plan.tools.unshare,
    [
      plan.tools.unshare,
      '--user',
      `--map-user=${plan.uid}`,
      `--map-group=${plan.gid}`,
      '--',
      plan.tools.setpriv,
      '--no-new-privs',
      '--',
      plan.initNode,
      plan.initScript,
      'init',
    ],
    { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_OPTIONS: '--disable-sigusr1 --no-warnings' },
  );
}

// ---- init --------------------------------------------------------------------------------------

interface BackendSpec {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string | null;
  // The egress forwarder (D2 §2.4): a listener on the sandbox's own loopback
  // that carries each connection, unchanged, to the engine's proxy through
  // the domain's unix socket bound into the sandbox.
  forwarder?: { port: number; socket: string } | null;
  // A qualification canary (D2 §7.2): the barrier file whose appearance the
  // init reports while the backend runs; for the containment canary, the
  // abstract socket on which the probe program asks for its actions, and the
  // exact argument array of each action as canary.json gives it.
  canary?: { barrier?: string | null; witness?: string | null; containment?: { targets: { host_pid_ns: string; token: string; port: number; unlisted: string }; actions: string[] } | null } | null;
}

// The containment canary's witnessing (D2 §7.2; the slice-13 review's S1;
// E83). Nothing a process inside the sandbox says about an action's outcome
// is taken, and nothing the agent reads names an action's target. The agent
// runs the engine's probe program once, as `/surety/context/probe` with no
// argument; the program asks the init, on the witness socket,
// for the containment check, giving only its own pid. The init checks, from
// /proc, that the asker is a live descendant of the backend running exactly
// that command, and then performs every action itself, one at a time, each
// in a child of its own started from the init's execute-only copy of node
// (not dumpable: the backend can neither trace it nor take its descriptors),
// with an environment the init constructs and the action's targets, which
// only the engine gave it, on the child's standard input. The outcome the
// engine records is what that child observed. The check runs once per
// domain; the asker is told each action's outcome and nothing of its target.
let containmentAsked = false;

function cmdlineOf(pid: number): string[] | null {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0');
    if (parts.at(-1) === '') parts.pop();
    return parts;
  } catch {
    return null;
  }
}

function descendantOfBackend(pid: number): boolean {
  if (backendPid === null || !Number.isInteger(pid) || pid <= 1) return false;
  let at = pid;
  for (let i = 0; i < 64; i++) {
    let ppid: number;
    try {
      const line = readFileSync(`/proc/${at}/status`, 'utf8').split('\n').find((l) => l.startsWith('PPid:'));
      ppid = Number(line?.slice(5).trim());
    } catch {
      return false;
    }
    if (ppid === backendPid) return true;
    if (!Number.isInteger(ppid) || ppid <= 1) return false;
    at = ppid;
  }
  return false;
}

const PROBE_PATH = '/surety/context/probe';

// Is this the probe program run as the containment check (SEAM.md §173)?
// Its interpreter (argv[0]) is whatever ran it; the program is the probe,
// by its path, resolved from the process's own working directory where the
// path is relative; it has no argument.
function isContainmentCheck(argv: string[] | null, cwd: string | null): boolean {
  if (argv === null || argv.length !== 2) return false;
  const program = argv[1]!;
  if (program === PROBE_PATH) return true;
  if (program.startsWith('/') || cwd === null) return false;
  return posix.resolve(cwd, program) === PROBE_PATH;
}

function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// One action, performed by a child of the init (the probe program's
// `--canary-run <name>`), its targets on its standard input.
function performAction(name: string, targets: Record<string, unknown>): Promise<{ outcome: string; detail: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(process.execPath, [PROBE_PATH, '--canary-run', name], {
        cwd: '/surety/workspace',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/surety/home', HTTPS_PROXY: backendEnv.HTTPS_PROXY ?? '' },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      resolve({ outcome: 'not_run', detail: (err as Error).message });
      return;
    }
    child.stdin!.on('error', () => {});
    child.stdin!.end(`${JSON.stringify(targets)}\n`);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // gone
      }
    }, 20_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (out.length < 65536) out += d.toString('utf8');
    });
    child.once('close', () => {
      clearTimeout(timer);
      for (const line of out.split('\n').reverse()) {
        try {
          const m = JSON.parse(line) as Msg;
          if (m.type === 'canary_action') return void resolve({ outcome: String(m.outcome ?? ''), detail: String(m.detail ?? '').slice(0, 500) });
        } catch {
          // not a report line
        }
      }
      resolve({ outcome: 'not_run', detail: 'the action reported nothing' });
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ outcome: 'not_run', detail: 'the action could not be started' });
    });
  });
}

let backendEnv: Record<string, string> = {};

function startWitness(name: string, check: { targets: Record<string, unknown>; actions: string[] }): void {
  const server = net.createServer((sock) => {
    let buf = '';
    let taken = false;
    sock.on('data', (d: Buffer) => {
      if (taken) return;
      buf += d.toString('utf8');
      if (buf.length > 4096) return void sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      taken = true;
      let m: Msg;
      try {
        m = JSON.parse(buf.slice(0, nl)) as Msg;
      } catch {
        return void sock.end('refused\n');
      }
      const pid = Number(m.pid);
      if (m.type !== 'containment_request' || !Number.isInteger(pid)) return void sock.end('refused\n');
      if (!isContainmentCheck(cmdlineOf(pid), cwdOf(pid)) || !descendantOfBackend(pid)) return void sock.end('refused\n');
      if (containmentAsked) return void sock.end(`${JSON.stringify({ refused: 'the containment check has already run in this domain' })}\n`);
      containmentAsked = true;
      void (async () => {
        const outcomes: { action: string; outcome: string }[] = [];
        for (const action of check.actions) {
          const r = await performAction(action, check.targets);
          send({ t: 'witness', action, outcome: r.outcome, pid, detail: r.detail });
          outcomes.push({ action, outcome: r.outcome });
        }
        sock.end(`${JSON.stringify({ actions: outcomes })}\n`);
      })();
    });
    sock.on('error', () => {});
  });
  server.on('error', () => {});
  server.listen(`\0${name}`);
}

let termAt: number | null = null;

// The forwarder: bytes pass both ways unchanged; it reads nothing of them.
// It holds no secret and no engine setting: it is part of the init.
function startForwarder(f: { port: number; socket: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(f.socket);
      const drop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', drop);
      upstream.on('error', drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once('error', reject);
    server.listen(f.port, '127.0.0.1', () => resolve());
  });
}

let exit: { code: number | null; signal: number | null } | null = null;
let backendPid: number | null = null;
let terminating = false;
// The engine has acknowledged the exit report (or is gone). The init sends
// the report once, after the backend's output has ended (or two seconds
// after its exit, if a descendant holds the output open), and then exits:
// process 1 gone, the kernel ends what is left in the pid namespace. An
// engine paused meanwhile reads the queued report when it resumes (D2 §3.5;
// SEAM.md §130). The acknowledgement is kept for the paths that leave
// before the backend's exit (the engine's term, the engine gone).
let acked = false;

const signalNumber = (name: string | null): number | null => (name === null ? null : ((constants.signals as Record<string, number>)[name] ?? null));

// Every live process of the sandbox but this one (zombies are gone).
function others(): number[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n) || n === '1') continue;
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') continue;
      out.push(Number(n));
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

function leaveWhenAlone(): void {
  const timer = setInterval(() => {
    if (others().length === 0) {
      clearInterval(timer);
      // Let the last line reach the engine.
      setTimeout(() => process.exit(0), 20);
    }
  }, 100);
}

let exitAt: number | null = null;

function reportExit(): void {
  if (exit === null || acked) return;
  // The time from the engine's TERM to the backend's exit, as the init saw
  // them (the cancellation canary's term_to_exit_ms; D2 §3.6).
  const termToExit = termAt !== null && exitAt !== null && exitAt >= termAt ? Math.round(exitAt - termAt) : null;
  send({ t: 'exit', code: exit.code, signal: exit.signal, term_to_exit_ms: termToExit });
}

// A sandbox whose backend has exited, whose report the engine has, and in
// which nothing else lives, ends (D2 §§3.2, 4.4): descendants keep it until
// the engine's term.
function maybeLeave(): void {
  if (exit !== null && acked && others().length === 0) leaveWhenAlone();
}

function onMessage(m: Msg): void {
  if (m.t === 'exit_ack') {
    acked = true;
    maybeLeave();
    // Descendants that outlive the backend keep the sandbox until the
    // engine's term; check again as they go.
    if (exit !== null && others().length > 0) {
      const watch = setInterval(() => {
        if (others().length === 0) {
          clearInterval(watch);
          maybeLeave();
        }
      }, 250);
    }
  } else if (m.t === 'term') {
    if (terminating) return;
    terminating = true;
    termAt = performance.now();
    // Every process of the pid namespace but the init (kill(2), pid -1):
    // only as process 1 of a pid namespace the launcher created, never
    // anywhere else, where -1 would mean every process of the uid.
    if (process.pid === 1) {
      try {
        process.kill(-1, 'SIGTERM');
      } catch {
        // nothing left to signal
      }
    }
    leaveWhenAlone();
  } else if (m.t === 'challenge') {
    send({
      t: 'challenge_response',
      nonce: m.nonce,
      invocation: m.invocation,
      generation: m.generation,
      backend: exit === null ? { state: 'running', pid: backendPid } : { state: 'exited', code: exit.code, signal: exit.signal },
    });
  }
}

async function init(): Promise<void> {
  onChannelLost = () => {
    acked = true;
    if (exit !== null) {
      maybeLeave();
      const watch = setInterval(() => {
        if (others().length === 0) {
          clearInterval(watch);
          maybeLeave();
        }
      }, 250);
    }
  };
  send({ t: 'hello', stage: 'init' });
  const msg = await next();
  if (!msg || msg.t !== 'backend') process.exit(0);
  const spec = msg.backend as BackendSpec;
  if (spec.forwarder) {
    try {
      await startForwarder(spec.forwarder);
    } catch (err) {
      send({ t: 'setup_failed', detail: `the egress forwarder could not listen: ${(err as Error).message}` });
      setTimeout(() => process.exit(70), 50);
      return;
    }
  }
  backendEnv = spec.env;
  if (spec.canary?.witness && spec.canary.containment) startWitness(spec.canary.witness, spec.canary.containment);
  send({ t: 'ready' });
  const go = await next();
  if (!go || go.t !== 'start') process.exit(0);
  handlers.push(onMessage);
  for (const m of queue.splice(0)) onMessage(m);

  let child;
  // Nothing of the init's but the pipes it makes reaches the backend.
  closeInherited();
  try {
    child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    });
  } catch (err) {
    send({ t: 'start_failed', detail: (err as Error).message });
    exit = { code: null, signal: null };
    send({ t: 'exit', code: null, signal: null, start_failed: true });
    leaveWhenAlone();
    return;
  }
  child.on('error', (err) => {
    if (backendPid === null) {
      send({ t: 'start_failed', detail: err.message });
      exit = { code: null, signal: null };
      send({ t: 'exit', code: null, signal: null, start_failed: true });
      leaveWhenAlone();
    }
  });
  if (child.pid !== undefined) {
    backendPid = child.pid;
    send({ t: 'started', pid: child.pid });
  }
  child.stdin!.on('error', () => {});
  child.stdin!.end(spec.stdin ?? '');
  child.stdout!.on('data', (chunk: Buffer) => send({ t: 'out', d: chunk.toString('base64') }));
  child.stdout!.on('end', () => send({ t: 'eof' }));
  // The init exits once the backend has (SEAM.md §126): its report written,
  // process 1 of the sandbox goes, and the kernel ends every process left in
  // its pid namespace, a daemon the backend started among them.
  // What the backend wrote before its exit is relayed first: the init waits
  // for its output to end, or a moment if a descendant holds it open.
  let outputEnded = false;
  child.stdout!.on('end', () => {
    outputEnded = true;
  });
  // The cancellation canary's barrier, observed by the init, not the stream.
  if (spec.canary?.barrier) {
    const barrier = spec.canary.barrier;
    const watch = setInterval(() => {
      if (exit !== null) return void clearInterval(watch);
      // Seen by lstat only: never followed, never opened (a FIFO or a link
      // there is not the barrier).
      try {
        if (!lstatSync(barrier).isFile()) return;
      } catch {
        return;
      }
      clearInterval(watch);
      send({ t: 'barrier', path: barrier });
    }, 50);
  }
  child.on('exit', (code, signal) => {
    exitAt = performance.now();
    exit = { code, signal: signalNumber(signal) };
    const started = Date.now();
    const leave = setInterval(() => {
      if (outputEnded || Date.now() - started >= 2000) {
        clearInterval(leave);
        reportExit();
        setTimeout(() => process.exit(0), 20);
      }
    }, 10);
  });
}

closeInherited();
const stage = process.argv[2];
// The init is process 1 of the pid namespace the launcher created, or it is
// nothing: outside one it would start a backend on the host.
if (process.pid !== 1) process.exit(65);
if (stage === 'setup') void setup();
else if (stage === 'init') void init();
else process.exit(64);
