// GET /v1/projects/:p/design (D7 A.8; SEAM.md §480): the policy and whether
// it is inert (and why: never an empty design shown as complete), the
// inventory, the revisions, the effective asset set, the design's human
// tests with their status (`pending`, or `owner_accepted` on the owner's
// confirmed verdict, Q4: never `verified`), and the open design_due. A read.

import type Database from 'better-sqlite3';

import { notFound, parseJson } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import { approvedModuleMap, designPolicyOf } from './policy.js';
import { currentInventory } from './store.js';
import { heldStages } from './readiness.js';
import type { AssetManifest } from './assets.js';
import { deferredBatches } from './approval.js';

// The selected slots and their selected variants (D7 §5.8, §6.2): the
// current approved revision's manifest under its selection; before any
// approval, every default slot and variant of the recorded inventory's
// manifest. A default kind the selection leaves out is not selected.
function selectedSlots(db: Database.Database, project: string, inventoryManifest: string | null): { key: string; variants: string[] }[] {
  const rev = db.prepare(`SELECT "selection", "asset_manifest" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as
    | { selection: string | null; asset_manifest: string | null }
    | undefined;
  const invSlots = parseJson<AssetManifest>(inventoryManifest)?.slots ?? [];
  if (!rev) return invSlots.map((s) => ({ key: s.key, variants: s.variants.map((v) => v.name) }));
  const selection = parseJson<{ slots?: { kind: string; variants: string[] }[] }>(rev.selection);
  const defaults = new Set(invSlots.map((s) => s.kind));
  return (parseJson<AssetManifest>(rev.asset_manifest)?.slots ?? [])
    .map((s) => {
      const chosen = selection?.slots?.find((x) => x.kind === s.kind);
      const variants = chosen ? s.variants.map((v) => v.name).filter((n) => chosen.variants.includes(n)) : Array.isArray(selection?.slots) && defaults.has(s.kind) ? [] : s.variants.map((v) => v.name);
      return { key: s.key, variants };
    })
    .filter((s) => s.variants.length > 0);
}

export function designView(db: Database.Database, args: { project: string }): Record<string, unknown> {
  const project = db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string } | undefined;
  if (!project) throw notFound('project', args.project);
  const policy = designPolicyOf(db, args.project);
  const map = approvedModuleMap(db, args.project)?.map ?? null;
  const hasUi = (map?.modules ?? []).some((m) => m.surface === 'ui');
  const inert = policy === 'off' || (map !== null && !hasUi);
  const inertReason = policy === 'off' ? 'design is off for this project' : map !== null && !hasUi ? 'the module map has no ui module: there is nothing to design, and no design is shown as complete' : null;
  const inv = currentInventory(db, args.project);
  const revisions = (
    db.prepare('SELECT "id", "version", "status", "scope", "current_against_spec", "ready_at", "approved_at", "assignments", "origin" FROM "design_revisions" WHERE "project" = ? ORDER BY rowid').all(args.project) as {
      id: string;
      version: number;
      status: string;
      scope: string;
      current_against_spec: string | null;
      ready_at: string | null;
      approved_at: string | null;
      assignments: string | null;
      origin: string;
    }[]
  ).map((r) => ({ id: r.id, version: r.version, status: r.status, scope: r.scope, origin: r.origin, current_against_spec: r.current_against_spec, ready_at: r.ready_at, approved_at: r.approved_at }));
  const effective = db.prepare('SELECT "slot", "kind", "variant", "slot_version", "source", "digest", "format" FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot", "variant"').all(args.project);
  // The design's human tests: one per target of the approved design's change.
  const approved = db.prepare(`SELECT "id", "assignments" FROM "design_revisions" WHERE "project" = ? AND "assignments" IS NOT NULL AND "status" IN ('approved', 'approved_without_criteria', 'superseded') ORDER BY rowid DESC LIMIT 1`).get(args.project) as
    | { id: string; assignments: string }
    | undefined;
  const confirmed = (
    db.prepare(`SELECT "verdicts" FROM "design_reviews" WHERE "project" = ? AND "confirmation_decision" IS NOT NULL ORDER BY rowid`).all(args.project) as { verdicts: string }[]
  ).flatMap((r) => parseJson<{ target: string; verdict: string; status: string; observed_on?: string }[]>(r.verdicts) ?? []);
  const human_tests = (parseJson<{ target: string; requirement: string | null; phase: number | null }[]>(approved?.assignments ?? null) ?? []).map((h) => {
    const accepted = confirmed.some((v) => v.target === h.target && v.status === 'confirmed' && v.verdict === 'matches' && v.observed_on !== 'simulation');
    return { target: h.target, requirement: h.requirement, phase: h.phase, status: accepted ? 'owner_accepted' : 'pending' };
  });
  const due = db.prepare(`SELECT "id", "evidence" FROM "decisions" WHERE "project" = ? AND "kind" = 'design_due' AND "status" = 'open' ORDER BY "seq" DESC LIMIT 1`).get(args.project) as { id: string; evidence: string } | undefined;
  // The native conventions the current approved revision leaves not
  // checkable yet, counted per target (D7 §7.2, A.8; SEAM.md §494).
  const current = db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { id: string } | undefined;
  const not_checkable_yet = Object.fromEntries(
    (current
      ? (db.prepare(`SELECT "target", COUNT(*) AS "n" FROM "design_native_obligations" WHERE "design_revision" = ? AND "status" = 'not_checkable_yet' GROUP BY "target" ORDER BY "target"`).all(current.id) as { target: string; n: number }[])
      : []
    ).map((r) => [r.target, r.n]),
  );
  // The release hook's count (D7 §6.7, A.8; SEAM.md §496), inert until D5:
  // every selected slot (the inventory's defaults before the first
  // approval) one of whose selected variants has no effective version from
  // an approval, counted over the selection, not over the rows that happen
  // to exist (the slice-41 review's S3).
  const notApproved = selectedSlots(db, args.project, inv?.row.manifest ?? null)
    .filter((s) => !s.variants.every((v) => (effective as { slot: string; variant: string; source: string }[]).some((e) => e.slot === s.key && e.variant === v && e.source === 'approved')))
    .map((s) => s.key)
    .sort();
  // The policy read gives every key its value or default; a value it lacks
  // is unknown, never assumed (the review's N5).
  const requiredFor = (projectEffective(db, args.project) as Record<string, unknown>).assets_required_for;
  const assets_required = { for: typeof requiredFor === 'string' ? requiredFor : { unknown: 'assets_required_for could not be read from the effective policy' }, not_approved: notApproved, count: notApproved.length };
  return {
    policy,
    design_preview: (projectEffective(db, args.project) as Record<string, unknown>).design_preview ?? 'static',
    inert,
    ...(inert && inertReason ? { inert_reason: inertReason } : {}),
    inventory: inv?.inventory ?? null,
    revisions,
    effective_assets: effective,
    assets_required,
    human_tests,
    not_checkable_yet,
    holds: heldStages(db, args.project),
    // A design batch the engine is holding back, and why (objection 166; rule 25).
    batches_deferred: deferredBatches(db, args.project),
    design_due: due ? { id: due.id, ...(parseJson<Record<string, unknown>>(due.evidence) ?? {}) } : null,
  };
}
