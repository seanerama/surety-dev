// M139, an unauthenticated canary (M2 slice 14, REAL LANE, manifest `real`).
// M2 plan §3.8 M139; D2 §7.2 (diagnostics), A.2 CanaryFailureClass; AR N04,
// T11; CH incident 3; SEAM.md §§159 to 165.
//
// PAID LANE, BUT THIS FILE SPENDS NO TOKENS: its attempt's credential is
// invalid on purpose (in M2 an invalid subscription token; E74 item 1), so
// the provider refuses the first request. It still runs only by
// Sean's command (`--lane real`) and only after his `qualification_approval`
// of that attempt, which the test waits for and never gives. It is first in
// the manifest's `real` list: the real binary, the sandbox, the proxy's
// tunnel to the provider and the attempt's failure path are exercised once
// at no cost before anything paid starts. An outcome other than the one
// expected halts the run directory, and every paid file after it stops
// before starting anything.
//
// What can be asserted before the first paid run, and what cannot. D2 fixes
// the class (`auth_failed`), the kept provider error, the failed attempt and
// no entry; this file asserts those. What Claude Code prints when its key is
// refused, and whether its terminal event reports a cost of zero, are not
// known before the run: the provider error is recorded as it is, and only
// "structured" (it parses as JSON) and "the key absent" are asserted of it.
// That the ledger shows the cost as unknown and never as zero is the plan's
// requirement and is asserted; if Claude Code reports `total_cost_usd: 0`
// and the engine records that as measured zero, this case fails, and that
// is a finding for Sean (unknown is not zero), not a defect of the case.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collectAttempt, homeOf, wrongKeyAttempt } from './harness/real/attempt.mjs';
import { REAL, REAL_TEST_TIMEOUT_MS, judged, observe, productionEngine, realPreflight, realStep, secretHits, stepValue, wrongKeyFile } from './harness/real/lane.mjs';
import { attemptOf } from './harness/sandbox/qualify.mjs';
import { withStore } from './harness/store.mjs';
import { eventsNamed, trustEntries } from './harness/trust.mjs';
import { decision } from './harness/decisions.mjs';

describe('M139 an unauthenticated canary (real lane; no tokens spent)', () => {
  test("(a) a reference whose value is an invalid credential (an invalid subscription token in M2; a wrong key in the api_key mode): auth_failed, the redacted structured provider error kept with the key absent, the attempt failed / qualification_failed, no entry; the ledger row's cost unknown, not zero", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M139 (a)', async () => {
    const out = await wrongKeyAttempt(ctx);
    const home = homeOf(ctx, 'home-auth');
    const wrong = wrongKeyFile(ctx);
    const c = collectAttempt(home, out.attempt);

    assert.equal(c.attempt.status, 'failed', `the attempt failed (${c.attempt.status})`);
    assert.deepEqual(c.attempt.canaries.map((x) => x.kind), ['positive'], `the first canary failed, so no later canary was dispatched (SEAM.md §148): ${JSON.stringify(c.attempt.canaries)}`);
    const [positive] = c.runs;
    assert.deepEqual([positive.canary.passed, positive.canary.failure_class], [false, 'auth_failed'], `the canary failed auth_failed (D2 §7.2): ${JSON.stringify(positive.canary)}`);

    // The provider error, kept as a published record, structured, redacted.
    assert.ok(positive.canary.provider_error, 'a failed canary keeps its provider error (D2 §7.2; SEAM.md §148)');
    const errorRecord = withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(positive.canary.provider_error));
    assert.equal(errorRecord?.published, 1, 'the provider error is a published record');
    assert.ok(typeof positive.provider_error === 'string' && positive.provider_error.length > 0, 'it holds something');
    let structured = null;
    try {
      structured = JSON.parse(positive.provider_error);
    } catch {
      // asserted below
    }
    assert.ok(structured !== null && typeof structured === 'object', `the provider error is kept structured, as JSON (D2 §7.2; CH incident 3): ${positive.provider_error.slice(0, 300)}`);
    observe(ctx, 'M139', 'provider_error', structured);
    assert.ok(!positive.provider_error.includes(wrong.value), 'the invalid credential is not in the provider error');

    // The finish, and no entry.
    const finished = eventsNamed(home, 'qualification.finished').filter((e) => e.subject?.qualification_attempt === out.attempt);
    assert.deepEqual(finished.map((e) => [e.payload?.outcome, e.payload?.code, e.payload?.failure_class]), [['failed', 'qualification_failed', 'auth_failed']], 'qualification.finished: failed, qualification_failed, auth_failed');
    assert.equal(trustEntries(home).filter((e) => e.qualification_attempt === out.attempt).length, 0, 'no entry is written');

    // The ledger: one original row, its cost unknown and never zero.
    assert.equal(positive.ledger.length, 1, `the canary's invocation is charged once (${JSON.stringify(positive.ledger)})`);
    const [row] = positive.ledger;
    observe(ctx, 'M139', 'ledger_row', row);
    assert.equal(row.cost_usd, null, `the cost is unknown (null), not zero: ${JSON.stringify(row)}`);
    assert.equal(row.cost_status, 'unknown', `cost_status is unknown: ${JSON.stringify(row)}`);

    // The invalid credential, and the real one, are absent from everything this home holds.
    assert.deepEqual(secretHits(wrong.value, { roots: [home] }), [], 'the invalid credential is in no file under its engine home');
    assert.deepEqual(secretHits(ctx.keyValue, { roots: [home] }), [], 'the real credential is in no file under this engine home either');
    });
  });

  test('(b) afterwards: the attempt is consumed; a new one needs a new approval', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M139 (b)', async () => {
    const first = stepValue(ctx, 'wrong_key_attempt');
    const home = homeOf(ctx, 'home-auth');
    const seen = await realStep(ctx, 'wrong_key_replay', async () => {
      const before = JSON.stringify(attemptOf(home, first.attempt));
      const oldDecision = attemptOf(home, first.attempt).decision;
      const fx = await productionEngine(ctx, 'home-auth', { keyFile: wrongKeyFile(ctx).file });
      try {
        // The old approval cannot be used again.
        const old = decision(home, oldDecision);
        assert.equal(old.status, 'consumed', 'the failed attempt\'s approval is consumed');
        const again = await fx.engine.post(`/v1/decisions/${oldDecision}/answer`, { option: 'approve', preview_hash: old.preview_hash });
        assert.equal(again.status, 409, `answering it again is refused (body: ${again.text})`);
        assert.equal(again.body?.code, 'decision_consumed');
        // A replay is a new attempt with its own approval, and waits for it.
        const res = await fx.engine.post('/v1/trust/qualify', { backend: REAL.backend, mode: REAL.mode, model: REAL.model, candidate_egress: [...REAL.candidateEgress], canary_deadlines: { ...REAL.canaryDeadlines }, auth_mode: ctx.authMode });
        assert.equal(res.status, 201, `a new attempt is proposed (body: ${res.text})`);
        const replay = attemptOf(home, res.body.qualification_attempt.id);
        assert.notEqual(replay.id, first.attempt, 'a new attempt');
        assert.notEqual(replay.decision, oldDecision, 'with a new approval');
        for (let i = 0; i < 3; i++) await fx.engine.post(`/v1/projects/${replay.fixture_project}/tick`, {});
        await new Promise((r) => setTimeout(r, 5_000));
        assert.equal(attemptOf(home, replay.id).status, 'proposed', 'it is not authorized by the old approval');
        assert.equal(withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts" WHERE "qualification_attempt" = ?').get(replay.id).n), 0, 'nothing runs under it');
        assert.equal(JSON.stringify(attemptOf(home, first.attempt)), before, 'the old attempt is untouched');
        // Left proposed, its question open: only Sean could approve it, and
        // its credential is invalid. The engine is stopped below.
        return { replay: replay.id, decision: replay.decision };
      } finally {
        await fx.engine.stop();
      }
    });
    observe(ctx, 'M139', 'replay', seen);
    });
  });
});
