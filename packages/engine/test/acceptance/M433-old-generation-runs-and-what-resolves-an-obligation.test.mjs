// M433 (f), (g), and the 31b review's M2 carried here (slice 36; kernel
// lane). M5 plan §3.6 M433; D6-C05; D6 §4.5 ("old-generation work provides
// no current acceptance"; "what resolves an obligation"), §4.6; B05; A.3
// (`check_obligations.resolved_by →protected_versions | assessments`), A.4
// (`EVIDENCE_GENERATION_STALE`); SEAM.md §§421, 422, 423; the driver's
// rulings Q6, Q7, Q12, Q13 (2026-10-13).
//
// (f) The change rewords R2.1 and R2.2 (accept-r2, integration listed). At
//     its approval one execution of a listed check on stage 2's candidate is
//     queued, one running, one collecting (its result callback arrives
//     after); each then finishes passed: each result carries the old
//     generation, decides nothing at the stage gate
//     (`EVIDENCE_GENERATION_STALE` naming its check), clears no obligation,
//     and the gate does not turn green.
// (g) A rediscovery (a protected change that leaves the checks alone) clears
//     nothing; a pass under the new generation without a resolution leaves
//     the gate incomplete naming the check; the Verifier's correction of
//     accept-r2 applied resolves its obligation (`resolved_by` the protected
//     version) and its assessment that integration applies unchanged
//     (`spec_applicability` †) resolves integration's (`resolved_by` the
//     assessment); fresh passes under the new generation then decide.
// M2 (31b review), A: an obligation whose criterion a later change withdraws
//     is resolved by the later change's correction removing the check,
//     whichever request recorded it; no gate names it afterwards.
// M2 (31b review), B (Q13): a correction item that ends with nothing applied
//     and no assessment takes its repair and parks with a blocker naming
//     the open obligation (`retry`, `cancel`), never completes; the owner's
//     rejection of its proposal does the same; the obligation stays
//     unresolved and named by the gate.
// (h) S3 (E172 item 7; E173 item 4; Sean's ruling of 2026-10-20, option B;
//     SEAM.md §557): once B's parked correction is cancelled, the owner's
//     command `surety spec correct --project P --request R` (route
//     `POST …/spec/change-requests/R/correct`) registers the correction
//     again at its next generation, with the same request, criteria and
//     checks; landed, it resolves the obligation and the gate no longer
//     names it. Refused 409 `correction_pending` while a correction of R is
//     live, 409 `nothing_owed` once R owes nothing, 404 for an unknown
//     request or project. The owner is told: the blocker's question and its
//     `cancel` option name the command, and `GET …/spec` lists R's open
//     obligations with a `next_action` naming it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, answer, decision, decisionsOn } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { newId } from './harness/ids.mjs';
import { drive, entryOf, operatorRequest, recordExit } from './harness/checks/selection.mjs';
import { executionRow } from './harness/checks/fixtures.mjs';
import { effectiveVersion, evaluate } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { addWork } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { ROUTED_KINDS, authoringReady, candidatesOfProject, checkRows, obligationsOf, planOfPhase, projectRow, queuedExecutions, specRevisions, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { journey35 } from './harness/journey/plan35.mjs';
import { CORRECTED_SERVICE_TEST, REQUIREMENTS, authoringFiles, specText } from './harness/journey/reference.mjs';
import { SPEC_CHANGES, changeScript, pumpHolding, surety, untilProposedOrFailed } from './harness/journey/change36.mjs';

const LISTED = ['accept-r2', 'integration'];
const SUM_TEST = '.surety/checks/tests/sum.test.mjs';
// The routed decisions the owner answers in these cases; spec_change is answered by the case itself.
const OWNER_KINDS = ROUTED_KINDS.filter((k) => k !== 'spec_change');
const active = (x) => x.active === 1 || x.active === true;
const one = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).get(...params));
const resultOfExecution = (home, id) => one(home, 'SELECT * FROM "check_results" WHERE "execution" = ?', id);
// The spec-evidence generation a result carries (A.3 `check_results.generation`),
// or, as the engine records it, its execution's (SEAM §375).
const generationOf = (home, result) => result.generation ?? executionRow(home, result.execution)?.spec_generation ?? null;
const keyIds = (home, project, key) => checkRows(home, project).filter((c) => c.key === key).map((c) => c.id);
const reasonSubjects = (evaluation, code) => evaluation.reasons.filter((r) => r.code === code).flatMap((r) => r.subjects ?? []);
// A subject names a check when it is the check's id, its key, or `check:<key>`;
// never by substring (`kind:integration` names a kind, objection 088).
const names = (subjects, ids, key) => subjects.some((s) => ids.includes(s) || s === key || s === `check:${key}`);
const R2_1_ONLY = specText({
  version: 2,
  requirements: REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, criteria: [{ id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with content type application/json and the JSON body {"sum": 5}.' }, r.criteria[1]] } : r)),
  changeLog: [{ version: 2, date: '2026-10-13', change: 'R2.1 names the content type', by: 'Sean' }],
});

// The owner approves the change, and approves it again whenever it is asked
// again (objection 119; SEAM §§420, 464, 468): phase 1's listed stage work and
// checks still move after the proposal, and under K1 their results land
// between the answer and the effect, so the approval's intent is invalidated
// (`EFFECT_PRECONDITION_CHANGED`) and the next generation is raised; or the
// decision is already stale when the first answer arrives (409). The pump
// after it answers each re-raised `spec_change` generation as the owner.
async function approveAsAsked(fx, ctx, id) {
  const res = await answer(fx.engine, ctx.project, decision(fx.home, id), 'approve');
  if (res.status !== 200) assertRefused(res, 409, [CODES.stale, CODES.invalidated], 'the owner\'s first approval, asked again before it arrived');
}

async function proposeAndApprove(fx, ctx, spec, changes, version, { beforeAnswer } = {}) {
  fx.scripted.kindScript('spec_change', changeScript(spec, changes));
  const res = await fx.engine.post(`/v1/projects/${ctx.project}/spec/change-requests`, { text: 'The owner\'s change.' });
  assert.equal(res.status, 201, `POST …/spec/change-requests (→ ${res.status} ${res.text})`);
  const out = await untilProposedOrFailed(fx, ctx, res.body.request.id, ctx.holdOpts);
  assert.ok(out.decision, `the change is proposed (${out.request.status} ${out.request.failure ?? ''})`);
  if (beforeAnswer) await beforeAnswer();
  await approveAsAsked(fx, ctx, out.decision.id);
  await pumpHolding(fx, ctx, () => specRevisions(fx.home, ctx.project).find((r) => r.version === version), { what: `version ${version}`, max: 40, ...ctx.holdOpts, answerKinds: [...(ctx.holdOpts?.answerKinds ?? []), 'spec_change'] });
  return out.request;
}

// Stage 2's candidate with the nomination's accept-r2 and integration queued, held.
async function stage2Candidate(fx, ctx) {
  return pumpHolding(fx, ctx, () => {
    const c = candidatesOfProject(fx.home, ctx.project).at(-1);
    const queued = queuedExecutions(fx.home, ctx.project).filter((x) => x.candidate === c?.id && LISTED.includes(x.key));
    return queued.length === 2 ? { candidate: c, ex: Object.fromEntries(queued.map((x) => [x.key, x.id])) } : undefined;
  }, { what: 'stage 2\'s candidate with accept-r2 and integration queued', max: 300, ...ctx.holdOpts });
}

// (h)'s start: B's fixture with no repair, so the request's correction parks
// at its first launch (nothing applied, no assessment) with its blocker open.
// The second check_correction launch, the one the owner's command registers,
// corrects accept-r2's test and proposes it; every launch is scripted.
async function parkedCorrection(t) {
  const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
  ctx.holdOpts = {};
  fx.scripted.kindScript('check_correction', [
    roleThat([], {}),
    roleThat([step.write('.surety/checks/tests/service.test.mjs', CORRECTED_SERVICE_TEST)], { proposal: { rationale: 'R2.1 names the content type; accept-r2 reads it.', requested_change_kind: 'tightening' } }),
  ]);
  await authoringReady(fx, ctx, 1);
  const request = await proposeAndApprove(fx, ctx, R2_1_ONLY, [{ key: 'R2', kind: 'criteria_changed', reason: 'R2.1 content type' }], 2);
  const corrections = () => workOf(fx.home, p.id, 'check_correction').filter((w) => w.trigger_source === 'spec_obligation' && w.trigger_id === request.id);
  const blocker = await pumpHolding(fx, ctx, () => {
    const w = corrections().at(-1);
    return w?.status === 'parked' ? decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open') : undefined;
  }, { what: 'the request\'s correction parked with its blocker open', max: 60, answerKinds: ['spec_change'] });
  const [first] = corrections();
  assert.equal(corrections().length, 1, 'the fixture is live: one correction of the request, parked');
  const open = () => obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed' && o.request === request.id && o.resolved_at === null).map((o) => o.key);
  assert.deepEqual(open(), ['accept-r2'], 'the fixture is live: the request owes accept-r2');
  const command = `surety spec correct --project ${p.id} --request ${request.id}`;
  const route = `/v1/projects/${p.id}/spec/change-requests/${request.id}/correct`;
  const stage2Gate = async () => {
    const candidate = candidatesOfProject(fx.home, p.id).at(-1);
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    const stage2 = stagesOfPlan(fx.home, plan1.id).find((s) => s.number === 2);
    return { candidate, evaluation: await evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage2.id }, { inventory: false }) };
  };
  const owesAccept = (evaluation) => names(reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE'), keyIds(fx.home, p.id, 'accept-r2'), 'accept-r2');
  return { fx, p, ctx, request, first, blocker, corrections, open, command, route, stage2Gate, owesAccept };
}

describe('M433 (f), (g): old-generation runs, and what resolves an obligation; the 31b review\'s M2', () => {
  test('(f) queued, running and late runs finish passed under the old generation and decide nothing; (g) rediscovery and evidence alone clear nothing; the correction and the assessment resolve; fresh evidence decides', async (t) => {
    // `repair_attempts_max` 0: the request's correction fails once and parks, so
    // it is captured only after the rediscovery, when the owner retries it.
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    ctx.holdOpts = { hold: (x) => LISTED.includes(x.key), answerKinds: OWNER_KINDS };
    // A check_correction launch with no script of its own fails (the request's, launched early, parks).
    fx.scripted.kindScript('check_correction', script.crash());
    const { candidate, ex } = await stage2Candidate(fx, ctx);
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    const stage2 = stagesOfPlan(fx.home, plan1.id).find((s) => s.number === 2);
    const [late] = Object.values(await operatorRequest(fx.engine, p.id, candidate.id, ['accept-r2']));
    await drive(fx.engine, ex.integration, ['materializing', 'running']);
    await drive(fx.engine, late, ['materializing', 'running', 'collecting']);
    const old = projectRow(fx.home, p.id).spec_evidence_generation;
    // The rediscovery to come (objection 087): a Verifier's correction of
    // another check's test (accept-r1's), registered while the change is
    // proposed. Q2 (objection 106): no protected writer but the request's own
    // correction is dispatched while a change is proposed or approved and
    // unapplied, so it is held then, and runs (held at its gate) once the
    // change has applied, landing under the new generation.
    let rediscovery = null;
    const request = await proposeAndApprove(fx, ctx, SPEC_CHANGES.r2Both, [{ key: 'R2', kind: 'criteria_changed', reason: 'content type' }], 2, {
      beforeAnswer: async () => {
        rediscovery = await addWork(fx.engine, p.id, 'check_correction', { subject: {} });
        fx.scripted.script(rediscovery, [
          {
            steps: [
              step.write(SUM_TEST, `${authoringFiles(1)[SUM_TEST]}// accept-r1 reads R1.1 as before.\n`),
              step.hold('gate', { heartbeat_ms: 250 }),
              step.result({ status: 'completed', summary: 'accept-r1\'s test restated', proposal: { rationale: 'accept-r1\'s test is restated; R1.1 is unchanged.', requested_change_kind: 'tightening' } }),
            ],
          },
        ]);
        await pumpHolding(fx, ctx, () => false, { max: 3, ...ctx.holdOpts }).catch(() => null);
        assert.deepEqual(fx.scripted.launches({ work_item: rediscovery }), [], 'Q2: the other correction is not dispatched while the change is proposed');
      },
    });
    await pumpHolding(fx, ctx, () => {
      const launch = fx.scripted.launches({ work_item: rediscovery }).at(-1);
      return launch && fx.scripted.eventsOf(launch.pid, 'holding').length > 0;
    }, { what: 'the other correction holding once the change has applied', max: 40, ...ctx.holdOpts });
    const gen = projectRow(fx.home, p.id).spec_evidence_generation;
    assert.equal(gen, old + 1, 'the fixture is live: the generation advanced');
    // The request's correction: its first launch fails (it parks); retried, it
    // corrects accept-r2 and assesses integration.
    const correction = workOf(fx.home, p.id, 'check_correction').find((w) => JSON.stringify(w.subject ?? {}).includes(request.id));
    assert.ok(correction, 'the fixture is live: the request\'s check_correction registered');
    fx.scripted.script(correction.id, [
      script.crash(),
      roleThat([step.write('.surety/checks/tests/service.test.mjs', CORRECTED_SERVICE_TEST)], {
        proposal: { rationale: 'R2.1 and R2.2 now name the content type; accept-r2 reads it.', requested_change_kind: 'tightening' },
        spec_applicability: [{ check: 'integration', criteria: ['R2.2'], rationale: 'integration asserts the refusal\'s status alone, which the reworded R2.2 leaves unchanged.' }],
      }),
    ]);
    // (f) each finishes passed after the approval.
    await recordExit(fx.engine, ex['accept-r2'], 0).catch((err) => assert.fail(`the execution queued at approval runs and records its result (D6 §4.5): ${err.message}`));
    await drive(fx.engine, ex.integration, ['collecting', 'recorded'], { exit_status: 0 });
    await drive(fx.engine, late, ['recorded'], { exit_status: 0 });
    const olds = { 'accept-r2 (queued)': ex['accept-r2'], 'integration (running)': ex.integration, 'accept-r2 (late callback)': late };
    for (const [what, id] of Object.entries(olds)) {
      const r = resultOfExecution(fx.home, id);
      assert.ok(r, `${what}: its result is recorded as history`);
      assert.equal(r.exit_status, 0, `${what}: passed`);
      assert.equal(generationOf(fx.home, r), old, `${what}: under the generation it was registered under`);
    }
    const open = () => obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed' && o.resolved_at === null).map((o) => o.key).sort();
    assert.deepEqual(open(), LISTED, 'no obligation cleared by them');
    const ids = { 'accept-r2': keyIds(fx.home, p.id, 'accept-r2'), integration: keyIds(fx.home, p.id, 'integration') };
    const gate = () => evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage2.id }, { inventory: false });
    let evaluation = await gate();
    assert.notEqual(evaluation.outcome, 'satisfied', 'the stage gate is not satisfied by old-generation passes');
    const stale = reasonSubjects(evaluation, 'EVIDENCE_GENERATION_STALE');
    for (const key of LISTED) assert.ok(names(stale, ids[key], key), `EVIDENCE_GENERATION_STALE names ${key} (${JSON.stringify(evaluation.reasons)})`);
    const effective = effectiveVersion(fx.home, p.id);
    for (const key of LISTED) {
      const id = ids[key].find((x) => checkRows(fx.home, p.id).find((c) => c.id === x)?.protected_version === effective.id) ?? ids[key].at(-1);
      const deciding = entryOf(evaluation, id).deciding?.result ?? null;
      assert.ok(!Object.values(olds).some((x) => resultOfExecution(fx.home, x)?.id === deciding), `no old-generation result decides ${key} (${deciding})`);
    }
    await pumpHolding(fx, ctx, () => false, { max: 3, ...ctx.holdOpts }).catch(() => null);
    evaluation = await gate();
    assert.notEqual(evaluation.outcome, 'satisfied', 'the green does not return after further ticks');

    // (g) a rediscovery clears nothing: the other correction released, approved and applied.
    fx.scripted.release(rediscovery, 'gate');
    await pumpHolding(fx, ctx, () => effectiveVersion(fx.home, p.id).id !== effective.id && effectiveVersion(fx.home, p.id), { what: 'the new protected version from the other correction', max: 40, ...ctx.holdOpts });
    assert.deepEqual(open(), LISTED, 'a rediscovery of the unchanged criterion IDs clears nothing');
    // A pass under the new generation, without a resolution: still incomplete.
    const [fresh] = Object.values(await operatorRequest(fx.engine, p.id, candidate.id, ['accept-r2']));
    await recordExit(fx.engine, fresh, 0);
    assert.equal(generationOf(fx.home, resultOfExecution(fx.home, fresh)), gen, 'the fixture is live: a pass of the new generation');
    evaluation = await gate();
    // The rediscovery's version has its own check rows: the ids read again.
    assert.ok(names(reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE'), keyIds(fx.home, p.id, 'accept-r2'), 'accept-r2'), `evidence under the new generation alone leaves ACCEPTANCE_SCOPE_INCOMPLETE naming accept-r2 (${JSON.stringify(evaluation.reasons)})`);
    // The correction and the assessment: the parked correction retried by the owner.
    const parked = await pumpHolding(fx, ctx, () => {
      const w = workOf(fx.home, p.id, 'check_correction').find((x) => x.id === correction.id);
      return w?.status === 'parked' ? decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open') : undefined;
    }, { what: 'the request\'s correction parked after its failed launch', max: 20, ...ctx.holdOpts });
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, parked.id), 'retry')).status, 200, 'the owner retries it');
    await pumpHolding(fx, ctx, () => withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "runs" WHERE "work_item" = ? AND "state" = 'ended'`).get(correction.id)).n >= 2, { what: 'the retried correction to end', max: 20, ...ctx.holdOpts });
    const run = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "runs" WHERE "work_item" = ? AND "state" = 'ended' ORDER BY "seq" DESC`).get(correction.id));
    assert.deepEqual([run.outcome, run.reason_class], ['completed', 'none'], `the correction with its spec_applicability assessment is accepted (Q6) (${run.reason_text})`);
    await pumpHolding(fx, ctx, () => open().length === 0, { what: 'both obligations resolved', max: 40, answerKinds: ROUTED_KINDS, ...ctx.holdOpts }).catch(() => null);
    const byKey = Object.fromEntries(obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed').map((o) => [o.key, o]));
    const applied = effectiveVersion(fx.home, p.id);
    const proposals = withStore(fx.home, (db) => db.prepare('SELECT p."id", p."status" FROM "protected_proposals" p JOIN "runs" r ON r."id" = p."run" WHERE r."work_item" = ?').all(correction.id));
    assert.ok(byKey['accept-r2'].resolved_at, `accept-r2's obligation resolved by the correction naming its criteria (its proposals ${JSON.stringify(proposals)})`);
    assert.equal(byKey['accept-r2'].resolved_by, applied.id, `resolved_by the applied protected version (A.3; Q7), not ${byKey['accept-r2'].resolved_by}`);
    assert.ok(byKey.integration.resolved_at, 'integration\'s resolved by the Verifier\'s recorded assessment');
    assert.ok(byKey.integration.resolved_by && byKey.integration.resolved_by !== applied.id, `resolved_by the assessment (${byKey.integration.resolved_by})`);
    // Fresh deciding evidence under the current generation decides.
    const keys = LISTED.filter((k) => !queuedExecutions(fx.home, p.id).some((x) => x.candidate === candidate.id && x.key === k));
    if (keys.length > 0) await operatorRequest(fx.engine, p.id, candidate.id, keys);
    for (const x of queuedExecutions(fx.home, p.id).filter((q) => q.candidate === candidate.id && LISTED.includes(q.key))) await recordExit(fx.engine, x.id, 0);
    evaluation = await gate();
    for (const key of LISTED) {
      const allIds = keyIds(fx.home, p.id, key);
      assert.ok(!names(reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE'), allIds, key), `${key} no longer incomplete (${JSON.stringify(evaluation.reasons)})`);
      assert.ok(!names(reasonSubjects(evaluation, 'EVIDENCE_GENERATION_STALE'), allIds, key), `${key} decided by current evidence`);
    }
  });

  test('M2 (31b review), A: an obligation whose criterion a later change withdraws is resolved by the later change\'s correction removing the check', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 0 } });
    ctx.holdOpts = { answerKinds: OWNER_KINDS };
    // The first correction lands nothing; the second removes the checks.
    fx.scripted.kindScript('check_correction', [
      roleThat([], {}),
      roleThat(
        ['.surety/checks/defs/accept-r2.json', '.surety/checks/defs/integration.json', '.surety/checks/tests/service.test.mjs', '.surety/checks/tests/integration.test.mjs'].map((path) => step.delete(path)),
        { proposal: { rationale: 'R2 is withdrawn: its checks go.', requested_change_kind: 'loosening' } },
      ),
    ]);
    fx.scripted.kindScript('replan', script.crash());
    await authoringReady(fx, ctx, 1);
    await proposeAndApprove(fx, ctx, R2_1_ONLY, [{ key: 'R2', kind: 'criteria_changed', reason: 'R2.1 content type' }], 2);
    const first = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed');
    assert.deepEqual(first.map((o) => o.key), ['accept-r2'], 'the fixture is live: one obligation, accept-r2\'s, from the first change');
    await pumpHolding(fx, ctx, () => withStore(fx.home, (db) => db.prepare(`SELECT 1 FROM "runs" r JOIN "work_items" w ON w."id" = r."work_item" WHERE w."project" = ? AND w."kind" = 'check_correction' AND r."state" = 'ended'`).get(p.id)), { what: 'the first correction run ended', max: 20, ...ctx.holdOpts });
    const withoutR2 = specText({ version: 3, requirements: REQUIREMENTS.filter((r) => r.key !== 'R2'), changeLog: [{ version: 2, date: '2026-10-13', change: 'R2.1 names the content type', by: 'Sean' }, { version: 3, date: '2026-10-13', change: 'R2 withdrawn', by: 'Sean' }] });
    await proposeAndApprove(fx, ctx, withoutR2, [{ key: 'R2', kind: 'withdrawn', reason: 'R2 withdrawn' }], 3);
    const before = effectiveVersion(fx.home, p.id);
    await pumpHolding(fx, ctx, () => effectiveVersion(fx.home, p.id).id !== before.id && workOf(fx.home, p.id, 'check_correction').length === 2 && workOf(fx.home, p.id, 'check_correction')[1].status === 'complete', { what: 'the second correction applied', max: 60, ...ctx.holdOpts });
    const unresolved = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed' && o.resolved_at === null);
    assert.deepEqual(unresolved.map((o) => [o.key, o.generation]), [], `every obligation on the removed checks resolved, the first change's included (${JSON.stringify(unresolved)})`);
    const candidate = candidatesOfProject(fx.home, p.id).at(-1);
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    for (const s of stagesOfPlan(fx.home, plan1.id)) {
      const evaluation = await evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: s.id }, { inventory: false });
      for (const key of LISTED) assert.ok(!names(reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE'), keyIds(fx.home, p.id, key), key), `stage ${s.number}'s gate names no removed check ${key} (${JSON.stringify(evaluation.reasons)})`);
    }
  });

  test('M2 (31b review), B (Q13): a correction that ends with nothing applied and no assessment parks with a blocker naming the obligation; so does a rejected proposal; never complete', async (t) => {
    const { fx, p, ctx } = await journey35(t, { policy: { repair_attempts_max: 1 } });
    ctx.holdOpts = {};
    fx.scripted.kindScript('check_correction', [
      roleThat([], {}),
      roleThat([], {}),
      roleThat([step.write('.surety/checks/tests/service.test.mjs', CORRECTED_SERVICE_TEST)], { proposal: { rationale: 'R2.1 names the content type.', requested_change_kind: 'tightening' } }),
    ]);
    await authoringReady(fx, ctx, 1);
    await proposeAndApprove(fx, ctx, R2_1_ONLY, [{ key: 'R2', kind: 'criteria_changed', reason: 'R2.1 content type' }], 2);
    const item = () => workOf(fx.home, p.id, 'check_correction').at(-1);
    const parkedWithBlocker = async (what) => {
      const blocker = await pumpHolding(fx, ctx, () => {
        const w = item();
        if (w?.status === 'complete') return { completed: w };
        return w?.status === 'parked' ? decisionsOn(fx.home, 'blocker', w.id).find((d) => d.status === 'open') : undefined;
      }, { what: `${what}: the correction parked or complete`, max: 60, answerKinds: ['spec_change'] });
      assert.ok(!blocker.completed, `${what}: the correction item never completes with its obligation open (Q13); it is ${blocker.completed?.status}`);
      const keys = blocker.options.map((o) => o.key);
      for (const k of ['retry', 'cancel']) assert.ok(keys.includes(k), `${what}: the blocker offers ${k} (${JSON.stringify(keys)})`);
      assert.ok(JSON.stringify([blocker.question, blocker.blocker, item().blocker]).includes('accept-r2'), `${what}: the blocker names the open obligation's check (${blocker.question})`);
      const open = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed' && o.resolved_at === null).map((o) => o.key);
      assert.deepEqual(open, ['accept-r2'], `${what}: the obligation stays unresolved`);
      return blocker;
    };
    const runs = () => withStore(fx.home, (db) => db.prepare('SELECT * FROM "runs" WHERE "work_item" = ? ORDER BY "seq"').all(item().id));
    const first = await parkedWithBlocker('nothing applied, no assessment');
    assert.equal(runs().length, 2, 'it took its one repair before parking');
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, first.id), 'retry')).status, 200, 'the owner answers retry');
    // The retried run proposes; the owner rejects the proposal.
    const raised = await pumpHolding(fx, ctx, () => withStore(fx.home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "project" = ? AND "kind" LIKE 'check_correction_%' AND "status" = 'open'`).get(p.id)), { what: 'the proposal raised to the owner', max: 40 });
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, raised.id), 'reject')).status, 200, 'the owner rejects it');
    await parkedWithBlocker('the proposal rejected');
    const candidate = candidatesOfProject(fx.home, p.id).at(-1);
    const plan1 = planOfPhase(fx.home, p.id, 1).find(active);
    const stage2 = stagesOfPlan(fx.home, plan1.id).find((s) => s.number === 2);
    const evaluation = await evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage2.id }, { inventory: false });
    assert.ok(names(reasonSubjects(evaluation, 'ACCEPTANCE_SCOPE_INCOMPLETE'), keyIds(fx.home, p.id, 'accept-r2'), 'accept-r2'), `the gate names the obligation's check (${JSON.stringify(evaluation.reasons)})`);
  });

  test('(h) S3, the owner\'s command: after the cancel, `surety spec correct` registers the correction again with the same request, criteria and checks; landed, it resolves the obligation and the gate no longer names it; refused 409 correction_pending, 409 nothing_owed, 404', async (t) => {
    const { fx, p, ctx, request, first, blocker, corrections, open, route, stage2Gate, owesAccept } = await parkedCorrection(t);
    // While its correction is parked (live, not cancelled), the command is refused.
    let res = await fx.engine.post(route, {});
    assertRefused(res, 409, 'correction_pending', `S3: POST …/spec/change-requests/${request.id}/correct while the request's correction is parked (not cancelled)`);
    assert.equal(corrections().length, 1, 'the refusal registers nothing');
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, blocker.id), 'cancel')).status, 200, 'the owner answers cancel');
    // The dead end S3 names: nothing registers another correction by itself.
    await pumpHolding(fx, ctx, () => false, { max: 3 }).catch(() => null);
    assert.deepEqual(corrections().map((w) => [w.id, w.status]), [[first.id, 'cancelled']], 'the fixture is live: the cancelled correction, and no other');
    assert.deepEqual(open(), ['accept-r2'], 'the fixture is live: the obligation stays open after the cancel');
    assert.ok(owesAccept((await stage2Gate()).evaluation), 'the fixture is live: the gate names accept-r2 (ACCEPTANCE_SCOPE_INCOMPLETE)');
    // Unknown request, unknown project: 404, nothing registered.
    assertRefused(await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests/${newId('scr_')}/correct`, {}), 404, 'not_found', 'an unknown request');
    assertRefused(await fx.engine.post(`/v1/projects/${newId(`${p.id.split('_')[0]}_`)}/spec/change-requests/${request.id}/correct`, {}), 404, 'not_found', 'an unknown project');
    assert.equal(corrections().length, 1, 'the 404s register nothing');
    // The owner's command, by the CLI.
    const out = surety(fx, ['spec', 'correct', '--project', p.id, '--request', request.id]);
    assert.equal(out.status, 0, `S3: surety spec correct --project P --request R exits 0 (stdout ${out.stdout.slice(0, 600)}; stderr ${out.stderr.slice(0, 600)})`);
    assert.equal(out.stdout.trim().split('\n').length, 1, 'one line of JSON on standard output');
    const again = corrections();
    assert.equal(again.length, 2, 'one correction registered again');
    const fresh = again[1];
    assert.equal(out.body?.work_item?.id, fresh.id, `the answer names the registered work item (${out.stdout.slice(0, 400)})`);
    assert.deepEqual(
      [fresh.kind, fresh.trigger_source, fresh.trigger_id, fresh.trigger_generation, fresh.subject?.request],
      ['check_correction', 'spec_obligation', request.id, first.trigger_generation + 1, request.id],
      'a check_correction from (spec_obligation, R) at the next generation, about the same request',
    );
    const ev = (w) => JSON.parse(w.trigger_evidence ?? '{}');
    assert.deepEqual([ev(fresh).criteria, ev(fresh).checks], [ev(first).criteria, ev(first).checks], 'with the same criteria and checks');
    // Asked again while the fresh one is live: refused, nothing more.
    res = await fx.engine.post(route, {});
    assertRefused(res, 409, 'correction_pending', 'the command again while the correction it registered is pending');
    assert.equal(corrections().length, 2, 'no third correction');
    // It lands: its proposal approved by the owner, the obligation resolved.
    await pumpHolding(fx, ctx, () => open().length === 0 && corrections()[1].status === 'complete', { what: 'the registered correction applied and the obligation resolved', max: 60, answerKinds: ROUTED_KINDS });
    const resolved = obligationsOf(fx.home, p.id).find((o) => o.reason === 'spec_changed' && o.request === request.id && o.key === 'accept-r2');
    assert.equal(resolved.resolved_by, effectiveVersion(fx.home, p.id).id, 'resolved_by the protected version the registered correction applied');
    // Fresh evidence under the current generation: the gate no longer names accept-r2.
    const { candidate } = await stage2Gate();
    if (!queuedExecutions(fx.home, p.id).some((x) => x.candidate === candidate.id && x.key === 'accept-r2')) await operatorRequest(fx.engine, p.id, candidate.id, ['accept-r2']);
    for (const x of queuedExecutions(fx.home, p.id).filter((q) => q.candidate === candidate.id && q.key === 'accept-r2')) await recordExit(fx.engine, x.id, 0);
    const { evaluation } = await stage2Gate();
    assert.ok(!owesAccept(evaluation), `ACCEPTANCE_SCOPE_INCOMPLETE no longer names accept-r2 (${JSON.stringify(evaluation.reasons)})`);
    // R owes nothing now: refused, by the route and by the CLI.
    res = await fx.engine.post(route, {});
    assertRefused(res, 409, 'nothing_owed', 'the command once the request has no open obligation');
    const late = surety(fx, ['spec', 'correct', '--project', p.id, '--request', request.id]);
    assert.equal(late.status, 1, `the CLI exits 1 on a refusal (${late.stderr.slice(0, 400)})`);
    assert.match(late.stderr, /^409 .*nothing_owed/, 'printing the status and the refusal on standard error');
    assert.equal(corrections().length, 2, 'nothing registered by the refusals');
  });

  test('(h) S3, the owner is told: the parked correction\'s question and its cancel option name `surety spec correct`; after the cancel, GET …/spec lists the request\'s open obligation with a next_action naming it', async (t) => {
    const { fx, p, ctx, request, blocker, corrections, command } = await parkedCorrection(t);
    assert.ok(blocker.question.includes(command), `S3: the blocker's question (the obligation's text) names ${command} (${blocker.question})`);
    const cancel = blocker.options.find((o) => o.key === 'cancel');
    assert.ok(cancel?.consequence_text?.includes(command), `S3: the cancel option's consequence_text names ${command} (${JSON.stringify(cancel)})`);
    assert.equal((await answer(fx.engine, p.id, decision(fx.home, blocker.id), 'cancel')).status, 200, 'the owner answers cancel');
    await pumpHolding(fx, ctx, () => false, { max: 2 }).catch(() => null);
    assert.equal(corrections().at(-1).status, 'cancelled', 'the fixture is live: the correction cancelled');
    const res = await fx.engine.get(`/v1/projects/${p.id}/spec`);
    assert.equal(res.status, 200, `GET …/spec (${res.text})`);
    const entry = (res.body.change_requests ?? []).find((c) => c.id === request.id);
    assert.ok(entry, `S3: GET …/spec change_requests lists the request with an open obligation (${JSON.stringify(res.body.change_requests)})`);
    assert.deepEqual((entry.open_obligations ?? []).map((o) => o.key), ['accept-r2'], `its open obligations (${JSON.stringify(entry)})`);
    assert.ok(JSON.stringify(entry.next_action ?? null).includes(command), `its next_action names ${command} (${JSON.stringify(entry.next_action)})`);
  });
});
