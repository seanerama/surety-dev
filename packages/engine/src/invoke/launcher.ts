// The launcher (D2 §§1.1, 3.2): engine code the choke point spawns once per
// invocation, in the supervisor leaf of the engine's scope. It
//
//   1. places itself: writes its own pid into the domain's `cgroup.procs`,
//      confirms /proc/self/cgroup names the domain, and reports `placed`;
//   2. asks for the launch authorization, presenting domain, invocation,
//      incarnation and lease generation. Without the grant it exits, having
//      run nothing of the role's;
//   3. with it, execs `unshare` into the sandbox's namespaces, whose process 1
//      is the domain init (invoke/domain-init.ts) in its setup stage.
//
// It talks to the engine on its standard input and output, one JSON object per
// line, and only asks and waits for the answer, so nothing the engine sends
// can be lost across the exec. A `term` from the engine at any point means the
// launch is over: the launcher goes no further. If the engine goes away (its
// end of the channel closes) the launcher exits: an unauthorized launcher
// never outlives the engine that could authorize it, except while it waits at
// a named wait point the engine handed it (`waits`), where it stays, ignoring
// TERM, until the wait is released by a file the engine of any incarnation
// writes; then it goes on only as far as the engine still answers.
//
// This file imports nothing of the engine's: it runs as its own program.

import { closeSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface Spec {
  domain: string;
  invocation: string;
  incarnation: string;
  generation: number;
  // The domain's cgroup; null for the start-up trial, which is not placed.
  cgroup: string | null;
  unshare: string;
  node: string;
  init: string;
  // Named wait points, each `pause` or `kill`, and where a wait is marked
  // and released; none outside the engine's test mode.
  waits?: Record<string, string>;
  releaseDir?: string | null;
}


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

closeInherited();

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const queue: Record<string, unknown>[] = [];
let waiter: ((v: Record<string, unknown> | null) => void) | null = null;
let closed = false;
let waiting = false;
let ended = false;
lines.on('line', (line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg.t === 'term') {
    // The launch is over: whatever is asked next is refused.
    ended = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    }
    return;
  }
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(msg);
  } else queue.push(msg);
});
lines.on('close', () => {
  closed = true;
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(null);
  }
  // The engine is gone: nothing can authorize this launch any more.
  if (!waiting) process.exit(0);
});

function next(): Promise<Record<string, unknown> | null> {
  if (queue.length > 0) return Promise.resolve(queue.shift()!);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

function send(msg: Record<string, unknown>): void {
  if (closed) return;
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    // the engine is gone
  }
}

async function ask(msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (ended) return null;
  send(msg);
  return next();
}

function stop(): never {
  process.exit(0);
}

const ignoreTerm = (): void => {};

// A named wait point: mark the wait, tell the engine, and wait for its
// release file, whatever happens to the engine meanwhile.
async function waitPoint(spec: Spec, name: string): Promise<void> {
  const action = spec.waits?.[name];
  if (!action || !spec.releaseDir) return;
  const mark = join(spec.releaseDir, `${name}.${process.pid}.waiting`);
  const release = join(spec.releaseDir, `${name}.${process.pid}.release`);
  waiting = true;
  process.on('SIGTERM', ignoreTerm);
  try {
    writeFileSync(mark, '');
    send({ t: 'wait', name, action });
    while (!existsSync(release)) await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('SIGTERM', ignoreTerm);
    waiting = false;
    for (const f of [mark, release]) {
      try {
        unlinkSync(f);
      } catch {
        // already gone
      }
    }
  }
  if (closed) stop();
}

async function main(): Promise<void> {
  const spec = (await next()) as unknown as Spec | null;
  if (!spec) stop();
  await waitPoint(spec, 'launcher.before_placement');
  if (ended) stop();

  if (spec.cgroup !== null) {
    // Placement: the launcher enters the domain itself; no process of the
    // role exists yet (D2 §3.2).
    try {
      writeFileSync(join(spec.cgroup, 'cgroup.procs'), String(process.pid));
    } catch (err) {
      send({ t: 'place_failed', detail: (err as Error).message });
      stop();
    }
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    const now = line ? join('/sys/fs/cgroup', line.slice(3)) : null;
    if (now !== spec.cgroup) {
      send({ t: 'place_failed', detail: `/proc/self/cgroup names ${now ?? 'nothing'}, not ${spec.cgroup}` });
      stop();
    }
    if ((await ask({ t: 'placed', pid: process.pid, cgroup: now }))?.t !== 'go') stop();
    await waitPoint(spec, 'launcher.placed');
  }

  await waitPoint(spec, 'launcher.before_authorization');
  const answer = await ask({ t: 'authorize', domain: spec.domain, invocation: spec.invocation, incarnation: spec.incarnation, generation: spec.generation });
  if (answer?.t !== 'granted') stop();
  await waitPoint(spec, 'launcher.authorized');
  if (ended) stop();

  // The sandbox (D2 §2.2): a user namespace mapping the engine's uid to root,
  // in which the setup stage builds the mounts; private mount, pid, network,
  // ipc, uts namespaces, and a cgroup namespace rooted at the domain, which
  // the launcher has entered. `--fork` makes the domain init process 1 of the
  // new pid namespace; `unshare` itself stays, as this process, and exits
  // with the init.
  const argv = [
    spec.unshare,
    '--user',
    '--map-root-user',
    '--mount',
    '--pid',
    '--net',
    '--ipc',
    '--uts',
    '--cgroup',
    '--fork',
    '--propagation',
    'private',
    '--',
    spec.node,
    '--no-warnings',
    '--disable-sigusr1',
    spec.init,
    'setup',
  ];
  closeInherited();
  (process as unknown as { execve(file: string, args: string[], env: Record<string, string>): never }).execve(spec.unshare, argv, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
  });
}

main().catch(() => {
  // A refusal or a failure: nothing of the role ran.
  setTimeout(() => process.exit(0), 50);
});
