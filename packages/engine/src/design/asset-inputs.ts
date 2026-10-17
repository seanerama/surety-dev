// A check's asset inputs (D7 §6.5; G14; SEAM.md §487): a check whose
// definition names `asset_inputs` is given the effective file of each slot
// and variant, read-only, at `SURETY_ASSET_<SLOT>_<VARIANT>` in its domain.
// The slot@version is fixed when the execution is registered (never a held
// or proposed file: the effective set only), and its result records it. A
// passing result of the current versions resolves the check's
// `asset_version_changed` obligations.

import type Database from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import { getWorkItem, transitionWork } from '../store/transitions/work.js';
import { getCandidate, heldByAncestry } from '../store/transitions/evidence.js';
import { assetFixStages } from './asset-bindings.js';

export interface AssetInput {
  slot: string;
  variant: string;
  slot_version: number;
}

export const assetVariable = (slot: string, variant: string): string => `SURETY_ASSET_${`${slot}_${variant}`.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

// The inputs an execution of `check` is given now, or null when its
// definition names none.
export function assetInputsFor(db: Database.Database, project: string, check: string): AssetInput[] | null {
  const def = parseJson<{ asset_inputs?: { slot: string; variant: string }[] }>((db.prepare('SELECT "definition" FROM "checks" WHERE "id" = ?').get(check) as { definition: string | null } | undefined)?.definition ?? null);
  const wanted = def?.asset_inputs ?? [];
  if (wanted.length === 0) return null;
  return wanted.map((w) => {
    const e = db.prepare('SELECT "slot_version" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(project, w.slot, w.variant) as { slot_version: number } | undefined;
    return { slot: w.slot, variant: w.variant, slot_version: e?.slot_version ?? 0 };
  });
}

// Fixed on a registered execution.
export function stampAssetInputs(tx: Tx, execution: string, project: string, check: string): void {
  const inputs = assetInputsFor(tx.db, project, check);
  if (inputs !== null) tx.db.prepare('UPDATE "check_executions" SET "asset_inputs" = ? WHERE "id" = ?').run(JSON.stringify(inputs), execution);
}

// What the runner places for an execution: each input's effective file
// (the revision and the file under `.surety/design/` that hold its bytes),
// when it is still the version the execution was registered with.
export function executionAssetFiles(db: Database.Database, args: { execution: string }): { repo: string; files: (AssetInput & { revision: string; file: string; format: string; digest: string })[] | null; missing: string | null } {
  const x = db.prepare('SELECT "project", "asset_inputs" FROM "check_executions" WHERE "id" = ?').get(args.execution) as { project: string; asset_inputs: string | null } | undefined;
  const repo = x ? (db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(x.project) as { dev_repo_path: string }).dev_repo_path : '';
  const inputs = parseJson<AssetInput[]>(x?.asset_inputs ?? null);
  if (!x || inputs === null) return { repo, files: null, missing: null };
  const files: (AssetInput & { revision: string; file: string; format: string; digest: string })[] = [];
  for (const i of inputs) {
    const e = db.prepare('SELECT "slot_version", "revision", "file", "format", "digest" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(x.project, i.slot, i.variant) as
      | { slot_version: number; revision: string; file: string; format: string; digest: string }
      | undefined;
    if (!e) return { repo, files: null, missing: `${i.slot}/${i.variant} has no effective file` };
    files.push({ ...i, slot_version: e.slot_version, revision: e.revision, file: e.file, format: e.format, digest: e.digest });
  }
  return { repo, files, missing: null };
}

// A result recorded: its execution's inputs on it; a pass of the current
// versions resolves the check's open `asset_version_changed` obligations.
export function recordResultAssets(tx: Tx, args: { result: string; execution: string | null; project: string; exit_status: number | null }): void {
  if (args.execution === null) return;
  const x = tx.db.prepare('SELECT "key", "asset_inputs" FROM "check_executions" WHERE "id" = ?').get(args.execution) as { key: string; asset_inputs: string | null } | undefined;
  if (!x || x.asset_inputs === null) return;
  tx.db.prepare('UPDATE "check_results" SET "asset_inputs" = ? WHERE "id" = ?').run(x.asset_inputs, args.result);
  if (args.exit_status !== 0) return;
  const inputs = parseJson<AssetInput[]>(x.asset_inputs) ?? [];
  const current = inputs.every((i) => {
    const e = tx.db.prepare('SELECT "slot_version" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(args.project, i.slot, i.variant) as { slot_version: number } | undefined;
    return e !== undefined && e.slot_version === i.slot_version;
  });
  if (!current) return;
  const open = tx.db.prepare(`SELECT "id" FROM "check_obligations" WHERE "project" = ? AND "key" = ? AND "reason" = 'asset_version_changed' AND "resolved_at" IS NULL`).all(args.project, x.key) as { id: string }[];
  for (const o of open) {
    tx.db.prepare('UPDATE "check_obligations" SET "resolved_by" = ?, "resolved_at" = ? WHERE "id" = ?').run(args.result, tx.at, o.id);
    tx.emit('check.obligation_resolved', { project: args.project, check_obligation: o.id }, { resolved_by: args.result, how: 'asset_result', inputs });
  }
}

// Whether a result's asset inputs are the effective versions now (D7 §6.5;
// G14): a result that read none is not about assets; one naming a slot whose
// effective version has moved (or that has none) is about an older version.
export function assetInputsCurrent(db: Database.Database, project: string, inputs: string | null): boolean {
  const list = parseJson<AssetInput[]>(inputs);
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.every((i) => {
    const e = db.prepare('SELECT "slot_version" FROM "design_effective_assets" WHERE "project" = ? AND "slot" = ? AND "variant" = ?').get(project, i.slot, i.variant) as { slot_version: number } | undefined;
    return e !== undefined && e.slot_version === i.slot_version;
  });
}

// An `asset_updated` fix (D7 §6.5) is verified as any work is, by the gate:
// every stage it answers to (its bindings' stages and the stages that
// carried its slot) has a satisfied, current stage gate on a candidate that
// holds it, and every check reading its slot has passed with the new
// slot@version (its `asset_version_changed` obligations resolved). A fix
// has no finding whose resolution would end it.
export function completeAssetFixes(tx: Tx, project: string): void {
  const fixes = tx.db.prepare(`SELECT "id", "subject" FROM "work_items" WHERE "project" = ? AND "kind" = 'fix' AND "status" = 'verifying' AND json_extract("subject", '$.cause') = 'asset_updated' ORDER BY "seq"`).all(project) as { id: string; subject: string }[];
  for (const f of fixes) {
    const subject = parseJson<{ slot?: string; bindings?: unknown }>(f.subject) ?? {};
    const slot = subject.slot;
    if (typeof slot !== 'string') continue;
    const open = (tx.db.prepare(`SELECT o."id", c."definition" FROM "check_obligations" o LEFT JOIN "checks" c ON c."id" = o."check" WHERE o."project" = ? AND o."reason" = 'asset_version_changed' AND o."resolved_at" IS NULL`).all(project) as { id: string; definition: string | null }[]).filter((o) =>
      (parseJson<{ asset_inputs?: { slot: string }[] }>(o.definition)?.asset_inputs ?? []).some((a) => a.slot === slot),
    );
    if (open.length > 0) continue;
    const stages = assetFixStages(tx.db, project, subject);
    // No stage to answer to: never completed by an empty condition. Held,
    // naming why, for the owner to resume or cancel (the review's note).
    if (stages.length === 0) {
      const item = getWorkItem(tx, f.id);
      if (item) transitionWork(tx, item, 'held', { blocker: JSON.stringify({ reason: 'asset_fix_ungated', slot, why: 'no integrated UI stage carried or binds this slot: no stage gate can verify the fix' }) }, { cause: 'asset_updated', slot, reason: 'asset_fix_ungated' });
      continue;
    }
    const gated = stages.every((stage) =>
      (tx.db.prepare(`SELECT "candidate" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'stage' AND "stage" = ? AND "outcome" = 'satisfied' AND "stale" = 0 ORDER BY rowid DESC`).all(project, stage) as { candidate: string }[]).some((e) => {
        const c = getCandidate(tx.db, e.candidate);
        return c !== undefined && heldByAncestry(tx.db, c).includes(f.id);
      }),
    );
    if (!gated) continue;
    const item = getWorkItem(tx, f.id);
    if (item) transitionWork(tx, item, 'complete', {}, { cause: 'asset_updated', slot });
  }
}
