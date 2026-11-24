// The engine's own serving check, proposed by the engine (the owner's
// ruling of 2026-10-29: "An engine-executed serving check may satisfy the
// deployment-specific post-deploy requirement for a static site ... no paid
// Verifier run solely to prove static files are served"). When an
// environment is configured in static mode, or in service mode explicitly
// declaring `serving {root, entry}` (DECISIONS item 41; the owner's ruling
// of 2026-11-24: "When a service explicitly declares serving: {root,
// entry}, use the existing engine-authored proposal flow if the serving
// check is absent"), and the project's effective protected version has no
// `post_deploy_serving` check, and no proposal of the engine's for one is
// still open, the engine prepares, here on the main
// thread, a protected proposal through the existing check-definition path:
// the integration head's tree with one definition added under the governed
// `check_discovery.definitions` (and its key added to the governed
// `required_checks` when that names a list), committed nowhere yet. The
// configuration's transaction captures it with `proposed_by = 'engine'`
// and its rationale record; from there it is any proposal: classified at a
// tick, approved as its class is (a tightening: the owner's
// check_correction_tightening decision under `recommend`, the Reviewer's
// under `authoritative`), applied through the journal into a new protected
// version. Provenance: the proposal's `proposed_by` is `engine`, its `run`
// null, its `protected.proposed` event says `proposed_by: engine` and
// `engine_authored: post_deploy_serving`, and its rationale record says why.
// For a service the check establishes artifact identity only (the bytes
// served from the declared root against the sealed artifact's); what the
// running service does stays its behavioural check's (post_deploy_behavior),
// still required for its alpha_complete scope (store/transitions/serving.ts).

import { GOVERNED_FILE, governedText } from '../protected/set.js';
import { repoContext } from '../git/exec.js';
import { diffTrees } from '../git/repo.js';
import { diffHashOf, treeWith } from '../projects/commands.js';
import { writeWholeRecord } from '../records/files.js';
import { log } from '../runtime.js';
import type { Runtime } from '../runtime.js';
import { SERVING_COMMAND, SERVING_DESCRIPTION, SERVING_KIND } from '../checks/schema.js';

export const SERVING_CHECK_KEY = 'surety-static-serving';

// The definition the engine writes (D3 §1.3; SHAPES.md §3).
export function servingDefinition(timeoutMax: number): Record<string, unknown> {
  return {
    schema: 1,
    key: SERVING_CHECK_KEY,
    kind: SERVING_KIND,
    command: [SERVING_COMMAND],
    timeout_s: Math.max(1, Math.min(60, timeoutMax)),
    gate_kinds: ['alpha_complete'],
    requires: ['environment', 'artifact_digest'],
    inputs: [],
  };
}

export interface ServingInstallFacts {
  repo: string;
  head: string | null;
  definitions: string | null;
  timeout_max: number | null;
  // `present`: the effective version has a serving check; `pending`: a
  // proposal of the engine's for one is open; `none`: neither.
  state: 'present' | 'pending' | 'none' | 'unread';
}

export interface ServingProposal {
  head: string;
  tree: string;
  diffHash: string;
  rationale: string;
  changesRequiredSet: boolean;
}

// What a configuration declares is served: a static configuration's
// `static`, or a service configuration's explicitly declared `serving`
// (deploy/static-site.ts staticSpec, servingSpec).
export interface DeclaredServing {
  mode: 'static' | 'service';
  root: string;
  entry: string;
}

// The proposal to capture with the configuration, or null with why not.
export async function prepareServingProposal(rt: Runtime, project: string, environment: string, declared: DeclaredServing): Promise<{ proposal: ServingProposal | null; why: string | null }> {
  let facts: ServingInstallFacts;
  try {
    facts = await rt.read<ServingInstallFacts>('serving.install_facts', { project });
  } catch (err) {
    log('serving check', err, { project });
    return { proposal: null, why: 'the project\'s protected facts could not be read' };
  }
  if (facts.state === 'present') return { proposal: null, why: 'the effective protected version has a post_deploy_serving check' };
  if (facts.state === 'pending') return { proposal: null, why: 'a proposal of the engine\'s for the serving check is open' };
  if (facts.state === 'unread' || facts.head === null || facts.definitions === null || facts.timeout_max === null) return { proposal: null, why: 'the project has no integration head or effective protected version to propose against' };
  const ctx = repoContext(facts.repo);
  const dir = facts.definitions.endsWith('/') ? facts.definitions : `${facts.definitions}/`;
  const files: Record<string, string> = { [`${dir}${SERVING_CHECK_KEY}.json`]: `${JSON.stringify(servingDefinition(facts.timeout_max), null, 2)}\n` };
  let changesRequiredSet = false;
  try {
    const text = await governedText(ctx, facts.head);
    if (text !== null) {
      const g = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(g.required_checks) && !g.required_checks.includes(SERVING_CHECK_KEY)) {
        files[GOVERNED_FILE] = `${JSON.stringify({ ...g, required_checks: [...g.required_checks, SERVING_CHECK_KEY] }, null, 2)}\n`;
        changesRequiredSet = true;
      }
    }
  } catch (err) {
    log('serving check', err, { project });
    return { proposal: null, why: 'the governed file at the integration head could not be read' };
  }
  const tree = await treeWith(facts.repo, facts.head, files, rt.scratch);
  if (tree === null) return { proposal: null, why: 'the proposal\'s tree could not be written' };
  const changes = await diffTrees(ctx, facts.head, tree);
  if (changes === null) return { proposal: null, why: 'the proposal\'s tree could not be compared' };
  const rationale = await writeWholeRecord(rt, {
    project,
    run: null,
    kind: 'proposal_rationale',
    content: Buffer.from(servingRationale(environment, declared)),
  });
  return { proposal: { head: facts.head, tree, diffHash: diffHashOf(changes), rationale, changesRequiredSet }, why: null };
}

// Why the engine proposes its serving check, by what the configuration
// declares: a static configuration's text as it has been since 2026-10-29;
// a service's says what the check verifies (the bytes served from the
// declared root against the sealed artifact) and that it never stands in
// for the service's behavioural check.
export function servingRationale(environment: string, declared: DeclaredServing): string {
  const what = `The engine proposes its own serving check (${SERVING_KIND}, key ${SERVING_CHECK_KEY}, the engine's program ${SERVING_COMMAND})`;
  if (declared.mode === 'static') {
    return (
      `${what} because environment ${environment} is configured in static mode. ` +
      `Its description: ${SERVING_DESCRIPTION}. Under the owner's ruling of 2026-10-29 it may meet the deployment-specific post-deploy requirement of a static site's alpha_complete scope, recorded as serving verified, never as functional or visual acceptance. No Verifier wrote it.\n`
    );
  }
  return (
    `${what} because environment ${environment}'s service configuration declares serving {root: ${JSON.stringify(declared.root)}, entry: ${JSON.stringify(declared.entry)}}. ` +
    `It verifies the bytes served from the declared root against the sealed artifact: the entry page and its referenced local assets, as the running service serves them, each byte-identical to the sealed artifact's file under root ${JSON.stringify(declared.root)}. ` +
    `Its description: ${SERVING_DESCRIPTION}. Under the owner's ruling of 2026-11-24 matching file bytes establishes artifact identity, while the behavioural check establishes what the running service does: the service's post_deploy_behavior check stays required for its alpha_complete scope, and this check never meets that requirement nor is recorded as functional or visual acceptance. No Verifier wrote it.\n`
  );
}
