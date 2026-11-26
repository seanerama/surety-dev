// The audit record of a mutating API request (D1 §11.1, SEAM.md §6). The
// payload names the request, never its token.

import { type Tx, delegationOf } from './tx.js';

export interface AuditInput {
  method: string;
  path: string;
  status: number;
}

export class AuditFailed extends Error {
  constructor(cause: unknown) {
    super(`audit write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function recordApiAct(tx: Tx, input: AuditInput): void {
  try {
    // D7 (DECISIONS item 57): who performed an owner's request, the owner
    // or an agent on the owner's instruction, as the request stated it.
    tx.emit('api.act', {}, { method: input.method, path: input.path, status: input.status, ...(tx.actor.actor_kind === 'human' ? { delegation: delegationOf(tx.actor) } : {}) });
  } catch (err) {
    throw new AuditFailed(err);
  }
}
