// M637, a verifiable defect within the brief is repaired on the brief's
// repair allowance (slice 50; kernel lane). The owner's M7 plan §3j, row
// M637; Sean's ruling D3 of 2026-11-26 (DECISIONS item 57): "Use the
// brief's existing repair, token, and spend allowances for verifiable
// defects within scope. Preserve the finding, the repair, and the
// verification result. Ask me if the allowance is exhausted, the repair
// exceeds scope, or success cannot be verified. Lowering, accepting, or
// deferring a finding remains an owner decision."; F §6.2; D3 §2.11. The
// driver's reading (§3j, flagged for Sean): "verifiable" means a check fails
// on the defective candidate; the production R5.5 check passed on the
// defective candidate, which is why (a) and (b) differ.
//
// The classifier runs as configured: the harness engine sets no
// `classifier_authority`, so it is the default `recommend`, the project T1,
// and no Reviewer intervenes (no review work is made for a proposal under
// `recommend`; asserted where a proposal is made).
//
// The fixture: a T1 rapid prototype, iteration 1 (R1 to R3); its checks
// declare `inputs: []` (harness/item57v2.mjs narrowInputs, so that a
// correction adding a criterion is the classifier's tightening) and add X =
// `accept-r3x`, an acceptance check covering K = R3.1 at the Alpha gate only
// (gate_kinds [alpha_authorize]: in every candidate's registered content,
// D3 §2.5, and in no stage scope, so a failing X takes no stage repair).
// The Verifier's verification of C (the one candidate verification at T1:
// the phase's last stage's candidate) raises F (category
// defect, criterion R3.1, check accept-r3x; severity low, and separately
// high). The scripted check boundary records X's executions as each case
// says; every other execution exit 0.
//
// (a) X failed on C: fix work registered at once, `disposition_authority`
//     `policy`, `disposition_by` `policy:rapid_prototype`, one unit of
//     `prototype_repairs_per_iteration` consumed, the fix dispatched, the
//     next candidate nominated, X passes on it, F resolved with
//     `resolution_verification` naming that result (low; and separately
//     high);
// (b) X passed on C: no fix yet; check-correction work for X to the
//     Verifier; the correction adds Y = accept-r3y, a required acceptance
//     check covering K beside X (the same approved command, a new scenario
//     file), applied under M636; Y fails on C: F's `check` bound to Y with X
//     kept in its history, then (a) with Y as the verifying check (rows as
//     amended for objection 236, option 1: driver/item57-rulings-rows
//     8e36459e);
// (c) the correction's checks covering K (X and Y) all still pass on C:
//     the owner's `finding_disposition` question, its evidence saying the
//     repair could not be verified;
// (d) the iteration's repair allowance exhausted
//     (`prototype_repairs_per_iteration` 0): the owner's question naming the
//     allowance;
// (e) F's subject not the current iteration's candidate (M641 (d)'s
//     narrowed gap authoring of iteration 1's plan, run in iteration 2, its
//     Verifier's defect on c1): the owner's question;
// (f) the base: F raises the owed question (asserted in (a): none is
//     raised);
// and in every case policy never lowers, accepts or defers; the finding,
// the fix run, the resulting candidate and the verifying result readable
// from the finding and the iteration's delegation record; a restart
// between the disposition and the fix's dispatch gives one fix item.
//
// Readings this file makes (the report says them):
// - "one unit consumed" is read as the iteration read's
//   `remaining.repairs_iteration` one lower once the fix is dispatched than
//   when F was first recorded.
// - "the next candidate" is the first nominated after the fix item was
//   made; "X passes on it" its X result exit 0; `resolution_verification`'s
//   `check_result` is that result.
// - "the iteration's delegation record" is read as an entry of the
//   iteration read naming F (anywhere in it) that carries `performed_by`
//   or kind `fix_registered`; "readable" as: that entry naming F, the fix
//   work item served by the work read naming F, and the finding's
//   resolution naming the result on the resulting candidate.
// - "its evidence saying …" is read as a reason under a `policy_…` key (or
//   a sentence naming the policy) in the question's evidence as recorded
//   (decisions.evidence) or as served (harness/item57v2.mjs decisionWhy);
//   for (d) such a reason naming the allowance. Whether the decision read
//   serves it is reported as a diagnostic.
// - (b) "X kept in the finding's check history" is read as an event about
//   F whose payload names both X and Y, or X named in F's row.
// - The restart: the project is paused when F is first recorded, so the
//   disposition is made and no fix dispatched before the restart.
// - (d)'s "or the run would exceed the iteration's tokens/USD" and (e)'s
//   "K outside the brief" are not exercised: a finding's criterion must be
//   one of the registered index's (invoke/choke.ts), and the index is the
//   brief's own revision; the token/USD variant needs a limit calibrated to
//   the scripted usage at F's moment, not built here. The report says so.
//
// SAFETY (BS6 §4.1; E64): the kernel lane; the scripted role program and
// the scripted deployment adapter in the test's own home; nothing signalled
// but the test's own engine (the harness's verified stop).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gapItems, gapScript, phase2Plan, restart, runsOn, untilPublished } from './harness/gap57.mjs';
import { waitFor } from './harness/engine.mjs';
import { pauseProject, resumeProject, tick } from './harness/runs.mjs';
import { CHECK_KINDS, alphaReady, answerOpen, authoringScript, idle, iterationRead, kindNext, protoEngine, pump, result, toBrief, usage, workRead, write } from './harness/prototype.mjs';
import {
  NARROW_FILES,
  decisionsAbout,
  eventsAbout,
  findingRow,
  narrowGapRefused,
  objectsWhere,
  one,
  proposalsOfRun,
  pumpWith,
  resultsOf,
  rows,
  show,
  versionsOfProposal,
  decisionWhy,
  workOfKind,
} from './harness/item57v2.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const X = 'accept-r3x';
const XPATH = `.surety/checks/defs/${X}.json`;
const XDEF = { schema: 1, key: X, kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: ['alpha_authorize'], covers: { criteria: ['R3.1'] }, inputs: [] };
const FILES = { ...NARROW_FILES, [XPATH]: json(XDEF) };
// (b), (c): the Verifier's correction adds Y beside X, covering K with the same
// approved command and a new scenario file (objection 236, option 1).
const Y = 'accept-r3y';
const YSCENARIO = '.surety/checks/run/r3-done.mjs';
const TIGHTENED = { ...FILES, [`.surety/checks/defs/${Y}.json`]: json({ ...XDEF, key: Y, inputs: [YSCENARIO] }), [YSCENARIO]: "export const expect = 'a finished task is listed as done';\n" };
const finding = (severity) => ({ category: 'defect', severity, message: 'the list does not show a finished task as done after it is marked', check: X, criterion: 'R3.1' });
const correctionScript = () => ({ steps: [usage(600, 0, 200), ...Object.entries(TIGHTENED).map(([p, c]) => write(p, c)), result({ proposal: { rationale: `${Y} asserts the listed state the defect breaks, beside ${X}`, requested_change_kind: 'tightening' } })] });

const fixItems = (home, p, F) => workOfKind(home, p, 'fix').filter((w) => w.subject?.finding === F);
const corrections = (home, p, F) => workOfKind(home, p, 'check_correction').filter((w) => w.trigger_id === F);
const candidate = (home, id) => one(home, 'SELECT * FROM "candidates" WHERE "id" = ?', id);
const effectiveVersionId = (home, p) => one(home, 'SELECT "id" FROM "protected_versions" WHERE "project" = ? AND "authorized" = 1 AND "effective_from" IS NOT NULL AND "superseded_by" IS NULL', p)?.id ?? null;

// The exits: `mode` 'a': X fails on every candidate made before F's fix
// item; 'b': X always passes, Y fails on those candidates; 'c': X and Y
// always pass. Every other check passes.
function exitsFor(fx, p, mode, S) {
  return (x) => {
    const failing = mode === 'a' ? X : mode === 'b' ? Y : null;
    if (x.key !== failing) return 0;
    const fix = S.F ? fixItems(fx.home, p, S.F)[0] : null;
    const c = candidate(fx.home, x.candidate);
    if (fix && Date.parse(c.created_at) >= Date.parse(fix.created_at)) return 0;
    return 1;
  };
}

// Iteration 1 to C's verification raising F. Returns {fx, p, it, S}.
async function toFinding(t, { name, port, severity = 'low', mode = 'a', policy, pauseAtF = false }) {
  const fx = await protoEngine(t, { config: { lease_ttl: 600 } });
  kindNext(fx, 'check_authoring', [authoringScript({ files: FILES })], authoringScript({ files: FILES }));
  kindNext(fx, 'verification', [{ steps: [usage(300, 0, 100), result({ findings: [finding(severity)] })] }], { steps: [usage(300, 0, 100), result()] });
  kindNext(fx, 'check_correction', [correctionScript(), correctionScript()], correctionScript());
  const { id: p, it } = await toBrief(fx, { name, ...(policy ? { policy } : {}) });
  await answerOpen(fx, p, 'spec_approval');
  await alphaReady(fx, p, { port });
  const S = { F: null, V0: null, repairsAtF: null, exitLog: [] };
  const exitOf = exitsFor(fx, p, mode, S);
  await pumpWith(
    fx,
    p,
    async () => {
      const f = rows(fx.home, 'SELECT * FROM "findings" WHERE "project" = ? AND "check" = ?', p, X)[0];
      if (!f) return undefined;
      if (S.F === null) {
        if (pauseAtF) await pauseProject(fx.engine, p);
        S.F = f.id;
        S.V0 = effectiveVersionId(fx.home, p);
        S.repairsAtF = (await iterationRead(fx, p, it.id)).remaining.repairs_iteration;
      }
      // X's result on C recorded (under the version at F).
      return resultsOf(fx.home, f.candidate, X).length > 0 ? true : undefined;
    },
    { answer: CHECK_KINDS, exitOf, log: S.exitLog, max: 80, what: "C's verification raising F" },
  );
  const F = findingRow(fx.home, S.F);
  const C = candidate(fx.home, F.candidate);
  assert.ok(C, `the fixture is live: F on a candidate (${show([F.scope, F.candidate])})`);
  S.C = C.id;
  return { fx, p, it: it.id, S, exitOf };
}

const asked = (home, F) => decisionsAbout(home, F, 'finding_disposition');
function assertNeverByPolicy(fx, F, what) {
  const f = findingRow(fx.home, F);
  assert.deepEqual((f.severity_history ?? []).filter((h) => h.authority === 'policy'), [], `${what}: no policy entry in severity_history (${show(f.severity_history)})`);
  assert.ok(!(f.disposition_authority === 'policy' && ['accept', 'defer'].includes(f.disposition)), `${what}: never accepted or deferred by the policy (${show([f.disposition, f.disposition_authority])})`);
  assert.equal(f.effective_severity, f.proposed_severity, `${what}: its severity as raised`);
}

async function assertRepairedByPolicy(J, what, { verifying = X } = {}) {
  const { fx, p, it, S, exitOf } = J;
  const F = S.F;
  const resolved = await pumpWith(fx, p, () => (findingRow(fx.home, F).status === 'resolved' ? findingRow(fx.home, F) : undefined), { exitOf, log: S.exitLog, max: 80, what: `${what}: F resolved` });
  assert.deepEqual(asked(fx.home, F).map((d) => [d.kind, d.status]), [], `${what} and (f): no finding_disposition question about F (the base raises the owed question)`);
  assert.deepEqual([resolved.disposition, resolved.disposition_authority, resolved.disposition_by], ['fix', 'policy', 'policy:rapid_prototype'], `${what}: dispositioned fix by the policy`);
  const fixes = fixItems(fx.home, p, F);
  assert.equal(fixes.length, 1, `${what}: one fix item (${show(fixes.map((w) => [w.id, w.status]))})`);
  const fixRuns = runsOn(fx.home, fixes[0].id);
  assert.ok(fixRuns.length >= 1, `${what}: the fix dispatched`);
  const read = await iterationRead(fx, p, it);
  assert.equal(read.remaining.repairs_iteration, S.repairsAtF - 1, `${what}: one unit of prototype_repairs_per_iteration consumed (${S.repairsAtF} → ${read.remaining.repairs_iteration})`);
  const next = rows(fx.home, 'SELECT * FROM "candidates" WHERE "project" = ? AND "created_at" >= ? ORDER BY "seq"', p, fixes[0].created_at)[0];
  assert.ok(next, `${what}: the next candidate nominated after the fix`);
  const passed = resultsOf(fx.home, next.id, verifying).filter((r) => r.exit_status === 0 && r.invalidated_at === null);
  assert.ok(passed.length >= 1, `${what}: ${verifying} passes on ${next.id} (${show(resultsOf(fx.home, next.id, verifying).map((r) => [r.id, r.exit_status]))})`);
  assert.ok(passed.some((r) => r.id === resolved.resolution_verification?.check_result), `${what}: F resolved by that result (${show(resolved.resolution_verification)})`);
  assertNeverByPolicy(fx, F, what);
  // The delegation record.
  const entries = objectsWhere(read, (o) => show(o).includes(F) && ('performed_by' in o || o.kind === 'fix_registered'));
  assert.ok(entries.length > 0, `${what}: the iteration's delegation record names F (iteration read keys: ${Object.keys(read).join(', ')})`);
  const served = (await workRead(fx, p)).find((w) => w.id === fixes[0].id);
  assert.equal(served?.subject?.finding, F, `${what}: the fix work read from the finding (the work read serves it naming F: ${show(served?.subject)})`);
  assert.ok(candidate(fx.home, passed.find((r) => r.id === resolved.resolution_verification.check_result).candidate)?.id === next.id, `${what}: the resolution names the result on the resulting candidate`);
  return { resolved, next, fix: fixes[0] };
}

describe('M637 a verifiable defect within the brief is repaired on the brief\'s repair allowance', () => {
  for (const severity of ['low', 'high']) {
    test(`(a), (f) X failed on C, F ${severity}: fixed by the policy at once, one repair consumed, verified on the next candidate; no owed question`, { timeout: 600_000 }, async (t) => {
      const J = await toFinding(t, { name: `M637 a ${severity}`, port: severity === 'low' ? 18701 : 18702, severity, mode: 'a' });
      const failedOnC = J.S.exitLog.filter((x) => x.key === X && x.candidate === J.S.C && x.exit === 1);
      assert.ok(failedOnC.length >= 1 || resultsOf(J.fx.home, J.S.C, X).some((r) => r.exit_status === 1), `the fixture is live: X failed on C (${show(resultsOf(J.fx.home, J.S.C, X).map((r) => [r.exit_status, r.protected_version]))}; recorded ${show(J.S.exitLog.map((x) => [x.key, x.candidate === J.S.C, x.exit]))})`);
      await assertRepairedByPolicy(J, `(a) ${severity}`);
    });
  }

  test('(b) X passed on C: no fix yet; the correction adds Y covering K beside X, applied by policy; Y fails on C: F bound to Y, X kept in its history; then repaired as (a) with Y verifying', { timeout: 600_000 }, async (t) => {
    const J = await toFinding(t, { name: 'M637 b', port: 18703, mode: 'b' });
    const { fx, p, S, exitOf } = J;
    assert.ok(resultsOf(fx.home, S.C, X).some((r) => r.exit_status === 0 && r.protected_version === S.V0), '(b) the fixture is live: X passed on C');
    const corr = await pumpWith(fx, p, () => corrections(fx.home, p, S.F).find((w) => runsOn(fx.home, w.id).some((r) => r.state === 'ended')), { exitOf, log: S.exitLog, max: 40, what: "(b) the check correction's run" });
    const proposal = runsOn(fx.home, corr.id).flatMap((r) => proposalsOfRun(fx.home, r.id)).at(-1);
    assert.ok(proposal, '(b) the Verifier proposed the added check');
    const V = await pumpWith(fx, p, () => versionsOfProposal(fx.home, proposal.id).find((v) => v.effective_from !== null), { exitOf, log: S.exitLog, max: 40, what: '(b) the added check applied' });
    assert.deepEqual([V.approver_authority, V.approved_by], ['policy', 'policy:rapid_prototype'], `(b) applied under M636 (${show([V.approver_authority, V.approved_by])})`);
    assert.equal(rows(fx.home, `SELECT 1 FROM "work_items" WHERE "kind" = 'review' AND "trigger_id" = ?`, proposal.id).length, 0, '(b) no Reviewer (recommend)');
    const fixAtApplication = rows(fx.home, `SELECT "id", "created_at" FROM "work_items" WHERE "kind" = 'fix' AND json_extract("subject", '$.finding') = ? AND "created_at" < ?`, S.F, V.effective_from);
    assert.deepEqual(fixAtApplication, [], '(b) no fix before Y reproduced F');
    const { resolved } = await assertRepairedByPolicy(J, '(b)', { verifying: Y });
    assert.ok(resultsOf(fx.home, S.C, Y).some((r) => r.exit_status === 1 && r.protected_version === V.id), `(b) Y failed on C (${show(resultsOf(fx.home, S.C, Y).map((r) => [r.exit_status, r.protected_version]))})`);
    assert.equal(resolved.check, Y, `(b) F's check bound to Y (${resolved.check})`);
    const history = eventsAbout(fx.home, S.F).filter((e) => show(e.payload).includes(X) && show(e.payload).includes(Y));
    assert.ok(history.length > 0 || show(resolved).includes(`"${X}"`) || Object.values(resolved).some((v) => typeof v === 'string' && v.includes(X)), `(b) X kept in the finding's check history (events about F: ${show(eventsAbout(fx.home, S.F).map((e) => [e.type, e.payload]))}; row: ${show(resolved)})`);
  });

  test("(c) the correction's checks covering K all still pass on C: the owner's finding_disposition question, its evidence saying the repair could not be verified", { timeout: 600_000 }, async (t) => {
    const J = await toFinding(t, { name: 'M637 c', port: 18704, mode: 'c' });
    const { fx, p, S, exitOf } = J;
    const q = await pumpWith(fx, p, () => asked(fx.home, S.F).find((d) => d.status === 'open'), { exitOf, log: S.exitLog, max: 60, what: "(c) the owner's question about F" });
    const corr = corrections(fx.home, p, S.F);
    assert.ok(corr.length === 1 && runsOn(fx.home, corr[0].id).length >= 1, `(c) the correction was routed to the Verifier first (${show(corr.map((w) => [w.id, w.status]))})`);
    const applied = runsOn(fx.home, corr[0].id).flatMap((r) => proposalsOfRun(fx.home, r.id)).flatMap((x) => versionsOfProposal(fx.home, x.id)).find((v) => v.effective_from !== null);
    assert.ok(applied, '(c) the added check applied');
    for (const key of [X, Y]) assert.ok(resultsOf(fx.home, S.C, key).some((r) => r.exit_status === 0 && r.protected_version === applied.id), `(c) the fixture is live: ${key} passed on C under the corrected version`);
    assert.deepEqual(fixItems(fx.home, p, S.F), [], '(c) no fix registered');
    assert.equal(findingRow(fx.home, S.F).disposition, null, '(c) F undispositioned');
    const why = await decisionWhy(fx, p, q.id);
    assert.ok(why.reasons.length > 0, `(c) its evidence says why the policy did not repair it (stored: ${show(why.stored)}; served: ${show(why.decision).slice(0, 1500)})`);
    assert.ok(why.reasons.some((r) => /verif/i.test(r)), `(c) saying the repair could not be verified (${show(why.reasons)})`);
    t.diagnostic(`(c) reasons: ${show(why.reasons)}; served by the decision read: ${why.served.length > 0}`);
    assertNeverByPolicy(fx, S.F, '(c)');
  });

  test("(d) the iteration's repair allowance exhausted: the owner's question naming the allowance", { timeout: 600_000 }, async (t) => {
    const J = await toFinding(t, { name: 'M637 d', port: 18705, mode: 'a', policy: { prototype_repairs_per_iteration: 0 } });
    const { fx, p, S, exitOf } = J;
    const q = await pumpWith(fx, p, () => asked(fx.home, S.F).find((d) => d.status === 'open'), { exitOf, log: S.exitLog, max: 40, what: "(d) the owner's question about F" });
    assert.deepEqual(fixItems(fx.home, p, S.F), [], '(d) no fix registered');
    const why = await decisionWhy(fx, p, q.id);
    assert.ok(why.reasons.length > 0, `(d) its evidence says why the policy did not repair it (stored: ${show(why.stored)}; served: ${show(why.decision).slice(0, 1500)})`);
    assert.ok(why.reasons.some((s) => /allowance|repairs_per_iteration/.test(s)), `(d) naming the allowance (${show(why.reasons)})`);
    t.diagnostic(`(d) reasons: ${show(why.reasons)}; served by the decision read: ${why.served.length > 0}`);
    assertNeverByPolicy(fx, S.F, '(d)');
  });

  test("(e) F's subject not the current iteration's candidate (iteration 1's narrowed gap authoring, run in iteration 2): the owner's question", { timeout: 600_000 }, async (t) => {
    const J = await narrowGapRefused(t, { name: 'M637 e', port: 18706, partial: true });
    const { fx, p, R, G } = J;
    await resumeProject(fx.engine, p);
    await tick(fx.engine, p, { rounds: 1 });
    await waitFor(() => (runsOn(fx.home, R).some((r) => r.state !== 'ended') ? true : undefined), { what: "iteration 2's replan run live", timeoutMs: 60_000 });
    await pauseProject(fx.engine, p);
    fx.scripted.release('all', 'rp');
    await waitFor(() => (runsOn(fx.home, R).some((r) => r.state === 'ended') && !runsOn(fx.home, R).some((r) => r.state !== 'ended') ? true : undefined), { what: "the replan's run ended", timeoutMs: 120_000 });
    assert.ok(phase2Plan(fx.home, p) ?? (await untilPublished(fx, p)), "the fixture is live: phase 2's plan published");
    await tick(fx.engine, p, { rounds: 2 });
    const N = gapItems(fx.home, p).find((w) => w.id !== G);
    assert.ok(N, 'the fixture is live: the narrowed gap authoring');
    const low = gapScript(['R2.2']);
    const last = low.steps.at(-1);
    last.result.findings = last.result.findings.map((f) => ({ ...f, severity: 'low' }));
    fx.scripted.script(N.id, [low, low]);
    await resumeProject(fx.engine, p);
    const F = await pump(fx, p, () => rows(fx.home, 'SELECT * FROM "findings" WHERE "project" = ? AND "criterion" = ? AND "source_run" IN (SELECT "id" FROM "runs" WHERE "work_item" = ?)', p, 'R2.2', N.id)[0], { answer: CHECK_KINDS, max: 40, what: "N's Verifier's finding on c1" });
    const q = await pump(fx, p, () => asked(fx.home, F.id).find((d) => d.status === 'open'), { answer: CHECK_KINDS, max: 20, what: "(e) the owner's question about it" });
    assert.deepEqual(fixItems(fx.home, p, F.id), [], '(e) no fix registered by the policy');
    const why = await decisionWhy(fx, p, q.id);
    assert.ok(why.reasons.length > 0, `(e) its evidence says why the policy did not repair it (stored: ${show(why.stored)}; served: ${show(why.decision).slice(0, 1500)})`);
    t.diagnostic(`(e) reasons: ${show(why.reasons)}; served by the decision read: ${why.served.length > 0}`);
    assertNeverByPolicy(fx, F.id, '(e)');
  });

  test('a restart between the disposition and the fix dispatch: one fix item', { timeout: 600_000 }, async (t) => {
    // The project paused when F is first recorded (no dispatch while paused); X's result then recorded.
    const J = await toFinding(t, { name: 'M637 restart', port: 18707, mode: 'a', pauseAtF: true });
    const { fx, p, S } = J;
    for (let i = 0; i < 10 && findingRow(fx.home, S.F).disposition === null; i++) await tick(fx.engine, p, { rounds: 1 });
    assert.equal(findingRow(fx.home, S.F).disposition, 'fix', 'the fixture is live: F dispositioned while the project is paused');
    const runsBefore = fixItems(fx.home, p, S.F).flatMap((w) => runsOn(fx.home, w.id));
    assert.deepEqual(runsBefore.map((r) => r.id), [], 'the fixture is live: the fix not yet dispatched');
    await idle(fx, p);
    await restart(fx);
    await resumeProject(fx.engine, p);
    await assertRepairedByPolicy(J, 'after the restart');
    assert.equal(fixItems(fx.home, p, S.F).length, 1, 'one fix item');
  });
});
