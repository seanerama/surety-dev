// M338 (f) and (a), the slice-29 review's S1: an unread host fact is never
// equal to anything, an unread one included (slice 29; sandbox lane). M4
// plan §3.7 M338; D4-A07; D4 §2.6; E129 item 8 as Sean decided it ("a
// change in any of those lapses it, naming the member"); CLAUDE.md "unknown
// is a value"; SEAM.md §§322, 324, 328.
//
// The defect: with /etc/machine-id unreadable the host qualification records
// `host_id` as unknown (an unread tool version as null), and the facts are
// compared as JSON, so unknown equals unknown and a row qualified on such a
// host stays current across a change the engine cannot see. On one
// sandbox-lane home in harness mode, on the real adapter, through §328's
// `--harness-host-fact-unread host_id` (the host qualification of that start
// records the member unread, as an unreadable /etc/machine-id would):
//   (ii) a row qualified under known facts: a restart where `host_id` becomes
//        unread lapses it, `lapsed_reason` `host_qualification`,
//        `adapter.qualification_lapsed` naming the member `host_id`;
//   (i)  on that start, `qualify-adapter` writes no `current` row and its
//        evidence names the unread member.
// The control of (ii) is M338-lapse-on-a-changed-host's plain restart.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 322). The test acts on no unit and
// signals nothing; the qualifications' units are the engine's, created and
// removed by its adapter under this test's home's prefix. Engines are
// stopped in order; every start carries the real-adapter switch. The file
// ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { withStore } from './harness/store.mjs';
import { operatorGuard, realAdapterStarts } from './harness/deploy/host.mjs';
import { currentRows, eventsSince, evidenceOf, lapsedEvents, maxSeq, qualificationRow, qualifyAdapter } from './harness/deploy/qualify.mjs';

const UNREAD = ['--harness-host-fact-unread', 'host_id'];
const activeHost = (home) => withStore(home, (db) => db.prepare(`SELECT "id", "host_id" FROM "host_qualifications" WHERE "status" = 'active'`).get()) ?? null;

describe('M338 an unread host fact is never equal (the slice-29 review, S1)', () => {
  const shared = sharedFixture();
  let guard;
  let fx;
  const R = {};
  before(async () => {
    guard = operatorGuard();
    fx = realAdapterStarts(await sandboxEngine(shared.context, { start: false }));
    guard.track(fx);
    await fx.start();
    R.known = await qualifyAdapter(fx.engine);
    R.hostBefore = activeHost(fx.home);
    await fx.engine.stop();
    await fx.start({ args: UNREAD });
    R.hostAfter = activeHost(fx.home);
    R.row = qualificationRow(fx.home, R.known.adapter_qualification);
    R.lapsed = lapsedEvents(fx.home, R.known.adapter_qualification);
    R.seq = maxSeq(fx.home);
    R.unread = await qualifyAdapter(fx.engine);
    R.currentAfter = currentRows(fx.home);
    R.qualifiedAfter = eventsSince(fx.home, 'adapter.qualified', R.seq);
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(ii) a row qualified under known facts lapses at a restart where host_id becomes unread, naming the member host_id', () => {
    assert.equal(R.known.qualified, true, `the fixture is live: the adapter was qualified under known facts (${JSON.stringify(R.known).slice(0, 300)})`);
    assert.ok(R.hostBefore && R.hostAfter && R.hostAfter.id !== R.hostBefore.id, 'a host qualification is active at each start');
    assert.notEqual(R.hostAfter.host_id, R.hostBefore.host_id, `the fixture is live: the second start's host_id is not the one read before (${JSON.stringify(R.hostAfter.host_id)})`);
    assert.equal(R.row?.status, 'lapsed', `the row is lapsed: an unread fact never equals a read one (${JSON.stringify(R.row)?.slice(0, 300)})`);
    assert.equal(R.row.lapsed_reason, 'host_qualification');
    assert.equal(R.lapsed.length, 1, 'adapter.qualification_lapsed once');
    assert.equal(R.lapsed[0].payload?.member, 'host_id', `naming the member host_id (${JSON.stringify(R.lapsed[0].payload)})`);
  });

  test('(i) with host_id unread, qualify-adapter writes no current row, and its evidence names the unread member', () => {
    assert.equal(R.unread.qualified, false, `not qualified while a host fact is unread (${JSON.stringify(R.unread).slice(0, 400)})`);
    assert.equal(R.unread.adapter_qualification, null, 'naming no row');
    assert.deepEqual(R.currentAfter, [], 'no adapter_qualifications row is current');
    assert.deepEqual(R.qualifiedAfter, [], 'no adapter.qualified');
    assert.match(R.unread.evidence ?? '', /^rec_/, 'the run names its evidence record');
    const { content } = evidenceOf(fx.home, R.unread.evidence);
    assert.deepEqual(content.unread_host_facts, ['host_id'], `the evidence names the unread member (SEAM.md §328) (${JSON.stringify(content.unread_host_facts)})`);
  });
});
