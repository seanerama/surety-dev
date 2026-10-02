// Startup recovery (D1 §16.1; build spec §6 corrections 12, 13, 14, 16;
// SEAM.md §§16, 45, 46), the `recovery` step, in restricted mode and before
// anything is dispatched.
//
//   1. The journal: every operation that is not finalized is visited, the
//      confirmed ones included, which run only their finalizer. Each other
//      one is probed, after the git children of the incarnation that died
//      are accounted for (journal/driver.ts), and taken the way its probe
//      outcome leads: finalize, retry, complete, withdraw or block. A blocked
//      operation does not keep the engine restricted.
//   2. Every run that has not ended goes through the run-end protocol: an
//      outcome already recorded is kept, a run with none gets `recovered`,
//      and its run.ended event records this incarnation's recovery. The
//      run's end sees what the journal's recovery made of its operations.
//      A run whose end cannot complete yet (its workspace's removal is
//      blocked) stays finalizing and is retried by the engine.
//   3. Every quarantined run is observed again, and cleared if the boundary
//      now reports its domains terminated.

import type { Journal } from '../journal/driver.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { reconcileProject } from '../scheduler/tick.js';
import type { RunRow } from '../store/transitions/runs.js';

export async function recoverAtStartup(rt: Runtime, ender: RunEnder, journal: Journal): Promise<{ runs: number }> {
  await reconcileProject(rt, journal);

  const runs = await rt.engine<RunRow[]>('run.unended');
  const recovery = { recovery: rt.incarnation };
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.state === 'finalizing' && run.quarantined === 1) await ender.clearQuarantine(run.id, { ...recovery, signal: true });
        else await ender.endRun(run.id, { outcome: run.outcome ?? 'recovered', reason: run.reason_class ?? 'recovered' }, recovery);
      } catch (err) {
        // The engine retries the run's end; recovery does not stop for it.
        log('recovery', err, { run: run.id });
      }
    }),
  );
  return { runs: runs.length };
}
