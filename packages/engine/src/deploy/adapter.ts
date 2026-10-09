// The deployment adapter contract (D4 §2, Appendix B). Two calls are effects
// and four are reads; every call carries a deadline and an output bound and
// returns a typed result. An effect's result is a claim (provenance
// `claimed`): no adapter result completes an attempt (§2.3). A read returns
// what it could not read as unread, never as a default (CH 9).
//
// `adapterCall` is the one entry point of an effect: it checks the
// capability against the store before any host call (§2.2), and bounds the
// call. Reads go through `adapterRead`, bounded alike. Main thread only; no
// transaction is held across a call (D1 §6.1).
//
// Slice 23 builds no production adapter: `local_service` is slice 24's. The
// registry answers the scripted adapter of the seam where it has one, and
// otherwise an adapter that has nothing to call, whose every effect is
// `not_issued` and every read `unavailable`, so unknown.

import { seamDeploymentAdapter, seamDeployBounds } from '../testing/seam.js';

export type AdapterEffectResult = 'issued' | 'refused' | 'not_issued' | 'uncertain';
export type AdapterReadFailure = 'unavailable' | 'deadline' | 'output_exceeded' | 'invalid_response';
export type ReconcileOutcome = 'applied' | 'absent' | 'partial' | 'conflicting' | 'unknown';
export type IdentityMatch = 'match' | 'differs' | 'unread';
export type Supervision = 'attached' | 'unknown';

export interface Instance {
  invocationId: string;
  pid: number;
  startTime: number;
}

export interface DeployCapability {
  kind: 'deploy';
  environment: string;
  operation: string;
  attempt: string;
  generation: number;
  incarnation: string;
  leaseGeneration: number;
  artifact: { digest: string; sealedPath: string };
  configIdentity: string;
  configVersion: number;
  targets: string[];
  createUnits: string[];
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
  leaseGeneration: number;
  // The exact units its frozen intent names; nothing else is stopped.
  stopUnits: string[];
}

export type Capability = DeployCapability | TeardownCapability;

export interface EffectReceipt {
  result: AdapterEffectResult;
  steps: { at: string; step: string; detail: string }[];
}

export interface InventoryEntry {
  resource: string;
  kind: 'unit' | 'cgroup' | 'socket' | 'directory';
  recorded: boolean;
  state: string;
  pendingJob: boolean | 'unread';
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
  createUnits: string[];
  prior: { unit: string; instance: Instance | null }[];
  cleanup: string[];
  stopUnits: string[];
  // The units every frozen intent of the environment named: what the store
  // recorded for it.
  recordedUnits: string[];
  instance: Instance | null;
}

export interface DeploymentAdapter {
  readonly id: string;
  readonly version: string;
  readonly reach: 'service_link' | 'proxy';
  readonly identityMethod: string;
  deploy(cap: DeployCapability, signal: AbortSignal): Promise<EffectReceipt>;
  teardown(cap: TeardownCapability, signal: AbortSignal): Promise<EffectReceipt>;
  reconcile(op: OperationIntent, attempt: AttemptIntent, signal: AbortSignal): Promise<Reconciliation>;
  status(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<TargetStatus[]>;
  verify(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<IdentityRead[]>;
  logs(env: EnvRef, target: string, maxBytes: number, signal: AbortSignal): Promise<LogTail>;
}

// D4 A.7's values (BS4 §11.3). Their configuration keys come with the
// artifact's bounds (row M309, slice 24); the seam may lower them.
export const ADAPTER_EFFECT_DEADLINE_S = 120;
export const ADAPTER_READ_DEADLINE_S = 10;
export const ADAPTER_OUTPUT_MAX_BYTES = 1_048_576;
export const DEPLOY_ORCHESTRATION_DEADLINE_S = 1800;
export const DEPLOY_AUTO_RETRIES_MAX = 1;

export interface DeployBounds {
  effectMs: number;
  readMs: number;
  outputBytes: number;
  orchestrationSeconds: number;
  autoRetries: number;
}

export function deployBounds(): DeployBounds {
  const base: DeployBounds = {
    effectMs: ADAPTER_EFFECT_DEADLINE_S * 1000,
    readMs: ADAPTER_READ_DEADLINE_S * 1000,
    outputBytes: ADAPTER_OUTPUT_MAX_BYTES,
    orchestrationSeconds: DEPLOY_ORCHESTRATION_DEADLINE_S,
    autoRetries: DEPLOY_AUTO_RETRIES_MAX,
  };
  return { ...base, ...(seamDeployBounds() ?? {}) };
}

// An adapter with nothing to call: nothing is issued and nothing is read.
const NONE = (id: string): DeploymentAdapter => ({
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

export class AdapterUnavailable extends Error {
  constructor(readonly failure: AdapterReadFailure) {
    super(`adapter read failed: ${failure}`);
  }
}

const FAILURE_CLASSES: readonly AdapterReadFailure[] = ['unavailable', 'deadline', 'output_exceeded', 'invalid_response'];

// The class a failed call reported, or `unavailable`: an error the adapter
// raised without one is a call that could not be made.
function failureClass(err: unknown): AdapterReadFailure {
  const f = (err as { failure?: unknown } | null)?.failure;
  return FAILURE_CLASSES.includes(f as AdapterReadFailure) ? (f as AdapterReadFailure) : 'unavailable';
}

export function adapterFor(id: string): DeploymentAdapter {
  return (seamDeploymentAdapter(id) as DeploymentAdapter | null) ?? NONE(id);
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

// An effect, after the capability check (the caller's, against the store).
// Past its deadline or its output bound, or failed in a way it cannot
// interpret, the effect is `uncertain`: ambiguous until reconciled (§2.1).
export async function effectCall(adapter: DeploymentAdapter, cap: Capability): Promise<{ receipt: EffectReceipt; bound: AdapterReadFailure | null }> {
  const b = deployBounds();
  const r = await bounded((signal) => (cap.kind === 'deploy' ? adapter.deploy(cap, signal) : adapter.teardown(cap, signal)), b.effectMs, b.outputBytes);
  if ('failure' in r) return { receipt: { result: 'uncertain', steps: [{ at: new Date().toISOString(), step: 'bound', detail: r.failure }] }, bound: r.failure };
  const receipt = r.ok;
  if (!receipt || !['issued', 'refused', 'not_issued', 'uncertain'].includes(receipt.result)) {
    return { receipt: { result: 'uncertain', steps: [{ at: new Date().toISOString(), step: 'bound', detail: 'invalid_response' }] }, bound: 'invalid_response' };
  }
  return { receipt: { result: receipt.result, steps: Array.isArray(receipt.steps) ? receipt.steps : [] }, bound: null };
}

export async function readCall<T>(call: (signal: AbortSignal) => Promise<T>): Promise<{ ok: T } | { failure: AdapterReadFailure }> {
  const b = deployBounds();
  return bounded(call, b.readMs, b.outputBytes);
}
