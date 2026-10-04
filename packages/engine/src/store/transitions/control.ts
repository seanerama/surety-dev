// The slice-2 API commands (D1 §8.4, §10.5, §11.4; SEAM.md §17): the tick
// request, Stop and Abandon through their confirmation decisions, answering
// a decision, and the run representation. Each command is one transition and
// commits with its api.act record (store worker, `mutate`).

import { Refusal } from '../../refusal.js';
import { illegal, notFound, parseJson } from './common.js';
import { type DecisionRow, consumeDecision, currentPreview, openDecision, stale } from './decisions.js';
import { type Facts, KINDS, answerQueued, raiseQuestion, wireControl } from './queue.js';
import { beginEnd, getRun } from './runs.js';
import type { Tx } from './tx.js';

// What a command hands back to the main thread besides its reply: work that
// must start once the transaction has committed.
export type Effect = { kind: 'tick' } | { kind: 'end_run'; run: string } | { kind: 'journal'; project: string } | { kind: 'effect'; intent: string };

export interface CommandResult {
  status: number;
  body: unknown;
  effects?: Effect[];
}

// POST /v1/projects/:p/tick: the project must exist; the scheduler runs in its
// own loop, never in this call (D1 §1.5).
export function requestTick(tx: Tx, args: { project: string }): CommandResult {
  if (!tx.db.prepare('SELECT "id" FROM "projects" WHERE "id" = ?').get(args.project)) throw notFound('project', args.project);
  return { status: 202, body: { tick: 'requested' }, effects: [{ kind: 'tick' }] };
}

type Control = 'stop' | 'abandon';
const CONFIRM = { stop: 'stop_confirm', abandon: 'abandon_confirm' } as const;

// The effect of consuming a stop_confirm or abandon_confirm: the run-end
// protocol begins (its lease is closing when this commits).
function applyControl(tx: Tx, kind: Control, runId: string): CommandResult {
  const ended = beginEnd(tx, {
    run: runId,
    outcome: kind === 'stop' ? 'stopped' : 'abandoned',
    reason: kind === 'stop' ? 'human_stop' : 'human_abandon',
  });
  return { status: 200, body: { run: { id: runId, state: ended.state, outcome: ended.outcome } }, effects: [{ kind: 'end_run', run: runId }] };
}

wireControl((tx: Tx, d: DecisionRow, kind: Control) => {
  const run = getRun(tx, d.subject_id)!;
  const result = applyControl(tx, kind, run.id);
  return { ...result, body: { decision: { id: d.id, status: 'consumed' }, ...(result.body as object) } };
});

// POST /v1/projects/:p/runs/:r/stop and /abandon. Without a preview hash the
// confirmation decision is raised (or the open one returned) and the answer
// is 409 confirm_required; with the decision's preview hash it is consumed and
// the run-end protocol begins. The route cannot bypass the queue (D1 §10.1).
// What the confirmation binds is SEAM.md §80's: the run, whether it can be
// stopped, its workspace and what it holds, and what becomes of each; not
// whether the run is claimed or executing (E25 item 4).
//
// `decided`: the engine has already decided to end the run for another cause,
// whether or not it has recorded that yet (E27 item 5). The decided outcome
// stands, and the command is refused as for a run that has ended (SEAM.md
// §24). A quarantined run is refused `quarantined` (D1 §11.5; SEAM.md §80).
export function controlRun(tx: Tx, args: { project: string; run: string; kind: Control; previewHash: string | undefined; decided?: boolean }): CommandResult {
  const run = getRun(tx, args.run);
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  if (run.quarantined === 1 && run.state !== 'ended') {
    throw new Refusal(409, 'quarantined', `Run ${run.id} is quarantined: its termination has not been observed, and it is ended only when it is.`, 'Nothing was changed. The quarantine ends on observed termination.', {
      run: run.id,
    });
  }
  if (run.state === 'finalizing' || run.state === 'ended' || args.decided === true) {
    throw illegal(`${args.kind === 'stop' ? 'Stop' : 'Abandon'} of a ${args.decided === true && run.state !== 'ended' ? 'run whose end is already decided' : `${run.state} run`}`, {
      run: run.id,
      state: run.state,
    });
  }
  const kind = CONFIRM[args.kind];
  if (args.previewHash === undefined) {
    const decision = raiseQuestion(tx, { project: run.project, kind, subjectType: 'run', subjectId: run.id })!;
    const refusal = new Refusal(
      409,
      'confirm_required',
      `${args.kind === 'stop' ? 'Stop' : 'Abandon'} needs confirmation through decision ${decision.id}.`,
      'Send the same request again with {"preview_hash": <the preview hash>} to confirm.',
      { decision: decision.id, preview_hash: decision.preview_hash },
    );
    return { status: 409, body: refusal.body() };
  }
  const open = openDecision(tx, run.project, kind, 'run', run.id);
  if (!open) {
    const last = tx.db.prepare(`SELECT * FROM "decisions" WHERE "kind" = ? AND "subject_type" = 'run' AND "subject_id" = ? AND "preview_hash" = ? LIMIT 1`).get(kind, run.id, args.previewHash) as
      | DecisionRow
      | undefined;
    if (last?.status === 'consumed') throw new Refusal(409, 'decision_consumed', `Decision ${last.id} is consumed.`, 'Read the run; the confirmation took effect.', { decision: last.id });
    throw new Refusal(409, 'decision_stale', 'No confirmation is open for this run, or it was replaced.', 'Send the request without a preview hash to get the current confirmation.', {
      run: run.id,
    });
  }
  const now = KINDS[kind].preview(tx, open);
  if (args.previewHash !== open.preview_hash || now === null || currentPreview(open, now.manifest, now.options) !== open.preview_hash) throw stale(open);
  consumeDecision(tx, open, 'confirm', null);
  return applyControl(tx, args.kind, run.id);
}

// POST /v1/projects/:p/decisions/:d/answer (D1 §10.5; SEAM.md §§17, 76).
export function answerDecision(tx: Tx, args: { project: string; decision: string; option: unknown; preview_hash: unknown; note: unknown; facts?: Facts }): CommandResult {
  return answerQueued(tx, args);
}

const PREFLIGHT_CODES = ['backend_refused', 'isolation_unqualified', 'budget_boundary_unenforceable', 'mount_plan_refused'];

// D1 A.7: the public code reported on a run's representation.
function publicCode(reason: string | null, text: string | null): string | null {
  switch (reason) {
    case 'diff_violation':
    case 'ref_violation':
    case 'invalid_result':
    case 'integration_conflict':
      return reason;
    case 'preflight_refused':
      // D2 A.7: why a dispatch was refused before launch.
      return text !== null && PREFLIGHT_CODES.includes(text) ? text : 'backend_refused';
    case 'budget':
      return 'budget_exhausted';
    default:
      return null;
  }
}

function refusalOf(run: Record<string, unknown>): Record<string, unknown> | null {
  const code = publicCode(run.reason_class as string | null, run.reason_text as string | null);
  if (code === null) return null;
  const stored = parseJson<Record<string, unknown>>((run.reason_detail as string | null) ?? null);
  if (stored && stored.code === code && typeof stored.reason === 'string') return { code, reason: stored.reason, what_to_do: stored.what_to_do ?? null, subject: stored.subject ?? {} };
  return { code, reason: (run.reason_text as string | null) ?? code, what_to_do: null, subject: {} };
}

// GET /v1/projects/:p/runs/:r. A read: it writes nothing.
export function runRepresentation(db: Tx['db'], args: { project: string; run: string }) {
  const run = db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(args.run) as Record<string, unknown> | undefined;
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  // Each domain with the fingerprint of the validated mount plan its sandbox
  // was built from (D2 §2.3; A.6 P12), null for a domain no sandbox was
  // built for.
  // With the domain's observation and its backend's exit class, two separate
  // facts (D2 §1.6, N02), and the resource counters the boundary read.
  const domains = (
    db
      .prepare('SELECT "id", "status", "profile", "plan_fingerprint", "observation", "observed_at", "exit_class", "exit_evidence", "resource_events" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"')
      .all(args.run) as Record<string, unknown>[]
  ).map((d) => ({ ...d, exit_evidence: parseJson<unknown>((d.exit_evidence as string | null) ?? null), resource_events: parseJson<unknown>((d.resource_events as string | null) ?? null) }));
  // The validated mount plan the run's sandbox was built from (SEAM.md
  // §133): null before validation and for a launch refused before it.
  const planned = db
    .prepare('SELECT "profile", "plan_fingerprint", "mount_plan_record" FROM "execution_domains" WHERE "run" = ? AND "mount_plan_record" IS NOT NULL ORDER BY "id" DESC LIMIT 1')
    .get(args.run) as { profile: string; plan_fingerprint: string; mount_plan_record: string } | undefined;
  const receipts = (
    db.prepare('SELECT "id", "trust_entry", "qualification_attempt", "provider_session_id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(args.run) as {
      id: string;
      trust_entry: string | null;
      qualification_attempt: string | null;
      provider_session_id: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    trust_entry: r.trust_entry,
    qualification_attempt: r.qualification_attempt,
    provider_session_id: r.provider_session_id,
    statuses: (db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(r.id) as { status: string }[]).map(
      (o) => o.status,
    ),
  }));
  const workspace = db.prepare('SELECT "id", "path", "disposition" FROM "workspaces" WHERE "run" = ?').get(args.run) ?? null;
  // A checkpoint the role asked for is pending until its snapshot is
  // committed as a checkpoint revision; a request is not a checkpoint (Review
  // N06; SEAM.md §95). A run that ended without one never had it.
  let asked = false;
  try {
    asked = (JSON.parse((run.result_value as string | null) ?? 'null') as { checkpoint?: unknown } | null)?.checkpoint === true;
  } catch {
    asked = false;
  }
  const revision = db.prepare(`SELECT "id" FROM "revisions" WHERE "created_by_run" = ? AND "kind" = 'checkpoint' ORDER BY "recorded_at", "id" LIMIT 1`).get(args.run) as { id: string } | undefined;
  const checkpoint = revision
    ? { status: 'accepted', revision: revision.id }
    : asked
      ? { status: run.state === 'ended' ? 'not_taken' : 'pending', revision: null }
      : null;
  const successor = db.prepare('SELECT "id" FROM "runs" WHERE "parent_run" = ? ORDER BY "seq" LIMIT 1').get(args.run) as { id: string } | undefined;
  // The invocation's exit class, from its terminal observation once the run
  // has ended, else as the boundary recorded it on the domain.
  const terminal = db
    .prepare(
      `SELECT o."exit_class", o."exit_evidence" FROM "invocation_status_observations" o JOIN "invocation_receipts" r ON r."id" = o."invocation"
       WHERE r."run" = ? AND o."exit_class" IS NOT NULL ORDER BY o."seq" DESC LIMIT 1`,
    )
    .get(args.run) as { exit_class: string; exit_evidence: string | null } | undefined;
  const latestDomain = (domains as Record<string, unknown>[]).at(-1);
  const exitClass = terminal?.exit_class ?? (latestDomain?.exit_class as string | null | undefined) ?? null;
  const exitEvidence = terminal ? parseJson<unknown>(terminal.exit_evidence) : (latestDomain?.exit_evidence ?? null);
  return {
    run: {
      id: run.id,
      project: run.project,
      work_item: run.work_item,
      role: run.role,
      state: run.state,
      outcome: run.outcome,
      reason_class: run.reason_class,
      code: publicCode(run.reason_class as string | null, run.reason_text as string | null),
      // The refusal in its form beside the code (SEAM.md §116): what the
      // engine decided before launch, with its subject.
      refusal: refusalOf(run),
      // What became of each Alpha exception proposal the run's Reviewer made
      // (SEAM.md §119).
      alpha_exception_proposals: parseJson<unknown[]>((run.alpha_exception_outcomes as string | null) ?? null) ?? [],
      mount_plan: planned ? { profile: planned.profile, fingerprint: planned.plan_fingerprint, record: planned.mount_plan_record } : null,
      // The run's accepted result record, null when none was accepted (D2
      // §1.4); what collection from the volatile filesystem found; and how
      // the backend ended, apart from the domain's observation (§1.6).
      result: run.result ?? null,
      collection: parseJson<unknown>((run.collection as string | null) ?? null),
      exit_class: exitClass,
      exit_evidence: exitEvidence,
      observation: (latestDomain?.observation as string | null | undefined) ?? null,
      quarantined: run.quarantined === 1,
      backend: run.backend,
      base_revision: run.base_revision,
      deadline_at: run.deadline_at,
      parent_run: run.parent_run ?? null,
      successor_run: successor?.id ?? null,
      checkpoint,
      grant: run.grant,
      domains,
      receipts,
      workspace,
    },
  };
}

