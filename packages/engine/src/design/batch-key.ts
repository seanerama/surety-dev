// The batch a design decision belongs to (D7 §7.4; D1 §10.3): a design
// revision's `design_approval` and its change request's `spec_change` share
// the revision's batch_key in every generation either is raised in.

import type Database from 'better-sqlite3';

export function designBatchKeyOf(db: Database.Database, kind: string, subject: string): string | null {
  if (kind === 'design_approval') return (db.prepare('SELECT "batch_key" FROM "design_revisions" WHERE "id" = ?').get(subject) as { batch_key: string | null } | undefined)?.batch_key ?? null;
  if (kind === 'spec_change') {
    return (
      (db.prepare(`SELECT d."batch_key" FROM "design_revisions" d JOIN "spec_change_requests" r ON r."id" = d."spec_change_request" WHERE r."id" = ? AND r."source" = 'design' ORDER BY d.rowid DESC LIMIT 1`).get(subject) as
        | { batch_key: string | null }
        | undefined)?.batch_key ?? null
    );
  }
  return null;
}
