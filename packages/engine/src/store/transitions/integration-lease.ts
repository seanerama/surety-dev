// The integration lease (D1 §7.5, A.3 `leases` kind `integration`; D6 §6.4,
// K2; the driver's ruling 7, slice 37): with several runs of a project at
// once, their integrations serialize under one durable lease per project,
// taken for the run whose integration step holds it and released when the
// step ends. The engine's own queue (runs/accept.ts) admits one holder at a
// time within an incarnation, and the engine lock one incarnation per home:
// so an unreleased lease found here is a holder that is gone (a step that
// failed before its release, or an earlier incarnation), and is taken over
// at the next generation. The compare-and-swap of the integration branch
// still guards the branch itself.

import { notFound } from './common.js';
import { engineSettings } from './settings.js';
import type { Tx } from './tx.js';

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

export function acquireIntegrationLease(tx: Tx, args: { project: string; run: string; incarnation: string }): string {
  if (!tx.db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  const held = tx.db
    .prepare(`SELECT "id", "generation" FROM "leases" WHERE "resource_kind" = 'integration' AND "resource_id" = ? AND "released_at" IS NULL`)
    .get(args.project) as { id: string; generation: number } | undefined;
  if (held) tx.db.prepare('UPDATE "leases" SET "released_at" = ? WHERE "id" = ?').run(tx.at, held.id);
  const last = tx.db.prepare(`SELECT MAX("generation") AS g FROM "leases" WHERE "resource_kind" = 'integration' AND "resource_id" = ?`).get(args.project) as { g: number | null };
  const id = tx.newId('lease_');
  tx.db
    .prepare(
      `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "closing", "cleanup_authority")
       VALUES (?, ?, 'integration', ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(id, tx.at, args.project, args.incarnation, (last.g ?? 0) + 1, tx.at, tx.at, addSeconds(tx.at, engineSettings().lease_ttl));
  return id;
}

export function releaseIntegrationLease(tx: Tx, args: { lease: string }): void {
  tx.db.prepare(`UPDATE "leases" SET "released_at" = ? WHERE "id" = ? AND "resource_kind" = 'integration' AND "released_at" IS NULL`).run(tx.at, args.lease);
}
