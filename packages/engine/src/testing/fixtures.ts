// Fixture installation (build spec §8, SEAM.md §§7, 15): test setup the
// engine accepts only in harness mode, labelled as such. Like all code outside
// the migration runner, it writes the store only through transition functions
// (SEAM.md §5): the ones production uses, called with the fixture label.

import { isAbsolute } from 'node:path';

import type { Database } from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import { createProject } from '../store/transitions/project.js';
import type { Baseline } from '../store/transitions/repo.js';
import { allocateReceipt } from '../store/transitions/runs.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import { applyWorkTransition, observeTrigger, registerPlan } from '../store/transitions/work.js';
import {
  type CheckInput,
  type ResultInput,
  configureEnvironment,
  declareChecks,
  ensureModules,
  ensureRequirements,
  recordAlphaException,
  recordCheckResult,
  recordReuse,
  recordScopeApproval,
  requirementIds,
} from '../store/transitions/baseline.js';
import type { DecisionKind } from '../store/transitions/decisions.js';
import { type ChangeKind, type ProtectedSet, CORRECTION_KIND, classifyProposal } from '../store/transitions/protected.js';
import { raiseQuestion } from '../store/transitions/queue.js';

// The label on every event a fixture causes (SEAM.md §10, §15).
const FIXTURE_LABEL = { test_fixture: true } as const;

const FIXTURE_FIELDS = ['name', 'tier', 'dev_repo_path', 'integration_branch'] as const;

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the fixture request.', { field });

function objectBody(body: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (!fields.includes(key)) throw new Refusal(400, 'unknown_field', `"${key}" is not a field of this fixture.`, `Send only ${fields.join(', ')}.`, { field: key });
  }
  return b;
}

const str = (b: Record<string, unknown>, field: string) => {
  const v = b[field];
  if (typeof v !== 'string' || v.length === 0) throw invalid(field, 'must be a non-empty string');
  return v;
};

const positiveInt = (b: Record<string, unknown>, field: string) => {
  const v = b[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw invalid(field, 'must be a positive integer');
  return v;
};

export interface ProjectBody {
  name: string;
  tier: string;
  dev_repo_path: string;
  integration_branch: string;
}

export function parseProjectBody(body: unknown): ProjectBody {
  const b = objectBody(body, FIXTURE_FIELDS);
  const name = str(b, 'name');
  const tier = str(b, 'tier');
  if (!['T1', 'T2', 'T3'].includes(tier)) throw invalid('tier', 'must be T1, T2 or T3');
  const repo = str(b, 'dev_repo_path');
  if (!isAbsolute(repo)) throw invalid('dev_repo_path', 'must be an absolute path');
  const branch = str(b, 'integration_branch');
  return { name, tier, dev_repo_path: repo, integration_branch: branch };
}

// POST /v1/harness/fixtures/project: a registered project on an existing
// repository, its integration branch registered at the commit it is at, and
// the developer's checkouts of that branch managed (SEAM.md §25).
export function installFixtureProject(
  db: Database,
  actor: Actor,
  args: { body: ProjectBody; head: string; checkouts: { path: string; baseline: Baseline }[]; protectedSet: ProtectedSet },
): { project: { id: string } } {
  const id = transact(db, actor, (tx) => createProject(tx, { ...args.body, head: args.head, checkouts: args.checkouts, protectedSet: args.protectedSet, approvedBy: 'test fixture' }, FIXTURE_LABEL));
  return { project: { id } };
}

const TRIGGER_FIELDS = ['project', 'kind', 'trigger_source', 'trigger_id', 'trigger_generation', 'subject', 'depends_on'] as const;

// POST /v1/harness/fixtures/trigger: the engine observes a trigger (D1 §8.2)
// through its own transition.
export function installFixtureTrigger(db: Database, actor: Actor, body: unknown): { work_item: { id: string }; created: boolean } {
  const b = objectBody(body, TRIGGER_FIELDS);
  const subject = b.subject ?? {};
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) throw invalid('subject', 'must be an object');
  const dependsOn = b.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) throw invalid('depends_on', 'must be an array of work item ids');
  const input = {
    project: str(b, 'project'),
    kind: b.kind,
    trigger_source: str(b, 'trigger_source'),
    trigger_id: str(b, 'trigger_id'),
    trigger_generation: positiveInt(b, 'trigger_generation'),
    subject: subject as Record<string, unknown>,
    depends_on: dependsOn as string[],
  };
  return transact(db, actor, (tx) => observeTrigger(tx, input, FIXTURE_LABEL));
}

export interface PlanBody {
  project: string;
  stages: { number: number; goal: string; implements: string[] }[];
  requirements: string[];
  modules: { name: string; paths: string[]; sensitive_areas?: string[] }[];
}

const strings = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalid(field, 'must be an array of strings');
  return v as string[];
};

export function parsePlanBody(body: unknown): PlanBody {
  const b = objectBody(body, ['project', 'stages', 'requirements', 'modules']);
  const project = str(b, 'project');
  if (!Array.isArray(b.stages) || b.stages.length === 0) throw invalid('stages', 'must be a non-empty array');
  const stages = b.stages.map((s: unknown, i: number) => {
    const st = objectBody(s, ['number', 'goal', 'implements']);
    if (typeof st.goal !== 'string' || st.goal.length === 0) throw invalid(`stages[${i}].goal`, 'must be a non-empty string');
    return { number: positiveInt(st, 'number'), goal: st.goal, implements: st.implements === undefined ? [] : strings(st.implements, `stages[${i}].implements`) };
  });
  if (b.requirements !== undefined && !Array.isArray(b.requirements)) throw invalid('requirements', 'must be an array');
  if (b.modules !== undefined && !Array.isArray(b.modules)) throw invalid('modules', 'must be an array');
  const requirements = ((b.requirements ?? []) as unknown[]).map((r) => str(objectBody(r, ['key']), 'key'));
  const modules = ((b.modules ?? []) as unknown[]).map((m, i) => {
    const mo = objectBody(m, ['name', 'paths', 'sensitive_areas']);
    return { name: str(mo, 'name'), paths: strings(mo.paths, `modules[${i}].paths`), ...(mo.sensitive_areas !== undefined ? { sensitive_areas: strings(mo.sensitive_areas, `modules[${i}].sensitive_areas`) } : {}) };
  });
  return { project, stages, requirements, modules };
}

// POST /v1/harness/fixtures/plan: an approved baseline's requirements and
// modules, and an approved phase plan with its stages and their stage_build
// work, registered by the engine's own plan transition (SEAM.md §67).
export function installFixturePlan(db: Database, actor: Actor, args: PlanBody & { baseRevision: string }) {
  return transact(db, actor, (tx) => {
    const requirements = ensureRequirements(tx, { project: args.project, keys: args.requirements });
    ensureModules(tx, { project: args.project, modules: args.modules });
    const stages = args.stages.map((st, i) => ({ number: st.number, goal: st.goal, implements: requirementIds(tx, args.project, st.implements, `stages[${i}].implements`) }));
    const plan = registerPlan(tx, { project: args.project, baseRevision: args.baseRevision, approvedBy: 'test fixture', stages }, FIXTURE_LABEL);
    return { ...plan, requirements };
  });
}

const CHECK_KINDS = ['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery', 'sensitivity_floor', 'post_deploy_identity', 'post_deploy_behavior'];
const GATE_KINDS = ['stage', 'phase', 'alpha_authorize', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'];

// POST /v1/harness/fixtures/checks (SEAM.md §67).
export function installFixtureChecks(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['project', 'checks']);
  const project = str(b, 'project');
  if (!Array.isArray(b.checks) || b.checks.length === 0) throw invalid('checks', 'must be a non-empty array');
  const checks: CheckInput[] = b.checks.map((c: unknown, i: number) => {
    const ch = objectBody(c, ['key', 'kind', 'gate_kinds', 'requirements', 'required', 'tier_floor', 'sensitive_areas', 'runner_class', 'requires']);
    const kind = str(ch, 'kind');
    if (!CHECK_KINDS.includes(kind)) throw invalid(`checks[${i}].kind`, 'is not a check kind');
    const gates = strings(ch.gate_kinds, `checks[${i}].gate_kinds`);
    if (gates.some((g) => !GATE_KINDS.includes(g))) throw invalid(`checks[${i}].gate_kinds`, 'names a gate kind that does not exist');
    const tier = ch.tier_floor === undefined || ch.tier_floor === null ? null : str(ch, 'tier_floor');
    if (tier !== null && !['T1', 'T2', 'T3'].includes(tier)) throw invalid(`checks[${i}].tier_floor`, 'must be T1, T2 or T3');
    const runner = ch.runner_class === undefined ? 'direct' : str(ch, 'runner_class');
    if (!['direct', 'container', 'remote'].includes(runner)) throw invalid(`checks[${i}].runner_class`, 'must be direct, container or remote');
    const requires = ch.requires === undefined ? [] : strings(ch.requires, `checks[${i}].requires`);
    if (requires.some((r) => r !== 'environment' && r !== 'artifact_digest')) throw invalid(`checks[${i}].requires`, 'may name only environment and artifact_digest');
    if (ch.required !== undefined && typeof ch.required !== 'boolean') throw invalid(`checks[${i}].required`, 'must be a boolean');
    return {
      key: str(ch, 'key'),
      kind,
      gate_kinds: gates,
      requirements: ch.requirements === undefined ? [] : strings(ch.requirements, `checks[${i}].requirements`),
      required: ch.required !== false,
      tier_floor: tier,
      sensitive_areas: ch.sensitive_areas === undefined ? [] : strings(ch.sensitive_areas, `checks[${i}].sensitive_areas`),
      runner_class: runner,
      requires,
    };
  });
  return transact(db, actor, (tx) => declareChecks(tx, { project, checks }));
}

const RESULT_FIELDS = [
  'project', 'check', 'candidate', 'exit_status', 'source_revision', 'protected_version', 'runner_class', 'runner_id', 'environment', 'artifact_digest',
  'execution_established', 'signaled', 'deadline_hit', 'started_at', 'finished_at', 'output',
];

export function parseResultBody(body: unknown): ResultInput & { outputText: string | null } {
  const b = objectBody(body, RESULT_FIELDS);
  if (!('exit_status' in b) || (b.exit_status !== null && (typeof b.exit_status !== 'number' || !Number.isInteger(b.exit_status)))) throw invalid('exit_status', 'must be an integer or null');
  const opt = (field: string) => (b[field] === undefined || b[field] === null ? undefined : str(b, field));
  const bool = (field: string) => {
    if (b[field] === undefined) return undefined;
    if (typeof b[field] !== 'boolean') throw invalid(field, 'must be a boolean');
    return b[field] as boolean;
  };
  if (b.output !== undefined && typeof b.output !== 'string') throw invalid('output', 'must be a string');
  return {
    project: str(b, 'project'),
    check: str(b, 'check'),
    candidate: str(b, 'candidate'),
    exit_status: b.exit_status as number | null,
    source_revision: opt('source_revision'),
    protected_version: opt('protected_version'),
    runner_class: opt('runner_class'),
    runner_id: opt('runner_id'),
    environment: opt('environment') ?? null,
    artifact_digest: opt('artifact_digest') ?? null,
    execution_established: bool('execution_established'),
    signaled: bool('signaled'),
    deadline_hit: bool('deadline_hit'),
    started_at: opt('started_at') ?? null,
    finished_at: opt('finished_at') ?? null,
    outputText: (b.output as string | undefined) ?? null,
  };
}

// POST /v1/harness/fixtures/check-result (SEAM.md §67). The output, if any,
// was published as a check_output record before this.
export function installCheckResult(db: Database, actor: Actor, args: ResultInput) {
  return transact(db, actor, (tx) => recordCheckResult(tx, args, FIXTURE_LABEL));
}

export function installEnvironment(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['project', 'name', 'target_set']);
  return transact(db, actor, (tx) => configureEnvironment(tx, { project: str(b, 'project'), name: str(b, 'name'), target_set: strings(b.target_set, 'target_set') }));
}

// POST /v1/harness/fixtures/classification: what D3's classifier would say
// of a captured proposal (SEAM.md §§67, 69). The engine routes it.
export function installClassification(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['proposal', 'change_kind']);
  const changeKind = str(b, 'change_kind');
  if (!['tightening', 'loosening', 'unclassifiable'].includes(changeKind)) throw invalid('change_kind', 'must be tightening, loosening or unclassifiable');
  return transact(db, actor, (tx) => {
    const p = classifyProposal(tx, { proposal: str(b, 'proposal'), changeKind: changeKind as ChangeKind }, FIXTURE_LABEL);
    raiseQuestion(tx, { project: p.project, kind: CORRECTION_KIND[changeKind] as DecisionKind, subjectType: 'protected_proposal', subjectId: p.id });
    return { proposal: { id: p.id, status: p.status } };
  });
}

export function installScopeApproval(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['project', 'kind', 'proposal']);
  if (b.kind !== 'validation_scope') throw invalid('kind', 'must be validation_scope');
  return transact(db, actor, (tx) => recordScopeApproval(tx, { project: str(b, 'project'), proposal: str(b, 'proposal') }));
}

export function parseAlphaException(body: unknown): { finding: string; containment: string; purpose: string } {
  const b = objectBody(body, ['finding', 'containment_evidence', 'testing_purpose']);
  return { finding: str(b, 'finding'), containment: str(b, 'containment_evidence'), purpose: str(b, 'testing_purpose') };
}

export function installAlphaException(db: Database, actor: Actor, args: { finding: string; record: string; purpose: string }) {
  return transact(db, actor, (tx) => recordAlphaException(tx, { finding: args.finding, record: args.record, testing_purpose: args.purpose }));
}

export function installReuse(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['project', 'candidate', 'check', 'check_result', 'record', 'assessed']);
  if (typeof b.assessed !== 'boolean') throw invalid('assessed', 'must be a boolean');
  const opt = (field: string) => (b[field] === undefined || b[field] === null ? null : str(b, field));
  return transact(db, actor, (tx) =>
    recordReuse(tx, { project: str(b, 'project'), candidate: str(b, 'candidate'), check: str(b, 'check'), check_result: opt('check_result'), record: opt('record'), assessed: b.assessed as boolean }),
  );
}

export function findingProject(db: Database, finding: string): string | null {
  return (db.prepare('SELECT "project" FROM "findings" WHERE "id" = ?').get(finding) as { project: string } | undefined)?.project ?? null;
}

// POST /v1/harness/work/:w/transition: the engine's work-item transition
// function, applied directly.
export function applyFixtureTransition(db: Database, actor: Actor, args: { workItem: string; body: unknown }) {
  const b = objectBody(args.body, ['to']);
  return transact(db, actor, (tx) => applyWorkTransition(tx, { workItem: args.workItem, to: b.to }));
}

// POST /v1/harness/allocate: the scheduler's own receipt allocation.
export function allocateFixtureReceipt(db: Database, actor: Actor, body: unknown): { invocation: string } {
  const b = objectBody(body, ['run']);
  const run = str(b, 'run');
  return { invocation: transact(db, actor, (tx) => allocateReceipt(tx, run)) };
}

export function projectRepo(db: Database, project: string): { repo: string; branch: string } | null {
  const row = db.prepare('SELECT "dev_repo_path", "integration_branch" FROM "projects" WHERE "id" = ?').get(project) as
    | { dev_repo_path: string; integration_branch: string }
    | undefined;
  return row ? { repo: row.dev_repo_path, branch: row.integration_branch } : null;
}
