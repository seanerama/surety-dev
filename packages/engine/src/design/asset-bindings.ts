// Asset bindings at integration (D7 §6.5; G15; B.17; SEAM.md §487): each
// binding a UI Builder's result declares is validated against the
// integrated tree (D1 §7.3's validation): its path exists
// (`ASSET_BINDING_PATH_MISSING`), it names a slot and variant of the
// effective set the package carried (`ASSET_BINDING_UNKNOWN_SLOT`), and a
// `copy` binding's file is the effective file byte for byte
// (`ASSET_BINDING_MISMATCH`). A failure refuses the integration. Valid
// bindings are recorded with the stage and the revision (`design.asset_bound`),
// an earlier binding of the same slot, variant and path superseded.

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { git, repoContext } from '../git/exec.js';
import { parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import { designPackageFacts } from './package.js';

export interface AssetBinding {
  slot: string;
  variant: string;
  target: string;
  path: string;
  form: 'copy' | 'derived';
}

// What a run's package carried of the effective set (null: no design).
export function carriedEffective(db: Database.Database, run: string): { slot: string; variant: string; slot_version: number; digest: string }[] | null {
  const f = designPackageFacts(db, { run });
  return f ? f.effective.map((e) => ({ slot: e.slot, variant: e.variant, slot_version: e.slot_version, digest: e.digest })) : null;
}

// The main thread's validation against the tree to integrate: null when
// every binding holds, else the refusal's text naming the code.
export async function validateBindings(repo: string, tree: string, bindings: AssetBinding[], carried: { slot: string; variant: string; slot_version: number; digest: string }[] | null): Promise<string | null> {
  for (const b of bindings) {
    const e = (carried ?? []).find((x) => x.slot === b.slot && x.variant === b.variant);
    if (!e) return `ASSET_BINDING_UNKNOWN_SLOT: the binding of ${b.path} names ${b.slot}/${b.variant}, which is not a slot and variant of the effective set this run's package carried`;
    const r = await git(repoContext(repo), ['cat-file', 'blob', `${tree}:${b.path}`]);
    if (r.code !== 0) return `ASSET_BINDING_PATH_MISSING: the binding names ${b.path}, which is not a file of the integrated tree`;
    if (b.form === 'copy') {
      const digest = createHash('sha256').update(r.bytes).digest('hex');
      if (digest !== e.digest) return `ASSET_BINDING_MISMATCH: ${b.path} is not the effective file of ${b.slot}/${b.variant} (${b.slot}@${e.slot_version}): its digest is ${digest}, the effective file's ${e.digest}`;
    }
  }
  return null;
}

// The bindings recorded with the stage and the integrated revision.
export function recordBindings(tx: Tx, args: { project: string; run: string; work_item: string; stage: string | null; revision: string; bindings: (AssetBinding & { slot_version: number })[] }): void {
  for (const b of args.bindings) {
    // A fix's binding belongs to the stage that bound the path first.
    const stage =
      args.stage ??
      (tx.db.prepare('SELECT "stage" FROM "asset_bindings" WHERE "project" = ? AND "path" = ? AND "target" = ? AND "stage" IS NOT NULL ORDER BY rowid LIMIT 1').get(args.project, b.path, b.target) as { stage: string } | undefined)?.stage ??
      null;
    const id = tx.newId('abd_');
    const prior = tx.db.prepare('SELECT "id" FROM "asset_bindings" WHERE "project" = ? AND "slot" = ? AND "variant" = ? AND "path" = ? AND "superseded_by" IS NULL').all(args.project, b.slot, b.variant, b.path) as { id: string }[];
    tx.db
      .prepare(
        `INSERT INTO "asset_bindings" ("id", "created_at", "project", "stage", "work_item", "revision", "target", "slot", "variant", "path", "form", "source_slot_version", "declared_by")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builder')`,
      )
      .run(id, tx.at, args.project, stage, args.work_item, args.revision, b.target, b.slot, b.variant, b.path, b.form, b.slot_version);
    for (const p of prior) tx.db.prepare('UPDATE "asset_bindings" SET "superseded_by" = ? WHERE "id" = ?').run(id, p.id);
    tx.emit('design.asset_bound', { project: args.project, asset_binding: id, ...(stage ? { stage } : {}) }, { slot: b.slot, variant: b.variant, target: b.target, path: b.path, form: b.form, slot_version: b.slot_version, run: args.run, revision: args.revision });
  }
}

export const bindingsOfResult = (resultValue: string | null): AssetBinding[] => {
  const v = parseJson<{ asset_bindings?: AssetBinding[]; report?: { asset_bindings?: AssetBinding[] } }>(resultValue);
  return v?.report?.asset_bindings ?? v?.asset_bindings ?? [];
};
