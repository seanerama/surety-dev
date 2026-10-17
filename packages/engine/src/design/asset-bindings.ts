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
import { notFound, parseJson } from '../store/transitions/common.js';
import type { Tx } from '../store/transitions/tx.js';
import { designPackageFacts } from './package.js';
import { approvedModuleMap, stageModuleNames } from './policy.js';

export interface AssetBinding {
  slot: string;
  variant: string;
  target: string;
  path: string;
  form: 'copy' | 'derived';
}

// What a run's package carried of the effective set, as recorded when the
// package was built (the slice-40 review's m4: an approval moving the set
// while the Builder runs changes nothing it was given); null: no design. A
// run whose package recorded nothing (an earlier build) is read as now.
export function carriedEffective(db: Database.Database, run: string): { slot: string; variant: string; slot_version: number; digest: string }[] | null {
  const row = db.prepare('SELECT "effective" FROM "design_package_carried" WHERE "run" = ?').get(run) as { effective: string } | undefined;
  if (row) return parseJson<{ slot: string; variant: string; slot_version: number; digest: string }[]>(row.effective);
  const f = designPackageFacts(db, { run });
  return f ? f.effective.map((e) => ({ slot: e.slot, variant: e.variant, slot_version: e.slot_version, digest: e.digest })) : null;
}

// The effective set a run's package was built with, recorded (the latest
// package of the run is what its result answers to).
export function recordCarried(tx: Tx, args: { run: string; effective: unknown[] }): void {
  tx.db
    .prepare('INSERT INTO "design_package_carried" ("run", "created_at", "effective") VALUES (?, ?, ?) ON CONFLICT ("run") DO UPDATE SET "effective" = excluded."effective", "created_at" = excluded."created_at"')
    .run(args.run, tx.at, JSON.stringify(args.effective));
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

// The integrated UI stages and what their Builders' packages carried of the
// effective set (D7 §6.5; SEAM.md §508): each stage integrated or verified,
// its targets, and every slot and variant a package of a run of its work
// carried (the record made when the package was built).
export function stagesCarried(db: Database.Database, project: string): { stage: string; targets: string[]; carried: { slot: string; variant: string }[] }[] {
  const map = approvedModuleMap(db, project)?.map ?? null;
  const stages = db.prepare(`SELECT "id", "modules", "work_item" FROM "stages" WHERE "project" = ? AND "status" IN ('integrated', 'verified') AND "work_item" IS NOT NULL ORDER BY rowid`).all(project) as { id: string; modules: string; work_item: string }[];
  const out: { stage: string; targets: string[]; carried: { slot: string; variant: string }[] }[] = [];
  for (const st of stages) {
    const rows = db.prepare(`SELECT c."effective" FROM "design_package_carried" c JOIN "runs" r ON r."id" = c."run" WHERE r."work_item" = ? ORDER BY c.rowid`).all(st.work_item) as { effective: string }[];
    if (rows.length === 0) continue;
    const carried = new Map<string, { slot: string; variant: string }>();
    for (const r of rows) for (const e of parseJson<{ slot: string; variant: string }[]>(r.effective) ?? []) carried.set(`${e.slot}/${e.variant}`, { slot: e.slot, variant: e.variant });
    const modules = stageModuleNames(db, project, st.modules);
    const targets = [...new Set((map?.modules ?? []).filter((m) => m.surface === 'ui' && modules.includes(m.name)).flatMap((m) => (m.targets ?? []).map((t) => t.target)))];
    out.push({ stage: st.id, targets, carried: [...carried.values()] });
  }
  return out;
}

// GET …/design's `unbound` (D7 §6.5; SEAM.md §508): each slot and variant an
// integrated UI stage's package carried and no current binding of that stage
// (or of a fix that bound it since) names, per target of the stage the slot
// applies to.
export function unboundAssets(db: Database.Database, project: string): { slot: string; variant: string; target: string; stage: string }[] {
  const platforms = new Map(
    (db.prepare('SELECT "slot", "variant", "platforms" FROM "design_effective_assets" WHERE "project" = ?').all(project) as { slot: string; variant: string; platforms: string }[]).map((e) => [`${e.slot}/${e.variant}`, parseJson<string[]>(e.platforms) ?? []]),
  );
  const current = db.prepare('SELECT "stage", "target", "slot", "variant" FROM "asset_bindings" WHERE "project" = ? AND "superseded_by" IS NULL').all(project) as { stage: string | null; target: string; slot: string; variant: string }[];
  const out: { slot: string; variant: string; target: string; stage: string }[] = [];
  for (const st of stagesCarried(db, project)) {
    for (const c of st.carried) {
      const on = platforms.get(`${c.slot}/${c.variant}`);
      for (const target of st.targets.filter((t) => on === undefined || on.includes(t))) {
        if (current.some((b) => (b.stage === st.stage || b.stage === null) && b.target === target && b.slot === c.slot && b.variant === c.variant)) continue;
        out.push({ slot: c.slot, variant: c.variant, target, stage: st.stage });
      }
    }
  }
  return out;
}

// The stages an `asset_updated` fix answers to (D7 §6.5: "the gate waits on
// the asset_updated candidate's results as on any obligation"): the stages
// of the bindings it updates and every integrated UI stage whose package
// carried its slot. Their stage gates are evaluated on its candidate.
export function assetFixStages(db: Database.Database, project: string, subject: { slot?: unknown; bindings?: unknown }): string[] {
  const bound = (Array.isArray(subject.bindings) ? (subject.bindings as { stage?: unknown }[]) : []).map((b) => b.stage).filter((s): s is string => typeof s === 'string');
  const all = stagesCarried(db, project);
  const carried = typeof subject.slot === 'string' ? all.filter((s) => s.carried.some((c) => c.slot === subject.slot)).map((s) => s.stage) : [];
  const stages = [...new Set([...bound, ...carried])];
  if (stages.length > 0) return stages;
  // Bindings a fix recorded before any stage did (their stage null): the
  // integrated UI stages serving their targets.
  const targets = new Set((Array.isArray(subject.bindings) ? (subject.bindings as { target?: unknown }[]) : []).map((b) => b.target).filter((t): t is string => typeof t === 'string'));
  return all.filter((s) => s.targets.some((t) => targets.has(t))).map((s) => s.stage);
}

// Whether any integrated UI stage's package carried `slot`.
export const slotCarried = (db: Database.Database, project: string, slot: string): boolean => stagesCarried(db, project).some((s) => s.carried.some((c) => c.slot === slot));

// GET /v1/projects/:p/design/bindings (D7 A.8; SEAM.md §508): every binding
// by insertion, superseded ones included.
export function bindingsView(db: Database.Database, args: { project: string }): { bindings: Record<string, unknown>[] } {
  if (!db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  const bindings = db
    .prepare('SELECT "id", "created_at", "stage", "work_item", "revision", "target", "slot", "variant", "path", "form", "source_slot_version", "declared_by", "superseded_by" FROM "asset_bindings" WHERE "project" = ? ORDER BY rowid')
    .all(args.project) as Record<string, unknown>[];
  return { bindings };
}
