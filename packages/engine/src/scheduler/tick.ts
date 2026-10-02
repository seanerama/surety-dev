// The scheduler (D1 §1.5, §8.1). One tick every tick_interval, or when a tick
// is requested through the API, which only sets a flag this loop consumes.
// One tick runs at a time.
//
// A tick, for every registered project:
//   1. Recover: a run end of the project that failed part way is retried at
//      once (not waited for); quarantined runs are observed again, and a
//      domain the boundary now reports terminated is cleared and its run
//      ended. Every run lease past its expiry is reconciled through the
//      run-end protocol.
//   2. Journal: every operation of the project that is not finalized and
//      not failed, and that nothing in this engine is driving, is probed and
//      taken on its way (correction 14); a nomination that is due is made.
//   3. Repository integrity (D1 §7.6).
//   (4. budgets: a project whose day has passed a day limit is not
//      dispatched; the select step and the claim check it, and a check whose
//      read fails dispatches nothing of the project.)
//   8. Select, and 9. dispatch: at most one run per project and
//      max_concurrent_runs engine-wide; work at its chaining boundary is not
//      dispatched and gets one decision instead (D1-34); the tick waits for
//      what a dispatch writes before its spawn, never for the spawn or the run.
//  Then records whose retention has passed expire, and
//  10. engine.tick, after everything else the tick wrote.
//
// Steps 1 to 3 are safety prerequisites: one that overruns tick_step_budget
// or fails for a project makes that project's dispatch ineligible for this
// tick, also if it completes later; a tick that has used up tick_budget
// dispatches nothing further. Budgets are measured on the monotonic clock: a
// wall clock that steps back cannot stretch them (E30).

import { performance } from 'node:perf_hooks';

import { observeIntegrity } from '../git/integrity.js';
import { Launcher } from '../invoke/choke.js';
import type { Journal } from '../journal/driver.js';
import type { ProjectCandidates } from '../store/reads.js';
import { expireRecords } from '../records/retention.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { seamStepDelay } from '../testing/seam.js';

const PREREQUISITES = ['recover', 'journal', 'integrity'] as const;

// Whether `work` settled successfully within `ms`.
async function withinBudget(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = work.then(
    () => true,
    (err) => {
      log('tick step', err);
      return false;
    },
  );
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Scheduler {
  private flag = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly rt: Runtime,
    private readonly launcher: Launcher,
    private readonly ender: RunEnder,
    private readonly journal: Journal,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.request(), this.rt.setting('tick_interval') * 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  request(): void {
    this.flag = true;
    if (!this.running && !this.stopped) void this.loop();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.flag && !this.stopped) {
        this.flag = false;
        await this.tick().catch((err) => log('tick', err));
      }
    } finally {
      this.running = false;
    }
  }

  private async step(name: (typeof PREREQUISITES)[number], project: string): Promise<void> {
    await seamStepDelay(name, project);
    if (name === 'recover') {
      this.ender.retryDue(project);
      await this.ender.observeQuarantines(project);
      await this.ender.reconcileExpired(project);
    } else if (name === 'journal') {
      await reconcileProject(this.rt, this.journal, project);
      await this.rt.services?.nominate(project);
      // A run whose end waited for one of these operations goes on now.
      this.ender.retryDue(project);
    } else {
      await observeIntegrity(this.rt, project);
    }
  }

  private async tick(): Promise<void> {
    const started = performance.now();
    const tickBudget = this.rt.setting('tick_budget') * 1000;
    const stepBudget = this.rt.setting('tick_step_budget') * 1000;
    const remaining = () => tickBudget - (performance.now() - started);
    const projects = await this.rt.read<string[]>('scheduler.projects');
    const ineligible = new Set<string>();
    for (const name of PREREQUISITES) {
      for (const project of projects) {
        if (ineligible.has(project)) continue;
        const limit = Math.min(stepBudget, remaining());
        if (limit <= 0 || !(await withinBudget(this.step(name, project), limit))) ineligible.add(project);
      }
    }
    let dispatched = 0;
    if (remaining() > 0) {
      const candidates = await this.rt.read<ProjectCandidates[]>('scheduler.candidates', { maxConcurrentRuns: this.rt.setting('max_concurrent_runs') });
      for (const c of candidates) {
        if (ineligible.has(c.project) || c.items.length === 0) continue;
        if (remaining() <= 0) break;
        for (const item of c.items) {
          try {
            if (item.boundary) {
              // D1-34: the next step is a decision, asked once.
              await this.rt.engine('scheduler.chain_boundary', { workItem: item.id });
              continue;
            }
            if (await this.launcher.dispatch(c, item)) dispatched++;
          } catch (err) {
            log('dispatch', err);
          }
          break;
        }
      }
    }
    // Records nothing live refers to expire once their retention has passed
    // (D1 §14.3). Not a prerequisite of dispatch.
    await expireRecords(this.rt).catch((err) => log('record expiry', err));
    await this.rt.engine('engine.tick', { incarnation: this.rt.incarnation, dispatched });
  }
}

// Every unfinished operation of a project (or of every project), oldest
// first, taken on its way. One that this engine is driving is waited for;
// one this engine has just intended and not yet begun is its caller's.
//
// A finalizer may intend the next operation of a chain (a bootstrap's or a
// policy change's ref update after its commit): the list is read again until
// it holds nothing this pass has not taken on.
export async function reconcileProject(rt: Runtime, journal: Journal, project?: string): Promise<void> {
  const seen = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const ops = (await rt.read<{ id: string; project: string }[]>('journal.unfinished', { project: project ?? null })).filter((op) => !seen.has(op.id) && !journal.isFresh(op.id));
    if (ops.length === 0) return;
    for (const op of ops) {
      seen.add(op.id);
      await journal.withProject(op.project, () => journal.drive(op.id)).catch((err) => log('journal', err, { operation: op.id }));
    }
  }
}
