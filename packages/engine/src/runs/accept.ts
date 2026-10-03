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

import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { nowIso } from '../clock.js';
import { commitContent, messageText } from '../git/commit.js';
import { repoContext, worktreeContext } from '../git/exec.js';
import { catBlob, isAncestor, mergeBase, treeOf } from '../git/repo.js';
import { rebaseTree } from '../git/rebase.js';
import { type MetadataBaseline, snapshotTree, validateDiff, validateOutside } from '../git/snapshot.js';
import { materialize } from '../invoke/sandbox/materialize.js';
import type { Journal, Settled } from '../journal/driver.js';
import { branchCheckedOutAt, commitId } from '../journal/effects.js';
import { type RunEnd, type RunHandle, type Runtime, log } from '../runtime.js';
import type { AcceptFacts } from '../store/transitions/accept.js';
import { canonical, sha256 } from '../store/transitions/common.js';
import { governedText } from '../protected/set.js';
import { diffHashOf } from '../projects/commands.js';
import { readRecordBytes, writeWholeRecord } from '../records/files.js';
import type { AlphaPrepared } from '../store/transitions/findings.js';
import { ensureAncestry } from '../gates/prepare.js';
import type { RunEnder } from './end.js';

const RETRY_FIRST_MS = 500;
const RETRY_MAX_MS = 10_000;

export const INTEGRATING_KINDS = ['stage_build', 'fix', 'replan', 'assessment'];
// A Verifier's and a Reviewer's kinds: validated, never committed (SEAM.md §68).
export const REPORTING_KINDS = ['verification', 'review', 'check_correction'];
export const ACCEPTED_KINDS = [...INTEGRATING_KINDS, ...REPORTING_KINDS];

const failed = (reason: RunEnd['reason'], text: string, detail?: Record<string, unknown>): RunEnd => ({ outcome: 'failed', reason, reasonText: text, ...(detail ? { detail } : {}) });

// An operation the run issued whose effect git has not been made to tell
// (its command killed at the deadline, or its probe blocked): the run is
// neither ended nor failed on the strength of a timer (SEAM.md §§47, 110). It
// waits, held, until the journal has established what git did; then the
// pipeline goes on from durable state.
interface Wait {
  wait: string;
}
type StepEnd = RunEnd | null | Wait;
const isWait = (s: StepEnd): s is Wait => s !== null && 'wait' in s;
const unresolved = (settled: Settled): Wait | null => (settled.end === 'ambiguous' || settled.end === 'blocked' ? { wait: settled.op.id } : null);
const WAIT_POLL_MS = 250;

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
        if (end !== null && isWait(end)) {
          await this.awaitJournal(handle, end.wait);
          failures = -1;
          continue;
        }
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
        if (m.reason === 'secret') return failed('infra_error', `the secret screen refused the workspace's materialization: ${m.detail}; nothing of it reached the checkout`);
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
      if (settled.end !== 'finalized') return unresolved(settled) ?? this.commitFailed(settled);
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
      return failed('integration_conflict', `the compare-and-swap of the integration branch failed: ${String(detail?.text ?? 'the branch moved')}`, { park: 'integration_conflict' });
    }
    if (state !== 'finalized') return { wait: integration.id };

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
    if (diff.changes.length === 0) {
      await this.recordReport(facts);
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
  private async recordReport(facts: AcceptFacts): Promise<void> {
    await this.rt.engine('accept.record_report', { run: facts.run.id, evidence: await this.evidenceOf(facts), alpha: await this.alphaOf(facts) });
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
