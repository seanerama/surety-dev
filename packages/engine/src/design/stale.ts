// Staleness: the design class (D7 §9; G8; SEAM.md §515). What a design is
// bound to (the spec version it is current against, the architecture
// version, `inventory_digest`) moves; the screens that change touches are
// marked `stale` on the current approved revision, once, with one
// `design.stale` naming them, and design_due (stage `revise`) names them.
//
// - An approved spec change (never a design's own batched change, §7.4): the
//   screens of its requirements `text_changed`, `criteria_changed` or
//   `withdrawn`, and every screen of a target the header removed; a
//   requirement made newly UI is named in the class (it has no screen yet).
//   Computed with D6 §4.4's impact (spec/change.ts computeImpact) and
//   applied in the transaction that applies the version.
// - An architecture revision that changes `inventory_digest`: the screens
//   whose interfaces changed shape, or whose target's technology (and so its
//   preview capability) changed or whose target went; a revision leaving the
//   digest unchanged stales nothing. Applied when the new inventory is
//   recorded (design/store.ts).
// - A replan moving requirements stales nothing (its publication recomputes
//   stage_screens); an asset-only revision stales nothing.
//
// Pure functions over the store, and one transition.

import type Database from 'better-sqlite3';

import { canonical, parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import type { SpecRepresentation } from '../spec/semantics.js';
import type { AssetManifest } from './assets.js';
import type { Inventory } from './inventory.js';
import { approvedRevisionId } from './stage-screens.js';
import { designDueState } from './readiness.js';

type Db = Database.Database;

export interface StaleScreen {
  screen: string;
  target: string;
  reason: string;
}

// The impact's design class (SEAM.md §515): the approved screens the change
// stales, and the requirements it makes newly UI.
export interface DesignClass {
  screens: StaleScreen[];
  requirements: string[];
}

const STALING = ['text_changed', 'criteria_changed', 'withdrawn'];

interface ScreenRow {
  key: string;
  target: string;
  requirements: string[];
  interfaces: string[];
  status: string;
}

function screensOf(db: Db, revision: string): ScreenRow[] {
  return (db.prepare('SELECT "key", "target", "requirements", "interfaces", "status" FROM "design_screens" WHERE "design_revision" = ? ORDER BY "key"').all(revision) as {
    key: string;
    target: string;
    requirements: string;
    interfaces: string;
    status: string;
  }[]).map((s) => ({ key: s.key, target: s.target, requirements: parseJson<string[]>(s.requirements) ?? [], interfaces: parseJson<string[]>(s.interfaces) ?? [], status: s.status }));
}

// The design class of a specification change: `changes` per key as D6 §4.4
// computed them, `before` and `after` the approved and proposed
// representations. Empty with no approved design.
export function specDesignClass(db: Db, args: { project: string; changes: { key: string; changes: string[] }[]; before: SpecRepresentation; after: SpecRepresentation }): DesignClass {
  const rev = approvedRevisionId(db, args.project);
  const out: DesignClass = { screens: [], requirements: [] };
  const was = new Map(args.before.requirements.filter((q) => q.withdrawn !== true).map((q) => [q.key, q]));
  for (const q of args.after.requirements) {
    if (q.withdrawn === true || q.human_test === true || q.surface !== 'ui') continue;
    const before = was.get(q.key);
    if (!before || before.surface !== 'ui' || canonical(before.surface_targets ?? null) !== canonical(q.surface_targets ?? null)) out.requirements.push(q.key);
  }
  out.requirements.sort();
  if (rev === null) return out;
  const staled = new Map(args.changes.filter((c) => c.changes.some((x) => STALING.includes(x))).map((c) => [c.key, c.changes.filter((x) => STALING.includes(x))]));
  const removedTargets = args.before.targets && args.after.targets ? args.before.targets.filter((t) => !args.after.targets!.includes(t)) : [];
  for (const s of screensOf(db, rev)) {
    const keys = s.requirements.filter((k) => staled.has(k));
    if (keys.length > 0) out.screens.push({ screen: s.key, target: s.target, reason: keys.map((k) => `${k} ${staled.get(k)!.join(', ')}`).join('; ') });
    else if (removedTargets.includes(s.target)) out.screens.push({ screen: s.key, target: s.target, reason: `the target ${s.target} was removed from the specification` });
  }
  return out;
}

// The screens an inventory's change stales (§9.1, an architecture revision):
// interfaces whose shape changed or that went, targets whose technology or
// preview capability changed or that went. `from` is the inventory the
// approved design was drawn against.
export function inventoryDesignClass(db: Db, args: { project: string; from: Inventory; to: Inventory }): StaleScreen[] {
  const rev = approvedRevisionId(db, args.project);
  if (rev === null || args.from.inventory_digest === args.to.inventory_digest) return [];
  const shape = (i: Inventory['interfaces'][number]) => canonical({ request: i.request ?? null, response: i.response ?? null, errors: i.errors ?? [] });
  const after = new Map(args.to.interfaces.map((i) => [i.name, shape(i)]));
  const moved = new Set(args.from.interfaces.filter((i) => after.get(i.name) !== shape(i)).map((i) => i.name));
  const techOf = (inv: Inventory) => new Map(inv.targets.map((t) => [t.target, `${t.ui_technology}:${t.preview_capability}`]));
  const t0 = techOf(args.from);
  const t1 = techOf(args.to);
  const out: StaleScreen[] = [];
  for (const s of screensOf(db, rev)) {
    const shapes = s.interfaces.filter((i) => moved.has(i));
    if (shapes.length > 0) out.push({ screen: s.key, target: s.target, reason: `the shape of ${shapes.join(', ')} changed` });
    else if (t0.has(s.target) && !t1.has(s.target)) out.push({ screen: s.key, target: s.target, reason: `the target ${s.target} is no longer served` });
    else if (t0.has(s.target) && t0.get(s.target) !== t1.get(s.target)) out.push({ screen: s.key, target: s.target, reason: `the technology of ${s.target} changed (${t0.get(s.target)} to ${t1.get(s.target)})` });
  }
  return out;
}

// Mark `screens` stale on the current approved revision: those not stale
// already, once; one `design.stale` naming them; design_due's stage
// `revise` (§9.1, §11). Returns the keys newly staled.
export function staleScreens(tx: Tx, args: { project: string; screens: StaleScreen[]; cause: Record<string, unknown> }): string[] {
  const rev = approvedRevisionId(tx.db, args.project);
  if (rev === null || args.screens.length === 0) return [];
  const staled: StaleScreen[] = [];
  for (const s of args.screens) {
    const changed = tx.db.prepare(`UPDATE "design_screens" SET "status" = 'stale', "stale_reason" = ? WHERE "design_revision" = ? AND "key" = ? AND "status" = 'current'`).run(s.reason, rev, s.screen).changes;
    if (changed > 0) staled.push(s);
  }
  if (staled.length === 0) return [];
  tx.emit('design.stale', { project: args.project, design_revision: rev }, { screens: staled.map((s) => s.screen), stale: staled.map((s) => ({ screen: s.screen, target: s.target, reason: s.reason })), ...args.cause });
  const state = designDueState(tx.db, args.project);
  tx.db.prepare('UPDATE "projects" SET "design_due" = ? WHERE "id" = ?').run(JSON.stringify({ ...state, stage: 'revise' }), args.project);
  return staled.map((s) => s.screen);
}

// The stale screens of the current approved revision, with their targets
// (design_due's `stale_screens`, SEAM.md §§514, 515).
export function currentStaleScreens(db: Db, project: string): { screen: string; target: string }[] {
  const rev = approvedRevisionId(db, project);
  if (rev === null) return [];
  return screensOf(db, rev)
    .filter((s) => s.status === 'stale')
    .map((s) => ({ screen: s.key, target: s.target }));
}

// A target removed (§9.1; SEAM.md §515): each slot whose `platforms` hold a
// target the inventory no longer has, for the Designer to tidy: the slots of
// the approved design's asset manifest, and of the manifest the engine
// recorded with the inventory (where a target added put its slots).
export function stalePlatforms(db: Db, project: string, inventory: Inventory | null, recorded: string | null = null): { slot: string; target: string }[] {
  if (inventory === null) return [];
  const targets = new Set(inventory.targets.map((t) => t.target));
  const manifest = db
    .prepare(`SELECT "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') AND "asset_manifest" IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { asset_manifest: string } | undefined;
  const seen = new Set<string>();
  const out: { slot: string; target: string }[] = [];
  for (const text of [manifest?.asset_manifest ?? null, recorded]) {
    for (const s of parseJson<{ slots?: { key: string; platforms?: string[] }[] }>(text)?.slots ?? []) {
      for (const t of s.platforms ?? []) {
        if (targets.has(t) || seen.has(`${s.key}\u0000${t}`)) continue;
        seen.add(`${s.key}\u0000${t}`);
        out.push({ slot: s.key, target: t });
      }
    }
  }
  return out;
}

// A target added (D7 §9.1, §6.3; SEAM.md §515): the engine's placeholders
// for the default slots of the inventory's targets merged into the tree's
// asset manifest, the Designer's slots kept as they are: a missing default
// slot added whole (its placeholder files with it), a target added to the
// `platforms` of the slot of its kind, and a placeholder slot given the
// placeholder variants a new target needs. Nothing is removed (a removed
// target's platforms stay, marked stale on the design read). null when
// nothing changes; otherwise the manifest, its version advanced, and the
// placeholder files to write.
export function mergeTargetSlots(tree: AssetManifest, placeholders: { manifest: AssetManifest; files: Record<string, string> }): { manifest: AssetManifest; files: Record<string, string> } | null {
  const out = structuredClone(tree);
  const files: Record<string, string> = {};
  let changed = false;
  const add = (file: string | undefined) => {
    if (file !== undefined && placeholders.files[file] !== undefined) files[file] = placeholders.files[file]!;
  };
  for (const ps of placeholders.manifest.slots) {
    const slot = out.slots.find((s) => s.key === ps.key) ?? out.slots.find((s) => s.kind === ps.kind);
    if (!slot) {
      out.slots.push(structuredClone(ps));
      for (const v of ps.variants) add(v.file);
      changed = true;
      continue;
    }
    for (const t of ps.platforms) {
      if (slot.platforms.includes(t)) continue;
      slot.platforms.push(t);
      changed = true;
    }
    if (slot.status !== 'placeholder') continue;
    for (const v of ps.variants) {
      if (slot.variants.some((x) => x.name === v.name)) continue;
      slot.variants.push(structuredClone(v));
      add(v.file);
      changed = true;
    }
  }
  if (!changed) return null;
  out.version = tree.version + 1;
  return { manifest: out, files };
}

// The placeholder manifest recorded with an inventory: the engine's
// placeholders for its targets, with the platforms the tree's manifest
// still holds for those slots (so a target removed stays named, for
// stale_platforms, until the Designer tidies the manifest).
export function recordedPlaceholders(placeholders: AssetManifest, tree: AssetManifest | null): AssetManifest {
  const out = structuredClone(placeholders);
  for (const s of tree?.slots ?? []) {
    const mine = out.slots.find((x) => x.key === s.key);
    if (mine) {
      for (const t of s.platforms) if (!mine.platforms.includes(t)) mine.platforms.push(t);
    } else if (s.provenance === 'engine_placeholder' && s.status === 'placeholder') out.slots.push(structuredClone(s));
  }
  return out;
}
