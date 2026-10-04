// The model-invocation choke point (D1 §15.1). Every role process the engine
// starts is started here, and nowhere else (D1 §15.4).
//
// A dispatch, in order: the claim transaction (run, lease, grant, receipt,
// domain, ownership with pid null); the backend check, which refuses an
// unqualified backend before anything is spawned; the workspace, created
// through the git journal; `dispatch_started`; then, without the tick
// waiting: the spawn into a new process group with a constructed environment,
// the transaction that completes ownership and records `launched`, and the
// supervision of the role's callbacks until it exits. No transaction is held
// across the spawn, a git call or a read of the role's output.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { readRegular } from './sandbox/volatile.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { repoContext } from '../git/exec.js';
import { treeOf } from '../git/repo.js';
import { captureMetadata, indexHashOfTree } from '../git/snapshot.js';
import { ACCEPTED_KINDS } from '../runs/accept.js';
import { fieldAllowed, parseReport } from '../runs/report.js';
import type { RunResult } from '../store/transitions/accept.js';
import { isoAt, nowMs } from '../clock.js';
import { processStartTime } from '../lock.js';
import { type RunEnd, type RunHandle, type Runtime, earnedEnd, log, newHandle } from '../runtime.js';
import type { Claim, Outcome, ReasonClass } from '../store/transitions/runs.js';
import { RecordStream, writeWholeRecord } from '../records/files.js';
import { redactText, redactValue } from '../records/redact.js';
import { pausePoint, seamBackends, seamLauncherBarriers, seamLauncherReached, seamCollectBounds, seamCollectDelay, seamMainFault, seamRefuseBinary, seamStreamDelay, seamTemplateVersions } from '../testing/seam.js';
import { SandboxLaunch } from './sandboxed.js';
import { engineNode } from './sandbox/tools.js';
import { readPopulated, verifyLimits } from '../boundary/cgroup.js';
import { domainLimits, prepareSandbox } from './sandbox/prepare.js';
import { heldProviderCaps, heldSecret } from '../records/redact.js';
import { TEMPLATES, templateOf } from './adapters/templates.js';
import { helpHash } from './static.js';
import { type ResultCollection, collectResult, inventory, inventoryRecord } from './collect.js';
import { type BackendSpec, M1_BACKEND } from './backend.js';
import { type ForbiddenContext, type PlanReason, validateReadPaths } from './sandbox/plan.js';
import { GitViewRefused, repositoryCommonDir } from './sandbox/gitview.js';
import { GOVERNED_FILE } from '../protected/set.js';
import { materialize, screenWorkspace } from './sandbox/materialize.js';
import { canaryEdit } from '../trust/canaries.js';
import { DOMAIN_MARKER, INVOCATION_MARKER } from './processes.js';
import { type BackendSampling, type ClaudeStreamSummary, ClaudeStream } from './adapters/claude.js';
import { startBackendSampler } from './sampler.js';

// What a qualification canary's run showed the engine (D2 §7.2), kept for
// the attempt's judgement (trust/attempts.ts) once the run has ended.
export interface CanaryObservation {
  kind: string;
  exitClass: string;
  verdict: string;
  value: unknown;
  editContent: string | null;
  witnesses: { action: string; outcome: string; pid: number; detail: string }[];
  barrierSeen: boolean;
  termToExitMs: number | null;
  egress: { authority: string; decision: string; reason: string | null; opened_at: string }[];
  providerFilesRecord: string | null;
  // A real backend's: its stream as the adapter read it, and the host's
  // samples of its domain's processes; null for the scripted backend.
  stream: ClaudeStreamSummary | null;
  sampling: BackendSampling | null;
  exitStatus: number | null;
}
export const canaryObservations = new Map<string, CanaryObservation>();

function recordCanary(handle: RunHandle, exitClass: string, c: Collected, editContent: string | null): void {
  const launch = handle.sandbox;
  canaryObservations.set(handle.claim.run, {
    kind: handle.claim.attempt!.kind,
    exitClass,
    verdict: c.verdict.outcome,
    value: c.value,
    editContent,
    witnesses: launch ? [...launch.witnesses] : [],
    barrierSeen: launch?.barrierSeen ?? false,
    termToExitMs: launch?.termToExitMs() ?? null,
    egress: handle.egressEntries ?? [],
    providerFilesRecord: c.providerRecord,
    stream: handle.adapterStream?.summary() ?? null,
    sampling: stopSampler(handle),
    exitStatus: typeof handle.exit?.code === 'number' ? handle.exit.code : null,
  });
}

// The canary's host samples, ended once; null where none were taken.
export function stopSampler(handle: RunHandle): BackendSampling | null {
  const s = handle.sampler;
  if (s === null) return handle.samplingReport;
  s.sample();
  handle.sampler = null;
  const report = s.stop();
  handle.samplingReport = report;
  return report;
}

// The collector's reasons for a path that is not a result (SEAM.md §143).
const REFUSAL_REASON: Record<string, string> = { link: 'link', fifo: 'fifo', device: 'device', oversize: 'oversize', socket: 'not_regular', directory: 'not_regular', path: 'not_regular', unreadable: 'not_regular' };

// What collection found, once per run.
interface Collected {
  result: ResultCollection;
  verdict: { outcome: 'accepted' | 'invalid' | 'missing' | 'not_collected'; reason: string | null; bytes_read: number | null };
  value: RunResult | null;
  providerFiles: string;
  providerRecord: string | null;
  boundText: string | null;
  unacceptedDone: boolean;
}

export interface DispatchTarget {
  project: string;
  repo: string;
  branch: string;
}

// The slice-2 structured result (SEAM.md §13): an object whose `status` is
// "completed" and whose `summary` is a string.
//
// From slice 3 a result may carry `checkpoint` and `nominate`, each a JSON
// boolean (SEAM.md §26); anything else there makes the result invalid.
//
// From slice 5 it may also carry what a Verifier or a Reviewer reports
// (findings, sign-offs, ...; SEAM.md §68), each field in its form.
function parseResult(value: unknown, role: string): RunResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.status !== 'completed' || typeof r.summary !== 'string') return null;
  if (!fieldAllowed(r, role)) return null;
  if (r.checkpoint !== undefined && typeof r.checkpoint !== 'boolean') return null;
  if (r.nominate !== undefined && typeof r.nominate !== 'boolean') return null;
  const report = parseReport(r);
  if (report === null) return null;
  return { summary: r.summary, checkpoint: r.checkpoint === true, nominate: r.nominate === true, ...(Object.keys(report).length > 0 ? { report } : {}) };
}

// The role's environment is constructed, never inherited (D1 §17(4)): no
// engine home, no token, no git or editor variables.
// A real backend's environment adds exactly the variable its template names
// for the provider key, with the value resolved from the grant's reference
// (D2 §§1.2, 2.5).
function childEnv(claim: Claim, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    [DOMAIN_MARKER]: claim.domain,
    [INVOCATION_MARKER]: claim.invocation,
    ...extra,
  };
}

const refusalForm = (code: string, reason: string, whatToDo: string, subject: Record<string, unknown>) => ({ code, reason, what_to_do: whatToDo, subject });

const isUsageLine = (line: string): boolean => /"type"\s*:\s*"usage"/.test(line);

// The one line the backend reads on its standard input (SEAM.md §13).
function requestLine(handle: RunHandle, workspace: string): string {
  const { claim } = handle;
  return `${JSON.stringify({
    invocation: claim.invocation,
    domain: claim.domain,
    run: claim.run,
    project: claim.project,
    work_item: claim.work_item,
    work_kind: claim.work_kind,
    role: claim.role,
    workspace,
  })}\n`;
}

// What the choke point spawns for a backend a trust entry authorizes: its
// binary, its adapter's template arguments, and the provider key in the
// variable the template names (D2 §§1.2, 2.5, 4.5, 4.6). null when the
// engine has no adapter for the backend.
function realBackend(claim: Claim): BackendSpec | null {
  const e = claim.entry!;
  // A canary of a harness-mode attempt for `scripted` runs the attempt's
  // binary under the scripted protocol (SEAM.md §148).
  const template = templateOf(e.backend, { scripted: claim.attempt !== null, versions: seamTemplateVersions() });
  if (!template) return null;
  const key = template.keyVariable === '' ? null : heldSecret(e.key_ref);
  return {
    id: e.backend,
    version: template.version,
    command: e.binary_path,
    args: template.render({ model: e.model, invocation: claim.invocation }),
    env: key === null ? {} : { [template.keyVariable]: key },
    // The backend's installation, read-only at its pinned path (D2 §2.3).
    binds: [{ path: e.binary_path, writable: false }],
  };
}

export class Launcher {
  constructor(private readonly rt: Runtime) {}

  // One dispatch, as far as the tick waits for it: everything the run needs
  // before its spawn is durable when this returns true. The launch goes on
  // asynchronously (D1 §8.1 step 9).
  // `attempt`: a qualification attempt's own dispatch of one of its canaries
  // (D2 §7.2, K10; trust/attempts.ts), the only way such an item is run.
  async dispatch(target: DispatchTarget, item: { id: string }, attempt: string | null = null): Promise<boolean> {
    // The scripted backend, which only harness mode has. Every other backend
    // is chosen by the claim from the project's policy and the trust table
    // (D2 §4.1).
    const backend = seamBackends().find((b) => b.id === M1_BACKEND) ?? null;
    // The run's base is the commit the registry expects the integration
    // branch at, or the checkpoint the work continues from (D1 §7.4); the
    // claim reads it in its own transaction.
    const claim = await this.rt.engine<Claim | null>('dispatch.claim', {
      project: target.project,
      workItem: item.id,
      incarnation: this.rt.incarnation,
      scripted: backend?.version ?? null,
      maxConcurrentRuns: this.rt.setting('max_concurrent_runs'),
      providerCaps: heldProviderCaps(),
      // The domain is a cgroup of the incarnation's scope on the real
      // boundary (D2 §3.2); the kernel lane's scripted boundary has none.
      scope: this.rt.boundary() === 'real' ? (this.rt.scope?.path ?? null) : null,
      attempt,
    });
    if (!claim) return false;
    const handle = newHandle(claim);
    // The adapter that reads a real backend's stream (D2 §1.1): Claude
    // Code's for `claude`; the scripted protocol otherwise.
    if (claim.entry !== null && claim.entry.backend === 'claude') handle.adapterStream = new ClaudeStream();
    this.rt.handles.set(claim.run, handle);
    // The baseline of a fresh checkout of the base, read now: it is fixed
    // with the workspace's intent.
    const ctx = repoContext(target.repo);
    const tree = await treeOf(ctx, claim.base_revision).catch(() => null);
    const index = tree === null ? null : await indexHashOfTree(ctx, tree).catch(() => null);
    handle.baseline = tree === null || index === null ? null : { head: claim.base_revision, index_hash: index, tracked_tree_hash: tree };
    // The claim committed the run, its domain and its receipt together.
    await pausePoint('dispatch.run_created');
    await pausePoint('dispatch.domain_allocated');
    await pausePoint('dispatch.receipt_committed');

    // What runs: the scripted backend, or the binary a trust entry names with
    // its adapter's template arguments (D2 §§1.2, 4.5, 4.6).
    const runs = claim.entry === null ? backend : realBackend(claim);
    let ready = false;
    try {
      ready = await this.prepare(handle, runs, target.repo);
    } catch (err) {
      log('dispatch', err, { run: claim.run });
      this.never(handle, 'failed', 'infra_error');
      return true;
    }
    if (ready && runs) void this.launch(handle, runs, target.repo);
    return true;
  }

  // The run will never be spawned into by this incarnation.
  private never(handle: RunHandle, outcome: Outcome, reason: ReasonClass, phase: 'never' | 'aborted' = 'never', reasonText?: string, detail?: Record<string, unknown>): void {
    handle.phase = phase;
    handle.settle();
    this.rt.requestEnd(handle, { outcome, reason, ...(reasonText === undefined ? {} : { reasonText }), ...(detail === undefined ? {} : { detail }) });
  }

  // Backend check, workspace, dispatch_started. Returns false if the run is
  // not to be spawned.
  private async prepare(handle: RunHandle, backend: BackendSpec | null, repo: string): Promise<boolean> {
    const { claim } = handle;
    if (claim.refusal || !backend) {
      // D1 §15.1, D2 §4.1: an unqualified backend, mode or host is refused
      // before launch: before any domain is placed or any process started.
      // The refusal is the end the engine decided, and it is kept with the
      // handle: if recording it fails, the engine's retry records the same
      // refusal, never a failure (SEAM.md §24).
      const refusal =
        claim.refusal ??
        refusalForm(
          'backend_refused',
          claim.entry !== null ? `The adapter for ${claim.backend} is not part of this engine revision.` : 'No backend is qualified for this role.',
          'Name a backend this engine can run for the role.',
          { backend: claim.backend },
        );
      this.never(handle, 'refused', 'preflight_refused', 'never', refusal.code, refusal);
      return false;
    }
    // D2 §1.2: the binary is the one the entry names, by path and SHA-256;
    // a mismatch is refused before anything is launched.
    if (claim.entry !== null) {
      // The engine's test mode never launches a real backend's binary: only
      // the stand-in a test wrote (M2 plan §2.3).
      const real = seamRefuseBinary(claim.entry.binary_path, claim.entry.backend);
      if (real !== null) {
        const refusal = refusalForm('backend_refused', `This engine does not launch ${claim.entry.backend}'s own binary here: ${real}.`, 'Bind the backend to a stand-in.', { trust_entry: claim.trust_entry, binary_path: claim.entry.binary_path });
        this.never(handle, 'refused', 'preflight_refused', 'never', refusal.code, refusal);
        return false;
      }
      let found: string | null;
      try {
        found = createHash('sha256').update(await readFile(claim.entry.binary_path)).digest('hex');
      } catch {
        found = null;
      }
      if (found !== claim.entry.binary_sha256) {
        // The entry no longer holds (D2 §7.3): revoked, then refused.
        await this.rt.engine('trust.revoke_drifted', { entry: claim.trust_entry, binaries: { [claim.entry.binary_path]: found } }).catch((err) => log('trust revocation', err, { run: claim.run }));
        const refusal = refusalForm(
          'backend_refused',
          `The binary at ${claim.entry.binary_path} ${found === null ? 'cannot be read' : 'is not the one the trust entry names'}.`,
          'Qualify the binary that is installed, or restore the one the entry names.',
          { trust_entry: claim.trust_entry, binary_path: claim.entry.binary_path, expected_sha256: claim.entry.binary_sha256, found_sha256: found },
        );
        this.never(handle, 'refused', 'preflight_refused', 'never', refusal.code, refusal);
        return false;
      }
      // Its help, the static check of D2 §7.2, unchanged since it was
      // qualified (D2 §7.3; SEAM.md §150): a different help revokes an entry.
      let help: string | null = null;
      try {
        help = await helpHash(claim.entry.binary_path, claim.entry.backend);
      } catch {
        help = null;
      }
      if (help !== null && help !== claim.entry.help_sha256) {
        if (claim.trust_entry !== null) {
          await this.rt.engine('trust.revoke_drifted', { entry: claim.trust_entry, helps: { [claim.entry.binary_path]: help } }).catch((err) => log('trust revocation', err, { run: claim.run }));
        }
        const refusal = refusalForm('backend_refused', `The help of ${claim.entry.binary_path} is not the one the qualification recorded.`, 'Qualify the binary that is installed.', {
          trust_entry: claim.trust_entry,
          binary_path: claim.entry.binary_path,
          expected_help_sha256: claim.entry.help_sha256,
          found_help_sha256: help,
        });
        this.never(handle, 'refused', 'preflight_refused', 'never', refusal.code, refusal);
        return false;
      }
    }
    // D2 §§1.2, 2.5: a real backend runs only with the provider key its
    // grant names; a reference that cannot be resolved refuses the launch,
    // never a launch without the key (E62).
    const keyed = claim.entry !== null && (templateOf(claim.entry.backend, { scripted: claim.attempt !== null })?.keyVariable ?? '') !== '';
    if (claim.entry !== null && keyed && heldSecret(claim.entry.key_ref) === null) {
      const refusal = refusalForm(
        'backend_refused',
        `The provider key ${claim.entry.key_ref} that ${claim.entry.backend}'s grant names cannot be resolved, so the backend is not launched without it.`,
        'Make the key available to the engine under that reference.',
        { trust_entry: claim.trust_entry, reference: claim.entry.key_ref },
      );
      this.never(handle, 'refused', 'preflight_refused', 'never', refusal.code, refusal);
      return false;
    }
    // The widening a project's policy may make to the mount plan, validated
    // before every launch, approved or not (D2 §2.3): a refusal names the
    // path and why, and no launcher starts.
    const plan = await this.rt.read<{ paths: string[]; egress_allow_extra: string[]; protected: { roots: string[] }; context: Omit<ForbiddenContext, 'home'> }>('mount.context', { project: claim.project });
    handle.readPaths = plan.paths;
    handle.egressExtra = plan.egress_allow_extra;
    handle.protectedRoots = [...plan.protected.roots, GOVERNED_FILE];
    let refused = await validateReadPaths(plan.paths, { ...plan.context, home: this.rt.home });
    // The git view binds the repository's objects and refs; a repository
    // with alternates is refused (D2 §2.3; E58 item 3), on the real boundary
    // where the view is built.
    if (refused === null && this.rt.boundary() === 'real') {
      try {
        repositoryCommonDir(repo);
      } catch (err) {
        if (!(err instanceof GitViewRefused)) throw err;
        // The refusal names the repository as registered (SEAM.md §134).
        refused = { path: repo, resolved: err.path, reason: err.reason as PlanReason, detail: err.message };
      }
    }
    if (refused !== null) {
      this.never(
        handle,
        'refused',
        'preflight_refused',
        'never',
        'mount_plan_refused',
        refusalForm(
          'mount_plan_refused',
          refused.reason === 'alternates'
            ? `The repository ${refused.path} cannot be bound into the sandbox's git view: ${refused.detail}.`
            : `The project's sandbox_read_paths entry ${refused.path} cannot be bound: ${refused.detail}.`,
          refused.reason === 'alternates'
            ? 'Repack the repository so that it holds its own objects (git repack -a -d, then remove objects/info/alternates).'
            : 'Remove the path from sandbox_read_paths, or name a directory that reaches no forbidden authority.',
          { path: refused.path, reason: refused.reason },
        ),
      );
      return false;
    }
    // A widening is bound at what it resolves to, never at the link's own
    // path (D2 §2.3; SEAM.md §133).
    try {
      handle.readPaths = plan.paths.map((p) => realpathSync(p));
    } catch (err) {
      log('dispatch', err, { run: claim.run, what: 'sandbox_read_paths' });
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    if (handle.abort) {
      handle.phase = 'aborted';
      handle.settle();
      return false;
    }

    // D1 §7.3: `git worktree add --detach <ws> <base>`, journaled. The
    // workspace's baseline is that of a fresh checkout of the base, fixed
    // with the intent.
    const path = join(this.rt.home, 'workspaces', claim.run);
    mkdirSync(join(this.rt.home, 'workspaces'), { recursive: true, mode: 0o700 });
    const baseline = handle.baseline;
    if (baseline === null) {
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    const intent = await this.rt.journal.intend(
      'journal.intend',
      {
        project: claim.project,
        kind: 'worktree_add',
        payload: { repo, run: claim.run, path, base: claim.base_revision },
        target: { repo, path },
        subject: { run: claim.run, action: 'worktree_add' },
        finalizer: { purpose: 'workspace', run: claim.run, path, base: claim.base_revision, baseline },
        deadlineSeconds: this.rt.setting('git_deadline'),
      },
      'worktree_add',
    );
    if (!('operation' in intent)) {
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    const settled = await this.rt.journal.drive(intent.operation);
    const workspace = settled.receipts.workspace as string | undefined;
    if (settled.end !== 'finalized' || workspace === undefined) {
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    handle.workspacePath = path;
    // What lies outside the workspace's diff, as the engine leaves it before
    // the role is launched (correction 15).
    const metadata = await captureMetadata(repo, path);
    if (metadata === null) {
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    await this.rt.engine('workspace.metadata', { workspace, metadata });

    const started = await this.rt.engine<boolean>('invoke.dispatch_started', { run: claim.run, invocation: claim.invocation });
    if (!started || handle.abort) {
      handle.phase = 'aborted';
      handle.settle();
      return false;
    }
    return true;
  }

  // The launch, from the barrier before the spawn to the role's exit. Every
  // way out of it settles the handle, so a run-end protocol waiting on the
  // launch is never left waiting; a failure ends the run (failed /
  // infra_error) rather than leaving it to a lease nobody will renew.
  private async launch(handle: RunHandle, backend: BackendSpec, repo: string): Promise<void> {
    try {
      // The real boundary: the launcher, the sandbox, the domain's cgroup
      // (D2 §§1.1, 2, 3). The kernel lane's scripted boundary keeps the
      // direct spawn of SEAM.md §13.
      if (handle.claim.cgroup_path !== null) await this.superviseSandboxed(handle, backend, repo);
      else if (this.rt.boundary() === 'scripted') await this.supervise(handle, backend);
      else {
        // No production path runs a backend outside the sandbox (D2 §5 C3):
        // a domain without a cgroup on the real boundary is not launched.
        this.never(handle, 'refused', 'preflight_refused', 'never', 'isolation_unqualified', refusalForm(
          'isolation_unqualified',
          'The engine has no incarnation scope, so no domain can be placed in the execution boundary.',
          'Start surety from a login session of uid 1000 with a running user manager; real backends are refused until then.',
          { domain: handle.claim.domain },
        ));
      }
    } catch (err) {
      log('launch', err, { run: handle.claim.run, phase: handle.phase });
      if (handle.phase === 'spawned') this.rt.requestEnd(handle, earnedEnd(handle));
      else this.never(handle, 'failed', 'infra_error');
    } finally {
      handle.settle();
    }
  }

  private async supervise(handle: RunHandle, backend: BackendSpec): Promise<void> {
    const { claim } = handle;
    await pausePoint('launch.before_spawn');
    // The lease is checked again after the barrier: a run stopped, abandoned
    // or whose lease expired meanwhile is not left with a live child (SEAM.md
    // §§16, 18).
    const active = await this.rt.engine<boolean>('run.lease_active', { run: claim.run, generation: claim.generation });
    if (handle.abort || !active) {
      handle.phase = 'aborted';
      handle.settle();
      return;
    }

    // The transcript's stream has its identity before the role writes
    // anything (correction 21; SEAM.md §56).
    let transcript: RecordStream;
    try {
      transcript = await RecordStream.open(this.rt, { project: claim.project, run: claim.run, kind: 'transcript' });
    } catch (err) {
      log('transcript', err, { run: claim.run });
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    if (handle.abort) {
      await transcript.abandon();
      handle.phase = 'aborted';
      handle.settle();
      return;
    }

    handle.phase = 'spawned';
    let child;
    try {
      child = spawn(backend.command, backend.args, {
        cwd: handle.workspacePath!,
        env: childEnv(claim, backend.env),
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (err) {
      log('spawn', err, { run: claim.run });
      await transcript.abandon();
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    if (child.pid === undefined) {
      child.once('error', (err) => log('spawn', err, { run: claim.run }));
      await transcript.abandon();
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    child.on('error', (err) => log('role process', err, { run: claim.run }));
    handle.child = child;
    handle.pid = child.pid;
    // Read before the event loop can reap the child, so it is there to read;
    // if it cannot be read it is recorded as unknown, and the process is then
    // reached only by its marker, never by a pid whose identity is unproven.
    try {
      handle.startTime = processStartTime(child.pid);
    } catch (err) {
      log('process start time', err, { run: claim.run, pid: child.pid });
      handle.startTime = null;
    }

    const output = new RoleOutput(child.stdout!, (bytes) => transcript.write(bytes));
    let outputDone: () => void = () => {};
    handle.output = { done: new Promise<void>((resolve) => (outputDone = resolve)), stop: () => output.close() };
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        handle.exit = { code, signal };
        handle.exitAt = isoAt(nowMs());
        output.exited();
        resolve();
      });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(requestLine(handle, handle.workspacePath!));

    try {
      await pausePoint('launch.before_ownership');
      await this.rt.engine('invoke.launched', {
        run: claim.run,
        invocation: claim.invocation,
        domain: claim.domain,
        pid: child.pid,
        pgid: child.pid,
        startTime: handle.startTime,
      });
    } finally {
      handle.settle();
    }

    // The role's callbacks, one at a time, in the order sent, until the role
    // has exited and what it wrote before its exit has been read, or its
    // output has ended (SEAM.md §13).
    try {
      for (let line = await output.next(); line !== null; line = await output.next()) {
        await this.callback(handle, line).catch((err) => log('callback', err, { run: claim.run }));
      }
    } finally {
      // A descendant may still hold the role's output open; the engine stops
      // reading it. The descendant is a member of the domain and is
      // terminated by the run-end protocol.
      output.close();
      // The transcript ends where the engine stopped reading (SEAM.md §56).
      await transcript.end().catch((err) => log('transcript', err, { run: claim.run }));
      outputDone();
    }
    // The end of the output is not the role's exit: a role may close its
    // standard output and go on working, and nothing begins until it exits
    // (SEAM.md §13). Meanwhile the engine holds the run as before: it renews
    // the lease while the process lives, and a deadline, Stop or Abandon ends
    // the run as for any role. Should the exit never be delivered, the
    // process is no longer held once /proc shows it gone, its lease expires,
    // and the tick reconciles the run.
    await exited;
    this.childDone(handle);
  }

  // The launch into the real sandbox (D2 §§1.1, 3.2): the domain's cgroup,
  // created by the engine while its launch is not closed; the launcher,
  // spawned in the supervisor leaf, placed by itself, authorized in one
  // transaction bound to this invocation, incarnation and lease generation;
  // the domain init, which starts the backend on the engine's word and
  // relays its output. Every way out of it leaves the domain to the run-end
  // protocol, which closes the launch and establishes termination.
  private async superviseSandboxed(handle: RunHandle, backend: BackendSpec, repo: string): Promise<void> {
    const { claim } = handle;
    await pausePoint('launch.before_spawn');
    const active = await this.rt.engine<boolean>('run.lease_active', { run: claim.run, generation: claim.generation });
    if (handle.abort || !active) {
      handle.phase = 'aborted';
      handle.settle();
      return;
    }
    let transcript: RecordStream;
    try {
      transcript = await RecordStream.open(this.rt, { project: claim.project, run: claim.run, kind: 'transcript' });
    } catch (err) {
      log('transcript', err, { run: claim.run });
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    let prepared: Awaited<ReturnType<typeof prepareSandbox>>;
    try {
      prepared = await prepareSandbox(this.rt, handle, backend, requestLine(handle, '/surety/workspace'), repo);
    } catch (err) {
      log('sandbox', err, { run: claim.run });
      await transcript.abandon();
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    if (prepared === null || handle.abort) {
      // The launch was closed before its cgroup could be made.
      await transcript.abandon();
      handle.phase = 'aborted';
      handle.settle();
      return;
    }

    handle.phase = 'spawned';
    let started: () => void = () => {};
    const backendStarted = new Promise<void>((resolve) => (started = resolve));
    const launch = new SandboxLaunch(
      {
        domain: claim.domain,
        invocation: claim.invocation,
        incarnation: this.rt.incarnation,
        generation: claim.generation,
        cgroup: claim.cgroup_path,
        unshare: prepared.unshare,
        node: engineNode(),
        ...(() => {
          const w = seamLauncherBarriers(this.rt.home);
          return w ? { waits: w.barriers, releaseDir: w.releaseDir } : {};
        })(),
      },
      {
        barrier: (name) => pausePoint(name),
        reached: (name, action) => seamLauncherReached(name, action),
        placed: async (pid) => {
          await this.rt.engine('domain.placed', { domain: claim.domain, pid });
        },
        // Refused at once if the engine has decided to end the run, before
        // the store says so; the store's transaction checks the rest.
        authorize: async () => {
          if (handle.ending || handle.abort) return false;
          // The domain's limits, read back again at the grant (D2 §3.7): no
          // role code is authorized into a domain without them.
          const wrong = verifyLimits(claim.cgroup_path!, domainLimits(this.rt, claim.work_item));
          if (wrong !== null) {
            log('launch', new Error(`the domain's limits do not read as written: ${wrong}`), { run: claim.run, domain: claim.domain });
            this.rt.requestEnd(handle, {
              outcome: 'failed',
              reason: 'infra_error',
              reasonText: `the domain's cgroup limits do not read as the engine wrote them (${wrong}); its launch was refused`,
            });
            return false;
          }
          const r = await this.rt.engine<{ granted: boolean }>('domain.authorize', {
            domain: claim.domain,
            invocation: claim.invocation,
            incarnation: this.rt.incarnation,
            generation: claim.generation,
            pid: launch.pid,
            startTime: launch.startTime,
          });
          return r.granted && !handle.ending;
        },
        plan: () => prepared!.plan,
        backend: () => prepared!.backend,
        // The launch was recorded with the grant (SEAM.md §125).
        started: async () => {
          handle.backendStarted = true;
          // A real backend's canary: the host samples the domain's members
          // from the backend's start (D2 §7.2; M136 (c)).
          if (claim.attempt !== null && handle.adapterStream !== null && claim.entry !== null && claim.cgroup_path !== null) {
            handle.sampler = startBackendSampler(claim.cgroup_path, claim.entry.binary_path);
            handle.sampler.sample();
          }
          started();
        },
        // D2 §7.1: a sandbox the launcher fails to build refuses the run
        // with `isolation_unqualified` and runs the host checks again.
        setupFailed: (detail) => {
          this.rt.requestEnd(handle, {
            outcome: 'refused',
            reason: 'preflight_refused',
            reasonText: 'isolation_unqualified',
            detail: refusalForm('isolation_unqualified', `The sandbox could not be built: ${detail}.`, 'Read the host checks on GET /v1/engine; real backends are refused until the host qualifies.', {
              domain: claim.domain,
              detail,
            }),
          });
          this.rt.rerunHostChecks();
        },
      },
    );
    launch.dropExitReport = seamMainFault('init_report_lost');
    // The cancellation canary (D2 §7.2): the init observed the barrier while
    // the backend ran; the engine cancels through the boundary.
    if (claim.attempt?.kind === 'cancellation') {
      launch.onBarrier = () => {
        if (handle.backendStarted && launch.exitReport === null) {
          this.rt.requestEnd(handle, { outcome: 'stopped', reason: 'human_stop', reasonText: 'canary_barrier: the cancellation canary reached its barrier and the engine cancelled it' });
        }
      };
    }
    handle.sandbox = launch;
    handle.child = launch.child;
    handle.pid = launch.pid;
    handle.startTime = launch.startTime;
    handle.settle();

    const output = new RoleOutput(launch.output, (bytes) => transcript.write(bytes), {
      lineMax: this.rt.setting('stream_line_max_bytes'),
      queueMax: this.rt.setting('stream_queue_max_bytes'),
      onBound: (why) => {
        // A supervisor bound reached cancels the run through the boundary
        // and records the evidence incomplete, never complete (D2 §3.7).
        transcript.truncate();
        handle.streamBound = why;
        this.rt.requestEnd(handle, { outcome: 'failed', reason: 'infra_error', reasonText: why });
      },
    });
    let outputDone: () => void = () => {};
    handle.output = { done: new Promise<void>((resolve) => (outputDone = resolve)), stop: () => output.close() };
    // The backend's exit, as the init reports it. Taken now, unless the
    // engine has just resumed from a pause that outlived the run lease: then
    // it waits, with the role's lines, for the tick's fresh challenge (D2
    // §3.5; `regrant`).
    const takeExit = () => {
      launch.ackExit();
      const report = launch.exitReport;
      handle.exit = report === null ? { code: null, signal: null } : { code: report.code, signal: report.signal === null ? null : String(report.signal) };
      handle.exitAt = isoAt(nowMs());
      output.exited();
    };
    // The role's lines are acted on once its launch is recorded (as
    // `launch.before_ownership` and `launched` precede them on the scripted
    // boundary), or not at all if it never starts.
    await Promise.race([backendStarted, launch.launcherExited]);
    void launch.backendDone.then(() => {
      if (!handle.backendStarted) return;
      if (handle.gate || this.pausedPastLease(handle)) {
        this.gate(handle).exit = takeExit;
        return;
      }
      takeExit();
    });
    try {
      for (let line = await output.next(); line !== null; line = await output.next()) {
        // While an expired lease is pending its challenge (SEAM.md §130), a
        // usage line is recorded and checked against the budget at once; a
        // result and a heartbeat wait for the challenge's outcome.
        const usageOnly = handle.adapterStream !== null ? ClaudeStream.usageOnly(line) : isUsageLine(line);
        if ((handle.gate || this.pausedPastLease(handle)) && !usageOnly) {
          this.gate(handle).lines.push(line);
          continue;
        }
        // The harness's slow consumer (SEAM.md §157); 0 outside it.
        const slow = seamStreamDelay();
        if (slow > 0) await new Promise((r) => setTimeout(r, slow));
        await this.callback(handle, line).catch((err) => log('callback', err, { run: claim.run }));
      }
    } finally {
      output.close();
      await transcript.end().catch((err) => log('transcript', err, { run: claim.run }));
      outputDone();
    }
    await launch.backendDone;
    if (!handle.backendStarted) {
      // Nothing of the role ran: the launch was refused, the sandbox could not
      // be built, or the launcher ended before it. The run's end is decided
      // elsewhere (a Stop, a deadline, the lease's expiry, the refusal).
      // A refused grant decides nothing: its cause (an expired lease, a Stop,
      // a deadline) ends the run. A launcher that ended by itself, or was
      // killed, before the backend started is a failed launch (SEAM.md §125).
      await launch.launcherExited;
      if (!handle.ending && launch.setupFailure === null && launch.stage !== 'refused') {
        this.rt.requestEnd(handle, { outcome: 'failed', reason: 'infra_error', reasonText: 'the launcher ended before the backend started' });
      }
      return;
    }
    await backendStarted;
    if (handle.gate) await handle.gate.released;
    await this.collectAfterExit(handle);
  }

  // ---- after the backend's exit, on the real boundary (D2 §§1.4, 1.6, 2.5, 4.3) ----

  // The backend has exited and its output is read. Nothing it left is read
  // before the domain's termination is established, with closure (K4): the
  // engine terminates the domain first (a descendant still writing is ended
  // by the boundary), then reads the exit class the boundary recorded and
  // collects. Only then is the run's end decided: only `clean` with a
  // well-formed result completes; every other class gives its outcome, and
  // a result present for one of them is published as an unaccepted_result.
  private async collectAfterExit(handle: RunHandle): Promise<void> {
    const { claim } = handle;
    // An end already decided (a Stop, a deadline, a stream bound) is the
    // run-end protocol's, which collects what is unaccepted.
    if (handle.ending || !this.rt.services) return;
    handle.collecting = true;
    let terminated = false;
    try {
      terminated = await this.rt.services.terminateDomains(claim.run);
    } catch (err) {
      log('termination after exit', err, { run: claim.run });
      terminated = false;
    }
    if (handle.ending) return;
    if (!terminated) {
      // Unknown termination: nothing is collected at all (D2 §3.4); the
      // run-end protocol quarantines it.
      handle.collecting = false;
      this.rt.requestEnd(handle, {
        outcome: 'failed',
        reason: 'infra_error',
        reasonText: "the termination of the run's domain could not be established after the backend's exit; nothing it left was collected",
        ...(handle.exitAt ? { decidedAt: handle.exitAt } : {}),
      });
      return;
    }
    const exit = await this.rt.read<{ exit_class: string | null; exit_evidence: string | null } | null>('domain.exit_of', { domain: claim.domain }).catch(() => null);
    const cls = exit?.exit_class ?? 'unknown';
    const collected = await this.collectOnce(handle);
    handle.collecting = false;
    if (handle.ending) return;
    const end = await this.decideAfterExit(handle, cls, collected);
    if (end === 'accept') {
      this.childDone(handle);
      return;
    }
    this.rt.requestEnd(handle, handle.exitAt === null ? end : { ...end, decidedAt: end.decidedAt ?? handle.exitAt });
  }

  // What the result and the exit class give (D2 §1.6; SEAM.md §143's
  // table), the result recorded first where it is the run's.
  private async decideAfterExit(handle: RunHandle, cls: string, c: Collected): Promise<RunEnd | 'accept'> {
    const { claim } = handle;
    if (handle.streamBound !== null) {
      await this.publishUnaccepted(handle, c);
      return { outcome: 'failed', reason: 'infra_error', reasonText: handle.streamBound };
    }
    if (c.boundText !== null) {
      await this.publishUnaccepted(handle, c);
      return { outcome: 'failed', reason: 'infra_error', reasonText: c.boundText };
    }
    const r = c.result;
    const accepted = c.verdict.outcome === 'accepted' && r.state === 'read';
    // A screen hit (D2 §2.5; SEAM.md §152): what holds the secret is refused
    // and the run cannot complete. What does not hold it is still kept: an
    // accepted result is published as the run's record; and the workspace's
    // changes are screened too, so a refusal there is reported as well.
    const hits = [...(r.state === 'secret' ? ['the result'] : []), ...(c.providerFiles === 'refused_secret' ? ['the provider files'] : [])];
    if (hits.length > 0) {
      c.unacceptedDone = true;
      // Only a clean exit's accepted file is the run's `result`; any other
      // class's is `unaccepted_result` (D2 §1.4; the review's S5).
      if (accepted && r.state === 'read') {
        const kind = cls === 'clean' ? 'result' : 'unaccepted_result';
        await writeWholeRecord(this.rt, { project: claim.project, run: claim.run, kind, content: r.bytes }).catch((err) => log('result record', err, { run: claim.run }));
      }
      const hold = handle.sandbox?.volatile ?? null;
      if (hold !== null && hold.held && hold.merged !== null && handle.workspacePath) {
        // Under the snapshot's caps, as materialization is (E67 item 4): a
        // workspace past them is refused before it is read.
        const caps = await this.snapshotCaps(claim.project);
        const m = screenWorkspace({ hold, home: this.rt.home, workspace: handle.workspacePath, caps });
        if (m.state === 'refused' && m.reason === 'secret') {
          hits.push("the workspace's changes");
          await this.rt.engine('evidence.secret_refused', { run: claim.run, domain: claim.domain, what: 'materialization', path: m.path === null ? null : redactText(m.path), by: null }).catch(() => {});
        }
      }
      if (claim.attempt !== null) recordCanary(handle, cls, c, null);
      return { outcome: 'failed', reason: 'infra_error', reasonText: `secret_refused: the secret screen refused ${hits.join(', ')}; nothing of it was published` };
    }
    if (claim.attempt !== null) return this.decideCanary(handle, cls, c, accepted);
    if (cls === 'clean') {
      // The result is the run's to take or refuse: never also unaccepted.
      c.unacceptedDone = true;
      if (!accepted) {
        if (c.verdict.outcome === 'invalid') {
          await this.recordResult(handle, false, null, null).catch((err) => log('result', err, { run: claim.run }));
          handle.result = { valid: false };
          return { outcome: 'failed', reason: 'invalid_result', reasonText: `the result file is not a result the engine may take (${c.verdict.reason})` };
        }
        return { outcome: 'failed', reason: 'infra_error', reasonText: 'the backend exited 0 with its terminal success event and left no result file' };
      }
      await pausePoint('run.result_received');
      let record: string | null = null;
      try {
        record = await writeWholeRecord(this.rt, { project: claim.project, run: claim.run, kind: 'result', content: r.bytes });
      } catch (err) {
        log('result record', err, { run: claim.run });
      }
      const recorded = await this.recordResult(handle, true, c.value, record).catch((err) => {
        log('result', err, { run: claim.run });
        return false;
      });
      if (!recorded) return earnedEnd(handle);
      handle.result = { valid: true };
      if (handle.exit?.code !== 0) return earnedEnd(handle);
      return 'accept';
    }
    // Any other class: the file, if accepted by the collector, is never the
    // run's result (D2 §1.4).
    if (cls === 'error_exit') {
      if (accepted) return { outcome: 'failed', reason: 'invalid_result', reasonText: 'exit class error_exit: a well-formed result contradicts the failed exit' };
      return { outcome: 'failed', reason: 'infra_error', reasonText: 'exit class error_exit: the backend failed without a result' };
    }
    await this.publishUnaccepted(handle, c);
    if (cls === 'resource_limit') return { outcome: 'failed', reason: 'infra_error', reasonText: 'exit class resource_limit: the backend was ended by a resource limit of its domain (memory.events oom_kill rose)' };
    if (cls === 'foreign_signal') return { outcome: 'failed', reason: 'infra_error', reasonText: 'exit class foreign_signal: the backend was ended by a signal the engine did not send' };
    return { outcome: 'failed', reason: 'infra_error', reasonText: `exit class ${cls}: no exit report of the backend reached the engine` };
  }

  // The snapshot's caps of a project's policy (D1 §7.3; M19).
  private async snapshotCaps(project: string): Promise<{ files: number; bytes: number; fileBytes: number }> {
    const p = await this.rt.read<Record<string, number>>('project.policy', { project }).catch(() => ({}) as Record<string, number>);
    return { files: p.snapshot_max_files ?? 10_000, bytes: p.snapshot_max_bytes ?? 64 * 1024 * 1024, fileBytes: p.snapshot_max_file_bytes ?? 16 * 1024 * 1024 };
  }

  // A qualification canary's run (D2 §7.2): never the acceptance pipeline,
  // never a commit. The positive canary's edit is materialized into the
  // run's own workspace behind the screen, so its content can be judged.
  private async decideCanary(handle: RunHandle, cls: string, c: Collected, accepted: boolean): Promise<RunEnd> {
    const { claim } = handle;
    const kind = claim.attempt!.kind;
    c.unacceptedDone = true;
    let editContent: string | null = null;
    if (kind === 'positive' && cls === 'clean' && accepted && handle.sandbox?.volatile && handle.workspacePath) {
      const m = materialize({ hold: handle.sandbox.volatile, home: this.rt.home, workspace: handle.workspacePath, caps: await this.snapshotCaps(claim.project) });
      if (m.state === 'refused' && m.reason === 'secret') {
        await this.rt.engine('evidence.secret_refused', { run: claim.run, domain: claim.domain, what: 'materialization', path: m.path === null ? null : redactText(m.path), by: null }).catch(() => {});
        recordCanary(handle, cls, c, null);
        return { outcome: 'failed', reason: 'infra_error', reasonText: 'secret_refused: the secret screen refused the canary\'s materialization' };
      }
      handle.materialized = m.state === 'materialized';
      // Read as the engine reads what a role left (the review's S3): never
      // through a link, only a regular file, at most 64 KiB.
      const r = readRegular(handle.workspacePath, canaryEdit(claim.attempt!.id).path, 64 * 1024);
      editContent = r.state === 'read' ? r.bytes.toString('utf8') : null;
    }
    recordCanary(handle, cls, c, editContent);
    if (kind === 'cancellation') return { outcome: 'failed', reason: 'infra_error', reasonText: 'barrier_not_reached: the cancellation canary ended without the engine observing its barrier' };
    if (cls === 'clean' && accepted) return { outcome: 'completed', reason: 'none' };
    if (cls === 'clean' || (cls === 'error_exit' && accepted)) return { outcome: 'failed', reason: 'invalid_result', reasonText: `exit class ${cls}: the canary's result is not one the engine may take` };
    return { outcome: 'failed', reason: 'infra_error', reasonText: `exit class ${cls}` };
  }

  // A result the run does not accept, published after the screen as an
  // unaccepted_result record (D2 §1.4), once.
  private async publishUnaccepted(handle: RunHandle, c: Collected): Promise<void> {
    const r = c.result;
    if (r.state !== 'read' || c.verdict.outcome !== 'accepted' || c.unacceptedDone) return;
    c.unacceptedDone = true;
    try {
      const record = await writeWholeRecord(this.rt, { project: handle.claim.project, run: handle.claim.run, kind: 'unaccepted_result', content: r.bytes });
      await this.recordCollection(handle, { unaccepted_result: record });
    } catch (err) {
      log('unaccepted result', err, { run: handle.claim.run });
    }
  }

  private recordCollection(handle: RunHandle, collection: Record<string, unknown>): Promise<unknown> {
    return this.rt.engine('run.collection', { run: handle.claim.run, collection }).catch((err) => log('collection', err, { run: handle.claim.run }));
  }

  // Collection from the volatile filesystem (invoke/collect.ts), once per
  // run, after termination is established: the result read, the provider
  // files inventoried, screened and published. A screen hit refuses the
  // publication, raises the Critical security finding and
  // evidence.secret_refused (D2 §2.5). A bound reached marks the evidence
  // incomplete and the run cannot complete (§3.7).
  collectOnce(handle: RunHandle): Promise<Collected> {
    handle.collection ??= this.collect(handle);
    return handle.collection as Promise<Collected>;
  }

  private async collect(handle: RunHandle): Promise<Collected> {
    const { claim } = handle;
    const hold = handle.sandbox?.volatile ?? null;
    await pausePoint('collect.before_read');
    // The engine's test mode may set the inventory's bounds below their
    // ranges (SEAM.md §152); the configuration keeps its ranges.
    const below = seamCollectBounds();
    const bounds = {
      resultMaxBytes: this.rt.setting('result_max_bytes'),
      entriesMax: below?.entries ?? this.rt.setting('collect_entries_max'),
      filesMaxBytes: below?.bytes ?? this.rt.setting('provider_files_max_bytes'),
      deadlineMs: this.rt.setting('collect_deadline') * 1000,
    };
    const began = performance.now();
    const result = collectResult(hold, bounds);
    // The collector's verdict on the file (SEAM.md §143), apart from what the
    // exit class makes of it.
    let verdict: Collected['verdict'];
    let value: RunResult | null = null;
    if (result.state === 'not_held') verdict = { outcome: 'not_collected', reason: null, bytes_read: null };
    else if (result.state === 'absent') verdict = { outcome: 'missing', reason: null, bytes_read: 0 };
    else if (result.state === 'refused') verdict = { outcome: 'invalid', reason: REFUSAL_REASON[result.reason] ?? 'not_regular', bytes_read: 0 };
    else if (result.state === 'secret') verdict = { outcome: 'invalid', reason: 'secret_refused', bytes_read: null };
    else {
      try {
        value = parseResult(redactValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes))), claim.role);
      } catch {
        value = null;
      }
      verdict = value === null ? { outcome: 'invalid', reason: 'malformed', bytes_read: result.bytes.length } : { outcome: 'accepted', reason: null, bytes_read: result.bytes.length };
    }
    if (performance.now() - began > bounds.deadlineMs) verdict = { outcome: 'invalid', reason: 'deadline', bytes_read: verdict.bytes_read };
    await this.recordCollection(handle, { result_collection: verdict });
    if (result.state === 'secret') {
      await this.rt.engine('evidence.secret_refused', { run: claim.run, domain: claim.domain, what: 'result', path: '/surety/out/result.json', by: result.by }).catch((err) => log('secret screen', err, { run: claim.run }));
    }
    // The provider files (D2 §4.3; SEAM.md §152), after the result.
    const template = claim.entry ? templateOf(claim.entry.backend, { scripted: claim.attempt !== null }) : undefined;
    const inv = await inventory(hold, bounds, template?.persistenceFlags ?? [], seamCollectDelay());
    let providerFiles: string = hold === null || !hold.held ? 'not_collected' : 'published';
    let providerRecord: string | null = null;
    if (hold !== null && hold.held) {
      if (inv.secret !== null) {
        providerFiles = 'refused_secret';
        await this.rt
          .engine('evidence.secret_refused', { run: claim.run, domain: claim.domain, what: 'provider_files', path: redactText(inv.secret.path), by: inv.secret.by })
          .catch((err) => log('secret screen', err, { run: claim.run }));
      } else {
        try {
          providerRecord = await writeWholeRecord(this.rt, { project: claim.project, run: claim.run, kind: 'provider_files', content: inventoryRecord(inv) });
          if (inv.truncated) providerFiles = 'truncated';
        } catch (err) {
          log('provider files', err, { run: claim.run });
          providerFiles = 'unwritten';
        }
      }
    }
    await this.recordCollection(handle, {
      provider_files_collection: { outcome: providerFiles === 'refused_secret' ? 'refused' : providerFiles === 'unwritten' ? 'missing' : providerFiles, record: providerRecord },
      excluded: inv.excluded.map((e) => redactText(e.path)),
    });
    const boundText = inv.truncated ? `collection reached ${inv.truncated.key} (${inv.truncated.value}): the provider_files record is truncated and the run's evidence incomplete` : null;
    return { result, verdict, value, providerFiles, providerRecord, boundText, unacceptedDone: false };
  }

  // On a run's end decided by the engine (a Stop, a deadline, a bound) or by
  // its exit: once its domains are terminated, what the volatile filesystem
  // held is collected, and a result is published only as unaccepted (D2
  // §1.4). A run whose termination was not established when it ended (it was
  // quarantined) is not collected: what it left is recorded missing.
  async collectAtEnd(handle: RunHandle, quarantined: boolean): Promise<void> {
    if (handle.sandbox === null || !handle.backendStarted) return;
    if (quarantined && handle.collection === null) {
      stopSampler(handle);
      // A domain whose termination was unknown is not collected (D2 §3.4).
      await this.recordCollection(handle, { result_collection: { outcome: 'not_collected', reason: null, bytes_read: null }, provider_files_collection: { outcome: 'not_collected', record: null } });
      return;
    }
    const c = await this.collectOnce(handle);
    await this.publishUnaccepted(handle, c);
    if (handle.claim.attempt !== null && !canaryObservations.has(handle.claim.run)) {
      const exit = await this.rt.read<{ exit_class: string | null } | null>('domain.exit_of', { domain: handle.claim.domain }).catch(() => null);
      recordCanary(handle, exit?.exit_class ?? 'unknown', c, null);
    }
  }

  // Has the engine just resumed from a pause that outlived the run lease?
  // Its last renewal is a whole lease_ttl ago: nothing the role sent meanwhile
  // is acted on until the tick has made a fresh challenge (D2 §3.5).
  private pausedPastLease(handle: RunHandle): boolean {
    if (handle.ending || handle.sandbox === null) return false;
    return nowMs() - handle.renewedAtMs >= this.rt.setting('lease_ttl') * 1000;
  }

  private gate(handle: RunHandle): NonNullable<RunHandle['gate']> {
    if (!handle.gate) {
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      handle.gate = { lines: [], exit: null, released, release };
      this.rt.services?.requestTick();
    }
    return handle.gate;
  }

  // D2 §3.5, K5: a run lease past its expiry, of a run this incarnation holds
  // on the real boundary, is re-granted on the same generation if and only if
  // its domain observes running, its ownership and launch authorization name
  // this incarnation and the current generation, the run is not ending, and a
  // fresh challenge on the init's channel succeeds within
  // pause_challenge_timeout. The re-grant never moves the deadline or restores
  // budget: a deadline or a day limit passed during the pause ends the run as
  // it would have, and no re-grant is made. Returns true when it decided the
  // run (re-granted, or ended for its deadline or budget); false leaves the
  // run to the lease's ordinary reconciliation (E27 item 3).
  // One challenge at a time per run (D2 §3.5: "While the challenge is
  // outstanding nothing replaces the run"): a tick that comes while one is
  // outstanding waits for its outcome instead of sending another, and a
  // challenge that went unanswered is not sent again on the same lease
  // generation, so a later tick cannot re-grant what the unanswered one
  // left to the lease's reconciliation.
  private readonly challenges = new Map<string, Promise<boolean>>();
  private readonly unanswered = new Map<string, number>();

  regrant(run: string): Promise<boolean> {
    const outstanding = this.challenges.get(run);
    if (outstanding) return outstanding;
    const p = this.regrantOnce(run).finally(() => this.challenges.delete(run));
    this.challenges.set(run, p);
    return p;
  }

  private async regrantOnce(run: string): Promise<boolean> {
    const handle = this.rt.handles.get(run);
    if (!handle) this.unanswered.delete(run);
    if (!handle || handle.ending || handle.sandbox === null || handle.claim.cgroup_path === null) return false;
    const launch = handle.sandbox;
    const facts = await this.rt.read<{ eligible: boolean; reason: string | null; generation: number | null; domain: string | null; invocation: string | null; deadline_at: string | null }>(
      'run.regrant_facts',
      { run, incarnation: this.rt.incarnation },
    );
    if (!facts.eligible || facts.generation === null) return false;
    if (this.unanswered.get(run) === facts.generation) return false;
    const gate = this.gate(handle);
    // Without a re-grant or an exit, what the role sent during the pause is
    // not acted on (its lease had expired), and its exit is the run's end's.
    const dropGate = () => {
      gate.lines = [];
      if (handle.gate === gate) handle.gate = null;
      gate.release();
    };
    if (facts.deadline_at !== null && nowMs() >= Date.parse(facts.deadline_at)) {
      dropGate();
      this.rt.requestEnd(handle, { outcome: 'timed_out', reason: 'deadline', asIs: true });
      return true;
    }
    let limit: string | null = null;
    try {
      limit = await this.rt.read<string | null>('budget.check', { run, invocation: handle.claim.invocation });
    } catch {
      limit = 'budget_unreadable';
    }
    if (limit !== null) {
      dropGate();
      this.rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: limit, asIs: true });
      return true;
    }
    // The backend's exit report, read after the pause: the backend exited
    // while the engine was stopped, and the run ends by its exit with what
    // it sent before it (SEAM.md §130); nothing is re-granted.
    if (gate.exit) {
      handle.expiryExempt = true;
      // The gate stays until its lines and the exit are taken: the launch's
      // supervision waits for its release before it acts on the exit.
      for (const line of gate.lines) await this.callback(handle, line).catch((err) => log('callback', err, { run }));
      gate.exit();
      handle.gate = null;
      gate.release();
      return true;
    }
    const populated = readPopulated(handle.claim.cgroup_path);
    if (populated.state !== 'populated' || populated.value !== 1 || !launch.alive) {
      dropGate();
      return false;
    }
    const sentAt = isoAt(nowMs());
    const response = await launch.challenge(handle.claim.invocation, facts.generation, this.rt.setting('pause_challenge_timeout') * 1000, seamMainFault('challenge_response_dropped'));
    if (response === null || handle.ending) {
      if (response === null) this.unanswered.set(run, facts.generation);
      dropGate();
      return false;
    }
    if (response.backend.state === 'exited') {
      // The backend exited during the pause: the run ends by its exit, with
      // what it sent before it (SEAM.md §130); nothing is re-granted.
      handle.expiryExempt = true;
      // The gate stays until its lines and the exit are taken: the launch's
      // supervision waits for its release before it acts on the exit.
      for (const line of gate.lines) await this.callback(handle, line).catch((err) => log('callback', err, { run }));
      const reported = gate.exit as (() => void) | null;
      if (reported) reported();
      else {
        // The init's report is lost or not yet read: the response says how
        // the backend ended.
        handle.sandbox.ackExit();
        handle.exit = { code: response.backend.code, signal: response.backend.signal === null ? null : String(response.backend.signal) };
        handle.exitAt = isoAt(nowMs());
      }
      handle.gate = null;
      gate.release();
      return true;
    }
    const at = await this.rt.engine<string | null>('run.regrant', {
      run,
      generation: facts.generation,
      incarnation: this.rt.incarnation,
      challenge: { nonce: response.nonce, sent_at: sentAt, answered_at: isoAt(nowMs()), backend_state: response.backend.state },
    });
    if (at === null) {
      dropGate();
      return false;
    }
    handle.renewedAtMs = Math.max(handle.renewedAtMs, Date.parse(at));
    handle.leaseLost = false;
    // What the role sent during the pause is acted on now, in order, on the
    // lease re-granted; then its exit, if it exited meanwhile.
    for (const line of gate.lines) await this.callback(handle, line).catch((err) => log('callback', err, { run }));
    (gate.exit as (() => void) | null)?.();
    handle.gate = null;
    gate.release();
    return true;
  }

  // A real backend's line, read by its adapter (D2 §§1.1, 1.5, 1.6): each
  // usage observation recorded (redacted) and checked against the budget as
  // the scripted protocol's are; the terminal event noted for the exit
  // class. Its result is the file, read after termination (D2 §1.4), never
  // a line; and nothing else in the stream is a command to the engine.
  private async adapterCallback(handle: RunHandle, stream: ClaudeStream, line: string): Promise<void> {
    const r = stream.feed(line);
    const { run, generation, invocation } = handle.claim;
    for (const u of r.usage) {
      const recorded = await this.recordUsage(handle, { run, generation, invocation, semantics: u.semantics, raw: redactValue(u.raw) });
      if (recorded) await this.checkBudget(handle);
    }
    if (r.terminal !== null) handle.terminal = r.terminal;
  }

  private async callback(handle: RunHandle, line: string): Promise<void> {
    if (handle.adapterStream !== null) return this.adapterCallback(handle, handle.adapterStream, line);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol line
    }
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    const { run, generation, invocation } = handle.claim;
    if (m.type === 'heartbeat') {
      await this.rt.heartbeat(handle);
    } else if (m.type === 'usage') {
      if ((m.semantics !== 'cumulative' && m.semantics !== 'delta') || typeof m.raw !== 'object' || m.raw === null || Array.isArray(m.raw)) return;
      const recorded = await this.recordUsage(handle, { run, generation, invocation, semantics: m.semantics, raw: redactValue(m.raw) });
      if (recorded) await this.checkBudget(handle);
    } else if (m.type === 'result') {
      // On the real boundary the result is the file the role leaves in
      // /surety/out, read only after the domain's termination is established
      // (D2 §1.4, K4): a result line read while the role runs is its
      // terminal event (§1.6), never recorded now. The scripted adapter's
      // line is held, unrecorded, as its stand-in for a role that wrote no
      // file; a real backend's line is never a result.
      if (handle.sandbox !== null) {
        handle.terminal = m.is_error === true || (m.subtype !== undefined && m.subtype !== 'success') ? 'failure' : 'success';
        return;
      }
      // D1 §4.3: duplicate terminal callbacks are idempotent on the invocation.
      if (handle.result !== null) return;
      // A run the engine has decided to end takes no late result, as a
      // closing lease takes none (D1 §8.3), also while the transaction that
      // would make the lease closing has not yet succeeded (E27 item 5).
      if (handle.ending) return;
      // Nothing the role sent is kept with a secret in it (SEAM.md §57).
      const sent = redactValue(m.result);
      const result = parseResult(sent, handle.claim.role);
      const valid = result !== null;
      if (valid) await pausePoint('run.result_received');
      // A valid result is kept as a record, published before anything
      // refers to it (SEAM.md §56).
      let record: string | null = null;
      if (valid) {
        try {
          record = await writeWholeRecord(this.rt, { project: handle.claim.project, run, kind: 'result', content: Buffer.from(JSON.stringify(sent)) });
        } catch (err) {
          log('result record', err, { run });
        }
      }
      const accepted = await this.recordResult(handle, valid, result, record);
      if (accepted && handle.result === null) handle.result = { valid };
    }
  }

  // The budget check on a usage observation (D1 §13.3; SEAM.md §55): a run
  // that has passed a limit with what it has observed is stopped at this
  // boundary, through the run-end protocol. A check that cannot read the
  // ledger has failed, and the run does not go on without one (D1 §6.6).
  private async checkBudget(handle: RunHandle): Promise<void> {
    if (handle.ending) return;
    const { run, invocation } = handle.claim;
    let limit: string | null;
    try {
      limit = await this.rt.read<string | null>('budget.check', { run, invocation });
    } catch (err) {
      log('budget check', err, { run });
      limit = 'budget_unreadable';
    }
    // A budget stop decided on a usage line read while the lease was pending
    // its challenge is the run's end as decided (SEAM.md §130).
    const pending = handle.sandbox !== null && (handle.gate !== null || this.pausedPastLease(handle));
    if (limit !== null) this.rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: limit, ...(pending ? { asIs: true } : {}) });
  }

  // A usage observation is never lost silently (E37 item 3). A store failure
  // while recording it is retried, at the waits used for a result
  // (RESULT_RETRY_MS), so that after one failed write the durable facts are
  // those of the same run with no failure: the observation in the ledger and
  // the budget checked on it. Only a store failure is retried, which rolled
  // its transaction back; none is made once the engine has decided to end the
  // run, whose outcome then marks its usage incomplete. If the observation
  // still cannot be recorded, the run is stopped as it is when the budget
  // cannot be read: its budget can no longer be known, and the run does not
  // go on without one (D1 §6.6). A run so stopped is engine-ended, so its
  // ledger row is charged with usage incomplete. Returns whether the
  // observation was recorded.
  private async recordUsage(handle: RunHandle, args: { run: string; generation: number; invocation: string; semantics: 'cumulative' | 'delta'; raw: unknown }): Promise<boolean> {
    const { run } = handle.claim;
    for (let attempt = 0; ; attempt++) {
      if (handle.ending) return false;
      try {
        return await this.rt.role<boolean>('run.usage', run, args);
      } catch (err) {
        const retryIn = RESULT_RETRY_MS[attempt];
        if ((err as { code?: unknown }).code !== 'store_error' || retryIn === undefined) {
          log('usage', err, { run, attempt: attempt + 1, lost: true });
          this.rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: 'budget_unreadable' });
          return false;
        }
        log('usage', err, { run, attempt: attempt + 1, retry_in_ms: retryIn });
        await new Promise((resolve) => setTimeout(resolve, retryIn));
      }
    }
  }

  // The result is the work the role was run for, so a store failure while
  // recording it is retried, at the waits RESULT_RETRY_MS gives: a few
  // seconds in all, during which the role's later callbacks wait. Only a
  // store failure is retried, which rolled its transaction back; every
  // attempt is fenced again in the store (D1 §8.3), and none is made once the
  // engine has decided to end the run. If every attempt fails, the run ends
  // failed with the cause stated (`resultLost`), never as if no result had
  // been sent (SEAM.md §61).
  private async recordResult(handle: RunHandle, valid: boolean, result: RunResult | null, record: string | null): Promise<boolean> {
    const { run, generation } = handle.claim;
    for (let attempt = 0; ; attempt++) {
      if (handle.ending) return false;
      try {
        return await this.rt.role<boolean>('run.result', run, { run, generation, valid, result, record, ...(handle.expiryExempt ? { pending: true } : {}) });
      } catch (err) {
        const retryIn = RESULT_RETRY_MS[attempt];
        if ((err as { code?: unknown }).code !== 'store_error') throw err;
        if (retryIn === undefined) {
          // The result is not lost silently (E27; SEAM.md §61): the run ends
          // failed with the cause stated, and the role's transcript holds the
          // line it sent.
          if (valid) handle.resultLost = `the result the role sent could not be recorded: ${attempt + 1} attempts failed (${(err as Error).message})`;
          throw err;
        }
        log('result', err, { run, attempt: attempt + 1, retry_in_ms: retryIn });
        await new Promise((resolve) => setTimeout(resolve, retryIn));
      }
    }
  }

  // The role process has exited and its output is read. Unless the run is
  // already ending, its outcome follows from what it sent (SEAM.md §13); the
  // run-end protocol then establishes termination, which the exit itself
  // never does.
  //
  // A run that earned `completed` is not ended yet: what its role left is
  // accepted first (runs/accept.ts). From slice 5 that is every dispatched
  // kind: a Verifier's and a Reviewer's runs are validated too (SEAM.md §68).
  private childDone(handle: RunHandle): void {
    const end = earnedEnd(handle);
    if (!handle.ending && end.outcome === 'completed' && ACCEPTED_KINDS.includes(handle.claim.work_kind) && this.rt.services) {
      this.rt.services.accept(handle);
      return;
    }
    this.rt.requestEnd(handle, handle.exitAt === null ? end : { ...end, decidedAt: end.decidedAt ?? handle.exitAt });
  }
}

// How long, after the role's exit, the engine goes on reading what is already
// in its output pipe: until the pipe closes, or nothing new has arrived for
// DRAIN_QUIET_MS, and never longer than DRAIN_CAP_MS. A role's last lines may
// still be in the pipe when its exit is reported; a descendant that holds the
// pipe open does not hold the run (SEAM.md §13, "When the role exits").
// Measured on the monotonic clock, so a wall clock that steps back cannot
// stretch or shorten the drain.
const DRAIN_QUIET_MS = 250;
const DRAIN_CAP_MS = 2000;

// The waits between attempts to record a role's result: a few seconds in
// all, well within a minute (SEAM.md §61).
const RESULT_RETRY_MS = [100, 300, 1000, 2000, 4000];

// The role's standard output, as protocol lines. When the engine stops
// reading, at the end of the stream or after the role's exit, whatever it has
// read after the last line ending is a line like any other (E27 item 1).
export class RoleOutput {
  private readonly lines: string[] = [];
  private readonly decoder = new StringDecoder('utf8');
  // The text read after the last line ending, as the pieces it arrived in:
  // joined once, when its line ends, so reading a line is linear in its
  // length (SEAM.md §24).
  private partial: string[] = [];
  private closed = false;
  private exitAt: number | null = null;
  private lastDataAt = 0;
  private wake: (() => void) | null = null;
  private readonly stream: Readable;

  // The supervisor's bounds on the stream (D2 §3.7), on the real boundary:
  // a line longer than `lineMax` bytes, or more than `queueMax` bytes of
  // lines read and not yet acted on, stops the reading and is reported.
  private partialBytes = 0;
  private queuedBytes = 0;

  constructor(
    stream: Readable,
    private readonly onBytes: (bytes: Buffer) => void,
    private readonly bounds: { lineMax: number; queueMax: number; onBound: (why: string) => void } | null = null,
  ) {
    this.stream = stream;
    this.stream.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      // The line bound is judged on the bytes as they arrive, before any of
      // them reaches the transcript: a line that would pass
      // stream_line_max_bytes is kept up to the bound and no further, so the
      // transcript ends at the bound itself (SEAM.md §157: kept, holding
      // fewer bytes than the role wrote).
      const cut = this.bounds ? this.lineCut(chunk, this.bounds.lineMax) : -1;
      if (cut >= 0) {
        this.onBytes(chunk.subarray(0, cut));
        this.partial = [];
        this.lines.length = 0;
        this.queuedBytes = 0;
        this.bounds!.onBound(`a line of the backend's output exceeded stream_line_max_bytes (${this.bounds!.lineMax} bytes): the run was cancelled and its transcript is truncated`);
        this.close();
        return;
      }
      this.onBytes(chunk);
      this.take(this.decoder.write(chunk));
      this.lastDataAt = performance.now();
      if (this.bounds && !this.closed) {
        const why =
          this.partialBytes > this.bounds.lineMax
            ? `a line of the backend's output exceeded stream_line_max_bytes (${this.bounds.lineMax} bytes): the run was cancelled and its transcript is truncated`
            : this.queuedBytes > this.bounds.queueMax
              ? `the backend's output queued beyond stream_queue_max_bytes (${this.bounds.queueMax} bytes): the run was cancelled and its transcript is truncated`
              : null;
        if (why !== null) {
          // Nothing past the bound is acted on: the line in progress and the
          // lines queued are dropped with the reading.
          this.partial = [];
          this.lines.length = 0;
          this.queuedBytes = 0;
          this.bounds.onBound(why);
          this.close();
          return;
        }
      }
      this.wake?.();
    });
    const ended = () => this.stop();
    this.stream.once('end', ended);
    this.stream.once('close', ended);
    this.stream.on('error', ended);
  }

  // The bytes of the line in progress, counted as they arrive.
  private lineBytes = 0;

  // Where in `chunk` the line in progress first passes `max` bytes (its line
  // ending not counted), or -1 when no line does; advances the count.
  private lineCut(chunk: Buffer, max: number): number {
    let at = this.lineBytes;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        at = 0;
        continue;
      }
      if (++at > max) return i;
    }
    this.lineBytes = at;
    return -1;
  }

  private take(text: string): void {
    if (text === '') return;
    const parts = text.split('\n');
    if (parts.length === 1) {
      this.partial.push(text);
      this.partialBytes += text.length;
      return;
    }
    const last = parts.pop()!;
    this.partial.push(parts[0]!);
    this.partialBytes += parts[0]!.length;
    if (this.bounds && this.partialBytes > this.bounds.lineMax) return;
    parts[0] = this.partial.join('');
    this.partial = last === '' ? [] : [last];
    this.partialBytes = last.length;
    for (const part of parts) {
      if (this.bounds && part.length > this.bounds.lineMax) {
        this.partialBytes = part.length;
        return;
      }
      this.lines.push(part.endsWith('\r') ? part.slice(0, -1) : part);
      this.queuedBytes += part.length;
    }
  }

  // No more is read. The text after the last line ending, if any, is the
  // last line.
  private stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.take(this.decoder.end());
    const rest = this.partial.join('');
    const last = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    this.partial = [];
    if (last !== '') this.lines.push(last);
    this.wake?.();
  }

  exited(): void {
    this.exitAt = performance.now();
    this.wake?.();
  }

  // The next line, or null once there are no more to act on.
  async next(): Promise<string | null> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) {
        this.queuedBytes -= line.length;
        return line;
      }
      if (this.closed) return null;
      let waitMs: number | null = null;
      if (this.exitAt !== null) {
        const now = performance.now();
        const quietFor = now - Math.max(this.exitAt, this.lastDataAt);
        if (quietFor >= DRAIN_QUIET_MS || now - this.exitAt >= DRAIN_CAP_MS) {
          this.stop();
          continue;
        }
        waitMs = Math.min(DRAIN_QUIET_MS - quietFor, DRAIN_CAP_MS - (now - this.exitAt));
      }
      await new Promise<void>((resolve) => {
        const timer = waitMs === null ? null : setTimeout(resolve, waitMs);
        this.wake = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        if (this.lines.length > 0 || this.closed) this.wake();
      });
      this.wake = null;
    }
  }

  // Stop reading; a descendant may still hold the pipe open.
  close(): void {
    this.stop();
    this.stream.removeAllListeners('data');
    this.stream.destroy();
  }
}
