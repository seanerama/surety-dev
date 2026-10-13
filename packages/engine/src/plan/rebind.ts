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
    if (d.from !== d.to) {
      const out = await gitOk(repoContext(d.repo), ['diff', '--name-only', '-z', '--no-renames', d.from, d.to]).catch(() => null);
      touched = out === null ? null : touchesBundle(out.split('\0').filter((x) => x.length > 0), d.paths);
    }
    await rt.engine('plan.rebind', { bundle: d.bundle, from: d.from, to: d.to, touched }).catch((err) => log('bundle rebind', err, { project, bundle: d.bundle }));
  }
}
