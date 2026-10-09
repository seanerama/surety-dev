// The scripted deployment adapter (SEAM.md §247; BS4 §8; M4 plan §2.3): a
// stand-in target the test scripts, so the engine's operation, reconcile,
// verification and completion rules run without a unit. Harness mode only:
// production reaches it only through the seam module, which offers it only
// with --harness and `--harness-deploy-adapter scripted` (the default).
//
// The target of each environment is a JSON document under
// `<scripted dir>/deploy/<environment>.json`, which survives an engine
// restart as a real target does: its units, the answers queued for each
// call, every call made, and the admission the kernel lane's service domain
// is given. An effect with no answer queued is `not_issued` and changes
// nothing; a read with none queued answers from the target. The adapter
// never decides what a read means: the engine maps what it reads
// (deploy/reconcile.ts). Nothing here touches the host.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  LaunchChannel,
  OperationIntent,
  Reconciliation,
  TargetExpectation,
  TargetStatus,
  TeardownCapability,
} from '../deploy/adapter.js';

const CALLS = ['deploy', 'teardown', 'reconcile', 'status', 'verify', 'logs'] as const;
type CallName = (typeof CALLS)[number];
const FAILURES: readonly AdapterReadFailure[] = ['unavailable', 'deadline', 'output_exceeded', 'invalid_response'];
const RESULTS = ['issued', 'refused', 'not_issued', 'uncertain'] as const;
const STATES = ['active', 'inactive', 'failed', 'unread'] as const;

type Unread = 'unread';
export interface Unit {
  name: string;
  state: (typeof STATES)[number];
  invocation_id: string | Unread;
  cgroup: string | Unread;
  pending_job: boolean | Unread;
  generation: number | Unread;
  instance: Instance | Unread;
  init: Instance | Unread;
  tree: string | Unread;
}

interface Answer {
  result?: (typeof RESULTS)[number];
  apply?: boolean;
  hang?: boolean;
  output_bytes?: number;
  failure?: AdapterReadFailure;
  value?: unknown;
}

// What survives an engine restart, as a real target's state does: the
// target, the answers queued and the admission. The calls are this engine
// process's, counted from its start.
interface State {
  target: { complete: boolean; units: Unit[] };
  answers: Partial<Record<CallName, Answer[]>>;
  admission: 'granted' | 'held';
}
type Call = { call: CallName; at: string; capability: unknown; answer: Answer | null };
const calls = new Map<string, Call[]>();

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `"${field}" ${why}.`, 'Correct the scripted adapter request.', { field });
const now = () => new Date().toISOString();
const ENV_ID = /^env_[0-9A-Z]{26}$/;

const fresh = (): State => ({ target: { complete: true, units: [] }, answers: {}, admission: 'granted' });

function stateFile(dir: string, env: string): string {
  if (!ENV_ID.test(env)) throw invalid('environment', 'must be an environment id');
  return join(dir, 'deploy', `${env}.json`);
}

function load(dir: string, env: string): State {
  const file = stateFile(dir, env);
  if (!existsSync(file)) return fresh();
  return JSON.parse(readFileSync(file, 'utf8')) as State;
}

function save(dir: string, env: string, state: State): void {
  const file = stateFile(dir, env);
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, file);
}

// Pids from 100000 up, distinct across the environments of one scripted
// directory; start times positive and rising.
function nextInstance(dir: string): Instance {
  const file = join(dir, 'deploy', 'pids.json');
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  const n = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { next: number }).next : 100000;
  writeFileSync(file, JSON.stringify({ next: n + 1 }));
  return { pid: n, start_time: n - 99000 };
}

class ReadFailed extends Error {
  constructor(readonly failure: AdapterReadFailure) {
    super(`scripted read failure: ${failure}`);
  }
}

const generationOf = (unit: string): number | Unread => {
  const m = /-g(\d+)\.service$/.exec(unit);
  return m ? Number(m[1]) : 'unread';
};

const sameInstance = (a: Instance | Unread, b: Instance | null): boolean => a !== 'unread' && b !== null && a.pid === b.pid && a.start_time === b.start_time;

// Take the next answer queued for a call, recording the call.
function takeAnswer(dir: string, env: string, call: CallName, capability: unknown): { state: State; answer: Answer | null } {
  const state = load(dir, env);
  const answer = state.answers[call]?.shift() ?? null;
  calls.set(env, [...(calls.get(env) ?? []), { call, at: now(), capability, answer }]);
  save(dir, env, state);
  return { state, answer };
}

// What an answer does once the call's change (if any) is made: hang until
// the engine aborts the call, or give that many bytes more.
async function settle<T>(answer: Answer | null, signal: AbortSignal, value: T): Promise<T> {
  if (answer?.hang) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new ReadFailed('deadline');
  }
  if (answer?.output_bytes) return { ...(value as object), padding: 'x'.repeat(answer.output_bytes) } as T;
  return value;
}

async function readAnswer<T>(dir: string | null, env: string, call: CallName, signal: AbortSignal, fromTarget: (state: State) => T): Promise<T> {
  if (dir === null) throw new ReadFailed('unavailable');
  const { state, answer } = takeAnswer(dir, env, call, null);
  if (answer?.failure) throw new ReadFailed(answer.failure);
  if (answer?.hang) return settle(answer, signal, undefined as T);
  const value = answer && 'value' in answer ? (answer.value as T) : fromTarget(state);
  if (answer?.output_bytes) {
    const padded = Array.isArray(value) ? [...value, { padding: 'x'.repeat(answer.output_bytes) }] : { ...(value as object), padding: 'x'.repeat(answer.output_bytes) };
    return padded as T;
  }
  return value;
}

export function scriptedDeploymentAdapter(dir: string | null): DeploymentAdapter {
  return {
    id: 'local_service',
    version: '1',
    reach: 'service_link',
    identityMethod: 'tree_digest',

    async deploy(cap: DeployCapability, signal: AbortSignal, launch: LaunchChannel): Promise<EffectReceipt> {
      if (dir === null) return { result: 'not_issued', steps: [{ at: now(), step: 'scripted', detail: 'no scripted directory' }] };
      const { answer } = takeAnswer(dir, cap.environment, 'deploy', cap);
      if (answer === null) return { result: 'not_issued', steps: [{ at: now(), step: 'scripted', detail: 'no answer queued' }] };
      if (answer.apply) {
        const state = load(dir, cap.environment);
        const priors = new Set(cap.prior.map((p) => p.unit));
        state.target.units = state.target.units.filter((u) => !priors.has(u.name));
        const made: { unit: Unit; init: Instance }[] = [];
        for (const name of cap.create_units) {
          const init = nextInstance(dir);
          const unit: Unit = {
            name,
            state: 'active',
            invocation_id: randomBytes(16).toString('hex'),
            cgroup: `/user.slice/app.slice/${name}`,
            pending_job: false,
            generation: generationOf(name),
            instance: 'unread',
            init,
            tree: cap.artifact_digest,
          };
          state.target.units = [...state.target.units.filter((u) => u.name !== name), unit];
          made.push({ unit, init });
        }
        save(dir, cap.environment, state);
        // The launch stand-in (SEAM.md §247): the launcher's authorization
        // asked with the init's instance; granted, the application started.
        for (const m of made) {
          const grant = await launch.authorize(m.init);
          if (!grant.granted) continue;
          const app = nextInstance(dir);
          const s = load(dir, cap.environment);
          const u = s.target.units.find((x) => x.name === m.unit.name);
          if (u) u.instance = app;
          save(dir, cap.environment, s);
          await launch.started({ ...app, exe: grant.exe, exe_sha256: grant.exe_sha256, argv: grant.argv });
        }
      }
      const receipt: EffectReceipt = { result: answer.result ?? 'not_issued', steps: [{ at: now(), step: 'deploy', detail: `${answer.apply ? 'applied' : 'left'} ${cap.create_units.join(', ')}` }] };
      if (answer.hang) await settle(answer, signal, receipt);
      if (answer.output_bytes) receipt.steps.push({ at: now(), step: 'output', detail: 'x'.repeat(answer.output_bytes) });
      return receipt;
    },

    async teardown(cap: TeardownCapability, signal: AbortSignal): Promise<EffectReceipt> {
      if (dir === null) return { result: 'not_issued', steps: [{ at: now(), step: 'scripted', detail: 'no scripted directory' }] };
      const { answer } = takeAnswer(dir, cap.environment, 'teardown', cap);
      if (answer === null) return { result: 'not_issued', steps: [{ at: now(), step: 'scripted', detail: 'no answer queued' }] };
      if (answer.apply) {
        const state = load(dir, cap.environment);
        state.target.units = state.target.units.filter((u) => !cap.stop_units.includes(u.name));
        save(dir, cap.environment, state);
      }
      const receipt: EffectReceipt = { result: answer.result ?? 'not_issued', steps: [{ at: now(), step: 'teardown', detail: `${answer.apply ? 'stopped' : 'left'} ${cap.stop_units.join(', ')}` }] };
      if (answer.hang) await settle(answer, signal, receipt);
      if (answer.output_bytes) receipt.steps.push({ at: now(), step: 'output', detail: 'x'.repeat(answer.output_bytes) });
      return receipt;
    },

    reconcile(op: OperationIntent, attempt: AttemptIntent, signal: AbortSignal): Promise<Reconciliation> {
      return readAnswer(dir, op.environment, 'reconcile', signal, (state) => {
        const inventory: InventoryEntry[] = state.target.units.map((u) => ({
          resource: u.name,
          kind: 'unit',
          recorded: attempt.recorded_units.includes(u.name),
          state: u.state,
          pendingJob: u.pending_job,
          generation: u.generation,
          invocation_id: u.invocation_id,
          instance: u.instance,
          tree: u.tree,
        }));
        // The outcome is the engine's mapping of these reads (SEAM.md §247).
        return { outcome: 'unknown', complete: state.target.complete, inventory, reads: [], identity: [] };
      });
    },

    status(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<TargetStatus[]> {
      return readAnswer(dir, env.environment, 'status', signal, (state) =>
        state.target.units.map((u) => ({
          target: expect.find((e) => e.unit === u.name)?.target ?? expect[0]?.target ?? u.name,
          unit: u.name,
          active: u.state === 'unread' ? 'unread' : u.state === 'active',
          instance: u.instance,
          generation: u.generation,
          supervision: 'attached',
          at: now(),
        })),
      );
    },

    verify(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<IdentityRead[]> {
      return readAnswer(dir, env.environment, 'verify', signal, (state) =>
        expect.map((e): IdentityRead => {
          const u = state.target.units.find((x) => (e.unit !== null ? x.name === e.unit : x.generation === e.generation));
          const base = { target: e.target, method: 'tree_digest', expected: e.digest, at: now() };
          if (!u) {
            return state.target.complete
              ? { ...base, read: 'unread', match: 'differs', instance: 'unread', generation: 'unread' }
              : { ...base, read: 'unread', match: 'unread', instance: 'unread', generation: 'unread' };
          }
          const unread = u.state === 'unread' || u.instance === 'unread' || u.tree === 'unread';
          const match = unread ? 'unread' : u.state === 'active' && sameInstance(u.instance, e.instance) && u.tree === e.digest ? 'match' : 'differs';
          return { ...base, read: u.tree, match, instance: u.instance, generation: u.generation };
        }),
      );
    },

    logs(env: EnvRef, _target: string, _maxBytes: number, signal: AbortSignal) {
      return readAnswer(dir, env.environment, 'logs', signal, () => ({ bytes: 0, text: '' }));
    },
  };
}

// ---- the harness routes' halves (SEAM.md §247) ----------------------------------------------

// GET …/deploy/environments/:e: the target, every call, the admission.
export function adapterReport(dir: string | null, env: string): { target: State['target']; calls: Call[]; admission: State['admission'] } {
  const state = dir === null ? fresh() : load(dir, env);
  return { target: state.target, calls: calls.get(env) ?? [], admission: state.admission };
}

const needDir = (dir: string | null): string => {
  if (dir === null) throw new Refusal(409, 'illegal_transition', 'The scripted deployment adapter has no scripted directory.', 'Start the engine with --harness-scripted.', {});
  return dir;
};

function parseUnit(v: unknown, i: number): Unit {
  if (!isObject(v) || typeof v.name !== 'string' || v.name === '') throw invalid(`units[${i}].name`, 'must name the unit');
  const state = v.state ?? 'active';
  if (!(STATES as readonly string[]).includes(state as string)) throw invalid(`units[${i}].state`, `must be one of ${STATES.join(', ')}`);
  const inst = (x: unknown, f: string): Instance | Unread => {
    if (x === 'unread') return 'unread';
    if (isObject(x) && Number.isInteger(x.pid) && Number.isInteger(x.start_time)) return { pid: x.pid as number, start_time: x.start_time as number };
    throw invalid(`units[${i}].${f}`, 'must be {pid, start_time} or "unread"');
  };
  return {
    name: v.name,
    state: state as Unit['state'],
    invocation_id: (v.invocation_id as string | undefined) ?? randomBytes(16).toString('hex'),
    cgroup: (v.cgroup as string | undefined) ?? `/user.slice/app.slice/${v.name}`,
    pending_job: (v.pending_job as boolean | Unread | undefined) ?? false,
    generation: (v.generation as number | Unread | undefined) ?? generationOf(v.name),
    instance: v.instance === undefined ? 'unread' : inst(v.instance, 'instance'),
    init: v.init === undefined ? 'unread' : inst(v.init, 'init'),
    tree: (v.tree as string | Unread | undefined) ?? 'unread',
  };
}

// POST …/deploy/environments/:e/target: the target replaced.
export function setTarget(dir: string | null, env: string, body: unknown): { target: State['target'] } {
  const d = needDir(dir);
  if (!isObject(body) || !Array.isArray(body.units)) throw invalid('units', 'must be an array of units');
  if (body.complete !== undefined && typeof body.complete !== 'boolean') throw invalid('complete', 'must be a boolean');
  const state = load(d, env);
  state.target = { complete: (body.complete as boolean | undefined) ?? true, units: body.units.map(parseUnit) };
  save(d, env, state);
  return { target: state.target };
}

// POST …/deploy/environments/:e/answers {call, answers}: appended.
export function addAnswers(dir: string | null, env: string, body: unknown): { queued: number } {
  const d = needDir(dir);
  if (!isObject(body) || !(CALLS as readonly string[]).includes(body.call as string)) throw invalid('call', `must be one of ${CALLS.join(', ')}`);
  if (!Array.isArray(body.answers)) throw invalid('answers', 'must be an array');
  const call = body.call as CallName;
  const effect = call === 'deploy' || call === 'teardown';
  const answers = body.answers.map((a, i): Answer => {
    if (!isObject(a)) throw invalid(`answers[${i}]`, 'must be an object');
    const known = effect ? ['result', 'apply', 'hang', 'output_bytes'] : ['failure', 'hang', 'output_bytes', 'value'];
    for (const k of Object.keys(a)) if (!known.includes(k)) throw new Refusal(400, 'unknown_field', `"${k}" is not a field of a ${call} answer.`, `Send only ${known.join(', ')}.`, { field: `answers[${i}].${k}` });
    if (effect && !(RESULTS as readonly string[]).includes(a.result as string)) throw invalid(`answers[${i}].result`, `must be one of ${RESULTS.join(', ')}`);
    if (a.failure !== undefined && !FAILURES.includes(a.failure as AdapterReadFailure)) throw invalid(`answers[${i}].failure`, `must be one of ${FAILURES.join(', ')}`);
    for (const b of ['apply', 'hang']) if (a[b] !== undefined && typeof a[b] !== 'boolean') throw invalid(`answers[${i}].${b}`, 'must be a boolean');
    if (a.output_bytes !== undefined && (!Number.isInteger(a.output_bytes) || (a.output_bytes as number) < 0)) throw invalid(`answers[${i}].output_bytes`, 'must be a non-negative integer');
    return a as Answer;
  });
  const state = load(d, env);
  state.answers[call] = [...(state.answers[call] ?? []), ...answers];
  save(d, env, state);
  return { queued: state.answers[call]!.length };
}

// POST …/deploy/environments/:e/admission {answer}.
export function setAdmission(dir: string | null, env: string, body: unknown): { admission: string } {
  const d = needDir(dir);
  if (!isObject(body) || (body.answer !== 'granted' && body.answer !== 'held')) throw invalid('answer', 'must be granted or held');
  const state = load(d, env);
  state.admission = body.answer;
  save(d, env, state);
  return { admission: state.admission };
}

export const scriptedAdmission = (dir: string | null, env: string): 'granted' | 'held' => (dir === null ? 'granted' : load(dir, env).admission);
