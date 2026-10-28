// The trust table and what it rests on, the store's side (D2 §§4.1, 4.2,
// 7.1 to 7.3, K10, A.3, A.4): host qualifications, qualification attempts and
// trust entries, their transitions, what the two decisions about them bind,
// and the dispatch rule. Nothing here starts a process: an attempt's canaries
// and a host's checks are run elsewhere, and answering either decision
// launches nothing (CH incident 10).

import { sameModel } from '../../invoke/adapters/model.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BACKEND_ROLE_KEYS, BUDGET_BOUNDARIES, REAL_BACKEND_NAMES } from '../../config/schema.js';
import { Refusal } from '../../refusal.js';
import { seamHostChecks, seamTemplateVersions } from '../../testing/seam.js';
import { BOUNDARY_MECHANISM, HOST_CHECKS, ISOLATION_MECHANISM, hostIdentity } from '../../trust/host.js';
import { canonical, notFound, sha256 } from './common.js';
import { assertEdge } from './lifecycle.js';
import { type RoleProfile, defaultProfileMax, effectiveProfileMax, engineSettings, projectOptions, roleModel, roleProfileOf } from './settings.js';
import { purposeOfTemplateVersion, templateOf } from '../../invoke/adapters/templates.js';
import type { Tx } from './tx.js';
import { attemptAdmission, outstandingReservation } from './qualification-budget.js';

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
  // M5 slice 33 (D6 §2.6; migration 0026).
  mode: 'one_shot_headless' | 'session_headless';
  session_entry: string | null;
  // Codex's `codex features list` (D2 §4.6, D2-T13; migration 0042): its
  // standard output and SHA-256; null for a backend that has none.
  feature_inventory?: string | null;
  feature_inventory_sha256?: string | null;
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
export const getHostRow = (db: Db, id: string): HostQualificationRow | undefined =>
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
  // D2 §4.1: an active entry qualified under another mechanism needs
  // requalification. Each found so at this start is recorded with the
  // qualification that makes it so (real loop run 4: a package upgrade
  // changed the mechanism mid-run); dispatch to it is refused, and the work
  // it refuses held, until an entry of this mechanism is active.
  if (active) {
    const stale = staleEntries(tx.db, { host_id: args.host_id, mechanism_fingerprint: args.mechanism_fingerprint });
    tx.emit('host.qualified', { host_qualification: id }, { ...label, mechanism_fingerprint: args.mechanism_fingerprint, incarnation: args.incarnation, requalification_required: stale });
  }
  return getHostRow(tx.db, id)!;
}

// The active entries of this host qualified under a host qualification whose
// mechanism fingerprint is not `now`'s (D2 §4.1: "an incompatible mechanism
// ... requires requalification"), each with what the owner's requalification
// names. An entry with no host qualification of record (the kernel lane's
// fixtures) is not judged.
export function staleEntries(db: Db, now: { host_id: string; mechanism_fingerprint: string }) {
  const rows = db.prepare(`SELECT * FROM "trust_entries" WHERE "status" = 'active' AND "host_id" = ? AND "host_qualification" IS NOT NULL ORDER BY rowid, "id"`).all(now.host_id) as EntryRow[];
  return rows.flatMap((e) => {
    const then = getHostRow(db, e.host_qualification!);
    if (then && then.mechanism_fingerprint === now.mechanism_fingerprint) return [];
    return [{ trust_entry: e.id, backend: e.backend, model: e.model, auth_mode: e.auth_mode, entry_mechanism_fingerprint: then?.mechanism_fingerprint ?? null, command: requalifyCommand(db, e) }];
  });
}

// The exact `surety qualify` command that asks for an attempt with what the
// entry was qualified with (D2 §7.2): its backend, mode, model,
// authentication mode, egress list and its attempt's canary deadlines; and
// what the command has no flag for (a role profile other than the default,
// a continuation canary's deadline), named for POST /v1/trust/qualify. It
// proposes the attempt only: nothing runs before the owner's
// qualification_approval (Q7), and the entry it writes is active only by
// the owner's trust_activation.
export function requalifyCommand(db: Db, e: EntryRow): string {
  const attempt = getAttempt(db, e.qualification_attempt);
  const deadlines = (() => {
    try {
      return JSON.parse(attempt?.canary_deadlines ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  })();
  const egress = (() => {
    try {
      return JSON.parse(e.egress_hosts) as string[];
    } catch {
      return [];
    }
  })();
  const mode = e.session_qualified === 1 ? 'session_headless' : 'one_shot_headless';
  const parts = ['surety', 'qualify', e.backend, '--mode', mode, '--model', e.model, '--auth-mode', e.auth_mode];
  for (const h of egress) parts.push('--egress', h);
  for (const k of ['positive', 'cancellation', 'containment']) if (Number.isSafeInteger(deadlines[k])) parts.push('--canary-deadline', `${k}=${deadlines[k]}`);
  const extra: string[] = [];
  const profile = (() => {
    try {
      return JSON.parse((e as EntryRow & { profile?: string | null }).profile ?? 'null') as RoleProfile | null;
    } catch {
      return null;
    }
  })();
  if (profile !== null && profile.memory_max !== defaultProfileMax('role')) extra.push(`"role_memory_max": ${profile.memory_max}`);
  if (mode === 'session_headless' && Number.isSafeInteger(deadlines.continuation)) extra.push(`"canary_deadlines": {"continuation": ${deadlines.continuation}}`);
  const command = parts.join(' ');
  return extra.length === 0 ? command : `${command} (the command has no flag for ${extra.join(' and ')}: send them to POST /v1/trust/qualify with the same fields)`;
}

export interface CheckResult {
  id: string;
  result: 'passed' | 'failed' | 'not_exercised';
  observed: string | null;
  remedy?: string | null;
  required?: boolean;
}

// What this start's checks observed (D2 §6; SEAM.md §123), held by the store
// worker for the engine read and the dispatch rule: a start whose checks do
// not all pass writes no row (D2 §7.1, "a pass writes a row"), and what it
// observed is still readable.
export interface HostObserved {
  checks: CheckResult[];
  probes: unknown[];
  duration_ms: number | null;
  scope_cgroup: string | null;
  wsl2: boolean;
  // The role profile's fingerprint this start qualified (its mount plan and
  // volatile bounds without the domain's own paths; D2 §§2.3, 4.1).
  profile_fingerprint?: string | null;
  // The host's facts this start read (host id, kernel, tool versions,
  // mechanism fingerprint), whatever its checks found: what an adapter
  // qualification is matched on (E129 item 8; the slice-29 review, m8).
  facts?: { host_id: string; kernel: string; tool_versions: Record<string, unknown>; mechanism_fingerprint: string } | null;
}

let observed: HostObserved | null = null;

export function setHostObserved(value: HostObserved): void {
  observed = value;
}

// The role profile's fingerprint this start's checks observed, or null when
// they did not run (the kernel lane) or could not build it.
export const currentProfileFingerprint = (): string | null => observed?.profile_fingerprint ?? null;
// The host's facts this start's checks read, or null when they did not run.
export const observedHostFacts = (): HostObserved['facts'] => observed?.facts ?? null;

// The checks that decide eligibility: H1 to H12, H10 only on WSL2 (D2 §6).
export const isRequired = (id: string, wsl2: boolean): boolean => id !== 'H13' && (id !== 'H10' || wsl2);

export function isWsl2(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

// The first blocking check in H order, in D2 §6's shape: `isolation
// unqualified: <id> <failed|not_exercised>: <observed>; <remedy>; real
// backends are refused until then.`
export function unqualifiedMessage(checks: CheckResult[], wsl2: boolean): string | null {
  const first = checks.find((c) => isRequired(c.id, wsl2) && c.result !== 'passed');
  if (!first) return null;
  return `isolation unqualified: ${first.id} ${first.result}: ${first.observed ?? 'nothing was observed'}; ${first.remedy ?? 'see GET /v1/engine'}; real backends are refused until then.`;
}

// The host checks as this engine reports them (D2 §6; SEAM.md §§114, 118,
// 123). Under the harness's `unrun` switch the checks are not run and the
// host's eligibility is the harness's say-so (source `harness`); otherwise it
// rests on a current active host qualification (source `qualification`),
// which only a start whose every required check passed writes.
export function hostReport(db: Db) {
  const switches = seamHostChecks();
  const mode = switches?.mode ?? 'run';
  const forced = switches?.forced ?? {};
  const vouched = switches?.vouched ?? null;
  const wsl2 = observed?.wsl2 ?? isWsl2();
  const current = currentHostQualification(db) ?? null;
  let checks: CheckResult[];
  if (mode === 'run' && observed) checks = observed.checks;
  // Without this start's observation in hand, an active row's own checks are
  // the ones that qualified it.
  else if (mode === 'run' && current) checks = JSON.parse(current.checks) as CheckResult[];
  else if (mode === 'run') {
    checks = HOST_CHECKS.map((id) => ({ id, result: forced[id] ?? 'not_exercised', observed: null, remedy: 'wait for the host_qualification startup step to finish' }));
  } else {
    checks = HOST_CHECKS.map((id) => ({ id, result: forced[id] ?? 'not_exercised', observed: forced[id] ? `${forced[id]} (forced)` : null, remedy: null }));
  }
  const failed = checks.filter((c) => c.result === 'failed').map((c) => c.id);
  const notExercised =
    mode === 'run' ? checks.filter((c) => c.result === 'not_exercised' && isRequired(c.id, wsl2)).map((c) => c.id) : Object.keys(forced).filter((id) => forced[id] === 'not_exercised');
  const eligible = failed.length === 0 && (vouched !== null || (notExercised.length === 0 && current !== null));
  return {
    mode,
    eligible,
    source: vouched ?? 'qualification',
    host_qualification: current?.id ?? null,
    mechanism_fingerprint: current?.mechanism_fingerprint ?? null,
    failed_checks: failed,
    not_exercised_checks: notExercised,
    wsl2,
    checks,
    probes: mode === 'run' ? (observed?.probes ?? []) : [],
    // The role profile this start qualified (SEAM.md §150), null when the
    // checks did not run.
    profile_fingerprint: mode === 'run' ? (observed?.profile_fingerprint ?? null) : null,
    message: eligible ? null : mode === 'run' ? (unqualifiedMessage(checks, wsl2) ?? 'isolation unqualified: no current host qualification; real backends are refused until then.') : null,
    scope_cgroup: mode === 'run' ? (observed?.scope_cgroup ?? null) : null,
    duration_ms: mode === 'run' ? (observed?.duration_ms ?? null) : null,
  };
}

// What "current host eligibility" binds (D2 §4.1; SEAM.md §§114, 123).
export function hostEligibility(db: Db) {
  const { eligible, source, host_qualification, mechanism_fingerprint, failed_checks, not_exercised_checks } = hostReport(db);
  return { eligible, source, host_qualification, mechanism_fingerprint, failed_checks, not_exercised_checks };
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
  // D6 §2.6: `session_headless` adds the continuation canary; with
  // `session_entry` it runs alone and qualifies that entry for sessions.
  mode?: 'one_shot_headless' | 'session_headless';
  session_entry?: string | null;
  // D6-X09 (B09; SEAM.md §432): the role profile the attempt qualifies;
  // the engine's default under its ceiling when absent.
  profile?: RoleProfile | null;
  // Codex's feature inventory (D2 §4.6; migration 0042), or none.
  feature_inventory?: { text: string; sha256: string } | null;
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
         "model", "auth_mode", "host_qualification", "profile_fingerprint", "fixture_project", "candidate_egress", "canary_deadlines", "spend", "status", "mode", "session_entry", "profile",
         "feature_inventory", "feature_inventory_sha256")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
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
      args.mode ?? 'one_shot_headless',
      args.session_entry ?? null,
      args.profile === null ? null : JSON.stringify(args.profile ?? roleProfileOf(defaultProfileMax('role'))),
      args.feature_inventory?.text ?? null,
      args.feature_inventory?.sha256 ?? null,
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
  tx.emit('qualification.finished', { project: a.fixture_project, qualification_attempt: a.id }, { ...label, status: 'invalidated', outcome: 'invalidated', code: null, failure_class: null, reason });
}

// What of an attempt's binding no longer holds (D2 §7.2; SEAM.md §148): its
// binary's bytes (read here), its template's version, the host
// qualification it was proposed under. Its help is checked by the main
// thread before each dispatch. null when nothing changed.
export function attemptDrift(db: Db, a: AttemptRow): string | null {
  const now = currentBinarySha(a.binary_path);
  if (now !== a.binary_sha256) return 'binary_changed';
  const t = templateOf(a.backend, { scripted: true, versions: seamTemplateVersions(), authMode: a.auth_mode, purpose: purposeOfTemplateVersion(a.template_version) });
  if (!t || t.version !== a.template_version) return 'template_changed';
  const hq = currentHostQualification(db);
  if (!hq || hq.id !== a.host_qualification || hostIdentity() === null) return 'host_changed';
  return null;
}

export function currentBinarySha(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

// Every attempt not yet dispatching whose binding changed is invalidated
// (within the ticks); its open approval then goes as its subject does.
export function sweepAttempts(tx: Tx): string[] {
  const rows = tx.db.prepare(`SELECT * FROM "qualification_attempts" WHERE "status" IN ('proposed', 'authorized')`).all() as AttemptRow[];
  const out: string[] = [];
  for (const a of rows) {
    const reason = attemptDrift(tx.db, a);
    if (reason === null) continue;
    invalidateAttempt(tx, a, reason);
    out.push(a.id);
  }
  return out;
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
  const failed = (args.canaries as { passed?: boolean; failure_class?: string | null }[]).find((c) => c.passed === false);
  tx.emit(
    'qualification.finished',
    { project: a.fixture_project, qualification_attempt: a.id },
    { ...label, status: args.outcome, outcome: args.outcome, code: args.outcome === 'failed' ? 'qualification_failed' : null, failure_class: failed?.failure_class ?? null, trust_entry: args.trust_entry ?? null },
  );
}

// What a qualification_approval binds (D2 A.7; SEAM.md §117).
export function attemptManifest(db: Db, a: AttemptRow): Record<string, unknown> {
  return {
    attempt_status: a.status,
    // The binary as it is now: a change between preview and answer stales
    // the decision (SEAM.md §148).
    binary_sha256: a.status === 'proposed' ? (currentBinarySha(a.binary_path) ?? 'unreadable') : a.binary_sha256,
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
  // `session_qualified` is established by the continuation canary alone (D6
  // §2.6; D6-S09): only an attempt whose continuation canary passed writes it.
  if (e.session_qualified) {
    const a = db.prepare('SELECT "canaries" FROM "qualification_attempts" WHERE "id" = ?').get(e.qualification_attempt) as { canaries: string | null } | undefined;
    let passed = false;
    try {
      passed = (JSON.parse(a?.canaries ?? '[]') as { kind?: string; passed?: boolean }[]).some((c) => c.kind === 'continuation' && c.passed === true);
    } catch {
      passed = false;
    }
    if (!passed) throw entryInvalid('session_qualified', 'is true only from a passing continuation canary of its qualification attempt (D6 §2.6)');
  }
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
         "qualification_attempt", "evidence", "evidence_fingerprint", "status", "profile")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
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
      // validateEntry: true only from a passing continuation canary.
      e.session_qualified ? 1 : 0,
      JSON.stringify(e.provider_files),
      e.term_to_exit_ms,
      e.qualification_attempt,
      JSON.stringify(e.evidence),
      evidenceFingerprint(tx.db, e),
      // The role profile its attempt qualified (D6-X09; B09).
      (attempt as AttemptRow & { profile?: string | null }).profile ?? null,
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

// ---- revocation on change (D2 §7.3) -----------------------------------------------------------

// Two role profiles alike in every bound (D6-X09).
export function sameProfile(a: RoleProfile | null, b: RoleProfile): boolean {
  return a !== null && typeof a === 'object' && a.memory_max === b.memory_max && a.writable_bytes === b.writable_bytes && a.writable_inodes === b.writable_inodes && a.tasks_max === b.tasks_max;
}

// What has changed of what an entry was qualified with, or null: its host's
// identity, its adapter's template version, the role profile this host now
// qualifies, its binary's bytes (when the caller hashed them: `binary`
// undefined means not read here, null that the file cannot be read).
export function entryDrift(e: EntryRow, now: { host: string | null; profile: string | null; binary?: string | null | undefined; help?: string | null | undefined }): string | null {
  if (now.host === null || e.host_id !== now.host) return 'host_changed';
  const template = templateOf(e.backend, { scripted: true, versions: seamTemplateVersions(), authMode: e.auth_mode, purpose: purposeOfTemplateVersion(e.template_version) });
  if (!template || template.version !== e.template_version) return 'template_changed';
  // The profile is judged against an entry qualified under a host
  // qualification of record; one with none (written in the kernel lane) has
  // no qualified profile on this host to differ from.
  if (now.profile !== null && e.host_qualification !== null && e.profile_fingerprint !== entryProfile(now.profile, e)) return 'profile_changed';
  if (now.binary === null) return 'binary_changed';
  if (now.binary !== undefined && now.binary !== e.binary_sha256) return 'binary_changed';
  if (now.help !== undefined && now.help !== e.help_sha256) return 'help_changed';
  return null;
}

// The profile fingerprint an entry is held to (SEAM.md §150): the role
// profile's, as this start qualified it, with the entry's egress list.
export function entryProfile(role: string, e: { egress_hosts: string }): string {
  let hosts: string[] = [];
  try {
    hosts = JSON.parse(e.egress_hosts) as string[];
  } catch {
    hosts = [];
  }
  return profileWithEgress(role, hosts);
}

export const profileWithEgress = (role: string, hosts: string[]): string => (hosts.length === 0 ? role : sha256(canonical({ role, egress: [...new Set(hosts)].sort() })));

// Every entry not already revoked whose qualification no longer holds is
// revoked (`trust.revoked`), refusing new dispatch and touching no running
// domain. `binaries` gives the SHA-256 the main thread read of each binary
// path (null: unreadable); a path not given is not judged on its bytes.
export function revokeDrifted(tx: Tx, args: { binaries?: Record<string, string | null>; helps?: Record<string, string | null>; entry?: string } = {}): string[] {
  const rows = (
    args.entry ? tx.db.prepare(`SELECT * FROM "trust_entries" WHERE "id" = ? AND "status" <> 'revoked'`).all(args.entry) : tx.db.prepare(`SELECT * FROM "trust_entries" WHERE "status" <> 'revoked'`).all()
  ) as EntryRow[];
  const revoked: string[] = [];
  const now = { host: hostIdentity(), profile: currentProfileFingerprint() };
  for (const e of rows) {
    const binary = args.binaries && e.binary_path in args.binaries ? args.binaries[e.binary_path] : undefined;
    // A help that could not be read is not judged a change of help.
    const help = args.helps && e.binary_path in args.helps && args.helps[e.binary_path] !== null ? args.helps[e.binary_path] : undefined;
    const drift = entryDrift(e, { ...now, binary, help });
    if (drift === null) continue;
    revokeEntry(tx, e, drift);
    revoked.push(e.id);
  }
  return revoked;
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

// Each role's backend key; the conversational roles' are D6 A.7's (slice 33).
// D6 A.7 (M5 slice 33; SEAM.md §391); D7 A.7 (M6): the Designer's backend
// (the slice-46 rehearsal's finding).
const ROLE_KEY: Readonly<Record<string, string>> = BACKEND_ROLE_KEYS;

// The backend a role of a project is dispatched to, or why it is refused,
// before any domain or process (D2 §4.1; SEAM.md §116). The role's backend
// key names it: `scripted` by default only in harness mode, which alone
// provides it; elsewhere a key with no value is unconfigured and refused. A
// real backend needs an active entry for its name and the policy's mode on
// this host; session mode is refused with no fallback (§1.8); an authorized
// qualification attempt is never considered (K10). Then the policy's budget
// boundary must be one the entry enforces (§4.2), and the host must be
// eligible (§4.1).
// `model`: the model the run requests (its role's `model_<role>`, or the
// owner's at a session's opening), which selects the entry: an active entry
// whose model it is, or whose family its alias names (D6 A.7; the review's
// M1). `sessions`: only an entry qualified for sessions (D6 §2.6).
export function resolveBackend(db: Db, args: { project: string; role: string; scripted: string | null; model?: string | null; sessions?: boolean }): Resolution {
  const options = projectOptions(db, args.project) as unknown as Record<string, string | undefined>;
  const key = ROLE_KEY[args.role];
  // A role's key with no value is unconfigured: outside the test mode no
  // backend is a default (the owner's ruling of 2026-10-27), and none is
  // substituted. The dispatch is refused before any domain or process, and
  // the run records the backend as `unconfigured`.
  if (key !== undefined && typeof options[key] !== 'string') {
    return {
      kind: 'refused',
      backend: 'unconfigured',
      version: 'unqualified',
      model: 'unconfigured',
      code: 'backend_refused',
      reason: `No backend is configured for the ${args.role} role: ${key} names none, and the engine has no default provider and substitutes none. A real provider (${REAL_BACKEND_NAMES.join(' or ')}) needs configuring.`,
      what_to_do: `Qualify a real provider (${REAL_BACKEND_NAMES.join(' or ')}) on this host, have its trust entry activated, and set ${key} to it in the project's policy.`,
      subject: { backend: null, configured: false, role: args.role, key, providers: [...REAL_BACKEND_NAMES] },
    };
  }
  const backend = (key === undefined ? undefined : options[key]) ?? 'scripted';
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
  // A project role resolves a role template's entry only: the workspace
  // assistant's entries (its own template, the assistant design §3) are
  // never a role's.
  const active = (
    db
      .prepare(`SELECT * FROM "trust_entries" WHERE "backend" = ? AND "mode" = ? AND "status" = 'active' AND "host_id" = ? ORDER BY rowid DESC, "id" DESC`)
      .all(backend, mode, running ?? '') as EntryRow[]
  ).filter((e) => purposeOfTemplateVersion(e.template_version) === 'role');
  if (active.length === 0) {
    const known = (db.prepare(`SELECT "status", "template_version" FROM "trust_entries" WHERE "backend" = ? ORDER BY rowid DESC, "id" DESC`).all(backend) as { status: string; template_version: string }[]).find(
      (e) => purposeOfTemplateVersion(e.template_version) === 'role',
    );
    return backendRefused(known ? `${backend} has no active trust entry on this host (its latest is ${known.status}).` : `${backend} has no trust entry.`, { trust_entry_status: known?.status ?? null });
  }
  const model = args.model ?? roleModel(db, args.project, args.role);
  const ofModel = model === null ? active : active.filter((e) => sameModel(model, e.model));
  if (ofModel.length === 0) {
    return backendRefused(`No active ${backend} entry on this host is of the model ${model} the ${args.role} role requests (active: ${active.map((e) => e.model).join(', ')}).`, {
      model_requested: model,
      active_models: active.map((e) => e.model),
    });
  }
  // The role profile is part of the qualification identity (D6 §2.6, §6.4;
  // B09; D6-X09): an entry serves only the profile it was qualified at, the
  // project's effective role maximum with the engine's volatile and task
  // bounds. An entry written with no profile serves none (the driver's
  // ruling 4, slice 37). A project's setting revokes nothing.
  const want = roleProfileOf(effectiveProfileMax(db, args.project, 'role'));
  const ofProfile = ofModel.filter((e) => sameProfile(json<RoleProfile | null>((e as EntryRow & { profile?: string | null }).profile ?? 'null'), want));
  if (ofProfile.length === 0) {
    return backendRefused(
      `No active ${backend} entry of the model ${model ?? '(any)'} on this host is qualified for the ${args.role} role's profile (memory_max ${want.memory_max}, writable ${want.writable_bytes} bytes and ${want.writable_inodes} inodes, ${want.tasks_max} tasks).`,
      { model_requested: model, profile: want, entry_profiles: ofModel.map((e) => json<RoleProfile | null>((e as EntryRow & { profile?: string | null }).profile ?? 'null')) },
    );
  }
  const qualified = args.sessions === true ? ofProfile.filter((e) => e.session_qualified === 1) : ofProfile;
  // A session needs an entry qualified for sessions (sessions/session.ts
  // says why when none is): the newest of the model's otherwise.
  const entry = qualified[0] ?? ofProfile[0]!;
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
  if (host.eligible && report.source === 'qualification' && entry.host_qualification !== null && host.host_qualification !== null) {
    // D2 §4.1 (E62): the current qualification must be compatible with the
    // one the entry was qualified under: the same mechanism fingerprint. The
    // entry's own row is historical and normally lapsed.
    const then = getHostRow(db, entry.host_qualification);
    if (!then || then.mechanism_fingerprint !== host.mechanism_fingerprint) {
      // Not cleared by retrying (real loop run 4): the reason names the
      // entry and its model, and what to do is the exact command.
      const command = requalifyCommand(db, entry);
      return refuse(
        'backend_refused',
        `${backend}'s entry ${entry.id} for the model ${entry.model} was qualified under a host qualification whose mechanism fingerprint (${then?.mechanism_fingerprint ?? 'unknown'}) is not the current one's (${host.mechanism_fingerprint}): the host's mechanism changed, and the entry needs requalification on this host.`,
        `Requalify it: ${command}; then approve the attempt's qualification_approval and, once its canaries pass, the new entry's trust_activation. Or name another backend for the ${args.role} role.`,
        { backend, role: args.role, mode, trust_entry: entry.id, requalification_required: true, entry_mechanism_fingerprint: then?.mechanism_fingerprint ?? null, current_mechanism_fingerprint: host.mechanism_fingerprint, requalify: command },
      );
    }
  }
  if (!host.eligible) {
    return refuse(
      'isolation_unqualified',
      `${report.message ?? 'isolation unqualified'} No current host qualification makes this host eligible to run ${backend}.`,
      'Start the engine where the host checks pass; real backends are refused until then.',
      { trust_entry: entry.id, failed_checks: host.failed_checks, not_exercised_checks: host.not_exercised_checks, host_qualification: host.host_qualification, host_eligibility: host },
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
  auth_mode: e.auth_mode,
  session_qualified: e.session_qualified === 1,
  status: e.status,
  binary_path: e.binary_path,
  binary_sha256: e.binary_sha256,
  template_version: e.template_version,
  // What the entry's template is for: a project role's, or the workspace
  // assistant's (the assistant design §3).
  purpose: purposeOfTemplateVersion(e.template_version),
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
  const entries = db.prepare('SELECT * FROM "trust_entries" ORDER BY rowid, "id"').all() as EntryRow[];
  const attempts = db.prepare('SELECT * FROM "qualification_attempts" ORDER BY rowid, "id"').all() as AttemptRow[];
  const active = host.eligible ? [...new Set(entries.filter((e) => e.status === 'active' && e.host_id === running && purposeOfTemplateVersion(e.template_version) === 'role').map((e) => e.backend))].sort() : [];
  return {
    backends: [...(args.scripted ? ['scripted'] : []), ...active],
    host_qualification: host,
    trust_entries: entries.map(entryView),
    qualification_attempts: attempts.map((a) => ({
      id: a.id,
      backend: a.backend,
      version: a.version,
      model: a.model,
      purpose: purposeOfTemplateVersion(a.template_version),
      status: a.status,
      fixture_project: a.fixture_project,
      host_qualification: a.host_qualification,
      decision: a.decision,
      trust_entry: a.trust_entry,
      invalidated_reason: a.invalidated_reason,
      // The qualification budget (B2): for an attempt awaiting its approval,
      // the fit its answer is checked against (charged today, the
      // reservations of attempts already admitted, its own, the limit, when
      // the day clears); for every attempt, what it holds back of its fixture
      // project's day now (0 once converted or released).
      admission: a.status === 'proposed' ? attemptAdmission(db, a) : null,
      reserved_tokens: outstandingReservation(db, a),
    })),
  };
}
