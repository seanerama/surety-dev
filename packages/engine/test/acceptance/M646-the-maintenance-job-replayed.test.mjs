// M646, the maintenance job replayed (the owner's M7 plan §3j, row M646;
// DECISIONS item 57, Sean's rulings D1–D8 and WO1 Q1 of 2026-11-26 and his
// acceptance ask, verbatim: "replay the same maintenance job from the saved
// two-board plan. Report owner decisions, navigation clicks, and agent
// dispatches separately. Exercise the actual print-label defect: show
// candidate review detects it, an authorized repair corrects it, and the
// first printed page names the unit before the diagrams. Also attempt an
// out-of-brief deployment and show that it stops for my decision before
// dispatch."). Kernel lane, slice 50; the slice plan §A M646, §D.
//
// The fixture (harness/wcp, README.md): Workshop Cut Planner's own products,
// written by the scripted roles (harness/wcp/replay.mjs). Iteration 1 goes
// to its Alpha on `local` (17f0a3d's code, 8b965c6's checks); then, with the
// preparation allowance granted (D8; a policy widening approved before the
// job, counted apart), the owner requests the production change. Spec Writer
// (3fa256d's spec v2), Architect (2578102's phase 2: two stages, the module
// map changed, ADR-003, declaring `conformance: uncertain` as production's
// plan did), Verifier phase authoring (226f7c0 + 3f631ef: 33 definitions),
// Builder stage 1 (eed79f1) and stage 2 (a88fa57 = candidate 2), the
// Verifier's verification of candidate 2 reporting the production finding
// (defect, low, R5.5, accept-r5-5), the Verifier's check correction (the
// tightened R5.5 scenario, harness/wcp/tightened/units-r5.mjs), Builder fix
// (1d32e51 = candidate 3), verification, Alpha on `local`. During the plan
// the owner redeploys iteration 1's Alpha as production did after its
// restart (item 54): the obsolete gap authoring it queues is counted (0
// runs, 0 findings, 0 decisions under M641). Then the owner opens the
// preview, and asks for a deployment of candidate 3 to `demo`, a second
// configured environment with a qualified adapter outside the brief.
//
// The check boundary is scripted (SEAM.md §190); for each accept-r5-5
// execution the exit recorded is the real command's (`node
// .surety/checks/run/check-units.mjs R5.5`) run by the test outside the
// engine, no browser, on the candidate's tree and the protected version's
// checks the execution names (git archive of the project's repository); every
// other execution exit 0, as production recorded them. The same discriminating
// evidence is established first on the fixture's trees alone, and the print
// order asserted directly over the print-visible text.
//
// Counted separately: owner decisions (answers to decisions the engine
// raised in iteration 2; exceptions apart: the demo decision); owner acts
// (Iterate, Open preview, the demo request; the replayed redeploy of
// iteration 1 named apart); agent dispatches by role and work kind (runs of
// iteration 2). Navigation clicks are the console's measure (UI1 U69: a
// click whose only effect is a route or view change, counted by the console
// harness's instrumentation); this engine file does not and cannot count
// them, and states so in its output.
//
// SAFETY: scripted backend; no real model; the only programs run outside
// the engine are WCP's own check scripts on copies of its trees under this
// test's TMPDIR (lib/page.mjs: WCP's DOM, no browser, no network).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { adapterState, configContent, configure, effectCalls, qualifyByFixture, requestDeployment, scriptCall } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { decisionRead, iterationRead, ok, openDecisionsRead, runsOfIteration } from './harness/prototype.mjs';
import { tick } from './harness/runs.mjs';
import { REV, TWO_BOARD, checksOf, codeAt, materialize, printOrder, runCheckUnits } from './harness/wcp/index.mjs';
import { derive } from './harness/wcp/derive-two-board-plan.mjs';
import { CHANGE, J, PORT, PRINT_FINDING, drive, iterationOneAlpha, one, reached, rows, show, verifications } from './harness/wcp/replay.mjs';

// The target of D.4 (the slice plan): iteration 2's dispatches by role/kind.
const TARGET_DISPATCHES = Object.freeze({
  'spec_writer/brief_preparation': 1,
  'architect/replan': 1,
  'verifier/check_authoring': 1,
  'builder/stage_build': 2,
  'verifier/verification': 2,
  'verifier/check_correction': 1,
  'builder/fix': 1,
});

const scratchOf = (name) => {
  const dir = join(process.env.TMPDIR ?? '/tmp', `m646-${name}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const candidatesOf = (home, p) => rows(home, 'SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"', p);
const findingsOf = (home, p) => rows(home, 'SELECT * FROM "findings" WHERE "project" = ? ORDER BY "seq"', p);
const workOf = (home, p, kind) => rows(home, 'SELECT * FROM "work_items" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"', p, kind).map((w) => ({ ...w, subject: J(w.subject), trigger_evidence: J(w.trigger_evidence) }));
const decisionsOf = (home, p) => rows(home, 'SELECT "id", "kind", "status", "subject_type", "subject_id", "seq" FROM "decisions" WHERE "project" = ? ORDER BY "seq"', p);
const versionsOf = (home, p) => rows(home, 'SELECT * FROM "protected_versions" WHERE "project" = ? ORDER BY "seq"', p);
const plansOf = (home, p) => rows(home, 'SELECT * FROM "phase_plans" WHERE "project" = ? ORDER BY rowid', p);
const revisionOf = (home, c) => one(home, 'SELECT "revision" FROM "candidates" WHERE "id" = ?', c)?.revision;

// The demo environment's effects: authorizations, requests, deploy work and
// the scripted adapter's deploy calls for it.
async function demoEffects(fx, p, demo) {
  const auths = rows(fx.home, 'SELECT "id", "status" FROM "deployment_authorizations" WHERE "project" = ? AND "environment" = ?', p, demo.id);
  const requests = rows(fx.home, 'SELECT "id", "requested_by", "outcome", "reason", "authorization", "work_item" FROM "deployment_requests" WHERE "project" = ? AND "environment" = ?', p, demo.id);
  const work = rows(fx.home, `SELECT "id", "status", "subject" FROM "work_items" WHERE "project" = ? AND "kind" = 'deploy'`, p).filter((w) => JSON.stringify(J(w.subject) ?? {}).includes(demo.id));
  const intents = eventsOfType(fx.home, 'deployment.intent_recorded').filter((e) => JSON.stringify(e).includes(demo.id));
  const calls = effectCalls(await adapterState(fx.engine, demo.id), 'deploy');
  return { auths, requests, work, intents, calls };
}
const nothingDispatched = (e) => e.auths.length === 0 && e.work.length === 0 && e.intents.length === 0 && e.calls.length === 0 && e.requests.every((r) => r.authorization === null && r.work_item === null);

// ---- the replay ------------------------------------------------------------------------------

async function replay(t) {
  const scratch = scratchOf('kernel');
  const R = await iterationOneAlpha(t, { scratch });
  const { fx, p, it1, local, o, real, prep1 } = R;
  R.scratch = scratch;
  R.errors = {};
  R.answersBefore = o.answers.length;
  R.c1 = candidatesOf(fx.home, p).at(-1);

  // D8: the preparation allowance, granted before the job (counted apart).
  o.at('grant the preparation allowance (before the job)');
  const grant = { prototype_preparation_allowance: 'per_iteration', prototype_preparation_model: `${prep1.provider}/${prep1.model}`, prototype_preparation_run_tokens: prep1.run_token_limit, prototype_preparation_usd_estimated: 1 };
  const g = await fx.engine.post(`/v1/projects/${p}/policy`, grant);
  R.grant = { request: grant, status: g.status, body: g.body ?? g.text };
  if (g.status === 409 && g.body?.code === 'confirm_required') {
    const d = await decisionRead(fx, p, g.body.subject.decision);
    const a = await fx.engine.post(`/v1/projects/${p}/decisions/${d.id}/answer`, { option: 'approve', preview_hash: d.preview_hash });
    R.grant.widening = { decision: d.id, kind: d.kind, answer: a.status };
    await tick(fx.engine, p);
  }
  R.answersAfterGrant = o.answers.length;

  // Request a change (owner act 1).
  o.at('Request a change');
  verifications(fx);
  await scriptCall(fx.engine, local.id, 'deploy', [{ result: 'issued', apply: true }, { result: 'issued', apply: true }]);
  const made = await fx.engine.post(`/v1/projects/${p}/iterations/${it1.id}/iterate`, { change: CHANGE });
  o.acts.push({ step: o.step, act: 'iterate', status: made.status });
  assert.equal(made.status, 201, `Iterate (→ ${made.status} ${made.text})`);
  R.iterate = made.body;
  const it2 = made.body.iteration.id;
  R.it2 = it2;
  R.decisionsAtIterate = decisionsOf(fx.home, p).length;
  R.answersFrom = o.answers.length;

  o.at('preparation');
  await drive(fx, p, o, reached(fx, p, it2, 'awaiting_brief_approval'), { what: "iteration 2's brief", real, scratch });

  // The one owner decision.
  o.at('Approve the brief');
  const briefQ = (await openDecisionsRead(fx, p)).find((d) => d.kind === 'spec_approval');
  assert.ok(briefQ, 'the brief is asked');
  const a = await fx.engine.post(`/v1/projects/${p}/decisions/${briefQ.id}/answer`, { option: 'approve', preview_hash: briefQ.preview_hash });
  o.answers.push({ step: o.step, kind: briefQ.kind, decision: briefQ.id, option: 'approve', status: a.status });
  assert.equal(a.status, 200, `the brief approved (→ ${a.status} ${a.text})`);

  // Production's redeploy of iteration 1's Alpha while the plan is pending
  // (11:55Z, after its restart: item 54), replayed so the obsolete gap
  // authoring arises; an owner act, named apart from the target's.
  o.at('the replayed redeploy of iteration 1 (production 11:55Z)');
  const redeploy = await requestDeployment(fx.engine, p, R.c1.id, 'local');
  o.acts.push({ step: o.step, act: 'redeploy iteration 1 (production restore, item 54)', status: redeploy.status, code: redeploy.body?.code ?? null });
  R.redeploy = { status: redeploy.status, body: redeploy.body ?? redeploy.text };
  R.gapItems = workOf(fx.home, p, 'check_authoring').filter((w) => w.trigger_source === 'authoring_gap');

  o.at('build to Alpha');
  try {
    await drive(fx, p, o, reached(fx, p, it2, 'alpha_ready'), { max: 220, what: "iteration 2's Alpha", real, scratch });
    const adv = await fx.engine.post('/v1/harness/clock/advance', { seconds: 31 });
    assert.equal(adv.status, 200, `the clock advanced (${adv.text})`);
    await drive(fx, p, o, async () => (await iterationRead(fx, p, it2)).alpha.current ?? undefined, { what: "an observation of iteration 2's Alpha", real, scratch });
  } catch (e) {
    R.errors.alpha = e;
  }
  R.read2 = await iterationRead(fx, p, it2);
  R.answers2 = o.answers.slice(R.answersFrom);

  // Open preview (owner act 2).
  o.at('Open preview');
  const relay = await fx.engine.post(`/v1/projects/${p}/environments/local/relay`, {});
  o.acts.push({ step: o.step, act: 'open preview (relay)', status: relay.status, code: relay.body?.code ?? null });
  R.relay = { status: relay.status, body: relay.body ?? relay.text };

  // The out-of-brief deployment (owner act 3), never answered.
  o.at('out-of-brief deployment to demo');
  try {
    const dm = await configure(fx.engine, p, 'demo', configContent({ start: [process.execPath, 'server.mjs'], port: PORT + 1 }));
    R.demo = { ...dm.environment, name: 'demo' };
    await qualifyByFixture(fx.engine);
    const c3 = candidatesOf(fx.home, p).at(-1);
    R.demoCandidate = c3;
    const decisionsBefore = decisionsOf(fx.home, p).length;
    const req = await requestDeployment(fx.engine, p, c3.id, 'demo');
    o.acts.push({ step: o.step, act: 'deploy to demo', status: req.status, code: req.body?.code ?? null });
    R.demoRequest = { status: req.status, body: req.body ?? req.text };
    R.demoDecisions = () => decisionsOf(fx.home, p).slice(decisionsBefore).filter((d) => d.kind === 'deployment_target_approval');
    R.demoAt = { request: await demoEffects(fx, p, R.demo) };
    await tick(fx.engine, p);
    await drive(fx, p, o, async () => true, { real, scratch });
    R.demoAt.tick = await demoEffects(fx, p, R.demo);
    R.demoOpenAfterTick = (await openDecisionsRead(fx, p)).filter((d) => d.kind === 'deployment_target_approval');
    await fx.engine.stop();
    await fx.start();
    await tick(fx.engine, p);
    R.demoAt.restart = await demoEffects(fx, p, R.demo);
    R.demoOpenAfterRestart = (await openDecisionsRead(fx, p)).filter((d) => d.kind === 'deployment_target_approval');
  } catch (e) {
    R.errors.demo = e;
  }
  return R;
}

describe('M646 the maintenance job replayed', () => {
  const shared = sharedFixture();
  let R;
  // The discriminating evidence, before the engine work: the fixture's
  // trees alone, the real check and the print-visible text.
  const evidence = {};
  before(async () => {
    const scratch = scratchOf('evidence');
    for (const [name, rev] of [['stage2', REV.stage2], ['fix', REV.fix]]) {
      const code = codeAt(rev, scratch);
      const original = materialize(join(scratch, `${name}-original`), code, checksOf(2));
      const tightened = materialize(join(scratch, `${name}-tightened`), code, checksOf(2, { tightened: true }));
      evidence[name] = { original: runCheckUnits(original), tightened: runCheckUnits(tightened), print: printOrder(original) };
    }
    evidence.derived = await derive(scratch);
    R = await replay(shared.context);
  });
  after(shared.cleanup);

  test('the saved two-board plan: derived again with iteration 1\'s own store.mjs, it is the checked-in CP_STORAGE; its layout leaves 194 mm and 97 mm', () => {
    assert.deepEqual(evidence.derived.storage, TWO_BOARD, 'the derivation reproduces two-board-plan.json');
    assert.deepEqual(evidence.derived.layout.boards.map((b) => [b.lengthMm, b.freeMm]), [[1000, 194], [500, 97]], 'boards 1000 mm and 500 mm, offcuts 194 mm and 97 mm');
  });

  test('the discriminating evidence outside the engine: the real accept-r5-5 passes on a88fa57 and 1d32e51; the tightened one fails on a88fa57 and passes on 1d32e51; with the saved plan the unit follows the first board diagram on a88fa57 and precedes it on 1d32e51', () => {
    const exits = Object.fromEntries(['stage2', 'fix'].flatMap((n) => [[`${n} original`, evidence[n].original.status], [`${n} tightened`, evidence[n].tightened.status]]));
    assert.deepEqual(exits, { 'stage2 original': 0, 'stage2 tightened': 1, 'fix original': 0, 'fix tightened': 0 }, `the real exits (${show(exits)}); tightened on a88fa57: ${evidence.stage2.tightened.out.split('\n').filter((l) => l.includes('FAIL')).join(' | ')}`);
    for (const unit of ['mm', 'in']) {
      const a = evidence.stage2.print[unit];
      const f = evidence.fix.print[unit];
      assert.equal(a.diagrams, 2, `a88fa57 prints two board diagrams (${unit})`);
      assert.ok(a.unitAt > a.diagramAt && a.diagramAt >= 0, `a88fa57 (${unit}): the unit is first named after the first board diagram (unit at ${a.unitAt}, diagram at ${a.diagramAt}): ${a.text.slice(0, 400)}`);
      assert.ok(f.unitAt >= 0 && f.unitAt < f.diagramAt, `1d32e51 (${unit}): the first printed page names the unit before the first board diagram (unit at ${f.unitAt}, diagram at ${f.diagramAt}): ${f.text.slice(0, 400)}`);
    }
  });

  test('owner decisions: one, the brief; exceptions apart: one deployment_target_approval for demo', (t) => {
    t.diagnostic(`navigation clicks: not counted by the engine (the console's U69 instrumentation counts them)`);
    t.diagnostic(`allowance grant (before the job, apart): ${show(R.grant)}`);
    t.diagnostic(`iteration 2's owner answers: ${show(R.answers2.map((x) => [x.step, x.kind, x.option]))}`);
    t.diagnostic(`owner acts: ${show(R.o.acts)}`);
    assert.deepEqual(R.answers2.map((x) => x.kind), ['spec_approval'], `iteration 2's owner decisions are the brief alone (${show(R.answers2.map((x) => [x.step, x.kind, x.option]))})`);
    assert.ok(R.grant.status === 409 && R.grant.widening?.answer === 200, `the allowance is granted through its policy_widening, before the job (→ ${R.grant.status} ${show(R.grant.body).slice(0, 400)})`);
    const raised = R.demoDecisions ? R.demoDecisions() : [];
    assert.equal(raised.length, 1, `one deployment_target_approval for demo (${show(raised)}; demo request ${show(R.demoRequest)}; ${R.errors.demo ?? ''})`);
  });

  test('owner acts: Iterate and Open preview to the Alpha, then the demo request; the replayed redeploy of iteration 1 named apart', () => {
    const acts = R.o.acts.map((a) => a.act);
    assert.deepEqual(acts, ['iterate', 'redeploy iteration 1 (production restore, item 54)', 'open preview (relay)', 'deploy to demo'], `the acts (${show(R.o.acts)})`);
    // Open preview is one request to the relay route of `local`. The kernel
    // lane's engine has no service host, so it answers relay_unavailable
    // (the relay itself is the deploy lane's, M337); either way the act is
    // the owner's one request and raises no question.
    const relayOk = [200, 201, 202].includes(R.relay.status) || (R.relay.status === 409 && R.relay.body?.code === 'relay_unavailable');
    assert.ok(relayOk, `Open preview: one request to local's relay (→ ${R.relay.status} ${show(R.relay.body).slice(0, 400)})`);
  });

  test('agent dispatches of iteration 2 by role and kind: Spec Writer 1, Architect 1, Verifier authoring 1, Builder 2, Verifier verification 2, Verifier check correction 1, Builder fix 1', (t) => {
    const runs = runsOfIteration(R.fx.home, R.it2);
    const by = {};
    for (const r of runs) by[`${r.role}/${r.work_kind}`] = (by[`${r.role}/${r.work_kind}`] ?? 0) + 1;
    t.diagnostic(`dispatches: ${show(by)} (${runs.length} runs)`);
    assert.deepEqual(by, TARGET_DISPATCHES, `iteration 2's runs by role/kind (${show(by)})`);
    assert.equal(runs.length, 9, '9 dispatches in all');
  });

  test('the obsolete gap authoring the redeploy queued: 0 runs, 0 findings, 0 decisions', (t) => {
    const { fx, p } = R;
    t.diagnostic(`redeploy of iteration 1: ${show(R.redeploy).slice(0, 600)}`);
    const gaps = workOf(fx.home, p, 'check_authoring').filter((w) => w.trigger_source === 'authoring_gap');
    t.diagnostic(`gap items: ${show(gaps.map((g) => [g.id, g.status, g.end_cause ?? null]))}`);
    assert.equal(gaps.length, 1, `the redeploy queued one gap authoring, as production's did (${show(gaps.map((g) => [g.id, g.status]))}; redeploy ${show(R.redeploy).slice(0, 400)})`);
    const runs = rows(fx.home, 'SELECT "id" FROM "runs" WHERE "work_item" = ?', gaps[0].id);
    const findings = rows(fx.home, `SELECT f."id" FROM "findings" f JOIN "runs" r ON r."id" = f."source_run" WHERE r."work_item" = ?`, gaps[0].id);
    const decisions = rows(fx.home, 'SELECT "id", "kind" FROM "decisions" WHERE "subject_id" = ? OR "subject_id" IN (SELECT "id" FROM "runs" WHERE "work_item" = ?)', gaps[0].id, gaps[0].id);
    assert.deepEqual([runs.length, findings.length, decisions.length], [0, 0, 0], `0 runs, 0 findings, 0 decisions from ${gaps[0].id} (${show({ runs, findings, decisions })})`);
  });

  test('candidate review detects the print defect on candidate 2; the tightened R5.5 reproduces it (real exit 1); a repair authorized by the brief corrects it; candidate 3 passes the tightened R5.5 (real exit 0); the real accept-r5-5 passed candidate 2 (non-regression only)', (t) => {
    const { fx, p, real } = R;
    const its = candidatesOf(fx.home, p).filter((c) => c.seq > R.c1.seq);
    t.diagnostic(`iteration 2's candidates: ${show(its.map((c) => [c.id, c.revision?.slice(0, 10), c.superseded_by ?? null]))}`);
    t.diagnostic(`real accept-r5-5 runs: ${show(real.map((r) => [r.candidate, r.revision.slice(0, 10), `v${r.version_seq}`, r.tightened ? 'tightened' : 'original', r.exit]))}`);
    const findings = findingsOf(fx.home, p).filter((f) => f.criterion === 'R5.5' && f.check === 'accept-r5-5');
    assert.equal(findings.length, 1, `one print finding (${show(findings)})`);
    const F = findings[0];
    const c2 = F.candidate;
    assert.equal(F.scope, 'candidate', `bound to the candidate it observed (D6) (scope ${F.scope})`);
    assert.equal(F.message, PRINT_FINDING.message, 'the production finding');
    assert.deepEqual([F.category, F.proposed_severity, F.effective_severity], ['defect', 'low', 'low'], 'defect, low');
    assert.equal(J(F.severity_history).filter((h) => JSON.stringify(h).includes('policy')).length, 0, 'policy never lowered it');
    const onC2 = real.filter((r) => r.candidate === c2);
    assert.ok(onC2.some((r) => !r.tightened && r.exit === 0), `the real accept-r5-5 passed on candidate 2 (recorded, not repair evidence) (${show(onC2.map((r) => [r.tightened, r.exit]))})`);
    assert.ok(onC2.some((r) => r.tightened && r.exit === 1), `the tightened accept-r5-5 failed on candidate 2: the defect reproduced (${show(onC2.map((r) => [r.tightened, r.exit]))})`);
    assert.deepEqual([F.status, F.disposition, F.disposition_authority, F.disposition_by], ['resolved', 'fix', 'policy', 'policy:rapid_prototype'], `fixed by policy within the brief, resolved (${show([F.status, F.disposition, F.disposition_authority, F.disposition_by])})`);
    const fix = workOf(fx.home, p, 'fix');
    assert.equal(fix.length, 1, `one fix (${show(fix.map((w) => [w.id, w.status, w.subject]))})`);
    const c3 = its.at(-1);
    assert.notEqual(c3.id, c2, 'the fix nominated a later candidate');
    assert.ok(real.some((r) => r.candidate === c3.id && r.tightened && r.exit === 0), `the tightened accept-r5-5 passed on candidate 3 (${show(real.filter((r) => r.candidate === c3.id).map((r) => [r.tightened, r.exit]))})`);
    const verified = J(F.resolution_verification);
    assert.ok(JSON.stringify(verified ?? {}).includes(c3.id), `the resolution names candidate 3's result (${show(verified)})`);
  });

  test('the plan and the tightenings were the brief\'s: no preparation, architecture, plan, tightening or disposition question in iteration 2; phase 2\'s checks and the R5.5 correction applied by policy', (t) => {
    const { fx, p } = R;
    const raised = decisionsOf(fx.home, p).slice(R.decisionsAtIterate).filter((d) => !['spec_approval', 'deployment_target_approval'].includes(d.kind));
    const proposals = rows(fx.home, `SELECT pp."id", pp."status", pp."classified_change_kind", w."kind" AS "work_kind" FROM "protected_proposals" pp LEFT JOIN "runs" r ON r."id" = pp."run" LEFT JOIN "work_items" w ON w."id" = r."work_item" WHERE pp."project" = ? ORDER BY pp.rowid`, p);
    t.diagnostic(`protected proposals: ${show(proposals)}`);
    const later = versionsOf(fx.home, p).slice(1).map((x) => [x.seq, x.change_kind, x.approver_authority, x.approved_by]);
    t.diagnostic(`protected versions after the first: ${show(later)}`);
    assert.deepEqual(raised.map((d) => d.kind), [], `iteration 2 raised no other question (${show(raised)})`);
    assert.ok(later.length >= 2, `iteration 2 applied phase 2's checks and the R5.5 correction (${show(later)})`);
    assert.deepEqual(later.slice(-2).map((x) => x[2]), ['policy', 'policy'], `both applied by policy (${show(later)})`);
  });

  test('Alpha on local: iteration 2 alpha_ready on candidate 3, the plan published, phase 2 complete', () => {
    const { fx, p } = R;
    assert.equal(R.errors.alpha, undefined, `the replay reached iteration 2's Alpha (${R.errors.alpha?.message?.slice(0, 1500)})`);
    assert.equal(R.read2.iteration.status, 'alpha_ready', `iteration 2 alpha_ready (${show(R.read2.iteration).slice(0, 600)})`);
    const phase2 = plansOf(fx.home, p).filter((x) => x.phase_number === 2 && x.status === 'completed');
    assert.equal(phase2.length, 1, 'phase 2 complete');
    const c3 = candidatesOf(fx.home, p).at(-1);
    assert.equal(J(phase2[0].completion_binding)?.candidate, c3.id, 'bound to candidate 3');
    void revisionOf;
  });

  test('the out-of-brief deployment to demo stops for the owner before dispatch: 409 confirm_required naming deployment_target_approval; no authorization, intent, deploy work or adapter call for demo across a tick and a restart', () => {
    assert.equal(R.errors.demo, undefined, `the demo step ran (${R.errors.demo?.message?.slice(0, 1200)})`);
    assert.equal(R.demoRequest.status, 409, `the request asks first (→ ${R.demoRequest.status} ${show(R.demoRequest.body).slice(0, 600)})`);
    assert.equal(R.demoRequest.body?.code, 'confirm_required', 'confirm_required');
    const d = R.demoDecisions();
    assert.equal(d.length, 1, `one deployment_target_approval (${show(d)})`);
    assert.ok(JSON.stringify(R.demoRequest.body).includes(d[0].id), 'the answer names the decision');
    for (const at of ['request', 'tick', 'restart']) assert.ok(nothingDispatched(R.demoAt[at]), `nothing dispatched for demo at the ${at} (${show(R.demoAt[at])})`);
    assert.equal(R.demoOpenAfterRestart.length, 1, 'the decision still open after the restart');
  });
});
