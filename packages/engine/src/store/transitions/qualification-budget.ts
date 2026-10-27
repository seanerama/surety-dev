// The qualification budget (B2, SETUP-01; Sean's approval of 2026-10-27):
// the upfront admission of a qualification attempt against its fixture
// project's day, by reservation. Read by the qualification_approval's answer
// (queue.ts) and served on GET /v1/engine's attempts (trust.ts).

import { Refusal } from '../../refusal.js';
import { canaryKindsOf } from '../../trust/canaries.js';
import { envelopeHold } from './envelope.js';
import { dayUnknownAccount, exhaustedLimits, invocationStanding } from './ledger.js';
import { dispatchBlocker } from './runs.js';
import { projectPolicy } from './settings.js';
import type { AttemptRow } from './trust.js';
import type { Tx } from './tx.js';
import type { WorkRow } from './work.js';

// An attempt's qualification_approval is consumed as `approve` only if the
// fixture project's day can hold what the attempt's passing path charges by
// design: the cancellation canary, which the engine ends at its barrier and
// which C4 charges the per-canary limit (its observed tokens plus the
// allowance). So the answer is accepted only if
//
//   charged today + outstanding reservations + this attempt's reservation
//     <= the fixture project's budget_day_unknown_tokens,
//
// where an attempt's reservation is the fixture project's
// budget_run_billable_tokens (the per-canary limit) when it runs the
// cancellation canary and 0 when it does not (an active entry's session
// qualification, the continuation canary alone). Nothing is stored: a
// reservation is read from the attempt and its canary's receipt, so a
// restart neither loses one nor counts one twice. An admitted attempt's
// reservation is
//   - converted when its cancellation canary is charged: the ledger row
//     replaces it, and while the canary is under way the reservation is its
//     limit less what it already counts in the charged figure;
//   - released when the attempt is no longer authorized or running
//     (succeeded, failed, invalidated: an ended attempt dispatches nothing
//     more), and when the canary was refused (charged nothing).

const ADMITTED = ['authorized', 'running'];

// What the attempt asks to hold back of the fixture project's day.
export function requestedReservation(db: Tx['db'], a: AttemptRow): number {
  if (a.fixture_project === null || !canaryKindsOf(a).includes('cancellation')) return 0;
  return projectPolicy(db, a.fixture_project).budget_run_billable_tokens!;
}

// What an admitted attempt still holds back: 0 once it ended or its
// cancellation canary was charged.
export function outstandingReservation(db: Tx['db'], a: AttemptRow): number {
  if (a.fixture_project === null || !ADMITTED.includes(a.status) || !canaryKindsOf(a).includes('cancellation')) return 0;
  const receipts = db
    .prepare(
      `SELECT r."id" FROM "invocation_receipts" r JOIN "runs" u ON u."id" = r."run" JOIN "work_items" w ON w."id" = u."work_item"
       WHERE r."qualification_attempt" = ? AND w."canary_kind" = 'cancellation' ORDER BY r.rowid`,
    )
    .all(a.id) as { id: string }[];
  if (receipts.length === 0) return requestedReservation(db, a);
  let held = 0;
  for (const r of receipts) {
    const standing = invocationStanding(db, r.id, a.fixture_project);
    if (!standing.charged) held += Math.max(0, standing.limit - standing.counted);
  }
  return held;
}

export interface Admission {
  fixture_project: string;
  day: string;
  limit_key: 'budget_day_unknown_tokens';
  // The four numbers (Sean's approval): charged today, the reservations of
  // attempts already admitted, this attempt's own, and the limit.
  charged_tokens: number;
  outstanding_reserved_tokens: number;
  requested_tokens: number;
  limit_tokens: number;
  reserving_attempts: { id: string; tokens: number }[];
  fits: boolean;
  clears_at: string;
}

// The fit of an attempt's admission, as it stands now; null for an attempt
// with no fixture project.
export function attemptAdmission(db: Tx['db'], a: AttemptRow): Admission | null {
  if (a.fixture_project === null) return null;
  const account = dayUnknownAccount(db, a.fixture_project);
  const others = (db.prepare(`SELECT * FROM "qualification_attempts" WHERE "fixture_project" = ? AND "id" <> ? AND "status" IN ('authorized', 'running') ORDER BY rowid, "id"`).all(a.fixture_project, a.id) as AttemptRow[])
    .map((o) => ({ id: o.id, tokens: outstandingReservation(db, o) }))
    .filter((o) => o.tokens > 0);
  const outstanding = others.reduce((n, o) => n + o.tokens, 0);
  const requested = requestedReservation(db, a);
  return {
    fixture_project: a.fixture_project,
    day: account.day,
    limit_key: 'budget_day_unknown_tokens',
    charged_tokens: account.charged_tokens,
    outstanding_reserved_tokens: outstanding,
    requested_tokens: requested,
    limit_tokens: account.limit_tokens,
    reserving_attempts: others,
    fits: account.charged_tokens + outstanding + requested <= account.limit_tokens,
    clears_at: account.clears_at,
  };
}

// The refusal of an approval the day cannot hold: the four numbers and when
// the day clears. The decision stays open; nothing is changed.
export function admissionRefusal(a: AttemptRow, f: Admission): Refusal {
  const total = f.charged_tokens + f.outstanding_reserved_tokens + f.requested_tokens;
  return new Refusal(
    409,
    'budget_exhausted',
    `Qualification attempt ${a.id} cannot be authorized now: the fixture project ${f.fixture_project} has ${f.charged_tokens} unknown-cost tokens charged on ${f.day}, ` +
      `${f.outstanding_reserved_tokens} reserved by attempts already authorized${f.reserving_attempts.length > 0 ? ` (${f.reserving_attempts.map((r) => `${r.id} ${r.tokens}`).join(', ')})` : ''}, ` +
      `and this attempt reserves ${f.requested_tokens} for its cancellation canary: ${total} in all, over budget_day_unknown_tokens (${f.limit_tokens}).`,
    `The day clears at ${f.clears_at} (00:00 UTC): answer again then, or raise the fixture project's budget_day_unknown_tokens (a widening, approved by its own decision). The decision stays open; nothing was changed.`,
    {
      qualification_attempt: a.id,
      fixture_project: f.fixture_project,
      day: f.day,
      limit_key: f.limit_key,
      charged_tokens: f.charged_tokens,
      outstanding_reserved_tokens: f.outstanding_reserved_tokens,
      requested_tokens: f.requested_tokens,
      limit_tokens: f.limit_tokens,
      reserving_attempts: f.reserving_attempts,
      clears_at: f.clears_at,
    },
  );
}

// Why a canary's item is not dispatched now (B2: a canary never dispatched
// is recorded `not_dispatched` with the blocker's own words and its limits,
// D-3/D-4 of the analysis): the store's dispatch blocker, or the resource
// envelope's hold; `reason` null when neither holds at this read (what held
// it is then not known, and is never reported as nothing). For a day limit,
// the day's account beside the limits passed.
export function canaryWaitReason(db: Tx['db'], args: { item: string }): { reason: string | null; limits: string[]; day: ReturnType<typeof dayUnknownAccount> | null } {
  const item = db.prepare('SELECT * FROM "work_items" WHERE "id" = ?').get(args.item) as WorkRow | undefined;
  if (!item) return { reason: 'work item missing', limits: [], day: null };
  const blocker = dispatchBlocker(db, item, { canary: true, check: false });
  if (blocker !== null) {
    const limits = blocker === 'budget exhausted' ? exhaustedLimits(db, item.project, { check: false, dispatch: true }) : [];
    return { reason: blocker, limits, day: limits.length > 0 ? dayUnknownAccount(db, item.project) : null };
  }
  if (envelopeHold(db, { kind: 'role', project: item.project }) !== null) return { reason: 'resource envelope', limits: [], day: null };
  return { reason: null, limits: [], day: null };
}
