// The isolation probe suite (D2 §§2.8, 6 H9 and H10, 7.1, A.6; AR §8.1): run
// at every engine start in the `probe` profile, within `tick_step_budget`,
// with no model and no internet. Each probe attempts a forbidden action
// against a target the engine seeded and verified from the host side, paired
// with a control that shows the same operation usable without the
// restriction. A probe passes only if its target was seeded, its negative was
// attempted and denied as expected, and its control succeeded; a missing
// target, a failed control or an unattempted negative fails it; a probe that
// cannot run on this host is `not_exercised` and fails qualification unless
// the host class excuses it (P11 off WSL2). Every claim is corroborated from
// the host: the sentinel process still alive, the repository's configuration
// unchanged, the probe's host pid in the domain's cgroup, the counters the
// kernel kept.
//
// The probe program (probes/program.ts) runs inside each sandbox and fails
// closed; the engine's half of the guard is here: before it lets any probe
// sandbox start its program, the engine reads from the host that the
// sandbox's process 1 is in a pid namespace of its own (E64 item 2). The
// sandboxes are the launcher's and the domain init's, through SandboxLaunch,
// in probe cgroups of this engine's scope, emptied and removed afterwards.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { type DomainLimits, createDomainCgroup, readPopulated, readProcs, removeCgroup, verifyLimits, writeKill } from '../../boundary/cgroup.js';
import type { Scope } from '../../boundary/scope.js';
import { gitOk, repoContext } from '../../git/exec.js';
import { newId } from '../../ids.js';
import { type Runtime, log } from '../../runtime.js';
import { type ProbeOverride, seamProbeOverrides } from '../../testing/seam.js';
import { ECHO_HOST, echoEndpoint } from '../proxy/echo.js';
import { DomainProxy } from '../proxy/proxy.js';
import type { Resolver } from '../proxy/resolver.js';
import { PROBE_PROGRAM } from '../sandbox/context.js';
import { seedGitView, viewConfig } from '../sandbox/gitview.js';
import { type Plan, type PlannedMount, buildPlan, planFingerprint, plannedMounts, unescape } from '../sandbox/mounts.js';
import { FORWARDER_PORT, protectedBinds } from '../sandbox/prepare.js';
import type { ResolvedTools } from '../sandbox/tools.js';
import { engineNode } from '../sandbox/tools.js';
import { validateReadPaths } from '../sandbox/plan.js';
import { readRegular } from '../sandbox/volatile.js';
import { INIT_SCRIPT, SandboxLaunch } from '../sandboxed.js';
import { type ProbeFixture, probeFixture } from './fixture.js';
import { Sentinel, runHost } from './host.js';

type Obj = Record<string, unknown>;

export const PROBES = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);

// A probe's result (SEAM.md §138): the row's keys, and in the evidence its
// detail and what its negative met, in words.
export interface ProbeResult {
  id: string;
  target_seeded: boolean;
  negative: 'denied' | 'allowed' | 'not_attempted' | null;
  // Whether the control succeeded; null when it did not run.
  control: boolean | null;
  result: 'passed' | 'failed' | 'not_exercised';
  reason: string | null;
  detail: string;
  observed: string | null;
  // A host class that excuses a probe that could not run (P11 off WSL2; P20
  // in slice 12).
  excused?: string;
  // P2: each target its verdict counts, with the role's attempts at it.
  targets?: { kind: string; path: string; host_verified: boolean; attempts: { path: string; outcome: string; error: string | null }[] }[];
}

export const probeRow = (p: ProbeResult) => ({ id: p.id, target_seeded: p.target_seeded, negative: p.negative, control: p.control, result: p.result, reason: p.reason });

export interface SuiteOutcome {
  probes: ProbeResult[];
  // The probe sandbox's validated plan, published with the evidence.
  plan: { fingerprint: string; mounts: PlannedMount[] } | null;
  evidence: Obj;
}

const WIN_EXE = '/mnt/c/Windows/System32/cmd.exe';

// ---- probe sandboxes ---------------------------------------------------------------------------

interface BoxOptions {
  label: string;
  fixture: ProbeFixture | null;
  memoryMax: number;
  tasksMax: number;
  volBytes: number;
  volInodes: number;
  egress: { allow: string[]; resolver: Resolver } | null;
  context: (dir: string) => void;
  actions: Obj[];
  onLine?: (o: Obj, box: Box) => void | Promise<void>;
  // P20's boxes: the limits the host reads back before the program starts.
  limits?: DomainLimits;
}

interface Box {
  id: string;
  area: string;
  cgroup: string;
  sibling: string;
  plan: Plan;
  launch: SandboxLaunch;
  lines: Obj[];
  proxy: DomainProxy | null;
  hostRefusal: string | null;
  counters: { oom_kill: number | null; pids_max: number | null } | null;
  finished: boolean;
}

const BOX_ID = /^probe_[0-9A-HJKMNP-TV-Z]{26}$/;

function counters(path: string): { oom_kill: number | null; pids_max: number | null } {
  const read = (file: string, key: string): number | null => {
    try {
      const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(readFileSync(join(path, file), 'utf8'));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };
  return { oom_kill: read('memory.events', 'oom_kill'), pids_max: read('pids.events', 'max') };
}

// From the host: process 1 of the sandbox is in a pid namespace other than
// the engine's (its NSpid has two levels) before the program may start.
function containedFromHost(launcherPid: number, cgroup: string): string | null {
  let kids: number[];
  try {
    kids = readFileSync(`/proc/${launcherPid}/task/${launcherPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return "the launcher's children cannot be read";
  }
  if (kids.length !== 1) return `the launcher has ${kids.length} children, not the one init`;
  try {
    const line = readFileSync(`/proc/${kids[0]}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('NSpid:'));
    const ids = line ? line.slice(6).trim().split(/\s+/) : [];
    if (ids.length < 2 || ids.at(-1) !== '1') return `the init's NSpid is ${ids.join(' ') || 'unreadable'}`;
    if (readlinkSync(`/proc/${kids[0]}/ns/pid`) === readlinkSync('/proc/self/ns/pid')) return "the init is in the engine's pid namespace";
    if (!(readProcs(cgroup) ?? []).includes(kids[0]!)) return `the init is not a member of ${cgroup}`;
  } catch {
    return "the init's pid namespace cannot be read";
  }
  return null;
}

// The second half of the engine's guard for a box whose program exhausts a
// limit (P20): the box's own limit files, read from the host, say what the
// suite wrote, and each is small.
function limitsFromHost(cgroup: string, limits: DomainLimits): string | null {
  const wrong = verifyLimits(cgroup, limits);
  if (wrong !== null) return `the box's limits do not read as written: ${wrong}`;
  if (limits.tasksMax > P20_MAX.tasksMax || limits.memoryMax > P20_MAX.memoryMax) return `the box's limits ${JSON.stringify(limits)} are not small`;
  return null;
}

// P20's boxes (D2 A.6 P20; M2 plan §2.6, "the small caps used for P20"). The
// pids and memory caps leave room for the box's own init and program (two
// node processes and unshare); the storage caps are D2's preamble's.
type P20Kind = 'pids' | 'memory' | 'bytes' | 'inodes';
const P20_KINDS: readonly P20Kind[] = ['pids', 'memory', 'bytes', 'inodes'];
const MIB = 1024 * 1024;
// E69 (Sean): `pids.max` 64 and `memory.max` 64 MiB, `memory.swap.max` 0;
// the program stops itself at 96 tasks and 128 MiB whatever the cgroup does.
const P20_CAPS: Record<P20Kind, { memoryMax: number; tasksMax: number; volBytes: number; volInodes: number }> = {
  pids: { memoryMax: 64 * MIB, tasksMax: 64, volBytes: MIB, volInodes: 256 },
  memory: { memoryMax: 64 * MIB, tasksMax: 64, volBytes: MIB, volInodes: 256 },
  bytes: { memoryMax: 64 * MIB, tasksMax: 64, volBytes: MIB, volInodes: 256 },
  inodes: { memoryMax: 64 * MIB, tasksMax: 64, volBytes: MIB, volInodes: 64 },
};
const P20_MAX = { tasksMax: 64, memoryMax: 64 * MIB };
// Why P20 does not run on a host not designated for it (E69).
export const P20_NOT_DESIGNATED = 'host not designated for exhaustion probes (isolation_probe_exhaustion is false); excused, not claimed';

async function openBox(rt: Runtime, scope: Scope, tools: ResolvedTools, initCopy: string, o: BoxOptions): Promise<Box> {
  const t = tools.paths;
  const id = newId('probe_');
  // The area by its real path: the plan and the hold name what the setup
  // stage's mount namespace resolves, whatever links the home is reached by.
  const made = join(rt.home, 'domains', id);
  for (const d of ['root', 'vol', 'context', 'git', 'workspace']) mkdirSync(join(made, d), { recursive: true, mode: 0o700 });
  const area = realpathSync(made);
  o.context(join(area, 'context'));
  copyFileSync(PROBE_PROGRAM, join(area, 'context', 'probe'));
  const cgroup = join(scope.path, id);
  const sibling = join(scope.path, `sibling_${id}`);
  createDomainCgroup(cgroup, { memoryMax: o.memoryMax, tasksMax: o.tasksMax });
  createDomainCgroup(sibling, { memoryMax: o.memoryMax, tasksMax: o.tasksMax });
  let proxy: DomainProxy | null = null;
  if (o.egress) {
    proxy = new DomainProxy({
      area,
      domain: id,
      run: null,
      invocation: null,
      profile: 'probe',
      allow: o.egress.allow,
      limits: { resolveTimeoutMs: 1000, connectTimeoutMs: 1000, tunnelMaxMs: 10_000, tunnelsMax: 8, bufferMaxBytes: 1024 * 1024, logMaxBytes: 256 * 1024 },
      resolver: o.egress.resolver,
      echo: echoEndpoint,
    });
    await proxy.listen();
  }
  const f = o.fixture;
  const git = f ? seedGitView({ repo: f.repo, adminDir: f.adminDir, seed: join(area, 'git'), head: f.head }) : null;
  const plan = buildPlan({
    area,
    context: join(area, 'context'),
    workspace: f ? realpathSync(f.worktree) : join(area, 'workspace'),
    readPaths: [],
    writablePaths: [],
    binds: [
      { source: cgroup, target: '/surety/cgroup/domain', writable: true, noexec: true },
      { source: sibling, target: '/surety/cgroup/sibling', writable: true, noexec: true },
    ],
    volBytes: o.volBytes,
    volInodes: o.volInodes,
    shmBytes: 1024 * 1024,
    tools: { mount: t.mount!, umount: t.umount!, pivot_root: t.pivot_root!, ip: t.ip!, unshare: t.unshare!, setpriv: t.setpriv!, mknod: t.mknod! },
    node: engineNode(),
    initNodeCopy: initCopy,
    initScript: INIT_SCRIPT,
    git,
    workspaceBinds: f ? protectedBinds(f.worktree, f.protectedRoots, join(area, 'git', 'empty')) : [],
    egressSocket: proxy?.socketPath ?? null,
    holdVolatile: true,
  });
  const box: Box = { id, area, cgroup, sibling, plan, launch: null as unknown as SandboxLaunch, lines: [], proxy, hostRefusal: null, counters: null, finished: false };
  const instructions = `${JSON.stringify({ host_pid_ns: readlinkSync('/proc/self/ns/pid'), actions: o.actions })}\n`;
  const launch = new SandboxLaunch(
    { domain: id, invocation: id, incarnation: rt.incarnation, generation: 0, cgroup, unshare: t.unshare!, node: engineNode() },
    {
      // The engine's half of the guard: nothing of the program starts unless
      // the host sees process 1 of the sandbox in a pid namespace of its own.
      barrier: async () => {
        const why = containedFromHost(launch.pid, cgroup) ?? (o.limits ? limitsFromHost(cgroup, o.limits) : null);
        if (why !== null) {
          box.hostRefusal = why;
          launch.closed = true;
        }
      },
      placed: async () => {},
      authorize: async () => true,
      plan: () => plan,
      backend: () => ({
        argv: [engineNode(), '--no-warnings', '/surety/context/probe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/surety/home' },
        cwd: '/surety/workspace',
        stdin: instructions,
        forwarder: proxy ? { port: FORWARDER_PORT, socket: '/.init/egress.sock' } : null,
      }),
      started: async () => {},
      setupFailed: () => {},
    },
  );
  box.launch = launch;
  let partial = '';
  launch.output.on('data', (d: Buffer) => {
    partial += d.toString('utf8');
    let at: number;
    while ((at = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, at);
      partial = partial.slice(at + 1);
      try {
        const obj = JSON.parse(line) as Obj;
        box.lines.push(obj);
        if (o.onLine) void Promise.resolve(o.onLine(obj, box)).catch((err) => log('probe suite', err, { box: id }));
      } catch {
        // not a report line
      }
    }
  });
  void launch.backendDone.then(() => launch.ackExit());
  return box;
}

// Wait for the box's launcher to exit, or the deadline.
async function awaitBox(box: Box, deadline: number): Promise<void> {
  const remaining = Math.max(200, deadline - Date.now());
  box.finished = await Promise.race([box.launch.launcherExited.then(() => true), sleep(remaining).then(() => false)]);
}

// The box emptied and removed: its cgroup (through the guarded writes of
// boundary/cgroup.ts, a probe cgroup of this engine's own scope), its
// launcher (this engine's child), its proxy, its hold of the volatile
// filesystem, its area (`<home>/domains/probe_<ULID>`).
async function closeBox(rt: Runtime, box: Box): Promise<void> {
  if (!box.finished) {
    writeKill(box.cgroup);
    await box.launch.killUnplaced(rt.setting('kill_grace') * 1000);
  }
  box.counters ??= counters(box.cgroup);
  for (let i = 0; i < 40; i++) {
    const p = readPopulated(box.cgroup);
    if (p.state !== 'populated' || p.value === 0) break;
    writeKill(box.cgroup);
    await sleep(50);
  }
  removeCgroup(box.cgroup);
  removeCgroup(box.sibling);
  await box.proxy?.close().catch(() => {});
  box.launch.releaseVolatile();
  if (BOX_ID.test(box.id)) rmSync(join(rt.home, 'domains', box.id), { recursive: true, force: true });
}

const line = (box: Box, id: string): Obj | null => box.lines.find((l) => l.id === id) ?? null;

// ---- what a suite leaves outside its sandboxes, and the sweep of it ---------------------------

// The tag of the suite in progress, recorded in the home before the suite
// makes anything outside it, so that the next start sweeps exactly what this
// home's suite made: nothing of another home's or another user's.
const TAG_FILE = 'probe-tag';
const TAG = /^[0-9a-f]{12}$/;
export const probeTmpDir = (tag: string): string => `/tmp/surety-probe-${tag}`;
export const probeShmFile = (tag: string): string => `/dev/shm/surety-probe-${tag}`;
const SANDBOX_LEFTOVERS = /^(probe-ws2-|probe-role-|probe-fifo-)/;

// At the start of a suite: what an earlier one of this home left, by a crash
// during it. The home's own probe areas (`<home>/domains/probe_<ULID>`) and
// scratch entries (`<home>/sandbox/probe-ws2-*`, `probe-role-*`,
// `probe-fifo-*`); outside the home only the two exact names the recorded tag
// gives, each removed only if it is what the suite made (a directory or a
// regular file of this uid, never a link), the directory only with its one
// socket and only when nothing else is in it.
export function sweepProbeLeftovers(home: string): string[] {
  const swept: string[] = [];
  const uid = process.getuid?.() ?? -1;
  const domains = join(home, 'domains');
  try {
    for (const n of readdirSync(domains)) {
      if (!BOX_ID.test(n)) continue;
      rmSync(join(domains, n), { recursive: true, force: true });
      swept.push(join(domains, n));
    }
  } catch {
    // no domains yet
  }
  const sandbox = join(home, 'sandbox');
  try {
    for (const n of readdirSync(sandbox)) {
      if (!SANDBOX_LEFTOVERS.test(n)) continue;
      rmSync(join(sandbox, n), { recursive: true, force: true });
      swept.push(join(sandbox, n));
    }
  } catch {
    // no sandbox directory yet
  }
  let tag = '';
  try {
    tag = readFileSync(join(sandbox, TAG_FILE), 'utf8').trim();
  } catch {
    return swept;
  }
  if (!TAG.test(tag)) return swept;
  const shm = probeShmFile(tag);
  try {
    const st = lstatSync(shm);
    if (st.isFile() && st.uid === uid) {
      rmSync(shm);
      swept.push(shm);
    }
  } catch {
    // not there
  }
  const dir = probeTmpDir(tag);
  try {
    const st = lstatSync(dir);
    if (st.isDirectory() && st.uid === uid) {
      const sock = join(dir, 'listening.sock');
      try {
        const ss = lstatSync(sock);
        if (ss.isSocket() && ss.uid === uid) rmSync(sock);
      } catch {
        // no socket
      }
      rmdirSync(dir);
      swept.push(dir);
    }
  } catch {
    // not there, or not empty: left
  }
  rmSync(join(sandbox, TAG_FILE), { force: true });
  return swept;
}

// ---- the suite's own resolver (P8) -------------------------------------------------------------

// Constructed answers, counted: the suite needs no DNS and no internet.
export function suiteResolver(answers: Record<string, string[][]>): Resolver & { queries: Map<string, number> } {
  const queries = new Map<string, number>();
  return {
    queries,
    async resolve(name: string) {
      const n = (queries.get(name) ?? 0) + 1;
      queries.set(name, n);
      const list = answers[name];
      if (!list) throw Object.assign(new Error(`no name ${name}`), { code: 'ENOTFOUND' });
      return [...list[Math.min(n - 1, list.length - 1)]!];
    },
  };
}

// ---- the mount table against the plan (P12) ------------------------------------------------------

const FORBIDDEN_FS = ['9p', 'drvfs', 'virtiofs', 'fuse', 'fuse.drvfs', 'nfs', 'cifs'];

export function compareMounts(mountinfo: string[], planned: PlannedMount[]): { equal: boolean; detail: string } {
  const seen = mountinfo.map((l) => {
    const fields = l.split(' ');
    const dash = fields.indexOf('-');
    return { target: unescape(fields[4] ?? ''), opts: (fields[5] ?? '').split(','), fstype: fields[dash + 1] ?? '' };
  });
  const problems: string[] = [];
  for (const s of seen) if (FORBIDDEN_FS.includes(s.fstype)) problems.push(`${s.target} is a ${s.fstype} mount`);
  const want = planned.map((p) => p.target).sort();
  const got = seen.map((s) => s.target).sort();
  const missing = want.filter((x, i) => want.indexOf(x) === i && want.filter((y) => y === x).length > got.filter((y) => y === x).length);
  const extra = got.filter((x, i) => got.indexOf(x) === i && got.filter((y) => y === x).length > want.filter((y) => y === x).length);
  if (missing.length > 0) problems.push(`not mounted: ${missing.slice(0, 5).join(', ')}`);
  if (extra.length > 0) problems.push(`mounted beyond the plan: ${extra.slice(0, 5).join(', ')}`);
  for (const p of planned) {
    const s = seen.find((x) => x.target === p.target);
    if (!s) continue;
    if (p.ro !== s.opts.includes('ro')) problems.push(`${p.target} is ${s.opts.includes('ro') ? 'read-only' : 'writable'}, the plan says ${p.ro ? 'read-only' : 'writable'}`);
    if (p.type !== 'bind' && p.type !== s.fstype) problems.push(`${p.target} is ${s.fstype}, the plan says ${p.type}`);
  }
  return { equal: problems.length === 0, detail: problems.length === 0 ? `${seen.length} mounts, each the plan's, in no other place` : problems.join('; ') };
}

// ---- the suite ---------------------------------------------------------------------------------

interface Ctx {
  overrides: Record<string, ProbeOverride>;
  wsl2: boolean;
}

function verdict(ctx: Ctx, id: string, r: { seeded: boolean; negative: string | null; held: boolean; control: boolean | null; detail: string }): ProbeResult {
  const o = ctx.overrides[id];
  const seeded = o === 'target_absent' ? false : r.seeded;
  const control = o === 'control_failing' ? false : r.control;
  const observed = o === 'negative_unattempted' ? null : r.negative;
  const negative = observed === null ? 'not_attempted' : r.held ? 'denied' : 'allowed';
  const passed = seeded && negative === 'denied' && control === true;
  const why = !seeded ? 'its target was not seeded or not verified from the host' : negative === 'not_attempted' ? 'its negative was not attempted' : negative === 'allowed' ? 'its negative was not denied as expected' : control !== true ? 'its control did not succeed' : null;
  const note = o ? ` (override: ${o})` : '';
  return { id, target_seeded: seeded, negative, control, result: passed ? 'passed' : 'failed', reason: why === null ? null : `${why}${note}`, detail: `${r.detail}${note}`, observed };
}

const notRun = (id: string, why: string, excused?: string): ProbeResult => ({ id, target_seeded: false, negative: null, control: null, result: 'not_exercised', reason: why, detail: why, observed: null, ...(excused ? { excused } : {}) });

const DENIED_ABSENT = ['ENOENT', 'ENOTDIR'];

export async function runProbeSuite(rt: Runtime, args: { scope: Scope | null; tools: ResolvedTools; initCopy: string | null; deadline: number; wsl2: boolean }): Promise<SuiteOutcome> {
  const overrides = seamProbeOverrides();
  const ctx: Ctx = { overrides, wsl2: args.wsl2 };
  const all = (why: string): SuiteOutcome => ({ probes: PROBES.map((id) => notRun(id, why)), plan: null, evidence: { reason: why } });
  if (args.scope === null) return all('the engine has no incarnation scope, so no probe sandbox can be placed (H3)');
  if (args.initCopy === null || args.tools.missing.length > 0) return all(`the sandbox cannot be built: ${args.tools.missing.join(', ') || "the domain init's copy of node is missing"}`);
  const fixture = await probeFixture(rt.home).catch((err) => {
    log('probe suite', err, { what: 'fixture' });
    return null;
  });
  if (fixture === null) return all('the probe fixture repository could not be made');

  const home = rt.home;
  const realHome = realpathSync(home);
  const port = rt.config.values.api_port;
  const tag = randomBytes(6).toString('hex');
  // What an earlier suite of this home left was swept before the start-up
  // trial and this suite began (trust/checks.ts); this suite's tag is
  // recorded before it makes anything outside the home.
  writeFileSync(join(home, 'sandbox', TAG_FILE), `${tag}\n`, { mode: 0o600 });
  const run = (id: string) => overrides[id] !== 'cannot_run';
  const neg = (id: string) => run(id) && overrides[id] !== 'negative_unattempted';
  const cleanups: (() => void | Promise<void>)[] = [];
  const evidence: Obj = {};

  // ---- seeded targets, verified from the host ----
  const readable = (p: string): boolean => {
    try {
      closeSync(openSync(p, 'r'));
      return true;
    } catch {
      return false;
    }
  };
  // P1: the real api.token, and its aliases.
  const token = join(home, 'api.token');
  const tokenForms = [...new Set([token, join(realHome, 'api.token'), `/proc/self/root${realHome}/api.token`, `/surety/..${realHome}/api.token`, `/surety/workspace/../..${realHome}/api.token`])];
  // P2: the store, the lock, the engine log, a record, another domain's
  // area: each seeded (made where the home has none yet) and read back from
  // the host before the instructions are written, so that every target the
  // probe counts is one the role is told to open (D2 A.6 P2; SEAM.md §138).
  const engineLog = join(home, 'engine.log');
  // A target with content: where the home has no engine log yet, the suite
  // starts one with a line of its own; an existing log is left as it is.
  if (!existsSync(engineLog)) writeFileSync(engineLog, `${JSON.stringify({ log: 'info', at: new Date().toISOString(), what: 'engine log started by the isolation probe suite', tag })}\n`, { mode: 0o600, flag: 'wx' });
  mkdirSync(join(home, 'records'), { recursive: true, mode: 0o700 });
  const recordSentinel = join(home, 'records', `probe-sentinel-${tag}`);
  writeFileSync(recordSentinel, tag, { mode: 0o600 });
  cleanups.push(() => rmSync(recordSentinel, { force: true }));
  const otherArea = join(home, 'domains', newId('probe_'));
  mkdirSync(otherArea, { recursive: true, mode: 0o700 });
  writeFileSync(join(otherArea, 'sentinel'), tag, { mode: 0o600 });
  cleanups.push(() => {
    if (BOX_ID.test(otherArea.slice(otherArea.lastIndexOf('/') + 1))) rmSync(otherArea, { recursive: true, force: true });
  });
  const p2Targets: { kind: string; path: string }[] = [
    { kind: 'store', path: join(home, 'store.db') },
    { kind: 'engine_lock', path: join(home, 'engine.lock') },
    { kind: 'engine_log', path: engineLog },
    { kind: 'record', path: recordSentinel },
    { kind: 'other_domain', path: join(otherArea, 'sentinel') },
  ];
  try {
    const rec = readdirSync(join(home, 'records')).find((n) => n.startsWith('rec_') && !n.endsWith('.tmp'));
    if (rec) p2Targets.push({ kind: 'record', path: join(home, 'records', rec) });
  } catch {
    // the record sentinel stands for the records
  }
  // Each target by its host path, by its real path and through
  // /proc/self/root: the role's attempts at it.
  const aliasesOf = (path: string): string[] => {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // judged as given
    }
    return [...new Set([path, real, `/proc/self/root${real}`])];
  };
  const p2 = p2Targets.flatMap((t) => aliasesOf(t.path));
  // P3: a second populated workspace and a developer checkout.
  const ws2 = mkdtempSync(join(home, 'sandbox', 'probe-ws2-'));
  writeFileSync(join(ws2, 'sentinel.txt'), `second workspace ${tag}\n`);
  cleanups.push(() => rmSync(ws2, { recursive: true, force: true }));
  const p3 = [join(ws2, 'sentinel.txt'), join(fixture.repo, 'sentinel.txt')];
  // Each target read back from the host now, before any instruction names it.
  const seededP2 = Object.fromEntries(p2Targets.map((t) => [t.path, readable(t.path)]));
  const seededP3 = Object.fromEntries(p3.map((t) => [t, readable(t)]));
  const seededToken = readable(token);
  // P4, P5: the fixture repository's configuration and hooks, as the host sees them.
  const configHash = () => {
    try {
      return createHash('sha256').update(readFileSync(join(fixture.repo, '.git', 'config'))).digest('hex');
    } catch {
      return null;
    }
  };
  const hooksList = () => {
    try {
      return readdirSync(join(fixture.repo, '.git', 'hooks')).sort().join(',');
    } catch {
      return null;
    }
  };
  const configBefore = configHash();
  const hooksBefore = hooksList();
  // P6, P7: the engine's own listener, alive from the host.
  const hostAddrs = [...new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => !a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80'))).map((a) => a.address)))];
  const listenerAlive = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
  // P9: a host abstract socket and a host pathname socket in a directory a
  // project could propose for `sandbox_read_paths`, both listening.
  const abstractName = `surety-probe-${tag}`;
  const abstractServer = net.createServer((c) => c.destroy());
  const abstractUp = await new Promise<boolean>((resolve) => {
    abstractServer.once('error', () => resolve(false));
    abstractServer.listen(`\0${abstractName}`, () => resolve(true));
  });
  cleanups.push(() => void abstractServer.close());
  const sockDir = probeTmpDir(tag);
  mkdirSync(sockDir, { mode: 0o700 });
  const sockPath = join(sockDir, 'listening.sock');
  const pathServer = net.createServer((c) => c.destroy());
  const pathUp = await new Promise<boolean>((resolve) => {
    pathServer.once('error', () => resolve(false));
    pathServer.listen(sockPath, () => resolve(true));
  });
  cleanups.push(async () => {
    await new Promise<void>((r) => pathServer.close(() => r()));
    rmSync(sockPath, { force: true });
    try {
      rmdirSync(sockDir);
    } catch {
      // not empty: left for the operator
    }
  });
  // P10: the user bus, Docker, WSL's runtime directory, a host /dev/shm sentinel.
  const uid = process.getuid?.() ?? 1000;
  const p10Candidates = [`/run/user/${uid}/bus`, '/var/run/docker.sock', '/run/docker.sock'];
  try {
    for (const n of readdirSync('/run/WSL')) p10Candidates.push(join('/run/WSL', n));
  } catch {
    // no WSL runtime directory
  }
  const shmSentinel = probeShmFile(tag);
  let shmSeeded = false;
  try {
    closeSync(openSync(shmSentinel, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    shmSeeded = true;
    cleanups.push(() => rmSync(shmSentinel, { force: true }));
  } catch {
    shmSeeded = false;
  }
  const exists = (p: string) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const p10 = [...p10Candidates.filter(exists), ...(shmSeeded ? [shmSentinel] : [])];
  const dockerPresent = ['/var/run/docker.sock', '/run/docker.sock'].some(exists);
  // P11: a valid, harmless Windows executable (E59 item 4), copied into the
  // sandbox's context to be executed there.
  const winPresent = args.wsl2 && exists(WIN_EXE);
  const marker = `surety-probe-${tag}`;
  // P13: a host sentinel process, outside every domain.
  const sentinel = new Sentinel(60);
  cleanups.push(() => sentinel.end());
  // P18: a host FIFO the role's result may name.
  const fifo = join(home, 'sandbox', `probe-fifo-${tag}`);
  const fifoMade = (await runHost('/usr/bin/mkfifo', ['-m', '0600', fifo])).status === 0;
  cleanups.push(() => rmSync(fifo, { force: true }));

  // ---- P8: the suite's resolver ----
  const names = {
    private: 'probe-private.surety.invalid',
    mixed: 'probe-mixed.surety.invalid',
    loop6: 'probe-loop6.surety.invalid',
    ula: 'probe-ula.surety.invalid',
    mapped: 'probe-mapped.surety.invalid',
    rebind: 'probe-rebind.surety.invalid',
    unlisted: 'probe-unlisted.surety.invalid',
  };
  const resolver = suiteResolver({
    [names.private]: [['10.1.2.3']],
    [names.mixed]: [['192.0.2.10', '192.168.1.10']],
    [names.loop6]: [['::1']],
    [names.ula]: [['fd00::1']],
    [names.mapped]: [['::ffff:127.0.0.1']],
    // The first answer validates (a documentation address, routed nowhere:
    // the connection is attempted to it and times out); the second is
    // loopback and is refused.
    [names.rebind]: [['192.0.2.77'], ['127.0.0.1']],
  });
  const echoBytes = randomBytes(64);

  // ---- the main probe sandbox ----
  const box: Obj[] = [];
  const add = (probe: string, a: Obj, kind: 'negative' | 'control') => {
    if (kind === 'negative' ? neg(probe) : run(probe)) box.push(a);
  };
  add('P1', { id: 'p1', kind: 'open', paths: tokenForms }, 'negative');
  add('P2', { id: 'p2', kind: 'open', paths: p2 }, 'negative');
  add('P2', { id: 'p2fds', kind: 'fds' }, 'negative');
  add('P3', { id: 'p3', kind: 'open', paths: p3 }, 'negative');
  add('P3', { id: 'p3c', kind: 'read', path: `/surety/workspace/${fixture.sentinel.path}` }, 'control');
  add('P4', { id: 'p4', kind: 'git', commands: [['rev-parse', '--git-path', 'config'], ['config', 'probe.x', 'y'], ['config', '--list', '--show-origin']] }, 'negative');
  add('P5', { id: 'p5', kind: 'git', commands: [['rev-parse', '--git-path', 'hooks']] }, 'negative');
  add('P5', { id: 'p5w', kind: 'attempts', ops: [{ op: 'create', path: '/surety/git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' }] }, 'negative');
  add('P5', { id: 'p5l', kind: 'exec', argv: ['/usr/bin/ls', '-A', '/surety/git/hooks'] }, 'negative');
  const p6Targets = [{ host: '127.0.0.1', port }, { host: '::1', port }, ...hostAddrs.map((a) => ({ host: a, port }))];
  add('P6', { id: 'p6', kind: 'connect', targets: p6Targets }, 'negative');
  add('P6', { id: 'p6c', kind: 'connect', targets: [{ host: '127.0.0.1', port: FORWARDER_PORT }] }, 'control');
  add('P7', { id: 'p7', kind: 'http', host: '127.0.0.1', port, path: '/v1/token/bootstrap' }, 'negative');
  const p7Requests = [{ authority: `127.0.0.1:${port}` }, { authority: `[::1]:${port}` }, ...hostAddrs.map((a) => ({ authority: a.includes(':') ? `[${a}]:${port}` : `${a}:${port}` }))];
  add('P7', { id: 'p7p', kind: 'tunnels', port: FORWARDER_PORT, requests: p7Requests }, 'negative');
  add('P8', { id: 'p8', kind: 'tunnels', port: FORWARDER_PORT, requests: [names.unlisted, names.private, names.mixed, names.loop6, names.ula, names.mapped, names.rebind, names.rebind].map((n) => ({ authority: `${n}:443` })) }, 'negative');
  add('P8', { id: 'p8c', kind: 'tunnels', port: FORWARDER_PORT, requests: [{ authority: `${ECHO_HOST}:443`, send: echoBytes.toString('base64') }] }, 'control');
  add('P9', { id: 'p9', kind: 'connect', targets: [{ abstract: abstractName }] }, 'negative');
  add('P9', { id: 'p9c', kind: 'own_socket' }, 'control');
  add('P10', { id: 'p10', kind: 'open', paths: p10 }, 'negative');
  add('P10', { id: 'p10c', kind: 'write_read', path: `/dev/shm/probe-own-${tag}`, content: tag }, 'control');
  if (winPresent) add('P11', { id: 'p11', kind: 'exec', argv: ['/surety/context/win.exe', '/c', 'echo', marker] }, 'negative');
  add('P12', { id: 'p12', kind: 'mountinfo' }, 'negative');
  add('P14', { id: 'p14', kind: 'status' }, 'negative');
  add('P14', { id: 'p14c', kind: 'write_read', path: `/surety/workspace/probe-own-${tag}.txt`, content: tag }, 'control');
  add('P15', { id: 'p15', kind: 'cgroup_migrate', to: '/surety/cgroup/sibling', linger_ms: 400 }, 'negative');
  add('P17', { id: 'p17', kind: 'exec', argv: ['/usr/bin/systemd-run', '--user', '--quiet', '/usr/bin/true'], timeout_ms: 4000 }, 'negative');
  const resultMax = rt.setting('result_max_bytes');
  add('P18', { id: 'p18', kind: 'results', dir: '/surety/out', host_fifo: fifo, oversize: resultMax + 1, regular: JSON.stringify({ status: 'completed', summary: tag }) }, 'negative');
  const ws = '/surety/workspace';
  add(
    'P19',
    {
      id: 'p19',
      kind: 'attempts',
      ops: [
        { op: 'write', path: `${ws}/.surety/checks/check.txt` },
        { op: 'truncate', path: `${ws}/.surety/checks/check.txt` },
        { op: 'create', path: `${ws}/.surety/checks/new-${tag}.txt` },
        { op: 'rename', path: `${ws}/.surety/checks/check.txt`, to: `${ws}/moved-${tag}.txt` },
        { op: 'rename', path: `${ws}/src/source.txt`, to: `${ws}/PROTECTED.md` },
        { op: 'link', path: `${ws}/PROTECTED.md`, to: `${ws}/hardlink-${tag}.md` },
        { op: 'symlink_write', path: `${ws}/PROTECTED.md`, to: `${ws}/alias-${tag}.md` },
        { op: 'chmod', path: `${ws}/PROTECTED.md` },
        { op: 'write', path: `${ws}/PROTECTED.md` },
      ],
    },
    'negative',
  );
  const p19Ops = ((box.find((a) => a.id === 'p19')?.ops as unknown[] | undefined) ?? []).length;
  add('P19', { id: 'p19c', kind: 'write_read', path: `${ws}/src/probe-${tag}.txt`, content: tag }, 'control');
  // P13 last: it signals every process the program can see.
  add('P13', { id: 'p13', kind: 'signal_all' }, 'negative');

  const tools = args.tools;
  const scope = args.scope;
  const initCopy = args.initCopy;
  let p15Host: { found: boolean; inDomain: boolean; inSibling: boolean; detail: string } | null = null;
  const big = 1024 * 1024 * 1024;
  const opened: Box[] = [];
  let main: Box;
  try {
    main = await openBox(rt, scope, tools, initCopy, {
      label: 'main',
      fixture,
      memoryMax: big,
      tasksMax: 256,
      volBytes: 16 * 1024 * 1024,
      volInodes: 4096,
      egress: { allow: [names.private, names.mixed, names.loop6, names.ula, names.mapped, names.rebind], resolver },
      context: (dir) => {
        if (winPresent) copyFileSync(WIN_EXE, join(dir, 'win.exe'));
      },
      actions: box,
      onLine: (o, b) => {
        if (o.id !== 'p15') return;
        // From the host, while the program lingers: where its process is.
        const pid = Number(o.pid);
        const members = readProcs(b.cgroup) ?? [];
        const host = members.find((m) => {
          try {
            const ns = readFileSync(`/proc/${m}/status`, 'utf8')
              .split('\n')
              .find((l) => l.startsWith('NSpid:'));
            return ns !== undefined && ns.slice(6).trim().split(/\s+/).at(-1) === String(pid);
          } catch {
            return false;
          }
        });
        const sib = readProcs(b.sibling) ?? [];
        p15Host = {
          found: host !== undefined,
          inDomain: host !== undefined && members.includes(host),
          inSibling: host !== undefined && sib.includes(host),
          detail: host !== undefined ? `host pid ${host} in ${b.cgroup}` : `no member of ${b.cgroup} has inner pid ${pid}`,
        };
      },
    });
    opened.push(main);
  } catch (err) {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
    return all(`the probe sandbox could not be prepared: ${(err as Error).message}`);
  }

  // ---- P16: a daemon that leaves its session; the engine kills the domain ----
  let p16: { daemon: number | null; hostPid: number | null; env: number | null; session: boolean; killed: boolean; witnessStill: boolean | null; detail: string } | null = null;
  const p16Box = run('P16')
    ? await openBox(rt, scope, tools, initCopy, {
        label: 'p16',
        fixture: null,
        memoryMax: big,
        tasksMax: 64,
        volBytes: 1024 * 1024,
        volInodes: 256,
        egress: null,
        context: () => {},
        actions: [...(neg('P16') ? [{ id: 'p16', kind: 'daemon', witness: '/surety/out/p16.witness' }] : []), { id: 'hold', kind: 'exec', argv: ['/usr/bin/sleep', '8'], timeout_ms: 9000 }],
        onLine: async (o, b) => {
          if (o.id !== 'p16') return;
          const inner = Number(o.daemon_pid);
          let hostPid: number | null = null;
          for (const m of readProcs(b.cgroup) ?? []) {
            try {
              const ns = readFileSync(`/proc/${m}/status`, 'utf8').split('\n').find((l) => l.startsWith('NSpid:'));
              if (ns && ns.slice(6).trim().split(/\s+/).at(-1) === String(inner)) hostPid = m;
            } catch {
              // gone
            }
          }
          let env: number | null = null;
          let session = false;
          if (hostPid !== null) {
            try {
              env = readFileSync(`/proc/${hostPid}/environ`).length;
            } catch {
              env = null;
            }
            try {
              const stat = readFileSync(`/proc/${hostPid}/stat`, 'utf8');
              const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
              // Its session id, as the sandbox numbers it, is its own pid.
              const nsSid = readFileSync(`/proc/${hostPid}/status`, 'utf8').split('\n').find((l) => l.startsWith('NSsid:'));
              session = nsSid ? nsSid.slice(6).trim().split(/\s+/).at(-1) === String(inner) : Number(fields[3]) === hostPid;
            } catch {
              session = false;
            }
          }
          // The witness file grows while the daemon lives.
          const witnessSize = () => {
            const r = b.launch.volatile ? readRegular(b.launch.volatile.vol, 'out/p16.witness', 1024 * 1024) : null;
            return r && r.state === 'read' ? r.bytes.length : null;
          };
          // Before the kill: the witness written, and growing.
          let first = witnessSize();
          for (let i = 0; i < 40 && (first === null || first === 0); i++) {
            await sleep(25);
            first = witnessSize();
          }
          let grew = first;
          for (let i = 0; i < 20 && grew !== null && first !== null && grew <= first; i++) {
            await sleep(50);
            grew = witnessSize();
          }
          // cgroup.kill on the probe domain, a cgroup of this engine's scope.
          const k = writeKill(b.cgroup);
          let empty = false;
          for (let i = 0; i < 60 && !empty; i++) {
            const p = readPopulated(b.cgroup);
            empty = p.state === 'populated' && p.value === 0;
            if (!empty) await sleep(50);
          }
          b.finished = true;
          const after = witnessSize();
          await sleep(300);
          const later = witnessSize();
          p16 = {
            daemon: inner,
            hostPid,
            env,
            session,
            killed: k.state === 'written' && empty,
            witnessStill: first !== null && grew !== null && after !== null && later !== null ? grew > first && after === later : null,
            detail: `daemon inner pid ${inner}, host pid ${hostPid ?? 'not found'} in the domain before the kill; environ ${env ?? '?'} bytes; own session ${session}; cgroup.kill ${k.state}, populated 0 ${empty}; witness ${first ?? '?'} → ${grew ?? '?'} bytes while alive, ${after ?? '?'} → ${later ?? '?'} after the kill`,
          };
        },
      })
    : null;
  if (p16Box) opened.push(p16Box);

  // ---- P20: each limit alone, in a domain of its own with small caps ----
  // (D2 §3.7, A.6 P20; E64 item 2). The program's exhaustion actions refuse
  // unless the limit they read is small and stop at a fixed ceiling a little
  // above it; the engine's half: before the program may start, the host
  // reads that process 1 is in a pid namespace of its own and that the box's
  // `pids.max`, `memory.max` and `memory.swap.max` read as the suite wrote
  // them (verifyLimits); a box that fails either never starts its program.
  const p20: Record<P20Kind, Box | null> = { pids: null, memory: null, bytes: null, inodes: null };
  // Only on a host designated for exhaustion probes (E69): elsewhere no box
  // is opened and nothing is forked, allocated or filled to a limit.
  const designated = rt.config.values.isolation_probe_exhaustion === true;
  if (designated && run('P20')) {
    for (const kind of P20_KINDS) {
      const caps = P20_CAPS[kind];
      try {
        const b = await openBox(rt, scope, tools, initCopy, {
          label: `p20-${kind}`,
          fixture: null,
          memoryMax: caps.memoryMax,
          tasksMax: caps.tasksMax,
          volBytes: caps.volBytes,
          volInodes: caps.volInodes,
          egress: null,
          context: () => {},
          actions: neg('P20')
            ? [
                kind === 'pids'
                  ? { id: 'p20', kind: 'pids', max_limit: caps.tasksMax }
                  : kind === 'memory'
                    ? { id: 'p20', kind: 'memory', max_limit: caps.memoryMax }
                    : { id: 'p20', kind, dir: '/surety/out', max_bytes: caps.volBytes, max_inodes: caps.volInodes },
              ]
            : [{ id: 'p20c', kind: 'write_read', path: '/surety/out/p20-control', content: tag }],
          limits: { memoryMax: caps.memoryMax, tasksMax: caps.tasksMax },
        });
        p20[kind] = b;
        opened.push(b);
      } catch (err) {
        log('probe suite', err, { probe: 'P20', kind });
      }
    }
  }

  // The host controls run meanwhile (P4's and P5's after the sandboxes, so
  // that the repository is compared before and after the role alone).
  const p11Control = winPresent && run('P11') ? runHost(WIN_EXE, ['/c', 'echo', marker], { cwd: '/' }) : Promise.resolve(null);
  const managerEnv: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  if (process.env.XDG_RUNTIME_DIR) managerEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) managerEnv.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  const p17Control = run('P17') ? runHost('/usr/bin/systemd-run', ['--user', '--quiet', '--wait', '--collect', '/usr/bin/true'], { env: managerEnv }) : Promise.resolve(null);
  // P8's control from the host: the `role` profile cannot use the echo.
  const roleEcho = run('P8') ? roleProfileEcho(rt).catch(() => null) : Promise.resolve(null);

  await Promise.all(opened.map((b) => awaitBox(b, args.deadline)));
  const p8Role = await roleEcho;
  const configAfter = configHash();
  const hooksAfter = hooksList();
  const p4Host = run('P4') ? await gitOk(repoContext(fixture.repo), ['config', '--file', join(fixture.repo, '.git', 'config'), `probe.host${tag}`, 'y']) : null;
  const hook = join(fixture.repo, '.git', 'hooks', `probe-control-${tag}`);
  let p5Control = false;
  if (run('P5')) {
    try {
      writeFileSync(hook, '#!/bin/sh\n', { mode: 0o700 });
      p5Control = true;
    } catch {
      p5Control = false;
    }
  }
  const p11Host = await p11Control;
  const p17Host = await p17Control;
  // P18: the result files, read as collection reads them, after the domain.
  const p18Read: Record<string, unknown> = {};
  const p18Started = performance.now();
  if (main.launch.volatile && run('P18')) {
    for (const name of ['link_fifo', 'fifo', 'device', 'oversize', 'regular']) {
      const r = readRegular(main.launch.volatile.vol, `out/${name}.json`, resultMax);
      p18Read[name] = r.state === 'read' ? { state: 'read', bytes: r.bytes.length, json: (() => { try { JSON.parse(r.bytes.toString('utf8')); return true; } catch { return false; } })() } : r;
    }
  }
  const p18Ms = performance.now() - p18Started;
  let fifoUnopened: boolean | null = null;
  if (fifoMade) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      fifoUnopened = false;
    } catch (err) {
      fifoUnopened = (err as NodeJS.ErrnoException).code === 'ENXIO';
    }
  }
  const sentinelAlive = sentinel.alive();
  if (p4Host !== null) await gitOk(repoContext(fixture.repo), ['config', '--file', join(fixture.repo, '.git', 'config'), '--unset', `probe.host${tag}`]);
  rmSync(hook, { force: true });
  for (const b of opened) b.counters = counters(b.cgroup);
  // P9's second half: a proposed read path holding a listening socket is
  // refused by the plan's validation.
  const socketDir = pathUp ? await validateReadPaths([sockDir], { home, repositories: [], workspaces: [], checkouts: [] }).catch(() => null) : null;

  // ---- judgement ----
  const results: ProbeResult[] = [];
  const L = (id: string) => line(main, id);
  const refusedBy = (o: Obj | null) => (o && typeof o.refused === 'string' ? `the program refused: ${(o.reasons as string[] | undefined)?.join('; ') ?? o.refused}` : null);
  const boxFailure = main.hostRefusal ?? (main.launch.setupFailure ? `the probe sandbox could not be built: ${main.launch.setupFailure}` : null) ?? (main.finished ? null : 'the probe sandbox did not finish within tick_step_budget');
  const guard = L('guard');
  const guardReasons = (guard?.guard as { reasons?: string[] } | undefined)?.reasons ?? null;
  const mainProblem = boxFailure ?? (guard === null ? 'the probe program did not report' : guardReasons && guardReasons.length > 0 ? `the probe program refused: ${guardReasons.join('; ')}` : null);
  const judge = (id: string, f: () => ProbeResult): void => {
    if (!run(id)) results.push(notRun(id, 'this probe was made unable to run at start'));
    else if (mainProblem !== null && id !== 'P16') results.push({ ...verdict(ctx, id, { seeded: false, negative: null, held: false, control: null, detail: mainProblem }), result: 'failed' });
    else {
      try {
        results.push(f());
      } catch (err) {
        results.push(verdict(ctx, id, { seeded: false, negative: null, held: false, control: null, detail: `the probe could not be judged: ${(err as Error).message}` }));
      }
    }
  };
  const openResults = (o: Obj | null) => (o?.results as Record<string, string> | undefined) ?? null;
  const fmt = (r: Record<string, string> | null) => (r ? Object.entries(r).map(([p, c]) => `${p}: ${c}`).join(', ') : 'nothing');
  // Each target on its own (SEAM.md §138): seeded and read back from the
  // host before the instructions named it, attempted by the role, denied.
  // A target the role did not attempt leaves the negative not attempted;
  // nothing is counted in place of a target.
  const perTarget = (targets: string[], seeded: Record<string, boolean>, r: Record<string, string> | null, codes = DENIED_ABSENT) => {
    const unseeded = targets.filter((t) => seeded[t] !== true);
    const unattempted = targets.filter((t) => r === null || r[t] === undefined);
    const allowed = targets.filter((t) => r !== null && r[t] !== undefined && !codes.includes(r[t]!));
    return {
      seeded: targets.length > 0 && unseeded.length === 0,
      attempted: targets.length > 0 && unattempted.length === 0,
      denied: targets.length > 0 && unattempted.length === 0 && allowed.length === 0,
      note: [unseeded.length ? `not seeded: ${unseeded.join(', ')}` : '', unattempted.length ? `not attempted: ${unattempted.join(', ')}` : '', allowed.length ? `not denied: ${allowed.map((t) => `${t} ${r?.[t]}`).join(', ')}` : ''].filter(Boolean).join('; '),
    };
  };

  judge('P1', () => {
    const o = L('p1');
    const r = openResults(o);
    const t = perTarget(tokenForms, Object.fromEntries(tokenForms.map((f) => [f, seededToken])), r);
    return verdict(ctx, 'P1', { seeded: t.seeded, negative: refusedBy(o) ?? (t.attempted ? fmt(r) : null), held: t.denied, control: readable(token), detail: `the token by its host path and aliases: ${fmt(r)}${t.note ? `; ${t.note}` : ''}` });
  });
  judge('P2', () => {
    const o = L('p2');
    const fds = L('p2fds');
    const r = openResults(o);
    const own = (fds?.own as Record<string, string> | undefined) ?? {};
    const named = Object.values(own).filter((v) => p2.some((t) => v === t || v.startsWith(`${realHome}/`) || v.startsWith(`${home}/`)));
    const initFd = (fds?.init as { outcome?: string; error?: string } | undefined) ?? null;
    // Each target its verdict counts, with its own attempts (SEAM.md §138).
    const targets = p2Targets.map((x) => ({
      kind: x.kind,
      path: x.path,
      host_verified: seededP2[x.path] === true,
      attempts: aliasesOf(x.path)
        .filter((a) => r !== null && r[a] !== undefined)
        .map((a) => ({ path: a, outcome: r![a] === 'opened' ? 'opened' : 'failed', error: r![a] === 'opened' ? null : r![a]! })),
    }));
    const t = perTarget(p2, Object.fromEntries(p2Targets.flatMap((x) => aliasesOf(x.path).map((a) => [a, seededP2[x.path] === true]))), r);
    const held = t.denied && named.length === 0 && initFd?.outcome === 'refused';
    return {
      ...verdict(ctx, 'P2', {
        seeded: t.seeded,
        negative: t.attempted && fds ? `${fmt(r)}; descriptors naming the home: ${named.length}; /proc/1/fd ${initFd?.outcome ?? '?'} ${initFd?.error ?? ''}`.trim() : null,
        held,
        control: p2Targets.every((x) => readable(x.path)),
        detail: `${p2Targets.length} engine-home targets, each judged with its aliases${t.note ? `; ${t.note}` : ''}`,
      }),
      targets,
    };
  });
  judge('P3', () => {
    const o = L('p3');
    const c = L('p3c');
    const r = openResults(o);
    const t = perTarget(p3, seededP3, r);
    return verdict(ctx, 'P3', {
      seeded: t.seeded,
      negative: t.attempted ? fmt(r) : null,
      held: t.denied,
      control: c?.outcome === 'read' && c.content === fixture.sentinel.content,
      detail: `a second workspace and the fixture's checkout; the role's own sentinel ${c?.outcome ?? 'not read'}${t.note ? `; ${t.note}` : ''}`,
    });
  });
  judge('P4', () => {
    const o = L('p4');
    const cmds = (o?.commands as { args: string[]; status: number | null; stdout: string }[] | undefined) ?? null;
    const [path, write, list] = cmds ?? [];
    const expected = viewConfig('sha1')
      .split('\n')
      .filter((l) => l.startsWith('\t'))
      .map((l) => l.trim().replace(/\s*=\s*/, '='));
    const listed = (list?.stdout ?? '').split('\n').filter(Boolean);
    const onlyView = listed.length > 0 && listed.every((l) => l.startsWith('file:/surety/git/config\t'));
    const sameContent = listed.map((l) => l.split('\t')[1]).join(',') === expected.map((e) => `core.${e}`).join(',');
    const held = path?.stdout.trim() === '/surety/git/config' && write !== undefined && write.status !== 0 && onlyView && sameContent && configBefore !== null && configBefore === configAfter;
    return verdict(ctx, 'P4', {
      seeded: configBefore !== null,
      negative: cmds ? `--git-path config ${path?.stdout.trim()}; config write status ${write?.status}; ${listed.length} settings shown, only the view's ${onlyView}, the engine's content ${sameContent}; the repository's config unchanged ${configBefore === configAfter}` : null,
      held,
      control: p4Host !== null,
      detail: 'the fixture repository through the git view',
    });
  });
  judge('P5', () => {
    const o = L('p5');
    const w = L('p5w');
    const l = L('p5l');
    const cmds = (o?.commands as { stdout: string }[] | undefined) ?? null;
    const create = ((w?.results as { outcome: string }[] | undefined) ?? [])[0]?.outcome ?? null;
    const held = cmds?.[0]?.stdout.trim() === '/surety/git/hooks' && create !== null && create !== 'written' && l?.status === 0 && String(l.stdout ?? '').trim() === '' && hooksBefore !== null && hooksBefore === hooksAfter;
    return verdict(ctx, 'P5', { seeded: hooksBefore !== null, negative: cmds ? `--git-path hooks ${cmds[0]?.stdout.trim()}; hook creation ${create}; hooks listed ${JSON.stringify(String(l?.stdout ?? '').trim())}; the repository's hooks unchanged ${hooksBefore === hooksAfter}` : null, held, control: p5Control, detail: 'the hooks of the git view' });
  });
  judge('P6', () => {
    const o = L('p6');
    const c = L('p6c');
    const r = (o?.results as { host?: string; outcome: string }[] | undefined) ?? null;
    // Every target named was attempted: one result per target, in order.
    const attempted = r !== null && r.length === p6Targets.length && p6Targets.every((x, i) => r[i]?.host === x.host);
    const held = attempted && r.every((x) => x.outcome !== 'connected');
    const control = ((c?.results as { outcome: string }[] | undefined) ?? [])[0]?.outcome === 'connected';
    return verdict(ctx, 'P6', { seeded: listenerAlive, negative: attempted ? r.map((x) => `${x.host}: ${x.outcome}`).join(', ') : null, held, control, detail: `the engine's port ${port}, alive from the host ${listenerAlive}` });
  });
  judge('P7', () => {
    const d = L('p7');
    const p = L('p7p');
    const tunnels = (p?.results as { authority: string; status: number | null }[] | undefined) ?? null;
    const attempted = d !== null && tunnels !== null && tunnels.length === p7Requests.length && p7Requests.every((x, i) => tunnels[i]?.authority === x.authority);
    const held = attempted && d.outcome !== 'answered' && tunnels.every((x) => x.status === 403);
    return verdict(ctx, 'P7', { seeded: listenerAlive, negative: attempted ? `direct ${String(d.outcome)}; through the proxy ${tunnels.map((x) => `${x.authority}: ${x.status}`).join(', ')}` : null, held, control: listenerAlive, detail: 'GET /v1/token/bootstrap by every route the role has' });
  });
  judge('P8', () => {
    const o = L('p8');
    const c = L('p8c');
    const r = (o?.results as { authority: string; status: number | null }[] | undefined) ?? null;
    const policy = [names.unlisted, names.private, names.mixed, names.loop6, names.ula, names.mapped].map((n) => `${n}:443`);
    const attempted = r !== null && r.length === policy.length + 2;
    const refusedAll = attempted && policy.every((a, i) => r[i]?.authority === a && r[i]?.status === 403);
    // One resolution per attempt: the listed names were asked once each, the
    // rebinding name once per attempt, and each answer judged on its own.
    const q = resolver.queries;
    const once = q.get(names.private) === 1 && q.get(names.mixed) === 1 && q.get(names.rebind) === 2 && !q.has(names.unlisted);
    // Rebinding: the first attempt connected to the validated numeric
    // address of its own answer (a documentation address, so it reached
    // nothing); the retry resolved again, got loopback, and was refused.
    const logged = (main.proxy?.entries ?? []).filter((e) => e.authority === `${names.rebind}:443`);
    const [first, second] = logged;
    const rebound =
      attempted &&
      logged.length === 2 &&
      first!.decision === 'accepted' &&
      first!.address === '192.0.2.77' &&
      first!.resolved.join(' ') === '192.0.2.77' &&
      r[policy.length]?.status !== 200 &&
      second!.decision === 'refused' &&
      second!.reason === 'address_policy' &&
      second!.address === null &&
      second!.resolved.join(' ') === '127.0.0.1' &&
      r[policy.length + 1]?.status === 403;
    const rebinds = logged.map((e) => `${e.resolved.join(' ')} → ${e.address ?? 'nothing'} (${e.decision}${e.ended ? `, ${e.ended}` : ''})`);
    const tunnel = ((c?.results as { status: number | null; same?: boolean }[] | undefined) ?? [])[0];
    const echoed = echoEndpoint.of(main.id).some((e) => e.received.subarray(0, echoBytes.length).equals(echoBytes));
    return verdict(ctx, 'P8', {
      seeded: true,
      negative: attempted ? `${r.map((x) => `${x.authority}: ${x.status}`).join(', ')}; resolutions ${JSON.stringify(Object.fromEntries(q))}; rebinding ${rebinds.join(' | ')}` : null,
      held: refusedAll && once && rebound,
      control: tunnel?.status === 200 && tunnel.same === true && echoed && p8Role === 403,
      detail: `the echo tunnel ${tunnel?.status ?? '?'} unchanged ${tunnel?.same ?? '?'}, witnessed ${echoed}; the role profile's echo ${p8Role ?? '?'}`,
    });
  });
  judge('P9', () => {
    const o = L('p9');
    const c = L('p9c');
    const r = (o?.results as { outcome: string }[] | undefined) ?? null;
    const refusal = socketDir === null ? 'not refused' : `refused ${socketDir.reason}`;
    return verdict(ctx, 'P9', {
      seeded: abstractUp && pathUp,
      negative: r ? `the host abstract socket: ${r[0]?.outcome}; the plan with a listening socket: ${refusal}` : null,
      held: r !== null && r.length > 0 && r.every((x) => x.outcome !== 'connected') && socketDir?.reason === 'special_file',
      control: c?.outcome === 'connected',
      detail: `${abstractName}, ${sockPath}`,
    });
  });
  judge('P10', () => {
    const o = L('p10');
    const c = L('p10c');
    const r = openResults(o);
    const t = perTarget(p10, Object.fromEntries(p10.map((x) => [x, true])), r);
    return verdict(ctx, 'P10', {
      seeded: shmSeeded && t.seeded,
      negative: t.attempted ? `${fmt(r)}${dockerPresent ? '' : '; the Docker socket: not_exercised, absent on this host'}` : null,
      held: t.denied,
      control: c?.outcome === 'same',
      detail: `${p10.length} host endpoints verified by lstat, none connected to${t.note ? `; ${t.note}` : ''}`,
    });
  });
  if (!args.wsl2) results.push(notRun('P11', 'not a WSL2 host: WSL interop does not exist here', 'not_wsl2'));
  else if (!winPresent) judge('P11', () => verdict(ctx, 'P11', { seeded: false, negative: null, held: false, control: false, detail: `${WIN_EXE} is not present` }));
  else
    judge('P11', () => {
      const o = L('p11');
      const host = p11Host as { stdout: string; status: number | null } | null;
      const ranInside = o !== null && String(o.stdout ?? '').includes(marker);
      return verdict(ctx, 'P11', {
        seeded: winPresent,
        negative: o ? `inside: status ${String(o.status)}, error ${String(o.error)}, marker printed ${ranInside}` : null,
        held: o !== null && !ranInside && o.status !== 0,
        control: host !== null && host.stdout.includes(marker),
        detail: `${WIN_EXE} (sha256 ${fileSha(WIN_EXE)}), copied into the context`,
      });
    });
  let planEvidence: { fingerprint: string; mounts: PlannedMount[] } | null = null;
  judge('P12', () => {
    const o = L('p12');
    const planned = plannedMounts(main.plan);
    planEvidence = { fingerprint: planFingerprint(main.plan), mounts: planned };
    const cmp = o ? compareMounts(o.mountinfo as string[], planned) : null;
    return verdict(ctx, 'P12', { seeded: true, negative: cmp ? cmp.detail : null, held: cmp?.equal === true, control: planned.length > 0, detail: `the role's /proc/self/mountinfo against the validated plan (${planned.length} mounts)` });
  });
  judge('P13', () => {
    const o = L('p13');
    const control = (o?.control as { exit?: { signal?: string } | null } | undefined)?.exit?.signal === 'SIGKILL';
    return verdict(ctx, 'P13', {
      seeded: sentinel.pid !== null,
      negative: o ? `${refusedBy(o) ?? `signalled ${Object.keys((o.results as Obj) ?? {}).length} pids, kill(-1) ${String(o.kill_all)}`}; the host sentinel alive ${sentinelAlive}; /proc/1/fd ${String(o.init_fd)}` : null,
      held: o !== null && refusedBy(o) === null && sentinelAlive && o.init_fd !== 'listed',
      control,
      detail: `host sentinel pid ${sentinel.pid}`,
    });
  });
  judge('P14', () => {
    const o = L('p14');
    const c = L('p14c');
    const fds = (o?.fds as Record<string, string> | undefined) ?? {};
    // Beyond 0 to 2, only the runtime's own (SEAM.md §127): anonymous
    // inodes, pipes, /dev/null, /dev/urandom, the listing's own directory.
    const foreign = Object.entries(fds).filter(([fd, target]) => {
      if (['0', '1', '2'].includes(fd)) return false;
      // (A descriptor gone before its link was read is the listing's own.)
      return !(target.startsWith('anon_inode:') || target.startsWith('pipe:') || target === '/dev/null' || target === '/dev/urandom' || target === 'unreadable:ENOENT' || /^\/proc\/\d+\/fd$/.test(target));
    });
    const uids = String(o?.uid ?? '').split(/\s+/);
    const mount = o?.mount as { status: number | null } | undefined;
    const held = o !== null && o.cap_eff === '0000000000000000' && o.no_new_privs === '1' && uids.length === 4 && uids.every((u) => u === String(process.getuid?.() ?? 1000)) && foreign.length === 0 && mount !== undefined && mount.status !== 0;
    return verdict(ctx, 'P14', { seeded: true, negative: o ? `CapEff ${String(o.cap_eff)}, NoNewPrivs ${String(o.no_new_privs)}, Uid ${String(o.uid)}, descriptors beyond the runtime's ${foreign.map(([f, x]) => `${f}:${x}`).join(' ') || 'none'}, mount status ${mount?.status}` : null, held, control: c?.outcome === 'same', detail: 'the program after exec' });
  });
  judge('P15', () => {
    const o = L('p15');
    const host = p15Host as { found: boolean; inDomain: boolean; inSibling: boolean; detail: string } | null;
    // Under nsdelegate a migration out of the namespace's root is refused
    // with ENOENT (the target outside the namespace) or a permission error;
    // ENOENT counts only when the program saw the target's file there.
    const refused = o !== null && typeof o.outcome === 'string' && (['EACCES', 'EPERM', 'EBUSY', 'EOPNOTSUPP'].includes(o.outcome) || (o.outcome === 'ENOENT' && o.target_present === true));
    return verdict(ctx, 'P15', { seeded: existsSync(join(main.sibling, 'cgroup.procs')), negative: o ? `the write to the sibling's cgroup.procs: ${String(o.outcome)}; ${host?.detail ?? 'the host did not look'}` : null, held: refused && host !== null && !host.inSibling, control: host !== null && host.inDomain, detail: 'a migration out of the namespace root' });
  });
  if (p16Box) {
    const b = p16Box;
    const problem = b.hostRefusal ?? (b.launch.setupFailure ? `the sandbox could not be built: ${b.launch.setupFailure}` : null);
    judge('P16', () => {
      const r = p16 as { daemon: number | null; hostPid: number | null; env: number | null; session: boolean; killed: boolean; witnessStill: boolean | null; detail: string } | null;
      return verdict(ctx, 'P16', {
        seeded: problem === null && r !== null && r.daemon !== null,
        negative: problem ?? (r ? r.detail : null),
        held: r !== null && r.hostPid !== null && r.env === 0 && r.session && r.killed && r.witnessStill === true,
        control: r !== null && r.daemon !== null,
        detail: 'a detached daemon with a cleared environment',
      });
    });
  } else results.push(notRun('P16', 'this probe was made unable to run at start'));
  judge('P17', () => {
    const o = L('p17');
    const host = p17Host as { status: number | null } | null;
    return verdict(ctx, 'P17', { seeded: true, negative: o ? `inside: status ${String(o.status)} ${String(o.error ?? '')} ${String(o.stderr ?? '').trim().slice(0, 120)}`.trim() : null, held: o !== null && o.status !== 0, control: host?.status === 0, detail: 'systemd-run --user true' });
  });
  judge('P18', () => {
    const o = L('p18');
    const made = (o?.made as Record<string, string> | undefined) ?? {};
    const reason = (n: string) => (p18Read[n] as { reason?: string } | undefined)?.reason ?? (p18Read[n] as { state?: string } | undefined)?.state;
    const held = reason('link_fifo') === 'link' && reason('fifo') === 'fifo' && reason('device') === 'link' && reason('oversize') === 'oversize' && fifoUnopened === true && p18Ms < rt.setting('collect_deadline') * 1000;
    const regular = p18Read.regular as { state?: string; json?: boolean } | undefined;
    return verdict(ctx, 'P18', {
      seeded: fifoMade && Object.values(made).every((m) => m === 'made'),
      negative: o ? `link to the host FIFO ${reason('link_fifo')}, FIFO ${reason('fifo')}, link to a device ${reason('device')}, oversize ${reason('oversize')}; the host FIFO never opened ${fifoUnopened}; ${Math.round(p18Ms)} ms` : null,
      held,
      control: regular?.state === 'read' && regular.json === true,
      detail: 'collection from the volatile filesystem after termination',
    });
  });
  judge('P19', () => {
    const o = L('p19');
    const c = L('p19c');
    const r = (o?.results as { op: string; path: string; outcome: string }[] | undefined) ?? null;
    return verdict(ctx, 'P19', {
      seeded: fixture.protectedFiles.every((f) => readable(join(fixture.worktree, f))),
      negative: r ? r.map((x) => `${x.op} ${x.path.replace('/surety/workspace/', '')}: ${x.outcome}`).join(', ') : null,
      held: r !== null && r.length === p19Ops && r.every((x) => x.outcome !== 'written'),
      control: c?.outcome === 'same',
      detail: `the protected roots ${fixture.protectedRoots.join(', ')} for a role other than the Verifier`,
    });
  });
  // P20: each limit alone in its own capped domain (D2 §3.7, A.6 P20). Each
  // part passes only if its box was built with its limits read back from the
  // host, the program's exhaustion was stopped by the kernel short of the
  // program's own ceiling with the counter the kernel keeps risen where it
  // keeps one, and the control (one fork, one allocation, one write, one
  // file) succeeded first.
  if (!run('P20')) results.push(notRun('P20', 'this probe was made unable to run at start'));
  else if (!designated) results.push(notRun('P20', P20_NOT_DESIGNATED, 'not_designated'));
  else {
    const parts: { kind: P20Kind; seeded: boolean; held: boolean; control: boolean; negative: string | null; detail: string }[] = [];
    for (const kind of P20_KINDS) {
      const b = p20[kind];
      if (b === null) {
        parts.push({ kind, seeded: false, held: false, control: false, negative: null, detail: `the ${kind} box could not be made` });
        continue;
      }
      const problem = b.hostRefusal ?? (b.launch.setupFailure ? `its sandbox could not be built: ${b.launch.setupFailure}` : null) ?? (b.finished ? null : 'it did not finish within tick_step_budget');
      const g = line(b, 'guard');
      const guardReasons = (g?.guard as { reasons?: string[] } | undefined)?.reasons ?? [];
      const o = line(b, 'p20');
      const c = b.lines.find((l) => l.id === 'p20' && l.step === 'control') ?? null;
      const k = b.counters ?? { oom_kill: null, pids_max: null };
      const seeded = problem === null && g !== null && guardReasons.length === 0;
      let held = false;
      let control = false;
      let negative: string | null = null;
      if (!neg('P20')) {
        control = line(b, 'p20c')?.outcome === 'same';
      } else if (kind === 'pids') {
        const r = o && o.step !== 'control' ? o : b.lines.filter((l) => l.id === 'p20' && l.step !== 'control').at(-1) ?? null;
        control = (c?.control as { fork?: string } | undefined)?.fork === 'spawned';
        const forks = Number(r?.forks ?? NaN);
        const ceiling = Number(r?.ceiling ?? NaN);
        held = r !== null && typeof r.failure === 'string' && forks < ceiling && (k.pids_max ?? 0) > 0;
        negative = r ? (typeof r.refused === 'string' ? `refused: ${String(r.refused)}` : `${forks} forks of a ceiling of ${ceiling}, stopped by ${String(r.failure)}; pids.events max ${k.pids_max ?? 'unreadable'}`) : null;
      } else if (kind === 'memory') {
        const finals = b.lines.filter((l) => l.id === 'p20' && l.step !== 'control');
        control = (c?.control as { allocated?: number } | undefined)?.allocated === MIB;
        const exit = b.launch.exitReport;
        // The program never reported reaching its ceiling: the kernel ended
        // it at memory.max (memory.events oom_kill rose).
        held = c !== null && finals.every((l) => typeof l.allocated !== 'number' || Number(l.allocated) < Number(l.ceiling)) && (k.oom_kill ?? 0) > 0;
        negative = c ? `${finals.length === 0 ? 'the program was ended before it reported' : JSON.stringify(finals.at(-1))}; exit ${JSON.stringify(exit)}; memory.events oom_kill ${k.oom_kill ?? 'unreadable'}` : null;
      } else {
        const r = o;
        control = kind === 'bytes' ? r?.control === 'written' : r?.control === 'created';
        if (kind === 'bytes') {
          const written = Number(r?.written ?? NaN);
          held = r !== null && r.stop === 'ENOSPC' && written <= Number(r.size) + 64 * 1024 && written < Number(r.ceiling);
          negative = r ? (typeof r.refused === 'string' ? `refused: ${String(r.refused)}` : `${written} bytes written to a ${String(r.size)}-byte volatile filesystem, stopped by ${String(r.stop)}`) : null;
        } else {
          const made = Number(r?.made ?? NaN);
          held = r !== null && r.stop === 'ENOSPC' && made < Number(r.inodes);
          negative = r ? (typeof r.refused === 'string' ? `refused: ${String(r.refused)}` : `${made} files made on a ${String(r.inodes)}-inode volatile filesystem, stopped by ${String(r.stop)}`) : null;
        }
      }
      const caps = P20_CAPS[kind];
      parts.push({
        kind,
        seeded,
        held,
        control,
        negative,
        detail: `${kind}: ${problem ?? (guardReasons.length > 0 ? `the program refused: ${guardReasons.join('; ')}` : `pids.max ${caps.tasksMax}, memory.max ${caps.memoryMax}, volatile ${caps.volBytes} bytes and ${caps.volInodes} inodes`)}`,
      });
    }
    evidence.p20 = parts;
    const v = verdict(ctx, 'P20', {
      seeded: parts.every((p) => p.seeded),
      negative: parts.some((p) => p.negative === null) ? null : parts.map((p) => `${p.kind}: ${p.negative}`).join('; '),
      held: parts.every((p) => p.held),
      control: parts.every((p) => p.control),
      detail: parts.map((p) => p.detail).join('; '),
    });
    results.push(v);
  }

  evidence.domains = opened.map((b) => ({ id: b.id, cgroup: b.cgroup, finished: b.finished, host_refusal: b.hostRefusal, setup_failure: b.launch.setupFailure, counters: b.counters, exit: b.launch.exitReport }));
  evidence.egress = main.proxy?.entries ?? null;
  evidence.lines = Object.fromEntries(main.lines.filter((l) => l.id !== 'p12').map((l) => [String(l.id), l]));

  for (const b of opened) await closeBox(rt, b).catch((err) => log('probe suite', err, { box: b.id }));
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
  rmSync(join(home, 'sandbox', TAG_FILE), { force: true });

  const ordered = PROBES.map((id) => results.find((r) => r.id === id) ?? notRun(id, 'the probe was not judged'));
  return { probes: ordered, plan: planEvidence, evidence };
}

// The `role` profile cannot use the echo endpoint (D2 §2.4, A.6 P8): a
// proxy of that profile, asked for it from the host, refuses.
async function roleProfileEcho(rt: Runtime): Promise<number | null> {
  const dir = mkdtempSync(join(rt.home, 'sandbox', 'probe-role-'));
  const proxy = new DomainProxy({
    area: dir,
    domain: 'probe-role-profile',
    run: null,
    invocation: null,
    profile: 'role',
    allow: [],
    limits: { resolveTimeoutMs: 1000, connectTimeoutMs: 1000, tunnelMaxMs: 5000, tunnelsMax: 2, bufferMaxBytes: 65536, logMaxBytes: 65536 },
    resolver: suiteResolver({}),
    echo: null,
  });
  try {
    await proxy.listen();
    const dirFd = openSync(dir, 'r');
    try {
      return await new Promise<number | null>((resolve) => {
        const s = net.connect(`/proc/self/fd/${dirFd}/egress.sock`);
        let buf = '';
        s.once('connect', () => s.write(`CONNECT ${ECHO_HOST}:443 HTTP/1.1\r\n\r\n`));
        s.on('data', (d: Buffer) => {
          buf += d.toString('latin1');
          const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
          if (m) {
            s.destroy();
            resolve(Number(m[1]));
          }
        });
        s.once('error', () => resolve(null));
        setTimeout(() => {
          s.destroy();
          resolve(null);
        }, 2000);
      });
    } finally {
      closeSync(dirFd);
    }
  } finally {
    await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fileSha(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

