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

import { readRecordBytes, recordsDir, writeWholeRecord } from '../../records/files.js';
import { seamDomainLimits, seamSandboxBinds } from '../../testing/seam.js';

import { type DomainLimits, createDomainCgroup } from '../../boundary/cgroup.js';
import { workspaceLink } from '../../git/worktree.js';
import { type RunHandle, type Runtime, log } from '../../runtime.js';
import type { BackendSpec } from '../backend.js';
import { DOMAIN_MARKER, INVOCATION_MARKER } from '../processes.js';
import { finishEgress, startEgress } from '../proxy/egress.js';
import type { DomainProxy } from '../proxy/proxy.js';
import type { BackendLaunch } from '../sandboxed.js';
import { INIT_SCRIPT } from '../sandboxed.js';
import { type CandidateDiff, type ContextFacts, type EngineCommitsInRange, PROBE_PROGRAM, writeContextPackage } from './context.js';
import { isAncestor } from '../../git/repo.js';
import { SHA, git, repoContext } from '../../git/exec.js';
import { CANARY_BARRIER, CONTAINMENT_ACTIONS, CONTAINMENT_CHECK_MS, CONTAINMENT_PROBE, canaryInstructions, containmentTargets } from '../../trust/canaries.js';
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

// A domain's cgroup limits (D2 §3.7): `pids.max` from `domain_tasks_max`,
// `memory.max` from `domain_memory_max`, `memory.swap.max` 0.
// In harness mode a test may cap an item's domains below the configured
// minimums (E69; seamDomainLimits); the limits are then those, written and
// read back like any other.
export function domainLimits(rt: Runtime, workItem: string): DomainLimits {
  const o = seamDomainLimits(workItem);
  return { memoryMax: o?.memory_max ?? rt.setting('domain_memory_max'), tasksMax: o?.pids_max ?? rt.setting('domain_tasks_max') };
}

// The volatile filesystem's bounds (D2 §§2.3, 3.7), likewise.
export function volatileBounds(rt: Runtime, workItem: string): { bytes: number; inodes: number } {
  const o = seamDomainLimits(workItem);
  return { bytes: o?.writable_bytes ?? rt.setting('domain_writable_bytes'), inodes: o?.writable_inodes ?? rt.setting('domain_writable_inodes') };
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
  // The failed repair checks' output records the claim names (D3 §2.10),
  // read as the API would serve them: only a record it serves, and only
  // bytes of its recorded size and hash. Anything else is missing to the
  // package, never copied (a quarantined record among them).
  const outputBytes = new Map<string, Buffer | null>();
  const outputIds = (claim.check_outputs ?? []).map((o) => o.output).filter((id): id is string => id !== null);
  if (outputIds.length > 0) {
    const rows = await rt.read<Record<string, { path: string; sha256: string | null; bytes: number | null } | null>>('records.paths', { project: claim.project, ids: outputIds });
    for (const id of outputIds) {
      const row = rows[id] ?? null;
      outputBytes.set(id, row === null ? null : await readRecordBytes(rt.home, row));
    }
  }
  const canary = claim.attempt
    ? canaryInstructions({
        attempt: claim.attempt.id,
        kind: claim.attempt.kind,
        deadlineSeconds: Math.max(1, Math.round((Date.parse(claim.deadline_at) - Date.now()) / 1000)),
      })
    : null;
  // The containment check's targets, for the domain init only (E83).
  const targets =
    claim.attempt?.kind === 'containment'
      ? containmentTargets({
          tokenPath: (() => {
            try {
              return realpathSync(join(rt.home, 'api.token'));
            } catch {
              return join(rt.home, 'api.token');
            }
          })(),
          apiPort: rt.config.values.api_port,
        })
      : null;
  let diff: (CandidateDiff & { engine_commits: EngineCommitsInRange }) | null = null;
  if (facts?.run.role === 'reviewer' && facts.candidate && facts.review) {
    // The base by git ancestry (E106; E129 item 10): unknown is said, never guessed.
    const base = await resolveDiffBase(repo, facts.review.diff_base, facts.candidate.revision);
    diff =
      base.unknown !== undefined
        ? {
            base: null,
            base_from: base.from,
            revision: facts.candidate.revision,
            state: 'unavailable',
            text: '',
            detail: base.unknown,
            engine_commits: { state: 'unknown', detail: base.unknown },
          }
        : {
            ...(await candidateDiff(repo, base, facts.candidate.revision)),
            engine_commits: await engineCommitsInRange(repo, base.revision, facts.candidate.revision, facts.review.revision_records),
          };
  }
  writeContextPackage(join(area, 'context'), claim, facts, {
    canary,
    diff,
    probe: claim.profile === 'probe',
    readRecord: (id) => {
      if (outputBytes.has(id)) return outputBytes.get(id) ?? null;
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
  const limits = domainLimits(rt, claim.work_item);
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
    const vb = volatileBounds(rt, claim.work_item);
    const writable = vb.bytes;
    plan = buildPlan({
      area,
      context: join(area, 'context'),
      workspace,
      readPaths: [...handle.readPaths, ...(backend.binds ?? []).filter((b) => !b.writable).map((b) => b.path)],
      writablePaths: [...new Set([...(backend.binds ?? []), ...seamSandboxBinds()].filter((b) => b.writable).map((b) => b.path))],
      binds,
      volBytes: writable,
      volInodes: vb.inodes,
      shmBytes: Math.min(writable, 64 * 1024 * 1024),
      tools: { mount: t.mount, umount: t.umount, pivot_root: t.pivot_root, ip: t.ip, unshare: t.unshare, setpriv: t.setpriv, mknod: t.mknod },
      node: engineNode(),
      initNodeCopy: await initNodeIn(area, copy),
      initScript: INIT_SCRIPT,
      probeProgram: targets !== null ? PROBE_PROGRAM : null,
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
    backend: {
      argv: [backend.command, ...backend.args],
      env,
      cwd: '/surety/workspace',
      stdin,
      forwarder: { port: FORWARDER_PORT, socket: EGRESS_SOCKET },
      ...(canary
        ? {
            canary: {
              barrier: canary.kind === 'cancellation' ? CANARY_BARRIER : null,
              containment:
                canary.kind === 'containment' && targets !== null
                  ? { program: CONTAINMENT_PROBE, actions: CONTAINMENT_ACTIONS.map((a) => a.name), targets, action_timeout_ms: 20_000, check_ms: CONTAINMENT_CHECK_MS }
                  : null,
            },
          }
        : {}),
    },
    unshare: t.unshare,
    egress,
  };
}

// The most of a candidate's diff the context package carries (D2 §1.3).
export const DIFF_CAP_BYTES = 2 * 1024 * 1024;

// The Reviewer's candidate diff (D2 §1.3; E41 item 4): from the base the
// store names to the candidate's revision, taken from the project's
// repository by the engine's own git. With no base, from the empty tree.
// What could not be taken is said, never given as an empty diff.
// The commits of the diff's range (E106): reachable from the candidate's
// revision and not from the base (with no base, every ancestor of it), each
// classified by the engine's records (store/reads.ts revisionRecords): a
// commit whose every record names no run is the engine's or the owner's; one
// a run recorded is a role's work and is not named; one with no record is
// named as unknown, never left out. A read that fails makes the whole answer
// unknown, never "none". At most RANGE_MAX commits are classified; beyond
// them the range is said to be unknown.
export const RANGE_MAX = 500;

// The first candidate's base (E106; E129 item 10; SEAM.md §299): of the
// project's recorded revisions, the one earliest in the candidate's own
// history (`git rev-list --reverse --topo-order`), and its parent; never the
// earliest by record time. A history that cannot be listed leaves the base
// unknown, said as such. Another base (the previous candidate's) is given
// as it is.
export async function resolveDiffBase(
  repo: string,
  base: { revision: string | null; from: string | null; recorded?: Record<string, string> },
  revision: string,
): Promise<{ revision: string | null; from: string | null; unknown?: string }> {
  if (base.from !== 'first_recorded_parent' || base.recorded === undefined) return { revision: base.revision, from: base.from };
  const unknown = (why: string) => ({ revision: null, from: base.from, unknown: why });
  if (!SHA.test(revision)) return unknown("the candidate's revision is not an object id, so the diff's base is unknown");
  const listed = await git(repoContext(repo), ['rev-list', '--reverse', '--topo-order', revision, '--']);
  if (listed.code !== 0) return unknown("the candidate's history could not be listed, so the diff's base is unknown");
  const root = listed.stdout.split('\n').find((sha) => sha.length > 0 && Object.prototype.hasOwnProperty.call(base.recorded, sha));
  if (root === undefined) return { revision: null, from: null };
  const parent = base.recorded[root]!;
  return SHA.test(parent) ? { revision: parent, from: base.from } : unknown("the recorded parent of the first revision is not an object id, so the diff's base is unknown");
}
export async function engineCommitsInRange(
  repo: string,
  base: string | null,
  revision: string,
  records: Record<string, { by_run: boolean; kinds: string[]; purpose: string | null }> | null | undefined,
): Promise<EngineCommitsInRange> {
  if (records === null || records === undefined) return { state: 'unknown', detail: "the engine's records of the project's commits could not be read" };
  if (!SHA.test(revision) || (base !== null && !SHA.test(base))) return { state: 'unknown', detail: 'a revision of the range is not an object id' };
  const listed = await git(repoContext(repo), ['rev-list', `--max-count=${RANGE_MAX + 1}`, base === null ? revision : `${base}..${revision}`, '--']);
  if (listed.code !== 0) return { state: 'unknown', detail: "the range's commits could not be listed" };
  const shas = listed.stdout.split('\n').filter((x) => x.length > 0);
  if (!shas.every((x) => SHA.test(x))) return { state: 'unknown', detail: "the range's commits could not be read" };
  const more = shas.length > RANGE_MAX;
  const engine: { sha: string; purpose: string }[] = [];
  const unrecorded: string[] = [];
  // Oldest first, as the history reads.
  for (const sha of shas.slice(0, RANGE_MAX).reverse()) {
    const r = records[sha];
    if (r === undefined) unrecorded.push(sha);
    else if (!r.by_run) engine.push({ sha, purpose: r.purpose ?? r.kinds[0] ?? 'engine_commit' });
  }
  return { state: 'known', commits: engine, unrecorded, more };
}

export async function candidateDiff(repo: string, base: { revision: string | null; from: string | null }, revision: string): Promise<CandidateDiff> {
  const ctx = repoContext(repo);
  const out = (state: CandidateDiff['state'], text: string, detail: string | null, from: string | null = base.revision): CandidateDiff => ({
    base: from,
    base_from: base.from,
    revision,
    state,
    text,
    detail,
  });
  if (!SHA.test(revision) || (base.revision !== null && !SHA.test(base.revision))) return out('unavailable', '', 'a revision is not an object id');
  let from = base.revision;
  if (from === null) {
    const empty = await git(ctx, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
    from = empty.code === 0 ? empty.stdout.trim() : null;
    if (from === null) return out('unavailable', '', 'the empty tree could not be named', null);
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', from, revision, '--'];
  const whole = await git(ctx, args);
  if (whole.code === 0) {
    const bytes = Buffer.from(whole.stdout, 'utf8');
    if (bytes.length <= DIFF_CAP_BYTES) return out('complete', whole.stdout, null, from);
    const cut = bytes.subarray(0, DIFF_CAP_BYTES);
    const end = cut.lastIndexOf(0x0a);
    return out('truncated', cut.subarray(0, end < 0 ? cut.length : end + 1).toString('utf8'), `${bytes.length} bytes, the first ${DIFF_CAP_BYTES} given`, from);
  }
  const why = whole.timedOut ? 'git diff passed its deadline or its output cap' : `git diff exited ${String(whole.code)}: ${whole.stderr.trim().slice(0, 200)}`;
  const stat = await git(ctx, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--stat=200', from, revision, '--']);
  if (stat.code === 0 && Buffer.byteLength(stat.stdout) <= DIFF_CAP_BYTES) return out('stat_only', stat.stdout, why, from);
  return out('unavailable', '', why, from);
}
