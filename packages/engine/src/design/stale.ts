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
import { designInForce } from './stage-screens.js';
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

// The screens of the design in force and of every approved revision back to
// the ready one (designInForce's scope), one per key and target.
function scopeScreens(db: Db, project: string): ScreenRow[] {
  const seen = new Set<string>();
  const out: ScreenRow[] = [];
  for (const rev of designInForce(db, project).stale_scope.slice().reverse()) {
    for (const s of screensOf(db, rev)) {
      const k = `${s.key}\u0000${s.target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// The design class of a specification change: `changes` per key as D6 §4.4
// computed them, `before` and `after` the approved and proposed
// representations. Empty with no approved design.
export function specDesignClass(db: Db, args: { project: string; changes: { key: string; changes: string[] }[]; before: SpecRepresentation; after: SpecRepresentation }): DesignClass {
  const out: DesignClass = { screens: [], requirements: [] };
  const was = new Map(args.before.requirements.filter((q) => q.withdrawn !== true).map((q) => [q.key, q]));
  for (const q of args.after.requirements) {
    if (q.withdrawn === true || q.human_test === true || q.surface !== 'ui') continue;
    const before = was.get(q.key);
    if (!before || before.surface !== 'ui' || canonical(before.surface_targets ?? null) !== canonical(q.surface_targets ?? null)) out.requirements.push(q.key);
  }
  out.requirements.sort();
  if (designInForce(db, args.project).current === null) return out;
  const staled = new Map(args.changes.filter((c) => c.changes.some((x) => STALING.includes(x))).map((c) => [c.key, c.changes.filter((x) => STALING.includes(x))]));
  const removedTargets = args.before.targets && args.after.targets ? args.before.targets.filter((t) => !args.after.targets!.includes(t)) : [];
  // A proposed specification with no **Targets:** where the approved one had
  // them: whether its targets changed is unknown, never "unchanged" (the
  // review's S7); every screen of the approved targets is stale, saying so.
  const targetsUnknown = args.before.targets !== undefined && args.before.targets.length > 0 && args.after.targets === undefined ? args.before.targets : [];
  for (const s of scopeScreens(db, args.project)) {
    const keys = s.requirements.filter((k) => staled.has(k));
    if (keys.length > 0) out.screens.push({ screen: s.key, target: s.target, reason: keys.map((k) => `${k} ${staled.get(k)!.join(', ')}`).join('; ') });
    else if (removedTargets.includes(s.target)) out.screens.push({ screen: s.key, target: s.target, reason: `the target ${s.target} was removed from the specification` });
    else if (targetsUnknown.includes(s.target)) out.screens.push({ screen: s.key, target: s.target, reason: `unknown: the proposed specification states no **Targets:**, so whether ${s.target} is still a target is not known` });
  }
  return out;
}

// The screens an inventory's change stales (§9.1, an architecture revision):
// interfaces whose shape changed or that went, targets whose technology or
// preview capability changed or that went. `from` is the inventory the
// approved design was drawn against.
export function inventoryDesignClass(db: Db, args: { project: string; from: Inventory; to: Inventory }): StaleScreen[] {
  if (designInForce(db, args.project).current === null || args.from.inventory_digest === args.to.inventory_digest) return [];
  const shape = (i: Inventory['interfaces'][number]) => canonical({ request: i.request ?? null, response: i.response ?? null, errors: i.errors ?? [] });
  const after = new Map(args.to.interfaces.map((i) => [i.name, shape(i)]));
  const moved = new Set(args.from.interfaces.filter((i) => after.get(i.name) !== shape(i)).map((i) => i.name));
  const techOf = (inv: Inventory) => new Map(inv.targets.map((t) => [t.target, `${t.ui_technology}:${t.preview_capability}`]));
  const t0 = techOf(args.from);
  const t1 = techOf(args.to);
  // The UI requirements' targets (§9.1 "requirements moved"): a screen's
  // requirement no longer a UI requirement of its target.
  const uiTargets = (inv: Inventory) => new Map(inv.ui_requirements.map((r) => [r.key, r.targets]));
  const u0 = uiTargets(args.from);
  const u1 = uiTargets(args.to);
  const out: StaleScreen[] = [];
  for (const s of scopeScreens(db, args.project)) {
    const shapes = s.interfaces.filter((i) => moved.has(i));
    const gone = s.requirements.filter((k) => (u0.get(k) ?? []).includes(s.target) && !(u1.get(k) ?? []).includes(s.target));
    if (shapes.length > 0) out.push({ screen: s.key, target: s.target, reason: `the shape of ${shapes.join(', ')} changed` });
    else if (gone.length > 0) out.push({ screen: s.key, target: s.target, reason: `${gone.join(', ')} no longer a UI requirement of ${s.target}` });
    else if (t0.has(s.target) && !t1.has(s.target)) out.push({ screen: s.key, target: s.target, reason: `the target ${s.target} is no longer served` });
    else if (t0.has(s.target) && t0.get(s.target) !== t1.get(s.target)) out.push({ screen: s.key, target: s.target, reason: `the technology of ${s.target} changed (${t0.get(s.target)} to ${t1.get(s.target)})` });
  }
  return out;
}

// Every screen of the design in force, stale for a reason that is unknown
// (an inventory that cannot be read): never left fresh.
export function allScreensUnknown(db: Db, project: string, reason: string): StaleScreen[] {
  return scopeScreens(db, project).map((s) => ({ screen: s.key, target: s.target, reason: `unknown: ${reason}` }));
}

// Mark `screens` stale on the current approved revision: those not stale
// already, once; one `design.stale` naming them; design_due's stage
// `revise` (§9.1, §11). Returns the keys newly staled.
export function staleScreens(tx: Tx, args: { project: string; screens: StaleScreen[]; cause: Record<string, unknown> }): string[] {
  const { current, stale_scope } = designInForce(tx.db, args.project);
  if (current === null || args.screens.length === 0) return [];
  const rev = current.id;
  const staled: StaleScreen[] = [];
  // Every revision of the scope (the review's B1): the one in force and
  // each approved one back to the ready one.
  for (const s of args.screens) {
    let changed = 0;
    for (const r of stale_scope) changed += tx.db.prepare(`UPDATE "design_screens" SET "status" = 'stale', "stale_reason" = ? WHERE "design_revision" = ? AND "key" = ? AND "status" = 'current'`).run(s.reason, r, s.screen).changes;
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
  const rev = designInForce(db, project).current?.id ?? null;
  if (rev === null) return [];
  return screensOf(db, rev)
    .filter((s) => s.status === 'stale')
    .map((s) => ({ screen: s.key, target: s.target }));
}

// A target removed (§9.1; SEAM.md §515): each slot whose `platforms` hold a
// target the current inventory no longer has, for the Designer to tidy: the
// slots of the approved design's asset manifest, and of the engine's
// placeholder records of the project's earlier inventories (where a target
// once added put its slots; the record of each holds only the engine's
// placeholders, their platforms that derivation's, slice 43's B2).
export function stalePlatforms(db: Db, project: string, inventory: Inventory | null): { slot: string; target: string }[] {
  if (inventory === null) return [];
  const targets = new Set(inventory.targets.map((t) => t.target));
  const manifest = db
    .prepare(`SELECT "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') AND "asset_manifest" IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
    .get(project) as { asset_manifest: string } | undefined;
  const records = (db.prepare(`SELECT "manifest" FROM "design_inventories" WHERE "project" = ? AND "recorded_at" IS NOT NULL ORDER BY rowid`).all(project) as { manifest: string }[]).map((r) => r.manifest);
  const seen = new Set<string>();
  const out: { slot: string; target: string }[] = [];
  for (const text of [manifest?.asset_manifest ?? null, ...records]) {
    for (const s of parseJson<Pick<AssetManifest, 'slots'>>(text)?.slots ?? []) {
      for (const t of s.platforms ?? []) {
        if (targets.has(t) || seen.has(`${s.key}\u0000${t}`)) continue;
        seen.add(`${s.key}\u0000${t}`);
        out.push({ slot: s.key, target: t });
      }
    }
  }
  return out;
}
