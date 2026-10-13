// What the owner's answer route does around the answer's transaction (D1
// §10.5) for the kinds whose effect the reply waits for, and the barriers
// around a bundle's publication (D6 §3.4, §5.5; M448 (e)):
//
// - `plan.before_publication`: an answer that will publish its bundle (the
//   last approval of the pair) has read the bundle's authority and not yet
//   begun the transaction that publishes it;
// - `plan.after_publication`: that transaction committed (the bundle
//   published, `plan.published` emitted), nothing after it begun;
// - a `spec_approval` answered `approve` is answered once its effect, the
//   change log row's commit and the approval (spec/approval-effect.ts), has
//   run, so that what the answer approved is what the reply follows. An
//   effect that cannot run now is carried by the tick, as any intent is.

import type { Runtime } from '../runtime.js';
import { pausePoint } from '../testing/seam.js';

export interface AnswerWaits {
  project: string;
  decisions: string[];
  publishes: string[];
}

export async function beforeAnswer(rt: Runtime, project: string, answers: { decision: unknown; option: unknown }[]): Promise<AnswerWaits> {
  const decisions = answers.map((a) => a.decision).filter((d): d is string => typeof d === 'string');
  const publishes: string[] = [];
  for (const a of answers) {
    if (typeof a.decision !== 'string') continue;
    const due = await rt.read<{ bundle: string } | null>('plan.publication_due', { project, decision: a.decision, option: a.option }).catch(() => null);
    if (due !== null) publishes.push(due.bundle);
  }
  if (publishes.length > 0) await pausePoint('plan.before_publication');
  return { project, decisions, publishes };
}

export async function afterAnswer(rt: Runtime, waits: AnswerWaits | undefined): Promise<void> {
  if (!waits) return;
  for (const bundle of waits.publishes) {
    if (await rt.read<boolean>('plan.bundle_published', { bundle }).catch(() => false)) {
      await pausePoint('plan.after_publication');
      break;
    }
  }
  const intents = await rt.read<string[]>('decision.intents', { decisions: waits.decisions, kind: 'spec_approval_application' }).catch(() => [] as string[]);
  for (const intent of intents) await rt.services?.effect(intent);
}
