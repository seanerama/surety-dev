// The authorized finalizer on the main thread (D6 §5.5; B02; SEAM.md §401):
// each bundle of the project whose authority is complete (the pair's
// approvals, or `plan_approval` alone for a routed replan) is published in
// a transaction of its own, after the answer's: once, its baseline compared
// again. Called after an answer that may complete an authority, and at every
// tick (so that a publication interrupted by a restart happens once at the
// next one). One at a time per project.
//
// - `plan.before_publication`: the authority has been read, the
//   publication's transaction not begun;
// - `plan.after_publication`: that transaction committed, nothing after it.

import type { Runtime } from '../runtime.js';
import { log } from '../runtime.js';
import { pausePoint } from '../testing/seam.js';

const running = new Map<string, Promise<number>>();

export function publishAuthorized(rt: Runtime, project: string): Promise<number> {
  const existing = running.get(project);
  if (existing) return existing;
  const p = publishAll(rt, project).finally(() => running.delete(project));
  running.set(project, p);
  return p;
}

async function publishAll(rt: Runtime, project: string): Promise<number> {
  const due = await rt.read<string[]>('plan.authorized', { project });
  let n = 0;
  for (const bundle of due) {
    await pausePoint('plan.before_publication');
    const made = await rt.engine<{ published: boolean; plan: string | null; stale: string | null }>('plan.publish', { bundle }).catch((err) => {
      log('publication', err, { project, bundle });
      return null;
    });
    if (made?.published) {
      n++;
      await pausePoint('plan.after_publication');
    }
  }
  return n;
}
