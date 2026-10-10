// What a read of an environment establishes beside an operation's own
// outcome (D4 §§6.2, 6.3; J6; AR N01; E121 CD2): the out-of-band changes it
// found, and the observed condition by §6.2's precedence. Pure: the store's
// half (store/transitions/observe.ts) gives it what the engine recorded and
// what was read, and records what it returns. The developer tests call it.
//
// A change is one of §6.3's: the environment's current-generation unit
// stopped (not active, or gone) or restarted (another invocation than the one
// recorded at its placement); a unit of the environment's prefix whose
// ownership the store cannot account for; an identity read that differs.
// Never from a value that was not read, never from an absence an incomplete
// read implies, and never for the units of the operation in flight, whose
// states between its prior and its next are the engine's own (D4 §4.5; the
// driver's ruling): only their identity, which no operation changes, is
// compared.

import type { IdentityRead, Instance, InventoryEntry, TargetStatus } from './adapter.js';
import { unaccountedUnits } from './reconcile.js';

export type ChangeKind = 'stopped' | 'restarted' | 'unexpected_unit' | 'identity_differs';

export interface Change {
  change: ChangeKind;
  resource: string;
  expected: Record<string, unknown>;
  found: Record<string, unknown>;
}

// What the environment is expected to run now: the current generation's
// unit, as the engine recorded it at its placement and launch.
export interface ExpectedService {
  target: string;
  unit: string;
  generation: number;
  invocation: string | null;
  instance: Instance | null;
  digest: string | null;
  // The init reported the application's own exit, with an exit code and no
  // termination signal it was not ordered to receive (D4 §9.2's legal
  // ending; the driver's ruling on the slice-27 design, answer 2).
  naturalExit: boolean;
}

const isInstance = (v: unknown): v is Instance =>
  typeof v === 'object' && v !== null && Number.isInteger((v as Instance).pid) && Number.isInteger((v as Instance).start_time);
const sameInstance = (a: unknown, b: Instance | null): boolean => isInstance(a) && b !== null && a.pid === b.pid && a.start_time === b.start_time;
const readString = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v !== 'unread' ? v : null);

// The changes an inventory read shows. `complete`: the read was complete, so
// an absence in it is one; `permitted`: the units of an operation in flight.
export function changesFromInventory(args: {
  inventory: InventoryEntry[];
  complete: boolean;
  targets?: TargetStatus[];
  expected: ExpectedService | null;
  permitted: string[];
  recorded: string[];
  cgroups: Record<string, string | null>;
}): Change[] {
  const out: Change[] = [];
  const units = args.inventory.filter((e) => typeof e === 'object' && e !== null && e.kind === 'unit' && typeof e.resource === 'string');
  for (const u of unaccountedUnits(units, args.recorded, args.cgroups)) {
    const e = units.find((x) => x.resource === u.unit)!;
    out.push({
      change: 'unexpected_unit',
      resource: u.unit,
      expected: u.why === 'no_intent' ? { unit: u.unit, owned_by: null, why: 'no attempt intent of the environment names it' } : { unit: u.unit, cgroup: u.recorded_cgroup, why: 'the cgroup recorded for it' },
      found: { unit: u.unit, state: e.state ?? 'unread', invocation_id: readString(e.invocation_id), cgroup: u.cgroup, why: u.why },
    });
  }
  const x = args.expected;
  if (x === null || args.permitted.includes(x.unit)) return out;
  const e = units.find((u) => u.resource === x.unit);
  if (e && e.state === 'unread') return out;
  const invocation = e ? readString(e.invocation_id) : null;
  const target = args.targets?.find((t) => t.unit === x.unit);
  const instance = target && (isInstance(target.instance) || target.instance === null) ? target.instance : 'unread';
  if (e && invocation !== null && x.invocation !== null && invocation !== x.invocation) {
    out.push({
      change: 'restarted',
      resource: x.unit,
      expected: { unit: x.unit, invocation_id: x.invocation, instance: x.instance },
      found: { unit: x.unit, state: e.state, invocation_id: invocation, instance },
    });
    return out;
  }
  const notRunning = e === undefined ? args.complete : e.state === 'inactive' || e.state === 'failed';
  if (notRunning && !x.naturalExit) {
    out.push({ change: 'stopped', resource: x.unit, expected: { unit: x.unit, state: 'active', invocation_id: x.invocation }, found: { unit: x.unit, state: e?.state ?? 'not-found', exit_reported: false } });
  }
  return out;
}

// The fields of an identity read that name a change of what runs rather
// than of which instance runs it (D4 §3.4).
const IDENTITY_FIELDS = ['tree', 'exe', 'argv', 'mounts'];
// Those that name another instance or invocation of the unit (a restart).
const INSTANCE_FIELDS = ['invocation_id', 'start_time', 'init', 'parent', 'cgroup', 'instance'];

// The changes identity reads show. A read that differs on the bytes is an
// identity that differs, whoever made the read; one that differs on the
// instance is a restart, unless the unit is the operation in flight's.
export function changesFromIdentity(args: { reads: IdentityRead[]; expected: ExpectedService | null; permitted: string[] }): Change[] {
  const x = args.expected;
  if (x === null) return [];
  const out: Change[] = [];
  for (const r of args.reads) {
    if (!r || r.match !== 'differs') continue;
    const field = typeof r.detail?.field === 'string' ? r.detail.field : null;
    const digest = readString(r.read);
    if ((field !== null && IDENTITY_FIELDS.includes(field)) || (field === null && digest !== null && x.digest !== null && digest !== x.digest)) {
      out.push({
        change: 'identity_differs',
        resource: x.unit,
        expected: { unit: x.unit, digest: x.digest },
        found: { unit: x.unit, digest: digest ?? 'unread', field: field ?? 'tree', at: r.at },
      });
      continue;
    }
    if (args.permitted.includes(x.unit)) continue;
    const otherInstance = field === null ? isInstance(r.instance) && !sameInstance(r.instance, x.instance) : INSTANCE_FIELDS.includes(field);
    if (otherInstance) {
      out.push({
        change: 'restarted',
        resource: x.unit,
        expected: { unit: x.unit, invocation_id: x.invocation, instance: x.instance },
        found: { unit: x.unit, instance: isInstance(r.instance) ? r.instance : 'unread', field: field ?? 'instance', at: r.at },
      });
    }
  }
  return out;
}

// Whether a change read again is the one already recorded (the driver's
// ruling: deduplicated by environment, resource, change and what was found).
// What one read cannot see (an identity read has no invocation) is not a
// difference.
export function sameChange(a: { change: string; resource: string; found: Record<string, unknown> | null }, b: Change): boolean {
  if (a.change !== b.change || a.resource !== b.resource) return false;
  const f = a.found ?? {};
  const g = b.found;
  switch (b.change) {
    case 'identity_differs':
      return f.digest === g.digest && (f.field ?? 'tree') === (g.field ?? 'tree');
    case 'restarted':
    case 'unexpected_unit': {
      const i = readString(f.invocation_id);
      const j = readString(g.invocation_id);
      return i === null || j === null || i === j;
    }
    default:
      return true;
  }
}

export type Condition = 'healthy' | 'degraded' | 'down' | 'unknown';

// D4 §6.2's precedence, for the one target M4 allows (§10 X2), with CD2:
// 1. a required state unread → unknown;
// 2. no application of the environment running and no unexpected active
//    unit → down (drift shown beside it);
// 3. an unexpected active unit, or drift open or acknowledged → degraded;
// 4. the expected instance running as recorded, at the expected generation,
//    with a matching identity where read → healthy, unless its supervision
//    is unknown (CD2: degraded, `supervision_unknown`);
// 5. anything else → degraded.
export function judgeCondition(args: {
  read: { complete: boolean; inventory: InventoryEntry[]; targets: TargetStatus[] } | null;
  identityUnread: boolean;
  expected: ExpectedService | null;
  supervision: 'attached' | 'unknown' | null;
  newestIdentity: { match: string } | null;
  unexpectedActive: boolean;
  drift: number;
}): { condition: Condition; detail: Record<string, unknown> | null } {
  const r = args.read;
  if (r === null) return { condition: 'unknown', detail: { code: 'read_failed' } };
  const entries = r.inventory.filter((e) => typeof e === 'object' && e !== null);
  if (r.complete !== true || entries.some((e) => e.state === 'unread' || e.state === undefined || e.pendingJob === 'unread')) return { condition: 'unknown', detail: { code: 'state_unread' } };
  const x = args.expected;
  const t = x ? r.targets.find((s) => s.unit === x.unit) : undefined;
  if (t && (t.active === 'unread' || (t.active === true && t.instance === 'unread'))) return { condition: 'unknown', detail: { code: 'state_unread', unit: x!.unit } };
  if (args.identityUnread) return { condition: 'unknown', detail: { code: 'identity_unread' } };
  const running = r.targets.some((s) => s.active === true && isInstance(s.instance));
  if (!running && !args.unexpectedActive) return { condition: 'down', detail: args.drift > 0 ? { code: 'out_of_band' } : null };
  if (args.unexpectedActive || args.drift > 0) return { condition: 'degraded', detail: { code: args.drift > 0 ? 'out_of_band' : 'unexpected_unit' } };
  const e = x ? entries.find((u) => u.kind === 'unit' && u.resource === x.unit) : undefined;
  const asRecorded =
    x !== null &&
    t !== undefined &&
    t.active === true &&
    sameInstance(t.instance, x.instance) &&
    (t.generation === 'unread' || t.generation === null || t.generation === x.generation) &&
    (x.invocation === null || readString(e?.invocation_id) === null || readString(e?.invocation_id) === x.invocation) &&
    (args.newestIdentity === null || args.newestIdentity.match === 'match');
  if (asRecorded) return args.supervision === 'attached' ? { condition: 'healthy', detail: null } : { condition: 'degraded', detail: { code: 'supervision_unknown' } };
  return { condition: 'degraded', detail: { code: 'not_as_expected' } };
}
