// The store worker (D1 §6.1, build spec §5). It owns the only engine
// connection to store.db and executes one command at a time from the main
// thread. Every command is short; none waits on git, an adapter or a stream.

import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import type { LockRecord } from '../lock.js';
import { Refusal, storeError } from '../refusal.js';
import { type SeamInit, configureWorker, seamStoreOp } from '../testing/seam.js';
import { migrate } from './migrate.js';
import { dispatchCandidates, projectIds, projectPolicy, quarantinedRuns } from './reads.js';
import { AuditFailed, type AuditInput, recordApiAct } from './transitions/audit.js';
import { type CommandResult, answerDecision, controlRun, requestTick, runRepresentation } from './transitions/control.js';
import { liftToFull, recordIncarnation, recordTick, schedulerStarted } from './transitions/engine.js';
import { setPaused, submitPolicy } from './transitions/project.js';
import {
  allocateReceipt,
  beginEnd,
  claimDispatch,
  dispatchStarted,
  domainTerminated,
  endFacts,
  finishRun,
  heartbeat,
  intendWorktree,
  leaseActive,
  pendingWorktreeOperations,
  quarantineRun,
  recordFoundProcess,
  recordLaunch,
  recordResult,
  recordUsage,
  refuseInvocation,
  settleWorktree,
  unendedRuns,
} from './transitions/runs.js';
import { type EngineSettings, setEngineSettings } from './transitions/settings.js';
import { ENGINE_ACTOR, type Actor, type Tx, transact } from './transitions/tx.js';
import { resumeWork } from './transitions/work.js';

export interface WorkerData {
  file: string;
  migrationsDir: string;
  seam: SeamInit;
}

export type Request = { id: number; op: string; args: unknown };
export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; refusal: ReturnType<Refusal['toWire']> };

const data = workerData as WorkerData;
const port = parentPort!;
// Messages that are not replies (they carry no `id`) belong to the seam.
configureWorker(data.seam, (message) => port.postMessage(message));

let db: Database.Database | null = null;
const store = (): Database.Database => {
  if (!db) throw storeError(new Error('the store is not open'));
  return db;
};

const ok = (body: unknown): CommandResult => ({ status: 200, body });

// API commands: each is one transition. The api.act record commits in the
// same transaction as the command (D1 §11.1).
const COMMANDS: Record<string, (tx: Tx, args: any) => CommandResult> = {
  'project.pause': (tx, a: { project: string }) => ok(setPaused(tx, { project: a.project, paused: true })),
  'project.resume': (tx, a: { project: string }) => ok(setPaused(tx, { project: a.project, paused: false })),
  'project.policy_submit': (tx, a: { project: string; body: unknown }) => ok(submitPolicy(tx, a)),
  'project.tick': (tx, a: { project: string }) => requestTick(tx, a),
  'run.stop': (tx, a: { project: string; run: string; preview_hash: string | undefined }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'stop', previewHash: a.preview_hash }),
  'run.abandon': (tx, a: { project: string; run: string; preview_hash: string | undefined }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'abandon', previewHash: a.preview_hash }),
  'work.resume': (tx, a: { project: string; work_item: string }) => ok(resumeWork(tx, { project: a.project, workItem: a.work_item })),
  'decision.answer': (tx, a) => answerDecision(tx, a),
};

const READS: Record<string, (db: Database.Database, args: any) => unknown> = {
  'project.policy': (d, a: { project: string }) => projectPolicy(d, a.project),
  'run.representation': (d, a: { project: string; run: string }) => transact(d, ENGINE_ACTOR, (tx) => runRepresentation(tx, a)),
  'scheduler.candidates': (d, a: { maxConcurrentRuns: number }) => dispatchCandidates(d, a),
  'scheduler.projects': (d) => projectIds(d),
  'runs.quarantined': (d) => quarantinedRuns(d),
};

// Transitions the engine itself performs (the scheduler, the choke point, the
// run-end protocol, recovery). Callbacks of a role are recorded with the run
// as actor.
const ENGINE_OPS: Record<string, (tx: Tx, args: any) => unknown> = {
  'engine.tick': (tx, a: { incarnation: string; dispatched: number }) => recordTick(tx, a),
  'dispatch.claim': (tx, a) => claimDispatch(tx, a),
  'receipt.allocate': (tx, a: { run: string }) => allocateReceipt(tx, a.run),
  'invoke.refuse': (tx, a) => refuseInvocation(tx, a),
  'invoke.dispatch_started': (tx, a) => dispatchStarted(tx, a),
  'invoke.launched': (tx, a) => recordLaunch(tx, a),
  'invoke.found_process': (tx, a) => recordFoundProcess(tx, a),
  'worktree.intend': (tx, a) => intendWorktree(tx, a),
  'worktree.settle': (tx, a) => settleWorktree(tx, a),
  'worktree.pending': (tx) => pendingWorktreeOperations(tx),
  'run.lease_active': (tx, a) => leaseActive(tx, a),
  'run.begin_end': (tx, a) => beginEnd(tx, a),
  'run.end_facts': (tx, a: { run: string }) => endFacts(tx, a.run),
  'run.unended': (tx) => unendedRuns(tx),
  'domain.terminated': (tx, a) => domainTerminated(tx, a),
  'run.quarantine': (tx, a) => quarantineRun(tx, a),
  'run.finish': (tx, a) => finishRun(tx, a),
};

const ROLE_OPS: Record<string, (tx: Tx, args: any) => unknown> = {
  'run.heartbeat': (tx, a) => heartbeat(tx, a),
  'run.usage': (tx, a) => recordUsage(tx, a),
  'run.result': (tx, a) => recordResult(tx, a),
};

const asRefusal = (err: unknown): Refusal => (err instanceof Refusal ? err : storeError(err));

const auditFailed = () =>
  new Refusal(500, 'audit_failed', 'The audit record for this request could not be written, so the request had no effect.', 'Retry the request; if it fails again, inspect the store.');

function writeAudit(actor: Actor, input: AuditInput): void {
  try {
    transact(store(), actor, (tx) => recordApiAct(tx, input));
  } catch {
    throw auditFailed();
  }
}

// One API mutation: the command and its audit record commit together. A
// refused or failed command rolls back and is audited on its own.
function mutate(args: { name: string; args: unknown; actor: Actor; method: string; path: string }): CommandResult {
  const command = COMMANDS[args.name];
  if (!command) throw new Error(`unknown command ${args.name}`);
  try {
    return transact(store(), args.actor, (tx) => {
      const result = command(tx, args.args);
      recordApiAct(tx, { method: args.method, path: args.path, status: result.status });
      return result;
    });
  } catch (err) {
    if (err instanceof AuditFailed) throw auditFailed();
    const refusal = asRefusal(err);
    writeAudit(args.actor, { method: args.method, path: args.path, status: refusal.status });
    throw refusal;
  }
}

function open(args: { lock: LockRecord; settings: EngineSettings }) {
  setEngineSettings(args.settings);
  const d = new Database(data.file);
  db = d;
  const mode = d.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal') throw new Refusal(500, 'store_error', `The store could not enter WAL mode (got ${String(mode)}).`, 'Put the engine home on a local filesystem that supports WAL.');
  d.pragma('synchronous = FULL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  const result = migrate(d, data.migrationsDir);
  transact(d, ENGINE_ACTOR, (tx) => recordIncarnation(tx, args.lock));
  return result;
}

const OPS: Record<string, (args: any) => unknown> = {
  open,
  mutate,
  audit: (a: { actor: Actor } & AuditInput) => writeAudit(a.actor, { method: a.method, path: a.path, status: a.status }),
  read: (a: { name: string; args: unknown }) => {
    const read = READS[a.name];
    if (!read) throw new Error(`unknown read ${a.name}`);
    return read(store(), a.args);
  },
  engine: (a: { name: string; args: unknown }) => {
    const op = ENGINE_OPS[a.name];
    if (!op) throw new Error(`unknown engine transition ${a.name}`);
    return transact(store(), ENGINE_ACTOR, (tx) => op(tx, a.args));
  },
  role: (a: { name: string; run: string; args: unknown }) => {
    const op = ROLE_OPS[a.name];
    if (!op) throw new Error(`unknown role callback ${a.name}`);
    return transact(store(), { actor_kind: 'run', actor_id: a.run, request_id: null }, (tx) => op(tx, a.args));
  },
  'engine.full': (a: { incarnation: string }) => transact(store(), ENGINE_ACTOR, (tx) => liftToFull(tx, a.incarnation)),
  'engine.started': (a: { incarnation: string }) => transact(store(), ENGINE_ACTOR, (tx) => schedulerStarted(tx, a.incarnation)),
  close: () => {
    db?.close();
    db = null;
  },
};

port.on('message', (msg: Request) => {
  let reply: Reply;
  try {
    const op = OPS[msg.op];
    // An operation the store does not define is offered to the seam, which
    // refuses it as unknown outside harness mode.
    reply = { id: msg.id, ok: true, value: op ? op(msg.args) : seamStoreOp(msg.op, msg.args, store) };
  } catch (err) {
    reply = { id: msg.id, ok: false, refusal: asRefusal(err).toWire() };
  }
  port.postMessage(reply);
});
