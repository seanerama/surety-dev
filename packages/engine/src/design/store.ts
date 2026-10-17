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
import { recordMetMilestones } from '../scheduler/milestones.js';
import { allScreensUnknown, inventoryDesignClass, staleScreens } from './stale.js';
import { type Inventory, deriveInventory, fixtureFiles, inventoryText } from './inventory.js';
import { approvedModuleMap, designPolicyOf, holdsBeforeBuild, inventoryInputs, isUiStage, publishedStages } from './policy.js';

// What an inventory's row records of the assets (the review's B2): the
// engine's deterministic placeholders for the derivation's targets and no
// one else's file, each slot's platforms the derivation's; `sources` where a
// placeholder's bytes are not at its path in the row's commit (an earlier
// derivation's commit, or another path); and what was done with the head's
// manifest (absent and written, merged, unchanged, or unknown: not read).
export interface PlaceholderRecord extends AssetManifest {
  sources?: Record<string, { revision: string; file: string }>;
  head_manifest?: 'absent' | 'merged' | 'unchanged' | { unknown: string };
}

// Where a placeholder's bytes are: its source, or its own file in the
// record's commit; null when the record does not hold that digest.
export function placeholderSource(record: PlaceholderRecord | null, revision: string, slot: string, variant: string, digest?: string): { revision: string; file: string } | null {
  const v = record?.slots.find((s) => s.key === slot)?.variants.find((x) => x.name === variant);
  if (!v || !v.file || !v.digest || (digest !== undefined && v.digest !== digest)) return null;
  const src = record?.sources?.[`${slot}/${variant}`];
  return src ? { revision: src.revision || revision, file: src.file } : { revision, file: v.file };
}

// The engine placeholder's digest of a slot and variant, or null.
export function placeholderDigest(record: PlaceholderRecord | null, slot: string, variant: string): string | null {
  return record?.slots.find((s) => s.key === slot)?.variants.find((x) => x.name === variant)?.digest ?? null;
}

// The default slots and variants an approved manifest could not have
// selected: each placeholder slot of the record whose kind the manifest has
// no slot of, and each placeholder variant its slot of that kind lacks.
export function laterDefaults(approved: AssetManifest | null, record: PlaceholderRecord | null): { slot: AssetManifest['slots'][number]; variant: string }[] {
  const out: { slot: AssetManifest['slots'][number]; variant: string }[] = [];
  for (const slot of record?.slots ?? []) {
    const has = approved?.slots.find((s) => s.key === slot.key) ?? approved?.slots.find((s) => s.kind === slot.kind);
    for (const v of slot.variants) if (!has || !has.variants.some((x) => x.name === v.name)) out.push({ slot, variant: v.name });
  }
  return out;
}

// Where a manifest slot stands against the effective set (§6.4; S2): its
// own files (every variant with a file that is not the engine placeholder's)
// each effective from an approval at the same digest is `approved`; a slot
// with no file of its own is `placeholder`; else `pending`.
export function slotStanding(db: Database, project: string, slot: AssetManifest['slots'][number]): 'approved' | 'placeholder' | 'pending' {
  const record = parseJson<PlaceholderRecord>(currentInventory(db, project)?.row.manifest ?? null);
  const own = slot.variants.filter((v) => typeof v.digest === 'string' && v.digest !== placeholderDigest(record, slot.key, v.name));
  if (own.length === 0) return 'placeholder';
  const rows = db.prepare(`SELECT "variant", "digest" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "source" = 'approved'`).all(project, slot.key) as { variant: string; digest: string }[];
  return own.every((v) => rows.some((e) => e.variant === v.name && e.digest === v.digest)) ? 'approved' : 'pending';
}

// The latest placeholder record (by insertion), recorded or not.
export function placeholderRecord(db: Database, project: string): { revision: string; manifest: PlaceholderRecord | null } | null {
  const row = db.prepare('SELECT "revision", "manifest" FROM "design_inventories" WHERE "project" = ? ORDER BY rowid DESC LIMIT 1').get(project) as { revision: string; manifest: string } | undefined;
  return row ? { revision: row.revision, manifest: parseJson<PlaceholderRecord>(row.manifest) } : null;
}

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
  // Nothing due while the project's inventory is this one. An inventory the
  // project had before and moved away from (a target added, then removed)
  // is committed again and made current again (D7 §9.1): its row is kept.
  const current = (db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(args.project) as { design_inventory_digest: string | null } | undefined)?.design_inventory_digest ?? null;
  if (current === inventory.inventory_digest) return null;
  if (current === null && db.prepare('SELECT 1 FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(args.project, inventory.inventory_digest)) return null;
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

// Design turned off, or to `at_alpha`, by a policy revision (D7 §2; SEAM.md
// §§514, 516): the stages held for design before the revision are released
// (their milestone is met once the policy no longer holds before build);
// under `off` each released stage records `design.waived`, the design's
// human tests staying pending. Idempotent: called once per revision.
export function designTurnedOff(tx: Tx, args: { project: string; held: string[]; policy_revision: string; decision: string | null }): number {
  if (args.held.length === 0 || holdsBeforeBuild(designPolicyOf(tx.db, args.project))) return 0;
  const off = designPolicyOf(tx.db, args.project) === 'off';
  if (off) {
    for (const stage of args.held) {
      tx.emit('design.waived', { project: args.project, stage }, { reason: 'design turned off by a policy revision', policy_revision: args.policy_revision, ...(args.decision ? { decision: args.decision } : {}) });
    }
  }
  recordMetMilestones(tx, args.project);
  return off ? args.held.length : 0;
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
  if (existing) {
    // Committed again (its inputs returned to it): the row names the commit
    // that now holds it and the placeholders recorded with it.
    tx.db.prepare('UPDATE "design_inventories" SET "revision" = ?, "manifest" = ? WHERE "id" = ?').run(inputs.new_oid, JSON.stringify(inputs.manifest), existing.id);
    return { design_inventory: existing.id };
  }
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
  if (!row) return { recorded: false };
  if (row.recorded_at !== null) return reselectInventory(tx, row);
  // The inventory the approved design was drawn against (else the one this
  // replaces), read before this one is recorded (D7 §9.1).
  const drawnAgainst = designInventoryBefore(tx.db, row.project);
  tx.db.prepare('UPDATE "design_inventories" SET "recorded_at" = ? WHERE "id" = ?').run(tx.at, row.id);
  tx.db.prepare('UPDATE "projects" SET "design_inventory_digest" = ? WHERE "id" = ?').run(row.inventory_digest, row.project);
  const inventory = parseJson<Inventory>(row.inventory)!;
  const record = parseJson<PlaceholderRecord>(row.manifest);
  // The effective set's placeholders (§6.3, §6.4; the review's B2): before
  // any approval every default slot and variant is selected, so each one the
  // set lacks gets its placeholder; after one, each the approved design could
  // not have selected (a target added since: a slot or a variant its
  // manifest lacks) gets it too. Only the engine's placeholders are read
  // here, and a slot's platforms are the derivation's.
  const approved = tx.db.prepare(`SELECT "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(row.project) as
    | { asset_manifest: string | null }
    | undefined;
  for (const slot of record?.slots ?? []) tx.db.prepare('UPDATE "design_effective_assets" SET "platforms" = ? WHERE "project" = ? AND "slot" = ?').run(JSON.stringify(slot.platforms), row.project, slot.key);
  const owed = approved ? laterDefaults(parseJson<AssetManifest>(approved.asset_manifest), record) : (record?.slots ?? []).flatMap((s) => s.variants.map((v) => ({ slot: s, variant: v.name })));
  for (const { slot, variant } of owed) {
    const v = slot.variants.find((x) => x.name === variant);
    if (!v?.file || !v.digest) continue;
    if (tx.db.prepare('SELECT 1 FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(row.project, slot.key, v.name)) continue;
    const at = placeholderSource(record, row.revision, slot.key, v.name)!;
    tx.db
      .prepare(
        `INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms", "since_design_revision")
         VALUES (?, ?, ?, ?, ?, ?, ?, 'placeholder', ?, ?, ?, ?, ?, NULL)`,
      )
      .run(tx.newId('deff_'), tx.at, row.project, slot.key, slot.kind, v.name, slot.slot_version, v.digest, v.format, at.revision, at.file, JSON.stringify(slot.platforms));
  }
  tx.emit('design.inventory_derived', { project: row.project, design_inventory: row.id }, {
    inventory_digest: row.inventory_digest,
    revision: row.revision,
    targets: inventory.targets.map((t) => ({ module: t.module, target: t.target, preview_capability: t.preview_capability })),
    ui_requirements: inventory.ui_requirements.map((r) => r.key),
    obligations: inventory.obligations.length,
    placeholders: record?.head_manifest ?? 'absent',
  });
  // An architecture revision that moved the inventory stales the screens
  // whose interfaces, technology or target moved (D7 §9.1; G8).
  inventoryStale(tx, row.project, drawnAgainst, inventory, { design_inventory: row.id, inventory_digest: row.inventory_digest });
  reviewDesignDue(tx, row.project);
  return { recorded: true };
}

// The inventory the approved design names (its `inventory_digest`), else
// the project's last recorded one; null with neither. With an approved
// design whose inventory cannot be read, unknown: never read as fresh (the
// review's S7).
function designInventoryBefore(db: Database, project: string): Inventory | { unknown: string } | null {
  const approved = db.prepare(`SELECT "id", "inventory_digest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { id: string; inventory_digest: string | null }
    | undefined;
  if (approved) {
    if (approved.inventory_digest === null) return { unknown: `the approved design ${approved.id} names no inventory` };
    const row = db.prepare('SELECT "inventory" FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(project, approved.inventory_digest) as { inventory: string } | undefined;
    const inv = parseJson<Inventory>(row?.inventory ?? null);
    return inv ?? { unknown: `the inventory ${approved.inventory_digest.slice(0, 12)} the approved design was drawn against cannot be read` };
  }
  const row = db.prepare('SELECT "inventory" FROM "design_inventories" WHERE "project" = ? AND "recorded_at" IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(project) as { inventory: string } | undefined;
  return parseJson<Inventory>(row?.inventory ?? null);
}

// What an inventory's change stales, from the inventory the design was
// drawn against; every screen of the design when that one is unknown.
function inventoryStale(tx: Tx, project: string, drawnAgainst: Inventory | { unknown: string } | null, to: Inventory, cause: Record<string, unknown>): void {
  if (drawnAgainst === null) return;
  const screens = 'unknown' in drawnAgainst ? allScreensUnknown(tx.db, project, drawnAgainst.unknown) : inventoryDesignClass(tx.db, { project, from: drawnAgainst, to });
  staleScreens(tx, { project, screens, cause });
}

// An inventory recorded before made current again (its inputs returned to
// it, D7 §9.1): the project's digest, the staleness of what moved since the
// design was drawn, the event and design_due, once.
function reselectInventory(tx: Tx, row: InventoryRow): { recorded: boolean } {
  const current = (tx.db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(row.project) as { design_inventory_digest: string | null }).design_inventory_digest;
  if (current === row.inventory_digest) return { recorded: false };
  const drawnAgainst = designInventoryBefore(tx.db, row.project);
  tx.db.prepare('UPDATE "projects" SET "design_inventory_digest" = ? WHERE "id" = ?').run(row.inventory_digest, row.project);
  const inventory = parseJson<Inventory>(row.inventory)!;
  tx.emit('design.inventory_derived', { project: row.project, design_inventory: row.id }, {
    inventory_digest: row.inventory_digest,
    revision: row.revision,
    targets: inventory.targets.map((t) => ({ module: t.module, target: t.target, preview_capability: t.preview_capability })),
    ui_requirements: inventory.ui_requirements.map((r) => r.key),
    obligations: inventory.obligations.length,
    again: true,
  });
  inventoryStale(tx, row.project, drawnAgainst, inventory, { design_inventory: row.id, inventory_digest: row.inventory_digest });
  reviewDesignDue(tx, row.project);
  return { recorded: true };
}

// The project's current inventory: the recorded one its digest names, else
// the latest recorded by insertion; or null.
export function currentInventory(db: Database, project: string): { row: InventoryRow; inventory: Inventory } | null {
  const row = db
    .prepare(
      `SELECT i.* FROM "design_inventories" i JOIN "projects" p ON p."id" = i."project" WHERE i."project" = ? AND i."recorded_at" IS NOT NULL
       ORDER BY (i."inventory_digest" = COALESCE(p."design_inventory_digest", '')) DESC, i.rowid DESC LIMIT 1`,
    )
    .get(project) as InventoryRow | undefined;
  if (!row) return null;
  const inventory = parseJson<Inventory>(row.inventory);
  return inventory ? { row, inventory } : null;
}

export const blobsHash = (blobs: Record<string, string>): string => sha256(canonical(blobs));
