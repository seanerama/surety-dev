// The slice-2 API commands (D1 §8.4, §10.5, §11.4; SEAM.md §17): the tick
// request, Stop and Abandon through their confirmation decisions, answering
// a decision, and the run representation. Each command is one transition and
// commits with its api.act record (store worker, `mutate`).

import { Refusal } from '../../refusal.js';
import { illegal, notFound } from './common.js';
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

// D1 A.7: the public code reported on a run's representation.
function publicCode(reason: string | null, text: string | null): string | null {
  switch (reason) {
    case 'diff_violation':
    case 'ref_violation':
    case 'invalid_result':
    case 'integration_conflict':
      return reason;
    case 'preflight_refused':
      return text === 'isolation_unqualified' ? 'isolation_unqualified' : 'backend_refused';
    case 'budget':
      return 'budget_exhausted';
    default:
      return null;
  }
}

// GET /v1/projects/:p/runs/:r. A read: it writes nothing.
export function runRepresentation(db: Tx['db'], args: { project: string; run: string }) {
  const run = db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(args.run) as Record<string, unknown> | undefined;
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  const domains = db.prepare('SELECT "id", "status" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').all(args.run);
  const receipts = (db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(args.run) as { id: string }[]).map((r) => ({
    id: r.id,
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

