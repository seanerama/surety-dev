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
//   2. Journal and effects: no git operation outlives the call that made it
//      in this revision, so there is nothing to probe between ticks yet; the
//      journal's recovery runs at startup.
//   (3. integrity and 4. budgets arrive with the slices that build them.)
//   8. Select, and 9. dispatch: at most one run per project and
//      max_concurrent_runs engine-wide; the tick waits for what a dispatch
//      writes before its spawn, never for the spawn or the run.
//  10. engine.tick, after everything else the tick wrote.
//
// Steps 1 and 2 are safety prerequisites: one that overruns tick_step_budget
// for a project makes that project's dispatch ineligible for this tick, also
// if it completes later; a tick that has used up tick_budget dispatches
// nothing further.

import { Launcher } from '../invoke/choke.js';
import type { ProjectCandidates } from '../store/reads.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { seamStepDelay } from '../testing/seam.js';

const PREREQUISITES = ['recover', 'journal'] as const;

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
    }
  }

  private async tick(): Promise<void> {
    const started = Date.now();
    const tickBudget = this.rt.setting('tick_budget') * 1000;
    const stepBudget = this.rt.setting('tick_step_budget') * 1000;
    const remaining = () => tickBudget - (Date.now() - started);
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
        try {
          if (await this.launcher.dispatch(c, c.items[0]!)) dispatched++;
        } catch (err) {
          log('dispatch', err);
        }
      }
    }
    await this.rt.engine('engine.tick', { incarnation: this.rt.incarnation, dispatched });
  }
}
