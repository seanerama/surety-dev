// The launcher (D2 §§1.1, 3.2): engine code the choke point spawns once per
// invocation, in the supervisor leaf of the engine's scope. It
//
//   1. waits for the engine at `before_placement`;
//   2. places itself: writes its own pid into the domain's `cgroup.procs`,
//      confirms /proc/self/cgroup names the domain, and reports `placed`;
//   3. asks for the launch authorization, presenting domain, invocation,
//      incarnation and lease generation. Without the grant it exits, having
//      run nothing of the role's;
//   4. with it, execs `unshare` into the sandbox's namespaces, whose process 1
//      is the domain init (invoke/domain-init.ts) in its setup stage.
//
// It talks to the engine on its standard input and output, one JSON object per
// line, and only answers what the engine asked or waits for the engine's word:
// so nothing the engine sends can be lost across the exec. If the engine goes
// away (its end of the channel closes) the launcher exits: an unauthorized
// launcher never outlives the engine that could authorize it.
//
// This file imports nothing of the engine's: it runs as its own program.

import { readFileSync, writeFileSync } from 'node:fs';
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
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const queue: unknown[] = [];
let waiter: ((v: unknown) => void) | null = null;
let closed = false;
lines.on('line', (line) => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
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
  // The engine is gone: nothing can authorize this launch any more.
  process.exit(0);
});

function next(): Promise<Record<string, unknown>> {
  if (queue.length > 0) return Promise.resolve(queue.shift() as Record<string, unknown>);
  if (closed) process.exit(0);
  return new Promise((resolve) => {
    waiter = (v) => resolve(v as Record<string, unknown>);
  });
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function ask(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  send(msg);
  return next();
}

function stop(why: string): never {
  send({ t: 'stopped', why });
  process.exitCode = 0;
  // Let the line drain, then go.
  setTimeout(() => process.exit(0), 50);
  throw new Error(why);
}

async function main(): Promise<void> {
  const spec = (await next()) as unknown as Spec;
  if ((await ask({ t: 'stage', at: 'before_placement' })).t !== 'go') stop('placement not allowed');

  if (spec.cgroup !== null) {
    // Placement: the launcher enters the domain itself; no process of the
    // role exists yet (D2 §3.2).
    try {
      writeFileSync(join(spec.cgroup, 'cgroup.procs'), String(process.pid));
    } catch (err) {
      send({ t: 'place_failed', detail: (err as Error).message });
      stop('placement failed');
    }
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    const now = line ? join('/sys/fs/cgroup', line.slice(3)) : null;
    if (now !== spec.cgroup) {
      send({ t: 'place_failed', detail: `/proc/self/cgroup names ${now ?? 'nothing'}, not ${spec.cgroup}` });
      stop('placement not confirmed');
    }
    if ((await ask({ t: 'placed', pid: process.pid, cgroup: now })).t !== 'go') stop('not allowed past placement');
  }

  const answer = await ask({ t: 'authorize', domain: spec.domain, invocation: spec.invocation, incarnation: spec.incarnation, generation: spec.generation });
  if (answer.t !== 'granted') stop('launch not authorized');

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
  (process as unknown as { execve(file: string, args: string[], env: Record<string, string>): never }).execve(spec.unshare, argv, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
  });
}

main().catch(() => {
  // A refusal or a failure: nothing of the role ran.
  setTimeout(() => process.exit(0), 50);
});
