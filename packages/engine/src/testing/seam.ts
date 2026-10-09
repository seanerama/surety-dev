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

import { SELF_TEST_CASES } from '../checks/selftest-cases.js';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
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
import type { ScriptedStep } from '../store/transitions/checks.js';
import { type Discovery, discover, protectedVersionAt } from '../checks/discovery.js';
import {
  type PlanBody,
  type ProjectBody,
  allocateFixtureReceipt,
  applyFixtureTransition,
  findingProject,
  installAlphaException,
  installCheckResult,
  installClassification,
  executionProject,
  installScriptedStep,
  parseScriptedStep,
  parseClassification,
  parseRunnerQualification,
  installRunnerQualification,
  parseLegacyFingerprint,
  installLegacyFingerprint,
  versionSourceOf,
  proposalTree,
  installEnvironment,
  installObservation,
  installFixtureChecks,
  installFixturePlan,
  installFixtureProject,
  installFixtureTrigger,
  installReuse,
  installScopeApproval,
  installAttempt,
  installTrustEntry,
  parseAttemptFixture,
  parseEntryFixture,
  type AttemptFixture,
  type EntryFixture,
  parseAlphaException,
  parsePlanBody,
  parseProjectBody,
  parseResultBody,
  projectRepo,
} from './fixtures.js';
import { addScript, callReport, changeTarget, resetScripted, scriptedAdmission, scriptedBounds, scriptedDeploymentAdapter, setAdmission, setBounds } from './deploy-adapter.js';
import { installAdapterQualification, installFixtureAuthorization, lapseAdapterQualification, parseAdapterQualification } from './deploy-fixtures.js';

// Barriers reached in the store worker, and those reached in the main thread.
const WORKER_BARRIERS = ['migration.before_commit', 'checks.registered'] as const;
// Worker barriers a test may also arm while the engine runs (SEAM.md §184).
const WORKER_RUNTIME_BARRIERS: readonly string[] = ['checks.registered'];
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
  // M2 plan §2.3: the launch boundaries of D2 §3.2, the init's start of the
  // backend, the record of termination, and the incarnation scope's creation
  // (before the lock and the listener, so only `kill` can be released there).
  'init.before_backend',
  'boundary.before_terminated',
  // M2 plan §2.3: before collection reads the volatile filesystem (I18), and
  // before a qualification attempt dispatches a canary.
  'collect.before_read',
  'qualification.before_dispatch',
  // SEAM.md §184: a nomination's and a protected application's finalizer.
  'nomination.before_finalizer',
  'nomination.finalized',
  'protected_application.before_finalizer',
  'protected_application.finalized',
  // SEAM.md §218: an approved proposal's application is due, its approval
  // recorded, before the revalidation of its binding.
  'protected_application.before_revalidation',
  // M3 plan §2.3: around a check tree's materialization.
  'checks.before_materialize',
  'checks.materialized',
  // SEAM.md §205: the init's `started` report arrived, before and after the
  // transaction that records it; after the transaction that records its exit
  // report, before the domain's termination begins.
  'checks.before_started',
  'checks.started',
  'checks.exit_recorded',
  // SEAM.md §193: an evaluation's facts read, its transaction not begun.
  'gate.facts_read',
  // M4 plan §2.3: the deployment's boundaries (BS4 §8).
  'deploy.requested',
  'deploy.intended',
  'deploy.attempt_recorded',
  'adapter.before_host_call',
  'adapter.after_host_call',
  'deploy.receipt_recorded',
  'deploy.confirmed',
  'deploy.before_finalizer',
  'deploy.round_registered',
  'verify.after_first_read',
  'verify.before_second_read',
  'deploy.before_completion',
];
// SEAM.md §125: barriers the launcher reaches and waits at itself. Its wait
// survives the engine: it marks it with a file under the home's release
// directory, and any incarnation lists and releases it there.
const LAUNCHER_BARRIERS: readonly string[] = ['launcher.before_placement', 'launcher.placed', 'launcher.before_authorization', 'launcher.authorized'];
// SEAM.md §124: the scope's barrier, before the listener, released by a file.
const SCOPE_BARRIER = 'scope.before_create';
const BARRIER_NAMES: readonly string[] = [...WORKER_BARRIERS, ...MAIN_BARRIERS, ...LAUNCHER_BARRIERS, SCOPE_BARRIER];
const RELEASE_DIR = 'harness-release';
let barrierHome: string | null = null;
// Launcher barriers already handed to a launcher: each fires once.
const handedOut = new Set<string>();
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
  // --harness-host-checks and --harness-host-check (SEAM.md §114).
  hostChecks: { mode: 'unrun' | 'run'; forced: Record<string, 'failed' | 'not_exercised'> };
  // SEAM.md §§150, 152: a template version per backend, the host identity,
  // a mechanism variant, collection bounds below their ranges.
  switches?: HarnessSwitches;
}

export interface HarnessSwitches {
  templateVersions: Record<string, string>;
  hostId: string | null;
  mechanismVariant: string | null;
  collectBounds: { entries: number; bytes: number } | null;
  // `--harness-checktrees-max-bytes <n>` (SEAM.md §200): checktrees_max_bytes
  // for this start, below its configured range.
  checktreesMaxBytes?: number | null;
  // SEAM.md §208: `--harness-runner-self-test run`, the forced results of
  // `--harness-runner-self-test-case`, `--harness-check-profile-variant`;
  // §212: `--harness-check-domain-limits`.
  runnerSelfTest?: boolean;
  selfTestForced?: Record<string, 'failed' | 'not_exercised'>;
  checkProfileVariant?: string | null;
  checkDomainLimits?: CheckDomainLimits | null;
  // SEAM.md §217: `--harness-classifier-version <n>`.
  classifierVersion?: number | null;
}

export interface CheckDomainLimits {
  pids_max?: number;
  memory_max?: number;
  writable_bytes?: number;
  writable_inodes?: number;
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
// Faults the main thread fires (M2 plan §2.3): the bootstrap route's read of
// the token; the execution boundary's (the user manager unreachable, the
// backend's exit report lost, a challenge's response dropped, a launcher's
// exit that cannot be established).
const MAIN_FAULTS = ['token_read', 'manager_unreachable', 'init_report_lost', 'challenge_response_dropped', 'launcher_wait'] as const;
type MainFault = { point: (typeof MAIN_FAULTS)[number]; times: number; remaining: number; hit: number };

// A failure the seam injects. It is not a Refusal, so the transaction it
// interrupts rolls back and is reported like any other store failure.
class InjectedFault extends Error {
  constructor(what: string) {
    super(`injected fault: ${what}`);
  }
}

let init: SeamInit = { harness: false, barriers: [], shared: null, clock: null, scripted: null, probes: {}, hostChecks: { mode: 'run', forced: {} } };
let clockCell: BigInt64Array | null = null;
let post: ((message: SeamMessage) => void) | null = null;
const faults: Fault[] = [];
const tickFaults: TickFault[] = [];
const mainFaults: MainFault[] = [];
// SEAM.md §224: each read of a candidate's module presence for the project
// fails, as a git read that fails, `times` times.
type PresenceFault = { point: 'module_presence_read'; project: string; times: number; remaining: number; hit: number };
const presenceFaults: PresenceFault[] = [];

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

const registry = new Map<string, { spec: BarrierSpec; state: BarrierState; resume?: () => void; cell?: Int32Array }>();
// Worker barriers armed while the engine runs (worker side).
const runtimeWorkerBarriers = new Map<string, { action: BarrierAction; cell: Int32Array }>();

// The command line's --harness flag, --harness-barrier values and
// --harness-scripted directory. Returns a usage problem to report, or null.
// Called once, before the engine starts.
export function configureHarness(
  harness: boolean,
  barrierValues: string[],
  scripted: string | null = null,
  probeValues: string[] = [],
  hostChecksMode: string | null = null,
  hostCheckValues: string[] = [],
): string | null {
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
  if (hostChecksMode !== null && hostChecksMode !== 'unrun' && hostChecksMode !== 'run') return `--harness-host-checks takes unrun or run, not ${hostChecksMode}`;
  const forced: Record<string, 'failed' | 'not_exercised'> = {};
  for (const value of hostCheckValues) {
    const m = /^(H(?:[1-9]|1[0-3]))=(failed|not_exercised)$/.exec(value);
    if (!m) return `--harness-host-check takes <Hn>=<failed|not_exercised>, not ${value}`;
    forced[m[1]!] = m[2] as 'failed' | 'not_exercised';
  }
  if (!harness && (barriers.length > 0 || scripted !== null || probeValues.length > 0 || hostChecksMode !== null || hostCheckValues.length > 0)) return 'harness flags are accepted only with --harness';
  const shared = harness && barriers.length > 0 ? new SharedArrayBuffer(4 * barriers.length) : null;
  adopt({
    harness,
    barriers: harness ? barriers : [],
    shared,
    clock: harness ? new SharedArrayBuffer(8) : null,
    scripted: harness ? scripted : null,
    probes: harness ? probes : {},
    // In harness mode the host checks are left unrun unless asked for.
    hostChecks: harness ? { mode: (hostChecksMode as 'unrun' | 'run' | null) ?? 'unrun', forced } : { mode: 'run', forced: {} },
  });
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

// The launchers' waits marked under the release directory: `<name>.<pid>.waiting`,
// released by `<name>.<pid>.release`.
function launcherWaits(): { name: string; pid: number; released: boolean; alive: boolean }[] {
  if (barrierHome === null) return [];
  const dir = join(barrierHome, RELEASE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; pid: number; released: boolean; alive: boolean }[] = [];
  for (const file of names) {
    const m = /^(launcher\.[a-z_]+)\.(\d+)\.waiting$/.exec(file);
    if (!m || !LAUNCHER_BARRIERS.includes(m[1]!)) continue;
    out.push({ name: m[1]!, pid: Number(m[2]), released: existsSync(join(dir, `${m[1]}.${m[2]}.release`)), alive: existsSync(`/proc/${m[2]}`) });
  }
  return out;
}

function listBarriers(): { name: string; action: BarrierAction; state: BarrierState }[] {
  const listed = [...registry.values()].filter(({ spec }) => spec.name !== SCOPE_BARRIER).map(({ spec, state }) => ({ name: spec.name, action: spec.action, state }));
  for (const w of launcherWaits()) {
    const state: BarrierState = w.released ? 'released' : w.alive ? 'waiting' : 'fired';
    const at = listed.findIndex((b) => b.name === w.name);
    const action = registry.get(w.name)?.spec.action ?? 'pause';
    if (at >= 0) {
      if (state === 'waiting' || listed[at]!.state === 'armed') listed[at] = { name: w.name, action, state };
    } else listed.push({ name: w.name, action, state });
  }
  return listed;
}

// POST /v1/harness/barriers (SEAM.md §33): arm a main-thread barrier while
// the engine runs, or arm it again after it fired or was released.
function armBarrier(body: unknown, arm: (spec: { name: string; action: BarrierAction; cell: SharedArrayBuffer }) => Promise<unknown>): Promise<{ barriers: ReturnType<typeof listBarriers> }> | { barriers: ReturnType<typeof listBarriers> } {
  const b = isObject(body) ? body : {};
  const name = b.name;
  const action = b.action;
  if (typeof name === 'string' && WORKER_RUNTIME_BARRIERS.includes(name) && (action === 'pause' || action === 'kill')) {
    const existing = registry.get(name);
    if (existing && existing.state === 'waiting') throw new Refusal(409, 'illegal_transition', `Barrier "${name}" is waiting.`, 'Release it first.', { barrier: name });
    // Reached in the store worker: armed there, with its own release cell.
    const cell = new SharedArrayBuffer(4);
    registry.set(name, { spec: { name, action, slot: -1 }, state: 'armed', cell: new Int32Array(cell) });
    return arm({ name, action, cell }).then(() => ({ barriers: listBarriers() }));
  }
  if (typeof name !== 'string' || !(MAIN_BARRIERS.includes(name) || LAUNCHER_BARRIERS.includes(name)) || (action !== 'pause' && action !== 'kill')) {
    throw new Refusal(400, 'invalid_value', 'Unknown barrier or action.', 'Send {"name": <a barrier the engine reaches on its main thread>, "action": "pause"|"kill"}.', { field: 'name' });
  }
  const existing = registry.get(name);
  if (existing && existing.state === 'waiting') {
    throw new Refusal(409, 'illegal_transition', `Barrier "${name}" is waiting.`, 'Release it first.', { barrier: name });
  }
  registry.set(name, { spec: { name, action, slot: -1 }, state: 'armed' });
  handedOut.delete(name);
  return { barriers: listBarriers() };
}

function releaseBarrier(name: string): void {
  // A launcher's wait, this incarnation's launcher's or an earlier one's.
  const waits = launcherWaits().filter((w) => w.name === name && !w.released);
  if (waits.length > 0) {
    for (const w of waits) writeFileSync(join(barrierHome!, RELEASE_DIR, `${w.name}.${w.pid}.release`), '');
    const own = registry.get(name);
    if (own) own.state = 'released';
    return;
  }
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
  if (entry.cell) {
    Atomics.store(entry.cell, 0, 1);
    Atomics.notify(entry.cell, 0);
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

// The scope's barrier (SEAM.md §124): before the lock and the listener, so a
// pause waits for the file `<home>/harness-release/scope.before_create`,
// marking its wait with `scope.before_create.waiting`.
export async function seamScopeBarrier(home: string, reached: boolean): Promise<void> {
  if (!init.harness) return;
  barrierHome = home;
  if (!reached) return;
  const entry = registry.get(SCOPE_BARRIER);
  if (!entry || entry.state !== 'armed') return;
  if (entry.spec.action === 'kill') {
    entry.state = 'fired';
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  entry.state = 'waiting';
  const dir = join(home, RELEASE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SCOPE_BARRIER}.waiting`), '');
  while (!existsSync(join(dir, SCOPE_BARRIER))) await sleep(50);
  entry.state = 'released';
}

// The launcher barriers armed and not yet handed to a launcher, with where
// the launcher marks and awaits its wait (SEAM.md §125). Each is handed out
// once. null outside harness mode: a launcher then waits nowhere.
export function seamLauncherBarriers(home: string): { releaseDir: string; barriers: Record<string, BarrierAction> } | null {
  if (!init.harness) return null;
  barrierHome = home;
  const barriers: Record<string, BarrierAction> = {};
  for (const name of LAUNCHER_BARRIERS) {
    const entry = registry.get(name);
    if (entry && entry.state === 'armed' && !handedOut.has(name)) {
      barriers[name] = entry.spec.action;
      handedOut.add(name);
    }
  }
  const releaseDir = join(home, RELEASE_DIR);
  if (Object.keys(barriers).length > 0) mkdirSync(releaseDir, { recursive: true });
  return { releaseDir, barriers };
}

// A launcher reached a barrier: one armed `kill` makes the engine kill itself.
export function seamLauncherReached(name: string, action: string): void {
  if (!init.harness) return;
  const entry = registry.get(name);
  if (entry) entry.state = action === 'kill' ? 'fired' : 'waiting';
  if (action === 'kill') process.kill(process.pid, 'SIGKILL');
}

// ---- clock (both threads) ---------------------------------------------------

// The controlled clock's offset from the system clock (SEAM.md §18): zero
// outside harness mode and until the clock is advanced.
export function clockOffsetMs(): number {
  return clockCell ? Number(Atomics.load(clockCell, 0)) : 0;
}

// ---- backends and the execution boundary (main thread) ----------------------

// The backends a dispatch may use. In M1 the only one is the scripted backend,
// and only with --harness --harness-scripted (SEAM.md §§12, 13). In the
// sandbox lane it runs inside the real sandbox, with its directory (the test's
// instrument: its program, its scripts and its launch log) bound read-write.
export function seamBackends(): BackendSpec[] {
  if (!init.harness || init.scripted === null) return [];
  return [{ id: 'scripted', version: 'scripted-1', command: process.execPath, args: [join(init.scripted, 'child.mjs')], binds: [{ path: init.scripted, writable: true }] }];
}

// ---- the test caps (E69) -----------------------------------------------------

// A harness-only override of a work item's domains' limits, set on the
// trigger fixture (`domain_limits`), so that the exhaustion cases can run at
// caps below the engine's configured minimums. Outside harness mode there is
// none, and every domain has the configured limits.
export interface DomainLimitOverride {
  pids_max?: number;
  memory_max?: number;
  writable_bytes?: number;
  writable_inodes?: number;
}
const domainLimitOverrides = new Map<string, DomainLimitOverride>();

function parseDomainLimits(v: unknown): DomainLimitOverride {
  const bad = () => new Refusal(400, 'invalid_value', 'domain_limits must be an object of positive integers: pids_max, memory_max, writable_bytes, writable_inodes.', 'Send the caps the case needs.', { field: 'domain_limits' });
  if (!isObject(v)) throw bad();
  const out: DomainLimitOverride = {};
  for (const [k, x] of Object.entries(v)) {
    if (!['pids_max', 'memory_max', 'writable_bytes', 'writable_inodes'].includes(k) || !Number.isSafeInteger(x) || (x as number) <= 0) throw bad();
    (out as Record<string, number>)[k] = x as number;
  }
  return out;
}

export function seamDomainLimits(workItem: string): DomainLimitOverride | null {
  if (!init.harness) return null;
  return domainLimitOverrides.get(workItem) ?? null;
}

// SEAM.md §127: the scripted directory is bound read-write at its own path
// inside every sandbox of a sandbox-lane engine, a real backend's (the
// stand-in's log, SEAM.md §139) included. Nothing outside harness mode.
export function seamSandboxBinds(): { path: string; writable: boolean }[] {
  if (!init.harness || init.scripted === null) return [];
  return [{ path: init.scripted, writable: true }];
}

// The host checks switch and its overrides (SEAM.md §114): null outside
// harness mode, where every start runs the checks.
// Under `unrun` the harness vouches for the host (source "harness").
export function seamHostChecks(): { mode: 'unrun' | 'run'; forced: Record<string, 'failed' | 'not_exercised'>; vouched: 'harness' | null } | null {
  if (!init.harness) return null;
  return { mode: init.hostChecks.mode, forced: { ...init.hostChecks.forced }, vouched: init.hostChecks.mode === 'unrun' ? 'harness' : null };
}

// Which execution boundary holds this engine's runs in harness mode
// (SEAM.md §§14, 114): the scripted one in the kernel lane (`unrun`), the
// real one in the sandbox lane (`run`). null outside harness mode, where
// there is only the real one.
export function seamBoundary(): 'scripted' | 'real' | null {
  if (!init.harness) return null;
  return init.hostChecks.mode === 'unrun' ? 'scripted' : 'real';
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
  proposalTree: 'harness.proposal_tree',
  armWorkerBarrier: 'harness.arm_worker_barrier',
  runnerQualification: 'harness.runner_qualification',
  legacySource: 'harness.legacy_source',
  legacyFingerprint: 'harness.legacy_fingerprint',
  fixtureApproval: 'harness.fixture_approval',
  fixtureAlphaException: 'harness.fixture_alpha_exception',
  fixtureReuse: 'harness.fixture_reuse',
  fixtureAttempt: 'harness.fixture_attempt',
  fixtureTrustEntry: 'harness.fixture_trust_entry',
  listFaults: 'harness.list_faults',
  findingProject: 'harness.finding_project',
  projectRepo: 'harness.project_repo',
  workTransition: 'harness.work_transition',
  allocate: 'harness.allocate',
  armFault: 'harness.arm_fault',
  clearFaults: 'harness.clear_faults',
  correction: 'harness.ledger_correction',
  executionProject: 'harness.execution_project',
  scriptedStep: 'harness.scripted_step',
  adapterQualification: 'harness.adapter_qualification',
  adapterQualificationLapse: 'harness.adapter_qualification_lapse',
  fixtureAuthorization: 'harness.fixture_authorization',
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
    return { restricted: true, handler: async () => ({ status: 200, body: await armBarrier(await hooks.body(), (spec) => storeOp(OP.armWorkerBarrier, spec)) }) };
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
        mainFaults.length = 0;
        presenceFaults.length = 0;
        collectSlowMs = 0;
        streamSlow = null;
        connectHangs.clear();
        await storeOp(OP.clearFaults, {});
        return { status: 200, body: { faults: [] } };
      },
    };
  }
  // M2 plan §2.3: the harness resolver the egress proxy consults instead of
  // the system resolver, and what the engine's echo endpoint received.
  if (s.length === 1 && s[0] === 'resolver' && get) {
    return { restricted: true, handler: async () => ({ status: 200, body: resolverReport() }) };
  }
  if (s.length === 1 && s[0] === 'resolver' && post) {
    return { restricted: true, handler: async () => ({ status: 200, body: configureResolver(await hooks.body()) }) };
  }
  if (s.length === 1 && s[0] === 'echo' && get) {
    return {
      restricted: true,
      handler: async () => {
        const { echoEndpoint, echoView } = await import('../invoke/proxy/echo.js');
        return { status: 200, body: { connections: echoEndpoint.connections.map(echoView) } };
      },
    };
  }
  if (s.length === 1 && s[0] === 'faults' && get) {
    // What is armed, and how often each main-thread fault fired.
    return {
      restricted: true,
      handler: async () => ({
        status: 200,
        body: {
          faults: [
            ...mainFaults.map((f) => ({ point: f.point, times: f.times, remaining: f.remaining, hit: f.hit })),
            ...presenceFaults.map((f) => ({ point: f.point, project: f.project, times: f.times, remaining: f.remaining, hit: f.hit })),
            ...tickFaults.map((f) => ({ ...f })),
            ...((await storeOp(OP.listFaults, {}).catch(() => [])) as unknown[]),
          ],
        },
      }),
    };
  }
  // The scripted deployment adapter's report and reset (BS4 §8).
  if (s.length === 2 && s[0] === 'deploy' && s[1] === 'calls' && get) return { restricted: false, handler: async () => ({ status: 200, body: callReport() }) };
  if (s.length === 1 && s[0] === 'deploy' && method === 'DELETE') {
    return {
      restricted: false,
      handler: async () => {
        await hooks.body();
        resetScripted();
        return { status: 200, body: callReport() };
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
      const cap = b.provider_cap_usd;
      if (
        typeof b.ref !== 'string' ||
        b.ref.length === 0 ||
        typeof b.value !== 'string' ||
        b.value.length === 0 ||
        (cap !== undefined && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) ||
        Object.keys(b).some((k) => k !== 'ref' && k !== 'value' && k !== 'provider_cap_usd')
      ) {
        throw new Refusal(400, 'invalid_value', 'A secret needs a "ref" and a non-empty "value", and optionally a positive "provider_cap_usd".', 'Send {"ref": <name>, "value": <the secret>, "provider_cap_usd"?: <USD>}.', { field: 'value' });
      }
      holdSecret(b.ref, b.value, cap as number | undefined);
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
      const protectedSet = await protectedVersionAt(b.dev_repo_path, head);
      if (protectedSet === null) throw new Refusal(409, 'repo_unreadable', 'The protected set of the fixture repository could not be read.', 'Check the fixture repository.', { path: b.dev_repo_path });
      return storeOp(OP.fixtureProject, { body: b, head, checkouts, protectedSet, actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'trigger') {
    return {
      restricted: false,
      handler: async () => {
        let body = await hooks.body();
        // SEAM.md §139: a raw user report on the trigger, published as a
        // record of the project; the answer names the record. Nothing of it
        // reaches a context package.
        let report: string | null = null;
        // E69: a harness-only override of the item's domains' limits, below
        // the engine's configured minimums (the test caps).
        let limits: DomainLimitOverride | null = null;
        if (isObject(body) && body.domain_limits !== undefined) {
          const { domain_limits: given, ...rest } = body;
          limits = parseDomainLimits(given);
          body = rest;
        }
        if (isObject(body) && body.raw_user_report !== undefined) {
          const { raw_user_report: text, ...rest } = body;
          if (typeof text !== 'string' || text.length === 0 || typeof rest.project !== 'string') {
            throw new Refusal(400, 'invalid_value', 'raw_user_report must be a non-empty string, with the project.', 'Send the report as a string.', { field: 'raw_user_report' });
          }
          const rt = hooks.runtime();
          const { writeWholeRecord } = await import('../records/files.js');
          report = await writeWholeRecord(rt, { project: rest.project, run: null, kind: 'raw_user_report', content: Buffer.from(text) });
          body = rest;
        }
        const result = (await storeOp(OP.fixtureTrigger, { body, actor: hooks.actor })) as { created: boolean; work_item: { id: string } };
        if (limits !== null) domainLimitOverrides.set(result.work_item.id, limits);
        return { status: result.created ? 201 : 200, body: report === null ? result : { ...result, raw_user_report: report } };
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
  // SEAM.md §190: the scripted check boundary of the kernel lane, one A.5
  // step per call through the engine's own transitions.
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'check-execution' && post) {
    return route(200, async (body) => {
      const step = parseScriptedStep(body);
      const project = (await storeOp(OP.executionProject, { execution: step.execution })) as string | null;
      if (project === null) throw new Refusal(404, 'not_found', `No check execution "${step.execution}".`, 'Name an execution the engine registered.', { execution: step.execution });
      // A recorded result names its output record, an empty one when none
      // was given (D3 §2.6); it is published before the result names it.
      let output: string | null = null;
      if (step.to === 'recorded') {
        // The same screen as a collection (SEAM.md §207): a hit publishes
        // nothing, raises the Critical finding, and names no record.
        const content = Buffer.from(step.outputText ?? '');
        const { scanBytes } = await import('../records/redact.js');
        const screened = scanBytes(content);
        if (screened.hit) {
          await hooks.runtime().engine('checks.output_refused', { execution: step.execution, by: screened.by });
        } else {
          const { writeWholeRecord } = await import('../records/files.js');
          output = await writeWholeRecord(hooks.runtime(), { project, run: null, kind: 'check_output', content });
        }
      }
      return storeOp(OP.scriptedStep, { args: { execution: step.execution, to: step.to, result: step.result, output }, actor: hooks.actor });
    });
  }
  // M4 plan §2.3 (BS4 §8): the scripted deployment adapter, its model of the
  // target, its counts, the kernel lane's admission and the bounds; the
  // labelled adapter qualification; caller-supplied authorization bindings
  // (J3), which no production route accepts.
  if (s.length === 2 && s[0] === 'deploy' && s[1] === 'script' && post) return route(200, async (body) => addScript(body));
  if (s.length === 2 && s[0] === 'deploy' && s[1] === 'target' && post) return route(200, async (body) => changeTarget(body));
  if (s.length === 2 && s[0] === 'deploy' && s[1] === 'admission' && post) return route(200, async (body) => setAdmission(body));
  if (s.length === 2 && s[0] === 'deploy' && s[1] === 'bounds' && post) return route(200, async (body) => setBounds(body));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'adapter-qualification' && post) {
    return route(201, async (body) => {
      parseAdapterQualification(body);
      return storeOp(OP.adapterQualification, { body, actor: hooks.actor });
    });
  }
  if (s.length === 3 && s[0] === 'fixtures' && s[1] === 'adapter-qualification' && s[2] === 'lapse' && post) {
    return route(200, async (body) => storeOp(OP.adapterQualificationLapse, { body, actor: hooks.actor }));
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'authorization' && post) {
    return route(201, async (body) => storeOp(OP.fixtureAuthorization, { body, actor: hooks.actor }));
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'runner-qualification') {
    return route(201, async (body) => {
      parseRunnerQualification(body);
      const { checkProfileFingerprint } = await import('../checks/profile.js');
      return storeOp(OP.runnerQualification, { fingerprint: checkProfileFingerprint(), actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'legacy-fingerprint') {
    return route(200, async (body) => {
      // The mode-free value of the version's own authorized set, computed
      // from its authorized revision as the engine did before slice 17.
      const { version } = parseLegacyFingerprint(body);
      const src = (await storeOp(OP.legacySource, { version })) as { repo: string; roots: string[]; revision: string | null } | null;
      if (src === null) throw new Refusal(404, 'not_found', `No protected version "${version}".`, 'Name a version the engine recorded.', { protected_version: version });
      const { protectedManifest, legacyFingerprintOf } = await import('../protected/set.js');
      const manifest = src.revision === null ? null : await protectedManifest(repoContext(src.repo), src.revision, src.roots);
      if (manifest === null) throw new Refusal(409, 'repo_unreadable', "The version's authorized tree could not be read.", 'Check the fixture repository.', { protected_version: version });
      return storeOp(OP.legacyFingerprint, { version, fingerprint: legacyFingerprintOf(manifest), actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'environment') return route(201, (body) => storeOp(OP.fixtureEnvironment, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'observation') return route(201, (body) => storeOp(OP.fixtureObservation, { body, actor: hooks.actor }));
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'classification') {
    return route(200, async (body) => {
      // The class is the fixture's; the discovery of the proposal's tree is
      // the engine's, frozen at classification (D3 §1.4; SEAM.md §177).
      const parsed = parseClassification(body);
      const where = (await storeOp(OP.proposalTree, { proposal: parsed.proposal })) as { repo: string; tree: string } | null;
      const discovery = where === null ? null : await discover(where.repo, where.tree);
      return storeOp(OP.fixtureClassification, { body, discovery, actor: hooks.actor });
    });
  }
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
      armed:
        isObject(body) && body.point === 'stream_slow'
          ? (() => {
              const f = parseStreamSlow(body);
              setStreamSlow(f);
              return { point: 'stream_slow', delay_ms: f.delayMs, times: f.remaining };
            })()
          : isObject(body) && body.point === 'collect_slow'
          ? (() => {
              const ms = Number(body.delay_ms);
              if (!Number.isSafeInteger(ms) || ms < 1 || ms > 60_000) throw new Refusal(400, 'invalid_value', 'collect_slow takes delay_ms, 1 to 60000.', 'Send delay_ms.', { field: 'delay_ms' });
              setCollectSlow(ms);
              return { point: 'collect_slow', delay_ms: ms };
            })()
          : isObject(body) && body.point === 'egress_connect_hang'
          ? (() => {
              const f = parseConnectHang(body);
              connectHangs.add(f.address);
              return { point: 'egress_connect_hang', address: f.address };
            })()
          : isObject(body) && body.point === 'tick_step'
          ? armTickFault(body)
          : isObject(body) && body.point === 'module_presence_read'
          ? armPresenceFault(body)
          : isObject(body) && (MAIN_FAULTS as readonly unknown[]).includes(body.point)
            ? armMainFault(body)
            : await storeOp(OP.armFault, body),
    }));
  }
  // The "help" of a stand-in binary is its own file (SEAM.md §116).
  // The help hash the engine's own check computes (the stand-in's `--help`
  // output; SEAM.md §150), else the file's own hash.
  const helpOf = async (path: string, backend = 'claude'): Promise<string> => {
    // No fixture is ever bound to a real backend's binary (SEAM.md §164).
    const real = realBinaryReason(path, backend);
    if (real !== null) throw new Refusal(409, 'backend_refused', `The engine's test mode never binds a fixture to a real backend's binary: ${real}.`, 'Name the stand-in binary the test wrote.', { field: 'binary' });
    try {
      const { helpHash } = await import('../invoke/static.js');
      const h = await helpHash(path, backend).catch(() => null);
      if (h !== null) return h;
      return createHash('sha256').update(await readFile(path)).digest('hex');
    } catch {
      throw new Refusal(400, 'invalid_value', `The binary ${path} cannot be read.`, 'Name the stand-in binary the test wrote.', { field: 'binary' });
    }
  };
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'qualification-attempt') {
    return route(201, async (body) => {
      const parsed = parseAttemptFixture(body);
      return storeOp(OP.fixtureAttempt, { body: parsed, helpSha256: await helpOf(parsed.binary.path), actor: hooks.actor });
    });
  }
  if (s.length === 2 && s[0] === 'fixtures' && s[1] === 'trust-entry') {
    return route(201, async (body) => {
      const parsed = parseEntryFixture(body);
      const helpSha256 = await helpOf(parsed.binary.path);
      const rt = hooks.runtime();
      const { writeWholeRecord } = await import('../records/files.js');
      const evidence: string[] = [];
      for (const text of parsed.evidence) evidence.push(await writeWholeRecord(rt, { project: null, run: null, kind: 'qualification_evidence', content: Buffer.from(text) }));
      return storeOp(OP.fixtureTrustEntry, { body: parsed, evidence, helpSha256, actor: hooks.actor });
    });
  }
  return null;
}

// ---- the harness resolver (main thread; M2 plan §2.3) -------------------------------

// A name's answers in order: each resolution takes the next, the last
// repeating; an optional delay per name; a counter per name (SEAM.md §140).
const resolver: { names: Map<string, { answers: string[][]; delayMs: number }>; queries: Map<string, number> } = { names: new Map(), queries: new Map() };

function configureResolver(body: unknown): unknown {
  const b = isObject(body) ? body : {};
  const names = isObject(b.names) ? b.names : null;
  const bad = () => new Refusal(400, 'invalid_value', 'The resolver takes {"names": {<name>: {"answers": [[<address>, ...], ...], "delay_ms"?: <ms>}}}.', 'Send names and their answers.', { field: 'names' });
  if (names === null || Object.keys(b).some((k) => k !== 'names')) throw bad();
  const parsed = new Map<string, { answers: string[][]; delayMs: number }>();
  for (const [name, value] of Object.entries(names)) {
    if (!isObject(value) || !Array.isArray(value.answers)) throw bad();
    const delay = value.delay_ms ?? 0;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || Object.keys(value).some((k) => k !== 'answers' && k !== 'delay_ms')) throw bad();
    // One answer (a list of addresses) or one per resolution (a list of them).
    const given = value.answers as unknown[];
    const answers = given.length > 0 && given.every((x) => typeof x === 'string') ? [given] : given;
    if (answers.length === 0 || !answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))) throw bad();
    parsed.set(name.toLowerCase().replace(/\.+$/, ''), { answers: answers as string[][], delayMs: delay });
  }
  resolver.names = parsed;
  resolver.queries.clear();
  return resolverReport();
}

function resolverReport(): unknown {
  const names: Record<string, { queries: number }> = {};
  for (const name of new Set([...resolver.names.keys(), ...resolver.queries.keys()])) names[name] = { queries: resolver.queries.get(name) ?? 0 };
  return { names };
}

// The resolver the egress proxy consults: the harness's in harness mode (the
// system's is never consulted there), null (the system's) otherwise, and
// null under the real lane (SEAM.md §164), whose real backend reaches its
// real provider by name: the harness map is never filled there, and Sean's
// second real-agent run found every name refused `resolve_failed` by it. A
// name the map does not hold does not resolve.
// The deployment adapter of this id, in harness mode the scripted one
// (BS4 §8): production has no other in slice 23.
export function seamDeploymentAdapter(id: string): unknown {
  if (!init.harness || id !== 'local_service') return null;
  return scriptedDeploymentAdapter;
}

// The adapter's and the orchestration's bounds a test set, in harness mode.
export function seamDeployBounds(): Partial<{ effectMs: number; readMs: number; outputBytes: number; orchestrationSeconds: number; autoRetries: number }> | null {
  return init.harness ? scriptedBounds() : null;
}

// What admission answers for a service domain where no real boundary admits
// one (the kernel lane): the test's answer; null outside harness mode.
export function seamDeployAdmission(): 'granted' | 'held' | null {
  return init.harness ? scriptedAdmission() : null;
}

export function seamResolver(): { resolve(name: string): Promise<string[]> } | null {
  if (!init.harness || realLane) return null;
  return {
    async resolve(name: string): Promise<string[]> {
      const key = name.toLowerCase().replace(/\.+$/, '');
      const n = (resolver.queries.get(key) ?? 0) + 1;
      resolver.queries.set(key, n);
      const entry = resolver.names.get(key);
      if (entry && entry.delayMs > 0) await sleep(entry.delayMs);
      if (!entry) {
        const err = new Error(`the harness resolver knows no name ${key}`) as NodeJS.ErrnoException;
        err.code = 'ENOTFOUND';
        throw err;
      }
      return [...entry.answers[Math.min(n - 1, entry.answers.length - 1)]!];
    },
  };
}

// ---- the probe suite's overrides (main thread; M2 plan §2.3, row M124) -------------

export type ProbeOverride = 'target_absent' | 'control_failing' | 'negative_unattempted' | 'cannot_run';
export const PROBE_OVERRIDES: readonly ProbeOverride[] = ['target_absent', 'control_failing', 'negative_unattempted', 'cannot_run'];
let probeOverrides: Record<string, ProbeOverride> = {};

export function setProbeOverrides(values: string[]): string | null {
  const out: Record<string, ProbeOverride> = {};
  for (const value of values) {
    const m = /^(P(?:[1-9]|1[0-9]|20))=([a-z_]+)$/.exec(value);
    if (!m || !(PROBE_OVERRIDES as readonly string[]).includes(m[2]!)) return `--harness-isolation-probe takes <Pn>=<${PROBE_OVERRIDES.join('|')}>, not ${value}`;
    out[m[1]!] = m[2] as ProbeOverride;
  }
  probeOverrides = out;
  return null;
}

// A named probe's override, in harness mode only.
export function seamProbeOverrides(): Record<string, ProbeOverride> {
  return init.harness ? { ...probeOverrides } : {};
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
      return installClassification(store(), a.actor, a.body, (a.discovery as Discovery | null | undefined) ?? null);
    case OP.runnerQualification:
      return installRunnerQualification(store(), a.actor, a.fingerprint as string);
    case OP.legacySource:
      return versionSourceOf(store(), a.version as string);
    case OP.legacyFingerprint:
      return installLegacyFingerprint(store(), a.actor, { version: a.version as string, fingerprint: a.fingerprint as string });
    case OP.armWorkerBarrier:
      runtimeWorkerBarriers.set(a.name as string, { action: a.action as BarrierAction, cell: new Int32Array(a.cell as SharedArrayBuffer) });
      return { armed: a.name };
    case OP.proposalTree:
      return proposalTree(store(), a.proposal as string);
    case OP.fixtureApproval:
      return installScopeApproval(store(), a.actor, a.body);
    case OP.fixtureAlphaException:
      return installAlphaException(store(), a.actor, a.args as { finding: string; record: string; purpose: string });
    case OP.fixtureReuse:
      return installReuse(store(), a.actor, a.body);
    case OP.fixtureAttempt:
      return installAttempt(store(), a.actor, a as unknown as { body: AttemptFixture; helpSha256: string });
    case OP.fixtureTrustEntry:
      return installTrustEntry(store(), a.actor, a as unknown as { body: EntryFixture; evidence: string[]; helpSha256: string });
    case OP.listFaults:
      return faults.map((f) => ({ ...f }));
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
    case OP.executionProject:
      return executionProject(store(), a.execution as string);
    case OP.scriptedStep:
      return installScriptedStep(store(), a.actor, a.args as unknown as Omit<ScriptedStep, 'runner_id'>);
    case OP.adapterQualification:
      return installAdapterQualification(store(), a.actor, a.body);
    case OP.adapterQualificationLapse:
      return lapseAdapterQualification(store(), a.actor, a.body);
    case OP.fixtureAuthorization:
      return installFixtureAuthorization(store(), a.actor, a.body);
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
  const armed = runtimeWorkerBarriers.get(name);
  if (armed !== undefined) {
    // Fires once (SEAM.md §18).
    runtimeWorkerBarriers.delete(name);
    if (armed.action === 'kill') {
      post?.({ seam: 'barrier', name, state: 'fired' });
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    post?.({ seam: 'barrier', name, state: 'waiting' });
    while (Atomics.load(armed.cell, 0) === 0) Atomics.wait(armed.cell, 0, 0);
    return;
  }
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

function armMainFault(body: Record<string, unknown>): { point: MainFault['point']; times: number } {
  const times = body.times === undefined ? 1 : body.times;
  const point = body.point as MainFault['point'];
  if (Object.keys(body).some((k) => k !== 'point' && k !== 'times') || typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    throw new Refusal(400, 'invalid_value', `Unknown ${point} fault.`, `Send {"point":"${point}","times"?: <n>}.`, { field: 'point' });
  }
  mainFaults.push({ point, times, remaining: times, hit: 0 });
  return { point, times };
}

function armPresenceFault(body: Record<string, unknown>): { point: 'module_presence_read'; project: string; times: number } {
  const times = body.times === undefined ? 1 : body.times;
  if (Object.keys(body).some((k) => !['point', 'project', 'times'].includes(k)) || typeof body.project !== 'string' || body.project.length === 0 || typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
    throw new Refusal(400, 'invalid_value', 'Unknown module_presence_read fault.', 'Send {"point":"module_presence_read","project":"proj_…","times"?: <n>}.', { field: 'point' });
  }
  presenceFaults.push({ point: 'module_presence_read', project: body.project, times, remaining: times, hit: 0 });
  return { point: 'module_presence_read', project: body.project, times };
}

// SEAM.md §224: true where a read of the project's module presence is to
// fail. Always false outside harness mode.
export function seamPresenceFault(project: string): boolean {
  if (!init.harness) return false;
  const f = presenceFaults.find((m) => m.project === project && m.remaining > 0);
  if (!f) return false;
  f.remaining -= 1;
  f.hit += 1;
  return true;
}

// A main-thread fault of the execution boundary (M2 plan §2.3): true, once
// per arming (or `times` times), where the engine is to behave as if the
// fault had happened. Always false outside harness mode.
export function seamMainFault(point: Exclude<MainFault['point'], 'token_read'>): boolean {
  if (!init.harness) return false;
  const f = mainFaults.find((m) => m.point === point && m.remaining > 0);
  if (!f) return false;
  f.remaining -= 1;
  f.hit += 1;
  return true;
}

// The bootstrap route reads the token (M107; D2 §2.6): an armed `token_read`
// fault fails that read, which the route reaches only when the bootstrap
// exception is in force.
export function seamTokenRead(): void {
  if (!init.harness) return;
  const f = mainFaults.find((m) => m.point === 'token_read' && m.remaining > 0);
  if (!f) return;
  f.remaining -= 1;
  f.hit += 1;
  throw new Refusal(500, 'token_read_failed', 'The API token could not be read (an injected fault).', 'Retry the request.', { fault: 'token_read' });
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

// ---- qualification in harness mode (M2 plan §2.3; SEAM.md §116) ------------

// Is `path` a real backend's binary, which harness mode never runs? An
// executable image (ELF), or the file the backend's own name resolves to on
// the engine's PATH or under the user's local installation. The harness's
// stand-in is a script the test wrote. null when it may be run.
export function realBinaryReason(path: string, backend: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(4);
    const fd = openSync(real, 'r');
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    if (head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return `${real} is an executable image, not the harness's stand-in`;
  } catch {
    return null;
  }
  const dirs = [...(process.env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin')].filter((d) => d.startsWith('/'));
  for (const d of dirs) {
    try {
      if (realpathSync(join(d, backend)) === real) return `${real} is the ${backend} the engine's PATH names`;
    } catch {
      // not there
    }
  }
  return null;
}

// In harness mode: a launch of a real backend's binary is refused (the
// sandbox and kernel lanes run only the stand-in); null otherwise.
export function seamRefuseBinary(path: string, backend: string): string | null {
  if (!init.harness) return null;
  return realBinaryReason(path, backend);
}

// ---- the test mode for the real lane (SEAM.md §164) ---------------------------
//
// `--harness-real-lane`, accepted only with --harness: the journey of the
// real lane runs on the plan and check fixtures of the test mode, against
// the active entry a production attempt wrote and Sean activated. Under it,
// and only for a dispatch to an active entry of a real backend, the test
// mode's refusal of a real binary does not apply (nor to that binary's
// static --help check before the dispatch); it still applies to
// POST /v1/trust/qualify and both fixture routes, so no test-mode engine can
// propose, qualify or install an entry for a real binary.
let realLane = false;
export function setRealLane(on: boolean): void {
  realLane = on && init.harness;
}
export const seamRealLane = (): boolean => init.harness && realLane;
// SEAM.md §190: an execution the scripted check boundary moved out of
// `queued` has no domain (the engine's admission allocates one in the same
// transaction), and only that route moves it: restart recovery leaves it.
export const seamScriptedExecution = (domain: string | null): boolean => init.harness && domain === null;

// A dispatch's launch of an entry's binary: as seamRefuseBinary, except
// that under the real lane an active entry's binary may be launched.
export function seamRefuseEntryBinary(path: string, backend: string, activeEntry: boolean): string | null {
  if (!init.harness) return null;
  if (realLane && activeEntry) return null;
  return realBinaryReason(path, backend);
}

// A static check (`--version`, `--help`) of a binary: refused in the test
// mode for a real binary, except under the real lane, where it is the
// active entry's re-check before a dispatch (the qualification route and
// the fixture routes refuse a real binary before they reach it).
export function seamRefuseStatic(path: string, backend: string): string | null {
  if (!init.harness || realLane) return null;
  return realBinaryReason(path, backend);
}

// Is the engine in its test mode, where a qualification request may name a
// stand-in binary, a fixture project of the test's and the scripted
// backend (SEAM.md §148)?
export function seamQualifyMode(): boolean {
  return init.harness;
}

// ---- the slice-13 switches (SEAM.md §§150, 152) -----------------------------

// `--harness-template-version <backend>=<version>`, `--harness-host-id <id>`,
// `--harness-mechanism-variant <label>`, `--harness-collect-bounds
// entries=<n>,bytes=<n>`. Called once, after configureHarness, before the
// store worker starts. Returns a usage problem, or null.
export function setHarnessSwitches(values: {
  templateVersions: string[];
  hostId: string | null;
  mechanismVariant: string | null;
  collectBounds: string | null;
  checktreesMaxBytes?: string | null;
  runnerSelfTest?: string | null;
  selfTestCases?: string[];
  checkProfileVariant?: string | null;
  checkDomainLimits?: string | null;
  classifierVersion?: string | null;
}): string | null {
  const templateVersions: Record<string, string> = {};
  for (const v of values.templateVersions) {
    const m = /^([a-z]+)=([A-Za-z0-9._-]+)$/.exec(v);
    if (!m) return `--harness-template-version takes <backend>=<version>, not ${v}`;
    templateVersions[m[1]!] = m[2]!;
  }
  if (values.hostId !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(values.hostId)) return `--harness-host-id takes an identity, not ${values.hostId}`;
  if (values.mechanismVariant !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(values.mechanismVariant)) return `--harness-mechanism-variant takes a label, not ${values.mechanismVariant}`;
  let collectBounds: HarnessSwitches['collectBounds'] = null;
  if (values.collectBounds !== null) {
    const m = /^entries=(\d+),bytes=(\d+)$/.exec(values.collectBounds);
    if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) return `--harness-collect-bounds takes entries=<n>,bytes=<n>, not ${values.collectBounds}`;
    collectBounds = { entries: Number(m[1]), bytes: Number(m[2]) };
  }
  let checktreesMaxBytes: number | null = null;
  if (values.checktreesMaxBytes != null) {
    if (!/^\d{1,15}$/.test(values.checktreesMaxBytes) || Number(values.checktreesMaxBytes) < 1) return `--harness-checktrees-max-bytes takes a positive number of bytes, not ${values.checktreesMaxBytes}`;
    checktreesMaxBytes = Number(values.checktreesMaxBytes);
  }
  if (values.runnerSelfTest != null && values.runnerSelfTest !== 'run') return `--harness-runner-self-test takes run, not ${values.runnerSelfTest}`;
  const selfTestForced: Record<string, 'failed' | 'not_exercised'> = {};
  for (const v of values.selfTestCases ?? []) {
    const m = /^([a-z_]+)=(failed|not_exercised)$/.exec(v);
    if (!m || !(SELF_TEST_CASES as readonly string[]).includes(m[1]!)) return `--harness-runner-self-test-case takes <case>=<failed|not_exercised>, not ${v}`;
    selfTestForced[m[1]!] = m[2] as 'failed' | 'not_exercised';
  }
  if (values.checkProfileVariant != null && !/^[A-Za-z0-9._-]{1,64}$/.test(values.checkProfileVariant)) return `--harness-check-profile-variant takes a label, not ${values.checkProfileVariant}`;
  let checkDomainLimits: CheckDomainLimits | null = null;
  if (values.checkDomainLimits != null) {
    checkDomainLimits = {};
    for (const part of values.checkDomainLimits.split(',')) {
      const m = /^(pids_max|memory_max|writable_bytes|writable_inodes)=(\d{1,15})$/.exec(part);
      if (!m || Number(m[2]) < 1 || (checkDomainLimits as Record<string, number>)[m[1]!] !== undefined) return `--harness-check-domain-limits takes <key>=<positive integer>,… of pids_max, memory_max, writable_bytes, writable_inodes, not ${values.checkDomainLimits}`;
      (checkDomainLimits as Record<string, number>)[m[1]!] = Number(m[2]);
    }
  }
  let classifierVersion: number | null = null;
  if (values.classifierVersion != null) {
    if (!/^[1-9][0-9]{0,8}$/.test(values.classifierVersion)) return `--harness-classifier-version takes a positive integer, not ${values.classifierVersion}`;
    classifierVersion = Number(values.classifierVersion);
  }
  if (!init.harness) return null;
  init = {
    ...init,
    switches: {
      templateVersions,
      hostId: values.hostId,
      mechanismVariant: values.mechanismVariant,
      collectBounds,
      checktreesMaxBytes,
      runnerSelfTest: values.runnerSelfTest === 'run',
      selfTestForced,
      checkProfileVariant: values.checkProfileVariant ?? null,
      checkDomainLimits,
      classifierVersion,
    },
  };
  return null;
}

// In harness mode only (either thread: the worker has the same init).
export const seamTemplateVersions = (): Record<string, string> | null => (init.harness ? (init.switches?.templateVersions ?? null) : null);
export const seamHostId = (): string | null => (init.harness ? (init.switches?.hostId ?? null) : null);
export const seamMechanismVariant = (): string | null => (init.harness ? (init.switches?.mechanismVariant ?? null) : null);
// SEAM.md §217: the classifier version this harness start reports.
export const seamClassifierVersion = (): number | null => (init.harness ? (init.switches?.classifierVersion ?? null) : null);
export const seamChecktreesMaxBytes = (): number | null => (init.harness ? (init.switches?.checktreesMaxBytes ?? null) : null);
// SEAM.md §208: whether this harness start runs the runner self-test, the
// cases it records with a forced result, and the profile variant.
// Outside the test mode the self-test runs at every start whose host
// qualification is active; in it, only when asked for.
export const seamSelfTestAtStart = (): boolean => (init.harness ? init.switches?.runnerSelfTest === true : true);
export const seamSelfTestForced = (): Record<string, 'failed' | 'not_exercised'> => (init.harness ? (init.switches?.selfTestForced ?? {}) : {});
export const seamCheckProfileVariant = (): string | null => (init.harness ? (init.switches?.checkProfileVariant ?? null) : null);
// SEAM.md §212: limits below the configured minimums for every check domain.
export const seamCheckDomainLimits = (): CheckDomainLimits | null => (init.harness ? (init.switches?.checkDomainLimits ?? null) : null);
export const seamCollectBounds = (): { entries: number; bytes: number } | null => (init.harness ? (init.switches?.collectBounds ?? null) : null);

// The fault `collect_slow` (SEAM.md §152): standing until lifted, it delays
// the inventory's handling of each entry by `delay_ms`. 0 when not armed.
let collectSlowMs = 0;
export function seamCollectDelay(): number {
  return init.harness ? collectSlowMs : 0;
}
export function setCollectSlow(ms: number): void {
  collectSlowMs = ms;
}

// The fault `stream_slow` (SEAM.md §157): standing, or for `times` lines,
// it delays acting on each line of a backend's output by `delay_ms`, so that
// `stream_queue_max_bytes` can be exceeded by a modest stream. 0 outside
// harness mode or when not armed.
let streamSlow: { delayMs: number; remaining: number | null } | null = null;

export function parseStreamSlow(body: unknown): { delayMs: number; remaining: number | null } {
  const b = (isObject(body) ? body : {}) as Record<string, unknown>;
  const ms = Number(b.delay_ms);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 60_000) throw new Refusal(400, 'invalid_value', 'stream_slow takes delay_ms, 1 to 60000.', 'Send delay_ms.', { field: 'delay_ms' });
  if (b.times !== undefined && (!Number.isSafeInteger(b.times) || (b.times as number) < 1)) throw new Refusal(400, 'invalid_value', 'times must be a positive integer.', 'Send times, or leave it out for a standing fault.', { field: 'times' });
  return { delayMs: ms, remaining: b.times === undefined ? null : (b.times as number) };
}

export function setStreamSlow(value: { delayMs: number; remaining: number | null } | null): void {
  streamSlow = value;
}

// ---- egress_connect_hang (the M128 (b) follow-up) ----------------------------
//
// `{"point": "egress_connect_hang", "address": <numeric IPv4 or IPv6>}`
// (SEAM.md §169): the egress proxy's connection to that validated address
// never completes, so its connect timeout (`egress_connect_timeout`) is what
// ends it, on any host, whatever the host's router answers. No packet is
// sent: the proxy's socket is never connected. Standing: every attempt to
// that address until the faults are cleared; arming another address adds
// it. A no-op outside harness mode (SEAM.md §7).
const connectHangs = new Set<string>();

export function parseConnectHang(body: unknown): { address: string } {
  const b = (isObject(body) ? body : {}) as Record<string, unknown>;
  if (typeof b.address !== 'string' || isIP(b.address) === 0) throw new Refusal(400, 'invalid_value', 'egress_connect_hang takes a numeric IPv4 or IPv6 address.', 'Send {"point":"egress_connect_hang","address":<numeric address>}.', { field: 'address' });
  return { address: b.address };
}

export function armConnectHang(address: string): void {
  connectHangs.add(address);
}

// Whether the proxy's connection to `address` hangs; always false outside
// harness mode.
export function seamConnectHang(address: string): boolean {
  return init.harness && connectHangs.has(address);
}

export function seamStreamDelay(): number {
  if (!init.harness || streamSlow === null) return 0;
  const ms = streamSlow.delayMs;
  if (streamSlow.remaining !== null && --streamSlow.remaining <= 0) streamSlow = null;
  return ms;
}
