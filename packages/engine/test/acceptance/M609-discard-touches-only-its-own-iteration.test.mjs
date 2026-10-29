// M609, Discard touches only its own iteration (the owner's draft M7 plan
// §3, row M609; request §9; ruling R8 of 2026-10-28, with S3; SEAM.md
// §575). Kernel lane, the scripted deployment adapter.
//
//   (b) after Iterate, the predecessor discarded while the newer iteration
//       holds the environment: the Alpha left in place with kept_because;
//       the predecessor discarded.
//   (a) the current iteration discarded while its deployment is the
//       environment's current one: the teardown requested, status
//       discarded, ended_at; alpha.current null once the teardown
//       finalizes (and its candidate no longer claimed alpha_deployed).
//   (c) history: receipts, runs, ledger rows, records and alpha_at
//       unchanged by either Discard.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { operationsOf } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  PROTO,
  briefToAlpha,
  candidatesOfProject,
  confirmed,
  decisionRead,
  eventsFor,
  iterateToAlpha,
  iterationRead,
  iterationRow,
  observedCurrent,
  protoEngine,
  pump,
  scriptTeardown,
  toBrief,
} from './harness/prototype.mjs';

// What Discard must leave as it was: the iteration's receipts, runs, ledger
// rows and records, and its Alpha history.
function history(home, it) {
  return withStore(home, (db) => ({
    runs: db.prepare('SELECT "id", "outcome", "reason_class", "finished_at", "iteration" FROM "runs" WHERE "iteration" = ? ORDER BY "seq"').all(it),
    receipts: db.prepare('SELECT i.* FROM "invocation_receipts" i JOIN "runs" r ON r."id" = i."run" WHERE r."iteration" = ? ORDER BY i.rowid').all(it),
    ledger: db.prepare('SELECT l.* FROM "ledger_rows" l JOIN "invocation_receipts" i ON i."id" = l."invocation" JOIN "runs" r ON r."id" = i."run" WHERE r."iteration" = ? ORDER BY l.rowid').all(it),
    records: db.prepare('SELECT x.* FROM "records" x JOIN "runs" r ON r."id" = x."run" WHERE r."iteration" = ? ORDER BY x.rowid').all(it),
    alpha: db.prepare('SELECT "candidate", "deployment_request", "alpha_at", "approved_at", "brief_record", "plan_bundle", "phase_plan" FROM "prototype_iterations" WHERE "id" = ?').get(it),
  }));
}

const discardPath = (p, it) => `/v1/projects/${p}/iterations/${it}/discard`;

describe('M609 Discard touches only its own iteration', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const fx = await protoEngine(shared.context);
    S.fx = fx;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks discard' });
    S.p = p;
    S.one = it.id;
    S.env = await briefToAlpha(fx, p, it.id);
    await observedCurrent(fx, p, it.id);
    S.oneRead = await iterationRead(fx, p, it.id);
    S.oneHistory = history(fx.home, it.id);
    const { two } = await iterateToAlpha(fx, p, it.id, S.env);
    S.two = two;
    await observedCurrent(fx, p, two);
    S.twoRead = await iterationRead(fx, p, two);
    S.twoHistory = history(fx.home, two);
  });
  after(() => shared.cleanup());

  test('(b) the predecessor discarded while the newer iteration holds the environment: the Alpha left in place with kept_because; status discarded', async () => {
    const { fx, p, one, two } = S;
    assert.ok(S.twoRead.alpha.current, `iteration 2's Alpha is current (${JSON.stringify(S.twoRead.alpha)})`);
    assert.equal((await iterationRead(fx, p, one)).alpha.current, null, "iteration 1's is not: iteration 2's deployment runs there");
    const teardownsBefore = operationsOf(fx.home, p, 'teardown').length;
    const { ask, done } = await confirmed(fx, discardPath(p, one));
    const m = (await decisionRead(fx, p, ask.body.subject.decision)).dependency_manifest;
    assert.equal(m.action, 'discard');
    assert.equal(m.alpha.tears_down_alpha, false, 'the preview says the Alpha is not torn down');
    assert.equal(m.alpha.kept_because, `iteration 2, newer, holds environment alpha: its deployment (request ${S.twoRead.alpha.deployment_request}) is the one running there, and Discard never touches it`);
    assert.equal(done.teardown, null, 'no teardown requested');
    const read = await iterationRead(fx, p, one);
    assert.equal(read.iteration.status, 'discarded');
    assert.ok(read.iteration.ended_at);
    assert.equal(read.outcome.next_step, PROTO.next_steps.discard);
    assert.equal(read.controls.discard.available, false, 'discarded once');
    await tick(fx.engine, p);
    assert.equal(operationsOf(fx.home, p, 'teardown').length, teardownsBefore, 'no teardown operation');
    const two_ = await iterationRead(fx, p, two);
    assert.deepEqual([two_.iteration.status, two_.alpha.deployment_request], ['alpha_ready', S.twoRead.alpha.deployment_request], "iteration 2 untouched");
    assert.ok(two_.alpha.current, "iteration 2's Alpha still current");
    assert.equal(candidatesOfProject(fx.home, p).find((c) => c.id === S.twoRead.alpha.candidate).progress, 'alpha_deployed', "iteration 2's candidate still alpha_deployed");
    assert.equal(eventsFor(fx.home, 'prototype.iteration_discarded', 'iteration', one).length, 1);
  });

  test('(a) the current iteration discarded while its deployment is the environment\'s current one: teardown requested, discarded, ended_at; alpha.current null once the teardown finalizes', async () => {
    const { fx, p, two, env } = S;
    await scriptTeardown(fx, env);
    const { ask, done } = await confirmed(fx, discardPath(p, two));
    const m = (await decisionRead(fx, p, ask.body.subject.decision)).dependency_manifest;
    assert.deepEqual([m.alpha.tears_down_alpha, m.alpha.kept_because, m.alpha.environment?.name], [true, null, 'alpha'], 'the preview says the Alpha is torn down');
    assert.deepEqual(done.teardown, { environment: 'alpha', operation_requested: true }, 'the teardown requested');
    const read = await iterationRead(fx, p, two);
    assert.equal(read.iteration.status, 'discarded');
    assert.ok(read.iteration.ended_at, 'ended_at set');
    const op = await pump(fx, p, () => operationsOf(fx.home, p, 'teardown').find((o) => o.target?.environment === env.id && o.finalized_at !== null), { max: 12, what: 'the teardown to finalize' });
    const after = await iterationRead(fx, p, two);
    assert.equal(after.alpha.current, null, 'alpha.current null after the teardown finalizes');
    const cand = candidatesOfProject(fx.home, p).find((c) => c.id === S.twoRead.alpha.candidate);
    assert.equal(cand.progress, 'developing', 'its candidate is no longer claimed alpha_deployed (S3)');
    const withdrawn = eventsFor(fx.home, 'candidate.alpha_withdrawn', 'candidate', cand.id);
    assert.deepEqual(withdrawn.map((e) => [e.payload.environment, e.payload.operation]), [[env.id, op.id]], 'withdrawn once, by that teardown');
    assert.equal(after.iteration.status, 'discarded');
  });

  test('(c) history: receipts, runs, ledger rows, records and alpha_at unchanged by either Discard', async () => {
    const { fx, p, one, two } = S;
    assert.deepEqual(history(fx.home, one), S.oneHistory, "iteration 1's receipts, runs, ledger rows, records and Alpha history unchanged");
    assert.deepEqual(history(fx.home, two), S.twoHistory, "iteration 2's unchanged by its Discard and the teardown");
    for (const [it, before] of [[one, S.oneRead], [two, S.twoRead]]) {
      const now = await iterationRead(fx, p, it);
      assert.deepEqual(now.usage, before.usage, `${it}: usage unchanged`);
      assert.deepEqual([now.iteration.alpha_at, now.alpha.candidate, now.alpha.deployment_request, now.alpha.deployed_at], [before.iteration.alpha_at, before.alpha.candidate, before.alpha.deployment_request, before.alpha.deployed_at], `${it}: the Alpha history unchanged`);
      assert.deepEqual(now.owner_approvals, before.owner_approvals);
      assert.equal(iterationRow(fx.home, it).alpha_at, before.iteration.alpha_at);
      const receipt = await fx.engine.get(`/v1/projects/${p}/iterations/${it}/receipt.json`);
      assert.equal(receipt.status, 200, 'the receipt is still served');
      assert.equal(receipt.body.outcome.status, 'discarded');
      assert.deepEqual(receipt.body.usage, before.usage);
    }
  });
});
