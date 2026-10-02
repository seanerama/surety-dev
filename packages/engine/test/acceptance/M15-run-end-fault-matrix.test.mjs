// M15, the run-end fault matrix (slice 3; E28 item 1). Plan §3.2 M13 to M18
// ("cleanup can persist usage", "finalizes once", "exactly one cleanup/ledger
// outcome"); D1 §§4.5, 6.3, 8.1 step 1, 8.3, 12.1, 16.2; E27 item 5; SEAM.md
// §§16 and 24; ../contract/run-end-faults.json.
//
// Three reviews of slice 2 each found one more way in which ending a run went
// wrong after a single failed store transaction. The rule is now stated once
// and tested as a matrix: every step of ending a run is repeatable, and a
// step repeated after a partial failure writes the same facts it would have
// written the first time.
//
// For each way a run can end in slice 2 (a role completes; a role fails with
// a result that is not valid; a preflight refusal after a lease was issued; a
// deadline; Stop from claimed and from executing; Abandon from claimed and
// from executing; a lease expiry reconciled by the tick; a quarantine
// followed by its clearance) there is one reference case, the ending with no
// fault, and one case for each store transaction on that ending's path. A
// case arms a one-shot fault on its transaction and requires that, without a
// restart, the project reaches the same final durable facts as the reference:
// the run's outcome and reason, the work item's status and counters, the
// lease released, the grant revoked, the domains' statuses, the workspace's
// disposition on disk and in the repository, the receipt's status
// observations, exactly the ledger rows, the operations and their statuses,
// the decisions, the number of events of every type, and the project's next
// item dispatched. Facts are compared, not ids or timestamps.
//
// The cases are generated from the contract table; each is reported on its
// own. The expected facts of each ending are in that table too, so the
// reference is itself checked against the sources and not only against the
// engine's own behaviour without a fault.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ENDINGS, STAGES, assertCell, matrixCells, reference } from './harness/endings.mjs';

const cells = matrixCells();
assert.ok(cells.length >= 60, 'the contract table carries the matrix');
for (const cell of cells) assert.ok(STAGES.includes(cell.fault.stage) && typeof cell.fault.event_type === 'string', `a cell names its event and stage: ${JSON.stringify(cell)}`);

for (const [name, spec] of Object.entries(ENDINGS)) {
  describe(`M15 ending a run is repeatable: ${spec.title}`, () => {
    test(`${spec.title}, with no fault: the reference ends as the contract table says`, async () => {
      await reference(name);
    });
    for (const cell of cells.filter((c) => c.ending === name)) {
      const when = cell.fault.stage === 'quarantined' ? ', after the quarantine' : '';
      test(`${spec.title}; ${cell.fault.what} (${cell.fault.event_type}${when}) fails once: the same facts as with no fault, without a restart`, async (t) => {
        await assertCell(t, cell);
      });
    }
  });
}
