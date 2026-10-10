// The `check` profile (D3 §2.2; D2 §3.8): the mount plan of a check
// execution's domain, resolved from the host before each launch with D2's
// plan builder (invoke/sandbox/mounts.ts), and the profile's fingerprint,
// which a result's `runner_id` carries (D3 §2.8).
//
// What the root holds: D2's system root (the system trees, the enumerated
// /etc, a minimal /dev, /proc, the engine's node, the domain init);
// `runner_config.direct.read_paths`, read-only at their own paths;
// `/surety/workspace`, an overlay whose lower layer is the check tree's
// candidate-source projection and whose upper layer is on the domain's
// volatile filesystem, discarded with the domain (E89 item 2); the immutable
// input namespace (B01, below); `/surety/home` and `/tmp` on the volatile
// filesystem; and, only when the definition names `egress`, the domain's
// egress socket beside the init (D2 §2.4). Absent, compared with the `role`
// profile: the context package, `/surety/out`, any git metadata, a backend
// installation and any provider key; the network namespace has only
// loopback.
//
// The immutable input namespace (D3 §2.2, B01; E95; SEAM.md §198). For each
// top-level component T of the workspace that holds an input, one read-only
// mount at /surety/workspace/T, on top of the writable overlay:
//   - T a directory of the source projection: an overlay with no upper
//     layer, its layers the check's manifest projection of T over the source
//     projection's T (`ro`, so the mount and its superblock are read-only);
//   - T absent from the source: a read-only bind of the projection's T;
//   - an input at the top level itself: a read-only bind of that file.
// So every input's pathname and every directory from it up to
// /surety/workspace lies on a read-only mount below the workspace that is
// no overlay with an upper layer: nothing at those paths can be renamed,
// removed, exchanged or replaced (a mount point cannot be renamed or
// removed from its parent, and a read-only mount refuses changes under it).
// The source beside an input in T is read-only too (the driver's ruling 2).
// The only target made is T itself, in the overlay's upper layer, without
// following a link (S1); a source that has T, or an ancestor of an input, as
// anything but a directory refuses the plan (`inputTargetConflict`). A T
// that an overlay's options cannot name (`,` `:` `\` or white space) refuses
// it too (`inputMountConflict`).

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Builder, DEV_NODES, ETC_FILES, type Plan, SYSTEM_TREES, type Tools, WORKSPACE, esc, hostMountPoints, overlayPath, parents, systemRoot } from '../invoke/sandbox/mounts.js';
import { INIT_SCRIPT } from '../invoke/sandboxed.js';
import { seamCheckProfileVariant } from '../testing/seam.js';
import type { ManifestEntry } from './schema.js';

export interface CheckPlanInput {
  area: string;
  // The check tree's source projection and this check's manifest
  // projection, by their real paths.
  source: string;
  projection: string;
  manifest: ManifestEntry[];
  readPaths: string[];
  volBytes: number;
  volInodes: number;
  shmBytes: number;
  tools: Tools;
  node: string;
  initNodeCopy: string;
  initScript: string;
  // The domain's egress socket, only when the definition names `egress`.
  egressSocket?: string | null;
  // The execution's service link (D4 §5.2), bound beside the init.
  linkSocket?: string | null;
}

export const LINK_SOCKET = '/.init/link.sock';

// The top-level components of the workspace that hold the manifest's
// inputs, each once, in order.
export const inputTops = (manifest: readonly ManifestEntry[]): string[] => [...new Set(manifest.map(([path]) => path.split('/')[0]!))].sort();

export function buildCheckPlan(input: CheckPlanInput): Plan {
  const stage = join(input.area, 'root');
  const vol = join(input.area, 'vol');
  const b = new Builder(stage, hostMountPoints());
  systemRoot(b, input);
  if (input.linkSocket) b.bind(input.linkSocket, { target: LINK_SOCKET, noexec: true });
  b.dir('/surety');
  b.dir(WORKSPACE);
  b.line(
    'surety-workspace',
    WORKSPACE,
    'overlay',
    `lowerdir=${esc(overlayPath(input.source))},upperdir=${esc(overlayPath(join(vol, 'upper')))},workdir=${esc(overlayPath(join(vol, 'work')))},userxattr,nosuid,nodev`,
  );
  b.dir('/surety/home');
  b.line(join(vol, 'home'), '/surety/home', 'none', 'bind,nosuid,nodev');
  b.dir('/tmp', 0o1777);
  b.line(join(vol, 'tmp'), '/tmp', 'none', 'bind,nosuid,nodev');
  const first = { skeleton: b.skeleton, fstab: b.fstab };
  b.second();
  b.entry({ path: 'dev/ptmx', kind: 'symlink', target: 'pts/ptmx' });
  // The immutable input namespace (the head of this file).
  for (const top of inputTops(input.manifest)) {
    const target = join(WORKSPACE, top);
    const projected = join(input.projection, top);
    const st = lstatSync(projected);
    if (st.isFile()) {
      b.bind(projected, { target });
      continue;
    }
    b.dir(target);
    if (existsSync(join(input.source, top))) {
      b.line('surety-inputs', target, 'overlay', `lowerdir=${esc(overlayPath(projected))}:${esc(overlayPath(join(input.source, top)))},userxattr,ro,nosuid,nodev`);
    } else b.bind(projected, { target, noTarget: true });
  }
  // The targets, made under the overlay before the root is pivoted to,
  // never through a link (S1): with `inputTargetConflict` refusing a plan
  // whose source has one, nothing is created outside the domain's own area.
  for (const e of b.late) if (e.path.startsWith(`${WORKSPACE.slice(1)}/`)) e.nofollow = true;
  for (const p of input.readPaths) {
    for (const d of parents(p)) b.dir(d);
    b.bind(p);
  }
  return {
    stage,
    vol,
    rootBytes: 16 * 1024 * 1024,
    volBytes: input.volBytes,
    volInodes: input.volInodes,
    volDirs: ['home', 'tmp', 'upper', 'work'],
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
    workspaceMount: 'surety/workspace',
  };
}

// Why the input namespace cannot be mounted, or null: a top-level component
// holding an input whose name an overlay's options cannot carry (`,` and `:`
// separate them; `\` and white space are escapes there). The first runner
// refuses the plan rather than mount it otherwise (`mount_plan_refused`).
export function inputMountConflict(manifest: readonly ManifestEntry[]): string | null {
  for (const top of inputTops(manifest)) {
    if (/[,:\\\s]/.test(top)) {
      return `the top-level directory ${JSON.stringify(top)} holds a protected input, and its name contains a comma, colon, backslash or white space, which a read-only overlay's options cannot name: the first runner cannot mount the input namespace there`;
    }
  }
  return null;
}

// Why a check's input targets cannot be made in the workspace, or null (S1):
// each input's pathname is created under the overlay, whose lower layer is
// the candidate's source projection, so every ancestor that exists there
// must be a directory (never a link, a file or anything else), and the
// target itself must not exist there. Read without following links.
export function inputTargetConflict(source: string, manifest: ManifestEntry[]): string | null {
  for (const [path] of manifest) {
    const parts = path.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return `the input ${path} is not a plain relative path`;
    let at = source;
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]!);
      let st;
      try {
        st = lstatSync(at);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
        return `the source projection at ${parts.slice(0, i + 1).join('/')} cannot be read: ${(err as Error).message}`;
      }
      const last = i === parts.length - 1;
      if (last) return `the candidate's source has ${path} itself, where the input is presented`;
      if (st.isSymbolicLink() || !st.isDirectory()) return `the candidate's source has ${parts.slice(0, i + 1).join('/')} as ${st.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}, an ancestor of the input ${path}`;
    }
  }
  return null;
}

// The profile's fingerprint (D3 §2.8): its rules, not one domain's paths,
// and the domain init it runs.
let fingerprint: string | null = null;
export function checkProfileFingerprint(): string {
  if (fingerprint !== null) return fingerprint;
  let init = '';
  try {
    init = createHash('sha256').update(readFileSync(INIT_SCRIPT)).digest('hex');
  } catch {
    init = 'unreadable';
  }
  const rules = {
    profile: 'check',
    rules: 2,
    system: SYSTEM_TREES,
    etc: ETC_FILES,
    dev: DEV_NODES,
    workspace: 'overlay(lower: candidate-source projection; upper: volatile, discarded)',
    inputs: 'per top-level component holding an input: read-only overlay without upper layer (manifest projection over source), or read-only bind; source in such a component read-only',
    volatile: ['/surety/home', '/tmp', '/dev/shm'],
    absent: ['/surety/context', '/surety/out', '/surety/git'],
    egress: 'only the definition\'s egress hosts, through the domain proxy; none without egress',
    read_paths: 'runner_config.direct.read_paths, read-only at their own paths',
    init,
  };
  // The test seam's profile variant (SEAM.md §208) folds a label in, as a
  // change to the profile would.
  const variant = seamCheckProfileVariant();
  fingerprint = createHash('sha256').update(JSON.stringify(variant === null ? rules : { ...rules, variant })).digest('hex');
  return fingerprint;
}

export const runnerId = (hostId: string, profileFingerprint: string): string => `direct@${hostId}/${profileFingerprint.slice(0, 12)}`;
