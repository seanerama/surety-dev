// The scripted deployment adapter (BS4 §8; M4 plan §2.3; D4 Appendix C's
// kernel lane): a stand-in target the test scripts, so the engine's
// operation, reconcile, verification and completion rules run without a
// unit. Harness mode only: production reaches it only through the seam
// module, which offers it only with --harness.
//
// The target is a model held in this engine process: per environment, its
// units, each with a generation, whether it is active, its application
// instance and the digest of the tree it runs from. By default the adapter
// behaves as a working target would: `deploy` stops the prior units its
// capability names and starts the next generation's; `teardown` stops the
// units it names; `reconcile`, `status` and `verify` read the model. A test
// scripts what a call does instead (its result, a read failure, a hang past
// the deadline, an output past its bound, an outcome), and changes the
// model as a person or a fault would. Every call is counted.

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Refusal } from '../refusal.js';
import type {
  AdapterReadFailure,
  AttemptIntent,
  DeployCapability,
  DeploymentAdapter,
  EffectReceipt,
  EnvRef,
  IdentityRead,
  Instance,
  InventoryEntry,
  OperationIntent,
  Reconciliation,
  ReconcileOutcome,
  TargetExpectation,
  TargetStatus,
  TeardownCapability,
} from '../deploy/adapter.js';

const CALLS = ['deploy', 'teardown', 'reconcile', 'status', 'verify', 'logs'] as const;
type CallName = (typeof CALLS)[number];
const FAILURES: readonly AdapterReadFailure[] = ['unavailable', 'deadline', 'output_exceeded', 'invalid_response'];
const RESULTS = ['issued', 'refused', 'not_issued', 'uncertain'] as const;
const OUTCOMES: readonly ReconcileOutcome[] = ['applied', 'absent', 'partial', 'conflicting', 'unknown'];

interface Unit {
  name: string;
  generation: number;
  active: boolean;
  digest: string;
  instance: Instance;
}

// One scripted call: consumed by the next call of its kind.
export interface ScriptStep {
  call: CallName;
  // An effect's result; with `apply` false the target is left unchanged.
  result?: (typeof RESULTS)[number];
  apply?: boolean;
  // A read that fails with this class.
  failure?: AdapterReadFailure;
  // reconcile: the outcome reported, and whether the inventory is complete.
  outcome?: ReconcileOutcome;
  complete?: boolean;
  // verify: what the read finds instead of the model's answer.
  match?: 'differs' | 'unread';
  // The call never settles (until the engine's deadline aborts it), or
  // settles after a delay, or returns this many bytes more than it would.
  hang?: boolean;
  delay_ms?: number;
  output_bytes?: number;
}

const targets = new Map<string, Map<string, Unit>>();
const script: ScriptStep[] = [];
const counts: Record<CallName, number> = { deploy: 0, teardown: 0, reconcile: 0, status: 0, verify: 0, logs: 0 };
const log: { call: CallName; at: string; environment: string | null; detail: unknown }[] = [];
let nextPid = 4000;
let admission: 'granted' | 'held' = 'granted';
let bounds: Partial<{ effectMs: number; readMs: number; outputBytes: number; orchestrationSeconds: number; autoRetries: number }> = {};

const now = () => new Date().toISOString();
const unitsOf = (env: string): Map<string, Unit> => {
  let m = targets.get(env);
  if (!m) {
    m = new Map();
    targets.set(env, m);
  }
  return m;
};

function take(call: CallName): ScriptStep | null {
  const i = script.findIndex((s) => s.call === call);
  if (i < 0) return null;
  return script.splice(i, 1)[0]!;
}

class ReadFailed extends Error {
  constructor(readonly failure: AdapterReadFailure) {
    super(`scripted read failure: ${failure}`);
  }
}

// What a step does before the call answers: wait, or hang until aborted.
async function before(step: ScriptStep | null, signal: AbortSignal): Promise<void> {
  if (step?.delay_ms) await sleep(step.delay_ms, undefined, { signal }).catch(() => {});
  if (step?.hang) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    // The engine has given up on the call; what it would have said is moot.
    throw new ReadFailed('deadline');
  }
}

const pad = (step: ScriptStep | null) => (step?.output_bytes ? 'x'.repeat(step.output_bytes) : undefined);

function record(call: CallName, environment: string | null, detail: unknown): void {
  counts[call]++;
  log.push({ call, at: now(), environment, detail });
}

function newInstance(): Instance {
  return { invocationId: randomBytes(16).toString('hex'), pid: nextPid++, startTime: Math.floor(Date.now() / 10) };
}

const generationOf = (unit: string): number | null => {
  const m = /-g(\d+)\.service$/.exec(unit);
  return m ? Number(m[1]) : null;
};

export const scriptedDeploymentAdapter: DeploymentAdapter = {
  id: 'local_service',
  version: '1',
  reach: 'service_link',
  identityMethod: 'tree_digest',

  async deploy(cap: DeployCapability, signal: AbortSignal): Promise<EffectReceipt> {
    const step = take('deploy');
    record('deploy', cap.environment, { attempt: cap.attempt, generation: cap.generation, units: cap.createUnits, prior: cap.prior.map((p) => p.unit) });
    const result = step?.result ?? 'issued';
    const apply = step?.apply ?? (result === 'issued' || result === 'uncertain');
    if (apply) {
      const units = unitsOf(cap.environment);
      for (const p of cap.prior) units.delete(p.unit);
      for (const name of cap.createUnits) {
        units.set(name, { name, generation: generationOf(name) ?? cap.generation, active: true, digest: cap.artifact.digest, instance: newInstance() });
      }
    }
    await before(step, signal);
    return { result, steps: [{ at: now(), step: 'deploy', detail: pad(step) ?? `${apply ? 'started' : 'left'} ${cap.createUnits.join(', ')}` }] };
  },

  async teardown(cap: TeardownCapability, signal: AbortSignal): Promise<EffectReceipt> {
    const step = take('teardown');
    record('teardown', cap.environment, { attempt: cap.attempt, units: cap.stopUnits });
    const result = step?.result ?? 'issued';
    const apply = step?.apply ?? (result === 'issued' || result === 'uncertain');
    if (apply) {
      const units = unitsOf(cap.environment);
      for (const name of cap.stopUnits) units.delete(name);
    }
    await before(step, signal);
    return { result, steps: [{ at: now(), step: 'teardown', detail: pad(step) ?? `${apply ? 'stopped' : 'left'} ${cap.stopUnits.join(', ')}` }] };
  },

  async reconcile(op: OperationIntent, attempt: AttemptIntent, signal: AbortSignal): Promise<Reconciliation> {
    const step = take('reconcile');
    record('reconcile', op.environment, { operation: op.operation, attempt: attempt.attempt });
    await before(step, signal);
    if (step?.failure) throw new ReadFailed(step.failure);
    const units = [...unitsOf(op.environment).values()];
    const inventory: InventoryEntry[] = units.map((u) => ({
      resource: u.name,
      kind: 'unit',
      recorded: attempt.recordedUnits.includes(u.name),
      state: u.active ? 'active' : 'inactive',
      pendingJob: false,
    }));
    const reads: TargetStatus[] = [];
    const identity: IdentityRead[] = [];
    let outcome: ReconcileOutcome;
    if (op.kind === 'deploy') {
      const g = units.find((u) => attempt.createUnits.includes(u.name));
      const others = units.filter((u) => u.active && !attempt.createUnits.includes(u.name));
      const priorIntact = attempt.prior.every((p) => units.some((u) => u.name === p.unit && u.active));
      for (const t of op.targets) {
        reads.push({ target: t, unit: g?.name ?? null, active: g?.active ?? false, instance: g?.instance ?? null, generation: g?.generation ?? null, supervision: 'attached', at: now() });
        if (g) identity.push({ target: t, method: 'tree_digest', expected: op.digest ?? '', read: g.digest, match: g.digest === op.digest ? 'match' : 'differs', instance: g.instance, generation: g.generation, at: now() });
      }
      if (others.some((u) => !attempt.prior.some((p) => p.unit === u.name))) outcome = 'conflicting';
      else if (g && g.active && others.length === 0) outcome = g.digest === op.digest ? 'applied' : 'conflicting';
      else if (!g && (attempt.prior.length === 0 ? others.length === 0 : priorIntact)) outcome = 'absent';
      else outcome = 'partial';
    } else {
      const left = units.filter((u) => attempt.stopUnits.includes(u.name));
      const unowned = units.filter((u) => !attempt.stopUnits.includes(u.name) && u.active);
      if (unowned.length > 0) outcome = 'conflicting';
      else if (left.length === 0) outcome = 'applied';
      else if (left.length === attempt.stopUnits.length) outcome = 'absent';
      else outcome = 'partial';
    }
    const result: Reconciliation = { outcome: step?.outcome ?? outcome, complete: step?.complete ?? true, inventory, reads, identity };
    const extra = pad(step);
    return extra === undefined ? result : { ...result, inventory: [...inventory, { resource: extra, kind: 'directory', recorded: false, state: 'padding', pendingJob: false }] };
  },

  async status(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<TargetStatus[]> {
    const step = take('status');
    record('status', env.environment, { targets: expect.map((e) => e.target) });
    await before(step, signal);
    if (step?.failure) throw new ReadFailed(step.failure);
    const active = [...unitsOf(env.environment).values()].filter((u) => u.active);
    return expect.map((e) => {
      const u = active[0];
      return { target: e.target, unit: u?.name ?? null, active: u !== undefined, instance: u?.instance ?? null, generation: u?.generation ?? null, supervision: 'attached', at: now(), ...(pad(step) ? { pad: pad(step) } : {}) };
    });
  },

  async verify(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<IdentityRead[]> {
    const step = take('verify');
    record('verify', env.environment, { targets: expect.map((e) => e.target) });
    await before(step, signal);
    if (step?.failure) throw new ReadFailed(step.failure);
    const units = unitsOf(env.environment);
    return expect.map((e) => {
      const u = e.unit !== null ? units.get(e.unit) : undefined;
      const base = { target: e.target, method: 'tree_digest', expected: e.digest, at: now() };
      if (!u || !u.active || step?.match === 'unread') return { ...base, read: 'unread', match: 'unread', instance: 'unread', generation: 'unread', ...(pad(step) ? { pad: pad(step) } : {}) };
      const same = e.instance === null || (e.instance.pid === u.instance.pid && e.instance.startTime === u.instance.startTime && e.instance.invocationId === u.instance.invocationId);
      const match = step?.match === 'differs' || u.digest !== e.digest || !same ? 'differs' : 'match';
      return { ...base, read: u.digest, match, instance: u.instance, generation: u.generation, ...(pad(step) ? { pad: pad(step) } : {}) };
    });
  },

  async logs(env: EnvRef, _target: string, _maxBytes: number, signal: AbortSignal) {
    const step = take('logs');
    record('logs', env.environment, {});
    await before(step, signal);
    if (step?.failure) throw new ReadFailed(step.failure);
    return { bytes: 0, text: '' };
  },
};

// Every read failure the adapter raises is one the bounded call reads as its
// class (deploy/adapter.ts maps an error to `unavailable` unless it carries
// its own).
export const failureOf = (err: unknown): AdapterReadFailure | null => (err instanceof ReadFailed ? err.failure : null);

// ---- the harness routes' halves -------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the scripted step.', { field });

function parseStep(v: unknown, i: number): ScriptStep {
  if (!isObject(v)) throw invalid(`steps[${i}]`, 'must be an object');
  const known = ['call', 'result', 'apply', 'failure', 'outcome', 'complete', 'match', 'hang', 'delay_ms', 'output_bytes'];
  for (const k of Object.keys(v)) if (!known.includes(k)) throw new Refusal(400, 'unknown_field', `"${k}" is not a field of a scripted step.`, `Send only ${known.join(', ')}.`, { field: `steps[${i}].${k}` });
  if (!(CALLS as readonly string[]).includes(v.call as string)) throw invalid(`steps[${i}].call`, `must be one of ${CALLS.join(', ')}`);
  if (v.result !== undefined && !(RESULTS as readonly string[]).includes(v.result as string)) throw invalid(`steps[${i}].result`, `must be one of ${RESULTS.join(', ')}`);
  if (v.failure !== undefined && !FAILURES.includes(v.failure as AdapterReadFailure)) throw invalid(`steps[${i}].failure`, `must be one of ${FAILURES.join(', ')}`);
  if (v.outcome !== undefined && !OUTCOMES.includes(v.outcome as ReconcileOutcome)) throw invalid(`steps[${i}].outcome`, `must be one of ${OUTCOMES.join(', ')}`);
  if (v.match !== undefined && v.match !== 'differs' && v.match !== 'unread') throw invalid(`steps[${i}].match`, 'must be differs or unread');
  for (const b of ['apply', 'complete', 'hang']) if (v[b] !== undefined && typeof v[b] !== 'boolean') throw invalid(`steps[${i}].${b}`, 'must be a boolean');
  for (const n of ['delay_ms', 'output_bytes']) if (v[n] !== undefined && (!Number.isInteger(v[n]) || (v[n] as number) < 0)) throw invalid(`steps[${i}].${n}`, 'must be a non-negative integer');
  return v as unknown as ScriptStep;
}

// POST …/deploy/script {steps: [...]}: appended to what is scripted.
export function addScript(body: unknown): { scripted: number } {
  if (!isObject(body) || !Array.isArray(body.steps)) throw invalid('steps', 'must be an array of scripted steps');
  const steps = body.steps.map(parseStep);
  script.push(...steps);
  return { scripted: script.length };
}

// GET …/deploy/calls: every call counted, and what is still scripted.
export function callReport(): { calls: Record<CallName, number>; log: typeof log; scripted: ScriptStep[]; targets: Record<string, Unit[]> } {
  return { calls: { ...counts }, log: [...log], scripted: [...script], targets: Object.fromEntries([...targets].map(([env, units]) => [env, [...units.values()]])) };
}

// DELETE …/deploy: the model, the script and the counts emptied.
export function resetScripted(): void {
  targets.clear();
  script.length = 0;
  log.length = 0;
  for (const c of CALLS) counts[c] = 0;
  admission = 'granted';
  bounds = {};
}

// POST …/deploy/target {environment, action, unit?}: the target changed as
// a person or a fault would: a byte of the running tree changed, a unit
// stopped, restarted (a new instance), or an unrecorded unit started.
export function changeTarget(body: unknown): { units: Unit[] } {
  if (!isObject(body) || typeof body.environment !== 'string') throw invalid('environment', 'must name an environment');
  const units = unitsOf(body.environment);
  const pick = (): Unit => {
    const u = typeof body.unit === 'string' ? units.get(body.unit) : [...units.values()].find((x) => x.active);
    if (!u) throw new Refusal(404, 'not_found', 'No such unit in the scripted target.', 'Name a unit the target holds.', { unit: body.unit ?? null });
    return u;
  };
  switch (body.action) {
    case 'change_byte': {
      const u = pick();
      u.digest = `sha256:${randomBytes(32).toString('hex')}`;
      break;
    }
    case 'stop':
      pick().active = false;
      break;
    case 'restart': {
      const u = pick();
      u.active = true;
      u.instance = newInstance();
      break;
    }
    case 'add_unit': {
      if (typeof body.unit !== 'string') throw invalid('unit', 'must name the unit to add');
      units.set(body.unit, { name: body.unit, generation: generationOf(body.unit) ?? 0, active: true, digest: 'sha256:unknown', instance: newInstance() });
      break;
    }
    default:
      throw invalid('action', 'must be change_byte, stop, restart or add_unit');
  }
  return { units: [...units.values()] };
}

// POST …/deploy/admission {answer}: what admission answers for a service
// in the kernel lane, whose scripted boundary admits no domain (E121
// decision 5: the real reservation is slice 25's).
export function setAdmission(body: unknown): { admission: string } {
  if (!isObject(body) || (body.answer !== 'granted' && body.answer !== 'held')) throw invalid('answer', 'must be granted or held');
  admission = body.answer;
  return { admission };
}
export const scriptedAdmission = (): 'granted' | 'held' => admission;

// POST …/deploy/bounds: the adapter's and the orchestration's bounds for
// this engine, in small units.
export function setBounds(body: unknown): typeof bounds {
  if (!isObject(body)) throw invalid('body', 'must be an object');
  const map: Record<string, keyof typeof bounds> = {
    effect_ms: 'effectMs',
    read_ms: 'readMs',
    output_bytes: 'outputBytes',
    orchestration_seconds: 'orchestrationSeconds',
    auto_retries: 'autoRetries',
  };
  for (const [k, v] of Object.entries(body)) {
    const key = map[k];
    if (!key) throw new Refusal(400, 'unknown_field', `"${k}" is not a bound.`, `Send only ${Object.keys(map).join(', ')}.`, { field: k });
    if (!Number.isInteger(v) || (v as number) < 0) throw invalid(k, 'must be a non-negative integer');
    bounds[key] = v as number;
  }
  return { ...bounds };
}
export const scriptedBounds = (): typeof bounds | null => (Object.keys(bounds).length === 0 ? null : bounds);
