// Acts the engine performs under an authority the owner gave beforehand
// (DECISIONS item 57, the owner's rulings D1, D2, D3, D4, D7 and D8 of
// 2026-11-26; migration 0053): "Record who authorized the action, who
// performed it, and the scope of the delegation." One row per act in
// `delegated_actions`: what it was (`kind`), what it was about (`subject`),
// what authorized it (the approved brief's decision, the preparation
// allowance's policy revision), who performed it (`policy:<name>`, or the
// engine), the bounds it was within (`scope`) and what the engine computed
// to establish them (`basis`). Records written before migration 0053 stay as
// they were written; nothing here infers them.

import { canonical } from './common.js';
import type { Tx } from './tx.js';

export type DelegatedKind = 'plan_published' | 'tightening_applied' | 'fix_registered' | 'deployment_requested' | 'preparation_by_allowance' | 'deployment_target_approved';
export type AuthorizedByKind = 'decision' | 'allowance' | 'policy_revision';

export interface DelegatedAction {
  project: string;
  iteration: string | null;
  kind: DelegatedKind;
  subject_type: string;
  subject_id: string;
  authorized_by_kind: AuthorizedByKind;
  authorized_by: string | null;
  performed_by: string;
  scope: Record<string, unknown>;
  basis: Record<string, unknown>;
}

// The act recorded, once per (kind, subject): an act replayed (a finalizer
// run again, a tick after a restart) records nothing twice. Returns the row's
// id.
export function recordDelegatedAction(tx: Tx, a: DelegatedAction): string {
  const existing = tx.db.prepare('SELECT "id" FROM "delegated_actions" WHERE "kind" = ? AND "subject_type" = ? AND "subject_id" = ?').get(a.kind, a.subject_type, a.subject_id) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = tx.newId('dact_');
  tx.db
    .prepare(
      `INSERT INTO "delegated_actions" ("id", "created_at", "project", "iteration", "kind", "subject_type", "subject_id", "authorized_by_kind", "authorized_by", "performed_by", "scope", "basis", "seq")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, a.project, a.iteration, a.kind, a.subject_type, a.subject_id, a.authorized_by_kind, a.authorized_by, a.performed_by, canonical(a.scope), canonical(a.basis), tx.storeOrder());
  return id;
}

export interface DelegatedActionRow {
  id: string;
  created_at: string;
  project: string;
  iteration: string | null;
  kind: DelegatedKind;
  subject_type: string;
  subject_id: string;
  authorized_by_kind: AuthorizedByKind;
  authorized_by: string | null;
  performed_by: string;
  scope: string;
  basis: string;
  seq: number | null;
}

// An iteration's delegated acts, in the order they were recorded, as served
// (scope and basis parsed).
export function delegatedActionsOf(db: Tx['db'], project: string, iteration: string): Record<string, unknown>[] {
  const rows = db.prepare('SELECT * FROM "delegated_actions" WHERE "project" = ? AND "iteration" = ? ORDER BY rowid').all(project, iteration) as DelegatedActionRow[];
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  };
  return rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    kind: r.kind,
    subject: { type: r.subject_type, id: r.subject_id },
    authorized_by: { kind: r.authorized_by_kind, id: r.authorized_by },
    performed_by: r.performed_by,
    scope: parse(r.scope),
    basis: parse(r.basis),
  }));
}
