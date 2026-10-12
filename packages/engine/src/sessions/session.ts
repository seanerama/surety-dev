// The session run's transitions (D6 §2; K6; B01; D1 §15.2, A.5; SEAM.md
// §344): open, a turn's admission, the claim its dispatch rebuilds, its
// settlement, save, close; the transcript record (one per session, its
// entries' speakers assigned here and nowhere else). A session is one run of
// kind `session` with no work item; each turn is its own invocation, domain
// and ledger row. A turn is `open_idle` only when it is settled (its domain
// terminated, its reply or failure recorded, its usage charged); each
// settlement, and each save, advances the idle generation, the one value
// save, close and the next turn's admission compare-and-swap on
// (`session_generation_stale`).
//
// Slice 31a builds the walking path (BS5 §9). Idle timeout, budget
// exhaustion, resume and the races at every settlement step are slice 33's
// (M415 to M420), which hardens what is built here.

import { Refusal } from '../refusal.js';
import { illegal, nextSeq, notFound } from '../store/transitions/common.js';
import { chargeInvocation, exhaustedLimits } from '../store/transitions/ledger.js';
import { type Claim, type RunRow, getRun } from '../store/transitions/runs.js';
import { integrationRef, projectRepoRow, registryRow } from '../store/transitions/repo.js';
import { engineSettings, projectEffective, projectPolicy } from '../store/transitions/settings.js';
import { type Resolution, resolveBackend } from '../store/transitions/trust.js';
import type { Tx } from '../store/transitions/tx.js';
import { TEMPLATES, credentialRef, keyVariable, templateOf } from '../invoke/adapters/templates.js';
import { assertEdge } from '../store/transitions/lifecycle.js';
import { raiseQuestion } from '../store/transitions/queue.js';
import type { DecisionRow } from '../store/transitions/decisions.js';
import { intendOperation } from '../store/transitions/journal.js';
import type { IntentResult } from '../store/transitions/journal.js';
import { recordSemantics } from '../spec/approval.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import type { SemanticFinding, SpecRepresentation } from '../spec/semantics.js';

export const SESSION_ROLES = ['vision', 'spec_writer', 'architect'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

// The paths each interactive role may write (D6 §2.5; F §4.1).
export const SESSION_PATHS: Record<SessionRole, readonly string[]> = {
  vision: ['.surety/idea.md'],
  spec_writer: ['.surety/spec/'],
  architect: ['.surety/architecture/', '.surety/adrs/', '.surety/roadmap/', '.surety/phases/'],
};

export type SpeakerKind = 'owner' | 'role' | 'engine';

export interface SessionRow extends RunRow {
  session_state: 'allocated' | 'open_idle' | 'turn_running' | 'saving' | 'closing' | null;
  idle_generation: number;
  turn_count: number;
  session_notes: string | null;
  backend_version: string;
}

export interface TranscriptEntry {
  turn: number;
  speaker: SpeakerKind;
  at: string;
  text_ref: string | null;
  text: string;
}

// A finding of the parse at save (SEAM.md §346): {code, path, subject, message}.
export interface SaveFinding {
  code: string;
  path: string | null;
  subject: Record<string, unknown>;
  message: string;
}

// D6 A.7's `turn_max_bytes` at its default: the key itself is slice 33's
// (the contract names no session key in slice 31).
export const TURN_MAX_BYTES = 65_536;

// The backend a session of `role` runs on (D6 §2.6; D2 §4.1): the role's,
// refused `backend_refused` for a real entry not qualified for sessions. No
// entry is until slice 33's continuation canary, so only the scripted
// backend runs a session in slice 31.
export function sessionBackend(db: Tx['db'], args: { project: string; role: string; scripted: string | null }): Resolution {
  const resolved = resolveBackend(db, args);
  if (resolved.kind !== 'entry' || resolved.entry.session_qualified === 1) return resolved;
  return {
    kind: 'refused',
    backend: resolved.backend,
    version: resolved.version,
    model: resolved.model,
    code: 'backend_refused',
    reason: `${resolved.backend}'s trust entry is not qualified for sessions (session_qualified is false): no continuation canary established it (D6 §2.6).`,
    what_to_do: `Run the ${args.role} session on a backend qualified for sessions.`,
    subject: { backend: resolved.backend, role: args.role, trust_entry: resolved.entry.id, session_qualified: false },
  };
}

const addSeconds = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

export function getSession(tx: Tx, project: string, run: string): SessionRow {
  const row = getRun(tx, run) as SessionRow | undefined;
  if (!row || row.project !== project || row.kind !== 'session') throw notFound('session', run);
  return row;
}

const notIdle = (run: SessionRow, what: string) =>
  new Refusal(409, 'session_not_idle', `Session ${run.id} is ${run.session_state ?? run.state}, not open_idle, so ${what} is refused.`, 'Wait for the current turn or save to settle, then ask again.', {
    run: run.id,
    session_state: run.session_state,
    state: run.state,
  });

const generationStale = (run: SessionRow, expected: number) =>
  new Refusal(409, 'session_generation_stale', `Session ${run.id} is at idle generation ${run.idle_generation}, not ${expected}: a save, a close or a turn won it first.`, 'Read the session and act on its current generation.', {
    run: run.id,
    idle_generation: run.idle_generation,
    expected,
  });

// ---- the transcript record (D6 §2.3; A.3; B01) ---------------------------------------------

// The entries so far: [] for a session with none yet, null when the record
// cannot be read (unknown, never empty).
export function transcriptOf(db: Tx['db'], run: string): TranscriptEntry[] | null {
  const row = db.prepare('SELECT "entries" FROM "session_transcripts" WHERE "run" = ?').get(run) as { entries: string } | undefined;
  if (!row) return [];
  try {
    const entries = JSON.parse(row.entries) as unknown;
    return Array.isArray(entries) ? (entries as TranscriptEntry[]) : null;
  } catch {
    return null;
  }
}

// What a turn's admission found of the transcript's last entry: the owner's
// entry gets its record once the record is written (after the admission, so
// a refused turn leaves no record behind).
export function attachOwnerText(tx: Tx, args: { run: string; turn: number; record: string }): void {
  const row = tx.db.prepare('SELECT "id", "entries" FROM "session_transcripts" WHERE "run" = ?').get(args.run) as { id: string; entries: string } | undefined;
  if (!row) return;
  const entries = JSON.parse(row.entries) as TranscriptEntry[];
  const entry = entries.find((e) => e.turn === args.turn && e.speaker === 'owner' && e.text_ref === null);
  if (!entry) return;
  entry.text_ref = args.record;
  tx.db.prepare('UPDATE "session_transcripts" SET "entries" = ? WHERE "id" = ?').run(JSON.stringify(entries), row.id);
}

// One entry appended by an engine transition only: the speaker and the turn
// are this function's arguments, never a role's text. `text_ref` is the
// record the main thread wrote through the redactor before the transition.
export function appendTranscript(tx: Tx, run: SessionRow, entry: { turn: number; speaker: SpeakerKind; text: string; text_ref: string | null }): void {
  const existing = tx.db.prepare('SELECT "id", "entries" FROM "session_transcripts" WHERE "run" = ?').get(run.id) as { id: string; entries: string } | undefined;
  const read = existing ? transcriptOf(tx.db, run.id) : [];
  // An unreadable record is never overwritten as if empty.
  if (read === null) throw illegal('appending to a session transcript that cannot be read', { run: run.id });
  const entries = read;
  entries.push({ turn: entry.turn, speaker: entry.speaker, at: tx.at, text_ref: entry.text_ref, text: entry.text });
  if (existing) tx.db.prepare('UPDATE "session_transcripts" SET "entries" = ? WHERE "id" = ?').run(JSON.stringify(entries), existing.id);
  else {
    const id = tx.newId('str_');
    tx.db.prepare('INSERT INTO "session_transcripts" ("id", "created_at", "project", "run", "entries") VALUES (?, ?, ?, ?, ?)').run(id, tx.at, run.project, run.id, JSON.stringify(entries));
  }
}

// ---- open (D6 §2.1, §2.7; D1 §15.2) -------------------------------------------------------

export function openSession(tx: Tx, args: { project: string; role: unknown; model?: unknown; scripted: string | null; incarnation: string }): { run: Record<string, unknown> } {
  const p = tx.db.prepare('SELECT "id", "paused", "registration_state" FROM "projects" WHERE "id" = ?').get(args.project) as { id: string; paused: number; registration_state: string } | undefined;
  if (!p) throw notFound('project', args.project);
  if (typeof args.role !== 'string' || !(SESSION_ROLES as readonly string[]).includes(args.role)) {
    throw new Refusal(400, 'invalid_value', `"role" must be one of ${SESSION_ROLES.join(', ')}.`, 'Open a session for an interactive role.', { field: 'role' });
  }
  if (args.model !== undefined && (typeof args.model !== 'string' || args.model === '')) throw new Refusal(400, 'invalid_value', '"model" must be a non-empty string.', 'Name a model, or leave it out.', { field: 'model' });
  if (p.registration_state !== 'registered') throw illegal('a session on a project that is not registered', { project: p.id, registration_state: p.registration_state });
  if (p.paused === 1) throw illegal('a session on a paused project', { project: p.id });
  // One open session per project, and no session beside a one-shot run
  // (D6 §2.7; D6-S08): no run counter, the project's own exclusivity.
  const live = tx.db.prepare(`SELECT "id", "kind", "role" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' ORDER BY "seq" LIMIT 1`).get(p.id) as { id: string; kind: string; role: string } | undefined;
  if (live) {
    throw new Refusal(409, 'session_busy', `Project ${p.id} has a ${live.kind} run (${live.id}, ${live.role}) that has not ended; one session at a time, and none beside a one-shot run.`, 'Wait for it to end, or close the open session.', {
      project: p.id,
      run: live.id,
      kind: live.kind,
    });
  }
  const role = args.role as SessionRole;
  // The backend first (D6 §2.6), then the Architect's approved
  // specification (D6 §3.3, §3.5).
  const resolved = sessionBackend(tx.db, { project: p.id, role, scripted: args.scripted });
  if (resolved.kind === 'refused') throw new Refusal(409, resolved.code, resolved.reason, resolved.what_to_do, { ...resolved.subject, role });
  if (role === 'architect' && !tx.db.prepare('SELECT 1 FROM "spec_revisions" WHERE "project" = ?').get(p.id)) {
    throw illegal('an Architect session on a project with no approved specification', { project: p.id, role });
  }
  const repo = projectRepoRow(tx, p.id);
  const head = registryRow(tx, p.id, integrationRef(repo.integration_branch));
  if (!head) throw illegal('a session on a project whose integration branch is not registered', { project: p.id });
  const policy = projectPolicy(tx.db, p.id);
  const options = projectEffective(tx.db, p.id) as Record<string, unknown>;
  const modelKey = `model_${role}`;
  const model = typeof args.model === 'string' ? args.model : typeof options[modelKey] === 'string' ? (options[modelKey] as string) : resolved.model;
  const run = tx.newId('run_');
  const seq = nextSeq(tx, p.id, 'runs');
  const idle = addSeconds(tx.at, policy.session_idle_timeout!);
  tx.db
    .prepare(
      `INSERT INTO "runs" ("id", "created_at", "project", "seq", "work_item", "role", "kind", "state", "session_state", "backend", "backend_version",
         "model_requested", "base_revision", "deadline_at", "parent_run", "quarantined", "chain", "idle_generation", "turn_count")
       VALUES (?, ?, ?, ?, NULL, ?, 'session', 'claimed', 'allocated', ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0)`,
    )
    .run(run, tx.at, p.id, seq, role, resolved.backend, resolved.version, model, head.expected_oid, idle);
  const subject = { project: p.id, run };
  tx.emit('run.created', subject, { seq, role, kind: 'session', backend: resolved.backend, base_revision: head.expected_oid, parent_run: null });
  tx.emit('run.claimed', subject, {});
  const lease = tx.newId('lease_');
  tx.db
    .prepare(
      `INSERT INTO "leases" ("id", "created_at", "resource_kind", "resource_id", "owner_incarnation", "generation", "acquired_at", "renewed_at", "expires_at", "closing", "cleanup_authority")
       VALUES (?, ?, 'run', ?, ?, 1, ?, ?, ?, 0, 0)`,
    )
    .run(lease, tx.at, run, args.incarnation, tx.at, tx.at, addSeconds(tx.at, engineSettings().lease_ttl));
  const authMode = resolved.kind === 'entry' ? resolved.entry.auth_mode : 'api_key';
  const keyRef = credentialRef(resolved.backend, authMode);
  const real = resolved.kind === 'entry';
  const grant = tx.newId('grant_');
  tx.db
    .prepare(
      `INSERT INTO "capability_grants" ("id", "created_at", "project", "run", "capabilities", "env_allowlist", "secret_refs", "issued_at", "expires_at")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grant,
      tx.at,
      p.id,
      run,
      JSON.stringify(['workspace_write']),
      JSON.stringify(['PATH', 'LANG', 'SURETY_DOMAIN', 'SURETY_INVOCATION', ...(real ? [keyVariable(resolved.backend, authMode), ...Object.keys(templateOf(resolved.backend, { authMode })?.env ?? {})] : [])]),
      JSON.stringify(real ? [keyRef] : []),
      tx.at,
      idle,
    );
  tx.db.prepare('UPDATE "runs" SET "grant" = ? WHERE "id" = ?').run(grant, run);
  tx.emit('session.allocated', subject, { role, idle_deadline_at: idle });
  return { run: runSummary(tx.db, run) };
}

function runSummary(db: Tx['db'], run: string): Record<string, unknown> {
  const r = db.prepare('SELECT "id", "project", "role", "kind", "state", "session_state", "idle_generation", "turn_count", "outcome", "reason_class", "deadline_at", "base_revision" FROM "runs" WHERE "id" = ?').get(run) as Record<string, unknown>;
  return r;
}

// ---- a turn's admission (D6 §2.2, §2.4; B01; SEAM.md §344) ---------------------------------

export interface TurnArgs {
  project: string;
  run: string;
  text: string;
  // The owner's message as a session_transcript record, written on the main
  // thread through the redactor before this transaction.
  textRecord: string | null;
  expectedGeneration?: number | null;
  incarnation: string;
  scope?: string | null;
  scripted: string | null;
}

// The claim a session turn gives the launcher: a one-shot's Claim with no
// work item and the turn named (invoke/choke.ts).
export type TurnClaim = Claim & { session: { turn: number; role: SessionRole; idle_generation: number } };

export function admitTurn(tx: Tx, args: TurnArgs): { run: string; turn: number; session_state: 'turn_running'; invocation: string } {
  const run = getSession(tx, args.project, args.run);
  if (run.state === 'ended' || run.state === 'finalizing' || run.session_state === 'closing') {
    throw new Refusal(409, 'session_not_idle', `Session ${run.id} is ${run.state === 'ended' ? 'ended' : 'closing'}; it takes no further turn.`, 'Open a new session.', { run: run.id, state: run.state });
  }
  if (run.session_state !== 'allocated' && run.session_state !== 'open_idle') throw notIdle(run, 'a turn');
  if (args.expectedGeneration !== undefined && args.expectedGeneration !== null && args.expectedGeneration !== run.idle_generation) throw generationStale(run, args.expectedGeneration);
  const bytes = Buffer.byteLength(args.text, 'utf8');
  const max = TURN_MAX_BYTES;
  if (bytes > max) {
    throw new Refusal(413, 'turn_too_large', `The turn is ${bytes} bytes, more than turn_max_bytes (${max}).`, 'Send a shorter message.', { run: run.id, bytes, turn_max_bytes: max });
  }
  // Every next turn revalidates the backend and the cumulative budget (D6
  // §2.4; D1 §13.3).
  const resolved = sessionBackend(tx.db, { project: run.project, role: run.role, scripted: args.scripted });
  if (resolved.kind === 'refused') throw new Refusal(409, resolved.code, resolved.reason, resolved.what_to_do, resolved.subject);
  const exhausted = exhaustedLimits(tx.db, run.project, { check: true, dispatch: true });
  if (exhausted.length > 0) {
    throw new Refusal(409, 'budget_exhausted', `Project ${run.project} has passed ${exhausted.join(', ')}; the session admits no further turn.`, 'Raise the limit or wait for the day to pass.', { run: run.id, limits: exhausted });
  }
  // The session's cumulative run budget (D6 §2.4; D1 §13.3): every earlier
  // turn's billable tokens, an unknown remainder counted at its allowance;
  // a turn whose usage is unknown with no allowance cannot be judged, and no
  // turn is admitted on it (never read as zero).
  const policyNow = projectPolicy(tx.db, run.project);
  // (The scripted backend's invocation with nothing observed carries no
  // allowance by D2's policy, as on any run: it is charged nothing.)
  const rows = tx.db.prepare('SELECT "provider", "billable_in", "unknown_allowance_tokens" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL').all(run.id) as {
    provider: string;
    billable_in: number | null;
    unknown_allowance_tokens: number | null;
  }[];
  if (rows.some((r) => r.provider !== 'scripted' && r.billable_in === null && r.unknown_allowance_tokens === null)) {
    throw new Refusal(409, 'budget_exhausted', `Session ${run.id}'s spend so far cannot be judged: a turn's usage is unknown and no allowance was charged for it.`, 'Close the session; open another once the usage is known.', { run: run.id, limits: ['budget_usage_unknown'] });
  }
  const spent = rows.reduce((n, r) => n + (r.billable_in ?? 0) + (r.unknown_allowance_tokens ?? 0), 0);
  if (spent >= policyNow.budget_run_billable_tokens!) {
    throw new Refusal(409, 'budget_exhausted', `Session ${run.id} has spent ${spent} billable tokens, at or over budget_run_billable_tokens (${policyNow.budget_run_billable_tokens}); it admits no further turn.`, 'Close the session, or raise the limit.', {
      run: run.id,
      limits: ['budget_run_billable_tokens'],
      spent,
    });
  }
  const lease = tx.db.prepare(`SELECT "id", "generation", "closing" FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`).get(run.id) as { id: string; generation: number; closing: number } | undefined;
  if (!lease || lease.closing === 1) throw illegal('a turn on a session whose lease is closing or released', { run: run.id });
  // The run lease is renewed for the turn: between turns the idle deadline,
  // not the lease, bounds the session (expiredRunLeases leaves an idle
  // session alone).
  tx.db.prepare('UPDATE "leases" SET "renewed_at" = ?, "expires_at" = ? WHERE "id" = ?').run(tx.at, addSeconds(tx.at, engineSettings().lease_ttl), lease.id);
  const turn = run.turn_count + 1;
  // The owner's entry, by the admission (B01).
  appendTranscript(tx, run, { turn, speaker: 'owner', text: args.text, text_ref: args.textRecord });
  // The turn, its receipt and its domain in one transaction, the foreign
  // keys deferred (0001: turns and receipts reference each other).
  tx.db.pragma('defer_foreign_keys = ON');
  const turnId = tx.newId('turn_');
  const invocation = tx.newId('inv_');
  const domain = tx.newId('dom_');
  const policy = projectPolicy(tx.db, run.project);
  const budget = { budget_run_billable_tokens: policy.budget_run_billable_tokens, budget_day_verified_usd: policy.budget_day_verified_usd, budget_day_unknown_tokens: policy.budget_day_unknown_tokens };
  const session = TEMPLATES[run.backend]?.sessionIdOf?.(invocation) ?? null;
  tx.db
    .prepare('INSERT INTO "turns" ("id", "created_at", "project", "run", "number", "invocation", "domain", "started_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(turnId, tx.at, run.project, run.id, turn, invocation, domain, tx.at);
  tx.db
    .prepare(
      `INSERT INTO "invocation_receipts" ("id", "created_at", "project", "run", "turn", "provider", "model_requested", "grant", "budget_snapshot", "trust_entry", "qualification_attempt", "provider_session_id")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(invocation, tx.at, run.project, run.id, turnId, run.backend, run.model_requested, run.grant, JSON.stringify(budget), resolved.kind === 'entry' ? resolved.entry.id : null, session);
  tx.emit('invocation.receipt', { project: run.project, run: run.id, invocation }, { provider: run.backend, turn, ...(session ? { provider_session_id: session } : {}) });
  const cgroupPath = args.scope ? `${args.scope}/${domain}` : null;
  tx.db
    .prepare(`INSERT INTO "execution_domains" ("id", "created_at", "project", "run", "invocation", "status", "profile", "cgroup_path", "launch_state") VALUES (?, ?, ?, ?, ?, 'allocated', 'role', ?, 'authorizable')`)
    .run(domain, tx.at, run.project, run.id, invocation, cgroupPath);
  tx.db.prepare('INSERT INTO "process_ownership" ("id", "created_at", "project", "domain", "invocation", "incarnation") VALUES (?, ?, ?, ?, ?, ?)').run(tx.newId('proc_'), tx.at, run.project, domain, invocation, args.incarnation);
  const deadlineSeconds = policy[`deadline_${run.role}`] ?? policy.deadline_architect!;
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'turn_running', "turn_count" = ?, "deadline_at" = ? WHERE "id" = ?`).run(turn, addSeconds(tx.at, deadlineSeconds), run.id);
  tx.emit('session.turn_started', { project: run.project, run: run.id, invocation }, { turn, idle_generation: run.idle_generation });
  return { run: run.id, turn, session_state: 'turn_running', invocation };
}

// The turns admitted and not yet dispatched (D1 §15.1: the choke point
// dispatches; SEAM.md §344: a tick launches it in the kernel lane).
export function pendingTurns(db: Tx['db'], project: string | null): { run: string; project: string; invocation: string; repo: string; branch: string }[] {
  return db
    .prepare(
      `SELECT r."id" AS "run", r."project", d."invocation", p."dev_repo_path" AS "repo", p."integration_branch" AS "branch"
       FROM "runs" r JOIN "execution_domains" d ON d."run" = r."id" AND d."status" = 'allocated' JOIN "projects" p ON p."id" = r."project"
       WHERE r."kind" = 'session' AND r."session_state" = 'turn_running' AND r."state" IN ('claimed', 'executing') AND (? IS NULL OR r."project" = ?)
         AND NOT EXISTS (SELECT 1 FROM "invocation_status_observations" o WHERE o."invocation" = d."invocation")
       ORDER BY r."created_at"`,
    )
    .all(project, project) as { run: string; project: string; invocation: string; repo: string; branch: string }[];
}

// The claim of an admitted turn, rebuilt from its rows for the launcher.
export function turnClaim(tx: Tx, args: { run: string; invocation: string; scripted: string | null }): TurnClaim | null {
  const run = getRun(tx, args.run) as SessionRow | undefined;
  if (!run || run.kind !== 'session' || run.session_state !== 'turn_running') return null;
  const turn = tx.db.prepare('SELECT "number", "domain" FROM "turns" WHERE "run" = ? AND "invocation" = ?').get(run.id, args.invocation) as { number: number; domain: string } | undefined;
  if (!turn) return null;
  const d = tx.db.prepare('SELECT "cgroup_path", "status" FROM "execution_domains" WHERE "id" = ?').get(turn.domain) as { cgroup_path: string | null; status: string } | undefined;
  if (!d || d.status !== 'allocated') return null;
  const lease = tx.db.prepare(`SELECT "generation", "renewed_at" FROM "leases" WHERE "resource_kind" = 'run' AND "resource_id" = ? AND "released_at" IS NULL`).get(run.id) as { generation: number; renewed_at: string } | undefined;
  if (!lease) return null;
  const resolved = sessionBackend(tx.db, { project: run.project, role: run.role, scripted: args.scripted });
  // Refused since the admission: the claim carries the refusal, and the
  // launcher refuses the turn before any process (D2 §4.1).
  if (resolved.kind === 'refused') {
    return {
      run: run.id,
      project: run.project,
      work_item: null,
      work_kind: 'session',
      role: run.role,
      invocation: args.invocation,
      domain: turn.domain,
      generation: lease.generation,
      deadline_at: run.deadline_at,
      base_revision: run.base_revision,
      lease_renewed_at: lease.renewed_at,
      cgroup_path: d.cgroup_path,
      profile: 'role',
      backend: resolved.backend,
      trust_entry: null,
      entry: null,
      attempt: null,
      refusal: { code: resolved.code, reason: resolved.reason, what_to_do: resolved.what_to_do, subject: resolved.subject },
      session: { turn: turn.number, role: run.role as SessionRole, idle_generation: run.idle_generation },
    };
  }
  const keyRef = credentialRef(resolved.backend, resolved.kind === 'entry' ? resolved.entry.auth_mode : 'api_key');
  return {
    run: run.id,
    project: run.project,
    work_item: null,
    work_kind: 'session',
    role: run.role,
    invocation: args.invocation,
    domain: turn.domain,
    generation: lease.generation,
    deadline_at: run.deadline_at,
    base_revision: run.base_revision,
    lease_renewed_at: lease.renewed_at,
    cgroup_path: d.cgroup_path,
    profile: 'role',
    backend: resolved.backend,
    trust_entry: resolved.kind === 'entry' ? resolved.entry.id : null,
    entry:
      resolved.kind === 'entry'
        ? {
            backend: resolved.backend,
            auth_mode: resolved.entry.auth_mode,
            binary_path: resolved.entry.binary_path,
            binary_sha256: resolved.entry.binary_sha256,
            help_sha256: resolved.entry.help_sha256,
            model: resolved.entry.model,
            key_ref: keyRef,
            egress_hosts: (() => {
              try {
                return JSON.parse(resolved.entry.egress_hosts) as string[];
              } catch {
                return [];
              }
            })(),
          }
        : null,
    attempt: null,
    refusal: null,
    session: { turn: turn.number, role: run.role as SessionRole, idle_generation: run.idle_generation },
  };
}

// The session's workspace, if a turn has made one (the launcher reuses it).
export function sessionWorkspace(db: Tx['db'], run: string): { id: string; path: string; current_base: string } | null {
  return (db.prepare('SELECT "id", "path", "current_base" FROM "workspaces" WHERE "run" = ? ORDER BY "created_at" DESC LIMIT 1').get(run) as { id: string; path: string; current_base: string } | undefined) ?? null;
}

// ---- a turn's settlement (D6 §2.1; B01; D6-S10) -------------------------------------------

export interface SessionReply {
  reply: string;
  artifact_changed: boolean;
  questions_for_owner?: string[];
  done?: boolean;
}

// The role's reply in B.7's form (SEAM.md §343: §68's `status` and `summary`
// beside B.7's fields), or null. A `speaker` or `turn` field is role text
// and assigns nothing (B01): the form is refused.
export function parseSessionReply(value: unknown): SessionReply | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.status !== 'completed' || typeof v.summary !== 'string') return null;
  for (const k of Object.keys(v)) if (!['status', 'summary', 'reply', 'artifact_changed', 'questions_for_owner', 'done'].includes(k)) return null;
  if (typeof v.reply !== 'string') return null;
  if (typeof v.artifact_changed !== 'boolean') return null;
  if (v.questions_for_owner !== undefined && !(Array.isArray(v.questions_for_owner) && v.questions_for_owner.every((q) => typeof q === 'string'))) return null;
  if (v.done !== undefined && typeof v.done !== 'boolean') return null;
  return { reply: v.reply, artifact_changed: v.artifact_changed, ...(v.questions_for_owner ? { questions_for_owner: v.questions_for_owner as string[] } : {}), ...(v.done !== undefined ? { done: v.done } : {}) };
}

export interface SettleArgs {
  run: string;
  invocation: string;
  reply: SessionReply | null;
  failure: string | null;
  // The reply's (or the failure's) text as a session_transcript record.
  textRecord: string | null;
  exit: { exit_class: string | null; exit_evidence: string | null } | null;
}

export function settleTurn(tx: Tx, args: SettleArgs): { turn: number; idle_generation: number; outcome: 'replied' | 'failed' } {
  const run = getRun(tx, args.run) as SessionRow | undefined;
  if (!run || run.kind !== 'session') throw notFound('session', args.run);
  const turnRow = tx.db.prepare('SELECT "id", "number", "domain", "settled_at" FROM "turns" WHERE "run" = ? AND "invocation" = ?').get(run.id, args.invocation) as { id: string; number: number; domain: string; settled_at: string | null } | undefined;
  if (!turnRow) throw notFound('turn', args.invocation);
  if (turnRow.settled_at !== null) return { turn: turnRow.number, idle_generation: run.idle_generation, outcome: args.reply ? 'replied' : 'failed' };
  if (run.session_state !== 'turn_running') throw illegal(`settling a turn of a ${run.session_state ?? run.state} session`, { run: run.id });
  const open = tx.db.prepare(`SELECT "id" FROM "execution_domains" WHERE "invocation" = ? AND "status" <> 'terminated'`).all(args.invocation) as { id: string }[];
  if (open.length > 0) throw illegal('settling a turn whose domain is not terminated', { run: run.id, domains: open.map((d) => d.id) });
  // The invocation's terminal observation and its ledger row (D1 §13.1):
  // one per turn, an unknown remainder included.
  const seen = (tx.db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(args.invocation) as { status: string }[]).map((r) => r.status);
  if (!seen.some((s) => s === 'ended' || s === 'unknown' || s === 'refused')) {
    const terminal = seen.includes('launched') ? 'ended' : seen.includes('dispatch_started') ? 'unknown' : 'refused';
    const { n } = tx.db.prepare('SELECT COALESCE(MAX("seq"), 0) + 1 AS n FROM "invocation_status_observations" WHERE "invocation" = ?').get(args.invocation) as { n: number };
    tx.db
      .prepare('INSERT INTO "invocation_status_observations" ("id", "created_at", "project", "invocation", "seq", "status", "at", "exit_class", "exit_evidence") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(tx.newId('iso_'), tx.at, run.project, args.invocation, n, terminal, tx.at, terminal === 'refused' ? null : (args.exit?.exit_class ?? null), terminal === 'refused' ? null : (args.exit?.exit_evidence ?? null));
    tx.emit('invocation.status', { project: run.project, run: run.id, invocation: args.invocation }, { status: terminal, seq: n, ...(args.exit?.exit_class ? { exit_class: args.exit.exit_class } : {}) });
    if (terminal !== 'refused') chargeInvocation(tx, { id: run.id, project: run.project, role: run.role, backend: run.backend, model_requested: run.model_requested, outcome: null }, { id: args.invocation, turn: turnRow.id });
  }
  const ledger = tx.db.prepare('SELECT "usage_complete" FROM "ledger_rows" WHERE "invocation" = ? AND "corrects" IS NULL').get(args.invocation) as { usage_complete: number } | undefined;
  const usageStatus = ledger && ledger.usage_complete === 1 ? 'recorded' : 'unknown';
  const outcome: 'replied' | 'failed' = args.reply !== null ? 'replied' : 'failed';
  if (args.reply !== null) appendTranscript(tx, run, { turn: turnRow.number, speaker: 'role', text: args.reply.reply, text_ref: args.textRecord });
  else appendTranscript(tx, run, { turn: turnRow.number, speaker: 'engine', text: `The turn failed: ${args.failure ?? 'the role left no reply the engine could take'}.`, text_ref: args.textRecord });
  tx.db
    .prepare('UPDATE "turns" SET "finished_at" = ?, "settled_at" = ?, "usage_status" = ?, "outcome" = ?, "reply" = ? WHERE "id" = ?')
    .run(tx.at, tx.at, usageStatus, outcome, args.reply === null ? JSON.stringify({ failure: args.failure }) : JSON.stringify(args.reply), turnRow.id);
  const generation = run.idle_generation + 1;
  const policy = projectPolicy(tx.db, run.project);
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'open_idle', "idle_generation" = ?, "deadline_at" = ? WHERE "id" = ?`).run(generation, addSeconds(tx.at, policy.session_idle_timeout!), run.id);
  tx.emit('session.turn_ended', { project: run.project, run: run.id, invocation: args.invocation }, { turn: turnRow.number, outcome });
  tx.emit('session.turn_settled', { project: run.project, run: run.id, invocation: args.invocation }, { turn: turnRow.number, outcome, idle_generation: generation, usage_status: usageStatus, done: args.reply?.done === true });
  return { turn: turnRow.number, idle_generation: generation, outcome };
}

// ---- save (D6 §2.4, §2.5; B01, B02) -------------------------------------------------------

export interface SaveFacts {
  run: string;
  project: string;
  role: SessionRole;
  repo: string;
  branch: string;
  head: string | null;
  base_revision: string;
  workspace: { id: string; path: string; current_base: string; metadata: Record<string, unknown> | null } | null;
  roots: string[];
  caps: { files: number; bytes: number; fileBytes: number };
  idle_generation: number;
  turn: number;
}

export function saveFacts(tx: Tx, run: SessionRow, roots: string[]): SaveFacts {
  const p = projectRepoRow(tx, run.project);
  const head = registryRow(tx, run.project, integrationRef(p.integration_branch));
  const policy = projectPolicy(tx.db, run.project);
  const ws = tx.db.prepare('SELECT "id", "path", "current_base", "metadata_baseline" FROM "workspaces" WHERE "run" = ? ORDER BY "created_at" DESC LIMIT 1').get(run.id) as
    | { id: string; path: string; current_base: string; metadata_baseline: string | null }
    | undefined;
  return {
    run: run.id,
    project: run.project,
    role: run.role as SessionRole,
    repo: p.dev_repo_path,
    branch: p.integration_branch,
    head: head?.expected_oid ?? null,
    base_revision: run.base_revision,
    workspace: ws ? { id: ws.id, path: ws.path, current_base: ws.current_base, metadata: ws.metadata_baseline ? (JSON.parse(ws.metadata_baseline) as Record<string, unknown>) : null } : null,
    roots,
    caps: { files: policy.snapshot_max_files!, bytes: policy.snapshot_max_bytes!, fileBytes: policy.snapshot_max_file_bytes! },
    idle_generation: run.idle_generation,
    turn: run.turn_count,
  };
}

// What the close reads after its save: the session as it stands, no swap.
export function closeFacts(tx: Tx, args: { project: string; run: string; expectedGeneration?: number | null }): SaveFacts {
  const run = getSession(tx, args.project, args.run);
  if (run.session_state !== 'open_idle' && run.session_state !== 'allocated') throw notIdle(run, 'a close');
  if (args.expectedGeneration !== undefined && args.expectedGeneration !== null && args.expectedGeneration !== run.idle_generation) throw generationStale(run, args.expectedGeneration);
  const version = effectiveVersion(tx.db, run.project);
  return saveFacts(tx, run, version ? (JSON.parse(version.roots) as string[]) : ['.surety/checks/']);
}

// The compare-and-swap into `saving` (B01): one winner per generation.
export function beginSave(tx: Tx, args: { project: string; run: string; expectedGeneration?: number | null }): SaveFacts {
  const run = getSession(tx, args.project, args.run);
  if (run.session_state !== 'open_idle' && run.session_state !== 'allocated') throw notIdle(run, 'a save');
  if (args.expectedGeneration !== undefined && args.expectedGeneration !== null && args.expectedGeneration !== run.idle_generation) throw generationStale(run, args.expectedGeneration);
  const open = tx.db.prepare(`SELECT "id" FROM "execution_domains" WHERE "run" = ? AND "status" <> 'terminated'`).all(run.id) as { id: string }[];
  if (open.length > 0) throw illegal('a save while a domain of the session is not terminated', { run: run.id, domains: open.map((d) => d.id) });
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'saving' WHERE "id" = ?`).run(run.id);
  const version = effectiveVersion(tx.db, run.project);
  return saveFacts(tx, run, version ? (JSON.parse(version.roots) as string[]) : ['.surety/checks/']);
}

// The checkpoint's integration onto the branch (D6 §2.4): a compare-and-swap
// of the integration ref whose finalizer registers nothing (B02).
export function intendCheckpointIntegration(tx: Tx, args: { project: string; run: string; repo: string; head: string; commit: string; deadlineSeconds: number }): IntentResult {
  const p = projectRepoRow(tx, args.project);
  const ref = integrationRef(p.integration_branch);
  return intendOperation(tx, {
    project: args.project,
    kind: 'ref_update',
    payload: { repo: args.repo, ref, old_oid: args.head, new_oid: args.commit, run: args.run },
    target: { repo: args.repo, ref },
    subject: { run: args.run, old_oid: args.head, new_oid: args.commit, checkpoint: true },
    finalizer: { purpose: 'integration', ref, ref_kind: 'integration', new_oid: args.commit, run: args.run, checkpoint: true, plans: [], architect: false, nominate: null, chain: 0 },
    deadlineSeconds: args.deadlineSeconds,
  });
}

export interface SaveOutcome {
  project: string;
  run: string;
  committed: { sha: string; blobs: Record<string, string> } | null;
  refused: { code: string; text: string } | null;
  findings: SaveFinding[];
  // The engine's entry as a session_transcript record (the findings' text).
  notesRecord: string | null;
  // What the parse read of the products, for the decisions at close.
  products: { identity?: Record<string, unknown> | null; spec?: { blob: string; digest: string | null; representation: SpecRepresentation | null; findings: SemanticFinding[]; readable: boolean } | null };
  nothingToSave: boolean;
}

export function finishSave(tx: Tx, args: SaveOutcome): { idle_generation: number; saved: boolean } {
  const run = getSession(tx, args.project, args.run);
  if (run.session_state !== 'saving') throw illegal(`finishing a save of a ${run.session_state ?? run.state} session`, { run: run.id });
  const generation = run.idle_generation + 1;
  if (args.findings.length > 0 || args.refused) {
    const lines = [...(args.refused ? [`The save was refused (${args.refused.code}): ${args.refused.text} The workspace keeps the change.`] : []), ...args.findings.map((f) => `${f.code}${f.path ? ` (${f.path})` : ''}: ${f.message}`)];
    appendTranscript(tx, run, { turn: run.turn_count, speaker: 'engine', text: lines.join('\n'), text_ref: args.notesRecord });
  }
  let semantics: string | null = null;
  if (args.products.spec && args.committed) {
    semantics = recordSemantics(tx, { project: run.project, run: run.id, blob: args.products.spec.blob, digest: args.products.spec.digest, representation: args.products.spec.representation, findings: args.products.spec.findings, readable: args.products.spec.readable });
  }
  // A save that committed nothing keeps what the last checkpoint gave the
  // products (its blobs, identity and semantics): the close raises on the
  // last checkpoint (SEAM.md §344).
  const prior = saveNotesOf(tx.db, run.id);
  const notes = args.committed
    ? { at: tx.at, saved: args.committed.sha, blobs: args.committed.blobs, refused: args.refused, findings: args.findings, identity: args.products.identity ?? null, semantics }
    : { ...prior, at: tx.at, refused: args.refused, findings: args.refused || args.findings.length > 0 ? args.findings : (prior.findings ?? []) };
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'open_idle', "idle_generation" = ?, "session_notes" = ? WHERE "id" = ?`).run(generation, JSON.stringify(notes), run.id);
  tx.emit('session.saved', { project: run.project, run: run.id }, { idle_generation: generation, revision: args.committed?.sha ?? null, refused: args.refused?.code ?? null, nothing_to_save: args.nothingToSave, findings: args.findings.length });
  return { idle_generation: generation, saved: args.committed !== null };
}

// ---- close (D6 §2.4, §3.4; SEAM.md §344) ---------------------------------------------------

export interface CloseArgs {
  project: string;
  run: string;
  expectedGeneration?: number | null;
  // What the close raises: nothing (refuse), the role's decision, or the
  // architecture bundle prepared by the main thread (plan/bundle.ts).
  raise: { kind: 'none' } | { kind: 'idea_accept' } | { kind: 'spec_approval' } | { kind: 'bundle'; bundle: string; withPlan: boolean };
}

// The compare-and-swap into `closing` (B01) and the decision the role's
// product calls for (D6 §3.4), in one transaction; the end protocol follows
// on the main thread.
export function closeSession(tx: Tx, args: CloseArgs): { run: SessionRow; decisions: { id: string; kind: string; batch_key: string | null }[] } {
  const run = getSession(tx, args.project, args.run);
  if (run.session_state !== 'open_idle' && run.session_state !== 'allocated') throw notIdle(run, 'a close');
  if (args.expectedGeneration !== undefined && args.expectedGeneration !== null && args.expectedGeneration !== run.idle_generation) throw generationStale(run, args.expectedGeneration);
  const decisions: { id: string; kind: string; batch_key: string | null }[] = [];
  const raised = (d: DecisionRow | null) => {
    if (d) decisions.push({ id: d.id, kind: d.kind, batch_key: d.batch_key ?? null });
  };
  if (args.raise.kind === 'idea_accept' || args.raise.kind === 'spec_approval') {
    raised(raiseQuestion(tx, { project: run.project, kind: args.raise.kind, subjectType: 'run', subjectId: run.id }));
  } else if (args.raise.kind === 'bundle') {
    // The bundle is each decision's identity scope (B02): what it binds is
    // named, never found by the run.
    const arch = raiseQuestion(tx, { project: run.project, kind: 'architecture_approval', subjectType: 'run', subjectId: run.id, scope: args.raise.bundle });
    const plan = args.raise.withPlan ? raiseQuestion(tx, { project: run.project, kind: 'plan_approval', subjectType: 'run', subjectId: run.id, scope: args.raise.bundle }) : null;
    const ids = [arch?.id, plan?.id].filter((x): x is string => typeof x === 'string');
    if (ids.length > 0) tx.db.prepare(`UPDATE "decisions" SET "batch_key" = ? WHERE "id" IN (${ids.map(() => '?').join(', ')})`).run(args.raise.bundle, ...ids);
    tx.db.prepare('UPDATE "plan_bundles" SET "batch_key" = ? WHERE "id" = ?').run(args.raise.bundle, args.raise.bundle);
    if (arch) decisions.push({ id: arch.id, kind: arch.kind, batch_key: args.raise.bundle });
    if (plan) decisions.push({ id: plan.id, kind: plan.kind, batch_key: args.raise.bundle });
  }
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'closing' WHERE "id" = ?`).run(run.id);
  tx.emit('session.closed', { project: run.project, run: run.id }, { turns: run.turn_count, idle_generation: run.idle_generation, decisions: decisions.map((d) => d.kind), refused: args.raise.kind === 'none' });
  return { run: { ...run, session_state: 'closing' }, decisions };
}

// ---- the read (D6 §2.7; SEAM.md §344) --------------------------------------------------------

export function sessionView(db: Tx['db'], project: string, runId: string): Record<string, unknown> {
  const run = db.prepare('SELECT * FROM "runs" WHERE "id" = ? AND "project" = ? AND "kind" = ?').get(runId, project, 'session') as Record<string, unknown> | undefined;
  if (!run) throw notFound('session', runId);
  const turns = db.prepare('SELECT "id", "number", "invocation", "started_at", "finished_at", "settled_at", "usage_status", "outcome", "reply" FROM "turns" WHERE "run" = ? ORDER BY "number"').all(runId) as Record<string, unknown>[];
  const ledger = db.prepare('SELECT "id", "invocation", "billable_in", "cached_in", "out", "cost_status", "cost_usd", "usage_complete", "model_observed" FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY "created_at"').all(runId) as Record<string, unknown>[];
  const byInvocation = new Map(ledger.map((l) => [l.invocation as string, l]));
  let notes: { findings?: SaveFinding[] } | null = null;
  try {
    notes = typeof run.session_notes === 'string' ? (JSON.parse(run.session_notes) as { findings?: SaveFinding[] }) : null;
  } catch {
    notes = null;
  }
  // The session's spend: unknown (null) as soon as one turn's usage is
  // unknown or one figure is missing, never a partial sum read as the total.
  const turnUnknown = turns.some((t) => t.settled_at !== null && t.usage_status !== 'recorded');
  const known = !turnUnknown && ledger.every((l) => l.usage_complete === 1);
  const sum = (key: string): number | null => {
    if (!known) return null;
    let total = 0;
    for (const l of ledger) {
      if (typeof l[key] !== 'number') return null;
      total += l[key] as number;
    }
    return total;
  };
  return {
    run: {
      id: run.id,
      project: run.project,
      role: run.role,
      kind: run.kind,
      state: run.state,
      session_state: run.session_state,
      idle_generation: run.idle_generation,
      turn_count: run.turn_count,
      outcome: run.outcome,
      reason_class: run.reason_class,
      deadline_at: run.deadline_at,
      base_revision: run.base_revision,
      backend: run.backend,
      model_requested: run.model_requested,
    },
    turns: turns.map((t) => {
      let reply: Record<string, unknown> | null = null;
      try {
        reply = typeof t.reply === 'string' ? (JSON.parse(t.reply) as Record<string, unknown>) : null;
      } catch {
        reply = null;
      }
      const state = t.settled_at === null ? 'running' : t.outcome === 'replied' ? 'settled' : t.outcome === 'failed' ? 'failed' : 'unknown';
      return {
        turn: t.number,
        invocation: t.invocation,
        state,
        reply: state === 'settled' ? (reply?.reply ?? null) : null,
        artifact_changed: state === 'settled' ? (reply?.artifact_changed ?? null) : null,
        done: state === 'settled' ? (reply?.done ?? false) : null,
        questions_for_owner: state === 'settled' ? (reply?.questions_for_owner ?? []) : null,
        failure: state === 'failed' ? (reply?.failure ?? null) : null,
        started_at: t.started_at,
        settled_at: t.settled_at,
        usage_status: t.usage_status,
        ledger_row: (byInvocation.get(t.invocation as string)?.id as string | undefined) ?? null,
      };
    }),
    // null: the transcript record cannot be read (unknown, never empty).
    transcript: transcriptOf(db, runId)?.map((e) => ({ turn: e.turn, speaker: e.speaker, at: e.at, text: e.text, text_ref: e.text_ref })) ?? null,
    findings: notes?.findings ?? [],
    spend: { turns: ledger.length, usage: known ? 'recorded' : 'unknown', billable_in: sum('billable_in'), cached_in: sum('cached_in'), out: sum('out'), cost_usd: sum('cost_usd'), rows: ledger },
  };
}

// Idle sessions whose idle deadline has passed (D6 §2.4): closed by the idle
// protocol (slice 33 pins it; here no session outlives its deadline unattended).
export function idleExpiredSessions(db: Tx['db'], at: string): { run: string; project: string }[] {
  return db
    .prepare(`SELECT "id" AS "run", "project" FROM "runs" WHERE "kind" = 'session' AND "state" <> 'ended' AND "session_state" IN ('allocated', 'open_idle') AND "deadline_at" <= ? ORDER BY "created_at"`)
    .all(at) as { run: string; project: string }[];
}

export function closeIdle(tx: Tx, args: { run: string }): boolean {
  const run = getRun(tx, args.run) as SessionRow | undefined;
  if (!run || run.kind !== 'session' || run.state === 'ended' || run.state === 'finalizing') return false;
  if (run.session_state !== 'open_idle' && run.session_state !== 'allocated') return false;
  if (run.deadline_at > tx.at) return false;
  assertEdge('RunState', run.state, 'finalizing', { run: run.id });
  tx.db.prepare(`UPDATE "runs" SET "session_state" = 'closing' WHERE "id" = ?`).run(run.id);
  tx.emit('session.closed', { project: run.project, run: run.id }, { turns: run.turn_count, idle_generation: run.idle_generation, cause: 'idle_timeout' });
  return true;
}

// The notes of the last save (sessions/decisions.ts reads the products).
export function saveNotesOf(db: Tx['db'], run: string): { saved?: string | null; blobs?: Record<string, string>; identity?: Record<string, unknown> | null; semantics?: string | null; findings?: SaveFinding[] } {
  const row = db.prepare('SELECT "session_notes" FROM "runs" WHERE "id" = ?').get(run) as { session_notes: string | null } | undefined;
  try {
    return row?.session_notes ? (JSON.parse(row.session_notes) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Whether `run` is a session of `project` (the routes answer 404 before
// reading a body or writing a record).
export function sessionExists(db: Tx['db'], project: string, run: string): boolean {
  return db.prepare(`SELECT 1 FROM "runs" WHERE "id" = ? AND "project" = ? AND "kind" = 'session'`).get(run, project) !== undefined;
}

// What a turn's package is built from (sessions/package.ts): the transcript
// so far with each entry's text, and the last save's notes.
export function sessionContextFacts(db: Tx['db'], run: string): import('./package.js').SessionContextFacts | null {
  const r = db.prepare(`SELECT "id", "project", "role", "turn_count" FROM "runs" WHERE "id" = ? AND "kind" = 'session'`).get(run) as { id: string; project: string; role: SessionRole; turn_count: number } | undefined;
  if (!r) return null;
  const notes = saveNotesOf(db, run);
  return {
    run: r.id,
    project: r.project,
    role: r.role,
    turn: r.turn_count,
    paths: SESSION_PATHS[r.role] ?? [],
    transcript: transcriptOf(db, run)?.map((e) => ({ turn: e.turn, speaker: e.speaker, at: e.at, text: e.text })) ?? null,
    findings: notes.findings ?? [],
    approved: approvedInputs(db, r.project, r.role),
  };
}

function approvedInputs(db: Tx['db'], project: string, role: SessionRole): { name: string; blob: string; what: string }[] {
  if (role === 'architect') {
    const spec = db.prepare('SELECT "version", "git_blob" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { version: number; git_blob: string } | undefined;
    return spec ? [{ name: 'spec.md', blob: spec.git_blob, what: `the approved specification, version ${spec.version}` }] : [];
  }
  if (role === 'spec_writer') {
    const idea = db.prepare('SELECT "idea_version", "idea_blob" FROM "projects" WHERE "id" = ?').get(project) as { idea_version: number | null; idea_blob: string | null } | undefined;
    return idea?.idea_blob ? [{ name: 'idea.md', blob: idea.idea_blob, what: `the accepted idea record, version ${idea.idea_version}` }] : [];
  }
  return [];
}
