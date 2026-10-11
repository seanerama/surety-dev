// What an adapter qualification is matched by (D4 §2.6; E129 item 8 as Sean
// decided it; SEAM.md §§248, 322, 324): the engine's build, the adapter and
// its version, the host qualification's facts and the `service` profile's
// fingerprint. Computed alike on every thread (the store worker matches rows
// against them), each once per thread.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildServicePlan } from './service-profile.js';
import { seamAdapterVersion, seamEngineBuildVariant, seamServiceProfileVariant } from '../testing/seam.js';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

// The adapter's version this engine builds (SEAM.md §322: `local_service`
// is version 1 in M4), or the harness's `--harness-adapter-version`.
export const LOCAL_SERVICE_VERSION = '1';
export function adapterVersion(adapter: string): string | null {
  if (adapter !== 'local_service') return null;
  return seamAdapterVersion(adapter) ?? LOCAL_SERVICE_VERSION;
}

// The engine's build (the driver's ruling): the hash of the compiled
// engine, every `.js` file under `dist/` by its relative path and bytes,
// with the harness's `--harness-engine-build-variant` folded in.
let buildHash: string | null = null;
function distHash(): string {
  if (buildHash !== null) return buildHash;
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(root);
  const h = createHash('sha256');
  for (const f of files.map((p) => relative(root, p)).sort()) {
    h.update(f);
    h.update('\0');
    h.update(sha(readFileSync(join(root, f))));
    h.update('\n');
  }
  buildHash = `sha256:${h.digest('hex')}`;
  return buildHash;
}

export function engineBuild(): string {
  const variant = seamEngineBuildVariant();
  return variant === null ? distHash() : `sha256:${sha(`${distHash()}\0variant:${variant}`)}`;
}

// The properties every service unit is created with, but its numeric
// limits (adapters/local-service.ts; D4 §9.2). Part of the profile's shape.
export const SERVICE_UNIT_SHAPE = Object.freeze([
  '--user',
  '--no-ask-password',
  '--service-type=exec',
  '--working-directory=/',
  '--setenv=NODE_OPTIONS=',
  '--property=Delegate=yes',
  '--property=Restart=no',
  '--property=MemoryMax=<limit>',
  '--property=MemorySwapMax=0',
  '--property=TasksMax=<limit>',
  '--property=KillMode=control-group',
  '--property=TimeoutStopSec=<kill_grace>',
  '--property=StandardInput=file:<launch socket>',
  '--property=StandardOutput=file:<launch socket>',
  '--property=StandardError=null',
]);

// The `service` profile's fingerprint (D4 §9.2; the driver's ruling: the
// real profile's shape, leaving out the numeric limits): the mount plan a
// service domain is built from, with every per-domain path and bound a
// placeholder, the unit's properties, its network and its launch; with the
// harness's `--harness-service-profile-variant` folded in.
let profileHash: string | null = null;
function profileShape(): string {
  if (profileHash !== null) return profileHash;
  // The plan builder reads each bind's source: the per-domain sources stand
  // in as the engine's own node (a file) and its directory, the same on
  // every start of this engine on this host.
  const node = process.execPath;
  const plan = buildServicePlan(
    {
      area: '/<area>',
      sealed: dirname(node),
      runtime: node,
      ingress: node,
      volBytes: 64 * 1024 * 1024,
      volInodes: 1024,
      tools: { mount: '/<mount>', umount: '/<umount>', pivot_root: '/<pivot_root>', ip: '/<ip>', unshare: '/<unshare>', setpriv: '/<setpriv>', mknod: '/<mknod>' },
      node,
      initNodeCopy: node,
      initScript: node,
    },
    [],
  );
  const shape = {
    profile: 'service',
    plan: { skeleton: plan.skeleton, fstab: plan.fstab, late: plan.late, late_fstab: plan.lateFstab, vol_dirs: plan.volDirs, init_node: plan.initNode, init_script: plan.initScript },
    unit: SERVICE_UNIT_SHAPE,
    network: 'loopback',
    restart: 'disabled',
    launch: 'single-use',
  };
  profileHash = sha(JSON.stringify(shape));
  return profileHash;
}

export function profileFingerprint(): string {
  const variant = seamServiceProfileVariant();
  return `sha256:${variant === null ? profileShape() : sha(`${profileShape()}\0variant:${variant}`)}`;
}

// The host qualification's facts a row is matched on (E129 item 8): never
// the row's id, so a new row of the same host (every start records one,
// M110) keeps an adapter's row current.
export const HOST_MEMBERS = ['host_id', 'kernel', 'tool_versions', 'mechanism_fingerprint'] as const;
export type HostFacts = Record<(typeof HOST_MEMBERS)[number], unknown>;

// The member of the host's facts that differs, in HOST_MEMBERS' order, or
// null when none does; null facts (no host qualification in force, `unrun`)
// match only null, and otherwise differ from the host id on.
export function hostFactsDrift(now: HostFacts | null, then: HostFacts | null): (typeof HOST_MEMBERS)[number] | null {
  if (now === null || then === null) return now === then ? null : 'host_id';
  const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
  return HOST_MEMBERS.find((m) => !same(now[m], then[m])) ?? null;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

export function hostFactsOf(row: { host_id: string; kernel: string; tool_versions: string; mechanism_fingerprint: string } | undefined | null): HostFacts | null {
  if (!row) return null;
  let tools: unknown = row.tool_versions;
  try {
    tools = JSON.parse(row.tool_versions);
  } catch {
    // kept as text
  }
  return { host_id: row.host_id, kernel: row.kernel, tool_versions: tools, mechanism_fingerprint: row.mechanism_fingerprint };
}
