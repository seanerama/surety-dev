// The `service` profile (D4 §9.2; Q6; E110; SEAM.md §§259, 260): the mount
// plan of a service domain, built with D2's plan builder (invoke/sandbox/
// mounts.ts) and executed by the domain init's setup stage, as a role's and
// a check's are.
//
// What the root holds: D2's system root (the system trees, the enumerated
// /etc, a minimal /dev with a private devpts and /dev/shm, a private /proc,
// the engine's node, the domain init with its execute-only node under
// /.init); the configured runtime, read-only at its configured path; the
// sealed artifact at /surety/app, a read-only bind of the sealed directory;
// the engine's ingress socket for this domain at /.init/ingress.sock (a
// read-only bind: the init dials it, nobody can replace it); and a volatile
// filesystem, bounded by `service_writable_bytes` and
// `service_writable_inodes`, for /surety/home, /tmp and /surety/state, lost
// with the domain. The root is a tmpfs remounted read-only after the pivot,
// so /, /surety and /surety/app lie on read-only mounts with no writable
// layer, and /surety/app, a mount point, cannot be renamed: its pathname is
// immutable with its ancestors for the domain's life. Absent: the engine
// home, every workspace and repository, the context package, any git
// metadata, any backend and the operator's home (but for the path to the
// pinned runtime, when it lies there). The network namespace has only its
// loopback; no egress socket is bound (X2).

import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import { Builder, type Plan, SYSTEM_TREES, type Tools, hostMountPoints, parents, systemRoot } from '../invoke/sandbox/mounts.js';

export const INGRESS_SOCKET = '/.init/ingress.sock';
export const APP_DIR = '/surety/app';

export interface ServicePlanInput {
  // The domain's runtime directory: `root` and `vol` are the mount points
  // the setup stage mounts its two tmpfs on.
  area: string;
  sealed: string;
  runtime: string;
  ingress: string;
  volBytes: number;
  volInodes: number;
  tools: Tools;
  node: string;
  initNodeCopy: string;
  initScript: string;
}

// `mountPoints`: the host's mount points the builder accounts for (the
// host's own by default); the profile's fingerprint passes none, so that it
// is a shape and not a reading of this moment's mounts (qualification.ts).
export function buildServicePlan(input: ServicePlanInput, mountPoints: string[] = hostMountPoints()): Plan {
  const stage = join(input.area, 'root');
  const vol = join(input.area, 'vol');
  const b = new Builder(stage, mountPoints);
  systemRoot(b, { shmBytes: Math.min(input.volBytes, 64 * 1024 * 1024), node: input.node, initNodeCopy: input.initNodeCopy, initScript: input.initScript, probeProgram: null, egressSocket: null });
  // The configured runtime at its configured path (its real file), unless a
  // system tree or the engine's node already holds it there.
  const real = realpathSync(input.runtime);
  const inTree = SYSTEM_TREES.some((t) => input.runtime === t || input.runtime.startsWith(`${t}/`));
  if (!inTree && input.runtime !== input.node) {
    for (const p of parents(input.runtime)) b.dir(p);
    b.bind(real, { target: input.runtime });
  }
  b.bind(input.ingress, { target: INGRESS_SOCKET, noexec: true });
  b.dir('/surety');
  b.bind(input.sealed, { target: APP_DIR });
  b.dir('/surety/home');
  b.line(join(vol, 'home'), '/surety/home', 'none', 'bind,nosuid,nodev');
  b.dir('/surety/state');
  b.line(join(vol, 'state'), '/surety/state', 'none', 'bind,nosuid,nodev');
  b.dir('/tmp', 0o1777);
  b.line(join(vol, 'tmp'), '/tmp', 'none', 'bind,nosuid,nodev');
  const first = { skeleton: b.skeleton, fstab: b.fstab };
  b.second();
  b.entry({ path: 'dev/ptmx', kind: 'symlink', target: 'pts/ptmx' });
  return {
    stage,
    vol,
    rootBytes: 16 * 1024 * 1024,
    volBytes: input.volBytes,
    volInodes: input.volInodes,
    volDirs: ['home', 'state', 'tmp'],
    volEntries: [],
    skeleton: first.skeleton,
    fstab: first.fstab,
    late: b.late,
    lateFstab: b.lateFstab,
    tools: input.tools,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    initNode: '/.init/node',
    initScript: '/.init/init.js',
  };
}

// The environment the init gives the service's application (D4 §§7.1, 7.2;
// SEAM.md §§259, 311): the fixed variables, the configuration's `env`, each
// `secrets` variable with the value the engine holds for its reference, and
// PORT. Built on the main thread only, where the values are held, and sent
// only on the launch grant's continuation (the real init's `backend`; the
// kernel lane's stand-in's grant). A reference not held: nothing, naming it.
export function serviceEnvironment(
  lk: { env: Record<string, string>; secrets: Record<string, string>; port: number | null },
  held: (ref: string) => string | null,
): { env: Record<string, string> } | { unheld: string } {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/surety/home', TMPDIR: '/tmp', ...lk.env };
  for (const [name, ref] of Object.entries(lk.secrets)) {
    const value = held(ref);
    if (value === null) return { unheld: ref };
    env[name] = value;
  }
  if (lk.port !== null) env.PORT = String(lk.port);
  return { env };
}
