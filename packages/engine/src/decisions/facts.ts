// What an answer is checked against afresh (D1 §10.5; SEAM.md §79): the
// stored observation says what was found when the engine looked; before an
// answer about it is consumed the actual ref, or the actual HEAD, index and
// tracked files of the checkout, are read again.

import { repoContext } from '../git/exec.js';
import { checkoutContext } from '../git/integrity.js';
import { checkoutBaseline, readRef } from '../git/repo.js';
import { ensureAncestry } from '../gates/prepare.js';
import type { Runtime } from '../runtime.js';
import type { Facts } from '../store/transitions/queue.js';

export async function answerFacts(rt: Runtime, project: string | null, decision: string): Promise<Facts> {
  // An engine-scoped decision reads nothing afresh (SEAM.md §117).
  if (project === null) return {};
  // The acceptance content of a candidate is part of some previews.
  await ensureAncestry(rt, project).catch(() => undefined);
  const subject = await rt.read<{ kind: string; oob: { subject_kind: string; repo: string; ref: string | null; checkout: string | null } | null; run?: string | null } | null>('decision.subject', { project, decision });
  // A Stop's or an Abandon's run whose backend has exited on its own (Q13).
  if (subject && typeof subject.run === 'string') return rt.exitedFirst(subject.run) ? { exited: true } : {};
  if (!subject?.oob) return {};
  const { oob } = subject;
  if (oob.subject_kind === 'ref' && oob.ref) {
    const read = await readRef(repoContext(oob.repo), oob.ref);
    return { found: read.state === 'ok' ? read.oid : read.state === 'missing' ? null : 'unreadable' };
  }
  if (oob.subject_kind === 'checkout' && oob.checkout) {
    const ctx = await checkoutContext(oob.repo, oob.checkout);
    const now = ctx === null ? null : await checkoutBaseline(ctx, rt.scratch);
    return { found: now === null ? 'unreadable' : JSON.stringify(now) };
  }
  return {};
}
