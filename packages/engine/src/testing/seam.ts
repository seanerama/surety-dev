// The engine side of the test seam (build spec §8, SEAM.md §7). Every
// harness-only behaviour lives in this folder, and production code reaches it
// only by importing this module and calling its functions at the points where
// the harness has a hook: the command line hands over the --harness flags; the
// API server offers a request no production route matched and its engine
// description; the store worker offers an operation it does not know and a
// message channel; the migration runner and the event writer reach their
// barrier and fault points. Outside harness mode every function here does
// nothing, or refuses, by its own check.
//
// The module runs in two threads. The main thread owns the barrier registry
// that GET /v1/harness/barriers reports and releases; the store worker reaches
// barriers and fault points. They share one SharedArrayBuffer so a paused
// worker can block synchronously inside its transaction until released.

import type { Database } from 'better-sqlite3';

import { Refusal } from '../refusal.js';
import type { StoreClient } from '../store/client.js';
import type { Actor } from '../store/transitions/tx.js';
import { installFixtureProject } from './fixtures.js';

const BARRIER_NAMES = ['migration.before_commit'] as const;
type BarrierAction = 'pause' | 'kill';
type BarrierState = 'armed' | 'waiting' | 'released' | 'fired';

interface BarrierSpec {
  name: string;
  action: BarrierAction;
  slot: number;
}

// What the store worker needs to know of the seam, passed in its workerData.
export interface SeamInit {
  harness: boolean;
  barriers: BarrierSpec[];
  shared: SharedArrayBuffer | null;
}

type Fault = { point: 'before_event'; event_type: string } | { point: 'audit_write' };

// A failure the seam injects. It is not a Refusal, so the transaction it
// interrupts rolls back and is reported like any other store failure.
class InjectedFault extends Error {
  constructor(what: string) {
    super(`injected fault: ${what}`);
  }
}

let init: SeamInit = { harness: false, barriers: [], shared: null };
let post: ((message: SeamMessage) => void) | null = null;
const faults: Fault[] = [];

type SeamMessage = { seam: 'barrier'; name: string; state: BarrierState };

const notFound = (what: string) => new Refusal(404, 'not_found', `${what} exists only in harness mode.`, 'Start the engine with --harness.');

// ---- command line (main thread) ---------------------------------------------

// Parse `--harness-barrier name=action`. Returns null for an unknown barrier
// or action.
function parseBarrier(value: string, slot: number): BarrierSpec | null {
  const at = value.lastIndexOf('=');
  if (at <= 0) return null;
  const name = value.slice(0, at);
  const action = value.slice(at + 1);
  if (!(BARRIER_NAMES as readonly string[]).includes(name)) return null;
  if (action !== 'pause' && action !== 'kill') return null;
  return { name, action, slot };
}

const registry = new Map<string, { spec: BarrierSpec; state: BarrierState }>();

// The command line's --harness flag and --harness-barrier values. Returns a
// usage problem to report, or null. Called once, before the engine starts.
export function configureHarness(harness: boolean, barrierValues: string[]): string | null {
  const barriers: BarrierSpec[] = [];
  for (const value of barrierValues) {
    const spec = parseBarrier(value, barriers.length);
    if (!spec) return `unknown barrier or action in --harness-barrier ${value}`;
    if (barriers.some((b) => b.name === spec.name)) return `barrier ${spec.name} is armed twice`;
    barriers.push(spec);
  }
  if (!harness && barriers.length > 0) return '--harness-barrier is accepted only with --harness';
  const shared = harness && barriers.length > 0 ? new SharedArrayBuffer(4 * barriers.length) : null;
  init = { harness, barriers: harness ? barriers : [], shared };
  registry.clear();
  for (const spec of init.barriers) registry.set(spec.name, { spec, state: 'armed' });
  return null;
}

// ---- store client (main thread) ---------------------------------------------

// The seam's part of the store worker's startup data.
export function seamWorkerData(): SeamInit {
  return init;
}

// A message from the store worker that is not a reply to a store call.
export function seamMessage(message: unknown): void {
  const m = message as Partial<SeamMessage> | null;
  if (!init.harness || m?.seam !== 'barrier' || typeof m.name !== 'string') return;
  const entry = registry.get(m.name);
  if (entry && entry.state !== 'released' && (m.state === 'waiting' || m.state === 'fired')) entry.state = m.state;
}

function listBarriers(): { name: string; action: BarrierAction; state: BarrierState }[] {
  return [...registry.values()].map(({ spec, state }) => ({ name: spec.name, action: spec.action, state }));
}

function releaseBarrier(name: string): void {
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

// ---- API server (main thread) -----------------------------------------------

// What a seam route needs from the server for the request it was offered.
export interface SeamRequestHooks {
  // Reads the JSON body; this is when `100 Continue` is sent.
  body: () => Promise<unknown>;
  store: () => StoreClient;
  actor: Actor;
}

export interface SeamRoute {
  // Answers while the engine is still in restricted mode.
  restricted: boolean;
  handler: () => Promise<{ status: number; body: unknown }>;
}

// Store operations the seam's routes run in the worker (seamStoreOp).
const OP_FIXTURE_PROJECT = 'harness.fixture_project';
const OP_ARM_FAULT = 'harness.arm_fault';

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

// The /v1/harness/... routes (SEAM.md §7), offered a request no production
// route matched. They pass the same Host and token checks as every route and
// write no api.act event. null: not a seam route, which outside harness mode
// is every request.
export function seamRoute(method: string, segments: string[], hooks: SeamRequestHooks): SeamRoute | null {
  if (!init.harness || segments[0] !== 'v1' || segments[1] !== 'harness') return null;
  const s = segments.slice(2);
  const get = method === 'GET' || method === 'HEAD';
  const post = method === 'POST';
  if (s.length === 1 && s[0] === 'barriers' && get) {
    return { restricted: true, handler: async () => ({ status: 200, body: { barriers: listBarriers() } }) };
  }
  if (s.length === 3 && s[0] === 'barriers' && s[2] === 'release' && post) {
    return {
      restricted: true,
      handler: async () => {
        await hooks.body();
        releaseBarrier(decodeSegment(s[1]!));
        return { status: 200, body: { barriers: listBarriers() } };
      },
    };
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'project' && post) {
    return {
      restricted: false,
      handler: async () => {
        const body = await hooks.body();
        return { status: 201, body: await hooks.store().call(OP_FIXTURE_PROJECT, { body, actor: hooks.actor }) };
      },
    };
  }
  if (s.length === 1 && s[0] === 'faults' && post) {
    return {
      restricted: false,
      handler: async () => {
        const body = await hooks.body();
        return { status: 200, body: { armed: await hooks.store().call(OP_ARM_FAULT, body) } };
      },
    };
  }
  return null;
}

// GET /v1/engine reports whether the engine is in harness mode.
export function seamDescribe<T extends object>(info: T): T & { harness: boolean } {
  return { ...info, harness: init.harness };
}

// ---- store worker -----------------------------------------------------------

export function configureWorker(given: SeamInit, send: (message: unknown) => void): void {
  init = given;
  post = send;
}

// A store operation the worker does not know. Outside harness mode, or for an
// operation the seam does not define either, it is refused as unknown.
export function seamStoreOp(op: string, args: unknown, store: () => Database): unknown {
  if (init.harness && op === OP_FIXTURE_PROJECT) {
    const a = args as { body: unknown; actor: Actor };
    return installFixtureProject(store(), a.actor, a.body);
  }
  if (init.harness && op === OP_ARM_FAULT) return armFault(args);
  throw new Error(`unknown store op ${op}`);
}

// A named point the engine pauses at until released, or kills itself at.
export function barrier(name: string): void {
  if (!init.harness) return;
  const spec = init.barriers.find((b) => b.name === name);
  if (!spec) return;
  if (spec.action === 'kill') {
    post?.({ seam: 'barrier', name, state: 'fired' });
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  post?.({ seam: 'barrier', name, state: 'waiting' });
  const cells = new Int32Array(init.shared!);
  while (Atomics.load(cells, spec.slot) === 0) Atomics.wait(cells, spec.slot, 0);
}

function armFault(fault: unknown): Fault {
  if (!init.harness) throw notFound('Fault injection');
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
