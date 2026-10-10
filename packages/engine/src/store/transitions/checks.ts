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
import { type CandidateRow, type CheckRow, candidateContent, getCandidate, markStale } from './evidence.js';
import { effectiveVersion } from './protected.js';
import { insertExecutionResult } from './baseline.js';
import { checkLimits } from '../../checks/limits.js';
import { raiseFinding } from './findings.js';
import { quarantineDomain } from './runs.js';
import { envelopeHold } from './envelope.js';
import { engineSettings, projectPolicy } from './settings.js';
import type { Tx } from './tx.js';
import { reconcileRepairs } from './repair.js';

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
  const next = executionSeqHigh(tx.db, project) + 1;
  counters.executions = next;
  tx.db.prepare('UPDATE "projects" SET "seq_counters" = ? WHERE "id" = ?').run(JSON.stringify(counters), project);
  return next;
}

// The highest number the project's one sequence has given (L7): to a
// registration, to a fixture result, or kept in the counter. A `fix`
// disposition takes it as its watermark (D3 §2.11; T06), so an execution
// registered before the disposition never counts as after it, however late
// its result is recorded.
export function executionSeqHigh(db: Db, project: string): number {
  const row = db.prepare('SELECT "seq_counters" FROM "projects" WHERE "id" = ?').get(project) as { seq_counters: string } | undefined;
  if (!row) throw notFound('project', project);
  const counters = JSON.parse(row.seq_counters) as Record<string, number>;
  const { a } = db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) AS a FROM "check_results" WHERE "project" = ?').get(project) as { a: number };
  const { b } = db.prepare('SELECT COALESCE(MAX("execution_seq"), 0) AS b FROM "check_executions" WHERE "project" = ?').get(project) as { b: number };
  return Math.max(counters.executions ?? 0, a, b);
}

// One registration per candidate, trigger identity and key (D3 §2.5): a
// protected application's trigger registers for every candidate.
const triggerKey = (t: Trigger, key: string, candidate = ''): string => `${candidate}|${t.source}|${t.id}|${t.generation}|${key}`;

// Not built, by design (slice 20, approved): a scope that grows on a spec
// revision or a module change registers nothing by itself. Neither is a
// trigger of D3 §2.5; the new required check is `missing` (never passed)
// until a trigger (operator request, a protected application, recovery)
// registers it, or a result is recorded.
//
// The checks a candidate's trigger registers under `version`: the union of
// the required sets of the `stage` gates of the stages it holds and of its
// `alpha_authorize` gate (D3 §2.5), each once, in key order: the candidate's
// content (evidence.ts candidateContent; one rule, B04). `unread`: a fact the
// sets need (ancestry, module presence) has not been read, so nothing is
// registered yet.
export function registrationSet(db: Db, project: string, candidate: CandidateRow, version: string): { checks: CheckRow[]; unread: boolean } {
  const content = candidateContent(db, project, candidate, version);
  if (content.unread.length > 0) return { checks: [], unread: true };
  return { checks: content.checks, unread: false };
}

// A candidate's `checks_due` (D3 A.3; SEAM.md §224): {trigger, at} of the
// first registration owed, and `owed`, every one, each with the version it
// was owed under. Read also in the form slice 15 wrote, a list.
export interface Owed {
  trigger: Trigger;
  version?: string;
  at: string;
}

// The due mark as read: what is owed, or `unknown` when the stored value is
// not a form this engine wrote (slice 20 review, minor 7). An unknown mark
// fails closed: every check is owed (missing, its entry's `due` the stored
// value) and the mark is never cleared or rewritten.
export type Due = { owed: Owed[]; unknown: false } | { owed: []; unknown: true; value: unknown };

const isTrigger = (t: unknown): t is Trigger =>
  typeof t === 'object' && t !== null && typeof (t as Trigger).source === 'string' && typeof (t as Trigger).id === 'string' && Number.isInteger((t as Trigger).generation);
const isOwed = (o: unknown): o is Owed =>
  typeof o === 'object' && o !== null && isTrigger((o as Owed).trigger) && typeof (o as Owed).at === 'string' && ((o as Owed).version === undefined || typeof (o as Owed).version === 'string');

export function readDue(text: string | null | undefined): Due | null {
  if (text === null || text === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    return { owed: [], unknown: true, value: text };
  }
  // The slice-15 form: a non-empty list.
  if (Array.isArray(v)) return v.length > 0 && v.every(isOwed) ? { owed: v, unknown: false } : { owed: [], unknown: true, value: v };
  if (v && typeof v === 'object') {
    const o = v as { trigger?: unknown; at?: unknown; version?: unknown; owed?: unknown };
    if (o.owed !== undefined) return Array.isArray(o.owed) && o.owed.length > 0 && o.owed.every(isOwed) ? { owed: o.owed, unknown: false } : { owed: [], unknown: true, value: v };
    if (isOwed(o)) return { owed: [{ trigger: o.trigger, at: o.at, ...(typeof o.version === 'string' ? { version: o.version } : {}) }], unknown: false };
  }
  return { owed: [], unknown: true, value: v };
}

// What is owed, for a known mark; [] for none. An unknown mark has no list:
// callers that must fail closed read readDue.
export function dueOwed(text: string | null | undefined): Owed[] {
  return readDue(text)?.owed ?? [];
}

const dueText = (owed: Owed[]): string | null => (owed.length === 0 ? null : JSON.stringify({ trigger: owed[0]!.trigger, at: owed[0]!.at, owed }));

// Register one execution per check for the trigger, in this transaction;
// a trigger identity already registered registers nothing (D3 §2.5).
// Returns the executions, those registered before included.
// A deployment verification's registrations carry their binding (D4 §5.1,
// X1): the environment, the artifact digest and {operation, attempt,
// deployment_generation, round}, frozen with the registration.
export interface DeploymentBinding {
  environment: string;
  artifact_digest: string;
  deployment: { operation: string; attempt: string; deployment_generation: number; round: string };
}

export function registerExecutions(
  tx: Tx,
  args: { project: string; candidate: CandidateRow; checks: CheckRow[]; trigger: Trigger; binding?: DeploymentBinding },
): { id: string; check: string; key: string; created: boolean }[] {
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
           "trigger", "trigger_key", "status", "registered_at", "environment", "artifact_digest", "deployment")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        id,
        tx.at,
        args.project,
        c.id,
        c.key,
        args.candidate.id,
        args.candidate.revision,
        c.protected_version,
        c.runner_class,
        seq,
        JSON.stringify(args.trigger),
        tk,
        tx.at,
        args.binding?.environment ?? null,
        args.binding?.artifact_digest ?? null,
        args.binding ? JSON.stringify(args.binding.deployment) : null,
      );
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
    const mark = readDue(due.checks_due);
    // An unknown mark already owes everything; it is never rewritten.
    if (mark?.unknown) {
      markStale(tx, { candidate: candidate.id });
      return;
    }
    const list = mark?.owed ?? [];
    if (!list.some((d) => triggerKey(d.trigger, '') === triggerKey(args.trigger, ''))) list.push({ trigger: args.trigger, version: args.version, at: tx.at });
    tx.db.prepare('UPDATE "candidates" SET "checks_due" = ? WHERE "id" = ?').run(dueText(list), candidate.id);
    markStale(tx, { candidate: candidate.id });
    return;
  }
  registerExecutions(tx, { project: args.project, candidate, checks: set.checks, trigger: args.trigger });
}

// The Checks step's half of L2: every due registration whose facts are now
// read is made, and the due mark cleared in the same transaction.
export function registerDue(tx: Tx, args: { project: string }): number {
  // Before anything is admitted: queued executions whose binding was
  // superseded end with no row (D3 §2.5; T15).
  cancelSuperseded(tx, args.project);
  const rows = tx.db.prepare('SELECT "id", "checks_due" FROM "candidates" WHERE "project" = ? AND "checks_due" IS NOT NULL').all(args.project) as { id: string; checks_due: string }[];
  let made = 0;
  for (const r of rows) {
    const candidate = getCandidate(tx.db, r.id)!;
    // A superseded candidate is owed nothing more (slice 16 review m5).
    if (candidate.superseded_by) continue;
    // Under the version effective now: one stored with the due mark may
    // since have been superseded.
    const effective = effectiveVersion(tx.db, args.project);
    if (!effective) continue;
    // A fact the sets need (ancestry, module presence) is still unread.
    if (registrationSet(tx.db, args.project, candidate, effective.id).unread) continue;
    // An unknown mark is never cleared (it fails closed: everything owed).
    const mark = readDue(r.checks_due);
    if (!mark || mark.unknown) continue;
    for (const d of mark.owed) {
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
  // A superseded candidate's results authorize nothing (D3 §2.5; Q9): no
  // execution is registered for it (slice 16 review m5).
  if (candidate.superseded_by) {
    throw new Refusal(409, 'illegal_transition', `Candidate ${candidate.id} is superseded by ${candidate.superseded_by}.`, `Request the checks of ${candidate.superseded_by}.`, {
      candidate: candidate.id,
      superseded_by: candidate.superseded_by,
    });
  }
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
      // Unknown is a value (Q11; SEAM.md §197): a fingerprint not over the
      // manifest is shown as none.
      fingerprint: v.fingerprint_scheme === 'manifest' ? v.fingerprint : null,
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
    retry_of: row.retry_of ?? null,
    infra_retries: row.infra_retries ?? 0,
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
  // A queued `direct` execution the resource envelope does not admit now
  // shows its hold (D3 §2.5, "a hold shows as resource_envelope"; SEAM.md
  // §210): no domain is allocated for it meanwhile.
  const queued = (r: Record<string, unknown>) => r.status === 'queued' && r.runner_class === 'direct';
  const hold = rows.some((r) => queued(r) && r.deployment === null) ? envelopeHold(db, { kind: 'check' }) : null;
  const boundHold = rows.some((r) => queued(r) && r.deployment !== null) ? envelopeHold(db, { kind: 'check', bound: true }) : null;
  return { ...head, executions: rows.map((r) => ({ ...executionView(r), hold: queued(r) ? (r.deployment !== null ? boundHold : hold) : null })) };
}

// ---- the runner's qualification (D3 §2.8; A.3 host_qualifications.check_runner) --------

export interface CheckRunnerState {
  profile_fingerprint: string;
  self_test: { case: string; control: string; result: string; evidence?: unknown }[];
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
  // An environment-bound execution's service link (D4 §5.2; J8): the
  // attempt and generation frozen on it, its environment, and the targets
  // with the port each is reached on inside the check's own namespace.
  link: { attempt: string; environment: string; generation: number; targets: string[]; port: number } | null;
  // Bound to a deployment verification (D4 §5.1): its source projection is
  // empty.
  deployment: boolean;
}

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

// The Checks tick step's admission (D3 §2.5; L1, L2): the oldest queued
// `direct` execution of the project, when the runner is qualified on this
// host now, the project runs fewer than `max_concurrent_checks`, and the
// resource envelope admits a domain. Its domain is allocated, owned by this
// incarnation, and it holds a lease of kind `check`. null: nothing admitted.
export function admitExecution(
  tx: Tx,
  args: { project: string; incarnation: string; scope: string; hostId: string; selfTestRunning?: boolean },
): Admission | null {
  cancelSuperseded(tx, args.project);
  recordUnrunnable(tx, args.project, args.selfTestRunning === true);
  const q = runnerQualification(tx.db);
  // While this start's runner self-test is in progress nothing `direct` is
  // admitted: it stays queued (SEAM.md §208).
  if (args.selfTestRunning === true || q === null || q.check_runner === null || q.check_runner.qualified !== true) return null;
  const { n } = tx.db.prepare(`SELECT COUNT(*) AS n FROM "check_executions" WHERE "project" = ? AND "status" IN (${LIVE.map(() => '?').join(', ')})`).get(args.project, ...LIVE) as { n: number };
  const max = projectPolicy(tx.db, args.project).max_concurrent_checks ?? 1;
  if (n >= max) return null;
  // A deployment verification's execution is admitted first, into the check
  // capacity kept for it while a service runs (D4 §4.7; E126; the slice-25
  // design Q5); any other beside it.
  const x = tx.db
    .prepare(`SELECT * FROM "check_executions" WHERE "project" = ? AND "status" = 'queued' AND "runner_class" = 'direct' ORDER BY ("deployment" IS NULL), "execution_seq" LIMIT 1`)
    .get(args.project) as Record<string, unknown> | undefined;
  if (!x) return null;
  if (envelopeHold(tx.db, { kind: 'check', bound: typeof x.deployment === 'string' }) !== null) return null;
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
    link: linkOf(tx.db, x),
    deployment: typeof x.deployment === 'string',
  };
}

// The service link an execution bound to a deployment reaches (D4 §5.2).
function linkOf(db: Db, x: Record<string, unknown>): Admission['link'] {
  if (typeof x.deployment !== 'string' || typeof x.environment !== 'string') return null;
  let dep: { attempt?: string; deployment_generation?: number; operation?: string };
  try {
    dep = JSON.parse(x.deployment) as typeof dep;
  } catch {
    return null;
  }
  if (!dep.attempt || !dep.operation || !Number.isInteger(dep.deployment_generation)) return null;
  const op = db.prepare('SELECT "finalizer_inputs" FROM "operations" WHERE "id" = ?').get(dep.operation) as { finalizer_inputs: string } | undefined;
  if (!op) return null;
  const frozen = JSON.parse(op.finalizer_inputs) as { target_set?: string[]; config_version?: string | null };
  const config = frozen.config_version ? (db.prepare('SELECT "content" FROM "environment_configs" WHERE "id" = ?').get(frozen.config_version) as { content: string } | undefined) : undefined;
  const port = config ? (JSON.parse(config.content) as { port?: number }).port : undefined;
  if (typeof port !== 'number') return null;
  return { attempt: dep.attempt, environment: x.environment, generation: dep.deployment_generation!, targets: frozen.target_set ?? [], port };
}

// The reasons the runner knows, before anything is allocated, that a queued
// execution cannot run (D3 §§2.7, 2.8, 5 X3; SEAM.md §§209, 211): each is
// recorded at once with its reason (queued → materializing → recorded, A.5),
// with no domain, under the qualification in force now (T19).
//   - environment_unbound: the definition requires an environment, and no
//     trigger M3 has binds one (deployment is reserved);
//   - isolation_unqualified: no active host qualification;
//   - runner_unqualified: a class other than `direct`, which nothing
//     qualifies; or `direct` while the runner is not qualified at this start
//     and no self-test of this start is still in progress.
// Only the refusal of checks against a service of unknown supervision
// (redaction_unavailable), recorded as soon as its round reaches them, in
// either lane (deploy.ts, the round's step).
export function refuseUnsupervised(tx: Tx, project: string): void {
  recordUnrunnable(tx, project, false, true);
}

function recordUnrunnable(tx: Tx, project: string, selfTestRunning: boolean, unsupervisedOnly = false): void {
  const rows = tx.db
    .prepare(
      `SELECT x."id", x."runner_class", x."environment", x."deployment", c."definition" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check"
       WHERE x."project" = ? AND x."status" = 'queued' ORDER BY x."execution_seq"`,
    )
    .all(project) as { id: string; runner_class: string; environment: string | null; deployment: string | null; definition: string }[];
  if (rows.length === 0) return;
  const q = runnerQualification(tx.db);
  for (const r of rows) {
    let requires: unknown = [];
    try {
      requires = (JSON.parse(r.definition) as { requires?: unknown }).requires ?? [];
    } catch {
      requires = [];
    }
    let reason: string | null = null;
    // An execution a deployment verification bound to its environment is
    // not unbound (D4 §5.1, X1); every other one that requires one is.
    if (Array.isArray(requires) && requires.includes('environment') && r.environment === null) reason = 'environment_unbound';
    // A check against a service whose supervision is `unknown` is refused,
    // not run (D4 §§5.1, 7.3; E116).
    else if (r.deployment !== null && !deploymentSupervised(tx, r.deployment)) reason = 'redaction_unavailable';
    else if (unsupervisedOnly) reason = null;
    else if (q === null) reason = 'isolation_unqualified';
    else if (r.runner_class !== 'direct') reason = 'runner_unqualified';
    else if (!selfTestRunning && (q.check_runner === null || q.check_runner.qualified !== true)) reason = 'runner_unqualified';
    if (reason === null) continue;
    tx.db.prepare(`UPDATE "check_executions" SET "status" = 'materializing', "runner_qualification" = ? WHERE "id" = ?`).run(q?.id ?? null, r.id);
    recordExecutionResult(
      tx,
      {
        execution: r.id,
        established: false,
        exit_status: null,
        signaled: false,
        deadline_hit: false,
        orphans: false,
        not_run_reason: reason,
        output: null,
        output_dropped_bytes: null,
      },
      { runner_id: r.runner_class },
    );
  }
}

interface ExecutionRow {
  id: string;
  project: string;
  candidate: string;
  status: string;
  domain: string | null;
  lease: string | null;
  init_reports: string;
  finished_at: string | null;
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
// The execution stays `materializing` until the init's `started` report is
// recorded (SEAM.md §203).
export function markLaunched(tx: Tx, args: { execution: string; domain: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (x.status !== 'materializing') return;
  tx.emit('check.launched', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: args.domain }, {});
}

// One of the init's reports (A.2 InitReport), as the engine received it on
// the init's channel, never from anything check code wrote.
export function recordInitReport(tx: Tx, args: { execution: string; kind: 'started' | 'exec_failed' | 'exit' | 'orphans'; detail: Record<string, unknown> | null }): void {
  const x = mustExecution(tx.db, args.execution);
  const reports = JSON.parse(x.init_reports) as { kind: string; at: string; detail: unknown }[];
  reports.push({ kind: args.kind, at: tx.at, detail: args.detail });
  tx.db.prepare('UPDATE "check_executions" SET "init_reports" = ? WHERE "id" = ?').run(JSON.stringify(reports), x.id);
  if (args.kind === 'started') {
    tx.db.prepare('UPDATE "check_executions" SET "started_at" = ? WHERE "id" = ? AND "started_at" IS NULL').run(tx.at, x.id);
    // `running` from the transaction that records `started` (SEAM.md §203).
    if (x.status === 'materializing') tx.db.prepare(`UPDATE "check_executions" SET "status" = 'running' WHERE "id" = ?`).run(x.id);
  }
}

// The program the execution runs, as resolved at launch (D3 §§1.1, 2.5, Q6).
// The candidate's own protected fingerprint, under the bound version's
// roots, over the manifest (D3 §1.5; SEAM.md §196); null when unread.
export function recordCandidateFingerprint(tx: Tx, args: { execution: string; fingerprint: string | null }): void {
  tx.db.prepare('UPDATE "check_executions" SET "candidate_protected_fingerprint" = ? WHERE "id" = ?').run(args.fingerprint, args.execution);
}

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
  // One a preempting teardown cancelled while it ran is quarantined as well
  // when its termination is not observed (the slice-27 review, m4).
  const cancelledLive = x.status === 'cancelled' && x.finished_at !== null && x.domain !== null;
  if (x.status === 'quarantined' || (!LIVE.includes(x.status) && !cancelledLive)) return;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'quarantined' WHERE "id" = ?`).run(x.id);
  tx.emit('check.quarantined', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: x.domain }, { from: x.status, why: args.why });
  // Its domain stays nonterminal, quarantined, as a role's does (L1; SEAM.md
  // §§128, 205).
  if (x.domain !== null) quarantineDomain(tx, { domain: x.domain, subject: { check_execution: x.id } });
  markStale(tx, { candidate: x.candidate });
}

// A deployment verification's `service_link_log` record (D4 §5.2; SEAM.md
// §268), tied to its execution once written.
export function recordLinkLog(tx: Tx, args: { execution: string; record: string }): void {
  tx.db.prepare('UPDATE "check_executions" SET "service_link_log" = ? WHERE "id" = ? AND "service_link_log" IS NULL').run(args.record, args.execution);
}

// Ended with no row (D3 §2.6): its domain's closure observed, and nothing
// established about the check's own process.
export function interruptExecution(tx: Tx, args: { execution: string; why: string }): void {
  const x = mustExecution(tx.db, args.execution);
  if (!LIVE.includes(x.status)) return;
  if (cancelledThenSettled(tx, x)) return;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'interrupted', "finished_at" = ? WHERE "id" = ?`).run(tx.at, x.id);
  releaseCheckLease(tx, x.id);
  tx.emit('check.interrupted', { project: x.project, candidate: x.candidate, check_execution: x.id, domain: x.domain }, { from: x.status, why: args.why });
  markStale(tx, { candidate: x.candidate });
  // Registered again, as `recovery`, in this transaction (D3 §2.7; T05).
  registerRecoveryRetry(tx, x.id);
  // An execution ended: reconciled as D3 §2.10 asks (it never makes a check
  // failed by itself, so it never takes a repair; it may leave one owed).
  reconcileRepairs(tx, x.project);
}

// An execution cancelled while live and quarantined meanwhile (its
// `finished_at` is the cancellation's): once its closure is observed it is
// `cancelled` again, with no result (the slice-27 review, m4).
function cancelledThenSettled(tx: Tx, x: { id: string; status: string; finished_at: string | null }): boolean {
  if (x.finished_at === null || (x.status !== 'quarantined' && x.status !== 'collecting')) return false;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'cancelled' WHERE "id" = ?`).run(x.id);
  releaseCheckLease(tx, x.id);
  return true;
}

// Whether the service a deployment-bound execution is bound to is
// supervised now (D4 §9.2; E110): its launch granted by this incarnation,
// its control channel not lost.
function deploymentSupervised(tx: Tx, binding: string): boolean {
  let b: { attempt?: string };
  try {
    b = JSON.parse(binding) as typeof b;
  } catch {
    return false;
  }
  const row = tx.db
    .prepare(`SELECT a."incarnation", a."init_instance" AS "init", (SELECT d."supervision_lost_at" FROM "execution_domains" d WHERE d."attempt" = a."id") AS "lost" FROM "operation_attempts" a WHERE a."id" = ?`)
    .get(b.attempt ?? '') as { incarnation: string | null; init: string | null; lost: string | null } | undefined;
  let incarnation: string | undefined;
  try {
    incarnation = engineSettings().incarnation;
  } catch {
    incarnation = undefined;
  }
  return row !== undefined && row.init !== null && row.incarnation === incarnation && row.lost === null;
}

// Whether a deployment-bound execution may be retried (D4 §5.3 item 7;
// E110): its round open, its generation the environment's current one, its
// service's launch granted by this incarnation and its channel not lost.
function deploymentRetryable(tx: Tx, binding: string): boolean {
  let b: { round?: string; attempt?: string; deployment_generation?: number };
  try {
    b = JSON.parse(binding) as typeof b;
  } catch {
    return false;
  }
  const row = tx.db
    .prepare(
      `SELECT r."status" AS "round_status", e."current_generation" AS "current", a."incarnation" AS "incarnation", a."init_instance" AS "init",
              (SELECT d."supervision_lost_at" FROM "execution_domains" d WHERE d."attempt" = a."id") AS "lost"
       FROM "verification_rounds" r JOIN "operation_attempts" a ON a."id" = r."attempt" JOIN "environments" e ON e."id" = r."environment"
       WHERE r."id" = ? AND a."id" = ?`,
    )
    .get(b.round ?? '', b.attempt ?? '') as { round_status: string; current: number | null; incarnation: string | null; init: string | null; lost: string | null } | undefined;
  if (!row) return false;
  let incarnation: string | undefined;
  try {
    incarnation = engineSettings().incarnation;
  } catch {
    incarnation = undefined;
  }
  return row.round_status === 'open' && row.current === b.deployment_generation && row.init !== null && row.incarnation === incarnation && row.lost === null;
}

// The recovery registration of an interrupted or `materialization_failed`
// execution (D3 §§2.5, 2.7; T05; SEAM.md §204), made in the transaction that
// ends it, after its domain's closure. The n-th retry of an original
// registration has trigger {recovery, the original's trigger id, the
// original's generation + n}, `retry_of` the execution it retries and
// `infra_retries` n; at most `check_infra_retries_max` per original, counted
// from the store, so a restart resets nothing. The same frozen bindings: the
// check row, the candidate and its revision, the protected version, the
// class. Nothing for a superseded candidate or version. Returns the new
// registration's id, or null.
export function registerRecoveryRetry(tx: Tx, execution: string): string | null {
  type Row = {
    id: string;
    project: string;
    check: string;
    key: string;
    candidate: string;
    source_revision: string;
    protected_version: string;
    runner_class: string;
    trigger: string;
    retry_of: string | null;
    infra_retries: number;
    environment: string | null;
    artifact_digest: string | null;
    deployment: string | null;
  };
  const get = (id: string) => tx.db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(id) as Row | undefined;
  const x = get(execution);
  if (!x) return null;
  let original = x;
  for (let i = 0; original.retry_of !== null && i < 64; i++) {
    const prior = get(original.retry_of);
    if (!prior) break;
    original = prior;
  }
  const n = (x.infra_retries ?? 0) + 1;
  if (n > checkLimits().check_infra_retries_max) return null;
  const superseded = tx.db
    .prepare('SELECT (SELECT "superseded_by" FROM "candidates" WHERE "id" = ?) AS c, (SELECT "superseded_by" FROM "protected_versions" WHERE "id" = ?) AS v')
    .get(x.candidate, x.protected_version) as { c: string | null; v: string | null };
  if (superseded.c !== null || superseded.v !== null) return null;
  // A deployment verification's execution keeps its binding (D4 §5.3 item
  // 7: recovery preserves the round's retry accounting), and is retried
  // only while its round is open, its generation the environment's current
  // one and its service supervised (E110); otherwise nothing is retried.
  if (x.deployment !== null && !deploymentRetryable(tx, x.deployment)) return null;
  const first = JSON.parse(original.trigger) as Trigger;
  const trigger: Trigger = { source: 'recovery', id: first.id, generation: first.generation + n };
  const tk = triggerKey(trigger, x.key, x.candidate);
  const existing = tx.db.prepare('SELECT "id" FROM "check_executions" WHERE "project" = ? AND "trigger_key" = ?').get(x.project, tk) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = tx.newId('cx_');
  const seq = nextExecutionSeq(tx, x.project);
  tx.db
    .prepare(
      `INSERT INTO "check_executions" ("id", "created_at", "project", "check", "key", "candidate", "source_revision", "protected_version", "runner_class", "execution_seq",
         "trigger", "trigger_key", "retry_of", "infra_retries", "status", "registered_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(id, tx.at, x.project, x.check, x.key, x.candidate, x.source_revision, x.protected_version, x.runner_class, seq, JSON.stringify(trigger), tk, x.id, n, tx.at);
  if (x.deployment !== null) {
    tx.db.prepare('UPDATE "check_executions" SET "environment" = ?, "artifact_digest" = ?, "deployment" = ? WHERE "id" = ?').run(x.environment, x.artifact_digest, x.deployment, id);
  }
  tx.emit('check.registered', { project: x.project, candidate: x.candidate, check_execution: id }, { key: x.key, trigger, execution_seq: seq, check: x.check, retry_of: x.id, infra_retries: n });
  markStale(tx, { candidate: x.candidate });
  return id;
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
export function recordExecutionResult(tx: Tx, args: ResultFields, label: { runner_id?: string } = {}): { check_result: string } | null {
  const x = tx.db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(args.execution) as Record<string, unknown> | undefined;
  if (!x) throw notFound('check execution', args.execution);
  if (x.status === 'recorded' && typeof x.result === 'string') return { check_result: x.result };
  if (!LIVE.includes(x.status as string)) return null;
  if (cancelledThenSettled(tx, x as { id: string; status: string; finished_at: string | null })) return null;
  const id = insertExecutionResult(tx, {
    project: x.project as string,
    check: x.check as string,
    candidate: x.candidate as string,
    source_revision: x.source_revision as string,
    protected_version: x.protected_version as string,
    runner_class: x.runner_class as string,
    runner_id: label.runner_id ?? (x.runner_id as string | null) ?? 'direct',
    runner_qualification: (x.runner_qualification as string | null) ?? null,
    execution_seq: x.execution_seq as number,
    started_at: (x.started_at as string | null) ?? null,
    finished_at: tx.at,
    environment: (x.environment as string | null) ?? null,
    artifact_digest: (x.artifact_digest as string | null) ?? null,
    deployment: (x.deployment as string | null) ?? null,
    ...args,
  });
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'recorded', "result" = ?, "not_run_reason" = ?, "finished_at" = ? WHERE "id" = ?`).run(id, args.not_run_reason, tx.at, args.execution);
  releaseCheckLease(tx, args.execution);
  // A failed materialization is registered again (D3 §2.7); no other
  // reason, and no established result, ever is.
  if (args.not_run_reason === 'materialization_failed') registerRecoveryRetry(tx, args.execution);
  // The repair a failed check owes, in the transaction that records it (D3 §2.10).
  reconcileRepairs(tx, x.project as string);
  return { check_result: id };
}

// The secret screen refused a check's output record (D3 §2.6; D1 §14.2;
// SEAM.md §207): nothing of it is written; the Critical security finding of
// the project, and `evidence.secret_refused` naming the execution, never the
// secret.
export function checkOutputRefused(tx: Tx, args: { execution: string; by: string | null }): string {
  const x = mustExecution(tx.db, args.execution);
  const finding = raiseFinding(tx, {
    project: x.project,
    scope: 'project',
    candidate: null,
    run: null,
    role: null,
    category: 'security',
    severity: 'critical',
    message: `The secret screen found a registered secret${args.by ? ` (${args.by})` : ''} in the output of check execution ${x.id}; its publication was refused.`,
  });
  tx.emit('evidence.secret_refused', { project: x.project, check_execution: x.id, finding }, { what: 'check_output', path: null, by: args.by });
  return finding;
}

// ---- the check lease after a pause (D3 §2.5; D2 §3.5; SEAM.md §205) -----------------------

// Is the execution's check lease, past its expiry, a candidate for a re-grant
// (everything but the challenge, which the main thread makes)? Its lease is
// held, not closing, by this incarnation at this generation; its domain is
// launched under an authorization binding the execution, the incarnation and
// the generation; the execution is running.
export function checkRegrantFacts(db: Db, args: { execution: string; incarnation: string; generation: number }): { eligible: boolean; reason: string | null } {
  const none = (reason: string) => ({ eligible: false, reason });
  const lease = db.prepare(`SELECT * FROM "leases" WHERE "resource_kind" = 'check' AND "resource_id" = ? AND "released_at" IS NULL`).get(args.execution) as
    | { generation: number; closing: number; owner_incarnation: string }
    | undefined;
  if (!lease) return none('the execution holds no check lease');
  if (lease.closing === 1) return none('the lease is closing');
  if (lease.owner_incarnation !== args.incarnation || lease.generation !== args.generation) return none("the lease is another incarnation's or generation's");
  const x = db.prepare('SELECT "status", "domain" FROM "check_executions" WHERE "id" = ?').get(args.execution) as { status: string; domain: string | null } | undefined;
  if (!x || x.status !== 'running' || x.domain === null) return none('the execution is not running');
  const d = db.prepare('SELECT "status", "launch_state", "launch_binding" FROM "execution_domains" WHERE "id" = ?').get(x.domain) as
    | { status: string; launch_state: string; launch_binding: string | null }
    | undefined;
  if (!d || d.status !== 'launched' || d.launch_state !== 'authorized' || d.launch_binding === null) return none('the domain is not launched under an authorization');
  const b = JSON.parse(d.launch_binding) as { check_execution?: string; incarnation?: string; lease_generation?: number };
  if (b.check_execution !== args.execution || b.incarnation !== args.incarnation || b.lease_generation !== args.generation) return none('the launch authorization names another execution, incarnation or generation');
  return { eligible: true, reason: null };
}

// The re-grant: the same generation, a new expiry, `timeout_s` untouched;
// `check.lease_regranted` carries the fresh challenge's evidence.
export function regrantCheckLease(
  tx: Tx,
  args: { execution: string; generation: number; incarnation: string; challenge: { nonce: string; sent_at: string; answered_at: string; backend_state: string } },
): string | null {
  if (!checkRegrantFacts(tx.db, args).eligible) return null;
  const lease = tx.db.prepare(`SELECT "id", "expires_at" FROM "leases" WHERE "resource_kind" = 'check' AND "resource_id" = ? AND "released_at" IS NULL`).get(args.execution) as {
    id: string;
    expires_at: string;
  };
  const expires = addSeconds(tx.at, engineSettings().lease_ttl);
  tx.db.prepare('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?').run(tx.at, expires, lease.id);
  const x = mustExecution(tx.db, args.execution);
  tx.emit(
    'check.lease_regranted',
    { project: x.project, candidate: x.candidate, check_execution: x.id },
    { generation: args.generation, expired_at: lease.expires_at, expires_at: expires, challenge: { ...args.challenge, channel: 'domain_init' } },
  );
  return tx.at;
}

// ---- cancellation and supersession (D3 §2.5 "Supersession"; T15; SEAM.md §192) ------------

// Cancelled with no row: the execution never ran, so nothing is claimed of
// the check, and no superseded evidence is restored (L7). Only from
// `queued` or `materializing` (A.5).
// `live`: a running execution too (a preempting teardown, D4 §4.6 step 2;
// SEAM.md §296): cancelled in this transaction, recorded with no result; the
// check runner's supervisor ends its process and closes its domain.
export function cancelExecution(tx: Tx, args: { execution: string; why: string; live?: boolean }): boolean {
  const x = mustExecution(tx.db, args.execution);
  // A quarantined one keeps its quarantine: its termination is not known.
  if (args.live === true ? !['queued', 'materializing', 'running', 'collecting'].includes(x.status) : x.status !== 'queued' && x.status !== 'materializing') return false;
  tx.db.prepare(`UPDATE "check_executions" SET "status" = 'cancelled', "finished_at" = ? WHERE "id" = ?`).run(tx.at, x.id);
  releaseCheckLease(tx, x.id);
  tx.emit('check.cancelled', { project: x.project, candidate: x.candidate, check_execution: x.id }, { from: x.status, why: args.why });
  markStale(tx, { candidate: x.candidate });
  reconcileRepairs(tx, x.project);
  return true;
}

// Every queued execution of the project whose candidate or protected version
// is superseded is cancelled before launch. One already past `queued` is not:
// it is recorded under its frozen bindings, which then decide nothing current.
export function cancelSuperseded(tx: Tx, project: string): number {
  const rows = tx.db
    .prepare(
      `SELECT x."id", c."superseded_by" AS "by_candidate", v."superseded_by" AS "by_version" FROM "check_executions" x
       JOIN "candidates" c ON c."id" = x."candidate" JOIN "protected_versions" v ON v."id" = x."protected_version"
       WHERE x."project" = ? AND x."status" = 'queued' AND (c."superseded_by" IS NOT NULL OR v."superseded_by" IS NOT NULL) ORDER BY x."execution_seq"`,
    )
    .all(project) as { id: string; by_candidate: string | null; by_version: string | null }[];
  for (const r of rows) {
    cancelExecution(tx, { execution: r.id, why: r.by_version !== null ? `its protected version was superseded by ${r.by_version}` : `its candidate was superseded by ${r.by_candidate}` });
  }
  return rows.length;
}

// ---- the scripted check boundary (kernel lane; SEAM.md §190) ---------------------------------

// D3 A.5, one step at a time.
const SCRIPTED_STEPS: Record<string, string[]> = {
  queued: ['materializing', 'cancelled'],
  materializing: ['running', 'quarantined', 'interrupted', 'cancelled'],
  running: ['collecting', 'quarantined', 'interrupted'],
  quarantined: ['collecting', 'interrupted'],
  collecting: ['recorded'],
};

export interface ScriptedStep {
  execution: string;
  to: string;
  result: { exit_status: number | null; signaled: boolean; deadline_hit: boolean; orphans: boolean } | null;
  output: string | null;
  // The label a recorded result carries as its runner: the caller's, since
  // no runner ran (E92 item 2; objection 025).
  runner_id: string;
}

// Move one execution one step through the engine's own transitions, so that
// whatever the engine does on that change (staling, and in later slices the
// repair and recovery reconciliations) happens in this transaction. A
// recorded result carries the registration's number and frozen bindings,
// `execution_established` true, no runner qualification and the caller's
// label as its runner (no runner ran; E92 item 2).
export function scriptExecutionStep(tx: Tx, args: ScriptedStep): { execution: { id: string; status: string }; check_result: { id: string; execution_seq: number } | null } {
  const x = tx.db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(args.execution) as (ExecutionRow & { execution_seq: number }) | undefined;
  if (!x) throw notFound('check execution', args.execution);
  if (!(SCRIPTED_STEPS[x.status] ?? []).includes(args.to)) {
    throw new Refusal(409, 'illegal_transition', `A check execution in ${x.status} cannot move to ${args.to} in one step.`, 'Move it one step of D3 A.5 at a time.', {
      execution: x.id,
      status: x.status,
      to: args.to,
    });
  }
  let result: { id: string; execution_seq: number } | null = null;
  const why = 'the scripted check boundary';
  switch (args.to) {
    case 'materializing':
    case 'running':
    case 'collecting':
      tx.db.prepare('UPDATE "check_executions" SET "status" = ? WHERE "id" = ?').run(args.to, x.id);
      if (args.to === 'running') tx.db.prepare('UPDATE "check_executions" SET "started_at" = ? WHERE "id" = ? AND "started_at" IS NULL').run(tx.at, x.id);
      break;
    case 'quarantined':
      quarantineExecution(tx, { execution: x.id, why });
      break;
    case 'interrupted':
      interruptExecution(tx, { execution: x.id, why });
      break;
    case 'cancelled':
      cancelExecution(tx, { execution: x.id, why });
      break;
    case 'recorded': {
      const r = args.result!;
      const made = recordExecutionResult(
        tx,
        {
          execution: x.id,
          established: true,
          exit_status: r.exit_status,
          signaled: r.signaled,
          deadline_hit: r.deadline_hit,
          orphans: r.orphans,
          not_run_reason: null,
          output: args.output,
          output_dropped_bytes: null,
        },
        { runner_id: args.runner_id },
      );
      if (made !== null) result = { id: made.check_result, execution_seq: x.execution_seq };
      break;
    }
  }
  const now = mustExecution(tx.db, x.id);
  return { execution: { id: now.id, status: now.status }, check_result: result };
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

// Whether another execution of the triple has a domain that may still hold
// its check tree: launched or past it and not established closed (D3 §2.4,
// "never before closure").
export function treeHeld(db: Db, args: { project: string; revision: string; version: string; except: string }): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM "check_executions" WHERE "project" = ? AND "source_revision" = ? AND "protected_version" = ? AND "id" <> ?
         AND "status" IN ('running', 'collecting', 'quarantined') LIMIT 1`,
      )
      .get(args.project, args.revision, args.version, args.except) !== undefined
  );
}

// Executions this incarnation must account for at start (D3 §2.6, T07):
// every one past `queued` and not terminal.
export function liveExecutions(db: Db): { id: string; project: string; status: string; domain: string | null; source_revision: string; protected_version: string }[] {
  return db
    .prepare(`SELECT "id", "project", "status", "domain", "source_revision", "protected_version" FROM "check_executions" WHERE "status" IN (${LIVE.map(() => '?').join(', ')}) ORDER BY "execution_seq"`)
    .all(...LIVE) as { id: string; project: string; status: string; domain: string | null; source_revision: string; protected_version: string }[];
}
