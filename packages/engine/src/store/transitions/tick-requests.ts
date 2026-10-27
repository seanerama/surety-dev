// The requested tick (D6 K1; N02; D1 §1.5; SEAM.md §430): a transition that
// ends a run, finalizes an operation, records a check result, answers a
// decision or makes work eligible requests the next tick. The request is
// recorded in the requesting transaction (`scheduler.tick_requested`, one
// per requesting event, with its cause and subject), and the number of
// requests committed reaches the main thread with the store's reply, where
// it sets D1 §1.5's flag: requests coalesce and never re-enter a running
// tick (scheduler/tick.ts).

import type { Tx } from './tx.js';

type Cause = 'run_ended' | 'operation_finalized' | 'result_recorded' | 'decision_answered' | 'work_eligible' | 'assistant_turn_admitted';

// What a requesting event names: its cause and the subject the request
// carries; null for an event that requests nothing.
function requestOf(type: string, subject: Record<string, unknown>, payload: Record<string, unknown>): { cause: Cause; subject: Record<string, unknown> } | null {
  const project = subject.project ?? null;
  switch (type) {
    case 'run.ended':
      return { cause: 'run_ended', subject: { project, run: subject.run ?? null } };
    case 'operation.finalized':
      return { cause: 'operation_finalized', subject: { project, operation: subject.operation ?? null } };
    case 'check.result':
      return { cause: 'result_recorded', subject: { project, check_result: subject.check_result ?? null } };
    case 'decision.answered':
      return { cause: 'decision_answered', subject: { project, decision: subject.decision ?? null } };
    // A workspace assistant turn is dispatched from the tick (the assistant
    // design §4): its admission asks for one.
    case 'assistant.turn_admitted':
      return { cause: 'assistant_turn_admitted', subject: { account: subject.account ?? null, invocation: subject.invocation ?? null } };
    case 'work.created':
    case 'work.resumed':
    case 'work.advanced':
      return payload.to === 'eligible' ? { cause: 'work_eligible', subject: { project, work_item: subject.work_item ?? null } } : null;
    default:
      return null;
  }
}

// Called by `transact` once its transition has run, inside the same
// transaction: one `scheduler.tick_requested` per requesting event. Returns
// how many it recorded.
export function recordTickRequests(tx: Tx): number {
  const refs = [...tx.events];
  let n = 0;
  for (const ref of refs) {
    if (ref.type === 'scheduler.tick_requested') continue;
    const row = tx.db.prepare('SELECT "subject", "payload" FROM "events" WHERE "id" = ?').get(ref.id) as { subject: string; payload: string | null } | undefined;
    if (!row) continue;
    const req = requestOf(ref.type, JSON.parse(row.subject) as Record<string, unknown>, JSON.parse(row.payload ?? '{}') as Record<string, unknown>);
    if (req === null) continue;
    tx.emit('scheduler.tick_requested', req.subject, { cause: req.cause, event: ref.seq });
    n++;
  }
  return n;
}

// The route's own request (POST /v1/projects/:p/tick): cause `api`.
export function recordApiTickRequest(tx: Tx, project: string): void {
  tx.emit('scheduler.tick_requested', { project }, { cause: 'api' });
}

// Requests committed since the main thread last heard (the worker's reply).
let committed = 0;
export function addCommittedTickRequests(n: number): void {
  committed += n;
}
export function takeCommittedTickRequests(): number {
  const n = committed;
  committed = 0;
  return n;
}
