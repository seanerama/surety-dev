// The effects of consumed decisions, and the application of a protected
// proposal (D1 §§7.9, 10.5; SEAM.md §§69, 76, 78, 79). The consuming
// transaction recorded the effect intent; here, on the main thread and with
// no transaction held across git, the effect is prepared, its preconditions
// are read again (in the transaction that begins it, with what the main
// thread read afresh), and it is made through the journal. An intent found
// pending after a restart is revalidated and executed then, once; one found
// executing is carried on by the journal's recovery, whose finalizer
// completes it.

import { commitContent, messageText } from '../git/commit.js';
import { git, gitOk, repoContext } from '../git/exec.js';
import { checkoutContext } from '../git/integrity.js';
import { checkoutBaseline, isAncestor, mergeBase, readRef, treeIndexHash } from '../git/repo.js';
import type { ApplicationFacts as SpecApplicationFacts } from '../spec/change.js';
import type { ApprovalFacts as SpecApprovalFacts } from '../spec/approval-effect.js';
import { appendChangeLog } from '../spec/changelog.js';
import { prepareCommit, treeWith } from '../projects/commands.js';
import { writeBlob } from '../git/repo.js';
import { rebaseTree } from '../git/rebase.js';
import type { Journal } from '../journal/driver.js';
import { commitId } from '../journal/effects.js';
import type { Policy } from '../config/project-policy.js';
import { preparePolicyCommit } from '../projects/commands.js';
import { protectedSetAt } from '../protected/set.js';
import { type Discovery, discover } from '../checks/discovery.js';
import { classificationInputs } from '../checks/classify-inputs.js';
import { nowIso } from '../clock.js';
import { type Runtime, log } from '../runtime.js';
import type { ApplicationFacts } from '../store/transitions/protected.js';
import { pausePoint } from '../testing/seam.js';

const SPEC_PATH = '.surety/spec/spec.md';

// The specification file at `rev`: its exact bytes and its mode, or null
// when either cannot be read. `blob`, when given, must be the blob there.
async function specFileAt(ctx: ReturnType<typeof repoContext>, rev: string, blob: string | null): Promise<{ bytes: Buffer; mode: string } | null> {
  const entry = (await gitOk(ctx, ['ls-tree', '-z', rev, '--', SPEC_PATH]))?.split('\0')[0] ?? '';
  const m = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry);
  if (!m || (blob !== null && m[2] !== blob)) return null;
  const r = await git(ctx, ['cat-file', 'blob', m[2]!]);
  return r.code === 0 ? { bytes: r.bytes, mode: m[1]! } : null;
}

interface IntentRow {
  id: string;
  project: string;
  decision: string;
  status: 'pending' | 'executing' | 'done' | 'invalidated';
  kind: 'protected_application' | 'policy_widening' | 'oob_stash' | 'oob_adopt' | 'alpha_exception' | 'spec_change_application' | 'spec_approval_application';
  plan: Record<string, unknown>;
  operation: string | null;
}

export class Effects {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly rt: Runtime,
    private readonly journal: Journal,
  ) {}

  // Run an intent's effect, once at a time.
  run(intent: string): Promise<void> {
    const existing = this.running.get(intent);
    if (existing) return existing;
    const p = this.execute(intent)
      .catch((err) => log('effect', err, { intent }))
      .finally(() => this.running.delete(intent));
    this.running.set(intent, p);
    return p;
  }

  // Approve-then-apply by a Reviewer's run has no intent: the proposal is
  // applied by the ticks after the approval (SEAM.md §69).
  private readonly applying = new Map<string, Promise<void>>();
  apply(proposal: string): Promise<void> {
    const existing = this.applying.get(proposal);
    if (existing) return existing;
    const p = applyProposal(this.rt, this.journal, proposal, null)
      .catch((err) => log('protected application', err, { proposal }))
      .finally(() => this.applying.delete(proposal));
    this.applying.set(proposal, p);
    return p;
  }

  // The tick's effects step for a project: every intent that is pending or
  // executing, and every proposal a Reviewer approved that is not applied.
  async step(project: string): Promise<void> {
    const due = await this.rt.read<{ intents: string[]; proposals: string[] }>('effects.due', { project });
    for (const intent of due.intents) await this.run(intent);
    for (const proposal of due.proposals) await this.apply(proposal);
  }

  private async execute(id: string): Promise<void> {
    let row = await this.rt.read<IntentRow | null>('intent.row', { intent: id });
    if (!row || row.status === 'done' || row.status === 'invalidated') return;
    // Between the consuming transaction and the revalidation (SEAM.md §76).
    if (row.status === 'pending') await pausePoint('intent.recorded');
    row = (await this.rt.read<IntentRow | null>('intent.row', { intent: id }))!;
    switch (row.kind) {
      case 'protected_application':
        await applyProposal(this.rt, this.journal, row.plan.proposal as string, row.id);
        return;
      case 'policy_widening':
        await this.widen(row);
        return;
      case 'oob_stash':
        await this.stash(row);
        return;
      case 'oob_adopt':
        await this.adopt(row);
        return;
      case 'spec_change_application':
        await this.applySpecChange(row);
        return;
      case 'spec_approval_application':
        await this.applySpecApproval(row);
        return;
      case 'alpha_exception':
        // A store-only effect: its preconditions read again and the
        // exception written in one transaction (D2 §5 C1).
        if (row.status === 'pending') await this.rt.engine('alpha.apply', { intent: row.id });
        return;
    }
  }

  // A spec change approved (D6 §4.5): the proposal's revision onto the
  // integration branch through the journal, rebased onto the head if it
  // moved (D1 §7.5, the spec files alone changing); the finalizer of the
  // branch's move is the approval's one effect (spec/change.ts).
  private async applySpecChange(row: IntentRow): Promise<void> {
    if (row.status === 'pending') {
      // What cannot be read or made as approved invalidates the intent and
      // asks the owner again (D1 §10.5; the 31b review's S7, M4).
      const refuse = (reason: string) => this.rt.engine('spec.refuse_application', { intent: row.id, reason });
      const facts = await this.rt.engine<SpecApplicationFacts | null>('spec.application_facts', { intent: row.id });
      if (facts === null || facts.revision === null) return void (await refuse('proposal'));
      const ctx = repoContext(facts.repo);
      const read = await readRef(ctx, facts.ref);
      if (read.state !== 'ok' || read.oid === null) return void (await refuse('integration_revision_unread'));
      const head = read.oid;
      // The branch is somewhere the engine did not put it: the integrity
      // observation takes it (D1 §7.6); nothing is begun meanwhile.
      if (head !== facts.head) return;
      // The approved text is the proposal's; the engine's change log row is
      // appended to it in the one commit the branch moves to (TPL §11; D6
      // §4.5 "appended"; the coordinator's ruling on question 2): on the
      // proposal when the head is its ancestor, else on the head with the
      // proposal rebased.
      let base: { tree: string; parent: string };
      const ancestor = await isAncestor(ctx, head, facts.revision);
      if (ancestor === null) return void (await refuse('integration_revision_unread'));
      if (ancestor === true) {
        const tree = (await gitOk(ctx, ['rev-parse', '--verify', '--quiet', `${facts.revision}^{tree}`]))?.trim() ?? null;
        if (tree === null) return void (await refuse('proposal_unread'));
        base = { tree, parent: facts.revision };
      } else {
        const mb = await mergeBase(ctx, head, facts.revision);
        if (mb === null) return void (await refuse('merge_base_unread'));
        // The approved representation is the proposal's: a rebase onto a
        // head whose spec files moved since the proposal's base would commit
        // a specification nobody approved (the 31b review's M4).
        const specAt = async (rev: string) => (await gitOk(ctx, ['rev-parse', '--verify', '--quiet', `${rev}:.surety/spec`]))?.trim() ?? null;
        const [atBase, atHead] = [await specAt(mb), await specAt(head)];
        if (atBase === null || atHead === null) return void (await refuse('spec_files_unread'));
        if (atBase !== atHead) return void (await refuse('spec_files_moved'));
        const rebased = await rebaseTree(facts.repo, mb, facts.revision, head, this.rt.scratch);
        if (rebased === 'unknown') return void (await refuse('rebase_unread'));
        if (rebased.conflict !== null) return void (await refuse(`rebase_conflict:${rebased.conflict}`));
        base = { tree: rebased.tree, parent: head };
      }
      if (facts.approved_by === null) throw new Error(`answer_actor_unreadable: the answer approving specification change ${facts.request} names no actor the engine can read; the change log row is not written`);
      const proposed = await specFileAt(ctx, facts.revision, null);
      if (proposed === null) return void (await refuse('proposal_unread'));
      const text = Buffer.from(appendChangeLog(proposed.bytes.toString('latin1'), { version: facts.version, date: nowIso().slice(0, 10), change: `Specification change ${facts.seq}`, approved_by: facts.approved_by }), 'latin1');
      const tree = await treeWith(facts.repo, base.tree, { [SPEC_PATH]: { bytes: text, mode: proposed.mode } }, this.rt.scratch);
      const blob = await writeBlob(ctx, text);
      if (tree === null || blob === null) return void (await refuse('commit_unprepared'));
      const message = messageText({ title: `surety: apply specification change ${facts.request} as version ${facts.version}`, trailers: [['Surety-Project', row.project], ['Surety-Spec-Change', facts.request]] });
      const content = commitContent({ tree, parent: base.parent, message, at: nowIso() });
      const sha = await commitId(facts.repo, content);
      if (sha === null) return void (await refuse('commit_unprepared'));
      const commit = { sha, tree, content, parent: base.parent, blob };
      const made = await this.journal.withProject(row.project, () => this.journal.intend('spec.begin_application', { intent: row.id, head, commit, deadlineSeconds: this.rt.setting('git_deadline') }, 'commit_tree'));
      if (made && 'operation' in made) await this.journal.withProject(row.project, () => this.journal.drive(made.operation));
    }
    await this.rt.services?.journal(row.project);
  }

  // A specification approved (D6 §3.4): TPL §11's change log row appended
  // to the saved text and committed on the head the decision was answered
  // at; the branch's move is finalized by the approval itself
  // (spec/approval-effect.ts).
  private async applySpecApproval(row: IntentRow): Promise<void> {
    if (row.status === 'pending') {
      const refuse = (reason: string) => this.rt.engine('spec.refuse_approval', { intent: row.id, reason });
      const facts = await this.rt.engine<SpecApprovalFacts | null>('spec.approval_facts', { intent: row.id });
      if (facts === null || facts.blob === null || facts.head === null) return void (await refuse('specification_unsaved'));
      // Who approved is part of the row: unread, the effect fails closed and
      // the intent is not done (the review's N3 (a)).
      if (facts.approved_by === null) throw new Error(`answer_actor_unreadable: the answer of decision ${facts.decision} names no actor the engine can read; the change log row is not written`);
      const ctx = repoContext(facts.repo);
      const read = await readRef(ctx, facts.ref);
      if (read.state !== 'ok' || read.oid === null) return void (await refuse('integration_revision_unread'));
      // The branch is somewhere the engine did not put it: the integrity
      // observation takes it (D1 §7.6); nothing is begun meanwhile.
      if (read.oid !== facts.head) return;
      // The saved file's bytes and mode, kept outside §11 (the review's N7).
      const saved = await specFileAt(ctx, facts.head, facts.blob);
      if (saved === null) return void (await refuse('specification_unread'));
      const text = appendChangeLog(saved.bytes.toString('latin1'), { version: facts.version, date: nowIso().slice(0, 10), change: facts.version === 1 ? 'First approved version' : `Approved from Spec Writer session ${facts.run}`, approved_by: facts.approved_by });
      const bytes = Buffer.from(text, 'latin1');
      const message = messageText({ title: `surety: specification version ${facts.version} approved`, trailers: [['Surety-Project', row.project], ['Surety-Decision', facts.decision]] });
      const commit = await prepareCommit(facts.repo, facts.head, { [SPEC_PATH]: { bytes, mode: saved.mode } }, message, this.rt.scratch);
      const blob = await writeBlob(ctx, bytes);
      if (commit === null || blob === null) return void (await refuse('commit_unprepared'));
      const made = await this.journal.withProject(row.project, () => this.journal.intend('spec.begin_approval', { intent: row.id, head: facts.head, commit, blob, deadlineSeconds: this.rt.setting('git_deadline') }, 'commit_tree'));
      if (made && 'operation' in made) await this.journal.withProject(row.project, () => this.journal.drive(made.operation));
    }
    await this.rt.services?.journal(row.project);
  }

  // A widening approved (SEAM.md §78): `.surety/policy.json` committed as
  // the decision's effect, on the base its preview was bound to.
  private async widen(row: IntentRow): Promise<void> {
    if (row.status === 'pending') {
      const facts = await this.rt.engine<{ repo: string; branch: string; head: string | null; effective: Policy; revision: number | null }>('project.policy_facts', {
        project: row.project,
      });
      let prepared: Record<string, unknown> | null = null;
      try {
        prepared = await preparePolicyCommit(this.rt, row.project, facts, row.plan.change as Policy);
      } catch (err) {
        log('policy widening', err, { intent: row.id });
      }
      if (prepared !== null) {
        const made = await this.journal.withProject(row.project, () => this.journal.intend('policy.begin_widening', { intent: row.id, project: row.project, prepared }, 'commit_tree'));
        if ('operation' in made) await this.journal.withProject(row.project, () => this.journal.drive(made.operation));
      } else {
        // What cannot be prepared is revalidated: a base that moved
        // invalidates the intent.
        await this.rt.engine('intent.revalidate', { intent: row.id, facts: {} });
      }
    }
    await this.rt.services?.journal(row.project);
  }

  private adopt(row: IntentRow): Promise<void> {
    return adoptCheckout(this.rt, this.journal, row);
  }

  // A checkout observation answered `stash` (SEAM.md §79): its tracked
  // content as reviewed is committed to a new registered oob ref, the
  // checkout restored to its baseline, and the observation reconciled.
  private async stash(row: IntentRow): Promise<void> {
    const facts = await this.rt.engine<{ repo: string; path: string; baseline: { head: string }; workspace?: { id: string; found: { head: string; tracked_tree_hash: string } } } | null>('oob.stash_facts', { intent: row.id });
    if (facts === null) return;
    if (facts.workspace) return this.stashWorkspace(row, facts as typeof facts & { workspace: NonNullable<typeof facts.workspace> });
    const ctx = await checkoutContext(facts.repo, facts.path);
    if (ctx === null) return;
    if (row.status === 'pending') {
      const now = await checkoutBaseline(ctx, this.rt.scratch);
      const found = now === null ? 'unreadable' : JSON.stringify(now);
      let made: { operation: string } | { fenced: true } | { operation: string; existing: boolean } = { fenced: true };
      if (now !== null) {
        const message = messageText({ title: `surety: stash the reviewed edits of ${facts.path}`, trailers: [['Surety-Project', row.project], ['Surety-Observation', String(row.plan.observation)]] });
        const content = commitContent({ tree: now.tracked_tree_hash, parent: now.head, message, at: nowIso() });
        const sha = await commitId(facts.repo, content);
        if (sha !== null) {
          made = await this.journal.withProject(row.project, () =>
            this.journal.intend(
              'oob.begin_stash',
              { intent: row.id, facts: { found }, repo: facts.repo, tree: now.tracked_tree_hash, parent: now.head, sha, content, deadlineSeconds: this.rt.setting('git_deadline') },
              'commit_tree',
            ),
          );
        }
      } else {
        await this.rt.engine('intent.revalidate', { intent: row.id, facts: { found } });
      }
      if ('operation' in made) await this.journal.withProject(row.project, () => this.journal.drive(made.operation));
    }
    await this.rt.services?.journal(row.project);
    const kept = await this.rt.read<boolean>('oob.stash_kept', { intent: row.id });
    if (!kept) return;
    // The stash is kept under its ref: the checkout goes back to its
    // baseline, files and index, and the observation is reconciled.
    const restored = await gitOk(ctx, ['read-tree', '--reset', '-u', facts.baseline.head]);
    if (restored === null) {
      log('stash restore', new Error(`the checkout ${facts.path} could not be restored to its baseline`), { intent: row.id });
      return;
    }
    await this.rt.engine('oob.stashed', { intent: row.id });
  }

  // A session's retained workspace answered `stash` (D6 §2.4): the content
  // the resume found (its snapshot tree on its checkpoint base) is committed
  // by the engine and kept under an oob ref through the journal; nothing is
  // adopted onto any branch, and the workspace is given up.
  private async stashWorkspace(row: IntentRow, facts: { repo: string; path: string; workspace: { id: string; found: { head: string; tracked_tree_hash: string } } }): Promise<void> {
    if (row.status === 'pending') {
      const found = JSON.stringify(facts.workspace.found);
      const message = messageText({ title: `surety: stash the uncommitted session workspace ${facts.path}`, trailers: [['Surety-Project', row.project], ['Surety-Observation', String(row.plan.observation)]] });
      const content = commitContent({ tree: facts.workspace.found.tracked_tree_hash, parent: facts.workspace.found.head, message, at: nowIso() });
      const sha = await commitId(facts.repo, content);
      if (sha === null) return;
      const made = await this.journal.withProject(row.project, () =>
        this.journal.intend(
          'oob.begin_stash',
          { intent: row.id, facts: { found }, repo: facts.repo, tree: facts.workspace.found.tracked_tree_hash, parent: facts.workspace.found.head, sha, content, deadlineSeconds: this.rt.setting('git_deadline') },
          'commit_tree',
        ),
      );
      if ('operation' in made) await this.journal.withProject(row.project, () => this.journal.drive(made.operation));
    }
    await this.rt.services?.journal(row.project);
    if (!(await this.rt.read<boolean>('oob.stash_kept', { intent: row.id }))) return;
    await this.rt.engine('oob.stashed', { intent: row.id });
    // The workspace's removal, intended by the stash's end, driven now.
    await this.rt.services?.journal(row.project);
  }
}

// A checkout observation answered `adopt` (D1 §§7.6, 7.8; brief B2; SEAM.md
// §§106, 111): the checkout's tracked content as reviewed (what `git commit
// -a` would commit) is committed by the engine onto the expected head, as an
// out-of-band revision; the checkout's index is set to that commit's tree;
// and the integration branch is moved to it through the journal, whose
// finalizer records the checkout's new baseline and reconciles the
// observation. The checkout's files are not touched.
async function adoptCheckout(rt: Runtime, journal: Journal, row: IntentRow): Promise<void> {
  const facts = await rt.engine<{ repo: string; path: string; baseline: { head: string } } | null>('oob.stash_facts', { intent: row.id });
  if (facts === null) return;
  if (row.status === 'pending') {
    const ctx = await checkoutContext(facts.repo, facts.path);
    const now = ctx === null ? null : await checkoutBaseline(ctx, rt.scratch);
    const found = now === null ? 'unreadable' : JSON.stringify(now);
    let made: { operation: string } | { fenced: true } | { operation: string; existing: boolean } = { fenced: true };
    if (now !== null) {
      const message = messageText({
        title: `surety: adopt the developer's edits of ${facts.path}`,
        trailers: [
          ['Surety-Project', row.project],
          ['Surety-Observation', String(row.plan.observation)],
          ['Surety-Kind', 'out_of_band'],
        ],
      });
      const content = commitContent({ tree: now.tracked_tree_hash, parent: now.head, message, at: nowIso() });
      const sha = await commitId(facts.repo, content);
      // The checkout's index is made the adopted commit's, so that it reads
      // clean once its HEAD follows the branch (Sean's decision on B2); its
      // files are not touched. The index it will then have is bound in the
      // baseline the branch update's finalizer records.
      const adoptedIndex = ctx === null ? null : await treeIndexHash(ctx, now.tracked_tree_hash, rt.scratch);
      if (sha !== null && adoptedIndex !== null) {
        made = await journal.withProject(row.project, () =>
          journal.intend(
            'oob.begin_adopt',
            {
              intent: row.id,
              facts: { found },
              repo: facts.repo,
              tree: now.tracked_tree_hash,
              parent: now.head,
              sha,
              content,
              index_hash: adoptedIndex,
              before_index: now.index_hash,
              deadlineSeconds: rt.setting('git_deadline'),
            },
            'commit_tree',
          ),
        );
        if ('operation' in made && !('existing' in made && made.existing) && ctx !== null) {
          if ((await gitOk(ctx, ['read-tree', now.tracked_tree_hash])) === null) {
            log('adopt', new Error(`the index of ${facts.path} could not be set to the adopted tree`), { intent: row.id });
          }
        }
      }
    } else {
      await rt.engine('intent.revalidate', { intent: row.id, facts: { found } });
    }
    if ('operation' in made) await journal.withProject(row.project, () => journal.drive(made.operation));
  }
  await rt.services?.journal(row.project);
}

// The application of an approved proposal (SEAM.md §69): its changes onto
// the commit the integration branch is at, one protected commit through the
// journal, whose finalizer makes the intended version the effective one.
export async function applyProposal(rt: Runtime, journal: Journal, proposal: string, intent: string | null): Promise<void> {
  let facts = await rt.engine<ApplicationFacts>('protected.application_facts', { proposal });
  const project = facts.project;
  if (facts.pending === null) {
    // The application is due, its approval recorded (the human's intent, or
    // a Reviewer's approval); its binding is revalidated next (SEAM.md §218).
    await pausePoint('protected_application.before_revalidation');
    facts = await rt.engine<ApplicationFacts>('protected.application_facts', { proposal });
  }
  if (facts.pending === null) {
    const read = await readRef(repoContext(facts.repo), facts.ref);
    const head = read.state === 'ok' ? read.oid : null;
    if (head === null) {
      if (intent) await rt.engine('intent.revalidate', { intent, facts: { head } });
      return;
    }
    // A Reviewer's approval waits while the branch is somewhere the engine
    // did not put it; a human's intent is judged against what is there.
    if (intent === null && head !== facts.head) return;
    let tree: string | null = facts.proposal.tree_id;
    if (head !== facts.proposal.base_revision) {
      const rebased = await rebaseTree(facts.repo, facts.proposal.base_revision, facts.proposal.tree_id, head, rt.scratch);
      tree = rebased === 'unknown' || rebased.conflict !== null ? null : rebased.tree;
    }
    const plain = tree === null ? null : await protectedSetAt(facts.repo, tree);
    // The new version's checks: the discovery frozen at classification, or,
    // for a proposal classification never discovered, the applied tree's.
    const frozen = await rt.read<Discovery | null>('protected.proposal_discovery', { proposal });
    const discovery = plain === null ? null : (frozen ?? (await discover(facts.repo, tree!)));
    const set = plain === null || discovery === null ? null : { ...plain, discovery };
    if (tree === null || set === null) {
      log('protected application', new Error(`proposal ${proposal} cannot be applied onto ${head}`), { proposal });
      if (intent) await rt.engine('intent.revalidate', { intent, facts: { head } });
      return;
    }
    // What is committed is the proposal's changes rebased onto the head;
    // what was classified, bound and revalidated is the proposal's own tree.
    // Their protected sets must be the same, or what would be applied is not
    // what was approved: nothing is applied, and the approval is withdrawn
    // as for any failed precondition (the review's M3). Unreadable, nothing
    // is begun now.
    if (tree !== facts.proposal.tree_id) {
      const own = await protectedSetAt(facts.repo, facts.proposal.tree_id);
      if (own === null) {
        log('protected application', new Error(`the protected set of proposal ${proposal}'s tree cannot be read; it is not applied now`), { proposal });
        return;
      }
      if (own.fingerprint !== plain!.fingerprint || canonicalRoots(own.roots) !== canonicalRoots(plain!.roots)) {
        await rt.engine('protected.application_diverged', { proposal, intent });
        return;
      }
    }
    const message = messageText({
      title: `surety: apply protected proposal ${proposal}`,
      trailers: [
        ['Surety-Project', project],
        ['Surety-Proposal', proposal],
      ],
    });
    const content = commitContent({ tree, parent: head, message, at: nowIso() });
    const sha = await commitId(facts.repo, content);
    if (sha === null) return;
    // What the classifier reads, read again immediately before the journal
    // intent, with the project's journal held (D3 §3.3; T10): the effective
    // version's tree and the proposal's. Unreadable, nothing is begun this
    // tick and nothing is invalidated: an unread tree is no evidence either
    // way, and a later tick reads again.
    const made = await journal.withProject(project, async () => {
      // The effective version read with the journal held (the review's M2):
      // the inputs are read at it, and the transaction keeps what they give
      // only if it is still the effective one there.
      const now = await rt.engine<ApplicationFacts>('protected.application_facts', { proposal });
      const revision = now.effective.authorized_revision;
      const inputs = revision === null ? null : await classificationInputs(facts.repo, revision, facts.proposal.tree_id);
      if (inputs === null) {
        log('protected application', new Error(`the trees proposal ${proposal} is classified from cannot be read; its binding is not revalidated, and it is not applied now`), { proposal });
        return { fenced: true as const };
      }
      return journal.intend(
        'protected.begin_application',
        { proposal, repo: facts.repo, head, tree, sha, content, set, intent, deadlineSeconds: rt.setting('git_deadline'), facts: { head }, inputs, inputsVersion: now.effective.id },
        'commit_tree',
      );
    });
    if (!('operation' in made)) return;
    await journal.withProject(project, () => journal.drive(made.operation));
  }
  await rt.services?.journal(project);
}

const canonicalRoots = (roots: readonly string[]): string => JSON.stringify([...roots].sort());

// The engine classifies every captured proposal at a tick after its capture,
// never in the capturing transaction (D3 §1.6; SEAM.md §215): the two trees
// read here with engine git, the classification computed and recorded by
// the store against the index as it then stands. A tree that cannot be read
// leaves the proposal captured; a later tick reads again.
export async function classifyDue(rt: Runtime, project: string): Promise<void> {
  const due = await rt.read<{ proposal: string; repo: string; effective: string; revision: string; tree: string }[]>('protected.unclassified', { project });
  for (const p of due) {
    const inputs = await classificationInputs(p.repo, p.revision, p.tree);
    if (inputs === null) {
      log('classification', new Error(`the trees of proposal ${p.proposal} cannot be read; it stays captured`), { proposal: p.proposal });
      continue;
    }
    await rt.engine('protected.record_classification', { proposal: p.proposal, effective: p.effective, inputs }).catch((err) => log('classification', err, { proposal: p.proposal }));
  }
}

// Before a protected application's operation is replayed (one this engine
// did not itself just intend): the application's binding read again (D3
// §3.3, "a replay after a restart is revalidated the same way"). Returns
// whether the operation may go on; false also when the trees cannot be read
// now, so nothing is attempted and a later pass reads again.
export async function revalidateReplay(rt: Runtime, operation: string): Promise<boolean> {
  const app = await rt.read<{ proposal: string; repo: string; effective: string | null; revision: string | null; tree: string } | null>('protected.operation_application', { operation });
  if (app === null) return true;
  const inputs = app.revision === null ? null : await classificationInputs(app.repo, app.revision, app.tree);
  if (inputs === null) {
    log('protected application', new Error(`the trees proposal ${app.proposal} is classified from cannot be read; its replay waits`), { operation });
    return false;
  }
  return rt.engine<boolean>('protected.revalidate_operation', { operation, inputs, inputsVersion: app.effective ?? undefined, incarnation: rt.incarnation });
}
