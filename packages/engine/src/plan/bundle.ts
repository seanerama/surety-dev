// The prospective bundle and its publication (D6 §3.4, §5.5; B02, B03, B08;
// K4; SEAM.md §§346, 347): what an Architect's close binds (the approved spec
// version and integration head, every proposed blob, the versions
// publication will allocate), its mechanical check recorded as a
// plan_check, the consolidated `architecture_approval` + `plan_approval`
// under one batch_key, and the authorized finalizer that publishes the
// bundle exactly once, re-comparing the head and the open plan at
// publication (`plan_generation_stale`). The bundle's id is the id of the
// record the close wrote with its content (A.3 `phase_plans.bundle →records`).
// A checkpoint invokes none of this; `finalizeIntegration` registers nothing
// from one (B02).

import { Refusal } from '../refusal.js';
import { type BundleArtifacts, type BundleBaseline, type PlanCheckResult, checkPlan, executionInputsDigest } from './check.js';
import type { AdrFrontMatter, ModuleMap, PhasePlanFile, Roadmap } from './schemas.js';
import { ensureBaselineTexts, ensureModules, moduleIds, requirementIds } from '../store/transitions/baseline.js';
import { illegal, notFound } from '../store/transitions/common.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { policyRevision } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { registerPlan } from '../store/transitions/work.js';
import { markStale } from '../store/transitions/evidence.js';
import type { SpecRepresentation } from '../spec/semantics.js';

type Db = Tx['db'];

export interface BundleRow {
  id: string;
  project: string;
  run: string | null;
  spec_revision: string | null;
  head: string;
  phase_number: number | null;
  blobs: string;
  artifacts: string;
  versions: string;
  plan_check: string | null;
  batch_key: string | null;
  approvals: string;
  status: 'proposed' | 'published' | 'stale' | 'refused';
  published_at: string | null;
}

// The versions publication will allocate (SEAM.md §346): `phase_plan` null
// for an architecture-only bundle.
export interface BundleVersions {
  architecture: number;
  roadmap: number;
  phase_plan: number | null;
}

// The parsed artifacts a bundle carries (plan/schemas.ts), as the store
// keeps them for publication. `plan` null for an architecture-only bundle;
// `roadmap` null when the bundle changes no roadmap and none is approved yet.
export interface BundleContent {
  modules: ModuleMap;
  roadmap: Roadmap | null;
  roadmap_changed: boolean;
  plan: PhasePlanFile | null;
  adrs: Record<string, { text: string; status: string; supersedes?: string }>;
  architecture_text: string | null;
}

export function getBundle(db: Db, id: string): BundleRow | undefined {
  return db.prepare('SELECT * FROM "plan_bundles" WHERE "id" = ?').get(id) as BundleRow | undefined;
}

// The bundle of a session's close (the decisions are about the run).
export function bundleOfRun(db: Db, run: string): BundleRow | undefined {
  return db.prepare(`SELECT * FROM "plan_bundles" WHERE "run" = ? AND "status" IN ('proposed', 'published', 'stale') ORDER BY "created_at" DESC LIMIT 1`).get(run) as BundleRow | undefined;
}

// ---- the baseline a bundle is checked against (D6 §3.4, §5.3) --------------------------

export interface BaselineFacts {
  baseline: BundleBaseline;
  spec_revision: string | null;
  spec_version: number;
  versions: BundleVersions;
  // Whether the bundle's roadmap.json differs from the approved roadmap (or
  // none is approved): a roadmap version is allocated only then.
  roadmap_changed: boolean;
  // The next phase (D6 §5.2) and the open plan, if one.
  phase: number;
  open_plan: { id: string; phase_number: number; generation: number } | null;
  architecture_revision: string | null;
  roadmap_revision: string | null;
  requirement_keys: string[];
  spec_modules: { name: string; sensitive_areas: string[] }[];
}

// What the store holds for the check: the approved spec revision and its
// requirements (with the questions that block them, from its semantics), the
// head the check compares `prepared_against` with, the versions to allocate,
// the phases complete, and the approved architecture artifacts if any.
// `head` is what a plan's `prepared_against.revision` must name: the head the
// session started from (its run's base), since the plan file is itself in
// the session's checkpoint. `roadmapBlob` is the bundle's roadmap.json blob:
// a roadmap version is allocated only when it differs from the approved one.
export function bundleBaselineFacts(db: Db, args: { project: string; head: string; withPlan: boolean; roadmapBlob?: string | null }): BaselineFacts {
  const p = db.prepare('SELECT "id", "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; tier: string } | undefined;
  if (!p) throw notFound('project', args.project);
  const spec = db.prepare('SELECT "id", "version", "semantics" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string; version: number; semantics: string | null } | undefined;
  let representation: SpecRepresentation | null = null;
  if (spec?.semantics) {
    const row = db.prepare('SELECT "representation" FROM "spec_semantics" WHERE "id" = ?').get(spec.semantics) as { representation: string | null } | undefined;
    try {
      representation = row?.representation ? (JSON.parse(row.representation) as SpecRepresentation) : null;
    } catch {
      representation = null;
    }
  }
  const blocked = new Map((representation?.requirements ?? []).map((r) => [r.key, r.blocked_by_questions]));
  const requirements = (
    db.prepare('SELECT "key", "criteria", "sensitive_areas", "withdrawn_at" FROM "requirements" WHERE "project" = ? ORDER BY "key"').all(args.project) as { key: string; criteria: string | null; sensitive_areas: string; withdrawn_at: string | null }[]
  ).map((r) => ({
    key: r.key,
    criteria: r.criteria === null ? [] : (JSON.parse(r.criteria) as string[]),
    sensitive_areas: JSON.parse(r.sensitive_areas) as string[],
    withdrawn: r.withdrawn_at !== null,
    blocked_by_questions: blocked.get(r.key) ?? [],
  }));
  const arch = db.prepare('SELECT "id", "version", "module_map", "blobs" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string; version: number; module_map: string; blobs: string } | undefined;
  const road = db.prepare('SELECT "id", "version", "phases", "git_blob" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as
    | { id: string; version: number; phases: string; git_blob: string }
    | undefined;
  const completed = (db.prepare(`SELECT "phase_number" FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed' ORDER BY "phase_number"`).all(args.project) as { phase_number: number }[]).map((r) => r.phase_number);
  const open = (db.prepare(`SELECT "id", "phase_number", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' ORDER BY "created_at" DESC LIMIT 1`).get(args.project) as { id: string; phase_number: number; generation: number } | undefined) ?? null;
  const phase = (completed.at(-1) ?? 0) + 1;
  const roadmapChanged = !road || (args.roadmapBlob !== undefined && args.roadmapBlob !== null && args.roadmapBlob !== road.git_blob);
  const versions: BundleVersions = { architecture: (arch?.version ?? 0) + 1, roadmap: roadmapChanged ? (road?.version ?? 0) + 1 : road!.version, phase_plan: args.withPlan ? 1 : null };
  let approved: BundleBaseline['approved'] = null;
  if (arch && road) {
    const adrs = (db.prepare(`SELECT "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' ORDER BY "key"`).all(args.project) as { key: string; text: string }[]).reduce<Record<string, string>>((o, a) => ({ ...o, [a.key]: a.text }), {});
    const archText = (db.prepare(`SELECT "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'constraint' AND "key" = 'architecture' LIMIT 1`).get(args.project) as { text: string } | undefined)?.text ?? null;
    approved = { modules: JSON.parse(arch.module_map) as ModuleMap, roadmap: { version: road.version, architecture_version: arch.version, phases: JSON.parse(road.phases) as Roadmap['phases'] }, adrs, architecture_text: archText };
  }
  const specModules = (representation?.modules ?? []).map((m) => ({ name: m.name, sensitive_areas: m.sensitive_areas }));
  return {
    baseline: {
      spec_version: spec?.version ?? 0,
      requirements,
      architecture_version: versions.architecture,
      roadmap_version: versions.roadmap,
      head: args.head,
      project_tier: p.tier,
      completed_phases: completed,
      approved,
    },
    spec_revision: spec?.id ?? null,
    spec_version: spec?.version ?? 0,
    versions,
    roadmap_changed: roadmapChanged,
    phase,
    open_plan: open,
    architecture_revision: arch?.id ?? null,
    roadmap_revision: road?.id ?? null,
    requirement_keys: requirements.filter((r) => !r.withdrawn).map((r) => r.key),
    spec_modules: specModules,
  };
}

// ---- the record of a close (D6 §3.4) -----------------------------------------------------

export interface RecordBundleArgs {
  project: string;
  run: string;
  // The record id the main thread wrote with the bundle's content: the
  // bundle's id (A.3 →records).
  bundle: string;
  // The planned obligations as a record, the check's inline too.
  obligations_record: string | null;
  head: string;
  phase: number | null;
  blobs: Record<string, string>;
  content: BundleContent;
  check: PlanCheckResult | null;
  spec_revision: string | null;
  versions: BundleVersions;
}

// The plan check recorded (when the bundle carries a plan) and the bundle
// `proposed`. The check must have passed: a refused check refuses the close
// before anything is recorded (sessions/driver.ts).
export function recordBundle(tx: Tx, args: RecordBundleArgs): { bundle: string; plan_check: string | null } {
  if (getBundle(tx.db, args.bundle)) throw illegal('recording a bundle twice', { plan_bundle: args.bundle });
  // The check and the bundle name each other: their keys are checked at commit.
  tx.db.pragma('defer_foreign_keys = ON');
  let check: string | null = null;
  if (args.check) {
    check = tx.newId('pchk_');
    const c = args.check;
    tx.db
      .prepare(
        `INSERT INTO "plan_checks" ("id", "created_at", "project", "bundle", "plan", "phase_number", "outcome", "reasons", "conformance", "changes_architecture", "changes_adrs", "changes_roadmap",
           "changes_goals", "roadmap_revision", "needs_spec_change", "routing", "planned_obligations", "obligations", "evidence")
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        check,
        tx.at,
        args.project,
        args.bundle,
        args.phase,
        c.outcome,
        JSON.stringify(c.reasons),
        c.conformance,
        JSON.stringify(c.changes.changes_architecture),
        JSON.stringify(c.changes.changes_adrs),
        JSON.stringify(c.changes.changes_roadmap),
        c.changes_goals ? 1 : 0,
        c.roadmap_revision ? 1 : 0,
        c.needs_spec_change ? 1 : 0,
        c.outcome === 'passed' ? c.routing : null,
        args.obligations_record,
        JSON.stringify(c.planned_obligations),
      );
    tx.emit('plan.checked', { project: args.project, plan_bundle: args.bundle, plan_check: check }, { phase: args.phase, outcome: c.outcome, reasons: c.reasons.map((r) => r.code), routing: c.routing, run: args.run });
    if (c.outcome === 'refused') tx.emit('baseline.plan_refused', { project: args.project, plan_bundle: args.bundle }, { phase: args.phase, reasons: c.reasons });
  }
  tx.db
    .prepare(
      `INSERT INTO "plan_bundles" ("id", "created_at", "project", "run", "spec_revision", "head", "phase_number", "blobs", "artifacts", "versions", "plan_check", "batch_key", "approvals", "status")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(args.bundle, tx.at, args.project, args.run, args.spec_revision, args.head, args.phase, JSON.stringify(args.blobs), JSON.stringify(args.content), JSON.stringify(args.versions), check, args.bundle, args.check?.outcome === 'refused' ? 'refused' : 'proposed');
  return { bundle: args.bundle, plan_check: check };
}

// What the approvals are bound to (D1 §4.6; contract/decisions.json): the
// head as registered now (a save since the preview stales the answer), the
// approved spec version, the bundle, its blobs and versions, the policy.
export function bundleManifest(db: Db, run: string, kind: 'architecture_approval' | 'plan_approval'): Record<string, unknown> {
  const b = bundleOfRun(db, run);
  const runRow = db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(run) as { project: string } | undefined;
  const project = runRow?.project ?? b?.project ?? null;
  const head = project === null ? null : (headOf(db, project) ?? null);
  const spec = project === null ? null : ((db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number } | undefined)?.version ?? null);
  const base = { run, baseline_revision: head, spec_version: spec, bundle: b?.id ?? null, blobs: b ? (JSON.parse(b.blobs) as unknown) : null, versions: b ? (JSON.parse(b.versions) as unknown) : null, bundle_status: b?.status ?? null, policy_revision: project === null ? null : policyRevision(db, project) };
  if (kind === 'plan_approval') return { ...base, plan_check: b?.plan_check ?? null, plan_generation: b?.phase_number === null ? null : 1 };
  return base;
}

function headOf(db: Db, project: string): string | undefined {
  const p = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as { integration_branch: string } | undefined;
  if (!p) return undefined;
  return (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid;
}

// One approval of the pair consumed (D6 §3.4): recorded on the bundle; the
// last one publishes. A `reject` on either refuses the bundle.
export function approveBundlePart(tx: Tx, args: { run: string; kind: 'architecture_approval' | 'plan_approval'; decision: string; option: 'approve' | 'reject' }): { published: boolean; plan: string | null; bundle: string } {
  const b = bundleOfRun(tx.db, args.run);
  if (!b) throw notFound('plan_bundle', args.run);
  if (b.status !== 'proposed') throw illegal(`answering an approval of a ${b.status} bundle`, { plan_bundle: b.id });
  const approvals = JSON.parse(b.approvals) as Record<string, string>;
  if (args.option === 'reject') {
    tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'refused', "stale_reason" = ? WHERE "id" = ?`).run(`rejected by ${args.kind} ${args.decision}`, b.id);
    tx.emit('baseline.plan_refused', { project: b.project, plan_bundle: b.id }, { phase: b.phase_number, rejected_by: args.decision, kind: args.kind });
    return { published: false, plan: null, bundle: b.id };
  }
  approvals[args.kind] = args.decision;
  tx.db.prepare('UPDATE "plan_bundles" SET "approvals" = ? WHERE "id" = ?').run(JSON.stringify(approvals), b.id);
  const needsPlan = b.phase_number !== null;
  if (!approvals.architecture_approval || (needsPlan && !approvals.plan_approval)) return { published: false, plan: null, bundle: b.id };
  const made = publishBundle(tx, { bundle: b.id, by: 'human' });
  return { published: true, plan: made.plan, bundle: b.id };
}

// The authorized publication (D6 §5.5; B02): once, after the authority
// exists; the head and the open plan compared again; then, in this one
// transaction, the architecture revision, the module map, the ADR texts,
// the roadmap revision, the requirements' phases and the plan with its
// stages and work. A mismatch leaves the bundle `stale`
// (`plan_generation_stale`), never current.
export function publishBundle(tx: Tx, args: { bundle: string; by: string }): { plan: string | null; architecture_revision: string; roadmap_revision: string | null } {
  const b = getBundle(tx.db, args.bundle);
  if (!b) throw notFound('plan_bundle', args.bundle);
  if (b.status === 'published') throw illegal('publishing a bundle twice', { plan_bundle: b.id });
  if (b.status !== 'proposed') throw illegal(`publishing a ${b.status} bundle`, { plan_bundle: b.id });
  const p = projectRepoRow(tx, b.project);
  const head = registryRow(tx, b.project, integrationRef(p.integration_branch));
  const stale = (why: string): never => {
    tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'stale', "stale_reason" = ? WHERE "id" = ?`).run(why, b.id);
    tx.emit('plan.generation_refused', { project: b.project, plan_bundle: b.id }, { phase: b.phase_number, cause: why });
    throw new Refusal(409, 'plan_generation_stale', `The bundle ${b.id} cannot be published: ${why}.`, 'The proposal is stale, not current; a new Architect session or replan proposes again.', { plan_bundle: b.id, phase: b.phase_number });
  };
  if (!head || head.expected_oid !== b.head) stale(`the integration head moved from ${b.head} to ${head?.expected_oid ?? 'none'} since the bundle was checked`);
  const spec = tx.db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { id: string } | undefined;
  if ((spec?.id ?? null) !== b.spec_revision) stale('the approved specification changed since the bundle was checked');
  const versions = JSON.parse(b.versions) as BundleVersions;
  const arch = tx.db.prepare('SELECT "version" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { version: number } | undefined;
  if ((arch?.version ?? 0) + 1 !== versions.architecture) stale(`architecture version ${versions.architecture} is no longer the next`);
  const open = tx.db.prepare(`SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published'`).get(b.project) as { id: string } | undefined;
  if (b.phase_number !== null && open) stale(`a plan (${open.id}) was published first`);
  const content = JSON.parse(b.artifacts) as BundleContent;
  const blobs = JSON.parse(b.blobs) as Record<string, string>;
  const approvals = JSON.parse(b.approvals) as Record<string, string>;

  // The architecture revision and the module map (D6 §3.3; O6).
  const archId = tx.newId('arch_');
  tx.db
    .prepare('INSERT INTO "architecture_revisions" ("id", "created_at", "project", "version", "spec_revision", "blobs", "module_map", "mapping_from_spec", "approved_by", "approved_at", "decision") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(archId, tx.at, b.project, versions.architecture, b.spec_revision, JSON.stringify(blobs), JSON.stringify(content.modules), JSON.stringify(content.modules.mapping_from_spec), args.by, tx.at, approvals.architecture_approval ?? null);
  ensureModules(tx, { project: b.project, modules: content.modules.modules.map((m) => ({ name: m.name, paths: m.paths, sensitive_areas: m.sensitive_areas, tier_override: m.tier_override ?? null })) });
  // The ADR texts the packages carry, refreshed at approval (D6 §3.5; N03).
  const adrItems = Object.entries(content.adrs).map(([key, a]) => ({ key, text: a.text }));
  ensureBaselineTexts(tx, { project: b.project, kind: 'adr', items: adrItems });
  for (const item of adrItems) tx.db.prepare(`UPDATE "baseline_texts" SET "text" = ? WHERE "project" = ? AND "kind" = 'adr' AND "key" = ?`).run(item.text, b.project, item.key);
  if (content.architecture_text !== null) {
    ensureBaselineTexts(tx, { project: b.project, kind: 'constraint', items: [{ key: 'architecture', text: content.architecture_text }] });
    tx.db.prepare(`UPDATE "baseline_texts" SET "text" = ? WHERE "project" = ? AND "kind" = 'constraint' AND "key" = 'architecture'`).run(content.architecture_text, b.project);
  }
  tx.emit('baseline.architecture_approved', { project: b.project, architecture_revision: archId }, { version: versions.architecture, bundle: b.id, approved_by: args.by });

  // The roadmap revision and the requirements' phases (D6 §5.1), when the
  // bundle carries one or changes it.
  let roadId: string | null = null;
  const existingRoad = tx.db.prepare('SELECT "id", "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { id: string; version: number } | undefined;
  if (content.roadmap && (content.roadmap_changed || !existingRoad)) {
    roadId = tx.newId('road_');
    const version = (existingRoad?.version ?? 0) + 1;
    tx.db
      .prepare('INSERT INTO "roadmap_revisions" ("id", "created_at", "project", "version", "architecture_revision", "git_path", "git_blob", "phases", "moved_requirements", "approved_by", "approved_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roadId, tx.at, b.project, version, archId, '.surety/roadmap/roadmap.json', blobs['.surety/roadmap/roadmap.json'] ?? '', JSON.stringify(content.roadmap.phases), content.roadmap.moved_requirements ? JSON.stringify(content.roadmap.moved_requirements) : null, args.by, tx.at);
    for (const ph of content.roadmap.phases) {
      for (const key of ph.requirement_ids) tx.db.prepare('UPDATE "requirements" SET "assigned_phase" = ? WHERE "project" = ? AND "key" = ?').run(ph.number, b.project, key);
    }
    tx.emit('baseline.roadmap_revised', { project: b.project, roadmap_revision: roadId }, { version, phases: content.roadmap.phases.map((p2) => p2.number), bundle: b.id });
  } else roadId = existingRoad?.id ?? null;

  // The plan (K4), by the one production function.
  let planId: string | null = null;
  if (content.plan) {
    const plan = content.plan;
    const obligations = b.plan_check ? (tx.db.prepare('SELECT "planned_obligations" FROM "plan_checks" WHERE "id" = ?').get(b.plan_check) as { planned_obligations: string | null }).planned_obligations : null;
    const made = registerPlan(
      tx,
      {
        project: b.project,
        baseRevision: b.head,
        authority: { kind: 'publication', by: args.by === 'human' ? 'human' : 'engine:plan_check', bundle: b.id, check: b.plan_check, routing: args.by === 'human' ? 'human' : 'registered' },
        phase: plan.phase,
        gitPath: `.surety/phases/phase-${plan.phase}.json`,
        chain: 0,
        prepared: { spec: b.spec_revision, architecture: archId, roadmap: roadId },
        plannedObligations: obligations,
        stages: plan.stages.map((s, i) => ({
          number: s.number,
          goal: s.goal,
          implements: requirementIds(tx, b.project, s.implements, `stages[${i}].implements`),
          modules: moduleIds(tx, b.project, s.modules, `stages[${i}].modules`),
          tasks: s.tasks,
          depends_on: s.depends_on,
          validation: s.validation,
          integration_obligations: s.integration_obligations,
          adrs: s.adrs,
          conformance: s.conformance === true,
          execution_inputs_digest: executionInputsDigest(s),
        })),
      },
      {},
    );
    planId = made.plan.id;
    if (b.plan_check) tx.db.prepare('UPDATE "plan_checks" SET "plan" = ? WHERE "id" = ?').run(planId, b.plan_check);
    tx.emit('baseline.plan_approved', { project: b.project, phase_plan: planId, plan_bundle: b.id }, { phase: plan.phase, generation: made.plan.generation, approved_by: args.by, routing: 'human' });
  }
  tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'published', "published_at" = ? WHERE "id" = ?`).run(tx.at, b.id);
  markStale(tx, { project: b.project });
  return { plan: planId, architecture_revision: archId, roadmap_revision: roadId };
}

// The check of a bundle's artifacts against the baseline (a pure call; the
// main thread reads the blobs, the store supplies the baseline).
export function checkBundle(facts: BaselineFacts, artifacts: BundleArtifacts): PlanCheckResult {
  return checkPlan(facts.baseline, artifacts);
}

export type { AdrFrontMatter };
