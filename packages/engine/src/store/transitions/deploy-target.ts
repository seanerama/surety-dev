// A deployment bound to the approved brief's environment (DECISIONS item 57,
// the owner's ruling D4 of 2026-11-26: "Bind automatic deployment to the
// environment named in the approved brief. A second configured environment
// requires a decision before dispatch."; migration 0053).
//
// `deployment_target_approval`: the owner's decision to deploy a candidate of
// a rapid prototype to an environment other than the one its approved brief
// names (or to that environment once its configuration is no longer the one
// bound when the brief was approved). Its subject is `deployment_target`
// `<candidate>:<config>`; its manifest binds what the deployment would be.

import type { KindSpec } from './queue.js';
import { Refusal } from '../../refusal.js';

// What the decision binds: the iteration and its candidate, the environment,
// its adapter and the adapter's qualified version, the port and the exposure
// as the configuration records them, the configuration and its identity, the
// target the brief bound, who asked (`policy` or `owner`), what approving
// does, and the policy revision.
export const DEPLOYMENT_TARGET_KEYS = [
  'iteration',
  'candidate',
  'candidate_revision',
  'environment',
  'environment_name',
  'adapter',
  'adapter_version',
  'port',
  'exposure_note',
  'config',
  'config_identity',
  'brief_target',
  'origin',
  'consequence',
  'policy_revision',
] as const;

const emptyManifest = (): Record<string, unknown> => Object.fromEntries(DEPLOYMENT_TARGET_KEYS.map((k) => [k, null]));

// The kind's specification. The schema and the contract come first
// (migration 0053); nothing raises the question yet, so it never stands.
export const DEPLOYMENT_TARGET_APPROVAL: KindSpec = {
  preview: () => null,
  manifest: () => emptyManifest(),
  reraise: false,
  answer(_tx, d) {
    throw new Refusal(409, 'illegal_transition', `Decision ${d.id} cannot be answered: deployment target approval is not enabled in this engine.`, 'Nothing was changed.', { decision: d.id });
  },
};
