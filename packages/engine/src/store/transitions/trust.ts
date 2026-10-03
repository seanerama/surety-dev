// The trust table and what it rests on, the store's side (D2 §§4.1, 4.2,
// 7.1 to 7.3, K10, A.3, A.4): host qualifications, qualification attempts and
// trust entries, their transitions, what the two decisions about them bind,
// and the dispatch rule. Nothing here starts a process: an attempt's canaries
// and a host's checks are run elsewhere, and answering either decision
// launches nothing (CH incident 10).

import { BUDGET_BOUNDARIES } from '../../config/schema.js';
import { Refusal } from '../../refusal.js';
import { seamHostChecks } from '../../testing/seam.js';
import { BOUNDARY_MECHANISM, HOST_CHECKS, ISOLATION_MECHANISM, hostIdentity } from '../../trust/host.js';
import { canonical, notFound, sha256 } from './common.js';
import { assertEdge } from './lifecycle.js';
import { engineSettings, projectOptions } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

export const USAGE_GRANULARITIES = ['model_call', 'invocation', 'none'] as const;
export const ENFORCEMENT_MECHANISMS = ['dispatch_check', 'admission_control', 'bounded_overshoot'] as const;
export const COST_REPORTING = ['reported', 'tokens_only', 'none'] as const;

// ---- rows -------------------------------------------------------------------------------

export interface HostQualificationRow {
  id: string;
  host_id: string;
  kernel: string;
  tool_versions: string;
  mechanism_fingerprint: string;
  checks: string;
  probes: string;
  bootstrap_exception: number;
  evidence: string;
  status: 'active' | 'lapsed';
  incarnation: string;
  qualified_at: string;
  lapsed_at: string | null;
  lapsed_reason: string | null;
}

export interface AttemptRow {
  id: string;
  created_at: string;
  backend: string;
  version: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  template: string;
  template_version: string;
  model: string;
  auth_mode: string;
  host_qualification: string | null;
  profile_fingerprint: string;
  fixture_project: string | null;
  candidate_egress: string;
  canary_deadlines: string;
  spend: string;
  decision: string | null;
  status: 'proposed' | 'authorized' | 'running' | 'succeeded' | 'failed' | 'invalidated';
  canaries: string;
  unexpected_contacts: string;
  trust_entry: string | null;
  invalidated_reason: string | null;
}

export interface Boundary {
  boundary: string;
  mechanism: string;
  evidence: string;
  overshoot: unknown;
}

export interface EntryRow {
  id: string;
  created_at: string;
  backend: string;
  version: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  mode: string;
  template: string;
  template_version: string;
  model: string;
  auth_mode: string;
  capabilities: string;
  host_id: string;
  host_qualification: string | null;
  isolation: string;
  boundary: string;
  profile_fingerprint: string;
  egress_hosts: string;
  usage_granularity: string;
  usage_semantics: string | null;
  cost_reporting: string;
  enforceable_boundaries: string;
  result_channel: string;
  session_qualified: number;
  provider_files: string;
  term_to_exit_ms: number | null;
  qualification_attempt: string;
  evidence: string;
  evidence_fingerprint: string;
  status: 'proposed' | 'active' | 'revoked';
  activated_by: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const json = <T>(text: string): T => JSON.parse(text) as T;

export const getEntry = (db: Db, id: string): EntryRow | undefined => db.prepare('SELECT * FROM "trust_entries" WHERE "id" = ?').get(id) as EntryRow | undefined;
export const getAttempt = (db: Db, id: string): AttemptRow | undefined => db.prepare('SELECT * FROM "qualification_attempts" WHERE "id" = ?').get(id) as AttemptRow | undefined;
const getHostRow = (db: Db, id: string): HostQualificationRow | undefined =>
  db.prepare('SELECT * FROM "host_qualifications" WHERE "id" = ?').get(id) as HostQualificationRow | undefined;

// ---- host qualifications (D2 §7.1) ----------------------------------------------------------

// The current host qualification: the one active row. Every start lapses the
// rows of earlier incarnations (lapseEarlierQualifications), so an active row
// is this incarnation's.
export function currentHostQualification(db: Db): HostQualificationRow | undefined {
  return db.prepare(`SELECT * FROM "host_qualifications" WHERE "status" = 'active'`).get() as HostQualificationRow | undefined;
}

function lapse(tx: Tx, row: HostQualificationRow, reason: string): void {
  if (row.status !== 'active') return;
  tx.db.prepare(`UPDATE "host_qualifications" SET "status" = 'lapsed', "lapsed_at" = ?, "lapsed_reason" = ? WHERE "id" = ?`).run(tx.at, reason, row.id);
  tx.emit('host.qualification_lapsed', { host_qualification: row.id }, { reason, incarnation: row.incarnation });
}

// At every start, before anything is dispatched (D2 §§4.1, 7.1): a
// qualification of an earlier incarnation is historical. Only this start's
// checks can make one current.
export function lapseEarlierQualifications(tx: Tx, incarnation: string): void {
  const rows = tx.db.prepare(`SELECT * FROM "host_qualifications" WHERE "status" = 'active' AND "incarnation" <> ?`).all(incarnation) as HostQualificationRow[];
  for (const row of rows) lapse(tx, row, 'engine_restart');
}

export interface HostQualificationInput {
  incarnation: string;
  host_id: string;
  kernel: string;
  tool_versions: Record<string, unknown>;
  mechanism_fingerprint: string;
  checks: unknown[];
  probes: unknown[];
  evidence: string;
  // Whether every required check passed (D2 §6: H1 to H12, H10 only on
  // WSL2); and if not, which did not and why.
  qualifies?: boolean;
  unqualified?: string | null;
}

// The checks of a start (D2 §7.1): one row per start. A start whose checks
// all passed writes its row `active` and lapses the previous one. A start
// whose checks did not all pass writes its row already lapsed, with the
// checks that kept it from qualifying as the reason, so what was observed is
// kept and nothing about it is current. While the bootstrap exception is in
// force the row is written and never active (D2 §2.6, N05).
export function recordHostQualification(tx: Tx, args: HostQualificationInput, label: Record<string, unknown> = {}): HostQualificationRow {
  if (!tx.db.prepare('SELECT 1 FROM "records" WHERE "id" = ? AND "published" = 1').get(args.evidence)) throw notFound('record', args.evidence);
  const exception = engineSettings().ui_bootstrap === true;
  const qualifies = args.qualifies !== false;
  const active = qualifies && !exception;
  const reason = exception ? 'bootstrap_exception' : qualifies ? null : `unqualified: ${args.unqualified ?? 'a required check did not pass'}`;
  const previous = currentHostQualification(tx.db);
  if (previous && active) lapse(tx, previous, 'superseded');
  const id = tx.newId('hq_');
  tx.db
    .prepare(
      `INSERT INTO "host_qualifications" ("id", "created_at", "host_id", "kernel", "tool_versions", "mechanism_fingerprint", "checks", "probes",
         "bootstrap_exception", "evidence", "status", "incarnation", "qualified_at", "lapsed_at", "lapsed_reason")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tx.at,
      args.host_id,
      args.kernel,
      JSON.stringify(args.tool_versions),
      args.mechanism_fingerprint,
      JSON.stringify(args.checks),
      JSON.stringify(args.probes),
      exception ? 1 : 0,
      args.evidence,
      active ? 'active' : 'lapsed',
      args.incarnation,
      tx.at,
      active ? null : tx.at,
      reason,
    );
  if (active) tx.emit('host.qualified', { host_qualification: id }, { ...label, mechanism_fingerprint: args.mechanism_fingerprint, incarnation: args.incarnation });
  return getHostRow(tx.db, id)!;
}

export interface CheckResult {
  id: string;
  result: 'passed' | 'failed' | 'not_exercised';
  observed: string | null;
  remedy?: string | null;
  required?: boolean;
}

// This start's row (any status), if its checks have been recorded.
function thisStartsRow(db: Db): HostQualificationRow | undefined {
  const incarnation = engineSettings().incarnation;
  if (!incarnation) return undefined;
  return db.prepare('SELECT * FROM "host_qualifications" WHERE "incarnation" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1').get(incarnation) as HostQualificationRow | undefined;
}

// The first reason the host is not eligible, in the message's shape (D2 §6):
// `isolation unqualified: H3 failed: <observed>; <remedy>; real backends are
// refused until then.`
export function unqualifiedMessage(checks: CheckResult[]): string | null {
  const first = checks.find((c) => c.result === 'failed') ?? checks.find((c) => c.result === 'not_exercised' && c.required === true);
  if (!first) return null;
  const what = first.result === 'failed' ? 'failed' : 'not exercised';
  return `isolation unqualified: ${first.id} ${what}: ${first.observed ?? 'nothing was observed'}${first.remedy ? `; ${first.remedy}` : ''}; real backends are refused until then.`;
}

// The host checks as this engine reports them (D2 §6; SEAM.md §§114, 118).
// The checks themselves are not built in this engine revision: each is
// `not_exercised`, never passed, unless the harness forces a result. Under
// the harness's `unrun` switch the host's eligibility is the harness's
// say-so (source `harness`); otherwise it rests on a current active host
// qualification (source `qualification`), which without the checks cannot
// exist outside harness mode.
export function hostReport(db: Db) {
  const switches = seamHostChecks();
  const mode = switches?.mode ?? 'run';
  const forced = switches?.forced ?? {};
  // Who vouches for the host when the checks are left unrun (the seam names
  // itself); null when the eligibility rests on a qualification.
  const vouched = switches?.vouched ?? null;
  const row = mode === 'run' ? thisStartsRow(db) : undefined;
  let checks: CheckResult[];
  let probes: unknown[] = [];
  if (row) {
    // What this start's checks observed, forced results included.
    checks = JSON.parse(row.checks) as CheckResult[];
    probes = JSON.parse(row.probes) as unknown[];
  } else if (mode === 'run') {
    checks = HOST_CHECKS.map((id) => ({ id, result: forced[id] ?? 'not_exercised', observed: forced[id] ? `${forced[id]} (forced)` : 'not yet run at this start', required: id !== 'H13' }));
  } else {
    checks = HOST_CHECKS.map((id) => ({ id, result: forced[id] ?? 'not_exercised', observed: forced[id] ? `${forced[id]} (forced)` : null }));
  }
  const failed = checks.filter((c) => c.result === 'failed').map((c) => c.id);
  const current = currentHostQualification(db) ?? null;
  const eligible = failed.length === 0 && (vouched !== null || current !== null);
  return {
    mode,
    eligible,
    source: vouched ?? 'qualification',
    host_qualification: current?.id ?? null,
    mechanism_fingerprint: current?.mechanism_fingerprint ?? null,
    failed_checks: failed,
    checks,
    probes,
    // This start's row, active or not, and why it is not (D2 §7.1).
    this_start: row ? { id: row.id, status: row.status, lapsed_reason: row.lapsed_reason, evidence: row.evidence, bootstrap_exception: row.bootstrap_exception === 1 } : null,
    message: eligible ? null : (unqualifiedMessage(checks) ?? 'isolation unqualified: no current host qualification; real backends are refused until then.'),
  };
}

// What "current host eligibility" binds (D2 §4.1; SEAM.md §114).
export function hostEligibility(db: Db) {
  const { eligible, source, host_qualification, mechanism_fingerprint, failed_checks } = hostReport(db);
  return { eligible, source, host_qualification, mechanism_fingerprint, failed_checks };
}

// ---- qualification attempts (D2 §7.2, K10) --------------------------------------------------

export interface AttemptInput {
  backend: string;
  version: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  template: string;
  template_version: string;
  model: string;
  auth_mode: string;
  host_qualification: string | null;
  profile_fingerprint: string;
  fixture_project: string | null;
  candidate_egress: string[];
  canary_deadlines: Record<string, number>;
  spend: Record<string, unknown>;
}

// An attempt is written proposed, binding everything before any launch; the
// caller raises its qualification_approval (store/transitions/qualification.ts).
export function writeAttempt(tx: Tx, args: AttemptInput, label: Record<string, unknown> = {}): AttemptRow {
  if (args.fixture_project !== null && !tx.db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.fixture_project)) throw notFound('project', args.fixture_project);
  if (args.host_qualification !== null && !getHostRow(tx.db, args.host_qualification)) throw notFound('host qualification', args.host_qualification);
  const id = tx.newId('qa_');
  tx.db
    .prepare(
      `INSERT INTO "qualification_attempts" ("id", "created_at", "backend", "version", "binary_path", "binary_sha256", "help_sha256", "template", "template_version",
         "model", "auth_mode", "host_qualification", "profile_fingerprint", "fixture_project", "candidate_egress", "canary_deadlines", "spend", "status")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
    )
    .run(
      id,
      tx.at,
      args.backend,
      args.version,
      args.binary_path,
      args.binary_sha256,
      args.help_sha256,
      args.template,
      args.template_version,
      args.model,
      args.auth_mode,
      args.host_qualification,
      args.profile_fingerprint,
      args.fixture_project,
      JSON.stringify(args.candidate_egress),
      JSON.stringify(args.canary_deadlines),
      JSON.stringify(args.spend),
    );
  tx.emit('qualification.proposed', { project: args.fixture_project, qualification_attempt: id }, { ...label, backend: args.backend, version: args.version, model: args.model });
  return getAttempt(tx.db, id)!;
}

function moveAttempt(tx: Tx, a: AttemptRow, to: AttemptRow['status'], extra: Record<string, unknown> = {}): void {
  assertEdge('QualificationAttemptStatus', a.status, to, { qualification_attempt: a.id });
  const sets = Object.keys(extra).map((k) => `"${k}" = ?`);
  tx.db.prepare(`UPDATE "qualification_attempts" SET ${['"status" = ?', ...sets].join(', ')} WHERE "id" = ?`).run(to, ...Object.values(extra), a.id);
}

// The consumption of the attempt's qualification_approval (D2 §7.2, Q7).
export function authorizeAttempt(tx: Tx, a: AttemptRow, decision: string | null, label: Record<string, unknown> = {}): void {
  moveAttempt(tx, a, 'authorized', { decision });
  tx.emit('qualification.authorized', { project: a.fixture_project, qualification_attempt: a.id, decision }, label);
}

export function startAttempt(tx: Tx, args: { attempt: string }): AttemptRow {
  const a = getAttempt(tx.db, args.attempt);
  if (!a) throw notFound('qualification attempt', args.attempt);
  moveAttempt(tx, a, 'running');
  return getAttempt(tx.db, a.id)!;
}

// A change to a bound dependency invalidates the attempt (D2 §7.2); a replay
// is a new attempt with a new approval.
export function invalidateAttempt(tx: Tx, a: AttemptRow, reason: string, label: Record<string, unknown> = {}): void {
  if (a.status === 'invalidated' || a.status === 'succeeded' || a.status === 'failed') return;
  moveAttempt(tx, a, 'invalidated', { invalidated_reason: reason });
  tx.emit('qualification.finished', { project: a.fixture_project, qualification_attempt: a.id }, { ...label, status: 'invalidated', reason });
}

export function finishAttempt(
  tx: Tx,
  a: AttemptRow,
  args: { outcome: 'succeeded' | 'failed'; canaries: unknown[]; unexpected_contacts?: unknown[]; trust_entry?: string | null },
  label: Record<string, unknown> = {},
): void {
  moveAttempt(tx, a, args.outcome, {
    canaries: JSON.stringify(args.canaries),
    unexpected_contacts: JSON.stringify(args.unexpected_contacts ?? []),
    trust_entry: args.trust_entry ?? null,
  });
  tx.emit('qualification.finished', { project: a.fixture_project, qualification_attempt: a.id }, { ...label, status: args.outcome, trust_entry: args.trust_entry ?? null });
}

// What a qualification_approval binds (D2 A.7; SEAM.md §117).
export function attemptManifest(db: Db, a: AttemptRow): Record<string, unknown> {
  return {
    attempt_status: a.status,
    binary_sha256: a.binary_sha256,
    help_sha256: a.help_sha256,
    template: a.template,
    template_version: a.template_version,
    model: a.model,
    auth_mode: a.auth_mode,
    host_qualification: a.host_qualification,
    host_eligibility: hostEligibility(db),
    fixture_project: a.fixture_project,
    candidate_egress: json<string[]>(a.candidate_egress),
    canary_deadlines: json<Record<string, number>>(a.canary_deadlines),
    spend: json<Record<string, unknown>>(a.spend),
  };
}

// ---- trust entries (D2 §§4.1, 4.2) ----------------------------------------------------------

export interface EntryInput {
  backend: string;
  version: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  mode: string;
  template: string;
  template_version: string;
  model: string;
  auth_mode: string;
  capabilities: { tools: string[]; denied: string[]; features_disabled: string[]; delegation_verified: boolean };
  host_id: string;
  host_qualification: string | null;
  isolation: string;
  boundary: string;
  profile_fingerprint: string;
  egress_hosts: string[];
  usage_granularity: string;
  usage_semantics: string | null;
  cost_reporting: string;
  enforceable_boundaries: Boundary[];
  result_channel: string;
  session_qualified: boolean;
  provider_files: { locations: string[]; persistence_flags: string[]; excluded: string[] };
  term_to_exit_ms: number | null;
  qualification_attempt: string;
  evidence: string[];
}

const entryInvalid = (field: string, why: string) =>
  new Refusal(400, 'invalid_value', `The trust entry's "${field}" ${why}.`, 'Nothing was written: an entry records only what qualification established.', { field });

const publishedRecord = (db: Db, id: unknown): boolean => typeof id === 'string' && db.prepare('SELECT 1 FROM "records" WHERE "id" = ? AND "published" = 1').get(id) !== undefined;

// What an entry may claim (D2 §4.2, K6; AR B06): reporting and enforcement
// apart; each enforceable boundary with its mechanism, its evidence record
// and its overshoot. `invocation` is enforced by the dispatch-time budget
// check and the deadline, for an entry whose usage is reported at all; a
// finer boundary only by admission control or a stated maximum of
// additional calls after exhaustion, never by per-call usage events alone.
export function validateEntry(db: Db, e: EntryInput): void {
  if (e.isolation !== ISOLATION_MECHANISM) throw entryInvalid('isolation', `must be ${ISOLATION_MECHANISM}, the sandbox of D2 §2.2`);
  if (e.boundary !== BOUNDARY_MECHANISM) throw entryInvalid('boundary', `must be ${BOUNDARY_MECHANISM}, the boundary of D2 §3.1`);
  if (!(USAGE_GRANULARITIES as readonly string[]).includes(e.usage_granularity)) throw entryInvalid('usage_granularity', `must be one of ${USAGE_GRANULARITIES.join(', ')}`);
  if (!(COST_REPORTING as readonly string[]).includes(e.cost_reporting)) throw entryInvalid('cost_reporting', `must be one of ${COST_REPORTING.join(', ')}`);
  if (e.session_qualified) throw entryInvalid('session_qualified', 'is never true: one-shot qualification never establishes continuation');
  if (!Array.isArray(e.evidence) || e.evidence.length === 0 || !e.evidence.every((r) => publishedRecord(db, r))) throw entryInvalid('evidence', 'must name published records');
  if (!Array.isArray(e.enforceable_boundaries)) throw entryInvalid('enforceable_boundaries', 'must be an array');
  for (const [i, b] of e.enforceable_boundaries.entries()) {
    const at = 'enforceable_boundaries';
    const which = `boundary ${i + 1}`;
    if (typeof b !== 'object' || b === null) throw entryInvalid(at, `${which} must be an object`);
    if (!(BUDGET_BOUNDARIES as readonly string[]).includes(b.boundary)) throw entryInvalid(at, `${which} must be one of ${BUDGET_BOUNDARIES.join(', ')}`);
    if (!(ENFORCEMENT_MECHANISMS as readonly string[]).includes(b.mechanism)) throw entryInvalid(at, `${which} must have a mechanism among ${ENFORCEMENT_MECHANISMS.join(', ')}`);
    if (!publishedRecord(db, b.evidence)) throw entryInvalid(at, `${which} must name a published evidence record`);
    if (b.overshoot === undefined || b.overshoot === null || b.overshoot === '') throw entryInvalid(at, `${which} must state its overshoot`);
    if (e.usage_granularity === 'none') throw entryInvalid(at, `${which} cannot be claimed by an entry whose usage is not reported`);
    if (b.boundary === 'invocation' && b.mechanism !== 'dispatch_check') throw entryInvalid(at, `${which}: the invocation boundary is enforced by dispatch_check`);
    if (b.boundary !== 'invocation' && b.mechanism !== 'admission_control') {
      throw entryInvalid(at, `${which}: ${b.boundary} is enforceable only with admission control and its evidence (D2 §4.2)`);
    }
  }
}

// The fingerprint of what was qualified (D2 §4.1): the template, the
// capabilities, the authentication mode, the egress policy and the profile,
// with the binary, and the content of every evidence record, not their
// identifiers alone.
export function evidenceFingerprint(db: Db, e: Pick<EntryInput, 'template' | 'template_version' | 'capabilities' | 'auth_mode' | 'egress_hosts' | 'profile_fingerprint' | 'binary_sha256' | 'help_sha256' | 'mode' | 'model' | 'evidence'>): string {
  const evidence = e.evidence.map((id) => (db.prepare('SELECT "sha256" FROM "records" WHERE "id" = ?').get(id) as { sha256: string | null } | undefined)?.sha256 ?? null);
  return sha256(
    canonical({
      template: e.template,
      template_version: e.template_version,
      capabilities: e.capabilities,
      auth_mode: e.auth_mode,
      egress_hosts: [...e.egress_hosts].sort(),
      profile_fingerprint: e.profile_fingerprint,
      binary_sha256: e.binary_sha256,
      help_sha256: e.help_sha256,
      mode: e.mode,
      model: e.model,
      evidence,
    }),
  );
}

// An entry is written proposed, by a succeeded attempt only (or a harness
// fixture standing for one); the caller raises its trust_activation.
export function writeEntry(tx: Tx, e: EntryInput, label: Record<string, unknown> = {}): EntryRow {
  validateEntry(tx.db, e);
  const attempt = getAttempt(tx.db, e.qualification_attempt);
  if (!attempt) throw notFound('qualification attempt', e.qualification_attempt);
  if (e.host_qualification !== null && !getHostRow(tx.db, e.host_qualification)) throw notFound('host qualification', e.host_qualification);
  const id = tx.newId('trust_');
  tx.db
    .prepare(
      `INSERT INTO "trust_entries" ("id", "created_at", "backend", "version", "binary_path", "binary_sha256", "help_sha256", "mode", "template", "template_version",
         "model", "auth_mode", "capabilities", "host_id", "host_qualification", "isolation", "boundary", "profile_fingerprint", "egress_hosts", "usage_granularity",
         "usage_semantics", "cost_reporting", "enforceable_boundaries", "result_channel", "session_qualified", "provider_files", "term_to_exit_ms",
         "qualification_attempt", "evidence", "evidence_fingerprint", "status")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'proposed')`,
    )
    .run(
      id,
      tx.at,
      e.backend,
      e.version,
      e.binary_path,
      e.binary_sha256,
      e.help_sha256,
      e.mode,
      e.template,
      e.template_version,
      e.model,
      e.auth_mode,
      JSON.stringify(e.capabilities),
      e.host_id,
      e.host_qualification,
      e.isolation,
      e.boundary,
      e.profile_fingerprint,
      JSON.stringify(e.egress_hosts),
      e.usage_granularity,
      e.usage_semantics,
      e.cost_reporting,
      JSON.stringify(e.enforceable_boundaries),
      e.result_channel,
      JSON.stringify(e.provider_files),
      e.term_to_exit_ms,
      e.qualification_attempt,
      JSON.stringify(e.evidence),
      evidenceFingerprint(tx.db, e),
    );
  tx.emit('trust.proposed', { trust_entry: id, qualification_attempt: attempt.id }, { ...label, backend: e.backend, version: e.version, mode: e.mode });
  return getEntry(tx.db, id)!;
}

// The consumption of trust_activation (D2 §4.1, A.4): `active`, with the
// decision that activated it. The store's trigger refuses this write without
// that consumed decision. Nothing is launched.
export function activateEntry(tx: Tx, entry: EntryRow, decision: string): void {
  assertEdge('TrustStatus', entry.status, 'active', { trust_entry: entry.id });
  tx.db.prepare(`UPDATE "trust_entries" SET "status" = 'active', "activated_by" = ? WHERE "id" = ?`).run(decision, entry.id);
  tx.emit('trust.activated', { trust_entry: entry.id, decision }, { backend: entry.backend, version: entry.version });
}

// D2 §7.3: revocation refuses new dispatch and touches no running domain.
export function revokeEntry(tx: Tx, entry: EntryRow, reason: string, label: Record<string, unknown> = {}): void {
  if (entry.status === 'revoked') return;
  assertEdge('TrustStatus', entry.status, 'revoked', { trust_entry: entry.id });
  tx.db.prepare(`UPDATE "trust_entries" SET "status" = 'revoked', "revoked_at" = ?, "revoked_reason" = ? WHERE "id" = ?`).run(tx.at, reason, entry.id);
  tx.emit('trust.revoked', { trust_entry: entry.id }, { ...label, reason });
}

// The state of an evidence record as a decision binds it (SEAM.md §§77, 117).
function evidenceState(db: Db, id: string): { record: string; quarantined: boolean | null; missing: boolean } {
  const row = db.prepare('SELECT "missing_at", "post_scan" FROM "records" WHERE "id" = ?').get(id) as { missing_at: string | null; post_scan: string } | undefined;
  return { record: id, quarantined: row ? row.post_scan === 'hit' : null, missing: row ? row.missing_at !== null : true };
}

// What a trust_activation binds (D2 A.7; SEAM.md §117): the binary and help
// hashes, the template, the capabilities, the profile fingerprint, the host
// identity and its current eligibility, the entry's status, and its
// evidence with the fingerprint over it.
export function entryManifest(db: Db, entry: EntryRow): Record<string, unknown> {
  return {
    entry_status: entry.status,
    binary_sha256: entry.binary_sha256,
    help_sha256: entry.help_sha256,
    template: entry.template,
    template_version: entry.template_version,
    capabilities: json<unknown>(entry.capabilities),
    profile_fingerprint: entry.profile_fingerprint,
    host_id: entry.host_id,
    host_eligibility: hostEligibility(db),
    evidence: json<string[]>(entry.evidence).map((id) => evidenceState(db, id)),
    evidence_fingerprint: entry.evidence_fingerprint,
  };
}

export const entryEvidence = (entry: EntryRow): string[] => [...json<string[]>(entry.evidence), ...json<Boundary[]>(entry.enforceable_boundaries).map((b) => b.evidence)];

// ---- the dispatch rule (D2 §§1.8, 4.1, 4.2, K10) ----------------------------------------------

const rank = (b: string): number => (BUDGET_BOUNDARIES as readonly string[]).indexOf(b);

export type Resolution =
  | { kind: 'scripted'; backend: string; version: string; model: string }
  | { kind: 'entry'; backend: string; version: string; model: string; entry: EntryRow }
  | { kind: 'refused'; backend: string; version: string; model: string; code: string; reason: string; what_to_do: string; subject: Record<string, unknown> };

const ROLE_KEY: Record<string, string> = { builder: 'backend_builder', verifier: 'backend_verifier', reviewer: 'backend_reviewer', architect: 'backend_architect' };

// The backend a role of a project is dispatched to, or why it is refused,
// before any domain or process (D2 §4.1; SEAM.md §116). The role's backend
// key names it, `scripted` by default, which only harness mode provides. A
// real backend needs an active entry for its name and the policy's mode on
// this host; session mode is refused with no fallback (§1.8); an authorized
// qualification attempt is never considered (K10). Then the policy's budget
// boundary must be one the entry enforces (§4.2), and the host must be
// eligible (§4.1).
export function resolveBackend(db: Db, args: { project: string; role: string; scripted: string | null }): Resolution {
  const options = projectOptions(db, args.project) as unknown as Record<string, string>;
  const backend = options[ROLE_KEY[args.role] ?? ''] ?? 'scripted';
  const mode = options.backend_mode ?? 'one_shot_headless';
  const required = options.budget_run_boundary ?? 'invocation';
  const refuse = (code: string, reason: string, whatToDo: string, subject: Record<string, unknown>, version = 'unqualified', model = backend): Resolution => ({
    kind: 'refused',
    backend,
    version,
    model,
    code,
    reason,
    what_to_do: whatToDo,
    subject,
  });
  const backendRefused = (reason: string, subject: Record<string, unknown> = {}) =>
    refuse('backend_refused', reason, `Qualify ${backend} on this host and have its trust entry activated, or name another backend for the ${args.role} role.`, { backend, role: args.role, mode, ...subject });

  if (mode !== 'one_shot_headless') return backendRefused(`Session mode is refused on every backend in M2 (D2 §1.8); ${backend} is not run one-shot in its place.`);
  if (backend === 'scripted') {
    if (args.scripted === null) return backendRefused('No backend is qualified for this role: the scripted backend is not available to this engine.');
    return { kind: 'scripted', backend, version: args.scripted, model: 'scripted' };
  }
  const running = hostIdentity();
  const entry = db
    .prepare(`SELECT * FROM "trust_entries" WHERE "backend" = ? AND "mode" = ? AND "status" = 'active' AND "host_id" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1`)
    .get(backend, mode, running ?? '') as EntryRow | undefined;
  if (!entry) {
    const known = db.prepare(`SELECT "status" FROM "trust_entries" WHERE "backend" = ? ORDER BY "created_at" DESC, "id" DESC LIMIT 1`).get(backend) as { status: string } | undefined;
    return backendRefused(known ? `${backend} has no active trust entry on this host (its latest is ${known.status}).` : `${backend} has no trust entry.`, { trust_entry_status: known?.status ?? null });
  }
  const boundaries = json<Boundary[]>(entry.enforceable_boundaries);
  if (!boundaries.some((b) => rank(b.boundary) >= 0 && rank(b.boundary) <= rank(required))) {
    return refuse(
      'budget_boundary_unenforceable',
      `The project requires its budget to be stopped at the ${required} boundary; ${backend}'s trust entry enforces only ${boundaries.map((b) => b.boundary).join(', ') || 'none'}, and within an invocation overshoot is bounded by the deadline alone.`,
      `Set budget_run_boundary to a boundary the entry enforces (${boundaries.map((b) => b.boundary).join(', ') || 'none'}), or qualify an entry that enforces ${required}.`,
      {
        required,
        trust_entry: entry.id,
        enforceable_boundaries: boundaries.map((b) => ({ boundary: b.boundary, mechanism: b.mechanism, evidence: b.evidence, overshoot: b.overshoot })),
        overshoot: { bounded_by: 'deadline' },
      },
      entry.version,
      entry.model,
    );
  }
  const report = hostReport(db);
  const host = hostEligibility(db);
  if (!host.eligible) {
    return refuse(
      'isolation_unqualified',
      `${report.message ?? 'isolation unqualified'} No current host qualification makes this host eligible to run ${backend}${host.failed_checks.length > 0 ? ` (failed: ${host.failed_checks.join(', ')})` : ''}.`,
      'Start the engine where the host checks pass; real backends are refused until then.',
      { trust_entry: entry.id, host_eligibility: host, checks: report.checks.filter((c) => c.result !== 'passed').map((c) => c.id) },
      entry.version,
      entry.model,
    );
  }
  return { kind: 'entry', backend, version: entry.version, model: entry.model, entry };
}

// ---- reads ---------------------------------------------------------------------------------

const entryView = (e: EntryRow) => ({
  id: e.id,
  backend: e.backend,
  version: e.version,
  mode: e.mode,
  model: e.model,
  status: e.status,
  binary_path: e.binary_path,
  binary_sha256: e.binary_sha256,
  template_version: e.template_version,
  usage_granularity: e.usage_granularity,
  cost_reporting: e.cost_reporting,
  // D2 §4.2: what the engine can stop at, each with mechanism, evidence and
  // overshoot, apart from how often usage is reported.
  enforceable_boundaries: json<Boundary[]>(e.enforceable_boundaries).map((b) => ({ boundary: b.boundary, mechanism: b.mechanism, evidence: b.evidence, overshoot: b.overshoot })),
  isolation: e.isolation,
  boundary: e.boundary,
  host_id: e.host_id,
  qualification_attempt: e.qualification_attempt,
  evidence_fingerprint: e.evidence_fingerprint,
  activated_by: e.activated_by,
  revoked_at: e.revoked_at,
  revoked_reason: e.revoked_reason,
});

// GET /v1/engine's trust part (D2 A.7; SEAM.md §118): the backends a dispatch
// may use now, every entry and attempt, and the host's qualification.
export function trustView(db: Db, args: { scripted: boolean }) {
  const host = hostReport(db);
  const running = hostIdentity();
  const entries = db.prepare('SELECT * FROM "trust_entries" ORDER BY "created_at", "id"').all() as EntryRow[];
  const attempts = db.prepare('SELECT * FROM "qualification_attempts" ORDER BY "created_at", "id"').all() as AttemptRow[];
  const active = host.eligible ? [...new Set(entries.filter((e) => e.status === 'active' && e.host_id === running).map((e) => e.backend))].sort() : [];
  return {
    backends: [...(args.scripted ? ['scripted'] : []), ...active],
    host_qualification: host,
    trust_entries: entries.map(entryView),
    qualification_attempts: attempts.map((a) => ({
      id: a.id,
      backend: a.backend,
      version: a.version,
      model: a.model,
      status: a.status,
      fixture_project: a.fixture_project,
      host_qualification: a.host_qualification,
      decision: a.decision,
      trust_entry: a.trust_entry,
      invalidated_reason: a.invalidated_reason,
    })),
  };
}
