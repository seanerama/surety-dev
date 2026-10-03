// The run-end protocol (D1 §4.5; build spec §6 corrections 1, 2, 12, 13).
// `endRun` is the only way a run ends and is idempotent; it is used for every
// outcome, by the choke point, Stop and Abandon, deadlines, the tick's
// reconciliation of expired leases, quarantine clearance and startup
// recovery.
//
//   1. The run lease becomes closing and the run enters finalizing with its
//      outcome (one transaction, `run.begin_end`).
//   2. Each domain's termination is established. The exit of the process the
//      engine spawned establishes nothing: only the execution boundary's
//      report does, or the engine's own knowledge that it never spawned into
//      the domain. Processes are signalled TERM, then KILL after
//      terminate_grace, and never by a pid whose start time has changed.
//   3. If termination is not established within terminate_grace + kill_grace,
//      or the boundary reports `unknown`, the run is quarantined and stays so
//      until the boundary reports its domains terminated (`clearQuarantine`,
//      at every tick and at startup). An `unknown` report ends the wait for a
//      report, not the signalling: KILL still follows TERM after
//      terminate_grace.
//   4. An abandoned run's workspace is discarded through the journal.
//   5–7. One transaction (`run.finish`) records the terminal observations and
//      ledger rows, disposes of the workspace, revokes the grant, releases
//      every lease naming the run, ends the run and moves its work item.
//
// If a step fails, the engine retries the protocol itself (E27 item 5;
// `retryDue`): from the step that failed, with the end it had decided, at
// most one attempt at a time per run, the first half a second later and then
// at doubling intervals up to RETRY_MAX_MS, and at once at every tick. Once
// the engine has decided to end a run nothing renews its lease, so the lease
// expires as well, and the tick's reconciliation (`reconcileExpired`) is the
// backstop that holds even for a run whose decision this engine has lost.

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { worktreeContext } from '../git/exec.js';
import { checkoutBaseline } from '../git/repo.js';
import { type MetadataBaseline, snapshotTree } from '../git/snapshot.js';
import type { Baseline } from '../store/transitions/repo.js';
import { markedProcesses, signalFound, signalRecordedGroup } from '../invoke/processes.js';
import { type RunEnd, type RunHandle, type Runtime, expiryEnd, log } from '../runtime.js';
import type { EndFacts } from '../store/transitions/runs.js';
import { pausePoint, seamObserveDomain } from '../testing/seam.js';
import { terminateDomain } from '../boundary/terminate.js';
import type { DomainRow } from '../store/transitions/boundary.js';

type Domain = EndFacts['domains'][number];

export interface EndOptions {
  // The incarnation whose startup recovery ends the run (correction 12).
  recovery?: string;
}

// A run-end protocol that failed part way, waiting for its next attempt.
// `end` is the decided end when step 1 itself has not been recorded; null
// when the run is already finalizing and only steps 2 to 7 remain.
interface Retry {
  end: RunEnd | null;
  opts: EndOptions;
  project: string | null;
  failures: number;
  dueAt: number; // monotonic ms
  running: boolean;
}

const RETRY_FIRST_MS = 500;
const RETRY_MAX_MS = 10_000;

// How long the end of a run waits for the engine to finish reading its
// role's output by itself before it stops reading.
const OUTPUT_GRACE_MS = 5000;

export class RunEnder {
  private readonly ending = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, Retry>();
  // Prior incarnations whose supervisor leaf startup recovery could not
  // close, with why: their domains are `unknown` (D2 §§3.3, 3.4).
  priorUnknown = new Map<string, string>();

  constructor(private readonly rt: Runtime) {}

  async endRun(run: string, end: RunEnd, opts: EndOptions = {}): Promise<void> {
    try {
      await this.rt.engine('run.begin_end', { run, outcome: end.outcome, reason: end.reason, reasonText: end.reasonText, decidedAt: end.decidedAt, detail: end.detail });
    } catch (err) {
      this.failed(run, end, opts);
      throw err;
    }
    return this.complete(run, opts);
  }

  // Steps 2 to 7 for a run already finalizing. One at a time per run.
  complete(run: string, opts: EndOptions = {}): Promise<void> {
    const existing = this.ending.get(run);
    if (existing) return existing;
    const p = this.doComplete(run, opts)
      .then(
        () => {
          this.retries.delete(run);
        },
        (err: unknown) => {
          this.failed(run, null, opts);
          throw err;
        },
      )
      .finally(() => this.ending.delete(run));
    this.ending.set(run, p);
    return p;
  }

  // Record a failed attempt and when the next one is due. An end decided
  // before is kept: a failure in a later step does not forget it.
  private failed(run: string, end: RunEnd | null, opts: EndOptions): void {
    const prior = this.retries.get(run);
    const failures = (prior?.failures ?? 0) + 1;
    this.retries.set(run, {
      end: end ?? prior?.end ?? null,
      opts,
      project: this.rt.handles.get(run)?.claim.project ?? prior?.project ?? null,
      failures,
      dueAt: performance.now() + Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS),
      running: false,
    });
  }

  // Retry every failed run end that is due, or, from a tick (`project` given),
  // every one of that project at once. An attempt that succeeds leaves the
  // run ended or quarantined and is forgotten; one that fails is recorded
  // again with a longer wait. Neither the watch nor the tick waits for it.
  retryDue(project?: string): void {
    const now = performance.now();
    for (const [run, r] of this.retries) {
      if (r.running || this.ending.has(run)) continue;
      if (project === undefined ? now < r.dueAt : r.project !== null && r.project !== project) continue;
      r.running = true;
      const attempt = r.end ? this.endRun(run, r.end, r.opts) : this.complete(run, r.opts);
      attempt.catch((err) => log('run end retry', err, { run, failures: r.failures }));
    }
  }

  private async doComplete(run: string, opts: EndOptions): Promise<void> {
    const handle = this.rt.handles.get(run);
    if (handle) {
      handle.ending = true;
      handle.abort = true;
      await handle.settled;
      // An operation the run issued is reconciled before the run ends (D1
      // §4.5 step 4): the acceptance pipeline settles what it has in flight.
      if (handle.pipeline) await handle.pipeline;
    }
    const facts = await this.rt.engine<EndFacts>('run.end_facts', { run });
    if (facts.run.state === 'ended') {
      this.rt.handles.delete(run);
      return;
    }
    if (facts.run.state !== 'finalizing') throw new Error(`run ${run} is ${facts.run.state}, not finalizing`);

    const invocations: Record<string, 'refused'> = {};
    const open: string[] = [];
    const seen: string[] = [];
    const domains = facts.domains.filter((d) => d.status !== 'terminated');
    const results = await Promise.all(
      domains.map(async (d) => {
        if (d.status === 'quarantined') return { d, terminated: false };
        if (d.cgroup_path !== null) {
          const r = await this.terminateReal(d, handle, {});
          if (r.terminated && r.refused) invocations[d.invocation] = 'refused';
          return { d, terminated: r.terminated };
        }
        if (handle && handle.claim.domain === d.id && (handle.phase === 'aborted' || handle.phase === 'never')) {
          // The running engine knows it never spawned into this domain.
          await this.rt.engine('domain.terminated', { domain: d.id, observed: false });
          invocations[d.invocation] = 'refused';
          return { d, terminated: true };
        }
        const r = await this.terminate(facts, d, handle);
        seen.push(...r.seen);
        return { d, terminated: r.terminated };
      }),
    );
    for (const r of results) if (!r.terminated) open.push(r.d.id);
    if (open.length > 0) {
      await this.rt.engine('run.quarantine', { run, domains: open, processes: [...new Set(seen)], incarnation: this.rt.incarnation });
      return;
    }
    await this.finish(run, invocations, opts);
  }

  private async finish(run: string, invocations: Record<string, string>, opts: EndOptions): Promise<void> {
    const facts = await this.rt.engine<EndFacts>('run.end_facts', { run });
    if (facts.run.state === 'ended') return;
    // Step 6 for Abandon: the workspace is discarded only now that
    // termination is established, never while a writer may survive.
    if (facts.run.outcome === 'abandoned' && facts.workspace && facts.workspace.disposition !== 'discarded') {
      await this.discard(facts);
    }
    const ws = facts.workspace;
    let baseline: Baseline | null = null;
    if (ws && ws.disposition !== 'discarded' && ws.metadata_baseline) {
      const metadata = JSON.parse(ws.metadata_baseline) as MetadataBaseline;
      const ctx = worktreeContext(facts.repo, metadata.adminDir, ws.path);
      // D1-32: a recovery captures what the role left, once termination is
      // established. It validates, commits and integrates nothing.
      if (opts.recovery && ws.snapshot_tree === null) {
        const tree = await snapshotTree(ctx, ws.current_base, this.rt.scratch).catch(() => null);
        if (tree !== null) await this.rt.engine('workspace.snapshot', { workspace: ws.id, tree });
      }
      // What the role left is the retained workspace's baseline from now on.
      baseline = await checkoutBaseline(ctx, this.rt.scratch).catch(() => null);
    }
    // The run's transcript ends where the engine stops reading the role's
    // output (SEAM.md §56). Termination is established by now, so what the
    // role wrote is read within the drain; should a descendant still hold
    // the output open, the engine stops reading it.
    const handle = this.rt.handles.get(run);
    if (handle?.output) {
      const done = await Promise.race([handle.output.done.then(() => true), sleep(OUTPUT_GRACE_MS).then(() => false)]);
      if (!done) {
        handle.output.stop();
        await handle.output.done;
      }
    }
    await pausePoint('run_end.before_ended');
    await this.rt.engine('run.finish', { run, invocations, recovery: opts.recovery ?? null, baseline });
    this.rt.handles.delete(run);
  }

  // The removal of an abandoned run's workspace, through the journal: one
  // operation per workspace. A repeated discard finds the operation it
  // recorded and drives it on from what the journal holds; the run is not
  // ended until the removal is finalized (SEAM.md §§24, 45).
  private async discard(facts: EndFacts): Promise<void> {
    const ws = facts.workspace!;
    const intent = await this.rt.journal.intend(
      'journal.intend',
      {
        project: facts.run.project,
        kind: 'worktree_remove',
        payload: { repo: facts.repo, run: facts.run.id, path: ws.path, workspace: ws.id },
        target: { repo: facts.repo, path: ws.path },
        subject: { run: facts.run.id, action: 'worktree_remove' },
        finalizer: { purpose: 'discard', run: facts.run.id, workspace: ws.id },
        deadlineSeconds: this.rt.setting('git_deadline'),
      },
      'worktree_remove',
    );
    if (!('operation' in intent)) throw new Error(`the removal of workspace ${ws.path} could not be journaled`);
    const settled = await this.rt.journal.drive(intent.operation);
    if (settled.end !== 'finalized') {
      throw new Error(`workspace ${ws.path} is not discarded yet: its removal is ${settled.end}; the run ends once it is`);
    }
  }

  // A domain of the real boundary (D2 §3.2): closure, the launcher, TERM,
  // cgroup.kill, observation (boundary/terminate.ts). A domain whose cgroup
  // was never made and into which this engine never spawned is terminated
  // on the engine's own knowledge, as on the scripted boundary. `refused`:
  // no role code ever ran in it (its launch was never authorized, or its
  // sandbox was never built), so its invocation was never launched.
  private async terminateReal(d: Domain, handle: RunHandle | undefined, opts: { observeOnly?: boolean }): Promise<{ terminated: boolean; refused: boolean }> {
    const own = handle && handle.claim.domain === d.id ? handle : undefined;
    if (d.cgroup_inode === null && own && (own.phase === 'aborted' || own.phase === 'never') && own.sandbox === null && !existsSync(d.cgroup_path!)) {
      await this.rt.engine('domain.terminated', { domain: d.id, observed: false });
      return { terminated: true, refused: true };
    }
    const row = await this.rt.read<DomainRow | null>('domain.row', { domain: d.id });
    if (row === null) return { terminated: false, refused: false };
    const verdict = await terminateDomain({
      rt: this.rt,
      d: row,
      incarnation: d.incarnation,
      handle: own,
      knownUnknown: this.priorUnknown.get(d.incarnation) ?? null,
      ...(opts.observeOnly ? { observeOnly: true } : {}),
    });
    if (!verdict.terminated) return { terminated: false, refused: false };
    const neverRan = row.launch_binding === null || (own !== undefined && !own.backendStarted && own.sandbox?.launcherExit !== null);
    return { terminated: true, refused: neverRan };
  }

  // Termination of every domain of a run that is not terminated yet, before a
  // snapshot (correction 1). Returns whether it was established for all. The
  // run is not quarantined here: the run-end protocol does that.
  async terminateDomains(run: string): Promise<boolean> {
    const facts = await this.rt.engine<EndFacts>('run.end_facts', { run });
    const handle = this.rt.handles.get(run);
    let all = true;
    for (const d of facts.domains) {
      if (d.status === 'terminated') continue;
      if (d.status === 'quarantined') {
        all = false;
        continue;
      }
      const r = d.cgroup_path !== null ? await this.terminateReal(d, handle, {}) : await this.terminate(facts, d, handle);
      if (!r.terminated) all = false;
    }
    return all;
  }

  // Step 2 for one domain. Returns whether termination was established.
  private async terminate(facts: EndFacts, d: Domain, handle: RunHandle | undefined): Promise<{ terminated: boolean; seen: string[] }> {
    const seen: string[] = [];
    let target: { pid: number; pgid: number; startTime: string } | null = null;
    if (handle?.pid && handle.startTime && handle.claim.domain === d.id) target = { pid: handle.pid, pgid: handle.pid, startTime: handle.startTime };
    else if (d.pid !== null && d.pid_start_time !== null) target = { pid: d.pid, pgid: d.pgid ?? d.pid, startTime: d.pid_start_time };
    else {
      // Ownership was never completed (a crash between spawn and ownership):
      // its processes are found by their marker, and what is found is recorded
      // so the launch is never reported as one that did not happen.
      const found = markedProcesses(d.id) ?? [];
      if (found.length > 0) {
        const first = found[0]!;
        await this.rt.engine('invoke.found_process', { run: facts.run.id, invocation: d.invocation, domain: d.id, pid: first.pid, pgid: first.pid, startTime: first.startTime });
        target = { pid: first.pid, pgid: first.pid, startTime: first.startTime };
      }
    }
    const signal = (sig: NodeJS.Signals) => {
      if (target && signalRecordedGroup(target.pid, target.pgid, target.startTime, sig)) seen.push(String(target.pid));
      for (const p of markedProcesses(d.id) ?? []) if (signalFound(p, sig)) seen.push(String(p.pid));
    };
    const graceMs = this.rt.setting('terminate_grace') * 1000;
    const killMs = this.rt.setting('kill_grace') * 1000;
    // The grace periods are real time, measured on the monotonic clock: a
    // wall clock that steps back cannot stretch them, and one that jumps
    // cannot cut them short.
    const start = performance.now();
    let termSent = false;
    let killSent = false;
    for (;;) {
      const observed = seamObserveDomain(d.id);
      if (observed === 'terminated') {
        await this.rt.engine('domain.terminated', { domain: d.id, observed: true });
        return { terminated: true, seen };
      }
      const elapsed = performance.now() - start;
      if (!termSent) {
        signal('SIGTERM');
        termSent = true;
      } else if (!killSent && elapsed >= graceMs) {
        signal('SIGKILL');
        killSent = true;
      }
      // The grace periods are time for signalled processes to exit. No signal
      // makes an unreadable boundary readable, so an `unknown` report means
      // quarantine when it is made (SEAM.md §14). A later `terminated` report
      // clears the quarantine; it does not undo it. The report ends the wait
      // for a report, not the signalling: what was sent TERM is still sent
      // KILL once terminate_grace has passed (D1 §4.5 step 2), by a timer of
      // this protocol, not by a tick. `signal` then reaches the recorded
      // process only if it is still that process, and finds the domain's
      // marked processes again.
      if (observed === 'unknown') {
        if (!killSent) {
          const timer = setTimeout(() => {
            try {
              signal('SIGKILL');
            } catch (err) {
              log('kill after unknown', err, { run: facts.run.id, domain: d.id });
            }
          }, Math.max(0, graceMs - elapsed));
          timer.unref();
        }
        return { terminated: false, seen };
      }
      if (elapsed >= graceMs + killMs) return { terminated: false, seen };
      await sleep(200);
    }
  }

  // A quarantine ends only on observed termination (corrections 2, 13): each
  // quarantined domain is observed once; when every domain of the run is
  // terminated the run ends with the outcome it already had. At startup the
  // processes still found are signalled first (D1 §16.1).
  async clearQuarantine(run: string, opts: EndOptions & { signal?: boolean } = {}): Promise<void> {
    if (this.ending.has(run)) return;
    const facts = await this.rt.engine<EndFacts>('run.end_facts', { run });
    if (facts.run.state !== 'finalizing' || facts.run.quarantined !== 1) return;
    for (const d of facts.domains) {
      if (d.status !== 'quarantined') continue;
      if (d.cgroup_path !== null) {
        // The real boundary: each tick observes, under the same closure
        // prerequisites, and signals nothing; startup recovery terminates
        // (D2 §§3.3, 3.4).
        await this.terminateReal(d, this.rt.handles.get(run), { observeOnly: !opts.signal });
        continue;
      }
      if (opts.signal) {
        if (d.pid !== null && d.pid_start_time !== null) signalRecordedGroup(d.pid, d.pgid ?? d.pid, d.pid_start_time, 'SIGKILL');
        for (const p of markedProcesses(d.id) ?? []) signalFound(p, 'SIGKILL');
      }
      if (seamObserveDomain(d.id) === 'terminated') await this.rt.engine('domain.terminated', { domain: d.id, observed: true });
    }
    const after = await this.rt.engine<EndFacts>('run.end_facts', { run });
    if (after.domains.every((d) => d.status === 'terminated')) await this.complete(run, opts);
  }

  // D1 §8.1 step 1: every unreleased run lease of the project past its expiry
  // is reconciled through the run-end protocol, whether or not the engine
  // that owns it is alive and whatever that engine is doing with the run. An
  // outcome already recorded is kept; an end this engine decided before the
  // expiry stands; otherwise the run is recovered (expiryEnd; E27 item 3).
  // The tick waits for the transaction that begins the end, not for the rest
  // of the protocol: a launch stalled before its spawn is not waited for, and
  // finds its run ending when it comes back (SEAM.md §16, "The run lease").
  // This is also the backstop under the engine's own retry of a run end that
  // failed part way: such a run's lease is no longer renewed.
  async reconcileExpired(project: string): Promise<void> {
    const expired = await this.rt.read<{ run: string; project: string }[]>('runs.expired_leases');
    for (const e of expired) {
      if (e.project !== project) continue;
      const handle = this.rt.handles.get(e.run);
      // A run whose role exited 0 after a valid result is held by the
      // acceptance pipeline, which ends it with the outcome its steps decide
      // (runs/accept.ts); it does not wait for a renewal it would never get.
      if (handle?.accepting && !handle.ending) continue;
      // A run on the real boundary that this engine holds, after a pause: a
      // fresh challenge may re-grant it (D2 §3.5).
      if (handle && handle.sandbox !== null && !handle.ending && this.rt.services && (await this.rt.services.regrant(e.run).catch(() => false))) continue;
      const end = expiryEnd(handle);
      if (handle) {
        handle.leaseLost = true;
        handle.ending = true;
        handle.intended ??= end;
      }
      const begun = await this.rt.engine<{ run: string; state: string } | null>('run.expire', {
        run: e.run,
        outcome: end.outcome,
        reason: end.reason,
        decidedAt: end.decidedAt,
      });
      if (begun === null) continue;
      void this.complete(e.run).catch((err) => log('run end', err, { run: e.run, cause: 'lease_expired' }));
    }
  }

  // Every quarantined run of a project, observed again (D1 §8.1 step 1).
  async observeQuarantines(project: string): Promise<void> {
    const runs = await this.rt.read<{ id: string; project: string }[]>('runs.quarantined');
    for (const r of runs) {
      if (r.project !== project) continue;
      await this.clearQuarantine(r.id).catch((err) => log('quarantine', err, { run: r.id }));
    }
  }
}
