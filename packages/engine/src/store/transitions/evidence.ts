// What a gate's evidence depends on, kept small so that every module that
// changes evidence can reach it (D1 §9.5; build spec §6 correction 17;
// SEAM.md §72): the staleness of evaluations, the delivery of requirements
// to a candidate, a candidate's ancestry, and the acceptance content hash.

import { canonical, sha256 } from './common.js';
import type { Tx } from './tx.js';
import { MODULE_PRESENCE, type ScopeCheck, type Tier, type ScopeModule, type ScopeRequirement, type ScopeResult, type Signoff, TIER_RANK, cadenceTier, computeScope, sameSignoff, signoffsOf } from '../../checks/scope.js';

const SIGNOFF_ORDER = (s: Signoff): number => ({ candidate: 0, module: 1, security: 2 })[s.scope] ?? 3;

type Db = Tx['db'];

// Evaluations that used something that changed are stale (D1 §9.5). Staleness
// is not invalidation: a stale evaluation is computed again, nothing more.
export function markStale(tx: Tx, where: { project?: string; candidate?: string }): void {
  if (where.candidate !== undefined) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "candidate" = ? AND "stale" = 0').run(where.candidate);
  else if (where.project !== undefined) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "project" = ? AND "stale" = 0').run(where.project);
}

// What blocked a gate from outside its evidence has cleared, or appeared: the
// evaluations it applies to are stale (D1 §9.5; E41 item 5). `blockedBy`
// limits this to evaluations that carry one of these reasons.
export function markBlockedStale(tx: Tx, project: string, blockedBy: string[]): void {
  const rows = tx.db.prepare('SELECT "id", "reasons" FROM "gate_evaluations" WHERE "project" = ? AND "stale" = 0').all(project) as { id: string; reasons: string }[];
  for (const r of rows) {
    const codes = (JSON.parse(r.reasons) as { code: string }[]).map((x) => x.code);
    if (codes.some((c) => blockedBy.includes(c))) tx.db.prepare('UPDATE "gate_evaluations" SET "stale" = 1 WHERE "id" = ?').run(r.id);
  }
}

export interface CandidateRow {
  id: string;
  project: string;
  seq: number;
  revision: string;
  lineage: string;
  held_work: string;
  nominated_protected_version: string | null;
  progress: string;
  superseded_by?: string | null;
}

export interface StageRow {
  id: string;
  project: string;
  number: number;
  implements: string;
  integrated_revision: string | null;
  work_item: string | null;
}

export interface CheckRow {
  id: string;
  project: string;
  key: string;
  protected_version: string;
  kind: string;
  required: number;
  gate_kinds: string;
  tier_floor: string | null;
  requirement_ids: string;
  runner_class: string;
  requires: string;
  sensitive_areas: string;
  origin?: string;
  criteria?: string;
}

export { TIER_RANK };

// Is `ancestor` an ancestor of (or the same commit as) `descendant`, as git
// said and the engine recorded (revision_ancestry)? A pair never recorded is
// not taken for an ancestor: the main thread records every pair a scope
// needs before the scope is built.
export function isAncestorRecorded(db: Db, project: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const row = db.prepare('SELECT "is_ancestor" FROM "revision_ancestry" WHERE "project" = ? AND "ancestor" = ? AND "descendant" = ?').get(project, ancestor, descendant) as
    | { is_ancestor: number }
    | undefined;
  return row?.is_ancestor === 1;
}

// The (stage revision, candidate revision) pairs of a project whose ancestry
// is not yet recorded: what the main thread asks git.
export function ancestryPairs(db: Db, args: { project: string }): { ancestor: string; descendant: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT s."integrated_revision" AS "ancestor", c."revision" AS "descendant" FROM "stages" s JOIN "candidates" c ON c."project" = s."project"
       WHERE s."project" = ? AND s."integrated_revision" IS NOT NULL AND s."integrated_revision" <> c."revision"
       AND NOT EXISTS (SELECT 1 FROM "revision_ancestry" a WHERE a."project" = s."project" AND a."ancestor" = s."integrated_revision" AND a."descendant" = c."revision")`,
    )
    .all(args.project) as { ancestor: string; descendant: string }[];
}

export function recordAncestry(tx: Tx, args: { project: string; pairs: { ancestor: string; descendant: string; is_ancestor: boolean }[] }): void {
  const insert = tx.db.prepare(
    'INSERT OR IGNORE INTO "revision_ancestry" ("id", "created_at", "project", "ancestor", "descendant", "is_ancestor") VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const p of args.pairs) insert.run(tx.newId('anc_'), tx.at, args.project, p.ancestor, p.descendant, p.is_ancestor ? 1 : 0);
}

export interface Delivery {
  delivered: string[];
  partial: string[];
  implementsOf: Map<string, string[]>;
}

// Delivery, per candidate (build spec §6 correction 8; SEAM.md §70): a
// requirement no stage implements, or none of whose stages is integrated at
// the candidate's revision or an ancestor of it, is not started; some is
// partial; all is delivered.
export function deliveryOf(db: Db, project: string, candidate: CandidateRow): Delivery {
  const stages = db.prepare('SELECT * FROM "stages" WHERE "project" = ?').all(project) as StageRow[];
  const requirements = (db.prepare('SELECT "id" FROM "requirements" WHERE "project" = ? ORDER BY "id"').all(project) as { id: string }[]).map((r) => r.id);
  const implementsOf = new Map<string, string[]>();
  for (const s of stages) implementsOf.set(s.id, JSON.parse(s.implements) as string[]);
  const integrated = (s: StageRow) => s.integrated_revision !== null && isAncestorRecorded(db, project, s.integrated_revision, candidate.revision);
  const delivered: string[] = [];
  const partial: string[] = [];
  for (const r of requirements) {
    const implementing = stages.filter((s) => implementsOf.get(s.id)!.includes(r));
    if (implementing.length === 0) continue;
    const done = implementing.filter(integrated).length;
    if (done === implementing.length) delivered.push(r);
    else if (done > 0) partial.push(r);
  }
  return { delivered, partial, implementsOf };
}

export function checksOfVersion(db: Db, version: string): CheckRow[] {
  return db.prepare('SELECT * FROM "checks" WHERE "protected_version" = ? ORDER BY "id"').all(version) as CheckRow[];
}

export const gateKindsOf = (c: CheckRow): string[] => JSON.parse(c.gate_kinds) as string[];
export const requirementsOf = (c: CheckRow): string[] => JSON.parse(c.requirement_ids) as string[];

// A required check of the tier (F §5.7): `required`, and no tier floor above
// the tier. What the context package reports per check; scopes use
// computeScope (checks/scope.ts).
export const applies = (c: CheckRow, tier: string): boolean => c.required === 1 && (c.tier_floor === null || TIER_RANK[c.tier_floor]! <= TIER_RANK[tier]!);

// ---- modules and their presence (D3 §4.1; SEAM.md §§222, 224) ----------------------------

interface ModuleRow {
  id: string;
  name: string;
  paths: string;
  sensitive_areas: string;
  tier_override: string | null;
}

const modulesOf = (db: Db, project: string): ModuleRow[] => db.prepare('SELECT * FROM "modules" WHERE "project" = ? ORDER BY "id"').all(project) as ModuleRow[];

const scopeModule = (m: ModuleRow): ScopeModule => ({ id: m.id, name: m.name, sensitive_areas: JSON.parse(m.sensitive_areas) as string[], tier_override: m.tier_override });

// The identity of the project's module definitions as presence depends on
// them (their ids and paths): a presence read under other definitions is of
// other modules, and is unread now (SEAM.md §222).
export function moduleBasis(db: Db, project: string): string {
  return sha256(canonical(modulesOf(db, project).map((m) => [m.id, JSON.parse(m.paths) as string[]])));
}

// What the main thread needs to read a revision's presence: the modules and
// their basis. Empty when the project has no module (nothing to read).
export function presenceModules(db: Db, project: string): { basis: string; modules: { id: string; paths: string[] }[] } {
  return { basis: moduleBasis(db, project), modules: modulesOf(db, project).map((m) => ({ id: m.id, paths: JSON.parse(m.paths) as string[] })) };
}

export interface Presence {
  modules: string[];
  read_at: string;
  basis: string;
}

// The present modules a recorded presence names, if it was read under the
// definitions in force; null when unread (never empty for unread). A
// project with no module has nothing present, read or not.
export function presenceIn(db: Db, project: string, recorded: string | Presence | null | undefined): string[] | null {
  const modules = modulesOf(db, project);
  if (modules.length === 0) return [];
  if (recorded === null || recorded === undefined) return null;
  const p = typeof recorded === 'string' ? (JSON.parse(recorded) as Partial<Presence>) : recorded;
  if (!Array.isArray(p.modules) || p.basis !== moduleBasis(db, project)) return null;
  return p.modules.filter((id) => modules.some((m) => m.id === id));
}

export const presenceOf = (db: Db, project: string, candidate: CandidateRow): string[] | null =>
  presenceIn(db, project, (candidate as CandidateRow & { module_presence?: string | null }).module_presence ?? null);

// A candidate's presence, read by the main thread, recorded (SEAM.md §224).
// Recorded only under the definitions in force, so a read that crossed a
// redefinition is not kept.
export function recordPresence(tx: Tx, args: { candidate: string; modules: string[]; basis: string }): boolean {
  const c = getCandidate(tx.db, args.candidate);
  if (!c || args.basis !== moduleBasis(tx.db, c.project)) return false;
  if (presenceOf(tx.db, c.project, c) !== null) return false;
  const value: Presence = { modules: [...args.modules].sort(), read_at: tx.at, basis: args.basis };
  tx.db.prepare('UPDATE "candidates" SET "module_presence" = ? WHERE "id" = ?').run(JSON.stringify(value), c.id);
  markStale(tx, { candidate: c.id });
  return true;
}

// The candidates whose presence is unread (D3 §4.1): what the main thread
// reads. Not built, by design: a superseded candidate's presence is not
// read again (its evaluation is refused, Q9; it is owed nothing more).
export function presenceDue(db: Db, args: { project: string }): { candidates: { id: string; revision: string }[]; basis: string; modules: { id: string; paths: string[] }[] } {
  const mods = presenceModules(db, args.project);
  if (mods.modules.length === 0) return { candidates: [], ...mods };
  const rows = db.prepare('SELECT * FROM "candidates" WHERE "project" = ? AND "superseded_by" IS NULL ORDER BY "seq"').all(args.project) as CandidateRow[];
  return { candidates: rows.filter((c) => presenceOf(db, args.project, c) === null).map((c) => ({ id: c.id, revision: c.revision })), ...mods };
}

// The presence a due nomination's revision needs, not yet read under the
// definitions in force: what the main thread reads before the nomination is
// intended (D3 §2.5, L2). null when nothing is to be read.
export function nominationPresenceDue(db: Db, args: { project: string }): { revision: string; basis: string; modules: { id: string; paths: string[] }[] } | null {
  const row = db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(args.project) as { nomination_due: string | null } | undefined;
  if (!row?.nomination_due) return null;
  const due = JSON.parse(row.nomination_due) as { revision: string; presence?: Presence };
  const mods = presenceModules(db, args.project);
  if (mods.modules.length === 0) return null;
  if (due.presence && due.presence.basis === mods.basis) return null;
  return { revision: due.revision, ...mods };
}

// The presence read for a due nomination, kept with it until the intent
// freezes it (accept.ts intendNomination).
export function recordNominationPresence(tx: Tx, args: { project: string; revision: string; modules: string[]; basis: string }): boolean {
  const row = tx.db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(args.project) as { nomination_due: string | null } | undefined;
  if (!row?.nomination_due || args.basis !== moduleBasis(tx.db, args.project)) return false;
  const due = JSON.parse(row.nomination_due) as { revision: string; presence?: Presence };
  if (due.revision !== args.revision) return false;
  const presence: Presence = { modules: [...args.modules].sort(), read_at: tx.at, basis: args.basis };
  tx.db.prepare('UPDATE "projects" SET "nomination_due" = ? WHERE "id" = ?').run(JSON.stringify({ ...due, presence }), args.project);
  return true;
}

// ---- the scope (D3 §4.2; one rule, every consumer) ----------------------------------------

const toScopeCheck = (c: CheckRow): ScopeCheck => ({
  id: c.id,
  key: c.key,
  kind: c.kind,
  origin: c.origin === 'developer' ? 'developer' : 'acceptance',
  required: c.required === 1,
  gate_kinds: gateKindsOf(c),
  tier_floor: c.tier_floor,
  criteria: c.criteria ? (JSON.parse(c.criteria) as string[]) : [],
  requirements: requirementsOf(c),
  sensitive_areas: JSON.parse(c.sensitive_areas) as string[],
});

function requirementRows(db: Db, project: string): ScopeRequirement[] {
  return (db.prepare('SELECT "id", "key", "criteria", "sensitive_areas" FROM "requirements" WHERE "project" = ? ORDER BY "id"').all(project) as {
    id: string;
    key: string;
    criteria: string | null;
    sensitive_areas: string;
  }[]).map((r) => ({ id: r.id, key: r.key, criteria: r.criteria === null ? null : (JSON.parse(r.criteria) as string[]), sensitive_areas: JSON.parse(r.sensitive_areas) as string[] }));
}

export interface RequiredSet {
  required: CheckRow[];
  obligations: string[];
  delivery: Delivery;
  tier: string;
  scope: ScopeResult;
}

// The scope of one gate of a candidate under a protected version (D3 §§4.1
// to 4.3): its modules (at `stage` the stage's; at `alpha_authorize` those
// present at the revision, as recorded), its tier, its required set, its
// categories, its sign-offs and what it misses. One function for every
// consumer: check registration (D3 §2.5), the scope, the sign-offs and the
// content hash (B04; T12).
export function requiredSet(db: Db, args: { project: string; candidate: CandidateRow; kind: string; stage: string | null; version: string }): RequiredSet {
  const projectTier = (db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(args.project) as { tier: string }).tier;
  const delivery = deliveryOf(db, args.project, args.candidate);
  const all = modulesOf(db, args.project);
  let modules: ScopeModule[] | null;
  let stageImplements: string[] = [];
  if (args.kind === 'stage') {
    const stage = db.prepare('SELECT "modules", "implements" FROM "stages" WHERE "id" = ?').get(args.stage ?? '') as { modules: string; implements: string } | undefined;
    const ids = stage ? (JSON.parse(stage.modules) as string[]) : [];
    stageImplements = stage ? (JSON.parse(stage.implements) as string[]) : [];
    modules = all.filter((m) => ids.includes(m.id)).map(scopeModule);
  } else {
    const present = presenceOf(db, args.project, args.candidate);
    modules = present === null ? null : all.filter((m) => present.includes(m.id)).map(scopeModule);
  }
  const rows = checksOfVersion(db, args.version);
  const scope = computeScope({
    kind: args.kind === 'stage' ? 'stage' : 'alpha_authorize',
    projectTier,
    checks: rows.map(toScopeCheck),
    requirements: requirementRows(db, args.project),
    delivered: delivery.delivered,
    partial: delivery.partial,
    stageImplements,
    modules,
  });
  const ids = new Set(scope.required.map((c) => c.id));
  return { required: rows.filter((c) => ids.has(c.id)), obligations: scope.obligations, delivery, tier: scope.tier, scope };
}

// The (stage revision, candidate revision) facts a candidate's required sets
// need that git has not yet answered: a delivery read from an unrecorded
// ancestry would be a guess (D3 §2.5, L2).
export function unreadAncestry(db: Db, project: string, candidate: CandidateRow): boolean {
  const stages = db.prepare('SELECT "integrated_revision" FROM "stages" WHERE "project" = ? AND "integrated_revision" IS NOT NULL').all(project) as { integrated_revision: string }[];
  return stages.some(
    (s) =>
      s.integrated_revision !== candidate.revision &&
      !db.prepare('SELECT 1 FROM "revision_ancestry" WHERE "project" = ? AND "ancestor" = ? AND "descendant" = ?').get(project, s.integrated_revision, candidate.revision),
  );
}

// The work a candidate holds by ancestry (E43): what it holds itself and what
// every candidate before it on its lineage chain holds. After a fix, the
// stage's work its first candidate held is held by the fix's candidate too.
export function heldByAncestry(db: Db, candidate: CandidateRow): string[] {
  const held = JSON.parse(candidate.held_work) as string[];
  for (const id of predecessors(db, candidate)) {
    const prior = getCandidate(db, id);
    if (prior) held.push(...(JSON.parse(prior.held_work) as string[]));
  }
  return [...new Set(held)];
}

// The stages whose work a candidate holds, by ancestry (E43).
export function stagesHeld(db: Db, candidate: CandidateRow): string[] {
  const out: string[] = [];
  for (const w of heldByAncestry(db, candidate)) {
    const item = db.prepare('SELECT "kind", "subject" FROM "work_items" WHERE "id" = ?').get(w) as { kind: string; subject: string } | undefined;
    if (item?.kind !== 'stage_build') continue;
    const stage = (JSON.parse(item.subject) as { stage?: string }).stage;
    if (stage && !out.includes(stage)) out.push(stage);
  }
  return out;
}

export interface CandidateContent {
  checks: CheckRow[];
  categories: string[];
  signoffs: Signoff[];
  // The highest tier of its scopes (every module's, while presence is
  // unread): what queues the review its sign-offs need (slice 20 review,
  // minor 6) and marks the context's required checks (minor 5).
  tier: Tier;
  // Its scopes' modules, each as `[id, paths, effective tier]` (every module
  // while presence is unread), in id order: part of the content hash, so a
  // redefined or re-tiered module changes it (slice 20 review, serious 2).
  modules: [string, string[], Tier][];
  delivered: string[];
  // The facts its scopes need that are unread: `ancestry`, `module_presence`.
  unread: string[];
}

// The candidate's scopes together (D3 §2.5, §4.2; SEAM.md §225): the `stage`
// scope of each stage it holds and its `alpha_authorize` scope. What a
// trigger registers, what the acceptance content hash covers (the gate kind
// excluded, so one sign-off serves both gates), and the sign-offs a Reviewer
// is asked for.
export function candidateContent(db: Db, project: string, candidate: CandidateRow, version: string): CandidateContent {
  const scopes = [...stagesHeld(db, candidate).map((stage) => requiredSet(db, { project, candidate, kind: 'stage', stage, version })), requiredSet(db, { project, candidate, kind: 'alpha_authorize', stage: null, version })];
  const byId = new Map<string, CheckRow>();
  const categories = new Set<string>();
  const signoffs: Signoff[] = [];
  const moduleIds = new Set<string>();
  let tier: Tier = 'T1';
  const raise = (t: Tier): void => {
    if (TIER_RANK[t]! > TIER_RANK[tier]!) tier = t;
  };
  for (const s of scopes) {
    for (const c of s.required) byId.set(c.id, c);
    for (const a of s.scope.categories) categories.add(a);
    for (const so of s.scope.signoffs) if (!signoffs.some((x) => sameSignoff(x, so))) signoffs.push(so);
    for (const m of s.scope.modules) moduleIds.add(m.id);
    raise(s.scope.tier);
  }
  const all = modulesOf(db, project);
  const projectTier = (db.prepare('SELECT "tier" FROM "projects" WHERE "id" = ?').get(project) as { tier: string }).tier;
  const unread: string[] = [];
  if (unreadAncestry(db, project, candidate)) unread.push('ancestry');
  if (presenceOf(db, project, candidate) === null) {
    unread.push(MODULE_PRESENCE);
    // Any module may be in the deployment scope while its presence is
    // unread: a Reviewer is asked the sign-offs of each (never fewer).
    const allTier = cadenceTier(projectTier, all);
    for (const so of signoffsOf(allTier, all)) if (!signoffs.some((x) => sameSignoff(x, so))) signoffs.push(so);
    for (const m of all) moduleIds.add(m.id);
    raise(allTier);
  }
  signoffs.sort((a, b) => SIGNOFF_ORDER(a) - SIGNOFF_ORDER(b) || (a.module ?? '').localeCompare(b.module ?? ''));
  const modules = all
    .filter((m) => moduleIds.has(m.id))
    .map((m): [string, string[], Tier] => [m.id, [...(JSON.parse(m.paths) as string[])].sort(), cadenceTier(projectTier, [m])]);
  return {
    checks: [...byId.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    categories: [...categories].sort(),
    signoffs,
    tier,
    modules,
    delivered: scopes[scopes.length - 1]!.delivery.delivered,
    unread,
  };
}

// The acceptance content of a candidate (D1 §3.4, A.3; SEAM.md §225): its
// revision, the effective protected fingerprint, the requirements delivered
// to it, and the required checks and sensitivity categories of its scopes
// together, whatever the gate kind. A fact its scopes need that is unread is
// part of what it hashes, so no hash stands for content nobody could read.
export function contentHash(db: Db, project: string, candidate: CandidateRow): string {
  const effective = db
    .prepare(`SELECT "id", "fingerprint" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL`)
    .get(project) as { id: string; fingerprint: string } | undefined;
  const content = effective ? candidateContent(db, project, candidate, effective.id) : null;
  const delivered = content?.delivered ?? deliveryOf(db, project, candidate).delivered;
  const body: Record<string, unknown> = {
    source_revision: candidate.revision,
    fingerprint: effective?.fingerprint ?? null,
    delivered: [...delivered].sort(),
    required: (content?.checks ?? []).map((c) => c.id).sort(),
    sensitivity: content?.categories ?? [],
  };
  if (content && content.unread.length > 0) body.unread = content.unread;
  // The scopes' modules (id, paths, effective tier) and the required
  // sign-offs: a module redefined or re-tiered, with the required set as it
  // was, is changed content, and an earlier sign-off does not count for it
  // (slice 20 review, serious 2; D3 §4.2; T12). Absent when empty, so a
  // project with neither keeps the hash it had.
  if (content && content.modules.length > 0) body.modules = content.modules;
  if (content && content.signoffs.length > 0) body.signoffs = content.signoffs.map((so) => [so.role, so.scope, so.module ?? null]);
  return sha256(canonical(body));
}

export function getCandidate(db: Db, id: string): CandidateRow | undefined {
  return db.prepare('SELECT * FROM "candidates" WHERE "id" = ?').get(id) as CandidateRow | undefined;
}

// The candidates a candidate descends from along the lineage chain
// (D1 §3.3; B02): the one its lineage started from, and so on back.
export function predecessors(db: Db, candidate: CandidateRow): string[] {
  const out: string[] = [];
  let lineage: string | null = candidate.lineage;
  for (let guard = 0; lineage !== null && guard < 10_000; guard++) {
    const row = db.prepare('SELECT "started_from_candidate" FROM "lineages" WHERE "id" = ?').get(lineage) as { started_from_candidate: string | null } | undefined;
    const from = row?.started_from_candidate ?? null;
    if (from === null || out.includes(from)) break;
    out.push(from);
    const prior = getCandidate(db, from);
    lineage = prior?.lineage ?? null;
  }
  return out;
}

// The (stage revision, revision to nominate) pairs whose ancestry a due
// nomination's registration will need, not yet recorded: read before the
// nomination is intended, so that its finalizer registers from facts frozen
// at intent (D3 §2.5, L2).
export function nominationAncestryPairs(db: Db, args: { project: string }): { ancestor: string; descendant: string }[] {
  const due = db.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(args.project) as { nomination_due: string | null } | undefined;
  if (!due?.nomination_due) return [];
  const revision = (JSON.parse(due.nomination_due) as { revision: string }).revision;
  const stages = db.prepare('SELECT DISTINCT "integrated_revision" AS r FROM "stages" WHERE "project" = ? AND "integrated_revision" IS NOT NULL').all(args.project) as { r: string }[];
  return stages
    .filter((s) => s.r !== revision && !db.prepare('SELECT 1 FROM "revision_ancestry" WHERE "project" = ? AND "ancestor" = ? AND "descendant" = ?').get(args.project, s.r, revision))
    .map((s) => ({ ancestor: s.r, descendant: revision }));
}
