// M545, a superseded phase verification retired (M6 slice 39; kernel lane).
// M6 plan §3.1 M545; INK-2 (the M5 report §§16, 24; M5-not-claimed); E154
// item 6 (6); E156 Q1; BS6 §11.3; D6 §5.8 (the phase sign-off bound to its
// candidate; one phase_verification per candidate and plan generation);
// M429 (d) (a sign-off on a superseded candidate is refused); SEAM.md §474.
//
// At T2 under `phase`, the phase's `phase_verification` for candidate c1 is
// keyed by c1 and the plan (`<c1>:<plan>`); a fix naming a finding on c1
// integrates and nominates c2, which supersedes c1, and the phase is
// verified and completed on c2. INK-2: c1's item was never retired; parked,
// its blocker stayed open (its `retry` re-checked stale code), and eligible,
// it was dispatched on the superseded candidate.
//   (a) c1's item parked on its blocker (its one run crashed, no repair
//       allowed) when c2's phase verification of the same plan generation
//       completes: c1's item `cancelled`, one `work.cancelled` with
//       `payload.cause` `candidate_superseded` †; its blocker closed
//       (`invalidated` †), the invalidation naming c2 (its candidate id or
//       its phase_verification item id, in the event or `invalidated_reason`);
//       no run dispatched on c1 after the crash;
//   (b) c1's item eligible, not yet dispatched (the project paused through
//       the owner's route while the fix that makes c2 runs), when c2
//       supersedes c1: cancelled likewise, never run; one phase_verification
//       item for c2;
//   (c) the owner's `retry` on c1's blocker afterwards: refused as stale
//       (409 `decision_invalidated` †), nothing dispatched;
//   (d) an engine restart after (a): c1's item not revived, its blocker not
//       reopened, nothing dispatched on it.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program in the
// test's own home; nothing signalled but the test's own engine (the
// harness's verified kill).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { answer, decision } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { ROUTED_KINDS, planOfPhase, workOf } from './harness/journey/drive.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { pauseProject, resumeProject, runsOf, tick } from './harness/runs.mjs';
import { findingFix } from './harness/exec37/envelope.mjs';
import { script, step } from './harness/scripted.mjs';
import { candidatesOf, holding, launchesOfKind, pumpSome } from './harness/exec37/autonomy.mjs';
import { withStore } from './harness/store.mjs';

const NOT_PLAN = ROUTED_KINDS.filter((k) => k !== 'plan_approval');
const SIGN = roleThat([], { signoffs: [{ scope: 'phase' }] });
const FIX = roleThat([step.write('NOTES.md', 'A note the fix adds.\n')]);
const HELD_FIX = { steps: [step.hold('gate', { heartbeat_ms: 250 }), ...FIX.steps] };

const show = (v) => JSON.stringify(v);
const verifications = (fx, p) => workOf(fx.home, p, 'phase_verification');
const itemOf = (fx, p, id) => verifications(fx, p).find((w) => w.id === id);
const openBlockerOf = (fx, item) => withStore(fx.home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'blocker' AND "subject_id" = ? AND "status" = 'open'`).get(item));
const decisionsAbout = (fx, item) => withStore(fx.home, (db) => db.prepare('SELECT "id", "kind", "status", "invalidated_reason" FROM "decisions" WHERE "subject_id" = ? ORDER BY rowid').all(item));
const cancelledEvents = (fx, item) => eventsOfType(fx.home, 'work.cancelled').filter((e) => e.subject?.work_item === item);
const queuedOf = (fx, p) => withStore(fx.home, (db) => db.prepare(`SELECT * FROM "check_executions" WHERE "project" = ? AND "status" = 'queued' ORDER BY "execution_seq"`).all(p));
const isPhaseTrigger = (x) => {
  try {
    return JSON.parse(x.trigger)?.source === 'phase';
  } catch {
    return false;
  }
};
const phaseDone = (fx, p) => planOfPhase(fx.home, p, 1).find((x) => x.completed_at);

// c1's item retired: cancelled, once, with its reason; `ran` runs on it, no more.
function assertRetired(fx, p, item, ran) {
  const row = itemOf(fx, p, item);
  assert.equal(row?.status, 'cancelled', `c1's phase_verification ${item} is cancelled (status ${row?.status}; items ${show(verifications(fx, p).map((w) => [w.id, w.status, w.subject?.candidate]))})`);
  const events = cancelledEvents(fx, item);
  assert.equal(events.length, 1, `one work.cancelled for it (${show(events)})`);
  assert.equal(events[0].payload?.cause, 'candidate_superseded', `with its reason, payload.cause candidate_superseded † (${show(events[0])})`);
  assert.equal(runsOf(fx.home, item).length, ran, `no run dispatched on c1 beyond ${ran} (${show(runsOf(fx.home, item).map((r) => [r.id, r.outcome]))})`);
}

describe('M545 (a), (c), (d) a parked phase verification of a superseded candidate retired', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const { fx, p, ctx } = await journey35(shared.context, { policy: { repair_attempts_max: 0 } });
    // c1's Verifier crashes (no repair allowed: parked on its blocker); every later one signs.
    fx.scripted.kindScript('phase_verification', [script.crash(3), SIGN, SIGN, SIGN]);
    const parked = await pumpSome(fx, ctx, () => verifications(fx, p.id).find((w) => w.status === 'parked'), { what: "c1's phase_verification parked", max: 300, answerKinds: NOT_PLAN });
    const blocker = openBlockerOf(fx, parked.id);
    assert.ok(blocker, `the fixture is live: c1's item parked on an open blocker (${show(decisionsAbout(fx, parked.id))})`);
    const c1 = parked.subject.candidate;
    // A fix naming a finding on c1 integrates and nominates c2 (E104; objection 092).
    const { item: fix } = await findingFix(fx, p.id, c1, FIX);
    const done = await pumpSome(fx, ctx, () => phaseDone(fx, p.id), { what: 'phase 1 completed on c2', max: 300, answerKinds: NOT_PLAN });
    const c2 = done.completion_binding?.candidate;
    const c1Row = candidatesOf(fx.home, p.id).find((c) => c.id === c1);
    const c2Row = candidatesOf(fx.home, p.id).find((c) => c.id === c2);
    assert.ok(c2Row && c2Row.seq > c1Row.seq, `the fixture is live: the phase completed on a later candidate c2 (${show(done.completion_binding)})`);
    const c2Items = verifications(fx, p.id).filter((w) => w.subject?.candidate === c2);
    assert.ok(c2Items.some((w) => w.status === 'complete'), `the fixture is live: c2's phase verification completed (${show(c2Items)})`);
    assert.ok(runsOf(fx.home, fix).length >= 1, 'the fixture is live: the fix ran');
    Object.assign(S, { fx, p, ctx, parked, blocker, c1, c2, c2Items });
  });
  after(async () => {
    await shared.cleanup();
  });

  test("(a) c2's phase verification completed: c1's parked item cancelled (candidate_superseded), its blocker invalidated naming c2, no run on c1", () => {
    const { fx, p, parked, blocker, c2, c2Items } = S;
    assertRetired(fx, p.id, parked.id, 1);
    const now = decision(fx.home, blocker.id);
    assert.equal(now?.status, 'invalidated', `c1's blocker closed: invalidated † (${show(decisionsAbout(fx, parked.id))})`);
    const inv = eventsOfType(fx.home, 'decision.invalidated').filter((e) => e.subject?.decision === blocker.id);
    assert.equal(inv.length, 1, `one decision.invalidated for it (${show(inv)})`);
    const named = `${show(inv[0])} ${now.invalidated_reason ?? ''}`;
    assert.ok([c2, ...c2Items.map((w) => w.id)].some((id) => named.includes(id)), `the invalidation names c2 (${c2}) or its phase verification (${show(c2Items.map((w) => w.id))}): ${named}`);
  });

  test("(c) the owner's retry on c1's blocker afterwards: refused as stale (409 decision_invalidated), nothing dispatched", async () => {
    const { fx, p, parked, blocker } = S;
    const res = await answer(fx.engine, p.id, blocker, 'retry');
    assert.equal(res.status, 409, `the retry is refused (→ ${res.status} ${res.text})`);
    assert.match(res.text, /decision_invalidated/, `as stale: decision_invalidated † (${res.text})`);
    await tick(fx.engine, p.id, { rounds: 3 });
    assertRetired(fx, p.id, parked.id, 1);
  });

  test("(d) an engine restart after (a): c1's item not revived, its blocker not reopened, nothing dispatched", async () => {
    const { fx, p, parked } = S;
    await fx.engine.kill();
    await fx.start();
    await tick(fx.engine, p.id, { rounds: 3 });
    assertRetired(fx, p.id, parked.id, 1);
    assert.equal(openBlockerOf(fx, parked.id), undefined, `no open blocker about c1's item (${show(decisionsAbout(fx, parked.id))})`);
  });
});

describe('M545 (b) an eligible phase verification of a superseded candidate retired before dispatch', () => {
  test("(b) c1's item eligible, not dispatched, when c2 supersedes c1: cancelled (candidate_superseded), never run; one phase_verification item for c2", async (t) => {
    const { fx, p, ctx } = await journey35(t);
    fx.scripted.kindScript('phase_verification', [SIGN, SIGN, SIGN]);
    const notPhase = (x) => !isPhaseTrigger(x);
    // Every stage verified; the phase's checks on c1 registered and withheld.
    const first = await pumpSome(fx, ctx, () => queuedOf(fx, p.id).find(isPhaseTrigger), { what: "the phase's checks registered on c1", max: 300, answerKinds: NOT_PLAN, record: notPhase });
    const c1 = first.candidate;
    // The fix that makes c2, held in flight; then the project paused (the
    // owner's route) so that nothing more is dispatched.
    await findingFix(fx, p.id, c1, HELD_FIX);
    const held = await pumpSome(fx, ctx, () => launchesOfKind(fx, 'fix').find((l) => holding(fx, l)), { what: 'the fix holding', max: 40, answerKinds: NOT_PLAN, record: notPhase });
    await pauseProject(fx.engine, p.id);
    const c1Item = await pumpSome(fx, ctx, () => verifications(fx, p.id).find((w) => w.subject?.candidate === c1), { what: "c1's phase_verification registered (the project paused)", max: 40, answerKinds: NOT_PLAN });
    assert.equal(itemOf(fx, p.id, c1Item.id)?.status, 'eligible', `the fixture is live: c1's item eligible (${show(c1Item)})`);
    assert.equal(runsOf(fx.home, c1Item.id).length, 0, 'the fixture is live: not dispatched');
    fx.scripted.release(held.work_item, 'gate');
    const c1Row = candidatesOf(fx.home, p.id).find((c) => c.id === c1);
    const c2Row = await pumpSome(fx, ctx, () => candidatesOf(fx.home, p.id).find((c) => c.seq > c1Row.seq), { what: 'the fix integrated and c2 nominated (the project paused)', max: 60, answerKinds: NOT_PLAN });
    await resumeProject(fx.engine, p.id);
    const done = await pumpSome(fx, ctx, () => phaseDone(fx, p.id), { what: 'phase 1 completed', max: 300, answerKinds: NOT_PLAN });
    assert.equal(done.completion_binding?.candidate, c2Row.id, `the fixture is live: the phase completed on c2 (${show(done.completion_binding)})`);
    assertRetired(fx, p.id, c1Item.id, 0);
    const forC2 = verifications(fx, p.id).filter((w) => w.subject?.candidate === c2Row.id);
    assert.equal(forC2.length, 1, `one phase_verification item for c2 (${show(forC2.map((w) => [w.id, w.status, w.trigger_id, w.trigger_generation]))})`);
  });
});
