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
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

type Msg = Record<string, unknown>;

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
  path: string; // relative to the new root
  kind: 'dir' | 'file' | 'symlink';
  target?: string;
  content?: string;
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
  tools: { mount: string; umount: string; pivot_root: string; ip: string; unshare: string; setpriv: string };
  uid: number;
  gid: number;
  initNode: string; // in the new root
  initScript: string; // in the new root
  // The start-up trial (D2 §6 H11): mount an overlay whose upper layer is on
  // the volatile filesystem, write through it, and report.
  overlayTrial?: boolean;
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

function make(root: string, e: Entry): void {
  const at = join(root, e.path);
  mkdirSync(dirname(at), { recursive: true });
  if (e.kind === 'dir') mkdirSync(at, { recursive: true, mode: e.mode ?? 0o755 });
  else if (e.kind === 'symlink') symlinkSync(e.target!, at);
  else {
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
    run(tools.mount, ['-t', 'tmpfs', '-o', `size=${plan.rootBytes},mode=0755,nosuid`, 'surety-root', plan.stage]);
    run(tools.mount, ['-t', 'tmpfs', '-o', `size=${plan.volBytes},nr_inodes=${plan.volInodes},mode=0755,nosuid,nodev`, 'surety-volatile', plan.vol]);
    for (const d of plan.volDirs) mkdirSync(join(plan.vol, d), { recursive: true, mode: 0o755 });
    for (const e of plan.skeleton) make(plan.stage, e);
    const fstab = join(plan.vol, '.fstab');
    writeFileSync(fstab, `${plan.fstab.join('\n')}\n`);
    run(tools.mount, ['--all', '--fstab', fstab]);
    unlinkSync(fstab);
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
}

let exit: { code: number | null; signal: number | null } | null = null;
let backendPid: number | null = null;
let terminating = false;
// The engine has acknowledged the exit report. Until it has, the report is
// sent again every half second and the init stays: an engine that was
// paused reads it, or asks by a challenge, when it resumes (D2 §3.5).
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

function reportExit(): void {
  if (exit === null || acked) return;
  send({ t: 'exit', code: exit.code, signal: exit.signal });
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
  send({ t: 'ready' });
  const go = await next();
  if (!go || go.t !== 'start') process.exit(0);
  handlers.push(onMessage);
  for (const m of queue.splice(0)) onMessage(m);

  let child;
  try {
    child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
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
  child.on('exit', (code, signal) => {
    exit = { code, signal: signalNumber(signal) };
    if (!channelOpen) onChannelLost();
    reportExit();
    const again = setInterval(() => {
      if (acked || terminating) clearInterval(again);
      else reportExit();
    }, 500);
  });
}

const stage = process.argv[2];
// The init is process 1 of the pid namespace the launcher created, or it is
// nothing: outside one it would start a backend on the host.
if (process.pid !== 1) process.exit(65);
if (stage === 'setup') void setup();
else if (stage === 'init') void init();
else process.exit(64);
