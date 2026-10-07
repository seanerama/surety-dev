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
//   1a. The execution boundary (D2 §3.3): every domain not terminated is
//      closed; every prior incarnation's supervisor leaf is killed and
//      observed empty, or what could not be makes its domains `unknown`.
//   2. Every run that has not ended goes through the run-end protocol: an
//      outcome already recorded is kept, a run with none gets `recovered`,
//      and its run.ended event records this incarnation's recovery. The
//      run's end sees what the journal's recovery made of its operations.
//      A run whose end cannot complete yet (its workspace's removal is
//      blocked) stays finalizing and is retried by the engine.
//   3. Every quarantined run is observed again, and cleared if the boundary
//      now reports its domains terminated.
//   4. Records are audited (D1 §16.1 step 5): a published record that
//      something refers to and whose bytes are missing or not of its hash is
//      reported (`record.missing`) before full mode. It does not keep the
//      engine restricted.

import type { Journal } from '../journal/driver.js';
import { auditRecords } from '../records/retention.js';
import { type Runtime, log } from '../runtime.js';
import type { RunEnder } from '../runs/end.js';
import { reconcileProject } from '../scheduler/tick.js';
import { closePriorSupervisors, removeEndedAreas } from '../boundary/terminate.js';
import { recoverChecks } from '../checks/run.js';
import { removeStagingLeftovers } from '../checks/checktree.js';
import type { RunRow } from '../store/transitions/runs.js';

export async function recoverAtStartup(rt: Runtime, ender: RunEnder, journal: Journal): Promise<{ runs: number }> {
  await reconcileProject(rt, journal);

  // D2 §3.3: before any run is ended, every domain not terminated is closed,
  // so no launcher of a prior incarnation can be authorized; then the
  // supervisor leaf of every prior incarnation of this home is killed and
  // observed empty, or its scope's absence established. What cannot be
  // makes that incarnation's domains `unknown`.
  const open = await rt.read<{ id: string }[]>('boundary.unterminated');
  for (const d of open) await rt.engine('domain.close', { domain: d.id, cause: 'recovery' });
  const prior = await rt.read<{ incarnation: string; scope_cgroup: string }[]>('boundary.prior_scopes', { incarnation: rt.incarnation });
  if (prior.length > 0 || rt.scope !== null) ender.priorUnknown = await closePriorSupervisors(rt, prior);

  // Check executions a prior incarnation left (D3 §2.6): never recorded as
  // run or not run; their domains' closure established first.
  removeStagingLeftovers(rt.home);
  await recoverChecks(rt, ender.priorUnknown).catch((err) => log('recovery', err, { what: 'check executions' }));

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
  await auditRecords(rt);
  // The areas of domains terminated before this start (their context
  // packages and plan sources) are no longer anyone's.
  await removeEndedAreas(rt).catch((err) => log('recovery', err, { what: 'domain areas' }));
  return { runs: runs.length };
}
