// M33 (slice 3). Plan §3.3 M33 ("crash across journal and finalizer
// boundaries"); Plan §2 ("deterministic barriers at intent commit, effect
// application, receipt commit, probe confirmation and finalizer commit. A
// crash test observes durable state by reopening SQLite and inspecting real
// git, then resumes through the public API where available. It asserts
// identities, file/ref contents, effect/launch counts, evidence and
// disposition, not just a state label"); build spec §6 correction 14 (Review
// B05, B17); D1 §§6.3, 7.10, 16; D1-06, D1-18, D1-19, D1-22, D1-23, D1-32;
// SEAM.md §§33, 45, 46; ../contract/journal.json (`durable`, `recovery`,
// `finalizers`).
//
// For each of the four journal kinds the engine is killed at each of the five
// boundaries of one operation: after the intent is committed, after the
// effect and before its applied receipt, after the applied receipt, after the
// confirmation and before the finalizer, and after the finalizer's commit.
// The scenarios: the workspace of a dispatch (worktree_add), the commit of a
// Builder's run (commit_tree), its integration (ref_update), and the
// discarding of an abandoned run's workspace (worktree_remove).
//
// Each case first reads what the dead engine left: the journal's durable
// events and its state projection, the operation's status as its attempts
// derive it, what git holds of the effect, and the finalizer's receipts,
// which are there exactly when the journal says `finalized`. Then the engine
// is restarted. D1 §7.10 as drafted skipped `confirmed` entries; in force is
// that recovery visits every operation that is not finalized, confirmed ones
// included, which run only their finalizer. A receipt that was lost is
// reconstructed from what the probe finds; an effect that is there is never
// made again; an effect that is positively absent is retried once, as a new
// attempt of the same operation. The case asserts the operation finalized
// with a legal journal, the effect in git exactly once, the finalizer's
// receipts, the run and the work item, and that the engine's own effect is
// not reported out of band. The engine is then killed and started a second
// time: every receipt has the identity and content it had. Last, the work
// goes on through the public API.
//
// The cases are generated from the contract table, one per kind and boundary.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JOURNAL } from './harness/journal.mjs';
import { BOUNDARIES, KINDS, crashCase, crashTitle } from './harness/probes.mjs';

assert.deepEqual([KINDS.length, BOUNDARIES.length], [4, 5], 'the contract table carries four journal kinds and five boundaries');
for (const boundary of BOUNDARIES) assert.ok(JOURNAL.durable[boundary], `the contract table says what is durable at ${boundary}`);

for (const kind of KINDS) {
  describe(`M33 ${kind}: a crash at each boundary of the journal and of the finalizer`, () => {
    for (const boundary of BOUNDARIES) {
      test(crashTitle(kind, boundary), async (t) => {
        await crashCase(t, kind, boundary);
      });
    }
  });
}
