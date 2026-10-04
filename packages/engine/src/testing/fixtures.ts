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
import { OBSERVED_CONDITIONS, type ObservedCondition, recordObservation } from '../store/transitions/environments.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import { applyWorkTransition, observeTrigger, registerPlan } from '../store/transitions/work.js';
import {
  type CheckInput,
  type ResultInput,
  configureEnvironment,
  declareChecks,
  ensureModules,
  ensureBaselineTexts,
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
import type { DecisionRow } from '../store/transitions/decisions.js';
import { answerQueued } from '../store/transitions/queue.js';
import { TEMPLATES } from '../invoke/adapters/templates.js';
import { proposeAttempt, proposeEntry } from '../store/transitions/qualification.js';
import { type AttemptInput, type EntryInput, currentProfileFingerprint, getEntry, profileWithEgress, revokeEntry, writeAttempt } from '../store/transitions/trust.js';
import { BOUNDARY_MECHANISM, ISOLATION_MECHANISM, hostIdentity } from '../trust/host.js';

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

const TRIGGER_FIELDS = ['project', 'kind', 'trigger_source', 'trigger_id', 'trigger_generation', 'subject', 'depends_on', 'profile'] as const;

// POST /v1/harness/fixtures/trigger: the engine observes a trigger (D1 §8.2)
// through its own transition.
export function installFixtureTrigger(db: Database, actor: Actor, body: unknown): { work_item: { id: string }; created: boolean } {
  const b = objectBody(body, TRIGGER_FIELDS);
  const subject = b.subject ?? {};
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) throw invalid('subject', 'must be an object');
  const dependsOn = b.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) throw invalid('depends_on', 'must be an array of work item ids');
  // SEAM.md §127: the sandbox profile the item's runs are dispatched under.
  if (b.profile !== undefined && b.profile !== 'role' && b.profile !== 'probe') throw invalid('profile', 'must be "role" or "probe"');
  const input = {
    project: str(b, 'project'),
    kind: b.kind,
    trigger_source: str(b, 'trigger_source'),
    trigger_id: str(b, 'trigger_id'),
    trigger_generation: positiveInt(b, 'trigger_generation'),
    subject: subject as Record<string, unknown>,
    depends_on: dependsOn as string[],
    profile: (b.profile as 'role' | 'probe' | undefined) ?? null,
  };
  return transact(db, actor, (tx) => observeTrigger(tx, input, FIXTURE_LABEL));
}

export interface PlanBody {
  project: string;
  stages: { number: number; goal: string; implements: string[]; adrs: string[] }[];
  requirements: string[];
  // E67 item 7 (SEAM.md §139): approved texts.
  requirementTexts: Record<string, string>;
  adrs: { key: string; text: string }[];
  constraints: { key: string; text: string }[];
  modules: { name: string; paths: string[]; sensitive_areas?: string[] }[];
}

const keyed = (v: unknown, field: string): { key: string; text: string }[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw invalid(field, 'must be an array');
  return v.map((x, i) => {
    const o = objectBody(x, ['key', 'text']);
    if (typeof o.text !== 'string') throw invalid(`${field}[${i}].text`, 'must be a string');
    return { key: str(o, 'key'), text: o.text };
  });
};

const strings = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalid(field, 'must be an array of strings');
  return v as string[];
};

export function parsePlanBody(body: unknown): PlanBody {
  const b = objectBody(body, ['project', 'stages', 'requirements', 'modules', 'adrs', 'constraints']);
  const project = str(b, 'project');
  if (!Array.isArray(b.stages) || b.stages.length === 0) throw invalid('stages', 'must be a non-empty array');
  const stages = b.stages.map((s: unknown, i: number) => {
    const st = objectBody(s, ['number', 'goal', 'implements', 'adrs']);
    if (typeof st.goal !== 'string' || st.goal.length === 0) throw invalid(`stages[${i}].goal`, 'must be a non-empty string');
    return {
      number: positiveInt(st, 'number'),
      goal: st.goal,
      implements: st.implements === undefined ? [] : strings(st.implements, `stages[${i}].implements`),
      adrs: st.adrs === undefined ? [] : strings(st.adrs, `stages[${i}].adrs`),
    };
  });
  if (b.requirements !== undefined && !Array.isArray(b.requirements)) throw invalid('requirements', 'must be an array');
  if (b.modules !== undefined && !Array.isArray(b.modules)) throw invalid('modules', 'must be an array');
  const requirementTexts: Record<string, string> = {};
  const requirements = ((b.requirements ?? []) as unknown[]).map((r, i) => {
    const o = objectBody(r, ['key', 'text']);
    const key = str(o, 'key');
    if (o.text !== undefined) {
      if (typeof o.text !== 'string') throw invalid(`requirements[${i}].text`, 'must be a string');
      requirementTexts[key] = o.text;
    }
    return key;
  });
  const adrs = keyed(b.adrs, 'adrs');
  const constraints = keyed(b.constraints, 'constraints');
  for (const [i, st] of stages.entries()) for (const k of st.adrs) if (!adrs.some((a) => a.key === k)) throw invalid(`stages[${i}].adrs`, `names ${k}, which is not among the plan's adrs`);
  const modules = ((b.modules ?? []) as unknown[]).map((m, i) => {
    const mo = objectBody(m, ['name', 'paths', 'sensitive_areas']);
    return { name: str(mo, 'name'), paths: strings(mo.paths, `modules[${i}].paths`), ...(mo.sensitive_areas !== undefined ? { sensitive_areas: strings(mo.sensitive_areas, `modules[${i}].sensitive_areas`) } : {}) };
  });
  return { project, stages, requirements, requirementTexts, adrs, constraints, modules };
}

export function installFixturePlan(db: Database, actor: Actor, args: PlanBody & { baseRevision: string }) {
  return transact(db, actor, (tx) => {
    const requirements = ensureRequirements(tx, { project: args.project, keys: args.requirements, texts: args.requirementTexts });
    const adrs = ensureBaselineTexts(tx, { project: args.project, kind: 'adr', items: args.adrs });
    const constraints = ensureBaselineTexts(tx, { project: args.project, kind: 'constraint', items: args.constraints });
    ensureModules(tx, { project: args.project, modules: args.modules });
    const stages = args.stages.map((st, i) => ({ number: st.number, goal: st.goal, implements: requirementIds(tx, args.project, st.implements, `stages[${i}].implements`) }));
    const plan = registerPlan(tx, { project: args.project, baseRevision: args.baseRevision, approvedBy: 'test fixture', stages }, FIXTURE_LABEL);
    // The ADRs each stage cites (SEAM.md §139).
    for (const st of plan.stages) {
      const cites = args.stages.find((x) => x.number === st.number)?.adrs ?? [];
      tx.db.prepare('UPDATE "stages" SET "adrs" = ? WHERE "id" = ?').run(JSON.stringify(cites), st.id);
    }
    return { ...plan, requirements, adrs, constraints };
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

// POST /v1/harness/fixtures/observation (SEAM.md §91): an environment's
// current observation, entered as test setup. M1 has no observation job.
export function installObservation(db: Database, actor: Actor, body: unknown) {
  const b = objectBody(body, ['project', 'environment', 'condition', 'observed_at', 'source']);
  const condition = str(b, 'condition');
  if (!(OBSERVED_CONDITIONS as readonly string[]).includes(condition)) throw invalid('condition', `must be one of ${OBSERVED_CONDITIONS.join(', ')}`);
  const observedAt = str(b, 'observed_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) || Number.isNaN(Date.parse(observedAt))) throw invalid('observed_at', 'must be a timestamp, YYYY-MM-DDTHH:MM:SS.sssZ');
  return transact(db, actor, (tx) =>
    recordObservation(tx, { project: str(b, 'project'), environment: str(b, 'environment'), condition: condition as ObservedCondition, observed_at: observedAt, source: str(b, 'source') }, FIXTURE_LABEL),
  );
}

// ---- the trust table's fixtures (M2 plan §2.3; SEAM.md §116) ------------------------------
//
// Test setup standing for what the host checks and a qualification attempt
// would have established. Each writes through the engine's own transitions,
// and every event it causes carries the fixture label. None sets an entry
// `active` but through a trust_activation decision it raises and answers as
// the human would (SEAM.md §116; M102).

const ATTEMPT_STATUSES = ['proposed', 'authorized', 'running', 'succeeded', 'failed', 'invalidated'];
const REAL_BACKENDS = ['claude', 'codex'];

interface Binary {
  path: string;
  sha256: string;
}

function binaryOf(b: Record<string, unknown>): Binary {
  const v = b.binary;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid('binary', 'must be {"path", "sha256"}');
  const o = objectBody(v, ['path', 'sha256']);
  const path = str(o, 'path');
  if (!isAbsolute(path)) throw invalid('binary', 'must name an absolute path');
  return { path, sha256: str(o, 'sha256') };
}

function realBackend(b: Record<string, unknown>): string {
  const backend = str(b, 'backend');
  if (!REAL_BACKENDS.includes(backend)) throw invalid('backend', `must be one of ${REAL_BACKENDS.join(', ')}: the scripted backend never has an entry`);
  return backend;
}

export interface AttemptFixture {
  backend: string;
  status: string;
  binary: Binary;
  fixture_project: string | null;
  version: string;
  model: string;
  template_version: string;
}

export function parseAttemptFixture(body: unknown): AttemptFixture {
  const b = objectBody(body, ['backend', 'status', 'binary', 'fixture_project', 'version', 'model', 'template_version']);
  const opt = (field: string, fallback: string) => (b[field] === undefined ? fallback : str(b, field));
  const status = opt('status', 'authorized');
  if (!ATTEMPT_STATUSES.includes(status)) throw invalid('status', `must be one of ${ATTEMPT_STATUSES.join(', ')}`);
  const backend = realBackend(b);
  return {
    backend,
    status,
    binary: binaryOf(b),
    fixture_project: b.fixture_project === undefined || b.fixture_project === null ? null : str(b, 'fixture_project'),
    version: opt('version', '0.0.0-standin'),
    model: opt('model', 'standin-model'),
    template_version: opt('template_version', TEMPLATES[backend]!.version),
  };
}

function attemptInput(f: { backend: string; version: string; model: string; template_version: string; binary: Binary; fixture_project: string | null }, helpSha256: string, hq: string | null): AttemptInput {
  return {
    backend: f.backend,
    version: f.version,
    binary_path: f.binary.path,
    binary_sha256: f.binary.sha256,
    help_sha256: helpSha256,
    template: TEMPLATES[f.backend]!.text,
    template_version: f.template_version,
    model: f.model,
    auth_mode: 'api_key',
    host_qualification: hq,
    profile_fingerprint: currentProfileFingerprint() ?? 'fixture-profile-1',
    fixture_project: f.fixture_project,
    candidate_egress: [],
    canary_deadlines: { positive: 600, cancellation: 600, containment: 600 },
    spend: { cap: null, estimate: 0, label: 'estimate', overshoot: 'bounded by the deadline' },
  };
}

const currentHq = (db: Database): string | null => (db.prepare(`SELECT "id" FROM "host_qualifications" WHERE "status" = 'active'`).get() as { id: string } | undefined)?.id ?? null;

// POST /v1/harness/fixtures/qualification-attempt (SEAM.md §116): one attempt
// in the status given. A proposed one raises its qualification_approval; an
// authorized one is the authority M101 (e) shows to be no bypass (K10).
export function installAttempt(db: Database, actor: Actor, args: { body: AttemptFixture; helpSha256: string }) {
  return transact(db, actor, (tx) => {
    tx.stamp = FIXTURE_LABEL;
    const input = attemptInput(args.body, args.helpSha256, currentHq(tx.db));
    if (args.body.status === 'proposed') return { qualification_attempt: { id: proposeAttempt(tx, input, FIXTURE_LABEL).attempt.id } };
    const attempt = writeAttempt(tx, input, FIXTURE_LABEL);
    tx.db.prepare('UPDATE "qualification_attempts" SET "status" = ? WHERE "id" = ?').run(args.body.status, attempt.id);
    return { qualification_attempt: { id: attempt.id } };
  });
}

export interface EntryFixture {
  status: 'proposed' | 'active' | 'revoked';
  binary: Binary;
  evidence: string[];
  boundaries: { boundary: unknown; mechanism: unknown; evidence: 'own' | null; overshoot: unknown }[];
  entry: Omit<EntryInput, 'host_qualification' | 'qualification_attempt' | 'evidence' | 'enforceable_boundaries' | 'host_id' | 'help_sha256' | 'binary_path' | 'binary_sha256'>;
}

const ENTRY_FIELDS = [
  'backend', 'status', 'binary', 'mode', 'version', 'model', 'template_version', 'capabilities', 'profile_fingerprint', 'egress_hosts', 'usage_granularity',
  'usage_semantics', 'cost_reporting', 'enforceable_boundaries', 'isolation', 'boundary', 'evidence',
];

export function parseEntryFixture(body: unknown): EntryFixture {
  const b = objectBody(body, ENTRY_FIELDS);
  const opt = (field: string, fallback: string) => (b[field] === undefined ? fallback : str(b, field));
  const backend = realBackend(b);
  const status = opt('status', 'proposed');
  if (status !== 'proposed' && status !== 'active' && status !== 'revoked') throw invalid('status', 'must be proposed, active or revoked');
  const mode = opt('mode', 'one_shot_headless');
  if (mode !== 'one_shot_headless' && mode !== 'session_headless') throw invalid('mode', 'must be one_shot_headless or session_headless');
  if (status === 'active' && mode === 'session_headless') throw invalid('mode', 'cannot be session_headless for an active entry: session mode is never active in M2 (D2 §1.8)');
  const isolation = opt('isolation', ISOLATION_MECHANISM);
  if (isolation !== ISOLATION_MECHANISM) throw invalid('isolation', `must be ${ISOLATION_MECHANISM}, the sandbox of D2 §2.2`);
  const boundary = opt('boundary', BOUNDARY_MECHANISM);
  if (boundary !== BOUNDARY_MECHANISM) throw invalid('boundary', `must be ${BOUNDARY_MECHANISM}, the boundary of D2 §3.1`);
  const given = b.enforceable_boundaries === undefined ? [{ boundary: 'invocation', mechanism: 'dispatch_check', overshoot: 'deadline' }] : b.enforceable_boundaries;
  if (!Array.isArray(given)) throw invalid('enforceable_boundaries', 'must be an array');
  const boundaries = given.map((x: unknown) => {
    const o = objectBody(x, ['boundary', 'mechanism', 'evidence', 'overshoot']);
    if (o.evidence !== undefined && o.evidence !== null) throw invalid('enforceable_boundaries', "each boundary's evidence is the fixture's own record, or null");
    if (o.boundary !== 'invocation' && (o.mechanism !== 'admission_control' || o.evidence === null)) {
      throw invalid('enforceable_boundaries', `${String(o.boundary)} is recorded only with admission_control and an evidence record (D2 §4.2)`);
    }
    return { boundary: o.boundary, mechanism: o.mechanism, evidence: o.evidence === null ? null : ('own' as const), overshoot: o.overshoot };
  });
  let evidence = ['qualification evidence written by the trust-entry fixture'];
  if (b.evidence !== undefined) {
    if (!Array.isArray(b.evidence) || b.evidence.length === 0) throw invalid('evidence', 'must be a non-empty array of {"kind", "content"}');
    evidence = b.evidence.map((e: unknown) => {
      const o = objectBody(e, ['kind', 'content']);
      if (o.kind !== 'qualification_evidence') throw invalid('evidence', 'records are of kind qualification_evidence');
      return str(o, 'content');
    });
  }
  const template = TEMPLATES[backend]!;
  return {
    status,
    binary: binaryOf(b),
    evidence,
    boundaries,
    entry: {
      backend,
      version: opt('version', '0.0.0-standin'),
      mode,
      template: template.text,
      template_version: opt('template_version', template.version),
      model: opt('model', 'standin-model'),
      auth_mode: 'api_key',
      capabilities: (b.capabilities as EntryInput['capabilities'] | undefined) ?? { tools: [], denied: [], features_disabled: [], delegation_verified: true },
      isolation,
      boundary,
      // The profile this host's checks qualified, when they ran (filled in
      // where the entry is written); a placeholder in the kernel lane.
      profile_fingerprint: opt('profile_fingerprint', ''),
      egress_hosts: b.egress_hosts === undefined ? [] : strings(b.egress_hosts, 'egress_hosts'),
      usage_granularity: opt('usage_granularity', 'model_call'),
      usage_semantics: b.usage_semantics === undefined ? 'cumulative' : b.usage_semantics === null ? null : str(b, 'usage_semantics'),
      cost_reporting: opt('cost_reporting', 'reported'),
      result_channel: 'file',
      session_qualified: false,
      provider_files: { locations: [], persistence_flags: [], excluded: [] },
      term_to_exit_ms: null,
    },
  };
}

// POST /v1/harness/fixtures/trust-entry (SEAM.md §116): an entry written
// proposed through the transition a succeeded attempt uses, with its
// trust_activation raised; then, for `active`, that decision answered as the
// human would, or, for `revoked`, the entry revoked. The attempt it names
// stands succeeded. The evidence records were published, engine-scoped,
// before this.
export function installTrustEntry(db: Database, actor: Actor, args: { body: EntryFixture; evidence: string[]; helpSha256: string }) {
  const host = hostIdentity();
  if (host === null) throw new Refusal(409, 'host_unidentified', 'The host identity cannot be read.', 'Check /etc/machine-id.', {});
  return transact(db, actor, (tx) => {
    tx.stamp = FIXTURE_LABEL;
    const f = args.body;
    const hq = currentHq(tx.db);
    const attempt = writeAttempt(
      tx,
      attemptInput({ backend: f.entry.backend, version: f.entry.version, model: f.entry.model, template_version: f.entry.template_version, binary: f.binary, fixture_project: null }, args.helpSha256, hq),
      FIXTURE_LABEL,
    );
    tx.db.prepare(`UPDATE "qualification_attempts" SET "status" = 'succeeded', "canaries" = ? WHERE "id" = ?`).run(
      JSON.stringify(['positive', 'cancellation', 'containment'].map((kind) => ({ kind, run: null, passed: true }))),
      attempt.id,
    );
    const input: EntryInput = {
      ...f.entry,
      profile_fingerprint:
        f.entry.profile_fingerprint !== ''
          ? f.entry.profile_fingerprint
          : (() => {
              const current = currentProfileFingerprint();
              return current === null ? 'fixture-profile-1' : profileWithEgress(current, f.entry.egress_hosts);
            })(),
      binary_path: f.binary.path,
      binary_sha256: f.binary.sha256,
      help_sha256: args.helpSha256,
      host_id: host,
      host_qualification: hq,
      qualification_attempt: attempt.id,
      evidence: args.evidence,
      enforceable_boundaries: f.boundaries.map((x) => ({ boundary: x.boundary as string, mechanism: x.mechanism as string, evidence: x.evidence === null ? (null as unknown as string) : args.evidence[0]!, overshoot: x.overshoot })),
    };
    const { entry, decision } = proposeEntry(tx, input, FIXTURE_LABEL);
    tx.db.prepare(`UPDATE "qualification_attempts" SET "trust_entry" = ? WHERE "id" = ?`).run(entry.id, attempt.id);
    if (f.status === 'active') {
      if (decision === null) throw invalid('status', 'cannot be active: this entry can never be activated (its usage is not reported)');
      const d = tx.db.prepare('SELECT * FROM "decisions" WHERE "id" = ?').get(decision) as DecisionRow & { preview_hash: string };
      answerQueued(tx, { project: null, decision, option: 'approve', preview_hash: d.preview_hash, note: 'test fixture', facts: {} });
    }
    if (f.status === 'revoked') revokeEntry(tx, entry, 'test_fixture', FIXTURE_LABEL);
    const row = getEntry(tx.db, entry.id)!;
    return {
      trust_entry: { id: row.id, status: row.status },
      qualification_attempt: { id: attempt.id },
      evidence: args.evidence,
      decision: f.status === 'proposed' ? decision : null,
    };
  });
}
