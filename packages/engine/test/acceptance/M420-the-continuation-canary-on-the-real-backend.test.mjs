// M420 (d), the continuation canary on the real backend (slice 33; REAL
// LANE, manifest `real`; PAID, on Sean's subscription token, run by the
// driver alone under E144 item 2; the Verifier never runs it). M5 plan §3.3
// M420 (d) (early evidence before M443's attempt); D6-S09; D6 §2.6; D2 §7.2,
// §4.1; E139 Q6; SEAM.md §§160 to 164, 393.
//
// What it spends, on Sonnet (`claude-sonnet-5-5`, set explicitly: the canary
// is not the Spec Writer, so Q6's Opus default for that role does not apply),
// on ONE of two paths:
//   - an ACTIVE, eligible Claude entry for the pinned binary exists in the
//     home: its session qualification, the continuation canary alone,
//     EXACTLY TWO real turns (well under 0.25 USD as estimated);
//   - none exists (the slice-33 engine revokes an M4 entry at start,
//     `profile_changed`, since M5's profile is a changed profile, D6 §2.6):
//     ONE full qualification attempt in `session_headless` mode, D2's three
//     canaries (positive, cancellation, containment) plus the continuation
//     canary's two turns, then its `trust_activation`. Estimated under
//     0.50 USD in all.
// Each path is a `realStep`, so a rerun of the run directory never pays
// twice. The receipts, ledger rows and cost of whichever path ran are
// recorded for the report (`observed/M420.json`).
//
// What it needs, refused before anything starts or spends:
//   - the real lane's preflight (SEAM.md §160): the run directory, the
//     credential's file (the subscription token), the pinned binary and this
//     file's own spend confirmation; without the token, nothing starts;
//   - the engine home `<run dir>/home` at most 56 bytes (E134).
// Sean's answers (`qualification_approval`; on the full path also
// `trust_activation`) are the driver's for him; the test waits and never
// answers them (`waitForSean`).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { changePolicy } from './harness/journal.mjs';
import { collectAttempt, realPolicy } from './harness/real/attempt.mjs';
import { REAL, REAL_TEST_TIMEOUT_MS, judged, observe, productionEngine, realPreflight, realStep, tickWhile, waitForSean } from './harness/real/lane.mjs';
import { attemptOf } from './harness/sandbox/qualify.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntries } from './harness/trust.mjs';

const CONFIRM_PHRASE_M5_S33 = 'I accept the M5 slice-33 continuation canary on my Claude subscription, one qualification attempt and two Sonnet turns, under 0.50 USD as estimated';
const MODEL = 'claude-sonnet-5-5';
const HOME_MAX_BYTES = 56;
const CONTINUATION_DEADLINE_S = 600;
const FINAL = ['succeeded', 'failed', 'invalidated'];

const receiptsOfAttempt = (home, attempt) => withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "qualification_attempt" = ? ORDER BY rowid').all(attempt));
const ledgerOfRuns = (home, runs) =>
  runs.flatMap((run) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL ORDER BY rowid').all(run)));
const eligibleEntry = (home, ctx) => trustEntries(home).find((e) => e.backend === 'claude' && e.status === 'active' && e.binary_sha256 === ctx.binarySha256);

// What the report records of an attempt, whichever path ran it.
function spentOn(home, attempt) {
  const receipts = receiptsOfAttempt(home, attempt);
  const runs = [...new Set(receipts.map((r) => r.run))];
  const ledger = ledgerOfRuns(home, runs);
  const runKinds = Object.fromEntries(runs.map((r) => [r, withStore(home, (db) => db.prepare('SELECT "kind" FROM "runs" WHERE "id" = ?').get(r))?.kind ?? null]));
  return {
    receipts: receipts.map((r) => ({ id: r.id, run: r.run, trust_entry: r.trust_entry, qualification_attempt: r.qualification_attempt })),
    runs: runs.map((r) => ({ run: r, kind: runKinds[r] })),
    ledger: ledger.map((l) => ({ run: l.run, invocation: l.invocation, model_requested: l.model_requested, model_observed: l.model_observed, billable_in: l.billable_in, cached_in: l.cached_in, out: l.out, usage_complete: l.usage_complete, cost_status: l.cost_status, cost_usd: l.cost_usd })),
    cost_usd: ledger.reduce((n, l) => n + (Number(l.cost_usd) || 0), 0),
  };
}

describe('M420 (d) the continuation canary on the real backend (real lane, paid, the driver\'s)', () => {
  test('the session qualification on Sonnet: the continuation canary on an active entry, or one full session_headless attempt when there is none', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight({ confirm: CONFIRM_PHRASE_M5_S33 });
    const home = join(ctx.runDir, 'home');
    assert.ok(Buffer.byteLength(home) <= HOME_MAX_BYTES, `the engine home is at most ${HOME_MAX_BYTES} bytes (E134): ${home} is ${Buffer.byteLength(home)}. Nothing was started.`);
    await judged(ctx, 'M420 (d)', async () => {
      // Which path: read once, recorded, never re-decided on a rerun.
      const path = await realStep(ctx, 'm5_path', async () => {
        const fx = await productionEngine(ctx, 'home');
        try {
          const entry = eligibleEntry(fx.home, ctx);
          const all = trustEntries(fx.home).filter((e) => e.backend === 'claude').map((e) => ({ id: e.id, status: e.status, revoked_reason: e.revoked_reason ?? null, binary_sha256: e.binary_sha256, session_qualified: Boolean(e.session_qualified) }));
          observe(ctx, 'M420', 'entries_at_start', all);
          if (entry && entry.session_qualified) return { path: 'already_qualified', entry: entry.id };
          return entry ? { path: 'continuation_only', entry: entry.id } : { path: 'full_attempt', entry: null };
        } finally {
          await fx.engine.stop();
        }
      });
      if (path.path === 'already_qualified') {
        observe(ctx, 'M420', 'outcome', { path: path.path, entry: path.entry, spent: 'nothing: the active entry is already session_qualified' });
        return;
      }

      const out = await realStep(ctx, path.path === 'continuation_only' ? 'm5_continuation' : 'm5_session_attempt', async () => {
        const fx = await productionEngine(ctx, 'home');
        try {
          const info = await fx.engine.engineInfo();
          const fixtureProject = info.qualification_fixture_project;
          // The fixture project's limits, as M2's attempt sets them (a refusal here stops before anything is spent).
          await changePolicy(fx.engine, fixtureProject, realPolicy(REAL.dayVerifiedUsd.qualification));
          const before = withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n);
          const body =
            path.path === 'continuation_only'
              ? { entry: path.entry, mode: 'session_headless', model: MODEL }
              : { backend: REAL.backend, mode: 'session_headless', model: MODEL, candidate_egress: [...ctx.candidateEgress], canary_deadlines: { ...REAL.canaryDeadlines, continuation: CONTINUATION_DEADLINE_S }, auth_mode: ctx.authMode };
          const res = await fx.engine.post('/v1/trust/qualify', body);
          assert.equal(res.status, 201, `the qualification is proposed (→ ${res.status} ${res.text}). Nothing was spent.`);
          const attempt = res.body.qualification_attempt?.id ?? res.body.attempt?.id;
          assert.ok(attempt, `the answer names the attempt (${res.text})`);
          assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "invocation_receipts"').get().n), before, 'nothing launched before the approval');
          const row = attemptOf(fx.home, attempt);
          observe(ctx, 'M420', 'proposed', { path: path.path, row });
          await waitForSean(ctx, fx, 'qualification_approval', attempt, {
            what:
              path.path === 'continuation_only'
                ? 'the session qualification of the active Claude entry: the continuation canary alone, two Sonnet turns, paid (under 0.25 USD as estimated)'
                : 'one full qualification attempt for Claude Code in session_headless mode: the three canaries and the continuation canary\'s two turns, Sonnet, paid (under 0.50 USD as estimated)',
            facts: { entry: path.entry ?? '(none: a new entry is written if the attempt succeeds)', model: MODEL, canaries: row?.canaries ?? null, spend: row?.spend ?? null, fixture_project: row?.fixture_project ?? fixtureProject },
            project: row?.fixture_project ?? fixtureProject,
          });
          const limitMs = (Object.values(REAL.canaryDeadlines).reduce((a, b) => a + b, 0) + 2 * CONTINUATION_DEADLINE_S) * 1000 + 20 * 60_000;
          const done = await tickWhile(fx, row?.fixture_project ?? fixtureProject, () => (FINAL.includes(attemptOf(fx.home, attempt)?.status) ? attemptOf(fx.home, attempt) : undefined), { timeoutMs: limitMs, what: `attempt ${attempt} to finish` });
          const spent = spentOn(fx.home, attempt);
          observe(ctx, 'M420', 'attempt', path.path === 'full_attempt' ? collectAttempt(fx.home, attempt) : { status: done.status, canaries: done.canaries ?? null });
          observe(ctx, 'M420', 'spent', spent);
          let entryId = path.entry ?? done.trust_entry ?? null;
          if (path.path === 'full_attempt' && done.status === 'succeeded' && entryId) {
            const written = trustEntries(fx.home).find((e) => e.id === entryId);
            if (written?.status === 'proposed') {
              await waitForSean(ctx, fx, 'trust_activation', entryId, {
                what: 'the activation of the Claude Code entry this attempt wrote, qualified for sessions. Activating launches nothing.',
                facts: { entry: entryId, model: written.model, session_qualified: Boolean(written.session_qualified), binary_sha256: written.binary_sha256 },
              });
            }
          }
          const after = entryId ? trustEntries(fx.home).find((e) => e.id === entryId) : null;
          const value = {
            path: path.path,
            attempt,
            status: done.status,
            entry: entryId,
            entry_status: after?.status ?? null,
            session_qualified: Boolean(after?.session_qualified),
            one_shot_canaries: (done.canaries ?? []).filter((c) => c.kind !== 'continuation').length,
            ...spent,
          };
          observe(ctx, 'M420', 'outcome', value);
          return value;
        } finally {
          await fx.engine.stop();
        }
      });

      const turns = out.receipts.length;
      const expected = out.path === 'continuation_only' ? 2 : out.one_shot_canaries + 2;
      assert.equal(turns, expected, `the invocations this path should make: ${expected} (${out.path}; got ${turns})`);
      const sessionRuns = out.runs.filter((r) => r.kind === 'session');
      assert.equal(sessionRuns.length, 1, 'one session run, the continuation canary\'s');
      assert.ok(out.ledger.every((l) => l.model_requested === MODEL), `each invocation requested ${MODEL}`);
      if (out.status === 'succeeded') {
        assert.equal(out.session_qualified, true, 'a passing canary sets session_qualified');
        assert.equal(out.entry_status, 'active', 'and the entry is active');
      } else {
        assert.equal(out.session_qualified, false, `not established: the attempt ended ${out.status}, and no entry is session_qualified`);
      }
      assert.equal(out.status, 'succeeded', `the session qualification passed on the real backend (recorded either way; cost ${out.cost_usd} USD)`);
    });
  });
});
