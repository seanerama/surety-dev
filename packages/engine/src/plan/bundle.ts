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

import { designAssignedHumanTests, designPolicyOf } from '../design/policy.js';
import { designHumanCriteria } from '../design/criterion-map.js';
import { approvedDesignScreens } from '../design/stage-screens.js';
import { requestsFromReplan } from '../spec/change.js';
import { Refusal } from '../refusal.js';
import { type BundleArtifacts, type BundleBaseline, type PlanCheckResult, checkPlan, executionInputsDigest, specChangeRoute } from './check.js';
import { ADR_FILE, type AdrFrontMatter, type ModuleMap, type PhasePlanFile, type Roadmap } from './schemas.js';
import { type Replaces, classesDiffer, countStages, keptOf, listedSame, replacementOf, subjectWorkOf } from './replace.js';
import { ensureBaselineTexts, ensureModules, moduleIds, requirementIds } from '../store/transitions/baseline.js';
import { illegal, notFound } from '../store/transitions/common.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { policyRevision, projectOptions } from '../store/transitions/settings.js';
import type { Tx } from '../store/transitions/tx.js';
import { registerPlan } from '../store/transitions/work.js';
import { getCandidate, markStale, requiredSet } from '../store/transitions/evidence.js';
import { checkState } from '../store/transitions/gates.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import { type DecisionRow, invalidateDecision } from '../store/transitions/decisions.js';
import type { CommandResult } from '../store/transitions/control.js';
import { getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import { type SpecRepresentation, liveRepresentation } from '../spec/semantics.js';

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
  replaces: string | null;
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
  // A replan's: the head its commit was integrated onto, the revision the
  // plan is prepared against once re-based (D6 §5.3 clause 2; B03).
  prepared_against_revision?: string;
  // A replan's: its own integration commit, on the head the bundle is bound
  // at (`plan_bundles.head`, the moved head it was re-based onto; M427 (f)).
  // The branch standing at it is the bundle's head unmoved.
  own_commit?: string;
}

// The commit the integration branch stands at while nothing has moved since
// the bundle was recorded: a replan's own integration, else its head.
export function boundHead(b: Pick<BundleRow, 'head' | 'artifacts'>): string {
  return (JSON.parse(b.artifacts) as BundleContent).own_commit ?? b.head;
}

export function getBundle(db: Db, id: string): BundleRow | undefined {
  return db.prepare('SELECT * FROM "plan_bundles" WHERE "id" = ?').get(id) as BundleRow | undefined;
}

// The bundle a decision binds: named by the decision's identity scope (and
// its batch key), which the close sets to the bundle's id (B02), never
// found by the run alone.
export function bundleOfDecision(db: Db, d: { scope: string; batch_key?: string | null }): BundleRow | undefined {
  const id = d.scope !== 'subject' ? d.scope : (d.batch_key ?? null);
  return id === null ? undefined : getBundle(db, id);
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
  // Scoped mode's descriptive, criteria-less requirements (Sean, 2026-10-13).
  descriptive_keys: string[];
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
      representation = row?.representation ? liveRepresentation(JSON.parse(row.representation) as SpecRepresentation) : null;
    } catch {
      representation = null;
    }
  }
  const blocked = new Map((representation?.requirements ?? []).map((r) => [r.key, r.blocked_by_questions]));
  const designHumanTests = designAssignedHumanTests(db, args.project);
  // A design criterion of kind `human` is a person's, never a stage's
  // validation or a check's (D7 §7.3; the driver's ruling on M519's F1).
  const judged = designHumanCriteria(db, args.project);
  const requirements = (
    db.prepare('SELECT "key", "criteria", "sensitive_areas", "withdrawn_at", "defect", "status", "human_test" FROM "requirements" WHERE "project" = ? ORDER BY "key"').all(args.project) as {
      key: string;
      criteria: string | null;
      sensitive_areas: string;
      withdrawn_at: string | null;
      defect: number;
      status: string;
      human_test: number;
    }[]
  ).map((r) => ({
    defect: r.defect === 1,
    human_test: r.human_test === 1,
    ...(r.human_test === 1 && designHumanTests.has(r.key) ? { design_human_test: true } : {}),
    descriptive_unverified: r.status === 'descriptive_unverified',
    key: r.key,
    criteria: r.criteria === null ? [] : (JSON.parse(r.criteria) as string[]),
    sensitive_areas: JSON.parse(r.sensitive_areas) as string[],
    withdrawn: r.withdrawn_at !== null,
    blocked_by_questions: blocked.get(r.key) ?? [],
    // Kept in `criteria` (the specification lists them, and a stage may
    // validate them); named here so the plan check owes nothing for them.
    ...(r.criteria !== null && (JSON.parse(r.criteria) as string[]).some((c) => judged.has(c)) ? { judged_by_person: (JSON.parse(r.criteria) as string[]).filter((c) => judged.has(c)) } : {}),
  }));
  const arch = db.prepare('SELECT "id", "version", "module_map", "blobs" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { id: string; version: number; module_map: string; blobs: string } | undefined;
  const road = db.prepare('SELECT "id", "version", "phases", "git_blob" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as
    | { id: string; version: number; phases: string; git_blob: string }
    | undefined;
  const completed = (db.prepare(`SELECT "phase_number" FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed' ORDER BY "phase_number"`).all(args.project) as { phase_number: number }[]).map((r) => r.phase_number);
  // A completed phase a later regression no longer holds (D6 §5.8: "it
  // blocks current effects (the next plan's dependency clause) through the
  // gates that reread"): its completion stays history, and the dependency
  // clause reads it as incomplete.
  const held = phasesNotHeld(db, args.project);
  const open = (db.prepare(`SELECT "id", "phase_number", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' ORDER BY rowid DESC LIMIT 1`).get(args.project) as { id: string; phase_number: number; generation: number } | undefined) ?? null;
  const phase = (completed.at(-1) ?? 0) + 1;
  const roadmapChanged = !road || (args.roadmapBlob !== undefined && args.roadmapBlob !== null && args.roadmapBlob !== road.git_blob);
  const versions: BundleVersions = { architecture: (arch?.version ?? 0) + 1, roadmap: roadmapChanged ? (road?.version ?? 0) + 1 : road!.version, phase_plan: args.withPlan ? 1 : null };
  let approved: BundleBaseline['approved'] = null;
  if (arch && road) {
    const adrs = approvedAdrs(db, args.project, arch.blobs);
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
      completed_phases: completed.filter((n) => !(n in held)),
      phase_unknown: held,
      approved,
      adopted: (db.prepare('SELECT "adoption" FROM "projects" WHERE "id" = ?').get(args.project) as { adoption: string | null }).adoption !== null,
      phase_size: projectOptions(db, args.project).phase_size,
      // D7 §4.1, §8.3 (G2): clause 5 reads the design policy and the spec's targets.
      // A specification whose representation cannot be read has targets
      // unknown, never "none stated" (the slice-41 review's N1).
      design: {
        policy: designPolicyOf(db, args.project),
        spec_targets: representation?.targets ?? null,
        ...(spec && representation === null ? { spec_targets_unknown: `the representation of specification version ${spec.version} cannot be read` } : {}),
        // Clause 1 and clause 4's design reads (D7 §8.1, §8.3; G6).
        approved_screens: approvedDesignScreens(db, args.project),
        surface_targets: Object.fromEntries((representation?.requirements ?? []).filter((r) => r.surface === 'ui').map((r) => [r.key, r.surface_targets ?? null])),
      },
      questions: (representation?.questions ?? []).map((q) => ({ id: q.id, blocks: q.blocks, phase_hint: q.phase_hint })),
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
    descriptive_keys: requirements.filter((r) => !r.withdrawn && r.descriptive_unverified).map((r) => r.key),
    spec_modules: specModules,
  };
}

// The approved ADRs (D6 §5.4): those the approved architecture revision's
// tree holds, with their approved texts. An ADR a later revision deleted is
// no longer approved, though its text stays in baseline_texts as history.
export function approvedAdrs(db: Db, project: string, archBlobs: string): Record<string, string> {
  const keys = new Set(Object.keys(JSON.parse(archBlobs) as Record<string, string>).flatMap((p) => ADR_FILE.exec(p)?.[1] ?? []));
  return (db.prepare(`SELECT "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' ORDER BY "key"`).all(project) as { key: string; text: string }[])
    .filter((a) => keys.has(a.key))
    .reduce<Record<string, string>>((o, a) => ({ ...o, [a.key]: a.text }), {});
}

// The completed phases whose completion the newest candidate does not hold
// now (D6 §5.8; the review's N4): each named with what it lacks, a check
// failed there (a regression observed) or not passed there (not run,
// pending or stale: unknown, never "no regression"). With no candidate or
// no effective version the reading is unknown too.
//
// A check a specification change approved after the phase's completion owes
// a correction for (a `spec_changed` obligation of a change approved as a
// later spec version than the completion binding's) is not read against the
// phase (E153 item 1, the driver's ruling, 2026-10-16): the phase stays
// complete for a dependency, its failure there being what the change's
// delivery phase is to fix, and its history is not reopened. A regression
// with no such change still blocks the clause (D6 §5.8).
export function phasesNotHeld(db: Db, project: string): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [phase, lacking] of Object.entries(phaseLacking(db, project))) {
    out[Number(phase)] = lacking.map((l) => (l.check === null ? `unknown: ${l.why}` : l.state === 'failed' ? `failed: ${l.check} on ${l.candidate}` : `unknown: ${l.check} ${l.state} on ${l.candidate}`));
  }
  return out;
}

// What a completed phase lacks on the newest candidate, each entry
// structured (phasesNotHeld's strings are made from it): the check, its
// state there, and the execution still to give its result, if one is in
// flight (queued, materializing, running or collecting). `check` null: the
// reading itself is unknown (no candidate, no effective version).
export interface PhaseLack {
  check: string | null;
  state: string;
  candidate: string | null;
  execution: { id: string; status: string } | null;
  why?: string;
}
// A quarantined execution counts too (the review's finding 2), as the spec
// change's hold counts it: its result is not yet settled.
export const IN_FLIGHT: readonly string[] = ['queued', 'materializing', 'running', 'quarantined', 'collecting'];

export function phaseLacking(db: Db, project: string): Record<number, PhaseLack[]> {
  const plans = db.prepare(`SELECT "id", "phase_number", "completion_binding" FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed' ORDER BY "phase_number"`).all(project) as {
    id: string;
    phase_number: number;
    completion_binding: string | null;
  }[];
  if (plans.length === 0) return {};
  const newest = db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(project) as { id: string } | undefined;
  const candidate = newest ? getCandidate(db, newest.id) : undefined;
  const effective = effectiveVersion(db, project);
  const out: Record<number, PhaseLack[]> = {};
  for (const plan of plans) {
    if (!candidate || !effective) {
      out[plan.phase_number] = [{ check: null, state: 'unknown', candidate: candidate?.id ?? null, execution: null, why: !candidate ? 'no current candidate' : 'no effective protected version' }];
      continue;
    }
    const set = requiredSet(db, { project, candidate, kind: 'phase', stage: null, version: effective.id, phasePlan: plan.id });
    const changed = changedSinceCompletion(db, project, plan.completion_binding);
    const lacking: PhaseLack[] = [];
    for (const c of set.required) {
      if (changed.has(c.key)) continue;
      const s = checkState(db, project, c, { candidate, effective, environment: null, artifact: null });
      if (s.state === 'passed') continue;
      const execution = s.state !== 'failed' && s.pending !== null && IN_FLIGHT.includes(s.pending.status) ? { id: s.pending.execution, status: s.pending.status } : null;
      lacking.push({ check: c.key, state: s.state, candidate: candidate.id, execution });
    }
    if (lacking.length > 0) out[plan.phase_number] = lacking;
  }
  return out;
}

// A replan's prerequisite results still to come (M543; M444F-1; E154 item 6
// (2); D6 §5.3 clause 3, §5.6): the phases `phase` depends on are complete,
// and everything one of them lacks on the newest candidate is a required
// check whose execution there is queued or running, so the dependency
// clause would read `unknown` now and `passed` or `failed` once they are
// recorded. Then the replan is held, not checked: refusing it now would
// spend its repair on a result not yet observed. Any other lack (a failed
// result, a result with no execution in flight, a dependency not complete,
// the reading itself unknown) is not held: the plan check refuses it as
// built. null when nothing is pending.
export interface PendingPrerequisite {
  phase: number;
  key: string;
  candidate: string;
  execution: string;
  status: string;
}
export function pendingPrerequisites(db: Db, project: string, dependsOn: readonly number[]): PendingPrerequisite[] | null {
  if (dependsOn.length === 0) return null;
  const completed = new Set((db.prepare(`SELECT "phase_number" FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).all(project) as { phase_number: number }[]).map((r) => r.phase_number));
  if (!dependsOn.every((d) => completed.has(d))) return null;
  const lacking = phaseLacking(db, project);
  const pending: PendingPrerequisite[] = [];
  for (const d of dependsOn) {
    for (const l of lacking[d] ?? []) {
      if (l.check === null || l.candidate === null || l.execution === null) return null;
      pending.push({ phase: d, key: l.check, candidate: l.candidate, execution: l.execution.id, status: l.execution.status });
    }
  }
  return pending.length > 0 ? pending : null;
}

// The phase a replan item plans and what that phase depends on, by the
// approved roadmap (an early replacement's: the phase of the plan it
// replaces; any other: the next phase after the last completed one).
// null when the roadmap names no such phase.
export function replanTarget(db: Db, item: { id: string; project: string }): { phase: number; depends_on: number[] } | null {
  const row = db.prepare('SELECT "trigger_source", "trigger_id", "trigger_generation", "subject", "trigger_evidence" FROM "work_items" WHERE "id" = ?').get(item.id) as
    | { trigger_source: string; trigger_id: string; trigger_generation: number; subject: string; trigger_evidence: string | null }
    | undefined;
  if (!row) return null;
  const target = replacementOf(db, row);
  let phase: number | null = null;
  if (target) phase = (db.prepare('SELECT "phase_number" FROM "phase_plans" WHERE "id" = ?').get(target.phase_plan) as { phase_number: number } | undefined)?.phase_number ?? null;
  if (phase === null) {
    const last = db.prepare(`SELECT MAX("phase_number") AS n FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).get(item.project) as { n: number | null };
    phase = (last.n ?? 0) + 1;
  }
  const road = db.prepare('SELECT "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(item.project) as { phases: string } | undefined;
  let phases: { number: number; depends_on?: number[] }[] = [];
  try {
    phases = road ? (JSON.parse(road.phases) as typeof phases) : [];
  } catch {
    phases = [];
  }
  const entry = phases.find((p) => p.number === phase);
  return entry ? { phase, depends_on: Array.isArray(entry.depends_on) ? entry.depends_on : [] } : null;
}

// The check keys a specification change approved after a phase's completion
// owes a correction for: the `spec_changed` obligations (resolved or not) of
// requests approved as a spec version later than the completion binding's.
// A binding with no readable spec revision names none (the conservative
// reading: the clause rereads every check).
function changedSinceCompletion(db: Db, project: string, binding: string | null): Set<string> {
  let revision: string | null = null;
  try {
    revision = binding ? ((JSON.parse(binding) as { spec_revision?: string | null }).spec_revision ?? null) : null;
  } catch {
    revision = null;
  }
  const bound = revision ? (db.prepare('SELECT "version" FROM "spec_revisions" WHERE "id" = ?').get(revision) as { version: number } | undefined) : undefined;
  if (!bound) return new Set();
  const rows = db
    .prepare(
      `SELECT DISTINCT o."key" FROM "check_obligations" o JOIN "spec_change_requests" r ON r."id" = o."request" JOIN "spec_revisions" s ON s."id" = r."approved_revision"
       WHERE o."project" = ? AND o."reason" = 'spec_changed' AND o."key" IS NOT NULL AND r."status" = 'approved' AND s."version" > ?`,
    )
    .all(project, bound.version) as { key: string }[];
  return new Set(rows.map((r) => r.key));
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
  // The record of the complete diff of every changed artifact (D6 §5.4).
  diff?: string | null;
  // The Architect's declarations as its result made them (B.7): recorded
  // beside the computed routing, which overrides them.
  declared?: Record<string, unknown> | null;
  // An early replacement's: the active generation it names (D6 §5.7; B08).
  replaces?: { phase_plan: string; generation: number } | null;
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
           "changes_goals", "roadmap_revision", "needs_spec_change", "routing", "planned_obligations", "obligations", "evidence", "uncertain", "declared", "diff")
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
        JSON.stringify(c.uncertain ?? []),
        JSON.stringify(declaredOf(c, args.declared)),
        args.diff ?? null,
      );
    // The planned design obligations (D7 §8.3; SEAM.md §513).
    tx.db.prepare('UPDATE "plan_checks" SET "design_obligations" = ? WHERE "id" = ?').run(JSON.stringify(c.design_obligations ?? []), check);
    tx.emit('plan.checked', { project: args.project, plan_bundle: args.bundle, plan_check: check }, { phase: args.phase, outcome: c.outcome, reasons: c.reasons.map((r) => r.code), routing: c.routing, run: args.run, uncertain: c.uncertain ?? [], diff: args.diff ?? null });
    if (c.outcome === 'refused') tx.emit('baseline.plan_refused', { project: args.project, plan_bundle: args.bundle }, { phase: args.phase, reasons: c.reasons });
  }
  tx.db
    .prepare(
      `INSERT INTO "plan_bundles" ("id", "created_at", "project", "run", "spec_revision", "head", "phase_number", "blobs", "artifacts", "versions", "plan_check", "batch_key", "approvals", "status", "replaces")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(
      args.bundle,
      tx.at,
      args.project,
      args.run,
      args.spec_revision,
      args.head,
      args.phase,
      JSON.stringify(args.blobs),
      JSON.stringify(args.content),
      JSON.stringify(args.versions),
      check,
      args.bundle,
      args.check?.outcome === 'refused' ? 'refused' : 'proposed',
      args.replaces ? JSON.stringify(args.replaces) : null,
    );
  return { bundle: args.bundle, plan_check: check };
}

// The declarations recorded on a plan check (D6 §5.4): the plan's own
// `conformance` and whatever the role's result declared beside it.
function declaredOf(c: PlanCheckResult, extra: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return { conformance: c.declared?.conformance ?? c.conformance, ...(extra ?? {}) };
}

// What the approvals are bound to (D1 §4.6; contract/decisions.json): the
// head as registered now (a save since the preview stales the answer), the
// approved spec version, the bundle, its blobs and versions, the policy.
export function bundleManifest(db: Db, run: string, b: BundleRow | undefined, kind: 'architecture_approval' | 'plan_approval'): Record<string, unknown> {
  const runRow = db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(run) as { project: string } | undefined;
  const project = runRow?.project ?? b?.project ?? null;
  // A session's bundle binds the head as registered now (a save since the
  // preview stales the answer, D1 §4.6). A replan's binds the head it was
  // re-based onto: another engine commit is judged by the rebind and at
  // publication (B03), so pending replacements are answered in turn (the
  // driver's ruling 5 of 2026-10-13; M430 (e)).
  const session = db.prepare(`SELECT 1 FROM "runs" WHERE "id" = ? AND "kind" = 'session'`).get(run) !== undefined;
  const head = project === null ? null : b && !session ? boundHead(b) : (headOf(db, project) ?? null);
  const spec = project === null ? null : ((db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number } | undefined)?.version ?? null);
  const base = { run, baseline_revision: head, spec_version: spec, bundle: b?.id ?? null, blobs: b ? (JSON.parse(b.blobs) as unknown) : null, versions: b ? (JSON.parse(b.versions) as unknown) : null, bundle_status: b?.status ?? null, policy_revision: project === null ? null : policyRevision(db, project) };
  if (kind === 'plan_approval') return { ...base, plan_check: b?.plan_check ?? null, plan_generation: b?.phase_number === null || b === undefined ? null : generationOf(b) };
  return base;
}

// The generation a bundle's plan is published at: 1, or the one after the
// generation an early replacement names (D6 §5.7; B08).
export const replacesOf = (b: Pick<BundleRow, 'replaces'>): Replaces | null => (b.replaces ? (JSON.parse(b.replaces) as Replaces) : null);
const generationOf = (b: BundleRow): number => (replacesOf(b)?.generation ?? 0) + 1;

function headOf(db: Db, project: string): string | undefined {
  const p = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as { integration_branch: string } | undefined;
  if (!p) return undefined;
  return (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid;
}

// One approval of the pair consumed (D6 §3.4): recorded on the bundle; the
// last one publishes. A `reject` on either refuses the bundle.
export function approveBundlePart(tx: Tx, args: { bundle: string; kind: 'architecture_approval' | 'plan_approval'; decision: string; option: 'approve' | 'reject'; note?: string | null }): { published: boolean; plan: string | null; bundle: string; replan?: string | null } {
  const b = getBundle(tx.db, args.bundle);
  if (!b) throw notFound('plan_bundle', args.bundle);
  if (b.status !== 'proposed') throw illegal(`answering an approval of a ${b.status} bundle`, { plan_bundle: b.id });
  const approvals = JSON.parse(b.approvals) as Record<string, string>;
  if (args.option === 'reject') {
    tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'refused', "stale_reason" = ? WHERE "id" = ?`).run(`rejected by ${args.kind} ${args.decision}`, b.id);
    tx.emit('baseline.plan_refused', { project: b.project, plan_bundle: b.id }, { phase: b.phase_number, rejected_by: args.decision, kind: args.kind });
    // A replan's proposal rejected returns to the Architect as new `replan`
    // work with the note (D6 §5.4; M427 (d)): the next generation of the
    // same trigger, its subject the same and the rejection on it.
    const replan = rejectedReplan(tx, b, args.decision, args.note ?? null);
    return { published: false, plan: null, bundle: b.id, replan };
  }
  approvals[args.kind] = args.decision;
  tx.db.prepare('UPDATE "plan_bundles" SET "approvals" = ? WHERE "id" = ?').run(JSON.stringify(approvals), b.id);
  const needsPlan = b.phase_number !== null;
  // A replan routed to the human that changes nothing of the baseline raises
  // `plan_approval` alone (D6 §5.4): its approval publishes the plan.
  const needsArchitecture = tx.db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'architecture_approval' AND "scope" = ?`).get(b.id) !== undefined;
  if ((needsArchitecture && !approvals.architecture_approval) || (needsPlan && !approvals.plan_approval)) return { published: false, plan: null, bundle: b.id };
  // The authority is complete: the authorized finalizer publishes it in a
  // transaction of its own (publishAuthorized, D6 §5.5; M448 (e)), right
  // after this answer and, after a restart, at the next tick; once.
  return { published: false, plan: null, bundle: b.id };
}

function rejectedReplan(tx: Tx, b: BundleRow, decision: string, note: string | null): string | null {
  return nextReplanGeneration(tx, b, { rejected: { bundle: b.id, decision, note } });
}

// The next generation of the trigger of the replan whose run proposed `b`,
// carrying its evidence and `extra` (a rejection's note, a staleness).
function nextReplanGeneration(tx: Tx, b: BundleRow, extra: Record<string, unknown>): string | null {
  if (b.run === null) return null;
  const item = tx.db
    .prepare(`SELECT w."id", w."trigger_source", w."trigger_id", w."subject", w."trigger_evidence" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ? AND w."kind" = 'replan'`)
    .get(b.run) as { id: string; trigger_source: string; trigger_id: string; subject: string; trigger_evidence: string | null } | undefined;
  if (!item) return null;
  const { g } = tx.db.prepare('SELECT MAX("trigger_generation") AS g FROM "work_items" WHERE "project" = ? AND "trigger_source" = ? AND "trigger_id" = ?').get(b.project, item.trigger_source, item.trigger_id) as { g: number };
  const trigger_evidence = { ...((item.trigger_evidence ? JSON.parse(item.trigger_evidence) : {}) as Record<string, unknown>), ...extra, from_work_item: item.id };
  return observeTrigger(
    tx,
    { project: b.project, kind: 'replan', trigger_source: item.trigger_source, trigger_id: item.trigger_id, trigger_generation: g + 1, subject: JSON.parse(item.subject) as Record<string, unknown>, trigger_evidence, chain: 0 },
    { from_bundle: b.id },
  ).work_item.id;
}

// Whether a proposed bundle's authority is complete: every approval its
// decisions ask for answered `approve`.
function authorized(db: Db, b: BundleRow): boolean {
  if (b.status !== 'proposed') return false;
  const approvals = JSON.parse(b.approvals) as Record<string, string>;
  const needsArchitecture = db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'architecture_approval' AND "scope" = ?`).get(b.id) !== undefined;
  const needsPlan = b.phase_number !== null && db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'plan_approval' AND "scope" = ?`).get(b.id) !== undefined;
  if (!needsArchitecture && !needsPlan) return false;
  return (!needsArchitecture || approvals.architecture_approval !== undefined) && (!needsPlan || approvals.plan_approval !== undefined);
}

// The bundles whose authority is complete and which are not yet published
// (the main thread's read before `plan.before_publication`).
export function authorizedBundles(db: Db, args: { project: string }): string[] {
  return (db.prepare(`SELECT * FROM "plan_bundles" WHERE "project" = ? AND "status" = 'proposed' ORDER BY rowid`).all(args.project) as BundleRow[]).filter((b) => authorized(db, b)).map((b) => b.id);
}

// The authorized finalizer (D6 §5.5; B02): the bundle published once, its
// baseline compared again; a bundle that can no longer publish is stale,
// recorded, and publishes nothing. Idempotent: a bundle no longer proposed
// or not authorized is left as it is.
export function publishAuthorized(tx: Tx, args: { bundle: string }): { published: boolean; plan: string | null; stale: string | null } {
  const b = getBundle(tx.db, args.bundle);
  if (!b || !authorized(tx.db, b)) return { published: false, plan: null, stale: null };
  const needsArchitecture = tx.db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'architecture_approval' AND "scope" = ?`).get(b.id) !== undefined;
  const why = unpublishable(tx.db, b, needsArchitecture ? 'bundle' : 'plan', { head: false });
  if (why !== null) {
    markBundleStale(tx, b, why);
    return { published: false, plan: null, stale: why };
  }
  // A head that moved after the authority was complete and before this
  // publication (B03; carried item (i)): not judged here. The rebind reads
  // what changed (plan/rebind.ts): a bound input makes the bundle stale; any
  // other engine commit re-bases it, and the next pass publishes it.
  if (needsArchitecture && headOf(tx.db, b.project) !== boundHead(b)) return { published: false, plan: null, stale: null };
  const made = guarded(tx, b, () => (needsArchitecture ? publishBundle(tx, { bundle: b.id, by: 'human' }).plan : publishPlan(tx, { bundle: b.id, by: 'human', routing: 'human' })));
  return made.ok ? { published: true, plan: made.value, stale: null } : { published: false, plan: null, stale: made.why };
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
  // An architecture is published only on an approved specification (D6 §3.3).
  if (b.spec_revision === null) throw illegal('publishing an architecture with no approved specification', { plan_bundle: b.id });
  const why = unpublishable(tx.db, b, 'bundle');
  if (why !== null) {
    markBundleStale(tx, b, why);
    throw staleRefusal(b, why);
  }
  const versions = JSON.parse(b.versions) as BundleVersions;
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
  if (content.roadmap && (content.roadmap_changed || !existingRoad)) roadId = publishRoadmap(tx, b, content.roadmap, blobs, archId, args.by);
  else roadId = existingRoad?.id ?? null;

  // The plan (K4), by the one production function.
  let planId: string | null = null;
  if (content.plan) {
    const plan = content.plan;
    const obligations = b.plan_check ? (tx.db.prepare('SELECT "planned_obligations" FROM "plan_checks" WHERE "id" = ?').get(b.plan_check) as { planned_obligations: string | null }).planned_obligations : null;
    const made = registerPlan(
      tx,
      {
        project: b.project,
        baseRevision: content.prepared_against_revision ?? b.head,
        authority: { kind: 'publication', by: args.by === 'human' ? 'human' : 'engine:plan_check', bundle: b.id, check: b.plan_check, routing: args.by === 'human' ? 'human' : 'registered', replaces: replacesOf(b) },
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
          ...(s.screens !== undefined ? { screens: s.screens } : {}),
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
  afterPublication(tx, b.project, planId === null ? null : (content.plan?.phase ?? null), planId);
  return { plan: planId, architecture_revision: archId, roadmap_revision: roadId };
}

// A roadmap revision published (D6 §5.1): the next version, the
// requirements' phases derived from it.
function publishRoadmap(tx: Tx, b: BundleRow, roadmap: Roadmap, blobs: Record<string, string>, archId: string | null, by = 'human'): string {
  const existing = tx.db.prepare('SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { version: number } | undefined;
  const roadId = tx.newId('road_');
  const version = (existing?.version ?? 0) + 1;
  tx.db
    .prepare('INSERT INTO "roadmap_revisions" ("id", "created_at", "project", "version", "architecture_revision", "git_path", "git_blob", "phases", "moved_requirements", "approved_by", "approved_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(roadId, tx.at, b.project, version, archId, '.surety/roadmap/roadmap.json', blobs['.surety/roadmap/roadmap.json'] ?? '', JSON.stringify(roadmap.phases), roadmap.moved_requirements ? JSON.stringify(roadmap.moved_requirements) : null, by, tx.at);
  // The moves as the engine sees them (D6 §4.7; the driver's ruling Q-B):
  // each requirement whose phase this revision changes, from the phase it
  // had (null: none yet) to the one given. The declared list stays on the row.
  const moved: { key: string; from: number | null; to: number }[] = [];
  for (const ph of roadmap.phases) {
    for (const key of ph.requirement_ids) {
      const had = tx.db.prepare('SELECT "assigned_phase" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(b.project, key) as { assigned_phase: number | null } | undefined;
      if (had && had.assigned_phase !== ph.number) moved.push({ key, from: had.assigned_phase, to: ph.number });
      tx.db.prepare('UPDATE "requirements" SET "assigned_phase" = ? WHERE "project" = ? AND "key" = ?').run(ph.number, b.project, key);
    }
  }
  tx.emit('baseline.roadmap_revised', { project: b.project, roadmap_revision: roadId }, { version, phases: roadmap.phases.map((p2) => p2.number), bundle: b.id, moved_requirements: moved.sort((x, y) => x.key.localeCompare(y.key)) });
  return roadId;
}

// The check of a bundle's artifacts against the baseline (a pure call; the
// main thread reads the blobs, the store supplies the baseline).
export function checkBundle(facts: BaselineFacts, artifacts: BundleArtifacts): PlanCheckResult {
  return checkPlan(facts.baseline, artifacts);
}

export type { AdrFrontMatter };


// A replan's plan the check refused (D6 §5.3; SEAM.md §383): its check is
// recorded, with no bundle, so the refusal and its reasons are on the plan
// read; and the requests its result carried are made (D6 §8.3). The run
// itself fails its acceptance as before.
export function recordRefusedReplan(tx: Tx, args: { project: string; run: string; phase: number; check: PlanCheckResult; requests: { keys: string[]; text: string }[]; declared?: Record<string, unknown> | null }): { plan_check: string; requests: string[] } {
  // Once per run: an acceptance retried records nothing twice (the slice-32
  // review's M7).
  const done = tx.db.prepare(`SELECT "id" FROM "plan_checks" WHERE "project" = ? AND "bundle" IS NULL AND json_extract("evidence", '$.run') = ?`).get(args.project, args.run) as { id: string } | undefined;
  if (done) return { plan_check: done.id, requests: (tx.db.prepare(`SELECT "id" FROM "spec_change_requests" WHERE "run" = ? ORDER BY "seq"`).all(args.run) as { id: string }[]).map((r) => r.id) };
  const id = tx.newId('pchk_');
  const c = args.check;
  tx.db
    .prepare(
      `INSERT INTO "plan_checks" ("id", "created_at", "project", "bundle", "plan", "phase_number", "outcome", "reasons", "conformance", "changes_architecture", "changes_adrs", "changes_roadmap",
         "changes_goals", "roadmap_revision", "needs_spec_change", "routing", "planned_obligations", "obligations", "evidence", "uncertain", "declared")
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.project,
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
      JSON.stringify(c.planned_obligations),
      JSON.stringify({ run: args.run }),
      JSON.stringify(c.uncertain ?? []),
      JSON.stringify(declaredOf(c, args.declared)),
    );
  tx.db.prepare('UPDATE "plan_checks" SET "design_obligations" = ? WHERE "id" = ?').run(JSON.stringify(c.design_obligations ?? []), id);
  tx.emit('plan.checked', { project: args.project, plan_check: id, run: args.run }, { phase: args.phase, outcome: c.outcome, reasons: c.reasons.map((r) => r.code), routing: null, run: args.run });
  // A refused replan is a refused plan like a session's (D6 §5.3; M425 (a)).
  // An unknown requirement is offered through the spec-change workflow,
  // never registered (D6 §5.4; the driver's ruling 5).
  if (c.outcome === 'refused') {
    tx.emit('baseline.plan_refused', { project: args.project, plan_check: id, run: args.run }, { phase: args.phase, reasons: c.reasons, ...(c.needs_spec_change ? { spec_change_route: specChangeRoute(args.project) } : {}) });
  }
  return { plan_check: id, requests: requestsFromReplan(tx, { project: args.project, run: args.run, requests: args.requests }) };
}

// What a session's phase plan must name in `prepared_against` (D6 §3.3,
// §5.3 clause 2; the check's PLAN_STALE_BASELINE): the approved
// specification's version, the versions the bundle will allocate and the
// head the session started from; the roadmap keeps its version unless the
// session changes roadmap.json. Taken from the facts the check compares
// with (bundleBaselineFacts), never computed apart.
export interface PreparedAgainstFacts {
  spec_version: number;
  architecture_version: number;
  roadmap_version: number;
  roadmap_version_if_changed: number;
  revision: string;
}
export function preparedAgainstFacts(db: Db, project: string, head: string): PreparedAgainstFacts {
  const unchanged = bundleBaselineFacts(db, { project, head, withPlan: true });
  const road = db.prepare('SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number } | undefined;
  return {
    spec_version: unchanged.baseline.spec_version,
    architecture_version: unchanged.versions.architecture,
    roadmap_version: unchanged.versions.roadmap,
    roadmap_version_if_changed: (road?.version ?? 0) + 1,
    revision: head,
  };
}

// ---- a replan's plan (D6 §5.6, §5.4, §5.5; B03; SEAM.md §352) --------------------------

// What a replan's plan is checked against: the approved baseline as it is,
// its versions the approved ones (a replan that changes nothing of the
// architecture names them), the approved artifacts for the computed diff,
// and the head the run started from.
export interface ReplanBaseline {
  baseline: BundleBaseline;
  spec_revision: string | null;
  architecture_revision: string | null;
  roadmap_revision: string | null;
  phase: number;
  open_plan: { id: string; phase_number: number; generation: number } | null;
  requirement_keys: string[];
  spec_modules: { name: string; sensitive_areas: string[] }[];
  // Scoped mode's descriptive, criteria-less requirements (Sean, 2026-10-13).
  descriptive_keys: string[];
  // An early replan's (D6 §5.7; B08): the generation it replaces, that
  // plan's phase, and its kept stages; null for any other replan.
  replacement: (Replaces & { phase: number; kept: { number: number; digest: string | null; implements: string[]; validated: string[] }[] }) | null;
}

export function replanBaseline(db: Db, args: { project: string; head: string; work_item?: string; digests?: [number, string][] }): ReplanBaseline {
  const facts = bundleBaselineFacts(db, { project: args.project, head: args.head, withPlan: true });
  const arch = db.prepare('SELECT "version" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { version: number } | undefined;
  const road = db.prepare('SELECT "version", "architecture_revision" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { version: number; architecture_revision: string | null } | undefined;
  // The architecture the approved roadmap was made with: what an unchanged
  // roadmap.json names.
  const roadArch = road?.architecture_revision ? ((db.prepare('SELECT "version" FROM "architecture_revisions" WHERE "id" = ?').get(road.architecture_revision) as { version: number } | undefined)?.version ?? null) : null;
  return {
    baseline: { ...facts.baseline, architecture_version: arch?.version ?? 0, roadmap_version: road?.version ?? 0, roadmap_architecture_version: roadArch ?? arch?.version ?? 0 },
    spec_revision: facts.spec_revision,
    architecture_revision: facts.architecture_revision,
    roadmap_revision: facts.roadmap_revision,
    phase: facts.phase,
    open_plan: facts.open_plan,
    requirement_keys: facts.requirement_keys,
    descriptive_keys: facts.descriptive_keys,
    spec_modules: facts.spec_modules,
    replacement: replacementFacts(db, args.work_item, new Map(args.digests ?? [])),
  };
}

function replacementFacts(db: Db, workItem: string | undefined, digests: Map<number, string>): ReplanBaseline['replacement'] {
  if (!workItem) return null;
  const item = db.prepare('SELECT "trigger_source", "trigger_id", "trigger_generation", "subject", "trigger_evidence" FROM "work_items" WHERE "id" = ?').get(workItem) as
    | { trigger_source: string; trigger_id: string; trigger_generation: number; subject: string; trigger_evidence: string | null }
    | undefined;
  const target = item ? replacementOf(db, item) : null;
  if (!target) return null;
  const plan = db.prepare('SELECT "phase_number" FROM "phase_plans" WHERE "id" = ?').get(target.phase_plan) as { phase_number: number } | undefined;
  if (!plan) return null;
  const subject = subjectWorkOf(target);
  // What the check counts: the kept stages, and what the swap would do with
  // each active stage given this plan's stages (the review's S1).
  return { ...target, phase: plan.phase_number, kept: keptOf(db, target.phase_plan, subject), counted: countStages(db, target.phase_plan, digests, subject) };
}

export interface ReplanPrepared {
  bundle: string;
  obligations_record: string | null;
  phase: number;
  head: string;
  blobs: Record<string, string>;
  content: BundleContent;
  check: PlanCheckResult;
  spec_revision: string | null;
  architecture_revision: string | null;
  roadmap_revision: string | null;
  versions: BundleVersions;
  // D6 §8.3 (B.7): the requests for criteria a retrofit replan carried.
  spec_change_requests?: { keys: string[]; text: string }[];
  // D6 §5.4: the complete diff's record and the result's declarations.
  diff?: string | null;
  declared?: Record<string, unknown> | null;
  // D6 §5.7 (B08): an early replan's, the active generation it replaces.
  replaces?: Replaces | null;
}

// The replan's commit integrated (its finalizer, store/transitions/
// finalize.ts): the bundle and its check recorded; a plan whose computed
// routing is `registered` published now by `engine:plan_check`; one routed
// to the human waits for `plan_approval`; one for a phase that is not the
// next, or whose phase has an open plan, is stale and registers nothing
// (early replacement is slice 35's). Returns the published plan, if any.
export function finalizeReplan(tx: Tx, args: { project: string; run: string; prepared: ReplanPrepared; integrated: string; base?: string | null }): string | null {
  const r = args.base ? { ...args.prepared, content: { ...args.prepared.content, prepared_against_revision: args.base, own_commit: args.integrated } } : args.prepared;
  if (getBundle(tx.db, r.bundle)) return null;
  if (r.spec_change_requests && r.spec_change_requests.length > 0) requestsFromReplan(tx, { project: args.project, run: args.run, requests: r.spec_change_requests });
  recordBundle(tx, {
    project: args.project,
    run: args.run,
    bundle: r.bundle,
    obligations_record: r.obligations_record,
    // The head the plan was re-based and rechecked onto (M427 (f)); its own
    // commit on the content.
    head: args.base ?? args.integrated,
    phase: r.phase,
    blobs: r.blobs,
    content: r.content,
    check: r.check,
    spec_revision: r.spec_revision,
    versions: r.versions,
    diff: r.diff ?? null,
    declared: r.declared ?? null,
    replaces: r.replaces ?? null,
  });
  const { done } = tx.db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS done FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).get(args.project) as { done: number };
  const open = tx.db.prepare(`SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1`).get(args.project) as { id: string; generation: number } | undefined;
  // An early replacement (D6 §5.7; B08) is exempt from the one-open-plan
  // rule only for the active generation it names.
  const replacing = r.replaces !== undefined && r.replaces !== null && open !== undefined && open.id === r.replaces.phase_plan && open.generation === r.replaces.generation;
  if (r.phase !== done + 1 || (r.replaces ? !replacing : open !== undefined)) {
    const why = r.replaces && !replacing
      ? `generation ${r.replaces.generation} of plan ${r.replaces.phase_plan}, which the replacement names, is no longer the active one${open ? ` (${open.id}, generation ${open.generation})` : ''}`
      : open
        ? `phase ${r.phase} has an open plan (${open.id}); a replacement is the early-replacement route's`
        : `phase ${r.phase} is not the next phase (${done + 1})`;
    tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'stale', "stale_reason" = ? WHERE "id" = ?`).run(why, r.bundle);
    tx.emit('plan.generation_refused', { project: args.project, plan_bundle: r.bundle }, { phase: r.phase, cause: why, code: 'plan_generation_stale' });
    return null;
  }
  if (r.check.outcome !== 'passed') return null;
  if (r.check.routing === 'human') {
    // A replan that changes the approved architecture, module map, ADRs or
    // roadmap carries them to the human with the plan, in one batch (D6
    // §5.4; the 31b review's S4): published together, or not at all.
    const c = r.check.changes;
    // An architecture text, module map or ADR change is an architecture
    // revision and raises `architecture_approval` beside the plan's; a
    // roadmap-only change is the plan's own approval, its roadmap revision
    // published with the plan (the driver's ruling, slice 35). Its versions
    // are the ones its publication allocates: the replan was checked
    // against them (runs/accept.ts; B02).
    const architectureChanging = c.changes_architecture.changed || c.changes_adrs.added.length + c.changes_adrs.changed.length + c.changes_adrs.deleted.length > 0;
    if (architectureChanging) raiseQuestion(tx, { project: args.project, kind: 'architecture_approval', subjectType: 'run', subjectId: args.run, scope: r.bundle });
    raiseQuestion(tx, { project: args.project, kind: 'plan_approval', subjectType: 'run', subjectId: args.run, scope: r.bundle });
    tx.db.prepare('UPDATE "decisions" SET "batch_key" = ? WHERE "subject_type" = ? AND "subject_id" = ? AND "scope" = ? AND "status" = ?').run(r.bundle, 'run', args.run, r.bundle, 'open');
    tx.db.prepare('UPDATE "plan_bundles" SET "batch_key" = ? WHERE "id" = ?').run(r.bundle, r.bundle);
    return null;
  }
  // The recheck at publication (D6 §5.5): a baseline that moved since the
  // main thread's check leaves the proposal stale, with its reason.
  const recorded = getBundle(tx.db, r.bundle)!;
  const why = unpublishable(tx.db, recorded, 'plan');
  if (why !== null) {
    markBundleStale(tx, recorded, why);
    return null;
  }
  const made = guarded(tx, recorded, () => publishPlan(tx, { bundle: r.bundle, by: 'engine:plan_check', routing: 'registered' }));
  return made.ok ? made.value : null;
}

// A bundle that carries a plan and changes nothing of the approved
// architecture, module map, ADRs or roadmap (§5.4): the plan alone
// published, prepared against the approved revisions.
export function publishPlan(tx: Tx, args: { bundle: string; by: 'human' | 'engine:plan_check'; routing: 'human' | 'registered' }): string {
  const b = getBundle(tx.db, args.bundle);
  if (!b) throw notFound('plan_bundle', args.bundle);
  if (b.status !== 'proposed') throw illegal(`publishing a ${b.status} bundle`, { plan_bundle: b.id });
  if (b.spec_revision === null) throw illegal('publishing a plan with no approved specification', { plan_bundle: b.id });
  const content = JSON.parse(b.artifacts) as BundleContent;
  const plan = content.plan;
  if (!plan) throw illegal('publishing a bundle with no plan as a plan', { plan_bundle: b.id });
  // The baseline the plan was checked against, compared again (D6 §5.5).
  const why = unpublishable(tx.db, b, 'plan');
  if (why !== null) {
    markBundleStale(tx, b, why);
    throw staleRefusal(b, why);
  }
  const arch = tx.db.prepare('SELECT "id" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { id: string } | undefined;
  // A plan that carries a roadmap revision (a roadmap-only change, D6
  // §5.4): the revision published with it, under the approved architecture.
  if (content.roadmap && content.roadmap_changed) publishRoadmap(tx, b, content.roadmap, JSON.parse(b.blobs) as Record<string, string>, arch?.id ?? null);
  const road = tx.db.prepare('SELECT "id" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { id: string } | undefined;
  const obligations = b.plan_check ? (tx.db.prepare('SELECT "planned_obligations" FROM "plan_checks" WHERE "id" = ?').get(b.plan_check) as { planned_obligations: string | null }).planned_obligations : null;
  const made = registerPlan(
    tx,
    {
      project: b.project,
      baseRevision: content.prepared_against_revision ?? b.head,
      authority: { kind: 'publication', by: args.by, bundle: b.id, check: b.plan_check, routing: args.routing, replaces: replacesOf(b) },
      phase: plan.phase,
      gitPath: `.surety/phases/phase-${plan.phase}.json`,
      chain: 0,
      prepared: { spec: b.spec_revision, architecture: arch?.id ?? null, roadmap: road?.id ?? null },
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
        ...(s.screens !== undefined ? { screens: s.screens } : {}),
      })),
    },
    {},
  );
  if (b.plan_check) tx.db.prepare('UPDATE "plan_checks" SET "plan" = ? WHERE "id" = ?').run(made.plan.id, b.plan_check);
  tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'published', "published_at" = ? WHERE "id" = ?`).run(tx.at, b.id);
  tx.emit('baseline.plan_approved', { project: b.project, phase_plan: made.plan.id, plan_bundle: b.id }, { phase: plan.phase, generation: made.plan.generation, approved_by: args.by, routing: args.routing });
  markStale(tx, { project: b.project });
  afterPublication(tx, b.project, plan.phase, made.plan.id);
  return made.plan.id;
}

// A publication run in a savepoint of the finalizer's transaction: a
// refusal from inside it (registerPlan's, or a staleness found only there)
// rolls back what the publication wrote and leaves the bundle stale, named,
// never a throw out of the finalizer and never a pass the engine retries
// forever (the review's S1).
function guarded<T>(tx: Tx, b: BundleRow, fn: () => T): { ok: true; value: T } | { ok: false; why: string } {
  const events = tx.events.length;
  try {
    return { ok: true, value: tx.db.transaction(fn)() };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    tx.events.length = events;
    const why = `publication refused ${err.code}: ${err.reason}`;
    const now = getBundle(tx.db, b.id);
    if (now) markBundleStale(tx, now, why);
    return { ok: false, why };
  }
}

// ---- staleness (D6 §5.5; B02, B08; M448 (d)) ------------------------------------------------

// Why a proposed bundle can no longer publish, or null. `route`: 'bundle'
// for publishBundle (the architecture with its plan, checked against the
// head it was checked at and the architecture version it allocates);
// 'plan' for publishPlan (a plan alone, against the approved revisions it
// was checked against; a harmless head move is the plan's re-base, B03).
// `head` false: a moved head is not judged (an answer's guard leaves it to
// the decision's manifest, which a save after the preview stales, D1 §4.6).
export function unpublishable(db: Db, b: BundleRow, route: 'bundle' | 'plan', opts: { head?: boolean } = {}): string | null {
  const spec = db.prepare('SELECT "id", "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { id: string; version: number } | undefined;
  if ((spec?.id ?? null) !== b.spec_revision) return `the approved specification changed since the bundle was checked (now version ${spec?.version ?? 'none'})`;
  // The plan's references whose existence can change between the check and
  // publication (D6-P01; M425 (e); the driver's ruling 4): an ADR a stage
  // cites, deleted by a competing proposal, makes it stale, named.
  const content = JSON.parse(b.artifacts) as BundleContent;
  if (content.plan && route === 'plan') {
    const latest = db.prepare('SELECT "blobs" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { blobs: string } | undefined;
    const approved = latest ? Object.keys(approvedAdrs(db, b.project, latest.blobs)) : [];
    const gone = [...new Set(content.plan.stages.flatMap((st) => st.adrs))].filter((k) => !approved.includes(k)).sort();
    if (gone.length > 0) return `PLAN_UNKNOWN_ADR ${gone.join(', ')}: an ADR the plan cites is not in the approved architecture`;
  }
  const versions = JSON.parse(b.versions) as BundleVersions;
  const arch = db.prepare('SELECT "version" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { version: number } | undefined;
  const road = db.prepare('SELECT "version" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(b.project) as { version: number } | undefined;
  if (route === 'bundle') {
    const p = db.prepare('SELECT "integration_branch" FROM "projects" WHERE "id" = ?').get(b.project) as { integration_branch: string };
    const head = (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(b.project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid ?? null;
    if (opts.head !== false && head !== boundHead(b)) return `the integration head moved from ${boundHead(b)} to ${head ?? 'none'} since the bundle was checked`;
    if ((arch?.version ?? 0) + 1 !== versions.architecture) return `architecture version ${versions.architecture} is no longer the next`;
  } else {
    if ((arch?.version ?? 0) !== versions.architecture) return `the approved architecture is version ${arch?.version ?? 0}, not ${versions.architecture}, which the plan was checked against`;
    // A plan carrying a roadmap revision was checked against the version its
    // publication allocates, the approved one's next.
    const expected = content.roadmap_changed && content.roadmap ? versions.roadmap - 1 : versions.roadmap;
    if ((road?.version ?? 0) !== expected) return `the approved roadmap is version ${road?.version ?? 0}, not ${expected}, which the plan was checked against`;
  }
  if (b.phase_number !== null) {
    const open = db.prepare(`SELECT "id", "generation" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1`).get(b.project) as { id: string; generation: number } | undefined;
    const replaces = replacesOf(b);
    // Early replacement (D6 §5.7; B08): the generation it names must still
    // be the active one; any other open plan was published first.
    if (replaces) {
      if (!open || open.id !== replaces.phase_plan || open.generation !== replaces.generation) return `generation ${replaces.generation} of plan ${replaces.phase_plan}, which the replacement names, is no longer the active one${open ? ` (${open.id}, generation ${open.generation})` : ''}`;
      // The stages the check counted, compared again (the review's S1): a
      // stage integrated, parked or ended since changes what the swap does.
      const c = JSON.parse(b.artifacts) as BundleContent;
      if (c.plan) {
        const digests = new Map<number, string | null>(c.plan.stages.map((st) => [st.number, executionInputsDigest(st)]));
        const now = countStages(db, replaces.phase_plan, digests, subjectWorkOf(replaces));
        const diff = classesDiffer(replaces.counted, now, listedSame(db, replaces.phase_plan, digests));
        if (diff !== null) return `${STAGES_CHANGED} ${replaces.generation} of plan ${replaces.phase_plan} changed since the check: ${diff}`;
      }
    } else if (open) return `a plan (${open.id}) was published first`;
    const { done } = db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS done FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).get(b.project) as { done: number };
    if (b.phase_number !== done + 1) return `phase ${b.phase_number} is not the next phase (${done + 1})`;
  }
  return null;
}

// The cause a replacement goes stale with when the generation's stages
// changed since its check: its replan proposes again (the review's S1).
const STAGES_CHANGED = 'the stages of generation';

// The route a proposed bundle is published by: a plan alone when no
// architecture approval was raised on it.
const routeOf = (db: Db, b: BundleRow): 'bundle' | 'plan' =>
  b.phase_number !== null && db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = 'architecture_approval' AND "scope" = ?`).get(b.id) === undefined && b.run !== null && db.prepare(`SELECT 1 FROM "runs" WHERE "id" = ? AND "kind" = 'session'`).get(b.run) === undefined ? 'plan' : 'bundle';

function staleRefusal(b: BundleRow, why: string): Refusal {
  return new Refusal(409, 'plan_generation_stale', `The bundle ${b.id} cannot be published: ${why}.`, 'The proposal is stale, not current; a new Architect session or replan proposes again.', { plan_bundle: b.id, phase: b.phase_number, cause: why });
}

// The proposal stale with its reason, once; its open decisions invalidated.
export function markBundleStale(tx: Tx, b: BundleRow, why: string): void {
  if (b.status !== 'proposed') return;
  tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'stale', "stale_reason" = ? WHERE "id" = ? AND "status" = 'proposed'`).run(why, b.id);
  tx.emit('plan.generation_refused', { project: b.project, plan_bundle: b.id }, { phase: b.phase_number, cause: why, code: 'plan_generation_stale' });
  const open = tx.db.prepare(`SELECT * FROM "decisions" WHERE "scope" = ? AND "kind" IN ('architecture_approval', 'plan_approval') AND "status" = 'open'`).all(b.id) as DecisionRow[];
  for (const d of open) invalidateDecision(tx, d, `plan_generation_stale: ${why}`);
  // A replacement whose generation's stages moved under it: its replan
  // proposes again, the next generation of its trigger (the review's S1).
  if (b.replaces && why.includes(STAGES_CHANGED)) nextReplanGeneration(tx, b, { stale: why });
}

// Every proposed bundle of the project that can no longer publish, stale
// (called by a specification's approval and after each publication).
export function staleUnpublishable(tx: Tx, project: string, cause: string): void {
  const rows = tx.db.prepare(`SELECT * FROM "plan_bundles" WHERE "project" = ? AND "status" = 'proposed'`).all(project) as BundleRow[];
  for (const b of rows) {
    const why = unpublishable(tx.db, b, routeOf(tx.db, b));
    if (why !== null) markBundleStale(tx, b, `${cause}: ${why}`);
  }
}

// The answer to a bundle's decision (KindSpec.guard): a bundle that is no
// longer proposed refuses every answer; one that can no longer publish is
// marked stale and refuses `approve`; both as a committed 409
// `plan_generation_stale`.
export function bundleGuard(tx: Tx, d: DecisionRow, option: string): CommandResult | null {
  const b = bundleOfDecision(tx.db, d);
  if (!b || b.status === 'published') return null;
  if (b.status === 'proposed') {
    if (option !== 'approve') return null;
    const why = unpublishable(tx.db, b, routeOf(tx.db, b), { head: false });
    if (why === null) return null;
    markBundleStale(tx, b, why);
    return { status: 409, body: staleRefusal(b, why).body() };
  }
  const row = tx.db.prepare('SELECT "stale_reason" FROM "plan_bundles" WHERE "id" = ?').get(b.id) as { stale_reason: string | null };
  return { status: 409, body: staleRefusal(b, row.stale_reason ?? `the bundle is ${b.status}`).body() };
}

// After a publication: what can no longer publish is stale, and a replan
// parked for the phase just published is superseded (the coordinator's
// ruling on slice 34's question 5).
function afterPublication(tx: Tx, project: string, phase: number | null, plan: string | null): void {
  staleUnpublishable(tx, project, 'another proposal was published');
  if (phase === null || plan === null) return;
  const parked = tx.db.prepare(`SELECT "id", "trigger_source", "trigger_id" FROM "work_items" WHERE "project" = ? AND "kind" = 'replan' AND "status" = 'parked'`).all(project) as { id: string; trigger_source: string; trigger_id: string }[];
  for (const w of parked) {
    let target: number | null = null;
    if (w.trigger_source === 'phase_complete') {
      const p = tx.db.prepare('SELECT "phase_number" FROM "phase_plans" WHERE "id" = ?').get(w.trigger_id) as { phase_number: number } | undefined;
      target = p ? p.phase_number + 1 : null;
    }
    if (target === null) {
      const c = tx.db
        .prepare(`SELECT c."phase_number" FROM "plan_checks" c JOIN "runs" r ON r."id" = json_extract(c."evidence", '$.run') WHERE r."work_item" = ? ORDER BY c.rowid DESC LIMIT 1`)
        .get(w.id) as { phase_number: number | null } | undefined;
      target = c?.phase_number ?? null;
    }
    if (target !== phase) continue;
    const item = getWorkItem(tx, w.id)!;
    transitionWork(tx, item, 'cancelled', { blocker: null }, { cause: 'superseded', phase_plan: plan });
    const blocker = tx.db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_type" = 'work_item' AND "subject_id" = ? AND "status" = 'open'`).all(w.id) as DecisionRow[];
    for (const d of blocker) invalidateDecision(tx, d, `superseded: the plan of phase ${phase} (${plan}) was published`);
  }
}

// ---- a proposed bundle under a moving head (B03; the review's gap) -----------------------

// The approvals a bundle's authority still needs: each kind raised on it
// (any generation) and not yet approved.
function pendingKinds(db: Db, b: BundleRow): ('architecture_approval' | 'plan_approval')[] {
  const approvals = JSON.parse(b.approvals) as Record<string, string>;
  return (['architecture_approval', 'plan_approval'] as const).filter(
    (k) => approvals[k] === undefined && db.prepare('SELECT 1 FROM "decisions" WHERE "kind" = ? AND "scope" = ?').get(k, b.id) !== undefined,
  );
}

export interface RebindDue {
  bundle: string;
  repo: string;
  from: string;
  to: string;
  paths: string[];
}

// The proposed bundles that a moved head, or a pending approval with no
// open decision, leaves without a current question.
export function rebindDue(db: Db, args: { project: string }): RebindDue[] {
  const p = db.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string; integration_branch: string } | undefined;
  if (!p) return [];
  const head = (db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? AND "ref" = ?').get(args.project, integrationRef(p.integration_branch)) as { expected_oid: string } | undefined)?.expected_oid ?? null;
  if (head === null) return [];
  const out: RebindDue[] = [];
  for (const b of db.prepare(`SELECT * FROM "plan_bundles" WHERE "project" = ? AND "status" = 'proposed' ORDER BY rowid`).all(args.project) as BundleRow[]) {
    const pending = pendingKinds(db, b);
    // An authorized bundle whose head moved before its publication is
    // re-based too (carried item (i)); one with nothing pending and an
    // unmoved head has nothing to rebind.
    const bound = boundHead(b);
    if (pending.length === 0 && !(authorized(db, b) && bound !== head)) continue;
    const unasked = pending.some((k) => db.prepare(`SELECT 1 FROM "decisions" WHERE "kind" = ? AND "scope" = ? AND "status" = 'open'`).get(k, b.id) === undefined);
    if (bound !== head || unasked) out.push({ bundle: b.id, repo: p.dev_repo_path, from: bound, to: head, paths: Object.keys(JSON.parse(b.blobs) as Record<string, string>) });
  }
  return out;
}

// The bound inputs of a bundle a head move can touch (B03): the
// specification's files, the Architect's paths, and every proposed path.
const BOUND_PREFIXES = ['.surety/spec/', '.surety/architecture/', '.surety/adrs/', '.surety/roadmap/', '.surety/phases/'];
export const touchesBundle = (changed: string[], paths: string[]): string[] => changed.filter((c) => paths.includes(c) || BOUND_PREFIXES.some((p) => c.startsWith(p)));

// The bundle re-bound to the head: `touched` (the changed bound paths, or
// null when the diff could not be read) makes it stale; otherwise, its
// baseline still current, its head becomes `to` and every pending approval
// is raised as the next generation, one batch. Never a proposed bundle
// with no open decision.
export function rebindBundle(tx: Tx, args: { bundle: string; from: string; to: string; touched: string[] | null; deleted?: string[] }): { outcome: 'rebound' | 'stale' | 'moved' | 'none'; why?: string } {
  const b = getBundle(tx.db, args.bundle);
  if (!b || b.status !== 'proposed' || boundHead(b) !== args.from) return { outcome: 'none' };
  const p = projectRepoRow(tx, b.project);
  if ((registryRow(tx, b.project, integrationRef(p.integration_branch))?.expected_oid ?? null) !== args.to) return { outcome: 'moved' };
  const stale = (why: string) => {
    markBundleStale(tx, b, why);
    return { outcome: 'stale' as const, why };
  };
  if (args.touched === null) return stale(`the integration head moved from ${args.from} to ${args.to}, and what changed could not be read`);
  // A reference the plan makes, gone at the new head (D6-P01; M425 (e); the
  // driver's ruling 4): named first.
  const plan = (JSON.parse(b.artifacts) as BundleContent).plan;
  const gone = plan ? [...new Set(plan.stages.flatMap((st) => st.adrs))].filter((k) => (args.deleted ?? []).includes(`.surety/adrs/${k}.md`)).sort() : [];
  if (gone.length > 0) return stale(`PLAN_UNKNOWN_ADR ${gone.join(', ')}: the integration head moved from ${args.from} to ${args.to}, deleting an ADR the plan cites`);
  // A phase plan file another proposal committed is that proposal's draft
  // intent: the plans a publication reads are the store's, and the active
  // generation is compared at publication (D6 §5.5, §5.7; B08: two pending
  // replacements answered in turn, the second losing the swap). Any other
  // bound input moved makes the bundle stale.
  const touched = args.touched.filter((path) => !path.startsWith('.surety/phases/'));
  if (touched.length > 0) return stale(`the integration head moved from ${args.from} to ${args.to}, changing ${touched.join(', ')}, which the bundle is bound to`);
  const why = unpublishable(tx.db, b, routeOf(tx.db, b), { head: false });
  if (why !== null) return stale(why);
  if (args.from !== args.to) {
    // Re-bound: its head is the new one, its own integration behind it.
    const content = JSON.parse(b.artifacts) as BundleContent;
    delete content.own_commit;
    tx.db.prepare('UPDATE "plan_bundles" SET "head" = ?, "artifacts" = ? WHERE "id" = ?').run(args.to, JSON.stringify(content), b.id);
  }
  for (const kind of pendingKinds(tx.db, b)) raiseQuestion(tx, { project: b.project, kind, subjectType: 'run', subjectId: b.run!, scope: b.id });
  tx.db.prepare(`UPDATE "decisions" SET "batch_key" = ? WHERE "scope" = ? AND "status" = 'open' AND "kind" IN ('architecture_approval', 'plan_approval')`).run(b.id, b.id);
  return { outcome: 'rebound' };
}

// A head move known to touch no bound input (a policy commit changes
// `.surety/policy.json` alone): every proposed bundle on the old head is
// re-bound to the new one in the move's own transaction, its pending
// approvals raised as their next generation (B03; the review's gap).
export function rebindHarmless(tx: Tx, args: { project: string; from: string; to: string }): void {
  const rows = (tx.db.prepare(`SELECT * FROM "plan_bundles" WHERE "project" = ? AND "status" = 'proposed'`).all(args.project) as BundleRow[]).filter((b) => boundHead(b) === args.from);
  for (const r of rows) if (pendingKinds(tx.db, getBundle(tx.db, r.id)!).length > 0) rebindBundle(tx, { bundle: r.id, from: args.from, to: args.to, touched: [] });
}
