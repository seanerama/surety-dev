// The design check's record (D7 §5.6; A.3 design_checks; SEAM.md §483): one
// row per save and per close's check, with its reasons and the design tree's
// blobs, and `design.checked`; and what the check reads of the store (the
// recorded inventory, the allowed external hosts, what the last approval
// approved).

import type Database from 'better-sqlite3';

import { canonical, parseJson, sha256 } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import type { AssetManifest } from './assets.js';
import type { CheckContext, DesignReason, ReviewLinks } from './check.js';
import { knownCriteria } from '../store/transitions/checks.js';
import { checksOfVersion } from '../store/transitions/evidence.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import { currentInventory } from './store.js';
import { designPolicyOf } from './policy.js';

export function checkContext(db: Database.Database, project: string, run: string | null = null): CheckContext {
  const inv = currentInventory(db, project);
  const options = projectEffective(db, project) as Record<string, unknown>;
  // What an owner's approval made effective (§6.4): a manifest may mark only
  // these `approved`, with the same versions and digests.
  const effective = db.prepare(`SELECT "slot", "variant", "slot_version", "digest" FROM "design_effective_assets" WHERE "project" = ? AND "source" = 'approved' ORDER BY "slot", "variant"`).all(project) as {
    slot: string;
    variant: string;
    slot_version: number;
    digest: string;
  }[];
  const bySlot = new Map<string, { slot: string; slot_version: number; digests: Record<string, string> }>();
  for (const e of effective) {
    const s = bySlot.get(e.slot) ?? { slot: e.slot, slot_version: e.slot_version, digests: {} };
    s.digests[e.variant] = e.digest;
    bySlot.set(e.slot, s);
  }
  return {
    inventory: inv?.inventory ?? null,
    externalHosts: Array.isArray(options.design_external_urls) ? (options.design_external_urls as string[]) : [],
    approved: [...bySlot.values()],
    base: baseManifest(db, project),
    placeholders: parseJson<AssetManifest>(inv?.row.manifest ?? null),
    policy: designPolicyOf(db, project),
    reviews: reviewEvidence(db, project, run),
    links: reviewLinks(db, project),
  };
}

// What a review delta's `criterion` and `check` may name (F4): the
// criteria of the registered requirement index, null when none is
// registered; each check of the effective protected version with the
// criteria its covers.criteria names (none with no effective version).
export function reviewLinks(db: Database.Database, project: string): ReviewLinks {
  const known = knownCriteria(db, project);
  const version = effectiveVersion(db, project);
  const checks: Record<string, string[]> = {};
  for (const c of version ? checksOfVersion(db, version.id) : []) checks[c.key] = parseJson<string[]>((c as unknown as { criteria: string | null }).criteria) ?? [];
  return { criteria: known === null ? null : [...known].sort(), checks };
}

// The evidence each review file may cite (B.14): each recorded review's
// own, by the blob of its file; and the saving session's (the evidence of
// the review its opening recorded, and the observations made for its run).
function reviewEvidence(db: Database.Database, project: string, run: string | null): NonNullable<CheckContext['reviews']> {
  const held: Record<string, string[]> = {};
  for (const r of db.prepare('SELECT "id", "review_blob" FROM "design_reviews" WHERE "project" = ? AND "review_blob" IS NOT NULL ORDER BY rowid').all(project) as { id: string; review_blob: string }[]) {
    held[r.review_blob] = (db.prepare('SELECT "id" FROM "design_evidence" WHERE "review" = ? ORDER BY rowid').all(r.id) as { id: string }[]).map((e) => e.id);
  }
  const own =
    run === null
      ? []
      : (db.prepare(`SELECT "id" FROM "design_evidence" WHERE "run" = ? OR "review" IN (SELECT "id" FROM "design_reviews" WHERE "run" = ?) ORDER BY rowid`).all(run, run) as { id: string }[]).map((e) => e.id);
  return { held, run: own };
}

// The base of the asset manifest's version rules (SEAM.md §505): the
// manifest of the project's current approved design revision; before any
// approval, the one the engine last committed (its inventory's placeholders
// or an owner's `asset add`), the latest by event sequence. A Designer
// checkpoint is never the base.
export function baseManifest(db: Database.Database, project: string): AssetManifest | null {
  const approved = db.prepare(`SELECT "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as { asset_manifest: string | null } | undefined;
  if (approved) return parseJson<AssetManifest>(approved.asset_manifest);
  const ev = db
    .prepare(`SELECT "type", "payload" FROM "events" WHERE "type" IN ('design.asset_added', 'design.inventory_derived') AND json_extract("subject", '$.project') = ? ORDER BY "seq" DESC LIMIT 1`)
    .get(project) as { type: string; payload: string } | undefined;
  if (ev?.type === 'design.asset_added') return parseJson<{ manifest?: AssetManifest }>(ev.payload)?.manifest ?? null;
  return parseJson<AssetManifest>(currentInventory(db, project)?.row.manifest ?? null);
}

export interface CheckRecord {
  id: string;
  outcome: 'passed' | 'refused';
  reasons: DesignReason[];
  notices?: DesignReason[];
  hash: string;
}

export function recordCheck(
  tx: Tx,
  args: { project: string; run: string | null; revision: string; inventory_digest: string | null; outcome: 'passed' | 'refused'; reasons: DesignReason[]; notices?: DesignReason[]; blobs: Record<string, string> },
): CheckRecord {
  const id = tx.newId('dchk_');
  const notices = args.notices ?? [];
  // The notices are part of what the check said: in its hash when there are any.
  const hash = sha256(canonical({ revision: args.revision, outcome: args.outcome, reasons: args.reasons, blobs: args.blobs, ...(notices.length > 0 ? { notices } : {}) }));
  tx.db
    .prepare('INSERT INTO "design_checks" ("id", "created_at", "project", "run", "tree_revision", "inventory_digest", "outcome", "reasons", "hash", "blobs", "notices") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, args.project, args.run, args.revision, args.inventory_digest, args.outcome, JSON.stringify(args.reasons), hash, JSON.stringify(args.blobs), notices.length > 0 ? JSON.stringify(notices) : null);
  tx.emit('design.checked', { project: args.project, design_check: id, ...(args.run ? { run: args.run } : {}) }, { outcome: args.outcome, revision: args.revision, reasons: args.reasons.map((r) => r.code), ...(notices.length > 0 ? { notices: notices.map((r) => r.code) } : {}) });
  return { id, outcome: args.outcome, reasons: args.reasons, ...(notices.length > 0 ? { notices } : {}), hash };
}

// The latest design check of a project (by insertion), or of a session run.
export function latestCheck(db: Database.Database, args: { project: string; run?: string }): (CheckRecord & { tree_revision: string; blobs: Record<string, string>; inventory_digest: string | null }) | null {
  const row = (
    args.run
      ? db.prepare('SELECT * FROM "design_checks" WHERE "run" = ? ORDER BY rowid DESC LIMIT 1').get(args.run)
      : db.prepare('SELECT * FROM "design_checks" WHERE "project" = ? ORDER BY rowid DESC LIMIT 1').get(args.project)
  ) as { id: string; outcome: 'passed' | 'refused'; reasons: string; notices: string | null; hash: string; tree_revision: string; blobs: string; inventory_digest: string | null } | undefined;
  if (!row) return null;
  const notices = parseJson<DesignReason[]>(row.notices) ?? [];
  return {
    id: row.id,
    outcome: row.outcome,
    reasons: parseJson<DesignReason[]>(row.reasons) ?? [],
    ...(notices.length > 0 ? { notices } : {}),
    hash: row.hash,
    tree_revision: row.tree_revision,
    blobs: parseJson<Record<string, string>>(row.blobs) ?? {},
    inventory_digest: row.inventory_digest,
  };
}

// A reason as a save's finding (SEAM.md §346's form), naming its subjects.
export function reasonFinding(r: DesignReason): { code: string; path: string; subject: Record<string, unknown>; message: string } {
  const parts = Object.entries(r.subjects).map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return { code: r.code, path: '.surety/design/', subject: r.subjects, message: `${r.code}: ${parts.join(', ')}` };
}
