// The deployment-specific post-deploy requirement of the `alpha_complete`
// scope, by the candidate's output kind (the owner's ruling of 2026-10-29,
// amending D4 §4.1 J4 and D3 §4.3):
//
//   "An engine-executed serving check may satisfy the deployment-specific
//   post-deploy requirement for a static site. It must verify the deployed
//   artifact's identity, entry page and required local assets. Record this
//   as serving verified, not functional or visual acceptance. Existing
//   application checks and human-review requirements remain unchanged."
//
// The rule as built: for a candidate whose sealed artifact is a
// `static_site` (deploy/static-site.ts outputKindOfTree, recorded on the
// artifact when it is sealed; engine B's `output_kind` may replace it), the
// requirement J4 states for a required `post_deploy_behavior` check listing
// `alpha_complete` is met by a required `post_deploy_serving` check listing
// `alpha_complete` (in the scope), or by a `post_deploy_behavior` check as
// before; and the deployment verification's behaviour result by that
// serving check passed for the round's candidate, environment and artifact.
// What it establishes is recorded as `serving_verified` with the statement
// "serving verified; not functional or visual acceptance": never an
// acceptance, never a sign-off, never a human review. For every other
// output kind (`node_service`, `unknown`, or an artifact recorded before its
// kind was) the `post_deploy_behavior` requirement is exactly as before. A
// static site's missing check is named `kind:post_deploy_serving`, which no
// Verifier is asked to author (alpha-gap.ts): the engine proposes it itself
// (deploy/serving-install.ts). Every other kind's and criterion's
// requirement, the tier's sign-offs and the Alpha review are unchanged.

import type { Tx } from './tx.js';

type Db = Tx['db'];

export const BEHAVIOR_KIND = 'post_deploy_behavior';
export const SERVING_KIND = 'post_deploy_serving';
export const SERVING_STATEMENT = 'serving verified; not functional or visual acceptance';

export type OutputKind = 'static_site' | 'node_service' | 'unknown';

// The output kind of a candidate's sealed artifacts: `static_site` only when
// every artifact sealed from its revision says so; `unknown` with none, or
// any of another or no recorded kind.
export function candidateOutputKind(db: Db, project: string, revision: string): OutputKind {
  const kinds = (
    db
      .prepare(
        `SELECT DISTINCT a."output_kind" AS k FROM "artifacts" a JOIN "artifact_mappings" m ON m."artifact" = a."id"
         WHERE a."project" = ? AND m."dev_revision" = ? AND a."status" = 'sealed'`,
      )
      .all(project, revision) as { k: string | null }[]
  ).map((r) => r.k);
  if (kinds.length === 1 && (kinds[0] === 'static_site' || kinds[0] === 'node_service')) return kinds[0];
  return 'unknown';
}

// Whether the kinds of the alpha_complete scope's required checks meet the
// deployment-specific requirement for the output kind.
export const deploymentRequirementMet = (kinds: readonly string[], output: OutputKind): boolean => kinds.includes(BEHAVIOR_KIND) || (output === 'static_site' && kinds.includes(SERVING_KIND));

// The subject naming the requirement unmet.
export const missingDeploymentKind = (output: OutputKind): string => `kind:${output === 'static_site' ? SERVING_KIND : BEHAVIOR_KIND}`;

// What a serving check's pass establishes, as recorded.
export interface ServingVerified {
  serving_verified: true;
  check: string;
  key: string;
  execution: string | null;
  result: string | null;
  statement: typeof SERVING_STATEMENT;
}
