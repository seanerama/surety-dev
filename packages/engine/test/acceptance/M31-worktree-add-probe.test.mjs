// M31, the five outcomes of the worktree-add probe (slice 3). Plan §3.3 M31
// ("Frozen owned path/base; no artifacts, complete valid worktree, partial
// directory/metadata, foreign/conflicting occupancy, and unreadable
// metadata"); Plan §2; build spec §6 correction 14 (Review B05, B17); D1
// §§7.3, 7.10; SEAM.md §§35, 45; ../contract/journal.json (`probe`). Two
// cases of this row were written earlier: the engine home behind a symbolic
// link (slice 2) and a symbolic link at the workspace path (first session).
//
// The operation is the workspace of a dispatch: `git worktree add --detach`
// at the owned path $SURETY_HOME/workspaces/<run id>, at the run's base. The
// engine is killed before the effect (`intended`), after its receipt
// (`applied`), or left `ambiguous`, and then:
//
//   absent       nothing at the path, no metadata for it. Reconciled absent,
//                and the operation is withdrawn: a workspace is for one run,
//                the run is over, and nothing is added for it afterwards.
//   applied      a complete worktree. It is adopted once: one workspaces row,
//                one worktree in the repository, nothing added again.
//   partial      the repository's metadata for the path without its
//                directory; or, as three further cases, the metadata and the
//                directory with nothing checked out. The owned residue is
//                removed, under owned-path checks, and the operation
//                withdrawn.
//   conflicting  a directory with unrelated content at the owned path. It
//                blocks; the unrelated content is neither removed nor
//                absorbed.
//   unknown      the repository's worktree metadata cannot be read. It
//                blocks. (`git worktree list` leaves out, without a word, what
//                it cannot read: an engine that asks only git sees `absent`.)
//
// The run that was being dispatched is ended by the recovery and its work
// held; its role was never launched. The work goes on by an explicit Resume,
// in a workspace of its own.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROBE } from './harness/journal.mjs';
import { OUTCOMES, STATES, otherFormCells, probeCase, probeCells } from './harness/probes.mjs';

const KIND = 'worktree_add';
const cells = probeCells(KIND);
assert.equal(cells.length, STATES.length * OUTCOMES.length, 'one case per durable state and probe outcome');
assert.deepEqual(OUTCOMES, ['absent', 'applied', 'partial', 'conflicting', 'unknown'], 'the five outcomes of correction 14');
for (const outcome of OUTCOMES) assert.ok(PROBE.dispositions[PROBE.kinds[KIND][outcome].leads_to], `the contract table says what ${outcome} leads to`);

for (const state of STATES) {
  describe(`M31 the worktree_add probe, from a journal that is ${state}`, () => {
    for (const cell of cells.filter((c) => c.state === state)) {
      test(cell.title, async (t) => {
        await probeCase(t, cell);
      });
    }
  });
}

// `partial` has a second form for this kind, and it is the one a `git
// worktree add` leaves when it is cut short: git writes the metadata and the
// directory's link first and checks the files out last. The repository lists
// such a worktree, and its HEAD is at the base. It is not complete, and it is
// not adopted: it is the operation's own residue, removed like the first form.
const others = otherFormCells(KIND);
assert.deepEqual([...new Set(others.map((c) => `${c.outcome}/${c.form}`))], ['partial/unfinished_checkout'], 'the other forms the contract table names for this kind');
describe('M31 the worktree_add probe, a worktree whose checkout was not finished', () => {
  for (const cell of others) {
    test(cell.title, async (t) => {
      await probeCase(t, cell);
    });
  }
});
