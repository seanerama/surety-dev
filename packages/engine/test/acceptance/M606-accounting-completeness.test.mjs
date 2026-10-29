// M606, accounting completeness (the owner's draft M7 plan §3, row M606;
// request §7; rulings R9, S2 of 2026-10-28; D2 C4; SEAM.md §575). Kernel
// lane, the scripted provider's usage lines.
//
//   (a) complete usage with cached tokens: total = billable + cached + out,
//       total_is complete, the normalization rule served.
//   (b) a pending invocation: completeness.pending 1, total_is lower_bound,
//       the reservation shown; never 0.
//   (c) an invocation cut by cancellation: the unknown allowance charged
//       once and shown.
//   (d) a mid-run engine restart (SIGKILL while a run is under way, a new
//       engine on the same home): the run ends recovered, keeps its
//       iteration, its allowance charged once, the totals consistent, and
//       the iteration offers a usable next step (each one followed works).
//   (e) a run that reports no usage at all (S2): remaining unknown, the
//       reason naming the invocation; next_step offers only Iterate or
//       Discard; …/prepare refused 409; raising a limit does not reopen it;
//       the uncertainty preserved in app_totals.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { waitFor } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { tick } from './harness/runs.mjs';
import {
  CHECK_KINDS,
  PROTO,
  SERVER,
  alphaReady,
  answerOpen,
  assertAccounted,
  builderScript,
  confirmed,
  eventsFor,
  holdingBuilder,
  idle,
  iterationRead,
  iterationRow,
  kindNext,
  ledgerOfInvocation,
  limitsCommitted,
  ok,
  ownerPolicy,
  protoEngine,
  pump,
  result,
  runsOfIteration,
  statusIs,
  toBrief,
  workOfProject,
  write,
} from './harness/prototype.mjs';

const originalRows = (home, inv) => ledgerOfInvocation(home, inv).filter((r) => r.corrects === null);

describe('M606 accounting completeness', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) complete usage with cached tokens: total = billable + cached + out, total_is complete, the normalization rule served', async () => {
    const { fx } = S;
    const { id, it } = await toBrief(fx, { name: 'Tasks metered' });
    S.p = id;
    S.it = it.id;
    const read = await iterationRead(fx, id, it.id);
    const [prep] = read.usage.runs;
    const inv = prep.invocations[0];
    assert.deepEqual([inv.usage.state, inv.usage.billable_in, inv.usage.cached_in, inv.usage.out], ['complete', 1200, 300, 400], 'the cache reads reported apart from the billable input');
    assert.equal(inv.usage.normalization_version, 'scripted-1');
    const t = read.usage.totals.tokens;
    assert.deepEqual([t.billable_in, t.cached_in, t.out, t.total, t.total_is], [1200, 300, 400, 1900, 'complete'], 'total = billable + cached + out, complete');
    assert.equal(t.total, t.billable_in + t.cached_in + t.out);
    assert.deepEqual(t.normalization, { scripted: 'scripted-1: input, cache reads and output as reported, each counted once' }, 'the normalization rule is served');
    assert.deepEqual(read.usage.totals.completeness, { complete: 1, pending: 0, incomplete: 0, not_launched: 0 });
    const [row] = originalRows(fx.home, inv.id);
    assert.deepEqual([row.billable_in, row.cached_in, row.out], [1200, 300, 400], 'the ledger row holds the same');
    assertAccounted(read, 'complete usage');
  });

  test('(b) a pending invocation: completeness.pending 1, total_is lower_bound, the reservation shown; never 0', async () => {
    const { fx, p, it } = { ...S };
    kindNext(fx, 'stage_build', [holdingBuilder('pend', { use: { usage: { semantics: 'cumulative', raw: { input_tokens: 1000, cache_read_tokens: 200, output_tokens: 300 } } } }), { steps: [write('server.mjs', SERVER), result()] }], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p);
    const pending = await pump(fx, p, async () => {
      const r = await iterationRead(fx, p, it);
      const run = r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null);
      return run && run.invocations[0]?.usage.billable_in === 1000 ? { r, run } : undefined;
    }, { answer: CHECK_KINDS, wait: false, what: 'stage 1 under way' });
    const inv = pending.run.invocations[0];
    S.pendingRun = pending.run;
    assert.equal(inv.usage.state, 'pending');
    assert.deepEqual([inv.usage.billable_in, inv.usage.cached_in, inv.usage.out], [1000, 200, 300], 'what it observed so far');
    assert.equal(inv.cost.status, 'unknown', 'its cost is not known while it runs');
    assert.ok(inv.reserved_tokens > 0, `it reserves the rest of its effective allowance (${inv.reserved_tokens})`);
    assert.equal(inv.reserved_tokens, inv.effective_limit_tokens - 1300, 'its effective allowance less the billable it observed (1,000 in + 300 out; cache reads are not billable)');
    assert.equal(pending.r.usage.totals.completeness.pending, 1, 'completeness.pending 1');
    assert.equal(pending.r.usage.totals.tokens.total_is, 'lower_bound', 'a lower bound');
    assert.equal(pending.r.remaining.committed.under_way_reserved_tokens, inv.reserved_tokens, 'the reservation counted in what the iteration committed');
    assert.equal(pending.r.remaining.committed.under_way_observed_tokens, 1300, 'what it observed, billable: input and output');
    assert.equal(pending.r.usage.totals.cost.pending_invocations, 1);
    assert.equal(originalRows(fx.home, inv.id).length, 0, 'no ledger row yet: not charged as 0');
    assertAccounted(pending.r, 'while pending');
  });

  test('(c) an invocation cut by cancellation: the unknown allowance charged once and shown', async () => {
    const { fx, p, it } = S;
    const run = S.pendingRun;
    await confirmed(fx, `/v1/projects/${p}/runs/${run.id}/stop`);
    await idle(fx, p);
    const read = await iterationRead(fx, p, it);
    const r = read.usage.runs.find((x) => x.id === run.id);
    assert.ok(r.finished_at, 'the stopped run ended');
    const inv = r.invocations[0];
    assert.equal(inv.usage.state, 'incomplete');
    assert.deepEqual([inv.usage.billable_in, inv.usage.cached_in, inv.usage.out], [1000, 200, 300], 'what it observed is kept');
    assert.equal(inv.unknown_allowance_tokens, inv.effective_limit_tokens - 1300, 'charged its effective allowance less the billable it observed (1,300), never 0');
    assert.ok(inv.unknown_allowance_tokens > 0);
    const rows = originalRows(fx.home, inv.id);
    assert.equal(rows.length, 1, 'one ledger row: charged once');
    assert.equal(rows[0].unknown_allowance_tokens, inv.unknown_allowance_tokens, 'the ledger row holds the allowance the read shows');
    assert.equal(read.usage.totals.unknown_allowance_tokens, inv.unknown_allowance_tokens, 'shown in the totals, apart');
    assert.equal(read.remaining.committed.unknown_allowance_tokens, inv.unknown_allowance_tokens, 'and in what the iteration committed');
    await tick(fx.engine, p);
    assert.equal(originalRows(fx.home, inv.id).length, 1, 'still once after a tick');
    assertAccounted(read, 'after the cancellation');
    S.cut = { run: run.id, inv: inv.id, allowance: inv.unknown_allowance_tokens };
  });

  test('(e) a run that reports no usage: remaining unknown naming the invocation; only Iterate or Discard; …/prepare 409; a raise does not reopen; app_totals keep the uncertainty', async () => {
    const { fx, p, it } = S;
    // The cut run's allowance spent what the iteration had left: its next
    // dispatch meets the limit; the owner raises it (it reopens), and stage
    // 1 is built by a run that reports no usage at all.
    const held = workOfProject(fx.home, p).find((w) => w.kind === 'stage_build' && w.status === 'held');
    assert.ok(held, 'the stopped run\'s work is held');
    await ok(fx.engine.post(`/v1/projects/${p}/work/${held.id}/resume`, {}), 200, 'the owner resumes the held work');
    await pump(fx, p, statusIs(fx, p, it, 'limit_reached'), { max: 4, what: 'the spent allowance to stop dispatch' });
    const raised = await ownerPolicy(fx, p, { prototype_budget_tokens: 3_000_000 }, 'the raised allowance');
    assert.deepEqual([raised.prototype?.reopens, raised.prototype?.status], [true, 'limit_reached'], `the submission says it reopens (${JSON.stringify(raised.prototype)})`);
    await waitFor(async () => ((await iterationRead(fx, p, it)).iteration.status === 'building' ? true : undefined), { what: 'the iteration open again' });
    const unknown = await pump(fx, p, async () => {
      const r = await iterationRead(fx, p, it);
      return r.iteration.status === 'limit_reached' ? r : undefined;
    }, { answer: CHECK_KINDS, what: 'the missing usage to stop dispatch' });
    const missingRun = unknown.usage.runs.filter((x) => x.work_kind === 'stage_build').at(-1);
    const missing = missingRun.invocations[0];
    assert.deepEqual([missing.usage.state, missing.usage.billable_in, missing.unknown_allowance_tokens], ['incomplete', null, null], 'no usage reported: unknown, no figure, no allowance');
    assert.equal(unknown.remaining.tokens, null, 'the remaining allowance is unknown, never the limit less 0');
    assert.ok(unknown.remaining.tokens_reason.includes(`invocation ${missing.id} of run ${missingRun.id} (builder, stage_build)`), `the reason names the invocation and its run (${unknown.remaining.tokens_reason})`);
    assert.equal(unknown.remaining.committed.total_tokens, null, 'what was committed is unknown');
    assert.ok(unknown.outcome.reason.includes(`invocation ${missing.id} of run ${missingRun.id}`), unknown.outcome.reason);
    assert.match(unknown.outcome.reason, /Raising a limit cannot resolve an unknown total; no run is dispatched against an unknown total$/);
    assert.equal(unknown.outcome.next_step, PROTO.next_steps.unknown, 'the next step offers only Iterate or Discard');
    assert.equal(unknown.controls.resume.available, false, 'no resume is offered');
    assert.equal(unknown.controls.discard.available, true, 'Discard is');
    assertAccounted(unknown, 'after the missing usage');
    // …/prepare does not bypass it.
    const prep = await fx.engine.post(`/v1/projects/${p}/iterations/${it}/prepare`, {});
    assert.equal(prep.status, 409, `…/prepare is refused (→ ${prep.status} ${prep.text})`);
    assert.match(prep.body.reason, /cannot be prepared again while its accounting is unresolved: 1 charged invocation\(s\) have unknown billable tokens/);
    assert.deepEqual(prep.body.subject.unknown_invocations, [missing.id]);
    // Raising a limit does not reopen it, and the submission and the event say why.
    const again = await ownerPolicy(fx, p, { prototype_budget_tokens: 4_000_000 }, 'a second raise');
    assert.equal(again.prototype?.reopens, false);
    assert.match(again.prototype?.reason ?? '', /^iteration 1's accounting is unresolved: .*Raising a limit cannot resolve an unknown total\. Next: iterate/);
    await limitsCommitted(fx, p, it, 'prototype_budget_tokens', 4_000_000);
    const changed = eventsFor(fx.home, 'prototype.iteration_limits_changed', 'iteration', it).at(-1);
    assert.deepEqual([changed.payload.reopened, changed.payload.status], [false, 'limit_reached']);
    assert.match(changed.payload.not_reopened_because, /accounting is unresolved/);
    await tick(fx.engine, p);
    const still = await iterationRead(fx, p, it);
    assert.deepEqual([still.iteration.status, still.outcome.reason, still.remaining.tokens], ['limit_reached', unknown.outcome.reason, null], 'not reopened; the uncertainty kept');
    assert.equal(still.usage.runs.length, unknown.usage.runs.length, 'nothing dispatched');
    // The app's totals keep it; Iterate works, its own totals exclude it.
    assert.ok(still.app_totals.completeness.incomplete >= 2 && still.app_totals.tokens.total_is === 'lower_bound', JSON.stringify(still.app_totals));
    const made = await ok(fx.engine.post(`/v1/projects/${p}/iterations/${it}/iterate`, {}), 201, 'Iterate from the unresolved iteration');
    const fresh = await iterationRead(fx, p, made.iteration.id);
    assert.deepEqual([fresh.usage.totals.invocations, fresh.remaining.tokens, fresh.remaining.tokens_reason], [0, 4_000_000, null], "the new iteration's own totals exclude the unknown");
    assert.ok(fresh.app_totals.completeness.incomplete >= 2 && fresh.app_totals.tokens.total_is === 'lower_bound', `the app's totals keep it (${JSON.stringify(fresh.app_totals.completeness)})`);
    assert.equal(fresh.app_totals.unknown_allowance_tokens, S.cut.allowance, 'and the cut run\'s allowance, once');
  });

  test('(d) a mid-run engine restart: the run ends recovered, keeps its iteration, its allowance charged once, the totals consistent, and a usable next step', async () => {
    const { fx } = S;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks killed' });
    kindNext(fx, 'stage_build', [holdingBuilder('kill'), builderScript(1), builderScript(2)], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    await alphaReady(fx, p, { port: 18091 });
    const under = await pump(fx, p, async () => {
      const r = await iterationRead(fx, p, it.id);
      const run = r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null);
      return run && run.invocations[0]?.usage.billable_in === 1000 ? { r, run } : undefined;
    }, { answer: CHECK_KINDS, wait: false, what: 'a stage build under way' });
    const runId = under.run.id;
    // The engine killed while the run executes; a new one on the same home.
    await fx.engine.kill();
    await fx.start();
    const ended = await waitFor(async () => {
      await tick(fx.engine, p);
      const x = await iterationRead(fx, p, it.id);
      const run = x.usage.runs.find((y) => y.id === runId);
      return run?.finished_at ? { x, run } : undefined;
    }, { timeoutMs: 120_000, what: 'the interrupted run to end' });
    assert.equal(ended.run.outcome, 'recovered', `the interrupted run ends recovered (${JSON.stringify([ended.run.outcome, ended.run.reason_class])})`);
    assert.equal(iterationRow(fx.home, it.id).id, it.id);
    assert.equal(runsOfIteration(fx.home, it.id).find((r) => r.id === runId)?.iteration, it.id, 'it keeps its iteration in the store');
    const inv = ended.run.invocations[0];
    assert.deepEqual([inv.usage.state, inv.usage.billable_in, inv.usage.out], ['incomplete', 1000, 200], 'what it observed is kept');
    assert.equal(inv.unknown_allowance_tokens, inv.effective_limit_tokens - 1200, 'charged its effective allowance less the billable it observed (1,200), never 0');
    assert.equal(inv.effective_limit_tokens, under.run.invocations[0].effective_limit_tokens, 'the allowance fixed at dispatch, the same after the restart');
    assert.equal(originalRows(fx.home, inv.id).length, 1, 'one ledger row: charged once');
    await tick(fx.engine, p);
    assert.equal(originalRows(fx.home, inv.id).length, 1, 'still once after another tick');
    assertAccounted(ended.x, 'after the restart');
    assert.ok(ended.x.remaining.committed.total_tokens <= ended.x.iteration.limits.prototype_budget_tokens, 'never committed past the allowance');
    // A usable next step, each one followed: the spent allowance (raise it),
    // then the recovered run's held work named (resume it), then Alpha.
    const limited = await pump(fx, p, statusIs(fx, p, it.id, 'limit_reached'), { max: 6, what: 'the next dispatch to meet the spent allowance' }).then(() => iterationRead(fx, p, it.id));
    assert.equal(limited.outcome.next_step, PROTO.next_steps.limit);
    const raised = await ownerPolicy(fx, p, { prototype_budget_tokens: 3_000_000 }, 'the raised allowance');
    assert.equal(raised.prototype?.reopens, true);
    const named = await pump(fx, p, async () => {
      const x = await iterationRead(fx, p, it.id);
      return x.iteration.status === 'awaiting_owner' && (x.outcome.next_step ?? '').startsWith('resume the held work') ? x : undefined;
    }, { answer: CHECK_KINDS, what: 'the held work to be named' });
    assert.ok(named.outcome.next_step.includes(`work/${ended.run.work_item}/resume`) && named.outcome.next_step.includes(`its run ${runId} ended recovered`), named.outcome.next_step);
    await ok(fx.engine.post(`/v1/projects/${p}/work/${ended.run.work_item}/resume`, {}), 200, 'the owner resumes the held work');
    await pump(fx, p, statusIs(fx, p, it.id, 'alpha_ready'), { answer: CHECK_KINDS, max: 100, what: 'alpha_ready after the recovery' });
    const done = await iterationRead(fx, p, it.id);
    assert.ok(done.usage.runs.some((y) => y.id === runId && y.outcome === 'recovered'), 'the recovered run kept, attributed');
    assert.equal(originalRows(fx.home, inv.id).length, 1, 'its allowance still charged once');
    assertAccounted(done, 'at Alpha');
  });
});
