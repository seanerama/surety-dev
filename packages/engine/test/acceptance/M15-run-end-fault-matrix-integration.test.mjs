// M15, the run-end fault matrix for the endings that pass through a commit
// or an integration (slice 3, second session; E28 item 1). Plan §3.2 M13 to
// M18 and §3.3 M21, M22, M28, M33; D1 §§4.5, 6.3, 7.3 to 7.5, 7.10, 12.1;
// SEAM.md §§24, 48; ../contract/run-end-faults.json (the endings marked
// `through: integration`).
//
// The first session's matrix (M15-run-end-fault-matrix.test.mjs) covers the
// ten ways a run could end in slice 2. Slice 3 adds endings whose path holds
// a commit and an integration, and the rule is the same: every step of
// ending a run, repeated after a partial failure, writes the same facts as
// the first time. The endings:
//
//   - a role completes and its work integrates;
//   - an integration that is refused (the branch is checked out in a worktree
//     the engine does not own);
//   - Stop, and Abandon, while the work is integrating: the ref update is
//     journaled and waits at its barrier when the command is confirmed;
//   - a checkpoint: the snapshot is committed as a working revision and the
//     work is continued by a second run.
//
// For each ending there is one reference case, the ending with no fault, and
// one case per store transaction on its path: the role's result, the
// domain's termination, each event of the commit's journal and the revision,
// the work item's moves, each event of the ref update's journal (armed
// between the commit and the integration), the refused operation, the
// blocker, the removal of an abandoned workspace, and the run's end. A case
// arms a one-shot fault on its transaction and requires that, without a
// restart, the project reaches the same final durable facts as the
// reference. Beyond the facts of the first matrix, the comparison here holds
// what the repository and the journal hold: the commits the branch gained
// and the paths they changed, every registered ref against the registry, the
// revisions, and every operation's journal events, state projection and
// attempt statuses. A step that was repeated as a recovery would show there:
// a reconciled attempt, a second attempt, a second commit.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ENDINGS, assertCell, matrixCells, reference, throughIntegration } from './harness/endings.mjs';

const endings = Object.entries(ENDINGS).filter(([, spec]) => throughIntegration(spec));
const cells = matrixCells().filter((cell) => throughIntegration(ENDINGS[cell.ending]));
assert.deepEqual(endings.map(([name]) => name), ['integrates', 'integration_conflict', 'stop_integrating', 'abandon_integrating', 'checkpoint'], 'the contract table carries the five endings through integration');
assert.ok(cells.length >= 50, 'and their transactions');

for (const [name, spec] of endings) {
  describe(`M15 ending a run is repeatable: ${spec.title}`, () => {
    test(`${spec.title}, with no fault: the reference ends as the contract table says`, async () => {
      await reference(name);
    });
    for (const cell of cells.filter((c) => c.ending === name)) {
      const when = cell.fault.stage === 'committed' ? ', after the commit' : '';
      test(`${spec.title}; ${cell.fault.what} (${cell.fault.event_type}${when}) fails once: the same facts as with no fault, without a restart`, async (t) => {
        await assertCell(t, cell);
      });
    }
  });
}
