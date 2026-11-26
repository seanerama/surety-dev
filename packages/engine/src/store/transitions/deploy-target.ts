// A deployment bound to the approved brief's environment (DECISIONS item 57,
// the owner's ruling D4 of 2026-11-26: "Bind automatic deployment to the
// environment named in the approved brief. A second configured environment
// requires a decision before dispatch."; migration 0053).
//
// The binding: when a rapid prototype's brief is approved (prototype/brief.ts
// briefApproved), the environment its target names and that environment's
// configuration and identity as they are then are recorded on the iteration
// (prototype_iterations.target_environment, target_config,
// target_config_identity). An environment named but not yet configured then
// is bound by name, and its identity at the first deployment request made to
// it (bindTarget): the binding is to the identity once one is known.
//
// `deployment_target_approval`: the owner's decision to deploy a candidate of
// the iteration to an environment other than the bound one, or to the bound
// one under a configuration whose identity is not the bound one. Its subject
// is `deployment_target` `<candidate>:<config>`; its manifest binds what the
// deployment would be. Raised by the policy's request (alpha_deploy) before
// anything of it is authorized, intended or dispatched, and by the owner's
// request (POST …/deployments answers 409 confirm_required naming it and its
// preview hash; the request sent again with that preview_hash is the
// approval). Approved, the deployment is requested as any other; rejected,
// the request is recorded `not_issued` `owner_rejected` under its key and
// never made again for that configuration.

import { Refusal } from '../../refusal.js';
import { type DecisionRow, consumeDecision } from './decisions.js';
import { type ConfigRow, type EnvRow, currentConfig, environmentByName, qualificationFor, recordTargetRejected } from './deploy.js';
import { type KindSpec, consumed, raiseQuestion, recordApproval } from './queue.js';
import { policyRevision } from './settings.js';
import type { Tx } from './tx.js';

type Db = Tx['db'];

// What the decision binds: the iteration and its candidate, the environment,
// its adapter and the adapter's qualified version, the port and the exposure
// as the configuration records them, the configuration and its identity, the
// target the brief bound, why it is outside it (`origin`), what approving
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

export const KIND = 'deployment_target_approval';
export const SUBJECT_TYPE = 'deployment_target';
const emptyManifest = (): Record<string, unknown> => Object.fromEntries(DEPLOYMENT_TARGET_KEYS.map((k) => [k, null]));

interface IterationTarget {
  id: string;
  project: string;
  seq: number;
  approved_at: string | null;
  brief_json: string | null;
  target_environment: string | null;
  target_config: string | null;
  target_config_identity: string | null;
}

// The project's current iteration whose brief is approved, when the project
// is a rapid prototype; null otherwise (a planned project is unchanged).
function boundIteration(db: Db, project: string): IterationTarget | null {
  const mode = (db.prepare('SELECT "mode" FROM "projects" WHERE "id" = ?').get(project) as { mode: string } | undefined)?.mode;
  if (mode !== 'rapid_prototype') return null;
  const it = db.prepare('SELECT * FROM "prototype_iterations" WHERE "project" = ? ORDER BY "seq" DESC LIMIT 1').get(project) as IterationTarget | undefined;
  return it && it.approved_at !== null ? it : null;
}

// The environment name the iteration's approved brief names.
function briefTargetName(it: IterationTarget): string | null {
  try {
    const name = (JSON.parse(it.brief_json ?? 'null') as { target?: { environment?: unknown } } | null)?.target?.environment;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

export interface TargetBinding {
  iteration: string;
  name: string;
  environment: string | null;
  config: string | null;
  config_identity: string | null;
}

// The binding in force for the project, or null when D4 does not apply (not
// a rapid prototype, no approved brief, or a brief naming no environment).
export function targetBindingOf(db: Db, project: string): TargetBinding | null {
  const it = boundIteration(db, project);
  if (!it) return null;
  const byId = it.target_environment === null ? undefined : (db.prepare('SELECT "name" FROM "environments" WHERE "id" = ?').get(it.target_environment) as { name: string } | undefined);
  const name = byId?.name ?? briefTargetName(it);
  if (name === null) return null;
  return { iteration: it.id, name, environment: it.target_environment, config: it.target_config, config_identity: it.target_config_identity };
}

// The binding recorded (at the brief's approval, and when an environment
// bound by name is first requested with a configuration): its environment,
// configuration and identity, once.
export function bindTarget(tx: Tx, args: { iteration: string }): void {
  const it = tx.db.prepare('SELECT * FROM "prototype_iterations" WHERE "id" = ?').get(args.iteration) as IterationTarget | undefined;
  if (!it || it.target_config_identity !== null) return;
  const name = briefTargetName(it);
  if (name === null) return;
  const env = environmentByName(tx.db, it.project, name);
  if (!env || env.name !== name || env.prefix === null) return;
  const config = currentConfig(tx.db, env);
  tx.db
    .prepare('UPDATE "prototype_iterations" SET "target_environment" = ?, "target_config" = ?, "target_config_identity" = ? WHERE "id" = ?')
    .run(env.id, config?.id ?? null, config?.config_identity ?? null, it.id);
}

export type Outside = { binding: TargetBinding; origin: 'other_environment' | 'config_changed' };

// Whether a deployment of the project to `env` under `config` is outside the
// approved brief's target: another environment, or the bound one under
// another configuration identity. null when inside, or when D4 does not apply.
export function outsideTarget(db: Db, project: string, env: Pick<EnvRow, 'id' | 'name'>, config: Pick<ConfigRow, 'config_identity'>): Outside | null {
  const b = targetBindingOf(db, project);
  if (b === null) return null;
  if (env.name !== b.name && env.id !== b.environment) return { binding: b, origin: 'other_environment' };
  if (b.config_identity !== null && config.config_identity !== b.config_identity) return { binding: b, origin: 'config_changed' };
  return null;
}

const subjectOf = (candidate: string, config: string): string => `${candidate}:${config}`;

// The owner's answer to the target decision about a candidate and
// configuration: `approve`, `reject`, `open` (asked, not answered), or null
// (never asked).
export function targetAnswer(db: Db, candidate: string, config: string): { state: 'approve' | 'reject' | 'open'; decision: DecisionRow } | null {
  const d = db.prepare(`SELECT * FROM "decisions" WHERE "kind" = ? AND "subject_type" = ? AND "subject_id" = ? AND "status" IN ('open', 'consumed') ORDER BY "seq" DESC LIMIT 1`).get(KIND, SUBJECT_TYPE, subjectOf(candidate, config)) as DecisionRow | undefined;
  if (!d) return null;
  if (d.status === 'open') return { state: 'open', decision: d };
  const option = (JSON.parse((d as DecisionRow & { answer?: string | null }).answer ?? "{}") as { option?: unknown }).option;
  return { state: option === 'approve' ? 'approve' : 'reject', decision: d };
}

// The question raised (or the open one returned) about deploying a candidate
// to an environment's current configuration; null when it does not stand.
export function askTarget(tx: Tx, args: { project: string; candidate: string; environment: string }): DecisionRow | null {
  const env = environmentByName(tx.db, args.project, args.environment);
  const config = env ? currentConfig(tx.db, env) : undefined;
  if (!env || !config) return null;
  return raiseQuestion(tx, { project: args.project, kind: KIND, subjectType: SUBJECT_TYPE, subjectId: subjectOf(args.candidate, config.id) });
}

// The owner's request to an environment outside the target, before anything
// is sealed (deploy/commands.ts prepareDeployment): `required` false when
// none is needed (inside, D4 not applying, or already approved); otherwise
// the decision (raised now when none is open, committed) and whether the
// request's preview hash confirms it.
export function confirmTarget(tx: Tx, args: { project: string; candidate: string; environment: string; preview_hash?: unknown }): { required: false } | { required: true; decision: string; preview_hash: string; confirmed: boolean; origin: string } {
  const env = environmentByName(tx.db, args.project, args.environment);
  const config = env ? currentConfig(tx.db, env) : undefined;
  if (!env || !config) return { required: false };
  const out = outsideTarget(tx.db, args.project, env, config);
  if (out === null) return { required: false };
  const answered = targetAnswer(tx.db, args.candidate, config.id);
  if (answered?.state === 'approve') return { required: false };
  const d = answered?.state === 'open' ? answered.decision : askTarget(tx, args);
  if (!d) return { required: false };
  return { required: true, decision: d.id, preview_hash: d.preview_hash, confirmed: typeof args.preview_hash === 'string' && args.preview_hash === d.preview_hash && d.status === 'open', origin: out.origin };
}

// The refusal the owner's request meets while its target is not confirmed.
export const confirmRequired = (args: { environment: string; decision: string; preview_hash: string; origin: string }): Refusal =>
  new Refusal(
    409,
    'confirm_required',
    `Environment ${args.environment} is ${args.origin === 'config_changed' ? "the approved brief's environment under a configuration other than the one bound when the brief was approved" : "not the environment the approved brief names"}: deploying there needs your decision ${args.decision} (deployment_target_approval) first.`,
    `Read the decision; approve it, or send the request again with "preview_hash": "${args.preview_hash}" to confirm. Nothing was sealed, authorized or dispatched.`,
    { decision: args.decision, kind: KIND, preview_hash: args.preview_hash, environment: args.environment, origin: args.origin },
  );

// In the owner's request's transaction (store/transitions/deploy.ts
// requestDeployment): the open decision consumed as approved when the
// request carries its preview hash. Returns whether the target is confirmed
// (approved before, confirmed now, or not needed).
export function consumeConfirmation(tx: Tx, args: { project: string; candidate: string; env: EnvRow; config: ConfigRow; preview_hash?: unknown }): { confirmed: true } | { confirmed: false; decision: DecisionRow | null; origin: string } {
  const out = outsideTarget(tx.db, args.project, args.env, args.config);
  if (out === null) return { confirmed: true };
  const answered = targetAnswer(tx.db, args.candidate, args.config.id);
  if (answered?.state === 'approve') return { confirmed: true };
  const d = answered?.state === 'open' ? answered.decision : askTarget(tx, { project: args.project, candidate: args.candidate, environment: args.env.name });
  if (d && d.status === 'open' && typeof args.preview_hash === 'string' && args.preview_hash === d.preview_hash) {
    consumeDecision(tx, d, 'approve', null);
    recordApproval(tx, d, { consequence: `deployment of candidate ${args.candidate} to ${args.env.name} outside the approved brief's target approved`, subjectType: SUBJECT_TYPE, subjectId: d.subject_id });
    return { confirmed: true };
  }
  return { confirmed: false, decision: d, origin: out.origin };
}

function previewOf(db: Db, d: { project: string | null; subject_id: string }): { manifest: Record<string, unknown>; env: EnvRow; config: ConfigRow; out: Outside } | null {
  if (d.project === null) return null;
  const [candidate, configId] = d.subject_id.split(':');
  if (!candidate || !configId) return null;
  const cand = db.prepare('SELECT "id", "revision", "project" FROM "candidates" WHERE "id" = ?').get(candidate) as { id: string; revision: string; project: string } | undefined;
  const config = db.prepare('SELECT * FROM "environment_configs" WHERE "id" = ?').get(configId) as ConfigRow | undefined;
  if (!cand || cand.project !== d.project || !config) return null;
  const env = db.prepare('SELECT * FROM "environments" WHERE "id" = ?').get(config.environment) as EnvRow | undefined;
  if (!env || env.current_config !== config.id) return null;
  const out = outsideTarget(db, d.project, env, config);
  if (out === null) return null;
  let content: { adapter?: unknown; adapter_version?: unknown; port?: unknown } = {};
  try {
    content = JSON.parse(config.content) as typeof content;
  } catch {
    content = {};
  }
  const port = typeof content.port === 'number' ? content.port : null;
  const qualified = qualificationFor(db, env) !== undefined;
  const exposure =
    port === null
      ? `The configuration of ${env.name} records no port: who could reach the service is not known, and the engine has not checked it.`
      : `The service would listen on port ${port} of this host. The configuration sets no bind address: whether it is reachable only from this host (loopback) or from your network depends on how the application binds, which the engine has not checked.`;
  const consequence = `Approving lets candidate ${cand.id} be deployed to ${env.name} (adapter ${String(content.adapter ?? env.adapter)} ${String(content.adapter_version ?? 'unknown')}${qualified ? ', qualified' : ', not qualified now: the deployment is then refused until it is'}): the request is authorized by its gate as any other and dispatched. Rejecting deploys nothing there and the request is recorded not issued.`;
  return {
    env,
    config,
    out,
    manifest: {
      iteration: out.binding.iteration,
      candidate: cand.id,
      candidate_revision: cand.revision,
      environment: env.id,
      environment_name: env.name,
      adapter: content.adapter ?? env.adapter,
      adapter_version: content.adapter_version ?? null,
      port,
      exposure_note: exposure,
      config: config.id,
      config_identity: config.config_identity,
      brief_target: { name: out.binding.name, id: out.binding.environment, bound_config: out.binding.config, bound_config_identity: out.binding.config_identity },
      origin: out.origin,
      consequence,
      policy_revision: policyRevision(db, d.project),
    },
  };
}

export const DEPLOYMENT_TARGET_APPROVAL: KindSpec = {
  preview(tx, d) {
    const p = previewOf(tx.db, d);
    if (p === null) return null;
    const { manifest: m } = p;
    const why =
      p.out.origin === 'config_changed'
        ? `${String(m.environment_name)} is the environment the approved brief names, but its configuration changed since the brief was approved (identity ${String(m.config_identity)}, bound ${String(p.out.binding.config_identity)})`
        : `the approved brief names environment ${p.out.binding.name}, not ${String(m.environment_name)}`;
    return {
      manifest: m,
      question: `Deploy candidate ${String(m.candidate)} to ${String(m.environment_name)}? ${why}, so nothing is deployed there without your decision. Adapter ${String(m.adapter)} ${String(m.adapter_version)}, port ${m.port === null ? 'not recorded' : String(m.port)}. ${String(m.exposure_note)}`,
      options: [
        { key: 'approve', label: `Deploy to ${String(m.environment_name)}`, consequence: String(m.consequence), effect: { candidate: m.candidate, environment: m.environment, config: m.config } },
        { key: 'reject', label: 'Do not deploy there', consequence: `Nothing is deployed to ${String(m.environment_name)} for candidate ${String(m.candidate)}; the request is recorded not issued (owner_rejected).`, effect: { candidate: m.candidate, environment: m.environment } },
      ],
    };
  },
  manifest: (tx, d) => previewOf(tx.db, d)?.manifest ?? emptyManifest(),
  reraise: false,
  answer(tx, d, option, note) {
    consumeDecision(tx, d, option, note);
    const [candidate, config] = d.subject_id.split(':');
    if (option === 'approve') {
      recordApproval(tx, d, { consequence: `deployment of candidate ${candidate} outside the approved brief's target approved`, subjectType: SUBJECT_TYPE, subjectId: d.subject_id });
      return consumed(d, [{ kind: 'tick' }]);
    }
    const c = tx.db.prepare('SELECT * FROM "environment_configs" WHERE "id" = ?').get(config) as ConfigRow | undefined;
    if (c && d.project !== null) recordTargetRejected(tx, { project: d.project, candidate: candidate!, environment: c.environment, config: c.id });
    return consumed(d);
  },
};
