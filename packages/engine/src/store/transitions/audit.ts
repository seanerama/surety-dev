// The audit record of a mutating API request (D1 §11.1, SEAM.md §6). The
// payload names the request, never its token.

import type { Tx } from './tx.js';

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
    tx.emit('api.act', {}, { method: input.method, path: input.path, status: input.status });
  } catch (err) {
    throw new AuditFailed(err);
  }
}
