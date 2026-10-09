// What a reconcile read establishes (D4 §2.4; E111): the engine's mapping of
// what was read of the target, never the adapter's label and never a
// receipt. The answer is decided from the inventory read now and the
// engine's own records (the frozen intents, the launch it granted, the
// application instance recorded at the launch). `unknown` and then
// `conflicting` take precedence over `applied`, `absent` and `partial`, so
// every state has exactly one answer, and no success rests on a failed
// query's empty result.

import type { AdapterReadFailure, Instance, InventoryEntry, Reconciliation, ReconcileOutcome } from './adapter.js';

export interface ReconcileInputs {
  kind: 'deploy' | 'teardown';
  digest: string | null;
  // The attempt's frozen intent: g's units, the prior units it replaces,
  // and for a teardown the units it stops.
  create_units: string[];
  prior: string[];
  stop_units: string[];
  // Every unit a frozen intent of the environment named.
  recorded: string[];
  // The launch the engine granted, and the application it recorded then.
  launch_state: string | null;
  app_instance: Instance | null;
}

export interface Judged {
  outcome: ReconcileOutcome;
  // What was read, as recorded on the attempt: a summary, never the
  // adapter's output whole.
  read: Record<string, unknown>;
}

const isUnit = (e: InventoryEntry) => e.kind === 'unit';
const unread = (v: unknown) => v === 'unread' || v === undefined;
const sameInstance = (a: Instance | 'unread' | null | undefined, b: Instance | null): boolean =>
  a !== 'unread' && a !== null && a !== undefined && b !== null && a.pid === b.pid && a.start_time === b.start_time;

export function judgeReconcile(result: { ok: Reconciliation } | { failure: AdapterReadFailure }, x: ReconcileInputs): Judged {
  if ('failure' in result) return { outcome: 'unknown', read: { failure: result.failure } };
  const r = result.ok as Partial<Reconciliation> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.inventory)) return { outcome: 'unknown', read: { failure: 'invalid_response' } };
  const units = r.inventory.filter(isUnit);
  const read = {
    complete: r.complete === true,
    units: units.map((u) => ({ name: u.resource, state: u.state, pending_job: u.pendingJob, generation: u.generation ?? null, tree: u.tree ?? null, instance: u.instance ?? null })),
  };
  const answer = (outcome: ReconcileOutcome): Judged => ({ outcome, read });
  // Unknown: an incomplete inventory, a state left unread, or a manager job
  // still pending (no quiescence).
  if (r.complete !== true) return answer('unknown');
  if (units.some((u) => u.state === 'unread' || u.pendingJob === 'unread' || u.pendingJob === true)) return answer('unknown');
  const active = units.filter((u) => u.state === 'active');
  if (x.kind === 'teardown') {
    // A unit of the environment no intent names, still active: ownership
    // unexpected, conflicting.
    if (active.some((u) => !x.stop_units.includes(u.resource))) return answer('conflicting');
    const left = units.filter((u) => x.stop_units.includes(u.resource));
    if (left.length === 0) return answer('applied');
    if (left.length === x.stop_units.length && left.every((u) => u.state === 'active')) return answer('absent');
    return answer('partial');
  }
  // Conflicting: an active unit no frozen intent of the environment names,
  // or one of a generation this attempt's intent does not name.
  if (active.some((u) => !x.recorded.includes(u.resource) && !x.create_units.includes(u.resource))) return answer('conflicting');
  if (active.some((u) => !x.create_units.includes(u.resource) && !x.prior.includes(u.resource))) return answer('conflicting');
  const g = units.find((u) => x.create_units.includes(u.resource));
  const priorsActive = active.filter((u) => x.prior.includes(u.resource));
  if (g && g.state === 'active') {
    if (priorsActive.length > 0) return answer('conflicting');
    // The binding of g's invocation to the application recorded at launch.
    if (x.app_instance === null) return answer('unknown');
    if (unread(g.tree) || unread(g.instance)) return answer('unknown');
    if (g.tree !== x.digest || !sameInstance(g.instance, x.app_instance)) return answer('conflicting');
    return answer('applied');
  }
  if (!g) {
    const priorsAsFrozen = x.prior.every((p) => priorsActive.some((u) => u.resource === p));
    if (x.launch_state !== 'authorized' && priorsAsFrozen) return answer('absent');
  }
  return answer('partial');
}
