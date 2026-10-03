// Before a launch into the real sandbox (D2 §§1.2, 1.3, 2.3, 3.2, 3.7): the
// domain's area under the engine home (the two mountpoints of the setup
// stage and the context package), the domain's cgroup with its limits,
// created by the engine only while the launch is not closed, the mount plan,
// and what the init will start: the backend's argument array, its
// constructed environment, its working directory and its standard input.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDomainCgroup } from '../../boundary/cgroup.js';
import type { RunHandle, Runtime } from '../../runtime.js';
import type { BackendSpec } from '../backend.js';
import { DOMAIN_MARKER, INVOCATION_MARKER } from '../processes.js';
import type { BackendLaunch } from '../sandboxed.js';
import { INIT_SCRIPT } from '../sandboxed.js';
import { type Plan, buildPlan } from './mounts.js';
import { type ResolvedTools, engineNode, initNodeCopy, resolveSandboxTools } from './tools.js';

let tools: ResolvedTools | null = null;

export const domainArea = (home: string, domain: string): string => join(home, 'domains', domain);

export async function prepareSandbox(rt: Runtime, handle: RunHandle, backend: BackendSpec, stdin: string): Promise<{ plan: Plan; backend: BackendLaunch; unshare: string } | null> {
  const { claim } = handle;
  tools ??= await resolveSandboxTools();
  const t = tools.paths;
  if (!t.unshare || !t.setpriv || !t.ip || !t.mount || !t.umount || !t.pivot_root) throw new Error(`the sandbox's tools are missing: ${tools.missing.join(', ')}`);
  const copy = await initNodeCopy(rt.home);

  // The domain's area: the setup stage's two mountpoints and the context
  // package, which the sandbox mounts read-only at /surety/context.
  const area = domainArea(rt.home, claim.domain);
  for (const d of ['root', 'vol', 'context']) mkdirSync(join(area, d), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(area, 'context', 'invocation.json'),
    `${JSON.stringify({ invocation: claim.invocation, run: claim.run, work_item: claim.work_item, work_kind: claim.work_kind, role: claim.role }, null, 2)}\n`,
  );

  // The cgroup, only while the launch is not closed (D2 §3.2). The read and
  // the creation are one step of the main thread: nothing that could close
  // and then remove the domain runs between them.
  const may = await rt.read<{ cgroup_path: string | null; may: boolean }>('domain.may_create', { domain: claim.domain });
  if (!may.may || may.cgroup_path === null) return null;
  // The recorded path must be this domain's directory in this engine's own
  // scope; anything else is never created, entered or killed.
  if (rt.scope === null || may.cgroup_path !== join(rt.scope.path, claim.domain)) throw new Error(`the domain's recorded cgroup ${may.cgroup_path} is not ${claim.domain} in this engine's scope`);
  const limits = { memoryMax: rt.setting('domain_memory_max'), tasksMax: rt.setting('domain_tasks_max') };
  const inode = createDomainCgroup(may.cgroup_path, limits);
  await rt.engine('domain.cgroup_created', { domain: claim.domain, inode });
  // The probe profile (D2 §2.8, A.6 P15; SEAM.md §127): the domain's own
  // cgroup directory and a sibling beside it, delegated like a domain and
  // empty, bound read-write, so that a migration out of the namespace's root
  // can be attempted and seen refused. The role profile has no cgroupfs.
  const binds: { source: string; target: string; writable: boolean; noexec: boolean }[] = [];
  if (claim.profile === 'probe') {
    const sibling = join(rt.scope.path, `sibling_${claim.domain}`);
    createDomainCgroup(sibling, limits);
    binds.push({ source: may.cgroup_path, target: '/surety/cgroup/domain', writable: true, noexec: true }, { source: sibling, target: '/surety/cgroup/sibling', writable: true, noexec: true });
  }

  const writable = rt.setting('domain_writable_bytes');
  const plan = buildPlan({
    area,
    context: join(area, 'context'),
    workspace: handle.workspacePath!,
    readPaths: [...handle.readPaths, ...(backend.binds ?? []).filter((b) => !b.writable).map((b) => b.path)],
    writablePaths: (backend.binds ?? []).filter((b) => b.writable).map((b) => b.path),
    binds,
    volBytes: writable,
    volInodes: rt.setting('domain_writable_inodes'),
    shmBytes: Math.min(writable, 64 * 1024 * 1024),
    tools: { mount: t.mount, umount: t.umount, pivot_root: t.pivot_root, ip: t.ip, unshare: t.unshare, setpriv: t.setpriv },
    node: engineNode(),
    initNodeCopy: copy,
    initScript: INIT_SCRIPT,
  });

  // D2 §1.2: the environment is constructed, never inherited.
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/surety/home',
    XDG_CONFIG_HOME: '/surety/home/.config',
    XDG_CACHE_HOME: '/surety/home/.cache',
    XDG_DATA_HOME: '/surety/home/.local/share',
    XDG_STATE_HOME: '/surety/home/.local/state',
    TMPDIR: '/tmp',
    [DOMAIN_MARKER]: claim.domain,
    [INVOCATION_MARKER]: claim.invocation,
    ...(backend.env ?? {}),
  };
  return { plan, backend: { argv: [backend.command, ...backend.args], env, cwd: '/surety/workspace', stdin }, unshare: t.unshare };
}
