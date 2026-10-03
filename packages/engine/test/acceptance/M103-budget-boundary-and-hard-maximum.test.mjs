// M103, a budget boundary the entry cannot enforce; a hard maximum (M2
// slice 10, kernel lane). M2 plan §3.1 M103; D2 §4.2, K6, A.3, A.7
// (D2-T05, D2-T14); AR B06; E58 item 6; SEAM.md §§116, 118, 120.
//
// Reporting granularity and enforceable boundaries are separate fields of
// an entry. A policy that requires a finer boundary than the entry can
// enforce is refused before launch with `budget_boundary_unenforceable`,
// and the run read says what the entry can enforce and that overshoot
// within an invocation is bounded by the deadline alone. An entry may claim
// `model_turn` only with admission-control evidence. A hard spending
// maximum is refused at the policy, `hard_cap_unenforceable`: a
// provider-side cap is recorded on the grant as configured and never as the
// engine's enforcement. An entry that reports no usage cannot be activated.
// With the boundary the entry enforces, dispatch proceeds and the engine
// read shows each enforceable boundary with its mechanism, evidence and
// overshoot.
//
// Every case here is expected to fail on the engine these tests were
// written against, which has no trust table (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOn } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { changePolicy, getPolicy } from './harness/journal.mjs';
import { invocationOf, ledgerRows } from './harness/ledger.mjs';
import { readRun } from './harness/reads.mjs';
import { holdSecret } from './harness/records.mjs';
import { addWork, assertRunEnded, getRow, requestTick, tick, waitForRun, waitForRunState } from './harness/runs.mjs';
import { sha256Hex } from './harness/engine.mjs';
import { withStore } from './harness/store.mjs';
import { BACKENDS, answerEngine, apiKeyRef, entryShown, eventsNamed, installTrustEntry, realBackendProject, refusedTrustEntry, trustEntries, trustEntry } from './harness/trust.mjs';

// The one boundary the fixture's first entry enforces, as the engine read
// and the run read must show it (the evidence record is the fixture's).
const INVOCATION = Object.freeze({ boundary: 'invocation', mechanism: 'dispatch_check', overshoot: 'deadline' });
const shape = (boundary) => ({ boundary: boundary.boundary, mechanism: boundary.mechanism, overshoot: boundary.overshoot });

// An active entry that reports per model call and enforces the invocation boundary only.
async function enforcingInvocation(t) {
  const ctx = await realBackendProject(t);
  const entry = await installTrustEntry(ctx.fx.engine, ctx.standIn, { status: 'active', usage_granularity: 'model_call', enforceable_boundaries: [INVOCATION] });
  const row = trustEntry(ctx.fx.home, entry.id);
  assert.deepEqual([row.status, row.usage_granularity, row.enforceable_boundaries.map(shape)], ['active', 'model_call', [INVOCATION]], 'the fixture is live: an active entry enforcing the invocation boundary');
  return { ...ctx, entry, row };
}

describe('M103 budget boundaries and the hard maximum', () => {
  test('(a) a policy boundary finer than the entry enforces is refused before launch with budget_boundary_unenforceable: no domain placed, the receipt refused, and the run read names the entry\'s boundary and the deadline as the overshoot bound', async (t) => {
    const { fx, standIn, project, entry } = await enforcingInvocation(t);
    await changePolicy(fx.engine, project, { budget_run_boundary: 'model_turn' });
    const item = await addWork(fx.engine, project, 'verification');
    await requestTick(fx.engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    const facts = assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    assert.deepEqual(facts.receipts.map((receipt) => receipt.statuses), [['refused']], 'the receipt has the observation refused and nothing else');
    assert.deepEqual(eventsNamed(fx.home, 'domain.placed').filter((event) => event.subject?.run === run.id), [], 'no domain was placed');
    assert.equal(standIn.launches().length, 0, 'the stand-in binary was not launched');
    assert.deepEqual(ledgerRows(fx.home, project), [], 'no charge');

    const shown = await readRun(fx.engine, project, run.id);
    assert.equal(shown.code, 'budget_boundary_unenforceable', 'the run read carries the code');
    const refusal = shown.refusal;
    assert.ok(refusal && refusal.code === 'budget_boundary_unenforceable' && typeof refusal.reason === 'string' && typeof refusal.what_to_do === 'string', `the run read carries the refusal in its form (${JSON.stringify(shown.refusal)})`);
    assert.deepEqual(
      { required: refusal.subject?.required, entry: refusal.subject?.trust_entry, enforceable: (refusal.subject?.enforceable_boundaries ?? []).map(shape), bounded_by: refusal.subject?.overshoot?.bounded_by, deadline: refusal.subject?.overshoot?.deadline_at },
      { required: 'model_turn', entry: entry.id, enforceable: [INVOCATION], bounded_by: 'deadline', deadline: run.deadline_at },
      'it names what the policy required, what the entry enforces, and the deadline as the only bound on overshoot',
    );
  });

  test('(b) a claim of model_turn without admission-control evidence is not written; with the mechanism and an evidence record it is', async (t) => {
    const { fx, standIn } = await realBackendProject(t);
    await refusedTrustEntry(fx.engine, standIn, { enforceable_boundaries: [INVOCATION, { boundary: 'model_turn', mechanism: 'dispatch_check', overshoot: 'deadline' }] }, { field: 'enforceable_boundaries' });
    await refusedTrustEntry(fx.engine, standIn, { enforceable_boundaries: [INVOCATION, { boundary: 'model_turn', mechanism: 'admission_control', evidence: null, overshoot: 'none' }] }, { field: 'enforceable_boundaries' });
    assert.equal(trustEntries(fx.home).length, 0, 'neither claim was written');

    const admission = { boundary: 'model_turn', mechanism: 'admission_control', overshoot: 'none' };
    const entry = await installTrustEntry(fx.engine, standIn, { enforceable_boundaries: [INVOCATION, admission] });
    const row = trustEntry(fx.home, entry.id);
    assert.deepEqual(row.enforceable_boundaries.map(shape), [INVOCATION, admission], 'with admission control and evidence the claim is written');
    assert.ok(row.enforceable_boundaries.every((boundary) => entry.evidence.includes(boundary.evidence)), `each boundary names one of the entry's evidence records (${JSON.stringify(row.enforceable_boundaries)})`);
  });

  test('(c) a policy that declares a hard spending maximum is refused hard_cap_unenforceable; a provider-side cap appears on the grant as configured and nowhere as engine enforcement', async (t) => {
    const { fx, standIn, project, entry } = await enforcingInvocation(t);
    const before = await getPolicy(fx.engine, project);
    const res = await fx.engine.post(`/v1/projects/${project}/policy`, { budget_hard_maximum: true });
    assertRefused(res, 400, 'hard_cap_unenforceable', 'a policy declaring a hard maximum');
    assert.equal(res.body.subject?.field, 'budget_hard_maximum', 'the refusal names the field');
    const after = await getPolicy(fx.engine, project);
    assert.deepEqual([after.revision, after.effective.budget_hard_maximum], [before.revision, false], 'the policy is unchanged and the maximum stays false');

    // The dedicated key's provider-side cap (Q2): recorded with the secret, shown on the grant as configured.
    await holdSecret(fx.engine, apiKeyRef(BACKENDS.claude), 'sk-test-key-with-a-cap-0002', { provider_cap_usd: 50 });
    const item = await addWork(fx.engine, project, 'verification');
    await tick(fx.engine, project);
    const run = await waitForRunState(fx.home, (await waitForRun(fx.home, item)).id, 'ended', { timeoutMs: 60_000 });
    assert.notEqual(run.outcome, 'refused', `the fixture is live: the dispatch was not refused (it ended ${run.outcome} / ${run.reason_class})`);
    const grant = getRow(fx.home, 'capability_grants', run.grant);
    assert.deepEqual(JSON.parse(grant.provider_cap ?? 'null'), { status: 'configured', usd: 50, reference: apiKeyRef(BACKENDS.claude) }, 'the grant records the provider-side cap as configured evidence');
    const shown = entryShown(await fx.engine.engineInfo(), entry.id);
    assert.deepEqual(shown.enforceable_boundaries.map(shape), [INVOCATION], 'the engine claims no enforcement from it: the entry\'s boundaries are what the entry enforces');
    assert.ok(!JSON.stringify(shown.enforceable_boundaries).includes('provider'), 'and no mechanism names the provider');
  });

  test('(d) an entry whose usage granularity is none cannot be activated: trust_activation is not raised for it, or refuses', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t);
    const entry = await installTrustEntry(fx.engine, standIn, { status: 'proposed', usage_granularity: 'none', cost_reporting: 'none', enforceable_boundaries: [] });
    assert.equal(trustEntry(fx.home, entry.id).usage_granularity, 'none', 'the fixture is live: a proposed entry that reports no usage');
    for (let i = 0; i < 3; i++) await tick(fx.engine, project);
    const open = decisionsOn(fx.home, 'trust_activation', entry.id).filter((row) => row.status === 'open');
    if (open.length === 0) {
      assert.equal(entry.decision, null, 'no trust_activation was raised for it, and the fixture said so');
    } else {
      const approve = open[0].options.find((option) => option.key === 'approve');
      assert.ok(approve.blockers.length > 0, `the approve option carries a blocker (${JSON.stringify(approve)})`);
      assertRefused(await answerEngine(fx.engine, open[0], 'approve'), 409, 'illegal_transition', 'approving the activation of an entry with no usage');
    }
    assert.equal(trustEntry(fx.home, entry.id).status, 'proposed', 'the entry is not active');
    assert.equal(standIn.launches().length, 0);
  });

  test('(e) with the boundary the entry enforces, dispatch proceeds: the stand-in is launched for the entry, and the engine read shows each enforceable boundary with mechanism, evidence record and overshoot', async (t) => {
    const { fx, standIn, project, entry, key } = await enforcingInvocation(t);
    assert.equal((await getPolicy(fx.engine, project)).effective.budget_run_boundary, 'invocation', 'the fixture is live: the policy requires the invocation boundary, the default');
    const item = await addWork(fx.engine, project, 'verification');
    await tick(fx.engine, project);
    const run = await waitForRun(fx.home, item);
    const launch = await standIn.waitForLaunch({ invocation: invocationOf(fx.home, run.id) });
    const domain = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "execution_domains" WHERE "run" = ?').get(run.id));
    assert.equal(launch.domain, domain?.id, 'the launch carries the domain marker, as the scripted boundary needs it');
    assert.ok(launch.env_keys.includes('ANTHROPIC_API_KEY'), `the key the template names is in the environment (keys: ${launch.env_keys.join(', ')})`);
    assert.ok(launch.env_value_hashes.includes(sha256Hex(key)), 'with the held key as its value');
    assert.ok(!launch.env_keys.includes('SURETY_HOME'), 'and the engine\'s environment is not inherited');
    assert.equal(fx.scripted.launches({ work_item: item }).length, 0, 'no scripted role was launched for the real backend\'s work');
    await waitForRunState(fx.home, run.id, 'ended', { timeoutMs: 60_000 });
    const ended = getRow(fx.home, 'runs', run.id);
    assert.notEqual(ended.outcome, 'refused', `the run was dispatched (it ended ${ended.outcome} / ${ended.reason_class})`);
    const receipt = getRow(fx.home, 'invocation_receipts', invocationOf(fx.home, run.id));
    assert.deepEqual([receipt.trust_entry, receipt.qualification_attempt], [entry.id, null], 'the receipt names the entry that authorized the dispatch, and no attempt');

    const shown = entryShown(await fx.engine.engineInfo(), entry.id);
    assert.deepEqual(shown.enforceable_boundaries.map(shape), [INVOCATION], 'the engine read shows the enforceable boundary with its mechanism and overshoot');
    assert.deepEqual(shown.enforceable_boundaries.map((boundary) => boundary.evidence), [entry.evidence[0]], 'and the evidence record each rests on');
    assert.deepEqual([shown.usage_granularity, shown.status], ['model_call', 'active'], 'beside the reporting granularity, which is a separate field');
  });
});
