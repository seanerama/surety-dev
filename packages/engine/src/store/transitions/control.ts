// The slice-2 API commands (D1 §8.4, §10.5, §11.4; SEAM.md §17): the tick
// request, Stop and Abandon through their confirmation decisions, answering
// a decision, and the run representation. Each command is one transition and
// commits with its api.act record (store worker, `mutate`).

import { Refusal } from '../../refusal.js';
import { illegal, notFound } from './common.js';
import { type DecisionRow, checkAnswer, consumeDecision, currentPreview, openDecision, raiseDecision, stale } from './decisions.js';
import { beginEnd, getRun, runBlockerManifest, workBlockerManifest } from './runs.js';
import type { Tx } from './tx.js';
import { getWorkItem, transitionWork } from './work.js';

// What a command hands back to the main thread besides its reply: work that
// must start once the transaction has committed.
export type Effect = { kind: 'tick' } | { kind: 'end_run'; run: string };

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

// A.8 stop_confirm / abandon_confirm manifest: run state, domain status,
// workspace disposition.
function controlManifest(tx: Tx, runId: string): Record<string, unknown> {
  const run = getRun(tx, runId);
  const domains = tx.db.prepare('SELECT "id", "status" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').all(runId) as { id: string; status: string }[];
  const ws = tx.db.prepare('SELECT "disposition" FROM "workspaces" WHERE "run" = ?').get(runId) as { disposition: string } | undefined;
  return { run: runId, run_state: run?.state ?? null, domains: domains.map((d) => [d.id, d.status]), workspace: ws?.disposition ?? null };
}

function manifestOf(tx: Tx, d: DecisionRow): Record<string, unknown> {
  if (d.kind === 'stop_confirm' || d.kind === 'abandon_confirm') return controlManifest(tx, d.subject_id);
  if (d.subject_type === 'run') return runBlockerManifest(tx, d.subject_id);
  return workBlockerManifest(tx, d);
}

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

// POST /v1/projects/:p/runs/:r/stop and /abandon. Without a preview hash the
// confirmation decision is raised (or the open one returned) and the answer
// is 409 confirm_required; with the decision's preview hash it is consumed and
// the run-end protocol begins. The route cannot bypass the queue (D1 §10.1).
export function controlRun(tx: Tx, args: { project: string; run: string; kind: Control; previewHash: string | undefined }): CommandResult {
  const run = getRun(tx, args.run);
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  if (run.state === 'finalizing' || run.state === 'ended') {
    throw illegal(`${args.kind === 'stop' ? 'Stop' : 'Abandon'} of a ${run.state} run`, { run: run.id, state: run.state });
  }
  const kind = CONFIRM[args.kind];
  if (args.previewHash === undefined) {
    const decision = raiseDecision(tx, {
      project: run.project,
      kind,
      subjectType: 'run',
      subjectId: run.id,
      question:
        args.kind === 'stop'
          ? `Stop run ${run.id}? Its role is terminated, what it observed is kept, its workspace is retained and its work is held until you resume it.`
          : `Abandon run ${run.id}? Its role is terminated, its workspace is discarded once termination is confirmed, and its work waits under a dispatch hold until you resume it.`,
      options: [
        {
          key: 'confirm',
          label: args.kind === 'stop' ? 'Stop' : 'Abandon',
          consequence: args.kind === 'stop' ? 'The run ends stopped and the work is held.' : 'The run ends abandoned and the workspace is discarded.',
          effect: { run: run.id, outcome: args.kind === 'stop' ? 'stopped' : 'abandoned' },
        },
      ],
      manifest: controlManifest(tx, run.id),
    });
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
    throw new Refusal(409, 'decision_stale', 'No confirmation is open for this run, or it was replaced.', 'Send the request without a preview hash to get the current confirmation.', {
      run: run.id,
    });
  }
  if (args.previewHash !== open.preview_hash || currentPreview(open, controlManifest(tx, run.id)) !== open.preview_hash) throw stale(open);
  consumeDecision(tx, open, 'confirm', null);
  return applyControl(tx, args.kind, run.id);
}

// POST /v1/projects/:p/decisions/:d/answer (D1 §10.5; SEAM.md §17).
export function answerDecision(tx: Tx, args: { project: string; decision: string; option: unknown; preview_hash: unknown; note: unknown }): CommandResult {
  const d = checkAnswer(tx, args, (row) => manifestOf(tx, row));
  const option = args.option as string;
  const note = typeof args.note === 'string' ? args.note : null;
  if (d.kind === 'stop_confirm' || d.kind === 'abandon_confirm') {
    const run = getRun(tx, d.subject_id);
    if (!run || run.state === 'finalizing' || run.state === 'ended') throw stale(d);
    consumeDecision(tx, d, option, note);
    const result = applyControl(tx, d.kind === 'stop_confirm' ? 'stop' : 'abandon', run.id);
    return { ...result, body: { decision: { id: d.id, status: 'consumed' }, ...(result.body as object) } };
  }
  if (d.subject_type === 'work_item') {
    const item = getWorkItem(tx, d.subject_id);
    if (!item || item.status !== 'parked') throw stale(d);
    consumeDecision(tx, d, option, note);
    if (option === 'retry') transitionWork(tx, item, 'eligible', { blocker: null, repair_due: 0 }, { decision: d.id, cause: 'retry' });
    else transitionWork(tx, item, 'cancelled', { blocker: null }, { decision: d.id, cause: 'cancel' });
    return { status: 200, body: { decision: { id: d.id, status: 'consumed' } } };
  }
  // A quarantine blocker: the acknowledgement is recorded and establishes
  // nothing (build spec §6 correction 2).
  consumeDecision(tx, d, option, note);
  return { status: 200, body: { decision: { id: d.id, status: 'consumed' } } };
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

// GET /v1/projects/:p/runs/:r.
export function runRepresentation(tx: Tx, args: { project: string; run: string }) {
  const run = tx.db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(args.run) as Record<string, unknown> | undefined;
  if (!run || run.project !== args.project) throw notFound('run', args.run);
  const domains = tx.db.prepare('SELECT "id", "status" FROM "execution_domains" WHERE "run" = ? ORDER BY "id"').all(args.run);
  const receipts = (tx.db.prepare('SELECT "id" FROM "invocation_receipts" WHERE "run" = ? ORDER BY "id"').all(args.run) as { id: string }[]).map((r) => ({
    id: r.id,
    statuses: (tx.db.prepare('SELECT "status" FROM "invocation_status_observations" WHERE "invocation" = ? ORDER BY "seq"').all(r.id) as { status: string }[]).map(
      (o) => o.status,
    ),
  }));
  const workspace = tx.db.prepare('SELECT "id", "path", "disposition" FROM "workspaces" WHERE "run" = ?').get(args.run) ?? null;
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
      parent_run: run.parent_run,
      grant: run.grant,
      domains,
      receipts,
      workspace,
    },
  };
}
