// The design's store operations, as the store worker exposes them (D7;
// store/worker.ts): its reads, its engine transitions and its API commands.

import type Database from 'better-sqlite3';

import type { CommandResult } from '../store/transitions/control.js';
import { parseJson } from '../store/transitions/common.js';
import { intendCommit } from '../store/transitions/accept.js';
import type { IntentResult } from '../store/transitions/journal.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import type { Tx } from '../store/transitions/tx.js';
import type { AssetManifest } from './assets.js';
import { inventoryAttempt, openRefused, reviewDesignDue, writeDueState } from './due.js';
import { designDueState } from './readiness.js';
import type { Inventory } from './inventory.js';
import { type InventoryRefInputs, inventoryDue, inventoryForPolicy, placeholderRecord, recordInventory } from './store.js';
import { answeredBatches, designBatchState, designReadiness, proposeDesign, releaseBatch, roadmapAssignment } from './approval.js';
import { checkContext, latestCheck, recordCheck } from './records.js';
import { designView } from './view.js';
import { designPackageFacts } from './package.js';
import { carriedEffective, recordCarried } from './asset-bindings.js';
import { exportFacts, previewFacts } from './preview-facts.js';
import { ownerReviewFacts, ownerReviewOfRun, releaseEvidenceRecords } from './owner-review.js';
import { reviewPackageFacts } from './review-package.js';
import { noteAlphaReview, notObservedScreens, observationsOf, recordObservation, reviewTarget } from './review.js';
import { approvedRevisionFacts, assetFacts, intendAsset, submitAssets } from './assets-submit.js';
import { bindingsView } from './asset-bindings.js';
import { completeAssetFixes, executionAssetFiles } from './asset-inputs.js';
import { raiseDeferredBatches } from '../spec/change.js';
import { beginPreview, interruptPreviews, intendPreviewOp, previewArtifact, previewDeployed, previewFailed, previewState, previewTornDown } from '../store/transitions/deploy.js';

type Db = Database.Database;

// The engine's intent commit of the inventory, with the branch's move to it
// as its follow-on (D7 §4.4), on the head the main thread read.
function intendInventory(
  tx: Tx,
  a: { project: string; repo: string; head: string; commit: { sha: string; tree: string; content: string }; digest: string; inventory: Inventory; manifest: AssetManifest; incarnation: string; deadlineSeconds: number },
): IntentResult {
  const p = projectRepoRow(tx, a.project);
  const ref = integrationRef(p.integration_branch);
  if (registryRow(tx, a.project, ref)?.expected_oid !== a.head) return { fenced: true };
  const finalizer: InventoryRefInputs = { purpose: 'design_inventory', ref, ref_kind: 'integration', new_oid: a.commit.sha, project: a.project, inventory_digest: a.digest, inventory: a.inventory, manifest: a.manifest, incarnation: a.incarnation };
  return intendCommit(tx, {
    project: a.project,
    repo: a.repo,
    purpose: 'design',
    tree: a.commit.tree,
    parent: a.head,
    sha: a.commit.sha,
    content: a.commit.content,
    revisionKind: 'intent',
    follow: {
      project: a.project,
      kind: 'ref_update',
      payload: { repo: a.repo, ref, old_oid: a.head, new_oid: a.commit.sha },
      target: { repo: a.repo, ref },
      subject: { design_inventory: a.digest, old_oid: a.head, new_oid: a.commit.sha },
      finalizer: finalizer as unknown as Record<string, unknown>,
      deadlineSeconds: a.deadlineSeconds,
    },
    deadlineSeconds: a.deadlineSeconds,
  });
}

export const DESIGN_READS: Record<string, (db: Db, args: any) => unknown> = {
  'design.inventory_due': (d, a: { project: string; incarnation: string; inFlight: boolean }) => inventoryDue(d, a),
  'design.inventory_for_policy': (d, a: { project: string; effective: Record<string, unknown> }) => inventoryForPolicy(d, a),
  'design.batch_state': (d, a: { request: string }) => designBatchState(d, a.request),
  'design.view': (d, a: { project: string }) => designView(d, a),
  'design.bindings': (d, a: { project: string }) => bindingsView(d, a),
  'design.approved_revision': (d, a: { project: string }) => approvedRevisionFacts(d, a),
  'design.asset_facts': (d, a: { project: string }) => assetFacts(d, a),
  'design.placeholder_record': (d, a: { project: string }) => placeholderRecord(d, a.project),
  'design.package_facts': (d, a: { run: string }) => designPackageFacts(d, a),
  'design.carried_effective': (d, a: { run: string }) => carriedEffective(d, a.run),
  'design.preview_facts': (d, a: { project: string; revision?: string }) => previewFacts(d, a),
  'design.preview_state': (d, a: { project: string; now?: string }) => previewState(d, a),
  'design.export_facts': (d, a: { project: string; revision?: string }) => exportFacts(d, a),
  'design.owner_review_facts': (d, a: { project: string; target: string }) => ownerReviewFacts(d, a),
  'design.review_target': (d, a: { project: string; run?: string }) => reviewTarget(d, a),
  'design.not_observed': (d, a: { project: string }) => notObservedScreens(d, a),
  'design.review_package_facts': (d, a: { run: string }) => reviewPackageFacts(d, a),
  'design.roadmap_assignment': (d, a: { request: string }) => roadmapAssignment(d, a),
  'design.run_facts': (d, a: { run: string }) => {
    const r = d.prepare('SELECT "project", "role", "session_notes" FROM "runs" WHERE "id" = ?').get(a.run) as { project: string; role: string; session_notes: string | null } | undefined;
    return r ? { project: r.project, role: r.role, mode: parseJson<{ mode?: string }>(r.session_notes)?.mode ?? null, owner_review: ownerReviewOfRun(d, a.run) } : null;
  },
  'design.observations': (d, a: { run: string }) => observationsOf(d, a),
  'design.open_requested': (d, a: { project: string }) => {
    const state = designDueState(d, a.project);
    return state.open_requested ? { decision: state.open_requested, mode: state.open_mode ?? null } : null;
  },
  'design.review_facts': (d, a: { project: string; run: string }) => {
    const rev = d.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(a.project) as { id: string } | undefined;
    const state = parseJson<{ stage?: string }>((d.prepare('SELECT "design_due" FROM "projects" WHERE "id" = ?').get(a.project) as { design_due: string | null }).design_due);
    const recorded = (d.prepare('SELECT "review_blob" FROM "design_reviews" WHERE "project" = ? AND "review_blob" IS NOT NULL').all(a.project) as { review_blob: string }[]).map((r) => r.review_blob);
    // An owner-invoked review is never the Alpha's (SEAM.md §522); every
    // other review-mode session is bound to the Alpha at its opening (S2).
    void state;
    return { design_revision: rev?.id ?? null, alpha_review: ownerReviewOfRun(d, a.run) === null, recorded };
  },
  'checks.asset_files': (d, a: { execution: string }) => executionAssetFiles(d, a),
  'design.answered_batches': (d, a: { decisions?: string[]; project?: string }) => answeredBatches(d, a),
  'design.check_context': (d, a: { project: string; run?: string }) => checkContext(d, a.project, a.run ?? null),
  'design.latest_check': (d, a: { project: string; run?: string }) => latestCheck(d, a),
  'design.session_mode': (d, a: { run: string }) => parseJson<{ mode?: string }>((d.prepare('SELECT "session_notes" FROM "runs" WHERE "id" = ?').get(a.run) as { session_notes: string | null } | undefined)?.session_notes ?? null)?.mode ?? null,
  // The findings a Designer session's turns returned (B.12).
  'design.session_findings': (d, a: { run: string }) =>
    (d.prepare('SELECT "reply" FROM "turns" WHERE "run" = ? ORDER BY "number"').all(a.run) as { reply: string | null }[]).flatMap((t) => parseJson<{ findings?: Record<string, unknown>[] }>(t.reply)?.findings ?? []),
  'design.repo_facts': (d, a: { project: string }) => {
    const p = d.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(a.project) as { dev_repo_path: string; integration_branch: string };
    const head = d.prepare(`SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?`).get(a.project, `refs/heads/${p.integration_branch}`) as { expected_oid: string } | undefined;
    return { repo: p.dev_repo_path, branch: p.integration_branch, head: head?.expected_oid ?? null };
  },
};

export const DESIGN_ENGINE_OPS: Record<string, (tx: Tx, args: any) => unknown> = {
  'design.intend_inventory': (tx, a) => intendInventory(tx, a),
  'design.intend_asset': (tx, a) => intendAsset(tx, a),
  'design.record_inventory': (tx, a: { id?: string; project?: string; digest?: string }) => {
    const id = a.id ?? (tx.db.prepare('SELECT "id" FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(a.project, a.digest) as { id: string } | undefined)?.id;
    return id ? recordInventory(tx, { id }) : { recorded: false };
  },
  'design.tick': (tx, a: { project: string }) => {
    // A batch held behind a correction, raised once it is applied (objection 166).
    raiseDeferredBatches(tx, a.project);
    designReadiness(tx, a.project);
    noteAlphaReview(tx, a.project);
    completeAssetFixes(tx, a.project);
    reviewDesignDue(tx, a.project);
    return {};
  },
  'design.release_batch': (tx, a: { revision: string }) => releaseBatch(tx, a),
  'design.open_cleared': (tx, a: { project: string; decision: string }) => {
    const state = designDueState(tx.db, a.project);
    if (state.open_requested !== a.decision) return { cleared: false };
    const { open_requested: _o, open_mode: _m, ...rest } = state;
    writeDueState(tx, a.project, rest);
    return { cleared: true };
  },
  'design.open_refused': (tx, a: { project: string; decision: string; reason: string }) => {
    openRefused(tx, a);
    return {};
  },
  'design.record_check': (tx, a) => recordCheck(tx, a),
  'design.propose': (tx, a) => proposeDesign(tx, a),
  'design.preview_begin': (tx, a) => beginPreview(tx, a),
  'design.inventory_attempt': (tx, a: { project: string; failure: string | null }) => inventoryAttempt(tx, a),
  'design.record_carried': (tx, a: { run: string; effective: unknown[] }) => recordCarried(tx, a),
  'design.preview_interrupt': (tx, a: { incarnation: string }) => interruptPreviews(tx, a),
  'design.record_observation': (tx, a) => recordObservation(tx, a),
  'design.release_evidence': (tx, a: { records: string[] }) => releaseEvidenceRecords(tx, a),
  'design.preview_artifact': (tx, a) => previewArtifact(tx, a),
  'design.preview_intend': (tx, a) => intendPreviewOp(tx, a),
  'design.preview_deployed': (tx, a) => previewDeployed(tx, a),
  'design.preview_failed': (tx, a) => previewFailed(tx, a),
  'design.preview_torn_down': (tx, a) => previewTornDown(tx, a),
};

export const DESIGN_COMMANDS: Record<string, (tx: Tx, args: any) => CommandResult> = {
  // The preview's answers (SEAM.md §488): what the main thread prepared, audited here.
  'design.preview_answer': (_tx, a: { status: number; body: Record<string, unknown> }) => ({ status: a.status, body: a.body }),
  'design.assets_submit': (tx, a) => submitAssets(tx, a),
  // The owner's asset added (SEAM.md §508): the main thread's answer, audited here.
  'design.asset_answer': (_tx, a: { status: number; body: Record<string, unknown> }) => ({ status: a.status, body: a.body }),
};
