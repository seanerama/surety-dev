// M338 (b): one case forced `failed`, one `not_exercised`, one whose control
// fails: each leaves the adapter unqualified (slice 29; sandbox lane). M4
// plan §3.7 M338 (b); D4-A06; D4 §2.6 ("a case whose control fails is
// `failed`, an unexercised one `not_exercised`, and either leaves the
// adapter unqualified"); AR N03; SEAM.md §§321 to 323.
//
// Three qualification runs on one sandbox-lane home in harness mode, on the
// real `local_service` adapter, each at a start carrying one
// `--harness-adapter-qualification-case` (SEAM §323 †), none with a current
// row before it:
//   `replace=failed`              the case recorded `failed` whatever it saw;
//   `unreadable=not_exercised`    the case not run;
//   `deploy_read_back=control_failed`  the case run as usual, its control run
//                                 so that it cannot succeed: recorded
//                                 `control` `failed` and so `failed`, whatever
//                                 the case's own assertions saw.
// Each: the answer `qualified` false naming no row; that case as forced and
// every other case `passed` beside a passed control (so that one entry alone
// is what leaves it unqualified); no row `current`; no `adapter.qualified`;
// the CLI's exit 1 is (a)'s file's matter, the route is read here.
//
// And Sean's decision on D4-A06 (2026-10-11; SEAM §332): a later run that
// does not qualify lapses the row current before it: an adapter qualified,
// then a run with `replace=failed`: the earlier row `lapsed` (its
// `lapsed_reason` the Builder's), `adapter.qualification_lapsed` once.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 322). The test acts on no unit and
// signals nothing: each run's units are the engine's, created and removed
// by its adapter under this test's home's prefix. Engines are stopped in
// order. The file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { operatorGuard, realAdapterStarts } from './harness/deploy/host.mjs';
import { ADAPTER_CASES, caseEntry, currentRows, eventsSince, lapsedEvents, maxSeq, qualificationRow, qualifyAdapter } from './harness/deploy/qualify.mjs';

const FORCED = Object.freeze([
  ['replace', 'failed', { result: 'failed' }],
  ['unreadable', 'not_exercised', { result: 'not_exercised', control: 'not_exercised' }],
  ['deploy_read_back', 'control_failed', { result: 'failed', control: 'failed' }],
]);

describe('M338 (b) a case failed, not exercised, or without a working control leaves the adapter unqualified', () => {
  const shared = sharedFixture();
  let guard;
  let fx;
  const runs = {};
  before(async () => {
    guard = operatorGuard();
    fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    for (const [name, forced] of FORCED) {
      await fx.start({ args: ['--harness-adapter-qualification-case', `${name}=${forced}`] });
      const seq = maxSeq(fx.home);
      const currentBefore = currentRows(fx.home);
      const body = await qualifyAdapter(fx.engine);
      runs[name] = { forced, body, currentBefore, currentAfter: currentRows(fx.home), qualified: eventsSince(fx.home, 'adapter.qualified', seq) };
      await fx.engine.stop();
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  for (const [name, forced, expected] of FORCED) {
    test(`(b) ${name}=${forced}: unqualified; that case ${JSON.stringify(expected)}, every other case passed beside a passed control; no current row, no adapter.qualified`, () => {
      const run = runs[name];
      assert.ok(run, `the run with ${name}=${forced} was made`);
      assert.deepEqual(run.currentBefore, [], 'the fixture is live: no row was current before the run');
      assert.equal(run.body.qualified, false, `the adapter is not qualified (D4 §2.6) (${JSON.stringify(run.body).slice(0, 600)})`);
      const entry = caseEntry(run.body, name);
      for (const [k, v] of Object.entries(expected)) assert.equal(entry?.[k], v, `${name}: ${k} ${v} (${JSON.stringify(entry)})`);
      for (const other of ADAPTER_CASES.filter((c) => c !== name)) {
        const e = caseEntry(run.body, other);
        assert.deepEqual([e?.result, e?.control], ['passed', 'passed'], `${other} passed beside a passed control, so ${name} alone leaves the adapter unqualified (${JSON.stringify(e).slice(0, 300)})`);
      }
      assert.deepEqual(run.currentAfter, [], 'no adapter_qualifications row is current');
      assert.deepEqual(run.qualified, [], 'no adapter.qualified');
    });
  }
});

describe('M338 a later run that does not qualify lapses the row current before it (Sean, D4-A06)', () => {
  const shared = sharedFixture();
  let guard;
  const L = {};
  before(async () => {
    guard = operatorGuard();
    const fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    L.fx = fx;
    await fx.start();
    L.earlier = await qualifyAdapter(fx.engine);
    await fx.engine.stop();
    await fx.start({ args: ['--harness-adapter-qualification-case', 'replace=failed'] });
    L.currentBefore = currentRows(fx.home).map((r) => r.id);
    L.seq = maxSeq(fx.home);
    L.failed = await qualifyAdapter(fx.engine);
    L.row = qualificationRow(fx.home, L.earlier.adapter_qualification);
    L.lapsed = lapsedEvents(fx.home, L.earlier.adapter_qualification).filter((e) => e.seq > L.seq);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('an adapter qualified, then a run with replace=failed: the earlier row lapsed, adapter.qualification_lapsed once, no row current', () => {
    assert.equal(L.earlier.qualified, true, 'the fixture is live: the adapter was qualified first');
    assert.deepEqual(L.currentBefore, [L.earlier.adapter_qualification], 'and its row was current when the later run began (the restart lapsed nothing)');
    assert.equal(L.failed.qualified, false, 'the later run does not qualify');
    assert.equal(caseEntry(L.failed, 'replace')?.result, 'failed', 'its replace case forced failed');
    assert.equal(L.row?.status, 'lapsed', `the earlier row is lapsed by the run that did not qualify (${JSON.stringify(L.row)?.slice(0, 300)})`);
    assert.ok(typeof L.row.lapsed_reason === 'string' && L.row.lapsed_reason.length > 0, `with a lapsed_reason (the Builder's: ${L.row.lapsed_reason})`);
    assert.equal(L.lapsed.length, 1, 'adapter.qualification_lapsed once');
    assert.deepEqual(currentRows(L.fx.home), [], 'no row is current');
  });
});
