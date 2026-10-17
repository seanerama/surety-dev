// What the owner's answer route does after the answer's transaction (D1
// §10.5), for the answers whose consequence the reply follows:
//
// - a bundle whose authority the answer completed is published by the
//   authorized finalizer (plan/publish.ts, between `plan.before_publication`
//   and `plan.after_publication`; D6 §5.5; M448 (e)) before the reply;
// - a `spec_approval` answered `approve` is replied to once its effect, the
//   change log row's commit and the approval (spec/approval-effect.ts), has
//   run (SEAM.md §399). An effect that cannot run now is carried by the
//   tick, as any intent is.

import type { Runtime } from '../runtime.js';
import { publishAuthorized } from '../plan/publish.js';
import { pausePoint } from '../testing/seam.js';

// The design batches an answer's continuation is releasing now.
const releasing = new Set<string>();

export interface AnswerWaits {
  project: string;
  decisions: string[];
}

export async function beforeAnswer(_rt: Runtime, project: string, answers: { decision: unknown; option: unknown }[]): Promise<AnswerWaits> {
  return { project, decisions: answers.map((a) => a.decision).filter((d): d is string => typeof d === 'string') };
}

export async function afterAnswer(rt: Runtime, waits: AnswerWaits | undefined): Promise<void> {
  if (!waits) return;
  // A read that fails is an error, never "no intent" (the review's N3 (c)).
  const intents = await rt.read<string[]>('decision.intents', { decisions: waits.decisions, kind: 'spec_approval_application' });
  for (const intent of intents) await rt.services?.effect(intent);
  // A design batch whose two answers are both consumed approve (D7 §7.4;
  // SEAM.md §486): the barrier `design.approved` after the answers and
  // before any effect; then the batch released and its change applied.
  await releaseBatches(rt, await rt.read<{ revision: string; request: string; intents: string[] }[]>('design.answered_batches', { decisions: waits.decisions }));
  await publishAuthorized(rt, waits.project);
}

// The design batches of a project whose answers are consumed and which no
// continuation released (an answer's continuation cut short by a stop): at
// the design's tick, through the same barrier.
export async function releaseAnsweredBatches(rt: Runtime, project: string): Promise<void> {
  await releaseBatches(rt, await rt.read<{ revision: string; request: string; intents: string[] }[]>('design.answered_batches', { project }));
}

async function releaseBatches(rt: Runtime, batches: { revision: string; request: string; intents: string[] }[]): Promise<void> {
  for (const b of batches) {
    // One answer's continuation takes a batch: the other answer's, racing it,
    // does not release it past the barrier.
    if (releasing.has(b.revision)) continue;
    releasing.add(b.revision);
    try {
      await pausePoint('design.approved');
      await rt.engine('design.release_batch', { revision: b.revision });
      for (const intent of b.intents) await rt.services?.effect(intent);
    } finally {
      releasing.delete(b.revision);
    }
  }
}
