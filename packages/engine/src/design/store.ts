// The inventory's store transitions (D7 §4.4; SEAM.md §484): what is due to
// be derived, the finalizer of the engine's intent commit that holds it, and
// its record. The inventory, its fixtures and the placeholders are committed
// as one engine `intent` revision through the journal before any Designer
// session; `design.inventory_derived` is recorded once, after that commit
// (the barrier `design.inventory_committed` stands between the two), and a
// restart in between records it once. Keyed by the inventory's digest: ticks,
// replays and restarts derive nothing twice.

import { canonical, parseJson, sha256 } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import type { Database } from 'better-sqlite3';
import { type AssetManifest, placeholderManifest } from './assets.js';
import { reviewDesignDue } from './due.js';
import { type Inventory, deriveInventory, fixtureFiles, inventoryText } from './inventory.js';
import { approvedModuleMap, designPolicyOf, holdsBeforeBuild, inventoryInputs, isUiStage, publishedStages } from './policy.js';

export interface InventoryRow {
  id: string;
  project: string;
  inventory_digest: string;
  revision: string;
  inventory: string;
  manifest: string;
  incarnation: string | null;
  recorded_at: string | null;
}

export type InventoryDue =
  | { derive: { project: string; digest: string; inventory: Inventory; text: string; fixtures: Record<string, string>; placeholders: { manifest: AssetManifest; files: Record<string, string> } } }
  | { record: string }
  | null;

// What is due for a project's inventory now: a committed inventory to
// record (one an earlier incarnation committed, or this one's not in
// flight), a derivation whose digest has no inventory yet, or nothing.
export function inventoryDue(db: Database, args: { project: string; incarnation: string; inFlight: boolean }): InventoryDue {
  if (designPolicyOf(db, args.project) === 'off') return null;
  const unrecorded = db.prepare('SELECT "id", "incarnation" FROM "design_inventories" WHERE "project" = ? AND "recorded_at" IS NULL ORDER BY rowid LIMIT 1').get(args.project) as { id: string; incarnation: string | null } | undefined;
  if (unrecorded) return unrecorded.incarnation !== args.incarnation || !args.inFlight ? { record: unrecorded.id } : null;
  if (args.inFlight) return null;
  const inputs = inventoryInputs(db, args.project);
  if ('unknown' in inputs) return null;
  const inventory = deriveInventory(inputs);
  if (db.prepare('SELECT 1 FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(args.project, inventory.inventory_digest)) return null;
  const name = (db.prepare('SELECT "name" FROM "projects" WHERE "id" = ?').get(args.project) as { name: string }).name;
  const targets = [...new Set(inventory.targets.map((t) => t.target))];
  return { derive: { project: args.project, digest: inventory.inventory_digest, inventory, text: inventoryText(inventory), fixtures: fixtureFiles(inventory), placeholders: placeholderManifest(name, targets) } };
}

// The inventory a policy change that turns design on derives (D7 §2: a
// tightening for undispatched UI stages), committed with the policy's own
// commit so that the inventory is there when the revision is effective.
export function inventoryForPolicy(db: Database, args: { project: string; effective: Record<string, unknown> }): { digest: string; inventory: Inventory; text: string; fixtures: Record<string, string>; placeholders: { manifest: AssetManifest; files: Record<string, string> } } | null {
  const was = designPolicyOf(db, args.project);
  const next = args.effective.design;
  if (was !== 'off' || typeof next !== 'string' || next === 'off') return null;
  const inputs = inventoryInputs(db, args.project, { options: args.effective });
  if ('unknown' in inputs) return null;
  const inventory = deriveInventory(inputs);
  if (db.prepare('SELECT 1 FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(args.project, inventory.inventory_digest)) return null;
  const name = (db.prepare('SELECT "name" FROM "projects" WHERE "id" = ?').get(args.project) as { name: string }).name;
  return { digest: inventory.inventory_digest, inventory, text: inventoryText(inventory), fixtures: fixtureFiles(inventory), placeholders: placeholderManifest(name, [...new Set(inventory.targets.map((t) => t.target))]) };
}

// Design turned on mid-project (D7 §2): the undispatched UI stages' work
// waits on design_ready from now on (a tightening; no policy_widening).
export function designTurnedOn(tx: Tx, project: string): number {
  if (!holdsBeforeBuild(designPolicyOf(tx.db, project))) return 0;
  const map = approvedModuleMap(tx.db, project)?.map ?? null;
  let n = 0;
  for (const st of publishedStages(tx.db, project)) {
    if (!st.work_item || !isUiStage(tx.db, project, st, map)) continue;
    const item = tx.db.prepare('SELECT "id", "status", "depends_on" FROM "work_items" WHERE "id" = ?').get(st.work_item) as { id: string; status: string; depends_on: string | null } | undefined;
    if (!item || item.status !== 'eligible') continue;
    if (tx.db.prepare(`SELECT 1 FROM "runs" WHERE "work_item" = ? LIMIT 1`).get(item.id)) continue;
    const deps = parseJson<Record<string, unknown>[]>(item.depends_on) ?? [];
    if (deps.some((d) => d.milestone === 'design_ready')) continue;
    tx.db.prepare('UPDATE "work_items" SET "depends_on" = ? WHERE "id" = ?').run(JSON.stringify([...deps, { milestone: 'design_ready', stage: st.id }]), item.id);
    n++;
  }
  return n;
}

export interface InventoryRefInputs {
  purpose: 'design_inventory';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  project: string;
  inventory_digest: string;
  inventory: Inventory;
  manifest: AssetManifest;
  incarnation: string;
}

// The finalizer of the branch's move to the engine's commit: the inventory
// is on the integration branch; it is recorded by recordInventory.
export function finalizeInventoryRef(tx: Tx, op: { id: string; project: string }, inputs: InventoryRefInputs): Record<string, unknown> {
  const existing = tx.db.prepare('SELECT "id" FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(op.project, inputs.inventory_digest) as { id: string } | undefined;
  if (existing) return { design_inventory: existing.id };
  const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(op.project) as { id: string } | undefined;
  const arch = tx.db.prepare('SELECT "id" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(op.project) as { id: string } | undefined;
  const id = tx.newId('dinv_');
  tx.db
    .prepare(
      `INSERT INTO "design_inventories" ("id", "created_at", "project", "inventory_digest", "spec_revision", "architecture_revision", "revision", "inventory", "manifest", "incarnation", "recorded_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(id, tx.at, op.project, inputs.inventory_digest, spec?.id ?? null, arch?.id ?? null, inputs.new_oid, JSON.stringify(inputs.inventory), JSON.stringify(inputs.manifest), inputs.incarnation);
  return { design_inventory: id };
}

// The inventory recorded, once: the project's digest, the event, the
// effective set's placeholders where the project has none yet (§6.3, §6.4),
// and design_due (§1 step 4a).
export function recordInventory(tx: Tx, args: { id: string }): { recorded: boolean } {
  const row = tx.db.prepare('SELECT * FROM "design_inventories" WHERE "id" = ?').get(args.id) as InventoryRow | undefined;
  if (!row || row.recorded_at !== null) return { recorded: false };
  tx.db.prepare('UPDATE "design_inventories" SET "recorded_at" = ? WHERE "id" = ?').run(tx.at, row.id);
  tx.db.prepare('UPDATE "projects" SET "design_inventory_digest" = ? WHERE "id" = ?').run(row.inventory_digest, row.project);
  const inventory = parseJson<Inventory>(row.inventory)!;
  const manifest = parseJson<AssetManifest>(row.manifest);
  // Before any approval every default slot and variant is selected, so each
  // one the set lacks (a target added later, SEAM.md §506) gets its
  // placeholder; after one, the approved selection decides (approval.ts).
  // A slot's platforms follow the manifest's.
  const approvedDesign = tx.db.prepare(`SELECT 1 FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') LIMIT 1`).get(row.project) !== undefined;
  for (const slot of manifest?.slots ?? []) tx.db.prepare('UPDATE "design_effective_assets" SET "platforms" = ? WHERE "project" = ? AND "slot" = ?').run(JSON.stringify(slot.platforms), row.project, slot.key);
  if (manifest && !approvedDesign) {
    for (const slot of manifest.slots) {
      for (const v of slot.variants) {
        if (!v.file || !v.digest) continue;
        if (tx.db.prepare('SELECT 1 FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(row.project, slot.key, v.name)) continue;
        tx.db
          .prepare(
            `INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms", "since_design_revision")
             VALUES (?, ?, ?, ?, ?, ?, ?, 'placeholder', ?, ?, ?, ?, ?, NULL)`,
          )
          .run(tx.newId('deff_'), tx.at, row.project, slot.key, slot.kind, v.name, slot.slot_version, v.digest, v.format, row.revision, v.file, JSON.stringify(slot.platforms));
      }
    }
  }
  tx.emit('design.inventory_derived', { project: row.project, design_inventory: row.id }, {
    inventory_digest: row.inventory_digest,
    revision: row.revision,
    targets: inventory.targets.map((t) => ({ module: t.module, target: t.target, preview_capability: t.preview_capability })),
    ui_requirements: inventory.ui_requirements.map((r) => r.key),
    obligations: inventory.obligations.length,
  });
  reviewDesignDue(tx, row.project);
  return { recorded: true };
}

// The project's recorded inventory (the latest by insertion), or null.
export function currentInventory(db: Database, project: string): { row: InventoryRow; inventory: Inventory } | null {
  const row = db.prepare('SELECT * FROM "design_inventories" WHERE "project" = ? AND "recorded_at" IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(project) as InventoryRow | undefined;
  if (!row) return null;
  const inventory = parseJson<Inventory>(row.inventory);
  return inventory ? { row, inventory } : null;
}

export const blobsHash = (blobs: Record<string, string>): string => sha256(canonical(blobs));
