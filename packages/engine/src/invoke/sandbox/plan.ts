// The part of the mount plan a project's policy can widen, validated before
// every launch (D2 §2.3, A.7; AR B02): each `sandbox_read_paths` entry is
// resolved to its real path, and refused with `mount_plan_refused` if what
// it resolves to is, contains, or aliases forbidden authority (the engine
// home, a registered repository or workspace, an operator credential
// location, the host's runtime, kernel and device trees, `/mnt`, the host
// `/tmp`, a WSL path), or holds a socket, a device or a FIFO. Approval of the
// widening never overrides this. Nothing here starts a process; the walk is
// bounded, and a walk that cannot finish refuses rather than passes.

import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

export interface ForbiddenContext {
  // The engine home ($SURETY_HOME), registered repositories, workspaces and
  // managed checkouts, as the store records them.
  home: string;
  repositories: string[];
  workspaces: string[];
  checkouts: string[];
}

export interface PlanRefusal {
  path: string;
  resolved: string | null;
  reason: string;
}

// D2 §2.3: the operator credential locations the profile enumerates, under
// the operator's home.
export const CREDENTIAL_LOCATIONS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.claude',
  '.codex',
  '.docker',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.config/gcloud',
  '.azure',
  '.pypirc',
  '.config/git/credentials',
];

// Host trees no widening may reach (D2 §2.3), with WSL's own paths (its
// interop and driver trees; DrvFs is under /mnt).
const HOST_TREES = ['/run', '/var/run', '/proc', '/sys', '/dev', '/mnt', '/tmp', '/usr/lib/wsl', '/init'];

// How many directory entries one path's walk may visit before it is refused
// as unestablished.
export const WALK_LIMIT = 100_000;

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

// The real path of a forbidden location, or the path as given where it does
// not exist (an absent location is still forbidden by name).
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function forbiddenRoots(ctx: ForbiddenContext): Promise<{ root: string; why: string }[]> {
  const out: { root: string; why: string }[] = [];
  const add = async (path: string, why: string) => {
    out.push({ root: path, why });
    const r = await real(path);
    if (r !== path) out.push({ root: r, why });
  };
  await add(ctx.home, 'the engine home');
  for (const r of ctx.repositories) await add(r, 'a registered repository');
  for (const w of ctx.workspaces) await add(w, 'a workspace');
  for (const c of ctx.checkouts) await add(c, 'a managed checkout');
  const operator = homedir();
  for (const c of CREDENTIAL_LOCATIONS) await add(join(operator, c), 'an operator credential location');
  for (const t of HOST_TREES) await add(t, `the host's ${t}`);
  return out;
}

// What a directory holds that may never be bound into a sandbox: the first
// socket, device or FIFO found, without following links; or why the walk
// could not be finished.
async function special(root: string): Promise<string | null> {
  const queue = [root];
  let seen = 0;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      return `${dir} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}), so what it holds is unknown`;
    }
    for (const name of names) {
      if (++seen > WALK_LIMIT) return `it holds more than ${WALK_LIMIT} entries, so what it holds was not established`;
      const path = join(dir, name);
      let st;
      try {
        st = await lstat(path);
      } catch (err) {
        return `${path} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
      }
      if (st.isSocket()) return `it holds a socket, ${path}`;
      if (st.isFIFO()) return `it holds a FIFO, ${path}`;
      if (st.isBlockDevice() || st.isCharacterDevice()) return `it holds a device, ${path}`;
      if (st.isDirectory()) queue.push(path);
    }
  }
  return null;
}

// The first entry of `paths` that the plan refuses, with why; null if every
// one may be bound read-only.
export async function validateReadPaths(paths: string[], ctx: ForbiddenContext): Promise<PlanRefusal | null> {
  if (paths.length === 0) return null;
  const roots = await forbiddenRoots(ctx);
  for (const path of paths) {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (err) {
      return { path, resolved: null, reason: `it cannot be resolved (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    for (const { root, why } of roots) {
      if (within(resolved, root)) return { path, resolved, reason: resolved === root ? `it is ${why}` : `it is inside ${why} (${root})` };
      if (within(root, resolved)) return { path, resolved, reason: `it contains ${why} (${root})` };
    }
    // An alias is judged by what it resolves to, and bound at its real path.
    let st;
    try {
      st = await lstat(resolved);
    } catch (err) {
      return { path, resolved, reason: `it cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (st.isSocket() || st.isFIFO() || st.isBlockDevice() || st.isCharacterDevice()) return { path, resolved, reason: 'it is a socket, FIFO or device' };
    if (st.isDirectory()) {
      const found = await special(resolved);
      if (found !== null) return { path, resolved, reason: found };
    }
  }
  return null;
}
