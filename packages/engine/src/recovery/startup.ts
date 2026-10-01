// Startup recovery (D1 §16.1; build spec §6 corrections 12, 13; SEAM.md §16),
// the `recovery` step, in restricted mode and before anything is dispatched.
//
//   1. Journal: every worktree operation not finalized or failed is probed and
//      settled; a removal still present is retried once (D1 §7.10).
//   2. Every run that has not ended goes through the run-end protocol: an
//      outcome already recorded is kept, a run with none gets `recovered`,
//      and its run.ended event records this incarnation's recovery. Domains
//      are terminated (their processes found by recorded identity and by
//      marker), or the run is left quarantined if the boundary does not
//      report them terminated.
//   3. Every quarantined run is observed again, and cleared if the boundary
//      now reports its domains terminated.

import { repoContext } from '../git/exec.js';
import { probeWorktree, removeWorktree } from '../git/worktree.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import type { RunRow } from '../store/transitions/runs.js';

interface PendingOperation {
  operation: string;
  kind: 'worktree_add' | 'worktree_remove';
  payload: { repo: string; path: string; base?: string };
}

export async function recoverAtStartup(rt: Runtime, ender: RunEnder): Promise<{ journal: number; runs: number }> {
  const pending = await rt.engine<PendingOperation[]>('worktree.pending');
  for (const op of pending) {
    const ctx = repoContext(op.payload.repo);
    let probe = await probeWorktree(ctx, op.payload.path, op.kind === 'worktree_add' ? op.payload.base : undefined);
    if (op.kind === 'worktree_remove' && probe === 'present') probe = await removeWorktree(ctx, op.payload.path);
    await rt.engine('worktree.settle', { operation: op.operation, result: probe });
  }

  const runs = await rt.engine<RunRow[]>('run.unended');
  const recovery = { recovery: rt.incarnation };
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.state === 'finalizing' && run.quarantined === 1) await ender.clearQuarantine(run.id, { ...recovery, signal: true });
        else await ender.endRun(run.id, run.outcome ?? 'recovered', run.reason_class ?? 'recovered', recovery);
      } catch (err) {
        log('recovery', err);
        throw err;
      }
    }),
  );
  return { journal: pending.length, runs: runs.length };
}
