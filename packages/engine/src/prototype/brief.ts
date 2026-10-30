// Rapid prototype to Alpha, slice E3 (the owner's rulings R1, R3 and R5 of
// 2026-10-28; migration 0045): the brief, its preparation, and the first
// plan.
//
//   1. When an iteration is created, the owner is asked to authorize one
//      brief preparation run (`prototype_preparation_approval`, R5): the
//      role and model that will run, the per-run token limit and its cost
//      estimated at the price table (an estimate, never a cap), that it is
//      counted in the prototype's totals as its own subtotal, and that the
//      approval authorizes exactly one run. A scripted provider's question
//      is asked the same way and says no paid work follows.
//   2. Approved, a `brief_preparation` run of the Spec Writer is
//      dispatched. It reads the idea and writes the minimal specification
//      (3 to 5 observable objectives, R3) and, in its result, the brief's
//      idea-derived fields. At acceptance (runs/accept.ts) the engine
//      validates them, fills what it serves itself (the target and its real
//      exposure, the roles' models, the limits, the preparation, the stop
//      conditions), writes the brief as a `prototype_brief` record, and the
//      integration's finalizer records the specification's semantics and
//      raises the ordinary `spec_approval` about the run, the brief named in
//      its manifest (recordPreparedBrief).
//   3. The brief approved (the existing spec application), the first plan
//      is asked of the Architect as a one-shot `replan`; its bundle,
//      checked by the plan check, is published by the prototype policy when
//      within its bounds (withinPrototypeBounds: R1), recorded as
//      `policy_authorized`, never as a human approval; otherwise the
//      ordinary architecture_approval and plan_approval are raised.
//   4. The iteration's owner-facing status follows (syncIterationStatuses):
//      awaiting_owner while one of the owner's questions about its work is
//      open, failed while a work item of it is parked, building otherwise.
//
// Nothing here answers an owner's decision (D1 §10.1; E12).
//
// Not built in this slice: "Edit brief" (the owner's own edit of a brief
// before approving it) is deferred; the brief approval card offers approve
// and reject only, and a changed brief is a new preparation (POST
// …/iterations/:i/prepare). Iterate (a new iteration with its predecessor)
// is slice E4's (prototype/iterate.ts); a continuing iteration's question and
// package name what it continues (continuationOf).

import { Refusal } from '../refusal.js';
import { PROTOTYPE_LIMIT_KEYS } from '../config/schema.js';
import { type DecisionRow, consumeDecision, invalidateDecision } from '../store/transitions/decisions.js';
import type { CommandResult } from '../store/transitions/control.js';
import { attemptSpendEstimate, attemptSpendUnavailable } from '../store/transitions/ledger.js';
import { recordSemantics } from '../spec/approval.js';
import { SPEC_AREAS_LABEL, SPEC_HEADER_FIELDS, SPEC_SECTIONS, type SemanticFinding, type SpecRepresentation } from '../spec/semantics.js';
import { INDEX_COLUMNS } from '../checks/requirement-index.js';
import { type KindSpec, type Subject, consumed, raiseQuestion, recordApproval } from '../store/transitions/queue.js';
import { policyRevision, projectPolicy, roleModel } from '../store/transitions/settings.js';
import { resolveBackend } from '../store/transitions/trust.js';
import { PROVIDER_REFUSAL_NEXT_STEP, UNKNOWN_NEXT_STEP, effectiveAllowanceOf, endProviderHold, providerHoldOf, providerRefusalReason, unresolvedAccounting } from '../store/transitions/prototype.js';
import type { Tx } from '../store/transitions/tx.js';
import { type WorkRow, getWorkItem, observeTrigger, transitionWork } from '../store/transitions/work.js';
import type { BundleContent } from '../plan/bundle.js';
import type { PlanCheckResult } from '../plan/check.js';

type Db = Tx['db'];

export const PREPARATION_WORK = 'brief_preparation';
export const PREPARATION_SOURCE = 'prototype_preparation';
export const FIRST_PLAN_SOURCE = 'prototype_first_plan';
export const PREPARATION_ROLE = 'spec_writer';
// R3: three to five observable objectives, one per requirement.
export const OBJECTIVES = { min: 3, max: 5 } as const;
// R1: what the prototype policy publishes without asking.
export const PROTOTYPE_BOUNDS = { phases: 1, max_stages: 2 } as const;
// Who published a plan under the prototype policy, and its routing.
export const POLICY_PUBLISHER = 'policy:rapid_prototype';
export const POLICY_ROUTING = 'policy_authorized';

// The brief, exactly the shape the console renders (console C1,
// ws-prototype.js BRIEF_SHAPE), in its order.
export const BRIEF_FIELDS = ['version', 'prepared_at', 'app', 'for', 'experience', 'included', 'objectives', 'mocked', 'left_out', 'assumptions', 'limitations', 'constraints', 'target', 'models', 'estimates', 'preparation', 'limits', 'stop_conditions'] as const;
// What the Spec Writer's result gives (`brief` in its report): the
// idea-derived fields. The rest are the engine's, from what it serves.
export const MODEL_TEXT_FIELDS = ['app', 'for', 'experience'] as const;
export const MODEL_LIST_FIELDS = ['included', 'objectives', 'mocked', 'left_out', 'assumptions', 'limitations', 'constraints'] as const;
export const MODEL_FIELDS = [...MODEL_TEXT_FIELDS, ...MODEL_LIST_FIELDS, 'estimates'] as const;
export const ENGINE_FIELDS = ['version', 'prepared_at', 'target', 'models', 'preparation', 'limits', 'stop_conditions'] as const;
const ESTIMATE_KEYS = ['runs', 'tokens', 'usd', 'minutes'] as const;

// The roles a T1 prototype's build runs (no Reviewer at T1, F §5.7).
const BUILD_ROLES = ['spec_writer', 'architect', 'verifier', 'builder'] as const;

// The standard stop conditions (the proposal §2; R4): when the engine stops
// and asks the owner again.
export const STOP_CONDITIONS = [
  'a limit is reached (token allowance, estimated spend, runtime, or automatic repairs): no new run starts; runs already running end at their own limits',
  'a change to the automated checks or their toolchain needs your review (check approval)',
  'the first plan is outside the prototype bounds (more than one phase or two stages, or beyond the brief): you approve it as an ordinary plan',
  'work fails after its automatic repairs, or a gate refuses: you retry, cancel or discard',
  'a check change the engine cannot classify, a finding you must disposition, or an out-of-band change to the repository or the environment',
  "the Alpha environment is not configured, its adapter is not qualified, or its deployment's verification fails",
  'the configured model cannot be used: there is no fallback, Surety stops and asks',
  'you Stop or Discard the prototype',
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

interface IterationLite {
  id: string;
  project: string;
  seq: number;
  status: string;
  approved_at: string | null;
  brief_record: string | null;
  brief_json: string | null;
  brief_decision: string | null;
  plan_bundle: string | null;
  next_step: string | null;
  outcome_reason: string | null;
  created_at: string;
  predecessor: string | null;
  change_text: string | null;
  // C2k (migration 0051).
  provider_hold_since?: string | null;
}

const iterationById = (db: Db, id: string): IterationLite | undefined => db.prepare('SELECT * FROM "prototype_iterations" WHERE "id" = ?').get(id) as IterationLite | undefined;
const currentOf = (db: Db, project: string): IterationLite | undefined =>
  db.prepare('SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as IterationLite | undefined;
const isPrototype = (db: Db, project: string): boolean => (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode === 'rapid_prototype';

// The iteration's owner-facing status and next step changed, with an event.
function setStatus(tx: Tx, it: IterationLite, status: string, nextStep: string | null, extra: { reason?: string | null; ended?: boolean } = {}): void {
  const reason = extra.reason ?? null;
  if (it.status === status && it.next_step === nextStep && (it.outcome_reason ?? null) === reason) return;
  tx.db.prepare('UPDATE "prototype_iterations" SET "status" = ?, "next_step" = ?, "outcome_reason" = ?, "ended_at" = ? WHERE "id" = ?').run(status, nextStep, reason, extra.ended ? tx.at : null, it.id);
  tx.emit('prototype.iteration_status_changed', { project: it.project, iteration: it.id }, { from: it.status, to: status, next_step: nextStep, reason });
}

// ---- the role and model a run of a role would use, as the engine resolves it now ----

export interface RoleModel {
  role: string;
  provider: string;
  model: string;
  // How the engine resolves the role's backend now: a scripted backend, an
  // active trust entry, or refused (and why).
  resolution: 'scripted' | 'entry' | 'refused';
  refusal: string | null;
}

export function roleModelOf(db: Db, project: string, role: string): RoleModel {
  const r = resolveBackend(db, { project, role, scripted: 'scripted' });
  // Refused now (no active entry, unconfigured): the model the role
  // requests, where its policy names one, is what would run once it resolves.
  if (r.kind === 'refused') return { role, provider: r.backend, model: roleModel(db, project, role) ?? r.model, resolution: 'refused', refusal: r.reason };
  return { role, provider: r.backend, model: r.kind === 'entry' ? r.entry.model : r.model, resolution: r.kind, refusal: null };
}

// ---- 1. the preparation authorization (R5) -------------------------------------------------

// What `prototype_preparation_approval` binds: the iteration and its state,
// the role, provider and model the run would be dispatched to, its per-run
// token limit and the estimate at the price table, the idea it reads, and
// the policy.
export const PREPARATION_KEYS = [
  'iteration',
  'iteration_seq',
  'iteration_status',
  'role',
  'provider',
  'model',
  'resolution',
  'run_token_limit',
  'estimated_usd',
  'estimate_basis',
  'paid',
  'authorizes',
  'idea_version',
  'idea_blob',
  'policy_revision',
  // Slice E4 (R7): the iteration it continues and the owner's change.
  'continues',
  'change',
];

// Slice E4 (R7): the iteration an Iterate continues (its predecessor), and
// the latest approved brief along the chain of predecessors (the brief the
// new preparation starts from): null for a first iteration.
export interface Continuation {
  predecessor: string;
  predecessor_seq: number;
  change: string | null;
  // The latest approved brief among the predecessors (by the chain, not by
  // time), and the iteration that approved it; null when none was approved.
  previous_brief: Record<string, unknown> | null;
  previous_brief_iteration_seq: number | null;
  previous_brief_spec_revision: string | null;
}

export function continuationOf(db: Db, iteration: string): Continuation | null {
  const it = iterationById(db, iteration);
  if (!it || it.predecessor === null) return null;
  const pred = iterationById(db, it.predecessor);
  if (!pred) return null;
  let at: (IterationLite & { brief_spec_revision?: string | null }) | undefined = pred;
  const seen = new Set<string>();
  while (at && !(at.approved_at !== null && at.brief_json !== null)) {
    seen.add(at.id);
    at = at.predecessor === null || seen.has(at.predecessor) ? undefined : iterationById(db, at.predecessor);
  }
  let brief: Record<string, unknown> | null = null;
  try {
    brief = at?.brief_json ? (JSON.parse(at.brief_json) as Record<string, unknown>) : null;
  } catch {
    brief = null;
  }
  return {
    predecessor: pred.id,
    predecessor_seq: pred.seq,
    change: it.change_text,
    previous_brief: brief,
    previous_brief_iteration_seq: brief === null ? null : at!.seq,
    previous_brief_spec_revision: brief === null ? null : ((at as { brief_spec_revision?: string | null }).brief_spec_revision ?? null),
  };
}

// The work items of the iteration's preparations not yet over.
function preparationPending(db: Db, iteration: string): string | null {
  const row = db
    .prepare(
      `SELECT w."id" FROM "work_items" w WHERE w."kind" = 'brief_preparation' AND w."status" NOT IN ('complete', 'cancelled', 'parked')
         AND json_extract(w."subject", '$.decision') IN (SELECT d."id" FROM "decisions" d WHERE d."kind" = 'prototype_preparation_approval' AND d."subject_id" = ?) LIMIT 1`,
    )
    .get(iteration) as { id: string } | undefined;
  return row?.id ?? null;
}

export function preparationManifest(db: Db, iteration: string): Record<string, unknown> {
  const it = iterationById(db, iteration);
  if (!it) return { iteration, iteration_seq: null, iteration_status: null, role: PREPARATION_ROLE, provider: null, model: null, resolution: null, run_token_limit: null, estimated_usd: null, estimate_basis: null, paid: null, authorizes: null, idea_version: null, idea_blob: null, policy_revision: null, continues: null, change: null };
  const rm = roleModelOf(db, it.project, PREPARATION_ROLE);
  // Slice E5 (S5): the run's effective allowance as it would be given now,
  // the lower of the per-run limit and what the iteration has left; the
  // per-run limit itself when none is positive now (the dispatch is then
  // refused, and the read says why).
  const perRun = projectPolicy(db, it.project).budget_run_billable_tokens!;
  const allowance = effectiveAllowanceOf(db, it as unknown as Parameters<typeof effectiveAllowanceOf>[1], perRun);
  const limit = allowance?.effective_limit_tokens ?? perRun;
  const paid = rm.provider !== 'scripted';
  const est = paid ? attemptSpendEstimate(rm.provider, rm.model, limit, 1) : null;
  const p = db.prepare('SELECT "idea_version", "idea_blob" FROM "projects" WHERE "id" = ?').get(it.project) as { idea_version: number | null; idea_blob: string | null };
  const cont = continuationOf(db, it.id);
  return {
    iteration: it.id,
    iteration_seq: it.seq,
    iteration_status: it.status,
    role: PREPARATION_ROLE,
    provider: rm.provider,
    model: rm.model,
    resolution: rm.resolution,
    run_token_limit: limit,
    // The whole run limit priced at the model's output rate: an estimate of
    // what the run may cost at most under its limit, never a cap (the
    // provider bills what it bills); null, never 0, with no price.
    estimated_usd: est === null ? null : est.usd,
    estimate_basis: !paid
      ? 'scripted provider: unpaid, no price applies'
      : est === null
        ? (attemptSpendUnavailable(rm.provider, rm.model) ?? `no price for ${rm.provider} ${rm.model}`)
        : `${limit} billable tokens at the output rate of ${rm.model} in price table ${est.price_version}${est.bound === 'lower' ? ' (a lower bound)' : ''}: the run's allowance priced, an estimate of the most it may cost, not a measurement of what it will use`,
    paid,
    authorizes: 'exactly one brief_preparation run',
    idea_version: p.idea_version,
    idea_blob: p.idea_blob,
    policy_revision: policyRevision(db, it.project),
    continues: cont === null ? null : { iteration: cont.predecessor, seq: cont.predecessor_seq, previous_brief_iteration_seq: cont.previous_brief_iteration_seq, previous_brief_spec_revision: cont.previous_brief_spec_revision },
    change: cont === null ? null : cont.change,
  };
}

const usd = (v: unknown): string => (typeof v === 'number' ? `$${v.toFixed(2)}` : 'unknown');

export const PROTOTYPE_PREPARATION_APPROVAL: KindSpec = {
  preview(tx, d: Subject) {
    const it = iterationById(tx.db, d.subject_id);
    // The question stands while the iteration is its project's current one,
    // preparing or awaiting its brief's approval, and no preparation it
    // authorized is under way.
    if (!it || currentOf(tx.db, it.project)?.id !== it.id) return null;
    if (it.status !== 'preparing' && it.status !== 'awaiting_brief_approval') return null;
    if (preparationPending(tx.db, it.id) !== null) return null;
    const m = preparationManifest(tx.db, it.id);
    const who = `the Spec Writer (role ${PREPARATION_ROLE}) on ${String(m.provider)} model ${String(m.model)}`;
    const refused = m.resolution === 'refused' ? ` The ${PREPARATION_ROLE} role's backend is refused now (${roleModelOf(tx.db, it.project, PREPARATION_ROLE).refusal ?? 'unconfigured'}): the run is dispatched only once it resolves.` : '';
    const perRun = projectPolicy(tx.db, it.project).budget_run_billable_tokens!;
    const limitText =
      m.run_token_limit === perRun
        ? `Its token limit is ${String(m.run_token_limit)} billable tokens (the per-run limit)`
        : `Its effective token limit is ${String(m.run_token_limit)} billable tokens: the per-run limit of ${perRun}, capped at what the iteration has left of its token allowance`;
    // The owner's ruling of 2026-10-29: the limit is an allowance, said as
    // such, apart from what the run will be measured to use.
    const allowanceText = ' This limit is an estimated allowance, the most the run may use, not a measurement: what it uses is counted as the backend reports it, and if its usage is not fully known it is charged its limit less what was observed, conservatively.';
    const cost = m.paid
      ? `${limitText}; at the price table that is an estimated ${usd(m.estimated_usd)} at most (${String(m.estimate_basis)}): an estimate, not a cap.${allowanceText}`
      : `${limitText}. The scripted provider is unpaid: no paid work follows.${allowanceText}`;
    // Slice E4 (R7): an iteration that continues another says which, and
    // the change the owner asked for.
    const cont = m.continues as { seq: number; previous_brief_iteration_seq: number | null } | null;
    const continues =
      cont === null
        ? ''
        : ` This is iteration ${it.seq} of the app, continuing from iteration ${cont.seq}: ${m.change === null ? 'you gave no change request' : `the change you asked for is "${String(m.change)}"`}; the preparation starts from ${cont.previous_brief_iteration_seq === null ? 'the idea (no earlier brief was approved)' : `the brief approved in iteration ${cont.previous_brief_iteration_seq}`}, and its brief, once you approve it, is a new specification revision. Iteration ${cont.seq}'s runs, usage, receipt and Alpha are kept as they are.`;
    return {
      manifest: m,
      question: `Authorize one brief preparation run for prototype iteration ${it.seq}?${continues} It runs ${who}, reads the idea (.surety/idea.md, version ${String(m.idea_version)}) and writes the brief and the minimal specification for your approval. ${cost} Its usage is counted in the prototype's totals as its own subtotal (brief preparation). Approving authorizes exactly one preparation run; it approves neither the brief nor the build.${refused}`,
      options: [
        {
          key: 'approve',
          label: 'Authorize one preparation run',
          consequence: m.paid
            ? `One brief preparation run is dispatched to ${String(m.provider)} ${String(m.model)}, paid by your provider account, up to ${String(m.run_token_limit)} billable tokens (estimated ${usd(m.estimated_usd)} at most, not a cap). It writes the brief for your approval; nothing else is authorized.`
            : `One brief preparation run is dispatched to the scripted provider; no paid work follows. It writes the brief for your approval; nothing else is authorized.`,
          effect: { iteration: it.id, dispatch: PREPARATION_WORK, runs: 1 },
        },
        { key: 'reject', label: 'Do not prepare', consequence: 'Nothing is dispatched; the iteration stays preparing (next: approve preparation or discard).', effect: { iteration: it.id } },
      ],
    };
  },
  manifest: (tx, d) => preparationManifest(tx.db, d.subject_id),
  reraise: false,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    const it = iterationById(tx.db, d.subject_id)!;
    if (option !== 'approve') {
      setStatus(tx, it, it.status === 'awaiting_brief_approval' ? 'awaiting_brief_approval' : 'preparing', it.status === 'awaiting_brief_approval' ? 'approve the brief, or prepare again, or discard' : 'approve preparation or discard');
      tx.emit('prototype.preparation_declined', { project: it.project, iteration: it.id }, { decision: d.id });
      return consumed(d);
    }
    const m = preparationManifest(tx.db, it.id);
    recordApproval(tx, d, { consequence: `one brief preparation run of iteration ${it.seq} authorized`, subjectType: 'prototype_iteration', subjectId: it.id });
    const work = observeTrigger(tx, { project: it.project, kind: PREPARATION_WORK, trigger_source: PREPARATION_SOURCE, trigger_id: d.id, trigger_generation: 1, subject: { decision: d.id }, chain: 0 }, { iteration: it.id, decision: d.id }).work_item.id;
    setStatus(tx, it, it.status, 'wait: the brief is being prepared');
    tx.emit('prototype.preparation_authorized', { project: it.project, iteration: it.id }, { decision: d.id, work_item: work, role: m.role, provider: m.provider, model: m.model, run_token_limit: m.run_token_limit, estimated_usd: m.estimated_usd, paid: m.paid });
    return consumed(d, [{ kind: 'tick' }]);
  },
};

// The question raised about an iteration (at its creation, and again on the
// owner's request). null when it does not stand.
export function raisePreparation(tx: Tx, args: { project: string; iteration: string }): DecisionRow | null {
  return raiseQuestion(tx, { project: args.project, kind: 'prototype_preparation_approval', subjectType: 'prototype_iteration', subjectId: args.iteration });
}

// POST /v1/projects/:p/iterations/:i/prepare: the preparation asked for
// again (after a declined authorization, a failed run, a rejected brief, or
// to replace a brief awaiting approval). Refused when it cannot stand.
export function requestPreparation(tx: Tx, args: { project: string; iteration: string }): CommandResult {
  const it = iterationById(tx.db, args.iteration);
  if (!it || it.project !== args.project) throw new Refusal(404, 'not_found', `Iteration ${args.iteration} of project ${args.project} does not exist.`, 'Read GET /v1/projects/:p/iterations.', { iteration: args.iteration });
  if (currentOf(tx.db, it.project)?.id !== it.id) throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq} is not the project's current iteration.`, 'Prepare the current iteration.', { iteration: it.id });
  // Slice E5 (the owner's ruling S2): "'prepare again' must not bypass
  // unresolved accounting": refused, with what is unknown, whatever the
  // iteration's status.
  const unresolved = unresolvedAccounting(tx.db, it.project, it.id);
  if (unresolved !== null) {
    throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq}'s brief cannot be prepared again while its accounting is unresolved: ${unresolved.text}.`, `Next: ${UNKNOWN_NEXT_STEP}.`, {
      iteration: it.id,
      status: it.status,
      unknown_invocations: unresolved.invocations,
      runs: unresolved.runs,
    });
  }
  if (it.status !== 'preparing' && it.status !== 'awaiting_brief_approval') {
    throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq} is ${it.status}: a brief is prepared only while it is preparing or awaiting its brief's approval.`, 'Read the iteration; its next step says what is possible.', { iteration: it.id, status: it.status });
  }
  const pending = preparationPending(tx.db, it.id);
  if (pending !== null) throw new Refusal(409, 'illegal_transition', `A brief preparation of iteration ${it.seq} is already authorized and not over (work item ${pending}).`, 'Wait for it to end.', { iteration: it.id, work_item: pending });
  // Slice E5b (row M602 (d); objection 221): a preparation already put to
  // the owner and not yet answered is refused, naming it, never answered
  // again as if it were a new one.
  const asked = tx.db.prepare(`SELECT "id" FROM "decisions" WHERE "kind" = 'prototype_preparation_approval' AND "subject_id" = ? AND "status" = 'open' ORDER BY "seq" DESC LIMIT 1`).get(it.id) as { id: string } | undefined;
  if (asked) {
    throw new Refusal(409, 'illegal_transition', `Iteration ${it.seq}'s brief preparation is already awaiting your authorization (decision ${asked.id}).`, 'Answer or reject that decision first.', { iteration: it.id, decision: asked.id });
  }
  const d = raisePreparation(tx, args);
  if (d === null) throw new Refusal(409, 'illegal_transition', `The preparation of iteration ${it.seq} cannot be asked now.`, 'Read the iteration.', { iteration: it.id });
  if (it.status === 'preparing') setStatus(tx, it, 'preparing', 'approve preparation or discard');
  return { status: 201, body: { decision: { id: d.id, kind: d.kind, status: d.status, preview_hash: d.preview_hash } } };
}

// A preparation run that ended other than completed (runs.ts workAfterRun):
// its work is cancelled, never repaired (the authorization was for exactly
// one run), and the iteration stays preparing, its next step "prepare again
// or discard". A brief that was awaiting approval is left as it was.
export function preparationEnded(tx: Tx, item: WorkRow, run: { id: string; outcome: string | null; reason_class: string | null; reason_text?: string | null }): void {
  transitionWork(tx, item, 'cancelled', {}, { run: run.id, outcome: run.outcome, cause: 'preparation_failed' });
  const decision = (JSON.parse(item.subject) as { decision?: string }).decision ?? null;
  const it = decision === null ? undefined : (tx.db.prepare(`SELECT p.* FROM "prototype_iterations" p JOIN "decisions" d ON d."subject_id" = p."id" WHERE d."id" = ?`).get(decision) as IterationLite | undefined);
  if (!it) return;
  const why = `the brief preparation run ${run.id} ended ${run.outcome ?? 'unknown'}${run.reason_class && run.reason_class !== 'none' ? ` (${run.reason_class})` : ''}${run.reason_text ? `: ${run.reason_text}` : ''}`;
  if (it.status === 'preparing') setStatus(tx, it, 'preparing', 'prepare again or discard', { reason: why });
  tx.emit('prototype.preparation_failed', { project: it.project, iteration: it.id }, { run: run.id, work_item: item.id, outcome: run.outcome, reason_class: run.reason_class, reason: why });
}

// ---- 2. the brief (R3) -------------------------------------------------------------------

export interface BriefEstimates {
  runs: number | [number, number];
  tokens: number | [number, number];
  usd: number | [number, number];
  minutes: number | [number, number];
}

export interface ModelBrief {
  app: string;
  for: string;
  experience: string;
  included: string[];
  objectives: string[];
  mocked: string[];
  left_out: string[];
  assumptions: string[];
  limitations: string[];
  constraints: string[];
  estimates: BriefEstimates;
}

const estimateOk = (v: unknown): boolean => isCount(v) || (Array.isArray(v) && v.length === 2 && isCount(v[0]) && isCount(v[1]) && (v[0] as number) <= (v[1] as number));

// The Spec Writer's `brief` validated against the specification it wrote
// (R3): the idea-derived fields only, each in its form; 3 to 5 objectives,
// as many as the specification's requirements, each requirement named by
// one (its key in the text); a field the engine fills, or any other, is
// refused by name. An idea that does not fit five objectives is proposed
// smaller, what is left out listed (`left_out`): never silently dropped.
export function validateModelBrief(v: unknown, rep: SpecRepresentation): { brief: ModelBrief } | { refused: string } {
  if (!isObject(v)) return { refused: 'the result carries no `brief` object: a brief preparation must report the brief' };
  for (const k of Object.keys(v)) {
    if ((ENGINE_FIELDS as readonly string[]).includes(k)) return { refused: `brief.${k} is the engine's to fill from what it serves, not the Spec Writer's` };
    if (!(MODEL_FIELDS as readonly string[]).includes(k)) return { refused: `brief.${k} is not a field of the brief (${MODEL_FIELDS.join(', ')})` };
  }
  for (const k of MODEL_TEXT_FIELDS) if (!isText(v[k])) return { refused: `brief.${k} must be a non-empty string` };
  for (const k of MODEL_LIST_FIELDS) {
    const list = v[k];
    if (!Array.isArray(list) || !list.every(isText)) return { refused: `brief.${k} must be a list of non-empty strings` };
  }
  if (!isObject(v.estimates) || Object.keys(v.estimates).some((k) => !(ESTIMATE_KEYS as readonly string[]).includes(k)) || !ESTIMATE_KEYS.every((k) => estimateOk((v.estimates as Record<string, unknown>)[k]))) {
    return { refused: `brief.estimates must be {${ESTIMATE_KEYS.join(', ')}}, each a number of at least 0 or a [low, high] pair` };
  }
  const objectives = v.objectives as string[];
  const keys = rep.requirements.filter((r) => r.withdrawn !== true).map((r) => r.key);
  const smaller = 'if the idea does not fit, propose a smaller scope and list what is left out in brief.left_out; never drop a requirement silently';
  if (objectives.length < OBJECTIVES.min || objectives.length > OBJECTIVES.max) return { refused: `brief.objectives lists ${objectives.length}: a prototype has ${OBJECTIVES.min} to ${OBJECTIVES.max} observable objectives (R3); ${smaller}` };
  if (keys.length < OBJECTIVES.min || keys.length > OBJECTIVES.max) return { refused: `the specification has ${keys.length} requirement(s): a prototype's has ${OBJECTIVES.min} to ${OBJECTIVES.max}, one per objective (R3); ${smaller}` };
  if (keys.length !== objectives.length) return { refused: `brief.objectives lists ${objectives.length} and the specification has ${keys.length} requirement(s): one objective per requirement` };
  const named = (text: string, key: string) => new RegExp(`(^|[^A-Za-z0-9_.])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(text);
  const unnamed = keys.filter((k) => !objectives.some((o) => named(o, k)));
  if (unnamed.length > 0) return { refused: `no objective names requirement ${unnamed.join(', ')}: each objective names the requirement it is (its key in the text)` };
  const pick = (k: string) => (v[k] as string[]).map((s) => s.trim());
  return {
    brief: {
      app: (v.app as string).trim(),
      for: (v.for as string).trim(),
      experience: (v.experience as string).trim(),
      included: pick('included'),
      objectives: pick('objectives'),
      mocked: pick('mocked'),
      left_out: pick('left_out'),
      assumptions: pick('assumptions'),
      limitations: pick('limitations'),
      constraints: pick('constraints'),
      estimates: v.estimates as unknown as BriefEstimates,
    },
  };
}

export interface BriefTarget {
  environment: string | null;
  kind: 'local_service';
  description: string;
  exposure_note: string;
}

// What the engine serves into the brief (R5, R6, R4): read in one store
// read when the brief is prepared. `environments`: the names the prepared
// specification's §7 gives, in its order.
export interface BriefFacts {
  version: number;
  target: BriefTarget;
  models: { provider: string; model: string; roles: string[] }[];
  preparation: { authorized_at: string | null; runs: number; tokens: number | null; usd: number | null } | null;
  limits: Record<string, number | string | null>;
  stop_conditions: string[];
}

// The Alpha target (R6): local_service on this host only. Its exposure as
// the configuration records it: the engine configures a port and no bind
// address, so who can reach the service is the application's binding,
// which the engine has not checked; never "private".
function targetOf(db: Db, project: string, environments: string[]): BriefTarget {
  const name = environments[0] ?? null;
  if (name === null) {
    return { environment: null, kind: 'local_service', description: 'The specification names no environment: nothing can be deployed until it names one and you configure it.', exposure_note: 'No environment is named, so who could reach a deployment is unknown.' };
  }
  const env = db.prepare('SELECT "id", "adapter" FROM "environments" WHERE "project" = ? AND "name" = ?').get(project, name) as { id: string; adapter: string } | undefined;
  const config = env
    ? (db.prepare(`SELECT "content" FROM "environment_configs" WHERE "environment" = ? AND "status" <> 'superseded' ORDER BY "version" DESC LIMIT 1`).get(env.id) as { content: string } | undefined)
    : undefined;
  let port: number | null = null;
  try {
    const c = config ? (JSON.parse(config.content) as { port?: unknown }) : null;
    port = c && typeof c.port === 'number' ? c.port : null;
  } catch {
    port = null;
  }
  const extra = environments.length > 1 ? ` The specification also names ${environments.slice(1).join(', ')}; the prototype deploys to ${name} only.` : '';
  if (port === null) {
    return {
      environment: name,
      kind: 'local_service',
      description: `Environment "${name}": a transient service on this host (the local_service adapter, a systemd user unit), deployed when the prototype's checks pass.${extra}`,
      exposure_note: `Environment "${name}" has no configuration recorded yet: its port and who can reach it are not known, and the engine has not checked its exposure. Configure it before Alpha.`,
    };
  }
  return {
    environment: name,
    kind: 'local_service',
    description: `Environment "${name}": a transient service on this host (the local_service adapter, a systemd user unit) on port ${port}, deployed when the prototype's checks pass.${extra}`,
    exposure_note: `The service listens on port ${port} of this host. The configuration sets no bind address: whether it is reachable only from this host (loopback) or from your network depends on how the application binds, which the engine has not checked.`,
  };
}

export function briefFacts(db: Db, args: { project: string; run: string; environments: string[] }): BriefFacts {
  const policy = projectPolicy(db, args.project);
  const latest = (db.prepare('SELECT "version" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(args.project) as { version: number } | undefined)?.version ?? 0;
  const models: BriefFacts['models'] = [];
  for (const role of BUILD_ROLES) {
    const rm = roleModelOf(db, args.project, role);
    const at = models.find((m) => m.provider === rm.provider && m.model === rm.model);
    if (at) at.roles.push(role);
    else models.push({ provider: rm.provider, model: rm.model, roles: [role] });
  }
  // The preparation: the authorization, the preparation runs so far (this
  // one under way: its usage is not settled, so tokens and cost are not
  // known yet; the iteration read serves the settled subtotal).
  const run = db.prepare('SELECT r."iteration", w."subject" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(args.run) as { iteration: string | null; subject: string } | undefined;
  let preparation: BriefFacts['preparation'] = null;
  if (run) {
    const decision = (JSON.parse(run.subject) as { decision?: string }).decision ?? null;
    const at = decision === null ? null : ((db.prepare('SELECT "consumed_at" FROM "decisions" WHERE "id" = ?').get(decision) as { consumed_at: string | null } | undefined)?.consumed_at ?? null);
    const runs = run.iteration === null ? 1 : (db.prepare(`SELECT COUNT(*) AS n FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? AND w."kind" = 'brief_preparation'`).get(run.iteration) as { n: number }).n;
    preparation = { authorized_at: at, runs, tokens: null, usd: null };
  }
  const limits: BriefFacts['limits'] = {};
  for (const k of PROTOTYPE_LIMIT_KEYS) limits[k] = (policy[k] as number | undefined) ?? null;
  limits.reservation_rule = `Each run is given an effective allowance at dispatch: the lower of the per-run limit (budget_run_billable_tokens ${policy.budget_run_billable_tokens}) and what the iteration has left of its token allowance after its settled usage, its unknown allowances and the reservations of the other runs under way. The run reserves that allowance from dispatch until its usage is settled, and is stopped at it; usage that cannot be known is charged as an unknown allowance up to it, never as zero. A run that would get no positive allowance is not dispatched. Possible overshoot: what runs already running may still spend under their own allowances. The effective allowance, the reservation and the unknown allowance are estimated allowances, never measured consumption: the iteration read serves what the backends reported (usage) apart from them (unknown_allowance_tokens, reserved_tokens), and its committed figure names both parts.`;
  return { version: latest + 1, target: targetOf(db, args.project, args.environments), models, preparation, limits, stop_conditions: [...STOP_CONDITIONS] };
}

// The brief, whole, in BRIEF_FIELDS' order.
export function composeBrief(model: ModelBrief, facts: BriefFacts, preparedAt: string): Record<string, unknown> {
  const all: Record<string, unknown> = { ...model, version: facts.version, prepared_at: preparedAt, target: facts.target, models: facts.models, preparation: facts.preparation, limits: facts.limits, stop_conditions: facts.stop_conditions };
  return Object.fromEntries(BRIEF_FIELDS.map((k) => [k, all[k]]));
}

// The brief is complete and in its shape: every field, nothing else.
export function briefShapeProblem(b: unknown): string | null {
  if (!isObject(b)) return 'the brief is not an object';
  const keys = Object.keys(b);
  const missing = BRIEF_FIELDS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !(BRIEF_FIELDS as readonly string[]).includes(k));
  if (missing.length > 0) return `the brief lacks ${missing.join(', ')}`;
  if (extra.length > 0) return `the brief has fields outside its shape: ${extra.join(', ')}`;
  const objectives = b.objectives as unknown[];
  if (!Array.isArray(objectives) || objectives.length < OBJECTIVES.min || objectives.length > OBJECTIVES.max) return `the brief has ${Array.isArray(objectives) ? objectives.length : 'no'} objectives, not ${OBJECTIVES.min} to ${OBJECTIVES.max}`;
  const t = b.target as Record<string, unknown> | null;
  if (!isObject(t) || t.kind !== 'local_service' || !isText(t.description) || !isText(t.exposure_note)) return 'the brief\'s target is not {environment, kind: local_service, description, exposure_note}';
  return null;
}

export interface PreparedBrief {
  brief: Record<string, unknown>;
  record: string;
  digest: string;
  blob: string;
  semantic_digest: string | null;
  representation: SpecRepresentation;
  findings: SemanticFinding[];
}

// The brief preparation's integration finalized (store/transitions/
// finalize.ts): the specification's semantics recorded for the run, the
// brief on the iteration, its earlier brief's question invalidated, the
// ordinary spec_approval raised about the run with the brief in its
// manifest, the iteration awaiting the brief's approval, and the work
// complete. Once: a finalizer replayed writes nothing twice.
export function recordPreparedBrief(tx: Tx, args: { project: string; run: string; work_item: string; prepared: PreparedBrief }): string | null {
  const it = (tx.db.prepare('SELECT p.* FROM "prototype_iterations" p JOIN "runs" r ON r."iteration" = p."id" WHERE r."id" = ?').get(args.run) as IterationLite | undefined) ?? undefined;
  const item = getWorkItem(tx, args.work_item);
  if (item && item.status === 'integrated') transitionWork(tx, item, 'complete', {}, { run: args.run, cause: 'brief_prepared' });
  if (!it) return null;
  if (it.brief_record === args.prepared.record) return it.brief_decision;
  recordSemantics(tx, { project: args.project, run: args.run, blob: args.prepared.blob, digest: args.prepared.semantic_digest, representation: args.prepared.representation, findings: args.prepared.findings, readable: true });
  tx.db.prepare('UPDATE "prototype_iterations" SET "brief_record" = ?, "brief_json" = ? WHERE "id" = ?').run(args.prepared.record, JSON.stringify(args.prepared.brief), it.id);
  // A later brief replaces an earlier one awaiting approval: that question
  // is about a brief no longer the iteration's (its manifest's
  // `current_brief_record` moved), invalidated now rather than at the next
  // review.
  const earlier = tx.db
    .prepare(`SELECT d.* FROM "decisions" d JOIN "runs" r ON r."id" = d."subject_id" WHERE d."kind" = 'spec_approval' AND d."subject_type" = 'run' AND d."status" = 'open' AND r."iteration" = ? AND r."id" <> ?`)
    .all(it.id, args.run) as DecisionRow[];
  for (const d of earlier) invalidateDecision(tx, d, `a later brief (record ${args.prepared.record}, version ${String(args.prepared.brief.version)}) was prepared`);
  const d = raiseQuestion(tx, { project: args.project, kind: 'spec_approval', subjectType: 'run', subjectId: args.run });
  tx.db.prepare(`UPDATE "prototype_iterations" SET "status" = 'awaiting_brief_approval', "brief_decision" = ?, "next_step" = ?, "outcome_reason" = NULL WHERE "id" = ?`).run(d?.id ?? null, 'approve the brief, or prepare again, or discard', it.id);
  tx.emit('prototype.brief_prepared', { project: args.project, iteration: it.id, run: args.run }, { record: args.prepared.record, digest: args.prepared.digest, brief_version: args.prepared.brief.version, decision: d?.id ?? null, objectives: (args.prepared.brief.objectives as unknown[]).length });
  return d?.id ?? null;
}

// The brief a `spec_approval` about a run binds, when the run prepared one
// (sessions/decisions.ts specManifest): the record, its version and digest,
// the iteration, and the iteration's current brief (a later preparation
// moves it, which invalidates the question). null for any other run.
export function briefManifestOf(db: Db, run: string): Record<string, unknown> | null {
  const r = db.prepare('SELECT r."iteration", w."kind" FROM "runs" r LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ?').get(run) as { iteration: string | null; kind: string | null } | undefined;
  if (!r || r.kind !== PREPARATION_WORK || r.iteration === null) return null;
  const rec = db.prepare(`SELECT "id", "sha256" FROM "records" WHERE "run" = ? AND "kind" = 'prototype_brief' ORDER BY rowid DESC LIMIT 1`).get(run) as { id: string; sha256: string | null } | undefined;
  const it = iterationById(db, r.iteration);
  let version: unknown = null;
  try {
    version = it?.brief_record === rec?.id && it?.brief_json ? (JSON.parse(it.brief_json) as { version?: unknown }).version ?? null : null;
  } catch {
    version = null;
  }
  return { brief_record: rec?.id ?? null, brief_digest: rec?.sha256 ?? null, brief_version: version, iteration: r.iteration, current_brief_record: it?.brief_record ?? null };
}

// The brief approved (spec/approval-effect.ts, after approveSpec): the
// iteration's brief is the approved spec revision, its runtime starts, it is
// building, and the first plan is asked of the Architect (R1). Once.
export function briefApproved(tx: Tx, args: { project: string; run: string; decision: string; spec_revision: string }): void {
  const m = briefManifestOf(tx.db, args.run);
  if (m === null) return;
  const it = iterationById(tx.db, String(m.iteration));
  if (!it || it.approved_at !== null) return;
  tx.db
    .prepare(`UPDATE "prototype_iterations" SET "brief_spec_revision" = ?, "brief_decision" = ?, "approved_at" = ?, "status" = 'building', "next_step" = ?, "outcome_reason" = NULL WHERE "id" = ?`)
    .run(args.spec_revision, args.decision, tx.at, 'none: the first plan is being made', it.id);
  tx.emit('prototype.brief_approved', { project: args.project, iteration: it.id, spec_revision: args.spec_revision }, { decision: args.decision, run: args.run, brief_record: m.brief_record, brief_version: m.brief_version });
  const work = observeTrigger(tx, { project: args.project, kind: 'replan', trigger_source: FIRST_PLAN_SOURCE, trigger_id: it.id, trigger_generation: 1, subject: { cause: FIRST_PLAN_SOURCE }, chain: 0 }, { iteration: it.id }).work_item.id;
  tx.emit('prototype.first_plan_requested', { project: args.project, iteration: it.id }, { work_item: work, bounds: PROTOTYPE_BOUNDS });
}

// The brief rejected (sessions/decisions.ts SPEC_APPROVAL's answer):
// nothing is approved, the iteration is preparing again.
export function briefRejected(tx: Tx, d: DecisionRow): void {
  const m = briefManifestOf(tx.db, d.subject_id);
  if (m === null) return;
  const it = iterationById(tx.db, String(m.iteration));
  if (!it || it.status !== 'awaiting_brief_approval') return;
  setStatus(tx, it, 'preparing', 'prepare again or discard', { reason: `the brief (version ${String(m.brief_version)}) was rejected by decision ${d.id}` });
  tx.emit('prototype.brief_rejected', { project: it.project, iteration: it.id }, { decision: d.id, brief_record: m.brief_record });
}

// ---- 3. the first plan (R1) -------------------------------------------------------------

export interface BoundsVerdict {
  within: boolean;
  // What is outside the bounds, each said plainly; empty when within.
  outside: string[];
  facts: { phases: number; plan_phase: number | null; expected_phase: number; stages: number; adrs: number; requirements_uncovered: string[]; permissions: string[] };
}

// What the bounds are judged against (slice E5, the owner's ruling S4: "one
// bounded phase per iteration"): the approved brief's requirement keys; the
// phase this iteration's plan is for (the project's completed phases plus
// one: 1 for a first iteration); the requirements the completed phases'
// stages implemented; and the approved module map, so that only what the
// plan adds is new.
export interface BoundsContext {
  requirement_keys: string[];
  phase?: number;
  earlier_implemented?: string[];
  approved_modules?: { name: string; platform_permissions?: { permission: string; target: string }[]; asset_paths?: unknown[]; tier_override?: unknown }[] | null;
}

// The one place the prototype policy's bounds are defined (R1; slice E5's
// S4, "one bounded phase per iteration. Each iteration remains within its
// approved brief, with at most two stages. Wider scope still asks me."): a
// bundle whose plan is the iteration's own single phase (the next phase of
// the project: phase 1 for a first iteration, and for a later one the phase
// after those completed, the roadmap's last, so nothing is deferred to a
// phase after it), at most two stages, implementing only requirements of
// the approved brief and every one of them the completed phases did not (its
// coverage preserved), adding no platform permission, asset path or tier
// override the approved module map does not already hold, and checked
// `within_baseline`. The bundle names no environment, provider or model (a
// plan cannot: they are the specification's and the policy's), so those
// cannot change through it. Ordinary implementation choices (modules,
// interfaces, ADRs consistent with the brief) are the Architect's.
export function withinPrototypeBounds(content: Pick<BundleContent, 'roadmap' | 'plan' | 'modules' | 'adrs'>, brief: BoundsContext, check?: Pick<PlanCheckResult, 'conformance' | 'uncertain'> | null): BoundsVerdict {
  const outside: string[] = [];
  const expected = brief.phase ?? 1;
  const roadmapPhases = content.roadmap?.phases ?? [];
  const phases = roadmapPhases.length;
  const plan = content.plan;
  const stages = plan?.stages.length ?? 0;
  if (expected === 1) {
    if (phases !== PROTOTYPE_BOUNDS.phases) outside.push(`the roadmap has ${phases} phase(s); a prototype's has exactly ${PROTOTYPE_BOUNDS.phases}`);
  } else if (phases !== expected || roadmapPhases.some((p) => p.number > expected)) {
    outside.push(`the roadmap has ${phases} phase(s) (${roadmapPhases.map((p) => p.number).join(', ')}); a prototype adds exactly ${PROTOTYPE_BOUNDS.phases} phase per iteration: phase ${expected}, after the ${expected - 1} completed, and none after it`);
  }
  if (plan === null || plan === undefined) outside.push('the bundle carries no phase plan');
  else if (plan.phase !== expected) outside.push(`the plan is for phase ${plan.phase}, not phase ${expected}`);
  if (stages > PROTOTYPE_BOUNDS.max_stages) outside.push(`the plan has ${stages} stages; a prototype's has at most ${PROTOTYPE_BOUNDS.max_stages}`);
  if (plan && stages === 0) outside.push('the plan has no stage');
  const implemented = new Set((plan?.stages ?? []).flatMap((s) => s.implements));
  const earlier = new Set(brief.earlier_implemented ?? []);
  const uncovered = brief.requirement_keys.filter((k) => !implemented.has(k) && !earlier.has(k)).sort();
  if (uncovered.length > 0) {
    outside.push(expected === 1 ? `requirement(s) ${uncovered.join(', ')} of the approved brief are implemented by no stage of the one phase` : `requirement(s) ${uncovered.join(', ')} of the approved brief are implemented by no stage of phase ${expected} nor of the ${expected - 1} completed`);
  }
  const beyond = [...implemented].filter((k) => !brief.requirement_keys.includes(k)).sort();
  if (beyond.length > 0) outside.push(`the plan implements ${beyond.join(', ')}, beyond the approved brief's requirements`);
  const approved = brief.approved_modules ?? [];
  const held = new Set(approved.flatMap((m) => (m.platform_permissions ?? []).map((p) => `${m.name}: ${p.permission} (${p.target})`)));
  const permissions = content.modules.modules.flatMap((m) => (m.platform_permissions ?? []).map((p) => `${m.name}: ${p.permission} (${p.target})`)).filter((p) => !held.has(p));
  if (permissions.length > 0) outside.push(`the module map asks for platform permission(s): ${permissions.join('; ')}`);
  const sameAssets = (m: { name: string; asset_paths?: unknown[] | undefined }) => JSON.stringify(approved.find((a) => a.name === m.name)?.asset_paths ?? []) === JSON.stringify(m.asset_paths ?? []);
  const assets = content.modules.modules.filter((m) => (m.asset_paths ?? []).length > 0 && !sameAssets(m)).map((m) => m.name);
  if (assets.length > 0) outside.push(`module(s) ${assets.join(', ')} declare asset paths (design is off for a prototype)`);
  const tiers = content.modules.modules.filter((m) => m.tier_override !== undefined && approved.find((a) => a.name === m.name)?.tier_override !== m.tier_override).map((m) => `${m.name} (${String(m.tier_override)})`);
  if (tiers.length > 0) outside.push(`module(s) ${tiers.join(', ')} override the prototype's tier`);
  if (check && check.conformance === 'uncertain') outside.push(`the plan check found it uncertain${(check.uncertain ?? []).length > 0 ? `: ${(check.uncertain ?? []).join('; ')}` : ''}`);
  return { within: outside.length === 0, outside, facts: { phases, plan_phase: plan?.phase ?? null, expected_phase: expected, stages, adrs: Object.keys(content.adrs).length, requirements_uncovered: uncovered, permissions } };
}

// What an iteration's plan is judged against now (S4): the approved brief's
// requirements, the phase after those the project completed, what their
// stages implemented, and the approved module map.
export function boundsContextOf(db: Db, project: string): BoundsContext {
  const done = (db.prepare(`SELECT COALESCE(MAX("phase_number"), 0) AS n FROM "phase_plans" WHERE "project" = ? AND "status" = 'completed'`).get(project) as { n: number }).n;
  const earlier = new Set<string>();
  const rows = db
    .prepare(`SELECT s."implements" FROM "stages" s JOIN "phase_plans" p ON p."id" = s."phase_plan" WHERE s."project" = ? AND p."status" = 'completed' AND s."cancelled_at" IS NULL`)
    .all(project) as { implements: string }[];
  // A stage records the requirements it implements by their ids; the brief
  // names them by their keys.
  const keyOf = new Map((db.prepare('SELECT "id", "key" FROM "requirements" WHERE "project" = ?').all(project) as { id: string; key: string }[]).map((r) => [r.id, r.key]));
  for (const r of rows) {
    try {
      for (const k of JSON.parse(r.implements) as unknown[]) if (typeof k === 'string') earlier.add(keyOf.get(k) ?? k);
    } catch {
      // an unreadable list adds nothing: its requirements count as not implemented
    }
  }
  const arch = db.prepare('SELECT "module_map" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { module_map: string } | undefined;
  let approved: BoundsContext['approved_modules'] = null;
  try {
    approved = arch ? ((JSON.parse(arch.module_map) as { modules?: BoundsContext['approved_modules'] }).modules ?? null) : null;
  } catch {
    approved = null;
  }
  return { requirement_keys: briefRequirementKeys(db, project), phase: done + 1, earlier_implemented: [...earlier].sort(), approved_modules: approved };
}

// Whether a replan's run is a prototype's first plan, and its iteration.
export function firstPlanOf(db: Db, run: string): { iteration: string; work_item: string } | null {
  const r = db.prepare(`SELECT w."id", w."trigger_source", w."trigger_id" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."id" = ? AND w."kind" = 'replan'`).get(run) as { id: string; trigger_source: string; trigger_id: string } | undefined;
  return r && r.trigger_source === FIRST_PLAN_SOURCE ? { iteration: r.trigger_id, work_item: r.id } : null;
}

export function isFirstPlanItem(db: Db, item: string): boolean {
  return (db.prepare('SELECT "trigger_source" FROM "work_items" WHERE "id" = ?').get(item) as { trigger_source: string } | undefined)?.trigger_source === FIRST_PLAN_SOURCE;
}

// The approved brief's requirement keys: the iteration's approved spec
// revision's live requirements.
function briefRequirementKeys(db: Db, project: string): string[] {
  return (db.prepare(`SELECT "key" FROM "requirements" WHERE "project" = ? AND "withdrawn_at" IS NULL ORDER BY "key"`).all(project) as { key: string }[]).map((r) => r.key);
}

// The first plan's bundle recorded and its check passed (plan/bundle.ts
// finalizeReplan): published by the prototype policy when within its bounds,
// else the ordinary pair raised for the owner with the iteration
// awaiting_owner, its next step naming what was outside. `publish` is the
// bundle's publication with the policy's authority. Returns what was done.
export function routeFirstPlan(
  tx: Tx,
  args: { project: string; run: string; bundle: string; content: BundleContent; check: PlanCheckResult; publish: () => string | null; raiseOwner: () => void },
): 'published' | 'owner' | 'stale' {
  const first = firstPlanOf(tx.db, args.run);
  const it = first === null ? undefined : iterationById(tx.db, first.iteration);
  const verdict = withinPrototypeBounds(args.content, boundsContextOf(tx.db, args.project), args.check);
  if (it) tx.db.prepare('UPDATE "prototype_iterations" SET "plan_bundle" = ? WHERE "id" = ?').run(args.bundle, it.id);
  if (verdict.within && it && isPrototype(tx.db, args.project)) {
    const approvals = { policy_authorized: { policy: 'rapid_prototype', iteration: it.id, bounds: PROTOTYPE_BOUNDS, policy_revision: policyRevision(tx.db, args.project) } };
    tx.db.prepare('UPDATE "plan_bundles" SET "approvals" = ? WHERE "id" = ?').run(JSON.stringify(approvals), args.bundle);
    const plan = args.publish();
    if (plan === null) return 'stale';
    tx.db.prepare('UPDATE "prototype_iterations" SET "phase_plan" = ? WHERE "id" = ?').run(plan, it.id);
    const now = iterationById(tx.db, it.id)!;
    setStatus(tx, now, 'building', 'none: building');
    tx.emit('prototype.plan_policy_authorized', { project: args.project, iteration: it.id, plan_bundle: args.bundle, phase_plan: plan }, { routing: POLICY_ROUTING, approved_by: POLICY_PUBLISHER, bounds: PROTOTYPE_BOUNDS, ...verdict.facts });
    return 'published';
  }
  args.raiseOwner();
  if (it) {
    const now = iterationById(tx.db, it.id)!;
    setStatus(tx, now, 'awaiting_owner', `approve the plan (architecture_approval and plan_approval): outside the prototype bounds: ${verdict.outside.join('; ')}`);
    tx.emit('prototype.plan_routed_to_owner', { project: args.project, iteration: it.id, plan_bundle: args.bundle }, { outside: verdict.outside, ...verdict.facts });
  }
  return 'owner';
}

// ---- 4. the iteration's status (R2) -----------------------------------------------------

// The owner's questions that hold a building prototype, each with the next
// step it names.
const OWNER_KINDS: Record<string, string> = {
  check_correction_tightening: 'review automated-check changes',
  check_correction_loosening: 'review automated-check changes',
  check_correction_unclassifiable: 'review automated-check changes',
  architecture_approval: 'approve the plan',
  plan_approval: 'approve the plan',
  blocker: 'answer the blocker',
  finding_disposition: 'disposition the finding',
  severity_lower: 'answer the severity change',
  finding_applicability_exclusion: 'answer the applicability exclusion',
  out_of_band_change: 'answer the out-of-band change',
  rollout_partial: 'answer the partial rollout',
  policy_widening: 'answer the policy widening',
  spec_change: 'answer the specification change',
};
const SYNCED = ['building', 'awaiting_owner', 'failed'];

// At each tick (scheduler/holds.ts) and after each answer that moves the
// work: the current iteration of each rapid_prototype project, while it is
// building, awaiting the owner or failed, takes the status its work says:
// failed while a work item of the project is parked (the reason from its
// blocker and its last run), awaiting_owner while one of the owner's
// questions is open (the next step naming it), building otherwise. A failed
// iteration is ended until the owner's retry returns the work.
export function syncIterationStatuses(tx: Tx): number {
  const rows = tx.db
    .prepare(`SELECT p.* FROM "prototype_iterations" p JOIN "projects" j ON j."id" = p."project" WHERE j."mode" = 'rapid_prototype' AND p."approved_at" IS NOT NULL AND p."status" IN ('building', 'awaiting_owner', 'failed')`)
    .all() as IterationLite[];
  let n = 0;
  for (const it of rows) {
    if (currentOf(tx.db, it.project)?.id !== it.id) continue;
    // C2k: a provider-refusal hold whose work was resumed otherwise (POST
    // …/work/:w/resume) or is no longer the refused run's ends now.
    if (it.provider_hold_since && providerHoldOf(tx.db, it) === null) endProviderHold(tx, it);
    // A first plan the owner approved (routed outside the bounds): its
    // publication, once made, is the iteration's plan.
    if (it.plan_bundle !== null && (it as IterationLite & { phase_plan?: string | null }).phase_plan == null) {
      const published = tx.db.prepare(`SELECT "id" FROM "phase_plans" WHERE "bundle" = ? ORDER BY rowid DESC LIMIT 1`).get(it.plan_bundle) as { id: string } | undefined;
      if (published) tx.db.prepare('UPDATE "prototype_iterations" SET "phase_plan" = ? WHERE "id" = ?').run(published.id, it.id);
    }
    const parked = tx.db
      .prepare(`SELECT w."id", w."kind", w."blocker" FROM "work_items" w WHERE w."project" = ? AND w."status" = 'parked' AND w."id" IN (SELECT "work_item" FROM "runs" WHERE "iteration" = ? AND "work_item" IS NOT NULL) ORDER BY w."seq" LIMIT 1`)
      .get(it.project, it.id) as { id: string; kind: string; blocker: string | null } | undefined;
    let want: { status: string; next: string; reason: string | null; ended: boolean };
    if (parked) {
      let why = 'parked';
      try {
        why = String((JSON.parse(parked.blocker ?? '{}') as { reason?: unknown }).reason ?? 'parked');
      } catch {
        why = 'parked';
      }
      const last = tx.db.prepare(`SELECT "id", "outcome", "reason_class", "reason_text" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1`).get(parked.id) as { id: string; outcome: string | null; reason_class: string | null; reason_text: string | null } | undefined;
      const runText = last ? `; its last run ${last.id} ended ${last.outcome ?? 'unknown'}${last.reason_class && last.reason_class !== 'none' ? ` (${last.reason_class})` : ''}${last.reason_text ? `: ${last.reason_text}` : ''}` : '';
      want = { status: 'failed', next: 'retry or cancel the parked work (its blocker), or discard', reason: `${parked.kind} work ${parked.id} parked: ${why}${runText}`, ended: true };
    } else if (providerHoldOf(tx.db, it) !== null) {
      // C2k (the owner's ruling B of 2026-10-30): its work held by a
      // provider refusal: the refusal is the stop condition, and the retry
      // its next step (store/transitions/prototype.ts retryIteration).
      const h = providerHoldOf(tx.db, it)!;
      want = { status: 'awaiting_owner', next: PROVIDER_REFUSAL_NEXT_STEP, reason: providerRefusalReason(h.run, h.refusal), ended: false };
    } else if (heldOf(tx.db, it) !== null) {
      // Slice E5 (gap 2): work of the iteration held after its run ended
      // without completing (an engine restart recovered it, or the owner
      // stopped the run) waits for the owner's resume: the next step names it.
      const h = heldOf(tx.db, it)!;
      want = { status: 'awaiting_owner', next: `resume the held work (POST /v1/projects/${it.project}/work/${h.id}/resume: ${h.kind}, its run ${h.run} ended ${h.outcome ?? 'unknown'}), or discard`, reason: null, ended: false };
    } else {
      const open = tx.db
        .prepare(`SELECT "kind" FROM "decisions" WHERE "project" = ? AND "status" = 'open' AND "kind" IN (${Object.keys(OWNER_KINDS).map(() => '?').join(', ')}) ORDER BY "seq" LIMIT 1`)
        .get(it.project, ...Object.keys(OWNER_KINDS)) as { kind: string } | undefined;
      if (open) {
        // The plan's question keeps the next step its routing named.
        const keep = (open.kind === 'architecture_approval' || open.kind === 'plan_approval') && it.status === 'awaiting_owner' && (it.next_step ?? '').startsWith('approve the plan');
        want = { status: 'awaiting_owner', next: keep ? it.next_step! : OWNER_KINDS[open.kind]!, reason: null, ended: false };
      } else want = { status: 'building', next: 'none: building', reason: null, ended: false };
    }
    if (it.status === want.status && it.next_step === want.next && (it.outcome_reason ?? null) === want.reason) continue;
    if (!SYNCED.includes(it.status)) continue;
    setStatus(tx, it, want.status, want.next, { reason: want.reason, ended: want.ended });
    n++;
  }
  return n;
}

// The first held work item whose last run is the iteration's, with that run.
function heldOf(db: Db, it: IterationLite): { id: string; kind: string; run: string; outcome: string | null } | null {
  return (
    (db
      .prepare(
        `SELECT w."id", w."kind", r."id" AS "run", r."outcome" FROM "work_items" w JOIN "runs" r ON r."id" = (SELECT x."id" FROM "runs" x WHERE x."work_item" = w."id" ORDER BY x."seq" DESC LIMIT 1)
         WHERE w."project" = ? AND w."status" = 'held' AND r."iteration" = ? ORDER BY w."seq" LIMIT 1`,
      )
      .get(it.project, it.id) as { id: string; kind: string; run: string; outcome: string | null } | undefined) ?? null
  );
}

// ---- the preparation run's package (invoke/sandbox/context.ts) ---------------------------

export interface BriefPreparationFacts {
  iteration: string;
  iteration_seq: number;
  idea_path: '.surety/idea.md';
  idea_version: number | null;
  objectives: { min: number; max: number };
  model_fields: readonly string[];
  engine_fields: readonly string[];
  // What a preparation of the same iteration last ended with, when one did
  // (a refused brief, a rejected one): what to do differently.
  previous: { run: string; outcome: string | null; reason_text: string | null } | null;
  // Slice E4 (R7): the iteration this one continues, the owner's change, and
  // the latest approved brief of its predecessors; null for a first iteration.
  continues: Continuation | null;
}

export function briefPreparationFacts(db: Db, item: { id: string; project: string; subject: string }): BriefPreparationFacts | null {
  const decision = (JSON.parse(item.subject) as { decision?: string }).decision ?? null;
  const it = decision === null ? undefined : (db.prepare(`SELECT p.* FROM "prototype_iterations" p JOIN "decisions" d ON d."subject_id" = p."id" WHERE d."id" = ?`).get(decision) as IterationLite | undefined);
  if (!it) return null;
  const p = db.prepare('SELECT "idea_version" FROM "projects" WHERE "id" = ?').get(item.project) as { idea_version: number | null };
  const prev = db
    .prepare(`SELECT r."id", r."outcome", r."reason_text" FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE r."iteration" = ? AND w."kind" = 'brief_preparation' AND r."state" = 'ended' AND w."id" <> ? ORDER BY r."seq" DESC LIMIT 1`)
    .get(it.id, item.id) as { id: string; outcome: string | null; reason_text: string | null } | undefined;
  return { iteration: it.id, iteration_seq: it.seq, idea_path: '.surety/idea.md', idea_version: p.idea_version, objectives: { ...OBJECTIVES }, model_fields: MODEL_FIELDS, engine_fields: ENGINE_FIELDS, previous: prev ? { run: prev.id, outcome: prev.outcome, reason_text: prev.reason_text } : null, continues: continuationOf(db, it.id) };
}

export const BRIEF_TASK = "Prepare this rapid prototype's brief: read the idea (.surety/idea.md), write the minimal specification into .surety/spec/spec.md, and report the brief's idea-derived fields in your result's `brief`. You approve nothing: the owner approves the brief.";

// The path the engine reads the prepared specification from (runs/accept.ts
// briefOf), and the template's sections in the heading form the parser reads
// (spec/semantics.ts H2: `## <n>. <title>`, the full stop required). The
// minimal specification is an ordinary one, approved through spec_approval
// (the rapid prototype proposal's table: "the brief is the minimal spec's
// plain-language rendering"), so nothing of the template's form is omitted.
export const BRIEF_SPEC_PATH = '.surety/spec/spec.md';
export const BRIEF_SPEC_SECTIONS: readonly (readonly [number, string])[] = [
  [1, 'Purpose'],
  [2, 'Non-goals'],
  [3, 'Users and situations'],
  [SPEC_SECTIONS.requirements, 'Requirements'],
  [SPEC_SECTIONS.index, 'Requirement index'],
  [SPEC_SECTIONS.modules, 'Modules and protected paths'],
  [SPEC_SECTIONS.environments, 'Environments'],
  [8, 'Constraints'],
  [9, 'Interfaces and data'],
  [SPEC_SECTIONS.questions, 'Open questions'],
  [SPEC_SECTIONS.change_log, 'Change log'],
];
const heading = ([n, title]: readonly [number, string]): string => `## ${n}. ${title}`;

// What the prompt states of the specification's form (the first trial's
// preparation, 2026-10-30, wrote `## 4 Requirements` and `### R1 — <title>`
// with numbered criteria and no index, and was refused whole: the package
// had stated no form). The exact forms follow under "What the engine reads".
export function briefSpecFormText(f: Pick<BriefPreparationFacts, 'objectives'>): string[] {
  const [VERSION, STATUS, TIER, OWNER] = SPEC_HEADER_FIELDS;
  const req = BRIEF_SPEC_SECTIONS.find(([n]) => n === SPEC_SECTIONS.requirements)!;
  const idx = BRIEF_SPEC_SECTIONS.find(([n]) => n === SPEC_SECTIONS.index)!;
  return [
    `The specification's form. The engine reads ${BRIEF_SPEC_PATH} (exactly that path) with the same parser as every specification, and refuses the brief whole if the parser cannot read it or finds anything that would block its approval:`,
    `- The header, one line each after the title: \`**${VERSION}:** 1\` (one more than the current version when continuing, below), \`**${STATUS}:** draft\`, \`**${TIER}:** T1\` (a rapid prototype's tier), \`**${OWNER}:** <a name>\`.`,
    `- The sections, each heading exactly \`## <n>. <title>\` (the number, a full stop, a space, the title; \`## 4 Requirements\` without the full stop is not read), in this order: ${BRIEF_SPEC_SECTIONS.map((x) => `\`${heading(x)}\``).join(', ')}. A specification without \`${heading(req)}\` and \`${heading(idx)}\` is not a specification to the engine.`,
    `- Section ${req[0]}: ${f.objectives.min} to ${f.objectives.max} requirements, keyed R1, R2, … in order (when continuing, each key the previous specification gives keeps its requirement), each one subsection headed exactly \`### R<n>. <title>\` (not \`### R<n> — <title>\`); under it the statement as one paragraph, the line \`${SPEC_AREAS_LABEL} none\` (or identifiers of the closed list), then each acceptance criterion as a list item \`- R<n>.<m> <text>\` (not a numbered list), each one someone can check by using the running prototype.`,
    `- Section ${idx[0]}: one table with the columns ${INDEX_COLUMNS.map((c) => `\`${c}\``).join(', ')}, then the separator row, then one row per requirement of section ${req[0]} (Phase 1; the Criteria cell lists exactly that requirement's criterion keys, comma-separated), agreeing with section ${req[0]} exactly.`,
  ];
}

export function briefPreparationText(f: BriefPreparationFacts): string[] {
  return [
    '',
    '## The prototype brief',
    '',
    `Iteration ${f.iteration_seq} of a rapid prototype. The idea is ${f.idea_path} (version ${f.idea_version ?? 'unknown'}) in your workspace, as the owner typed or imported it.`,
    `1. Write the minimal specification into ${BRIEF_SPEC_PATH} in the template's form (sections 1 to 11, stated below): ${f.objectives.min} to ${f.objectives.max} requirements, each an observable objective with acceptance criteria someone can check by using the running prototype; one environment in section 7 (the prototype runs as a local service on this host); open questions: none, or each with its phase hint.`,
    `2. Write your result to /surety/out/result.json as /surety/context/result-schema.json states: \`status\`, \`summary\` and \`brief\`. Report in its \`brief\` exactly these fields: ${f.model_fields.join(', ')}. \`app\`, \`for\` and \`experience\` are short sentences; the others are lists of short sentences; \`objectives\` lists one objective per requirement, each naming its requirement key (for example "R1: ..."); \`estimates\` is {runs, tokens, usd, minutes}, each a number or a [low, high] pair, your estimate of the build.`,
    `3. If the idea does not fit ${f.objectives.max} objectives, propose a smaller scope: keep the objectives that show the idea best, and list everything you leave out in \`left_out\`. Never drop a requirement silently; what is mocked goes in \`mocked\`, what you assume in \`assumptions\`, the prototype's known limits in \`limitations\`, and the idea's constraints in \`constraints\`.`,
    `Do not report ${f.engine_fields.join(', ')}: the engine fills them from what it serves (the target and its exposure, the models, the limits, the preparation, the stop conditions). A brief that is not in this form is refused and nothing is approved.`,
    '',
    ...briefSpecFormText(f),
    ...(f.previous ? ['', `The iteration's last preparation run (${f.previous.run}) ended ${f.previous.outcome ?? 'unknown'}${f.previous.reason_text ? `: ${f.previous.reason_text}` : ''}.`] : []),
    ...(f.continues ? continuationText(f.continues) : []),
  ];
}

// Slice E4 (R7): what a preparation of an iteration that continues another
// is told: the previous approved brief (whole, in /surety/context/
// prototype-brief.json as `continues.previous_brief`) and the owner's change.
export function continuationText(c: Continuation): string[] {
  return [
    '',
    '## Continuing from the previous iteration',
    '',
    `This iteration continues from iteration ${c.predecessor_seq}. The owner's change request: ${c.change === null ? '(none given: keep the scope, and correct what the previous iteration left unfinished)' : JSON.stringify(c.change)}.`,
    c.previous_brief === null
      ? 'No earlier brief was approved: prepare the brief from the idea, with the change.'
      : `The previous approved brief (iteration ${c.previous_brief_iteration_seq}) is in /surety/context/prototype-brief.json under continues.previous_brief, and the specification it approved is .surety/spec/spec.md in your workspace. Start from them: change what the change request asks, keep the rest, and write the whole specification again as its next version (its Spec version one more than the current one, its change log naming the change). The brief you report is the whole brief for this iteration, not a difference.`,
  ];
}

// The `brief` field of the preparation's result (its result schema).
export const BRIEF_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: "The brief's idea-derived fields; the engine fills the rest.",
  additionalProperties: false,
  required: [...MODEL_FIELDS],
  properties: {
    ...Object.fromEntries(MODEL_TEXT_FIELDS.map((k) => [k, { type: 'string', minLength: 1 }])),
    ...Object.fromEntries(MODEL_LIST_FIELDS.map((k) => [k, { type: 'array', items: { type: 'string', minLength: 1 }, ...(k === 'objectives' ? { minItems: OBJECTIVES.min, maxItems: OBJECTIVES.max } : {}) }])),
    estimates: {
      type: 'object',
      additionalProperties: false,
      required: [...ESTIMATE_KEYS],
      properties: Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, { oneOf: [{ type: 'number', minimum: 0 }, { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 }] }])),
    },
  },
};
