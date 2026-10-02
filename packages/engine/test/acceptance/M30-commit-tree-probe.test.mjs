// M30 (slice 3). Plan §3.3 M30 ("commit-tree probe, all five outcomes":
// "Frozen parent/tree/commit inputs; object absent, object+keep ref present,
// object present without keep ref, inconsistent identity/pin, and unreadable
// object store"); Plan §2; build spec §6 correction 14 (Review B05); D1 §§6.5,
// 7.3, 7.10; D1-23, D1-32; SEAM.md §45; ../contract/journal.json (`probe`).
//
// The operation is the commit of a Builder's run: `git commit-tree` with the
// frozen parent and tree, and the publication of the commit under a keep ref.
// A commit's identity is the engine's own (its message and its dates), so the
// outcomes are made from what the engine made: the engine is killed after the
// effect, with the journal still `intended` or already `applied`, or left
// `ambiguous`, and then:
//
//   absent       the commit's object file and its keep ref are removed.
//                Reconciled absent and retried: the retry makes the very same
//                commit, with the id the first attempt gave it.
//   applied      object and keep ref as the effect left them. Finalized
//                without being made again.
//   partial      the object without its keep ref: the publication is the
//                bounded remaining effect, and is completed. The commit is not
//                made again as another commit.
//   conflicting  the operation's keep ref points at another commit. It
//                blocks: nothing is finalized as success, the ref is not
//                overwritten.
//   unknown      the object store cannot be read. It blocks.
//
// After a recovery that went through, exactly one commit object names the
// run, a revision records it, and it is reachable from a registered keep ref.
// Nothing is integrated by the recovery; the work is held and goes on by an
// explicit Resume.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROBE } from './harness/journal.mjs';
import { OUTCOMES, STATES, probeCase, probeCells } from './harness/probes.mjs';

const KIND = 'commit_tree';
const cells = probeCells(KIND);
assert.equal(cells.length, STATES.length * OUTCOMES.length, 'one case per durable state and probe outcome');
assert.deepEqual(OUTCOMES, ['absent', 'applied', 'partial', 'conflicting', 'unknown'], 'the five outcomes of correction 14');
for (const outcome of OUTCOMES) assert.ok(PROBE.dispositions[PROBE.kinds[KIND][outcome].leads_to], `the contract table says what ${outcome} leads to`);

for (const state of STATES) {
  describe(`M30 the commit_tree probe, from a journal that is ${state}`, () => {
    for (const cell of cells.filter((c) => c.state === state)) {
      test(cell.title, async (t) => {
        await probeCase(t, cell);
      });
    }
  });
}
