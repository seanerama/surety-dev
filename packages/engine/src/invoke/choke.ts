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

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { repoContext } from '../git/exec.js';
import { treeOf } from '../git/repo.js';
import { captureMetadata, indexHashOfTree } from '../git/snapshot.js';
import { INTEGRATING_KINDS } from '../runs/accept.js';
import type { RunResult } from '../store/transitions/accept.js';
import { isoAt, nowMs } from '../clock.js';
import { processStartTime } from '../lock.js';
import { type RunHandle, type Runtime, earnedEnd, log, newHandle } from '../runtime.js';
import type { Claim, Outcome, ReasonClass } from '../store/transitions/runs.js';
import { RecordStream, writeWholeRecord } from '../records/files.js';
import { redactValue } from '../records/redact.js';
import { pausePoint, seamBackends } from '../testing/seam.js';
import { type BackendSpec, M1_BACKEND } from './backend.js';
import { DOMAIN_MARKER, INVOCATION_MARKER } from './processes.js';

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
function parseResult(value: unknown): RunResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.status !== 'completed' || typeof r.summary !== 'string') return null;
  if (r.checkpoint !== undefined && typeof r.checkpoint !== 'boolean') return null;
  if (r.nominate !== undefined && typeof r.nominate !== 'boolean') return null;
  return { summary: r.summary, checkpoint: r.checkpoint === true, nominate: r.nominate === true };
}

// The role's environment is constructed, never inherited (D1 §17(4)): no
// engine home, no token, no git or editor variables.
function childEnv(claim: Claim): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    [DOMAIN_MARKER]: claim.domain,
    [INVOCATION_MARKER]: claim.invocation,
  };
}

export class Launcher {
  constructor(private readonly rt: Runtime) {}

  // One dispatch, as far as the tick waits for it: everything the run needs
  // before its spawn is durable when this returns true. The launch goes on
  // asynchronously (D1 §8.1 step 9).
  async dispatch(target: DispatchTarget, item: { id: string }): Promise<boolean> {
    const backend = seamBackends().find((b) => b.id === M1_BACKEND) ?? null;
    // The run's base is the commit the registry expects the integration
    // branch at, or the checkpoint the work continues from (D1 §7.4); the
    // claim reads it in its own transaction.
    const claim = await this.rt.engine<Claim | null>('dispatch.claim', {
      project: target.project,
      workItem: item.id,
      incarnation: this.rt.incarnation,
      backend: { id: M1_BACKEND, version: backend?.version ?? 'unqualified' },
      maxConcurrentRuns: this.rt.setting('max_concurrent_runs'),
    });
    if (!claim) return false;
    const handle = newHandle(claim);
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

    let ready = false;
    try {
      ready = await this.prepare(handle, backend, target.repo);
    } catch (err) {
      log('dispatch', err, { run: claim.run });
      this.never(handle, 'failed', 'infra_error');
      return true;
    }
    if (ready && backend) void this.launch(handle, backend);
    return true;
  }

  // The run will never be spawned into by this incarnation.
  private never(handle: RunHandle, outcome: Outcome, reason: ReasonClass, phase: 'never' | 'aborted' = 'never', reasonText?: string): void {
    handle.phase = phase;
    handle.settle();
    this.rt.requestEnd(handle, reasonText === undefined ? { outcome, reason } : { outcome, reason, reasonText });
  }

  // Backend check, workspace, dispatch_started. Returns false if the run is
  // not to be spawned.
  private async prepare(handle: RunHandle, backend: BackendSpec | null, repo: string): Promise<boolean> {
    const { claim } = handle;
    if (!backend) {
      // D1 §15.1: an unqualified backend is refused before launch. The
      // refusal is the end the engine decided, and it is kept with the
      // handle: if recording it fails, the engine's retry records the same
      // refusal, never a failure (SEAM.md §24).
      this.never(handle, 'refused', 'preflight_refused', 'never', 'backend_refused');
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
  private async launch(handle: RunHandle, backend: BackendSpec): Promise<void> {
    try {
      await this.supervise(handle, backend);
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
        env: childEnv(claim),
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

    const output = new RoleOutput(child, (bytes) => transcript.write(bytes));
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
    child.stdin!.end(
      `${JSON.stringify({
        invocation: claim.invocation,
        domain: claim.domain,
        run: claim.run,
        project: claim.project,
        work_item: claim.work_item,
        work_kind: claim.work_kind,
        role: claim.role,
        workspace: handle.workspacePath,
      })}\n`,
    );

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

  private async callback(handle: RunHandle, line: string): Promise<void> {
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
      const recorded = await this.rt.role<boolean>('run.usage', run, { run, generation, invocation, semantics: m.semantics, raw: redactValue(m.raw) });
      if (recorded) await this.checkBudget(handle);
    } else if (m.type === 'result') {
      // D1 §4.3: duplicate terminal callbacks are idempotent on the invocation.
      if (handle.result !== null) return;
      // A run the engine has decided to end takes no late result, as a
      // closing lease takes none (D1 §8.3), also while the transaction that
      // would make the lease closing has not yet succeeded (E27 item 5).
      if (handle.ending) return;
      // Nothing the role sent is kept with a secret in it (SEAM.md §57).
      const sent = redactValue(m.result);
      const result = parseResult(sent);
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
    if (limit !== null) this.rt.requestEnd(handle, { outcome: 'stopped', reason: 'budget', reasonText: limit });
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
        return await this.rt.role<boolean>('run.result', run, { run, generation, valid, result, record });
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
  // A run of the Builder's or the Architect's kinds that earned `completed`
  // is not ended yet: what its role left is accepted first (runs/accept.ts).
  private childDone(handle: RunHandle): void {
    const end = earnedEnd(handle);
    if (!handle.ending && end.outcome === 'completed' && INTEGRATING_KINDS.includes(handle.claim.work_kind) && this.rt.services) {
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
class RoleOutput {
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

  constructor(
    child: ChildProcess,
    private readonly onBytes: (bytes: Buffer) => void,
  ) {
    this.stream = child.stdout!;
    this.stream.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.onBytes(chunk);
      this.take(this.decoder.write(chunk));
      this.lastDataAt = performance.now();
      this.wake?.();
    });
    const ended = () => this.stop();
    this.stream.once('end', ended);
    this.stream.once('close', ended);
    this.stream.on('error', ended);
  }

  private take(text: string): void {
    if (text === '') return;
    const parts = text.split('\n');
    if (parts.length === 1) {
      this.partial.push(text);
      return;
    }
    const last = parts.pop()!;
    this.partial.push(parts[0]!);
    parts[0] = this.partial.join('');
    this.partial = last === '' ? [] : [last];
    for (const part of parts) this.lines.push(part.endsWith('\r') ? part.slice(0, -1) : part);
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
      if (line !== undefined) return line;
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
