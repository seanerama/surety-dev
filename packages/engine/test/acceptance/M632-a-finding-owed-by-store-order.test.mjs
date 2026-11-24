// M632, a finding owed to the owner, decided by store order (M7 plan §3h,
// row M632; DECISIONS item 51 finding 3, third priority; D1 §3.5; M50;
// SEAM.md §425). Sean, 2026-11-24: "3 · Finding disposition. Prove both
// orderings. An earlier completed review must not prematurely send a newer
// finding to me while another relevant review is pending. Once the
// qualifying review finishes, the owner question should appear exactly
// once."
//
// Kernel lane, the scripted backend: a T1 candidate C (gates.mjs
// `nominated`), and two review work items on it: R1, the engine's own review
// of C (trigger `verification`, C: the one a `reviewed_after` reads,
// findings.ts askUndispositioned), and R2, another review of C (a fixture's
// trigger), held at a scripted hold so it stays pending. F is a Verifier's
// finding on C (a `verification` run's report). The controlled clock is
// stepped back (`POST /v1/harness/clock/advance {"seconds": -N}`, SEAM.md
// §425) between the two facts compared, so their wall stamps invert the
// store order.
//   (a) R1 completed, the clock stepped back, F recorded: by wall time R1's
//       `finished_at` is not before F's `created_at` although R1 ended
//       first; ticks: no `finding_disposition` for F while R2 is pending;
//   (b) R2 then completes without dispositioning F; ticks: exactly one,
//       raised once across further ticks;
//   (c) the opposite order: F recorded, the clock stepped back, then R1
//       completes without dispositioning F (by wall time before F); ticks:
//       exactly one `finding_disposition` for F after R1 ends, not
//       postponed (R2 still pending);
//   (d) equal wall stamps: the clock seam moves whole seconds and cannot put
//       two writes in one millisecond, so the equality is ARRANGED BY A
//       LABELLED STORE WRITE of R1's run `finished_at` (a wall stamp only; no
//       event, seq or rowid) to F's `created_at`, with no clock step; then
//       as (a) and (b);
//   (e) rows that predate the ordering fact: see the case at the end.
// M50's manifest and disposition behaviour are M50's file, run beside this.
//
// SAFETY: no unit, no systemctl, no host process; the only engine stopped
// is the test's own (`t.after`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { addWork, advanceClock, observeTrigger, runsOf, scriptedEngine, tick, waitForRun } from './harness/runs.mjs';
import { waitFor } from './harness/engine.mjs';
import { withStore } from './harness/store.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { findingsOf, finding as findingRow, nominated } from './harness/gates.mjs';
import { roleThat, roleThatHolds, runToHold } from './harness/gitruns.mjs';

// The step back: far beyond the wall time between the two facts on this lane.
const STEP = 30;

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const questionsAbout = (home, f) => rows(home, `SELECT "id", "status", "scope", "semantic_generation" FROM "decisions" WHERE "kind" = 'finding_disposition' AND "subject_id" = ? ORDER BY rowid`, f);
const runRow = (home, id) => rows(home, 'SELECT * FROM "runs" WHERE "id" = ?', id)[0];
const ended = (home, run) => eventsOfType(home, 'run.ended').find((e) => e.subject?.run === run);
const raised = (home, f) => eventsOfType(home, 'finding.raised').find((e) => e.subject?.finding === f);

// Ticks until the item's first run has ended (R2's held run never blocks the wait, unlike runs.mjs tickUntil).
async function runOne(fx, project, item, what) {
  for (let i = 0; i < 12; i++) {
    const [r] = runsOf(fx.home, item);
    if (r?.state === 'ended') return r;
    await tick(fx.engine, project);
    await waitFor(() => runsOf(fx.home, item)[0]?.state === 'ended', { timeoutMs: 5000, what }).catch(() => {});
  }
  throw new Error(`${what}: the run did not end after 12 ticks`);
}

// C, and R2 (another review of C) running and held, so it stays pending.
async function withPendingReview(t) {
  const fx = await scriptedEngine(t);
  const ctx = await nominated(fx, { autonomy: 'step' });
  const project = ctx.project.id;
  const C = ctx.candidate.id;
  const r2 = await addWork(fx.engine, project, 'review', { subject: { candidate: C } });
  fx.scripted.script(r2, [roleThatHolds([])]);
  const held = await runToHold(fx, project, r2);
  return { fx, ctx, project, C, r2, r2run: held.run };
}

// R1, the engine's own review of C (trigger verification, C), run to its end with no disposition.
async function engineReview(J) {
  const { fx, project, C } = J;
  const seen = await observeTrigger(fx.engine, { project, kind: 'review', source: 'verification', id: C, subject: { candidate: C } });
  assert.equal(seen.status, 201, `R1, the engine's review of C (→ ${seen.status} ${seen.res.text})`);
  fx.scripted.script(seen.workItem, [roleThat([])]);
  const run = await runOne(fx, project, seen.workItem, 'R1 to end');
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `R1 accepted (${run.reason_text})`);
  return { item: seen.workItem, run };
}

// F, a Verifier's finding on C.
async function verifierFinding(J, message) {
  const before = findingsOf(J.fx.home, J.project).length;
  const item = await addWork(J.fx.engine, J.project, 'verification', { subject: { candidate: J.C } });
  J.fx.scripted.script(item, [roleThat([], { findings: [{ category: 'defect', severity: 'medium', message }] })]);
  const run = await runOne(J.fx, J.project, item, "the Verifier's run to end");
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the Verifier's run accepted (${run.reason_text})`);
  const found = findingsOf(J.fx.home, J.project).slice(before);
  assert.equal(found.length, 1, 'one finding recorded');
  const [f] = found;
  assert.deepEqual([f.status, f.disposition, f.source_role, f.candidate], ['open', null, 'verifier', J.C], `F is a Verifier's open finding on C (${JSON.stringify(f)})`);
  return f;
}

async function releaseR2(J) {
  J.fx.scripted.release(J.r2);
  const run = await waitForRun(J.fx.home, J.r2, { state: 'ended' });
  assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `R2 accepted (${run.reason_text})`);
  assert.equal(findingRow(J.fx.home, J.F.id).disposition, null, 'R2 left F with no disposition');
}

const assertPending = (J) => assert.notEqual(runRow(J.fx.home, J.r2run.id).state, 'ended', 'R2 is still pending (its run held)');

// Exactly one finding_disposition about F, open, and still one after further ticks.
async function assertAskedOnce(J, what) {
  const { fx, project, F } = J;
  for (let i = 0; i < 6 && questionsAbout(fx.home, F.id).length === 0; i++) await tick(fx.engine, project);
  const q = questionsAbout(fx.home, F.id);
  assert.equal(q.length, 1, `${what}: exactly one finding_disposition about F (${JSON.stringify(q)})`);
  assert.equal(q[0].status, 'open', `${what}: open, the owner's to answer`);
  await tick(fx.engine, project, { rounds: 4 });
  const again = questionsAbout(fx.home, F.id);
  assert.deepEqual(again.map((d) => d.id), [q[0].id], `${what}: raised once across further ticks (${JSON.stringify(again)})`);
  return q[0];
}

describe('M632 a finding owed to the owner, decided by store order', () => {
  test('(a) R1 ended before F by store order, stamped not before it: no question while R2 is pending; (b) R2 ends: exactly one, once', async (t) => {
    const J = await withPendingReview(t);
    const { fx, project } = J;
    J.r1 = await engineReview(J);
    await advanceClock(fx.engine, -STEP);
    J.F = await verifierFinding(J, 'M632 (a): the export omits the header row');
    const r1 = runRow(fx.home, J.r1.run.id);
    assert.ok(r1.finished_at >= J.F.created_at, `the clock step inverts the stamps: R1's finished_at ${r1.finished_at} is not before F's created_at ${J.F.created_at}`);
    const order = [ended(fx.home, r1.id)?.seq, raised(fx.home, J.F.id)?.seq];
    assert.ok(order[0] < order[1], `by store order R1 ended (seq ${order[0]}) before F was raised (seq ${order[1]})`);
    await tick(fx.engine, project, { rounds: 4 });
    assertPending(J);
    assert.deepEqual(questionsAbout(fx.home, J.F.id), [], `(a) no finding_disposition about F while R2 is pending: R1 ended before F (${JSON.stringify(questionsAbout(fx.home, J.F.id))})`);
    await releaseR2(J);
    await assertAskedOnce(J, '(b) once R2 has ended');
  });

  test('(c) the opposite order: F, the clock stepped back, R1 ends without dispositioning F (stamped before F): exactly one question after R1 ends, R2 still pending', async (t) => {
    const J = await withPendingReview(t);
    const { fx } = J;
    J.F = await verifierFinding(J, 'M632 (c): the export omits the header row');
    await advanceClock(fx.engine, -STEP);
    J.r1 = await engineReview(J);
    const r1 = runRow(fx.home, J.r1.run.id);
    assert.ok(r1.finished_at < J.F.created_at, `the clock step inverts the stamps: R1's finished_at ${r1.finished_at} < F's created_at ${J.F.created_at}`);
    const order = [raised(fx.home, J.F.id)?.seq, ended(fx.home, r1.id)?.seq];
    assert.ok(order[0] < order[1], `by store order F was raised (seq ${order[0]}) before R1 ended (seq ${order[1]})`);
    assert.equal(findingRow(fx.home, J.F.id).disposition, null, 'R1 left F with no disposition');
    assertPending(J);
    await assertAskedOnce(J, '(c) after the qualifying review, not postponed');
    assertPending(J);
  });

  test('(d) R1\'s end and F stamped the same millisecond (a labelled store write): as (a) and (b)', async (t) => {
    const J = await withPendingReview(t);
    const { fx, project } = J;
    J.r1 = await engineReview(J);
    J.F = await verifierFinding(J, 'M632 (d): the export omits the header row');
    const order = () => [ended(fx.home, J.r1.run.id)?.seq, raised(fx.home, J.F.id)?.seq];
    const before = order();
    assert.ok(before[0] < before[1], `by store order R1 ended (seq ${before[0]}) before F was raised (seq ${before[1]})`);
    // FIXTURE TAMPERING (labelled): R1's run finished_at made equal to F's created_at. Only that wall stamp is written.
    withStore(fx.home, (db) => db.prepare('UPDATE "runs" SET "finished_at" = ? WHERE "id" = ?').run(J.F.created_at, J.r1.run.id), { readonly: false });
    assert.equal(runRow(fx.home, J.r1.run.id).finished_at, J.F.created_at, 'the fixture is live: the two stamps are equal to the millisecond');
    assert.deepEqual(order(), before, 'the store order of the two facts untouched');
    await tick(fx.engine, project, { rounds: 4 });
    assertPending(J);
    assert.deepEqual(questionsAbout(fx.home, J.F.id), [], `(d) no finding_disposition about F while R2 is pending (${JSON.stringify(questionsAbout(fx.home, J.F.id))})`);
    await releaseR2(J);
    await assertAskedOnce(J, '(d) once R2 has ended');
  });
});
