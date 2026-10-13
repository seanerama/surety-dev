// The mechanical plan check (F §3.10.6; D6 §5.3, §5.4; B03, B04): one pure
// function of the proposed artifact tree, the bundle it is checked against
// and what the store holds of the approved baseline, giving the reason codes
// of D6 A.4 with their subjects, the planned obligations per scope, and the
// computed changes against the approved artifacts (routing's input). It
// executes nothing and registers nothing: its record is the plan_check row,
// and publication is bundle.ts's.
//
// `PLAN_QUESTION_OPEN` names `R<n>:Q<k>`, a hint-less question on an
// unassigned requirement refusing every plan (slice 34); the sixteen
// reasons' cases are slice 35's (BS5 §9.2).

import { KIND_INVENTORY, TIER_RANK, type Tier, cadenceTier } from '../checks/scope.js';
import type { AdrFrontMatter, ModuleMap, PhasePlanFile, PlanStage, Roadmap } from './schemas.js';
import { canonical, sha256 } from '../store/transitions/common.js';

export interface PlanReason {
  code: string;
  subjects: string[];
}

// The baseline the bundle is checked against (D6 §3.4: approved, or
// prospective for the first bundle).
export interface BundleBaseline {
  spec_version: number;
  // The approved requirements: key → criteria ids, areas, withdrawn.
  requirements: { key: string; criteria: string[]; sensitive_areas: string[]; withdrawn: boolean; blocked_by_questions: string[]; defect?: boolean; descriptive_unverified?: boolean }[];
  // TPL §10's open questions of the bundle's specification (B04; D6-P07),
  // each with the keys it blocks and its `(phase n)` hint.
  questions?: { id: string; blocks: string[]; phase_hint: number | null }[];
  // D6 §8 (K11; B10): the project was adopted (a conformance stage belongs
  // only to its phase 1), and its adoption mode.
  adopted?: boolean;
  // The versions the bundle names (the approved ones, or the ones
  // publication will allocate).
  architecture_version: number;
  roadmap_version: number;
  head: string;
  project_tier: string;
  // Phases complete already (their numbers).
  completed_phases: number[];
  // The approved artifacts, for the computed diff (B03): null for a first
  // bundle, which has none.
  approved: { modules: ModuleMap; roadmap: Roadmap; adrs: Record<string, string>; architecture_text: string | null } | null;
}

export interface BundleArtifacts {
  modules: ModuleMap;
  roadmap: Roadmap;
  // ADR key → the file's text.
  adrs: Record<string, string>;
  adr_front_matter: Record<string, AdrFrontMatter>;
  architecture_text: string | null;
  plan: PhasePlanFile;
}

export interface ScopeObligation {
  scope: { kind: 'stage'; number: number } | { kind: 'phase'; number: number };
  tier: Tier;
  criteria: string[];
  kinds: string[];
  sensitive_areas: string[];
}

export interface Changes {
  changes_architecture: { changed: boolean; subjects: string[] };
  changes_adrs: { added: string[]; changed: string[]; deleted: string[] };
  changes_roadmap: { phases_added: number[]; phases_removed: number[]; goals: number[]; memberships: number[]; assignments: string[]; dependencies: number[] };
}

export interface PlanCheckResult {
  outcome: 'passed' | 'refused';
  reasons: PlanReason[];
  planned_obligations: ScopeObligation[];
  changes: Changes;
  changes_goals: boolean;
  roadmap_revision: boolean;
  needs_spec_change: boolean;
  conformance: 'within_baseline' | 'uncertain';
  // §5.4: registered automatically, or to the human.
  routing: 'registered' | 'human';
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

// The stage graph is acyclic (clause 3): a depth-first search by number.
function cycle(stages: { number: number; depends_on: number[] }[]): number[] | null {
  const state = new Map<number, 'open' | 'done'>();
  const path: number[] = [];
  const byNumber = new Map(stages.map((s) => [s.number, s]));
  const visit = (n: number): number[] | null => {
    const s = state.get(n);
    if (s === 'done') return null;
    if (s === 'open') return [...path.slice(path.indexOf(n)), n];
    state.set(n, 'open');
    path.push(n);
    for (const d of byNumber.get(n)?.depends_on ?? []) {
      if (!byNumber.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(n, 'done');
    return null;
  };
  for (const s of stages) {
    const found = visit(s.number);
    if (found) return found;
  }
  return null;
}

export function computeChanges(baseline: BundleBaseline, a: BundleArtifacts): Changes {
  const approved = baseline.approved;
  if (approved === null) {
    return {
      changes_architecture: { changed: true, subjects: ['architecture', 'modules'] },
      changes_adrs: { added: Object.keys(a.adrs).sort(), changed: [], deleted: [] },
      changes_roadmap: {
        phases_added: a.roadmap.phases.map((p) => p.number),
        phases_removed: [],
        goals: [],
        memberships: [],
        assignments: [],
        dependencies: [],
      },
    };
  }
  const archSubjects: string[] = [];
  if ((approved.architecture_text ?? '') !== (a.architecture_text ?? '')) archSubjects.push('architecture');
  if (canonical(approved.modules) !== canonical(a.modules)) archSubjects.push('modules');
  const adrs = { added: [] as string[], changed: [] as string[], deleted: [] as string[] };
  for (const key of Object.keys(a.adrs)) {
    if (!(key in approved.adrs)) adrs.added.push(key);
    else if (approved.adrs[key] !== a.adrs[key]) adrs.changed.push(key);
  }
  for (const key of Object.keys(approved.adrs)) if (!(key in a.adrs)) adrs.deleted.push(key);
  const r0 = approved.roadmap;
  const r1 = a.roadmap;
  const nums0 = new Set(r0.phases.map((p) => p.number));
  const nums1 = new Set(r1.phases.map((p) => p.number));
  const roadmap: Changes['changes_roadmap'] = { phases_added: [], phases_removed: [], goals: [], memberships: [], assignments: [], dependencies: [] };
  for (const n of nums1) if (!nums0.has(n)) roadmap.phases_added.push(n);
  for (const n of nums0) if (!nums1.has(n)) roadmap.phases_removed.push(n);
  for (const p1 of r1.phases) {
    const p0 = r0.phases.find((p) => p.number === p1.number);
    if (!p0) continue;
    if (p0.goal !== p1.goal) roadmap.goals.push(p1.number);
    if (canonical([...p0.modules].sort()) !== canonical([...p1.modules].sort())) roadmap.memberships.push(p1.number);
    if (canonical([...p0.depends_on].sort()) !== canonical([...p1.depends_on].sort())) roadmap.dependencies.push(p1.number);
  }
  const assigned = (r: Roadmap) => new Map(r.phases.flatMap((p) => p.requirement_ids.map((k) => [k, p.number] as const)));
  const a0 = assigned(r0);
  const a1 = assigned(r1);
  for (const [k, n] of a1) if (a0.get(k) !== n) roadmap.assignments.push(k);
  for (const k of a0.keys()) if (!a1.has(k)) roadmap.assignments.push(k);
  return { changes_architecture: { changed: archSubjects.length > 0, subjects: archSubjects }, changes_adrs: { added: adrs.added.sort(), changed: adrs.changed.sort(), deleted: adrs.deleted.sort() }, changes_roadmap: { ...roadmap, assignments: uniq(roadmap.assignments).sort() } };
}

export function checkPlan(baseline: BundleBaseline, a: BundleArtifacts): PlanCheckResult {
  const reasons: PlanReason[] = [];
  const add = (code: string, subjects: string[]) => {
    const list = uniq(subjects).sort();
    if (list.length > 0) reasons.push({ code, subjects: list });
  };
  const plan = a.plan;
  const reqs = new Map(baseline.requirements.map((r) => [r.key, r]));
  const moduleNames = new Set(a.modules.modules.map((m) => m.name));
  const adrKeys = new Set(Object.keys(a.adr_front_matter));
  const stageNumbers = plan.stages.map((s) => s.number);
  const phase = a.roadmap.phases.find((p) => p.number === plan.phase);

  // 1. References.
  const unknownReq: string[] = [];
  const unknownModule: string[] = [];
  const unknownAdr: string[] = [];
  const criterionMismatch: string[] = [];
  const unknownStage: string[] = [];
  const questionOpen: string[] = [];
  for (const s of plan.stages) {
    for (const k of s.implements) {
      const r = reqs.get(k);
      if (!r || r.withdrawn) unknownReq.push(k);
      // Each requirement named with the question that blocks it (`R<n>:Q<k>`).
      else for (const q of r.blocked_by_questions) questionOpen.push(`${k}:${q}`);
    }
    for (const m of s.modules) if (!moduleNames.has(m)) unknownModule.push(m);
    for (const k of s.adrs) if (!adrKeys.has(k)) unknownAdr.push(k);
    for (const c of s.validation.criteria) {
      const key = c.split('.')[0]!;
      const r = reqs.get(key);
      if (!s.implements.includes(key) || !r || !r.criteria.includes(c)) criterionMismatch.push(c);
    }
    for (const d of s.depends_on) if (!stageNumbers.includes(d) || d === s.number) unknownStage.push(`stage ${s.number} -> ${d}`);
  }
  add('PLAN_UNKNOWN_REQUIREMENT', unknownReq);
  add('PLAN_UNKNOWN_MODULE', unknownModule);
  add('PLAN_UNKNOWN_ADR', unknownAdr);
  add('PLAN_CRITERION_MISMATCH', criterionMismatch);
  add('PLAN_UNKNOWN_STAGE', unknownStage);
  const dup = stageNumbers.filter((n, i) => stageNumbers.indexOf(n) !== i);
  add('PLAN_DUPLICATE_STAGE', dup.map((n) => `stage ${n}`));
  // A question with no phase hint whose requirement no phase holds blocks
  // every plan, whatever it implements, until the question is resolved or
  // the requirement assigned (D6 §5.3 clause 1; D6-P07).
  const held = new Set(a.roadmap.phases.flatMap((p) => p.requirement_ids));
  for (const q of baseline.questions ?? []) {
    if (q.phase_hint !== null) continue;
    for (const k of q.blocks) if (reqs.has(k) && !reqs.get(k)!.withdrawn && !held.has(k)) questionOpen.push(`${k}:${q.id}`);
  }
  add('PLAN_QUESTION_OPEN', questionOpen);
  // The roadmap's own references (D6 §3.3, §5.1): every approved requirement
  // in exactly one phase; phase modules in the module map; phase
  // dependencies acyclic and named.
  const assigned = new Map<string, number[]>();
  for (const p of a.roadmap.phases) for (const k of p.requirement_ids) assigned.set(k, [...(assigned.get(k) ?? []), p.number]);
  const roadmapUnknown = [...assigned.keys()].filter((k) => !reqs.has(k) || reqs.get(k)!.withdrawn);
  add('PLAN_UNKNOWN_REQUIREMENT', roadmapUnknown.map((k) => `roadmap:${k}`));
  const twice = [...assigned.entries()].filter(([, ns]) => ns.length > 1).map(([k]) => `roadmap:${k}`);
  const omitted = baseline.requirements.filter((r) => !r.withdrawn && !assigned.has(r.key)).map((r) => `roadmap:${r.key}`);
  add('PLAN_REQUIREMENT_UNPLANNED', [...twice.map((k) => `${k}:twice`), ...omitted]);
  add('PLAN_UNKNOWN_MODULE', a.roadmap.phases.flatMap((p) => p.modules.filter((m) => !moduleNames.has(m)).map((m) => `roadmap:${p.number}:${m}`)));
  const phaseNumbers = new Set(a.roadmap.phases.map((p) => p.number));
  const phaseCycle = cycle(a.roadmap.phases.map((p) => ({ number: p.number, depends_on: p.depends_on })));
  add('PLAN_CYCLE', phaseCycle ? [`roadmap:${phaseCycle.join('->')}`] : []);
  add('PLAN_UNKNOWN_STAGE', a.roadmap.phases.flatMap((p) => p.depends_on.filter((d) => !phaseNumbers.has(d) || d === p.number).map((d) => `roadmap:${p.number}->${d}`)));
  // The ADR front matter's keys match their files; a superseded ADR names one.
  add('PLAN_UNKNOWN_ADR', Object.values(a.adr_front_matter).flatMap((f) => (f.supersedes !== undefined && !adrKeys.has(f.supersedes) ? [f.supersedes] : [])));

  // 2. Approvals: prepared_against the bundle's versions and head.
  const stale: string[] = [];
  if (plan.prepared_against.spec_version !== baseline.spec_version) stale.push(`spec_version ${plan.prepared_against.spec_version} (approved ${baseline.spec_version})`);
  if (plan.prepared_against.architecture_version !== baseline.architecture_version) stale.push(`architecture_version ${plan.prepared_against.architecture_version} (bundle ${baseline.architecture_version})`);
  if (plan.prepared_against.roadmap_version !== baseline.roadmap_version) stale.push(`roadmap_version ${plan.prepared_against.roadmap_version} (bundle ${baseline.roadmap_version})`);
  if (plan.prepared_against.revision !== baseline.head) stale.push(`revision ${plan.prepared_against.revision} (head ${baseline.head})`);
  if (a.roadmap.version !== baseline.roadmap_version) stale.push(`roadmap.json version ${a.roadmap.version} (bundle ${baseline.roadmap_version})`);
  if (a.roadmap.architecture_version !== baseline.architecture_version) stale.push(`roadmap.json architecture_version ${a.roadmap.architecture_version} (bundle ${baseline.architecture_version})`);
  add('PLAN_STALE_BASELINE', stale);

  // 3. Dependencies.
  const stageCycle = cycle(plan.stages);
  add('PLAN_CYCLE', stageCycle ? [`stages:${stageCycle.join('->')}`] : []);
  if (!phase) add('PLAN_REQUIREMENT_UNPLANNED', [`phase ${plan.phase} is not in the roadmap`]);
  else {
    add('PLAN_MODULE_OUTSIDE_PHASE', plan.stages.flatMap((s) => s.modules.filter((m) => !phase.modules.includes(m)).map((m) => `stage ${s.number}:${m}`)));
    const implemented = new Set(plan.stages.flatMap((s) => s.implements));
    add('PLAN_REQUIREMENT_UNPLANNED', phase.requirement_ids.filter((k) => !implemented.has(k)));
    add('PLAN_DEPENDENCY_INCOMPLETE', phase.depends_on.filter((d) => !baseline.completed_phases.includes(d)).map((d) => `phase ${d}`));
    // A stage may implement only what the roadmap assigns to the phase.
    add('PLAN_MODULE_OUTSIDE_PHASE', plan.stages.flatMap((s) => s.implements.filter((k) => reqs.has(k) && !phase.requirement_ids.includes(k)).map((k) => `stage ${s.number}:${k}`)));
  }

  // 4. Validation obligations per scope (B04): derived from implements and
  // modules and the phase's assignment, not the union of the arrays.
  const obligations: ScopeObligation[] = [];
  const moduleRows = a.modules.modules;
  const tierOf = (names: string[]): Tier => cadenceTier(baseline.project_tier, moduleRows.filter((m) => names.includes(m.name)).map((m) => ({ tier_override: m.tier_override ?? null })));
  const unvalidatedCriteria: string[] = [];
  const unvalidatedAreas: string[] = [];
  const missingKinds: string[] = [];
  for (const s of plan.stages) {
    const tier = tierOf(s.modules);
    const criteria = uniq(s.implements.flatMap((k) => reqs.get(k)?.criteria ?? []));
    const areas = uniq([...s.implements.flatMap((k) => reqs.get(k)?.sensitive_areas ?? []), ...moduleRows.filter((m) => s.modules.includes(m.name)).flatMap((m) => m.sensitive_areas)]).sort();
    const kinds = [...KIND_INVENTORY[tier]];
    obligations.push({ scope: { kind: 'stage', number: s.number }, tier, criteria, kinds, sensitive_areas: areas });
    for (const c of criteria) if (!s.validation.criteria.includes(c)) unvalidatedCriteria.push(c);
    for (const area of areas) if (!s.validation.sensitive_areas.includes(area)) unvalidatedAreas.push(`stage ${s.number}:${area}`);
    for (const k of kinds) if (!s.validation.kinds.includes(k)) missingKinds.push(`stage ${s.number}:${k}`);
  }
  if (phase) {
    const tier = tierOf(phase.modules);
    const criteria = uniq(phase.requirement_ids.flatMap((k) => reqs.get(k)?.criteria ?? []));
    const areas = uniq([...phase.requirement_ids.flatMap((k) => reqs.get(k)?.sensitive_areas ?? []), ...moduleRows.filter((m) => phase.modules.includes(m.name)).flatMap((m) => m.sensitive_areas)]).sort();
    obligations.push({ scope: { kind: 'phase', number: phase.number }, tier, criteria, kinds: [...KIND_INVENTORY[tier]], sensitive_areas: areas });
  }
  // 5. Retrofit (D6 §8; K11; B10, B11): the conformance stage is phase 1's
  // one stage of an adopted project, with no tasks, implementing no defect;
  // phase 1 of an adopted project changes no source (no repair before
  // conformance, E142 item 3); and in scoped mode no stage implements a
  // requirement still descriptive_unverified until its criteria are
  // approved (the engine knows a requirement's module through the stages
  // that implement it: the reading recorded in the slice-32 report).
  const conformanceStages = plan.stages.filter((s) => s.conformance === true);
  const misplaced: string[] = [];
  if (!baseline.adopted) misplaced.push(...conformanceStages.map((s) => `stage ${s.number}: the project is not adopted`));
  else {
    if (plan.phase !== 1) misplaced.push(...conformanceStages.map((s) => `stage ${s.number}: phase ${plan.phase} is not the conformance phase`));
    misplaced.push(...conformanceStages.slice(1).map((s) => `stage ${s.number}: a second conformance stage`));
    misplaced.push(...conformanceStages.filter((s) => s.tasks.length > 0).map((s) => `stage ${s.number}: a conformance stage has no tasks`));
    for (const s of conformanceStages) for (const k of s.implements) if (reqs.get(k)?.defect) misplaced.push(`stage ${s.number}:${k}: a defect is delivered by a later phase, never by conformance`);
    if (plan.phase === 1) misplaced.push(...plan.stages.filter((s) => s.conformance !== true).map((s) => `stage ${s.number}: phase 1 of an adopted project changes no source`));
  }
  add('PLAN_CONFORMANCE_MISPLACED', misplaced);
  // Scoped mode (Sean, 2026-10-13; D6-R04, R08): a stage that touches a
  // module the module map says holds a descriptive, criteria-less
  // requirement is refused, whatever the stage claims to implement; one that
  // claims to implement such a requirement is refused too.
  const descriptive = (k: string) => reqs.get(k)?.descriptive_unverified === true;
  const touched: string[] = [];
  for (const s of plan.stages) {
    for (const m of a.modules.modules.filter((mm) => s.modules.includes(mm.name))) for (const k of (m.requirements ?? []).filter(descriptive)) touched.push(`stage ${s.number}:${m.name}:${k}`);
    for (const k of s.implements.filter(descriptive)) touched.push(`stage ${s.number}:${k}`);
  }
  add('PLAN_DESCRIPTIVE_MODULE_TOUCHED', touched);
  add('PLAN_CRITERION_UNVALIDATED', unvalidatedCriteria);
  add('PLAN_AREA_UNVALIDATED', unvalidatedAreas);
  add('PLAN_KIND_MISSING', missingKinds);

  // Routing (§5.4): computed from the diff, never from the declaration; the
  // declaration adds uncertainty only.
  const changes = computeChanges(baseline, a);
  const roadmapChanged =
    changes.changes_roadmap.phases_added.length + changes.changes_roadmap.phases_removed.length + changes.changes_roadmap.goals.length + changes.changes_roadmap.memberships.length + changes.changes_roadmap.assignments.length + changes.changes_roadmap.dependencies.length >
    0;
  const adrsChanged = changes.changes_adrs.added.length + changes.changes_adrs.changed.length + changes.changes_adrs.deleted.length > 0;
  const baselineChanging = changes.changes_architecture.changed || adrsChanged || roadmapChanged || a.plan.roadmap_revision !== undefined;
  const needsSpecChange = unknownReq.length > 0;
  const outcome = reasons.length === 0 ? 'passed' : 'refused';
  const conformance = plan.conformance;
  const routing: 'registered' | 'human' = outcome === 'passed' && !baselineChanging && conformance === 'within_baseline' ? 'registered' : 'human';
  return {
    outcome,
    reasons,
    planned_obligations: obligations,
    changes,
    changes_goals: changes.changes_roadmap.goals.length > 0,
    roadmap_revision: roadmapChanged,
    needs_spec_change: needsSpecChange,
    conformance,
    routing,
  };
}

// A stage's execution and acceptance inputs, hashed (D6 A.3
// `execution_inputs_digest`; B08).
export function executionInputsDigest(s: PlanStage): string {
  return sha256(canonical({ number: s.number, goal: s.goal, implements: [...s.implements].sort(), tasks: s.tasks, modules: [...s.modules].sort(), adrs: [...s.adrs].sort(), depends_on: [...s.depends_on].sort(), validation: s.validation, integration_obligations: s.integration_obligations }));
}

export const PLAN_REASONS = [
  'PLAN_UNKNOWN_REQUIREMENT',
  'PLAN_UNKNOWN_MODULE',
  'PLAN_UNKNOWN_ADR',
  'PLAN_CRITERION_MISMATCH',
  'PLAN_UNKNOWN_STAGE',
  'PLAN_DUPLICATE_STAGE',
  'PLAN_QUESTION_OPEN',
  'PLAN_STALE_BASELINE',
  'PLAN_CYCLE',
  'PLAN_MODULE_OUTSIDE_PHASE',
  'PLAN_REQUIREMENT_UNPLANNED',
  'PLAN_DEPENDENCY_INCOMPLETE',
  'PLAN_CRITERION_UNVALIDATED',
  'PLAN_AREA_UNVALIDATED',
  'PLAN_KIND_MISSING',
  'PLAN_DESCRIPTIVE_MODULE_TOUCHED',
  'PLAN_CONFORMANCE_MISPLACED',
] as const;

export const tierRank = (t: Tier): number => TIER_RANK[t]!;
