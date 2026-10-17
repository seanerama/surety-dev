// `surety design assets submit --project <p>` (D7 §6.4; SEAM.md §§487, 508):
// the pending proposals submitted for approval on their own. The main
// thread (asset-commands.ts) read the asset-only tree (the approved
// revision's design with the head's assets) and ran the design check; here
// the check is recorded (`design.checked`), an asset-only design revision
// proposed with every slot it holds (each pending proposal `proposed`, a slot
// held at an earlier approval included), and a design_approval raised alone,
// with no specification change and no criteria blocker. Approved, the
// effective set moves to each new slot@version (approval.ts), the bound
// paths get an asset_updated fix and every check reading a moved slot owes
// a result of it. No screen goes stale and no readiness changes.
//
// Also the owner's asset commit's store side: its intent, its finalizer
// (`design.asset_added`), and the facts its preparation reads.

import type Database from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { parseJson } from '../store/transitions/common.js';
import type { CommandResult } from '../store/transitions/control.js';
import { intendCommit } from '../store/transitions/accept.js';
import type { IntentResult } from '../store/transitions/journal.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { projectEffective } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { type DesignContent, type RevisionRow, proposeDesign } from './approval.js';
import type { AssetManifest } from './assets.js';
import type { DesignReason } from './check.js';
import { recordCheck } from './records.js';

const approvedRow = (db: Database.Database, project: string): RevisionRow | undefined =>
  db.prepare(`SELECT * FROM "design_revisions" WHERE "project" = ? AND "status" IN ('approved', 'approved_without_criteria') ORDER BY rowid DESC LIMIT 1`).get(project) as RevisionRow | undefined;

// What the submit's preparation reads of the approved revision.
export function approvedRevisionFacts(db: Database.Database, args: { project: string }): { id: string; version: number; blobs: Record<string, string>; content: Record<string, unknown> | null } | null {
  const r = approvedRow(db, args.project);
  return r ? { id: r.id, version: r.version, blobs: parseJson<Record<string, string>>(r.blobs) ?? {}, content: parseJson<Record<string, unknown>>(r.content) } : null;
}

// The pending proposals of a manifest: each slot `proposed` whose
// slot@version and digests the effective set does not hold from an approval.
export function pendingProposals(db: Database.Database, project: string, manifest: AssetManifest): string[] {
  const out: string[] = [];
  for (const slot of manifest.slots ?? []) {
    if (slot.status !== 'proposed') continue;
    const rows = db.prepare(`SELECT "variant", "slot_version", "digest" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "source" = 'approved'`).all(project, slot.key) as { variant: string; slot_version: number; digest: string }[];
    const withFiles = slot.variants.filter((v) => typeof v.digest === 'string');
    const effective = withFiles.length > 0 && withFiles.every((v) => rows.some((e) => e.variant === v.name && e.slot_version === slot.slot_version && e.digest === v.digest));
    if (!effective) out.push(slot.key);
  }
  return out;
}

export function submitAssets(
  tx: Tx,
  args: { project: string; revision: string; tree: string | null; blobs: Record<string, string>; content: DesignContent; inventory_digest: string | null; outcome: 'passed' | 'refused'; reasons: DesignReason[] },
): CommandResult {
  const approved = approvedRow(tx.db, args.project);
  if (!approved) throw new Refusal(409, 'no_approved_design', 'This project has no approved design whose assets could be submitted.', 'Approve a design first.', { project: args.project });
  const open = tx.db
    .prepare(`SELECT d."id" FROM "decisions" d JOIN "design_revisions" r ON r."id" = d."subject_id" WHERE d."kind" = 'design_approval' AND d."status" = 'open' AND r."project" = ? LIMIT 1`)
    .get(args.project) as { id: string } | undefined;
  if (open) throw new Refusal(409, 'decision_open', 'A design_approval of this project is open.', 'Answer it first.', { project: args.project, decision: open.id });
  const pending = pendingProposals(tx.db, args.project, args.content.manifest);
  if (pending.length === 0) throw new Refusal(409, 'no_assets_pending', `No asset of this project is proposed and not approved: there is nothing to submit.`, 'Hold an asset at an approval, or add one with surety design asset add, then submit.', { project: args.project, design_revision: approved.id });
  if (args.outcome !== 'passed') {
    throw new Refusal(422, 'design_check_failed', `The design with the submitted assets does not pass the design check: ${args.reasons.map((r) => r.code).join(', ')}. Nothing was raised.`, 'Correct the assets (surety design asset add) and submit again.', { project: args.project, reasons: args.reasons });
  }
  const check = recordCheck(tx, { project: args.project, run: null, revision: args.revision, inventory_digest: args.inventory_digest, outcome: args.outcome, reasons: args.reasons, blobs: args.blobs });
  const made = proposeDesign(tx, {
    project: args.project,
    run: null,
    revision: args.revision,
    tree: args.tree,
    blobs: args.blobs,
    content: args.content,
    check: check.id,
    findings: [],
    scope: 'asset_only',
  });
  const decision = tx.db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'design_approval' AND "subject_id" = ? AND "status" = 'open' ORDER BY rowid DESC LIMIT 1`).get(made.revision) as { id: string } | undefined;
  return { status: 201, body: { design_revision: made.revision, scope: 'asset_only', assets: pending, design_check: check.id, decision: decision?.id ?? null } };
}

// ---- the owner's asset commit (D7 §6.3; SEAM.md §508) ---------------------------------------------

// What the owner's asset commit reads: the design version a proposal is
// made at (the current approved revision's, else 0) and the project's policy.
export function assetFacts(db: Database.Database, args: { project: string }): { design_version: number; policy: Record<string, unknown> } {
  return { design_version: approvedRow(db, args.project)?.version ?? 0, policy: projectEffective(db, args.project) as Record<string, unknown> };
}

export interface AssetRefInputs {
  purpose: 'design_asset';
  ref: string;
  ref_kind: 'integration';
  new_oid: string;
  project: string;
  asset: { slot: string; variant: string; slot_version: number; digest: string; file: string; format: string };
  manifest: AssetManifest;
}

// The engine's intent commit of the owner's file, with the branch's move to
// it as its follow-on, on the head the main thread read.
export function intendAsset(
  tx: Tx,
  a: { project: string; repo: string; head: string; commit: { sha: string; tree: string; content: string }; asset: AssetRefInputs['asset']; manifest: AssetManifest; deadlineSeconds: number },
): IntentResult {
  const p = projectRepoRow(tx, a.project);
  const ref = integrationRef(p.integration_branch);
  if (registryRow(tx, a.project, ref)?.expected_oid !== a.head) return { fenced: true };
  const finalizer: AssetRefInputs = { purpose: 'design_asset', ref, ref_kind: 'integration', new_oid: a.commit.sha, project: a.project, asset: a.asset, manifest: a.manifest };
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
      subject: { design_asset: `${a.asset.slot}@${a.asset.slot_version}`, old_oid: a.head, new_oid: a.commit.sha },
      finalizer: finalizer as unknown as Record<string, unknown>,
      deadlineSeconds: a.deadlineSeconds,
    },
    deadlineSeconds: a.deadlineSeconds,
  });
}

// The branch moved to the owner's file: `design.asset_added`, carrying the
// manifest it committed (the base of the version rules until the next
// approval, SEAM.md §505).
export function finalizeAssetRef(tx: Tx, op: { id: string; project: string }, inputs: AssetRefInputs): Record<string, unknown> {
  tx.emit('design.asset_added', { project: op.project }, { ...inputs.asset, status: 'proposed', provenance: 'owner', revision: inputs.new_oid, manifest: inputs.manifest });
  return { design_asset: `${inputs.asset.slot}@${inputs.asset.slot_version}` };
}
