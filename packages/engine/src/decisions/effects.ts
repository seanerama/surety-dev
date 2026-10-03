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
import { gitOk, repoContext } from '../git/exec.js';
import { checkoutContext } from '../git/integrity.js';
import { checkoutBaseline, readRef } from '../git/repo.js';
import { rebaseTree } from '../git/rebase.js';
import type { Journal } from '../journal/driver.js';
import { commitId } from '../journal/effects.js';
import { preparePolicyCommit } from '../projects/commands.js';
import { protectedSetAt } from '../protected/set.js';
import { nowIso } from '../clock.js';
import { type Runtime, log } from '../runtime.js';
import type { ApplicationFacts } from '../store/transitions/protected.js';
import { pausePoint } from '../testing/seam.js';

interface IntentRow {
  id: string;
  project: string;
  decision: string;
  status: 'pending' | 'executing' | 'done' | 'invalidated';
  kind: 'protected_application' | 'policy_widening' | 'oob_stash' | 'oob_adopt';
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
    }
  }

  // A widening approved (SEAM.md §78): `.surety/policy.json` committed as
  // the decision's effect, on the base its preview was bound to.
  private async widen(row: IntentRow): Promise<void> {
    if (row.status === 'pending') {
      const facts = await this.rt.engine<{ repo: string; branch: string; head: string | null; effective: Record<string, number>; revision: number | null }>('project.policy_facts', {
        project: row.project,
      });
      let prepared: Record<string, unknown> | null = null;
      try {
        prepared = await preparePolicyCommit(this.rt, row.project, facts, row.plan.change as Record<string, number>);
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
    const facts = await this.rt.engine<{ repo: string; path: string; baseline: { head: string } } | null>('oob.stash_facts', { intent: row.id });
    if (facts === null) return;
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
}

// A checkout observation answered `adopt` (D1 §§7.6, 7.8; brief B2): the
// checkout's tracked content as reviewed is committed by the engine onto the
// expected head, as an out-of-band revision, and the integration branch is
// moved to it through the journal; the finalizer of that move records the
// checkout's new baseline and reconciles the observation. Nothing in the
// developer's checkout is written: its files and its index stay as they are.
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
      if (sha !== null) {
        made = await journal.withProject(row.project, () =>
          journal.intend(
            'oob.begin_adopt',
            { intent: row.id, facts: { found }, repo: facts.repo, tree: now.tracked_tree_hash, parent: now.head, sha, content, index_hash: now.index_hash, deadlineSeconds: rt.setting('git_deadline') },
            'commit_tree',
          ),
        );
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
  const facts = await rt.engine<ApplicationFacts>('protected.application_facts', { proposal });
  const project = facts.project;
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
    const set = tree === null ? null : await protectedSetAt(facts.repo, tree);
    if (tree === null || set === null) {
      log('protected application', new Error(`proposal ${proposal} cannot be applied onto ${head}`), { proposal });
      if (intent) await rt.engine('intent.revalidate', { intent, facts: { head } });
      return;
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
    const made = await journal.withProject(project, () =>
      journal.intend(
        'protected.begin_application',
        { proposal, repo: facts.repo, head, tree, sha, content, set, intent, deadlineSeconds: rt.setting('git_deadline'), facts: { head } },
        'commit_tree',
      ),
    );
    if (!('operation' in made)) return;
    await journal.withProject(project, () => journal.drive(made.operation));
  }
  await rt.services?.journal(project);
}
