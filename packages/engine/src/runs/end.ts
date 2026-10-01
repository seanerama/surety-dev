// The run-end protocol (D1 §4.5; build spec §6 corrections 1, 2, 12, 13).
// `endRun` is the only way a run ends and is idempotent; it is used for every
// outcome, by the choke point, Stop and Abandon, deadlines, quarantine
// clearance and startup recovery.
//
//   1. The run lease becomes closing and the run enters finalizing with its
//      outcome (one transaction, `run.begin_end`).
//   2. Each domain's termination is established. The exit of the process the
//      engine spawned establishes nothing: only the execution boundary's
//      report does, or the engine's own knowledge that it never spawned into
//      the domain. Processes are signalled TERM, then KILL after
//      terminate_grace, and never by a pid whose start time has changed.
//   3. If termination is not established within terminate_grace + kill_grace,
//      the run is quarantined and stays so until the boundary reports its
//      domains terminated (`clearQuarantine`, at every tick and at startup).
//   4. An abandoned run's workspace is discarded through the journal.
//   5–7. One transaction (`run.finish`) records the terminal observations and
//      ledger rows, disposes of the workspace, revokes the grant, releases
//      every lease naming the run, ends the run and moves its work item.

import { setTimeout as sleep } from 'node:timers/promises';

import { repoContext } from '../git/exec.js';
import { removeWorktree } from '../git/worktree.js';
import { markedProcesses, signalFound, signalRecordedGroup } from '../invoke/processes.js';
import { type RunHandle, type Runtime, log } from '../runtime.js';
import type { EndFacts } from '../store/transitions/runs.js';
import { pausePoint, seamObserveDomain } from '../testing/seam.js';

type Domain = EndFacts['domains'][number];

export interface EndOptions {
  // The incarnation whose startup recovery ends the run (correction 12).
  recovery?: string;
}

export class RunEnder {
  private readonly ending = new Map<string, Promise<void>>();

  constructor(private readonly rt: Runtime) {}

  async endRun(run: string, outcome: string, reason: string, opts: EndOptions = {}): Promise<void> {
    await this.rt.engine('run.begin_end', { run, outcome, reason });
    return this.complete(run, opts);
  }

  // Steps 2 to 7 for a run already finalizing. One at a time per run.
  complete(run: string, opts: EndOptions = {}): Promise<void> {
    const existing = this.ending.get(run);
    if (existing) return existing;
    const p = this.doComplete(run, opts).finally(() => this.ending.delete(run));
    this.ending.set(run, p);
    return p;
  }

  private async doComplete(run: string, opts: EndOptions): Promise<void> {
    const handle = this.rt.handles.get(run);
    if (handle) {
      handle.ending = true;
      handle.abort = true;
      await handle.settled;
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
    await pausePoint('run_end.before_ended');
    await this.rt.engine('run.finish', { run, invocations, recovery: opts.recovery ?? null });
    this.rt.handles.delete(run);
  }

  private async discard(facts: EndFacts): Promise<void> {
    const ws = facts.workspace!;
    const { operation } = await this.rt.engine<{ operation: string }>('worktree.intend', {
      run: facts.run.id,
      kind: 'worktree_remove',
      repo: facts.repo,
      path: ws.path,
      workspace: ws.id,
      deadlineSeconds: this.rt.setting('git_deadline'),
    });
    const probe = await removeWorktree(repoContext(facts.repo), ws.path);
    await this.rt.engine('worktree.settle', { operation, result: probe });
    if (probe !== 'absent') log('discard', new Error(`workspace ${ws.path} could not be removed (${probe}); it is retained`));
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
    const start = Date.now();
    let termSent = false;
    let killSent = false;
    for (;;) {
      if (seamObserveDomain(d.id) === 'terminated') {
        await this.rt.engine('domain.terminated', { domain: d.id, observed: true });
        return { terminated: true, seen };
      }
      const elapsed = Date.now() - start;
      if (!termSent) {
        signal('SIGTERM');
        termSent = true;
      } else if (!killSent && elapsed >= graceMs) {
        signal('SIGKILL');
        killSent = true;
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
      if (opts.signal) {
        if (d.pid !== null && d.pid_start_time !== null) signalRecordedGroup(d.pid, d.pgid ?? d.pid, d.pid_start_time, 'SIGKILL');
        for (const p of markedProcesses(d.id) ?? []) signalFound(p, 'SIGKILL');
      }
      if (seamObserveDomain(d.id) === 'terminated') await this.rt.engine('domain.terminated', { domain: d.id, observed: true });
    }
    const after = await this.rt.engine<EndFacts>('run.end_facts', { run });
    if (after.domains.every((d) => d.status === 'terminated')) await this.complete(run, opts);
  }

  // Every quarantined run of a project, observed again (D1 §8.1 step 1).
  async observeQuarantines(project: string): Promise<void> {
    const runs = await this.rt.read<{ id: string; project: string }[]>('runs.quarantined');
    for (const r of runs) {
      if (r.project !== project) continue;
      await this.clearQuarantine(r.id).catch((err) => log('quarantine', err));
    }
  }
}
