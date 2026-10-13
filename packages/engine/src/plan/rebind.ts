// A proposed bundle under a moving head (B03; the review's gap), on the
// main thread at every tick: the bundles a moved head (or a lost question)
// leaves without a current decision are re-bound. What changed between the
// bundle's head and the current one is read from git: a change to a bound
// input (the specification's files, the Architect's paths, a proposed path)
// makes the bundle stale; any other (a policy commit, a protected
// application, a stage's code) re-raises its pending approvals on the new
// head as the next generation. An unread diff is a change.

import { gitOk, repoContext } from '../git/exec.js';
import { type Runtime, log } from '../runtime.js';
import { type RebindDue, touchesBundle } from './bundle.js';

export async function rebindBundles(rt: Runtime, project: string): Promise<void> {
  const due = await rt.read<RebindDue[]>('plan.rebind_due', { project });
  for (const d of due) {
    let touched: string[] | null = [];
    let deleted: string[] = [];
    if (d.from !== d.to) {
      // Each changed path with its status (`D` for a deletion): a deleted
      // ADR the plan cites is named as such (M425 (e)).
      const out = await gitOk(repoContext(d.repo), ['diff', '--name-status', '-z', '--no-renames', d.from, d.to]).catch(() => null);
      if (out === null) touched = null;
      else {
        const parts = out.split('\0').filter((x) => x.length > 0);
        const changed: string[] = [];
        for (let i = 0; i + 1 < parts.length; i += 2) {
          changed.push(parts[i + 1]!);
          if (parts[i] === 'D') deleted.push(parts[i + 1]!);
        }
        touched = touchesBundle(changed, d.paths);
        deleted = touchesBundle(deleted, d.paths);
      }
    }
    await rt.engine('plan.rebind', { bundle: d.bundle, from: d.from, to: d.to, touched, deleted }).catch((err) => log('bundle rebind', err, { project, bundle: d.bundle }));
  }
}
