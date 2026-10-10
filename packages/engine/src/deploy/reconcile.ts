// What a reconcile read establishes (D4 §2.4; E111; D4-A03): the engine's
// mapping of what was read of the target, never the adapter's label and
// never a receipt. The answer is decided from the complete inventory read
// now (every resource of the environment: units, domain cgroups, link
// sockets, runtime directories) and the engine's own records (the frozen
// intents, the launch it granted, the instances recorded). `unknown` and
// then `conflicting` take precedence over `applied`, `absent` and
// `partial`, so every state has exactly one answer, and no success rests on
// a failed query's empty result or on a value that was not read.

import type { AdapterReadFailure, Instance, InventoryEntry, Reconciliation, ReconcileOutcome } from './adapter.js';

export interface ReconcileInputs {
  kind: 'deploy' | 'teardown';
  // The environment's unit-name prefix: a resource of generation n belongs
  // to the unit `<prefix>g<n>.service`.
  prefix: string;
  digest: string | null;
  // The attempt's frozen intent: g's units, the prior units it replaces
  // (with the instance each ran when it was frozen), and for a teardown the
  // units it stops.
  create_units: string[];
  prior: { unit: string; instance: Instance | null }[];
  stop_units: string[];
  // Every unit a frozen intent of the environment named.
  recorded: string[];
  // The cgroup the store recorded for each unit's domain, where it recorded
  // one (the launcher's placement): a unit the target reports in another
  // cgroup is not the one the engine created (D4 §4.6; SEAM.md §278).
  recorded_cgroups?: Record<string, string | null>;
  // Whether a launch for g was ever granted (the init's instance recorded at
  // the grant), and the application instance recorded at its launch.
  launch_granted: boolean;
  app_instance: Instance | null;
  // The init's report and the host read disagreed at `started` (§3.4 step
  // 3): nothing was bound, and the binding is `conflicting`.
  binding_conflict?: boolean;
}

export interface Judged {
  outcome: ReconcileOutcome;
  // What was read, as recorded on the attempt: a summary, never the
  // adapter's output whole.
  read: Record<string, unknown>;
}

const sameInstance = (a: unknown, b: Instance | null): boolean =>
  typeof a === 'object' && a !== null && b !== null && (a as Instance).pid === b.pid && (a as Instance).start_time === b.start_time;

// The unit a resource of the inventory belongs to: a unit is its own; a
// cgroup, socket or directory is its generation's unit's. null: no unit any
// frozen intent of the environment names.
function ownerOf(e: InventoryEntry, units: string[], prefix: string, cgroups: Record<string, string | null> = {}): string | null {
  if (e.kind === 'unit') return units.includes(e.resource) && !otherCgroup(e, cgroups) ? e.resource : null;
  const name = Number.isInteger(e.generation) ? `${prefix}g${e.generation as number}.service` : null;
  return name !== null && units.includes(name) ? name : null;
}

// A unit read in another cgroup than the one recorded for it, both known (the
// driver's reading of slice 26: ownership is the name in an intent and the
// recorded cgroup equal to the read one whenever both exist).
function otherCgroup(e: InventoryEntry, cgroups: Record<string, string | null>): boolean {
  const recorded = cgroups[e.resource] ?? null;
  return typeof e.cgroup === 'string' && e.cgroup !== 'unread' && e.cgroup !== '' && recorded !== null && e.cgroup !== recorded;
}

// The units of an inventory whose ownership the store cannot account for
// (D4 §§4.1, 9.2; SEAM.md §278): a unit carrying the environment's prefix
// that no frozen intent of the environment names, or that the target
// reports in another cgroup than the one recorded. Listed, never adopted or
// stopped. Pure, for the precondition and the developer tests.
export function unaccountedUnits(inventory: InventoryEntry[], recorded: string[], cgroups: Record<string, string | null>): { unit: string; why: 'no_intent' | 'other_cgroup'; cgroup: string | null; recorded_cgroup: string | null }[] {
  const out: { unit: string; why: 'no_intent' | 'other_cgroup'; cgroup: string | null; recorded_cgroup: string | null }[] = [];
  for (const e of inventory) {
    if (typeof e !== 'object' || e === null || e.kind !== 'unit' || typeof e.resource !== 'string') continue;
    const cgroup = typeof e.cgroup === 'string' && e.cgroup !== 'unread' ? e.cgroup : null;
    if (!recorded.includes(e.resource)) out.push({ unit: e.resource, why: 'no_intent', cgroup, recorded_cgroup: null });
    else if (otherCgroup(e, cgroups)) out.push({ unit: e.resource, why: 'other_cgroup', cgroup, recorded_cgroup: cgroups[e.resource] ?? null });
  }
  return out;
}

// A value that was not read: `unread`, or absent from the entry altogether
// (missing is unknown, never false or inactive).
const unread = (v: unknown): boolean => v === undefined || v === null || v === 'unread';

export function judgeReconcile(result: { ok: Reconciliation } | { failure: AdapterReadFailure }, x: ReconcileInputs): Judged {
  if ('failure' in result) return { outcome: 'unknown', read: { failure: result.failure } };
  const r = result.ok as Partial<Reconciliation> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.inventory)) return { outcome: 'unknown', read: { failure: 'invalid_response' } };
  const inventory = r.inventory.filter((e): e is InventoryEntry => typeof e === 'object' && e !== null);
  const read = {
    complete: r.complete === true,
    inventory: inventory.map((e) => ({
      resource: e.resource ?? null,
      kind: e.kind ?? null,
      state: e.state ?? null,
      pending_job: e.pendingJob ?? null,
      generation: e.generation ?? null,
      cgroup: e.cgroup ?? null,
      tree: e.tree ?? null,
      instance: e.instance ?? null,
    })),
  };
  const answer = (outcome: ReconcileOutcome): Judged => ({ outcome, read });
  // Unknown: an incomplete inventory; any resource, of any kind, whose
  // name, kind, state or pending job was not read; a manager job still
  // pending (no quiescence).
  if (r.complete !== true || inventory.length !== r.inventory.length) return answer('unknown');
  if (inventory.some((e) => typeof e.resource !== 'string' || !['unit', 'cgroup', 'socket', 'directory'].includes(e.kind) || unread(e.state) || unread(e.pendingJob) || e.pendingJob === true)) return answer('unknown');
  // A cgroup, socket or directory whose generation was not read belongs to
  // no unit the engine can name: unknown.
  if (inventory.some((e) => e.kind !== 'unit' && unread(e.generation))) return answer('unknown');

  const units = inventory.filter((e) => e.kind === 'unit');
  const known = [...new Set([...x.recorded, ...x.create_units, ...x.prior.map((p) => p.unit), ...x.stop_units])];
  // Every resource read, by the unit it belongs to.
  const owner = new Map(inventory.map((e) => [e, ownerOf(e, known, x.prefix, x.recorded_cgroups ?? {})] as const));

  if (x.kind === 'teardown') {
    // Conflicting: a resource of the environment whose ownership is
    // unexpected (a prefixed unit no intent names, in any state, or a
    // resource of one); unread state was answered above.
    if (inventory.some((e) => owner.get(e) === null || !x.stop_units.includes(owner.get(e)!))) return answer('conflicting');
    if (inventory.length === 0) return answer('applied');
    // The entire frozen pre-state unchanged: every unit it stops still there
    // and active.
    if (x.stop_units.every((u) => units.some((e) => e.resource === u && e.state === 'active'))) return answer('absent');
    // Owned resources that survive: a unit, a populated cgroup, a socket or
    // a directory the teardown covers.
    return answer('partial');
  }

  // Deploy of generation g.
  const g = new Set(x.create_units);
  const priors = new Set(x.prior.map((p) => p.unit));
  // Conflicting: a resource of a unit no frozen intent of the environment
  // names, in any state; an active unit of a generation this attempt's
  // intent does not name; a prior unit running another instance than the
  // one frozen.
  if (inventory.some((e) => owner.get(e) === null)) return answer('conflicting');
  if (units.some((e) => e.state === 'active' && !g.has(e.resource) && !priors.has(e.resource))) return answer('conflicting');
  for (const p of x.prior) {
    const e = units.find((u) => u.resource === p.unit && u.state === 'active');
    if (e && p.instance !== null && (unread(e.instance) || !sameInstance(e.instance, p.instance))) return unread(e.instance) ? answer('unknown') : answer('conflicting');
  }
  const gUnit = units.find((e) => g.has(e.resource));
  const gResources = inventory.filter((e) => g.has(owner.get(e)!));
  // What still runs or holds: an active unit, or a cgroup, socket or
  // directory that is there at all (an inactive or failed unit of a recorded
  // generation runs nothing).
  const live = (e: InventoryEntry) => e.kind !== 'unit' || e.state === 'active';
  const priorResources = inventory.filter((e) => priors.has(owner.get(e)!) && live(e));
  const others = inventory.filter((e) => !g.has(owner.get(e)!) && !priors.has(owner.get(e)!) && live(e));

  if (gUnit && gUnit.state === 'active') {
    if (units.some((e) => priors.has(e.resource) && e.state === 'active')) return answer('conflicting');
    // The binding of g's invocation to the application recorded at launch.
    if (x.binding_conflict === true) return answer('conflicting');
    if (x.app_instance === null || unread(gUnit.tree) || unread(gUnit.instance)) return answer('unknown');
    if (gUnit.tree !== x.digest || !sameInstance(gUnit.instance, x.app_instance)) return answer('conflicting');
    // Applied: the termination of every prior established (nothing of it
    // left) and nothing else of the environment there.
    if (priorResources.length === 0 && others.length === 0) return answer('applied');
    return answer('partial');
  }
  // Absent: g's unit and domain absent in every state; no launch for g ever
  // granted; the prior exactly as frozen; nothing else of the environment.
  const priorsAsFrozen = x.prior.every((p) => units.some((e) => e.resource === p.unit && e.state === 'active'));
  if (gResources.length === 0 && !x.launch_granted && priorsAsFrozen && others.length === 0) return answer('absent');
  return answer('partial');
}
