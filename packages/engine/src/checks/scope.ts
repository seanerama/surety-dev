// Validation scope at run time (D3 §§4.1 to 4.4; L3; B04; Q7, Q10; SEAM.md
// §§221 to 225): one pure function from what the store holds to a scope's
// tier, modules, required set, sensitivity categories, required sign-offs
// and what is missing. Every consumer derives from it (D3 §4.2, "one rule,
// every consumer"): check registration, the gate's scope, the required
// sign-offs, the acceptance content hash and so the staleness of a preview
// bound to it (store/transitions/evidence.ts gathers the inputs).
//
// Not built here, by design (slice 20, approved): the `phase` scope (D3
// §4.2 defines it; the gate stays `unsupported`, SEAM.md §70); the
// requirement index from spec approval (the plan fixture supplies it, D3
// §4.5).

export type Tier = 'T1' | 'T2' | 'T3';
export type ScopeKind = 'stage' | 'alpha_authorize';

export const TIER_RANK: Record<string, number> = { T1: 1, T2: 2, T3: 3 };

// F §5.7's kind inventory per tier (D3 §4.3; B04), cumulative.
export const KIND_INVENTORY: Record<Tier, readonly string[]> = Object.freeze({
  T1: ['acceptance', 'smoke'],
  T2: ['acceptance', 'smoke', 'integration', 'security_lint'],
  T3: ['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery'],
});

// The subject naming an unread module presence fact (SEAM.md §221).
export const MODULE_PRESENCE = 'module_presence';

export interface ScopeCheck {
  id: string;
  key: string;
  kind: string;
  origin: 'acceptance' | 'developer';
  required: boolean;
  gate_kinds: string[];
  tier_floor: string | null;
  // The criteria it names (covers.criteria); a developer check names none.
  criteria: string[];
  // The requirements it covers, for membership (D3 §4.2 (b)): those of its
  // criteria, or the M1 fixture's `requirements`, which cover no criterion.
  requirements: string[];
  sensitive_areas: string[];
}

export interface ScopeRequirement {
  id: string;
  key: string;
  // null: no index row registered it; [] an index row with no criterion.
  // Either way the requirement is uncertain (D3 §4.3).
  criteria: string[] | null;
  sensitive_areas: string[];
}

export interface ScopeModule {
  id: string;
  name: string;
  sensitive_areas: string[];
  tier_override: string | null;
}

export interface ScopeInputs {
  kind: ScopeKind;
  projectTier: string;
  checks: ScopeCheck[];
  requirements: ScopeRequirement[];
  delivered: string[];
  partial: string[];
  // At `stage`, the requirements its stage implements.
  stageImplements: string[];
  // The scope's modules: at `stage` its stage's; at a deployment gate those
  // present at the revision, null when that fact is unread (D3 §4.1).
  modules: ScopeModule[] | null;
}

export interface Missing {
  criteria: string[];
  uncertain: string[];
  kinds: string[];
  areas: string[];
  unread: string[];
}

export interface Signoff {
  role: string;
  scope: string;
  module?: string;
}

export interface ScopeResult {
  tier: Tier;
  modules: ScopeModule[];
  obligations: string[];
  categories: string[];
  required: ScopeCheck[];
  missing: Missing;
  signoffs: Signoff[];
}

const rank = (t: string | null | undefined): number => (t ? (TIER_RANK[t] ?? 0) : 0);

// The highest of the project's tier and the modules' overrides: an override
// never lowers (D3 §4.1). Also the cadence's tier (B04; Q10).
export function cadenceTier(projectTier: string, modules: readonly Pick<ScopeModule, 'tier_override'>[]): Tier {
  let best = rank(projectTier) || 1;
  for (const m of modules) best = Math.max(best, rank(m.tier_override));
  return (['T1', 'T2', 'T3'] as const)[best - 1]!;
}

// Whether any module could raise a scope above the project's tier: when none
// can, an unread presence fact cannot change the tier.
export const mayRaise = (projectTier: string, modules: readonly Pick<ScopeModule, 'tier_override'>[]): boolean => modules.some((m) => rank(m.tier_override) > rank(projectTier));

const isFloor = (c: ScopeCheck): boolean => c.kind === 'sensitivity_floor';
const ofTier = (c: ScopeCheck, tier: Tier): boolean => c.tier_floor === null || rank(c.tier_floor) <= rank(tier);

export function computeScope(inputs: ScopeInputs): ScopeResult {
  const modules = inputs.modules ?? [];
  const tier = cadenceTier(inputs.projectTier, modules);
  const reached = new Set([...inputs.delivered, ...inputs.partial]);
  // Obligations (as built): at `stage` the delivered requirements its stage
  // implements; at a deployment gate every delivered requirement.
  const obligations = inputs.kind === 'stage' ? inputs.delivered.filter((r) => inputs.stageImplements.includes(r)) : [...inputs.delivered];
  // Sensitivity categories (D3 §4.2; B04): the scope modules' areas and those
  // of every requirement the scope touches, delivered or partially delivered.
  const touched = inputs.kind === 'stage' ? inputs.stageImplements.filter((r) => reached.has(r)) : [...reached];
  const categories = new Set<string>();
  for (const m of modules) for (const a of m.sensitive_areas) categories.add(a);
  for (const r of inputs.requirements) if (touched.includes(r.id)) for (const a of r.sensitive_areas) categories.add(a);

  // The required set (D3 §4.2): the version's required checks listing the
  // gate kind; (a) and (b) at the scope's tier, (c) whatever the tiers.
  const listing = inputs.checks.filter((c) => c.required && c.gate_kinds.includes(inputs.kind));
  const required = listing.filter((c) => {
    if (isFloor(c)) return c.sensitive_areas.some((a) => categories.has(a));
    if (!ofTier(c, tier)) return false;
    return c.requirements.length === 0 || c.requirements.some((r) => obligations.includes(r));
  });

  // What is missing (D3 §4.3). Only a required acceptance-origin check
  // covers a criterion or supplies a kind; a developer check counts toward
  // neither.
  const counting = required.filter((c) => c.origin === 'acceptance');
  const missing: Missing = { criteria: [], uncertain: [], kinds: [], areas: [], unread: [] };
  for (const id of obligations) {
    const r = inputs.requirements.find((x) => x.id === id);
    if (!r || r.criteria === null || r.criteria.length === 0) {
      missing.uncertain.push(id);
      continue;
    }
    for (const k of r.criteria) if (!counting.some((c) => c.criteria.includes(k))) missing.criteria.push(k);
  }
  for (const kind of KIND_INVENTORY[tier]) if (!counting.some((c) => c.kind === kind)) missing.kinds.push(`kind:${kind}`);
  for (const a of [...categories].sort()) if (!required.some((c) => isFloor(c) && c.sensitive_areas.includes(a))) missing.areas.push(`area:${a}`);
  if (inputs.modules === null) missing.unread.push(MODULE_PRESENCE);

  return { tier, modules, obligations, categories: [...categories].sort(), required, missing, signoffs: signoffsOf(tier, modules) };
}

// The sign-offs a scope's tier requires (D1 §9; E36 item 3; D3 §4.1): T2 a
// Reviewer's at candidate scope; T3 also one per scope module, by name
// (SEAM.md §222), and a security review.
export function signoffsOf(tier: Tier, modules: readonly Pick<ScopeModule, 'name'>[]): Signoff[] {
  const out: Signoff[] = [];
  if (rank(tier) >= 2) out.push({ role: 'reviewer', scope: 'candidate' });
  if (rank(tier) >= 3) {
    for (const name of [...new Set(modules.map((m) => m.name))].sort()) out.push({ role: 'reviewer', scope: 'module', module: name });
    out.push({ role: 'reviewer', scope: 'security' });
  }
  return out;
}

// The subjects of ACCEPTANCE_SCOPE_INCOMPLETE for what is missing (SEAM.md
// §221), discovery error paths given separately.
export function missingSubjects(m: Missing): string[] {
  return [...m.criteria, ...m.uncertain, ...m.kinds, ...m.areas, ...m.unread];
}

export const sameSignoff = (a: Signoff, b: Signoff): boolean => a.role === b.role && a.scope === b.scope && (a.module ?? null) === (b.module ?? null);

// Whether a tracked path lies in a module (SEAM.md §224): it is one of the
// module's paths, or under one taken as a directory.
export function inModule(path: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    if (p.length === 0) return false;
    if (path === p) return true;
    const dir = p.endsWith('/') ? p : `${p}/`;
    return path.startsWith(dir);
  });
}

// The modules with at least one tracked path at a revision (D3 §4.1).
export function presentModules(paths: Iterable<string>, modules: readonly { id: string; paths: string[] }[]): string[] {
  const list = [...paths];
  return modules.filter((m) => list.some((p) => inModule(p, m.paths))).map((m) => m.id);
}
