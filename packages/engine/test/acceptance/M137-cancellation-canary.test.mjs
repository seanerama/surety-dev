// M137, the cancellation canary (M2 slice 14, REAL LANE, manifest `real`).
// M2 plan §3.8 M137; D2 §1.5, §1.6, §3.6, §7.2; AR B04, B07, T09; SEAM.md
// §§126, 145, 149, 159 to 165.
//
// PAID. The cancellation canary is the second canary of the one attempt
// (`harness/real/attempt.mjs`, step `attempt`); this file judges it from its
// records and starts nothing if M136 already ran the attempt.
//
// Case (b), the negatives (a backend that finishes early, one that never
// reaches the barrier), is established without a model, in the sandbox
// lane: `M137-cancellation-canary-negatives.test.mjs` (manifest slice 14).
// Here only (a) and (c), which need the real backend.
//
// What can be asserted before the first paid run, and what cannot. How
// Claude Code ends on TERM (at once, after a while, or only to the kill)
// and how much usage it has reported by the barrier are the canary's to
// establish (D2 §3.6, §4.5): recorded, not assumed. Asserted: D2 §1.6's
// order (closure before termination, termination established before the run
// ends), the exit class, `term_to_exit_ms` recorded, the barrier witnessed
// by the init, and the partial usage kept with the allowance charged once
// (D2 §1.5, C4; SEAM.md §120).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { canaryOfKind, collectAttempt, homeOf, qualificationAttempt } from './harness/real/attempt.mjs';
import { REAL, REAL_TEST_TIMEOUT_MS, judged, observe, realPreflight, stepValue } from './harness/real/lane.mjs';
import { withStore } from './harness/store.mjs';

describe('M137 the cancellation canary (real lane, paid)', () => {
  test('(a) the barrier file in /surety/out witnessed by the init, then the long wait; the engine cancels: closure, TERM, grace, cgroup.kill, populated 0; term_to_exit_ms; exit class engine_signaled; partial usage retained with usage_complete 0, null only where nothing was observed, the allowance charged once', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M137 (a)', async () => {
      const out = await qualificationAttempt(ctx);
      const home = homeOf(ctx, 'home');
      const c = collectAttempt(home, out.attempt);
      const k = canaryOfKind(c, 'cancellation');
      assert.ok(k, `the cancellation canary ran (${JSON.stringify(c.attempt.canaries)})`);
      assert.equal(k.canary.passed, true, `it passed (${JSON.stringify(k.canary)})`);

      // The barrier, witnessed by the domain init on its channel, never read
      // from the stream (D2 §7.2; SEAM.md §§149, 165).
      assert.equal(k.evidence?.barrier?.witnessed, true, `the init witnessed the barrier file (SEAM.md §165): ${JSON.stringify(k.evidence)}`);

      // The engine's cancellation, in D2 §1.6's order.
      assert.equal(k.exit_class, 'engine_signaled', `exit class engine_signaled (${k.exit_class})`);
      assert.equal(k.exit_evidence?.signal_by_engine, true, 'the signal was the engine\'s');
      const seq = (type) => k.events.find((e) => e.type === type)?.seq ?? null;
      for (const type of ['domain.launch_closed', 'domain.terminated', 'run.ended']) assert.ok(seq(type) !== null, `${type} recorded (events: ${k.events.map((e) => e.type).join(', ')})`);
      assert.ok(seq('domain.launch_closed') < seq('domain.terminated'), 'closure before termination');
      assert.ok(seq('domain.terminated') < seq('run.ended'), 'termination established before the run ended');
      assert.equal(k.domain?.observation, 'terminated', 'the domain observed terminated (populated 0 read)');
      assert.equal(existsSync(k.domain.cgroup_path), false, `its cgroup directory is gone (${k.domain.cgroup_path})`);
      assert.ok(Number.isInteger(k.canary.term_to_exit_ms) && k.canary.term_to_exit_ms >= 0, `term_to_exit_ms recorded (${k.canary.term_to_exit_ms})`);
      observe(ctx, 'M137', 'term_behaviour', { term_to_exit_ms: k.canary.term_to_exit_ms, signal: k.exit_evidence?.signal ?? null, exit_evidence: k.exit_evidence, outcome: [k.run.outcome, k.run.reason_class] });

      // Partial usage: known tokens kept, the remainder an allowance charged once.
      assert.equal(k.ledger.length, 1, `one original ledger row: charged once (${JSON.stringify(k.ledger)})`);
      const [row] = k.ledger;
      observe(ctx, 'M137', 'ledger_row', row);
      assert.equal(row.usage_complete, 0, 'usage_complete 0: the terminal usage never came');
      const observations = withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "usage_observations" WHERE "invocation" = ?').get(k.receipt.id).n);
      observe(ctx, 'M137', 'usage_observations', observations);
      if (observations > 0) assert.ok(row.out !== null || row.billable_in !== null, 'usage was observed: it is kept, not nulled');
      else assert.deepEqual([row.billable_in, row.out], [null, null], 'nothing observed: null, never zero');
      const observed = (row.billable_in ?? 0) + (row.out ?? 0);
      assert.equal(row.unknown_allowance_tokens, Math.max(0, REAL.runBillableTokens - observed), `the allowance is the run limit less the observed billable tokens (D2 C4; SEAM.md §120): ${JSON.stringify(row)}`);
    });
  });

  test('(c) an unauthenticated backend at the barrier: not passed, auth_failed (M139)', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M137 (c)', async () => {
      // M139's attempt, whose key is wrong: its first canary fails
      // auth_failed and no cancellation canary is dispatched after it, so an
      // unauthenticated backend never passes the barrier (D2 §7.2: "a
      // backend that ... fails to authenticate ... has not passed").
      const wrong = stepValue(ctx, 'wrong_key_attempt');
      const c = collectAttempt(homeOf(ctx, 'home-auth'), wrong.attempt);
      assert.equal(c.attempt.status, 'failed');
      assert.equal(canaryOfKind(c, 'positive')?.canary.failure_class, 'auth_failed', 'the unauthenticated backend failed auth_failed');
      assert.equal(canaryOfKind(c, 'cancellation'), undefined, 'and no cancellation canary passed, or ran, under that attempt');
    });
  });
});
