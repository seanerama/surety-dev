// The delivery of notification intents (D1 §10.4; SEAM.md §82). Delivery is
// an attempt that is reconciled, never repeated blindly: an attempt whose
// outcome the engine does not hold (it died, or the channel could not say)
// is looked up before anything else; found, the intent is delivered;
// positively absent, one new attempt is made; the channel cannot say, the
// intent is unknown and stays so. The engine never claims exactly-once
// delivery.

import { type Runtime, log } from '../runtime.js';
import type { NotificationRow } from '../store/transitions/notify.js';
import { pausePoint, seamNotify, seamNotifyChannel } from '../testing/seam.js';

const inFlight = new Set<string>();

export async function deliverNotifications(rt: Runtime, project: string): Promise<void> {
  if (seamNotifyChannel() === null) return;
  const due = await rt.read<(NotificationRow & { decision: string })[]>('notify.due', { project });
  for (const n of due) {
    if (inFlight.has(n.id)) continue;
    inFlight.add(n.id);
    try {
      await deliver(rt, n);
    } catch (err) {
      log('notification', err, { notification: n.id });
    } finally {
      inFlight.delete(n.id);
    }
  }
}

async function deliver(rt: Runtime, n: NotificationRow & { decision: string }): Promise<void> {
  const what = { key: n.key, decision: n.decision };
  const outcome = (status: 'delivered' | 'failed' | 'unknown', how: string) => rt.engine('notify.outcome', { id: n.id, status, how });
  // An attempt left in flight by an engine that died: its outcome is not
  // held, so the channel is asked first.
  if (n.status === 'sending') return reconcile(rt, n, what, outcome);
  if (!(await rt.engine<boolean>('notify.sending', { id: n.id }))) return;
  await pausePoint('notify.before_delivery');
  const code = await seamNotify('deliver', what);
  await pausePoint('notify.delivered');
  if (code === 0) return void (await outcome('delivered', 'confirmed'));
  if (code === 1) return void (await outcome('failed', 'refused'));
  return reconcile(rt, n, what, outcome);
}

async function reconcile(
  rt: Runtime,
  n: NotificationRow,
  what: { key: string; decision: string },
  outcome: (status: 'delivered' | 'failed' | 'unknown', how: string) => Promise<unknown>,
): Promise<void> {
  const found = await seamNotify('lookup', what);
  if (found === 0) return void (await outcome('delivered', 'found by lookup'));
  if (found !== 1) return void (await outcome('unknown', 'the channel cannot say'));
  // Positively absent: one new attempt.
  if (!(await rt.engine<boolean>('notify.sending', { id: n.id }))) return;
  await pausePoint('notify.before_delivery');
  const code = await seamNotify('deliver', what);
  await pausePoint('notify.delivered');
  if (code === 0) return void (await outcome('delivered', 'confirmed'));
  if (code === 1) return void (await outcome('failed', 'refused'));
  await outcome('unknown', 'the channel cannot say');
}
