// M29 (slice 3). Plan §3.3 M29 ("ref-update probe, all five outcome
// dispositions": "For one frozen ref intent, construct absent, applied,
// conflicting and unreadable/unknown fixtures; inject a claimed partial result
// with no declared remaining effect. Include durable states intended, applied
// and ambiguous"); Plan §2 (each of the four journal-probe rows requires all
// five outcomes, as separately reported cases); build spec §6 correction 14
// (Review B05, B17); D1 §§7.5, 7.10, 16; D1-06, D1-19; SEAM.md §45;
// ../contract/journal.json (`probe`, `transitions`, `attempts`).
//
// The operation is the integration of a Builder's run: a compare-and-swap of
// the integration branch from the commit it was at to the run's commit. The
// engine is killed with the journal `intended` (before the swap) or `applied`
// (after its receipt), or left `ambiguous` by a restart that could not read
// the repository. The branch is then put by hand where the outcome says:
//
//   absent       at the old commit. Reconciled absent, then one retry as a new
//                attempt of the same operation: the swap is made once.
//   applied      at the new commit. Confirmed and finalized without the swap
//                being repeated; an applied receipt that was lost is
//                reconstructed from the observation.
//   partial      a single-ref swap has no partially written state, so the
//                result is claimed (--harness-probe) with no remaining effect
//                declared. It blocks: no retry scope is invented.
//   conflicting  at a third commit. It blocks; the unexpected head is not
//                overwritten, and the registry does not absorb it.
//   unknown      the repository cannot be read. It blocks.
//
// A blocked operation is ambiguous, with one open blocker that names it;
// nothing of its project is dispatched, its work item is neither integrated
// nor held, and further ticks change nothing. Every case then removes what
// blocked it the way an operator would and shows the operation going through,
// so that an engine which blocks everything cannot pass (Plan §5).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROBE } from './harness/journal.mjs';
import { OUTCOMES, STATES, probeCase, probeCells } from './harness/probes.mjs';

const KIND = 'ref_update';
const cells = probeCells(KIND);
assert.equal(cells.length, STATES.length * OUTCOMES.length, 'one case per durable state and probe outcome');
assert.deepEqual(OUTCOMES, ['absent', 'applied', 'partial', 'conflicting', 'unknown'], 'the five outcomes of correction 14');
for (const outcome of OUTCOMES) assert.ok(PROBE.dispositions[PROBE.kinds[KIND][outcome].leads_to], `the contract table says what ${outcome} leads to`);

for (const state of STATES) {
  describe(`M29 the ref_update probe, from a journal that is ${state}`, () => {
    for (const cell of cells.filter((c) => c.state === state)) {
      test(cell.title, async (t) => {
        await probeCase(t, cell);
      });
    }
  });
}
