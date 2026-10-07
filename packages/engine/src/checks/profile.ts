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
// volatile filesystem, discarded with the domain (E89 item 2); each entry of
// the check's input manifest, read-only at its workspace pathname; and
// `/surety/home` and `/tmp` on the volatile filesystem. Absent, compared with
// the `role` profile: the context package, `/surety/out`, any git metadata, a
// backend installation, any provider key, and the egress proxy (no check
// names egress before slice 17): the network namespace has only loopback.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Builder, DEV_NODES, ETC_FILES, type Plan, SYSTEM_TREES, type Tools, WORKSPACE, esc, hostMountPoints, overlayPath, parents, systemRoot } from '../invoke/sandbox/mounts.js';
import { INIT_SCRIPT } from '../invoke/sandboxed.js';
import type { ManifestEntry } from './schema.js';

export interface CheckPlanInput {
  area: string;
  // The check tree's halves, by their real paths.
  source: string;
  protectedDir: string;
  manifest: ManifestEntry[];
  readPaths: string[];
  volBytes: number;
  volInodes: number;
  shmBytes: number;
  tools: Tools;
  node: string;
  initNodeCopy: string;
  initScript: string;
}

export function buildCheckPlan(input: CheckPlanInput): Plan {
  const stage = join(input.area, 'root');
  const vol = join(input.area, 'vol');
  const b = new Builder(stage, hostMountPoints());
  systemRoot(b, input);
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
  // The check's protected inputs, each read-only at its workspace pathname
  // (D3 §2.2). TEMPORARY, B01 / slice 17: a read-only bind beneath the
  // writable overlay is the construction D3 calls insufficient (renaming an
  // ancestor frees the pathname); slice 17 replaces it with an immutable
  // input namespace.
  for (const [path] of input.manifest) b.bind(join(input.protectedDir, path), { target: join(WORKSPACE, path) });
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
    rules: 1,
    system: SYSTEM_TREES,
    etc: ETC_FILES,
    dev: DEV_NODES,
    workspace: 'overlay(lower: candidate-source projection; upper: volatile, discarded)',
    inputs: 'read-only bind per manifest entry at its workspace pathname',
    volatile: ['/surety/home', '/tmp', '/dev/shm'],
    absent: ['/surety/context', '/surety/out', '/surety/git', 'egress'],
    read_paths: 'runner_config.direct.read_paths, read-only at their own paths',
    init,
  };
  fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  return fingerprint;
}

export const runnerId = (hostId: string, profileFingerprint: string): string => `direct@${hostId}/${profileFingerprint.slice(0, 12)}`;
