// M09, the legal paths that integrate, as far as snapshot, validation,
// commit and integration (slice 3, first session). Plan §3.2 M09 ("legal
// paths reach their intended outcome without fictitious integration"); D1
// §§4.1, 4.3, 7.3, 7.5, 7.8; A.5; E24 item 5; SEAM.md §§25, 28, 30;
// ../contract/work-items.json; ../contract/snapshot-validation.json.
//
// Slice 2 took each dispatched kind as far as `executing`. For the four
// kinds whose path integrates, a run that returns a valid result now goes
// on: its workspace is snapshotted, the snapshot validated and committed,
// the integration branch moved to the commit, and the work item passes
// through `integrating` to `integrated`. `stage_build` and `fix` are the
// Builder's and commit an engine_commit revision; `replan` and `assessment`
// are the Architect's (E24 item 5) and commit an intent revision.
//
// What follows `integrated` is the second slice-3 session's: `verifying`
// needs a chain of roles, and the plan and stage finalizers are row M26.
// These cases assert the path as far as `integrated`, and that all of it is
// legal for the kind.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertWorkHistory } from './harness/invariants.mjs';
import { addGitProject, addItem, roleThat, runToEnd } from './harness/gitruns.mjs';
import { VALIDATION, assertCommitted, outOfBand } from './harness/journal.mjs';
import { fileAt } from './harness/repos.mjs';
import { assertRunEnded, run as runRow, scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { WORK, roleOf } from './harness/transitions.mjs';

describe('M09 the kinds whose path integrates', () => {
  for (const [role, spec] of Object.entries(VALIDATION.roles)) {
    for (const kind of spec.kinds) {
      test(`a ${kind} run of the ${role} that returns a valid result is committed as ${spec.revision_kind} and integrated: eligible → claimed → executing → integrating → integrated`, async (t) => {
        assert.equal(roleOf(kind), role, `the contract table gives a ${kind} run to the ${role}`);
        assert.deepEqual(WORK.kinds[kind].path.slice(0, 5), ['eligible', 'claimed', 'executing', 'integrating', 'integrated']);
        const fx = await scriptedEngine(t);
        const project = await addGitProject(fx);
        const item = await addItem(fx, project.id, kind);
        const path = spec.permitted[0];
        fx.scripted.script(item, [roleThat([step.write(path, `written by a ${kind} run\n`)])]);
        const run = await runToEnd(fx, project.id, item);
        assert.equal(runRow(fx.home, run.id).role, role);
        const committed = assertCommitted(fx, run.id, { kind: spec.revision_kind, parent: project.base, integrated: true, changes: { [path]: 'A' } });
        assert.equal(fileAt(project.repo.path, committed.sha, path), `written by a ${kind} run\n`);
        // The run ended as every run ends: one terminal observation, one ledger row, lease released, grant revoked.
        assertRunEnded(fx.home, run.id, { outcome: 'completed', reason_class: 'none', workspace: 'retained', launched: true, recovery: false });
        // The whole history is legal for the kind, however far past `integrated` it has got.
        const history = withStore(fx.home, (db) => assertWorkHistory(db, item));
        assert.deepEqual(history.slice(0, 5), ['eligible', 'claimed', 'executing', 'integrating', 'integrated']);
        assert.deepEqual(outOfBand(fx.home, project.id), []);
      });
    }
  }
});
