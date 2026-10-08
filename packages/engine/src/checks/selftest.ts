// The runner self-test (D3 §2.8, R17; T18, T19; E95; SEAM.md §208): at an
// engine start whose host qualification is active, scripted check programs
// run in real `check` domains of this host, each beside a control, and the
// outcome is recorded once on `host_qualifications.check_runner`. `direct`
// is qualified only when every mandatory case and its control `passed`; a
// `failed` or `not_exercised` case leaves it unqualified. A passed self-test
// qualifies the runner, never a project's checks.
//
// What is real here, and shared with the runner (checks/run.ts): the check
// profile's mount plan (profile.ts), the domain init in its check mode, the
// launcher (invoke/sandboxed.ts), program resolution, the constructed
// environment, the output capture, the deadline and the judgment of what an
// execution established (`decideResult`). The domains are the self-test's
// own, like the isolation probe suite's boxes: a cgroup `selftest_<ULID>` in
// this engine's scope, an area `<home>/domains/selftest_<ULID>` and a small
// check tree under `<home>/selftest/`, all made here and removed here; none
// is a store row, since a domain row belongs to a check execution of a
// project (L1). Nothing is admitted while the self-test runs (run.ts).
//
// The programs (invoke/check-selftest-program.ts) are plain: each refuses to
// act outside a check domain, and none signals anything. The engine's half
// of the guard: no program starts unless the host reads the box's init in a
// pid namespace of its own. The one signal the self-test sends a program is
// the `foreign_signal` case's SIGKILL, to a pid it has just read from its own
// box's `cgroup.procs` and verified, and verifies again immediately before
// the signal (membership, command line, start time, a nested pid
// namespace); a pid that fails any check is never signalled, and the case is
// then `not_exercised` with the reason.
//
// The B01 case's evidence is structural (E95): the engine reads, from the
// host, the mount table of the case's own check process while it holds, and
// requires every input and each directory from it up to /surety/workspace
// to lie on a read-only mount below the workspace that is no overlay with an
// upper layer. No program renames, exchanges, replaces or relinks anything.

import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { type DomainLimits, createDomainCgroup, homeScopes, isHomeScope, readPopulated, readProcs, removeCgroup, verifyLimits, writeKill } from '../boundary/cgroup.js';
import { ownedHomeEntry } from '../home-entries.js';
import { newId } from '../ids.js';
import { containedFromHost } from '../invoke/probes/suite.js';
import { ECHO_HOST, echoEndpoint } from '../invoke/proxy/echo.js';
import { proxyLimits } from '../invoke/proxy/egress.js';
import { DomainProxy } from '../invoke/proxy/proxy.js';
import { activeResolver } from '../invoke/proxy/resolver.js';
import { EGRESS_SOCKET, SYSTEM_TREES, unescape } from '../invoke/sandbox/mounts.js';
import { validateReadPaths } from '../invoke/sandbox/plan.js';
import { FORWARDER_PORT, domainArea } from '../invoke/sandbox/prepare.js';
import { engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from '../invoke/sandbox/tools.js';
import { INIT_SCRIPT, SandboxLaunch } from '../invoke/sandboxed.js';
import { type Runtime, log } from '../runtime.js';
import type { CheckRunnerState, ResultFields } from '../store/transitions/checks.js';
import { seamSelfTestForced } from '../testing/seam.js';
import { buildCheckPlan, checkProfileFingerprint } from './profile.js';
import { OutputCapture, armDeadline, checkCwd, checkDomainLimits, checkEnvironment, decideResult, resolveProgram } from './run.js';
import type { Definition, Governed, ManifestEntry } from './schema.js';
import { SELF_TEST_CASES, type SelfTestCase } from './selftest-cases.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SELF_TEST_PROGRAM = join(here, '..', 'invoke', 'check-selftest-program.js');

const BOX_ID = /^selftest_[0-9A-HJKMNP-TV-Z]{26}$/;
const WORKSPACE = '/surety/workspace';
// The self-test's own check tree: the program and two more inputs, one two
// directories below the workspace in a top-level directory the source does
// not have (a read-only bind), one beside source (a read-only overlay with
// no upper layer); and two source files, one of them in a directory no
// input is under (the ordinary source write).
const PROGRAM_INPUT = '.selftest/program.mjs';
const DEEP_INPUT = 'inputs/deep/input.txt';
const BESIDE_INPUT = 'app/expect/value.txt';
const SOURCE_BESIDE = 'app/main.txt';
const SOURCE_WRITE = 'lib/source.txt';
const INPUT_BYTES = 'the protected input of the runner self-test\n';
const SOURCE_BYTES = 'source of the runner self-test\n';
const UNDECLARED_HOST = 'undeclared.surety.invalid';

export type State = 'passed' | 'failed' | 'skipped';

// D1 §9.2 step 4 with L4, for a recorded result: not established is
// skipped; established passes only with exit 0, not signaled, no deadline
// and no orphans known absent.
export function stateOf(f: Pick<ResultFields, 'established' | 'exit_status' | 'signaled' | 'deadline_hit' | 'orphans'>): State {
  if (!f.established) return 'skipped';
  return f.exit_status === 0 && !f.signaled && !f.deadline_hit && f.orphans === false ? 'passed' : 'failed';
}

// One run of a self-test program in its own check domain.
export interface Run {
  // `recorded`: what the engine established, judged; `not_run`: the reason
  // the runner knows it did not start; `interrupted`: nothing established.
  outcome: 'recorded' | 'not_run' | 'interrupted';
  fields: Omit<ResultFields, 'execution' | 'output' | 'output_dropped_bytes'> | null;
  state: State | null;
  reason: string | null;
  report: { code: number | null; signal: number | null } | null;
  output: string;
  notes: Record<string, unknown>;
}

interface RunSpec {
  key: string;
  args: string[];
  timeoutS: number;
  command?: 'node' | 'gone';
  egress?: string[];
  // While the program runs, after its `started` report.
  whileRunning?: (ctx: BoxContext) => Promise<void>;
  // Each line of its output as it arrives.
  onLine?: (line: string, ctx: BoxContext) => void;
}

interface BoxContext {
  id: string;
  cgroup: string;
  notes: Record<string, unknown>;
  cancel: () => void;
}

// ---- the structural reading of B01 (E95; SEAM.md §§198, 208) --------------------------------

export interface Mount {
  id: string;
  parent: string;
  point: string;
  options: string[];
  fstype: string;
  superopts: string;
}

export function parseMountinfo(lines: string[]): Mount[] {
  const out: Mount[] = [];
  for (const line of lines) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const fields = line.slice(0, sep).split(' ');
    const [fstype = '', , superopts = ''] = line.slice(sep + 3).split(' ');
    if (fields.length < 6) continue;
    out.push({ id: fields[0]!, parent: fields[1]!, point: unescape(fields[4]!), options: fields[5]!.split(','), fstype, superopts });
  }
  return out;
}

const under = (path: string, point: string): boolean => path === point || path.startsWith(point.endsWith('/') ? point : `${point}/`);

// The mount a path lies on: of the mount points that are the path or an
// ancestor, the longest; of those stacked there, the top one.
export function mountAt(mounts: Mount[], path: string): Mount | null {
  const holding = mounts.filter((m) => under(path, m.point));
  if (holding.length === 0) return null;
  const longest = Math.max(...holding.map((m) => m.point.length));
  const stack = holding.filter((m) => m.point.length === longest);
  return stack.find((m) => !stack.some((o) => o.parent === m.id)) ?? stack.at(-1) ?? null;
}

// Why an input's pathname, or a directory from it up to the workspace, does
// not lie on a read-only mount of its own below the workspace with no upper
// layer; null when every one does.
export function immutableProblem(mounts: Mount[], input: string): string | null {
  const parts = input.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const path = `${WORKSPACE}/${parts.slice(0, i).join('/')}`;
    const m = mountAt(mounts, path);
    if (m === null) return `${path} lies on no mount of the table`;
    if (!m.point.startsWith(`${WORKSPACE}/`)) return `${path} lies on ${m.point}, not on a mount of its own below ${WORKSPACE}`;
    if (!(m.options.includes('ro') || m.superopts.split(',').includes('ro'))) return `${path} lies on ${m.point}, which is not read-only`;
    if (m.fstype === 'overlay' && /(^|,)upperdir=/.test(m.superopts)) return `${path} lies on ${m.point}, an overlay with an upper layer`;
  }
  return null;
}

// ---- host-side reads of a box's processes -----------------------------------------------------

const cmdlineOf = (pid: number): string[] | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0);
  } catch {
    return null;
  }
};
const startTimeOf = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
};
const nestedPidNs = (pid: number): boolean => {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('NSpid:'));
    const ids = line ? line.slice(6).trim().split(/\s+/) : [];
    return ids.length >= 2 && readlinkSync(`/proc/${pid}/ns/pid`) !== readlinkSync('/proc/self/ns/pid');
  } catch {
    return false;
  }
};

// The host pid of the self-test program in the box whose command line holds
// `marker` (its mode, and the case's tag): a member of the box's own
// `cgroup.procs`, in a pid namespace nested in the engine's.
export function programIn(cgroup: string, marker: string[]): { pid: number; startTime: string } | null {
  for (const pid of readProcs(cgroup) ?? []) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const cmd = cmdlineOf(pid);
    if (cmd === null || !cmd.some((a) => a.endsWith(`/${PROGRAM_INPUT}`)) || !marker.every((m) => cmd.includes(m))) continue;
    const st = startTimeOf(pid);
    if (st === null || !nestedPidNs(pid)) continue;
    return { pid, startTime: st };
  }
  return null;
}

// ---- the self-test ------------------------------------------------------------------------------

export class RunnerSelfTest {
  private aborted = false;
  private current: { cgroup: string; launch: SandboxLaunch | null; area: string } | null = null;
  private tree: string | null = null;
  private readonly hostNs: string;

  constructor(private readonly rt: Runtime) {
    const ns = (n: string) => readlinkSync(`/proc/self/ns/${n}`).replace(/^[a-z]+:/, '');
    this.hostNs = `pid:${ns('pid')},net:${ns('net')},mnt:${ns('mnt')}`;
  }

  // At shutdown: the box in progress is killed through its own cgroup and
  // removed, its launcher (this engine's child) killed, its area removed;
  // nothing more starts. Synchronous, bounded to about a second.
  abort(): void {
    this.aborted = true;
    const c = this.current;
    if (c === null) {
      this.removeTree();
      return;
    }
    try {
      c.launch?.child.kill('SIGKILL');
    } catch {
      // gone
    }
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 50; i++) {
      const p = readPopulated(c.cgroup);
      if (p.state === 'absent') break;
      if (p.state === 'populated' && p.value === 0) {
        if (removeCgroup(c.cgroup)) break;
      } else writeKill(c.cgroup);
      Atomics.wait(wait, 0, 0, 20);
    }
    try {
      c.launch?.releaseVolatile();
    } catch {
      // nothing held
    }
    this.removeOwned('domains', c.area);
    this.removeTree();
  }

  private removeTree(): void {
    if (this.tree !== null) this.removeOwned('selftest', this.tree);
  }

  // A tree or an area of the self-test's, removed only as an entry of the
  // home's own `selftest/` or `domains/`, by real path, never through a link.
  private removeOwned(sub: 'selftest' | 'domains', path: string): void {
    const why = ownedHomeEntry(this.rt.home, sub, path, BOX_ID);
    if (why !== null) {
      log('runner self-test', new Error(`not removed: ${why}`), { path });
      return;
    }
    try {
      chmodTree(path);
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      log('runner self-test', err, { path });
    }
  }

  // Run every case and record the outcome once on the active host
  // qualification. Returns what was recorded, or null when there is no
  // active host qualification to record it on.
  async run(): Promise<CheckRunnerState | null> {
    const forced = seamSelfTestForced();
    const treeRoot = join(this.rt.home, 'selftest', newId('selftest_'));
    this.tree = treeRoot;
    const runs = new Map<string, Promise<Run>>();
    const results: CheckRunnerState['self_test'] = [];
    let ctx: Awaited<ReturnType<RunnerSelfTest['prepare']>> | null = null;
    let why: string | null = null;
    try {
      ctx = await this.prepare(treeRoot);
    } catch (err) {
      why = `the self-test could not be prepared: ${(err as Error).message}`;
      log('runner self-test', err);
    }
    const once = (spec: RunSpec): Promise<Run> => {
      let p = runs.get(spec.key);
      if (!p) {
        p = ctx === null ? Promise.resolve(notRun(why ?? 'not prepared')) : this.box(ctx, spec).catch((err) => interrupted(`the run failed: ${(err as Error).message}`));
        runs.set(spec.key, p);
      }
      return p;
    };
    try {
      for (const name of SELF_TEST_CASES) {
        if (forced[name] === 'not_exercised') {
          results.push({ case: name, control: CONTROLS[name], result: 'not_exercised', evidence: { reason: 'not run at this start: forced by the test seam' } });
          continue;
        }
        let verdict: { result: 'passed' | 'failed' | 'not_exercised'; evidence: Record<string, unknown> };
        if (this.aborted) verdict = { result: 'not_exercised', evidence: { reason: 'the engine stopped during the self-test' } };
        else {
          try {
            verdict = await this.judge(name, once, ctx);
          } catch (err) {
            verdict = { result: 'failed', evidence: { reason: (err as Error).message } };
          }
        }
        if (forced[name] === 'failed') verdict = { result: 'failed', evidence: { ...verdict.evidence, observed: verdict.result, forced: 'failed by the test seam' } };
        results.push({ case: name, control: CONTROLS[name], result: verdict.result, evidence: verdict.evidence });
      }
    } finally {
      this.removeTree();
    }
    if (this.aborted) return null;
    const state: CheckRunnerState = {
      profile_fingerprint: checkProfileFingerprint(),
      self_test: results,
      qualified: results.length === SELF_TEST_CASES.length && results.every((r) => r.result === 'passed'),
    };
    const row = await this.rt.engine<string | null>('checks.set_runner', state);
    return row === null ? null : state;
  }

  // The tree, the governed fields and the plan's fixed parts.
  private async prepare(treeRoot: string) {
    if (this.rt.scope === null) throw new Error('this engine has no scope');
    // After any wait, an abort creates nothing more (review m5).
    const halt = () => {
      if (this.aborted) throw new Error('the engine stopped');
    };
    halt();
    const src = join(treeRoot, 'src');
    const proj = join(treeRoot, 'proj');
    const node = engineNode();
    const files: [string, string, Buffer | string, number][] = [
      [src, SOURCE_BESIDE, SOURCE_BYTES, 0o644],
      [src, SOURCE_WRITE, SOURCE_BYTES, 0o644],
      [proj, DEEP_INPUT, INPUT_BYTES, 0o444],
      [proj, BESIDE_INPUT, INPUT_BYTES, 0o444],
      [proj, PROGRAM_INPUT, readFileSync(SELF_TEST_PROGRAM), 0o444],
    ];
    for (const [root, rel, content, mode] of files) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      writeFileSync(path, content);
      chmodSync(path, mode);
    }
    // The input files are read-only; their directories stay the owner's to
    // remove, so a tree left by a crash never blocks the removal of the home
    // (what holds the inputs immutable in the domain is its mounts, B01).
    const blob = (b: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
    const manifest: ManifestEntry[] = [PROGRAM_INPUT, BESIDE_INPUT, DEEP_INPUT].map((p) => [p, 'blob', '100644', blob(readFileSync(join(proj, p)))] as ManifestEntry);
    // The node installation's prefix, read-only, unless it lies under the
    // system trees the profile already has.
    const prefix = dirname(dirname(node));
    const readPaths = SYSTEM_TREES.some((t) => prefix === t || prefix.startsWith(`${t}/`)) ? [] : [realpathSync(prefix)];
    const refused = await validateReadPaths(readPaths, { repositories: [], workspaces: [], checkouts: [], home: this.rt.home });
    halt();
    if (refused !== null) throw new Error(`the node installation cannot be a read path: ${refused.path}: ${refused.detail}`);
    const governed = {
      check_commands: { node: { path: node }, gone: { path: join(treeRoot, 'no-such-program') } },
      runner_config: { direct: { read_paths: readPaths, path: [dirname(node), '/usr/bin', '/bin'], env: {}, egress_allow: [ECHO_HOST], timeout_max_s: 600 } },
      result_collection: { output_max_bytes: 65536 },
    } as unknown as Governed;
    const tools = await resolveSandboxTools();
    halt();
    const t = tools.paths;
    if (!t.unshare || !t.setpriv || !t.ip || !t.mount || !t.umount || !t.pivot_root || !t.mknod) throw new Error(`the sandbox's tools are missing: ${tools.missing.join(', ')}`);
    const copy = await initNodeCopy(this.rt.home);
    halt();
    const expected = createHash('sha256').update(INPUT_BYTES).digest('hex');
    return { src: realpathSync(src), proj: realpathSync(proj), manifest, readPaths, governed, tools: t, copy, expected, scope: this.rt.scope };
  }

  // One program in one check domain of the self-test's own.
  private async box(ctx: Awaited<ReturnType<RunnerSelfTest['prepare']>>, spec: RunSpec): Promise<Run> {
    if (this.aborted) return interrupted('the engine stopped');
    const rt = this.rt;
    const def = {
      command: [spec.command ?? 'node', `${WORKSPACE}/${PROGRAM_INPUT}`, '--host-ns', this.hostNs, ...spec.args],
      cwd: '.',
      env: {},
      timeout_s: spec.timeoutS,
      egress: spec.egress ?? [],
    } as unknown as Definition;
    const program = resolveProgram(ctx.governed, def);
    if (program.problem !== null) return notRun('toolchain_missing', { toolchain: { name: program.name, path: program.path, sha256: program.sha256 }, why: program.problem });
    if (this.aborted) return interrupted('the engine stopped');
    const id = newId('selftest_');
    const made = domainArea(rt.home, id);
    for (const d of ['root', 'vol']) mkdirSync(join(made, d), { recursive: true, mode: 0o700 });
    const area = realpathSync(made);
    const cgroup = join(ctx.scope.path, id);
    this.current = { cgroup, launch: null, area };
    const bounds = checkDomainLimits(rt);
    const limits: DomainLimits = { memoryMax: bounds.memoryMax, tasksMax: bounds.tasksMax };
    const notes: Record<string, unknown> = {};
    let proxy: DomainProxy | null = null;
    let launch: SandboxLaunch | null = null;
    // After any wait, an abort (the engine stopping) creates nothing more
    // (review m5): the box ends here, and the finally removes what exists.
    const stopped = () => (this.aborted ? interrupted('the engine stopped') : null);
    let counted = false;
    try {
      // Counted in the resource envelope before its cgroup exists (m6).
      await this.countInEnvelope({ cgroup, memoryMax: limits.memoryMax, writableBytes: bounds.volBytes });
      counted = true;
      const early = stopped();
      if (early !== null) return early;
      createDomainCgroup(cgroup, limits);
      if ((spec.egress ?? []).length > 0) {
        proxy = new DomainProxy({ area, domain: id, run: null, invocation: null, profile: 'check', allow: spec.egress!, limits: proxyLimits(rt), resolver: activeResolver(), echo: echoEndpoint });
        await proxy.listen();
        const after = stopped();
        if (after !== null) return after;
      }
      const initCopy = await initNodeIn(area, ctx.copy);
      const afterCopy = stopped();
      if (afterCopy !== null) return afterCopy;
      const plan = buildCheckPlan({
        area,
        source: ctx.src,
        projection: ctx.proj,
        manifest: ctx.manifest,
        egressSocket: proxy?.socketPath ?? null,
        readPaths: ctx.readPaths,
        volBytes: bounds.volBytes,
        volInodes: bounds.volInodes,
        shmBytes: Math.min(bounds.volBytes, 64 * 1024 * 1024),
        tools: { mount: ctx.tools.mount!, umount: ctx.tools.umount!, pivot_root: ctx.tools.pivot_root!, ip: ctx.tools.ip!, unshare: ctx.tools.unshare!, setpriv: ctx.tools.setpriv!, mknod: ctx.tools.mknod! },
        node: engineNode(),
        initNodeCopy: initCopy,
        initScript: INIT_SCRIPT,
      });
      const env = checkEnvironment({ governed: ctx.governed, def, ids: { check: `selftest:${spec.key}`, candidate: '-', revision: '-', version: '-' }, marker: id, proxy: proxy !== null });
      let started = false;
      let authorized = false;
      let execFailed = false;
      let orphans: boolean | null = null;
      let cancelAt: number | null = null;
      let reportAt: number | null = null;
      let refusal: string | null = null;
      let fire: () => void = () => {};
      const cancelled = new Promise<void>((resolve) => (fire = resolve));
      const cancel = () => {
        cancelAt ??= performance.now();
        fire();
      };
      const boxCtx: BoxContext = { id, cgroup, notes, cancel };
      let deadline: NodeJS.Timeout | null = null;
      const beforeLaunch = stopped();
      if (beforeLaunch !== null) return beforeLaunch;
      const l: SandboxLaunch = new SandboxLaunch(
        { domain: id, invocation: id, incarnation: rt.incarnation, generation: 0, cgroup, unshare: ctx.tools.unshare!, node: engineNode() },
        {
          // The engine's half of the guard: the program starts only once the
          // host reads the box's init in a pid namespace of its own.
          barrier: async (name) => {
            if (name !== 'init.before_backend') return;
            const why = containedFromHost(l.pid, cgroup);
            if (why !== null) {
              refusal = why;
              l.closed = true;
              cancel();
            }
          },
          placed: async () => {},
          authorize: async () => {
            authorized = verifyLimits(cgroup, limits) === null && !this.aborted;
            return authorized;
          },
          plan: () => plan,
          backend: () => ({ argv: [program.path!, ...def.command.slice(1)], env, cwd: checkCwd(def), stdin: null, forwarder: proxy ? { port: FORWARDER_PORT, socket: EGRESS_SOCKET } : null, check: true }),
          started: async () => {
            started = true;
            deadline = armDeadline(spec.timeoutS * 1000, () => l.exitReport !== null, cancel);
            if (spec.whileRunning) void spec.whileRunning(boxCtx).catch((err) => (notes.while_running = (err as Error).message));
          },
          setupFailed: (detail) => {
            notes.setup_failed = detail;
            cancel();
          },
          report: (kind, detail) => {
            if (kind === 'orphans') orphans = typeof detail.count === 'number' && Number.isInteger(detail.count) && detail.count >= 0 ? detail.count > 0 : null;
            else execFailed = true;
          },
        },
      );
      launch = l;
      this.current = { cgroup, launch: l, area };
      const capture = new OutputCapture(65536);
      let partial = '';
      const outputDone = new Promise<void>((resolve) => {
        l.output.on('data', (chunk: Buffer) => {
          capture.push(chunk);
          if (!spec.onLine) return;
          partial += chunk.toString('utf8');
          let at: number;
          while ((at = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, at);
            partial = partial.slice(at + 1);
            try {
              spec.onLine(line, boxCtx);
            } catch (err) {
              notes.on_line = (err as Error).message;
            }
          }
        });
        l.output.on('end', () => resolve());
        l.output.on('error', () => resolve());
      });
      void l.backendDone.then(() => {
        reportAt ??= performance.now();
      });
      // Bounded whatever happens: the case's timeout and a margin.
      const stall = setTimeout(cancel, spec.timeoutS * 1000 + 30_000);
      stall.unref?.();
      await Promise.race([l.backendDone, cancelled]);
      clearTimeout(stall);
      if (l.exitReport !== null) reportAt ??= performance.now();
      const report = l.exitReport;
      if (report !== null) l.ackExit();
      const closed = await this.terminate(l, cgroup);
      if (deadline !== null) clearTimeout(deadline);
      if (l.exitReport !== null) reportAt ??= performance.now();
      notes.termination = closed;
      await Promise.race([outputDone, sleep(2000)]);
      const output = capture.bytes().toString('utf8');
      if (refusal !== null) return { ...interrupted(`containment was not read from the host: ${refusal}`), output, notes };
      if (closed !== 'terminated') return { ...interrupted(`the box's termination was not established: ${closed}`), output, notes };
      const decided = decideResult({
        leaseLost: false,
        authorized,
        started,
        execFailed,
        report: l.exitReport === null ? null : { code: l.exitReport.code, signal: l.exitReport.signal, ...(l.exitReport.startFailed ? { startFailed: true } : {}) },
        cancelAt,
        cancelCause: cancelAt === null ? null : 'deadline',
        reportAt,
        orphans,
      });
      const finalReport = l.exitReport === null ? null : { code: l.exitReport.code, signal: l.exitReport.signal };
      if (decided.kind === 'interrupt') return { ...interrupted(decided.why), output, notes, report: finalReport };
      return { outcome: 'recorded', fields: decided.fields, state: stateOf(decided.fields), reason: null, report: finalReport, output, notes };
    } finally {
      await this.ensureGone(cgroup, launch);
      if (proxy !== null) notes.egress_entries = proxy.entries.map((e) => ({ authority: e.authority, decision: e.decision, reason: e.reason }));
      await proxy?.close().catch(() => {});
      try {
        launch?.releaseVolatile();
        launch?.closeChannel();
      } catch {
        // nothing held
      }
      this.removeOwned('domains', area);
      this.current = null;
      if (counted) await this.countInEnvelope(null);
    }
  }

  // The box running now, or none, as the store's resource envelope counts
  // it (review m6). A failure to say so is logged; the box is small.
  private async countInEnvelope(box: { cgroup: string; memoryMax: number; writableBytes: number } | null): Promise<void> {
    try {
      await this.rt.store.call('envelope.self_test_boxes', { boxes: box === null ? [] : [box] });
    } catch (err) {
      log('runner self-test', err, { what: 'resource envelope' });
    }
  }

  // The box ended: TERM through its init, `terminate_grace`, then
  // `cgroup.kill` on the box's own cgroup and `kill_grace`; its launcher
  // (this engine's child) killed if it was never placed; the cgroup removed
  // once `populated 0` is read. Returns `terminated` or why not.
  private async terminate(l: SandboxLaunch, cgroup: string): Promise<string> {
    l.closed = true;
    const populated = () => {
      const p = readPopulated(cgroup);
      return p.state === 'absent' ? 'absent' : p.state === 'unreadable' ? 'unreadable' : p.value === 0 ? 'empty' : 'populated';
    };
    const graceMs = this.rt.setting('terminate_grace') * 1000;
    const killMs = this.rt.setting('kill_grace') * 1000;
    let state = populated();
    if (state === 'populated') {
      l.term();
      const until = performance.now() + graceMs;
      while (performance.now() < until && (state = populated()) === 'populated') await sleep(100);
    }
    for (let i = 0; i < 3 && state !== 'empty' && state !== 'absent'; i++) {
      writeKill(cgroup);
      const until = performance.now() + killMs;
      while (performance.now() < until && (state = populated()) !== 'empty' && state !== 'absent') await sleep(50);
    }
    if (l.alive && l.placedPid === null) await l.killUnplaced(killMs);
    if (state !== 'empty' && state !== 'absent') return `the box's cgroup is ${state}`;
    removeCgroup(cgroup);
    return 'terminated';
  }

  // Whatever path the box took, nothing of it stays: its launcher killed if
  // it is still this engine's unplaced child, its cgroup emptied through its
  // own `cgroup.kill` and removed. Idempotent after `terminate`.
  private async ensureGone(cgroup: string, launch: SandboxLaunch | null): Promise<void> {
    if (launch !== null && launch.alive && launch.placedPid === null) await launch.killUnplaced(this.rt.setting('kill_grace') * 1000);
    for (let i = 0; i < 100; i++) {
      const p = readPopulated(cgroup);
      if (p.state === 'absent') return;
      if (p.state === 'populated' && p.value === 0) {
        if (removeCgroup(cgroup)) return;
      } else writeKill(cgroup);
      await sleep(50);
    }
    log('runner self-test', new Error(`the box's cgroup could not be removed: ${cgroup}`));
  }

  // One case: its own run and its control's, judged as D3 §2.8 requires.
  private async judge(
    name: SelfTestCase,
    once: (spec: RunSpec) => Promise<Run>,
    ctx: Awaited<ReturnType<RunnerSelfTest['prepare']>> | null,
  ): Promise<{ result: 'passed' | 'failed' | 'not_exercised'; evidence: Record<string, unknown> }> {
    const exit0 = (): Promise<Run> => once({ key: 'exit0', args: ['exit', '0'], timeoutS: 30 });
    const exit1 = (): Promise<Run> => once({ key: 'exit1', args: ['exit', '1'], timeoutS: 30 });
    const pair = (c: Run, k: Run, ok: boolean, extra: Record<string, unknown> = {}) => ({
      result: ok ? ('passed' as const) : ('failed' as const),
      evidence: { case_run: summary(c), control_run: summary(k), ...extra },
    });
    switch (name) {
      case 'exit_zero': {
        const c = await exit0();
        const k = await exit1();
        return pair(c, k, c.state === 'passed' && c.fields?.exit_status === 0 && k.state === 'failed');
      }
      case 'exit_nonzero': {
        const c = await exit1();
        const k = await exit0();
        return pair(c, k, c.state === 'failed' && c.fields?.exit_status === 1 && k.state === 'passed');
      }
      case 'prints_passed_exits_nonzero': {
        const c = await once({ key: 'passed1', args: ['print', 'passed', '1'], timeoutS: 30 });
        const k = await once({ key: 'passed0', args: ['print', 'passed', '0'], timeoutS: 30 });
        return pair(c, k, c.state === 'failed' && c.output.includes('passed') && c.fields?.exit_status === 1 && k.state === 'passed' && k.output.includes('passed'));
      }
      case 'foreign_signal': {
        const c = await once({
          key: 'foreign',
          args: ['sleep', '60000', 'foreign-signal'],
          timeoutS: 60,
          whileRunning: async (b) => {
            const outcome = await this.killVerified(b.cgroup, ['sleep', 'foreign-signal']);
            b.notes.signal = outcome;
            if (!outcome.sent) b.cancel();
          },
        });
        const k = await once({ key: 'foreignCtl', args: ['sleep', '200', 'foreign-control'], timeoutS: 30 });
        const sent = (c.notes.signal as { sent?: boolean; reason?: string } | undefined) ?? {};
        if (sent.sent !== true) return { result: 'not_exercised', evidence: { reason: sent.reason ?? 'the program could not be verified, so no signal was sent', case_run: summary(c), control_run: summary(k) } };
        return pair(c, k, c.state === 'failed' && c.fields?.signaled === true && c.fields?.exit_status === null && c.fields?.deadline_hit === false && k.state === 'passed', { signal: c.notes.signal });
      }
      case 'deadline': {
        const c = await once({ key: 'deadline', args: ['sleep', '60000', 'deadline'], timeoutS: 2 });
        const k = await once({ key: 'deadlineCtl', args: ['sleep', '100', 'deadline-control'], timeoutS: 10 });
        return pair(c, k, c.state === 'failed' && c.fields?.deadline_hit === true && k.state === 'passed');
      }
      case 'term_handled_after_cancel': {
        const c = await once({ key: 'term', args: ['term-exit0', '60000'], timeoutS: 2 });
        const k = await once({ key: 'termCtl', args: ['term-exit0', '200'], timeoutS: 10 });
        // The init's report shows the program handled TERM and exited 0; the
        // result is still not passed, the engine having stopped it (T07).
        return pair(c, k, c.state !== 'passed' && c.fields?.deadline_hit === true && c.report?.code === 0 && c.report?.signal === null && k.state === 'passed');
      }
      case 'missing_program': {
        const c = await once({ key: 'missing', command: 'gone', args: ['exit', '0'], timeoutS: 30 });
        const k = await exit0();
        return pair(c, k, c.outcome === 'not_run' && c.reason === 'toolchain_missing' && k.state === 'passed');
      }
      case 'input_immutable': {
        if (ctx === null) return { result: 'not_exercised', evidence: { reason: 'the self-test was not prepared' } };
        let mountinfo: string[] | null = null;
        let report: Record<string, unknown> | null = null;
        const c = await once({
          key: 'b01',
          args: ['b01', DEEP_INPUT, SOURCE_WRITE, '5000'],
          timeoutS: 30,
          onLine: (line, b) => {
            if (!line.startsWith('SELFTEST-B01 ')) return;
            report = JSON.parse(line.slice('SELFTEST-B01 '.length)) as Record<string, unknown>;
            // The mount table of the case's own check process, read from the
            // host while it holds.
            const p = programIn(b.cgroup, ['b01']);
            if (p === null) {
              b.notes.mountinfo = 'the program could not be found in the box';
              return;
            }
            try {
              mountinfo = readFileSync(`/proc/${p.pid}/mountinfo`, 'utf8').split('\n').filter(Boolean);
            } catch (err) {
              b.notes.mountinfo = (err as Error).message;
            }
          },
        });
        const inputs = [PROGRAM_INPUT, BESIDE_INPUT, DEEP_INPUT];
        const problems = mountinfo === null ? ['no mount table was read'] : inputs.map((i) => immutableProblem(parseMountinfo(mountinfo!), i)).filter((p): p is string => p !== null);
        const r = (report ?? {}) as Record<string, unknown>;
        let persisted: string | null;
        try {
          persisted = readFileSync(join(ctx.src, SOURCE_WRITE), 'utf8') === SOURCE_BYTES ? null : 'the source file changed outside the domain';
        } catch (err) {
          persisted = (err as Error).message;
        }
        const ok =
          c.state === 'passed' &&
          problems.length === 0 &&
          r.input_sha256 === ctx.expected &&
          (r.input_write === 'EROFS' || r.input_write === 'EACCES') &&
          r.source_write === 'ok' &&
          persisted === null;
        return {
          result: ok ? 'passed' : 'failed',
          evidence: { inputs, mountinfo: mountinfo ?? [], program_report: report, problems, source_persisted: persisted, case_run: summary(c) },
        };
      }
      case 'orphan_stdout_closed': {
        const c = await once({ key: 'orphan', args: ['orphan', '3000'], timeoutS: 30 });
        const k = await exit0();
        return pair(c, k, c.state === 'failed' && c.fields?.orphans === true && c.fields?.exit_status === 0 && k.state === 'passed' && k.fields?.orphans === false);
      }
      case 'egress': {
        let entries: unknown = null;
        const c = await once({ key: 'egress', args: ['egress', ECHO_HOST, UNDECLARED_HOST], timeoutS: 30, egress: [ECHO_HOST] });
        const line = c.output.split('\n').find((l) => l.startsWith('SELFTEST-EGRESS '));
        let results: { host: string; status: string | null }[] = [];
        try {
          results = line ? ((JSON.parse(line.slice('SELFTEST-EGRESS '.length)) as { results: { host: string; status: string | null }[] }).results ?? []) : [];
        } catch {
          results = [];
        }
        entries = c.notes.egress_entries ?? null;
        const declared = results.find((r) => r.host === ECHO_HOST);
        const undeclared = results.find((r) => r.host === UNDECLARED_HOST);
        const ok = c.state === 'passed' && /^HTTP\/1\.[01] 200\b/.test(declared?.status ?? '') && /^HTTP\/1\.[01] 403\b/.test(undeclared?.status ?? '');
        return { result: ok ? 'passed' : 'failed', evidence: { results, proxy_entries: entries, case_run: summary(c) } };
      }
    }
  }

  // The `foreign_signal` case's one signal: SIGKILL to the self-test
  // program in this box, found in the box's own `cgroup.procs` by its
  // command line, in a nested pid namespace; verified again immediately
  // before the signal. Never a pid that fails a check.
  private async killVerified(cgroup: string, marker: string[]): Promise<{ sent: boolean; pid?: number; reason?: string }> {
    let found: { pid: number; startTime: string } | null = null;
    for (let i = 0; i < 50 && found === null; i++) {
      found = programIn(cgroup, marker);
      if (found === null) await sleep(100);
    }
    if (found === null) return { sent: false, reason: "the program was not found in the box's cgroup.procs with its command line" };
    await sleep(200);
    // Again, immediately before the signal.
    const again = programIn(cgroup, marker);
    if (again === null || again.pid !== found.pid || again.startTime !== found.startTime) return { sent: false, reason: 'the program could not be verified again before the signal' };
    if (!(readProcs(cgroup) ?? []).includes(found.pid) || found.pid <= 1 || found.pid === process.pid) return { sent: false, reason: 'the pid is not a member of the box' };
    try {
      process.kill(found.pid, 'SIGKILL');
    } catch (err) {
      return { sent: false, pid: found.pid, reason: `the signal was not delivered: ${(err as Error).message}` };
    }
    return { sent: true, pid: found.pid };
  }
}

// The control each case runs beside (SEAM.md §208: a non-empty name).
const CONTROLS: Record<SelfTestCase, string> = {
  exit_zero: 'exit 1 in the same profile: failed',
  exit_nonzero: 'exit 0 in the same profile: passed',
  prints_passed_exits_nonzero: 'output "passed" with exit 0: passed',
  foreign_signal: 'the same program not signalled, exiting 0 by itself: passed',
  deadline: 'the same program ending within its timeout: passed',
  term_handled_after_cancel: 'the same program exiting 0 by itself before its timeout: passed',
  missing_program: 'a program that exists, exit 0: passed',
  input_immutable: 'an ordinary source write in the same domain: succeeds and does not persist',
  orphan_stdout_closed: 'exit 0 with no descendant: passed, no orphans',
  egress: 'the declared host, through the same proxy: connects',
};

function notRun(reason: string, notes: Record<string, unknown> = {}): Run {
  return { outcome: 'not_run', fields: null, state: 'skipped', reason, report: null, output: '', notes };
}

function interrupted(why: string): Run {
  return { outcome: 'interrupted', fields: null, state: null, reason: why, report: null, output: '', notes: {} };
}

const summary = (r: Run) => ({
  outcome: r.outcome,
  state: r.state,
  reason: r.reason,
  fields: r.fields,
  exit_report: r.report,
  output: r.output.length > 512 ? `${r.output.slice(0, 512)}…` : r.output,
  ...(Object.keys(r.notes).length > 0 ? { notes: r.notes } : {}),
});

// ---- what a crash left ------------------------------------------------------------------------

// At start, before anything else of the self-test: what an earlier start of
// this home left by a crash during it. Only this home's own entries, by
// name: `<home>/selftest/selftest_<ULID>` (its trees) and
// `<home>/domains/selftest_<ULID>` (its boxes' areas). Nothing of another
// engine home is ever named.
export function sweepSelfTestLeftovers(home: string): { swept: string[]; skipped: { path: string; why: string }[] } {
  const swept: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const sub of ['selftest', 'domains'] as const) {
    const dir = join(home, sub);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!BOX_ID.test(n)) continue;
      const path = join(dir, n);
      // By real path, never through a link: a link is skipped and reported.
      const why = ownedHomeEntry(home, sub, path, BOX_ID);
      if (why !== null) {
        skipped.push({ path, why });
        log('runner self-test', new Error(`a leftover was not removed: ${why}`), { leftover: path });
        continue;
      }
      try {
        // A read-only tree is made writable before it is removed.
        chmodTree(path);
        rmSync(path, { recursive: true, force: true });
        swept.push(path);
      } catch (err) {
        log('runner self-test', err, { leftover: path });
      }
    }
  }
  return { swept, skipped };
}

// Every directory of a tree made writable by its owner, no link followed.
function chmodTree(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(path, 0o755);
    for (const n of readdirSync(path)) chmodTree(join(path, n));
  } catch {
    // left as it is
  }
}

// At start, after D2 recovery has killed every prior incarnation's
// supervisor leaf: a self-test box a prior incarnation of this home left in
// its scope (a crash during its self-test) is killed through its own cgroup
// and removed. Only children named `selftest_<ULID>` of a scope that
// `homeScopes` and `isHomeScope` verify as this home's, never this
// incarnation's own, never another home's.
export async function sweepPriorSelfTestBoxes(rt: Runtime): Promise<string[]> {
  const swept: string[] = [];
  if (rt.scope === null) return swept;
  const parent = dirname(rt.scope.path);
  for (const [inc, scope] of homeScopes(parent, rt.home) ?? new Map<string, string>()) {
    if (inc === rt.incarnation || !isHomeScope(scope, { parent, home: rt.home, incarnation: inc })) continue;
    let names: string[];
    try {
      names = readdirSync(scope);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!BOX_ID.test(n)) continue;
      const path = join(scope, n);
      const until = performance.now() + rt.setting('kill_grace') * 1000;
      let p = readPopulated(path);
      while (p.state === 'populated' && p.value === 1 && performance.now() < until) {
        writeKill(path);
        await sleep(50);
        p = readPopulated(path);
      }
      if ((p.state === 'populated' && p.value === 0) || p.state === 'absent') {
        if (removeCgroup(path)) swept.push(path);
      } else log('runner self-test', new Error(`a prior self-test box could not be emptied: ${path}`));
    }
  }
  return swept;
}

