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
  const inode = createDomainCgroup(may.cgroup_path, { memoryMax: rt.setting('domain_memory_max'), tasksMax: rt.setting('domain_tasks_max') });
  await rt.engine('domain.cgroup_created', { domain: claim.domain, inode });

  const writable = rt.setting('domain_writable_bytes');
  const plan = buildPlan({
    area,
    context: join(area, 'context'),
    workspace: handle.workspacePath!,
    readPaths: [...handle.readPaths, ...(backend.binds ?? []).filter((b) => !b.writable).map((b) => b.path)],
    writablePaths: (backend.binds ?? []).filter((b) => b.writable).map((b) => b.path),
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
