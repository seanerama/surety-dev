// The check runner, class `direct` (D3 §§2.1 to 2.7; L1, L2, L4): the
// Checks tick step's admission and one supervisor per admitted execution.
//
// An execution is not a run: no role, no model, no invocation receipt, no
// grant. It reuses D2's launcher, domain init, volatile filesystem, boundary
// and resource envelope, with the check execution in the invocation's place
// (L1): its domain is allocated by the admission transaction; its cgroup is
// made here only while its launch is not closed; the launcher
// (invoke/sandboxed.ts) places itself and is authorized by a transaction
// bound to the execution, the incarnation and the check lease's generation;
// the domain init execs the check's program with no shell and reports
// `started`, the exit and `orphans` on its own channel; termination with
// closure is D2's (boundary/terminate.ts). Nothing here starts a process
// itself: processes start only through the launcher and engine git.
//
// The runner switch (SEAM.md §177): executions are admitted only on the real
// boundary of an engine with a scope, and only while the active host
// qualification has a qualified `check_runner`. On the kernel lane's
// scripted boundary registrations stay `queued`.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createDomainCgroup, verifyLimits } from '../boundary/cgroup.js';
import { type DomainHolder, terminateDomain } from '../boundary/terminate.js';
import { validateReadPaths } from '../invoke/sandbox/plan.js';
import { domainArea } from '../invoke/sandbox/prepare.js';
import { entriesFingerprint, planEntries } from '../invoke/sandbox/mounts.js';
import { type ResolvedTools, engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from '../invoke/sandbox/tools.js';
import { DOMAIN_MARKER } from '../invoke/processes.js';
import { type BackendLaunch, INIT_SCRIPT, SandboxLaunch } from '../invoke/sandboxed.js';
import { writeWholeRecord } from '../records/files.js';
import { type Runtime, log } from '../runtime.js';
import type { Admission, ResultFields } from '../store/transitions/checks.js';
import type { DomainRow } from '../store/transitions/boundary.js';
import { pausePoint, seamLauncherBarriers, seamLauncherReached, seamMainFault } from '../testing/seam.js';
import { hostIdentity } from '../trust/host.js';
import { MaterializationFailed, listTrees, materialize, releaseTree } from './checktree.js';
import { checkLimits } from './limits.js';
import { buildCheckPlan, inputTargetConflict } from './profile.js';
import type { Definition, Governed } from './schema.js';

let tools: ResolvedTools | null = null;

// Standard output and error, interleaved as they arrived, keeping the first
// and the last halves of the bound and counting what was dropped between
// them (D3 §2.6). Output volume never cancels a check.
export class OutputCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const half = Math.floor(this.max / 2);
    let rest = chunk;
    if (this.headBytes < half) {
      const take = rest.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    const keep = this.max - half;
    const joined = Buffer.concat([this.tail, rest]);
    if (joined.length > keep) {
      this.dropped += joined.length - keep;
      this.tail = Buffer.from(joined.subarray(joined.length - keep));
    } else this.tail = joined;
  }

  bytes(): Buffer {
    return Buffer.concat([...this.head, this.tail]);
  }
}

const sha256File = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

export class Supervisor implements DomainHolder {
  readonly claim: { domain: string };
  sandbox: SandboxLaunch | null = null;
  backendStarted = false;
  terminal = null;
  quarantined = false;
  private authorized = false;
  private execFailed: Record<string, unknown> | null = null;
  // What the init reported at the check's own exit (L4): true or false, or
  // null while unreported or unreadable, which is never a pass.
  private orphans: boolean | null = null;
  private cancelAt: number | null = null;
  private cancelCause: 'deadline' | 'lease' | null = null;
  // The check lease lapsed (D2 §3.5's case for checks): ended with no row.
  private leaseLost = false;
  private released = false;
  private reportAt: number | null = null;
  private capture: OutputCapture;
  private outputDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly rt: Runtime,
    readonly a: Admission,
  ) {
    this.claim = { domain: a.domain };
    const governed = a.governed as unknown as Governed | null;
    this.capture = new OutputCapture(governed?.result_collection.output_max_bytes ?? 65536);
  }

  get project(): string {
    return this.a.project;
  }

  private engine<T = unknown>(name: string, args: unknown): Promise<T> {
    return this.rt.engine<T>(name, args);
  }

  // Known not to have started, before anything was launched (D3 §2.7): the
  // domain closed with nothing in it, and a row with the reason.
  private async notRun(reason: ResultFields['not_run_reason'], why: string): Promise<void> {
    log('check not run', new Error(why), { execution: this.a.execution, reason });
    await this.engine('domain.close', { domain: this.a.domain, cause: 'not_run' });
    await this.engine('checks.never_launched', { domain: this.a.domain });
    await this.engine('checks.record', {
      execution: this.a.execution,
      established: false,
      exit_status: null,
      signaled: false,
      deadline_hit: false,
      orphans: false,
      not_run_reason: reason,
      output: null,
      output_dropped_bytes: null,
    } satisfies ResultFields);
    await this.release();
  }

  // The check trees nothing references any more go, once this execution's
  // domain is established terminated (never from a quarantine or a failure
  // whose termination is unknown).
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await releaseUnreferenced(this.rt, this.a.project, this.a.execution);
  }

  async run(): Promise<void> {
    const a = this.a;
    const def = a.definition as unknown as Definition;
    const governed = a.governed as unknown as Governed | null;
    if (governed === null || !Array.isArray(def.command)) return this.notRun('definition_invalid', 'the check has no discovered definition to run');
    // The program, resolved now and recorded whether pinned or not (Q6).
    const name = def.command[0]!;
    const entry = governed.check_commands[name];
    const program = entry?.path ?? null;
    const sha = program === null ? null : sha256File(program);
    await this.engine('checks.toolchain', { execution: a.execution, toolchain: { name, path: program, sha256: sha } });
    if (program === null || sha === null || (entry?.sha256 !== undefined && entry.sha256 !== sha)) {
      return this.notRun('toolchain_missing', program === null ? `${name} is not in check_commands` : sha === null ? `${program} cannot be read` : `${program} is not the pinned program`);
    }
    // The toolchain's read paths, validated as D2 §2.3 validates a role's.
    const mount = await this.rt.read<{ context: { repositories: string[]; workspaces: string[]; checkouts: string[] } }>('mount.context', { project: a.project });
    const refused = await validateReadPaths(governed.runner_config.direct.read_paths, { ...mount.context, home: this.rt.home });
    if (refused !== null) return this.notRun('mount_plan_refused', `${refused.path}: ${refused.detail}`);
    let readPaths: string[];
    try {
      readPaths = governed.runner_config.direct.read_paths.map((p) => realpathSync(p));
    } catch (err) {
      return this.notRun('mount_plan_refused', `a read path cannot be resolved: ${(err as Error).message}`);
    }
    // The check tree (D3 §2.4).
    await pausePoint('checks.before_materialize');
    let tree;
    try {
      tree = await materialize({
        home: this.rt.home,
        scratch: this.rt.scratch,
        repo: a.repo,
        project: a.project,
        revision: a.revision,
        version: a.version,
        roots: a.roots,
        manifests: a.manifests,
        maxEntries: checkLimits().checktree_max_entries,
        maxBytes: checkLimits().checktree_max_bytes,
      });
    } catch (err) {
      if (err instanceof MaterializationFailed) return this.notRun('materialization_failed', err.message);
      throw err;
    }
    await pausePoint('checks.materialized');
    // Every input's target, and each of its ancestors, must be a directory
    // of the source projection or absent there (S1): a link or a file at
    // one refuses the plan before any launcher starts.
    const conflict = inputTargetConflict(tree.src, a.manifest);
    if (conflict !== null) return this.notRun('mount_plan_refused', conflict);
    // The domain's cgroup, only while its launch is not closed (D2 §3.2),
    // and only at this domain's directory in this engine's own scope.
    const scope = this.rt.scope;
    const may = await this.rt.read<{ cgroup_path: string | null; may: boolean }>('domain.may_create', { domain: a.domain });
    if (scope === null || !may.may || may.cgroup_path === null || may.cgroup_path !== join(scope.path, a.domain)) {
      await this.engine('domain.close', { domain: a.domain, cause: 'not_created' });
      await this.engine('checks.never_launched', { domain: a.domain });
      await this.engine('checks.interrupt', { execution: a.execution, why: 'the domain could not be created in this engine scope' });
      return;
    }
    const limits = { memoryMax: this.rt.setting('domain_memory_max'), tasksMax: this.rt.setting('domain_tasks_max') };
    const inode = createDomainCgroup(may.cgroup_path, limits);
    await this.engine('domain.cgroup_created', { domain: a.domain, inode });
    await this.launch(def, governed, tree, readPaths, limits);
  }

  private async launch(def: Definition, governed: Governed, tree: { src: string; protected: string }, readPaths: string[], limits: { memoryMax: number; tasksMax: number }): Promise<void> {
    const a = this.a;
    const rt = this.rt;
    tools ??= await resolveSandboxTools();
    const t = tools.paths;
    if (!t.unshare || !t.setpriv || !t.ip || !t.mount || !t.umount || !t.pivot_root || !t.mknod) throw new Error(`the sandbox's tools are missing: ${tools.missing.join(', ')}`);
    const made = domainArea(rt.home, a.domain);
    for (const d of ['root', 'vol']) mkdirSync(join(made, d), { recursive: true, mode: 0o700 });
    const area = realpathSync(made);
    const copy = await initNodeCopy(rt.home);
    const plan = buildCheckPlan({
      area,
      source: realpathSync(tree.src),
      protectedDir: realpathSync(tree.protected),
      manifest: a.manifest,
      readPaths,
      volBytes: rt.setting('domain_writable_bytes'),
      volInodes: rt.setting('domain_writable_inodes'),
      shmBytes: Math.min(rt.setting('domain_writable_bytes'), 64 * 1024 * 1024),
      tools: { mount: t.mount, umount: t.umount, pivot_root: t.pivot_root, ip: t.ip, unshare: t.unshare, setpriv: t.setpriv, mknod: t.mknod },
      node: engineNode(),
      initNodeCopy: await initNodeIn(area, copy),
      initScript: INIT_SCRIPT,
    });
    // The validated plan, recorded on the domain before the launcher starts.
    const entries = planEntries(plan);
    const fingerprint = entriesFingerprint(entries, { area, workspace: tree.src });
    const record = await writeWholeRecord(rt, {
      project: a.project,
      run: null,
      kind: 'qualification_evidence',
      content: Buffer.from(JSON.stringify({ profile: 'check', fingerprint, domain: a.domain, check_execution: a.execution, entries }, null, 2)),
    });
    await this.engine('domain.plan', { domain: a.domain, fingerprint, mounts: entries, record });
    // The environment, constructed, never inherited (D3 §2.3).
    const env: Record<string, string> = {
      PATH: governed.runner_config.direct.path.join(':'),
      HOME: '/surety/home',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      CI: 'true',
      ...governed.runner_config.direct.env,
      ...def.env,
      SURETY_CHECK: a.key,
      SURETY_CANDIDATE: a.candidate,
      SURETY_SOURCE_REVISION: a.revision,
      SURETY_PROTECTED_VERSION: a.version,
      [DOMAIN_MARKER]: a.domain,
    };
    const backend: BackendLaunch = {
      argv: [governed.check_commands[def.command[0]!]!.path, ...def.command.slice(1)],
      env,
      cwd: def.cwd === '.' ? '/surety/workspace' : join('/surety/workspace', def.cwd),
      stdin: null,
      forwarder: null,
      check: true,
    };
    let deadline: NodeJS.Timeout | null = null;
    let fireDeadline: () => void = () => {};
    const deadlineHit = new Promise<void>((resolve) => (fireDeadline = resolve));
    const w = seamLauncherBarriers(rt.home);
    const launch = new SandboxLaunch(
      {
        domain: a.domain,
        invocation: a.execution,
        incarnation: rt.incarnation,
        generation: a.lease_generation,
        cgroup: a.cgroup_path,
        unshare: t.unshare,
        node: engineNode(),
        ...(w ? { waits: w.barriers, releaseDir: w.releaseDir } : {}),
      },
      {
        barrier: (name) => pausePoint(name),
        reached: (name, action) => seamLauncherReached(name, action),
        placed: async (pid) => {
          await this.engine('domain.placed', { domain: a.domain, pid });
        },
        authorize: async () => {
          if (this.cancelAt !== null) return false;
          const wrong = verifyLimits(a.cgroup_path, limits);
          if (wrong !== null) {
            log('check launch', new Error(`the domain's limits do not read as written: ${wrong}`), { execution: a.execution });
            return false;
          }
          const r = await this.engine<{ granted: boolean; reason: string | null }>('checks.authorize', {
            domain: a.domain,
            execution: a.execution,
            incarnation: rt.incarnation,
            generation: a.lease_generation,
            pid: launch.pid,
            startTime: launch.startTime,
          });
          this.authorized = r.granted;
          return r.granted;
        },
        plan: () => plan,
        backend: () => backend,
        started: async (pid) => {
          this.backendStarted = true;
          // `timeout_s` from the arrival of the init's `started` report; never
          // extended, and disarmed once the check has exited by itself.
          deadline = armDeadline(def.timeout_s * 1000, () => launch.exitReport !== null || launch.dropExitReport, () => {
            if (this.cancelAt === null) {
              this.cancelAt = performance.now();
              this.cancelCause = 'deadline';
            }
            fireDeadline();
          });
          await this.engine('checks.init_report', { execution: a.execution, kind: 'started', detail: { pid } });
        },
        setupFailed: (detail) => log('check launch', new Error(`the sandbox could not be built: ${detail}`), { execution: a.execution }),
        report: (kind, detail) => {
          if (kind === 'orphans') {
            // A count the init could not read, or none, is unknown.
            this.orphans = typeof detail.count === 'number' && Number.isInteger(detail.count) && detail.count >= 0 ? detail.count > 0 : null;
            void this.engine('checks.init_report', { execution: a.execution, kind: 'orphans', detail }).catch((err) => log('check report', err, { execution: a.execution }));
          } else this.execFailed = detail;
        },
        dropExit: () => seamMainFault('init_report_lost'),
      },
    );
    this.sandbox = launch;
    this.outputDone = new Promise<void>((resolve) => {
      launch.output.on('data', (chunk: Buffer) => this.capture.push(chunk));
      launch.output.on('end', () => resolve());
      launch.output.on('error', () => resolve());
    });
    void launch.backendDone.then(() => {
      if (launch.exitReport !== null && this.reportAt === null) this.reportAt = performance.now();
      if (deadline !== null) clearTimeout(deadline);
    });
    // The check lease, renewed while supervised (D3 §2.5).
    const renew = setInterval(() => {
      void this.engine<boolean>('checks.renew', { execution: a.execution, generation: a.lease_generation, incarnation: rt.incarnation })
        .then((ok) => {
          if (ok || this.leaseLost) return;
          // The check lease lapsed (the engine paused past it, D2 §3.5): the
          // execution ends with no verdict, `interrupted` once its domain's
          // closure is observed. Never a test failure, and never a pass.
          this.leaseLost = true;
          if (this.cancelAt === null && launch.exitReport === null) {
            this.cancelAt = performance.now();
            this.cancelCause = 'lease';
          }
          fireDeadline();
        })
        .catch((err) => log('check lease', err, { execution: a.execution }));
    }, (rt.setting('lease_ttl') * 1000) / 4);
    renew.unref?.();
    try {
      await Promise.race([launch.backendDone, deadlineHit]);
      if (launch.exitReport !== null && this.reportAt === null) this.reportAt = performance.now();
      const report = launch.exitReport;
      if (report !== null) {
        launch.ackExit();
        await this.engine('checks.init_report', {
          execution: a.execution,
          kind: report.startFailed === true ? 'exec_failed' : 'exit',
          detail: report.startFailed === true ? (this.execFailed ?? {}) : { code: report.code, signal: report.signal },
        });
      }
      // Termination with closure, whatever the check did (D3 §2.6).
      const d = await rt.read<DomainRow>('domain.row', { domain: a.domain });
      const verdict = await terminateDomain({ rt, d, incarnation: rt.incarnation, handle: this });
      if (deadline !== null) clearTimeout(deadline);
      // An exit report that arrived during termination is the engine's own
      // cancellation's, never the check's exit status.
      if (launch.exitReport !== null && report === null) {
        this.reportAt ??= performance.now();
        await this.engine('checks.init_report', { execution: a.execution, kind: launch.exitReport.startFailed === true ? 'exec_failed' : 'exit', detail: { code: launch.exitReport.code, signal: launch.exitReport.signal } });
      }
      if (!verdict.terminated) {
        this.quarantined = true;
        await this.engine('checks.quarantine', { execution: a.execution, why: verdict.unknown ?? 'termination not established' });
        return;
      }
      await this.collect();
      await this.release();
    } finally {
      clearInterval(renew);
      if (deadline !== null) clearTimeout(deadline);
      launch.closeChannel();
    }
  }

  // At a tick, a quarantined execution's domain is observed again; once its
  // termination is observed, the row is recorded from what the init had
  // reported (D3 §2.6).
  async reobserve(): Promise<boolean> {
    const d = await this.rt.read<DomainRow>('domain.row', { domain: this.a.domain });
    const verdict = await terminateDomain({ rt: this.rt, d, incarnation: this.rt.incarnation, handle: this, observeOnly: true });
    if (!verdict.terminated) return false;
    this.quarantined = false;
    await this.collect();
    await this.release();
    return true;
  }

  // After termination: the output record and the result row.
  private async collect(): Promise<void> {
    const a = this.a;
    const launch = this.sandbox!;
    await this.engine('checks.collecting', { execution: a.execution });
    await pausePoint('collect.before_read');
    const report = launch.exitReport;
    const pre = decideResult({
      leaseLost: this.leaseLost,
      authorized: this.authorized,
      started: this.backendStarted,
      execFailed: this.execFailed !== null,
      report,
      cancelAt: this.cancelAt,
      cancelCause: this.cancelCause,
      reportAt: this.reportAt,
      orphans: this.orphans,
    });
    if (pre.kind === 'interrupt') {
      await this.engine('checks.interrupt', { execution: a.execution, why: pre.why });
      return;
    }
    const whole = await Promise.race([this.outputDone.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    // What was dropped is known only when the init said the output ended:
    // otherwise bytes may be missing that nothing counted.
    const dropped = whole && launch.outputEof ? this.capture.dropped : null;
    let output: string | null = null;
    try {
      output = await writeWholeRecord(this.rt, { project: a.project, run: null, kind: 'check_output', content: this.capture.bytes() });
    } catch (err) {
      log('check output', err, { execution: a.execution });
    }
    const fields: ResultFields = { execution: a.execution, ...pre.fields, output, output_dropped_bytes: dropped };
    await this.engine('checks.record', fields);
  }
}

// A check's deadline (D3 §2.5): armed when the init's `started` report
// arrives, firing `fire` after `ms` unless the check has exited by itself
// by then (`exited`), and disarmed by clearing it once it has.
export function armDeadline(ms: number, exited: () => boolean, fire: () => void): NodeJS.Timeout {
  const t = setTimeout(() => {
    if (!exited()) fire();
  }, ms);
  t.unref?.();
  return t;
}

export interface Observed {
  leaseLost: boolean;
  authorized: boolean;
  started: boolean;
  execFailed: boolean;
  report: { code: number | null; signal: number | null; startFailed?: boolean } | null;
  cancelAt: number | null;
  cancelCause: 'deadline' | 'lease' | null;
  reportAt: number | null;
  orphans: boolean | null;
}

// What an execution established, from what the engine itself observed of
// it (D3 §§2.6, 2.7): never from anything check code wrote.
// - a lapsed check lease: no verdict, `interrupted` (D2 §3.5's case);
// - neither `started` nor `exec_failed`: not known to have started, no row;
// - `exec_failed`: not established, skipped;
// - otherwise established with its launch authorized and `started` seen;
//   the exit status is the check's own only when its exit report reached
//   the engine before the engine began cancelling it; a deadline sets
//   `deadline_hit` and `signaled`; `orphans` unknown stays unknown (null),
//   which never passes.
export function decideResult(o: Observed): { kind: 'interrupt'; why: string } | { kind: 'record'; fields: Omit<ResultFields, 'execution' | 'output' | 'output_dropped_bytes'> } {
  if (o.leaseLost) return { kind: 'interrupt', why: 'the check lease lapsed: the engine did not hold the execution throughout' };
  const execFailed = o.report?.startFailed === true || (o.execFailed && !o.started);
  if (!o.started && !execFailed) return { kind: 'interrupt', why: 'the domain ended with neither a started nor an exec_failed report' };
  if (execFailed) return { kind: 'record', fields: { established: false, exit_status: null, signaled: false, deadline_hit: false, orphans: false, not_run_reason: 'exec_failed' } };
  const cancelledFirst = o.cancelAt !== null && (o.reportAt === null || o.reportAt >= o.cancelAt);
  const own = o.report !== null && !cancelledFirst;
  return {
    kind: 'record',
    fields: {
      established: o.authorized && o.started,
      exit_status: own && o.report!.signal === null ? o.report!.code : null,
      signaled: (own && o.report!.signal !== null) || cancelledFirst,
      deadline_hit: cancelledFirst && o.cancelCause === 'deadline',
      orphans: o.orphans,
      not_run_reason: null,
    },
  };
}

// Every check tree of the project no execution or current candidate
// references any more is removed (D3 §2.4).
async function releaseUnreferenced(rt: Runtime, project: string, except: string): Promise<void> {
  for (const t of listTrees(rt.home, project)) {
    try {
      if (!(await rt.read<boolean>('checks.tree_in_use', { project, revision: t.revision, version: t.version, except }))) releaseTree(rt.home, project, t.revision, t.version);
    } catch (err) {
      log('check tree', err, { project, tree: `${t.revision}-${t.version}` });
    }
  }
}

export class CheckRunner {
  private readonly live = new Map<string, Supervisor>();

  constructor(private readonly rt: Runtime) {}

  // The tick step "Checks", after Gates (L2): registrations owed to a
  // trigger whose facts are now read, re-observation of quarantined
  // executions, and admission of queued ones within the envelope and
  // `max_concurrent_checks`.
  async step(project: string): Promise<void> {
    await this.rt.engine('checks.register_due', { project });
    if (this.rt.boundary() !== 'real' || this.rt.scope === null) return;
    for (const s of this.live.values()) {
      if (s.project !== project || !s.quarantined) continue;
      if (await s.reobserve().catch((err) => (log('check quarantine', err, { execution: s.a.execution }), false))) this.live.delete(s.a.execution);
    }
    const host = hostIdentity();
    if (host === null) return;
    for (let i = 0; i < 8; i++) {
      const a = await this.rt.engine<Admission | null>('checks.admit', { project, incarnation: this.rt.incarnation, scope: this.rt.scope.path, hostId: host });
      if (a === null) return;
      const s = new Supervisor(this.rt, a);
      this.live.set(a.execution, s);
      void s
        .run()
        .catch(async (err) => {
          log('check execution', err, { execution: a.execution });
          // Whatever failed, nothing is claimed of the check: its domain is
          // terminated if it can be, and the execution ends with no row.
          try {
            const d = await this.rt.read<DomainRow>('domain.row', { domain: a.domain });
            const v = d.status === 'terminated' ? { terminated: true as const } : await terminateDomain({ rt: this.rt, d, incarnation: this.rt.incarnation, handle: s });
            if (v.terminated) {
              await this.rt.engine('checks.interrupt', { execution: a.execution, why: (err as Error).message });
              await s.release();
            }
            else {
              s.quarantined = true;
              await this.rt.engine('checks.quarantine', { execution: a.execution, why: v.unknown ?? 'termination not established' });
            }
          } catch (inner) {
            log('check execution', inner, { execution: a.execution });
          }
        })
        .finally(() => {
          if (!s.quarantined) this.live.delete(a.execution);
          this.rt.services?.requestTick();
        });
    }
  }
}

// At start (D3 §2.6, T07): an execution a prior incarnation left past
// `queued` is never recorded as run or not run. Its domain's closure is
// established first; then it ends `interrupted` with no row. One whose
// termination cannot be established stays quarantined. Its registration
// again, as trigger `recovery`, is slice 18's.
// `priorUnknown`: per prior incarnation, why its domains are unknown (its
// supervisor leaf could not be closed, D2 §3.3); such a domain is never taken
// for terminated, so its execution stays quarantined.
export async function recoverChecks(rt: Runtime, priorUnknown: ReadonlyMap<string, string> = new Map()): Promise<void> {
  const live = await rt.read<{ id: string; domain: string | null }[]>('checks.live');
  for (const x of live) {
    try {
      if (x.domain === null) {
        await rt.engine('checks.interrupt', { execution: x.id, why: 'the engine restarted before its domain was allocated' });
        continue;
      }
      const d = await rt.read<DomainRow & { incarnation?: string }>('domain.row', { domain: x.domain });
      if (d.cgroup_inode === null) {
        await rt.engine('domain.close', { domain: d.id, cause: 'recovery' });
        if (d.status !== 'terminated') await rt.engine('checks.never_launched', { domain: d.id });
        await rt.engine('checks.interrupt', { execution: x.id, why: 'the engine restarted before its domain was created' });
        continue;
      }
      const owner = await rt.read<{ incarnation: string } | null>('checks.domain_owner', { domain: d.id });
      const known = owner === null ? 'the domain has no recorded owner' : (priorUnknown.get(owner.incarnation) ?? null);
      const v = d.status === 'terminated' ? { terminated: true as const } : await terminateDomain({ rt, d, incarnation: owner?.incarnation ?? rt.incarnation, handle: undefined, knownUnknown: known });
      if (v.terminated) await rt.engine('checks.interrupt', { execution: x.id, why: 'the engine restarted during the execution' });
      else await rt.engine('checks.quarantine', { execution: x.id, why: v.unknown ?? 'termination not established' });
    } catch (err) {
      log('check recovery', err, { execution: x.id });
    }
  }
}
