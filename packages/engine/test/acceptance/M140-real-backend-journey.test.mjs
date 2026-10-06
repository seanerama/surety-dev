// M140, the real-backend journey (M2 slice 14, REAL LANE, manifest `real`).
// M2 plan §3.8 M140 and question 4; plan row M01; spec R12.1 to R12.4; E46,
// E48, E59 (items 3 and the model); D2 §4.1; SEAM.md §§159 to 166.
//
// PAID. It needs the entry the attempt wrote to be active: if it is not, the
// test waits for Sean's `trust_activation` through the API (step
// `activation`) and never gives it. Then row M01's two paths run with Claude
// Code (claude-sonnet-5-5) as Builder, Verifier and Reviewer
// (`harness/real/journey.mjs`), each path in a project of its own whose day
// limit, with the qualification fixture project's, keeps the day within
// Sean's 25 USD (SEAM.md §161). Order: path one, the Stop (e) on path one's
// project, path two. Each is a step of the run directory, run once; a path
// that a real agent did not complete is recorded "not established" and
// halts the run directory (E59 item 3: Sean runs it once more with
// SURETY_REAL_RERUN=path_two, and the mixed run, SURETY_REAL_PATH_TWO=mixed,
// is the recorded fallback).
//
// What stays a fixture, labelled (SEAM.md §164): the approved plan with its
// texts, the protected check's declaration and its execution (D3's runner
// is not built: the check's result is recorded passed by the test, as row
// M01 records it, and is evidence of nothing about the code), and the Alpha
// test target. The journey's engine is the engine's test mode for the real
// lane (`--harness-real-lane`), restarted on the home the production engine
// qualified; the entry it dispatches to was written and activated in
// production mode.
//
// What can be asserted before the first paid run, and what cannot. The
// agents' behaviour cannot be known: whether the Builder writes what R1
// asks, whether the Verifier finds the seeded defect and names the check,
// whether the Reviewer chooses `fix` and signs off. Each is checked when it
// happens and a miss is "not established", never a pass. The fields of
// Claude Code's stream are recorded; (d) compares the ledger with the
// stream's terminal event only where the event carries the figure.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { activation, homeOf } from './harness/real/attempt.mjs';
import { REAL, REAL_TEST_TIMEOUT_MS, judged, observe, readObserved, realPreflight, secretHits, stepValue, streamEvents, terminalEvent, terminalOutput, costStatusFor, dayTotalFor, egressBasis, egressProvesNothingSent } from './harness/real/lane.mjs';
import { pathOne, pathTwo, stopCase } from './harness/real/journey.mjs';
import { authorizationsOf } from './harness/gates.mjs';
import { trailersOf, identityOf } from './harness/repos.mjs';
import { withStore } from './harness/store.mjs';

const TRAILERS = Object.freeze(['Surety-Run', 'Surety-Role', 'Surety-Base', 'Surety-WorkItem', 'Surety-Kind']);

// Path two as Sean chose it: real by default, the mixed fallback by his word.
const pathTwoStep = (ctx) => (ctx.pathTwo === 'mixed' ? 'path_two_mixed' : 'path_two');

// The paths that have run, from the run directory's state.
function donePaths(ctx) {
  const out = [];
  for (const name of ['path_one', 'path_two', 'path_two_mixed']) {
    try {
      out.push({ name, ...stepValue(ctx, name) });
    } catch {
      // not run, or failed: not judged here
    }
  }
  return out;
}

describe('M140 the real-backend journey (real lane, paid)', () => {
  test('(a) path one of M01: both gates satisfied on recorded evidence; the API and event history agree with the durable rows', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M140 (a)', async () => {
      const act = await activation(ctx);
      const one = await pathOne(ctx);
      const home = homeOf(ctx, 'home');
      assert.deepEqual([one.stage_gate, one.alpha_gate], ['satisfied', 'satisfied'], 'both gates satisfied on the candidate');
      const auth = authorizationsOf(home, one.candidate).find((a) => a.id === one.authorization);
      assert.equal(auth?.status, 'issued', `the Alpha authorization is issued (${JSON.stringify(auth)})`);
      for (const r of one.runs) {
        assert.deepEqual([r.outcome, r.reason_class], ['completed', 'none'], `the ${r.role}'s run completed (${r.reason_text})`);
        const receipt = withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(r.id));
        assert.deepEqual([receipt.trust_entry, receipt.qualification_attempt], [act.entry, null], `the ${r.role}'s run was dispatched to the active entry, not under an attempt (K10)`);
      }
      assert.deepEqual(one.runs.map((r) => r.role).sort(), ['builder', 'reviewer', 'verifier'], 'a real Builder, Verifier and Reviewer');
      assert.deepEqual(one.api_mismatches, [], `the API agrees with the durable rows (${JSON.stringify(one.api_mismatches)})`);
    });
  });

  test('(e) R12.4: a Stop during a real run: the run read is not ended until the test reads populated 0; the credential (the subscription token) is absent from every record and from git', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M140 (e)', async () => {
      await activation(ctx);
      await pathOne(ctx);
      const s = await stopCase(ctx);
      assert.equal(s.at_barrier.populated, 0, `at boundary.before_terminated the test itself read populated 0 (${JSON.stringify(s.at_barrier)})`);
      assert.notEqual(s.at_barrier.run_read, 'ended', `and the run read did not yet say ended (${s.at_barrier.run_read})`);
      const seq = (type) => s.events.find((e) => e.type === type)?.seq ?? null;
      assert.ok(seq('domain.launch_closed') !== null && seq('domain.launch_closed') < seq('domain.terminated') && seq('domain.terminated') < seq('run.ended'), `closure, termination, then the run's end (${JSON.stringify(s.events)})`);
      assert.deepEqual(s.outcome, ['stopped', 'human_stop'], 'the run ended stopped by the human');
      assert.equal(s.exit_class, 'engine_signaled', 'exit class engine_signaled');
      assert.equal(s.ledger.length, 1, 'one original ledger row');
      // E85: a run stopped before it reached its provider is a known zero by
      // the egress evidence, which the test reads itself; otherwise its usage
      // is incomplete and the allowance charged (D2 C4).
      const proof = egressProvesNothingSent(homeOf(ctx, 'home'), s.run);
      observe(ctx, 'M140', 'stop_case_egress', proof);
      // A zero by egress is the row's own claim (its basis names the egress
      // evidence); the test then checks that claim against the record it reads
      // itself. Without that basis the old rule holds: E85's condition (d), a
      // backend that reported usage, keeps the usage unknown even when nothing
      // left the domain (found by the real-lane rehearsal).
      if (egressBasis(s.ledger[0])) {
        assert.ok(proof.proven, `a zero by the egress evidence needs the run's egress record to show nothing sent (E85): ${JSON.stringify(proof)}`);
        const r = s.ledger[0];
        assert.ok(egressBasis(r) && r.billable_in === 0 && r.out === 0 && r.cost_usd === 0 && Boolean(r.usage_complete), `nothing reached the provider (its egress record shows it): a known zero with the egress basis (E85): ${JSON.stringify(r)}`);
      } else {
        assert.ok(!egressBasis(s.ledger[0]), `a run whose egress does not prove nothing was sent is no zero by egress (E85): ${JSON.stringify(s.ledger[0])}`);
        assert.equal(s.ledger[0].usage_complete, 0, 'its usage incomplete, the allowance charged (D2 C4)');
      }

      // The key: in no file of the run directory (the engine homes, their
      // records, stores and logs, the repositories' files, the observations)
      // and in no git object of any repository the lane used.
      const repos = [...donePaths(ctx).map((p) => p.repo), readObserved(ctx, 'attempt').host_witness?.before?.repo].filter(Boolean);
      const hits = secretHits(ctx.keyValue, { roots: [ctx.runDir], repos });
      observe(ctx, 'M140', 'key_search', { roots: [ctx.runDir], repos, hits: hits.length });
      assert.deepEqual(hits, [], `the ${ctx.authMode} credential is in no file and no git object`);
    });
  });

  test('(b) path two, the fix loop: a defect seeded for the real Verifier to find (the mixed run, labelled, as the recorded fallback); both gates satisfied on the fix\'s candidate; the API agrees with the durable rows', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M140 (b)', async () => {
      const act = await activation(ctx);
      const two = await pathTwo(ctx, { mixed: ctx.pathTwo === 'mixed' });
      observe(ctx, 'M140', 'path_two_kind', two.mixed ? 'mixed: real Builders, scripted Verifier and Reviewer (E59 item 3 fallback)' : 'real: every role Claude Code');
      assert.deepEqual([two.stage_gate, two.alpha_gate], ['satisfied', 'satisfied'], "both gates satisfied on the fix's candidate");
      assert.equal(two.finding?.status, 'resolved', 'the finding is resolved by the check passing on the fix\'s candidate (SEAM.md §74)');
      assert.equal(two.fix_status, 'complete', 'the fix\'s work is complete');
      assert.notEqual(two.blocked_on_first.outcome, 'satisfied', 'the stage gate on the first candidate was blocked by the finding');
      const home = homeOf(ctx, 'home');
      for (const r of two.runs) {
        assert.deepEqual([r.outcome, r.reason_class], ['completed', 'none'], `the ${r.role}'s run completed (${r.reason_text})`);
        const receipt = withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(r.id));
        const real = !two.mixed || r.role === 'builder';
        if (real) assert.equal(receipt.trust_entry, act.entry, `the ${r.role}'s run was the real backend's`);
      }
      assert.deepEqual(two.api_mismatches, [], `the API agrees with the durable rows (${JSON.stringify(two.api_mismatches)})`);
    });
  });

  test("(c) R12.2: every commit on the integration branch is the engine's, with run and role trailers, and none is the agent's", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M140 (c)', async () => {
      const paths = donePaths(ctx);
      assert.ok(paths.some((p) => p.name === 'path_one'), 'path one has run (its commits are judged here)');
      const home = homeOf(ctx, 'home');
      const seen = [];
      for (const p of paths) {
        // The engine's setup commits before the journey (the bootstrap and
        // the policy revision): the engine's own recorded revisions, naming
        // the project; no run made them, so they carry no run or role
        // trailer. (Found by the E79 rehearsal: judged from the fixture's
        // first commit, this case failed on them. Whether R12.2's "every
        // commit" means these too is put to Sean; until then they are
        // judged as the engine's and not the agent's, and recorded.)
        assert.ok(p.journey_base, `${p.name}: the journey's starting point on the integration branch was recorded`);
        const setup = execFileSync('git', ['-C', p.repo, 'rev-list', `${p.base}..${p.journey_base}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
        for (const sha of setup) {
          const trailers = trailersOf(p.repo, sha);
          assert.deepEqual(trailers['Surety-Project'], [p.project], `${p.name} ${sha}: a setup commit names the project once (${JSON.stringify(trailers)})`);
          assert.equal(trailers['Surety-Run'], undefined, `${p.name} ${sha}: a setup commit names no run`);
          const revision = withStore(home, (db) => db.prepare('SELECT * FROM "revisions" WHERE "sha" = ? AND "project" = ?').get(sha, p.project));
          assert.ok(revision, `${p.name} ${sha}: the engine recorded this setup commit as its own revision`);
          seen.push({ path: p.name, sha, identity: identityOf(p.repo, sha), run: null, role: null, revision_kind: revision.kind, setup: true });
        }
        const commits = execFileSync('git', ['-C', p.repo, 'rev-list', `${p.journey_base}..refs/heads/main`], { encoding: 'utf8' }).split('\n').filter(Boolean);
        assert.ok(commits.length > 0, `${p.name}: the integration branch gained commits`);
        for (const sha of commits) {
          const trailers = trailersOf(p.repo, sha);
          for (const name of TRAILERS) assert.equal(trailers[name]?.length, 1, `${p.name} ${sha}: ${name} exactly once (${JSON.stringify(trailers)})`);
          const run = withStore(home, (db) => db.prepare('SELECT * FROM "runs" WHERE "id" = ?').get(trailers['Surety-Run'][0]));
          assert.ok(run && run.project === p.project, `${p.name} ${sha}: Surety-Run names a run of the project`);
          assert.equal(trailers['Surety-Role'][0], run.role, `${p.name} ${sha}: Surety-Role is that run's role`);
          const revision = withStore(home, (db) => db.prepare('SELECT * FROM "revisions" WHERE "sha" = ? AND "project" = ?').get(sha, p.project));
          assert.ok(revision, `${p.name} ${sha}: the engine recorded this commit as its own revision`);
          seen.push({ path: p.name, sha, identity: identityOf(p.repo, sha), run: run.id, role: run.role, revision_kind: revision.kind });
        }
      }
      observe(ctx, 'M140', 'commits', seen);
      const identities = new Set(seen.map((s) => s.identity));
      assert.equal(identities.size, 1, `one identity for every commit, the engine's (${[...identities].join(' ; ')})`);
    });
  });

  test("(d) R12.3: each invocation's ledger row equals the usage the provider reported in its transcript record, or is unknown with the reason; the day's total is the sum (reported_usd with an API key, estimated_usd with a subscription token)", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M140 (d)', async () => {
      const home = homeOf(ctx, 'home');
      const paths = donePaths(ctx);
      assert.ok(paths.length > 0, 'a path has run');
      const compared = [];
      for (const p of paths) {
        for (const r of p.runs) {
          const receipt = withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "run" = ?').get(r.id));
          if (receipt.trust_entry === null) continue; // a scripted role of the mixed run: no provider
          const [row] = r.ledger;
          assert.ok(row, `${r.id}: an original ledger row`);
          const t = terminalEvent(streamEvents(home, r.id));
          compared.push({ run: r.id, role: r.role, row, terminal: t ? { total_cost_usd: t.total_cost_usd ?? null, usage: t.usage ?? null, modelUsage: t.modelUsage ?? null } : null });
          if (typeof t?.total_cost_usd === 'number') {
            assert.equal(row.cost_status, costStatusFor(ctx), `${r.id}: the stream's total_cost_usd is the ledger's, ${costStatusFor(ctx)} in the ${ctx.authMode} mode (E74 item 1)`);
            assert.ok(Math.abs(row.cost_usd - t.total_cost_usd) < 1e-6, `${r.id}: ${row.cost_usd} against the transcript's ${t.total_cost_usd}`);
            // Every model call's output tokens (`modelUsage` where present; objection 015).
            const reported = terminalOutput(t);
            if (reported.tokens !== null) assert.equal(row.out, reported.tokens, `${r.id}: output tokens as reported (${reported.scope})`);
            assert.equal(row.usage_complete, 1, `${r.id}: complete`);
          } else {
            assert.notEqual(row.cost_status, 'reported', `${r.id}: no cost in the transcript, none claimed as reported`);
            assert.ok(row.cost_usd === null || row.cost_status === 'estimated', `${r.id}: unknown (null) or estimated with its price version, never zero: ${JSON.stringify(row)}`);
          }
        }
        // The day's total of that status (reported_usd with an API key,
        // estimated_usd with a subscription token), as the project's ledger
        // read gave it while its engine ran, is the sum of its rows'.
        const read = p.name === 'path_one' && (() => { try { return stepValue(ctx, 'stop_case').ledger_read; } catch { return null; } })() || p.ledger_read;
        const rows = withStore(home, (db) => db.prepare(`SELECT * FROM "ledger_rows" WHERE "project" = ?`).all(p.project));
        const sum = rows.filter((x) => x.cost_status === costStatusFor(ctx)).reduce((a, x) => a + x.cost_usd, 0);
        const shown = read?.totals?.[dayTotalFor(ctx)];
        assert.ok(typeof shown === 'number' && Math.abs(shown - sum) < 1e-6, `${p.name}: the day's ${dayTotalFor(ctx)} (${shown}) is the sum of the rows' ${costStatusFor(ctx)} cost (${sum})`);
      }
      observe(ctx, 'M140', 'ledger_against_transcripts', compared);
      // The day's spend against Sean's bound (E59): recorded for the report.
      observe(ctx, 'M140', 'spend', { bound_usd_per_day: 25, limits: REAL.dayVerifiedUsd });
    });
  });
});
