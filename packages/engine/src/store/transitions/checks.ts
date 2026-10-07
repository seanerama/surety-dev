// Checks, the store's side (D3 §§1.4, 2.5 to 2.7, A.3, A.5 to A.7; L1, L2, L7;
// SEAM.md §§177 to 185): a version's discovered checks and errors, written
// from what the main thread read of a tree; the requirement index's criteria
// against them; the registration of check executions from the project's one
// sequence, in the trigger's own transaction; the operator route; and the
// reads of a version and of a candidate's executions. The life of one
// execution (admission, its domain, its launch, its result) is
// check-executions.ts.

import type { Discovery } from '../../checks/discovery.js';
import { type DiscoveryError, criterionErrors, requirementKeyOf } from '../../checks/schema.js';
import { Refusal } from '../../refusal.js';
import { barrier } from '../../testing/seam.js';
import { notFound } from './common.js';
import { type CandidateRow, type CheckRow, getCandidate, markStale, requiredSet, unreadAncestry } from './evidence.js';
import { heldByAncestry } from './gates.js';
import { effectiveVersion } from './protected.js';
import { insertExecutionResult } from './baseline.js';
import { envelopeHold } from './envelope.js';
import { engineSettings, projectPolicy } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export interface Trigger {
  source: 'nomination' | 'protected_application' | 'operator_request' | 'recovery' | 'deployment_verification';
  id: string;
  generation: number;
}

// ---- a version's discovery -----------------------------------------------------------

// The criteria of the registered requirement index, or null when no index
// is registered (D3 §4.5: until spec approval, the plan fixture's).
export function knownCriteria(db: Db, project: string): Set<string> | null {
  const rows = db.prepare('SELECT "criteria" FROM "requirements" WHERE "project" = ? AND "criteria" IS NOT NULL').all(project) as { criteria: string }[];
  if (rows.length === 0) return null;
  return new Set(rows.flatMap((r) => JSON.parse(r.criteria) as string[]));
}

function requirementIdsOf(db: Db, project: string, criteria: string[]): string[] {
  const ids: string[] = [];
  for (const key of [...new Set(criteria.map(requirementKeyOf))]) {
    const row = db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? AND "key" = ?').get(project, key) as { id: string } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

// The discovered checks of a version written as its `checks` rows, with its
// governed values and its errors (D3 §1.4, A.3). Written once per version.
export function writeVersionDiscovery(tx: Tx, args: { project: string; version: string; discovery: Discovery }): void {
  const { project, version, discovery } = args;
  const v = tx.db.prepare('SELECT "check_ids", "governed" FROM "protected_versions" WHERE "id" = ?').get(version) as { check_ids: string; governed: string | null } | undefined;
  if (!v) throw notFound('protected version', version);
  if (v.governed !== null) return;
  const ids = JSON.parse(v.check_ids) as string[];
  const insert = tx.db.prepare(
    `INSERT INTO "checks" ("id", "created_at", "project", "key", "protected_version", "kind", "required", "gate_kinds", "tier_floor", "definition_path", "definition_hash",
       "requirement_ids", "sensitive_areas", "phase", "runner_class", "requires", "origin", "criteria", "definition", "input_manifest")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of discovery.checks) {
    if (tx.db.prepare('SELECT 1 FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(version, c.key)) continue;
    const id = tx.newId('chk_');
    const d = c.definition;
    insert.run(
      id,
      tx.at,
      project,
      c.key,
      version,
      d.kind,
      c.required ? 1 : 0,
      JSON.stringify(d.gate_kinds),
      d.tier_floor ?? null,
      c.path,
      c.fingerprint,
      JSON.stringify(requirementIdsOf(tx.db, project, c.criteria)),
      JSON.stringify(d.covers?.sensitive_areas ?? []),
      d.phase ?? null,
      d.runner_class,
      JSON.stringify(d.requires),
      d.origin,
      JSON.stringify(c.criteria),
      JSON.stringify(d),
      JSON.stringify(c.input_manifest),
    );
    ids.push(id);
  }
  const errors = [...discovery.errors, ...criterionErrors(discovery.checks, knownCriteria(tx.db, project))];
  tx.db
    .prepare('UPDATE "protected_versions" SET "check_ids" = ?, "governed" = ?, "discovery_errors" = ? WHERE "id" = ?')
    .run(JSON.stringify(ids), JSON.stringify(discovery.governed), JSON.stringify(errors), version);
}

// The spec revision changed (the requirement index was registered): the
// errors of every version not superseded are recomputed against it, and the
// requirements its checks cover are named again (D3 §1.4; SEAM.md §177).
export function recomputeIndexErrors(tx: Tx, project: string): void {
  const known = knownCriteria(tx.db, project);
  const versions = tx.db.prepare('SELECT "id", "discovery_errors" FROM "protected_versions" WHERE "project" = ? AND "superseded_by" IS NULL').all(project) as {
    id: string;
    discovery_errors: string;
  }[];
  for (const v of versions) {
    const checks = tx.db.prepare('SELECT "id", "definition_path", "criteria" FROM "checks" WHERE "protected_version" = ?').all(v.id) as {
      id: string;
      definition_path: string;
      criteria: string;
    }[];
    const paths = new Set(checks.map((c) => c.definition_path));
    const kept = (JSON.parse(v.discovery_errors) as DiscoveryError[]).filter((e) => e.code !== 'criterion_unknown' || !paths.has(e.path.split('#')[0]!));
    const fresh = criterionErrors(
      checks.map((c) => ({ path: c.definition_path, criteria: JSON.parse(c.criteria) as string[] })),
      known,
    );
    tx.db.prepare('UPDATE "protected_versions" SET "discovery_errors" = ? WHERE "id" = ?').run(JSON.stringify([...kept, ...fresh]), v.id);
    for (const c of checks) {
      const criteria = JSON.parse(c.criteria) as string[];
      if (criteria.length > 0) tx.db.prepare('UPDATE "checks" SET "requirement_ids" = ? WHERE "id" = ?').run(JSON.stringify(requirementIdsOf(tx.db, project, criteria)), c.id);
    }
  }
  markStale(tx, { project });
}

export const discoveryErrorsOf = (db: Db, version: string): DiscoveryError[] => {
  const row = db.prepare('SELECT "discovery_errors" FROM "protected_versions" WHERE "id" = ?').get(version) as { discovery_errors: string } | undefined;
  return row ? (JSON.parse(row.discovery_errors) as DiscoveryError[]) : [];
};

// What classification froze of a proposal: the discovery of its tree (D3
// §1.4). The class itself is set elsewhere (the fixture, until slice 19).
export function freezeProposalDiscovery(tx: Tx, args: { proposal: string; discovery: Discovery }): void {
  const p = tx.db.prepare('SELECT "classification" FROM "protected_proposals" WHERE "id" = ?').get(args.proposal) as { classification: string | null } | undefined;
  if (!p) throw notFound('proposal', args.proposal);
  const prior = p.classification === null ? {} : (JSON.parse(p.classification) as Record<string, unknown>);
  tx.db.prepare('UPDATE "protected_proposals" SET "classification" = ? WHERE "id" = ?').run(JSON.stringify({ ...prior, discovery: args.discovery }), args.proposal);
}

export function proposalDiscovery(db: Db, proposal: string): Discovery | null {
  const p = db.prepare('SELECT "classification" FROM "protected_proposals" WHERE "id" = ?').get(proposal) as { classification: string | null } | undefined;
  if (!p?.classification) return null;
  return ((JSON.parse(p.classification) as { discovery?: Discovery }).discovery ?? null) as Discovery | null;
}

// Does the proposal's frozen discovery have errors (L5)? The criteria are
// judged against the index as registered now.
export function proposalHasErrors(db: Db, project: string, proposal: string): boolean {
  const d = proposalDiscovery(db, proposal);
  if (d === null) return false;
  return d.errors.length > 0 || criterionErrors(d.checks, knownCriteria(db, project)).length > 0;
}

// ---- registration (D3 §2.5; L2, L7) ----------------------------------------------------

// The project's one sequence (L7): registrations and fixture results draw
// from it, so the two never collide and nothing derives a sequence from
// the results recorded.
export function nextExecutionSeq(tx: Tx, project: string): number {
  const row = tx.db.prepare('SELECT "seq_counters" FROM "projects" WHERE "id" = ?').get(project) as { seq_counters: string } | undefined;
  if (!row) throw notFound('project', project);
  const counters = JSON.parse(row.seq_counters) as Record<string, number>;
  const { a } = tx.db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) AS a FROM "check_results" WHERE "project" = ?').get(project) as { a: number };
  const { b } = tx.db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) AS b FROM "check_executions" WHERE "project" = ?').get(project) as { b: number };
  const next = Math.max((counters.executions ?? 0) + 1, a + 1, b + 1);
  counters.executions = next;
  tx.db.prepare('UPDATE "projects" SET "seq_counters" = ? WHERE "id" = ?').run(JSON.stringify(counters), project);
  return next;
}

// One registration per candidate, trigger identity and key (D3 §2.5): a
// protected application's trigger registers for every candidate.
const triggerKey = (t: Trigger, key: string, candidate = ''): string => `${candidate}|${t.source}|${t.id}|${t.generation}|${key}`;

// The stages whose work a candidate holds, by ancestry (E43).
function stagesHeld(db: Db, candidate: CandidateRow): string[] {
  const out: string[] = [];
  for (const w of heldByAncestry(db, candidate)) {
    const item = db.prepare('SELECT "kind", "subject" FROM "work_items" WHERE "id" = ?').get(w) as { kind: string; subject: string } | undefined;
    if (item?.kind !== 'stage_build') continue;
    const stage = (JSON.parse(item.subject) as { stage?: string }).stage;
    if (stage && !out.includes(stage)) out.push(stage);
  }
  return out;
}

// The checks a candidate's trigger registers under `version`: the union of
// the required sets of the `stage` gates of the stages it holds and of its
// `alpha_authorize` gate (D3 §2.5), each once, in key order. `unread`: a
// fact the sets need has not been read, so nothing is registered yet.
export function registrationSet(db: Db, project: string, candidate: CandidateRow, version: string): { checks: CheckRow[]; unread: boolean } {
  if (unreadAncestry(db, project, candidate)) return { checks: [], unread: true };
  const byId = new Map<string, CheckRow>();
  for (const stage of stagesHeld(db, candidate)) for (const c of requiredSet(db, { project, candidate, kind: 'stage', stage, version }).required) byId.set(c.id, c);
  for (const c of requiredSet(db, { project, candidate, kind: 'alpha_authorize', stage: null, version }).required) byId.set(c.id, c);
  return { checks: [...byId.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), unread: false };
}

// Register one execution per check for the trigger, in this transaction;
// a trigger identity already registered registers nothing (D3 §2.5).
// Returns the executions, those registered before included.
export function registerExecutions(tx: Tx, args: { project: string; candidate: CandidateRow; checks: CheckRow[]; trigger: Trigger }): { id: string; check: string; key: string; created: boolean }[] {
  const out: { id: string; check: string; key: string; created: boolean }[] = [];
  for (const c of args.checks) {
    const tk = triggerKey(args.trigger, c.key, args.candidate.id);
    const existing = tx.db.prepare('SELECT "id", "check", "key" FROM "check_executions" WHERE "project" = ? AND "trigger_key" = ?').get(args.project, tk) as
      | { id: string; check: string; key: string }
      | undefined;
    if (existing) {
      out.push({ ...existing, created: false });
      continue;
    }
    const id = tx.newId('cx_');
    const seq = nextExecutionSeq(tx, args.project);
    tx.db
      .prepare(
        `INSERT INTO "check_executions" ("id", "created_at", "project", "check", "key", "candidate", "source_revision", "protected_version", "runner_class", "execution_seq",
           "trigger", "trigger_key", "status", "registered_at")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(id, tx.at, args.project, c.id, c.key, args.candidate.id, args.candidate.revision, c.protected_version, c.runner_class, seq, JSON.stringify(args.trigger), tk, tx.at);
    tx.emit('check.registered', { project: args.project, candidate: args.candidate.id, check_execution: id }, { key: c.key, trigger: args.trigger, execution_seq: seq, check: c.id });
    out.push({ id, check: c.id, key: c.key, created: true });
  }
  if (out.some((x) => x.created)) {
    // Registration stales the candidate's evaluations in this transition
    // (L7); a test may stop the transaction here (SEAM.md §184).
    markStale(tx, { candidate: args.candidate.id });
    barrier('checks.registered');
  }
  return out;
}

// A trigger's registration for a candidate, or, while a fact its sets need
// is unread, the candidate's `checks_due` (L2): Gates treat the owed checks
// as missing until the Checks step registers them.
export function registerForTrigger(tx: Tx, args: { project: string; candidate: string; version: string; trigger: Trigger }): void {
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate) throw notFound('candidate', args.candidate);
  const set = registrationSet(tx.db, args.project, candidate, args.version);
  if (set.unread) {
    const due = candidate as CandidateRow & { checks_due?: string | null };
    const list = due.checks_due ? (JSON.parse(due.checks_due) as { trigger: Trigger; version: string; at: string }[]) : [];
    if (!list.some((d) => triggerKey(d.trigger, '') === triggerKey(args.trigger, ''))) list.push({ trigger: args.trigger, version: args.version, at: tx.at });
    tx.db.prepare('UPDATE "candidates" SET "checks_due" = ? WHERE "id" = ?').run(JSON.stringify(list), candidate.id);
    markStale(tx, { candidate: candidate.id });
    return;
  }
  registerExecutions(tx, { project: args.project, candidate, checks: set.checks, trigger: args.trigger });
}

// The Checks step's half of L2: every due registration whose facts are now
// read is made, and the due mark cleared in the same transaction.
export function registerDue(tx: Tx, args: { project: string }): number {
  const rows = tx.db.prepare('SELECT "id", "checks_due" FROM "candidates" WHERE "project" = ? AND "checks_due" IS NOT NULL').all(args.project) as { id: string; checks_due: string }[];
  let made = 0;
  for (const r of rows) {
    const candidate = getCandidate(tx.db, r.id)!;
    if (unreadAncestry(tx.db, args.project, candidate)) continue;
    // Under the version effective now: one stored with the due mark may
    // since have been superseded.
    const effective = effectiveVersion(tx.db, args.project);
    if (!effective) continue;
    for (const d of JSON.parse(r.checks_due) as { trigger: Trigger }[]) {
      const set = registrationSet(tx.db, args.project, candidate, effective.id);
      made += registerExecutions(tx, { project: args.project, candidate, checks: set.checks, trigger: d.trigger }).filter((x) => x.created).length;
    }
    tx.db.prepare('UPDATE "candidates" SET "checks_due" = NULL WHERE "id" = ?').run(r.id);
  }
  return made;
}

// The nomination's trigger (D3 §2.5), from its finalizer.
export function registerAtNomination(tx: Tx, args: { project: string; candidate: string }): void {
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) return;
  registerForTrigger(tx, { project: args.project, candidate: args.candidate, version: effective.id, trigger: { source: 'nomination', id: args.candidate, generation: 1 } });
}

// A protected application's trigger (D3 §2.5, §3.5), from the finalizer
// that makes the new version effective and invalidates the old results:
// the new version's checks for every candidate with no successor.
export function registerAtApplication(tx: Tx, args: { project: string; proposal: string; version: string }): void {
  const candidates = tx.db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq"').all(args.project) as { id: string }[];
  for (const c of candidates) registerForTrigger(tx, { project: args.project, candidate: c.id, version: args.version, trigger: { source: 'protected_application', id: args.proposal, generation: 1 } });
}

// POST /v1/projects/:p/candidates/:c/checks (D3 A.7; SEAM.md §180).
export function requestChecks(tx: Tx, args: { project: string; candidate: string; body: unknown }): { status: number; body: unknown } {
  const candidate = getCandidate(tx.db, args.candidate);
  if (!candidate || candidate.project !== args.project) throw notFound('candidate', args.candidate);
  const b = args.body === undefined || args.body === null ? {} : args.body;
  if (typeof b !== 'object' || Array.isArray(b)) throw new Refusal(400, 'invalid_value', 'The body must be a JSON object.', 'Send {"keys"?: [<key>], "request_key"?: <string>}.', { field: null });
  const body = b as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (k !== 'keys' && k !== 'request_key') throw new Refusal(400, 'unknown_field', `"${k}" is not a field of a check request.`, 'Send keys and request_key only.', { field: k });
  }
  if (body.request_key !== undefined && (typeof body.request_key !== 'string' || body.request_key.length === 0 || body.request_key.length > 200)) {
    throw new Refusal(400, 'invalid_value', '"request_key" must be a non-empty string.', 'Send a short string that names this request.', { field: 'request_key' });
  }
  if (body.keys !== undefined && (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.some((k) => typeof k !== 'string'))) {
    throw new Refusal(400, 'invalid_value', '"keys" must be a non-empty array of check keys.', 'Name required checks of the candidate.', { field: 'keys' });
  }
  const effective = effectiveVersion(tx.db, args.project);
  if (!effective) throw new Refusal(409, 'illegal_transition', 'The project has no effective protected version.', 'Nothing was registered.', { project: args.project });
  const set = registrationSet(tx.db, args.project, candidate, effective.id);
  if (set.unread) throw new Refusal(409, 'illegal_transition', 'The candidate\'s required checks cannot be told yet: a fact they need has not been read from git.', 'Ask again after the next tick.', { candidate: candidate.id });
  const keys = body.keys as string[] | undefined;
  for (const k of keys ?? []) {
    if (!set.checks.some((c) => c.key === k)) throw new Refusal(400, 'invalid_value', `"${k}" is not a required check of candidate ${candidate.id}.`, 'Name required checks of the candidate.', { field: 'keys' });
  }
  const checks = keys === undefined ? set.checks : set.checks.filter((c) => keys.includes(c.key));
  const id = body.request_key === undefined ? tx.newId('opreq_') : `request:${candidate.id}:${body.request_key as string}`;
  if (body.request_key !== undefined) {
    const earlier = tx.db
      .prepare(`SELECT "id", "check", "key" FROM "check_executions" WHERE "candidate" = ? AND json_extract("trigger", '$.source') = 'operator_request' AND json_extract("trigger", '$.id') = ? ORDER BY "execution_seq"`)
      .all(candidate.id, id) as { id: string; check: string; key: string }[];
    if (earlier.length > 0) return { status: 200, body: { executions: earlier } };
  }
  const made = registerExecutions(tx, { project: args.project, candidate, checks, trigger: { source: 'operator_request', id, generation: 1 } });
  return { status: 202, body: { executions: made.map(({ id: x, check, key }) => ({ id: x, check, key })) } };
}

// ---- reads (SEAM.md §§178, 180) ---------------------------------------------------------

const envelope = (db: Db) => ({
  served_at: new Date().toISOString(),
  snapshot_seq: (db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get() as { n: number }).n,
});

// GET /v1/projects/:p/protected-versions/:v
export function readVersion(db: Db, args: { project: string; version: string }) {
  const head = envelope(db);
  const v = db.prepare('SELECT * FROM "protected_versions" WHERE "id" = ?').get(args.version) as Record<string, unknown> | undefined;
  if (!v || v.project !== args.project) throw notFound('protected version', args.version);
  const checks = db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? ORDER BY "key", "id"').all(args.version) as Record<string, unknown>[];
  return {
    ...head,
    version: {
      id: v.id,
      seq: v.seq,
      fingerprint: v.fingerprint,
      change_kind: v.change_kind,
      governed: v.governed === null ? null : JSON.parse(v.governed as string),
      discovery_errors: JSON.parse(v.discovery_errors as string),
      checks: checks.map((c) => ({
        id: c.id,
        key: c.key,
        required: c.required === 1,
        kind: c.kind,
        origin: c.origin,
        definition_path: c.definition_path,
        definition: JSON.parse(c.definition as string),
        input_manifest: JSON.parse(c.input_manifest as string),
        definition_hash: c.definition_hash,
      })),
    },
  };
}

export function executionView(row: Record<string, unknown>) {
  return {
    id: row.id,
    check: row.check,
    key: row.key,
    candidate: row.candidate,
    execution_seq: row.execution_seq,
    status: row.status,
    trigger: JSON.parse(row.trigger as string),
    source_revision: row.source_revision,
    protected_version: row.protected_version,
    runner_class: row.runner_class,
    not_run_reason: row.not_run_reason ?? null,
    toolchain: row.toolchain === null ? null : JSON.parse(row.toolchain as string),
    runner_id: row.runner_id ?? null,
    runner_qualification: row.runner_qualification ?? null,
    domain: row.domain ?? null,
    result: row.result ?? null,
    init_reports: JSON.parse(row.init_reports as string),
    registered_at: row.registered_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

// GET /v1/projects/:p/candidates/:c/checks
export function readCandidateExecutions(db: Db, args: { project: string; candidate: string }) {
  const head = envelope(db);
  const c = db.prepare('SELECT "project" FROM "candidates" WHERE "id" = ?').get(args.candidate) as { project: string } | undefined;
  if (!c || c.project !== args.project) throw notFound('candidate', args.candidate);
  const rows = db.prepare('SELECT * FROM "check_executions" WHERE "candidate" = ? ORDER BY "execution_seq"').all(args.candidate) as Record<string, unknown>[];
  return { ...head, executions: rows.map(executionView) };
}

// ---- the runner's qualification (D3 §2.8; A.3 host_qualifications.check_runner) --------

export interface CheckRunnerState {
  profile_fingerprint: string;
  self_test: { case: string; control: string; result: string }[];
  qualified: boolean;
  [label: string]: unknown;
}

// The active host qualification and its runner state, or null without one.
export function runnerQualification(db: Db): { id: string; check_runner: CheckRunnerState | null } | null {
  const row = db.prepare(`SELECT "id", "check_runner" FROM "host_qualifications" WHERE "status" = 'active'`).get() as { id: string; check_runner: string | null } | undefined;
  if (!row) return null;
  return { id: row.id, check_runner: row.check_runner === null ? null : (JSON.parse(row.check_runner) as CheckRunnerState) };
}

// Record the runner's state on the active host qualification. Returns its
// id, or null when there is none (the runner cannot be qualified then).
export function setCheckRunner(tx: Tx, state: CheckRunnerState): string | null {
  const q = runnerQualification(tx.db);
  if (q === null) return null;
  tx.db.prepare('UPDATE "host_qualifications" SET "check_runner" = ? WHERE "id" = ?').run(JSON.stringify(state), q.id);
  return q.id;
}

// ---- one execution's life (D3 §§2.5 to 2.7, A.5; L1) ---------------------------------------

const LIVE = ['materializing', 'running', 'collecting', 'quarantined'];

export interface Admission {
  execution: string;
  project: string;
  candidate: string;
  revision: string;
  version: string;
  key: string;
  definition: Record<string, unknown>;
  manifest: [string, string, string, string][];
  manifests: [string, string, string, string][][];
  governed: Record<string, unknown> | null;
  roots: string[];
  repo: string;
  domain: string;
  cgroup_path: string;
  lease_generation: number;
  runner_id: string;
  runner_qualification: string;
  execution_seq: number;
}

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

// The Checks tick step's admission (D3 §2.5; L1, L2): the oldest queued
// `direct` execution of the project, when the runner is qualified on this
// host now, the project runs fewer than `max_concurrent_checks`, and the
// resource envelope admits a domain. Its domain is allocated, owned by this
// incarnation, and it holds a lease of kind `check`. null: nothing admitted.
export function admitExecution(
  tx: Tx,
  args: { project: string; incarnation: string; scope: string; hostId: string },
): Admission | null {
  const q = runnerQualification(tx.db);
  if (q === null || q.check_runner === null || q.check_runner.qualified !== true) return null;
  const { n } = tx.db.prepare(`SELECT COUNT(*) AS n FROM "check_executions" WHERE "project" = ? AND "status" IN (${LIVE.map(() => '?').join(', ')})`).get(args.project, ...LIVE) as { n: number };
  const max = projectPolicy(tx.db, args.project).max_concurrent_checks ?? 1;
  if (n >= max || envelopeHold(tx.db) !== null) return null;
  const x = tx.db
    .prepare(`SELECT * FROM "check_executions" WHERE "project" = ? AND "status" = 'queued' AND "runner_class" = 'direct' ORDER BY "execution_seq" LIMIT 1`)
    .get(args.project) as Record<string, unknown> | undefined;
  if (!x) return null;
  const check = tx.db.prepare('SELECT * FROM "checks" WHERE "id" = ?').get(x.check) as { key: string; definition: string; input_manifest: string };
  const version = tx.db.prepare('SELECT "roots", "governed" FROM "protected_versions" WHERE "id" = ?').get(x.protected_version) as { roots: string; governed: string | null };
  const manifests = (tx.db.prepare('SELECT "input_manifest" FROM "checks" WHERE "protected_version" = ?').all(x.protected_version) as { input_manifest: string }[]).map(
    (r) => JSON.parse(r.input_manifest) as [string, string, string, string][],
  );
  const repo = (tx.db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string }).dev_repo_path;
  const domain = tx.newId('dom_');
  const cgroup = `${args.scope}/${domain}`;
  tx.db
    .prepare(
      `INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "check_execution", "status", "profile", "cgroup_path", "launch_state")
       VALUES (?, ?, ?, NULL, NULL, ?, 'allocated', 'check', ?, 'authorizable')`,
    )
    .run(domain, tx.at, args.project, x.id, cgroup);
  tx.db
    .prepare(`INSERT INTO "process_ownership" ("id", "created_at", "project", "domain", "invocation", "check_execution", "incarnation") VALUES (?, ?, ?, ?, NULL, ?, ?)`)
    .run(tx.newId('proc_'), tx.at, args.project, domain, x.id, args.incarnation);
  const lease = tx.newId('lease_');
  tx.db
    .prepare(
      `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "closing", "cleanup_authority")
       VALUES (?, ?, 'check', ?, ?, 1, ?, ?, ?, 0, 0)`,
    )
    .run(lease, tx.at, x.id, args.incarnation, tx.at, tx.at, addSeconds(tx.at, engineSettings().lease_ttl));
  const runner = `direct@${args.hostId}/${q.check_runner.profile_fingerprint.slice(0, 12)}`;
  tx.db
    .prepare(`UPDATE "check_executions" SET "status" = 'materializing', "domain" = ?, "lease" = ?, "runner_id" = ?, "runner_qualification" = ? WHERE "id" = ?`)
    .run(domain, lease, runner, q.id, x.id);
  return {
    execution: x.id as string,
    project: args.project,
    candidate: x.candidate as string,
    revision: x.source_revision as string,
    version: x.protected_version as string,
    key: check.key,
    definition: JSON.parse(check.definition) as Record<string, unknown>,
    manifest: JSON.parse(check.input_manifest) as [string, string, string, string][],
    manifests,
    governed: version.governed === null ? null : (JSON.parse(version.governed) as Record<string, unknown>),
    roots: JSON.parse(version.roots) as string[],
    repo,
    domain,
    cgroup_path: cgroup,
    lease_generation: 1,
    runner_id: runner,
    runner_qualification: q.id,
    execution_seq: x.execution_seq as number,
  };
}

interface ExecutionRow {
  id: string;
  project: string;
  candidate: string;
  status: string;
  domain: string | null;
  lease: string | null;
  init_reports: string;
}

const mustExecution = (db: Db, id: string): ExecutionRow => {
  const x = db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(id) as ExecutionRow | undefined;
  if (!x) throw notFound('check execution', id);
  return x;
};

// Is the execution's check lease current for this incarnation and generation?
export function checkLeaseCurrent(db: Db, args: { execution: string; incarnation: string; generation: number; at: string }): boolean {
  const lease = db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'check' AND "resource_id" = ? AND "released_at" IS NULL`).get(args.execution) as
    | { generation: number; closing: number; expires_at: string; owner_incarnation: string }
    | undefined;
  return lease !== undefined && lease.closing === 0 && lease.expires_at > args.at && lease.generation === args.generation && lease.owner_incarnation === args.incarnation;
}

// Renewed while supervised (D3 §2.5); never extends `timeout_s`.
export function renewCheckLease(tx: Tx, args: { execution: string; generation: number; incarnation: string }): boolean {
  if (!checkLeaseCurrent(tx.db, { ...args, at: tx.at })) return false;
  tx.db
    .prepare(`UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "resource_kind" = 'check' AND "resource_id" = ? AND "released_at" IS NULL`)
    .run(tx.at, addSeconds(tx.at, engineSettings().lease_ttl), args.execution);
  return true;
}

function releaseCheckLease(tx: Tx, execution: string): void {
  tx.db.prepare(`UPDATE "leases" SET "released_at" = ? WHERE "resource_kind" = 'check' AND "resource_id" = ? AND "released_at" IS NULL`).run(tx.at, execution);
}

// The launch was authorized (boundary.ts, in the same transaction): the
// execution is running in its domain.
export function markLaunched(tx: Tx, args: { execution: string; domain: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (x.status !== 'materializing') return;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'running' WHERE "id" = ?`).run(x.id);
  tx.emit('check.launched', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: args.domain }, {});
}

// One of the init's reports (A.2 InitReport), as the engine received it on
// the init's channel, never from anything check code wrote.
export function recordInitReport(tx: Tx, args: { execution: string; kind: 'started' | 'exec_failed' | 'exit' | 'orphans'; detail: Record<string, unknown> | null }): void {
  const x = mustExecution(tx.db, args.execution);
  const reports = JSON.parse(x.init_reports) as { kind: string; at: string; detail: unknown }[];
  reports.push({ kind: args.kind, at: tx.at, detail: args.detail });
  tx.db.prepare('UPDATE "check_executions" SET "init_reports" = ? WHERE "id" = ?').run(JSON.stringify(reports), x.id);
  if (args.kind === 'started') tx.db.prepare('UPDATE "check_executions" SET "started_at" = ? WHERE "id" = ? AND "started_at" IS NULL').run(tx.at, x.id);
}

// The program the execution runs, as resolved at launch (D3 §§1.1, 2.5, Q6).
export function recordToolchain(tx: Tx, args: { execution: string; toolchain: { name: string; path: string; sha256: string | null } }): void {
  tx.db.prepare('UPDATE "check_executions" SET "toolchain" = ? WHERE "id" = ?').run(JSON.stringify(args.toolchain), args.execution);
}

export function markCollecting(tx: Tx, args: { execution: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (x.status === 'running' || x.status === 'quarantined' || x.status === 'materializing') tx.db.prepare(`UPDATE "check_executions" SET "status" = 'collecting' WHERE "id" = ?`).run(x.id);
}

// Termination unknown (D2 §3.4): nothing collected, no row; the check is
// missing meanwhile and the gate read names the execution (D3 §2.6).
export function quarantineExecution(tx: Tx, args: { execution: string; why: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (x.status === 'quarantined' || !LIVE.includes(x.status)) return;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'quarantined' WHERE "id" = ?`).run(x.id);
  tx.emit('check.quarantined', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: x.domain }, { from: x.status, why: args.why });
  markStale(tx, { candidate: x.candidate });
}

// Ended with no row (D3 §2.6): its domain's closure observed, and nothing
// established about the check's own process.
export function interruptExecution(tx: Tx, args: { execution: string; why: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (!LIVE.includes(x.status)) return;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'interrupted', "finished_at" = ? WHERE "id" = ?`).run(tx.at, x.id);
  releaseCheckLease(tx, x.id);
  tx.emit('check.interrupted', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: x.domain }, { from: x.status, why: args.why });
  markStale(tx, { candidate: x.candidate });
}

export interface ResultFields {
  execution: string;
  established: boolean;
  exit_status: number | null;
  signaled: boolean;
  deadline_hit: boolean;
  // null: unknown (unreported or unreadable), which never passes (L4).
  orphans: boolean | null;
  not_run_reason: string | null;
  output: string | null;
  output_dropped_bytes: number | null;
}

// The result row of an execution (D3 §§2.6, 2.7, A.3), once its domain's
// termination with closure is observed (or, for a known not-run, its domain
// closed with nothing launched). Recorded once.
export function recordExecutionResult(tx: Tx, args: ResultFields): { check_result: string } | null {
  const x = tx.db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(args.execution) as Record<string, unknown> | undefined;
  if (!x) throw notFound('check execution', args.execution);
  if (x.status === 'recorded' && typeof x.result === 'string') return { check_result: x.result };
  if (!LIVE.includes(x.status as string)) return null;
  const id = insertExecutionResult(tx, {
    project: x.project as string,
    check: x.check as string,
    candidate: x.candidate as string,
    source_revision: x.source_revision as string,
    protected_version: x.protected_version as string,
    runner_class: x.runner_class as string,
    runner_id: (x.runner_id as string | null) ?? 'direct',
    runner_qualification: (x.runner_qualification as string | null) ?? null,
    execution_seq: x.execution_seq as number,
    started_at: (x.started_at as string | null) ?? null,
    finished_at: tx.at,
    ...args,
  });
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'recorded', "result" = ?, "not_run_reason" = ?, "finished_at" = ? WHERE "id" = ?`).run(id, args.not_run_reason, tx.at, args.execution);
  releaseCheckLease(tx, args.execution);
  return { check_result: id };
}

// Is a check tree still referenced (D3 §2.4)? By any execution of its
// triple not yet terminal, and, while its version is in effect, by a
// candidate at its revision that has no successor: an operator's or a
// recovery's registration of that candidate runs on the same tree.
export function treeInUse(db: Db, args: { project: string; revision: string; version: string; except: string }): boolean {
  const live = db
    .prepare(
      `SELECT 1 FROM "check_executions" WHERE "project" = ? AND "source_revision" = ? AND "protected_version" = ? AND "id" <> ?
       AND "status" IN ('queued', 'materializing', 'running', 'collecting', 'quarantined') LIMIT 1`,
    )
    .get(args.project, args.revision, args.version, args.except);
  if (live !== undefined) return true;
  const current = db.prepare('SELECT 1 FROM "protected_versions" WHERE "id" = ? AND "superseded_by" IS NULL').get(args.version);
  const candidate = db.prepare('SELECT 1 FROM "candidates" WHERE "project" = ? AND "revision" = ? AND "superseded_by" IS NULL').get(args.project, args.revision);
  return current !== undefined && candidate !== undefined;
}

// Executions this incarnation must account for at start (D3 §2.6, T07):
// every one past `queued` and not terminal.
export function liveExecutions(db: Db): { id: string; project: string; status: string; domain: string | null; source_revision: string; protected_version: string }[] {
  return db
    .prepare(`SELECT "id", "project", "status", "domain", "source_revision", "protected_version" FROM "check_executions" WHERE "status" IN (${LIVE.map(() => '?').join(', ')}) ORDER BY "execution_seq"`)
    .all(...LIVE) as { id: string; project: string; status: string; domain: string | null; source_revision: string; protected_version: string }[];
}
