// Accepting what a role left (D1 §§7.3–7.8; build spec §6 corrections 1, 6,
// 14, 15; SEAM.md §§28–30, 40–43, 47): for a run of the Builder's or the
// Architect's kinds that sent a valid result and exited 0, in order,
//
//   1. termination of the run's domains, before any snapshot: a workspace
//      that may still have a writer is not captured (correction 1);
//   2. the snapshot, in an index of its own;
//   3. validation of the snapshot (the diff) and of what lies outside it;
//   4. the commit, through the journal (commit_tree);
//   5. a checkpoint returns the work to be continued; otherwise
//   6. the work is integrating, the branch is checked for a checkout the
//      engine does not own, the run's changes are rebased onto a head that
//      moved, and the integration branch is moved by a journaled
//      compare-and-swap (ref_update), whose finalizer integrates the work;
//   7. a nomination that is due is made;
//   8. the run ends, with the outcome these steps decided.
//
// Each step reads what the steps before it made durable, so the pipeline,
// repeated after a failure at any point, writes what it would have written
// the first time (E28 item 1). It holds the run while it works: the run is
// not ended, and a Stop or an Abandon waits for it, while an operation it
// issued is in flight (D1 §4.5 step 4); an effect on behalf of a run whose
// lease is closing is refused in the store.

import { type AdoptedTest, type BoundaryError, boundaryErrors } from '../adopt/boundary.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { nowIso } from '../clock.js';
import { commitContent, messageText } from '../git/commit.js';
import { repoContext, worktreeContext } from '../git/exec.js';
import { catBlob, isAncestor, listTree, mergeBase, treeOf } from '../git/repo.js';
import type { BundleContent, PendingPrerequisite, ReplanBaseline, ReplanPrepared } from '../plan/bundle.js';
import { PREREQUISITES_PENDING, artifactDiff, checkPlan, computeChanges, executionInputsDigest, specChangeRoute, touchedCriteria } from '../plan/check.js';
import { parseSpecification } from '../spec/semantics.js';
import { discover } from '../checks/discovery.js';
import { proposedCheckRefusal, proposesChecks } from './report.js';
import { blockingFindings } from '../spec/approval.js';
import { type AdrFrontMatter, MODULES_FILE, PLAN_FILE, type PhasePlanFile, parsePhasePlan } from '../plan/schemas.js';
import { architectFindings } from '../plan/findings.js';
import { rebaseTree } from '../git/rebase.js';
import { type MetadataBaseline, type Violation, snapshotTree, validateDiff, validateOutside } from '../git/snapshot.js';
import { type AssetBinding, validateBindings } from '../design/asset-bindings.js';
import { materialize } from '../invoke/sandbox/materialize.js';
import type { Journal, Settled } from '../journal/driver.js';
import { branchCheckedOutAt, commitId } from '../journal/effects.js';
import { type RunEnd, type RunHandle, type Runtime, log } from '../runtime.js';
import type { AcceptFacts } from '../store/transitions/accept.js';
import { canonical, sha256 } from '../store/transitions/common.js';
import { governedText } from '../protected/set.js';
import { diffHashOf } from '../projects/commands.js';
import { readRecordBytes, writeWholeRecord } from '../records/files.js';
import { redactText } from '../records/redact.js';
import type { AlphaPrepared } from '../store/transitions/findings.js';
import { ensureAncestry } from '../gates/prepare.js';
import type { RunEnder } from './end.js';
import { pausePoint, seamSpecBlobFault } from '../testing/seam.js';
import type { ApplicabilityEntry } from '../spec/change.js';

const RETRY_FIRST_MS = 500;
const RETRY_MAX_MS = 10_000;

export const INTEGRATING_KINDS = ['stage_build', 'fix', 'replan', 'assessment'];
// A Verifier's and a Reviewer's kinds: validated, never committed (SEAM.md §68).
export const REPORTING_KINDS = ['verification', 'review', 'check_correction', 'check_authoring', 'phase_verification'];
// A Spec Writer's one-shot (D6 §4.3): committed onto a side ref, never integrated.
export const SIDE_REF_KINDS = ['spec_change'];
export const ACCEPTED_KINDS = [...INTEGRATING_KINDS, ...REPORTING_KINDS, ...SIDE_REF_KINDS];

const failed = (reason: RunEnd['reason'], text: string, detail?: Record<string, unknown>): RunEnd => ({ outcome: 'failed', reason, reasonText: text, ...(detail ? { detail } : {}) });
// A validation's refusal, with every path the role may not change kept on
// the run's detail, so that the repair is told to leave each unchanged
// (store/reads.ts diffViolationFacts; real Inkwell run: a fix Builder
// refused for an ADR edit four times running, its repairs told nothing).
const violated = (v: Violation, prefix = ''): RunEnd => failed(v.klass, `${prefix}${v.text}`, v.paths && v.paths.length > 0 ? { paths: v.paths } : undefined);

// An operation the run issued whose effect git has not been made to tell
// (its command killed at the deadline, or its probe blocked): the run is
// neither ended nor failed on the strength of a timer (SEAM.md §§47, 110). It
// waits, held, until the journal has established what git did; then the
// pipeline goes on from durable state.
interface Wait {
  wait: string;
}
type StepEnd = RunEnd | null | Wait;
// The integration step went on to its nomination (underIntegrationLease).
const GO_ON = Symbol('go_on');
const isWait = (s: StepEnd): s is Wait => s !== null && 'wait' in s;
const unresolved = (settled: Settled): Wait | null => (settled.end === 'ambiguous' || settled.end === 'blocked' ? { wait: settled.op.id } : null);
const WAIT_POLL_MS = 250;

export class Acceptor {
  constructor(
    private readonly rt: Runtime,
    private readonly ender: RunEnder,
    private readonly journal: Journal,
  ) {}

  // The project's integration, one at a time (D1 §7.5; K2): the project's
  // journal held, with its durable `integration` lease, from the read of
  // the head to the nomination (journal/driver.ts withProject), shared with
  // every other engine writer of the integration ref (the slice-37 review's
  // M3).
  private underIntegrationLease<T>(project: string, run: string, fn: () => Promise<T>): Promise<T> {
    return this.journal.withProject(project, fn, run);
  }

  // The role exited 0 after a valid result: accept what it left. The run is
  // held by the pipeline until it ends it.
  start(handle: RunHandle): void {
    handle.accepting = true;
    handle.pipeline = this.pipeline(handle).catch((err) => log('acceptance', err, { run: handle.claim.run }));
  }

  private async pipeline(handle: RunHandle): Promise<void> {
    const run = handle.claim.run;
    for (let failures = 0; ; failures++) {
      try {
        const end = await this.step(run);
        if (end !== null && isWait(end)) {
          await this.awaitJournal(handle, end.wait);
          failures = -1;
          continue;
        }
        // The acceptance of what the role left is its exit's own end (Q13).
        if (end) this.rt.requestEnd(handle, { ...end, ...(handle.exitAt ? { decidedAt: handle.exitAt } : {}) }, { afterExit: true });
        return;
      } catch (err) {
        log('acceptance step', err, { run, failures: failures + 1 });
        const state = await this.rt.read<string | null>('run.state', { run }).catch(() => null);
        if (state !== 'validating' && state !== 'proposal_captured' && state !== null) {
          // A Stop or an Abandon took the run while a step had failed: what
          // the run issued is settled before its end goes on (D1 §4.5 step 4).
          await this.settleIssued(run);
          return;
        }
        await sleep(Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MAX_MS));
      }
    }
  }

  // Wait until the journal has finalized or failed `operation` (D1 §§4.5
  // step 4, 7.10; SEAM.md §§47, 110, 112). The tick's journal step probes and
  // reconciles it (D1 §8.1 step 2). While the run is the pipeline's, its
  // lease is renewed (D1 §8.3). Once its end is decided (a Stop or an
  // Abandon confirmed, a deadline, an expiry: in memory, or recorded as the
  // run leaving `validating`), nothing renews the lease (E27 item 5), but the
  // wait goes on: the run is not ended while an operation it issued is
  // unresolved, so that an integration git did make is integrated before the
  // end takes its course, and one it did not make is failed first. Returns
  // once the operation is settled; the next pass then sees the run as it is.
  private async awaitJournal(handle: RunHandle, operation: string): Promise<boolean> {
    const { run, generation } = handle.claim;
    const renewEveryMs = (this.rt.setting('lease_ttl') * 1000) / 4;
    let renewed = performance.now();
    let renewing = true;
    for (;;) {
      const op = await this.rt.engine<{ state: string }>('journal.detail', { operation }).catch(() => null);
      if (op && (op.state === 'finalized' || op.state === 'failed')) return true;
      const decided = handle.ending || handle.intended !== null || handle.leaseLost;
      if (decided) renewing = false;
      if (renewing && performance.now() - renewed >= renewEveryMs) {
        const state = await this.rt.read<string | null>('run.state', { run }).catch(() => null);
        if (state !== 'validating' || handle.ending || handle.intended !== null) renewing = false;
        else {
          renewed = performance.now();
          const at = await this.rt.engine<string | null>('run.renew', { run, generation }).catch((err) => {
            log('lease renewal', err, { run });
            return undefined;
          });
          if (at === null) renewing = false;
          else if (typeof at === 'string') handle.renewedAtMs = Math.max(handle.renewedAtMs, Date.parse(at));
        }
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  // One pass from durable state. Returns the run's end, null when the run is
  // no longer the pipeline's to end (a Stop or an Abandon took it), or the
  // operation it must wait for.
  private async step(run: string): Promise<StepEnd> {
    let facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
    // A proposal already captured: the run's report is recorded with it.
    if (facts.run.state === 'proposal_captured') return { outcome: 'completed', reason: 'none' };
    if (facts.run.state !== 'validating') return null;
    const repo = facts.project.repo;
    const ws = facts.workspace;
    if (!ws || !ws.metadata) return failed('infra_error', 'the run has no workspace the engine can validate');
    const metadata = ws.metadata as unknown as MetadataBaseline;
    // The base this run's workspace was made at. Its current base moves only
    // by this run's own checkpoint, so what the pipeline does is judged
    // against the base it started from, also when it is repeated.
    const base = ws.base_revision;

    // 1. No snapshot of a workspace that may still have a writer.
    if (facts.domains.some((d) => d.status !== 'terminated')) {
      const terminated = await this.ender.terminateDomains(run);
      if (!terminated) {
        // A Verifier's or a Reviewer's run whose termination cannot be
        // established is quarantined with the outcome its role earned, and
        // is not snapshotted (SEAM.md §68).
        // Its report is recorded like any other, before the run can end and
        // complete the work (E41 item 3).
        if (REPORTING_KINDS.includes(facts.work.kind)) {
          await this.recordReport(facts);
          return { outcome: 'completed', reason: 'none' };
        }
        return failed('infra_error', "the termination of the run's domain could not be established, so what the role left cannot be known; nothing of it was captured");
      }
      facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
      if (facts.run.state !== 'validating') return null;
    }

    // 1b. On the real boundary what the role wrote is on its domain's
    // volatile filesystem: it reaches the checkout only now that termination
    // is established, through the secret screen (D2 §§2.3, 2.5).
    const handle = this.rt.handles.get(run);
    if (handle && handle.sandbox !== null && !handle.materialized && facts.workspace!.snapshot_tree === null) {
      const hold = handle.sandbox.volatile;
      if (hold === null || !hold.held) return failed('infra_error', 'what the role left in its workspace is no longer held, so nothing of it can be materialized');
      const m = materialize({ hold, home: this.rt.home, workspace: ws.path, caps: facts.caps });
      if (m.state === 'refused') {
        if (m.reason === 'secret') {
          // D2 §2.5: the refusal raises the Critical security finding and
          // evidence.secret_refused; the run cannot complete.
          await this.rt.engine('evidence.secret_refused', { run, domain: handle.claim.domain, what: 'materialization', path: m.path === null ? null : redactText(m.path), by: null });
          return failed('infra_error', `secret_refused: the secret screen refused the workspace's materialization: ${redactText(m.detail)}; nothing of it reached the checkout`);
        }
        // What the snapshot would refuse is never copied into the checkout.
        if (m.reason === 'caps') return failed('diff_violation', `the workspace's materialization was refused: ${m.detail}; nothing of it reached the checkout`);
        return failed('infra_error', `what the role left could not be materialized: ${m.detail}`);
      }
      handle.materialized = true;
    }

    // 2. The snapshot.
    let tree = facts.workspace!.snapshot_tree;
    if (tree === null) {
      tree = await snapshotTree(worktreeContext(repo, metadata.adminDir, ws.path), base, this.rt.scratch);
      if (tree === null) return failed('infra_error', 'the workspace could not be snapshotted');
      await this.rt.engine('workspace.snapshot', { workspace: ws.id, tree });
    }

    const role = facts.run.role;
    if (REPORTING_KINDS.includes(facts.work.kind)) return this.report(facts, tree, base, metadata);
    // 3. Validation, unless the run's commit is already journaled.
    if (facts.commits.length === 0) {
      const diff = await validateDiff(repo, base, tree, role, facts.caps, facts.roots);
      if (diff.violation) return violated(diff.violation);
      await pausePoint('snapshot.before_validate_outside');
      const outside = await validateOutside({ repo, path: ws.path, metadata, registry: facts.registry, moving: facts.moving, others: facts.others, scratch: this.rt.scratch, refFacts: () => this.rt.read<{ registry: { ref: string; expected_oid: string }[]; moving: Record<string, string[]> }>('integrity.registry', { project: facts.run.project }) });
      if (outside) return failed(outside.klass, outside.text);
    }

    // 4. The commit.
    const own = facts.commits.find((c) => c.parent === base);
    let commit = own;
    if (!commit) {
      const made = await this.commit(facts, tree, base, false);
      if ('end' in made) return made.end;
      commit = made.commit;
    } else if (commit.state !== 'finalized') {
      const settled = await this.journal.drive(commit.id);
      if (settled.end !== 'finalized') return unresolved(settled) ?? this.commitFailed(settled);
    }

    // 5. A checkpoint is a working revision: the work is continued later.
    if (facts.result?.checkpoint === true) {
      await this.rt.engine('accept.checkpoint', { run, sha: commit.sha });
      return { outcome: 'completed', reason: 'none' };
    }

    // A spec change's proposal goes onto its side ref, not the branch (D6 §4.3).
    if (SIDE_REF_KINDS.includes(facts.work.kind)) return this.specChange(facts, commit.sha);

    // 6. Integration.
    if (!(await this.rt.engine<boolean>('accept.integrating', { run }))) return null;
    // Serial under the project's integration lease (D1 §7.5; D6 §6.4, K2;
    // the driver's ruling 7, slice 37): the head is read, the run rebased
    // onto it, the compare-and-swap intended and driven while this run holds
    // the durable `integration` lease of its project; the compare-and-swap
    // still guards the branch.
    const serial = await this.underIntegrationLease(facts.project.id, run, async (): Promise<StepEnd | typeof GO_ON> => {
      facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
      let integration = facts.integrations.at(-1);
      if (!integration) {
        const at = await branchCheckedOutAt(repo, facts.project.branch, this.rt.home);
        if (at !== null && at !== 'unknown') {
          return failed(
            'integration_conflict',
            `the integration was refused: the integration branch ${facts.project.branch} is checked out in the worktree ${at}, which the engine does not own; switch that worktree to another branch, or detach it`,
            { park: 'integration_branch_checked_out', worktree: at },
          );
        }
        const head = facts.head;
        if (head === null) return failed('infra_error', 'the integration branch is not registered');
        let target = facts.commits.filter((c) => c.state === 'finalized').at(-1)!;
        const ctx = repoContext(repo);
        const fastForward = target.parent === head || (await isAncestor(ctx, head, target.sha)) === true;
        if (!fastForward) {
          // The branch moved: the run's changes are rebased onto the head,
          // validated again, and committed on it (D1 §7.5).
          const base = await mergeBase(ctx, head, target.sha);
          if (base === null) return failed('infra_error', 'the merge base of the run and the integration branch could not be read');
          const rebased = await rebaseTree(repo, base, target.sha, head, this.rt.scratch);
          if (rebased === 'unknown') return failed('infra_error', 'the run could not be rebased onto the integration branch: the repository could not be read');
          if (rebased.conflict !== null) {
            // A textual conflict with the moved branch, not a compare-and-swap
            // failure (D1 §7.5, D1-19 as amended by E152 item 4): the run's
            // end sends the item back to its Builder once on the new head,
            // naming the files and the head (store/transitions/runs.ts).
            return failed('integration_conflict', `the integration branch moved to ${head}, and the run's changes to ${rebased.files.join(', ')} do not apply to it`, {
              park: 'integration_conflict',
              conflict: 'rebase',
              head,
              files: rebased.files,
            });
          }
          const check = await validateDiff(repo, head, rebased.tree, role, facts.caps, facts.roots);
          if (check.violation) return violated(check.violation, 'the rebased result: ');
          const again = facts.commits.find((c) => c.parent === head && c.tree === rebased.tree);
          if (again && again.state === 'finalized') target = again;
          else {
            const made = again ? await this.driveCommit(again.id, again) : await this.commit(facts, rebased.tree, head, true);
            if ('end' in made) return made.end;
            target = made.commit;
          }
        }
        const headTree = await treeOf(ctx, head);
        const targetTree = await treeOf(ctx, target.sha);
        if (headTree === null || targetTree === null) return failed('infra_error', 'the integration could not be prepared: the repository could not be read');
        const plans = await validateDiff(repo, head, targetTree, role, { files: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, fileBytes: Number.MAX_SAFE_INTEGER }, facts.roots);
        if (plans.violation) return violated(plans.violation);
        // A replan's plan in Appendix B.5's form (D6 §5.6): checked against
        // the bundle now, on the main thread; its finalizer publishes it as its
        // routing says. A plan in D1 §7.8's form registers as built.
        let replan: ReplanPrepared | null = null;
        let legacy = plans.plans;
        if (role === 'architect' && plans.plans.length > 0) {
          const prepared = await this.replanOf(facts, target.sha, plans.plans.map((x) => x.path), base);
          if (prepared !== null && 'refused' in prepared) return failed('invalid_result', prepared.refused);
          // Held for its prerequisite results (M543): not refused, no repair
          // spent; the run's end returns the item to wait for them.
          if (prepared !== null && 'held' in prepared) {
            return failed('invalid_result', `${PREREQUISITES_PENDING}: the plan check's dependency clause reads ${prepared.held.map((x) => `${x.key} on ${x.candidate} (${x.status})`).join(', ')}; the replan waits for their results and is checked again after`, {
              hold: 'prerequisite_results',
              pending: prepared.held,
            });
          }
          if (prepared !== null) {
            replan = prepared.replan;
            legacy = [];
          }
        }
        // A UI Builder's asset bindings (D7 §6.5; G15), validated against
        // the tree to integrate; a failure refuses the integration.
        const bindings = (facts.result?.report as { asset_bindings?: AssetBinding[] } | undefined)?.asset_bindings ?? [];
        let bound: (AssetBinding & { slot_version: number })[] = [];
        if (bindings.length > 0) {
          const carried = await this.rt.read<{ slot: string; variant: string; slot_version: number; digest: string }[] | null>('design.carried_effective', { run });
          const refused = await validateBindings(repo, targetTree, bindings, carried);
          if (refused !== null) return failed('invalid_result', `the asset bindings were refused: ${refused}`);
          bound = bindings.map((b) => ({ ...b, slot_version: carried!.find((c) => c.slot === b.slot && c.variant === b.variant)!.slot_version }));
          await pausePoint('integration.bindings_validated');
        }
        const intent = await this.journal.withProject(facts.project.id, () =>
          this.journal.intend(
            'accept.intend_integration',
            { run, repo, head, commit: target.sha, plans: legacy, ...(replan ? { replan } : {}), ...(bound.length > 0 ? { asset_bindings: bound } : {}), deadlineSeconds: this.rt.setting('git_deadline') },
            'ref_update',
          ),
        );
        if ('fenced' in intent) return null;
        facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
        integration = facts.integrations.at(-1)!;
      }
      let settled: Settled | null = null;
      if (integration.state !== 'finalized' && integration.state !== 'failed') {
        settled = await this.journal.withProject(facts.project.id, () => this.journal.drive(integration!.id));
      }
      if (settled !== null) {
        const wait = unresolved(settled);
        if (wait) return wait;
      }
      const state = settled?.op.state ?? integration.state;
      const detail = settled?.op.outcome_detail ?? integration.detail;
      if (state === 'failed') {
        const current = await this.rt.read<string | null>('run.state', { run });
        if (current !== 'validating') return null;
        if (detail?.reason === 'integration_branch_checked_out') {
          return failed('integration_conflict', `the integration was refused: ${String(detail.text)}`, { park: 'integration_branch_checked_out', worktree: detail.worktree });
        }
        if (detail?.reason === 'closing') return null;
        return failed('integration_conflict', `the compare-and-swap of the integration branch failed: ${String(detail?.text ?? 'the branch moved')}`, { park: 'integration_conflict', conflict: 'compare_and_swap' });
      }
      if (state !== 'finalized') return { wait: integration.id };
      // 7. A nomination that is due, still under the lease: each
      // integration's own cadence point is nominated before the next
      // integration of the project can move the branch (D1 §7.7; K2).
      await this.rt.services?.nominate(facts.project.id).catch((err) => log('nomination', err, { project: facts.project.id }));
      return GO_ON;
    });
    if (serial !== GO_ON) return serial;
    return { outcome: 'completed', reason: 'none' };
  }

  // A spec change's proposal (D6 §§4.3, 4.4): the specification the run
  // committed is parsed from the commit, its impact computed against the
  // approved version and recorded, and the commit put on the request's side
  // ref through the journal, whose finalizer raises `spec_change`. An
  // impact the engine cannot compute refuses the proposal (§4.4).
  private async specChange(facts: AcceptFacts, sha: string): Promise<StepEnd> {
    const run = facts.run.id;
    const project = facts.project.id;
    const ctx = repoContext(facts.project.repo);
    const path = '.surety/spec/spec.md';
    const tree = await treeOf(ctx, sha);
    const entries = tree === null ? null : await listTree(ctx, tree);
    if (entries === null) return failed('infra_error', "the spec change's tree could not be read");
    const entry = [...entries.values()].find((e) => e.path === path && e.type === 'blob');
    if (!entry) return failed('invalid_result', `the spec change left no ${path}`);
    // A blob the engine cannot read leaves the impact uncomputable: the
    // proposal is refused naming why, never given an empty impact (D6 §4.4;
    // SEAM.md §419's `spec_blob_read` fault).
    const text = seamSpecBlobFault(project) ? null : await catBlob(ctx, sha, path);
    if (text === null) return failed('invalid_result', `spec_blob_unreadable: ${path} at ${sha} could not be read, so the impact of the proposed specification cannot be computed`);
    const parsed = parseSpecification(text);
    if (!parsed.readable || parsed.representation === null) return failed('invalid_result', `the proposed specification is not readable: ${parsed.findings.map((f) => f.why).join('; ')}`);
    // A specification that could not be approved is never proposed (D6 §3.4;
    // the 31b review's S1): its blocking findings refuse it here, before any
    // side ref, decision or effect.
    const blocking = blockingFindings(parsed.findings);
    if (blocking.length > 0) return failed('invalid_result', `spec_semantics_invalid: the proposed specification cannot be approved: ${blocking.map((f) => `${f.where}: ${f.code}: ${f.why}`).join('; ')}`);
    const claimed = (facts.result?.report as { changes?: unknown } | undefined)?.changes ?? null;
    let impact: unknown;
    try {
      const read = await this.rt.read<{ impact: unknown } | { refused: string }>('spec.change_impact', { project, representation: parsed.representation, digest: parsed.digest, claimed, work_item: facts.work.id });
      // A renumbered key, a withdrawn key used again or an unreadable
      // approved version refuses the proposal at the run (D6 §4.4; Q1).
      if ('refused' in read) return failed('invalid_result', `the proposed specification is refused: ${read.refused}`);
      impact = read.impact;
    } catch (err) {
      return failed('invalid_result', `the impact of the proposed specification could not be computed: ${(err as Error).message}`);
    }
    const record = await writeWholeRecord(this.rt, { project, run, kind: 'spec_impact', content: Buffer.from(`${JSON.stringify(impact, null, 2)}\n`) });
    const intent = await this.journal.withProject(project, () =>
      this.journal.intend(
        'spec.intend_proposal',
        { run, repo: facts.project.repo, commit: sha, blob: entry.oid, digest: parsed.digest, representation: parsed.representation, findings: parsed.findings, readable: parsed.readable, impact, impact_record: record, deadlineSeconds: this.rt.setting('git_deadline') },
        'ref_update',
      ),
    );
    if ('fenced' in intent) return null;
    const settled = await this.journal.withProject(project, () => this.journal.drive(intent.operation));
    if (settled.end !== 'finalized') return unresolved(settled) ?? failed('infra_error', `the side ref of the spec change was not written (${settled.end})`);
    return { outcome: 'completed', reason: 'none' };
  }

  // A replan's B.5 plan, checked against the approved bundle (D6 §5.3,
  // §5.4): null when the commit carries no plan in that form.
  private async replanOf(facts: AcceptFacts, sha: string, paths: string[], base: string): Promise<{ replan: ReplanPrepared } | { refused: string } | { held: PendingPrerequisite[] } | null> {
    const ctx = repoContext(facts.project.repo);
    let plan: PhasePlanFile | null = null;
    for (const path of paths) {
      const m = PLAN_FILE.exec(path);
      if (!m) continue;
      const text = await catBlob(ctx, sha, path);
      if (text === null) return { refused: `the plan ${path} could not be read` };
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null || !('prepared_against' in value)) continue;
      const parsed = parsePhasePlan(text, path, Number(m[1]));
      if (!parsed.ok) return { refused: `PLAN_INVALID: ${parsed.finding.file}: ${parsed.finding.field ?? ''} ${parsed.finding.why}` };
      if (plan !== null) return { refused: 'the replan wrote more than one phase plan' };
      plan = parsed.value;
    }
    if (plan === null) return null;
    const b = await this.rt.read<ReplanBaseline>('replan.baseline', { project: facts.project.id, head: base, work_item: facts.run.work_item, digests: plan.stages.map((st) => [st.number, executionInputsDigest(st)]) });
    // An early replan's plan for the phase it replaces (D6 §5.7; B08): its
    // kept stages are stages of the plan; any other plan replaces nothing.
    const replacement = b.replacement !== null && b.replacement.phase === plan.phase ? b.replacement : null;
    const approved = b.baseline.approved;
    if (approved === null) return { refused: 'PLAN_STALE_BASELINE: no approved architecture and roadmap to plan against' };
    // The commit's own architecture, module map, ADRs and roadmap, read from
    // its tree and diffed against the approved baseline by the check (D6
    // §5.4; the 31b review's S4): a replan that changes any of them is
    // routed to the human, never registered. An ADR whose front matter does
    // not parse, or a machine file that does not, refuses the replan: its
    // status is not known, and unknown is not `accepted`.
    const tree = await treeOf(ctx, sha);
    const entries = tree === null ? null : await listTree(ctx, tree);
    if (entries === null) return { refused: 'the replan\'s tree could not be read' };
    const ARCHITECT_PATHS = ['.surety/architecture/', '.surety/adrs/', '.surety/roadmap/', '.surety/phases/'];
    const blobs: Record<string, string> = {};
    const files: Record<string, string> = {};
    for (const e of entries.values()) {
      if (e.type !== 'blob' || !ARCHITECT_PATHS.some((p) => e.path.startsWith(p))) continue;
      blobs[e.path] = e.oid;
      if (e.path.startsWith('.surety/phases/')) continue;
      const text = await catBlob(ctx, sha, e.path);
      if (text === null) return { refused: `${e.path} could not be read` };
      files[e.path] = text;
    }
    const parsedArch = architectFindings({ files }, { requirement_keys: b.requirement_keys, spec_modules: b.spec_modules, descriptive_keys: b.descriptive_keys, adopted: b.baseline.adopted === true });
    if (parsedArch.findings.length > 0) return { refused: `the replan's architecture products do not parse: ${parsedArch.findings.map((f) => f.message).join('; ')}` };
    if (parsedArch.parsed.modules === null) return { refused: `the replan's tree has no ${MODULES_FILE}` };
    const adrTexts: Record<string, string> = {};
    const adrFront: Record<string, AdrFrontMatter> = {};
    const adrs: BundleContent['adrs'] = {};
    for (const [key, a] of Object.entries(parsedArch.parsed.adrs)) {
      adrTexts[key] = a.text;
      adrFront[key] = a.front;
      adrs[key] = { text: a.text, status: a.front.status, ...(a.front.supersedes ? { supersedes: a.front.supersedes } : {}) };
    }
    const roadmap = plan.roadmap_revision ?? parsedArch.parsed.roadmap ?? approved.roadmap;
    const architectureText = parsedArch.parsed.architecture_text;
    // A replan that changes the approved architecture text, module map or an
    // ADR is published with the next architecture version; one that changes
    // the roadmap with the next roadmap version; a roadmap-only change
    // allocates no architecture version (the driver's ruling, slice 35). It
    // is checked against the versions its publication allocates, as the
    // first close is (B02; M448 (a); the review's M4).
    const artifacts = { modules: parsedArch.parsed.modules, roadmap, adrs: adrTexts, adr_front_matter: adrFront, architecture_text: architectureText, plan };
    const pre = computeChanges(b.baseline, artifacts);
    const r0 = pre.changes_roadmap;
    const roadmapChanging = plan.roadmap_revision !== undefined || r0.phases_added.length + r0.phases_removed.length + r0.goals.length + r0.memberships.length + r0.assignments.length + r0.dependencies.length > 0;
    const architectureChanging = pre.changes_architecture.changed || pre.changes_adrs.added.length + pre.changes_adrs.changed.length + pre.changes_adrs.deleted.length > 0;
    const architectureVersion = architectureChanging ? b.baseline.architecture_version + 1 : b.baseline.architecture_version;
    const against = {
      ...b.baseline,
      architecture_version: architectureVersion,
      roadmap_version: roadmapChanging ? b.baseline.roadmap_version + 1 : b.baseline.roadmap_version,
      // An unchanged roadmap.json names the architecture it was made with; a
      // changed one the architecture it is published with.
      roadmap_architecture_version: roadmapChanging ? architectureVersion : (b.baseline.roadmap_architecture_version ?? b.baseline.architecture_version),
    };
    const check = checkPlan(replacement ? { ...against, kept: replacement.kept, touched: touchedCriteria(replacement.stale) } : against, artifacts);
    const report = facts.result?.report as Record<string, unknown> | undefined;
    const declared = Object.fromEntries(['conformance', 'adrs_changed', 'roadmap_revision', 'notes'].filter((k) => report?.[k] !== undefined).map((k) => [k, report![k]]));
    // The Architect's findings (B.7, as D3 X2): recorded with the run, a
    // `requirement_conflict` routed to `change_spec` (D6 §5.4), whatever
    // the check decides.
    if (Array.isArray(report?.findings) && (report.findings as unknown[]).length > 0) await this.rt.engine('accept.record_report', { run: facts.run.id, evidence: [] });
    // A requirement it cannot plan (D6 §5.4): routed to `change_spec` by
    // the owner through the replan's blocker (D3 X2), never a plan taken
    // over a conflict and never a silent change.
    const conflicts = ((report?.findings as { category?: string; criterion?: string; message?: string }[] | undefined) ?? []).filter((f) => f.category === 'requirement_conflict');
    if (conflicts.length > 0) return { refused: `requirement_conflict: the Architect reports a requirement it cannot plan (${conflicts.map((f) => f.criterion ?? f.message ?? '').join('; ')}); it is the owner's to route to a specification change` };
    // The result's declaration can add uncertainty, never remove a detected
    // change (D6 §5.4).
    if (report?.conformance === 'uncertain') {
      check.conformance = 'uncertain';
      check.routing = 'human';
    }
    const requests = facts.result?.report?.spec_change_requests ?? [];
    // A retrofit replan's field (D6 §8.3, B.7): carried by any other
    // project's replan, the result is not one this engine takes.
    if (requests.length > 0 && !(await this.rt.read<boolean>('project.adopted', { project: facts.project.id }))) {
      return { refused: 'spec_change_requests is a retrofit replan\'s field: this project was not adopted, and its specification changes are the owner\'s requests' };
    }
    if (check.outcome !== 'passed') {
      // Refused only for a dependency whose results are still to come (M543;
      // M444F-1): executions of the prerequisite phase's checks queued or
      // running on the newest candidate. Not refused, and no repair spent:
      // the replan goes back to wait for them (store/transitions/runs.ts),
      // held while they are in flight, and is checked again after.
      if (check.reasons.length > 0 && check.reasons.every((r) => r.code === 'PLAN_DEPENDENCY_INCOMPLETE')) {
        const dependsOn = roadmap.phases.find((ph) => ph.number === plan!.phase)?.depends_on ?? [];
        const pending = await this.rt.read<PendingPrerequisite[] | null>('replan.pending_prerequisites', { project: facts.project.id, depends_on: dependsOn });
        if (pending !== null) return { held: pending };
      }
      // Recorded as a refused check, with the requests the result carried
      // (D6 §8.3; SEAM.md §383), before the run fails its acceptance.
      await this.rt.engine('replan.record_refused', { project: facts.project.id, run: facts.run.id, phase: plan.phase, check, requests, declared });
      // An unknown requirement is offered through the spec-change workflow,
      // named in the refusal itself (D6 §5.4; the driver's ruling 5).
      const offer = check.needs_spec_change ? `; propose it through ${specChangeRoute(facts.project.id)}` : '';
      return { refused: `the plan check refused phase ${plan.phase}: ${check.reasons.map((r) => `${r.code} (${r.subjects.join(', ')})`).join('; ')}${offer}` };
    }
    const content: BundleContent = { modules: parsedArch.parsed.modules, roadmap, roadmap_changed: plan.roadmap_revision !== undefined || check.roadmap_revision, plan, adrs, architecture_text: architectureText };
    const bundle = await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'plan_check', content: Buffer.from(`${canonical({ run: facts.run.id, sha, phase: plan.phase, blobs, content, check })}\n`) });
    const obligations = await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'plan_check', content: Buffer.from(`${JSON.stringify({ bundle, planned_obligations: check.planned_obligations }, null, 2)}\n`) });
    // The complete diff of every changed artifact, the decision's evidence (D6 §5.4).
    const diff = await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'plan_check', content: Buffer.from(`${JSON.stringify({ bundle, diff: artifactDiff(against, artifacts, check.changes) }, null, 2)}\n`) });
    return {
      replan: {
        bundle,
        obligations_record: obligations,
        phase: plan.phase,
        head: sha,
        blobs,
        content,
        check,
        spec_revision: b.spec_revision,
        architecture_revision: b.architecture_revision,
        roadmap_revision: b.roadmap_revision,
        versions: { architecture: against.architecture_version, roadmap: against.roadmap_version, phase_plan: replacement ? replacement.generation + 1 : 1 },
        diff,
        declared,
        replaces: replacement ? { phase_plan: replacement.phase_plan, generation: replacement.generation, trigger: replacement.trigger, evidence: replacement.evidence, stale: replacement.stale, ...(replacement.counted ? { counted: replacement.counted } : {}) } : null,
        ...(requests.length > 0 ? { spec_change_requests: requests } : {}),
      },
    };
  }

  // A Verifier's or a Reviewer's run (SEAM.md §68): validated like a
  // Builder's and never committed. A run that changed nothing has its report
  // recorded; a Verifier's protected-only diff is captured as a proposal;
  // anything else is rejected whole.
  private async report(facts: AcceptFacts, tree: string, base: string, metadata: MetadataBaseline): Promise<RunEnd | null> {
    const repo = facts.project.repo;
    const run = facts.run.id;
    const diff = await validateDiff(repo, base, tree, facts.run.role, facts.caps, facts.roots);
    if (diff.violation) return violated(diff.violation);
    const ws = facts.workspace!;
    await pausePoint('snapshot.before_validate_outside');
    const outside = await validateOutside({ repo, path: ws.path, metadata, registry: facts.registry, moving: facts.moving, others: facts.others, scratch: this.rt.scratch, refFacts: () => this.rt.read<{ registry: { ref: string; expected_oid: string }[]; moving: Record<string, string[]> }>('integrity.registry', { project: facts.run.project }) });
    if (outside) return failed(outside.klass, outside.text);
    // A specification change's correction (D6 §4.5; the driver's rulings Q6,
    // Q13, Q-D; the slice-36 review's S1): the Verifier's applicability
    // assessments are validated against the open obligations here, and
    // recorded only in the transaction that records the run's report or
    // captures its correction, so a run that fails or is retried resolves
    // nothing. A correction that changes no check and assesses nothing while
    // its obligations are open is refused.
    const assessed = await this.correctionAssessments(facts, diff.changes.length);
    if ('outcome' in assessed) return assessed;
    const assessments = assessed.assessments;
    // A finding may name a check its own proposal adds (the driver's ruling
    // on loop run 1; invoke/choke.ts proposesChecks): judged here, against
    // the tree the proposal is captured from. A key that is neither the
    // effective version's nor a check of that tree refuses the result, as at
    // collection. The reference is bound when the proposal is decided
    // (store/transitions/protected.ts settleProposalFindings).
    const unknown = await this.proposedCheckRefusal(facts, repo, tree, diff.changes.length);
    if (unknown !== null) return failed('invalid_result', unknown);
    if (diff.changes.length === 0) {
      await this.recordReport(facts, assessments);
      return { outcome: 'completed', reason: 'none' };
    }
    const report = facts.result?.report ?? {};
    const evidence = await this.evidenceOf(facts);
    // Only a Verifier reaches here with changes, and only protected ones.
    const proposal = report.proposal;
    const rationale = await writeWholeRecord(this.rt, {
      project: facts.project.id,
      run,
      kind: 'proposal_rationale',
      content: Buffer.from(proposal?.rationale ?? 'The Verifier gave no rationale.'),
    });
    const required = async (rev: string) => {
      try {
        const text = await governedText(repoContext(repo), rev);
        return canonical(text === null ? null : ((JSON.parse(text) as { required_checks?: unknown }).required_checks ?? null));
      } catch {
        return 'unreadable';
      }
    };
    // An adopted project (D6 §8.3; B13): the adopted tests as declared, and
    // the protected root's import boundary checked against them.
    const adopted = await this.rt.read<boolean>('project.adopted', { project: facts.project.id });
    const adoptedTests = report.adopted_tests ?? [];
    let boundary: BoundaryError[] | null = [];
    // What earlier applied proposals declared stays declared (their copies
    // are already under the root): the boundary is theirs and this one's.
    if (adopted) boundary = await boundaryErrors(repo, tree, facts.roots, [...(await this.rt.read<AdoptedTest[]>('project.adopted_tests', { project: facts.project.id })), ...adoptedTests]);
    // B.7: deferrals are a phase authoring's only (D6 §6.2).
    if ((report.deferred_criteria ?? []).length > 0 && facts.work.kind !== 'check_authoring') return failed('invalid_result', 'deferred_criteria is the field of a phase\'s check authoring only');
    // Each deferral's prerequisite names a stage of the plan or an interface
    // of its module map (the slice-37 review's M5).
    if ((report.deferred_criteria ?? []).length > 0) {
      const invalid = await this.rt.read<string | null>('deferral.refs_invalid', { run: facts.run.id, deferrals: report.deferred_criteria });
      if (invalid !== null) return failed('invalid_result', invalid);
    }
    // SEAM.md §428: an authoring run's protected diff read, its proposal
    // not yet written.
    if (facts.work.kind === 'check_authoring') await pausePoint('check_authoring.before_proposal');
    await this.rt.engine('accept.capture_proposal', {
      run,
      base,
      tree,
      adoptedTests: report.adopted_tests ?? null,
      deferredCriteria: report.deferred_criteria ?? null,
      boundaryErrors: boundary === null ? [{ file: null, import: null, resolved: null, why: "the proposal's tree under the protected root could not be read, so its import boundary is unknown" }] : boundary,
      diffHash: diffHashOf(diff.changes),
      rationale,
      requested: proposal?.requested_change_kind ?? 'unclassifiable',
      changesRequiredSet: (await required(base)) !== (await required(tree)),
      evidence,
      ...(assessments ? { assessments } : {}),
    });
    return { outcome: 'completed', reason: 'none' };
  }

  private async proposedCheckRefusal(facts: AcceptFacts, repo: string, tree: string, changes: number): Promise<string | null> {
    const result = facts.result;
    if (!result || !proposesChecks(facts.run.role, result)) return null;
    const named = [...new Set((result.report?.findings ?? []).map((f) => f.check).filter((c): c is string => typeof c === 'string'))];
    if (named.length === 0) return null;
    const read = await this.rt.read<{ keys: string[] | null }>('run.check_keys', { run: facts.run.id });
    if (named.every((k) => (read.keys ?? []).includes(k))) return null;
    // The proposal's checks are read only when a key needs them.
    const proposed = changes === 0 ? [] : ((await discover(repo, tree))?.checks.map((c) => c.key) ?? null);
    return proposedCheckRefusal({ named, existing: read.keys ?? [], proposed, changes });
  }

  private async correctionAssessments(facts: AcceptFacts, changes: number): Promise<RunEnd | { assessments: { entries: ApplicabilityEntry[]; rationales: string[] } | null }> {
    const entries = facts.result?.report?.spec_applicability ?? [];
    if (facts.work.kind !== 'check_correction') {
      return entries.length > 0 ? failed('invalid_result', 'spec_applicability is the field of a specification change\'s correction only') : { assessments: null };
    }
    const c = await this.rt.read<{ request: string | null; open: string[]; resolves: string[][]; outside: string[] }>('spec.correction_facts', { run: facts.run.id, entries });
    if (entries.length > 0 && c.request === null) return failed('invalid_result', 'spec_applicability is the field of a specification change\'s correction only; this correction is not one');
    if (c.outside.length > 0) return failed('invalid_result', `spec_applicability names a check the effective protected version does not have: ${c.outside.join(', ')}`);
    const unmatched = entries.filter((_, i) => (c.resolves[i] ?? []).length === 0);
    if (unmatched.length > 0) {
      return failed('invalid_result', `spec_applicability names no open obligation it covers: ${unmatched.map((e) => `${e.check} (${e.criteria.join(', ')})`).join('; ')}`);
    }
    if (c.request !== null && c.open.length > 0 && changes === 0 && entries.length === 0) {
      return failed('invalid_result', `the correction changed no check and assessed none: the specification change's obligations on ${c.open.join(', ')} stay open`);
    }
    if (entries.length === 0) return { assessments: null };
    const rationales: string[] = [];
    for (const e of entries) rationales.push(await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'assessment_evidence', content: Buffer.from(e.rationale) }));
    return { assessments: { entries, rationales } };
  }

  // The records an applicability proposal's evidence is published as.
  private async evidenceOf(facts: AcceptFacts): Promise<(string | null)[]> {
    // What the report's content hashes need, made durable first.
    await ensureAncestry(this.rt, facts.project.id);
    const evidence: (string | null)[] = [];
    if (facts.run.role !== 'verifier') return evidence;
    for (const a of facts.result?.report?.applicability ?? []) {
      evidence.push(await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'assessment_evidence', content: Buffer.from(a.evidence) }).catch(() => null));
    }
    return evidence;
  }

  // What a Verifier's or a Reviewer's role reported, recorded with its run.
  private async recordReport(facts: AcceptFacts, assessments: { entries: ApplicabilityEntry[]; rationales: string[] } | null = null): Promise<void> {
    await this.rt.engine('accept.record_report', { run: facts.run.id, evidence: await this.evidenceOf(facts), alpha: await this.alphaOf(facts), ...(assessments ? { assessments } : {}) });
  }

  // A Reviewer's Alpha exception proposals (D2 §5 C1): one that may be made
  // has every reference its argument makes resolved, to a path at the
  // reviewed revision or to a record, into retained content, published with
  // the argument as a containment_evidence record (provenance claimed); one
  // that may not is refused before anything is published or raised.
  private async alphaOf(facts: AcceptFacts): Promise<AlphaPrepared[]> {
    const proposals = facts.run.role === 'reviewer' ? (facts.result?.report?.alpha_exception_proposals ?? []) : [];
    const out: AlphaPrepared[] = [];
    for (const p of proposals) {
      const check = await this.rt.read<{ ok: true; project: string; candidate: string; revision: string } | { ok: false; reason: string }>('alpha.check', { run: facts.run.id, finding: p.finding });
      if (!check.ok) {
        out.push({ refusal: check.reason });
        continue;
      }
      const references: Record<string, unknown>[] = [];
      let unresolved: string | null = null;
      for (const ref of p.references) {
        if ('path' in ref) {
          const content = await catBlob(repoContext(facts.project.repo), check.revision, ref.path);
          if (content === null) {
            unresolved = `the path ${ref.path} at ${check.revision}`;
            break;
          }
          references.push({ path: ref.path, revision: check.revision, sha256: sha256(content), content });
        } else {
          const row = await this.rt.read<{ project: string; path: string | null; sha256: string | null; bytes: number | null; published: number } | null>('record.row', { record: ref.record });
          const bytes = row && row.project === check.project && row.published === 1 && row.path !== null ? await readRecordBytes(this.rt.home, { path: row.path, sha256: row.sha256, bytes: row.bytes }) : null;
          if (bytes === null) {
            unresolved = `the record ${ref.record}`;
            break;
          }
          references.push({ record: ref.record, sha256: row!.sha256, content: bytes.toString('utf8') });
        }
      }
      if (unresolved !== null) {
        out.push({ refusal: 'reference_unresolved', detail: unresolved });
        continue;
      }
      const evidence = {
        provenance: 'claimed',
        proposed_by_run: facts.run.id,
        finding: p.finding,
        candidate: check.candidate,
        revision: check.revision,
        containment_text: p.containment_text,
        testing_purpose: p.testing_purpose,
        references,
      };
      try {
        out.push({ record: await writeWholeRecord(this.rt, { project: facts.project.id, run: facts.run.id, kind: 'containment_evidence', content: Buffer.from(JSON.stringify(evidence)) }) });
      } catch (err) {
        log('containment evidence', err, { run: facts.run.id });
        out.push({ refusal: 'evidence_unwritable' });
      }
    }
    return out;
  }

  // Drive every operation the run issued that has not settled, a few times
  // if a step of it fails.
  private async settleIssued(run: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
        const open = [...facts.commits, ...facts.integrations].filter((op) => op.state !== 'finalized' && op.state !== 'failed' && op.state !== 'ambiguous');
        for (const op of open) await this.journal.withProject(facts.project.id, () => this.journal.drive(op.id));
        return;
      } catch (err) {
        log('acceptance settle', err, { run });
        await sleep(Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS));
      }
    }
  }

  private commitFailed(settled: Settled): RunEnd {
    return failed('infra_error', `the run's commit could not be made (${settled.end}: ${JSON.stringify(settled.op.outcome_detail ?? {})})`);
  }

  private async driveCommit(id: string, c: AcceptFacts['commits'][number]): Promise<{ commit: AcceptFacts['commits'][number] } | { end: StepEnd }> {
    const settled = await this.journal.drive(id);
    if (settled.end !== 'finalized') return { end: unresolved(settled) ?? this.commitFailed(settled) };
    return { commit: { ...c, state: 'finalized' } };
  }

  // Intend and make the run's commit on `parent` (D1 §§7.3, 7.4).
  private async commit(facts: AcceptFacts, tree: string, parent: string, rebased: boolean): Promise<{ commit: AcceptFacts['commits'][number] } | { end: StepEnd }> {
    const repo = facts.project.repo;
    const checkpoint = facts.result?.checkpoint === true && !rebased;
    const title = `w-${facts.work.seq} ${facts.work.kind}: ${facts.work.goal ?? facts.result?.summary.split('\n')[0] ?? ''}`;
    const message = messageText({
      title,
      body: facts.result?.summary ?? '',
      trailers: [
        ['Surety-Run', facts.run.id],
        ['Surety-Role', facts.run.role],
        ['Surety-Base', parent],
        ['Surety-WorkItem', facts.work.id],
        ['Surety-Kind', facts.work.kind],
      ],
    });
    const content = commitContent({ tree, parent, message, at: nowIso() });
    const sha = await commitId(repo, content);
    if (sha === null) return { end: failed('infra_error', 'the commit could not be prepared: the repository could not be read') };
    const intent = await this.journal.withProject(facts.project.id, () =>
      this.journal.intend('accept.intend_commit', {
        project: facts.project.id,
        repo,
        run: facts.run.id,
        purpose: 'run',
        tree,
        parent,
        sha,
        content,
        revisionKind: checkpoint ? 'checkpoint' : facts.run.role === 'architect' ? 'intent' : 'engine_commit',
        checkpoint,
        workspace: facts.workspace!.id,
        fence: true,
        deadlineSeconds: this.rt.setting('git_deadline'),
      }, 'commit_tree'),
    );
    if ('fenced' in intent) return { end: null };
    const settled = await this.journal.withProject(facts.project.id, () => this.journal.drive(intent.operation));
    if (settled.end !== 'finalized') return { end: unresolved(settled) ?? this.commitFailed(settled) };
    return { commit: { id: intent.operation, state: 'finalized', status: 'succeeded', sha, parent, tree } };
  }
}
