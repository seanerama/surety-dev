// The incarnation scope (D2 §3.1, K2): at start, before the lock, the engine
// asks the user's systemd manager for a transient scope with delegation,
// `surety-<home>-<incarnation>.scope`, containing the engine itself, as
// `systemd-run --user --scope -p Delegate=yes` does: the same manager call
// (StartTransientUnit with the engine's own pid and Delegate=yes), made with
// `busctl`, so that the engine keeps its process identity. The engine then
// moves itself into the `supervisor` leaf and enables `memory` and `pids` for
// the scope's children.
//
// This is the one module outside invoke/ that starts a process (the M74 spawn
// lint's D2_HELPERS): `busctl` and `systemctl`, host tools of the user's
// systemd, never a backend. A start that cannot get its scope is not refused:
// it goes on with H3 failed and real backends refused (K2).

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SUPERVISOR_LEAF, movePid, ownCgroup, readControllers, scopeUnit } from './cgroup.js';

const SYSTEM_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

// A host tool by its absolute path, from the system directories only: the
// engine's PATH is not trusted to name it.
export function systemTool(name: string): string | null {
  for (const dir of SYSTEM_DIRS) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// The environment a call to the user manager needs, and nothing else.
function managerEnv(): NodeJS.ProcessEnv | null {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!runtime && !bus) return null;
  return {
    PATH: SYSTEM_DIRS.join(':'),
    LANG: 'C.UTF-8',
    ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}),
    ...(bus ? { DBUS_SESSION_BUS_ADDRESS: bus } : {}),
  };
}

export interface Scope {
  unit: string;
  // The scope's directory under /sys/fs/cgroup, and its supervisor leaf.
  path: string;
  supervisor: string;
  // `memory` and `pids` enabled for the scope's children.
  controllers: string[];
}

export type ScopeResult = { ok: true; scope: Scope } | { ok: false; observed: string };

const SCOPE_WAIT_MS = 5000;

// Create this incarnation's scope and enter it (D2 §3.1). Synchronous: it runs
// before the lock and the listener, when nothing else is waiting on the event
// loop.
export function createIncarnationScope(home: string, incarnation: string): ScopeResult {
  const env = managerEnv();
  if (env === null) return { ok: false, observed: 'the systemd user manager is not reachable (XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset)' };
  const busctl = systemTool('busctl');
  if (busctl === null) return { ok: false, observed: 'busctl, the systemd bus client, is not installed' };
  const unit = scopeUnit(home, incarnation);
  const call = spawnSync(
    busctl,
    [
      '--user',
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'StartTransientUnit',
      'ssa(sv)a(sa(sv))',
      unit,
      'fail',
      '3',
      'PIDs',
      'au',
      '1',
      String(process.pid),
      'Delegate',
      'b',
      'true',
      'Description',
      's',
      `surety engine ${incarnation}`,
      '0',
    ],
    { env, encoding: 'utf8', timeout: SCOPE_WAIT_MS },
  );
  if (call.error || call.status !== 0) {
    const why = (call.stderr || call.error?.message || `exit status ${call.status}`).trim();
    return { ok: false, observed: `the systemd user manager did not create the scope ${unit}: ${why}` };
  }
  // The manager moves the engine into the scope as part of the start job.
  const deadline = Date.now() + SCOPE_WAIT_MS;
  let path: string | null = null;
  while (Date.now() < deadline) {
    const cg = ownCgroup();
    if (cg !== null && cg.endsWith(`/${unit}`)) {
      path = cg;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (path === null) return { ok: false, observed: `the scope ${unit} was created but the engine was not moved into it within ${SCOPE_WAIT_MS} ms` };
  const supervisor = join(path, SUPERVISOR_LEAF);
  try {
    mkdirSync(supervisor);
    movePid(supervisor, process.pid);
  } catch (err) {
    return { ok: false, observed: `the scope ${unit} is not delegated to the engine's uid: ${(err as Error).message}` };
  }
  const available = readControllers(path, 'cgroup.controllers') ?? [];
  const wanted = ['memory', 'pids'].filter((c) => available.includes(c));
  try {
    if (wanted.length > 0) {
      // Written as one line, as the kernel takes it.
      writeFileSync(join(path, 'cgroup.subtree_control'), wanted.map((c) => `+${c}`).join(' '));
    }
  } catch (err) {
    return { ok: false, observed: `the controllers ${wanted.join(', ')} could not be enabled in ${unit}: ${(err as Error).message}` };
  }
  return { ok: true, scope: { unit, path, supervisor, controllers: readControllers(path, 'cgroup.subtree_control') ?? [] } };
}

// Is the user manager reachable now (D2 §3.4)? A call that fails, or that does
// not answer within the bound, is unreachable. Never throws.
export function managerReachable(timeoutMs = 3000): Promise<{ reachable: boolean; observed: string }> {
  const env = managerEnv();
  const systemctl = systemTool('systemctl');
  if (env === null || systemctl === null) return Promise.resolve({ reachable: false, observed: env === null ? 'XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset' : 'systemctl is not installed' });
  return new Promise((resolve) => {
    execFile(systemctl, ['--user', 'show', '--property=Version', '--value'], { env, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) resolve({ reachable: false, observed: (stderr || err.message).trim() });
      else resolve({ reachable: true, observed: `systemd ${String(stdout).trim()}` });
    });
  });
}

// The systemd version, for the host qualification's tool versions.
export function systemdVersion(): Promise<string | null> {
  return managerReachable().then((r) => (r.reachable ? r.observed.replace(/^systemd /, '') : null));
}

// Whether the scope directory still exists (used by the checks).
export const scopeExists = (scope: Scope): boolean => existsSync(join(scope.path, 'cgroup.procs'));

// The kernel's own record of the engine's cgroup, for diagnostics.
export const selfCgroupLine = (): string => {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8').trim();
  } catch {
    return '';
  }
};
