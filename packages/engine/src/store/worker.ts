// The store worker (D1 §6.1, build spec §5). It owns the only engine
// connection to store.db and executes one command at a time from the main
// thread. Every command is short; none waits on git, an adapter or a stream.

import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { nowIso } from '../clock.js';
import type { LockRecord } from '../lock.js';
import { Refusal, storeError } from '../refusal.js';
import { type SeamInit, configureWorker, seamStoreOp } from '../testing/seam.js';
import { migrate } from './migrate.js';
import { engineDecisions, listProjects, openDecisions, readCandidate, readDecision, readEnvironments, readGate, readOperations, readProject, readWork, runTail } from './projections.js';
import { dispatchCandidates, projectIds, projectPolicy, quarantinedRuns } from './reads.js';
import { AuditFailed, type AuditInput, recordApiAct } from './transitions/audit.js';
import { type CommandResult, answerDecision, controlRun, requestTick, runRepresentation } from './transitions/control.js';
import { liftToFull, recordBackup, recordIncarnation, recordTick, schedulerStarted } from './transitions/engine.js';
import { bootstrapProject, policyFacts, rebindProject, setPaused, submitPolicy } from './transitions/project.js';
import {
  acceptFacts,
  beginIntegration,
  checkpointContinue,
  intendCommit,
  intendIntegration,
  intendNomination,
  nominationDue,
  recordSnapshot,
  recordWorkspaceMetadata,
} from './transitions/accept.js';
import { integrityFacts, recordIntegrity } from './transitions/integrity.js';
import {
  blockOperation,
  finalizeOperation,
  intendOperation,
  opDetail,
  reconcileOperation,
  recordAmbiguous,
  recordApplied,
  recordConfirmed,
  recordFailed,
  refuseMovedBase,
  refuseOperation,
  startAttempt,
  unfinishedOperations,
  withdrawOperation,
} from './transitions/journal.js';
import {
  allocateReceipt,
  beginEnd,
  claimDispatch,
  dispatchStarted,
  domainTerminated,
  endFacts,
  expireRun,
  expiredRunLeases,
  finishRun,
  heartbeat,
  leaseActive,
  quarantineRun,
  recordFoundProcess,
  recordLaunch,
  recordResult,
  recordUsage,
  renewLease,
  unendedRuns,
} from './transitions/runs.js';
import { budgetCheck, ledgerView } from './transitions/ledger.js';
import {
  chunkReceipt,
  expirableRecords,
  expireRecord,
  getRecord,
  publishStream,
  publishWhole,
  recordAudited,
  recordScan,
  referencedRecords,
  registerStream,
  storedRecords,
} from './transitions/records.js';
import { type EngineSettings, setEngineSettings } from './transitions/settings.js';
import { ENGINE_ACTOR, type Actor, type Tx, transact } from './transitions/tx.js';
import { chainBoundary, resumeWork } from './transitions/work.js';
import { captureRunProposal, recordRunReport } from './transitions/accept.js';
import { ancestryPairs, recordAncestry } from './transitions/evidence.js';
import { dueStageGates, evaluateGate, gateFactsRead, proposeAuthorization } from './transitions/gates.js';
import { beginAdopt, beginStash, beginWidening, effectsDue, intentRow, revalidate, stashFacts, stashKept, stashed } from './transitions/intents.js';
import { notificationOutcome, notificationSending, notificationsDue } from './transitions/notify.js';
import { applicationFacts, beginApplication } from './transitions/protected.js';
import { answerBatch, applyAlphaException, decisionSubjectRead, revalidateIntent, reviewDecisions } from './transitions/queue.js';
import { alphaCheck } from './transitions/findings.js';
import { contextFacts, mountContext } from './reads.js';
import { type HostObserved, recordHostQualification, revokeDrifted, setHostObserved, trustView } from './transitions/trust.js';
import {
  authorizeLaunch,
  boundaryDomains,
  cgroupCreated,
  egressRefused,
  recordPlan,
  closeLaunch,
  domainMayCreate,
  getDomain,
  priorScopes,
  recordCollection,
  recordExit,
  secretRefused,
  recordObservation,
  recordPlacement,
  regrantFacts,
  regrantLease,
} from './transitions/boundary.js';
import { type EnvelopeSettings, setEnvelope } from './transitions/envelope.js';

export interface WorkerData {
  file: string;
  migrationsDir: string;
  seam: SeamInit;
}

export type Request = { id: number; op: string; args: unknown };
export type Reply = ({ id: number; ok: true; value: unknown } | { id: number; ok: false; refusal: ReturnType<Refusal['toWire']> }) & { seq?: number | null };

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
  'project.policy_submit': (tx, a) => submitPolicy(tx, a),
  'project.create': (tx, a) => ({ status: 201, body: bootstrapProject(tx, a), effects: [{ kind: 'journal', project: a.id }] }),
  'project.tick': (tx, a: { project: string }) => requestTick(tx, a),
  'run.stop': (tx, a: { project: string; run: string; preview_hash: string | undefined; decided: boolean }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'stop', previewHash: a.preview_hash, decided: a.decided }),
  'run.abandon': (tx, a: { project: string; run: string; preview_hash: string | undefined; decided: boolean }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'abandon', previewHash: a.preview_hash, decided: a.decided }),
  'work.resume': (tx, a: { project: string; work_item: string }) => ok(resumeWork(tx, { project: a.project, workItem: a.work_item })),
  'decision.answer': (tx, a) => answerDecision(tx, a),
  'decision.answer_batch': (tx, a) => answerBatch(tx, a),
  'gate.evaluate': (tx, a) => ok(evaluateGate(tx, a)),
  'authorization.propose': (tx, a) => proposeAuthorization(tx, a),
  'project.rebind': (tx, a: { project: string; dev_repo_path: string }) => ({ status: 200, body: rebindProject(tx, a), effects: [{ kind: 'tick' }] }),
};

const READS: Record<string, (db: Database.Database, args: any) => unknown> = {
  'projects.list': (d, a) => listProjects(d, a),
  'project.read': (d, a) => readProject(d, a),
  'decisions.open': (d, a) => openDecisions(d, a),
  'candidate.read': (d, a) => readCandidate(d, a),
  'candidate.gate': (d, a) => readGate(d, a),
  'work.list': (d, a) => readWork(d, a),
  'decision.read': (d, a) => readDecision(d, a),
  'operations.list': (d, a) => readOperations(d, a),
  'environments.list': (d, a) => readEnvironments(d, a),
  'project.policy': (d, a: { project: string }) => projectPolicy(d, a.project),
  'run.representation': (d, a: { project: string; run: string }) => runRepresentation(d, a),
  'run.tail': (d, a: { project: string; run: string }) => runTail(d, a),
  'scheduler.candidates': (d, a: { maxConcurrentRuns: number }) => dispatchCandidates(d, a),
  'scheduler.projects': (d) => projectIds(d),
  'runs.quarantined': (d) => quarantinedRuns(d),
  'runs.expired_leases': (d) => expiredRunLeases(d, nowIso()),
  'run.state': (d, a: { run: string }) => (d.prepare('SELECT "state" FROM "runs" WHERE "id" = ?').get(a.run) as { state: string } | undefined)?.state ?? null,
  'journal.unfinished': (d, a: { project: string | null }) => unfinishedOperations(d, a.project ?? undefined),
  'nomination.due': (d) => nominationDue(d),
  'ledger.view': (d, a: { project: string; day: string | null }) => ledgerView(d, a),
  'budget.check': (d, a: { run: string; invocation: string }) => budgetCheck(d, a),
  'record.get': (d, a: { project: string; record: string }) => getRecord(d, a),
  'record.row': (d, a: { record: string }) => d.prepare('SELECT * FROM "records" WHERE "id" = ?').get(a.record) ?? null,
  'records.stored': (d) => storedRecords(d),
  'records.expirable': (d, a: { now: string }) => expirableRecords(d, a.now),
  'records.referenced': (d) => referencedRecords(d),
  'ancestry.pairs': (d, a: { project: string }) => ancestryPairs(d, a),
  'project.repo': (d, a: { project: string }) => {
    const row = d.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(a.project) as { dev_repo_path: string } | undefined;
    return row ? { repo: row.dev_repo_path } : null;
  },
  'gate.facts': (d, a: { project: string; candidate: string }) => gateFactsRead(d, a),
  'gates.due': (d, a: { project: string }) => dueStageGates(d, a),
  'candidate.revision': (d, a: { candidate: string }) => (d.prepare('SELECT "revision" FROM "candidates" WHERE "id" = ?').get(a.candidate) as { revision: string } | undefined)?.revision ?? null,
  'decision.subject': (d, a: { project: string; decision: string }) => decisionSubjectRead(d, a),
  'intent.row': (d, a: { intent: string }) => intentRow(d, a),
  'effects.due': (d, a: { project: string }) => effectsDue(d, a),
  'oob.stash_kept': (d, a: { intent: string }) => stashKept(d, a),
  'notify.due': (d, a: { project: string }) => notificationsDue(d, a),
  'mount.context': (d, a: { project: string }) => mountContext(d, a),
  'context.facts': (d, a: { run: string }) => contextFacts(d, a),
  'alpha.check': (d, a: { run: string; finding: string }) => alphaCheck(d, a),
  'trust.view': (d, a: { scripted: boolean }) => trustView(d, a),
  'domain.may_create': (d, a: { domain: string }) => domainMayCreate(d, a),
  'boundary.domains': (d) => boundaryDomains(d),
  'boundary.terminated_ids': (d, a: { ids: string[] }) =>
    a.ids.filter((id) => (d.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get(id) as { status: string } | undefined)?.status === 'terminated'),
  'boundary.unterminated': (d) => d.prepare(`SELECT "id" FROM "execution_domains" WHERE "status" <> 'terminated' ORDER BY "created_at", "id"`).all(),
  'boundary.prior_scopes': (d, a: { incarnation: string }) => priorScopes(d, a),
  'run.regrant_facts': (d, a: { run: string; incarnation: string }) => regrantFacts(d, a),
  'domain.row': (d, a: { domain: string }) => getDomain(d, a.domain) ?? null,
  'domain.exit_of': (d, a: { domain: string }) => d.prepare('SELECT "exit_class", "exit_evidence" FROM "execution_domains" WHERE "id" = ?').get(a.domain) ?? null,
  'decisions.engine': (d) => engineDecisions(d),
  'trust.binaries': (d) => (d.prepare(`SELECT DISTINCT "binary_path" AS p FROM "trust_entries" WHERE "status" <> 'revoked'`).all() as { p: string }[]).map((r) => r.p),
};

// Transitions the engine itself performs (the scheduler, the choke point, the
// run-end protocol, recovery). Callbacks of a role are recorded with the run
// as actor.
const ENGINE_OPS: Record<string, (tx: Tx, args: any) => unknown> = {
  'engine.tick': (tx, a: { incarnation: string; dispatched: number }) => recordTick(tx, a),
  'engine.backup': (tx, a) => recordBackup(tx, a),
  'dispatch.claim': (tx, a) => claimDispatch(tx, a),
  'receipt.allocate': (tx, a: { run: string }) => allocateReceipt(tx, a.run),
  'invoke.dispatch_started': (tx, a) => dispatchStarted(tx, a),
  'invoke.launched': (tx, a) => recordLaunch(tx, a),
  'invoke.found_process': (tx, a) => recordFoundProcess(tx, a),
  'journal.detail': (tx, a: { operation: string }) => opDetail(tx, a.operation),
  'journal.intend': (tx, a) => intendOperation(tx, a),
  'journal.refuse': (tx, a) => refuseOperation(tx, a),
  'journal.refuse_moved_base': (tx, a) => refuseMovedBase(tx, a),
  'journal.start_attempt': (tx, a) => startAttempt(tx, a),
  'journal.applied': (tx, a) => recordApplied(tx, a),
  'journal.confirmed': (tx, a) => recordConfirmed(tx, a),
  'journal.failed': (tx, a) => recordFailed(tx, a),
  'journal.ambiguous': (tx, a) => recordAmbiguous(tx, a),
  'journal.finalize': (tx, a) => finalizeOperation(tx, a),
  'journal.reconcile': (tx, a) => reconcileOperation(tx, a),
  'journal.block': (tx, a) => blockOperation(tx, a),
  'journal.withdraw': (tx, a) => withdrawOperation(tx, a),
  'accept.facts': (tx, a) => acceptFacts(tx, a),
  'accept.intend_commit': (tx, a) => intendCommit(tx, a),
  'accept.checkpoint': (tx, a) => checkpointContinue(tx, a),
  'accept.integrating': (tx, a) => beginIntegration(tx, a),
  'accept.intend_integration': (tx, a) => intendIntegration(tx, a),
  'nomination.intend': (tx, a) => intendNomination(tx, a),
  'workspace.snapshot': (tx, a) => recordSnapshot(tx, a),
  'workspace.metadata': (tx, a) => recordWorkspaceMetadata(tx, a),
  'integrity.facts': (tx, a) => integrityFacts(tx, a),
  'integrity.record': (tx, a) => recordIntegrity(tx, a),
  'project.policy_facts': (tx, a) => policyFacts(tx, a),
  'scheduler.chain_boundary': (tx, a) => chainBoundary(tx, a),
  'run.lease_active': (tx, a) => leaseActive(tx, a),
  'run.renew': (tx, a) => renewLease(tx, a),
  'run.expire': (tx, a) => expireRun(tx, a),
  'run.begin_end': (tx, a) => beginEnd(tx, a),
  'run.end_facts': (tx, a: { run: string }) => endFacts(tx, a.run),
  'run.unended': (tx) => unendedRuns(tx),
  'domain.terminated': (tx, a) => domainTerminated(tx, a),
  'run.quarantine': (tx, a) => quarantineRun(tx, a),
  'run.finish': (tx, a) => finishRun(tx, a),
  'record.register_stream': (tx, a) => registerStream(tx, a),
  'record.chunk': (tx, a) => chunkReceipt(tx, a),
  'record.publish_stream': (tx, a) => publishStream(tx, a),
  'record.publish_whole': (tx, a) => publishWhole(tx, a),
  'record.scan': (tx, a) => recordScan(tx, a),
  'record.expire': (tx, a) => expireRecord(tx, a),
  'record.audited': (tx, a) => recordAudited(tx, a),
  'ancestry.record': (tx, a) => recordAncestry(tx, a),
  'gate.evaluate': (tx, a) => evaluateGate(tx, a),
  'decisions.review': (tx, a) => reviewDecisions(tx, a),
  'accept.record_report': (tx, a) => recordRunReport(tx, a),
  'accept.capture_proposal': (tx, a) => captureRunProposal(tx, a),
  'protected.application_facts': (tx, a) => applicationFacts(tx, a),
  'protected.begin_application': (tx, a) => beginApplication(tx, a, a.intent ? (t: Tx) => revalidateIntent(t, a.intent, a.facts ?? {}) : null),
  'intent.revalidate': (tx, a) => revalidate(tx, a),
  'policy.begin_widening': (tx, a) => beginWidening(tx, a),
  'oob.stash_facts': (tx, a) => stashFacts(tx, a),
  'oob.begin_stash': (tx, a) => beginStash(tx, a),
  'oob.begin_adopt': (tx, a) => beginAdopt(tx, a),
  'oob.stashed': (tx, a) => stashed(tx, a),
  'alpha.apply': (tx, a) => applyAlphaException(tx, a),
  'notify.sending': (tx, a) => notificationSending(tx, a),
  'notify.outcome': (tx, a) => notificationOutcome(tx, a),
  'domain.cgroup_created': (tx, a) => cgroupCreated(tx, a),
  'domain.plan': (tx, a) => recordPlan(tx, a),
  'domain.egress_refused': (tx, a) => egressRefused(tx, a),
  'domain.placed': (tx, a) => recordPlacement(tx, a),
  'domain.authorize': (tx, a) => authorizeLaunch(tx, a),
  'domain.close': (tx, a) => closeLaunch(tx, a),
  'domain.observed': (tx, a) => recordObservation(tx, a),
  'domain.exit': (tx, a) => recordExit(tx, a),
  'evidence.secret_refused': (tx, a) => secretRefused(tx, a),
  'run.collection': (tx, a) => recordCollection(tx, a),
  'run.regrant': (tx, a) => regrantLease(tx, a),
  'host.qualification': (tx, a) => recordHostQualification(tx, a),
  'trust.revoke_drifted': (tx, a) => revokeDrifted(tx, a),
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

function open(args: { lock: LockRecord; settings: EngineSettings; scope?: string | null; envelope?: EnvelopeSettings | null }) {
  setEngineSettings({ ...args.settings, incarnation: args.lock.incarnation_id });
  setEnvelope(args.envelope ?? null);
  const d = new Database(data.file);
  db = d;
  const mode = d.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal') throw new Refusal(500, 'store_error', `The store could not enter WAL mode (got ${String(mode)}).`, 'Put the engine home on a local filesystem that supports WAL.');
  d.pragma('synchronous = FULL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  const result = migrate(d, data.migrationsDir);
  transact(d, ENGINE_ACTOR, (tx) => recordIncarnation(tx, args.lock, args.scope ?? null));
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
  // What this start's host checks observed (no store write; SEAM.md §123).
  'host.observed': (a: HostObserved) => setHostObserved(a),
  close: () => {
    db?.close();
    db = null;
  },
};

// The highest committed event sequence, sent with every reply so that the
// main thread learns of new events as they commit (the event stream follows
// it). null while the store is not open or has no event log yet.
function lastSeq(): number | null {
  if (!db) return null;
  try {
    return (db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get() as { n: number }).n;
  } catch {
    return null;
  }
}

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
  reply.seq = lastSeq();
  port.postMessage(reply);
});
