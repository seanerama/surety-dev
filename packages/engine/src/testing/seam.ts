// The engine side of the test seam (build spec §8, SEAM.md §§7, 12–18). Every
// harness-only behaviour lives in this folder, and production code reaches it
// only by importing this module and calling its functions at the points where
// the harness has a hook: the command line hands over the --harness flags; the
// API server offers a request no production route matched and its engine
// description; the store worker offers an operation it does not know and a
// message channel; the migration runner, the event writer, the scheduler, the
// choke point and the run-end protocol reach their barrier and fault points;
// the clock asks for its offset; the choke point asks which backends exist and
// what the execution boundary reports. Outside harness mode every function
// here does nothing, or refuses, or reports nothing qualified, by its own
// check.
//
// The module runs in two threads. The main thread owns the barrier registry
// that GET /v1/harness/barriers reports and releases; the store worker reaches
// the migration barrier and the fault points of transactions. They share one
// SharedArrayBuffer so a paused worker can block synchronously inside its
// transaction until released, and another that holds the controlled clock's
// offset, so both threads take the same time.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Database } from 'better-sqlite3';

import { repoContext } from '../git/exec.js';
import { integrationCheckouts } from '../git/integrity.js';
import { branchHead } from '../git/worktree.js';
import type { Baseline } from '../store/transitions/repo.js';
import type { BackendSpec, DomainObservation } from '../invoke/backend.js';
import { markedProcesses } from '../invoke/processes.js';
import { Refusal } from '../refusal.js';
import { holdSecret, registerDetector } from '../records/redact.js';
import type { Runtime } from '../runtime.js';
import type { StoreClient } from '../store/client.js';
import { appendCorrection } from '../store/transitions/ledger.js';
import { type Actor, transact } from '../store/transitions/tx.js';
import type { ResultInput } from '../store/transitions/baseline.js';
import type { ProtectedSet } from '../store/transitions/protected.js';
import { protectedSetAt } from '../protected/set.js';
import {
  type PlanBody,
  type ProjectBody,
  allocateFixtureReceipt,
  applyFixtureTransition,
  findingProject,
  installAlphaException,
  installCheckResult,
  installClassification,
  installEnvironment,
  installObservation,
  installFixtureChecks,
  installFixturePlan,
  installFixtureProject,
  installFixtureTrigger,
  installReuse,
  installScopeApproval,
  parseAlphaException,
  parsePlanBody,
  parseProjectBody,
  parseResultBody,
  projectRepo,
} from './fixtures.js';

// Barriers reached in the store worker, and those reached in the main thread.
const WORKER_BARRIERS = ['migration.before_commit'] as const;
const JOURNAL_KINDS = ['ref_update', 'commit_tree', 'worktree_add', 'worktree_remove'] as const;
const JOURNAL_BOUNDARIES = ['intent_committed', 'effect_applied', 'receipt_committed', 'probe_confirmed', 'finalizer_committed', 'reconciled'] as const;
const MAIN_BARRIERS: readonly string[] = [
  'dispatch.run_created',
  'dispatch.domain_allocated',
  'dispatch.receipt_committed',
  'launch.before_spawn',
  'launch.before_ownership',
  'run.result_received',
  'run_end.before_ended',
  // SEAM.md §56: a streamed record's four crash points.
  'stream.before_registration',
  'stream.chunk_durable',
  'stream.before_rename',
  'stream.published',
  // SEAM.md §§76, 82: between a decision's consumption and its effect; a
  // notification's delivery.
  'intent.recorded',
  'notify.before_delivery',
  'notify.delivered',
  // SEAM.md §§33, 45: one per journal kind and boundary.
  ...JOURNAL_KINDS.flatMap((kind) => JOURNAL_BOUNDARIES.map((boundary) => `journal.${kind}.${boundary}`)),
];
const BARRIER_NAMES: readonly string[] = [...WORKER_BARRIERS, ...MAIN_BARRIERS];
const PROBE_OUTCOMES = ['absent', 'applied', 'partial', 'conflicting', 'unknown'];
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
  // The controlled clock's offset in milliseconds (one BigInt64 cell).
  clock: SharedArrayBuffer | null;
  // --harness-scripted: the scripted backend's directory (SEAM.md §13).
  scripted: string | null;
  // --harness-probe: the outcome every probe of a journal kind reports.
  probes: Record<string, string>;
}

// A fault fires for the next `times` matching transactions or reads (SEAM.md
// §61), then is gone.
type FaultSpec =
  | { point: 'before_event'; event_type: string }
  | { point: 'audit_write' }
  | { point: 'budget_read'; project: string }
  | { point: 'status_read'; project: string }
  | { point: 'lease_read' };
type Fault = FaultSpec & { times: number; remaining: number };
type TickFault = { point: 'tick_step'; step: 'recover' | 'journal' | 'integrity'; project: string; delay_ms: number };

// A failure the seam injects. It is not a Refusal, so the transaction it
// interrupts rolls back and is reported like any other store failure.
class InjectedFault extends Error {
  constructor(what: string) {
    super(`injected fault: ${what}`);
  }
}

let init: SeamInit = { harness: false, barriers: [], shared: null, clock: null, scripted: null, probes: {} };
let clockCell: BigInt64Array | null = null;
let post: ((message: SeamMessage) => void) | null = null;
const faults: Fault[] = [];
const tickFaults: TickFault[] = [];

type SeamMessage = { seam: 'barrier'; name: string; state: BarrierState };

const notFound = (what: string) => new Refusal(404, 'not_found', `${what} exists only in harness mode.`, 'Start the engine with --harness.');

function adopt(value: SeamInit): void {
  init = value;
  clockCell = value.clock ? new BigInt64Array(value.clock) : null;
}

// ---- command line (main thread) ---------------------------------------------

// Parse `--harness-barrier name=action`. Returns null for an unknown barrier
// or action.
function parseBarrier(value: string, slot: number): BarrierSpec | null {
  const at = value.lastIndexOf('=');
  if (at <= 0) return null;
  const name = value.slice(0, at);
  const action = value.slice(at + 1);
  if (!BARRIER_NAMES.includes(name)) return null;
  if (action !== 'pause' && action !== 'kill') return null;
  return { name, action, slot };
}

const registry = new Map<string, { spec: BarrierSpec; state: BarrierState; resume?: () => void }>();

// The command line's --harness flag, --harness-barrier values and
// --harness-scripted directory. Returns a usage problem to report, or null.
// Called once, before the engine starts.
export function configureHarness(harness: boolean, barrierValues: string[], scripted: string | null = null, probeValues: string[] = []): string | null {
  const barriers: BarrierSpec[] = [];
  for (const value of barrierValues) {
    const spec = parseBarrier(value, barriers.length);
    if (!spec) return `unknown barrier or action in --harness-barrier ${value}`;
    if (barriers.some((b) => b.name === spec.name)) return `barrier ${spec.name} is armed twice`;
    barriers.push(spec);
  }
  const probes: Record<string, string> = {};
  for (const value of probeValues) {
    const at = value.indexOf('=');
    const kind = value.slice(0, at);
    const outcome = value.slice(at + 1);
    if (at <= 0 || !(JOURNAL_KINDS as readonly string[]).includes(kind) || !PROBE_OUTCOMES.includes(outcome)) return `unknown journal kind or outcome in --harness-probe ${value}`;
    probes[kind] = outcome;
  }
  if (!harness && (barriers.length > 0 || scripted !== null || probeValues.length > 0)) return 'harness flags are accepted only with --harness';
  const shared = harness && barriers.length > 0 ? new SharedArrayBuffer(4 * barriers.length) : null;
  adopt({ harness, barriers: harness ? barriers : [], shared, clock: harness ? new SharedArrayBuffer(8) : null, scripted: harness ? scripted : null, probes: harness ? probes : {} });
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

// POST /v1/harness/barriers (SEAM.md §33): arm a main-thread barrier while
// the engine runs, or arm it again after it fired or was released.
function armBarrier(body: unknown): { barriers: ReturnType<typeof listBarriers> } {
  const b = isObject(body) ? body : {};
  const name = b.name;
  const action = b.action;
  if (typeof name !== 'string' || !MAIN_BARRIERS.includes(name) || (action !== 'pause' && action !== 'kill')) {
    throw new Refusal(400, 'invalid_value', 'Unknown barrier or action.', 'Send {"name": <a barrier the engine reaches on its main thread>, "action": "pause"|"kill"}.', { field: 'name' });
  }
  const existing = registry.get(name);
  if (existing && existing.state === 'waiting') {
    throw new Refusal(409, 'illegal_transition', `Barrier "${name}" is waiting.`, 'Release it first.', { barrier: name });
  }
  registry.set(name, { spec: { name, action, slot: -1 }, state: 'armed' });
  return { barriers: listBarriers() };
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
  if (entry.resume) {
    entry.resume();
    return;
  }
  const cells = new Int32Array(init.shared!);
  Atomics.store(cells, entry.spec.slot, 1);
  Atomics.notify(cells, entry.spec.slot);
}

// A barrier point in the main thread (SEAM.md §18). Fires once, the first
// time it is reached: `kill` makes the engine send itself SIGKILL; `pause`
// waits until released while the API keeps answering.
export async function pausePoint(name: string): Promise<void> {
  if (!init.harness) return;
  const entry = registry.get(name);
  if (!entry || entry.state !== 'armed') return;
  if (entry.spec.action === 'kill') {
    entry.state = 'fired';
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  entry.state = 'waiting';
  await new Promise<void>((resolve) => {
    entry.resume = resolve;
  });
}

// ---- clock (both threads) ---------------------------------------------------

// The controlled clock's offset from the system clock (SEAM.md §18): zero
// outside harness mode and until the clock is advanced.
export function clockOffsetMs(): number {
  return clockCell ? Number(Atomics.load(clockCell, 0)) : 0;
}

// ---- backends and the execution boundary (main thread) ----------------------

// The backends a dispatch may use. In M1 the only one is the scripted backend,
// and only with --harness --harness-scripted (SEAM.md §§12, 13).
export function seamBackends(): BackendSpec[] {
  if (!init.harness || init.scripted === null) return [];
  return [{ id: 'scripted', version: 'scripted-1', command: process.execPath, args: [join(init.scripted, 'child.mjs')] }];
}

const INSTRUCTIONS = ['auto', 'running', 'terminated', 'unknown'];

// The scripted execution boundary (SEAM.md §14), asked per domain. Its
// instructions are read every time, never cached. Outside harness mode there
// is no boundary, and nothing can be observed: `unknown`.
export function seamObserveDomain(domain: string): DomainObservation {
  if (!init.harness || init.scripted === null) return 'unknown';
  let instructions: { default?: unknown; domains?: Record<string, unknown> } = {};
  try {
    instructions = JSON.parse(readFileSync(join(init.scripted, 'boundary.json'), 'utf8')) as typeof instructions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
  }
  const given = instructions.domains?.[domain] ?? instructions.default ?? 'auto';
  const instruction = typeof given === 'string' && INSTRUCTIONS.includes(given) ? given : 'unknown';
  if (instruction !== 'auto') return instruction as DomainObservation;
  const live = markedProcesses(domain);
  if (live === null) return 'unknown';
  return live.length > 0 ? 'running' : 'terminated';
}

// ---- the scripted notification sink (main thread; SEAM.md §82) --------------------

// The project's external notification channel: in harness mode, the program
// notify.mjs in the scripted directory, if it is there. null: no channel.
export function seamNotifyChannel(): string | null {
  if (!init.harness || init.scripted === null) return null;
  try {
    readFileSync(join(init.scripted, 'notify.mjs'));
    return 'scripted';
  } catch {
    return null;
  }
}

const NOTIFY_DEADLINE_MS = 10_000;

// One call of the sink, as one process with an argument array and a
// deadline, never a shell: its exit status, or null for a signal, a
// timeout or a program that could not be run (the sink cannot say).
export function seamNotify(mode: 'deliver' | 'lookup', notification: { key: string; decision: string }): Promise<number | null> {
  if (seamNotifyChannel() === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [join(init.scripted!, 'notify.mjs'), mode, ...(mode === 'lookup' ? [notification.key] : [])], {
        cwd: init.scripted!,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, NOTIFY_DEADLINE_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(signal !== null ? null : code);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(mode === 'deliver' ? `${JSON.stringify(notification)}\n` : '');
  });
}

// ---- the journal's probes (main thread) ----------------------------------------

// --harness-probe (SEAM.md §45): the outcome every probe of the journal kind
// reports while this engine runs, whatever git holds; null outside harness
// mode and for a kind not named.
export function seamProbeOutcome(kind: string): string | null {
  if (!init.harness) return null;
  return init.probes[kind] ?? null;
}

// ---- the scheduler's prerequisite steps (main thread) -----------------------

// A tick_step fault (SEAM.md §18): the next time the step runs for that
// project it takes this much longer.
export async function seamStepDelay(step: string, project: string): Promise<void> {
  if (!init.harness || tickFaults.length === 0) return;
  const i = tickFaults.findIndex((f) => f.step === step && f.project === project);
  if (i < 0) return;
  const [fault] = tickFaults.splice(i, 1);
  await sleep(fault!.delay_ms);
}

// ---- API server (main thread) -----------------------------------------------

// What a seam route needs from the server for the request it was offered.
export interface SeamRequestHooks {
  // Reads the JSON body; this is when `100 Continue` is sent.
  body: () => Promise<unknown>;
  store: () => StoreClient;
  actor: Actor;
  // The engine home and its scratch directory.
  scratch: () => { home: string; scratch: string };
  // The running engine's services, for the routes that act through them.
  runtime: () => Runtime;
}

export interface SeamRoute {
  // Answers while the engine is still in restricted mode.
  restricted: boolean;
  handler: () => Promise<{ status: number; body: unknown }>;
}

// Store operations the seam's routes run in the worker (seamStoreOp).
const OP = {
  fixtureProject: 'harness.fixture_project',
  fixtureTrigger: 'harness.fixture_trigger',
  fixturePlan: 'harness.fixture_plan',
  fixtureChecks: 'harness.fixture_checks',
  fixtureResult: 'harness.fixture_result',
  fixtureEnvironment: 'harness.fixture_environment',
  fixtureObservation: 'harness.fixture_observation',
  fixtureClassification: 'harness.fixture_classification',
  fixtureApproval: 'harness.fixture_approval',
  fixtureAlphaException: 'harness.fixture_alpha_exception',
  fixtureReuse: 'harness.fixture_reuse',
  findingProject: 'harness.finding_project',
  projectRepo: 'harness.project_repo',
  workTransition: 'harness.work_transition',
  allocate: 'harness.allocate',
  armFault: 'harness.arm_fault',
  clearFaults: 'harness.clear_faults',
  correction: 'harness.ledger_correction',
} as const;

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function advanceClock(body: unknown): { now: string } {
  const seconds = isObject(body) ? body.seconds : undefined;
  if (!isObject(body) || Object.keys(body).some((k) => k !== 'seconds') || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) {
    throw new Refusal(400, 'invalid_value', '"seconds" must be a positive integer.', 'Send {"seconds": <n>}.', { field: 'seconds' });
  }
  Atomics.add(clockCell!, 0, BigInt(seconds * 1000));
  return { now: new Date(Date.now() + clockOffsetMs()).toISOString() };
}

function armTickFault(body: Record<string, unknown>): TickFault {
  const ok =
    Object.keys(body).every((k) => ['point', 'step', 'project', 'delay_ms', 'times'].includes(k)) &&
    (body.times === undefined || (typeof body.times === 'number' && Number.isInteger(body.times) && body.times >= 1)) &&
    (body.step === 'recover' || body.step === 'journal' || body.step === 'integrity') &&
    typeof body.project === 'string' &&
    typeof body.delay_ms === 'number' &&
    Number.isInteger(body.delay_ms) &&
    body.delay_ms >= 0;
  if (!ok) throw new Refusal(400, 'invalid_value', 'Unknown tick_step fault.', 'Send {"point":"tick_step","step":"recover"|"journal"|"integrity","project":...,"delay_ms":<n>}.', { field: 'point' });
  const fault: TickFault = { point: 'tick_step', step: body.step as TickFault['step'], project: body.project as string, delay_ms: body.delay_ms as number };
  for (let i = 0; i < ((body.times as number | undefined) ?? 1); i++) tickFaults.push(fault);
  return fault;
}

// The /v1/harness/... routes (SEAM.md §§7, 15, 18), offered a request no
// production route matched. They pass the same Host and token checks as every
// route and write no api.act event. null: not a seam route, which outside
// harness mode is every request.
export function seamRoute(method: string, segments: string[], hooks: SeamRequestHooks): SeamRoute | null {
  if (!init.harness || segments[0] !== 'v1' || segments[1] !== 'harness') return null;
  const s = segments.slice(2);
  const get = method === 'GET' || method === 'HEAD';
  const post = method === 'POST';
  const route = (status: number, run: (body: unknown) => Promise<unknown>): SeamRoute => ({
    restricted: false,
    handler: async () => ({ status, body: await run(await hooks.body()) }),
  });
  const storeOp = (op: string, args: unknown) => hooks.store().call(op, args);
  if (s.length === 1 && s[0] === 'barriers' && get) {
    return { restricted: true, handler: async () => ({ status: 200, body: { barriers: listBarriers() } }) };
  }
  if (s.length === 1 && s[0] === 'barriers' && post) {
    return { restricted: true, handler: async () => ({ status: 200, body: armBarrier(await hooks.body()) }) };
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
  if (s.length === 1 && s[0] === 'faults' && method === 'DELETE') {
    return {
      restricted: false,
      handler: async () => {
        tickFaults.length = 0;
        await storeOp(OP.clearFaults, {});
        return { status: 200, body: { faults: [] } };
      },
    };
  }
  if (!post) return null;
  if (s.length === 2 && s[0] === 'ledger' && s[1] === 'corrections') {
    return {
      restricted: false,
      handler: async () => {
        const result = (await storeOp(OP.correction, { body: await hooks.body(), actor: hooks.actor })) as { id: string; created: boolean };
        return { status: result.created ? 201 : 200, body: { ledger_row: { id: result.id }, created: result.created } };
      },
    };
  }
  if (s.length === 1 && s[0] === 'backup') {
    // SEAM.md §93: the engine's own backup job, started now rather than at
    // its daily time; answered at once while the backup runs.
    return {
      restricted: false,
      handler: async () => {
        const body = await hooks.body();
        if (body !== undefined && (!isObject(body) || Object.keys(body).length > 0)) {
          throw new Refusal(400, 'invalid_value', 'The backup route takes an empty body.', 'Send {}.', { field: null });
        }
        const rt = hooks.runtime();
        const { backupJob } = await import('../store/backup.js');
        void backupJob(rt);
        return { status: 202, body: { backup: 'started' } };
      },
    };
  }
  if (s.length === 1 && s[0] === 'secrets') {
    return route(200, async (body) => {
      const b = isObject(body) ? body : {};
      if (typeof b.ref !== 'string' || b.ref.length === 0 || typeof b.value !== 'string' || b.value.length === 0 || Object.keys(b).some((k) => k !== 'ref' && k !== 'value')) {
        throw new Refusal(400, 'invalid_value', 'A secret needs a "ref" and a non-empty "value".', 'Send {"ref": <name>, "value": <the secret>}.', { field: 'value' });
      }
      holdSecret(b.ref, b.value);
      // The value is held in memory only and never answered back.
      return { held: b.ref };
    });
  }
  if (s.length === 1 && s[0] === 'detectors') {
    return route(200, async (body) => {
      const b = isObject(body) ? body : {};
      if (typeof b.name !== 'string' || b.name.length === 0 || typeof b.pattern !== 'string' || b.pattern.length === 0 || Object.keys(b).some((k) => k !== 'name' && k !== 'pattern')) {
        throw new Refusal(400, 'invalid_value', 'A detector needs a "name" and a "pattern".', 'Send {"name": <name>, "pattern": <a regular expression>}.', { field: 'pattern' });
      }
      try {
        registerDetector(b.name, b.pattern);
      } catch (err) {
        throw new Refusal(400, 'invalid_value', `The pattern is not a regular expression: ${(err as Error).message}`, 'Send a valid ECMAScript regular expression source.', { field: 'pattern' });
      }
      const rt = hooks.runtime();
      // Registration starts a rescan of the stored records (SEAM.md §57).
      const { rescanRecords } = await import('../records/files.js');
      void rescanRecords(rt).catch(() => {});
      return { detector: b.name, rescan: 'started' };
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'project') {
    return route(201, async (body) => {
      const b = parseProjectBody(body);
      // What the project is installed on: the branch's commit, which the
      // registry will expect, and the developer's checkouts of the branch,
      // which become managed checkouts (SEAM.md §25).
      const ctx = repoContext(b.dev_repo_path);
      const head = await branchHead(ctx, b.integration_branch);
      if (head === null) throw new Refusal(409, 'repo_unreadable', 'The fixture repository or its integration branch could not be read.', 'Check the fixture repository.', { path: b.dev_repo_path });
      const checkouts = await integrationCheckouts(hooks.scratch(), b.dev_repo_path, b.integration_branch);
      if (checkouts === null) throw new Refusal(409, 'repo_unreadable', 'The fixture repository could not be read.', 'Check the fixture repository.', { path: b.dev_repo_path });
      const protectedSet = await protectedSetAt(b.dev_repo_path, head);
      if (protectedSet === null) throw new Refusal(409, 'repo_unreadable', 'The protected set of the fixture repository could not be read.', 'Check the fixture repository.', { path: b.dev_repo_path });
      return storeOp(OP.fixtureProject, { body: b, head, checkouts, protectedSet, actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'trigger') {
    return {
      restricted: false,
      handler: async () => {
        const result = (await storeOp(OP.fixtureTrigger, { body: await hooks.body(), actor: hooks.actor })) as { created: boolean };
        return { status: result.created ? 201 : 200, body: result };
      },
    };
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'plan') {
    return route(201, async (body) => {
      const plan = parsePlanBody(body);
      const repo = (await storeOp(OP.projectRepo, { project: plan.project })) as { repo: string; branch: string } | null;
      if (!repo) throw new Refusal(404, 'not_found', `No project "${plan.project}".`, 'Install the project first.', { project: plan.project });
      const base = await branchHead(repoContext(repo.repo), repo.branch);
      if (base === null) throw new Refusal(409, 'repo_unreadable', 'The project repository could not be read.', 'Check the fixture repository.', { project: plan.project });
      return storeOp(OP.fixturePlan, { ...plan, baseRevision: base, actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'checks') return route(201, (body) => storeOp(OP.fixtureChecks, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'check-result') {
    return route(201, async (body) => {
      const parsed = parseResultBody(body);
      const { outputText, ...result } = parsed;
      // The output is published through the record path before the result
      // names it (SEAM.md §67).
      let output: string | null = null;
      if (outputText !== null) {
        const rt = hooks.runtime();
        const { writeWholeRecord } = await import('../records/files.js');
        output = await writeWholeRecord(rt, { project: result.project, run: null, kind: 'check_output', content: Buffer.from(outputText) });
      }
      return storeOp(OP.fixtureResult, { args: { ...result, output }, actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'environment') return route(201, (body) => storeOp(OP.fixtureEnvironment, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'observation') return route(201, (body) => storeOp(OP.fixtureObservation, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'classification') return route(200, (body) => storeOp(OP.fixtureClassification, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'approval') return route(201, (body) => storeOp(OP.fixtureApproval, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'evidence-reuse') return route(201, (body) => storeOp(OP.fixtureReuse, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'alpha-exception') {
    return route(201, async (body) => {
      const parsed = parseAlphaException(body);
      const project = (await storeOp(OP.findingProject, { finding: parsed.finding })) as string | null;
      if (project === null) throw new Refusal(404, 'not_found', `No finding "${parsed.finding}".`, 'Check the finding id.', { finding: parsed.finding });
      const rt = hooks.runtime();
      const { writeWholeRecord } = await import('../records/files.js');
      const record = await writeWholeRecord(rt, { project, run: null, kind: 'containment_evidence', content: Buffer.from(parsed.containment) });
      return storeOp(OP.fixtureAlphaException, { args: { finding: parsed.finding, record, purpose: parsed.purpose }, actor: hooks.actor });
    });
  }
  if (s.length === 3 && s[0] === 'work' && s[2] === 'transition') {
    return route(200, (body) => storeOp(OP.workTransition, { workItem: decodeSegment(s[1]!), body, actor: hooks.actor }));
  }
  if (s.length === 2 && s[0] === 'clock' && s[1] === 'advance') return route(200, async (body) => advanceClock(body));
  if (s.length === 1 && s[0] === 'allocate') return route(200, (body) => storeOp(OP.allocate, { body, actor: hooks.actor }));
  if (s.length === 1 && s[0] === 'faults') {
    return route(200, async (body) => ({
      armed: isObject(body) && body.point === 'tick_step' ? armTickFault(body) : await storeOp(OP.armFault, body),
    }));
  }
  return null;
}

// GET /v1/engine reports whether the engine is in harness mode.
export function seamDescribe<T extends object>(info: T): T & { harness: boolean } {
  return { ...info, harness: init.harness };
}

// ---- store worker -----------------------------------------------------------

export function configureWorker(given: SeamInit, send: (message: unknown) => void): void {
  adopt(given);
  post = send;
}

// A store operation the worker does not know. Outside harness mode, or for an
// operation the seam does not define either, it is refused as unknown.
export function seamStoreOp(op: string, args: unknown, store: () => Database): unknown {
  if (!init.harness) throw new Error(`unknown store op ${op}`);
  const a = args as { body: unknown; actor: Actor } & Record<string, unknown>;
  switch (op) {
    case OP.fixtureProject:
      return installFixtureProject(store(), a.actor, a as unknown as { body: ProjectBody; head: string; checkouts: { path: string; baseline: Baseline }[]; protectedSet: ProtectedSet });
    case OP.fixtureTrigger:
      return installFixtureTrigger(store(), a.actor, a.body);
    case OP.fixturePlan:
      return installFixturePlan(store(), a.actor, a as unknown as PlanBody & { baseRevision: string });
    case OP.fixtureChecks:
      return installFixtureChecks(store(), a.actor, a.body);
    case OP.fixtureResult:
      return installCheckResult(store(), a.actor, a.args as unknown as ResultInput);
    case OP.fixtureEnvironment:
      return installEnvironment(store(), a.actor, a.body);
    case OP.fixtureObservation:
      return installObservation(store(), a.actor, a.body);
    case OP.fixtureClassification:
      return installClassification(store(), a.actor, a.body);
    case OP.fixtureApproval:
      return installScopeApproval(store(), a.actor, a.body);
    case OP.fixtureAlphaException:
      return installAlphaException(store(), a.actor, a.args as { finding: string; record: string; purpose: string });
    case OP.fixtureReuse:
      return installReuse(store(), a.actor, a.body);
    case OP.findingProject:
      return findingProject(store(), a.finding as string);
    case OP.projectRepo:
      return projectRepo(store(), a.project as string);
    case OP.workTransition:
      return applyFixtureTransition(store(), a.actor, { workItem: a.workItem as string, body: a.body });
    case OP.allocate:
      return allocateFixtureReceipt(store(), a.actor, a.body);
    case OP.armFault:
      return armFault(args);
    case OP.clearFaults:
      faults.length = 0;
      return { cleared: true };
    case OP.correction:
      return transact(store(), a.actor, (tx) => appendCorrection(tx, (isObject(a.body) ? a.body : {}) as Parameters<typeof appendCorrection>[1]));
    default:
      throw new Error(`unknown store op ${op}`);
  }
}

// A named point in the store worker the engine pauses at until released, or
// kills itself at.
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

function armFault(fault: unknown): FaultSpec & { times: number } {
  if (!init.harness) throw notFound('Fault injection');
  const f = isObject(fault) ? fault : {};
  const times = f.times === undefined ? 1 : f.times;
  const keys = Object.keys(f).filter((k) => k !== 'times');
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  let parsed: FaultSpec | null = null;
  if (f.point === 'before_event' && typeof f.event_type === 'string' && f.event_type.length > 0 && only('point', 'event_type')) {
    parsed = { point: 'before_event', event_type: f.event_type };
  } else if (f.point === 'audit_write' && only('point')) {
    parsed = { point: 'audit_write' };
  } else if (f.point === 'budget_read' && typeof f.project === 'string' && only('point', 'project')) {
    parsed = { point: 'budget_read', project: f.project };
  } else if (f.point === 'status_read' && typeof f.project === 'string' && only('point', 'project')) {
    parsed = { point: 'status_read', project: f.project };
  } else if (f.point === 'lease_read' && only('point')) {
    parsed = { point: 'lease_read' };
  }
  if (!parsed || typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    throw new Refusal(
      400,
      'invalid_value',
      'Unknown fault.',
      'Send {"point":"before_event","event_type":...}, {"point":"audit_write"}, {"point":"budget_read","project":...}, {"point":"status_read","project":...}, {"point":"lease_read"} or {"point":"tick_step",...}, each with an optional "times".',
      { field: 'point' },
    );
  }
  faults.push({ ...parsed, times, remaining: times });
  return { ...parsed, times };
}

// Fail the enclosing transaction or read if an armed fault matches.
function fire(matches: (f: Fault) => boolean, what: string): void {
  if (!init.harness || faults.length === 0) return;
  const i = faults.findIndex(matches);
  if (i < 0) return;
  const fault = faults[i]!;
  fault.remaining -= 1;
  if (fault.remaining <= 0) faults.splice(i, 1);
  throw new InjectedFault(what);
}

// A budget check reads a project's spend (SEAM.md §61).
export function seamBudgetRead(project: string): void {
  fire((f) => f.point === 'budget_read' && f.project === project, `budget read of ${project}`);
}

// A read computes a project's NOW (SEAM.md §107).
export function seamStatusRead(project: string): void {
  fire((f) => f.point === 'status_read' && f.project === project, `status read of ${project}`);
}

// A launch reads the run's lease before its spawn (SEAM.md §61).
export function seamLeaseRead(): void {
  fire((f) => f.point === 'lease_read', 'lease read');
}

// Called by the event writer just before it appends an event: fails the
// enclosing transaction once if a matching fault is armed.
export function beforeEventWrite(eventType: string): void {
  fire(
    (f) => (f.point === 'before_event' && f.event_type === eventType) || (f.point === 'audit_write' && eventType === 'api.act'),
    eventType === 'api.act' ? 'audit write' : `before event ${eventType}`,
  );
}
