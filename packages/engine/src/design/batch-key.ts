// The batch a design decision belongs to (D7 §7.4; D1 §10.3): a design
// revision's `design_approval` and its change request's `spec_change` share
// the revision's batch_key in every generation either is raised in; a
// review's `design_verdicts` shares the key of the design it proposed (D7
// §10.3; SEAM.md §525), which is `design:<revision>` from its proposal on.

import type Database from 'better-sqlite3';

export function designBatchKeyOf(db: Database.Database, kind: string, subject: string): string | null {
  if (kind === 'design_approval') return (db.prepare('SELECT "batch_key" FROM "design_revisions" WHERE "id" = ?').get(subject) as { batch_key: string | null } | undefined)?.batch_key ?? null;
  if (kind === 'design_verdicts') {
    const r = db.prepare('SELECT "proposed_revision" FROM "design_reviews" WHERE "id" = ?').get(subject) as { proposed_revision: string | null } | undefined;
    if (!r?.proposed_revision) return null;
    const rev = db.prepare('SELECT "batch_key" FROM "design_revisions" WHERE "id" = ?').get(r.proposed_revision) as { batch_key: string | null } | undefined;
    return rev?.batch_key ?? `design:${r.proposed_revision}`;
  }
  if (kind === 'spec_change') {
    return (
      (db.prepare(`SELECT d."batch_key" FROM "design_revisions" d JOIN "spec_change_requests" r ON r."id" = d."spec_change_request" WHERE r."id" = ? AND r."source" = 'design' ORDER BY d.rowid DESC LIMIT 1`).get(subject) as
        | { batch_key: string | null }
        | undefined)?.batch_key ?? null
    );
  }
  return null;
}
