// The deployment adapter contract (D4 §2, Appendix B). Two calls are effects
// and four are reads; every call carries a deadline and an output bound and
// returns a typed result. An effect's result is a claim (provenance
// `claimed`): no adapter result completes an attempt (§2.3). A read returns
// what it could not read as unread, never as a default (CH 9).
//
// An effect is made only after its capability passed the store check of
// D4 §2.2 (release-operator.ts, `adapterCall`). Reads and effects are
// bounded here by `adapter_effect_deadline`, `adapter_read_deadline` and
// `adapter_output_max_bytes`. Main thread only; no transaction is held
// across a call (D1 §6.1).
//
// Slice 23 builds no production adapter: `local_service` is slice 24's. In
// harness mode the seam answers the scripted adapter (SEAM.md §247);
// otherwise an adapter with nothing to call answers, whose every effect is
// `not_issued` and every read `unavailable`, so unknown.

import { seamDeploymentAdapter } from '../testing/seam.js';

export type AdapterEffectResult = 'issued' | 'refused' | 'not_issued' | 'uncertain';
export type AdapterReadFailure = 'unavailable' | 'deadline' | 'output_exceeded' | 'invalid_response';
export type ReconcileOutcome = 'applied' | 'absent' | 'partial' | 'conflicting' | 'unknown';
export type IdentityMatch = 'match' | 'differs' | 'unread';
export type Supervision = 'attached' | 'unknown';

// A process instance, as /proc names it: a pid and its start time.
export interface Instance {
  pid: number;
  start_time: number;
}

export interface DeployCapability {
  kind: 'deploy';
  environment: string;
  operation: string;
  attempt: string;
  generation: number;
  incarnation: string;
  lease_generation: number;
  artifact_digest: string;
  sealed_path: string;
  config_identity: string;
  config_version: string;
  targets: string[];
  create_units: string[];
  prior: { unit: string; instance: Instance | null }[];
  cleanup: string[];
}

export interface TeardownCapability {
  kind: 'teardown';
  environment: string;
  operation: string;
  attempt: string;
  generation: number;
  incarnation: string;
  lease_generation: number;
  // The exact units its frozen intent names; nothing else is stopped.
  stop_units: string[];
}

export type Capability = DeployCapability | TeardownCapability;

export interface EffectReceipt {
  result: AdapterEffectResult;
  steps: { at: string; step: string; detail: string }[];
}

// What a read found of one unit of the environment.
export interface InventoryEntry {
  resource: string;
  kind: 'unit' | 'cgroup' | 'socket' | 'directory';
  recorded: boolean;
  state: string;
  pendingJob: boolean | 'unread';
  generation?: number | 'unread' | null;
  invocation_id?: string | 'unread' | null;
  instance?: Instance | 'unread' | null;
  tree?: string | 'unread' | null;
}

export interface TargetStatus {
  target: string;
  unit: string | null;
  active: boolean | 'unread';
  instance: Instance | 'unread' | null;
  generation: number | 'unread' | null;
  supervision: Supervision;
  at: string;
  failure?: AdapterReadFailure;
}

export interface IdentityRead {
  target: string;
  method: string;
  expected: string;
  read: string | 'unread';
  match: IdentityMatch;
  instance: Instance | 'unread';
  generation: number | 'unread';
  at: string;
}

export interface Reconciliation {
  outcome: ReconcileOutcome;
  complete: boolean;
  inventory: InventoryEntry[];
  reads: TargetStatus[];
  identity: IdentityRead[];
}

export interface LogTail {
  bytes: number;
  text: string;
}

export interface EnvRef {
  environment: string;
  prefix: string;
}

export interface TargetExpectation {
  target: string;
  digest: string;
  unit: string | null;
  generation: number | null;
  instance: Instance | null;
}

// What reconcile is given: the operation's frozen intent and the attempt's.
export interface OperationIntent {
  operation: string;
  kind: 'deploy' | 'teardown';
  environment: string;
  prefix: string;
  digest: string | null;
  targets: string[];
}

export interface AttemptIntent {
  attempt: string;
  generation: number;
  create_units: string[];
  prior: { unit: string; instance: Instance | null }[];
  cleanup: string[];
  stop_units: string[];
  // Every unit a frozen intent of the environment names: what the store
  // recorded for it.
  recorded_units: string[];
}

// The engine's launch socket, as a service launcher reaches it (D4 §9.2):
// the launch authorization asked once with the init's instance, and the
// init's `started` report of the application. The reply names what the
// launcher is to run.
export interface LaunchChannel {
  authorize(init: Instance): Promise<{ granted: false } | { granted: true; exe: string; exe_sha256: string | null; argv: string[] }>;
  started(app: Instance & { exe: string; exe_sha256: string | null; argv: string[] }): Promise<void>;
}

export interface DeploymentAdapter {
  readonly id: string;
  readonly version: string;
  readonly reach: 'service_link' | 'proxy';
  readonly identityMethod: string;
  deploy(cap: DeployCapability, signal: AbortSignal, launch: LaunchChannel): Promise<EffectReceipt>;
  teardown(cap: TeardownCapability, signal: AbortSignal): Promise<EffectReceipt>;
  reconcile(op: OperationIntent, attempt: AttemptIntent, signal: AbortSignal): Promise<Reconciliation>;
  status(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<TargetStatus[]>;
  verify(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<IdentityRead[]>;
  logs(env: EnvRef, target: string, maxBytes: number, signal: AbortSignal): Promise<LogTail>;
}

export interface DeployBounds {
  effectMs: number;
  readMs: number;
  outputBytes: number;
}

const FAILURE_CLASSES: readonly AdapterReadFailure[] = ['unavailable', 'deadline', 'output_exceeded', 'invalid_response'];

export class AdapterUnavailable extends Error {
  constructor(readonly failure: AdapterReadFailure) {
    super(`adapter read failed: ${failure}`);
  }
}

// The class a failed call reported, or `unavailable`: an error the adapter
// raised without one is a call that could not be made.
function failureClass(err: unknown): AdapterReadFailure {
  const f = (err as { failure?: unknown } | null)?.failure;
  return FAILURE_CLASSES.includes(f as AdapterReadFailure) ? (f as AdapterReadFailure) : 'unavailable';
}

// An adapter with nothing to call: nothing is issued and nothing is read.
const none = (id: string): DeploymentAdapter => ({
  id,
  version: 'none',
  reach: 'service_link',
  identityMethod: 'tree_digest',
  deploy: async () => ({ result: 'not_issued', steps: [{ at: new Date().toISOString(), step: 'adapter', detail: `no ${id} adapter is built in this engine` }] }),
  teardown: async () => ({ result: 'not_issued', steps: [{ at: new Date().toISOString(), step: 'adapter', detail: `no ${id} adapter is built in this engine` }] }),
  reconcile: async () => {
    throw new AdapterUnavailable('unavailable');
  },
  status: async () => {
    throw new AdapterUnavailable('unavailable');
  },
  verify: async () => {
    throw new AdapterUnavailable('unavailable');
  },
  logs: async () => {
    throw new AdapterUnavailable('unavailable');
  },
});

export function adapterFor(id: string): DeploymentAdapter {
  return (seamDeploymentAdapter(id) as DeploymentAdapter | null) ?? none(id);
}

// A call bounded by its deadline and its output bound. The signal is
// aborted at the deadline; an adapter that does not settle then is left,
// and its outcome is `deadline`.
async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, outputBytes: number): Promise<{ ok: T } | { failure: AdapterReadFailure }> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ failure: AdapterReadFailure }>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve({ failure: 'deadline' });
    }, ms);
  });
  try {
    const done = call(ctl.signal).then(
      (value): { ok: T } | { failure: AdapterReadFailure } => {
        let size: number;
        try {
          size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
        } catch {
          return { failure: 'invalid_response' };
        }
        return size > outputBytes ? { failure: 'output_exceeded' } : { ok: value };
      },
      (err): { failure: AdapterReadFailure } => ({ failure: failureClass(err) }),
    );
    return await Promise.race([done, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// An effect. Past its deadline or its output bound, or answered in a way
// that cannot be interpreted, it is `uncertain`: ambiguous until a read
// settles it (§2.1).
export async function effectCall(adapter: DeploymentAdapter, cap: Capability, launch: LaunchChannel, b: DeployBounds): Promise<{ receipt: EffectReceipt; bound: AdapterReadFailure | null }> {
  const r = await bounded((signal) => (cap.kind === 'deploy' ? adapter.deploy(cap, signal, launch) : adapter.teardown(cap, signal)), b.effectMs, b.outputBytes);
  const at = new Date().toISOString();
  if ('failure' in r) return { receipt: { result: 'uncertain', steps: [{ at, step: 'bound', detail: r.failure }] }, bound: r.failure };
  const receipt = r.ok;
  if (!receipt || !['issued', 'refused', 'not_issued', 'uncertain'].includes(receipt.result)) {
    return { receipt: { result: 'uncertain', steps: [{ at, step: 'bound', detail: 'invalid_response' }] }, bound: 'invalid_response' };
  }
  const steps = Array.isArray(receipt.steps) ? receipt.steps.map((s) => ({ at: String(s.at), step: String(s.step), detail: String(s.detail).slice(0, 2000) })) : [];
  return { receipt: { result: receipt.result, steps }, bound: null };
}

export function readCall<T>(call: (signal: AbortSignal) => Promise<T>, b: DeployBounds): Promise<{ ok: T } | { failure: AdapterReadFailure }> {
  return bounded(call, b.readMs, b.outputBytes);
}
