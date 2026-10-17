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
import { pausePoint } from '../testing/seam.js';
import { MANIFEST_FILE, placeholderPlan, sha256hex } from './assets.js';
import { DESIGN_ROOT, INVENTORY_FILE } from './inventory.js';
import { type InventoryDue, type PlaceholderRecord, placeholderSource } from './store.js';
import { DesignPreviewer } from './preview.js';
import { releaseAnsweredBatches } from '../decisions/answer.js';
import { type AssetAddBody, addOwnerAsset } from './asset-commands.js';

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
          // none (§6.3): written with the manifest when the tree has none;
          // merged into the manifest it has when the targets changed
          // (SEAM.md §506), nothing it holds replaced.
          //
          // What is recorded is the engine's placeholders alone (the review's
          // B2): every default slot and variant of this derivation, its
          // platforms the derivation's, its bytes where git holds them (this
          // commit, or an earlier derivation's), never the head manifest's
          // proposals.
          const existing = await catBlob(ctx, facts.head, MANIFEST_FILE);
          const plan = placeholderPlan(existing, d.placeholders, facts.head);
          for (const [path, text] of Object.entries(plan.files)) files[`${DESIGN_ROOT}${path}`] = text;
          const headManifest = plan.head_manifest;
          const previous = await this.rt.read<{ revision: string; manifest: PlaceholderRecord | null } | null>('design.placeholder_record', { project });
          const sources: Record<string, { revision: string; file: string }> = {};
          for (const slot of d.placeholders.manifest.slots) {
            for (const v of slot.variants) {
              if (!v.file || !v.digest) continue;
              const path = `${DESIGN_ROOT}${v.file}`;
              if (files[path] !== undefined) continue;
              const atHead = await catBlob(ctx, facts.head, path);
              if (atHead !== null && sha256hex(atHead) === v.digest) continue;
              const earlier = previous ? placeholderSource(previous.manifest, previous.revision, slot.key, v.name, v.digest) : null;
              if (earlier) {
                sources[`${slot.key}/${v.name}`] = earlier;
                continue;
              }
              // No commit known to hold it: written now, at its own path when
              // that is free, else beside the design's files.
              const own = atHead === null ? v.file : `assets/placeholders/${slot.key}/${v.name}.svg`;
              files[`${DESIGN_ROOT}${own}`] = d.placeholders.files[v.file]!;
              if (own !== v.file) sources[`${slot.key}/${v.name}`] = { revision: '', file: own };
            }
          }
          const manifest: PlaceholderRecord = { ...d.placeholders.manifest, sources, head_manifest: headManifest };
          const message = messageText({ title: 'surety: the interface inventory', trailers: [['Surety-Project', project], ['Surety-Kind', 'intent'], ['Surety-Inventory', d.digest]] });
          const commit = await prepareCommit(facts.repo, facts.head, files, message, this.rt.scratch);
          if (commit === null) throw new Error('the inventory commit could not be prepared');
          const made = await this.journal.intend(
            'design.intend_inventory',
            { project, repo: facts.repo, head: facts.head, commit, digest: d.digest, inventory: d.inventory, manifest, incarnation: this.rt.incarnation, deadlineSeconds: this.rt.setting('git_deadline') },
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

  // `surety design asset add` (D7 §6.3; SEAM.md §508): the owner's file,
  // checked by its header and committed as an engine intent revision.
  addAsset(project: string, body: AssetAddBody): Promise<{ status: number; body: Record<string, unknown> }> {
    return addOwnerAsset(this.rt, this.journal, project, body);
  }

  // The design's part of a tick.
  async step(project: string): Promise<void> {
    await this.deriveIfDue(project).catch((err) => log('design inventory', err, { project }));
    await this.rt.engine('design.tick', { project }).catch((err) => log('design', err, { project }));
    await releaseAnsweredBatches(this.rt, project).catch((err) => log('design batch', err, { project }));
    await this.preview.expire(project).catch((err) => log('design preview', err, { project }));
  }
}
