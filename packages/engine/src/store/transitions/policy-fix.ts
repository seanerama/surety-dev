// What the approved brief of a rapid prototype's iteration authorizes
// beforehand (DECISIONS item 57; the owner's rulings of 2026-11-26), the
// store's side, for two of its acts:
//
//   D2 (classification.ts policyTightening): "The brief can authorize
//   tighter checks tied to its criteria using the approved commands and
//   execution permissions. A proposal that changes what can execute,
//   weakens existing coverage, or cannot be classified comes to me. Keep the
//   check diff available and retain candidate verification."
//
//   D3 (here, policyFix): "Use the brief's existing repair, token, and spend
//   allowances for verifiable defects within scope. Preserve the finding,
//   the repair, and the verification result. Ask me if the allowance is
//   exhausted, the repair exceeds scope, or success cannot be verified.
//   Lowering, accepting, or deferring a finding remains an owner decision."
//
// The scope both read (briefScope): the project's current iteration, its
// brief approved and its work open (`building` or `awaiting_owner`), and the
// criteria of the brief's approved specification revision, read from the
// requirement index while that revision is still the project's latest
// approved one (a specification changed since is not what the brief
// approved: nothing is covered then).
//
// D3's "verifiable" is read as the driver's design choice (§3j, flagged for
// the owner): the finding's named check has a failed established result on
// the finding's candidate under the effective protected version, so the
// defect is reproduced by a check before a repair is spent on it. A check
// that passed on the candidate does not reproduce it: the Verifier is asked
// to correct the check first (its tightening applied under D2), and the
// candidate's result under the corrected version decides; a corrected check
// that still passes leaves the finding the owner's, saying the repair could
// not be verified. Only `fix` is ever recorded by policy (authority
// `policy`, by `policy:rapid_prototype`); one unit of
// `prototype_repairs_per_iteration` is consumed by it (prototype.ts
// iterationAccount counts each `fix_registered` act). Whatever is refused
// goes to the owner as today, its evidence `{policy_fix_refused: <reason>}`.

import { checkState } from './gates.js';
import { type CandidateRow, getCandidate } from './evidence.js';
import { effectiveVersion } from './protected.js';
import { knownCriteria } from './checks.js';
import { recordDelegatedAction } from './delegation.js';
import { type FindingRow } from './gates.js';
import { correctionOpen, findingVerifiable, routeCheckCorrection } from './repair.js';
import { alphaNotOwn, iterationAccount, iterationVerdict } from './prototype.js';
import { projectPolicy } from './settings.js';
import { recordDisposition } from './queue.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// Who acts under the brief's authority (prototype/brief.ts POLICY_PUBLISHER).
export const POLICY_ACTOR = 'policy:rapid_prototype';

export interface BriefIteration {
  id: string;
  project: string;
  seq: number;
  status: string;
  approved_at: string;
  brief_decision: string | null;
  brief_spec_revision: string | null;
  limits_json: string;
  provider_hold_since?: string | null;
  provider_hold_ms?: number;
  created_at?: string;
  clock_basis?: string | null;
}

export type BriefScope = { iteration: BriefIteration; criteria: Set<string> };

// The approved brief's scope, or why there is none; null for a project that
// is not a rapid prototype (no policy applies to it at all).
export function briefScope(db: Db, project: string): BriefScope | { refused: string } | null {
  const mode = (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return null;
  const it = db.prepare('SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as (BriefIteration & { approved_at: string | null }) | undefined;
  if (!it || it.approved_at === null || it.brief_spec_revision === null) return { refused: 'no_approved_brief' };
  if (it.status !== 'building' && it.status !== 'awaiting_owner') return { refused: `iteration_${it.status}` };
  const latest = (db.prepare('SELECT "id" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1').get(project) as { id: string } | undefined)?.id ?? null;
  if (latest !== it.brief_spec_revision) return { refused: 'spec_changed_since_brief' };
  const criteria = knownCriteria(db, project);
  if (criteria === null) return { refused: 'no_requirement_index' };
  return { iteration: it as BriefIteration, criteria };
}

// The run's iteration (runs.iteration), or null.
export const runIteration = (db: Db, run: string | null): string | null =>
  run === null ? null : ((db.prepare('SELECT "iteration" FROM "runs" WHERE "id" = ?').get(run) as { iteration: string | null } | undefined)?.iteration ?? null);

// ---- D3: a verifiable defect within the brief, repaired on its allowance ----------------

export type PolicyFixOutcome = { outcome: 'fixed' } | { outcome: 'waiting'; why: string } | { outcome: 'refused'; reason: string } | null;

// The finding's named check on its candidate under the effective version:
// 'failed' or 'passed' (an established result decides), 'pending' (an
// execution registered with no result yet), or 'none'.
function checkOnCandidate(db: Db, f: FindingRow, candidate: CandidateRow): { state: 'failed' | 'passed' | 'pending' | 'none'; result: string | null; version: string | null } {
  const version = effectiveVersion(db, f.project);
  if (!version || f.check === null) return { state: 'none', result: null, version: version?.id ?? null };
  const check = db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? AND "key" = ?').get(version.id, f.check) as Parameters<typeof checkState>[2] | undefined;
  if (!check) return { state: 'none', result: null, version: version.id };
  const s = checkState(db, f.project, check, { candidate, effective: version, environment: null, artifact: null });
  if (s.state === 'failed' || s.state === 'passed') return { state: s.state, result: s.decider?.id ?? null, version: version.id };
  if (s.pending !== null) return { state: 'pending', result: null, version: version.id };
  return { state: 'none', result: null, version: version.id };
}

// Whether a correction of the finding's check was asked and has ended (its
// check_correction work complete or cancelled, nothing of it still open).
function correctionEnded(db: Db, project: string, finding: string): boolean {
  const any = db.prepare(`SELECT 1 FROM "work_items" WHERE "project" = ? AND "kind" = 'check_correction' AND "trigger_source" = 'check_correction' AND "trigger_id" = ? LIMIT 1`).get(project, finding) !== undefined;
  return any && !correctionOpen(db, project, finding);
}

// D3 for one open finding with no disposition, before the owner is asked
// (findings.ts askUndispositioned). null: no policy applies (not a rapid
// prototype, not a defect): the owner is asked as today. `fixed`: the fix
// is registered by policy. `waiting`: the policy waits (a check correction
// under way, a result to come): nobody is asked yet. `refused`: the owner
// is asked, the reason in the question's evidence.
export function policyFix(tx: Tx, f: FindingRow & { source_role?: string | null }): PolicyFixOutcome {
  if (f.category !== 'defect') return null;
  const scope = briefScope(tx.db, f.project);
  if (scope === null) return null;
  if ('refused' in scope) return { outcome: 'refused', reason: scope.refused };
  const it = scope.iteration;
  if (f.source_role !== 'verifier' && f.source_role !== 'reviewer') return { outcome: 'refused', reason: 'not_a_verification_finding' };
  if (runIteration(tx.db, f.source_run) !== it.id) return { outcome: 'refused', reason: 'not_this_iterations_verification' };
  const candidate = f.candidate ? getCandidate(tx.db, f.candidate) : undefined;
  if (!candidate || candidate.project !== f.project || candidate.superseded_by || alphaNotOwn(tx.db, it.id, candidate.id) !== null) return { outcome: 'refused', reason: 'subject_not_current_candidate' };
  const criterion = f.criterion ?? null;
  if (criterion === null || !scope.criteria.has(criterion)) return { outcome: 'refused', reason: 'outside_brief' };
  const version = effectiveVersion(tx.db, f.project);
  if (!version || f.check === null || !findingVerifiable(tx.db, f, version.id)) return { outcome: 'refused', reason: 'repair_unverifiable' };
  const on = checkOnCandidate(tx.db, f, candidate);
  if (on.state === 'pending') return { outcome: 'waiting', why: `check ${f.check} on candidate ${candidate.id} has a result to come` };
  if (on.state === 'passed' || on.state === 'none') {
    // Not reproduced: the check is corrected first (D2), once.
    if (correctionOpen(tx.db, f.project, f.id)) return { outcome: 'waiting', why: `the correction of check ${f.check} is under way` };
    if (correctionEnded(tx.db, f.project, f.id)) return { outcome: 'refused', reason: on.state === 'passed' ? 'repair_unverifiable: the corrected check still passes on the candidate' : 'repair_unverifiable: no result of the corrected check on the candidate' };
    if (on.state === 'none') return { outcome: 'refused', reason: 'repair_unverifiable: no result of the check on the candidate' };
    routeCheckCorrection(tx, f.project, f.id, 1);
    return { outcome: 'waiting', why: `check ${f.check} passed on candidate ${candidate.id}: its correction is asked of the Verifier` };
  }
  // Reproduced: the allowance decides.
  const limits = (() => {
    try {
      return JSON.parse(it.limits_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const account = iterationAccount(tx.db, f.project, it.id);
  const perIteration = typeof limits.prototype_repairs_per_iteration === 'number' ? limits.prototype_repairs_per_iteration : null;
  if (perIteration !== null && account.repairs_used + 1 > perIteration) {
    return { outcome: 'refused', reason: `repair_allowance_exhausted: prototype_repairs_per_iteration ${perIteration}, ${account.repairs_used} used` };
  }
  const v = iterationVerdict(tx.db, it as unknown as Parameters<typeof iterationVerdict>[1], { reservation: projectPolicy(tx.db, f.project).budget_run_billable_tokens!, repair: false, item_repairs: 0, work_item: null }, account);
  if (v !== null) return { outcome: 'refused', reason: `allowance_exceeded: ${v.limit}: ${v.reason}` };
  recordDisposition(tx, f, { disposition: 'fix', authority: 'policy', by: POLICY_ACTOR, linked_issue: null, defer_target: null });
  recordDelegatedAction(tx, {
    project: f.project,
    iteration: it.id,
    kind: 'fix_registered',
    subject_type: 'finding',
    subject_id: f.id,
    authorized_by_kind: 'decision',
    authorized_by: it.brief_decision,
    performed_by: POLICY_ACTOR,
    scope: { finding: f.id, criterion, check: f.check, candidate: candidate.id, spec_revision: it.brief_spec_revision, allowance: 'prototype_repairs_per_iteration' },
    basis: { reproduced_by: on.result, protected_version: on.version, repairs_used_before: account.repairs_used, repairs_per_iteration: perIteration, severity: f.effective_severity },
  });
  return { outcome: 'fixed' };
}

// The evidence the owner's question carries when policy did not act.
export const policyRefusedEvidence = (reason: string): Record<string, unknown> => ({ policy_fix_refused: reason });
