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
import { engineDecisions, listProjects, openDecisions, readCandidate, readDecision, readEnvironments, readGate, readOneEnvironment, readOperations, readProject, readWork, runTail } from './projections.js';
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
 dispatchEntryProbe } from './transitions/runs.js';
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
import { setCheckLimits } from '../checks/limits.js';
import { ENGINE_ACTOR, type Actor, type Tx, transact } from './transitions/tx.js';
import { chainBoundary, resumeWork } from './transitions/work.js';
import { captureRunProposal, recordRunReport } from './transitions/accept.js';
import { ancestryPairs, nominationAncestryPairs, nominationPresenceDue, presenceDue, recordAncestry, recordNominationPresence, recordPresence } from './transitions/evidence.js';
import { dueStageGates, evaluateGate, gateFactsRead, gateRefRegistry, observeGateRefs } from './transitions/gates.js';
import {
  applicationStarted,
  artifactFoundCorrupt,
  attemptOrphaned,
  capabilityCheck,
  capabilityRefused,
  configsWithSecrets,
  deployDetail,
  deployWork,
  finalizeDeploy,
  finalizeRound,
  intendDeploy,
  intendTeardown,
  launchAuthorize,
  markSecretsChanged,
  preconditionFailed,
  readPreconditions,
  recordReceipt,
  recordReconcile,
  requestDeployment,
  requestFacts,
  artifactAdmission,
  artifactPaths,
  artifactRows,
  artifactRefused,
  launchLookup,
  openServiceDomains,
  environmentResources,
  serviceLauncherPlaced,
  applicationDisagreement,
  applicationExited,
  serviceDomainClosed,
  requestTeardown,
  roundChecksDone,
  roundDetail,
  roundFirstRead,
  startDeployAttempt,
  writeConfigVersion,
} from './transitions/deploy.js';
import { type CheckRow, requiredSet } from './transitions/evidence.js';
import { beginAdopt, beginStash, beginWidening, effectsDue, intentRow, revalidate, stashFacts, stashKept, stashed } from './transitions/intents.js';
import { notificationOutcome, notificationSending, notificationsDue } from './transitions/notify.js';
import { applicationDiverged, operationApplication, recordClassification, revalidateApplication, revalidateOperation, unclassifiedProposals } from './transitions/classification.js';
import { applicationFacts, beginApplication, fingerprintsToRecompute, recordRecomputedFingerprint } from './transitions/protected.js';
import { answerBatch, applyAlphaException, decisionSubjectRead, reviewDecisions } from './transitions/queue.js';
import { alphaCheck } from './transitions/findings.js';
import { contextFacts, mountContext, recordPaths, runCheckKeys } from './reads.js';
import { reconcileRepairs } from './transitions/repair.js';
import {
  attemptTarget,
  attemptUsage,
  attemptsDue,
  canaryItem,
  canaryRunFacts,
  concludeAttempt,
  invalidateAttemptBy,
  qualify,
  recordCanary,
  startAttemptRun,
} from './transitions/qualification.js';
import { type HostObserved, attemptDrift, getAttempt, recordHostQualification, revokeDrifted, setHostObserved, sweepAttempts, trustView } from './transitions/trust.js';
import {
  authorizeCheckLaunch,
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
import { type EnvelopeSettings, type SelfTestBox, serviceAdmissionHold, setEnvelope, setSelfTestBoxes } from './transitions/envelope.js';
import {
  admitExecution,
  checkOutputRefused,
  checkRegrantFacts,
  regrantCheckLease,
  freezeProposalDiscovery,
  interruptExecution,
  liveExecutions,
  markCollecting,
  proposalDiscovery,
  quarantineExecution,
  readCandidateExecutions,
  readVersion,
  recordExecutionResult,
  recordInitReport,
  recordToolchain,
  recordCandidateFingerprint,
  registerDue,
  renewCheckLease,
  requestChecks,
  runnerQualification,
  setCheckRunner,
  treeInUse,
  treeHeld,
} from './transitions/checks.js';

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
  'run.stop': (tx, a: { project: string; run: string; preview_hash: string | undefined; decided: boolean; exited?: boolean }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'stop', previewHash: a.preview_hash, decided: a.decided, exited: a.exited === true }),
  'run.abandon': (tx, a: { project: string; run: string; preview_hash: string | undefined; decided: boolean; exited?: boolean }) =>
    controlRun(tx, { project: a.project, run: a.run, kind: 'abandon', previewHash: a.preview_hash, decided: a.decided, exited: a.exited === true }),
  'work.resume': (tx, a: { project: string; work_item: string }) => ok(resumeWork(tx, { project: a.project, workItem: a.work_item })),
  'decision.answer': (tx, a) => answerDecision(tx, a),
  'trust.qualify': (tx, a) => qualify(tx, a),
  'decision.answer_batch': (tx, a) => answerBatch(tx, a),
  'gate.evaluate': (tx, a) => ok(evaluateGate(tx, a)),
  'candidate.request_checks': (tx, a) => ({ ...requestChecks(tx, a), effects: [{ kind: 'tick' }] }),
  'project.rebind': (tx, a: { project: string; dev_repo_path: string }) => ({ status: 200, body: rebindProject(tx, a), effects: [{ kind: 'tick' }] }),
  // D4 §§3.2, 4.1, 4.6 (M4 slice 23).
  'environment.configure': (tx, a) => writeConfigVersion(tx, a),
  'deployment.request': (tx, a) => requestDeployment(tx, a, (t, e) => evaluateGate(t, e as never)),
  'environment.teardown': (tx, a) => requestTeardown(tx, a),
};

// The checks a round requires (D4 §5.3): the `alpha_complete` scope's.
const completionRequired = (d: Database.Database, project: string, candidate: Parameters<typeof requiredSet>[1]['candidate'], version: string): CheckRow[] =>
  requiredSet(d, { project, candidate, kind: 'alpha_complete', stage: null, version }).required;
const checksById = (d: Database.Database, ids: string[]): CheckRow[] => ids.map((id) => d.prepare('SELECT * FROM "checks" WHERE "id" = ?').get(id) as CheckRow).filter((c) => c !== undefined);

const READS: Record<string, (db: Database.Database, args: any) => unknown> = {
  'projects.list': (d, a) => listProjects(d, a),
  'project.read': (d, a) => readProject(d, a),
  'decisions.open': (d, a) => openDecisions(d, a),
  'candidate.read': (d, a) => readCandidate(d, a),
  'candidate.gate': (d, a) => readGate(d, a),
  'protected.version': (d, a) => readVersion(d, a),
  'candidate.executions': (d, a) => readCandidateExecutions(d, a),
  'protected.proposal_discovery': (d, a: { proposal: string }) => proposalDiscovery(d, a.proposal),
  'protected.unclassified': (d, a: { project: string }) => unclassifiedProposals(d, a),
  'protected.operation_application': (d, a: { operation: string }) => operationApplication(d, a),
  'checks.tree_in_use': (d, a) => treeInUse(d, a),
  'checks.tree_held': (d, a) => treeHeld(d, a),
  'protected.fingerprints_to_recompute': (d) => fingerprintsToRecompute(d),
  'checks.live': (d) => liveExecutions(d),
  'checks.domain_owner': (d, a: { domain: string }) => d.prepare('SELECT "incarnation" FROM "process_ownership" WHERE "domain" = ?').get(a.domain) ?? null,
  'checks.qualification': (d) => runnerQualification(d),
  'checks.regrant_facts': (d, a: { execution: string; incarnation: string; generation: number }) => checkRegrantFacts(d, a),
  'checks.execution': (d, a: { execution: string }) => d.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(a.execution) ?? null,
  'work.list': (d, a) => readWork(d, a),
  'decision.read': (d, a) => readDecision(d, a),
  'operations.list': (d, a) => readOperations(d, a),
  'environment.read': (d, a) => readOneEnvironment(d, a),
  'deploy.request_facts': (d, a) => requestFacts(d, a),
  'deploy.artifact_admission': (d, a) => artifactAdmission(d, a),
  'deploy.artifact_paths': (d) => artifactPaths(d),
  'deploy.artifact_rows': (d) => artifactRows(d),
  'deploy.launch_lookup': (d, a) => launchLookup(d, a),
  'deploy.environment_known': (d, a: { environment: string }) => d.prepare('SELECT 1 FROM "environments" WHERE "id" = ?').get(a.environment) !== undefined,
  'deploy.service_domains': (d, a) => openServiceDomains(d, a),
  'deploy.environment_resources': (d, a) => environmentResources(d, a),
  'deploy.admission': (d, a) => serviceAdmissionHold(d, a),
  'deploy.work': (d, a) => deployWork(d, a),
  'deploy.detail': (d, a) => deployDetail(d, a),
  'deploy.round': (d, a) => roundDetail(d, a),
  'deploy.capability_check': (d, a) => capabilityCheck(d, a),
  'deploy.configs_with_secrets': (d) => configsWithSecrets(d),
  'deploy.artifact_manifest': (d, a: { project: string; digest: string }) => {
    const row = d.prepare('SELECT "manifest" FROM "artifacts" WHERE "project" = ? AND "digest" = ?').get(a.project, a.digest) as { manifest: string } | undefined;
    return row ? (JSON.parse(row.manifest) as unknown) : null;
  },
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
  'budget.check': (d, a: { run: string; invocation: string; terminal?: boolean }) => budgetCheck(d, a),
  'record.get': (d, a: { project: string; record: string }) => getRecord(d, a),
  'record.row': (d, a: { record: string }) => d.prepare('SELECT * FROM "records" WHERE "id" = ?').get(a.record) ?? null,
  'records.stored': (d) => storedRecords(d),
  'records.expirable': (d, a: { now: string }) => expirableRecords(d, a.now),
  'records.referenced': (d) => referencedRecords(d),
  'ancestry.pairs': (d, a: { project: string }) => ancestryPairs(d, a),
  'ancestry.nomination_pairs': (d, a: { project: string }) => nominationAncestryPairs(d, a),
  'presence.due': (d, a: { project: string }) => presenceDue(d, a),
  'presence.nomination': (d, a: { project: string }) => nominationPresenceDue(d, a),
  // The engine's own qualification fixture project, by its repository.
  'qualification.engine_fixture': (d, a: { repo: string }) =>
    (d.prepare('SELECT "id" FROM "projects" WHERE "dev_repo_path" = ? ORDER BY "created_at" LIMIT 1').get(a.repo) as { id: string } | undefined)?.id ?? null,
  'dispatch.entry_probe': (d, a: { project: string; workItem: string }) => dispatchEntryProbe(d, a),
  'project.repo': (d, a: { project: string }) => {
    const row = d.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(a.project) as { dev_repo_path: string } | undefined;
    return row ? { repo: row.dev_repo_path } : null;
  },
  'gate.facts': (d, a: { project: string; candidate: string }) => gateFactsRead(d, a),
  'gate.ref_registry': (d, a: { project: string; candidate: string }) => gateRefRegistry(d, a),
  'gates.due': (d, a: { project: string }) => dueStageGates(d, a),
  'candidate.revision': (d, a: { candidate: string }) => (d.prepare('SELECT "revision" FROM "candidates" WHERE "id" = ?').get(a.candidate) as { revision: string } | undefined)?.revision ?? null,
  'decision.subject': (d, a: { project: string; decision: string }) => decisionSubjectRead(d, a),
  'intent.row': (d, a: { intent: string }) => intentRow(d, a),
  'effects.due': (d, a: { project: string }) => effectsDue(d, a),
  'oob.stash_kept': (d, a: { intent: string }) => stashKept(d, a),
  'notify.due': (d, a: { project: string }) => notificationsDue(d, a),
  'mount.context': (d, a: { project: string }) => mountContext(d, a),
  'context.facts': (d, a: { run: string }) => contextFacts(d, a),
  'run.check_keys': (d, a: { run: string }) => runCheckKeys(d, a),
  'records.paths': (d, a: { project: string; ids: string[] }) => recordPaths(d, a),
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
  'qualification.due': (d) => attemptsDue(d),
  'qualification.row': (d, a: { attempt: string }) => getAttempt(d, a.attempt) ?? null,
  'qualification.drift': (d, a: { attempt: string }) => {
    const row = getAttempt(d, a.attempt);
    return row ? attemptDrift(d, row) : 'missing';
  },
  'qualification.target': (d, a: { project: string | null }) => attemptTarget(d, a),
  'qualification.canary_run': (d, a: { item: string }) => (d.prepare('SELECT "id" FROM "runs" WHERE "work_item" = ? ORDER BY "seq" DESC LIMIT 1').get(a.item) as { id: string } | undefined)?.id ?? null,
  'qualification.run_facts': (d, a: { run: string }) => canaryRunFacts(d, a),
  'qualification.usage': (d, a: { attempt: string }) => attemptUsage(d, a),
  'qualification.provider_files': (d, a: { run: string }) =>
    d.prepare(`SELECT "path", "sha256", "bytes" FROM "records" WHERE "run" = ? AND "kind" = 'provider_files' AND "published" = 1 ORDER BY "created_at" DESC LIMIT 1`).get(a.run) ?? null,
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
  'presence.record': (tx, a) => recordPresence(tx, a),
  'presence.nomination_record': (tx, a) => recordNominationPresence(tx, a),
  'gate.evaluate': (tx, a) => evaluateGate(tx, a),
  'gate.observe_refs': (tx, a) => observeGateRefs(tx, a),
  'work.reconcile_repairs': (tx, a: { project: string }) => reconcileRepairs(tx, a.project),
  'checks.register_due': (tx, a) => registerDue(tx, a),
  'checks.admit': (tx, a) => admitExecution(tx, a),
  'checks.authorize': (tx, a) => authorizeCheckLaunch(tx, a),
  'checks.init_report': (tx, a) => recordInitReport(tx, a),
  'checks.toolchain': (tx, a) => recordToolchain(tx, a),
  'checks.candidate_fingerprint': (tx, a) => recordCandidateFingerprint(tx, a),
  'checks.renew': (tx, a) => renewCheckLease(tx, a),
  'checks.collecting': (tx, a) => markCollecting(tx, a),
  'checks.quarantine': (tx, a) => quarantineExecution(tx, a),
  'checks.interrupt': (tx, a) => interruptExecution(tx, a),
  'checks.record': (tx, a) => recordExecutionResult(tx, a),
  'checks.never_launched': (tx, a) => domainTerminated(tx, { domain: a.domain, observed: true, evidence: { never_launched: true } }),
  'checks.set_runner': (tx, a) => setCheckRunner(tx, a),
  'checks.regrant': (tx, a) => regrantCheckLease(tx, a),
  'checks.output_refused': (tx, a) => checkOutputRefused(tx, a),
  'protected.freeze_discovery': (tx, a) => freezeProposalDiscovery(tx, a),
  'decisions.review': (tx, a) => reviewDecisions(tx, a),
  'accept.record_report': (tx, a) => recordRunReport(tx, a),
  'accept.capture_proposal': (tx, a) => captureRunProposal(tx, a),
  'protected.application_facts': (tx, a) => applicationFacts(tx, a),
  'protected.fingerprint_recomputed': (tx, a) => recordRecomputedFingerprint(tx, a),
  // D3 §3.3 (T10; SEAM.md §218): the whole binding, the human's or a
  // Reviewer's, revalidated in the transaction that begins the application.
  'protected.begin_application': (tx, a) =>
    beginApplication(tx, a, (t: Tx) =>
      revalidateApplication(t, { proposal: a.proposal, intent: a.intent ?? null, head: a.facts?.head, inputs: a.inputs ?? null, inputsVersion: a.inputsVersion }),
    ),
  'protected.application_diverged': (tx, a) => applicationDiverged(tx, a),
  'protected.record_classification': (tx, a) => recordClassification(tx, a),
  'protected.revalidate_operation': (tx, a) => revalidateOperation(tx, a),
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
  'qualification.sweep': (tx) => sweepAttempts(tx),
  'qualification.start': (tx, a) => startAttemptRun(tx, a),
  'qualification.invalidate': (tx, a) => invalidateAttemptBy(tx, a),
  'qualification.canary_item': (tx, a) => canaryItem(tx, a),
  'qualification.canary': (tx, a) => recordCanary(tx, a),
  'qualification.conclude': (tx, a) => concludeAttempt(tx, a),
  // The Release Operator's steps (D4 §§4, 5; deploy/release-operator.ts).
  'deploy.secrets_changed': (tx, a) => markSecretsChanged(tx, a),
  'deploy.intend': (tx, a) => intendDeploy(tx, a),
  'deploy.intend_teardown': (tx, a) => intendTeardown(tx, a),
  'deploy.preconditions': (tx, a) => readPreconditions(tx, a, (t, e) => evaluateGate(t, e as never)),
  'deploy.precondition_failed': (tx, a) => preconditionFailed(tx, a),
  'deploy.artifact_corrupt': (tx, a) => artifactFoundCorrupt(tx, a),
  'deploy.artifact_refused': (tx, a) => artifactRefused(tx, a),
  'deploy.attempt': (tx, a) => startDeployAttempt(tx, a, (t, e) => evaluateGate(t, e as never)),
  'deploy.launch_authorize': (tx, a) => launchAuthorize(tx, a),
  'deploy.app_started': (tx, a) => applicationStarted(tx, a),
  'deploy.launcher_placed': (tx, a) => serviceLauncherPlaced(tx, a),
  'deploy.app_disagreement': (tx, a) => applicationDisagreement(tx, a),
  'deploy.app_exited': (tx, a) => applicationExited(tx, a),
  'deploy.domain_closed': (tx, a) => serviceDomainClosed(tx, a),
  'deploy.capability_refused': (tx, a) => capabilityRefused(tx, a),
  'deploy.receipt': (tx, a) => recordReceipt(tx, a),
  'deploy.reconciled': (tx, a) => recordReconcile(tx, a),
  'deploy.orphaned': (tx, a) => attemptOrphaned(tx, a),
  'deploy.finalize': (tx, a) => finalizeDeploy(tx, { operation: a.operation, requiredOf: completionRequired }),
  'deploy.round_first_read': (tx, a) => roundFirstRead(tx, { ...a, checksOf: checksById }),
  'deploy.round_checks_done': (tx, a) => roundChecksDone(tx, a),
  'deploy.round_finalize': (tx, a) => finalizeRound(tx, a),
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
  setCheckLimits(args.settings.checks ?? {});
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
  // The runner self-test's boxes running now, for the resource envelope (no
  // store write; review m6).
  'envelope.self_test_boxes': (a: { boxes: SelfTestBox[] }) => setSelfTestBoxes(Array.isArray(a.boxes) ? a.boxes : []),
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
