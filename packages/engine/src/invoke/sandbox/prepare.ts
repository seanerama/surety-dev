// Before a launch into the real sandbox (D2 §§1.2, 1.3, 2.3, 2.4, 2.7, 3.2,
// 3.7): the domain's area under the engine home (the two mountpoints of the
// setup stage, the context package, the git view's seed, the egress socket),
// the domain's cgroup with its limits, created by the engine only while the
// launch is not closed, the egress proxy, the mount plan, recorded on the
// domain before the launcher starts, and what the init will start: the
// backend's argument array, its constructed environment, its working
// directory, its standard input and the egress forwarder.

import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

import { recordsDir, writeWholeRecord } from '../../records/files.js';
import { seamSandboxBinds } from '../../testing/seam.js';

import { createDomainCgroup } from '../../boundary/cgroup.js';
import { workspaceLink } from '../../git/worktree.js';
import { type RunHandle, type Runtime, log } from '../../runtime.js';
import type { BackendSpec } from '../backend.js';
import { DOMAIN_MARKER, INVOCATION_MARKER } from '../processes.js';
import { finishEgress, startEgress } from '../proxy/egress.js';
import type { DomainProxy } from '../proxy/proxy.js';
import type { BackendLaunch } from '../sandboxed.js';
import { INIT_SCRIPT } from '../sandboxed.js';
import { type ContextFacts, writeContextPackage } from './context.js';
import { seedGitView } from './gitview.js';
import { EGRESS_SOCKET, type Plan, buildPlan, entriesFingerprint, planEntries } from './mounts.js';
import { type ResolvedTools, engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from './tools.js';

let tools: ResolvedTools | null = null;

// The port of the egress forwarder on the sandbox's own loopback, which
// HTTPS_PROXY names (D2 §2.4).
export const FORWARDER_PORT = 3128;

export const domainArea = (home: string, domain: string): string => join(home, 'domains', domain);

// The protected roots a role other than the Verifier sees read-only (D1 §7.3;
// D2 §2.3, A.6 P19): each root the checkout has, bound from the checkout
// (the run's base, which carries the effective version); a directory root it
// does not have, made empty and bound read-only, so that nothing can be
// created under it. A root reached through a symbolic link in the checkout
// is not bound (a bind would follow the link): the snapshot's validation
// still refuses any change under it.
export function protectedBinds(workspace: string, roots: string[], empty: string): { source: string; target: string; make?: 'dir' }[] {
  const out: { source: string; target: string; make?: 'dir' }[] = [];
  const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  for (const root of sorted) {
    const dir = root.endsWith('/');
    const rel = root.replace(/\/+$/, '');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === '..' || p === '.' || p === '.git')) continue;
    // Each component as the checkout has it, never through a link.
    let at = workspace;
    let state: 'present' | 'absent' | 'link' | 'other' = 'present';
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]!);
      let st;
      try {
        st = lstatSync(at);
      } catch {
        state = 'absent';
        break;
      }
      if (st.isSymbolicLink()) {
        state = 'link';
        break;
      }
      const last = i === parts.length - 1;
      if (!last && !st.isDirectory()) {
        state = 'other';
        break;
      }
      if (last && dir && !st.isDirectory()) state = 'other';
      if (last && !dir && !st.isDirectory() && !st.isFile()) state = 'other';
    }
    // Inside a root already bound: covered by it.
    if (out.some((b) => rel === b.target || rel.startsWith(`${b.target}/`))) continue;
    if (state === 'present') out.push({ source: at, target: rel });
    else if (state === 'absent' && dir) out.push({ source: empty, target: rel, make: 'dir' });
  }
  return out;
}

export interface PreparedSandbox {
  plan: Plan;
  backend: BackendLaunch;
  unshare: string;
  egress: DomainProxy;
}

export async function prepareSandbox(rt: Runtime, handle: RunHandle, backend: BackendSpec, stdin: string, repo: string): Promise<PreparedSandbox | null> {
  const { claim } = handle;
  tools ??= await resolveSandboxTools();
  const t = tools.paths;
  if (!t.unshare || !t.setpriv || !t.ip || !t.mount || !t.umount || !t.pivot_root || !t.mknod) throw new Error(`the sandbox's tools are missing: ${tools.missing.join(', ')}`);
  const copy = await initNodeCopy(rt.home);

  // The domain's area: the setup stage's two mountpoints, the context
  // package (mounted read-only at /surety/context) and the git view's seed.
  // The area by its real path: the plan and the hold name what the setup
  // stage's mount namespace resolves, whatever links the home is reached by.
  const made = domainArea(rt.home, claim.domain);
  for (const d of ['root', 'vol', 'context', 'git']) mkdirSync(join(made, d), { recursive: true, mode: 0o700 });
  const area = realpathSync(made);
  const facts = await rt.read<ContextFacts | null>('context.facts', { run: claim.run });
  const recordPaths = new Map((facts?.resumed?.records ?? []).map((r) => [r.id, r.path]));
  writeContextPackage(join(area, 'context'), claim, facts, {
    probe: claim.profile === 'probe',
    readRecord: (id) => {
      const path = recordPaths.get(id);
      if (!path) return null;
      try {
        return readFileSync(join(recordsDir(rt.home), basename(path)));
      } catch {
        return null;
      }
    },
  });

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

  // The git metadata view (D2 §2.7), from the workspace the journal made.
  const workspace = realpathSync(handle.workspacePath!);
  const link = workspaceLink(repo, workspace);
  if (link === null) throw new Error(`the workspace ${workspace} has no worktree metadata the engine can read`);
  const git = seedGitView({ repo, adminDir: link.adminDir, seed: join(area, 'git'), head: claim.base_revision });

  // The egress proxy (D2 §2.4): the entry's (or the attempt's) list and the
  // project's approved widening. Its log's bound cancels the run (§3.7).
  const egress = await startEgress(rt, {
    area,
    domain: claim.domain,
    run: claim.run,
    invocation: claim.invocation,
    profile: claim.profile,
    allow: [...(claim.entry?.egress_hosts ?? []), ...handle.egressExtra],
    onLogBound: () =>
      rt.requestEnd(handle, {
        outcome: 'failed',
        reason: 'infra_error',
        reasonText: `the egress log reached egress_log_max_bytes (${rt.setting('egress_log_max_bytes')} bytes): the run was cancelled and its egress evidence is incomplete`,
      }),
  });
  handle.egress = egress;

  let plan: Plan;
  try {
    const writable = rt.setting('domain_writable_bytes');
    plan = buildPlan({
      area,
      context: join(area, 'context'),
      workspace,
      readPaths: [...handle.readPaths, ...(backend.binds ?? []).filter((b) => !b.writable).map((b) => b.path)],
      writablePaths: [...new Set([...(backend.binds ?? []), ...seamSandboxBinds()].filter((b) => b.writable).map((b) => b.path))],
      binds,
      volBytes: writable,
      volInodes: rt.setting('domain_writable_inodes'),
      shmBytes: Math.min(writable, 64 * 1024 * 1024),
      tools: { mount: t.mount, umount: t.umount, pivot_root: t.pivot_root, ip: t.ip, unshare: t.unshare, setpriv: t.setpriv, mknod: t.mknod },
      node: engineNode(),
      initNodeCopy: await initNodeIn(area, copy),
      initScript: INIT_SCRIPT,
      git,
      // The Verifier writes the protected set, as proposals (D1 §7.3).
      workspaceBinds: claim.role === 'verifier' ? [] : protectedBinds(workspace, handle.protectedRoots, join(area, 'git', 'empty')),
      egressSocket: egress.socketPath,
      holdVolatile: true,
    });
    // The validated plan has the authority (D2 §2.3; A.6 P12): published as
    // a qualification_evidence record of the run and recorded on the domain
    // before the launcher starts (SEAM.md §133).
    const entries = planEntries(plan);
    const fingerprint = entriesFingerprint(entries, { area, workspace });
    const record = await writeWholeRecord(rt, {
      project: claim.project,
      run: claim.run,
      kind: 'qualification_evidence',
      content: Buffer.from(JSON.stringify({ profile: claim.profile, fingerprint, domain: claim.domain, entries }, null, 2)),
    });
    await rt.engine('domain.plan', { domain: claim.domain, fingerprint, mounts: entries, record });
  } catch (err) {
    handle.egress = null;
    await finishEgress(rt, egress, { project: claim.project, run: claim.run }).catch((e) => log('egress', e, { run: claim.run }));
    throw err;
  }

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
    HTTPS_PROXY: `http://127.0.0.1:${FORWARDER_PORT}`,
    [DOMAIN_MARKER]: claim.domain,
    [INVOCATION_MARKER]: claim.invocation,
    ...(backend.env ?? {}),
  };
  return {
    plan,
    backend: { argv: [backend.command, ...backend.args], env, cwd: '/surety/workspace', stdin, forwarder: { port: FORWARDER_PORT, socket: EGRESS_SOCKET } },
    unshare: t.unshare,
    egress,
  };
}
