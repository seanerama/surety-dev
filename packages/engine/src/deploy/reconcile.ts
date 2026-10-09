// What a reconcile read establishes (D4 §2.4; E111). The answer is decided
// from the target's state as read now and the engine's own records, never
// from an adapter's memory or a receipt. `unknown` and then `conflicting`
// take precedence over `applied`, `absent` and `partial`, so every state has
// exactly one answer, and no success rests on a failed query's empty result.

import type { AdapterReadFailure, IdentityRead, Instance, Reconciliation, ReconcileOutcome } from './adapter.js';

const OUTCOMES: readonly ReconcileOutcome[] = ['applied', 'absent', 'partial', 'conflicting', 'unknown'];

export interface Judged {
  outcome: ReconcileOutcome;
  // What was read, as recorded on the attempt.
  read: Record<string, unknown>;
  // The application instance read for the attempt's unit, where one was.
  instance: Instance | null;
}

export function judgeReconcile(
  result: { ok: Reconciliation } | { failure: AdapterReadFailure },
  args: { kind: 'deploy' | 'teardown'; targets: string[]; recorded: string[] },
): Judged {
  if ('failure' in result) return { outcome: 'unknown', read: { failure: result.failure }, instance: null };
  const r = result.ok;
  const read: Record<string, unknown> = { complete: r?.complete ?? null, inventory: r?.inventory ?? null, adapter_outcome: r?.outcome ?? null };
  if (!r || typeof r !== 'object' || !Array.isArray(r.inventory) || !Array.isArray(r.reads) || !Array.isArray(r.identity)) return { outcome: 'unknown', read: { ...read, invalid: true }, instance: null };
  // An incomplete inventory, a resource left unread, or a manager job still
  // pending (no quiescence): nothing can be established.
  if (r.complete !== true) return { outcome: 'unknown', read, instance: null };
  if (r.inventory.some((e) => e.state === 'unread' || e.pendingJob === 'unread' || e.pendingJob === true)) return { outcome: 'unknown', read, instance: null };
  // A resource outside the permitted states: an active unit of the
  // environment no frozen intent names.
  if (r.inventory.some((e) => e.kind === 'unit' && !e.recorded && !args.recorded.includes(e.resource) && e.state === 'active')) return { outcome: 'conflicting', read, instance: null };
  if (!OUTCOMES.includes(r.outcome)) return { outcome: 'unknown', read, instance: null };
  let instance: Instance | null = null;
  if (args.kind === 'deploy' && r.outcome === 'applied') {
    // Applied needs, per target, an identity read matching the frozen
    // digest with an application instance read.
    for (const t of args.targets) {
      const x: IdentityRead | undefined = r.identity.find((i) => i.target === t);
      if (!x || x.match === 'unread' || x.instance === 'unread') return { outcome: 'unknown', read, instance: null };
      if (x.match !== 'match') return { outcome: 'conflicting', read, instance: null };
      instance ??= x.instance;
    }
  }
  return { outcome: r.outcome, read, instance };
}
