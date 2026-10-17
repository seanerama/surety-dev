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
import { reviewDesignDue } from './due.js';
import type { Inventory } from './inventory.js';
import { type InventoryRefInputs, inventoryDue, inventoryForPolicy, recordInventory } from './store.js';
import { answeredBatches, designBatchState, designReadiness, proposeDesign, releaseBatch } from './approval.js';
import { checkContext, latestCheck, recordCheck } from './records.js';
import { designView } from './view.js';
import { designPackageFacts } from './package.js';
import { carriedEffective } from './asset-bindings.js';
import { previewFacts } from './preview-facts.js';
import { noteAlphaReview, observationsOf, recordObservation, reviewTarget } from './review.js';
import { submitAssets } from './assets-submit.js';
import { completeAssetFixes, executionAssetFiles } from './asset-inputs.js';
import { beginPreview, intendPreviewOp, previewArtifact, previewDeployed, previewFailed, previewState, previewTornDown } from '../store/transitions/deploy.js';

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
  'design.package_facts': (d, a: { run: string }) => designPackageFacts(d, a),
  'design.carried_effective': (d, a: { run: string }) => carriedEffective(d, a.run),
  'design.preview_facts': (d, a: { project: string; revision?: string }) => previewFacts(d, a),
  'design.preview_state': (d, a: { project: string }) => previewState(d, a),
  'design.review_target': (d, a: { project: string }) => reviewTarget(d, a),
  'design.run_facts': (d, a: { run: string }) => {
    const r = d.prepare('SELECT "project", "role", "session_notes" FROM "runs" WHERE "id" = ?').get(a.run) as { project: string; role: string; session_notes: string | null } | undefined;
    return r ? { project: r.project, role: r.role, mode: parseJson<{ mode?: string }>(r.session_notes)?.mode ?? null } : null;
  },
  'design.observations': (d, a: { run: string }) => observationsOf(d, a),
  'design.review_facts': (d, a: { project: string; run: string }) => {
    const rev = d.prepare(`SELECT "id" FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(a.project) as { id: string } | undefined;
    const state = parseJson<{ stage?: string }>((d.prepare('SELECT "design_due" FROM "projects" WHERE "id" = ?').get(a.project) as { design_due: string | null }).design_due);
    const recorded = (d.prepare('SELECT "review_blob" FROM "design_reviews" WHERE "project" = ? AND "review_blob" IS NOT NULL').all(a.project) as { review_blob: string }[]).map((r) => r.review_blob);
    return { design_revision: rev?.id ?? null, alpha_review: state?.stage === 'alpha_review', recorded };
  },
  'checks.asset_files': (d, a: { execution: string }) => executionAssetFiles(d, a),
  'design.answered_batches': (d, a: { decisions?: string[]; project?: string }) => answeredBatches(d, a),
  'design.check_context': (d, a: { project: string }) => checkContext(d, a.project),
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
  'design.record_inventory': (tx, a: { id?: string; project?: string; digest?: string }) => {
    const id = a.id ?? (tx.db.prepare('SELECT "id" FROM "design_inventories" WHERE "project" = ? AND "inventory_digest" = ?').get(a.project, a.digest) as { id: string } | undefined)?.id;
    return id ? recordInventory(tx, { id }) : { recorded: false };
  },
  'design.tick': (tx, a: { project: string }) => {
    designReadiness(tx, a.project);
    noteAlphaReview(tx, a.project);
    completeAssetFixes(tx, a.project);
    reviewDesignDue(tx, a.project);
    return {};
  },
  'design.release_batch': (tx, a: { revision: string }) => releaseBatch(tx, a),
  'design.record_check': (tx, a) => recordCheck(tx, a),
  'design.propose': (tx, a) => proposeDesign(tx, a),
  'design.preview_begin': (tx, a) => beginPreview(tx, a),
  'design.record_observation': (tx, a) => recordObservation(tx, a),
  'design.preview_artifact': (tx, a) => previewArtifact(tx, a),
  'design.preview_intend': (tx, a) => intendPreviewOp(tx, a),
  'design.preview_deployed': (tx, a) => previewDeployed(tx, a),
  'design.preview_failed': (tx, a) => previewFailed(tx, a),
  'design.preview_torn_down': (tx, a) => previewTornDown(tx, a),
};

export const DESIGN_COMMANDS: Record<string, (tx: Tx, args: any) => CommandResult> = {
  // The preview's answers (SEAM.md §488): what the main thread prepared, audited here.
  'design.preview_answer': (_tx, a: { status: number; body: Record<string, unknown> }) => ({ status: a.status, body: a.body }),
  'design.assets_submit': (tx, a: { project: string }) => submitAssets(tx, a),
};
