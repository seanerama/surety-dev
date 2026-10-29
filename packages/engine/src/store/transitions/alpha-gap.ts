// The checks an Alpha deployment's gate lacks, asked of the Verifier (D4
// §4.1 J4, §5.1; D6 §6.2, §6.8; found by real visual run 2).
//
// `alpha_authorize` is not satisfied while its scope lacks a check no one
// was asked to write: a kind of the tier, a criterion or an area of the
// deployment scope (D3 §4.3), or the required `post_deploy_behavior` check
// the `alpha_complete` scope needs (J4). Within a phase, a stage gate's gap
// gets a check_authoring follow-up (plan/phase.ts registerGapAuthoring); the
// deployment gate had no such route. Visual run 2's phase-1 and phase-2
// authoring wrote no `post_deploy_behavior` check; the policy's request at
// phase 2's completion was refused ACCEPTANCE_SCOPE_INCOMPLETE
// `kind:post_deploy_behavior` alone, recorded `not_issued` under its key,
// and nothing more happened. Here, when a deployment request's refusal names
// such a gap, the engine registers a check_authoring on the same route
// (trigger `authoring_gap`, the plan the candidate completed), its package
// naming the gate, the environment and what is missing; once per gap set and
// plan, as the stage route. The policy's request waits while that authoring
// is under way (its proposal undecided included) and is made again once it
// ends; the applied check then satisfies the gate's kind.

import { CRITERION } from '../../checks/schema.js';
import { targetVariable } from '../../checks/variables.js';
import { parseJson } from './common.js';
import type { CandidateRow } from './evidence.js';
import type { Tx } from './tx.js';
import { observeTrigger } from './work.js';

type Db = Tx['db'];

interface Reason {
  code: string;
  subjects?: string[];
}

export interface DeploymentGap {
  kinds: string[];
  criteria: string[];
  areas: string[];
}

// What a check_authoring asked for the deployment gate carries in its
// trigger evidence (and its package states, store/reads.ts authoringFacts).
export interface DeploymentGapEvidence {
  gate: 'alpha_authorize';
  evaluation: string;
  candidate: string;
  environment: string;
  targets: { name: string; variable: string }[] | null;
  missing: DeploymentGap;
}

// 'coming': an authoring of the project's checks is under way, or awaits
// its proposal's decision; 'due': none is, and this gap has not been asked
// for under the plan; 'asked': it has, and that authoring ended; 'none': the
// evaluation names no gap a Verifier could write, or something else too.
export type AlphaGapState = 'coming' | 'due' | 'asked' | 'none';

const TERMINAL = ['complete', 'cancelled'];

// The subjects of ACCEPTANCE_SCOPE_INCOMPLETE a Verifier's check closes:
// `kind:<k>`, `area:<a>`, a criterion of the index. A criterion an
// unresolved obligation owes is that route's (a deferral's follow-up, a
// specification change's correction); an unread fact, a discovery error, a
// check held by an obligation, an uncertain requirement are not authoring.
// null when any subject is not.
export function authorableGap(db: Db, project: string, subjects: readonly string[]): DeploymentGap | null {
  if (subjects.length === 0) return null;
  const owed = new Set(
    (db.prepare(`SELECT "criteria" FROM "check_obligations" WHERE "project" = ? AND "resolved_at" IS NULL`).all(project) as { criteria: string }[]).flatMap((o) => parseJson<string[]>(o.criteria) ?? []),
  );
  const gap: DeploymentGap = { kinds: [], criteria: [], areas: [] };
  for (const s of subjects) {
    // The engine's serving check is the engine's to propose, never a
    // Verifier's to author (the owner's ruling of 2026-10-29; serving.ts).
    if (s === 'kind:post_deploy_serving') return null;
    if (s.startsWith('kind:') && s.length > 5) gap.kinds.push(s.slice(5));
    else if (s.startsWith('area:') && s.length > 5) gap.areas.push(s.slice(5));
    else if (CRITERION.test(s) && !owed.has(s)) gap.criteria.push(s);
    else return null;
  }
  return { kinds: [...new Set(gap.kinds)].sort(), criteria: [...new Set(gap.criteria)].sort(), areas: [...new Set(gap.areas)].sort() };
}

export const gapReason = (db: Db, project: string, r: Reason): boolean => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE' && authorableGap(db, project, r.subjects ?? []) !== null;

function evaluationOf(db: Db, evaluation: string): { candidate: string; project: string; created_at: string; reasons: Reason[] } | null {
  const row = db.prepare('SELECT "candidate", "project", "created_at", "reasons" FROM "gate_evaluations" WHERE "id" = ? AND "gate_kind" = \'alpha_authorize\'').get(evaluation) as
    | { candidate: string; project: string; created_at: string; reasons: string }
    | undefined;
  return row ? { ...row, reasons: parseJson<Reason[]>(row.reasons) ?? [] } : null;
}

// The gap an evaluation names, every ACCEPTANCE_SCOPE_INCOMPLETE of it
// authorable; null when it names none, or one that is not.
export function gapOfEvaluation(db: Db, evaluation: string): DeploymentGap | null {
  const ev = evaluationOf(db, evaluation);
  if (ev === null) return null;
  const incomplete = ev.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE');
  if (incomplete.length === 0) return null;
  const gap = authorableGap(db, ev.project, incomplete.flatMap((r) => r.subjects ?? []));
  return gap !== null && gap.kinds.length + gap.criteria.length + gap.areas.length > 0 ? gap : null;
}

// The plan an authoring for the candidate's deployment belongs to: the
// newest the candidate completed, else the project's newest published or
// completed one.
function planFor(db: Db, project: string, candidate: string): string | null {
  const plans = db
    .prepare(`SELECT "id", "completion_binding" FROM "phase_plans" WHERE "project" = ? AND "status" IN ('published', 'completed') AND "active" = 1 ORDER BY "phase_number" DESC, rowid DESC`)
    .all(project) as { id: string; completion_binding: string | null }[];
  const completed = plans.find((p) => parseJson<{ candidate?: string }>(p.completion_binding)?.candidate === candidate);
  return (completed ?? plans[0])?.id ?? null;
}

interface GapItem {
  id: string;
  status: string;
  created_at: string;
  trigger_generation: number;
  trigger_evidence: string | null;
}

const gapItems = (db: Db, project: string, plan: string): GapItem[] =>
  db
    .prepare(`SELECT "id", "status", "created_at", "trigger_generation", "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = 'authoring_gap' AND "trigger_id" = ? ORDER BY "trigger_generation" DESC`)
    .all(project, plan) as GapItem[];

export const deploymentEvidenceOf = (raw: string | null): DeploymentGapEvidence | null => {
  const e = parseJson<{ deployment?: Partial<DeploymentGapEvidence> }>(raw)?.deployment;
  return e && e.gate === 'alpha_authorize' && e.missing ? (e as DeploymentGapEvidence) : null;
};

const sameGap = (a: DeploymentGap, b: DeploymentGap): boolean => JSON.stringify(a) === JSON.stringify(b);

// Is an authoring of the project's checks under way, or awaiting its
// proposal's decision (runs.ts: check_authoring waits for it)?
export function authoringUnderWay(db: Db, project: string): boolean {
  return db.prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" IN ('check_authoring', 'check_correction') AND "status" NOT IN ('complete', 'cancelled') LIMIT 1`).get(project) !== undefined;
}

// Is an authoring asked for a deployment gap under way, or awaiting its
// proposal's decision? The policy requests nothing meanwhile.
export function gapAuthoringUnderWay(db: Db, project: string): boolean {
  return (
    db.prepare(`SELECT "trigger_evidence" FROM "work_items" WHERE "project" = ? AND "kind" = 'check_authoring' AND "trigger_source" = 'authoring_gap' AND "status" NOT IN ('complete', 'cancelled')`).all(project) as { trigger_evidence: string | null }[]
  ).some((i) => deploymentEvidenceOf(i.trigger_evidence) !== null);
}

// The newest authoring asked for this gap under the candidate's plan, if any.
function askedFor(db: Db, project: string, candidate: string, gap: DeploymentGap): GapItem | null {
  const plan = planFor(db, project, candidate);
  if (plan === null) return null;
  const last = gapItems(db, project, plan).find((i) => deploymentEvidenceOf(i.trigger_evidence) !== null);
  return last && sameGap(deploymentEvidenceOf(last.trigger_evidence)!.missing, gap) ? last : null;
}

export function alphaGapState(db: Db, project: string, evaluation: string): AlphaGapState {
  const gap = gapOfEvaluation(db, evaluation);
  const ev = evaluationOf(db, evaluation);
  if (gap === null || ev === null) return 'none';
  if (planFor(db, project, ev.candidate) === null) return 'none';
  if (authoringUnderWay(db, project)) return 'coming';
  return askedFor(db, project, ev.candidate, gap) ? 'asked' : 'due';
}

// Ask a Verifier for the checks the evaluation found missing, when they are
// due: the next generation of the plan's `authoring_gap` trigger, unchained,
// its evidence naming the gate, the evaluation, the environment with its
// targets' variables, and what is missing. Returns the state after: 'coming'
// once queued.
export function queueAlphaGapAuthoring(tx: Tx, candidate: CandidateRow, evaluation: string, env: { name: string; targets: string[] | null }): AlphaGapState {
  const state = alphaGapState(tx.db, candidate.project, evaluation);
  if (state !== 'due') return state;
  const gap = gapOfEvaluation(tx.db, evaluation)!;
  const plan = planFor(tx.db, candidate.project, candidate.id)!;
  const latest = gapItems(tx.db, candidate.project, plan)[0];
  const deployment: DeploymentGapEvidence = {
    gate: 'alpha_authorize',
    evaluation,
    candidate: candidate.id,
    environment: env.name,
    targets: env.targets === null ? null : env.targets.map((t) => ({ name: t, variable: targetVariable(t) })),
    missing: gap,
  };
  // Its work.created names the gate and what is missing (the label): the
  // event set is closed (D1 §12.1, A.6), so no event of its own.
  observeTrigger(
    tx,
    {
      project: candidate.project,
      kind: 'check_authoring',
      trigger_source: 'authoring_gap',
      trigger_id: plan,
      trigger_generation: (latest?.trigger_generation ?? 0) + 1,
      subject: { phase_plan: plan },
      chain: 0,
      trigger_evidence: { deployment } as unknown as Record<string, unknown>,
    },
    { gate: 'alpha_authorize', evaluation, environment: env.name, missing: gap },
  );
  return 'coming';
}

// A policy request recorded `not_issued` on a refusal whose only lasting
// reason is such a gap (recorded before this route existed, or the authoring
// asked for it has ended since) is made again under its key: while the gap
// has not been asked for, and once after the authoring asked for it ends.
// What is read is the candidate's latest `alpha_authorize` evaluation; one
// made after that authoring ended stands (the gap outlived it: no required
// check of it was applied), so the key is never a loop.
export function reopenableRefusal(db: Db, args: { project: string; candidate: string; requested_by: string; outcome: string; reason: string | null }, settles: (r: Reason) => boolean): boolean {
  if (args.requested_by !== 'policy' || args.outcome !== 'not_issued' || args.reason !== null) return false;
  const latest = (db.prepare(`SELECT "id" FROM "gate_evaluations" WHERE "project" = ? AND "candidate" = ? AND "gate_kind" = 'alpha_authorize' ORDER BY rowid DESC LIMIT 1`).get(args.project, args.candidate) as { id: string } | undefined)?.id;
  if (!latest) return false;
  const ev = evaluationOf(db, latest);
  if (ev === null) return false;
  if (!ev.reasons.some((r) => gapReason(db, args.project, r))) return false;
  if (!ev.reasons.every((r) => gapReason(db, args.project, r) || r.code === 'SIGNOFF_MISSING' || settles(r))) return false;
  const state = alphaGapState(db, args.project, latest);
  if (state === 'due') return true;
  if (state !== 'asked') return false;
  const asked = askedFor(db, args.project, ev.candidate, gapOfEvaluation(db, latest)!);
  return asked !== null && TERMINAL.includes(asked.status) && deploymentEvidenceOf(asked.trigger_evidence)?.evaluation === latest;
}
