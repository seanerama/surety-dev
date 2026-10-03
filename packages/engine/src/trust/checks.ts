// The host checks of D2 §6, run as a startup step between repository
// integrity and full mode (§7.1, K2), within `tick_step_budget`, while the
// API answers. Each check is `passed`, `failed` or `not_exercised` with the
// value observed, never passed by default; a failure says what to do. The
// result is one `host_qualifications` row per start, `active` only when every
// required check passed (H1 to H12, H10 only on WSL2) and the bootstrap
// exception is not in force, with the probe results and an evidence record.
//
// Slice 11 runs H1 to H8, H11 and H12 for real: the incarnation scope, the
// cgroup controllers in a probe cgroup, the tools, and a start-up trial that
// launches a sandbox through the real launcher and init in a probe cgroup
// (namespaces, node from a read-only bind, a bounded tmpfs, an overlay on it).
// The isolation probe suite (H9, and on WSL2 the P11 and P12 claims of H10)
// is slice 12's: until it exists those checks are `not_exercised`, every
// probe is reported `not_exercised`, and no row is active. H13, the optional
// observer, is reported apart and never required.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { type Scope, managerReachable } from '../boundary/scope.js';
import { createDomainCgroup, readControllers, readPopulated, removeCgroup, writeKill } from '../boundary/cgroup.js';
import { filesystemOf } from '../home-fs.js';
import { newId } from '../ids.js';
import { INIT_SCRIPT, SandboxLaunch } from '../invoke/sandboxed.js';
import { SYSTEM_TREES, buildPlan, planFingerprint } from '../invoke/sandbox/mounts.js';
import { type ResolvedTools, engineNode, initNodeCopy, resolveSandboxTools } from '../invoke/sandbox/tools.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import { canonical } from '../store/transitions/common.js';
import { type CheckResult, isRequired, isWsl2 } from '../store/transitions/trust.js';
import { seamHostChecks } from '../testing/seam.js';
import { BOUNDARY_MECHANISM, HOST_CHECKS, ISOLATION_MECHANISM, hostIdentity } from './host.js';

export const PROBES = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);

export interface ScopeOutcome {
  scope: Scope | null;
  // What the scope's creation observed (H3).
  observed: string;
}

const isWsl = (): boolean => isWsl2();

// Every path under the system directories by which a tool is reached, as a
// PATH search would find it, before its real path.
function toolCandidates(name: string): string[] {
  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].map((d) => join(d, name)).filter((p) => existsSync(p));
}

function kernelAtLeast(major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(release());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

const GIB = 1024 ** 3;
const human = (n: number): string => (n >= GIB ? `${(n / GIB).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`);

interface Trial {
  ok: boolean;
  detail: string;
  namespaces: Record<string, boolean> | null;
  node: boolean;
  tmpfs: { bytes_bounded: boolean; inodes_bounded: boolean; detail: string } | null;
  overlay: { ok: boolean; detail: string } | null;
}

// What the trial's backend reports from inside the sandbox: its namespaces,
// and how the volatile filesystem's bounds held (D2 preamble: a 1 MiB, 64
// inode tmpfs stopped a 2 MiB write at about 1 MiB and creation at 58 files).
const TRIAL_SCRIPT = `
const fs = require('fs');
const ns = {};
for (const n of ['user', 'mnt', 'pid', 'net', 'ipc', 'uts', 'cgroup']) { try { ns[n] = fs.readlinkSync('/proc/self/ns/' + n); } catch (e) { ns[n] = null; } }
let written = 0; try { const b = Buffer.alloc(65536, 120); const fd = fs.openSync('/surety/out/fill', 'w'); for (let i = 0; i < 32; i++) { fs.writeSync(fd, b); written += b.length; } fs.closeSync(fd); } catch (e) {}
try { fs.unlinkSync('/surety/out/fill'); } catch (e) {}
let files = 0; try { for (let i = 0; i < 256; i++) { fs.writeFileSync('/surety/out/f' + i, ''); files++; } } catch (e) {}
process.stdout.write(JSON.stringify({ ns, written, files }) + '\\n');
`;

async function runTrial(rt: Runtime, scope: Scope | null, tools: ResolvedTools, initCopy: string, deadline: number): Promise<Trial> {
  const fail = (detail: string): Trial => ({ ok: false, detail, namespaces: null, node: false, tmpfs: null, overlay: null });
  const t = tools.paths;
  if (!t.unshare || !t.setpriv || !t.ip || !t.mount || !t.umount || !t.pivot_root) return fail(`missing tools: ${tools.missing.join(', ')}`);
  const id = newId('probe_');
  const area = join(rt.home, 'domains', id);
  for (const d of ['root', 'vol', 'context', 'workspace']) mkdirSync(join(area, d), { recursive: true, mode: 0o700 });
  let cgroup: string | null = null;
  if (scope) {
    cgroup = join(scope.path, id);
    try {
      createDomainCgroup(cgroup, { memoryMax: 256 * 1024 ** 2, tasksMax: 64 });
    } catch (err) {
      cgroup = null;
      log('host checks', err, { probe: id });
    }
  }
  const real = buildPlan({
    area,
    context: join(area, 'context'),
    workspace: join(area, 'workspace'),
    readPaths: [],
    writablePaths: [],
    volBytes: 1024 * 1024,
    volInodes: 64,
    shmBytes: 1024 * 1024,
    tools: { mount: t.mount, umount: t.umount, pivot_root: t.pivot_root, ip: t.ip, unshare: t.unshare, setpriv: t.setpriv },
    node: engineNode(),
    initNodeCopy: initCopy,
    initScript: INIT_SCRIPT,
  });
  real.overlayTrial = true;
  let out = '';
  const launch = new SandboxLaunch(
    { domain: id, invocation: id, incarnation: rt.incarnation, generation: 0, cgroup, unshare: t.unshare, node: engineNode() },
    {
      barrier: async () => {},
      placed: async () => {},
      authorize: async () => true,
      plan: () => real,
      backend: () => ({ argv: [engineNode(), '-e', TRIAL_SCRIPT], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/surety/workspace', stdin: null }),
      started: async () => {},
      setupFailed: () => {},
    },
  );
  launch.output.on('data', (d: Buffer) => {
    if (out.length < 65536) out += d.toString('utf8');
  });
  void launch.backendDone.then(() => launch.ackExit());
  const remaining = Math.max(500, deadline - Date.now());
  const finished = await Promise.race([launch.launcherExited.then(() => true), sleep(remaining).then(() => false)]);
  if (!finished) {
    if (cgroup) writeKill(cgroup);
    await launch.killUnplaced();
  }
  // The trial's probe cgroup is emptied and removed; what it held is gone.
  if (cgroup) {
    for (let i = 0; i < 20; i++) {
      const p = readPopulated(cgroup);
      if (p.state !== 'populated' || p.value === 0) break;
      writeKill(cgroup);
      await sleep(50);
    }
    removeCgroup(cgroup);
  }
  try {
    rmSync(area, { recursive: true, force: true });
  } catch {
    // an empty mountpoint left behind is harmless
  }
  if (!finished) return fail('the trial sandbox did not finish within tick_step_budget');
  if (launch.setupFailure) return { ...fail(`the sandbox could not be built: ${launch.setupFailure}`), overlay: launch.overlay };
  type Report = { ns: Record<string, string | null>; written: number; files: number };
  let report: Report | null = null;
  try {
    report = JSON.parse(out.trim().split('\n')[0] ?? '') as Report;
  } catch {
    report = null;
  }
  if (!report || launch.exitReport?.code !== 0) return { ...fail(`node did not run inside the sandbox (exit ${JSON.stringify(launch.exitReport)})`), overlay: launch.overlay };
  const namespaces: Record<string, boolean> = {};
  for (const [n, link] of Object.entries(report.ns)) {
    let own: string | null = null;
    try {
      own = readlinkSync(`/proc/self/ns/${n}`);
    } catch {
      own = null;
    }
    namespaces[n] = link !== null && own !== null && link !== own;
  }
  const bytesBounded = report.written > 0 && report.written <= 1024 * 1024 + 65536;
  const inodesBounded = report.files > 0 && report.files < 64;
  return {
    ok: true,
    detail: 'a sandbox was built by the launcher and the domain init',
    namespaces,
    node: true,
    tmpfs: { bytes_bounded: bytesBounded, inodes_bounded: inodesBounded, detail: `a 1 MiB, 64-inode volatile tmpfs stopped a 2 MiB write at ${report.written} bytes and creation at ${report.files} files` },
    overlay: launch.overlay,
  };
}

export interface HostCheckRun {
  checks: CheckResult[];
  qualifies: boolean;
  row: string | null;
}

// The checks, and the row (D2 §7.1). Never throws for a check's failure: a
// check that cannot be made is reported, and the start goes on.
export async function runHostChecks(rt: Runtime, args: { scope: ScopeOutcome; budgetMs: number }): Promise<HostCheckRun> {
  const deadline = Date.now() + args.budgetMs;
  const began = performance.now();
  const wsl2 = isWsl();
  const v = rt.config.values;
  const checks = new Map<string, CheckResult>();
  const set = (id: string, result: CheckResult['result'], observed: string | null, remedy: string | null = null) =>
    checks.set(id, { id, result, observed, remedy: result === 'passed' ? null : (remedy ?? 'see the observed value'), required: isRequired(id, wsl2) });
  const scope = args.scope.scope;

  // H1: the kernel, and cgroup.kill in the engine's own scope.
  const killFile = scope ? existsSync(join(scope.path, 'cgroup.kill')) : null;
  if (!kernelAtLeast(5, 14)) set('H1', 'failed', `kernel ${release()}`, 'run the engine on Linux 5.14 or later');
  else if (killFile === false) set('H1', 'failed', `kernel ${release()}; ${scope!.path}/cgroup.kill is missing`, 'run the engine on a kernel with cgroup.kill');
  else set('H1', 'passed', `kernel ${release()}${scope ? `; cgroup.kill present in ${scope.unit}` : ''}`);

  // H2: cgroup v2 at /sys/fs/cgroup, mounted nsdelegate.
  try {
    const line = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .find((l) => l.split(' ')[4] === '/sys/fs/cgroup');
    const [fs = '', , superOpts = ''] = line ? line.slice(line.indexOf(' - ') + 3).split(' ') : [];
    const mountOpts = line ? (line.split(' ')[5] ?? '') : '';
    const nsdelegate = `${superOpts},${mountOpts}`.split(',').includes('nsdelegate');
    if (fs === 'cgroup2' && nsdelegate) set('H2', 'passed', `cgroup2 at /sys/fs/cgroup, nsdelegate`);
    else set('H2', 'failed', line ? `/sys/fs/cgroup is ${fs || 'unknown'}${nsdelegate ? '' : ' without nsdelegate'}` : '/sys/fs/cgroup is not mounted', 'mount the unified cgroup v2 hierarchy with nsdelegate');
  } catch (err) {
    set('H2', 'failed', `/proc/self/mountinfo could not be read: ${(err as Error).message}`, 'run the engine where /proc is mounted');
  }

  // H3: the scope (D2 §3.1).
  if (scope) set('H3', 'passed', `${scope.unit} with Delegate=yes, owned by uid ${process.getuid?.() ?? '?'}; the engine is in ${scope.supervisor}`);
  else set('H3', 'failed', args.scope.observed, 'start surety from a login session of uid 1000 with a running user manager');

  // H4: memory and pids for the scope's children; cgroup.kill; memory.swap.max
  // settable, written in a probe cgroup.
  if (!scope) set('H4', 'failed', 'no delegated scope to read', 'start surety where the user manager delegates a scope (H3)');
  else {
    const ctl = readControllers(scope.path, 'cgroup.subtree_control') ?? [];
    const missing = ['memory', 'pids'].filter((c) => !ctl.includes(c));
    if (missing.length > 0) set('H4', 'failed', `the scope's children lack ${missing.join(', ')} (subtree_control: ${ctl.join(' ') || 'empty'})`, 'delegate memory and pids to the user manager');
    else {
      const probe = join(scope.path, newId('probe_'));
      try {
        createDomainCgroup(probe, { memoryMax: 64 * 1024 ** 2, tasksMax: 64 });
        const swap = readFileSync(join(probe, 'memory.swap.max'), 'utf8').trim();
        const kill = existsSync(join(probe, 'cgroup.kill'));
        if (swap === '0' && kill) set('H4', 'passed', `memory and pids delegated; cgroup.kill present; memory.swap.max set to 0 in a probe cgroup`);
        else set('H4', 'failed', `memory.swap.max reads ${swap}; cgroup.kill ${kill ? 'present' : 'missing'}`, 'use a kernel with swap accounting and cgroup.kill');
      } catch (err) {
        set('H4', 'failed', `a probe cgroup could not be made with its limits: ${(err as Error).message}`, 'delegate memory and pids to the user manager');
      } finally {
        removeCgroup(probe);
      }
    }
  }

  // H6: the tools, by absolute path, with versions.
  const tools = await resolveSandboxTools();
  if (tools.missing.length > 0) set('H6', 'failed', `missing: ${tools.missing.join(', ')}`, 'install util-linux (unshare, setpriv, mount, umount, pivot_root) and iproute2 (ip)');
  else
    set(
      'H6',
      'passed',
      Object.entries(tools.paths)
        .map(([n, p]) => `${n} ${[...new Set([...toolCandidates(n), p])].join(' = ')} (${tools.versions[n as keyof typeof tools.versions] ?? 'version unknown'})`)
        .join('; '),
    );

  // H5, H7, H11: one start-up trial through the real launcher and init.
  let initCopy: string | null = null;
  try {
    initCopy = await initNodeCopy(rt.home);
  } catch (err) {
    log('host checks', err, { what: 'init node copy' });
  }
  let trial: Trial | null = null;
  if (initCopy !== null && tools.missing.length === 0) {
    try {
      trial = await runTrial(rt, scope, tools, initCopy, deadline);
    } catch (err) {
      trial = { ok: false, detail: (err as Error).message, namespaces: null, node: false, tmpfs: null, overlay: null };
    }
  }
  if (!trial) {
    const why = initCopy === null ? 'the domain init\'s copy of node could not be made' : 'the tools the launcher needs are missing (H6)';
    for (const id of ['H5', 'H7', 'H11']) set(id, 'not_exercised', `the start-up trial could not run: ${why}`, 'see H6');
  } else {
    const ns = trial.namespaces;
    const all = ns !== null && Object.values(ns).every(Boolean);
    if (all) set('H5', 'passed', `user, mount, pid, network, ipc, uts and cgroup namespaces created without privilege`);
    else set('H5', trial.ok ? 'failed' : 'failed', ns ? `not new: ${Object.entries(ns).filter(([, d]) => !d).map(([n]) => n).join(', ')}` : trial.detail, 'allow unprivileged user namespaces');
    if (trial.node) set('H7', 'passed', `node ${process.version} ran from a read-only bind inside the sandbox`);
    else set('H7', 'failed', trial.detail, 'make the engine\'s node readable and runnable');
    const t = trial.tmpfs;
    const o = trial.overlay;
    if (t && t.bytes_bounded && t.inodes_bounded && o?.ok) set('H11', 'passed', `${t.detail}; ${o.detail}`);
    else set('H11', 'failed', [t?.detail ?? trial.detail, o?.detail ?? 'the overlay was not tried'].join('; '), 'run the engine where an unprivileged mount namespace can mount a bounded tmpfs and an overlay');
  }

  // H8: the engine home on a permitted filesystem, outside every mount plan.
  const fsType = filesystemOf(rt.home);
  let realHome = rt.home;
  try {
    realHome = realpathSync(rt.home);
  } catch {
    // judged as given
  }
  const inside = [...SYSTEM_TREES, '/etc', '/dev', '/proc'].find((t) => realHome === t || realHome.startsWith(`${t}/`));
  if (inside) set('H8', 'failed', `the engine home ${realHome} is inside ${inside}, which every mount plan binds`, 'move the engine home out of the system trees');
  else set('H8', 'passed', `${realHome} on ${fsType ?? 'an identified local filesystem'}, outside every mount plan`);

  // H9: the isolation probe suite (slice 12).
  set('H9', 'not_exercised', 'the isolation probe suite (D2 A.6) is not part of this engine revision; no probe was run', 'qualify the host with an engine that runs the probe suite');

  // H10: WSL2 only.
  if (isWsl()) set('H10', 'not_exercised', 'WSL2 host; P11 and P12 are run by the isolation probe suite, which is not part of this engine revision', 'qualify the host with an engine that runs the probe suite');
  else set('H10', 'not_exercised', 'not a WSL2 host; H10 applies only on WSL2', 'nothing to do: H10 is required only on WSL2');

  // H12: memory and disk beyond the reserves for at least one domain.
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const avail = Number(/^MemAvailable:\s+(\d+) kB/m.exec(meminfo)?.[1] ?? NaN) * 1024;
    const st = statfsSync(rt.home);
    const free = st.bavail * st.bsize;
    const needMem = v.host_reserve_memory + v.domain_memory_max;
    const needDisk = v.host_reserve_disk + v.domain_writable_bytes;
    const observed = `memory available ${human(avail)} (needs ${human(needMem)}: host_reserve_memory plus domain_memory_max); disk free ${human(free)} (needs ${human(needDisk)}: host_reserve_disk plus domain_writable_bytes)`;
    if (Number.isFinite(avail) && avail >= needMem && free >= needDisk) set('H12', 'passed', observed);
    else set('H12', 'failed', observed, 'free memory or disk, or lower domain_memory_max, domain_writable_bytes or the reserves');
  } catch (err) {
    set('H12', 'failed', `memory or disk could not be read: ${(err as Error).message}`, 'run the engine where /proc/meminfo and the home\'s filesystem can be read');
  }

  // H13: the optional observer, reported apart (D2 §3.9).
  let bpf = 'unknown';
  try {
    bpf = readFileSync('/proc/sys/kernel/unprivileged_bpf_disabled', 'utf8').trim();
  } catch {
    // reported as unknown
  }
  set(
    'H13',
    'not_exercised',
    `no execution observer loader is configured (kernel.unprivileged_bpf_disabled = ${bpf}); the observer is optional and never required`,
    'install the observer\'s loader with the privilege the operator grants (D2 §3.9, E57) to have it reported',
  );

  // The harness's overrides replace a check's result (SEAM.md §114).
  const forced = seamHostChecks()?.forced ?? {};
  for (const [id, result] of Object.entries(forced)) {
    const c = checks.get(id);
    if (c) checks.set(id, { ...c, result, observed: `${result} (forced; observed: ${c.observed ?? 'nothing'})`, remedy: c.remedy ?? 'this result was forced at start' });
  }

  const ordered = HOST_CHECKS.map((id) => checks.get(id)!);
  const probes = PROBES.map((id) => ({
    id,
    target_seeded: false,
    negative: null,
    control: null,
    result: 'not_exercised',
    reason: 'the isolation probe suite is not part of this engine revision',
  }));
  const blocking = ordered.filter((c) => c.required && c.result !== 'passed');
  const qualifies = blocking.length === 0;
  const versions: Record<string, unknown> = {
    unshare: tools.versions.unshare ?? null,
    setpriv: tools.versions.setpriv ?? null,
    ip: tools.versions.ip ?? null,
    mount: tools.versions.mount ?? null,
    systemd: (await managerReachable()).observed,
    node: process.version,
  };
  const fingerprint = createHash('sha256')
    .update(
      canonical({
        isolation: ISOLATION_MECHANISM,
        boundary: BOUNDARY_MECHANISM,
        kernel: release(),
        tools: versions,
        profile: initCopy && tools.missing.length === 0 ? planShape(rt, tools, initCopy) : null,
      }),
    )
    .digest('hex');
  const host = hostIdentity() ?? 'unknown';
  const evidence = {
    host_id: host,
    kernel: release(),
    tool_versions: versions,
    tool_paths: tools.paths,
    checks: ordered,
    probes,
    mechanism_fingerprint: fingerprint,
    scope: scope ? { unit: scope.unit, path: scope.path } : null,
    trial,
  };
  // What was observed is readable whatever the outcome; only a start whose
  // every required check passed writes a row, with its evidence record
  // (D2 §7.1; SEAM.md §123).
  await rt.store.call('host.observed', {
    checks: ordered,
    probes,
    duration_ms: Math.round(performance.now() - began),
    scope_cgroup: scope?.path ?? null,
    wsl2,
  });
  let row: string | null = null;
  if (qualifies) {
    try {
      const record = await writeWholeRecord(rt, { project: null, run: null, kind: 'qualification_evidence', content: Buffer.from(JSON.stringify(evidence, null, 2)) });
      const written = await rt.engine<{ id: string }>('host.qualification', {
        incarnation: rt.incarnation,
        host_id: host,
        kernel: release(),
        tool_versions: versions,
        mechanism_fingerprint: fingerprint,
        checks: ordered,
        probes,
        evidence: record,
        qualifies,
        unqualified: null,
      });
      row = written.id;
    } catch (err) {
      log('host checks', err, { what: 'record' });
    }
  }
  return { checks: ordered, qualifies, row };
}

// The role profile's plan, without the domain's own paths, for the mechanism
// fingerprint.
function planShape(rt: Runtime, tools: ResolvedTools, initCopy: string): string {
  const t = tools.paths;
  return planFingerprint(
    buildPlan({
      area: join(rt.home, 'domains', '<domain>'),
      context: '/dev/null',
      workspace: '/dev/null',
      readPaths: [],
      writablePaths: [],
      volBytes: rt.config.values.domain_writable_bytes,
      volInodes: rt.config.values.domain_writable_inodes,
      shmBytes: 64 * 1024 ** 2,
      tools: { mount: t.mount!, umount: t.umount!, pivot_root: t.pivot_root!, ip: t.ip!, unshare: t.unshare!, setpriv: t.setpriv! },
      node: engineNode(),
      initNodeCopy: initCopy,
      initScript: initCopy,
    }),
  );
}

export const allHostChecks = HOST_CHECKS;
