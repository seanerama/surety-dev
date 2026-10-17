// The design's main-thread steps (D7 §§4 to 11): the inventory's engine
// commit through the journal and its record, and the design's part of every
// tick (the inventory due, design_due reviewed, readiness, the batch's
// release). No transaction is held across a git call; each store step is
// one transition of design/.

import { messageText } from '../git/commit.js';
import { repoContext } from '../git/exec.js';
import { catBlob } from '../git/repo.js';
import type { Journal } from '../journal/driver.js';
import { prepareCommit } from '../projects/commands.js';
import { type Runtime, log } from '../runtime.js';
import { pausePoint, seamBackends } from '../testing/seam.js';
import { type AssetManifest, MANIFEST_FILE } from './assets.js';
import { mergeTargetSlots, recordedPlaceholders } from './stale.js';
import { DESIGN_ROOT, INVENTORY_FILE } from './inventory.js';
import type { InventoryDue } from './store.js';
import { DesignPreviewer } from './preview.js';
import { releaseAnsweredBatches } from '../decisions/answer.js';

export class DesignDriver {
  // Projects whose inventory this incarnation is deriving now.
  private readonly inFlight = new Set<string>();
  // The design preview (D7 §5.7; design/preview.ts).
  readonly preview: DesignPreviewer;

  constructor(
    private readonly rt: Runtime,
    private readonly journal: Journal,
  ) {
    this.preview = new DesignPreviewer(rt);
  }

  // The inventory, derived and committed when it is due (D7 §1 step 4a, §4.4):
  // after a plan's publication, a policy change and at every tick.
  async deriveIfDue(project: string): Promise<void> {
    if (this.inFlight.has(project)) return;
    const due = await this.rt.read<InventoryDue>('design.inventory_due', { project, incarnation: this.rt.incarnation, inFlight: false });
    if (!due) return;
    if ('record' in due) {
      await this.rt.engine('design.record_inventory', { id: due.record });
      return;
    }
    this.inFlight.add(project);
    let failure: string | null = null;
    try {
      const d = due.derive;
      const committed = await this.journal.withProject(
        project,
        async () => {
          const facts = await this.rt.read<{ repo: string; head: string | null }>('design.repo_facts', { project });
          if (facts.head === null) return false;
          const ctx = repoContext(facts.repo);
          const files: Record<string, string> = { [INVENTORY_FILE]: d.text };
          for (const [path, text] of Object.entries(d.fixtures)) files[`${DESIGN_ROOT}${path}`] = text;
          // The placeholders, for every default slot and variant that has
          // none (§6.3): written with the manifest when the tree has none.
          const treeManifest = await catBlob(ctx, facts.head, MANIFEST_FILE);
          let recorded = d.placeholders.manifest;
          if (treeManifest === null) {
            files[MANIFEST_FILE] = `${JSON.stringify(d.placeholders.manifest, null, 2)}\n`;
            for (const [path, text] of Object.entries(d.placeholders.files)) files[`${DESIGN_ROOT}${path}`] = text;
          } else {
            // A target added (D7 §9.1): its default slots and placeholders
            // merged into the manifest the tree holds.
            let tree: AssetManifest | null = null;
            try {
              tree = JSON.parse(treeManifest) as AssetManifest;
            } catch {
              tree = null;
            }
            if (tree !== null && Array.isArray(tree.slots)) {
              const merged = mergeTargetSlots(tree, d.placeholders);
              if (merged !== null) {
                files[MANIFEST_FILE] = `${JSON.stringify(merged.manifest, null, 2)}\n`;
                for (const [path, text] of Object.entries(merged.files)) files[`${DESIGN_ROOT}${path}`] = text;
              }
              recorded = recordedPlaceholders(d.placeholders.manifest, merged?.manifest ?? tree);
            }
          }
          const message = messageText({ title: 'surety: the interface inventory', trailers: [['Surety-Project', project], ['Surety-Kind', 'intent'], ['Surety-Inventory', d.digest]] });
          const commit = await prepareCommit(facts.repo, facts.head, files, message, this.rt.scratch);
          if (commit === null) throw new Error('the inventory commit could not be prepared');
          const made = await this.journal.intend(
            'design.intend_inventory',
            { project, repo: facts.repo, head: facts.head, commit, digest: d.digest, inventory: d.inventory, manifest: recorded, incarnation: this.rt.incarnation, deadlineSeconds: this.rt.setting('git_deadline') },
            'commit_tree',
          );
          if (!('operation' in made)) return false;
          const settled = await this.journal.drive(made.operation);
          if (settled.end !== 'finalized') return false;
          const follow = (settled.receipts as { follow?: unknown }).follow;
          if (typeof follow !== 'string') return false;
          return (await this.journal.drive(follow)).end === 'finalized';
        },
        'design:inventory',
      );
      if (!committed) {
        failure = 'the inventory commit or the branch move to it did not finalize';
        return;
      }
      // After the engine's commit, before its record (SEAM.md §484).
      await pausePoint('design.inventory_committed');
      await this.rt.engine('design.record_inventory', { project, digest: d.digest });
    } catch (err) {
      failure = (err as Error).message;
      throw err;
    } finally {
      this.inFlight.delete(project);
      // Each failed attempt counted; design_due names a failure that repeats.
      await this.rt.engine('design.inventory_attempt', { project, failure }).catch((err) => log('design inventory', err, { project }));
    }
  }

  // design_due answered `open` (D7 §11): the Designer session allocated as
  // `POST …/sessions {role: designer}` allocates it (D6 §2.1: a run, its
  // grant, lease and workspace, no process before the owner's first turn).
  // The request is cleared first: an opening refused (another session open)
  // leaves the question's command for the owner, never a loop.
  async openRequested(project: string): Promise<void> {
    const requested = await this.rt.read<string | null>('design.open_requested', { project });
    if (requested === null || !this.rt.sessions) return;
    await this.rt.engine('design.open_cleared', { project, decision: requested });
    await this.rt.sessions.open(project, { role: 'designer', scripted: seamBackends().find((x) => x.id === 'scripted')?.version ?? null });
  }

  // The design's part of a tick.
  async step(project: string): Promise<void> {
    await this.openRequested(project).catch((err) => log('design session', err, { project }));
    await this.deriveIfDue(project).catch((err) => log('design inventory', err, { project }));
    await this.rt.engine('design.tick', { project }).catch((err) => log('design', err, { project }));
    await releaseAnsweredBatches(this.rt, project).catch((err) => log('design batch', err, { project }));
    await this.preview.expire(project).catch((err) => log('design preview', err, { project }));
  }
}
