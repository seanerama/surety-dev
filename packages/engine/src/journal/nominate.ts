// Nomination (D1 §§3.3, 7.7; E11; E18; SEAM.md §42). The integration
// finalizer records a nomination as due where the tier's cadence or the
// Builder's request says so; this journals it, once: the immutable ref
// refs/surety/cand/<seq>, written by a ref update whose finalizer writes the
// candidate. It runs after an integration and at every tick, so a nomination
// that a crash interrupted before it was journaled is made after the restart.

import { ensureAncestry, ensureNominationAncestry } from '../gates/prepare.js';
import { type Runtime, log } from '../runtime.js';
import type { IntentResult } from '../store/transitions/journal.js';
import type { Journal } from './driver.js';

export async function nominate(rt: Runtime, journal: Journal, project: string): Promise<void> {
  await journal.withProject(project, async () => {
    await ensureNominationAncestry(rt, project).catch((err) => log('ancestry', err, { project }));
    const intent = await journal.intend('nomination.intend', { project, deadlineSeconds: rt.setting('git_deadline') }, 'ref_update');
    if (!('operation' in (intent as IntentResult))) return;
    const settled = await journal.drive((intent as { operation: string }).operation);
    if (settled.end !== 'finalized') log('nomination', new Error(`the nomination of project ${project} is ${settled.end}`), { operation: settled.op.id });
  });
  // What the new candidate's scopes need from git, recorded now.
  await ensureAncestry(rt, project).catch((err) => log('ancestry', err, { project }));
}
