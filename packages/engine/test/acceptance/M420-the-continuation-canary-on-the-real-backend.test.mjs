// M420 (d), the continuation canary on the real backend (slice 33; REAL
// LANE, manifest `real`; PAID, on Sean's subscription token, run by the
// driver alone under E144 item 2; the Verifier never runs it). M5 plan §3.3
// M420 (d) (early evidence before M443's attempt); D6-S09; D6 §2.6; D2 §7.2,
// §4.1; E139 Q6; SEAM.md §§160 to 164, 393.
//
// What it spends: EXACTLY TWO real model turns, one session of the
// continuation canary, on Sonnet (`claude-sonnet-5-5`, set explicitly: the
// canary is not the Spec Writer, so Q6's Opus default for that role does not
// apply). Estimated well under 0.25 USD; the ledger rows' usage and cost are
// recorded for the report (`observed/M420.json`).
//
// What it needs, refused before anything starts or spends:
//   - the real lane's preflight (SEAM.md §160): the run directory, the
//     credential's file (the subscription token), the pinned binary and
//     this file's own spend confirmation; without the token, nothing starts;
//   - the engine home `<run dir>/home` at most 56 bytes (E134);
//   - an ACTIVE Claude entry for the pinned binary in that home (written by
//     an earlier qualification attempt, M136 to M139, and activated by
//     Sean): without one, the file refuses, nothing spent.
// Then the session qualification (`POST /v1/trust/qualify` with `entry` and
// `mode: session_headless`, SEAM.md §393 †) runs the continuation canary
// alone; its `qualification_approval` is answered by the driver for Sean
// (the test never answers it; `waitForSean`). Read: one session run of two
// turns, two invocation receipts naming the entry and the attempt, the
// second turn's reply carrying the first turn's token, and the entry
// `session_qualified` true; or, if the model did not answer from the
// transcript, "not established" with the entry not session_qualified.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REAL_TEST_TIMEOUT_MS, judged, observe, productionEngine, realPreflight, realStep, waitForSean } from './harness/real/lane.mjs';
import { attemptOf, waitAttempt } from './harness/sandbox/qualify.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntries } from './harness/trust.mjs';

const CONFIRM_PHRASE_M5_S33 = 'I accept the M5 slice-33 continuation canary on my Claude subscription, two Sonnet turns, under 0.25 USD as estimated';
const MODEL = 'claude-sonnet-5-5';
const HOME_MAX_BYTES = 56;

const ledgerOfRun = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY rowid').all(run));
const receiptsOfAttempt = (home, attempt) => withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "qualification_attempt" = ? ORDER BY rowid').all(attempt));

describe('M420 (d) the continuation canary on the real backend (real lane, paid, the driver\'s)', () => {
  test('two real Sonnet turns qualify the active entry for sessions, or the outcome is recorded not established', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight({ confirm: CONFIRM_PHRASE_M5_S33 });
    const home = join(ctx.runDir, 'home');
    assert.ok(Buffer.byteLength(home) <= HOME_MAX_BYTES, `the engine home is at most ${HOME_MAX_BYTES} bytes (E134): ${home} is ${Buffer.byteLength(home)}. Nothing was started.`);
    await judged(ctx, 'M420 (d)', async () => {
      const out = await realStep(ctx, 'm5_continuation', async () => {
        const fx = await productionEngine(ctx, 'home');
        try {
          const entry = trustEntries(fx.home).find((e) => e.backend === 'claude' && e.status === 'active' && e.binary_sha256 === ctx.binarySha256);
          if (!entry) throw new Error(`no active Claude entry for the pinned binary (${ctx.binarySha256.slice(0, 16)}…) in ${fx.home}: qualify and activate one first (M136 to M139). Nothing was spent.`);
          const before = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n);
          const res = await fx.engine.post('/v1/trust/qualify', { entry: entry.id, mode: 'session_headless', model: MODEL });
          assert.equal(res.status, 201, `the session qualification is proposed (→ ${res.status} ${res.text}). Nothing was spent.`);
          const attempt = res.body.qualification_attempt?.id ?? res.body.attempt?.id;
          assert.ok(attempt, `the answer names the attempt (${res.text})`);
          assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n), before, 'nothing launched before the approval');
          const row = attemptOf(fx.home, attempt);
          await waitForSean(ctx, fx, 'qualification_approval', attempt, {
            what: 'the session qualification of the active Claude entry: the continuation canary alone, two Sonnet turns, paid (under 0.25 USD as estimated)',
            facts: { entry: entry.id, model: MODEL, canaries: row?.canaries ?? 'continuation', project: row?.fixture_project },
            project: row?.fixture_project ?? null,
          });
          const done = await waitAttempt(fx.home, attempt, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 1_800_000 });
          const receipts = receiptsOfAttempt(fx.home, attempt);
          const runs = [...new Set(receipts.map((r) => r.run))];
          const ledger = runs.flatMap((r) => ledgerOfRun(fx.home, r));
          const after = trustEntries(fx.home).find((e) => e.id === entry.id);
          const value = {
            attempt,
            status: done.status,
            entry: entry.id,
            session_qualified: Boolean(after?.session_qualified),
            runs,
            turns: receipts.length,
            canaries: done.canaries ?? null,
            ledger: ledger.map((l) => ({ run: l.run, invocation: l.invocation, model_requested: l.model_requested, model_observed: l.model_observed, billable_in: l.billable_in, cached_in: l.cached_in, out: l.out, usage_complete: l.usage_complete, cost_status: l.cost_status, cost_usd: l.cost_usd })),
            cost_usd: ledger.reduce((n, l) => n + (Number(l.cost_usd) || 0), 0),
          };
          observe(ctx, 'M420', 'continuation_canary', value);
          return value;
        } finally {
          await fx.engine.stop();
        }
      });
      assert.equal(out.turns, 2, `exactly two real turns (${out.turns})`);
      assert.equal(out.runs.length, 1, 'one session run');
      assert.ok(out.ledger.every((l) => l.model_requested === MODEL), `each turn requested ${MODEL}`);
      if (out.status === 'succeeded') assert.equal(out.session_qualified, true, 'a passing canary sets session_qualified');
      else assert.equal(out.session_qualified, false, `not established: the canary did not pass (${out.status}), and the entry is not session_qualified`);
      assert.equal(out.status, 'succeeded', `the continuation canary passed on the real backend (recorded either way; cost ${out.cost_usd} USD)`);
    });
  });
});
