// M32 (slice 3). Plan §3.3 M32 ("worktree-remove probe, all five outcomes":
// "Frozen owned workspace identity; still present, fully removed, partial
// metadata/directory cleanup, replacement/foreign path, and unreadable
// state"); Plan §2; build spec §6 correction 14 (Review B05); D1 §§4.5, 7.10;
// SEAM.md §45; ../contract/journal.json (`probe`).
//
// The operation is the discarding of an abandoned run's workspace: `git
// worktree remove` of the owned path. The engine is killed before the effect
// (`intended`), after its receipt (`applied`), or left `ambiguous`, and then:
//
//   absent       the worktree is still there. Reconciled absent and removed
//                by one retry.
//   applied      nothing is left. The completed removal is not repeated.
//   partial      the directory is gone and the repository's metadata for it
//                remains. Removal is not reported complete while owned
//                residue remains: the residue is removed, and only that.
//   conflicting  the worktree is gone and a directory with unrelated content
//                is at its path. It blocks; the unrelated files are preserved.
//   unknown      the repository's worktree metadata cannot be read. It blocks.
//
// While the removal is blocked the abandoned run is not ended, its workspace
// is not recorded discarded and its work is not released: nothing the old run
// held is reused. Once the removal goes through the run ends `abandoned`, the
// workspace is discarded once, and the work waits under its dispatch hold for
// an explicit Resume.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROBE } from './harness/journal.mjs';
import { OUTCOMES, STATES, probeCase, probeCells } from './harness/probes.mjs';

const KIND = 'worktree_remove';
const cells = probeCells(KIND);
assert.equal(cells.length, STATES.length * OUTCOMES.length, 'one case per durable state and probe outcome');
assert.deepEqual(OUTCOMES, ['absent', 'applied', 'partial', 'conflicting', 'unknown'], 'the five outcomes of correction 14');
for (const outcome of OUTCOMES) assert.ok(PROBE.dispositions[PROBE.kinds[KIND][outcome].leads_to], `the contract table says what ${outcome} leads to`);

for (const state of STATES) {
  describe(`M32 the worktree_remove probe, from a journal that is ${state}`, () => {
    for (const cell of cells.filter((c) => c.state === state)) {
      test(cell.title, async (t) => {
        await probeCase(t, cell);
      });
    }
  });
}
