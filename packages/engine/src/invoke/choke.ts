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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { repoContext } from '../git/exec.js';
import { addWorktree, branchHead } from '../git/worktree.js';
import { processStartTime } from '../lock.js';
import { type RunHandle, type Runtime, log, newHandle } from '../runtime.js';
import type { Claim } from '../store/transitions/runs.js';
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
function isValidResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.status === 'completed' && typeof r.summary === 'string';
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
    const base = await branchHead(repoContext(target.repo), target.branch);
    if (base === null) {
      log('dispatch', new Error(`the integration branch of project ${target.project} could not be read`));
      return false;
    }
    const backend = seamBackends().find((b) => b.id === M1_BACKEND) ?? null;
    const claim = await this.rt.engine<Claim | null>('dispatch.claim', {
      project: target.project,
      workItem: item.id,
      incarnation: this.rt.incarnation,
      backend: { id: M1_BACKEND, version: backend?.version ?? 'unqualified' },
      baseRevision: base,
      maxConcurrentRuns: this.rt.setting('max_concurrent_runs'),
    });
    if (!claim) return false;
    const handle = newHandle(claim);
    this.rt.handles.set(claim.run, handle);
    // The claim committed the run, its domain and its receipt together.
    await pausePoint('dispatch.run_created');
    await pausePoint('dispatch.domain_allocated');
    await pausePoint('dispatch.receipt_committed');

    let ready = false;
    try {
      ready = await this.prepare(handle, backend, target.repo);
    } catch (err) {
      log('dispatch', err);
      this.never(handle, 'failed', 'infra_error');
      return true;
    }
    if (ready && backend) void this.launch(handle, backend).catch((err) => log('launch', err));
    return true;
  }

  // The run will never be spawned into by this incarnation.
  private never(handle: RunHandle, outcome: string, reason: string, phase: 'never' | 'aborted' = 'never'): void {
    handle.phase = phase;
    handle.settle();
    if (!handle.ending) {
      handle.ending = true;
      void this.rt.services?.endRun(handle.claim.run, outcome, reason).catch((err) => log('run end', err));
    }
  }

  // Backend check, workspace, dispatch_started. Returns false if the run is
  // not to be spawned.
  private async prepare(handle: RunHandle, backend: BackendSpec | null, repo: string): Promise<boolean> {
    const { claim } = handle;
    if (!backend) {
      // D1 §15.1: an unqualified backend is refused before launch.
      await this.rt.engine('invoke.refuse', { run: claim.run, invocation: claim.invocation, code: 'backend_refused' });
      handle.phase = 'never';
      handle.settle();
      handle.ending = true;
      void this.rt.services?.completeEnd(claim.run).catch((err) => log('run end', err));
      return false;
    }
    if (handle.abort) {
      handle.phase = 'aborted';
      handle.settle();
      return false;
    }

    // D1 §7.3: `git worktree add --detach <ws> <base>`, journaled.
    const path = join(this.rt.home, 'workspaces', claim.run);
    mkdirSync(join(this.rt.home, 'workspaces'), { recursive: true, mode: 0o700 });
    const { operation } = await this.rt.engine<{ operation: string }>('worktree.intend', {
      run: claim.run,
      kind: 'worktree_add',
      repo,
      path,
      base: claim.base_revision,
      deadlineSeconds: this.rt.setting('git_deadline'),
    });
    const probe = await addWorktree(repoContext(repo), path, claim.base_revision);
    const { workspace } = await this.rt.engine<{ workspace: string | null }>('worktree.settle', { operation, result: probe });
    if (workspace === null) {
      this.never(handle, 'failed', 'infra_error');
      return false;
    }
    handle.workspacePath = path;

    const started = await this.rt.engine<boolean>('invoke.dispatch_started', { run: claim.run, invocation: claim.invocation });
    if (!started || handle.abort) {
      handle.phase = 'aborted';
      handle.settle();
      return false;
    }
    return true;
  }

  private async launch(handle: RunHandle, backend: BackendSpec): Promise<void> {
    const { claim } = handle;
    await pausePoint('launch.before_spawn');
    // The lease is checked again after the barrier: a run stopped or
    // abandoned meanwhile is not left with a live child (SEAM.md §18).
    const active = await this.rt.engine<boolean>('run.lease_active', { run: claim.run, generation: claim.generation });
    if (handle.abort || !active) {
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
      log('spawn', err);
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    if (child.pid === undefined) {
      child.once('error', (err) => log('spawn', err));
      this.never(handle, 'failed', 'infra_error');
      return;
    }
    child.on('error', (err) => log('role process', err));
    handle.child = child;
    handle.pid = child.pid;
    // Read before the event loop can reap the child, so it is there to read;
    // if it cannot be read it is recorded as unknown, and the process is then
    // reached only by its marker, never by a pid whose identity is unproven.
    handle.startTime = processStartTime(child.pid);

    const lines: string[] = [];
    let closed = false;
    const reader = createInterface({ input: child.stdout! });
    let wake: (() => void) | null = null;
    reader.on('line', (line) => {
      lines.push(line);
      wake?.();
    });
    reader.on('close', () => {
      closed = true;
      wake?.();
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        handle.exit = { code, signal };
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

    await pausePoint('launch.before_ownership');
    try {
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

    // The role's callbacks, one at a time, in the order sent.
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) {
        await this.callback(handle, line).catch((err) => log('callback', err));
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (lines.length > 0 || closed) resolve();
      });
      wake = null;
    }
    // The output is closed; wait for the exit status, but not for ever: a
    // descendant may hold nothing open and the exit has then already come.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
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
      await this.rt.role('run.heartbeat', run, { run, generation });
    } else if (m.type === 'usage') {
      if ((m.semantics !== 'cumulative' && m.semantics !== 'delta') || typeof m.raw !== 'object' || m.raw === null) return;
      await this.rt.role('run.usage', run, { run, generation, invocation, semantics: m.semantics, raw: m.raw });
    } else if (m.type === 'result') {
      // D1 §4.3: duplicate terminal callbacks are idempotent on the invocation.
      if (handle.result !== null) return;
      const valid = isValidResult(m.result);
      if (valid) await pausePoint('run.result_received');
      const accepted = await this.rt.role<boolean>('run.result', run, { run, generation, valid });
      if (accepted && handle.result === null) handle.result = { valid };
    }
  }

  // The role process has exited and its output is read. Unless the run is
  // already ending, its outcome follows from what it sent (SEAM.md §13); the
  // run-end protocol then establishes termination, which the exit itself
  // never does.
  private childDone(handle: RunHandle): void {
    if (handle.ending) return;
    handle.ending = true;
    let outcome = 'failed';
    let reason = 'infra_error';
    if (handle.result?.valid === false) reason = 'invalid_result';
    else if (handle.result?.valid === true && handle.exit?.code === 0) {
      outcome = 'completed';
      reason = 'none';
    }
    void this.rt.services?.endRun(handle.claim.run, outcome, reason).catch((err) => log('run end', err));
  }
}
