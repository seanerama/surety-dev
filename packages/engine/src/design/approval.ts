// Approval, and how design enters the specification (D7 §7; Q1; G5; E156
// Q3; BS6 §11.5; SEAM.md §§486, 487): a Designer session's close records the
// design revision `proposed` and files one change request (`source: design`)
// whose text is the design's criteria and one human-test requirement per
// target; a Spec Writer one-shot writes it on its side ref; when its
// proposal is recorded the engine raises `design_approval` and that
// `spec_change` under one `batch_key`, the approval bound to the
// specification version the change creates and the inventory derived from
// it, so it never stales itself. Neither answer alone has an effect: the
// change is applied only once the design is approved too (and the barrier
// `design.approved` has passed), and the design's effect is in the
// transaction that applies version n+1. Readiness (§7.5) follows the
// application of the protected version covering the criteria.
//
// The engine assigns the design's per-target human tests (E156 Q3,
// narrowly): to the phase holding that target's last UI stage in the active
// roadmap and published plans, shown on the approval's preview and bound to
// the roadmap and plan versions it was derived from; when it cannot be
// determined, nothing is assigned and the preview says why. Assignment is a
// roadmap revision `approved_by` `engine:design_approval`; it passes no human
// test, creates no machine evidence and reopens no completed phase.

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { canonical, illegal, notFound, parseJson, sha256 } from '../store/transitions/common.js';
import { type DecisionRow, consumeDecision, invalidateDecision, openDecision } from '../store/transitions/decisions.js';
import { checksOfVersion } from '../store/transitions/evidence.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import { type AnswerExtra, type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import { policyRevision } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import { recordMetMilestones } from '../scheduler/milestones.js';
import type { SpecRepresentation } from '../spec/semantics.js';
import { liveRepresentation } from '../spec/semantics.js';
import type { AssetManifest } from './assets.js';
import { narrowings as narrowingsOf } from './check.js';
import { writeDueState } from './due.js';
import { type Inventory, deriveInventory } from './inventory.js';
import { approvedModuleMap, designHumanTestKeys, inventoryInputs, publishedStages, stageModuleNames, stageRequirementKeys } from './policy.js';
import { designDueState } from './readiness.js';
import { blobsHash, currentInventory } from './store.js';
import { latestCheck } from './records.js';
import { disputedInterfaces } from './findings.js';
import { bindStageScreensTo } from './stage-screens.js';

type Db = Database.Database;

export const DESIGN_APPROVAL_KEYS = [
  'design_version',
  'architecture_version',
  'design_check',
  'asset_manifest_version',
  'selection',
  'tree_blobs',
  'spec_version',
  'spec_change_diff_hash',
  'inventory_digest',
  'roadmap_version',
  'plan_versions',
];

export interface DesignContent {
  design: Record<string, unknown>;
  screens: { screens: Record<string, unknown>[] };
  navigation: { targets: Record<string, unknown>[] };
  criteria: { criteria: Record<string, unknown>[]; human_tests: { target: string; text: string; screens: string[]; not_checkable_yet: unknown[] }[] };
  manifest: AssetManifest;
}

export interface RevisionRow {
  id: string;
  project: string;
  version: number;
  scope: 'full' | 'asset_only' | 'initial_review';
  revision: string;
  blobs: string;
  origin: string;
  targets: string;
  asset_manifest_version: number | null;
  asset_manifest: string | null;
  selection: string | null;
  narrowings: string;
  current_against_spec: string | null;
  spec_change_request: string | null;
  architecture_revision: string | null;
  inventory_digest: string | null;
  design_check: string | null;
  run: string | null;
  batch_key: string | null;
  status: 'proposed' | 'approved' | 'approved_without_criteria' | 'rejected' | 'superseded';
  assets_held: string;
  assignments: string | null;
  approved_at: string | null;
  ready_at: string | null;
  findings: string;
  content: string | null;
  batch_released_at: string | null;
}

export const getRevision = (db: Db, id: string): RevisionRow | undefined => db.prepare('SELECT * FROM "design_revisions" WHERE "id" = ?').get(id) as RevisionRow | undefined;
const contentOf = (r: RevisionRow): DesignContent | null => parseJson<DesignContent>(r.content);
const requestRow = (db: Db, id: string | null) =>
  id === null ? undefined : (db.prepare('SELECT * FROM "spec_change_requests" WHERE "id" = ?').get(id) as { id: string; project: string; seq: number; status: string; work_item: string | null; proposal_blob: string | null; impact_value: string | null; source: string } | undefined);

// ---- the proposal at close (D7 §5a, §7.1) ----------------------------------------------------------

// The request's text: the design's criteria and its human tests (§7.1).
export function requestText(content: DesignContent): string {
  return [
    'The approved design proposes these criteria and one human-test requirement per target (D7 §7.1, §7.3).',
    'Write each criterion under its requirement (a criterion with requirement "new" as a requirement of its own), and each human test as a new requirement marked **Human test.** and **Surface:** ui (<target>).',
    '',
    '```json',
    JSON.stringify({ criteria: content.criteria.criteria, human_tests: content.criteria.human_tests }, null, 2),
    '```',
  ].join('\n');
}

export function proposeDesign(
  tx: Tx,
  args: { project: string; run: string | null; revision: string; tree?: string | null; blobs: Record<string, string>; content: DesignContent; check: string; findings: Record<string, unknown>[]; scope?: 'full' | 'asset_only' | 'initial_review' },
): { revision: string; request: string | null } {
  const d = args.content.design;
  const inv = currentInventory(tx.db, args.project);
  const arch = approvedModuleMap(tx.db, args.project);
  const id = tx.newId('dsg_');
  const scope = args.scope ?? 'full';
  tx.db
    .prepare(
      `INSERT INTO "design_revisions" ("id", "created_at", "project", "version", "scope", "tree_blob", "revision", "blobs", "origin", "targets", "asset_manifest_version", "asset_manifest", "selection", "narrowings",
         "architecture_revision", "inventory_digest", "design_check", "run", "status", "findings", "content")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
      typeof d.version === 'number' ? d.version : 1,
      scope,
      // The git tree of .surety/design/ at the revision (D7 A.3; SEAM.md
      // §501); an asset-only revision of the same commit carries its own.
      args.tree ??
        (tx.db.prepare('SELECT "tree_blob" FROM "design_revisions" WHERE "project" = ? AND "revision" = ? AND "tree_blob" IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(args.project, args.revision) as { tree_blob: string } | undefined)?.tree_blob ??
        null,
      args.revision,
      JSON.stringify(args.blobs),
      d.origin === 'observed' ? 'observed' : 'intended',
      JSON.stringify(d.targets ?? []),
      args.content.manifest?.version ?? null,
      JSON.stringify(args.content.manifest ?? null),
      JSON.stringify(d.selection ?? null),
      JSON.stringify(narrowingsOf(d, inv?.inventory ?? null)),
      arch?.id ?? null,
      typeof d.inventory_digest === 'string' ? d.inventory_digest : null,
      args.check,
      args.run,
      JSON.stringify(args.findings),
      JSON.stringify(args.content),
    );
  tx.emit('design.proposed', { project: args.project, design_revision: id }, { version: d.version ?? null, scope, revision: args.revision, design_check: args.check });
  if (scope === 'asset_only') {
    raiseQuestion(tx, { project: args.project, kind: 'design_approval', subjectType: 'design_revision', subjectId: id });
    return { revision: id, request: null };
  }
  // The consolidated change request (§7.1): source design, its Spec Writer one-shot.
  const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string } | undefined;
  if (!spec) throw illegal('a design proposal with no approved specification', { project: args.project });
  const { seq } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS seq FROM "spec_change_requests" WHERE "project" = ?').get(args.project) as { seq: number };
  const request = tx.newId('scr_');
  tx.db
    .prepare(`INSERT INTO "spec_change_requests" ("id", "created_at", "project", "seq", "spec_revision", "text", "request_text", "source", "status") VALUES (?, ?, ?, ?, ?, NULL, ?, 'design', 'requested')`)
    .run(request, tx.at, args.project, seq, spec.id, requestText(args.content));
  const work = observeTrigger(tx, { project: args.project, kind: 'spec_change', trigger_source: 'spec_change_request', trigger_id: request, trigger_generation: 1, subject: { request }, chain: 0 }, { request, design_revision: id });
  tx.db.prepare('UPDATE "spec_change_requests" SET "work_item" = ? WHERE "id" = ?').run(work.work_item.id, request);
  tx.db.prepare('UPDATE "design_revisions" SET "spec_change_request" = ? WHERE "id" = ?').run(request, id);
  tx.emit('spec.change_requested', { project: args.project, spec_change_request: request }, { seq, spec_revision: spec.id, work_item: work.work_item.id, source: 'design', design_revision: id });
  return { revision: id, request };
}

// ---- the batch (D7 §7.4) -------------------------------------------------------------------------------

export const revisionOfRequest = (db: Db, request: string): RevisionRow | undefined =>
  db.prepare('SELECT * FROM "design_revisions" WHERE "spec_change_request" = ? ORDER BY rowid DESC LIMIT 1').get(request) as RevisionRow | undefined;

// The proposed representation's inventory (n+1's), derived and compared with
// the design's at raise: a difference refuses the batch (§7.4). null when
// they agree; the reason otherwise.
export function batchInventoryDifference(db: Db, args: { project: string; rep: SpecRepresentation; addedHumanTests: string[]; designDigest: string | null }): string | null {
  return batchInventoryDiff(db, args)?.reason ?? null;
}

// The same, with what differs (SEAM.md §519 `evidence.inventory_difference`):
// the UI requirements added or gone, and the interfaces and targets moved.
export function batchInventoryDiff(db: Db, args: { project: string; rep: SpecRepresentation; addedHumanTests: string[]; designDigest: string | null }): { reason: string; detail: Record<string, unknown> } | null {
  // The design's human tests already approved stay excluded beside the ones
  // this change adds: a later design's batch revises them (M533 (e)).
  const inputs = inventoryInputs(db, args.project, { rep: liveRepresentation(args.rep), exclude: [...new Set([...designHumanTestKeys(db, args.project), ...args.addedHumanTests])] });
  if ('unknown' in inputs) return { reason: `the inventory of the proposed specification cannot be derived: ${inputs.unknown}`, detail: { unknown: inputs.unknown } };
  const next = deriveInventory(inputs);
  if (args.designDigest === null) return { reason: 'the design names no inventory', detail: { design_inventory: null } };
  if (next.inventory_digest === args.designDigest) return null;
  const drawn = parseJson<Inventory>((db.prepare('SELECT "inventory" FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(args.project, args.designDigest) as { inventory: string } | undefined)?.inventory ?? null);
  const keyed = (inv: Inventory | null) => new Map((inv?.ui_requirements ?? []).map((r) => [r.key, canonical(r)]));
  const [a, b] = [keyed(drawn), keyed(next)];
  const shapes = (inv: Inventory | null) => new Map((inv?.interfaces ?? []).map((i) => [i.name, canonical(i)]));
  const [ia, ib] = [shapes(drawn), shapes(next)];
  const targets = (inv: Inventory | null) => new Map((inv?.targets ?? []).map((t) => [t.target, canonical(t)]));
  const [ta, tb] = [targets(drawn), targets(next)];
  const moved = <T>(x: Map<string, T>, y: Map<string, T>) => [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).sort();
  const detail = {
    design_inventory: args.designDigest,
    proposed_inventory: next.inventory_digest,
    ui_requirements: { added: [...b.keys()].filter((k) => !a.has(k)).sort(), removed: [...a.keys()].filter((k) => !b.has(k)).sort(), changed: [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).sort() },
    interfaces: moved(ia, ib),
    targets: moved(ta, tb),
  };
  return { reason: `the proposed specification's inventory (${next.inventory_digest.slice(0, 12)}) differs from the design's (${args.designDigest.slice(0, 12)})`, detail };
}

// Called when a design request's proposal is recorded (spec/change.ts
// finalizeProposal): the design_approval raised beside the spec_change, one
// batch_key; or the batch refused at raise, nothing raised, design_due open
// naming the difference (SEAM.md §486's reading of plan §2.6).
export function raiseDesignBatch(tx: Tx, args: { request: string; rep: SpecRepresentation | null; added: string[] }): { refused: string | null } {
  const rev = revisionOfRequest(tx.db, args.request);
  if (!rev || rev.status !== 'proposed') return { refused: 'the design is no longer proposed' };
  const human = args.rep ? args.rep.requirements.filter((q) => q.human_test && args.added.includes(q.key)).map((q) => q.key) : [];
  const found = args.rep ? batchInventoryDiff(tx.db, { project: rev.project, rep: args.rep, addedHumanTests: human, designDigest: rev.inventory_digest }) : { reason: 'the proposed specification cannot be read', detail: { proposed: null } };
  if (found !== null) {
    // The close's product stays recorded, `proposed` and never raised
    // (SEAM.md §519); design_due names what differs.
    writeDueState(tx, rev.project, { ...designDueState(tx.db, rev.project), stage: 'revise', note: `the batch was refused at raise: ${found.reason}`, inventory_difference: { design_revision: rev.id, ...found.detail } });
    return { refused: found.reason };
  }
  const key = `design:${rev.id}`;
  // An earlier batch's refusal at raise is answered by this one.
  const due = designDueState(tx.db, rev.project);
  if (due.inventory_difference) {
    const { inventory_difference: _d, ...rest } = due;
    writeDueState(tx, rev.project, rest);
  }
  tx.db.prepare('UPDATE "design_revisions" SET "batch_key" = ? WHERE "id" = ?').run(key, rev.id);
  const d = raiseQuestion(tx, { project: rev.project, kind: 'design_approval', subjectType: 'design_revision', subjectId: rev.id });
  if (d) tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "id" = ?').run(key, d.id);
  return { refused: null };
}

// ---- a batch deferred behind a pending correction (objection 166) ---------------------------------
//
// The driver's rulings on objection 166: the engine raises no decision whose
// binding is known to be about to move. A design batch's `spec_change` binds
// the effective protected-check version. A correction of the protected
// checks that is undecided (captured, classified, awaiting the owner: its
// question open or about to be raised) or approved and not yet applied may
// move that version. So the batch is not raised while one is pending: the
// change's work waits `awaiting_decision` with the blocker
// `design_batch_deferred`, and the batch is raised once none is pending
// (applied, rejected or withdrawn), bound to the version then current. The
// owner answers the correction first and the batch once. The design read
// names the deferral and the corrections (BS6 §4.1 rule 25).
//
// No cycle: a correction caused by this design's own batch never defers it.
// Such a correction is the proposal of a `check_correction` item the
// change's obligations registered (trigger `spec_obligation`, its subject's
// `request` this request), which exists only after the batch is approved and
// applied; it is excluded by that identity. Nothing else pending waits on the
// batch: while the request is proposed no protected writer is dispatched
// (store/transitions/runs.ts, the ruling on Q2), and a pending correction's
// classification, question, answer and application do not read the batch.
//
// A correction raised after the batch was raised is not this case: the
// effect's revalidation (D1 §10.5) refuses it and the batch is asked again.

export const DESIGN_BATCH_DEFERRED = 'design_batch_deferred';

export interface PendingCorrection {
  proposal: string;
  status: string;
  // The open check_correction_* question about it, if one stands.
  question: string | null;
}

// The project's protected proposals undecided, or approved and not yet
// applied, except those `request`'s own obligations caused.
export function pendingCorrections(db: Db, project: string, request: string | null = null): PendingCorrection[] {
  return db
    .prepare(
      `SELECT p."id" AS "proposal", p."status",
         (SELECT d."id" FROM "decisions" d WHERE d."subject_type" = 'protected_proposal' AND d."subject_id" = p."id" AND d."status" = 'open' AND d."kind" LIKE 'check_correction_%' ORDER BY d."seq" DESC LIMIT 1) AS "question"
       FROM "protected_proposals" p LEFT JOIN "runs" u ON u."id" = p."run" LEFT JOIN "work_items" w ON w."id" = u."work_item"
       WHERE p."project" = ? AND p."status" IN ('captured', 'classified', 'awaiting_human', 'approved')
         AND COALESCE(w."kind" = 'check_correction' AND w."trigger_source" = 'spec_obligation' AND json_extract(w."subject", '$.request') = ?, 0) = 0
       ORDER BY p."seq", p."id"`,
    )
    .all(project, request) as PendingCorrection[];
}

// The design batches the engine is holding back, with what holds them.
export function deferredBatches(db: Db, project: string): { spec_change_request: string; design_revision: string | null; work_item: string; since: string | null; reason: string; pending_corrections: PendingCorrection[] }[] {
  const items = db
    .prepare(`SELECT "id", "blocker" FROM "work_items" WHERE "project" = ? AND "kind" = 'spec_change' AND "status" = 'awaiting_decision' AND json_extract("blocker", '$.reason') = ? ORDER BY "seq"`)
    .all(project, DESIGN_BATCH_DEFERRED) as { id: string; blocker: string }[];
  return items.map((w) => {
    const blocker = parseJson<{ raised_at?: string; spec_change_request?: string }>(w.blocker) ?? {};
    const request = blocker.spec_change_request ?? (db.prepare('SELECT "id" FROM "spec_change_requests" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(w.id) as { id: string } | undefined)?.id ?? '';
    return {
      spec_change_request: request,
      design_revision: revisionOfRequest(db, request)?.id ?? null,
      work_item: w.id,
      since: blocker.raised_at ?? null,
      reason: 'a correction of the protected checks is undecided, or approved and not applied yet: the batch would be bound to a version that may be replaced; answer the correction first',
      pending_corrections: pendingCorrections(db, project, request),
    };
  });
}

// Whether a design request's application may begin (SEAM.md §486): 'none'
// for a request that is not a design's; 'wait' while its design_approval is
// open or the batch is not released; 'go'; or 'refuse' when the design was
// sent back or rejected.
export function designBatchState(db: Db, request: string): 'none' | 'wait' | 'go' | 'refuse' {
  const r = requestRow(db, request);
  if (!r || r.source !== 'design') return 'none';
  const rev = revisionOfRequest(db, request);
  if (!rev) return 'refuse';
  if (rev.status !== 'proposed') return 'refuse';
  const d = latestApproval(db, rev.id);
  if (!d || d.status === 'open') return 'wait';
  if (d.status !== 'consumed') return 'wait';
  const option = parseJson<{ option?: string }>(d.answer)?.option;
  if (option !== 'approve') return 'refuse';
  return rev.batch_released_at === null ? 'wait' : 'go';
}

const latestApproval = (db: Db, revision: string): (DecisionRow & { answer: string | null; dependency_manifest: string }) | undefined =>
  db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'design_approval' AND "subject_id" = ? ORDER BY "semantic_generation" DESC LIMIT 1`).get(revision) as (DecisionRow & { answer: string | null; dependency_manifest: string }) | undefined;

// The bindings the approval's answer was given on, compared with now (E156
// Q3: a change between the answer and the effect refuses the effect).
export function designBindingsChanged(db: Db, request: string): string | null {
  const rev = revisionOfRequest(db, request);
  if (!rev) return null;
  const d = latestApproval(db, rev.id);
  if (!d || d.status !== 'consumed') return null;
  const then = parseJson<Record<string, unknown>>(d.dependency_manifest) ?? {};
  const now = designManifest(db, rev);
  for (const k of ['roadmap_version', 'plan_versions', 'architecture_version', 'inventory_digest'] as const) if (canonical(then[k]) !== canonical(now[k])) return k;
  return null;
}

// The effect refused on bindings that moved: the batch raised again
// against what is there now (the spec_change by its own withdrawal).
export function reraiseDesignBatch(tx: Tx, request: string): void {
  const rev = revisionOfRequest(tx.db, request);
  if (!rev) return;
  tx.db.prepare('UPDATE "design_revisions" SET "batch_released_at" = NULL WHERE "id" = ?').run(rev.id);
  const d = raiseQuestion(tx, { project: rev.project, kind: 'design_approval', subjectType: 'design_revision', subjectId: rev.id });
  const key = rev.batch_key ?? `design:${rev.id}`;
  if (d) tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "id" = ?').run(key, d.id);
  const sc = openDecision(tx, rev.project, 'spec_change', 'spec_change_request', request);
  if (sc) tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "id" = ?').run(key, sc.id);
}

// The batches whose two answers are consumed `approve` and whose effect is
// not yet released, among `decisions` (an answer's) or all of a project's.
export function answeredBatches(db: Db, args: { decisions?: string[]; project?: string }): { revision: string; request: string; intents: string[] }[] {
  const revs = (
    args.decisions
      ? (args.decisions
          .map((id) => db.prepare('SELECT "kind", "subject_id", "batch_key" FROM "decisions" WHERE "id" = ?').get(id) as { kind: string; subject_id: string; batch_key: string | null } | undefined)
          .filter((x): x is { kind: string; subject_id: string; batch_key: string | null } => x !== undefined && x.batch_key !== null && x.batch_key.startsWith('design:'))
          .map((x) => x.batch_key!.slice('design:'.length)))
      : (db.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" = 'proposed' AND "batch_released_at" IS NULL AND "spec_change_request" IS NOT NULL`).all(args.project) as { id: string }[]).map((r) => r.id)
  ).filter((v, i, a) => a.indexOf(v) === i);
  const out: { revision: string; request: string; intents: string[] }[] = [];
  for (const id of revs) {
    const rev = getRevision(db, id);
    if (!rev || rev.status !== 'proposed' || rev.batch_released_at !== null || !rev.spec_change_request) continue;
    const d = latestApproval(db, rev.id);
    if (!d || d.status !== 'consumed' || parseJson<{ option?: string }>(d.answer)?.option !== 'approve') continue;
    const sc = db.prepare(`SELECT "id", "status", "answer" FROM "decisions" WHERE "kind" = 'spec_change' AND "subject_id" = ? ORDER BY "semantic_generation" DESC LIMIT 1`).get(rev.spec_change_request) as
      | { id: string; status: string; answer: string | null }
      | undefined;
    if (!sc || sc.status !== 'consumed' || parseJson<{ option?: string }>(sc.answer)?.option !== 'approve') continue;
    const intents = (db.prepare(`SELECT "id" FROM "effect_intents" WHERE "decision" = ? AND "kind" = 'spec_change_application' AND "status" IN ('pending', 'executing')`).all(sc.id) as { id: string }[]).map((r) => r.id);
    out.push({ revision: rev.id, request: rev.spec_change_request, intents });
  }
  return out;
}

export function releaseBatch(tx: Tx, args: { revision: string }): boolean {
  return tx.db.prepare('UPDATE "design_revisions" SET "batch_released_at" = ? WHERE "id" = ? AND "batch_released_at" IS NULL').run(tx.at, args.revision).changes > 0;
}

// A batch's change request settled with its design sent back or rejected:
// failed, its open question invalidated, its work done (§7.4: no rejected or
// revised design leaves its criteria pending).
function settleBatchRequest(tx: Tx, rev: RevisionRow, why: string): void {
  const r = requestRow(tx.db, rev.spec_change_request);
  if (!r || (r.status !== 'proposed' && r.status !== 'requested')) return;
  tx.db.prepare(`UPDATE "spec_change_requests" SET "status" = 'failed', "failure" = ? WHERE "id" = ?`).run(why, r.id);
  tx.emit('spec.change_failed', { project: r.project, spec_change_request: r.id }, { work_item: r.work_item, reason: 'design_not_approved', failure: why });
  const open = openDecision(tx, r.project, 'spec_change', 'spec_change_request', r.id);
  if (open) invalidateDecision(tx, open, why);
  const item = r.work_item ? getWorkItem(tx, r.work_item) : undefined;
  if (item && item.status !== 'complete' && item.status !== 'cancelled') {
    if (item.status === 'awaiting_decision') transitionWork(tx, item, 'complete', { blocker: null }, { spec_change_request: r.id, cause: 'design_not_approved' });
    else if (item.status === 'eligible') transitionWork(tx, item, 'cancelled', {}, { spec_change_request: r.id, cause: 'design_not_approved' });
  }
}

// ---- the preview (D7 §7.4; SEAM.md §486) -----------------------------------------------------------

export function planVersions(db: Db, project: string): { id: string; generation: number; phase: number }[] {
  return db.prepare(`SELECT "id", "generation", "phase_number" AS "phase" FROM "phase_plans" WHERE "project" = ? AND "active" = 1 AND "status" IN ('published', 'completed') ORDER BY "phase_number", rowid`).all(project) as {
    id: string;
    generation: number;
    phase: number;
  }[];
}
const roadmapVersion = (db: Db, project: string): number | null => (db.prepare('SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number } | undefined)?.version ?? null;

export function designManifest(db: Db, rev: RevisionRow): Record<string, unknown> {
  const r = requestRow(db, rev.spec_change_request);
  const current = (db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(rev.project) as { version: number } | undefined)?.version ?? null;
  // The architecture version and the inventory as they are now (the
  // slice-40 review's m5): the approval's answer is compared with them at
  // the effect, so a change between the two is seen.
  const arch = approvedModuleMap(db, rev.project)?.version ?? null;
  const inventoryNow = (db.prepare('SELECT "design_inventory_digest" FROM "projects" WHERE "id" = ?').get(rev.project) as { design_inventory_digest: string | null } | undefined)?.design_inventory_digest ?? null;
  const latest = latestCheck(db, { project: rev.project });
  return {
    design_version: rev.version,
    architecture_version: arch,
    design_check: rev.design_check,
    asset_manifest_version: rev.asset_manifest_version,
    selection: sha256(canonical(parseJson(rev.selection))),
    // The design tree as the project's last save left it: a later save
    // stales the approval (M505 (g)).
    tree_blobs: latest ? blobsHash(latest.blobs) : null,
    // In a batch, the version its own change creates (§7.4).
    spec_version: r && (r.status === 'proposed' || r.status === 'requested') ? (current ?? 0) + 1 : current,
    spec_change_diff_hash: r?.proposal_blob ?? null,
    inventory_digest: inventoryNow,
    roadmap_version: roadmapVersion(db, rev.project),
    plan_versions: planVersions(db, rev.project).map((p) => ({ id: p.id, generation: p.generation })),
  };
}

// The phase holding a target's last UI stage (E156 Q3; SEAM.md §486), or
// null with why.
export function lastUiPhase(db: Db, project: string, target: string): { phase: number | null; reason?: string; stage?: string; phase_plan?: string } {
  const map = approvedModuleMap(db, project)?.map ?? null;
  const serving = new Set((map?.modules ?? []).filter((m) => m.surface === 'ui' && (m.targets ?? []).some((t) => t.target === target)).map((m) => m.name));
  const road = db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { phases: string } | undefined;
  if (!road) return { phase: null, reason: 'the project has no roadmap yet' };
  const phases = parseJson<{ number: number; modules: string[] }[]>(road.phases) ?? [];
  const plans = planVersions(db, project);
  const stages = publishedStages(db, project);
  const holding: number[] = [];
  // The stage of a published plan that is the target's last UI stage, by phase.
  const last = new Map<number, { stage: string; phase_plan: string }>();
  for (const ph of phases) {
    const plan = plans.find((p) => p.phase === ph.number);
    if (plan) {
      const serving_ = stages.filter((s) => s.phase_plan === plan.id && stageModuleNames(db, project, s.modules).some((m) => serving.has(m))).sort((a, b) => a.number - b.number);
      if (serving_.length > 0) {
        holding.push(ph.number);
        last.set(ph.number, { stage: serving_.at(-1)!.id, phase_plan: plan.id });
      }
    } else if (ph.modules.some((m) => serving.has(m))) holding.push(ph.number);
  }
  if (holding.length === 0) return { phase: null, reason: `no phase of the roadmap holds a UI stage of ${target}` };
  const phase = Math.max(...holding);
  return { phase, ...(last.get(phase) ?? {}) };
}

// The design's human tests, each with the requirement the change gives it
// and the phase it would be assigned to.
export function humanTestAssignments(db: Db, rev: RevisionRow): { target: string; requirement: string | null; phase: number | null; reason?: string; stage?: string; phase_plan?: string }[] {
  const content = contentOf(rev);
  const r = requestRow(db, rev.spec_change_request);
  if (!content || !r) return [];
  const rep = proposedRepresentation(db, r.id);
  const impact = parseJson<{ requirements?: { key: string; changes: string[] }[] }>(r.impact_value);
  const added = new Set((impact?.requirements ?? []).filter((q) => q.changes.includes('added')).map((q) => q.key));
  return content.criteria.human_tests.map((h) => {
    const req = rep?.requirements.find((q) => q.human_test && added.has(q.key) && (q.surface_targets ?? []).includes(h.target)) ?? null;
    const where = lastUiPhase(db, rev.project, h.target);
    return { target: h.target, requirement: req?.key ?? null, phase: where.phase, ...(where.reason ? { reason: where.reason } : {}), ...(where.stage ? { stage: where.stage, phase_plan: where.phase_plan } : {}) };
  });
}

function proposedRepresentation(db: Db, request: string): SpecRepresentation | null {
  const r = db.prepare('SELECT "work_item", "proposal_blob" FROM "spec_change_requests" WHERE "id" = ?').get(request) as { work_item: string | null; proposal_blob: string | null } | undefined;
  if (!r?.proposal_blob) return null;
  const sem = db
    .prepare(`SELECT s."representation" FROM "spec_semantics" s JOIN "runs" u ON u."id" = s."run" WHERE u."work_item" = ? AND s."git_blob" = ? ORDER BY s.rowid DESC LIMIT 1`)
    .get(r.work_item, r.proposal_blob) as { representation: string | null } | undefined;
  return liveRepresentation(parseJson<SpecRepresentation>(sem?.representation ?? null));
}

// The interfaces its screens use that a Designer's finding still open
// disputes (D7 §4.5; SEAM.md §491): open until the owner routes it.
function interfacesDisputed(db: Db, rev: RevisionRow): string[] {
  const content = contentOf(rev);
  const used = new Set((content?.screens.screens ?? []).flatMap((s) => (Array.isArray(s.interfaces) ? (s.interfaces as string[]) : [])));
  return disputedInterfaces(db, rev.project).filter((i) => used.has(i));
}

export const DESIGN_APPROVAL: KindSpec = {
  preview(tx, d: Subject) {
    const rev = getRevision(tx.db, d.subject_id);
    if (!rev || rev.status !== 'proposed') return null;
    const content = contentOf(rev);
    const r = requestRow(tx.db, rev.spec_change_request);
    // A batch member before its change's proposal exists is not asked yet.
    if (rev.scope !== 'asset_only' && (!r || (r.status !== 'proposed' && r.status !== 'rejected'))) return null;
    const inv = currentInventory(tx.db, rev.project)?.inventory ?? null;
    const check = rev.design_check ? (tx.db.prepare('SELECT "id", "outcome", "hash" FROM "design_checks" WHERE "id" = ?').get(rev.design_check) as { id: string; outcome: string; hash: string } | undefined) : undefined;
    const manifest = designManifest(tx.db, rev);
    const assignments = rev.scope === 'asset_only' ? [] : humanTestAssignments(tx.db, rev);
    const capability = (target: string) => inv?.targets.find((t) => t.target === target)?.preview_capability ?? 'none';
    const screens = content?.screens.screens ?? [];
    const mockups = (Array.isArray(content?.design.mockups) ? (content!.design.mockups as Record<string, unknown>[]) : []).map((m) => {
      const target = String(screens.find((s) => Array.isArray(m.screens) && (m.screens as string[]).includes(String(s.key)))?.target ?? (m.simulates as { target?: string } | undefined)?.target ?? 'web');
      return { path: String(m.path), kind: String(m.kind), target, preview_capability: capability(target) };
    });
    const impact = parseJson<Record<string, unknown>>(r?.impact_value ?? null);
    const assetManifest = parseJson<AssetManifest>(rev.asset_manifest);
    const narrowings = parseJson<string[]>(rev.narrowings) ?? [];
    const disputed = interfacesDisputed(tx.db, rev);
    const evidence = {
      mockups,
      design_check: check ? { id: check.id, outcome: check.outcome, hash: check.hash } : null,
      criteria_diff: r ? { requirements: (impact as { requirements?: unknown } | null)?.requirements ?? null, added_criteria: (impact as { added_criteria?: unknown } | null)?.added_criteria ?? null, criteria: content?.criteria.criteria ?? [] } : null,
      asset_manifest: { version: assetManifest?.version ?? null, slots: (assetManifest?.slots ?? []).map((s) => ({ key: s.key, kind: s.kind, slot_version: s.slot_version, status: s.status, provenance: s.provenance })) },
      narrowings,
      impact,
      human_test_assignments: assignments,
    };
    // A review's revised or first design (D7 §10.3): approved only once the
    // verdicts it rests on are the owner's.
    const unconfirmed = rev.run
      ? (tx.db.prepare(`SELECT "id" FROM "design_reviews" WHERE "run" = ? AND "confirmation_decision" IS NULL ORDER BY rowid`).all(rev.run) as { id: string }[]).map((x) => x.id)
      : [];
    const approveBlockers = [
      ...unconfirmed.map((x) => `DESIGN_VERDICTS_UNCONFIRMED:${x}`),
      ...(check && check.outcome !== 'passed' ? [`DESIGN_CHECK_FAILED:${check.id}`] : []),
      ...disputed.map((i) => `DESIGN_INTERFACE_DISPUTED:${i}`),
      ...(r && r.status === 'rejected' ? [`SPEC_CHANGE_REJECTED:${r.seq}`] : []),
    ];
    const options = [
      { key: 'approve', label: 'Approve', consequence: 'The design is approved (assets you hold stay proposed); with its specification change, version n+1 is applied and the UI stages build once the covering checks are applied.', effect: { design_revision: rev.id, spec_version: manifest.spec_version }, blockers: approveBlockers },
      { key: 'revise', label: 'Revise', consequence: 'Back to a Designer session with your note; design_due is raised again with stage revise.', effect: { design_revision: rev.id } },
      { key: 'reject', label: 'Reject', consequence: 'The design is kept as history; the holds remain and design_due stays open.', effect: { design_revision: rev.id } },
      ...(rev.scope === 'asset_only'
        ? []
        : [
            {
              key: 'approve_without_criteria',
              label: 'Approve without criteria',
              consequence: 'The design is approved with no criteria in the specification; the absence is recorded on the revision and in every projection.',
              effect: { design_revision: rev.id, without_criteria: true },
              blockers: r && r.status === 'rejected' ? [] : [`SPEC_CHANGE_NOT_REJECTED:${r?.seq ?? 'none'}`],
            },
          ]),
    ];
    return {
      manifest,
      question: `Approve design version ${rev.version}${rev.scope === 'asset_only' ? ' (an asset-only revision)' : `, batched with specification change ${r?.seq}`}? ${mockups.length} mockup(s); ${narrowings.length > 0 ? `narrowed: ${narrowings.join('; ')}` : 'no narrowing'}.`,
      options,
      evidence: evidence as never,
    };
  },
  manifest: (tx, d) => {
    const rev = getRevision(tx.db, d.subject_id);
    return rev ? designManifest(tx.db, rev) : {};
  },
  reraise: true,
  answer(tx, d, option, note, _facts, extra?: AnswerExtra & { assets_held?: unknown }) {
    const rev = getRevision(tx.db, d.subject_id);
    if (!rev) throw notFound('design_revision', d.subject_id);
    const held = extra?.assets_held;
    if (held !== undefined) {
      const slots = new Set((parseJson<AssetManifest>(rev.asset_manifest)?.slots ?? []).map((s) => s.key));
      if (option !== 'approve' || !Array.isArray(held) || !held.every((h) => typeof h === 'string' && slots.has(h))) {
        throw new Refusal(400, 'invalid_value', '"assets_held" must be slot keys of the design\'s asset manifest, with approve.', 'Name the slots you hold, or leave it out.', { field: 'assets_held' });
      }
    }
    consumeDecision(tx, d, option, note);
    if (option === 'approve') {
      tx.db.prepare('UPDATE "design_revisions" SET "assets_held" = ? WHERE "id" = ?').run(JSON.stringify(held ?? []), rev.id);
      const approval = recordApproval(tx, d, { consequence: `design version ${rev.version} approved`, subjectType: 'design_revision', subjectId: rev.id });
      void approval;
      // An asset-only revision has no change to wait for (§6.4).
      if (rev.scope === 'asset_only') approveDesign(tx, { revision: rev.id, specRevision: null, withoutCriteria: false });
      return { ...consumed(d), effects: [{ kind: 'tick' }] };
    }
    if (option === 'approve_without_criteria') {
      recordApproval(tx, d, { consequence: `design version ${rev.version} approved without criteria`, subjectType: 'design_revision', subjectId: rev.id });
      approveDesign(tx, { revision: rev.id, specRevision: null, withoutCriteria: true });
      return { ...consumed(d), effects: [{ kind: 'tick' }] };
    }
    if (option === 'revise') {
      tx.db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "id" = ?`).run(rev.id);
      writeDueState(tx, rev.project, { ...designDueState(tx.db, rev.project), stage: 'revise', ...(note ? { note } : {}) });
      settleBatchRequest(tx, rev, 'the batched design was sent back for revision');
      tx.emit('design.rejected', { project: rev.project, design_revision: rev.id }, { option, note });
      return { ...consumed(d), effects: [{ kind: 'tick' }] };
    }
    tx.db.prepare(`UPDATE "design_revisions" SET "status" = 'rejected' WHERE "id" = ?`).run(rev.id);
    settleBatchRequest(tx, rev, 'the batched design was rejected');
    tx.emit('design.rejected', { project: rev.project, design_revision: rev.id }, { option, note });
    return { ...consumed(d), effects: [{ kind: 'tick' }] };
  },
};

export const DESIGN_VERDICTS_KEYS = ['review', 'review_blob', 'evidence'];

// ---- the effect (D7 §7.4, §6.4; E156 Q3) ------------------------------------------------------------

export function approveDesign(tx: Tx, args: { revision: string; specRevision: string | null; withoutCriteria: boolean; roadmap?: { blob: string; path: string; version: number; from_version: number } }): void {
  const rev = getRevision(tx.db, args.revision);
  if (!rev || rev.status !== 'proposed') return;
  const content = contentOf(rev);
  const prior = tx.db.prepare(`SELECT "id", "ready_at", "current_against_spec" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(rev.project) as
    | { id: string; ready_at: string | null; current_against_spec: string | null }
    | undefined;
  const latestSpec = (tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(rev.project) as { id: string } | undefined)?.id ?? null;
  const spec = args.specRevision !== null ? args.specRevision : rev.scope === 'asset_only' && prior?.current_against_spec ? prior.current_against_spec : latestSpec;
  // An asset-only revision changes no readiness (§6.4).
  const readyAt = args.withoutCriteria ? tx.at : rev.scope === 'asset_only' ? (prior?.ready_at ?? null) : null;
  tx.db.prepare(`UPDATE "design_revisions" SET "status" = 'superseded' WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') AND "id" <> ?`).run(rev.project, rev.id);
  tx.db
    .prepare(`UPDATE "design_revisions" SET "status" = ?, "approved_by" = ?, "approved_at" = ?, "current_against_spec" = ?, "ready_at" = ?, "supersedes" = ? WHERE "id" = ?`)
    .run(args.withoutCriteria ? 'approved_without_criteria' : 'approved', tx.actor.actor_kind, tx.at, spec, readyAt, prior?.id ?? null, rev.id);
  // The screens, and the slots as this revision holds them.
  for (const s of content?.screens.screens ?? []) {
    tx.db
      .prepare('INSERT OR IGNORE INTO "design_screens" ("id", "created_at", "design_revision", "key", "target", "requirements", "interfaces", "status") VALUES (?, ?, ?, ?, ?, ?, ?, \'current\')')
      .run(tx.newId('dscr_'), tx.at, rev.id, String(s.key), String(s.target), JSON.stringify(s.requirements ?? []), JSON.stringify(s.interfaces ?? []));
  }
  const held = new Set(parseJson<string[]>(rev.assets_held) ?? []);
  const manifest = parseJson<AssetManifest>(rev.asset_manifest);
  for (const slot of manifest?.slots ?? []) {
    tx.db
      .prepare(`INSERT OR IGNORE INTO "design_assets" ("id", "created_at", "design_revision", "slot", "slot_version", "kind", "platforms", "status", "provenance", "variants", "held") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        tx.newId('dast_'),
        tx.at,
        rev.id,
        slot.key,
        slot.slot_version,
        slot.kind,
        JSON.stringify(slot.platforms),
        slot.status === 'proposed' && !held.has(slot.key) ? 'approved' : slot.status,
        slot.provenance,
        JSON.stringify(slot.variants.map((v) => ({ name: v.name, format: v.format, digest: v.digest ?? null }))),
        held.has(slot.key) ? 1 : 0,
      );
  }
  const moved = moveEffective(tx, rev, manifest, held);
  // The human tests' assignment (E156 Q3), with the change's effect; an
  // asset-only revision keeps the one it supersedes.
  if (!args.withoutCriteria && rev.spec_change_request) assignHumanTests(tx, rev, args.roadmap ?? null);
  else if (rev.scope === 'asset_only' && prior) tx.db.prepare('UPDATE "design_revisions" SET "assignments" = (SELECT "assignments" FROM "design_revisions" WHERE "id" = ?) WHERE "id" = ?').run(prior.id, rev.id);
  bindStageScreens(tx, rev);
  // The native conventions the design leaves not checkable yet (§7.2, §7.3;
  // SEAM.md §494), each bound to its target's human-test requirement.
  recordNativeObligations(tx, rev);
  tx.emit('design.approved', { project: rev.project, design_revision: rev.id }, { version: rev.version, scope: rev.scope, status: args.withoutCriteria ? 'approved_without_criteria' : 'approved', spec_revision: spec, assets_held: [...held], narrowings: parseJson<string[]>(rev.narrowings) ?? [] });
  if (moved.length > 0) {
    tx.emit('design.assets_approved', { project: rev.project, design_revision: rev.id }, { moved });
    registerAssetUpdates(tx, rev, moved);
  }
  if (args.withoutCriteria) {
    tx.emit('design.ready', { project: rev.project, design_revision: rev.id }, { without_criteria: true });
    recordMetMilestones(tx, rev.project);
  }
}

// The effective set moved by an approval (§6.4): per selected slot and
// variant, the approved slot@version where the slot was proposed and not
// held, else what was effective (the placeholder or an earlier approval).
// Returns each move.
function moveEffective(tx: Tx, rev: RevisionRow, manifest: AssetManifest | null, held: Set<string>): { slot: string; variant: string; from_version: number | null; to_version: number }[] {
  if (!manifest) return [];
  const selection = parseJson<{ slots?: { kind: string; variants: string[] }[] }>(rev.selection);
  // A default kind the selection leaves out is narrowed away (§5.8: "slots
  // and variants only as selected"; SEAM.md §496); a kind the design adds
  // beyond the defaults (a banner, an illustration) is the design's own.
  const defaults = new Set((currentInventory(tx.db, rev.project)?.inventory.targets ?? []).flatMap((t) => t.required_slots.map((s) => s.kind)));
  const selected = (kind: string, variant: string): boolean => {
    const s = selection?.slots?.find((x) => x.kind === kind);
    if (s) return s.variants.includes(variant);
    return !(Array.isArray(selection?.slots) && defaults.has(kind));
  };
  const moved: { slot: string; variant: string; from_version: number | null; to_version: number }[] = [];
  for (const slot of manifest.slots) {
    for (const v of slot.variants) {
      const now = tx.db.prepare('SELECT * FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(rev.project, slot.key, v.name) as { slot_version: number; source: string } | undefined;
      if (!selected(slot.kind, v.name)) {
        if (now) tx.db.prepare('DELETE FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').run(rev.project, slot.key, v.name);
        continue;
      }
      const approve = slot.status === 'proposed' && !held.has(slot.key) && typeof v.file === 'string' && typeof v.digest === 'string';
      if (!approve) continue;
      if (now && now.source === 'approved' && now.slot_version === slot.slot_version) continue;
      tx.db.prepare('DELETE FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').run(rev.project, slot.key, v.name);
      tx.db
        .prepare(
          `INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms", "since_design_revision")
           VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)`,
        )
        .run(tx.newId('deff_'), tx.at, rev.project, slot.key, slot.kind, v.name, slot.slot_version, v.digest, v.format, rev.revision, v.file, JSON.stringify(slot.platforms), rev.id);
      moved.push({ slot: slot.key, variant: v.name, from_version: now?.slot_version ?? null, to_version: slot.slot_version });
    }
  }
  // A selected slot and variant with no effective row (narrowed away by an
  // earlier design, selected again by this one): its engine placeholder,
  // from the recorded inventory's manifest, is its effective version again
  // (§6.4: "else the slot's engine placeholder"; the slice-41 review's S3).
  const inv = currentInventory(tx.db, rev.project);
  for (const slot of parseJson<AssetManifest>(inv?.row.manifest ?? null)?.slots ?? []) {
    for (const v of slot.variants) {
      if (!selected(slot.kind, v.name) || typeof v.file !== 'string' || typeof v.digest !== 'string') continue;
      if (tx.db.prepare('SELECT 1 FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(rev.project, slot.key, v.name)) continue;
      tx.db
        .prepare(
          `INSERT INTO "design_effective_assets" ("id", "created_at", "project", "slot", "kind", "variant", "slot_version", "source", "digest", "format", "revision", "file", "platforms", "since_design_revision")
           VALUES (?, ?, ?, ?, ?, ?, ?, 'placeholder', ?, ?, ?, ?, ?, ?)`,
        )
        .run(tx.newId('deff_'), tx.at, rev.project, slot.key, slot.kind, v.name, slot.slot_version, v.digest, v.format, inv!.row.revision, v.file, JSON.stringify(slot.platforms), rev.id);
    }
  }
  return moved;
}

// The engine's assignment of the design's human tests (E156 Q3): a roadmap
// revision placing each in the phase holding its target's last UI stage.
function assignHumanTests(tx: Tx, rev: RevisionRow, file: { blob: string; path: string; version: number; from_version: number } | null): void {
  const assignments = humanTestAssignments(tx.db, rev).filter((a) => a.requirement !== null && a.phase !== null) as { target: string; requirement: string; phase: number }[];
  const all = humanTestAssignments(tx.db, rev);
  tx.db.prepare('UPDATE "design_revisions" SET "assignments" = ? WHERE "id" = ?').run(JSON.stringify(all), rev.id);
  if (assignments.length === 0) return;
  const road = tx.db.prepare('SELECT * FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(rev.project) as
    | { version: number; architecture_revision: string | null; git_path: string; git_blob: string; phases: string; moved_requirements: string | null }
    | undefined;
  if (!road) return;
  const phases = parseJson<{ number: number; requirement_ids: string[] }[]>(road.phases) ?? [];
  const moves: { key: string; from: number | null; to: number }[] = [];
  for (const a of assignments) {
    const ph = phases.find((p) => p.number === a.phase);
    if (!ph) continue;
    for (const p of phases) p.requirement_ids = p.requirement_ids.filter((k) => k !== a.requirement);
    ph.requirement_ids = [...ph.requirement_ids, a.requirement];
    const had = tx.db.prepare('SELECT "assigned_phase" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(rev.project, a.requirement) as { assigned_phase: number | null } | undefined;
    moves.push({ key: a.requirement, from: had?.assigned_phase ?? null, to: a.phase });
  }
  const id = tx.newId('road_');
  // The roadmap file the application's commit wrote (effects.ts): the next
  // version, derived from this one. A file written against another version
  // is not this assignment's: the store's revision then names the file as
  // it was, and the next Architect's roadmap places the tests.
  const written = file !== null && file.from_version === road.version && file.version === road.version + 1;
  tx.db
    .prepare('INSERT INTO "roadmap_revisions" ("id", "created_at", "project", "version", "architecture_revision", "git_path", "git_blob", "phases", "moved_requirements", "approved_by", "approved_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tx.at, rev.project, road.version + 1, road.architecture_revision, written ? file!.path : road.git_path, written ? file!.blob : road.git_blob, JSON.stringify(phases), JSON.stringify(moves), 'engine:design_approval', tx.at);
  for (const m of moves) tx.db.prepare('UPDATE "requirements" SET "assigned_phase" = ? WHERE "project" = ? AND "key" = ?').run(m.to, rev.project, m.key);
  // Each assignment bound to the roadmap and plan versions it was made against (E156 Q3).
  tx.db.prepare('UPDATE "design_revisions" SET "assignments" = ? WHERE "id" = ?').run(JSON.stringify(all.map((a) => (a.requirement !== null && a.phase !== null ? { ...a, roadmap_version: road.version + 1 } : a))), rev.id);
  tx.emit('baseline.roadmap_revised', { project: rev.project, roadmap_revision: id }, { version: road.version + 1, phases: phases.map((p) => p.number), design_revision: rev.id, approved_by: 'engine:design_approval', moved_requirements: moves });
}

// The stage-to-screen binding (D7 §8.1): design/stage-screens.ts.
export function bindStageScreens(tx: Tx, rev: RevisionRow): void {
  bindStageScreensTo(tx, { project: rev.project, revision: rev.id });
}

// D7 §5.3's "not checkable" column as A.2's NativeConvention, per target
// (SEAM.md §494): what only a running build of the target can show, web's
// browser back and keyboard path included; `permission_prompt` only where
// the target has a platform permission.
export const NOT_CHECKABLE_CONVENTIONS: Readonly<Record<string, readonly string[]>> = {
  web: ['browser_back', 'keyboard_path'],
  android: ['system_back', 'permission_prompt', 'touch_interaction'],
  ios: ['platform_navigation', 'safe_area', 'permission_prompt'],
  macos: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  windows: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
  linux: ['window_resize', 'menu_entries', 'keyboard_shortcuts'],
};

// The approval's native obligations (D7 §7.2, §7.3; A.3): one row per
// screen of the approved design and convention its target leaves not
// checkable yet, derived by the engine from the screens and the inventory
// (never from the design's own list, so none is dropped), each bound to
// the target's human-test requirement where the approval made one.
function recordNativeObligations(tx: Tx, rev: RevisionRow): void {
  const content = contentOf(rev);
  const inv = currentInventory(tx.db, rev.project)?.inventory ?? null;
  const assigned = new Map(((parseJson<{ target: string; requirement: string | null }[]>(getRevision(tx.db, rev.id)?.assignments ?? null) ?? []) as { target: string; requirement: string | null }[]).map((a) => [a.target, a.requirement]));
  const requirementId = (target: string): string | null => {
    const key = assigned.get(target) ?? null;
    if (key === null) return null;
    return (tx.db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(rev.project, key) as { id: string } | undefined)?.id ?? null;
  };
  for (const s of content?.screens.screens ?? []) {
    const target = String(s.target);
    const permitted = (inv?.targets ?? []).some((t) => t.target === target && t.permissions.length > 0);
    for (const convention of NOT_CHECKABLE_CONVENTIONS[target] ?? []) {
      if (convention === 'permission_prompt' && !permitted) continue;
      tx.db
        .prepare(
          `INSERT OR IGNORE INTO "design_native_obligations" ("id", "created_at", "project", "design_revision", "target", "screen", "convention", "status", "requirement") VALUES (?, ?, ?, ?, ?, ?, ?, 'not_checkable_yet', ?)`,
        )
        .run(tx.newId('dnob_'), tx.at, rev.project, rev.id, target, String(s.key), convention, requirementId(target));
    }
  }
}

// ---- asset_updated work and asset_version_changed obligations (D7 §6.5; G11, G14) ---------------------

function registerAssetUpdates(tx: Tx, rev: RevisionRow, moved: { slot: string; variant: string; from_version: number | null; to_version: number }[]): void {
  const slots = [...new Set(moved.map((m) => m.slot))];
  for (const slot of slots) {
    const m = moved.find((x) => x.slot === slot)!;
    // Every recorded binding of the slot, not superseded.
    const bindings = tx.db
      .prepare('SELECT "stage", "target", "path", "form" FROM "asset_bindings" WHERE "project" = ? AND "slot" = ? AND "superseded_by" IS NULL ORDER BY rowid')
      .all(rev.project, slot) as { stage: string | null; target: string; path: string; form: string }[];
    // A slot an integrated stage carried: bound, or carried and unbound.
    // (A stage's package carried the effective set when it was built under
    // the design: its work waited on design_ready.)
    const carried =
      bindings.length > 0 ||
      tx.db
        .prepare(
          `SELECT 1 FROM "stages" s JOIN "work_items" w ON w."id" = s."work_item" WHERE s."project" = ? AND s."status" IN ('integrated', 'verified')
             AND EXISTS (SELECT 1 FROM json_each(w."depends_on") j WHERE json_extract(j.value, '$.milestone') = 'design_ready') LIMIT 1`,
        )
        .get(rev.project) !== undefined;
    if (carried) {
      const candidate = tx.db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(rev.project) as { id: string } | undefined;
      observeTrigger(
        tx,
        {
          project: rev.project,
          kind: 'fix',
          trigger_source: 'asset_updated',
          trigger_id: `${rev.id}:${slot}`,
          trigger_generation: 1,
          subject: { cause: 'asset_updated', slot, from_version: m.from_version === null ? null : `${slot}@${m.from_version}`, to_version: `${slot}@${m.to_version}`, bindings, candidate: candidate?.id ?? null },
          chain: 0,
        },
        { design_revision: rev.id, slot },
      );
    }
    // Every check reading the slot owes a result of the new version (G14).
    const version = effectiveVersion(tx.db, rev.project);
    const generation = (tx.db.prepare('SELECT "spec_evidence_generation" AS g FROM "projects" WHERE "id" = ?').get(rev.project) as { g: number }).g;
    for (const c of version ? checksOfVersion(tx.db, version.id) : []) {
      const def = parseJson<{ asset_inputs?: { slot: string; variant: string }[] }>((tx.db.prepare('SELECT "definition" FROM "checks" WHERE "id" = ?').get(c.id) as { definition: string } | undefined)?.definition ?? null);
      if (!(def?.asset_inputs ?? []).some((a) => a.slot === slot)) continue;
      const id = tx.newId('obl_');
      tx.db
        .prepare(`INSERT INTO "check_obligations" ("id", "created_at", "project", "check", "key", "criteria", "generation", "reason", "request") VALUES (?, ?, ?, ?, ?, ?, ?, 'asset_version_changed', NULL)`)
        .run(id, tx.at, rev.project, c.id, c.key, JSON.stringify(parseJson<string[]>((c as { criteria?: string }).criteria ?? null) ?? []), generation);
      tx.emit('check.obligation_recorded', { project: rev.project, check_obligation: id }, { reason: 'asset_version_changed', slot, to_version: `${slot}@${m.to_version}`, check: c.key });
    }
  }
}

// ---- readiness (D7 §7.5) ---------------------------------------------------------------------------------

export function designReadiness(tx: Tx, project: string): string[] {
  const revs = tx.db.prepare(`SELECT * FROM "design_revisions" WHERE "project" = ? AND "status" = 'approved' AND "ready_at" IS NULL ORDER BY rowid`).all(project) as RevisionRow[];
  const out: string[] = [];
  for (const rev of revs) {
    const r = requestRow(tx.db, rev.spec_change_request);
    if (r && r.status !== 'approved') continue;
    if (r) {
      const open = tx.db
        .prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'spec_obligation' AND "trigger_id" = ? AND "status" NOT IN ('complete', 'cancelled') LIMIT 1`)
        .get(project, r.id);
      if (open) continue;
      if (tx.db.prepare(`SELECT 1 FROM "check_obligations" WHERE "request" = ? AND "reason" = 'spec_changed' AND "resolved_at" IS NULL LIMIT 1`).get(r.id)) continue;
      // Every criterion the change added is covered by a check of the
      // effective protected version.
      const impact = parseJson<{ added_criteria?: string[]; checks?: { uncovered?: string[] } }>(r.impact_value);
      const version = effectiveVersion(tx.db, project);
      const covered = new Set((version ? checksOfVersion(tx.db, version.id) : []).flatMap((c) => parseJson<string[]>((c as { criteria?: string }).criteria ?? null) ?? []));
      if ((impact?.checks?.uncovered ?? []).some((c) => !covered.has(c))) continue;
    }
    tx.db.prepare('UPDATE "design_revisions" SET "ready_at" = ? WHERE "id" = ? AND "ready_at" IS NULL').run(tx.at, rev.id);
    tx.emit('design.ready', { project, design_revision: rev.id }, { version: rev.version, spec_change_request: r?.id ?? null });
    out.push(rev.id);
  }
  if (out.length > 0) recordMetMilestones(tx, project);
  return out;
}

export { DESIGN_VERDICTS } from './review.js';

export type { Inventory };
void policyRevision;

// What the application's commit of a design's change writes into the
// roadmap file (E156 Q3): each human test's requirement moved to the phase
// holding its target's last UI stage, against the current roadmap version.
// null: nothing to assign (not a design's change, or no roadmap).
export function roadmapAssignment(db: Db, args: { request: string }): { path: string; version: number; moves: { requirement: string; phase: number }[] } | null {
  const rev = revisionOfRequest(db, args.request);
  if (!rev) return null;
  const road = db.prepare('SELECT "version", "git_path" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(rev.project) as { version: number; git_path: string } | undefined;
  if (!road) return null;
  const moves = humanTestAssignments(db, rev).filter((a) => a.requirement !== null && a.phase !== null).map((a) => ({ requirement: a.requirement!, phase: a.phase! }));
  if (moves.length === 0) return null;
  return { path: road.git_path || '.surety/roadmap/roadmap.json', version: road.version, moves };
}
