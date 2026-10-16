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
import { engineDecisions, listProjects, openDecisions, readCandidate, readDecision, readEnvironmentLogs, readEnvironments, readGate, readOneEnvironment, readOperations, readProject, readWork, runTail } from './projections.js';
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
import { deferralRefsInvalidForRun, resolveUnowedDeferrals } from '../plan/deferral.js';
import { integrityFacts, recordIntegrity, registryFacts } from './transitions/integrity.js';
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
  recordPeak,
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
 dispatchEntryProbe, envelopeHoldsDispatch } from './transitions/runs.js';
import { budgetCheck, exhaustedLimits, ledgerView } from './transitions/ledger.js';
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
import { type EngineSettings, engineSettings, setEngineSettings } from './transitions/settings.js';
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
  currentConfigContent,
  relayCheck,
  relayClosed,
  relayOpened,
  relaysReset,
  relayTarget,
  deployDetail,
  deployWork,
  finalizeDeploy,
  finalizeRound,
  admissionWait,
  linkTarget,
  liveRoundExecutions,
  requestVerification,
  roundStep,
  supervisionLost,
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
  policyRequestDue,
  policyPreparationFailed,
  policyRequestRefused,
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
  serviceDomainQuarantined,
  serviceDomainObserved,
  closePriorLaunches,
  requestTeardown,
  roundChecksDone,
  roundDetail,
  roundFirstRead,
  startDeployAttempt,
  writeConfigVersion,
  beginQualification,
  qualificationArtifact,
  intendQualificationOp,
  closeQualificationLaunch,
  qualificationReconciled,
  endQualificationOp,
  qualificationFacts,
  endQualification,
  interruptQualifications,
  qualificationAnswer,
  sweepAdapterQualifications,
  qualificationPaths,
  qualificationPermits,
  qualificationAttemptRunning,
  runArtifacts,
  qualificationHostFacts,
} from './transitions/deploy.js';
import { logsDue, observationLapsed, observationPlan, observationsDue, recordLogs, recordObservation as recordEnvironmentObservation, refuseLogs, requestLogs } from './transitions/observe.js';
import { type CheckRow, requiredSet } from './transitions/evidence.js';
import { beginAdopt, beginStash, beginWidening, effectsDue, intentRow, revalidate, stashFacts, stashKept, stashed } from './transitions/intents.js';
import { notificationOutcome, notificationSending, notificationsDue } from './transitions/notify.js';
import { applicationConflicts, applicationDiverged, classificationConflicts, operationApplication, pendingReclassification, reclassifyProposal, recordClassification, revalidateApplication, revalidateOperation, unclassifiedProposals } from './transitions/classification.js';
import { applicationFacts, beginApplication, fingerprintsToRecompute, recordRecomputedFingerprint } from './transitions/protected.js';
import { answerBatch, applyAlphaException, decisionSubjectRead, reviewDecisions } from './transitions/queue.js';
import { alphaCheck, askUndispositioned } from './transitions/findings.js';
import { contextFacts, mountContext, recordPaths, runCheckKeys } from './reads.js';
import { reconcileRepairs } from './transitions/repair.js';
import {
  admitTurn,
  attachOwnerText,
  beginSave,
  closeFacts,
  closeSession,
  finishSave,
  intendCheckpointIntegration,
  openSession,
  pendingTurns,
  sessionContextFacts,
  sessionExists,
  sessionView,
  sessionWorkspace,
  settleTurn,
  turnClaim,
  turnReply,
  turnUsage,
  turnStillOpen,
  admissionRead,
  dueCloses,
  resumeFacts,
  resumeSession,
  markSessionHolds,
  budgetSpent,
} from '../sessions/session.js';
import { bundleBaselineFacts, recordBundle, replanBaseline } from '../plan/bundle.js';
import { planView, specView } from '../plan/reads.js';
import { observeHost, paceView } from '../plan/pace.js';
import { applicationFacts as specApplicationFacts, beginApplication as beginSpecApplication, refuseApplication as refuseSpecApplication, correctionFacts, impactRead, intendProposal, requestSpecChange } from '../spec/change.js';
import { approvalFacts as specApprovalFacts, beginApproval as beginSpecApproval, refuseApproval as refuseSpecApproval } from '../spec/approval-effect.js';
import { authorizedBundles, publishAuthorized as publishAuthorizedBundle, rebindBundle, rebindDue } from '../plan/bundle.js';
import { approvedRepresentation, previousRepresentation } from '../spec/approval.js';
import { phaseStep, registerGapAuthoring } from '../plan/phase.js';
import {
  attemptTarget,
  attemptUsage,
  canarySession,
  continuationFacts,
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
import { markHolds } from '../scheduler/holds.js';
import { acquireIntegrationLease, releaseIntegrationLease } from './transitions/integration-lease.js';
import { takeCommittedTickRequests } from './transitions/tick-requests.js';
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
  executionSecrets,
  recordSecretRefs,
  recordCandidateFingerprint,
  registerDue,
  renewCheckLease,
  requestChecks,
  runnerQualification,
  setCheckRunner,
  checkProfilesNow,
  treeInUse,
  treeHeld,
  recordLinkLog,
} from './transitions/checks.js';
// Last: adopt/records.ts and queue.ts import each other (queue's KINDS needs
// records' kinds evaluated first).
import { adoptProject, appliedAdoptedTests, isAdopted, projectRepositories } from '../adopt/records.js';
import { conformanceFactsRead } from '../adopt/conformance.js';
import { recordRefusedReplan } from '../plan/bundle.js';
import { registerAwaiting, settleAwaiting, sweepAwaiting } from './transitions/awaiting.js';
import { registerAfterTransition } from './transitions/tx.js';
import { CORRECTION_KIND as AWAIT_CORRECTION_KIND } from './transitions/protected.js';
import { dropBlockQuestion as awaitDropBlocker, raiseQuestion as awaitRaiseQuestion, reverifyResolvedCompletions } from './transitions/queue.js';
import { correctionProposalDecided as awaitProposalDecided } from '../spec/change.js';

// No work item awaits a decision without one it waits on (slice 37).
registerAwaiting({
  raiseQuestion: (tx, a) => awaitRaiseQuestion(tx, a as never) as { id: string } | null,
  correctionKind: (k) => (k === null ? undefined : (AWAIT_CORRECTION_KIND[k] as never)),
  proposalDecided: (tx, a) => awaitProposalDecided(tx, a),
  dropBlocker: (tx, item) => awaitDropBlocker(tx, item),
});
registerAfterTransition(settleAwaiting);

export interface WorkerData {
  file: string;
  migrationsDir: string;
  seam: SeamInit;
}

export type Request = { id: number; op: string; args: unknown };
export type Reply = ({ id: number; ok: true; value: unknown } | { id: number; ok: false; refusal: ReturnType<Refusal['toWire']> }) & { seq?: number | null; tick?: number };

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
  // D6 §8.1 step 1, A.8 (SEAM.md §377): the adoption, A pinned before the bootstrap.
  'project.adopt': (tx, a) => ({ status: 201, body: adoptProject(tx, a), effects: [{ kind: 'journal', project: a.id }] }),
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
  // D6 §4.2 (SEAM.md §353): the owner's specification change request.
  'spec.change_request': (tx, a) => requestSpecChange(tx, a),
  'deployment.request': (tx, a) => requestDeployment(tx, { ...a, requested_by: 'human' }, (t, e) => evaluateGate(t, e as never)),
  'environment.teardown': (tx, a) => requestTeardown(tx, a),
  // D4 §2.6, A.8 (SEAM.md §322): the qualification's answer, once its run
  // has ended (deploy/qualify.ts).
  'adapter.qualify_answer': (tx, a: { run: string }) => qualificationAnswer(tx.db, a),
  // D4 §5.2 (M4 slice 28; SEAM.md §317): the operator relay, its listener
  // bound or closed on the main thread first.
  'environment.relay_open': (tx, a) => relayOpened(tx, a),
  'environment.relay_close': (tx, a) => relayClosed(tx, a),
  // D4 §6.1, A.8 (M4 slice 27; SEAM.md §294): a log collection asked for.
  'environment.collect_logs': (tx, a) => requestLogs(tx, a),
  // D4 §5.3 item 1, A.8; CD1 (M4 slice 25; SEAM.md §266).
  'operation.verify': (tx, a: { project: string; operation: string }) => requestVerification(tx, { ...a, incarnation: engineSettings().incarnation! }, completionRequired),
  // D6 §2 (M5 slice 31; SEAM.md §344): a session opened, a turn admitted
  // (dispatched by the scheduler's tick, never here), and the answer of a
  // save or a close the main thread made (sessions/driver.ts), audited here.
  'session.reply': (_tx, a: { status: number; body: unknown; tick?: boolean }) => ({ status: a.status, body: a.body, ...(a.tick ? { effects: [{ kind: 'tick' }] } : {}) }),
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
  'protected.pending_reclassification': (d, a: { project: string }) => pendingReclassification(d, a),
  'protected.operation_application': (d, a: { operation: string }) => operationApplication(d, a),
  'checks.tree_in_use': (d, a) => treeInUse(d, a),
  'checks.tree_held': (d, a) => treeHeld(d, a),
  'protected.fingerprints_to_recompute': (d) => fingerprintsToRecompute(d),
  'checks.live': (d) => liveExecutions(d),
  'checks.domain_owner': (d, a: { domain: string }) => d.prepare('SELECT "incarnation" FROM "process_ownership" WHERE "domain" = ?').get(a.domain) ?? null,
  'checks.qualification': (d) => runnerQualification(d),
  'checks.regrant_facts': (d, a: { execution: string; incarnation: string; generation: number }) => checkRegrantFacts(d, a),
  'checks.execution_secrets': (d, a) => executionSecrets(d, a),
  'checks.execution': (d, a: { execution: string }) => d.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(a.execution) ?? null,
  'work.list': (d, a) => readWork(d, a),
  'decision.read': (d, a) => readDecision(d, a),
  'operations.list': (d, a) => readOperations(d, a),
  'environment.read': (d, a) => readOneEnvironment(d, a),
  'environment.logs': (d, a) => readEnvironmentLogs(d, a),
  'environment.config_content': (d, a) => currentConfigContent(d, a),
  'environment.relay_target': (d, a) => relayTarget(d, a),
  'deploy.relay_check': (d, a) => relayCheck(d, a),
  'deploy.observations_due': (d, a) => observationsDue(d, a),
  'deploy.observation_plan': (d, a) => observationPlan(d, a),
  'deploy.logs_due': (d, a) => logsDue(d, a),
  'deploy.request_facts': (d, a) => requestFacts(d, a),
  'deploy.policy_due': (d, a) => policyRequestDue(d, a),
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
  'deploy.link_target': (d, a) => linkTarget(d, a),
  'deploy.live_executions': (d, a) => liveRoundExecutions(d, a),
  'deploy.capability_check': (d, a) => capabilityCheck(d, a),
  // The adapter qualification's reads (D4 §2.6; deploy/qualify.ts).
  'qualify.facts': (d, a) => qualificationFacts(d, a),
  'qualify.paths': (d) => qualificationPaths(d),
  'qualify.permits': (d, a) => qualificationPermits(d, a),
  'qualify.attempt_running': (d, a) => qualificationAttemptRunning(d, a),
  'qualify.run_artifacts': (d, a) => runArtifacts(d, a),
  'qualify.host_facts': (d) => qualificationHostFacts(d),
  'qualify.grants': (d, a: { attempt: string }) =>
    (d.prepare(`SELECT COUNT(*) AS n FROM "events" WHERE "type" = 'deploy.launch_authorized' AND json_extract("subject", '$.attempt') = ?`).get(a.attempt) as { n: number }).n,
  'qualify.receipt': (d, a: { attempt: string }) => (d.prepare('SELECT "receipt" FROM "operation_attempts" WHERE "id" = ?').get(a.attempt) as { receipt: string | null } | undefined)?.receipt ?? null,
  'qualify.environment': (d, a: { environment: string }) => d.prepare('SELECT "current_generation" FROM "environments" WHERE "id" = ?').get(a.environment) ?? { current_generation: null },
  'qualify.ended_attempt': (d, a: { environment: string }) =>
    (
      d
        .prepare(
          `SELECT a."id" FROM "operation_attempts" a JOIN "operations" o ON o."id" = a."operation"
           WHERE json_extract(o."target", '$.environment') = ? AND a."status" <> 'started' ORDER BY a.rowid DESC LIMIT 1`,
        )
        .get(a.environment) as { id: string } | undefined
    )?.id ?? null,
  'deploy.configs_with_secrets': (d) => configsWithSecrets(d),
  'deploy.artifact_manifest': (d, a: { project: string; digest: string }) => {
    const row = d.prepare('SELECT "manifest" FROM "artifacts" WHERE "project" = ? AND "digest" = ?').get(a.project, a.digest) as { manifest: string } | undefined;
    return row ? (JSON.parse(row.manifest) as unknown) : null;
  },
  'environments.list': (d, a) => readEnvironments(d, a),
  'project.policy': (d, a: { project: string }) => projectPolicy(d, a.project),
  'run.representation': (d, a: { project: string; run: string }) => runRepresentation(d, a),
  'run.tail': (d, a: { project: string; run: string }) => runTail(d, a),
  'scheduler.candidates': (d) => dispatchCandidates(d),
  'scheduler.projects': (d) => projectIds(d),
  'integrity.registry': (d, a: { project: string }) => registryFacts(d, a),
  // Whether a nomination is due (projects.nomination_due): the tick's
  // journal step takes the project's integration lease for it only then.
  'nomination.due_project': (d, a: { project: string }) => (d.prepare('SELECT "nomination_due" FROM "projects" WHERE "id" = ?').get(a.project) as { nomination_due: string | null } | undefined)?.nomination_due != null,
  'deferral.refs_invalid': (d, a) => deferralRefsInvalidForRun(d, a),
  'checks.profiles_now': (d) => checkProfilesNow(d),
  // D1 §8.1 step 4: the project's day limits, read before select (throws on a failed read).
  // D2 §3.7; K2: whether the envelope holds a role domain of the project now.
  'scheduler.envelope_holds': (d, a: { project: string; workItem: string }) => envelopeHoldsDispatch(d, a),
  'scheduler.budgets': (d, a: { project: string }) => exhaustedLimits(d, a.project, { check: true, dispatch: true }),
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
  // The engine's fixture projects registered under another path (a home
  // moved or copied): each with the commit its integration branch is
  // expected at, for the rebind (trust/fixture.ts).
  'qualification.moved_fixtures': (d, a: { name: string; repo: string }) =>
    d
      .prepare(
        `SELECT p."id", p."dev_repo_path", r."expected_oid" AS "head" FROM "projects" p
         JOIN "ref_registry" r ON r."project" = p."id" AND r."kind" = 'integration' AND r."ref" = 'refs/heads/' || p."integration_branch"
         WHERE p."name" = ? AND p."dev_repo_path" <> ? AND p."dev_repo_path" LIKE '%/qualification/fixture' ORDER BY p.rowid, p."id"`,
      )
      .all(a.name, a.repo),
  'qualification.engine_fixture': (d, a: { repo: string }) =>
    (d.prepare('SELECT "id" FROM "projects" WHERE "dev_repo_path" = ? ORDER BY rowid LIMIT 1').get(a.repo) as { id: string } | undefined)?.id ?? null,
  'dispatch.entry_probe': (d, a: { project: string; workItem: string }) => dispatchEntryProbe(d, a),
  // D6 §2 (M5 slice 31): the sessions' reads.
  'session.pending_turns': (d) => pendingTurns(d, null),
  'session.workspace': (d, a: { run: string }) => sessionWorkspace(d, a.run),
  'session.context': (d, a: { run: string }) => sessionContextFacts(d, a.run),
  'session.exists': (d, a: { project: string; run: string }) => sessionExists(d, a.project, a.run),
  'session.view': (d, a: { project: string; run: string }) => sessionView(d, a.project, a.run),
  // M5 slice 33: what an admission reads before its barrier; the sessions
  // the idle protocol closes now; an ended session's workspace at resume.
  'session.admission_read': (d, a: { project: string; run: string }) => admissionRead(d, a.project, a.run),
  'session.open_guard': (d, a: { project: string }) =>
    (d.prepare(`SELECT "id" FROM "runs" WHERE "project" = ? AND "state" <> 'ended' ORDER BY "seq" LIMIT 1`).get(a.project) as { id: string } | undefined)?.id ?? null,
  'session.due_closes': (d, a: { at: string }) => dueCloses(d, a.at),
  'session.budget_spent': (d, a: { run: string }) => budgetSpent(d, a.run),
  'session.resume_facts': (d, a: { project: string; run: string }) => resumeFacts(d, a.project, a.run),
  'session.open_facts': (d, a: { run: string }) =>
    d.prepare(`SELECT p."dev_repo_path" AS "repo", r."base_revision" AS "base" FROM "runs" r JOIN "projects" p ON p."id" = r."project" WHERE r."id" = ?`).get(a.run),
  'session.bundle_baseline': (d, a) => bundleBaselineFacts(d, a),
  'replan.baseline': (d, a) => replanBaseline(d, a),
  'spec.view': (d, a) => specView(d, a),
  'spec.change_impact': (d, a) => impactRead(d, a),
  'spec.correction_facts': (d, a) => correctionFacts(d, a),
  // M5 slice 34: the previous save's representation (keys renumbered or
  // gone, M421 (c)); a bundle answer's publication around its barriers
  // (M448 (e)); a decision's effect intents (the answer's settle).
  'spec.previous_representation': (d, a: { project: string }) => previousRepresentation(d, a.project),
  'spec.withdrawn_keys': (d, a: { project: string }) => approvedRepresentation(d, a.project).withdrawn,
  'plan.authorized': (d, a: { project: string }) => authorizedBundles(d, a),
  'plan.rebind_due': (d, a: { project: string }) => rebindDue(d, a),
  'decision.intents': (d, a: { decisions: string[]; kind: string }) =>
    a.decisions.flatMap((id) => (d.prepare('SELECT "id" FROM "effect_intents" WHERE "decision" = ? AND "kind" = ?').all(id, a.kind) as { id: string }[]).map((r) => r.id)),
  'pace.view': (d, a) => paceView(d, a),
  'plan.view': (d, a) => planView(d, a),
  'project.repo': (d, a: { project: string }) => {
    const row = d.prepare('SELECT "dev_repo_path" FROM "projects" WHERE "id" = ?').get(a.project) as { dev_repo_path: string } | undefined;
    return row ? { repo: row.dev_repo_path } : null;
  },
  'gate.facts': (d, a: { project: string; candidate: string }) => gateFactsRead(d, a),
  // D6 §8.1 step 5 (B11): what a conformance stage's projection is read of.
  'conformance.facts': (d, a: { project: string; candidate: string }) => conformanceFactsRead(d, a),
  'project.adopted': (d, a: { project: string }) => isAdopted(d, a.project),
  'projects.repositories': (d) => projectRepositories(d),
  'project.adopted_tests': (d, a: { project: string }) => appliedAdoptedTests(d, a.project),
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
  'qualification.continuation_facts': (d, a: { run: string }) => continuationFacts(d, a),
  'qualification.orphan_sessions': (d) =>
    d
      .prepare(
        `SELECT r."id" AS "run", a."id" AS "attempt", a."status" FROM "runs" r JOIN "qualification_attempts" a ON a."id" = r."qualification_attempt"
         WHERE r."kind" = 'session' AND r."state" NOT IN ('finalizing', 'ended') AND a."status" <> 'running' ORDER BY r.rowid`,
      )
      .all(),
  // D6 §2.6 (SEAM.md §393): the entry a session qualification names.
  'trust.entry_row': (d, a: { entry: string }) =>
    (d.prepare('SELECT "id", "status", "backend", "binary_path", "binary_sha256", "help_sha256", "model", "auth_mode", "egress_hosts", "session_qualified" FROM "trust_entries" WHERE "id" = ?').get(a.entry) as Record<string, unknown> | undefined) ?? null,
  'domain.may_create': (d, a: { domain: string }) => domainMayCreate(d, a),
  'boundary.domains': (d) => boundaryDomains(d),
  'boundary.terminated_ids': (d, a: { ids: string[] }) =>
    a.ids.filter((id) => (d.prepare('SELECT "status" FROM "execution_domains" WHERE "id" = ?').get(id) as { status: string } | undefined)?.status === 'terminated'),
  'boundary.unterminated': (d) => d.prepare(`SELECT "id" FROM "execution_domains" WHERE "status" <> 'terminated' ORDER BY rowid, "id"`).all(),
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
    d.prepare(`SELECT "path", "sha256", "bytes" FROM "records" WHERE "run" = ? AND "kind" = 'provider_files' AND "published" = 1 ORDER BY rowid DESC LIMIT 1`).get(a.run) ?? null,
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
  'domain.peak': (tx, a) => recordPeak(tx, a),
  // D1 §7.5; K2 (the driver's ruling 7, slice 37): the project's integration lease.
  'integration.acquire': (tx, a) => acquireIntegrationLease(tx, a),
  'integration.release': (tx, a) => releaseIntegrationLease(tx, a),
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
  'work.sweep_awaiting': (tx, a: { project: string }) => sweepAwaiting(tx, a),
  'plan.gap_authoring': (tx, a: { project: string }) => registerGapAuthoring(tx, a),
  'deferral.resolve_unowed': (tx, a: { project: string }) => resolveUnowedDeferrals(tx, a.project),
  'findings.ask_undispositioned': (tx, a: { project: string }) => askUndispositioned(tx, a),
  'deploy.reverify_resolved': (tx, a: { project: string }) => reverifyResolvedCompletions(tx, a),
  'checks.register_due': (tx, a) => registerDue(tx, a),
  'checks.admit': (tx, a) => admitExecution(tx, a),
  'checks.authorize': (tx, a) => authorizeCheckLaunch(tx, a),
  'checks.init_report': (tx, a) => recordInitReport(tx, a),
  'checks.toolchain': (tx, a) => recordToolchain(tx, a),
  'checks.secret_refs': (tx, a) => recordSecretRefs(tx, a),
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
      revalidateApplication(t, { proposal: a.proposal, intent: a.intent ?? null, head: a.facts?.head, inputs: a.inputs ?? null, inputsVersion: a.inputsVersion, inputsTree: a.inputsTree }),
    ),
  'protected.application_diverged': (tx, a) => applicationDiverged(tx, a),
  'protected.application_conflict': (tx, a) => applicationConflicts(tx, a),
  'protected.record_classification': (tx, a) => recordClassification(tx, a),
  'protected.reclassify': (tx, a) => reclassifyProposal(tx, a),
  'protected.classification_conflict': (tx, a) => classificationConflicts(tx, a),
  'protected.revalidate_operation': (tx, a) => revalidateOperation(tx, a),
  'intent.revalidate': (tx, a) => revalidate(tx, a),
  'policy.begin_widening': (tx, a) => beginWidening(tx, a),
  // D6 §§4.3, 4.5: a spec change's side ref, and its approval's application.
  'spec.intend_proposal': (tx, a) => intendProposal(tx, a),
  'spec.application_facts': (tx, a) => specApplicationFacts(tx, a),
  'spec.begin_application': (tx, a) => beginSpecApplication(tx, a),
  'spec.refuse_application': (tx, a) => refuseSpecApplication(tx, a),
  // D6 §3.4 (slice 34): spec_approval's effect, the change log row's commit.
  'spec.approval_facts': (tx, a) => specApprovalFacts(tx, a),
  'spec.begin_approval': (tx, a) => beginSpecApproval(tx, a),
  'spec.refuse_approval': (tx, a) => refuseSpecApproval(tx, a),
  // D6 §5.5 (slice 34): the authorized finalizer's publication.
  'plan.publish': (tx, a) => publishAuthorizedBundle(tx, a),
  'plan.rebind': (tx, a) => rebindBundle(tx, a),
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
  'deploy.domain_quarantined': (tx, a) => serviceDomainQuarantined(tx, a),
  'deploy.domain_observed': (tx, a) => serviceDomainObserved(tx, a),
  'deploy.close_prior_launches': (tx, a) => closePriorLaunches(tx, a),
  'deploy.capability_refused': (tx, a) => capabilityRefused(tx, a),
  'deploy.receipt': (tx, a) => recordReceipt(tx, a),
  'deploy.reconciled': (tx, a) => recordReconcile(tx, a),
  'deploy.orphaned': (tx, a) => attemptOrphaned(tx, a),
  'deploy.finalize': (tx, a) => finalizeDeploy(tx, { operation: a.operation, requiredOf: completionRequired }),
  'deploy.round_first_read': (tx, a) => roundFirstRead(tx, { ...a, checksOf: checksById }),
  'deploy.round_checks_done': (tx, a) => roundChecksDone(tx, a),
  'deploy.round_finalize': (tx, a) => finalizeRound(tx, a, completionRequired),
  'deploy.round_step': (tx, a) => roundStep(tx, a, completionRequired),
  'checks.link_log': (tx, a) => recordLinkLog(tx, a),
  'deploy.admission_wait': (tx, a) => admissionWait(tx, a),
  'deploy.supervision_lost': (tx, a) => supervisionLost(tx, a),
  // The observation job and the log collection (D4 §§6.1, 6.2; deploy/observe.ts).
  'deploy.observe': (tx, a) => recordEnvironmentObservation(tx, a),
  'deploy.observation_lapsed': (tx, a) => observationLapsed(tx, a),
  'deploy.logs_collected': (tx, a) => recordLogs(tx, a),
  'deploy.logs_refused': (tx, a) => refuseLogs(tx, a),
  'deploy.relay_closed': (tx, a) => relayClosed(tx, a),
  'deploy.relays_reset': (tx) => relaysReset(tx),
  // The adapter qualification and its lapse (D4 §2.6; deploy/qualify.ts).
  'adapter.sweep': (tx) => sweepAdapterQualifications(tx),
  'qualify.begin': (tx, a) => beginQualification(tx, a),
  'qualify.artifact': (tx, a) => qualificationArtifact(tx, a),
  'qualify.intend': (tx, a) => intendQualificationOp(tx, a),
  'qualify.close_launch': (tx, a) => closeQualificationLaunch(tx, a),
  // D6 §2.6 (M5 slice 33): the continuation canary's session.
  'qualification.canary_session': (tx, a) => canarySession(tx, { ...a, incarnation: engineSettings().incarnation! }),
  'qualify.reconciled': (tx, a) => qualificationReconciled(tx, a),
  'qualify.end_op': (tx, a) => endQualificationOp(tx, a),
  'qualify.end': (tx, a) => endQualification(tx, a),
  'qualify.interrupt': (tx, a) => interruptQualifications(tx, a),
  // D6 §2 (M5 slice 31; sessions/driver.ts): a turn's claim and settlement,
  // the save's swap, checkpoint and finish, the close.
  'session.turn_claim': (tx, a) => turnClaim(tx, a),
  // D6 §5.8 (M5 slice 31b): the phase's step at every tick (plan/phase.ts).
  'phase.step': (tx, a) => phaseStep(tx, a),
  'pace.observe_host': (tx, a) => observeHost(tx, a),
  // The request `alpha_deploy: on_phase_complete` owes (D6 §6.8; SEAM.md §354).
  'deploy.policy_refused': (tx, a) => policyRequestRefused(tx, a),
  'deploy.policy_preparation_failed': (tx, a) => policyPreparationFailed(tx, a),
  'deploy.policy_request': (tx, a) => requestDeployment(tx, { ...a, requested_by: 'policy' }, (t, e) => evaluateGate(t, e as never)),
  // D6 §2.1, §2.4 (B01; SEAM.md §389): a turn's settlement, one fact at a
  // time: its reply or failure, its usage, then the session idle.
  'session.turn_reply': (tx, a) => turnReply(tx, a),
  'session.turn_usage': (tx, a) => turnUsage(tx, a),
  'session.turn_open': (tx, a) => turnStillOpen(tx, a),
  // D6 §2.1, §2.4 (M5 slice 33; SEAM.md §394): a session's run, grant and
  // lease (its workspace is made after, through the journal), and a new run
  // continuing an ended session.
  'session.open_tx': (tx, a) => openSession(tx, { ...a, incarnation: engineSettings().incarnation! }),
  'session.resume_tx': (tx, a) => resumeSession(tx, { ...a, incarnation: engineSettings().incarnation! }),
  'session.mark_holds': (tx) => markSessionHolds(tx),
  // N01 (the driver's ruling Q3; SEAM.md §431): every eligible item's hold as an interval.
  'work.mark_holds': (tx) => markHolds(tx),
  'session.settle': (tx, a) => settleTurn(tx, a),
  // A turn's admission (D6 §2.2): the owner's entry and the session
  // `turn_running`, in one transaction; its record is attached after.
  'session.admit_turn': (tx, a) => admitTurn(tx, { ...a, incarnation: engineSettings().incarnation! }),
  'session.attach_text': (tx, a) => attachOwnerText(tx, a),
  'session.begin_save': (tx, a) => beginSave(tx, a),
  'session.intend_checkpoint': (tx, a) => intendCheckpointIntegration(tx, a),
  'session.finish_save': (tx, a) => finishSave(tx, a),
  'session.close_facts': (tx, a) => closeFacts(tx, a),
  'session.record_bundle': (tx, a) => recordBundle(tx, a),
  // D6 §5.3, §8.3 (SEAM.md §383): a refused replan's check, and its requests.
  'replan.record_refused': (tx, a) => recordRefusedReplan(tx, a),
  'session.bundle_stale': (tx, a: { bundle: string; reason: string }) =>
    tx.db.prepare(`UPDATE "plan_bundles" SET "status" = 'stale', "stale_reason" = ? WHERE "id" = ? AND "status" = 'proposed'`).run(a.reason, a.bundle).changes,
  'session.close': (tx, a) => {
    const made = closeSession(tx, a);
    return { decisions: made.decisions };
  },
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
  // The ticks the committed transitions requested (D6 K1).
  const ticks = takeCommittedTickRequests();
  if (ticks > 0) reply.tick = ticks;
  port.postMessage(reply);
});
