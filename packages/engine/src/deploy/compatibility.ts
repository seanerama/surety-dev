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
import type { Tx } from '../store/transitions/tx.js';
import { ADAPTER_CAPABILITIES, HOSTING_REQUIRED, KIND_LABEL, modeOfContent, withArticle } from './capabilities.js';
import { type KindAnswer, type OutputKind, type TreeAnswer, architectureKind, combineKinds } from './output-kind.js';

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

export const READINESS_STATES = ['ready', 'unconfigured', 'unsupported', 'unknown', 'not_complete'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];
export interface DeployReadiness {
  state: ReadinessState;
  reason: string;
  environment: string | null;
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
export function readinessOf(complete: boolean, compat: Compatibility): { readiness: DeployReadiness; sentence: string } {
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
    case 'hostable':
      return {
        readiness: { state: 'ready', reason: `The environment ${env.name} can host this output (${KIND_LABEL[compat.output_kind]}) with ${env.adapter} in ${env.mode} mode.`, environment },
        sentence: ` It can be deployed to ${env.name} (${KIND_LABEL[compat.output_kind]}, ${env.adapter} ${env.mode} mode).`,
      };
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
