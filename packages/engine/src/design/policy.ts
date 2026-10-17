// What the design reads of a project (D7 §2, §4, §8.1): its `design`
// policy, the approved module map and which modules are `ui`, the UI stages
// of its published plans, and the facts the inventory is derived from. Pure
// reads over the store; nothing here writes.

import type { Database } from 'better-sqlite3';

import { parseJson } from '../store/transitions/common.js';
import { projectEffective } from '../store/transitions/settings.js';
import type { ModuleMap } from '../plan/schemas.js';
import type { SpecRepresentation } from '../spec/semantics.js';
import { liveRepresentation } from '../spec/semantics.js';
import type { InventoryInputs } from './inventory.js';

export type DesignPolicy = 'off' | 'before_build' | 'at_alpha' | 'both';

export function designPolicyOf(db: Database, project: string): DesignPolicy {
  const v = (projectEffective(db, project) as Record<string, unknown>).design;
  return v === 'before_build' || v === 'at_alpha' || v === 'both' ? v : 'off';
}

// Whether the policy holds UI stages before build (D7 §2: before_build, both).
export const holdsBeforeBuild = (p: DesignPolicy): boolean => p === 'before_build' || p === 'both';

// The approved module map (the latest architecture revision's), or null.
export function approvedModuleMap(db: Database, project: string): { id: string; version: number; map: ModuleMap } | null {
  const row = db.prepare('SELECT "id", "version", "module_map", "mapping_from_spec" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as
    | { id: string; version: number; module_map: string; mapping_from_spec: string }
    | undefined;
  if (!row) return null;
  const parsed = parseJson<ModuleMap | ModuleMap['modules']>(row.module_map);
  if (parsed === null) return null;
  // The revision records the map as written: the file's object, or its
  // modules array (M5 recorded either).
  const map = Array.isArray(parsed) ? ({ version: 1, modules: parsed, mapping_from_spec: parseJson<ModuleMap['mapping_from_spec']>(row.mapping_from_spec) ?? [] } as ModuleMap) : parsed;
  if (!Array.isArray(map.modules)) return null;
  return { id: row.id, version: row.version, map };
}

// The names of the map's `ui` modules (D7 §4.1, §8.1).
export function uiModuleNames(map: ModuleMap | null): Set<string> {
  return new Set((map?.modules ?? []).filter((m) => m.surface === 'ui').map((m) => m.name));
}

// A stage's module names (stages record module ids; a name is kept as a name).
export function stageModuleNames(db: Database, project: string, modulesJson: string): string[] {
  const ids = parseJson<string[]>(modulesJson) ?? [];
  return ids.map((id) => (db.prepare('SELECT "name" FROM "modules" WHERE "project" = ? AND ("id" = ? OR "name" = ?)').get(project, id, id) as { name: string } | undefined)?.name ?? id);
}

// A stage's implemented requirement keys (stages record requirement ids).
export function stageRequirementKeys(db: Database, project: string, implementsJson: string): string[] {
  const ids = parseJson<string[]>(implementsJson) ?? [];
  return ids.map((id) => (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(project, id, id) as { key: string } | undefined)?.key ?? id);
}

// Whether a stage is a UI stage: any of its modules has `surface: ui` (D7 §8.1).
export function isUiStage(db: Database, project: string, stage: { modules: string }, map?: ModuleMap | null): boolean {
  const ui = uiModuleNames(map === undefined ? (approvedModuleMap(db, project)?.map ?? null) : map);
  if (ui.size === 0) return false;
  return stageModuleNames(db, project, stage.modules).some((m) => ui.has(m));
}

// The approved specification's representation (the latest revision's).
export function approvedSpec(db: Database, project: string): { id: string; version: number; rep: SpecRepresentation } | null {
  const row = db.prepare('SELECT v."id", v."version", s."representation" FROM "spec_revisions" v LEFT JOIN "spec_semantics" s ON s."id" = v."semantics" WHERE v."project" = ? ORDER BY v."version" DESC LIMIT 1').get(project) as
    | { id: string; version: number; representation: string | null }
    | undefined;
  if (!row) return null;
  const rep = liveRepresentation(parseJson<SpecRepresentation>(row.representation));
  return rep ? { id: row.id, version: row.version, rep } : null;
}

// The published (or completed) plans' stages, active generation only.
export function publishedStages(db: Database, project: string): { id: string; number: number; phase: number; modules: string; implements: string; work_item: string | null; phase_plan: string }[] {
  return db
    .prepare(
      `SELECT s."id", s."number", p."phase_number" AS "phase", s."modules", s."implements", s."work_item", s."phase_plan" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan"
       WHERE s."project" = ? AND p."active" = 1 AND p."status" IN ('published', 'completed') AND s."cancelled_at" IS NULL ORDER BY p."phase_number", s."number"`,
    )
    .all(project) as { id: string; number: number; phase: number; modules: string; implements: string; work_item: string | null; phase_plan: string }[];
}

// The requirement keys a design's own spec changes added as human tests:
// never UI requirements of the inventory (D7 §7.4).
export function designHumanTestKeys(db: Database, project: string): string[] {
  const rows = db.prepare(`SELECT "impact_value" FROM "spec_change_requests" WHERE "project" = ? AND "source" IN ('design', 'design_review') AND "status" IN ('proposed', 'approved')`).all(project) as { impact_value: string | null }[];
  const added = new Set<string>();
  for (const r of rows) for (const q of parseJson<{ requirements?: { key: string; changes: string[] }[] }>(r.impact_value)?.requirements ?? []) if (q.changes.includes('added')) added.add(q.key);
  const human = new Set((db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND "human_test" = 1').all(project) as { key: string }[]).map((r) => r.key));
  return [...added].filter((k) => human.has(k)).sort();
}

// What the inventory is derived from (D7 §4.2), or why it cannot be.
export function inventoryInputs(db: Database, project: string, opts: { rep?: SpecRepresentation; exclude?: string[]; options?: Record<string, unknown> } = {}): InventoryInputs | { unknown: string } {
  const spec = approvedSpec(db, project);
  if (!spec && !opts.rep) return { unknown: 'no approved specification' };
  const arch = approvedModuleMap(db, project);
  if (!arch) return { unknown: 'no approved architecture' };
  const rep = opts.rep ?? spec!.rep;
  const reqRows = new Map(
    (db.prepare('SELECT "key", "assigned_phase", "human_test", "withdrawn_at" FROM "requirements" WHERE "project" = ?').all(project) as { key: string; assigned_phase: number | null; human_test: number; withdrawn_at: string | null }[]).map((r) => [r.key, r]),
  );
  const requirements = rep.requirements
    .filter((q) => q.withdrawn !== true)
    .map((q) => ({ key: q.key, phase: reqRows.get(q.key)?.assigned_phase ?? q.phase_hint ?? null, human_test: q.human_test, surface: q.surface ?? null, surface_targets: q.surface_targets ?? null }));
  const stages = publishedStages(db, project).map((s) => ({ modules: stageModuleNames(db, project, s.modules), implements: stageRequirementKeys(db, project, s.implements) }));
  const adrs = (db.prepare(`SELECT "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' ORDER BY "key"`).all(project) as { key: string; text: string }[]).map((a) => ({ key: a.key, text: a.text }));
  const env = rep.environments[0];
  const runtime = env?.fields['Runtime and start command'] ?? null;
  const options = opts.options ?? (projectEffective(db, project) as Record<string, unknown>);
  const widths = Array.isArray(options.design_widths) ? (options.design_widths as number[]) : [360, 720, 1280];
  const orientations = Array.isArray(options.design_orientations) ? (options.design_orientations as string[]) : ['portrait', 'landscape'];
  return {
    spec_version: spec?.version ?? null,
    architecture_version: arch.version,
    spec_targets: rep.targets ?? null,
    cross_platform: rep.cross_platform === true,
    requirements,
    modules: arch.map,
    stages,
    adrs,
    runtime: runtime ? runtime.replace(/`/g, '') : null,
    policy: { design_preview: typeof options.design_preview === 'string' ? options.design_preview : 'static', design_widths: widths, design_orientations: orientations },
    exclude: opts.exclude ?? designHumanTestKeys(db, project),
  };
}
