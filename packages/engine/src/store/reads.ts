// Read-only queries. Reads never write and never call out of the store.

import { replanFacts } from '../plan/replan-package.js';
import { activeStages } from '../plan/active.js';
import { phaseVerificationFacts } from '../plan/phase.js';
import type { Database } from 'better-sqlite3';

import { policyRevision, projectEffective as effectivePolicy, projectOptions } from './transitions/settings.js';
import { projectNotFound } from './transitions/project.js';
import { CHAIN_BOUNDARY, ROLE_OF, dispatchBlocker } from './transitions/runs.js';
import { type CandidateRow, type CheckRow, applies, candidateContent, checksOfVersion, gateKindsOf, requirementsOf } from './transitions/evidence.js';
import { cadenceTier } from '../checks/scope.js';
import { effectiveVersion } from './transitions/protected.js';
import { knownCriteria } from './transitions/checks.js';
import { type FindingRow, candidateSignoffs, findingApplies } from './transitions/gates.js';
import type { WorkRow } from './transitions/work.js';
import type { CheckWritingFacts } from '../checks/guide.js';
import type { Governed } from '../checks/schema.js';
import { openObligationsOf } from '../spec/change.js';
import { isAdopted } from '../adopt/records.js';
import type { BuilderStageFacts } from '../packages/reads.js';

// The project's effective ungoverned policy: the revision the engine
// recorded over the schema defaults, or the defaults with revision null.
export function projectPolicy(db: Database, project: string) {
  const row = db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(project);
  if (!row) throw projectNotFound(project);
  return { effective: effectivePolicy(db, project), revision: policyRevision(db, project) };
}

// D1 §8.1 step 8 order: verification due, then builds, then replans, then
// the rest; oldest first within each.
const PRIORITY: Record<string, number> = { verification: 0, check_correction: 0, stage_build: 1, fix: 1, replan: 2 };
// A new correction waits for a Reviewer's review of a classified protected
// proposal that is pending (D3 §3.3, under `authoritative`): a correction
// captured on a base the pending proposal's application then moves can
// never be applied as approved (its protected set diverges, D3 §3.3), so the
// pending one is settled first.
const isProposalReview = (item: WorkRow): boolean => {
  if (item.kind !== 'review') return false;
  try {
    return typeof (JSON.parse(item.subject) as { proposal?: unknown }).proposal === 'string';
  } catch {
    return false;
  }
};
// The review goes with the protected path's work (verification due, D1 §8.1
// step 8) and ahead of a new correction.
const priorityOf = (item: WorkRow, reviewPending: boolean): number =>
  isProposalReview(item) ? 0 : item.kind === 'check_correction' && reviewPending ? 0.5 : (PRIORITY[item.kind] ?? 3);

export interface ProjectCandidates {
  project: string;
  repo: string;
  branch: string;
  items: { id: string; kind: string; role: string; boundary: boolean }[];
}

// Every project with work that could be dispatched now, as far as the store
// alone can tell. The scheduler's prerequisite steps decide the rest, and the
// claim transaction checks it all again.
export function dispatchCandidates(db: Database): ProjectCandidates[] {
  const projects = db.prepare('SELECT "id", "dev_repo_path", "integration_branch" FROM "projects" ORDER BY rowid, "id"').all() as {
    id: string;
    dev_repo_path: string;
    integration_branch: string;
  }[];
  const out: ProjectCandidates[] = [];
  for (const p of projects) {
    let items: ProjectCandidates['items'];
    try {
      const eligible = db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id) as WorkRow[];
      const reviewPending = eligible.some(isProposalReview);
      items = eligible
        .map((item) => ({ item, blocker: dispatchBlocker(db, item) }))
        .filter(({ blocker }) => blocker === null || blocker === CHAIN_BOUNDARY)
        .sort((a, b) => priorityOf(a.item, reviewPending) - priorityOf(b.item, reviewPending) || a.item.seq - b.item.seq)
        .map(({ item, blocker }) => ({ id: item.id, kind: item.kind, role: ROLE_OF[item.kind]!, boundary: blocker === CHAIN_BOUNDARY }));
    } catch {
      // A check that could not read what it needs (a budget, D1 §6.6) has
      // failed: nothing of this project is dispatched on it, and the other
      // projects go on.
      items = [];
    }
    out.push({ project: p.id, repo: p.dev_repo_path, branch: p.integration_branch, items });
  }
  return out;
}

export function projectIds(db: Database): string[] {
  return (db.prepare('SELECT "id" FROM "projects" ORDER BY rowid, "id"').all() as { id: string }[]).map((r) => r.id);
}

// Runs that are quarantined, for the observation at every tick (SEAM.md §14).
export function quarantinedRuns(db: Database): { id: string; project: string }[] {
  return db.prepare(`SELECT "id", "project" FROM "runs" WHERE "state" = 'finalizing' AND "quarantined" = 1 ORDER BY rowid`).all() as {
    id: string;
    project: string;
  }[];
}

// What a run's context package binds (D2 §1.3; F §3.10.8): the work item and
// its subject, the stage it builds with its requirements, phase plan and
// module interfaces, for a Reviewer the candidate and the acceptance content
// it reviews, for a resumed run what the records say of the run it resumes.
// Never a raw user report (E5): the trigger's report is not read here.
export function contextFacts(db: Database, args: { run: string }) {
  const run = db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(args.run) as Record<string, unknown> | undefined;
  // A session's turn has its own package (sessions/package.ts).
  if (!run || run.work_item === null) return null;
  const item = db.prepare('SELECT "id", "kind", "subject", "project", "trigger_source", "trigger_id", "trigger_generation", "trigger_evidence" FROM "work_items" WHERE "id" = ?').get(run.work_item) as {
    id: string;
    kind: string;
    subject: string;
    project: string;
    trigger_source: string | null;
    trigger_id: string | null;
    trigger_generation: number | null;
    trigger_evidence: string | null;
  };
  const parse = <T>(text: unknown, fallback: T): T => {
    try {
      return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  // The work item's subject is JSON: {"stage"}, {"candidate"}, {"finding"}.
  const subject = parse<Record<string, unknown> | null>(item.subject, null) ?? {};
  const subjectId = (key: string): string | null => (typeof subject[key] === 'string' ? (subject[key] as string) : null);
  const stage = db.prepare('SELECT * FROM "stages" WHERE "id" = ? OR "work_item" = ? ORDER BY "number" LIMIT 1').get(subjectId('stage'), item.id) as Record<string, unknown> | undefined;
  type Req = { id: string; key: string; text_ref: string; assigned_phase: number | null; text: string | null };
  let requirements: Req[] = [];
  let adrs: { id: string; key: string; text: string }[] = [];
  let modules: { id: string; name: string; paths: unknown; interfaces?: unknown[] }[] = [];
  let plan: Record<string, unknown> | null = null;
  if (stage) {
    const ids = [...new Set([...parse<string[]>(stage.requirement_ids, []), ...parse<string[]>(stage.implements, [])])];
    requirements = ids
      .map((id) => db.prepare('SELECT "id", "key", "text_ref", "assigned_phase", "text" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(item.project, id, id) as Req | undefined)
      .filter((r): r is Req => r !== undefined);
    // Every ADR the stage cites and no other (SEAM.md §139).
    adrs = parse<string[]>(stage.adrs, [])
      .map((key) => db.prepare(`SELECT "id", "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' AND "key" = ?`).get(item.project, key) as { id: string; key: string; text: string } | undefined)
      .filter((a): a is { id: string; key: string; text: string } => a !== undefined);
    const names = parse<string[]>(stage.modules, []);
    // A published plan's stage names its modules by id (plan/bundle.ts
    // moduleIds); a fixture's by name.
    modules = names
      .map((name) => db.prepare('SELECT "id", "name", "paths" FROM "modules" WHERE "project" = ? AND ("id" = ? OR "name" = ?)').get(item.project, name, name) as { id: string; name: string; paths: string } | undefined)
      .filter((m): m is { id: string; name: string; paths: string } => m !== undefined)
      .map((m) => ({ id: m.id, name: m.name, paths: parse<unknown>(m.paths, []) }));
    const p = db.prepare('SELECT "id", "phase_number", "git_path", "prepared_against_revision" FROM "phase_plans" WHERE "id" = ?').get(stage.phase_plan) as Record<string, unknown> | undefined;
    plan = p ?? null;
  }
  // What a stage's Builder is told of its stage (row M442; B.5; D6 §6.4):
  // its tasks, what it implements, its integration obligations, the stages
  // it depends on and the module map's interfaces of their modules, read
  // from the active generation's approved bundle. The interfaces are null
  // when the map cannot be read: unknown, never none.
  let builderStage: BuilderStageFacts | null = null;
  const moduleMap = stage ? bundleModules(db, String(stage.phase_plan)) : null;
  if (stage && run.role === 'builder') {
    const keyOf = (r: string): string => (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(item.project, r, r) as { key: string } | undefined)?.key ?? r;
    // The stage row holds its dependencies by stage id (registerPlan); a
    // number is taken as it is.
    const dependsOn = parse<unknown[]>(stage.depends_on, [])
      .map((d) => (typeof d === 'number' ? d : typeof d === 'string' ? ((db.prepare('SELECT "number" FROM "stages" WHERE "id" = ?').get(d) as { number: number } | undefined)?.number ?? null) : null))
      .filter((n): n is number => typeof n === 'number');
    const siblings = activeStages<{ number: number; modules: string }>(db, activePlanOf(db, String(stage.phase_plan)));
    // A stage row names its modules by id (plan/bundle.ts) or, in a
    // fixture, by name: each resolved to its name in the module map.
    const moduleName = (m: string): string => (db.prepare('SELECT "name" FROM "modules" WHERE "project" = ? AND ("id" = ? OR "name" = ?)').get(item.project, m, m) as { name: string } | undefined)?.name ?? m;
    const depModules = dependsOn.flatMap((n) => {
      const sib = siblings.find((x) => x.number === n);
      return sib ? parse<string[]>(sib.modules, []).map((m) => ({ stage: n, module: moduleName(m) })) : [];
    });
    builderStage = {
      number: Number(stage.number),
      goal: String(stage.goal),
      tasks: parse<string[]>(stage.tasks, []),
      implements: parse<string[]>(stage.implements, []).map(keyOf),
      integration_obligations: parse<string[]>(stage.integration_obligations, []),
      depends_on: dependsOn,
      dependency_interfaces:
        moduleMap === null
          ? null
          : depModules.flatMap(({ stage: n, module }) =>
              (moduleMap.find((m) => m.name === module)?.interfaces ?? []).map((i) => ({ stage: n, module, name: i.name, kind: i.kind, path: i.path ?? null, description: i.description })),
            ),
    };
  }
  // Each module's interfaces as the approved module map gives them (B.3),
  // beside its paths; absent when the map cannot be read.
  if (moduleMap !== null) modules = modules.map((m) => ({ ...m, interfaces: (moduleMap.find((x) => x.name === m.name)?.interfaces ?? []).map((i) => ({ name: i.name, kind: i.kind, path: i.path ?? null, description: i.description })) }));
  // Work that builds no stage of a plan (a fix naming no stage, a replan, an
  // assessment): every approved requirement and every ADR, by the approved
  // bindings the baseline texts carry, never a checkpoint's file in the
  // checkout (D6 §3.5; B02; D6-A01).
  if (!stage && ['fix', 'replan', 'assessment'].includes(item.kind)) {
    requirements = db
      .prepare(`SELECT "id", "key", "text_ref", "assigned_phase", "text" FROM "requirements" WHERE "project" = ? AND "text" IS NOT NULL AND "withdrawn_at" IS NULL ORDER BY "key"`)
      .all(item.project) as Req[];
    adrs = db.prepare(`SELECT "id", "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'adr' ORDER BY "key"`).all(item.project) as { id: string; key: string; text: string }[];
  }
  // The Verifier of check_correction work writes checks for every
  // requirement of the project (BS3 §3): each registered requirement, with
  // its approved text, its criteria and its areas (D3 §4.5).
  type IndexedReq = Req & { criteria: string | null; sensitive_areas: string };
  let checkWriting: CheckWritingFacts | null = null;
  if (item.kind === 'check_correction' || item.kind === 'check_authoring') {
    const all = db
      .prepare('SELECT "id", "key", "text_ref", "assigned_phase", "text", "criteria", "sensitive_areas" FROM "requirements" WHERE "project" = ? ORDER BY "key"')
      .all(item.project) as IndexedReq[];
    if (!stage) requirements = all.map(({ id, key, text_ref, assigned_phase, text }) => ({ id, key, text_ref, assigned_phase, text }));
    const version = effectiveVersion(db, item.project);
    const projectTier = (db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(item.project) as { tier: string } | undefined)?.tier ?? '';
    checkWriting = {
      // Unknown, never A.4's defaults, when the version or its governed
      // values cannot be read.
      governed: version ? parse<Governed | null>((db.prepare('SELECT "governed" FROM "protected_versions" WHERE "id" = ?').get(version.id) as { governed: string | null }).governed, null) : null,
      tier: projectTier,
      modules: (db.prepare('SELECT "name", "tier_override", "sensitive_areas" FROM "modules" WHERE "project" = ? ORDER BY "name"').all(item.project) as { name: string; tier_override: string | null; sensitive_areas: string }[]).map((m) => ({
        name: m.name,
        tier_override: m.tier_override,
        sensitive_areas: parse<string[]>(m.sensitive_areas, []),
      })),
      requirements: all.map((r) => ({ key: r.key, text: r.text, text_ref: r.text_ref, criteria: r.criteria === null ? null : parse<string[] | null>(r.criteria, null), sensitive_areas: parse<string[]>(r.sensitive_areas, []) })),
      stages: stagePlan(db, item.project, all),
      environments: checkEnvironments(db, item.project),
    };
  }
  const candidate = db.prepare('SELECT * FROM "candidates" WHERE "id" = ? AND "project" = ?').get(subjectId('candidate'), item.project) as CandidateRow | undefined;
  const role = run.role as string;
  type Finding = FindingRow & { message: string; source_role: string | null };
  const findingFacts = (f: Finding) => ({
    id: f.id,
    seq: f.seq,
    scope: f.scope,
    candidate: f.candidate,
    category: f.category,
    severity: f.effective_severity,
    message: f.message,
    check: f.check,
    criterion: f.criterion ?? null,
    sensitive_area: f.sensitive_area,
    status: f.status,
    disposition: f.disposition,
    source_role: f.source_role,
  });
  // What a Verifier or a Reviewer of a candidate reports against (D2 §1.3;
  // F §6): the findings open or dispositioned that apply to the candidate,
  // each by the id its result names, the applicability assessments proposed
  // on it, the sign-offs its scopes require (D3 §4.1), and the revision the candidate's
  // diff is taken from: the project's previous candidate, else the parent of
  // the first revision the engine recorded (null if there is none).
  let review: {
    findings: ReturnType<typeof findingFacts>[];
    assessments: { id: string; finding: string; candidate: string; reason: string; status: string }[];
    signoffs: { role: string; scope: string; module?: string }[];
    // `recorded` (first_recorded_parent only): every recorded revision with
    // its parent; which of them is the first is decided by git ancestry on
    // the main thread (invoke/sandbox/prepare.ts resolveDiffBase; E106,
    // E129 item 10), never by record time.
    diff_base: { revision: string | null; from: 'previous_candidate' | 'first_recorded_parent' | null; recorded?: Record<string, string> };
    revision_records?: RevisionRecords | null;
  } | null = null;
  if (candidate && (role === 'reviewer' || role === 'verifier')) {
    const findings = (db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "status" IN ('open', 'dispositioned') ORDER BY "seq"`).all(item.project) as Finding[])
      .filter((f) => findingApplies(db, f, candidate))
      .map(findingFacts);
    const assessments = db
      .prepare(`SELECT "id", "finding", "candidate", "reason", "status" FROM "applicability_assessments" WHERE "project" = ? AND "candidate" = ? AND "status" = 'proposed' ORDER BY rowid, "id"`)
      .all(item.project, candidate.id) as { id: string; finding: string; candidate: string; reason: string; status: string }[];
    const previous = db.prepare('SELECT "revision" FROM "candidates" WHERE "project" = ? AND "seq" < ? ORDER BY "seq" DESC LIMIT 1').get(item.project, candidate.seq) as { revision: string } | undefined;
    const recorded = previous
      ? []
      : (db.prepare('SELECT "sha", "parent_sha" FROM "revisions" WHERE "project" = ? AND "parent_sha" IS NOT NULL ORDER BY "id"').all(item.project) as { sha: string; parent_sha: string }[]);
    review = {
      findings,
      assessments,
      signoffs: role === 'reviewer' ? candidateSignoffs(db, item.project, candidate) : [],
      diff_base: previous
        ? { revision: previous.revision, from: 'previous_candidate' }
        : recorded.length > 0
          ? { revision: null, from: 'first_recorded_parent', recorded: Object.fromEntries(recorded.map((r) => [r.sha, r.parent_sha])) }
          : { revision: null, from: null },
      // A Reviewer is told which commits of its diff's range are the
      // engine's or the owner's (E106): the range is read from git when the
      // package is written, each commit classified by these records.
      ...(role === 'reviewer' ? { revision_records: revisionRecords(db, item.project) } : {}),
    };
  }
  // A fix's finding (D1 §9; F §6.2): the Builder is told what it fixes.
  // The project's checks (E87): what a finding's `check` names, so that a
  // Verifier, a Reviewer and a fix Builder know the keys the fix loop reads
  // (SEAM.md §74, "Resolution"). Every check of the effective protected
  // version: its key, the keys of the requirements it covers, its gate kinds,
  // and whether the candidate's scopes require it; never its content.
  // `required` follows the scope rule, as the gate and registration read it
  // (SEAM.md §176, as amended in slice 20; slice 20 review, minor 5; D3
  // §4.2): in the required set of a scope of the run's candidate (the union
  // of its stage scopes and its deployment scope, each at its own tier,
  // candidateContent), never by the project's tier alone. While a fact those
  // sets need is unread, a check that applies at the highest tier the
  // scopes could take is marked too (never fewer). With no candidate (not
  // pinned): a check that applies at the highest tier any scope of the
  // project could take (its tier and every module's override).
  // `checks_known` false: the project has no effective protected version,
  // so its checks cannot be read; that is unknown, never "no checks" (the
  // review of b72b9cc, F3).
  let checks: { key: string; requirements: string[]; criteria: string[]; gate_kinds: string[]; required: boolean }[] | null = null;
  let checksKnown: boolean | null = null;
  if (role === 'verifier' || role === 'reviewer' || item.kind === 'fix') {
    const version = effectiveVersion(db, item.project);
    const content = candidate && version ? candidateContent(db, item.project, candidate, version.id) : null;
    const inScope = new Set((content?.checks ?? []).map((c) => c.id));
    const projectTier = (db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(item.project) as { tier: string } | undefined)?.tier ?? '';
    const anyTier = cadenceTier(projectTier, db.prepare('SELECT "tier_override" FROM "modules" WHERE "project" = ?').all(item.project) as { tier_override: string | null }[]);
    const isRequired = (c: CheckRow): boolean => (content ? inScope.has(c.id) || (content.unread.length > 0 && applies(c, content.tier)) : applies(c, anyTier));
    const keyOf = (r: string): string =>
      (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(item.project, r, r) as { key: string } | undefined)?.key ?? r;
    checksKnown = version !== undefined;
    checks = version
      ? checksOfVersion(db, version.id)
          .map((c) => ({ key: c.key, requirements: requirementsOf(c).map(keyOf), criteria: parse<string[]>(c.criteria, []), gate_kinds: gateKindsOf(c), required: isRequired(c) }))
          .sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key))
      : [];
  }
  // What a result may name (D3 §2.11, §5 X2; SEAM.md §§230, 232): the
  // effective version's check keys (a Builder's objection names one; a
  // finding's check, as above) and the registered index's criteria (a
  // finding's criterion, an objection's); null where none can be read.
  const effective = effectiveVersion(db, item.project);
  const checkKeys = effective ? [...new Set(checksOfVersion(db, effective.id).map((c) => c.key))].sort() : null;
  const indexed = knownCriteria(db, item.project);
  const criteria = indexed === null ? null : [...indexed].sort();
  const fixFinding = subjectId('finding');
  const finding = fixFinding === null ? undefined : (db.prepare('SELECT * FROM "findings" WHERE "id" = ? AND "project" = ?').get(fixFinding, item.project) as Finding | undefined);
  // A resumed run's context is rebuilt from the records of the run it
  // resumes (D1 §15.3): its published records other than a raw report.
  let resumed: { run: string; outcome: unknown; reason_class: unknown; summary: unknown; records: { id: string; kind: string; path: string | null }[] } | null = null;
  if (typeof run.parent_run === 'string') {
    const parent = db.prepare('SELECT "id", "outcome", "reason_class", "result_value" FROM "runs" WHERE "id" = ?').get(run.parent_run) as { id: string; outcome: unknown; reason_class: unknown; result_value: string | null } | undefined;
    if (parent) {
      const records = db
        .prepare(`SELECT "id", "kind", "path" FROM "records" WHERE "run" = ? AND "published" = 1 AND "kind" <> 'raw_user_report' ORDER BY rowid, "id"`)
        .all(parent.id) as { id: string; kind: string; path: string | null }[];
      resumed = { run: parent.id, outcome: parent.outcome, reason_class: parent.reason_class, summary: parse<{ summary?: unknown } | null>(parent.result_value, null)?.summary ?? null, records };
    }
  }
  // A review of a protected proposal (D3 §3.3; SEAM.md §350): the package
  // holds what the work item binds, the proposal.
  const proposalId = subjectId('proposal');
  const proposalRow = proposalId === null ? undefined : (db.prepare('SELECT "id", "seq", "requested_change_kind", "classified_change_kind", "status", "base_revision", "tree_id", "diff_hash", "run" FROM "protected_proposals" WHERE "id" = ? AND "project" = ?').get(proposalId, item.project) as Record<string, unknown> | undefined);
  // A spec change's request (D6 §4.3; SEAM.md §353).
  const requestId = subjectId('request');
  const changeRequestRow = requestId === null ? undefined : (db.prepare('SELECT "id", "seq", "spec_revision", "request_text" AS "text", "source" FROM "spec_change_requests" WHERE "id" = ? AND "project" = ?').get(requestId, item.project) as Record<string, unknown> | undefined);
  // A correction's package lists the change's open obligations (the
  // slice-36 review's S3): what the Verifier still has to resolve.
  const changeRequest = changeRequestRow && item.kind === 'check_correction' ? { ...changeRequestRow, open_obligations: openObligationsOf(db, String(changeRequestRow.id)) } : changeRequestRow;
  return {
    // A check authoring's or correction's repair after its proposal was
    // rejected (M443): what the engine found wrong with it.
    rejected_proposal: item.kind === 'check_authoring' || item.kind === 'check_correction' ? rejectedProposalFacts(db, item.id, String(run.id)) : null,
    // A Builder sent back after its changes no longer applied to the moved
    // integration branch (D1 §7.5 as amended, E152 item 4): the files and
    // the head it moved to.
    rebase_conflict: run.role === 'builder' ? rebaseConflictFacts(db, item.id, String(run.id)) : null,
    // A Builder's repair after its last run's diff was refused for a path a
    // Builder may not change: the paths, to leave unchanged.
    diff_violation: run.role === 'builder' ? diffViolationFacts(db, item.id, String(run.id)) : null,
    // A correction the owner asked for (E152 item 3): the finding's check
    // judged over-broad on the owner's finding_disposition question.
    owner_correct_check: item.kind === 'check_correction' && finding ? ownerAskedCorrection(db, finding.id) : false,
    // The replan one-shot's package (D6 §3.5, §5.6; M424 (b)).
    replan: item.kind === 'replan' ? replanFacts(db, item) : null,
    // The phase Verifier's (D6 §5.8; M429 (a)): the phase evaluation and
    // the phase's findings.
    phase: phaseVerificationFacts(db, item),
    change_request: changeRequest ?? null,
    proposal: proposalRow ?? null,
    run: { id: run.id as string, role: run.role as string, base_revision: run.base_revision as string, content_hash: (run.content_hash as string | null) ?? null },
    work_item: { id: item.id, kind: item.kind, subject: item.subject, project: item.project },
    stage: stage ? { number: stage.number, goal: stage.goal, modules: parse<unknown>(stage.modules, []), requirement_ids: parse<unknown>(stage.requirement_ids, []), implements: parse<unknown>(stage.implements, []) } : null,
    requirements,
    adrs,
    // The project's constraints are project-wide: every one of the approved
    // baseline (F §3.10.8).
    constraints: db.prepare(`SELECT "id", "key", "text" FROM "baseline_texts" WHERE "project" = ? AND "kind" = 'constraint' ORDER BY "key"`).all(item.project) as { id: string; key: string; text: string }[],
    modules,
    phase_plan: plan,
    candidate: candidate ? { id: candidate.id, revision: candidate.revision, acceptance_content_hash: (run.content_hash as string | null) ?? null } : null,
    review,
    finding: finding ? findingFacts(finding) : null,
    checks,
    checks_known: checksKnown,
    check_keys: checkKeys,
    criteria,
    check_writing: checkWriting,
    // Whether the project was adopted (D6 §8): the retrofit packages.
    adopted: isAdopted(db, item.project),
    builder_stage: builderStage,
    // The phase-authoring package (D6 §6.2; N04; SEAM.md §428).
    authoring: item.kind === 'check_authoring' ? authoringFacts(db, item.project, subjectId('phase_plan'), item) : null,
    resumed,
    // What each environment's current configuration fixes, for a Builder
    // (BS4 §3, the role packages; CD4): never a secret's value.
    environments:
      run.role === 'builder'
        ? (
            db
              .prepare(`SELECT e."name", c."content" FROM "environments" e JOIN "environment_configs" c ON c."id" = e."current_config" WHERE e."project" = ? ORDER BY e."name"`)
              .all(item.project) as { name: string; content: string }[]
          ).map((r) => {
            const c = parse<Record<string, unknown>>(r.content, {});
            return {
              name: r.name,
              adapter: typeof c.adapter === 'string' ? c.adapter : null,
              runtime: (c.runtime as { path?: string } | undefined)?.path ?? null,
              start: Array.isArray(c.start) ? (c.start as string[]) : [],
              port: typeof c.port === 'number' ? c.port : null,
              exclude: ((c.artifact as { exclude?: string[] } | undefined)?.exclude ?? []).slice(),
            };
          })
        : null,
  };
}

// The run before `run` of the work item, when it ended on a rebase conflict
// with the moved integration branch (E152 item 4): what the Builder sent
// back is told. null otherwise.
export interface RebaseConflictFacts {
  run: string;
  head: string | null;
  files: string[];
}
export function rebaseConflictFacts(db: Database, workItem: string, run: string): RebaseConflictFacts | null {
  const prior = db
    .prepare(`SELECT "id", "reason_class", "reason_detail" FROM "runs" WHERE "work_item" = ? AND "id" <> ? AND "state" = 'ended' ORDER BY "seq" DESC LIMIT 1`)
    .get(workItem, run) as { id: string; reason_class: string | null; reason_detail: string | null } | undefined;
  if (!prior || prior.reason_class !== 'integration_conflict') return null;
  type Detail = { conflict?: unknown; head?: unknown; files?: unknown };
  let detail: Detail | null;
  try {
    detail = prior.reason_detail ? (JSON.parse(prior.reason_detail) as Detail) : null;
  } catch {
    detail = null;
  }
  if (detail === null || detail.conflict !== 'rebase') return null;
  return {
    run: prior.id,
    head: typeof detail.head === 'string' ? detail.head : null,
    files: Array.isArray(detail.files) ? detail.files.filter((f): f is string => typeof f === 'string') : [],
  };
}

// The run before `run` of the work item, when its diff was refused for a
// path its role may not change (D1 §7.3 step 1, `diff_violation`): what the
// repair is told, so that it does not repeat it (real Inkwell run: a fix
// Builder edited an ADR beside its code four runs running). `paths`: the
// run's detail, or, for a run recorded before the detail was kept, the one
// path its refusal names; empty when neither can be read. null otherwise.
export interface DiffViolationFacts {
  run: string;
  text: string | null;
  paths: string[];
}
export function diffViolationFacts(db: Database, workItem: string, run: string): DiffViolationFacts | null {
  const prior = db
    .prepare(`SELECT "id", "reason_class", "reason_text", "reason_detail" FROM "runs" WHERE "work_item" = ? AND "id" <> ? AND "state" = 'ended' ORDER BY "seq" DESC LIMIT 1`)
    .get(workItem, run) as { id: string; reason_class: string | null; reason_text: string | null; reason_detail: string | null } | undefined;
  if (!prior || prior.reason_class !== 'diff_violation') return null;
  let paths: string[] = [];
  try {
    const detail = prior.reason_detail ? (JSON.parse(prior.reason_detail) as { paths?: unknown }) : null;
    if (detail && Array.isArray(detail.paths)) paths = detail.paths.filter((p): p is string => typeof p === 'string');
  } catch {
    paths = [];
  }
  if (paths.length === 0 && prior.reason_text) {
    const named = /^(?:the rebased result: )?the run changed (.+?): /.exec(prior.reason_text);
    if (named) paths = [named[1]!];
  }
  return { run: prior.id, text: prior.reason_text, paths };
}

// Did the owner answer a finding_disposition question about the finding
// `correct_check` (E152 item 3)?
export function ownerAskedCorrection(db: Database, finding: string): boolean {
  const rows = db.prepare(`SELECT "answer" FROM "decisions" WHERE "kind" = 'finding_disposition' AND "subject_id" = ? AND "status" = 'consumed'`).all(finding) as { answer: string | null }[];
  return rows.some((r) => {
    try {
      return (JSON.parse(r.answer ?? 'null') as { option?: unknown } | null)?.option === 'correct_check';
    } catch {
      return false;
    }
  });
}

// The active generation of a plan (D6 §5.7): followed through replaced_by.
// The latest proposal an earlier run of this work item captured, when it
// was rejected: its id, the owner's note or the conflict's reason, and each
// discovery error of its classification (protected_proposals.classification
// elements `{reason: 'discovery_error', path}`) with its code as discovery
// recorded it (the stored discovery's errors; an index error, at
// `#/covers/criteria/<n>`, is criterion_unknown, schema.criterionErrors).
// A code the stored classification does not give is null: unknown.
export interface RejectedProposalFacts {
  proposal: string;
  note: string | null;
  errors: { path: string; code: string | null }[];
}
export function rejectedProposalFacts(db: Database, workItem: string, run: string): RejectedProposalFacts | null {
  const p = db
    .prepare(
      `SELECT p."id", p."status", p."classification" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run"
       WHERE r."work_item" = ? AND r."id" <> ? ORDER BY r."seq" DESC, p.rowid DESC LIMIT 1`,
    )
    .get(workItem, run) as { id: string; status: string; classification: string | null } | undefined;
  if (!p || p.status !== 'rejected') return null;
  let c: { elements?: { reason?: unknown; path?: unknown }[]; discovery?: { errors?: { path?: unknown; code?: unknown }[] } } | null = null;
  try {
    c = p.classification ? JSON.parse(p.classification) : null;
  } catch {
    c = null;
  }
  const recorded = (c?.discovery?.errors ?? []).filter((e) => typeof e?.path === 'string' && typeof e?.code === 'string') as { path: string; code: string }[];
  const paths = Array.isArray(c?.elements) ? c.elements.filter((e) => e?.reason === 'discovery_error' && typeof e.path === 'string').map((e) => e.path as string) : recorded.map((e) => e.path);
  const errors: RejectedProposalFacts['errors'] = [];
  for (const path of [...new Set(paths)]) {
    const codes = recorded.filter((e) => e.path === path).map((e) => e.code);
    if (codes.length === 0) errors.push({ path, code: /#\/covers\/criteria\/[0-9]+$/.test(path) ? 'criterion_unknown' : null });
    else for (const code of [...new Set(codes)]) errors.push({ path, code });
  }
  const decided = db
    .prepare(`SELECT "answer" FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'consumed' ORDER BY rowid DESC LIMIT 1`)
    .get(p.id) as { answer: string | null } | undefined;
  let note: string | null = null;
  try {
    const a = decided?.answer ? (JSON.parse(decided.answer) as { option?: unknown; note?: unknown }) : null;
    if (a && a.option !== 'approve' && typeof a.note === 'string' && a.note.length > 0) note = a.note;
  } catch {
    note = null;
  }
  if (note === null) {
    const ev = db.prepare(`SELECT "payload" AS "detail" FROM "events" WHERE "type" = 'protected.rejected' AND json_extract("subject", '$.proposal') = ? ORDER BY "seq" DESC LIMIT 1`).get(p.id) as { detail: string | null } | undefined;
    try {
      const d = ev?.detail ? (JSON.parse(ev.detail) as { reason?: unknown }) : null;
      if (typeof d?.reason === 'string') note = d.reason;
    } catch {
      note = null;
    }
  }
  return { proposal: p.id, note, errors };
}

function activePlanOf(db: Database, planId: string): string {
  let id = planId;
  for (let hops = 0; hops < 64; hops++) {
    const r = db.prepare('SELECT "active", "replaced_by" FROM "phase_plans" WHERE "id" = ?').get(id) as { active: number; replaced_by: string | null } | undefined;
    if (!r || r.active === 1 || r.replaced_by === null) break;
    id = r.replaced_by;
  }
  return id;
}

// The module map of a plan's approved bundle (its active generation's, else
// its own), or null when none can be read.
type BundleModule = { name: string; interfaces?: { name: string; kind: string; path?: string; description: string }[] };
function bundleModules(db: Database, planId: string): BundleModule[] | null {
  for (const id of [...new Set([activePlanOf(db, planId), planId])]) {
    const plan = db.prepare('SELECT "bundle" FROM "phase_plans" WHERE "id" = ?').get(id) as { bundle: string | null } | undefined;
    const bundle = plan?.bundle ? (db.prepare('SELECT "artifacts" FROM "plan_bundles" WHERE "id" = ?').get(plan.bundle) as { artifacts: string } | undefined) : undefined;
    if (!bundle) continue;
    try {
      const modules = (JSON.parse(bundle.artifacts) as { modules?: { modules?: BundleModule[] } } | null)?.modules?.modules;
      if (Array.isArray(modules)) return modules;
    } catch {
      // unreadable: try the next, else unknown
    }
  }
  return null;
}

// The project's environments as the Verifier of check_correction work is
// told them (BS4 §3, the role packages; SEAM.md §335): each by name, with
// its current configuration's targets and the secret references its checks
// may receive, never a value. An environment with no configuration, or one
// whose content cannot be read, has its targets and references unknown
// (null), never none.
// What a phase's check authoring is given beside the check-writing facts
// (D6 §6.2; N04): the plan's stages with what they implement and validate,
// the module map's interfaces and the architecture's text from the plan's
// approved bundle, and the approved specification's environments.
export interface AuthoringFacts {
  phase_plan: { id: string; phase_number: number; generation: number } | null;
  stages: { number: number; goal: string; modules: string[]; implements: string[]; depends_on: unknown[]; validation: unknown }[];
  interfaces: { module: string; name: string; kind: string; path: string | null; description: string }[] | null;
  architecture: string | null;
  environments: { name: string; fields: Record<string, string> }[] | null;
  // A deferral's follow-up (D6 §6.2; the slice-37 review's M6): the
  // obligation it is asked for, with the stages as they stand now; null for
  // the phase's first authoring.
  follow_up: { obligation: string; criteria: string[]; reason: string | null; prerequisite: unknown; stages: { number: number; status: string }[] } | null;
  // A gap follow-up's (plan/phase.ts registerGapAuthoring): per stage, the
  // kinds, criteria and areas its gate scope lacks under the effective
  // version, as registered.
  gaps?: { stage: number; kinds: string[]; criteria: string[]; areas: string[] }[] | null;
}
function authoringFacts(db: Database, project: string, planId: string | null, item: { trigger_source: string | null; trigger_id: string | null; trigger_evidence?: string | null }): AuthoringFacts {
  const parse = <T>(text: unknown, fallback: T): T => {
    try {
      return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  // The plan the work names, followed to its active generation.
  let id = planId;
  for (let hops = 0; id !== null && hops < 64; hops++) {
    const r = db.prepare('SELECT "active", "replaced_by" FROM "phase_plans" WHERE "id" = ?').get(id) as { active: number; replaced_by: string | null } | undefined;
    if (!r || r.active === 1 || r.replaced_by === null) break;
    id = r.replaced_by;
  }
  const plan = id === null ? undefined : (db.prepare('SELECT "id", "phase_number", "generation", "bundle" FROM "phase_plans" WHERE "id" = ?').get(id) as { id: string; phase_number: number; generation: number; bundle: string | null } | undefined);
  const keyOf = (r: string): string => (db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? AND ("id" = ? OR "key" = ?)').get(project, r, r) as { key: string } | undefined)?.key ?? r;
  const stages = plan
    ? activeStages<{ number: number; goal: string; modules: string; implements: string; depends_on: string; validation: string }>(db, plan.id).map((s) => ({
        number: s.number,
        goal: s.goal,
        modules: parse<string[]>(s.modules, []),
        implements: parse<string[]>(s.implements, []).map(keyOf),
        depends_on: parse<unknown[]>(s.depends_on, []),
        validation: parse<unknown>(s.validation, null),
      }))
    : [];
  const bundle = plan?.bundle ? (db.prepare('SELECT "artifacts" FROM "plan_bundles" WHERE "id" = ?').get(plan.bundle) as { artifacts: string } | undefined) : undefined;
  const content = bundle ? parse<{ modules?: { modules?: { name: string; interfaces?: { name: string; kind: string; path?: string; description: string }[] }[] }; architecture_text?: string | null } | null>(bundle.artifacts, null) : null;
  const interfaces = content?.modules?.modules ? content.modules.modules.flatMap((m) => (m.interfaces ?? []).map((i) => ({ module: m.name, name: i.name, kind: i.kind, path: i.path ?? null, description: i.description }))) : null;
  // The approved specification's environments (TPL §7), from its semantic
  // representation; null when it cannot be read.
  const approved = db.prepare('SELECT "semantic_digest" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { semantic_digest: string } | undefined;
  const sem = approved ? (db.prepare('SELECT "representation" FROM "spec_semantics" WHERE "project" = ? AND "semantic_digest" = ? AND "readable" = 1 ORDER BY rowid DESC LIMIT 1').get(project, approved.semantic_digest) as { representation: string | null } | undefined) : undefined;
  const environments = sem?.representation ? (parse<{ environments?: { name: string; fields: Record<string, string> }[] } | null>(sem.representation, null)?.environments ?? null) : null;
  const obligation =
    item.trigger_source === 'deferred_authoring' || item.trigger_source === 'authoring_pending'
      ? (db.prepare('SELECT "id", "criteria", "deferred_reason", "prerequisite" FROM "check_obligations" WHERE "id" = ?').get(item.trigger_id) as
          | { id: string; criteria: string; deferred_reason: string | null; prerequisite: string | null }
          | undefined)
      : undefined;
  const follow_up = obligation
    ? {
        obligation: obligation.id,
        criteria: parse<string[]>(obligation.criteria, []),
        reason: obligation.deferred_reason,
        prerequisite: parse<unknown>(obligation.prerequisite, null),
        stages: plan ? activeStages<{ number: number; status: string }>(db, plan.id).map((s) => ({ number: s.number, status: s.status })) : [],
      }
    : null;
  return {
    phase_plan: plan ? { id: plan.id, phase_number: plan.phase_number, generation: plan.generation } : null,
    stages,
    interfaces,
    architecture: content?.architecture_text ?? null,
    environments,
    follow_up,
    gaps: item.trigger_source === 'authoring_gap' ? (parse<{ gaps?: AuthoringFacts['gaps'] }>(item.trigger_evidence ?? null, {}).gaps ?? null) : null,
  };
}

function checkEnvironments(db: Database, project: string): NonNullable<CheckWritingFacts['environments']> {
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };
  const all = db
    .prepare(`SELECT e."name", c."content" FROM "environments" e LEFT JOIN "environment_configs" c ON c."id" = e."current_config" WHERE e."project" = ? ORDER BY e."name", e.rowid`)
    .all(project) as { name: string; content: string | null }[];
  // An environment is one thing by name (the driver's ruling, slice 38):
  // stated once, from the owner's configuration where a row of the name has
  // one; a store that holds two rows of a name (written before the ruling)
  // is merged here, never listed twice.
  const rows: { name: string; content: string | null }[] = [];
  for (const r of all) {
    const seen = rows.find((x) => x.name === r.name);
    if (!seen) rows.push({ ...r });
    else if (seen.content === null && r.content !== null) seen.content = r.content;
  }
  return rows.map((r) => {
    const c = r.content === null ? null : parse(r.content);
    const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).slice() : null);
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return { name: r.name, targets: null, check_secrets: null, runtime: null };
    const content = c as Record<string, unknown>;
    // The runtime the owner's configuration pins (D4 §3.2): a toolchain the
    // phase's authoring may name (src/packages/reads.ts, verifier.toolchain).
    const rt = content.runtime as { path?: unknown; sha256?: unknown } | undefined;
    const runtime = rt && typeof rt.path === 'string' ? { path: rt.path, sha256: typeof rt.sha256 === 'string' ? rt.sha256 : null } : null;
    return { name: r.name, targets: strings(content.targets), check_secrets: content.check_secrets === undefined ? [] : strings(content.check_secrets), runtime };
  });
}

// The project's stages as the scope rule reads them (deliveryOf, D3 §4.2):
// every stage row of the project with the requirements it implements, by
// key (a stage names a requirement by id or key). null when a stage's
// `implements` cannot be read: the plan is then unknown, never empty.
function stagePlan(db: Database, project: string, requirements: readonly { id: string; key: string }[]): { number: number; status: string; implements: string[] }[] | null {
  try {
    // The active obligation set: no stage an early replacement cancelled or
    // superseded (D6 §5.7; the review's N5).
    const rows = db.prepare('SELECT "number", "status", "implements" FROM "stages" WHERE "project" = ? AND "cancelled_at" IS NULL ORDER BY "number", rowid, "id"').all(project) as { number: number; status: string; implements: string }[];
    const keyOf = (r: string): string => requirements.find((q) => q.id === r || q.key === r)?.key ?? r;
    return rows.map((s) => {
      const ids = JSON.parse(s.implements) as unknown;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new Error('unreadable implements');
      return { number: s.number, status: s.status, implements: [...new Set(ids.map(keyOf))] };
    });
  } catch {
    return null;
  }
}

// What the engine recorded of each commit of a project (E106), by its
// `revisions` rows, never by a commit's trailers, which a role could write:
// `by_run` true when any row names the run that made it (a role's work),
// false when every row names none (the engine's or the owner's: the
// bootstrap, a policy revision, an applied protected change, adopted
// out-of-band edits); `kind` the rows' kinds; `purpose` the purpose of the
// engine's commit operation for that commit, where there is one. A commit
// with no row is absent: who made it is unknown. null when the records
// cannot be read.
export type RevisionRecords = Record<string, { by_run: boolean; kinds: string[]; purpose: string | null }>;
export function revisionRecords(db: Database, project: string): RevisionRecords | null {
  try {
    const rows = db.prepare('SELECT "sha", "kind", "created_by_run" FROM "revisions" WHERE "project" = ? ORDER BY rowid, "id"').all(project) as {
      sha: string;
      kind: string;
      created_by_run: string | null;
    }[];
    const out: RevisionRecords = {};
    for (const r of rows) {
      const e = (out[r.sha] ??= { by_run: false, kinds: [], purpose: null });
      if (r.created_by_run !== null) e.by_run = true;
      if (!e.kinds.includes(r.kind)) e.kinds.push(r.kind);
    }
    // The purpose only names what the engine's commit was; it never decides
    // whose a commit is. An operation that cannot be read names none.
    const ops = db.prepare(`SELECT "finalizer_inputs" FROM "operations" WHERE "project" = ? AND "kind" = 'git_commit' ORDER BY "seq"`).all(project) as { finalizer_inputs: string | null }[];
    for (const o of ops) {
      let inputs: { sha?: unknown; purpose?: unknown } | null = null;
      try {
        inputs = JSON.parse(o.finalizer_inputs ?? 'null') as { sha?: unknown; purpose?: unknown } | null;
      } catch {
        inputs = null;
      }
      if (inputs && typeof inputs.sha === 'string' && typeof inputs.purpose === 'string' && out[inputs.sha]) out[inputs.sha]!.purpose ??= inputs.purpose;
    }
    return out;
  } catch {
    return null;
  }
}

// The records a run's context package may hold by id (the failed checks'
// output records a repair run is given, D3 §2.10): where each is and the
// size and hash its bytes must have, or null for a record the API would
// not serve. A record of another project, unpublished, expired, recorded
// missing, or flagged by a detector after it was written (post_scan
// 'hit', quarantined: served by no route, E42 item 1) is withheld, and the
// package treats it as missing; it is never copied (slice 21 review).
export function recordPaths(db: Database, args: { project: string; ids: string[] }): Record<string, { path: string; sha256: string | null; bytes: number | null } | null> {
  const out: Record<string, { path: string; sha256: string | null; bytes: number | null } | null> = {};
  for (const id of args.ids) {
    const row = db.prepare('SELECT "project", "path", "sha256", "bytes", "published", "missing_at", "post_scan" FROM "records" WHERE "id" = ?').get(id) as
      | { project: string; path: string | null; sha256: string | null; bytes: number | null; published: number; missing_at: string | null; post_scan: string }
      | undefined;
    const served = row !== undefined && row.project === args.project && row.published === 1 && row.path !== null && row.missing_at === null && row.post_scan !== 'hit';
    out[id] = served ? { path: row!.path!, sha256: row!.sha256, bytes: row!.bytes } : null;
  }
  return out;
}

// What the mount plan's validation needs before a launch (D2 §2.3): the
// project's widened read paths, and the locations no widening may reach that
// the store knows of.
export function mountContext(db: Database, args: { project: string }) {
  const col = (sql: string) => (db.prepare(sql).all() as { p: string }[]).map((r) => r.p);
  const options = projectOptions(db, args.project);
  // The protected roots of the project's effective version (D1 §7.3; D2
  // §2.3): every role but the Verifier sees them read-only.
  const effective = db
    .prepare(`SELECT "roots", "fingerprint" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL`)
    .get(args.project) as { roots: string; fingerprint: string } | undefined;
  return {
    paths: options.sandbox_read_paths,
    egress_allow_extra: options.egress_allow_extra,
    protected: { roots: effective ? (JSON.parse(effective.roots) as string[]) : ['.surety/checks/'], fingerprint: effective?.fingerprint ?? null },
    context: {
      repositories: col('SELECT DISTINCT "dev_repo_path" AS p FROM "projects"'),
      workspaces: col(`SELECT "path" AS p FROM "workspaces" WHERE "disposition" <> 'discarded'`),
      checkouts: col('SELECT "path" AS p FROM "managed_checkouts"'),
    },
  };
}

// The check keys a run's findings may name (the review of b72b9cc, F1): the
// effective protected version's, the same list its package shows; null
// when the project has no effective version, so no key can be named.
// With them, the criteria of the registered requirement index a finding's
// `criterion` may name (D3 §2.11); null when no index is registered.
export function runCheckKeys(db: Database, args: { run: string }): { keys: string[] | null; criteria: string[] | null } {
  const run = db.prepare('SELECT "project" FROM "runs" WHERE "id" = ?').get(args.run) as { project: string } | undefined;
  if (!run) return { keys: null, criteria: null };
  const version = effectiveVersion(db, run.project);
  const criteria = knownCriteria(db, run.project);
  return { keys: version ? [...new Set(checksOfVersion(db, version.id).map((c) => c.key))].sort() : null, criteria: criteria === null ? null : [...criteria].sort() };
}
