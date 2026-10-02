// Notification intents, the store's side (D1 §§3.5, 10.4; SEAM.md §82). An
// escalation records the intent (queue.ts); its delivery is an attempt the
// main thread makes, and every step of it is recorded: `sending` while an
// attempt is in flight, then `delivered`, `failed` or `unknown`. An attempt
// whose outcome the engine does not hold is reconciled with the channel,
// never repeated blindly.

import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface NotificationRow {
  id: string;
  project: string;
  source: string;
  channel: string;
  key: string;
  status: 'queued' | 'sending' | 'delivered' | 'failed' | 'unknown';
  attempts: number;
}

// Intents a tick takes on: queued ones, and ones left sending.
export function notificationsDue(db: Db, args: { project: string }): (NotificationRow & { decision: string })[] {
  return (db.prepare(`SELECT * FROM "notification_intents" WHERE "project" = ? AND "status" IN ('queued', 'sending') ORDER BY "created_at"`).all(args.project) as NotificationRow[]).map((n) => ({
    ...n,
    decision: (JSON.parse(n.source) as { decision: string }).decision,
  }));
}

// An attempt begins: durable before the channel is called.
export function notificationSending(tx: Tx, args: { id: string }): boolean {
  const n = tx.db.prepare('SELECT * FROM "notification_intents" WHERE "id" = ?').get(args.id) as NotificationRow | undefined;
  if (!n || (n.status !== 'queued' && n.status !== 'sending')) return false;
  tx.db.prepare(`UPDATE "notification_intents" SET "status" = 'sending', "attempts" = "attempts" + 1 WHERE "id" = ?`).run(n.id);
  tx.emit('notification.sending', { project: n.project, notification: n.id }, { attempt: n.attempts + 1, channel: n.channel });
  return true;
}

export function notificationOutcome(tx: Tx, args: { id: string; status: 'delivered' | 'failed' | 'unknown'; how: string }): void {
  const n = tx.db.prepare('SELECT * FROM "notification_intents" WHERE "id" = ?').get(args.id) as NotificationRow | undefined;
  if (!n || n.status !== 'sending') return;
  tx.db.prepare('UPDATE "notification_intents" SET "status" = ? WHERE "id" = ?').run(args.status, n.id);
  tx.emit(`notification.${args.status}` as const, { project: n.project, notification: n.id }, { how: args.how, attempts: n.attempts });
}
