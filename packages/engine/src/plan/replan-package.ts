// The replan one-shot's context package (D6 §3.5, §5.6; F §3.10.5 step 2;
// A04; M424 (b), (d)): what the Architect replans from, every field read in
// one store read so that the package belongs to one approved generation,
// and never a session's transcript. The approved specification by its
// approved blob (`spec_revisions.git_blob`, read from git on the main
// thread); its index from the registered requirements; every ADR by the
// approved baseline texts (the package's `adrs/`, as built); the approved
// roadmap and module map; the completed plan with each stage's
// `integrated_revision`; the phase gate's evaluation with its per-check
// states; the phase's findings with their dispositions; the deferrals and
// open objections; and, on a repair, the reasons the last proposal was
// refused.

import { activeStages, dependsOnNumbers } from './active.js';
import { KEPT_STAGE_RULE, REBUILT_STAGE_RULE, touchedCriteria } from './check.js';
import { keptOf, replacementOf, subjectWorkOf } from './replace.js';
import { gitOk, repoContext } from '../git/exec.js';
import type { Tx } from '../store/transitions/tx.js';

type Db = Tx['db'];

export interface ReplanStage {
  number: number;
  goal: string;
  status: string;
  implements: string[];
  modules: string[];
  tasks: unknown;
  adrs: unknown;
  depends_on: unknown;
  validation: unknown;
  integration_obligations: unknown;
  integrated_revision: string | null;
  cancelled_at: string | null;
}

export interface ReplanPlan {
  id: string;
  phase_number: number;
  generation: number;
  status: string;
  published_at: string | null;
  completed_at: string | null;
  completion_binding: unknown;
  stages: ReplanStage[];
}

export interface ReplanFacts {
  repo: string;
  trigger: { source: string | null; id: string | null; generation: number | null };
  // An early replan's (D6 §5.7): the generation it replaces, the trigger's
  // evidence and what it made stale; a rejected proposal's note (§5.4).
  // Each null when the trigger carries none.
  trigger_subject: { replaces: { phase_plan: string; generation: number } | null; evidence: unknown; stale: unknown; rejected: unknown };
  generation: {
    spec_revision: { id: string; version: number; git_blob: string; semantic_digest: string } | null;
    architecture_revision: { id: string; version: number } | null;
    roadmap_revision: { id: string; version: number } | null;
    plan: { id: string; phase_number: number; generation: number } | null;
    spec_evidence_generation: number | null;
  };
  // Filled on the main thread from git (`spec_revisions.git_blob`); null
  // when it could not be read, never another version's text.
  spec_text?: string | null;
  index: { key: string; statement: string | null; criteria: unknown; sensitive_areas: unknown; assigned_phase: number | null; status: string; human_test: boolean; descriptive: boolean; withdrawn: boolean }[];
  roadmap: { version: number; phases: unknown } | null;
  module_map: unknown;
  completed_plan: ReplanPlan | null;
  open_plan: ReplanPlan | null;
  phase_evaluation: { id: string; candidate: string; outcome: string; reasons: unknown; check_states: unknown; computed_at: string; stale: boolean } | null;
  findings: Record<string, unknown>[];
  deferrals: { findings: Record<string, unknown>[]; obligations: Record<string, unknown>[] };
  objections: Record<string, unknown>[];
  refusal: { run: string; reason_class: string | null; reason_text: string | null; plan_check: { id: string; phase: number | null; reasons: unknown } | null } | null;
  // An early replacement's kept stages, as the plan check counts them
  // (plan/replace.ts keptOf; KEPT_STAGE_RULE): number and the requirement
  // keys each implements. Empty for any other replan.
  kept?: { number: number; implements: string[]; validated?: string[] }[];
  // The integrated or verified stages built on a stage this replacement
  // supersedes (E172 item 7 S2, the cascade): superseded with it and
  // registered fresh against the new dependency; `depends_on` by number.
  rebuilt?: { number: number; implements: string[]; depends_on: number[] }[];
  // The criteria the replacement's trigger touched (its stale `criterion:`
  // entries): what a new stage must validate.
  touched?: string[];
}

const json = (text: unknown): unknown => {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: text };
  }
};

function planOf(db: Db, project: string, id: string | null | undefined): ReplanPlan | null {
  if (!id) return null;
  const p = db.prepare('SELECT "id", "phase_number", "generation", "status", "published_at", "completed_at", "completion_binding" FROM "phase_plans" WHERE "id" = ? AND "project" = ?').get(id, project) as
    | { id: string; phase_number: number; generation: number; status: string; published_at: string | null; completed_at: string | null; completion_binding: string | null }
    | undefined;
  if (!p) return null;
  const keyOf = (r: string) => (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(project, r, r) as { key: string } | undefined)?.key ?? r;
  const nameOf = (m: string) => (db.prepare('SELECT "name" FROM "modules" WHERE "project" = ? AND ("id" = ? OR "name" = ?)').get(project, m, m) as { name: string } | undefined)?.name ?? m;
  // The generation's active stages (D6 §5.7; the review's M1).
  const stages = activeStages<Record<string, unknown>>(db, p.id).map((s) => ({
    number: s.number as number,
    goal: s.goal as string,
    status: s.status as string,
    implements: ((json(s.implements) as string[] | null) ?? []).map(keyOf),
    modules: ((json(s.modules) as string[] | null) ?? []).map(nameOf),
    tasks: json(s.tasks),
    // Every execution input a kept stage is compared by (plan/check.ts
    // executionInputsDigest), so it can be listed exactly as built.
    adrs: json(s.adrs),
    // As the plan schema has it (B.5: stage numbers), never the stage ids
    // the row holds: a kept stage copied as built must pass the schema.
    depends_on: dependsOnNumbers(db, s.depends_on),
    validation: json(s.validation),
    integration_obligations: json(s.integration_obligations),
    integrated_revision: (s.integrated_revision as string | null) ?? null,
    cancelled_at: (s.cancelled_at as string | null) ?? null,
  }));
  return { id: p.id, phase_number: p.phase_number, generation: p.generation, status: p.status, published_at: p.published_at, completed_at: p.completed_at, completion_binding: json(p.completion_binding), stages };
}

// A finding raised after the plan's publication and not after its
// completion, by event seq (parameters: the plan twice).
export const FINDING_RAISED_BETWEEN = `EXISTS (SELECT 1 FROM "events" r WHERE r."type" = 'finding.raised' AND json_extract(r."subject", '$.finding') = f."id"
  AND r."seq" >= COALESCE((SELECT MIN(p."seq") FROM "events" p WHERE p."type" = 'plan.published' AND json_extract(p."subject", '$.phase_plan') = ?), 0)
  AND r."seq" <= COALESCE((SELECT MIN(c."seq") FROM "events" c WHERE c."type" = 'baseline.phase_complete' AND json_extract(c."subject", '$.phase_plan') = ?), 9223372036854775807))`;

const FINDING_COLUMNS = '"id", "seq", "created_at", "scope", "candidate", "category", "effective_severity" AS "severity", "message", "check", "criterion", "sensitive_area", "status", "disposition", "disposition_at", "defer_target", "linked_issue", "source_role", "remediation"';

export function replanFacts(db: Db, item: { id: string; project: string; trigger_source: string | null; trigger_id: string | null; trigger_generation: number | null; subject?: string | null; trigger_evidence?: string | null }): ReplanFacts {
  const project = item.project;
  const p = db.prepare('SELECT "dev_repo_path", "spec_evidence_generation" FROM "projects" WHERE "id" = ?').get(project) as { dev_repo_path: string; spec_evidence_generation: number };
  const spec = db.prepare('SELECT "id", "version", "git_blob", "semantic_digest" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as
    | { id: string; version: number; git_blob: string; semantic_digest: string }
    | undefined;
  const arch = db.prepare('SELECT "id", "version", "module_map" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { id: string; version: number; module_map: string } | undefined;
  const road = db.prepare('SELECT "id", "version", "phases" FROM "roadmap_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { id: string; version: number; phases: string } | undefined;
  const index = (
    db
      .prepare('SELECT "key", "text", "criteria", "criteria_text", "sensitive_areas", "assigned_phase", "status", "human_test", "descriptive", "withdrawn_at" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
      .all(project) as { key: string; text: string | null; criteria: string | null; criteria_text: string | null; sensitive_areas: string; assigned_phase: number | null; status: string; human_test: number; descriptive: number; withdrawn_at: string | null }[]
  ).map((r) => ({
    key: r.key,
    statement: r.text,
    criteria: r.criteria_text !== null ? json(r.criteria_text) : json(r.criteria),
    sensitive_areas: json(r.sensitive_areas),
    assigned_phase: r.assigned_phase,
    status: r.status,
    human_test: r.human_test === 1,
    descriptive: r.descriptive === 1,
    withdrawn: r.withdrawn_at !== null,
  }));
  // The completed phase: the one the trigger names (phase_complete), else
  // the latest completed; and the open plan, if any (an early replan's).
  const triggered = item.trigger_source === 'phase_complete' ? item.trigger_id : null;
  const latestDone = (db.prepare(`SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "completed_at" IS NOT NULL ORDER BY "phase_number" DESC LIMIT 1`).get(project) as { id: string } | undefined)?.id ?? null;
  const completed = planOf(db, project, triggered ?? latestDone);
  const openId = (db.prepare(`SELECT "id" FROM "phase_plans" WHERE "project" = ? AND "status" = 'published' AND "active" = 1 AND "completed_at" IS NULL ORDER BY rowid DESC LIMIT 1`).get(project) as { id: string } | undefined)?.id ?? null;
  const open = planOf(db, project, openId);
  const binding = completed?.completion_binding as { candidate?: string } | null | undefined;
  const ev = binding?.candidate
    ? (db.prepare(`SELECT "id", "candidate", "outcome", "reasons", "check_states", "computed_at", "stale" FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = 'phase' AND "candidate" = ? ORDER BY rowid DESC, "id" DESC LIMIT 1`).get(project, binding.candidate) as
        | { id: string; candidate: string; outcome: string; reasons: string; check_states: string; computed_at: string; stale: number }
        | undefined)
    : undefined;
  // The phase's findings: raised while it was open, or still open. "While"
  // is the event log's order, between the plan's publication and its
  // completion, never wall time (the slice-36 review's N2): a clock step
  // drops no finding.
  const findings = completed
    ? (db.prepare(`SELECT ${FINDING_COLUMNS} FROM "findings" f WHERE f."project" = ? AND (${FINDING_RAISED_BETWEEN} OR f."status" IN ('open', 'dispositioned')) ORDER BY f."seq"`).all(project, completed.id, completed.id) as Record<string, unknown>[])
    : (db.prepare(`SELECT ${FINDING_COLUMNS} FROM "findings" WHERE "project" = ? ORDER BY "seq"`).all(project) as Record<string, unknown>[]);
  const deferred = db.prepare(`SELECT ${FINDING_COLUMNS} FROM "findings" WHERE "project" = ? AND "disposition" = 'defer' AND "status" <> 'resolved' ORDER BY "seq"`).all(project) as Record<string, unknown>[];
  const obligations = (db.prepare('SELECT "id", "key", "criteria", "generation", "reason", "request", "created_at" FROM "check_obligations" WHERE "project" = ? AND "resolved_at" IS NULL ORDER BY rowid, "id"').all(project) as Record<string, unknown>[]).map((o) => ({
    ...o,
    criteria: json(o.criteria),
  }));
  const objections = db
    .prepare(`SELECT ${FINDING_COLUMNS} FROM "findings" WHERE "project" = ? AND "source_role" = 'builder' AND "category" IN ('contract_conflict', 'requirement_conflict') AND "status" = 'open' ORDER BY "seq"`)
    .all(project) as Record<string, unknown>[];
  // A repair: the item's last failed run, and the refused check it recorded.
  const last = db.prepare(`SELECT "id", "reason_class", "reason_text" FROM "runs" WHERE "work_item" = ? AND "state" = 'ended' AND "outcome" = 'failed' ORDER BY "seq" DESC LIMIT 1`).get(item.id) as
    | { id: string; reason_class: string | null; reason_text: string | null }
    | undefined;
  const check = last
    ? (db.prepare(`SELECT "id", "phase_number", "reasons" FROM "plan_checks" WHERE "project" = ? AND json_extract("evidence", '$.run') = ? AND "outcome" = 'refused' ORDER BY rowid DESC LIMIT 1`).get(project, last.id) as
        | { id: string; phase_number: number | null; reasons: string }
        | undefined)
    : undefined;
  return {
    repo: p.dev_repo_path,
    trigger: { source: item.trigger_source, id: item.trigger_id, generation: item.trigger_generation },
    trigger_subject: subjectFacts(item.trigger_evidence ?? null),
    generation: {
      spec_revision: spec ?? null,
      architecture_revision: arch ? { id: arch.id, version: arch.version } : null,
      roadmap_revision: road ? { id: road.id, version: road.version } : null,
      plan: (open ?? completed) ? { id: (open ?? completed)!.id, phase_number: (open ?? completed)!.phase_number, generation: (open ?? completed)!.generation } : null,
      spec_evidence_generation: p.spec_evidence_generation,
    },
    index,
    roadmap: road ? { version: road.version, phases: json(road.phases) } : null,
    module_map: arch ? json(arch.module_map) : null,
    completed_plan: completed,
    open_plan: open,
    phase_evaluation: ev ? { id: ev.id, candidate: ev.candidate, outcome: ev.outcome, reasons: json(ev.reasons), check_states: json(ev.check_states), computed_at: ev.computed_at, stale: ev.stale === 1 } : null,
    findings,
    deferrals: { findings: deferred, obligations },
    objections,
    refusal: last ? { run: last.id, reason_class: last.reason_class, reason_text: last.reason_text, plan_check: check ? { id: check.id, phase: check.phase_number, reasons: json(check.reasons) } : null } : null,
    ...keptStagesOf(db, item),
    touched: touchedOf(item),
  };
}

// The kept stages the plan check will count for this replan (the driver's
// ruling on the real M443 run's replan, E135): from the store, as
// plan/bundle.ts replacementFacts takes them.
// The stages the cascade rebuilds are named apart (E172 item 7 S2).
function keptStagesOf(
  db: Db,
  item: { trigger_source: string | null; trigger_id: string | null; trigger_generation: number | null; subject?: string | null; trigger_evidence?: string | null },
): { kept: { number: number; implements: string[]; validated: string[] }[]; rebuilt?: { number: number; implements: string[]; depends_on: number[] }[] } {
  if (item.trigger_source === null || item.trigger_id === null || item.trigger_generation === null) return { kept: [] };
  const target = replacementOf(db, { trigger_source: item.trigger_source, trigger_id: item.trigger_id, trigger_generation: item.trigger_generation, subject: item.subject ?? '{}', trigger_evidence: item.trigger_evidence ?? null });
  if (!target) return { kept: [] };
  const all = keptOf(db, target.phase_plan, subjectWorkOf(target));
  const rebuilt = all.filter((k) => k.rebuilt === true).map((k) => ({ number: k.number, implements: k.implements, depends_on: k.depends_on ?? [] }));
  return { kept: all.filter((k) => k.rebuilt !== true).map((k) => ({ number: k.number, implements: k.implements, validated: k.validated })), ...(rebuilt.length > 0 ? { rebuilt } : {}) };
}

function touchedOf(item: { trigger_evidence?: string | null }): string[] {
  return touchedCriteria((json(item.trigger_evidence ?? null) as { stale?: unknown } | null)?.stale);
}

function subjectFacts(text: string | null): ReplanFacts['trigger_subject'] {
  const s = (json(text) ?? {}) as { phase_plan?: unknown; generation?: unknown; evidence?: unknown; stale?: unknown; rejected?: unknown };
  return {
    replaces: typeof s.phase_plan === 'string' && typeof s.generation === 'number' ? { phase_plan: s.phase_plan, generation: s.generation } : null,
    evidence: s.evidence ?? null,
    stale: s.stale ?? null,
    rejected: s.rejected ?? null,
  };
}

// The approved specification's text by its approved blob (D6 §3.5: the
// spec by `spec_revisions.git_blob`), on the main thread; null if it cannot
// be read.
export async function loadReplanSpec(facts: { replan?: ReplanFacts | null } | null): Promise<void> {
  const r = facts?.replan;
  if (!r) return;
  const blob = r.generation.spec_revision?.git_blob ?? null;
  r.spec_text = blob === null ? null : await gitOk(repoContext(r.repo), ['cat-file', 'blob', blob]).catch(() => null);
}

export type ReplanFileKind = 'spec' | 'index' | 'roadmap' | 'module_map' | 'phase_plan' | 'evaluation' | 'findings' | 'deferrals' | 'objections' | 'generation' | 'refusal' | 'trigger';

// The package's files for a replan, each with its kind and what it was
// made from.
export function replanFiles(r: ReplanFacts): { path: string; kind: ReplanFileKind; source: string | null; content: string }[] {
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const out: { path: string; kind: ReplanFileKind; source: string | null; content: string }[] = [];
  const spec = r.generation.spec_revision;
  out.push({ path: 'generation.json', kind: 'generation', source: spec?.id ?? null, content: j(r.generation) });
  out.push(
    r.spec_text === null || r.spec_text === undefined
      ? { path: 'spec.json', kind: 'spec', source: spec?.id ?? null, content: j({ spec_revision: spec, readable: false, why: spec ? `the approved specification's blob ${spec.git_blob} could not be read` : 'no specification is approved' }) }
      : { path: 'spec.md', kind: 'spec', source: spec?.id ?? null, content: r.spec_text },
  );
  out.push({ path: 'index.json', kind: 'index', source: spec?.id ?? null, content: j(r.index) });
  out.push({ path: 'roadmap.json', kind: 'roadmap', source: r.generation.roadmap_revision?.id ?? null, content: j(r.roadmap) });
  out.push({ path: 'module_map.json', kind: 'module_map', source: r.generation.architecture_revision?.id ?? null, content: j(r.module_map) });
  if (r.completed_plan) out.push({ path: 'plan.json', kind: 'phase_plan', source: r.completed_plan.id, content: j(r.completed_plan) });
  if (r.open_plan) out.push({ path: 'open-plan.json', kind: 'phase_plan', source: r.open_plan.id, content: j(r.open_plan) });
  out.push({ path: 'evaluation.json', kind: 'evaluation', source: r.phase_evaluation?.id ?? null, content: j(r.phase_evaluation) });
  out.push({ path: 'findings.json', kind: 'findings', source: null, content: j(r.findings) });
  out.push({ path: 'deferrals.json', kind: 'deferrals', source: null, content: j(r.deferrals) });
  out.push({ path: 'objections.json', kind: 'objections', source: null, content: j(r.objections) });
  if (r.refusal) out.push({ path: 'refusal.json', kind: 'refusal', source: r.refusal.plan_check?.id ?? r.refusal.run, content: j(r.refusal) });
  const t = r.trigger_subject;
  if (t && (t.replaces || t.evidence !== null || t.rejected !== null)) out.push({ path: 'trigger.json', kind: 'trigger', source: r.trigger.id, content: j({ trigger: r.trigger, ...t }) });
  return out;
}

export function replanPromptText(r: ReplanFacts): string[] {
  const next = (r.completed_plan?.phase_number ?? 0) + 1;
  const reasons = (r.refusal?.plan_check?.reasons as { code: string; subjects: string[] }[] | null | undefined) ?? null;
  return [
    '',
    '## The replan',
    '',
    `Plan the next phase (${r.open_plan ? `the open phase ${r.open_plan.phase_number}, replacing its plan` : `phase ${next}`}) from the approved baseline in this package; nothing else is approved.`,
    `It is generation spec version ${r.generation.spec_revision?.version ?? 'none'}, architecture version ${r.generation.architecture_revision?.version ?? 'none'}, roadmap version ${r.generation.roadmap_revision?.version ?? 'none'} (/surety/context/generation.json): your plan's prepared_against names these and the revision you start from (your workspace's HEAD).`,
    '- /surety/context/spec.md: the approved specification; /surety/context/index.json: its requirements with their criteria, areas and phases.',
    '- /surety/context/adrs/: every approved ADR; /surety/context/roadmap.json and /surety/context/module_map.json: the approved roadmap and module map.',
    '- /surety/context/plan.json: the completed phase with each stage and its integrated revision; /surety/context/evaluation.json: its phase gate evaluation with each check\'s state.',
    '- /surety/context/findings.json, deferrals.json, objections.json: the phase\'s findings with their dispositions, what is deferred and the open objections.',
    'Write the next phase\'s plan in the form the engine reads (below), and only the architecture, ADR or roadmap files you mean to change; any change of them goes to the owner.',
    'Your result names the plan (`plan`: "phase-<n>") and declares `conformance` (within_baseline or uncertain).',
    ...(r.refusal
      ? [
          '',
          '## Your last proposal was refused',
          '',
          reasons && reasons.length > 0
            ? `The engine's plan check refused it: ${reasons.map((x) => `${x.code} (${x.subjects.join(', ')})`).join('; ')}.`
            : `Its run failed (${r.refusal.reason_class ?? 'unknown'}): ${r.refusal.reason_text ?? 'no reason was recorded'}.`,
          'This is the one automatic repair: correct the plan for those reasons. Details in /surety/context/refusal.json.',
        ]
      : []),
    ...(r.trigger_subject?.replaces
      ? [
          '',
          '## An early replacement',
          '',
          `This replan replaces generation ${r.trigger_subject.replaces.generation} of the open plan (${r.trigger.source}): /surety/context/trigger.json holds the evidence and what became stale. Stages already integrated or verified are kept as built; a stage not yet built is replaced by what you plan.`,
          ...((r.kept ?? []).length > 0
            ? [
                '',
                `Kept stages: ${(r.kept ?? []).map((k) => `stage ${k.number} (implements ${k.implements.join(', ') || 'nothing'}${(k.validated ?? []).length > 0 ? `; validates ${(k.validated ?? []).join(', ')}` : ''})`).join('; ')}. Their inputs as built are in /surety/context/open-plan.json.`,
                ...((r.touched ?? []).length > 0 ? [`Criteria this replan's trigger touched (gained or changed): ${(r.touched ?? []).join(', ')}. A kept stage's validation does not settle these; every other criterion a kept stage validates stays validated.`] : []),
                KEPT_STAGE_RULE,
              ]
            : []),
          ...((r.rebuilt ?? []).length > 0
            ? [
                '',
                `Rebuilt stages: ${(r.rebuilt ?? []).map((k) => `stage ${k.number} (implements ${k.implements.join(', ') || 'nothing'}; depends on ${k.depends_on.map((d) => `stage ${d}`).join(', ') || 'nothing'})`).join('; ')}.`,
                REBUILT_STAGE_RULE,
              ]
            : []),
        ]
      : []),
    ...(r.trigger_subject?.rejected
      ? ['', '## Your last proposal was rejected', '', `The owner rejected it${typeof (r.trigger_subject.rejected as { note?: unknown }).note === 'string' ? `: "${(r.trigger_subject.rejected as { note: string }).note}"` : ''}. Details in /surety/context/trigger.json.`]
      : []),
  ];
}

// The replan result's fields (Appendix B.7), beside status and summary.
export const REPLAN_RESULT_FIELDS: Record<string, Record<string, unknown>> = {
  plan: { type: 'string', pattern: '^phase-[1-9][0-9]*$', description: 'The plan you wrote: "phase-<n>".' },
  conformance: { enum: ['within_baseline', 'uncertain'], description: 'within_baseline if you changed nothing of the architecture, module map, ADRs or roadmap; uncertain otherwise. A declaration only adds uncertainty: the engine computes what changed.' },
  roadmap_revision: { type: ['boolean', 'string'], description: 'Whether your replan revises the roadmap (B.7: a boolean); a string giving why is accepted too. Routing is computed from the artifacts, never from this.' },
  adrs_changed: { type: 'array', items: { type: 'string' }, description: 'The keys of the ADRs you added or changed.' },
  notes: { type: 'string' },
};
