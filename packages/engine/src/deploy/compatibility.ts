// Deployment compatibility (the owner's instruction of 2026-10-29; the
// static-preview shapes, §5): before a build begins, whether each of the
// project's environments can host what the build produces, or the
// capability it lacks; and once the build is complete, whether it is ready
// to deploy. Information served before and after the build, never a gate:
// no plan is blocked, no approval, hold or decision is raised by it.
//
// Evaluated (each evaluation one `deployment_compatibility` row and one
// `deployment.compatibility_evaluated` event) in the transaction that
// publishes a plan (work.ts registerPlan), that writes an environment's
// configuration (deploy.ts writeConfigVersion) and that nominates a
// candidate (finalize.ts finalizeNomination). The candidate's tree is read
// on the main thread before the act (git never runs on the store worker):
// at the nomination's intent (journal/nominate.ts) and in the
// configuration's preparation (deploy/commands.ts); a publication takes
// the tree recorded at the nomination. A read serves the newest evaluation
// whose basis (the approved specification and architecture revisions, the
// current candidate and the environments' configurations) is the store's now and that was made from the current
// candidate's tree; otherwise it computes the answer for that read from
// the tree the main thread read for it (deploy/compatibility-eval.ts) and
// writes nothing (a projection writes nothing, D1 §12; M70).
//
// Per environment: `hostable` (configured, and its adapter's mode hosts the
// output kind), `unconfigured` (no configuration), `unsupported`
// (configured, and the adapter or mode cannot host it: the capability it
// lacks named), `unknown` (the output kind is unknown, or the configuration
// cannot be read; never hostable by default).

import type { Database } from 'better-sqlite3';

import { approvedModuleMap, approvedSpec } from '../design/policy.js';
import { DESIGN_PREVIEW_ENV } from '../store/transitions/deploy.js';
import { canonical, parseJson } from '../store/transitions/common.js';
import { effectiveVersion } from '../store/transitions/protected.js';
import type { Tx } from '../store/transitions/tx.js';
import { BEHAVIOR_KIND, SERVING_KIND, deploymentRequirementMet, missingDeploymentKind } from '../store/transitions/serving.js';
import { ADAPTER_CAPABILITIES, HOSTING_REQUIRED, KIND_LABEL, modeOfContent, withArticle } from './capabilities.js';
import { type KindAnswer, type OutputKind, type TreeAnswer, architectureKind, combineKinds } from './output-kind.js';
import type { DeclaredServing } from './serving-install.js';
import type { GapAuthoring } from '../store/transitions/alpha-gap.js';
import { modeOf, servingSpec, staticSpec } from './static-site.js';

type Db = Database;

export const COMPATIBILITY_STATES = ['hostable', 'unconfigured', 'unsupported', 'unknown'] as const;
export type CompatibilityState = (typeof COMPATIBILITY_STATES)[number];
export const COMPATIBILITY_TRIGGERS = ['plan_published', 'environment_configured', 'candidate_nominated'] as const;
export type CompatibilityTrigger = (typeof COMPATIBILITY_TRIGGERS)[number];

export interface EnvironmentCompatibility {
  environment: string;
  name: string;
  adapter: string | null;
  mode: string | null;
  state: CompatibilityState;
  missing_capability: string | null;
  reason: string;
}

export interface Compatibility {
  evaluated_at: string;
  output_kind: OutputKind;
  // null only when the environments could not be read (never [] for that).
  environments: EnvironmentCompatibility[] | null;
  hosting_required: boolean | null;
  reason: string;
}

// `blocked` (laplab-validation E1; DECISIONS item 42): the environment can
// host the output but the engine would refuse a deployment request now,
// for what is named (`blocker`: the required check of the alpha_complete
// scope missing, the engine's serving check of a static site not yet
// applied, the candidate's checks running again or not read); `ready` only
// when the request would be authorized for all the read can tell.
export const READINESS_STATES = ['ready', 'blocked', 'unconfigured', 'unsupported', 'unknown', 'not_complete'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];
export interface DeployReadiness {
  state: ReadinessState;
  reason: string;
  environment: string | null;
  // `blocked` only: the open decision whose answer unblocks it, or null.
  decision?: string | null;
  // `blocked` only (DECISIONS item 42): what would refuse the request.
  blocker?: Blocker;
  // `blocked` with `required_check_missing` (DECISIONS item 43): the
  // Verifier's authoring of the missing check, and the owner's request for
  // it while none is under way; with `checks_running`, only when that
  // authoring's proposal made the effective version (`applied`).
  authoring?: ReadinessAuthoring;
  // `ready` only (the owner's ruling of 2026-10-29: "If a serving check has
  // not yet been proposed, readiness may mean ready to request deployment,
  // not 'verified' or 'ready to open.' State that approval and verification
  // follow."): what `ready` means (READY_MEANINGS), and what follows a
  // request, in order, before the preview opens (REQUEST_STEPS); null when
  // that cannot be read.
  means?: ReadyMeaning;
  follows?: RequestStep[] | null;
}

// What `ready` means: `request_deployment`, a deployment can be requested
// now and is neither verified nor open before what `follows` has happened;
// `verified`, the current candidate is deployed in that environment and its
// deployment was verified by its automated checks (serving verified for a
// static site, never functional or visual acceptance), so a request deploys
// it again.
export const READY_MEANINGS = ['request_deployment', 'verified'] as const;
export type ReadyMeaning = (typeof READY_MEANINGS)[number];
// The steps that can follow a request: the engine's proposal of its
// serving check (a static site in static mode, D4 §13.2); the
// deployment-specific post-deploy check written by a Verifier (any other
// output kind whose effective version has none: a request is refused
// naming it and asks a Verifier for it, alpha-gap.ts, and is made again
// once it is applied); the approval of that protected proposal; the
// deployment; its verification. Since DECISIONS item 42 a missing
// required check reads `blocked` (requiredCheckBlock), so `ready` never
// lists `deployment_checks_authoring` or `request_again`; the names stay.
export const REQUEST_STEPS = ['serving_check_proposal', 'deployment_checks_authoring', 'approval', 'request_again', 'deployment', 'verification'] as const;
export type RequestStep = (typeof REQUEST_STEPS)[number];

// What follows a request, as `readinessOf` serves it with `ready`.
export interface RequestPath {
  means: ReadyMeaning;
  follows: RequestStep[] | null;
  // One clause for the reason and the sentence (lower case, no final stop).
  clause: string;
}

// What would refuse a deployment request now, though the environment can
// host the output: a clause (lower case, no final stop), the open
// decision that settles it, if one does, and what it is (`blocker`).
export interface AdmissionBlock {
  clause: string;
  decision: string | null;
  blocker: Blocker;
  authoring?: ReadinessAuthoring;
}

// The Verifier's authoring of a missing required check as the readiness
// serves it (DECISIONS item 43; alpha-gap.ts gapAuthoringOf): its state,
// work item, run, proposal and open decision, and `offer`, the owner's
// request that would queue it (state `none` and a check a Verifier writes;
// null otherwise), with the engine's sentence of what it does.
export interface AuthoringOffer {
  method: 'POST';
  path: string;
  consequence_text: string;
}
export interface ReadinessAuthoring extends GapAuthoring {
  offer: AuthoringOffer | null;
}

// What a `blocked` readiness names (DECISIONS item 42; M616 (e) amended,
// M626): the required check of the `alpha_complete` scope missing from the
// effective protected version (`subject` `kind:post_deploy_behavior`, or
// `kind:post_deploy_serving` for a static site, serving.ts
// missingDeploymentKind); the engine's serving check of a static site in
// static mode proposed and not applied (`kind:post_deploy_serving`); the
// candidate's checks running; or what the gate would read not read
// (`subject` null for these two).
export const BLOCKERS = ['required_check_missing', 'serving_check_pending', 'checks_running', 'checks_unread'] as const;
export type BlockerKind = (typeof BLOCKERS)[number];
export interface Blocker {
  what: BlockerKind;
  subject: string | null;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const clause = (s: string): string => lowerFirst(s.replace(/\.\s*$/, ''));

// ---- what an evaluation reads ------------------------------------------------------------

interface EnvRow {
  id: string;
  name: string;
  prefix: string | null;
  current_config: string | null;
}

// The project's environments a deployment could use: the design preview's
// (the engine's own, D7 §5.7) and an adapter qualification's apart.
const environmentsOf = (db: Db, project: string): EnvRow[] =>
  db
    .prepare(`SELECT "id", "name", "prefix", "current_config" FROM "environments" WHERE "project" = ? AND "name" <> ? AND "qualification_run" IS NULL ORDER BY rowid, "id"`)
    .all(project, DESIGN_PREVIEW_ENV) as EnvRow[];

// The current candidate: the newest not superseded.
function currentCandidate(db: Db, project: string): { id: string; revision: string } | null {
  return (db.prepare('SELECT "id", "revision" FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq" DESC LIMIT 1').get(project) as { id: string; revision: string } | undefined) ?? null;
}

// What an evaluation depends on, canonical: equal bases give equal answers.
export function compatibilityBasis(db: Db, project: string): string {
  const one = (sql: string): unknown => (db.prepare(sql).get(project) as { v: unknown } | undefined)?.v ?? null;
  return canonical({
    spec: one('SELECT "id" AS "v" FROM "spec_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1'),
    architecture: one('SELECT "id" AS "v" FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version" DESC LIMIT 1'),
    candidate: currentCandidate(db, project),
    environments: environmentsOf(db, project).map((e) => [e.id, e.prefix, e.current_config]),
  });
}

// A tree answer an earlier evaluation recorded for this candidate's
// revision (a commit's tree does not change), read, not unread.
function recordedTree(db: Db, project: string, candidate: { id: string; revision: string } | null): TreeAnswer | null {
  if (candidate === null) return null;
  const rows = db.prepare(`SELECT "tree" FROM "deployment_compatibility" WHERE "project" = ? AND "candidate" = ? AND "tree" IS NOT NULL ORDER BY rowid DESC LIMIT 5`).all(project, candidate.id) as { tree: string }[];
  for (const r of rows) {
    const t = parseJson<TreeAnswer>(r.tree);
    if (t && !('unread' in t) && t.revision === candidate.revision) return t;
  }
  return null;
}

// Whether a recorded evaluation is the one to serve now: its basis is the
// store's, and, with a candidate, it was made from that candidate's tree as
// read (an evaluation made without it, or from a failed read, is served
// only until a read can compute a better one: the read computes it).
function isCurrent(db: Db, project: string, row: { basis: string; tree: string | null } | undefined): boolean {
  if (row === undefined || row.basis !== compatibilityBasis(db, project)) return false;
  const candidate = currentCandidate(db, project);
  if (candidate === null) return true;
  const t = parseJson<TreeAnswer>(row.tree);
  return t !== null && !('unread' in t) && t.revision === candidate.revision;
}

// ---- one environment ---------------------------------------------------------------------

function environmentCompatibility(db: Db, env: EnvRow, kind: KindAnswer): EnvironmentCompatibility {
  const base = { environment: env.id, name: env.name };
  const unknown = (adapter: string | null, mode: string | null, cause: string): EnvironmentCompatibility => ({
    ...base,
    adapter,
    mode,
    state: 'unknown',
    missing_capability: null,
    reason: `Whether ${env.name} can host the output is unknown: ${cause}.`,
  });
  // No configuration: an environment the specification named (or a
  // fixture's) that the owner has not configured.
  if (env.prefix === null || env.current_config === null) {
    return { ...base, adapter: null, mode: null, state: 'unconfigured', missing_capability: null, reason: `${env.name} has no configuration: no adapter or mode is chosen for it yet.` };
  }
  let content: Record<string, unknown>;
  try {
    const row = db.prepare('SELECT "content" FROM "environment_configs" WHERE "id" = ?').get(env.current_config) as { content: string } | undefined;
    if (!row) return unknown(null, null, `its configuration ${env.current_config} is not in the store`);
    content = JSON.parse(row.content) as Record<string, unknown>;
  } catch (err) {
    return unknown(null, null, `its configuration could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
  const adapter = typeof content.adapter === 'string' ? content.adapter : null;
  if (adapter === null) return unknown(null, null, 'its configuration names no adapter');
  const mode = modeOfContent(adapter, content);
  if (kind.kind === 'unknown') return unknown(adapter, mode, `the output kind is unknown (${clause(kind.reason)})`);
  const caps = ADAPTER_CAPABILITIES[adapter];
  if (!caps) {
    const others = Object.entries(ADAPTER_CAPABILITIES).filter(([, c]) => Object.values(c.modes).some((m) => m.hosts === kind.kind)).map(([a]) => a);
    const missing = `${adapter} is not an adapter of this engine; this output is ${withArticle(kind.kind)}, ${others.length > 0 ? `which ${others.join(' or ')} hosts` : 'which no adapter of this engine hosts'}`;
    return { ...base, adapter, mode, state: 'unsupported', missing_capability: missing, reason: `${env.name} is configured for ${adapter}, which cannot host this output: ${missing}.` };
  }
  const m = mode === null ? undefined : caps.modes[mode];
  if (!m) return unknown(adapter, mode, `its configuration names the mode ${JSON.stringify(content.mode)}, which ${adapter} does not have in this engine`);
  if (m.hosts === kind.kind) {
    return { ...base, adapter, mode, state: 'hostable', missing_capability: null, reason: `${env.name} is configured for ${adapter} in ${mode} mode, which hosts ${withArticle(kind.kind)}.` };
  }
  const other = Object.entries(caps.modes).find(([, x]) => x.hosts === kind.kind)?.[0];
  const elsewhere = Object.entries(ADAPTER_CAPABILITIES).filter(([a, c]) => a !== adapter && Object.values(c.modes).some((x) => x.hosts === kind.kind)).map(([a]) => a);
  const remedy =
    other !== undefined
      ? `: configure the environment in ${other} mode`
      : elsewhere.length > 0
        ? `: configure the environment with ${elsewhere.join(' or ')}`
        : ', which no adapter of this engine hosts';
  const missing = `${adapter} in ${mode} mode ${m.what}; this output is ${withArticle(kind.kind)}${remedy}`;
  return { ...base, adapter, mode, state: 'unsupported', missing_capability: missing, reason: `${env.name} is configured for ${adapter} in ${mode} mode, which cannot host this output: ${missing}.` };
}

// ---- the evaluation ----------------------------------------------------------------------

const HOSTING_SENTENCE: Record<OutputKind, string> = {
  static_site: 'A static site needs no hosting: a download suffices.',
  node_service: 'A Node service needs hosting to run.',
  unknown: 'Whether it needs hosting is not known.',
};

// The project's compatibility now, computed: `tree` is the current
// candidate's tree as the main thread read it (or null: none was read, and
// one an earlier evaluation recorded for the same revision is taken).
export function evaluateCompatibility(db: Db, project: string, tree: TreeAnswer | null, at: string): { evaluation: Compatibility; basis: string; tree: TreeAnswer | null } {
  const candidate = currentCandidate(db, project);
  const given = tree !== null && candidate !== null && tree.revision === candidate.revision ? tree : null;
  const used = given ?? recordedTree(db, project, candidate);
  const spec = approvedSpec(db, project)?.rep ?? null;
  const map = approvedModuleMap(db, project)?.map ?? null;
  const kind = combineKinds(architectureKind({ spec, map }), used, candidate);
  const environments = environmentsOf(db, project).map((e) => environmentCompatibility(db, e, kind));
  return {
    evaluation: { evaluated_at: at, output_kind: kind.kind, environments, hosting_required: HOSTING_REQUIRED[kind.kind], reason: `${kind.reason} ${HOSTING_SENTENCE[kind.kind]}` },
    basis: compatibilityBasis(db, project),
    tree: candidate === null ? null : (given ?? used ?? null),
  };
}

// The evaluation recorded, in the transaction of what triggered it (the
// plan's publication, the configuration, the nomination's finalizer; an
// engine op too): one row, one event.
export function recordCompatibility(tx: Tx, args: { project: string; trigger: CompatibilityTrigger; tree?: TreeAnswer | null }): Compatibility & { id: string } {
  if (!(COMPATIBILITY_TRIGGERS as readonly string[]).includes(args.trigger)) throw new Error(`not a compatibility trigger: ${String(args.trigger)}`);
  const { evaluation, basis, tree } = evaluateCompatibility(tx.db, args.project, args.tree ?? null, tx.at);
  const id = tx.newId('dcmp_');
  const candidate = currentCandidate(tx.db, args.project);
  tx.db
    .prepare(
      `INSERT INTO "deployment_compatibility" ("id", "created_at", "project", "trigger", "basis", "candidate", "tree", "output_kind", "evaluation")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, tx.at, args.project, args.trigger, basis, candidate?.id ?? null, tree === null ? null : JSON.stringify(tree), evaluation.output_kind, JSON.stringify(evaluation));
  tx.emit(
    'deployment.compatibility_evaluated',
    { project: args.project },
    {
      evaluation: id,
      trigger: args.trigger,
      candidate: candidate?.id ?? null,
      output_kind: evaluation.output_kind,
      hosting_required: evaluation.hosting_required,
      environments: (evaluation.environments ?? []).map((e) => ({ environment: e.environment, state: e.state })),
    },
  );
  return { id, ...evaluation };
}

// A candidate's output kind as an evaluation recorded it from the
// candidate's tree as read (its revision's), or null when none did (the
// deliverable then derives it from the sealed tree, deploy/deliverable.ts).
export function candidateKind(db: Db, args: { project: string; candidate: string }): OutputKind | null {
  const c = db.prepare('SELECT "id", "revision" FROM "candidates" WHERE "id" = ? AND "project" = ?').get(args.candidate, args.project) as { id: string; revision: string } | undefined;
  return c ? (recordedTree(db, args.project, c) as { kind: OutputKind } | null)?.kind ?? null : null;
}

// ---- the engine's serving check beside an environment (DECISIONS item 42; M626) -----------

// The engine's file-serving check as an environment's entry serves it
// (`serving_check`): what the environment's current configuration
// declares is served, and where the engine's check stands for the
// project:
// - `present`: the effective protected version has a post_deploy_serving
//   check (`check` its key);
// - `awaiting_decision`: the engine's proposal of it has an open decision
//   (its check_correction_tightening question; `decision` named);
// - `approved`: the proposal approved, not yet applied;
// - `proposed`: captured or classified, its question not yet raised;
// - `not_proposed`: none of these (the reason says why: no serving
//   declared, the proposal rejected, none captured);
// - `unread`: the facts could not be read (never taken as none).
// `holds_deployment`: whether its absence refuses a deployment request to
// the environment: a static site in static mode whose effective version
// has no required post_deploy_behavior check of the alpha_complete scope
// to meet the requirement instead (serving.ts deploymentRequirementMet;
// M616 (e)); never for a service (a pending proposal alone adds no
// deployment gate), nor for an environment no request targets (the design
// preview's, an adapter qualification's). The same facts the readiness
// reads (servingPendingBlock, readinessOf), so the two cannot differ.
export const SERVING_CHECK_STATES = ['present', 'awaiting_decision', 'approved', 'proposed', 'not_proposed', 'unread'] as const;
export type ServingCheckState = (typeof SERVING_CHECK_STATES)[number];
export interface ServingCheck {
  kind: typeof SERVING_KIND;
  declared: DeclaredServing | null;
  state: ServingCheckState;
  check: string | null;
  proposal: string | null;
  decision: string | null;
  holds_deployment: boolean;
  reason: string;
}

const PENDING_PROPOSAL = ['captured', 'classified', 'awaiting_human', 'approved'];
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The environment's serving check, or null when the environment has no
// current configuration. `output`: the output kind the deployment
// compatibility serves.
export function servingCheckStatus(db: Db, project: string, environment: string, output: OutputKind): ServingCheck | null {
  const base = { kind: SERVING_KIND, check: null, proposal: null, decision: null } as const;
  let env: { name: string; current_config: string | null; qualification_run: string | null } | undefined;
  try {
    env = db.prepare('SELECT "name", "current_config", "qualification_run" FROM "environments" WHERE "id" = ? AND "project" = ?').get(environment, project) as typeof env;
  } catch (err) {
    return { ...base, declared: null, state: 'unread', holds_deployment: false, reason: `Whether environment ${environment} has a configuration, and so where the engine's file-serving check stands for it, could not be read (${errText(err)}).` };
  }
  if (env === undefined || env.current_config === null) return null;
  let declared: DeclaredServing | null;
  let mode: 'static' | 'service';
  try {
    const row = db.prepare('SELECT "content" FROM "environment_configs" WHERE "id" = ?').get(env.current_config) as { content: string } | undefined;
    if (!row) throw new Error(`its configuration ${env.current_config} is not in the store`);
    const content = JSON.parse(row.content) as Record<string, unknown>;
    const st = staticSpec(content);
    const sv = st === null ? servingSpec(content) : null;
    declared = st !== null ? { mode: 'static', ...st } : sv !== null ? { mode: 'service', ...sv } : null;
    mode = modeOf(content);
  } catch (err) {
    return {
      ...base,
      declared: null,
      state: 'unread',
      holds_deployment: false,
      reason: `What environment ${env.name}'s configuration declares is served, and so where the engine's file-serving check stands for it, could not be read (${errText(err)}).`,
    };
  }
  const targeted = env.name !== DESIGN_PREVIEW_ENV && env.qualification_run === null;
  const staticSite = targeted && declared?.mode === 'static' && output === 'static_site';
  const holdsWhy = (holds: boolean, present: boolean, behavior: boolean | null): string =>
    holds
      ? present
        ? "it meets this static site's deployment requirement"
        : 'a deployment request is refused until it is in place'
      : mode === 'service'
        ? `for a service it does not hold the deployment: the required behavioural check (${BEHAVIOR_KIND}) does`
        : staticSite && behavior === true
          ? `it does not hold the deployment: the project's required ${BEHAVIOR_KIND} check meets the requirement`
          : 'it does not hold the deployment';
  let facts: { present: string | null; behavior: boolean; proposal: { id: string; status: string } | null; decision: string | null };
  try {
    const v = effectiveVersion(db, project);
    if (!v) throw new Error('the project has no effective protected version');
    const present = (db.prepare(`SELECT "key" FROM "checks" WHERE "protected_version" = ? AND "kind" = ? ORDER BY rowid LIMIT 1`).get(v.id, SERVING_KIND) as { key: string } | undefined)?.key ?? null;
    const behavior = (db.prepare(`SELECT "gate_kinds" FROM "checks" WHERE "protected_version" = ? AND "kind" = ? AND "required" = 1`).all(v.id, BEHAVIOR_KIND) as { gate_kinds: string }[]).some((c) =>
      (parseJson<string[]>(c.gate_kinds) ?? []).includes('alpha_complete'),
    );
    const proposal = (db.prepare(`SELECT "id", "status" FROM "protected_proposals" WHERE "project" = ? AND "proposed_by" = 'engine' ORDER BY "seq" DESC LIMIT 1`).get(project) as { id: string; status: string } | undefined) ?? null;
    const decision =
      proposal !== null && PENDING_PROPOSAL.includes(proposal.status)
        ? ((db.prepare(`SELECT "id" FROM "decisions" WHERE "subject_type" = 'protected_proposal' AND "subject_id" = ? AND "status" = 'open' ORDER BY rowid DESC LIMIT 1`).get(proposal.id) as { id: string } | undefined)?.id ?? null)
        : null;
    facts = { present, behavior, proposal, decision };
  } catch (err) {
    const holds = staticSite;
    return { ...base, declared, state: 'unread', holds_deployment: holds, reason: `Whether the engine's file-serving check is in place could not be read (${errText(err)}); ${holdsWhy(holds, false, null)}.` };
  }
  const holds = staticSite && !facts.behavior;
  const tail = (present: boolean): string => `; ${holdsWhy(holds, present, facts.behavior)}.`;
  if (facts.present !== null) {
    return { ...base, declared, state: 'present', check: facts.present, holds_deployment: holds, reason: `The engine's file-serving check ${facts.present} is in place in the effective protected version${tail(true)}` };
  }
  const p = facts.proposal;
  if (declared === null) {
    return {
      ...base,
      declared,
      state: 'not_proposed',
      holds_deployment: holds,
      reason: `The engine's file-serving check is not proposed for environment ${env.name}: its configuration declares no serving root and entry${tail(false)}`,
    };
  }
  if (p !== null && PENDING_PROPOSAL.includes(p.status)) {
    const one = { ...base, declared, proposal: p.id, holds_deployment: holds };
    if (facts.decision !== null) {
      return { ...one, state: 'awaiting_decision', decision: facts.decision, reason: `The engine's file-serving check is proposed (proposal ${p.id}) and waits for your answer on decision ${facts.decision}${tail(false)}` };
    }
    if (p.status === 'approved') return { ...one, state: 'approved', reason: `The engine's file-serving check (proposal ${p.id}) is approved, awaiting application${tail(false)}` };
    return { ...one, state: 'proposed', reason: `The engine's file-serving check is proposed (proposal ${p.id}); its question is raised at a coming tick${tail(false)}` };
  }
  const why =
    p === null
      ? 'no proposal of the engine\'s for it was captured (none is captured while the integration branch moves during its preparation, or when the facts it is prepared from cannot be read); a new configuration version declaring serving proposes it'
      : p.status === 'rejected'
        ? `the engine's proposal ${p.id} was rejected; a new configuration version declaring serving proposes it again`
        : `the engine's proposal ${p.id} was ${p.status}, and the effective protected version has no ${SERVING_KIND} check; a new configuration version declaring serving proposes it again`;
  return { ...base, declared, state: 'not_proposed', proposal: p?.id ?? null, holds_deployment: holds, reason: `The engine's file-serving check is not proposed: ${why}${tail(false)}` };
}

// The serving check's state in the words the readiness has said of a
// static site since 2026-10-29: present, pending (proposed, not yet
// applied), none, or unread.
export type StaticServing = 'present' | 'pending' | 'none' | 'unread';
export const staticServing = (s: ServingCheck): StaticServing =>
  s.state === 'present' ? 'present' : s.state === 'not_proposed' ? 'none' : s.state === 'unread' ? 'unread' : 'pending';

const SERVING_SENTENCE: Record<StaticServing, string> = {
  present: " The engine's serving check is in place: after deployment it verifies that the entry page and its assets are served from the artifact (serving verified, not functional or visual acceptance).",
  pending: " The engine's serving check is proposed and not yet applied.",
  none: " The engine's serving check has not been proposed yet.",
  unread: " Whether the engine's serving check is in place could not be read.",
};

// What the readiness's reason says of the serving check: a static site's
// as before; a service declaring serving, the check's own sentence (it
// does not hold the deployment); nothing otherwise.
function servingNote(compat: Compatibility, serving: ServingCheck | null | undefined): string {
  if (!serving) return '';
  if (compat.output_kind === 'static_site' && serving.declared?.mode === 'static') return SERVING_SENTENCE[staticServing(serving)];
  if (serving.declared?.mode === 'service') return ` ${serving.reason}`;
  return '';
}

// The engine's serving check proposed and not applied while the deployment
// scope needs it (laplab-validation E1): the environment's serving check
// holds the deployment (a static site in static mode whose effective
// protected version has no required post_deploy_behavior check of the
// alpha_complete scope) and is proposed, awaiting its decision or
// approved. A request now is refused ACCEPTANCE_SCOPE_INCOMPLETE
// (kind:post_deploy_serving). Neither present nor proposed (the proposal
// rejected, none open): blocked as the required check missing
// (requiredCheckBlock; M616 (e) amended). Its facts not read: blocked as
// unread, never ready. null when nothing of that holds.
export function servingPendingBlock(serving: ServingCheck | null): AdmissionBlock | null {
  if (serving === null || !serving.holds_deployment) return null;
  const pending: Blocker = { what: 'serving_check_pending', subject: `kind:${SERVING_KIND}` };
  const what = `the engine's serving check (proposal ${serving.proposal}), which the deployment needs, is not applied yet`;
  switch (serving.state) {
    case 'awaiting_decision':
      return { clause: `${what}: it waits for your answer on decision ${serving.decision}`, decision: serving.decision, blocker: pending };
    case 'approved':
      return { clause: `${what}: it is approved and is being applied`, decision: null, blocker: pending };
    case 'proposed':
      return { clause: `${what}: it is proposed and its question is raised at a coming tick`, decision: null, blocker: pending };
    case 'unread':
      return { clause: clause(serving.reason), decision: null, blocker: { what: 'checks_unread', subject: null } };
    case 'not_proposed':
      return requiredCheckBlock([], 'static_site', true);
    default:
      return null;
  }
}

// The deployment-specific post-deploy check of the `alpha_complete` scope
// missing from the effective protected version (serving.ts
// deploymentRequirementMet false): a request now is refused
// ACCEPTANCE_SCOPE_INCOMPLETE naming it (gates.ts), so the readiness is
// `blocked` naming it and what writes it (DECISIONS item 42; M616 (e)
// amended). `kinds`: the kinds of the effective version's required checks
// listing alpha_complete. null when the requirement is met. `staticMode`:
// the environment is a static site's in static mode, whose serving check is
// neither present nor proposed (the engine's proposal rejected, none open).
export function requiredCheckBlock(kinds: readonly string[], output: OutputKind, staticMode = false): AdmissionBlock | null {
  if (deploymentRequirementMet(kinds, output)) return null;
  const subject = missingDeploymentKind(output);
  const blocker: Blocker = { what: 'required_check_missing', subject };
  if (subject === `kind:${BEHAVIOR_KIND}`) {
    return {
      clause:
        `the required behavioural check (${BEHAVIOR_KIND}, of the alpha_complete scope) is not in the effective protected version; ` +
        `a Verifier writes it, asked by the engine when a deployment is requested (the policy's request under on_phase_complete, or a request from the operator console), and its approval and a request again follow`,
      decision: null,
      blocker,
    };
  }
  if (staticMode) {
    return {
      clause:
        `the required serving check (${SERVING_KIND}, of the alpha_complete scope) is not in the effective protected version and no proposal of the engine's for it is open; ` +
        `the engine proposes it again when the environment's static configuration is written, and its approval and a request again follow`,
      decision: null,
      blocker,
    };
  }
  return {
    clause:
      `the required serving check (${SERVING_KIND}, of the alpha_complete scope) is not in the effective protected version; ` +
      `the engine proposes it when a static configuration, or a service configuration declaring serving, is written (a required ${BEHAVIOR_KIND} check meets the requirement too), and its approval and a request again follow`,
    decision: null,
    blocker,
  };
}

// What the main thread needs to evaluate: the repository, the current
// candidate, and whether its tree must be read (no evaluation recorded one).
export function compatibilityTarget(db: Db, args: { project: string }): { repo: string | null; candidate: { id: string; revision: string } | null; tree_known: boolean; recorded: boolean; current: boolean } {
  const repo = (db.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(args.project) as { dev_repo_path: string } | undefined)?.dev_repo_path ?? null;
  const candidate = currentCandidate(db, args.project);
  const latest = db.prepare('SELECT "basis", "tree" FROM "deployment_compatibility" WHERE "project" = ? ORDER BY rowid DESC LIMIT 1').get(args.project) as { basis: string; tree: string | null } | undefined;
  return {
    repo,
    candidate,
    tree_known: recordedTree(db, args.project, candidate) !== null,
    recorded: latest !== undefined,
    current: isCurrent(db, args.project, latest),
  };
}

// The same for every project that a read would compute (the list's).
export function compatibilityTargets(db: Db): { project: string; repo: string | null; candidate: { id: string; revision: string } }[] {
  const ids = (db.prepare('SELECT "id" FROM "projects" ORDER BY rowid').all() as { id: string }[]).map((r) => r.id);
  const out: { project: string; repo: string | null; candidate: { id: string; revision: string } }[] = [];
  for (const project of ids) {
    const t = compatibilityTarget(db, { project });
    if (t.candidate !== null && !t.current) out.push({ project, repo: t.repo, candidate: t.candidate });
  }
  return out;
}

// What a read serves: the newest evaluation whose basis is the store's now,
// else the answer computed for this read (nothing written). `trees`: the
// candidates' trees the main thread read for it.
export function servedCompatibility(db: Db, project: string, trees: TreeAnswer[] = [], at: string): Compatibility {
  const latest = db.prepare('SELECT "basis", "tree", "evaluation" FROM "deployment_compatibility" WHERE "project" = ? ORDER BY rowid DESC LIMIT 1').get(project) as { basis: string; tree: string | null; evaluation: string } | undefined;
  if (isCurrent(db, project, latest)) return JSON.parse(latest!.evaluation) as Compatibility;
  const candidate = currentCandidate(db, project);
  const tree = candidate === null ? null : (trees.find((t) => t.revision === candidate.revision) ?? null);
  return evaluateCompatibility(db, project, tree, at).evaluation;
}

// The compatibility when it cannot be read: unknown, with why; the
// environments null (not read), never an empty list.
export function unreadCompatibility(err: unknown, at: string): Compatibility {
  return {
    evaluated_at: at,
    output_kind: 'unknown',
    environments: null,
    hosting_required: null,
    reason: `The deployment compatibility cannot be evaluated: the store could not be read (${err instanceof Error ? err.message : String(err)}).`,
  };
}

// ---- deploy readiness (`build.deploy_readiness`) and NOW's sentence ------------------------

// The environment a manual deployment would use: the only one; of several,
// the first hostable, else the first.
export function deploymentEnvironment(compat: Compatibility): EnvironmentCompatibility | null {
  const envs = compat.environments ?? [];
  return envs.find((e) => e.state === 'hostable') ?? envs[0] ?? null;
}

// The readiness, and the sentence NOW's build_complete continues with.
// `serving`: the deployment environment's serving check
// (servingCheckStatus), said in the reason when a static site is ready in
// static mode, and for any service configuration declaring serving.
// `block`: what would refuse a request now (AdmissionBlock), asked only
// when the environment can host the output.
// `request`: what follows a request now (RequestPath), asked only when
// ready; without it `ready` is served as before, with no `means`.
export function readinessOf(
  complete: boolean,
  compat: Compatibility,
  serving?: ServingCheck | null,
  block?: () => AdmissionBlock | null,
  request?: () => RequestPath,
): { readiness: DeployReadiness; sentence: string } {
  const env = deploymentEnvironment(compat);
  const environment = env?.name ?? null;
  if (compat.environments === null) {
    const why = clause(compat.reason);
    return { readiness: { state: complete ? 'unknown' : 'not_complete', reason: complete ? compat.reason : 'The planned build is not complete, so there is nothing to deploy yet.', environment: null }, sentence: ` Whether it can be deployed is unknown: ${why}.` };
  }
  if (!complete) return { readiness: { state: 'not_complete', reason: 'The planned build is not complete, so there is nothing to deploy yet.', environment }, sentence: '' };
  if (env === null) {
    return { readiness: { state: 'unconfigured', reason: 'The project has no environment configured for hosting yet.', environment: null }, sentence: ' It has no environment configured for hosting yet.' };
  }
  switch (env.state) {
    case 'hostable': {
      const b = block?.() ?? null;
      if (b !== null) {
        return {
          readiness: {
            state: 'blocked',
            reason: `The environment ${env.name} can host this output (${KIND_LABEL[compat.output_kind]}) with ${env.adapter} in ${env.mode} mode, but a deployment would be refused now: ${b.clause}.${serving?.declared?.mode === 'service' ? ` ${serving.reason}` : ''}`,
            environment,
            decision: b.decision,
            blocker: b.blocker,
            ...(b.authoring ? { authoring: b.authoring } : {}),
          },
          sentence: ` It cannot be deployed to ${env.name} yet: ${b.clause}.`,
        };
      }
      const hosts = `The environment ${env.name} can host this output (${KIND_LABEL[compat.output_kind]}) with ${env.adapter} in ${env.mode} mode.${servingNote(compat, serving)}`;
      const path = request?.() ?? null;
      if (path === null) {
        return { readiness: { state: 'ready', reason: hosts, environment }, sentence: ` It can be deployed to ${env.name} (${KIND_LABEL[compat.output_kind]}, ${env.adapter} ${env.mode} mode).` };
      }
      const where = `${env.name} (${KIND_LABEL[compat.output_kind]}, ${env.adapter} ${env.mode} mode)`;
      return {
        readiness: {
          state: 'ready',
          reason: `${hosts} ${path.means === 'verified' ? 'Ready: ' : 'Ready to request deployment, not verified and not open: '}${path.clause}.`,
          environment,
          means: path.means,
          follows: path.follows,
        },
        sentence: path.means === 'verified' ? ` It is deployed to ${where}: ${path.clause}.` : ` It is ready to request deployment to ${where}, not verified and not open: ${path.clause}.`,
      };
    }
    case 'unconfigured':
      return { readiness: { state: 'unconfigured', reason: `The environment ${env.name} is not configured for hosting yet.`, environment }, sentence: ` Its environment ${env.name} is not configured for hosting yet.` };
    case 'unsupported':
      return {
        readiness: { state: 'unsupported', reason: `The environment ${env.name} cannot host this output: ${env.missing_capability}.`, environment },
        sentence: ` Its environment ${env.name} cannot host this output: ${env.missing_capability}.`,
      };
    default: {
      const prefix = `Whether ${env.name} can host the output is unknown: `;
      const cause = env.reason.startsWith(prefix) ? env.reason.slice(prefix.length).replace(/\.\s*$/, '') : clause(env.reason);
      return { readiness: { state: 'unknown', reason: env.reason, environment }, sentence: ` Whether ${env.name} can host it is unknown: ${cause}.` };
    }
  }
}
