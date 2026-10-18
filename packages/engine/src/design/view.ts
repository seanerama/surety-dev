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
import { designDueState, heldStages } from './readiness.js';
import { assetsRequired } from './release-hook.js';
import { unboundAssets } from './asset-bindings.js';
import { deferredBatches, effectiveSetNow, readinessWaits } from './approval.js';
import { designHumanCriteria, mappedCriteria } from './criterion-map.js';
import { stalePlatforms } from './stale.js';
import { humanTestEvidence, reviewsView } from './review.js';

// The `later` deferral running now, or null.
export function deferredOf(db: Database.Database, project: string): { until: string; decision: string; held_stages: string[]; stale_screens: string[] } | null {
  const d = designDueState(db, project).deferred;
  return d ? { until: d.until, decision: d.decision, held_stages: d.held, stale_screens: d.stale } : null;
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
    db.prepare('SELECT "id", "version", "status", "scope", "current_against_spec", "ready_at", "approved_at", "assignments", "origin", "effective_assets", "effective_assets_digest" FROM "design_revisions" WHERE "project" = ? ORDER BY rowid').all(args.project) as {
      id: string;
      version: number;
      status: string;
      scope: string;
      current_against_spec: string | null;
      ready_at: string | null;
      approved_at: string | null;
      assignments: string | null;
      origin: string;
      effective_assets: string | null;
      effective_assets_digest: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    scope: r.scope,
    origin: r.origin,
    current_against_spec: r.current_against_spec,
    ready_at: r.ready_at,
    approved_at: r.approved_at,
    // The effective asset set its approval recorded (E162 item 4), null for
    // a revision not approved (or approved before the set was recorded).
    effective_assets: parseJson<unknown[]>(r.effective_assets),
    effective_assets_digest: r.effective_assets_digest,
  }));
  // An approved revision not ready: what its readiness waits on and the
  // next action (SEAM.md §549; the driver's ruling on M519's F1).
  const waits = new Map(readinessWaits(db, args.project).map((w) => [w.design_revision, w]));
  for (const r of revisions as (typeof revisions[number] & { readiness?: unknown })[]) {
    const w = waits.get(r.id);
    if (r.status === 'approved' && r.ready_at === null && w) r.readiness = { waits_on: w.waits_on, next_action: w.next_action, detail: w.detail };
  }
  // The in-force design's criteria of kind `human`, by target: a person
  // judges them through that target's human test (D7 §7.3).
  const mapped = mappedCriteria(db, args.project);
  const judgedOn = (target: string): string[] =>
    (mapped?.mapped ?? []).filter((e) => e.kind === 'human' && e.targets.includes(target)).map((e) => e.id);
  const effective = db.prepare('SELECT "slot", "kind", "variant", "slot_version", "source", "digest", "format" FROM "design_effective_assets" WHERE "project" = ? ORDER BY "slot", "variant"').all(args.project);
  // The design's human tests: one per target of the approved design's change.
  const approved = db.prepare(`SELECT "id", "assignments" FROM "design_revisions" WHERE "project" = ? AND "assignments" IS NOT NULL AND "status" IN ('approved', 'approved_without_criteria', 'superseded') ORDER BY rowid DESC LIMIT 1`).get(args.project) as
    | { id: string; assignments: string }
    | undefined;
  // The design revision in force: a confirmed verdict counts for the
  // version it was given on only (Q4; SEAM.md §524), kept as history after.
  const inForce = (db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(args.project) as { id: string } | undefined)?.id ?? null;
  const human_tests = (parseJson<{ target: string; requirement: string | null; phase: number | null }[]>(approved?.assignments ?? null) ?? []).map((h) => {
    const owner = humanTestEvidence(db, args.project, h.target, inForce);
    // Never `verified`: owner_accepted on his confirmed word alone (Q4).
    return { target: h.target, requirement: h.requirement, phase: h.phase, criteria: judgedOn(h.target), status: owner.accepted ? 'owner_accepted' : 'pending', evidence: owner.evidence };
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
  // The release hook's count (D7 §6.7, A.8; SEAM.md §§496, 508), inert
  // until D5: every selected slot one of whose selected variants has no
  // effective version from an approval, counted over the selection.
  const assets_required = assetsRequired(db, args.project);
  return {
    policy,
    design_preview: (projectEffective(db, args.project) as Record<string, unknown>).design_preview ?? 'static',
    inert,
    ...(inert && inertReason ? { inert_reason: inertReason } : {}),
    inventory: inv?.inventory ?? null,
    revisions,
    effective_assets: effective,
    // The current set's digest, computed as an approval records it: equal to
    // the in-force revision's `effective_assets_digest` unless a derivation
    // has added a placeholder since (a target added). Null with no inventory:
    // no slot is known yet, which is not an empty set.
    effective_assets_digest: inv ? effectiveSetNow(db, args.project).digest : null,
    unbound: unboundAssets(db, args.project),
    assets_required,
    human_tests,
    // The reviews (D7 §10; SEAM.md §524): evidence labelled and counted by
    // provenance, never merged.
    reviews: reviewsView(db, args.project),
    not_checkable_yet,
    // The approved design's criteria its approval could not map to a
    // specification id (criterion-map.ts; the slice-46 review's B1): shown,
    // never dropped.
    criteria_unmatched: mappedCriteria(db, args.project)?.unmatched ?? [],
    holds: heldStages(db, args.project),
    // The design criteria of kind `human` in the specification: a person
    // judges them through the target's human test; no check covers them.
    criteria_judged_by_person: [...designHumanCriteria(db, args.project)].sort(),
    // A design batch the engine is holding back, and why (objection 166; rule 25).
    batches_deferred: deferredBatches(db, args.project),
    // A target removed (D7 §9.1; SEAM.md §515): the slots whose platforms
    // hold a target the inventory no longer has, for the Designer to tidy.
    stale_platforms: stalePlatforms(db, args.project, inv?.inventory ?? null),
    design_due: due ? { id: due.id, ...(parseJson<Record<string, unknown>>(due.evidence) ?? {}) } : null,
    // A `later` deferral running (rule 25; the slice-44 review's S1): until
    // when, the decision that asked for it, and what it was answered on.
    deferred: deferredOf(db, args.project),
  };
}
