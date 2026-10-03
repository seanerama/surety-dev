// What an answer is checked against afresh (D1 §10.5; SEAM.md §79): the
// stored observation says what was found when the engine looked; before an
// answer about it is consumed the actual ref, or the actual HEAD, index and
// tracked files of the checkout, are read again.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { repoContext } from '../git/exec.js';
import { recordsDir } from '../records/files.js';
import { checkoutContext } from '../git/integrity.js';
import { checkoutBaseline, readRef } from '../git/repo.js';
import { ensureAncestry } from '../gates/prepare.js';
import type { Runtime } from '../runtime.js';
import type { Facts } from '../store/transitions/queue.js';

export async function answerFacts(rt: Runtime, project: string, decision: string): Promise<Facts> {
  // The acceptance content of a candidate is part of some previews.
  await ensureAncestry(rt, project).catch(() => undefined);
  // A record a manifest binds by content is read again: its bytes now, not
  // the hash recorded when it was published (a trust entry's evidence).
  const bound = await rt.read<{ id: string; path: string | null }[]>('decision.records', { project, decision });
  if (bound.length > 0) {
    const records: Record<string, string | null> = {};
    for (const r of bound) {
      try {
        records[r.id] = r.path === null ? null : createHash('sha256').update(await readFile(join(recordsDir(rt.home), r.path))).digest('hex');
      } catch {
        records[r.id] = null;
      }
    }
    return { records };
  }
  const subject = await rt.read<{ kind: string; oob: { subject_kind: string; repo: string; ref: string | null; checkout: string | null } | null } | null>('decision.subject', { project, decision });
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
