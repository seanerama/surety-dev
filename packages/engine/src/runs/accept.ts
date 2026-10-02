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

import { setTimeout as sleep } from 'node:timers/promises';

import { nowIso } from '../clock.js';
import { commitContent, messageText } from '../git/commit.js';
import { repoContext, worktreeContext } from '../git/exec.js';
import { isAncestor, mergeBase, treeOf } from '../git/repo.js';
import { rebaseTree } from '../git/rebase.js';
import { type MetadataBaseline, snapshotTree, validateDiff, validateOutside } from '../git/snapshot.js';
import type { Journal, Settled } from '../journal/driver.js';
import { branchCheckedOutAt, commitId } from '../journal/effects.js';
import { type RunEnd, type RunHandle, type Runtime, log } from '../runtime.js';
import type { AcceptFacts } from '../store/transitions/accept.js';
import { canonical } from '../store/transitions/common.js';
import { governedText } from '../protected/set.js';
import { diffHashOf } from '../projects/commands.js';
import { writeWholeRecord } from '../records/files.js';
import { ensureAncestry } from '../gates/prepare.js';
import type { RunEnder } from './end.js';

const RETRY_FIRST_MS = 500;
const RETRY_MAX_MS = 10_000;

export const INTEGRATING_KINDS = ['stage_build', 'fix', 'replan', 'assessment'];
// A Verifier's and a Reviewer's kinds: validated, never committed (SEAM.md §68).
export const REPORTING_KINDS = ['verification', 'review', 'check_correction'];
export const ACCEPTED_KINDS = [...INTEGRATING_KINDS, ...REPORTING_KINDS];

const failed = (reason: RunEnd['reason'], text: string, detail?: Record<string, unknown>): RunEnd => ({ outcome: 'failed', reason, reasonText: text, ...(detail ? { detail } : {}) });

export class Acceptor {
  constructor(
    private readonly rt: Runtime,
    private readonly ender: RunEnder,
    private readonly journal: Journal,
  ) {}

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
        if (end) this.rt.requestEnd(handle, { ...end, ...(handle.exitAt ? { decidedAt: handle.exitAt } : {}) });
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

  // One pass from durable state. Returns the run's end, or null when the run
  // is no longer the pipeline's to end (a Stop or an Abandon took it).
  private async step(run: string): Promise<RunEnd | null> {
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
        if (REPORTING_KINDS.includes(facts.work.kind)) return { outcome: 'completed', reason: 'none' };
        return failed('infra_error', "the termination of the run's domain could not be established, so what the role left cannot be known; nothing of it was captured");
      }
      facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
      if (facts.run.state !== 'validating') return null;
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
      if (diff.violation) return failed(diff.violation.klass, diff.violation.text);
      const outside = await validateOutside({ repo, path: ws.path, metadata, registry: facts.registry, moving: facts.moving, others: facts.others, scratch: this.rt.scratch });
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
      if (settled.end !== 'finalized') return this.commitFailed(settled);
    }

    // 5. A checkpoint is a working revision: the work is continued later.
    if (facts.result?.checkpoint === true) {
      await this.rt.engine('accept.checkpoint', { run, sha: commit.sha });
      return { outcome: 'completed', reason: 'none' };
    }

    // 6. Integration.
    if (!(await this.rt.engine<boolean>('accept.integrating', { run }))) return null;
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
          return failed('integration_conflict', `the integration branch moved to ${head}, and the run's changes to ${rebased.conflict} do not apply to it`, { park: 'integration_conflict' });
        }
        const check = await validateDiff(repo, head, rebased.tree, role, facts.caps, facts.roots);
        if (check.violation) return failed(check.violation.klass, `the rebased result: ${check.violation.text}`);
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
      if (plans.violation) return failed(plans.violation.klass, plans.violation.text);
      const intent = await this.journal.withProject(facts.project.id, () =>
        this.journal.intend('accept.intend_integration', { run, repo, head, commit: target.sha, plans: plans.plans, deadlineSeconds: this.rt.setting('git_deadline') }, 'ref_update'),
      );
      if ('fenced' in intent) return null;
      facts = await this.rt.engine<AcceptFacts>('accept.facts', { run });
      integration = facts.integrations.at(-1)!;
    }
    let settled: Settled | null = null;
    if (integration.state !== 'finalized' && integration.state !== 'failed') {
      settled = await this.journal.withProject(facts.project.id, () => this.journal.drive(integration!.id));
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
      return failed('integration_conflict', `the compare-and-swap of the integration branch failed: ${String(detail?.text ?? 'the branch moved')}`, { park: 'integration_conflict' });
    }
    if (state !== 'finalized') return failed('infra_error', 'the integration could not be confirmed: its operation is ambiguous, and the journal will reconcile it');

    // 7. A nomination that is due.
    await this.rt.services?.nominate(facts.project.id).catch((err) => log('nomination', err, { project: facts.project.id }));
    return { outcome: 'completed', reason: 'none' };
  }

  // A Verifier's or a Reviewer's run (SEAM.md §68): validated like a
  // Builder's and never committed. A run that changed nothing has its report
  // recorded; a Verifier's protected-only diff is captured as a proposal;
  // anything else is rejected whole.
  private async report(facts: AcceptFacts, tree: string, base: string, metadata: MetadataBaseline): Promise<RunEnd | null> {
    const repo = facts.project.repo;
    const run = facts.run.id;
    const diff = await validateDiff(repo, base, tree, facts.run.role, facts.caps, facts.roots);
    if (diff.violation) return failed(diff.violation.klass, diff.violation.text);
    const ws = facts.workspace!;
    const outside = await validateOutside({ repo, path: ws.path, metadata, registry: facts.registry, moving: facts.moving, others: facts.others, scratch: this.rt.scratch });
    if (outside) return failed(outside.klass, outside.text);
    // What the report's records and content hashes need, made durable first.
    await ensureAncestry(this.rt, facts.project.id);
    const report = facts.result?.report ?? {};
    const evidence: (string | null)[] = [];
    if (facts.run.role === 'verifier') {
      for (const a of report.applicability ?? []) {
        evidence.push(await writeWholeRecord(this.rt, { project: facts.project.id, run, kind: 'assessment_evidence', content: Buffer.from(a.evidence) }).catch(() => null));
      }
    }
    if (diff.changes.length === 0) {
      await this.rt.engine('accept.record_report', { run, evidence });
      return { outcome: 'completed', reason: 'none' };
    }
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
    await this.rt.engine('accept.capture_proposal', {
      run,
      base,
      tree,
      diffHash: diffHashOf(diff.changes),
      rationale,
      requested: proposal?.requested_change_kind ?? 'unclassifiable',
      changesRequiredSet: (await required(base)) !== (await required(tree)),
      evidence,
    });
    return { outcome: 'completed', reason: 'none' };
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

  private async driveCommit(id: string, c: AcceptFacts['commits'][number]): Promise<{ commit: AcceptFacts['commits'][number] } | { end: RunEnd }> {
    const settled = await this.journal.drive(id);
    if (settled.end !== 'finalized') return { end: this.commitFailed(settled) };
    return { commit: { ...c, state: 'finalized' } };
  }

  // Intend and make the run's commit on `parent` (D1 §§7.3, 7.4).
  private async commit(facts: AcceptFacts, tree: string, parent: string, rebased: boolean): Promise<{ commit: AcceptFacts['commits'][number] } | { end: RunEnd | null }> {
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
    if (settled.end !== 'finalized') return { end: this.commitFailed(settled) };
    return { commit: { id: intent.operation, state: 'finalized', status: 'succeeded', sha, parent, tree } };
  }
}
