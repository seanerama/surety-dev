// The owner asks for the missing deployment check (DECISIONS item 43; the
// owner's words of 2026-11-24: "For manual policy, that click is the
// owner's instruction to start authoring. For automatic deployment, use the
// existing policy authorization when it already covers the work."; M7 plan
// §3f M627).
//
// POST /v1/projects/:p/environments/:e/request-checks {}. Under
// `alpha_deploy: manual` the Verifier's authoring of a check the deployment
// gate lacks was queued only by a refused deployment request
// (alpha-gap.ts); the owner's Everyday Workspace withholds Deploy while the
// readiness is `blocked`, so nothing asked for it. Here the owner asks for
// it directly, for the current candidate and that environment, through the
// same gap-authoring path: one `check_authoring` work item, trigger
// `authoring_gap`, its evidence naming the gate, the evaluation, the
// environment, what is missing, and who asked (`requested_by`).
//
// The gap needs an `alpha_authorize` evaluation. A deployment request's is
// bound to the proposed authorization it derives from a sealed artifact;
// this route seals nothing and requests no deployment, so the gate is
// evaluated for the candidate and the environment with no authorization
// (gates.ts `checks_environment`): the scope is the environment's, its
// artifact unknown (no check of the alpha_authorize scope that needs an
// artifact digest is read as passed), the completion's requirement (J4) is
// the environment's, and the evaluation is recorded with no authorization
// and issues none. Nothing is deployed; no authorization is proposed and
// no deployment request is recorded.
//
// An authoring asked for a deployment gap that is under way, or awaits its
// proposal's decision, answers the request (`reused`), whoever asked for it
// (a repeat click, a refresh, the policy's refused request under
// `on_phase_complete`): no evaluation, no second work item, no second run.

import { nowIso } from '../../clock.js';
import { servedCompatibility } from '../../deploy/compatibility.js';
import type { TreeAnswer } from '../../deploy/output-kind.js';
import { buildComplete } from '../../plan/phase.js';
import { Refusal } from '../../refusal.js';
import { askAlphaGapAuthoring, gapAuthoringItem, gapAuthoringOf, requesterOf } from './alpha-gap.js';
import { notFound } from './common.js';
import { currentConfig, environmentByName, targetsOf } from './deploy.js';
import { getCandidate } from './evidence.js';
import { evaluateGate } from './gates.js';
import { projectNotFound } from './project.js';
import type { Tx } from './tx.js';

export interface RequestChecksArgs {
  project: string;
  // The environment's name, as the path named it.
  environment: string;
  // The current candidate as the preparation read it, and the gate's facts
  // read for it on the main thread (gates/prepare.ts); null with no candidate.
  candidate: string | null;
  facts: Record<string, unknown> | null;
  // The candidates' trees the main thread read (the deployment
  // compatibility's, as a read's).
  trees: TreeAnswer[];
}

export function requestEnvironmentChecks(tx: Tx, args: RequestChecksArgs): { status: number; body: unknown } {
  const db = tx.db;
  if (db.prepare('SELECT 1 FROM "projects" WHERE "id" = ?').get(args.project) === undefined) throw projectNotFound(args.project);
  const env = environmentByName(db, args.project, args.environment);
  if (!env || env.prefix === null) throw notFound('environment', args.environment);
  const current = db.prepare('SELECT "id" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(args.project) as { id: string } | undefined;
  if (current === undefined || !buildComplete(db, args.project)) {
    throw new Refusal(
      409,
      'no_candidate',
      current === undefined
        ? `Project ${args.project} has no current candidate, so there is no deployment whose checks could be asked for.`
        : `The planned build of project ${args.project} is not complete, so there is no deployment whose checks could be asked for yet.`,
      'Nothing was queued. Ask again once the build is complete.',
      { project: args.project, candidate: current?.id ?? null },
    );
  }
  if (args.candidate !== current.id || args.facts === null) {
    throw new Refusal(409, 'illegal_transition', `The current candidate of project ${args.project} changed while the request was prepared (now ${current.id}).`, 'Nothing was queued. Ask again.', {
      candidate: current.id,
    });
  }
  // The environment hosts the build's output: the compatibility a read
  // serves. Not hostable (unconfigured, unsupported, or unknown): refused.
  const compat = servedCompatibility(db, args.project, args.trees, nowIso());
  const entry = compat.environments?.find((e) => e.environment === env.id) ?? null;
  if (entry === null || entry.state !== 'hostable') {
    throw new Refusal(
      409,
      'not_hostable',
      entry === null
        ? `Whether the environment ${env.name} can host the build's output is not known: ${compat.reason}`
        : entry.state === 'unsupported'
          ? `The environment ${env.name} cannot host this output: ${entry.missing_capability}.`
          : entry.reason,
      'Nothing was queued. Configure an environment that can host the output, then ask again.',
      { environment: env.name, state: entry?.state ?? null },
    );
  }
  const under = gapAuthoringItem(db, args.project);
  if (under !== null) {
    const s = gapAuthoringOf(db, under);
    return { status: 202, body: { work_item: s.work_item, state: s.state, proposal: s.proposal, decision: s.decision, reused: true, requested_by: requesterOf(db, under) } };
  }
  const candidate = getCandidate(db, current.id)!;
  const { evaluation } = evaluateGate(tx, { ...args.facts, project: args.project, candidate: candidate.id, kind: 'alpha_authorize', checks_environment: env.id });
  const config = currentConfig(db, env);
  const item = askAlphaGapAuthoring(tx, candidate, evaluation.id, { name: env.name, targets: config ? targetsOf(config) : null });
  if (item === null) {
    const codes = (evaluation.reasons as { code: string }[]).map((r) => r.code);
    throw new Refusal(
      409,
      'nothing_missing',
      evaluation.outcome === 'satisfied'
        ? `Nothing a Verifier could write is missing from the ${env.name} deployment of candidate ${candidate.id}: alpha_authorize is satisfied for it.`
        : `Nothing a Verifier could write is missing from the ${env.name} deployment of candidate ${candidate.id}: alpha_authorize names ${[...new Set(codes)].join(', ')}, and none of it is a check a Verifier writes.`,
      evaluation.outcome === 'satisfied' ? 'Nothing was queued. Request the deployment.' : 'Nothing was queued. Read the reasons and settle them; then request the deployment.',
      { candidate: candidate.id, environment: env.name, outcome: evaluation.outcome, reasons: evaluation.reasons },
    );
  }
  const s = gapAuthoringOf(db, item);
  return { status: 202, body: { work_item: item, state: s.state, proposal: s.proposal, decision: s.decision, reused: false, requested_by: 'human' } };
}
