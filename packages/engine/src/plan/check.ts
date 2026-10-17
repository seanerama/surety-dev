// The mechanical plan check (F §3.10.6; D6 §5.3, §5.4; B03, B04): one pure
// function of the proposed artifact tree, the bundle it is checked against
// and what the store holds of the approved baseline, giving the reason codes
// of D6 A.4 with their subjects, the planned obligations per scope, and the
// computed changes against the approved artifacts (routing's input). It
// executes nothing and registers nothing: its record is the plan_check row,
// and publication is bundle.ts's.
//
// `PLAN_QUESTION_OPEN` names `R<n>:Q<k>`, a hint-less question on an
// unassigned requirement refusing every plan (slice 34). Slice 35: the
// validation clause through D3 §4.3's one coverage primitive; `phase_size`
// as computed uncertainty, never a refusal; an early replacement's kept
// stages (D6 §5.7; B08).

import { TIER_RANK, type Tier, computeScope, modulePathOk } from '../checks/scope.js';
import type { AdrFrontMatter, ModuleMap, PhasePlanFile, PlanStage, Roadmap } from './schemas.js';
import { canonical, sha256 } from '../store/transitions/common.js';

// A replan held for its prerequisite results (M543; M444F-1): the dispatch
// blocker's and the held run's text begin with it.
export const PREREQUISITES_PENDING = 'depends on prerequisite results still to come';

export interface PlanReason {
  code: string;
  subjects: string[];
}

// The baseline the bundle is checked against (D6 §3.4: approved, or
// prospective for the first bundle).
export interface BundleBaseline {
  spec_version: number;
  // The approved requirements: key → criteria ids, areas, withdrawn.
  requirements: { key: string; criteria: string[]; sensitive_areas: string[]; withdrawn: boolean; blocked_by_questions: string[]; defect?: boolean; descriptive_unverified?: boolean; human_test?: boolean; design_human_test?: boolean }[];
  // TPL §10's open questions of the bundle's specification (B04; D6-P07),
  // each with the keys it blocks and its `(phase n)` hint.
  questions?: { id: string; blocks: string[]; phase_hint: number | null }[];
  // D6 §8 (K11; B10): the project was adopted (a conformance stage belongs
  // only to its phase 1), and its adoption mode.
  adopted?: boolean;
  // The versions the bundle names (the approved ones, or the ones
  // publication will allocate).
  architecture_version: number;
  // The architecture version an unchanged roadmap.json names: the one the
  // approved roadmap was made with (a replan that changes the architecture
  // but not the roadmap keeps it; the review's M4). Default
  // architecture_version.
  roadmap_architecture_version?: number;
  roadmap_version: number;
  head: string;
  project_tier: string;
  // Phases complete already and still held by the newest candidate (their
  // numbers); a completed phase not held is named in `phase_unknown` with
  // what it lacks (D6 §5.8; the review's N4).
  completed_phases: number[];
  phase_unknown?: Record<number, string[]>;
  // D6 §5.2, A.7 (F §9.2): the project's `phase_size`; a plan outside it is
  // `uncertain` and routed to the human, never refused. Absent: not judged.
  phase_size?: { min: number; max: number };
  // D7 §4.1, §8.3 (G2): the project's design policy and the specification's
  // `**Targets:**` (null when it states none), for clause 5. Absent: off.
  design?: { policy: string; spec_targets: string[] | null; spec_targets_unknown?: string };
  // D6 §5.7 (B08): an early replacement's kept stages (integrated or
  // verified in the generation it replaces), by number, with their
  // execution-inputs digest and the requirement keys they implement. Each
  // is a stage of the plan whether the file lists it or not; listed with
  // other inputs it is a second stage under its number.
  kept?: { number: number; digest: string | null; implements: string[]; validated?: string[] }[];
  // The criteria the replacement's trigger touched (a specification
  // change's changed or gained criteria): a kept stage's validation does
  // not settle them (KEPT_STAGE_RULE).
  touched?: string[];
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
  // Why the check itself routes to the human (D6 §5.2: `phase_size`), never
  // a reason to refuse.
  uncertain: string[];
  // The Architect's declaration, recorded and overridden by the computed
  // routing (D6 §5.4): it can add uncertainty, never suppress a change.
  declared: { conformance: 'within_baseline' | 'uncertain' };
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

// D7 §4.1's admissibility table: the targets each UI technology may serve;
// `other` any (its preview capability is never `native`, design/inventory.ts).
const ALL_TARGETS = ['web', 'android', 'ios', 'macos', 'windows', 'linux'];
export const TECHNOLOGY_TARGETS: Readonly<Record<string, readonly string[]>> = {
  html_css: ['web'],
  three_js: ['web'],
  streamlit: ['web'],
  react_native: ['android', 'ios'],
  flutter: ALL_TARGETS,
  swiftui: ['ios', 'macos'],
  compose: ['android'],
  other: ALL_TARGETS,
};
export const technologyAdmits = (technology: string, target: string): boolean => (TECHNOLOGY_TARGETS[technology] ?? []).includes(target);

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
  const kept = baseline.kept ?? [];
  const keptNumbers = kept.map((k) => k.number);
  const touchedSet = new Set(baseline.touched ?? []);
  // The kept stages that stand as built: omitted, or listed exactly.
  const keptStanding = kept.filter((k) => {
    const listed = plan.stages.find((st) => st.number === k.number);
    return listed === undefined || (k.digest !== null && k.digest === executionInputsDigest(listed));
  });
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
    for (const d of s.depends_on) if ((!stageNumbers.includes(d) && !keptNumbers.includes(d)) || d === s.number) unknownStage.push(`stage ${s.number} -> ${d}`);
  }
  add('PLAN_UNKNOWN_REQUIREMENT', unknownReq);
  add('PLAN_UNKNOWN_MODULE', unknownModule);
  // Every module path in the form the matcher reads (checks/scope.ts): one
  // it cannot read leaves the module's presence unread for good, and every
  // registration of the project owed (the real M443 run's `dir/**`, before
  // it was read as the directory). Refused here, so the session's close
  // fails loudly instead of the build stalling.
  add('PLAN_MODULE_PATH_INVALID', a.modules.modules.flatMap((m) => m.paths.filter((p) => !modulePathOk(p)).map((p) => `${m.name}:${p}`)));
  add('PLAN_UNKNOWN_ADR', unknownAdr);
  add('PLAN_CRITERION_MISMATCH', criterionMismatch);
  add('PLAN_UNKNOWN_STAGE', unknownStage);
  const dup = stageNumbers.filter((n, i) => stageNumbers.indexOf(n) !== i);
  // A kept stage listed with other inputs would be a second stage under
  // its number: the replacement keeps the stage as it is (D6 §5.7; the
  // driver's ruling 1).
  const keptChanged = plan.stages.filter((st) => {
    const k = kept.find((x) => x.number === st.number);
    return k !== undefined && k.digest !== executionInputsDigest(st);
  });
  add('PLAN_DUPLICATE_STAGE', [...dup.map((n) => `stage ${n}`), ...keptChanged.map((st) => `stage ${st.number}: kept (integrated) with other inputs`)]);
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
  const roadmapArchitecture = baseline.roadmap_architecture_version ?? baseline.architecture_version;
  if (a.roadmap.architecture_version !== roadmapArchitecture) stale.push(`roadmap.json architecture_version ${a.roadmap.architecture_version} (bundle ${roadmapArchitecture})`);
  add('PLAN_STALE_BASELINE', stale);

  // 3. Dependencies.
  const stageCycle = cycle(plan.stages);
  add('PLAN_CYCLE', stageCycle ? [`stages:${stageCycle.join('->')}`] : []);
  if (!phase) add('PLAN_REQUIREMENT_UNPLANNED', [`phase ${plan.phase} is not in the roadmap`]);
  else {
    add('PLAN_MODULE_OUTSIDE_PHASE', plan.stages.flatMap((s) => s.modules.filter((m) => !phase.modules.includes(m)).map((m) => `stage ${s.number}:${m}`)));
    const implemented = new Set([...plan.stages.flatMap((s) => s.implements), ...kept.filter((k) => !stageNumbers.includes(k.number)).flatMap((k) => k.implements)]);
    // A `descriptive_unverified` requirement is no obligation of the phase
    // (D6 §8.2, K10; the driver's ruling 7): still held to the roadmap.
    // Nor is a design's per-target human-only requirement the engine
    // assigned through the design approval, with no executable criterion
    // (E156 Q3; BS6 §11.5): its human test is a person's, pending, never a
    // stage's. A hand-written human test keeps D6's rule.
    const humanOnly = (k: string) => reqs.get(k)?.design_human_test === true && (reqs.get(k)?.criteria.length ?? 0) === 0;
    add('PLAN_REQUIREMENT_UNPLANNED', phase.requirement_ids.filter((k) => !implemented.has(k) && reqs.get(k)?.descriptive_unverified !== true && !humanOnly(k)));
    add('PLAN_DEPENDENCY_INCOMPLETE', phase.depends_on.filter((d) => !baseline.completed_phases.includes(d)).map((d) => (baseline.phase_unknown?.[d] ? `phase ${d} (${baseline.phase_unknown[d]!.join('; ')})` : `phase ${d}`)));
    // A stage may implement only what the roadmap assigns to the phase.
    add('PLAN_MODULE_OUTSIDE_PHASE', plan.stages.flatMap((s) => s.implements.filter((k) => reqs.has(k) && !phase.requirement_ids.includes(k)).map((k) => `stage ${s.number}:${k}`)));
  }

  // 4. Validation obligations per scope (B04): derived from implements and
  // modules and the phase's assignment, never from the union of the arrays,
  // and counted by D3 §4.3's primitive, computeScope, given the stage's
  // declared validation as an explicit planned-obligation input in place
  // of the required set (D6 §5.3 clause 4; D6-P04): one implementation.
  const obligations: ScopeObligation[] = [];
  const moduleRows = a.modules.modules;
  const unvalidatedCriteria: string[] = [];
  const unvalidatedAreas: string[] = [];
  const missingKinds: string[] = [];
  // Only a requirement with criteria to validate is an obligation: a
  // descriptive one is excluded (ruling 7).
  const obligated = (k: string) => reqs.has(k) && reqs.get(k)!.descriptive_unverified !== true && !reqs.get(k)!.withdrawn;
  const scopeRequirements = baseline.requirements.map((r) => ({ id: r.key, key: r.key, criteria: r.criteria, sensitive_areas: r.sensitive_areas, human_test: r.human_test === true }));
  const scopeModules = (names: string[]) => moduleRows.filter((m) => names.includes(m.name)).map((m) => ({ id: m.name, name: m.name, sensitive_areas: m.sensitive_areas, tier_override: m.tier_override ?? null }));
  const planned = (kind: 'stage' | 'phase', keys: string[], modules: string[], covering?: { criteria: string[]; kinds: string[]; areas: string[] }) =>
    computeScope({ kind, projectTier: baseline.project_tier, checks: [], requirements: scopeRequirements, delivered: keys, partial: [], stageImplements: keys, modules: scopeModules(modules), ...(covering ? { covering } : {}) });
  for (const s of plan.stages) {
    const keys = s.implements.filter(obligated);
    const scope = planned('stage', keys, s.modules, { criteria: s.validation.criteria, kinds: s.validation.kinds, areas: s.validation.sensitive_areas });
    const criteria = uniq(keys.flatMap((k) => reqs.get(k)?.criteria ?? []));
    obligations.push({ scope: { kind: 'stage', number: s.number }, tier: scope.tier, criteria, kinds: [...scope.kinds], sensitive_areas: scope.categories });
    // A kept stage listed unchanged (KEPT_STAGE_RULE) cannot take criteria
    // its requirement gained after it was built: they are not charged to it,
    // but another stage of the plan must validate them (the driver's ruling
    // on the real M443 run's replan).
    const k = kept.find((x) => x.number === s.number);
    const keptUnchanged = k !== undefined && k.digest !== null && k.digest === executionInputsDigest(s);
    // And (the driver's ruling on the retry): a criterion a kept stage
    // (omitted, or listed exactly) validated as built, and the trigger did
    // not touch, stays that stage's, and counts as validated: a new stage
    // implementing the same requirement validates only what was gained or
    // changed.
    const settled = (c: string) => !touchedSet.has(c) && keptStanding.some((x) => x.number !== s.number && (x.validated ?? []).includes(c));
    const missing = (keptUnchanged ? scope.missing.criteria.filter((c) => !plan.stages.some((t) => t !== s && t.validation.criteria.includes(c))) : scope.missing.criteria).filter((c) => !settled(c));
    unvalidatedCriteria.push(...missing.map((c) => `stage ${s.number}:${c}`));
    unvalidatedAreas.push(...scope.missing.areas.map((area) => `stage ${s.number}:${area.replace(/^area:/, '')}`));
    missingKinds.push(...scope.missing.kinds.map((k) => `stage ${s.number}:${k.replace(/^kind:/, '')}`));
  }
  if (phase) {
    const keys = phase.requirement_ids.filter(obligated);
    const scope = planned('phase', keys, phase.modules);
    obligations.push({ scope: { kind: 'phase', number: phase.number }, tier: scope.tier, criteria: uniq(keys.flatMap((k) => reqs.get(k)?.criteria ?? [])), kinds: [...scope.kinds], sensitive_areas: scope.categories });
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
  // 5. Interfaces and targets (D7 §4.1, §8.3; G2; SEAM.md §495), under a
  // design policy other than off: the spec states the targets (the engine
  // assumes none), the `ui` modules serve exactly them, each with a UI
  // technology the admissibility table admits on it. (ARCH_INTERFACE_SHAPE_MISSING
  // is M508's, slice 44.)
  let targetsMissing = false;
  if (baseline.design && baseline.design.policy !== 'off') {
    const ui = a.modules.modules.filter((m) => m.surface === 'ui');
    const specTargets = baseline.design.spec_targets ?? [];
    if (ui.length > 0 && baseline.design.spec_targets_unknown !== undefined) {
      // Unknown, not missing: refused naming why, and not routed to a
      // specification change (the review's N1).
      add('SPEC_TARGETS_MISSING', [`unknown: ${baseline.design.spec_targets_unknown}`]);
    } else if (ui.length > 0 && specTargets.length === 0) {
      add('SPEC_TARGETS_MISSING', ui.map((m) => m.name));
      targetsMissing = true;
    }
    if (ui.length > 0 && specTargets.length > 0) {
      const served = new Set(ui.flatMap((m) => (m.targets ?? []).map((t) => t.target)));
      add('ARCH_TARGET_UNKNOWN', ui.flatMap((m) => (m.targets ?? []).filter((t) => !specTargets.includes(t.target)).map((t) => `${m.name}:${t.target}`)));
      add('ARCH_TARGET_UNCOVERED', specTargets.filter((t) => !served.has(t)));
    }
    add('ARCH_TECHNOLOGY_TARGET_MISMATCH', ui.flatMap((m) => (m.targets ?? []).filter((t) => !technologyAdmits(t.ui_technology, t.target)).map((t) => `${m.name}:${t.target}:${t.ui_technology}`)));
  }
  // The spec's own gap is the spec-change workflow's (D7 §4.1: routed to
  // change_spec), never a plan's.
  const needsSpecChange = unknownReq.length > 0 || targetsMissing;
  const outcome = reasons.length === 0 ? 'passed' : 'refused';
  // §5.2: a stage count outside `phase_size` is sense, not error: it routes
  // to the human, never refuses. Kept stages count toward it.
  const uncertain: string[] = [];
  const size = new Set([...stageNumbers, ...keptNumbers]).size;
  if (baseline.phase_size && (size < baseline.phase_size.min || size > baseline.phase_size.max)) uncertain.push(`phase_size: ${size} stages, outside {min ${baseline.phase_size.min}, max ${baseline.phase_size.max}}`);
  const conformance: 'within_baseline' | 'uncertain' = plan.conformance === 'uncertain' || uncertain.length > 0 ? 'uncertain' : 'within_baseline';
  const routing: 'registered' | 'human' = outcome === 'passed' && !baselineChanging && conformance === 'within_baseline' ? 'registered' : 'human';
  return {
    outcome,
    uncertain,
    declared: { conformance: plan.conformance },
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

// The criteria a replacement's trigger touched (its `stale`, as
// `criterion:<id>`): those a kept stage's validation no longer settles.
export function touchedCriteria(stale: unknown): string[] {
  return Array.isArray(stale) ? stale.filter((x): x is string => typeof x === 'string' && x.startsWith('criterion:')).map((x) => x.slice('criterion:'.length)) : [];
}

// The kept-stage rule (D6 §5.7; B08), stated to the Architect as this check
// applies it (plan/replan-package.ts): an integrated or verified stage of
// the plan a replan replaces is kept as built.
export const KEPT_STAGE_RULE =
  "Omitting a kept stage is always valid: it stays as built. Listing one is valid only with exactly the inputs it was built with (number, goal, implements, tasks, modules, adrs, depends_on, validation, integration_obligations); a kept stage listed with any other input is refused (PLAN_DUPLICATE_STAGE). Criteria a kept stage's requirement gained or changed since it was built are planned in a new stage, under a new number, that implements that requirement and validates only those gained or changed criteria; the requirement's other criteria stay validated by the kept stage.";

// The per-stage validation rule (the driver's ruling on the real M443 run
// and loop run 1: two stages split R12 and validated its criteria between
// them, and were refused), stated to the Architect as step 4 above applies
// it: each stage's gate scope is built from its own implements, so its own
// validation must cover them. The replan exceptions (criteria only) follow.
export const STAGE_VALIDATION_RULE =
  "Each stage validates what it implements, in its own validation: every criterion of every requirement a stage implements is in that stage's validation.criteria, and every sensitive area of those requirements and of the modules it touches is in that stage's validation.sensitive_areas. A requirement implemented by several stages is validated in full by each of them: every one of those stages lists all of the requirement's criteria; another stage's validation never counts for it.";
export const STAGE_VALIDATION_REPLAN_EXCEPTIONS =
  "In a replan, two exceptions, for criteria only: a kept stage listed unchanged is not charged a criterion its requirement gained after it was built (another stage of the plan validates it, as the kept-stage rule says); and a criterion a kept stage validated as built, which this replan's trigger did not touch, stays validated by that stage, so a new stage implementing the same requirement need list only the gained or changed criteria.";

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
  'PLAN_MODULE_PATH_INVALID',
  // Clause 5 (D7 §4.1, §8.3; G2), under a design policy other than off.
  'SPEC_TARGETS_MISSING',
  'ARCH_TARGET_UNKNOWN',
  'ARCH_TARGET_UNCOVERED',
  'ARCH_TECHNOLOGY_TARGET_MISMATCH',
] as const;

export const tierRank = (t: Tier): number => TIER_RANK[t]!;

// The complete diff of every changed artifact (D6 §5.4; B03; M427 (b),
// M426 (b)): each architecture or module-map artifact, ADR or roadmap the
// computed changes name, in full as approved and as proposed (null where
// one side has none), and the proposed plan. Built from the texts the
// store and the bundle hold, so it reads nothing from git. The whole
// roadmap is carried whenever any part of it changes.
export interface ArtifactDiff {
  artifact: 'architecture' | 'modules' | 'adr' | 'roadmap' | 'plan';
  path: string;
  approved: unknown;
  proposed: unknown;
}

export function artifactDiff(baseline: BundleBaseline, a: BundleArtifacts, changes: Changes): ArtifactDiff[] {
  const approved = baseline.approved;
  const out: ArtifactDiff[] = [];
  if (changes.changes_architecture.subjects.includes('architecture')) out.push({ artifact: 'architecture', path: '.surety/architecture/architecture.md', approved: approved?.architecture_text ?? null, proposed: a.architecture_text });
  if (changes.changes_architecture.subjects.includes('modules')) out.push({ artifact: 'modules', path: '.surety/architecture/modules.json', approved: approved?.modules ?? null, proposed: a.modules });
  const c = changes.changes_adrs;
  for (const key of [...c.added, ...c.changed, ...c.deleted].sort()) out.push({ artifact: 'adr', path: `.surety/adrs/${key}.md`, approved: approved?.adrs[key] ?? null, proposed: a.adrs[key] ?? null });
  const r = changes.changes_roadmap;
  const roadmapChanged = r.phases_added.length + r.phases_removed.length + r.goals.length + r.memberships.length + r.assignments.length + r.dependencies.length > 0 || a.plan.roadmap_revision !== undefined;
  if (roadmapChanged) out.push({ artifact: 'roadmap', path: '.surety/roadmap/roadmap.json', approved: approved?.roadmap ?? null, proposed: a.roadmap });
  out.push({ artifact: 'plan', path: `.surety/phases/phase-${a.plan.phase}.json`, approved: null, proposed: a.plan });
  return out;
}

// The spec-change workflow's route an unknown requirement is offered
// through (D6 §5.4; the driver's ruling 5): named, never invoked.
export const specChangeRoute = (project: string): string => `POST /v1/projects/${project}/spec/change-requests`;
