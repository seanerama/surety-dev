// The engine side of the test seam (build spec §8, SEAM.md §7). Production
// code reaches harness behaviour only through this module. Outside harness
// mode every call here is a no-op and nothing can be armed.
//
// The module runs in two threads. The main thread owns the barrier registry
// that GET /v1/harness/barriers reports and releases; the store worker reaches
// barriers and fault points. They share one SharedArrayBuffer so a paused
// worker can block synchronously inside its transaction until released.

import { Refusal } from '../refusal.js';

export const BARRIER_NAMES = ['migration.before_commit'] as const;
export type BarrierAction = 'pause' | 'kill';
export type BarrierState = 'armed' | 'waiting' | 'released' | 'fired';

export interface BarrierSpec {
  name: string;
  action: BarrierAction;
  slot: number;
}

export interface SeamInit {
  harness: boolean;
  barriers: BarrierSpec[];
  shared: SharedArrayBuffer | null;
}

export type Fault = { point: 'before_event'; event_type: string } | { point: 'audit_write' };

export class InjectedFault extends Error {
  constructor(what: string) {
    super(`injected fault: ${what}`);
  }
}

let init: SeamInit = { harness: false, barriers: [], shared: null };
let notify: ((name: string, state: BarrierState) => void) | null = null;
const faults: Fault[] = [];

export const isHarness = (): boolean => init.harness;

// ---- startup flags -----------------------------------------------------------

// Parse `--harness-barrier name=action` values. Returns null for an unknown
// barrier or action, which the command line treats as a usage error.
export function parseBarrierFlag(value: string, slot: number): BarrierSpec | null {
  const at = value.lastIndexOf('=');
  if (at <= 0) return null;
  const name = value.slice(0, at);
  const action = value.slice(at + 1);
  if (!(BARRIER_NAMES as readonly string[]).includes(name)) return null;
  if (action !== 'pause' && action !== 'kill') return null;
  return { name, action, slot };
}

// ---- main thread: the barrier registry --------------------------------------

const registry = new Map<string, { spec: BarrierSpec; state: BarrierState }>();

export function configureMain(harness: boolean, barriers: BarrierSpec[]): SeamInit {
  const shared = harness && barriers.length > 0 ? new SharedArrayBuffer(4 * barriers.length) : null;
  init = { harness, barriers: harness ? barriers : [], shared };
  for (const spec of init.barriers) registry.set(spec.name, { spec, state: 'armed' });
  return init;
}

// The worker reports a barrier it reached.
export function barrierReached(name: string, state: BarrierState): void {
  const entry = registry.get(name);
  if (entry && entry.state !== 'released') entry.state = state;
}

export function listBarriers(): { name: string; action: BarrierAction; state: BarrierState }[] {
  return [...registry.values()].map(({ spec, state }) => ({ name: spec.name, action: spec.action, state }));
}

export function releaseBarrier(name: string): void {
  const entry = registry.get(name);
  if (!entry) throw new Refusal(404, 'not_found', `No barrier named "${name}" is armed.`, 'Arm it at startup with --harness-barrier.', { barrier: name });
  if (entry.spec.action !== 'pause' || entry.state !== 'waiting') {
    throw new Refusal(409, 'illegal_transition', `Barrier "${name}" is ${entry.state}, not a waiting pause.`, 'Release a pause barrier once the engine is waiting at it.', {
      barrier: name,
      state: entry.state,
    });
  }
  entry.state = 'released';
  const cells = new Int32Array(init.shared!);
  Atomics.store(cells, entry.spec.slot, 1);
  Atomics.notify(cells, entry.spec.slot);
}

// ---- store worker: barriers and faults --------------------------------------

export function configureWorker(given: SeamInit, report: (name: string, state: BarrierState) => void): void {
  init = given;
  notify = report;
}

// A named point the engine pauses at until released, or kills itself at.
export function barrier(name: string): void {
  if (!init.harness) return;
  const spec = init.barriers.find((b) => b.name === name);
  if (!spec) return;
  if (spec.action === 'kill') {
    notify?.(name, 'fired');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  notify?.(name, 'waiting');
  const cells = new Int32Array(init.shared!);
  while (Atomics.load(cells, spec.slot) === 0) Atomics.wait(cells, spec.slot, 0);
}

export function armFault(fault: unknown): Fault {
  if (!init.harness) throw new Refusal(404, 'not_found', 'Fault injection exists only in harness mode.', 'Start the engine with --harness.');
  const f = fault as Partial<Record<string, unknown>> | null;
  let parsed: Fault | null = null;
  if (f && f.point === 'before_event' && typeof f.event_type === 'string' && f.event_type.length > 0 && Object.keys(f).length === 2) {
    parsed = { point: 'before_event', event_type: f.event_type };
  } else if (f && f.point === 'audit_write' && Object.keys(f).length === 1) {
    parsed = { point: 'audit_write' };
  }
  if (!parsed) {
    throw new Refusal(400, 'invalid_value', 'Unknown fault.', 'Send {"point":"before_event","event_type":...} or {"point":"audit_write"}.', { field: 'point' });
  }
  faults.push(parsed);
  return parsed;
}

// Called by the event writer just before it appends an event: fails the
// enclosing transaction once if a matching fault is armed.
export function beforeEventWrite(eventType: string): void {
  if (!init.harness || faults.length === 0) return;
  const i = faults.findIndex(
    (f) => (f.point === 'before_event' && f.event_type === eventType) || (f.point === 'audit_write' && eventType === 'api.act'),
  );
  if (i < 0) return;
  const [fault] = faults.splice(i, 1);
  throw new InjectedFault(fault!.point === 'audit_write' ? 'audit write' : `before event ${eventType}`);
}
