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

// One publication loop per project. A caller that arrives while a pass runs
// asks for another, and is answered only after a pass that began after it:
// so the reply to an answer waits for a publication that includes the
// authority it completed (the review's M3).
interface Loop {
  again: boolean;
  done: Promise<number>;
}
const loops = new Map<string, Loop>();

export function publishAuthorized(rt: Runtime, project: string): Promise<number> {
  const existing = loops.get(project);
  if (existing) {
    existing.again = true;
    return existing.done;
  }
  const loop: Loop = { again: false, done: Promise.resolve(0) };
  loop.done = (async () => {
    let n = 0;
    try {
      do {
        loop.again = false;
        n += await publishAll(rt, project);
      } while (loop.again);
    } finally {
      // Synchronously after the last pass's check: no caller can join a
      // loop that will not run again.
      loops.delete(project);
    }
    return n;
  })();
  loops.set(project, loop);
  return loop.done;
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
      // The interface inventory, derived at publication (D7 §1 step 4a).
      await rt.design?.deriveIfDue(project).catch((err) => log('design inventory', err, { project }));
    }
  }
  return n;
}
