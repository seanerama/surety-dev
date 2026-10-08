// Read-only queries. Reads never write and never call out of the store.

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

export interface ProjectCandidates {
  project: string;
  repo: string;
  branch: string;
  items: { id: string; kind: string; role: string; boundary: boolean }[];
}

// Every project with work that could be dispatched now, as far as the store
// alone can tell. The scheduler's prerequisite steps decide the rest, and the
// claim transaction checks it all again.
export function dispatchCandidates(db: Database, args: { maxConcurrentRuns: number }): ProjectCandidates[] {
  const projects = db.prepare('SELECT "id", "dev_repo_path", "integration_branch" FROM "projects" ORDER BY "created_at", "id"').all() as {
    id: string;
    dev_repo_path: string;
    integration_branch: string;
  }[];
  const out: ProjectCandidates[] = [];
  for (const p of projects) {
    let items: ProjectCandidates['items'];
    try {
      items = (db.prepare(`SELECT * FROM "work_items" WHERE "project" = ? AND "status" = 'eligible' ORDER BY "seq"`).all(p.id) as WorkRow[])
        .map((item) => ({ item, blocker: dispatchBlocker(db, item, args.maxConcurrentRuns) }))
        .filter(({ blocker }) => blocker === null || blocker === CHAIN_BOUNDARY)
        .sort((a, b) => (PRIORITY[a.item.kind] ?? 3) - (PRIORITY[b.item.kind] ?? 3) || a.item.seq - b.item.seq)
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
  return (db.prepare('SELECT "id" FROM "projects" ORDER BY "created_at", "id"').all() as { id: string }[]).map((r) => r.id);
}

// Runs that are quarantined, for the observation at every tick (SEAM.md §14).
export function quarantinedRuns(db: Database): { id: string; project: string }[] {
  return db.prepare(`SELECT "id", "project" FROM "runs" WHERE "state" = 'finalizing' AND "quarantined" = 1 ORDER BY "created_at"`).all() as {
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
  if (!run) return null;
  const item = db.prepare('SELECT "id", "kind", "subject", "project" FROM "work_items" WHERE "id" = ?').get(run.work_item) as { id: string; kind: string; subject: string; project: string };
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
  let modules: { id: string; name: string; paths: unknown }[] = [];
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
    modules = names
      .map((name) => db.prepare('SELECT "id", "name", "paths" FROM "modules" WHERE "project" = ? AND "name" = ?').get(item.project, name) as { id: string; name: string; paths: string } | undefined)
      .filter((m): m is { id: string; name: string; paths: string } => m !== undefined)
      .map((m) => ({ id: m.id, name: m.name, paths: parse<unknown>(m.paths, []) }));
    const p = db.prepare('SELECT "id", "phase_number", "git_path", "prepared_against_revision" FROM "phase_plans" WHERE "id" = ?').get(stage.phase_plan) as Record<string, unknown> | undefined;
    plan = p ?? null;
  }
  // The Verifier of check_correction work writes checks for every
  // requirement of the project (BS3 §3): each registered requirement, with
  // its approved text, its criteria and its areas (D3 §4.5).
  type IndexedReq = Req & { criteria: string | null; sensitive_areas: string };
  let checkWriting: CheckWritingFacts | null = null;
  if (item.kind === 'check_correction') {
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
    diff_base: { revision: string | null; from: 'previous_candidate' | 'first_recorded_parent' | null };
  } | null = null;
  if (candidate && (role === 'reviewer' || role === 'verifier')) {
    const findings = (db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "status" IN ('open', 'dispositioned') ORDER BY "seq"`).all(item.project) as Finding[])
      .filter((f) => findingApplies(db, f, candidate))
      .map(findingFacts);
    const assessments = db
      .prepare(`SELECT "id", "finding", "candidate", "reason", "status" FROM "applicability_assessments" WHERE "project" = ? AND "candidate" = ? AND "status" = 'proposed' ORDER BY "created_at", "id"`)
      .all(item.project, candidate.id) as { id: string; finding: string; candidate: string; reason: string; status: string }[];
    const previous = db.prepare('SELECT "revision" FROM "candidates" WHERE "project" = ? AND "seq" < ? ORDER BY "seq" DESC LIMIT 1').get(item.project, candidate.seq) as { revision: string } | undefined;
    const first = previous
      ? undefined
      : (db.prepare('SELECT "parent_sha" FROM "revisions" WHERE "project" = ? AND "parent_sha" IS NOT NULL ORDER BY "recorded_at", "created_at", "id" LIMIT 1').get(item.project) as { parent_sha: string } | undefined);
    review = {
      findings,
      assessments,
      signoffs: role === 'reviewer' ? candidateSignoffs(db, item.project, candidate) : [],
      diff_base: previous ? { revision: previous.revision, from: 'previous_candidate' } : first ? { revision: first.parent_sha, from: 'first_recorded_parent' } : { revision: null, from: null },
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
        .prepare(`SELECT "id", "kind", "path" FROM "records" WHERE "run" = ? AND "published" = 1 AND "kind" <> 'raw_user_report' ORDER BY "created_at", "id"`)
        .all(parent.id) as { id: string; kind: string; path: string | null }[];
      resumed = { run: parent.id, outcome: parent.outcome, reason_class: parent.reason_class, summary: parse<{ summary?: unknown } | null>(parent.result_value, null)?.summary ?? null, records };
    }
  }
  return {
    run: { id: run.id as string, role: run.role as string, base_revision: run.base_revision as string, content_hash: (run.content_hash as string | null) ?? null },
    work_item: item,
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
    resumed,
  };
}

// The project's stages as the scope rule reads them (deliveryOf, D3 §4.2):
// every stage row of the project with the requirements it implements, by
// key (a stage names a requirement by id or key). null when a stage's
// `implements` cannot be read: the plan is then unknown, never empty.
function stagePlan(db: Database, project: string, requirements: readonly { id: string; key: string }[]): { number: number; status: string; implements: string[] }[] | null {
  try {
    const rows = db.prepare('SELECT "number", "status", "implements" FROM "stages" WHERE "project" = ? ORDER BY "number", "created_at", "id"').all(project) as { number: number; status: string; implements: string }[];
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
