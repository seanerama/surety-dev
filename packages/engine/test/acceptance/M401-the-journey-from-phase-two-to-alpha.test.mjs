// M401, the journey from an idea to Alpha on the scripted backend, part 2 of
// 2: from phase 2 published to `alpha_deployed` on a real unit (slice 31b;
// project lane, run with `npm test` like the sandbox lane, E92 item 2 (1)).
// M5 plan §3.1 M401 (h) to (l); D6-J01; D6 §1 steps 10 to 12; E40; BS5 §3,
// §4.1 rules 12, 13, 20; SEAM.md §§350 to 357. Part 1 is
// `M401-the-journey-from-an-idea-to-phase-two`, which pins (a) to (g).
//
// The seed (§357): the same reference project, in this file's own home,
// carried to where part 1 ends (phase 1 complete, phase 2 published by the
// replan) on the kernel lane's production path: the same sessions, answers,
// roles, transitions and finalizers, with the kernel lane's scripted check
// boundary recording the checks' exits. Nothing is installed by fixture: no
// plan, candidate, phase check, readiness or authorization (rule 20). The
// home is then restarted on the project lane (the runner self-tested, the
// real adapter) and everything this file pins happens there: CR-1 between
// the phases, phase 2 in real `role` and `check` domains, the adapter
// qualified by `surety qualify-adapter` in the test's home, `alpha`
// configured by the owner after the last phase, the policy's request, the
// real `local_service` adapter in a transient user unit, the pace read and
// the teardown. Every clause about a check result is read over the results
// recorded after the switch.
//
// SAFETY (BS5 §4.1; E64; SEAM.md §§257, 356, 357). The only unit is the one
// the engine creates under this test's home's prefix; the test acts on no
// unit and signals nothing but its own engine (the verified kill). The
// service has no act and no secret. The environment is ended in `finally`
// (`endJourney`: the engine's own teardown, waited for); the file ends with
// `operatorGuard`; every project-lane start carries the real-adapter switch
// and the runner self-test.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { serviceOf, operatorGuard, unitShow } from './harness/deploy/host.mjs';
import { unitPrefix } from './harness/deploy/kernel.mjs';
import { evaluationsOf, scopeOf, sharedFixture } from './harness/gates.mjs';
import {
  correctionOrigin,
  alphaDeployed,
  authorizationsOfProject,
  candidatesOfProject,
  changeRequest,
  deploymentRequests,
  eventsAbout,
  evaluationsOfKind,
  executionsOf,
  obligationsOf,
  paceLeaves,
  phaseCompleted,
  planOfPhase,
  projectRow,
  readPace,
  requirementsOf,
  resultsOf,
  runsOfProject,
  signoffsOfProject,
  specRevisions,
  stageCandidateRuns,
  stagesOfPlan,
  workOf,
  humanActsOf,
} from './harness/journey/drive.mjs';
import { alphaByCommand, endJourney, journeyEngine, toPhaseTwoPublished, toProjectLane } from './harness/journey/project.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';

const operationsOf = (home, project, kind) => withStore(home, (db) => db.prepare('SELECT * FROM "operations" WHERE "project" = ? AND "kind" = ? ORDER BY "seq"').all(project, kind));
const domainRow = (home, id) => withStore(home, (db) => db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(id));
const qualificationRow = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "host_qualifications" WHERE "id" = ?').get(id));
  return row ? { ...row, check_runner: row.check_runner ? JSON.parse(row.check_runner) : null } : null;
};
// A result recorded by a self-tested runner: it names a host qualification
// whose check runner passed its own self-test, never the fixture (SEAM.md §§181, 190).
const selfTested = (home, r) => {
  if (!r.runner_qualification || r.runner_id === 'test_fixture') return false;
  const q = qualificationRow(home, r.runner_qualification);
  return Boolean(q?.check_runner && q.check_runner.test_fixture !== true && Array.isArray(q.check_runner.self_test) && q.check_runner.self_test.length > 0);
};
const after_ = (iso, at) => Date.parse(iso) > Date.parse(at);

describe('M401 the journey from an idea to Alpha, part 2: phase 2 published to alpha_deployed, on the project lane from a kernel-lane seed', () => {
  const shared = sharedFixture();
  let guard;
  let J;
  before(async () => {
    guard = operatorGuard();
    const fx = await journeyEngine(shared.context, guard, { lane: 'kernel' });
    J = { fx };
    try {
      // The seed: where part 1 ends, on the kernel lane's production path.
      const seed = await toPhaseTwoPublished(fx, { lane: 'kernel' });
      assert.ok(seed.phase1?.completed_at && seed.phase2Plan?.published_at, 'the seed reached phase 1 complete and phase 2 published');
      Object.assign(J, { p: seed.p, ctx: seed.ctx, seed });
      const { p, ctx } = seed;
      // The same home on the project lane from here on.
      J.switched = await toProjectLane(fx, ctx);
      // 11. CR-1 between the phases. 10. Phase 2.
      J.change = await changeRequest(fx, ctx);
      J.phase2 = await phaseCompleted(fx, ctx, 2, { max: 300 });
      // 12. Nothing requested while no environment exists; then the owner
      // qualifies the adapter by command and configures `alpha`.
      await tick(fx.engine, p.id, { rounds: 1, timeoutMs: 180_000 });
      J.beforeAlpha = { requests: deploymentRequests(fx.home, p.id), authorizations: authorizationsOfProject(fx.home, p.id) };
      const alpha = await alphaByCommand(fx, ctx);
      J.env = alpha.env;
      J.deployed = await alphaDeployed(fx, ctx, { max: 120 });
      const op = operationsOf(fx.home, p.id, 'deploy').at(-1);
      J.svc = op ? serviceOf(ctx, J.env, op) : null;
      J.unitShow = J.svc?.unit ? unitShow(J.svc.unit, ['LoadState', 'ActiveState', 'MainPID']) : null;
      // (j) a further tick creates no second request.
      await tick(fx.engine, p.id, { rounds: 1, timeoutMs: 180_000 });
      J.requestsAfterTick = deploymentRequests(fx.home, p.id);
      J.pace = await readPace(fx, p.id);
    } finally {
      if (J.env) J.afterTeardown = await endJourney(fx, J.p.id, J.env);
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(h) the spec change between the phases: version 2, spec_evidence_generation 2, the listed results invalidated spec_changed with obligations recorded, check_correction and replan done, every gate afterwards on version 2', () => {
    const { fx, p } = J;
    const [v1, v2] = specRevisions(fx.home, p.id);
    assert.ok(v2 && v2.supersedes === v1.id, 'version 2 supersedes 1');
    assert.equal(projectRow(fx.home, p.id).spec_evidence_generation, 2);
    // Objection 107 (the driver's ruling): under Q2 a protected proposal in the
    // engine's hands (phase 2's authoring, captured before CR-1) applies first,
    // so accept-r2's earlier results may already be invalidated
    // `protected_version_superseded` when CR-1 is approved. Either way every
    // accept-r2 result recorded before the approval is invalidated, by one of
    // the two, and none stays current evidence. Read in event order (seq).
    const approved = eventsAbout(fx.home, 'spec.change_approved', p.id).find((e) => e.payload?.version === 2);
    assert.ok(approved, 'CR-1 approved as version 2 (spec.change_approved)');
    const keyOf = new Map(withStore(fx.home, (db) => db.prepare('SELECT "id", "key" FROM "checks" WHERE "project" = ?').all(p.id)).map((c) => [c.id, c.key]));
    const recordedAt = new Map(eventsAbout(fx.home, 'check.result', p.id).map((e) => [e.subject.check_result, e.seq]));
    const acceptR2 = resultsOf(fx.home, p.id).filter((r) => keyOf.get(r.check) === 'accept-r2');
    assert.deepEqual(acceptR2.filter((r) => !recordedAt.has(r.id)).map((r) => r.id), [], 'every accept-r2 result has its check.result event');
    const touched = acceptR2.filter((r) => recordedAt.get(r.id) < approved.seq);
    assert.ok(touched.length > 0, 'the fixture is live: accept-r2 had results before CR-1\'s approval');
    const INVALIDATING = ['spec_changed', 'protected_version_superseded'];
    assert.deepEqual(touched.filter((r) => !INVALIDATING.includes(r.invalidated_reason)).map((r) => [r.id, r.invalidated_reason]), [], `accept-r2's results from before CR-1's approval all invalidated, spec_changed or protected_version_superseded (${JSON.stringify(touched.map((r) => [r.id, r.invalidated_reason]))})`);
    const obligations = obligationsOf(fx.home, p.id);
    assert.ok(obligations.some((o) => o.reason === 'spec_changed' && o.generation === 2 && (o.criteria ?? []).includes('R2.1')), `an obligation for the check covering R2.1 (${JSON.stringify(obligations)})`);
    // R4's statement sharpened (`text_changed`): its criterion's checks are listed too (D6 §4.4, B05; objection 070).
    assert.ok(obligations.some((o) => o.reason === 'spec_changed' && o.generation === 2 && (o.criteria ?? []).includes('R4.1')), `an obligation for the checks covering R4.1 (${JSON.stringify(obligations)})`);
    const correction = workOf(fx.home, p.id, 'check_correction');
    assert.ok(correction.some((w) => w.status === 'complete'), 'check_correction done');
    const replans = workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'spec_change');
    assert.ok(replans.some((w) => w.status === 'complete'), 'the replan the change registered is done');
    // The driver's ruling (2026-10-13; SEAM.md §375; D6 §4.5): a spec change
    // re-nominates nothing; the spec-evidence generation carries it. A candidate
    // nominated after v2's creation is on v2, and there may be none (phase 2's
    // stages can be nominated while CR-1 is still being applied).
    const since = v2.created_at;
    const later = candidatesOfProject(fx.home, p.id).filter((c) => after_(c.nominated_at, since));
    assert.deepEqual(later.filter((c) => c.spec_revision !== v2.id).map((c) => [c.id, c.nominated_at, c.spec_revision]), [], `every candidate nominated after v2's creation (${since}) is on version 2 (${later.length} such candidates)`);
    // "Every gate afterwards on version 2", read through the evidence (D6 §4.5,
    // B05): the change invalidates the results it listed and records an
    // obligation, at generation 2, on each listed check; a result of an earlier
    // generation than an obligation on its check satisfies no gate, and a result
    // of a check the change did not list stays evidence. So each evaluation
    // after v2's creation decides from no result invalidated `spec_changed`, and
    // for a check with a generation-2 obligation only from a generation-2
    // result (generation cross-checked in the store).
    const gates = withStore(fx.home, (db) => db.prepare('SELECT "id", "candidate", "gate_kind", "created_at", "checks" FROM "gate_evaluations" WHERE "project" = ?').all(p.id)).filter((g) => after_(g.created_at, since));
    assert.ok(gates.length > 0, `gates were evaluated after v2's creation (${since})`);
    // The result's spec-evidence generation (D6 A.3 names `check_results.generation`; the engine as built records it on the
    // result's execution, `check_executions.spec_generation`; read from whichever the store has, SEAM.md §375).
    const resultRow = (id) =>
      withStore(fx.home, (db) => {
        const cols = db.prepare('PRAGMA table_info("check_results")').all().map((c) => c.name);
        const own = cols.includes('generation') ? 'r."generation"' : 'NULL';
        return db.prepare(`SELECT r."id", COALESCE(${own}, x."spec_generation") AS "generation", r."invalidated_reason" FROM "check_results" r LEFT JOIN "check_executions" x ON x."id" = r."execution" WHERE r."id" = ?`).get(id);
      });
    const obligedKeys = new Set(obligations.filter((o) => o.reason === 'spec_changed' && o.generation === 2).map((o) => o.key));
    assert.ok(obligedKeys.size > 0, 'the fixture is live: the change obliged checks at generation 2');
    const offending = [];
    let decided = 0;
    for (const g of gates) {
      for (const entry of Object.values(JSON.parse(g.checks ?? '{}'))) {
        const id = entry?.deciding?.result;
        if (!id) continue;
        decided++;
        const r = resultRow(id);
        if (!r || r.invalidated_reason === 'spec_changed' || (obligedKeys.has(entry.key) && r.generation !== 2)) offending.push([g.gate_kind, g.id, entry.key, id, r?.generation ?? null, r?.invalidated_reason ?? null]);
      }
    }
    assert.ok(decided > 0, 'the fixture is live: evaluations after v2 decided from results');
    assert.deepEqual(offending, [], `every gate evaluated after v2 decides from no result invalidated spec_changed, and for the checks the change obliged (${[...obligedKeys]}) only from generation-2 results ([gate, evaluation, check, result, generation, invalidated_reason])`);
    // Phase 2's completion, and the phase sign-off it used, are bound to v2 (the 31b review's S3).
    const completion = J.phase2.completion_binding;
    assert.equal(completion?.spec_revision, v2.id, `phase 2 completed bound to version 2 (${JSON.stringify(completion)})`);
    const used = signoffsOfProject(fx.home, p.id).find((s) => s.scope === 'phase' && s.candidate === completion.candidate && s.binding?.spec_revision === completion.spec_revision && s.binding?.protected_version === completion.protected_version);
    assert.ok(used, `the phase sign-off the completion used is bound to v2's spec revision (${JSON.stringify(signoffsOfProject(fx.home, p.id).filter((s) => s.scope === 'phase').map((s) => [s.candidate, s.binding]))})`);
    assert.ok(obligations.filter((o) => o.reason === 'spec_changed').every((o) => o.resolved_at), 'every spec_changed obligation resolved before the end');
    // Its obligations resolved before any gate passes on the check (objection
    // 107): every satisfied evaluation after the approval that names an obliged
    // check comes after that obligation's check.obligation_resolved (by seq).
    const resolvedAt = new Map(eventsAbout(fx.home, 'check.obligation_resolved', p.id).map((e) => [e.subject.check_obligation, e.seq]));
    const obliged = obligations.filter((o) => o.reason === 'spec_changed' && o.generation === 2);
    assert.deepEqual(obliged.filter((o) => !resolvedAt.has(o.id)).map((o) => o.id), [], 'each obligation\'s resolution recorded (check.obligation_resolved)');
    const early = [];
    let passedOn = 0;
    for (const e of eventsAbout(fx.home, 'gate.evaluated', p.id).filter((x) => x.seq > approved.seq && x.payload?.outcome === 'satisfied')) {
      const row = withStore(fx.home, (db) => db.prepare('SELECT "checks" FROM "gate_evaluations" WHERE "id" = ?').get(e.subject.evaluation));
      const keys = new Set(Object.values(JSON.parse(row?.checks ?? '{}')).map((x) => x?.key));
      for (const o of obliged.filter((x) => keys.has(x.key))) {
        passedOn++;
        if (!(resolvedAt.get(o.id) < e.seq)) early.push([e.payload.gate_kind, e.subject.evaluation, o.key, e.seq, resolvedAt.get(o.id) ?? null]);
      }
    }
    assert.ok(passedOn > 0, 'the fixture is live: a gate passed on an obliged check after the approval');
    assert.deepEqual(early, [], 'no gate passed on an obliged check before its obligation was resolved ([gate, evaluation, check, gate seq, resolution seq])');
    // Sean, 2026-10-12, CR-1 correction counted as a human act (SEAM.md §370):
    // the correction rewrites accept-r2's declared input, which D3 §3.1 makes unclassifiable.
    // Counted from the store (objection 074): decisions consumed by a human answer, and the owner's request, after the switch.
    const acts = humanActsOf(fx.home, J.ctx.project, { sinceSeq: J.switched.seq });
    assert.deepEqual(acts.map((h) => h.kind).sort(), ['check_correction_unclassifiable', 'spec_change', 'spec_change_request'], `the human acts on the project lane: CR-1's submission, its approval and its check correction (${JSON.stringify(acts)}; posts ${JSON.stringify(J.ctx.humanActs)})`);
    const owned = acts.find((h) => h.kind === 'check_correction_unclassifiable');
    assert.equal(correctionOrigin(fx.home, owned.id), 'check_correction', 'the unclassifiable decision is CR-1\'s check correction');
    assert.equal(owned.option, 'approve', 'answered approve by the owner');
  });

  test('(i) phase 2 as (f) and (g), without a next phase: each stage integrated then verified through engine-run checks in check domains by the self-tested runner, a Verifier and a Reviewer run, the phase sign-off bound, no replan', () => {
    const { fx, p, phase2, switched } = J;
    assert.ok(phase2.completed_at && phase2.completion_binding);
    // Objection 085: CR-1's replan replaces phase 2 early (D6 §5.7; M430), and the kept stages keep their
    // rows on generation 1: phase 2's stages are read across its generations, the cancelled excluded.
    const phase2Stages = planOfPhase(fx.home, p.id, 2).flatMap((x) => stagesOfPlan(fx.home, x.id)).filter((s) => !s.cancelled_at);
    assert.deepEqual(phase2Stages.map((s) => s.status), ['verified', 'verified']);
    assert.equal(workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'phase_complete' && w.trigger_id === phase2.id).length, 0, 'no replan after the last phase');
    assert.ok(evaluationsOfKind(fx.home, p.id, 'phase').some((e) => e.candidate === phase2.completion_binding.candidate && e.outcome === 'satisfied'), 'the phase gate satisfied on the bound candidate');
    const signoff = signoffsOfProject(fx.home, p.id).find((s) => s.scope === 'phase' && s.candidate === phase2.completion_binding.candidate);
    assert.ok(signoff, 'the phase sign-off on the bound candidate');
    assert.deepEqual([signoff.binding?.protected_version, signoff.binding?.spec_revision, signoff.binding?.plan_generation], [phase2.completion_binding.protected_version, phase2.completion_binding.spec_revision, phase2.completion_binding.generation]);
    const runs = runsOfProject(fx.home, p.id).filter((r) => r.kind !== 'session' && r.started_at && after_(r.started_at, switched.at));
    // Objection 109: one verification and one review per candidate, so stages
    // integrated together under K2 share them; every stage's candidate is
    // verified by a Verifier and reviewed, through engine-run checks in check domains.
    const phase2Candidates0 = new Set(candidatesOfProject(fx.home, p.id).filter((c) => after_(c.nominated_at, switched.at)).map((c) => c.id));
    for (const s of phase2Stages) {
      const on = stageCandidateRuns(fx.home, p.id, s.id);
      assert.ok(on.candidate && phase2Candidates0.has(on.candidate), `stage ${s.number} verified on a candidate nominated on the project lane (${JSON.stringify(on)})`);
      assert.ok(on.verifier >= 1 && on.reviewer >= 1, `stage ${s.number}'s candidate verified by a Verifier and reviewed (${JSON.stringify(on)}; runs ${JSON.stringify(runs.map((r) => r.role))})`);
      const recorded = executionsOf(fx.home, on.candidate).filter((x) => x.status === 'recorded');
      assert.ok(recorded.length > 0, `stage ${s.number}'s candidate has engine-run checks`);
      for (const x of recorded) assert.equal(domainRow(fx.home, x.domain)?.check_execution, x.id, `${x.key} ran in a check domain of its own`);
    }
    const phase2Candidates = candidatesOfProject(fx.home, p.id).filter((c) => after_(c.nominated_at, switched.at));
    assert.ok(phase2Candidates.some((c) => c.id === phase2.completion_binding.candidate), 'the bound candidate was nominated on the project lane');
    // Objection 107 (the driver's ruling): under K2 phase 2's stages integrate
    // moments apart, and a candidate superseded before any of its executions
    // starts has them cancelled (D3 §2.5). The checks are read on the candidate
    // the phase completed on, which is the one deployed: they all ran, in check
    // domains of their own, by the self-tested runner, and passed.
    const bound = phase2.completion_binding.candidate;
    assert.equal(J.deployed?.id, bound, 'the candidate the phase completed on is the one deployed');
    const xs = executionsOf(fx.home, bound).filter((x) => x.status === 'recorded');
    assert.ok(xs.length > 0, 'the bound candidate has engine-run checks');
    for (const x of xs) assert.equal(domainRow(fx.home, x.domain)?.check_execution, x.id, `${x.key} ran in a check domain of its own`);
    const phaseGate = evaluationsOfKind(fx.home, p.id, 'phase').filter((e) => e.candidate === bound && e.outcome === 'satisfied').at(-1);
    const deciding = Object.values(JSON.parse(phaseGate?.checks ?? '{}')).map((x) => x?.deciding?.result).filter(Boolean);
    assert.ok(deciding.length > 0, 'the phase gate on the bound candidate decided from results');
    for (const id of deciding) {
      const r = withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "id" = ?').get(id));
      const x = withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_executions" WHERE "id" = ?').get(r?.execution ?? null));
      assert.equal(r?.exit_status, 0, `${x?.key ?? id}: passed`);
      assert.ok(selfTested(fx.home, r), `${x?.key ?? id}: by the self-tested runner`);
      assert.equal(domainRow(fx.home, x?.domain)?.check_execution, x?.id, `${x?.key ?? id}: ran in a check domain of its own`);
    }
  });

  test('(j) the engine\'s request under policy through requestDeployment after the last phase: none before the environment, then one row requested_by policy with its key, the authorization derived and evaluated before the deploy work, alpha_authorize over the whole delivered set, alpha_complete, alpha_deployed on a real unit read by exact name; no second request after a further tick', () => {
    const { fx, p, phase2, deployed } = J;
    assert.deepEqual([J.beforeAlpha.requests, J.beforeAlpha.authorizations], [[], []], 'no request and no authorization before the request');
    const requests = deploymentRequests(fx.home, p.id).filter((r) => r.requested_by === 'policy');
    assert.equal(requests.length, 1, `one request by policy, for the last phase's candidate (${JSON.stringify(requests)})`);
    const [last] = requests;
    assert.equal(last.request_key?.candidate, deployed.id);
    assert.equal(last.request_key?.project, p.id);
    assert.deepEqual(last.request_key.completion_binding, phase2.completion_binding);
    assert.ok(last.request_key.environment_configuration, `and the environment configuration (${JSON.stringify(last.request_key)})`);
    assert.equal(eventsAbout(fx.home, 'deploy.requested_by_policy', p.id).length, 1);
    const auth = authorizationsOfProject(fx.home, p.id).find((a) => a.id === last.authorization);
    assert.ok(auth && ['issued', 'consumed'].includes(auth.status), `the request names its derived authorization (${JSON.stringify(auth)})`);
    const work = workOf(fx.home, p.id, 'deploy').filter((w) => w.subject?.authorization === auth.id);
    assert.equal(work.length, 1, 'one deploy work item for the derived authorization');
    assert.ok(Date.parse(auth.created_at) <= Date.parse(work[0].created_at), 'the authorization precedes the deploy work');
    const authorize = evaluationsOf(fx.home, deployed.id, 'alpha_authorize').find((e) => e.id === auth.evaluation);
    assert.equal(authorize?.outcome, 'satisfied', 'alpha_authorize satisfied');
    const reqs = requirementsOf(fx.home, p.id);
    const keyOf = (id) => reqs.find((r) => r.id === id || r.key === id)?.key ?? id;
    assert.deepEqual((scopeOf(fx.home, authorize).delivered ?? []).map(keyOf).sort(), ['R1', 'R2', 'R3', 'R4'], 'over the whole delivered set of both phases');
    assert.ok(evaluationsOf(fx.home, deployed.id, 'alpha_complete').some((e) => e.outcome === 'satisfied'), 'alpha_complete satisfied');
    assert.ok(eventsAbout(fx.home, 'candidate.advanced', p.id).some((e) => e.subject?.candidate === deployed.id), 'candidate.advanced');
    assert.equal(deployed.progress, 'alpha_deployed');
    assert.ok(J.svc?.unit && J.svc.unit.startsWith(unitPrefix(fx.home, J.env.id)), `the unit under this home's prefix (${J.svc?.unit})`);
    assert.deepEqual([J.unitShow?.LoadState, J.unitShow?.ActiveState], ['loaded', 'active'], `read from the host by exact name while it ran (${JSON.stringify(J.unitShow)})`);
    assert.equal(J.requestsAfterTick.length, deploymentRequests(fx.home, p.id).length, 'a further tick created no request');
    assert.equal(J.requestsAfterTick.filter((r) => r.requested_by === 'policy').length, 1, 'still one by policy');
  });

  test('(k) the pace read: every §7.6 figure present or unknown with its reason; human wait a measured zero in the stages, the routed decisions\' open time at the project', () => {
    const { pace } = J;
    for (const key of ['project', 'sessions', 'phases', 'stages', 'runs', 'domains', 'host']) assert.ok(key in pace, `the read has ${key} (${Object.keys(pace).join(', ')})`);
    for (const [path, value] of paceLeaves(pace)) {
      const ok = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || (value && typeof value === 'object' && typeof value.unknown === 'string');
      assert.ok(ok, `${path}: a figure is a value or {unknown: <reason>}, never null (${JSON.stringify(value)})`);
    }
    for (const s of pace.stages) assert.equal(s.human_wait, 0, `stage ${s.number ?? s.id}: human wait a measured zero under phase (${JSON.stringify(s.human_wait)})`);
    assert.ok(Array.isArray(pace.project.decisions), 'the routed decisions at the project');
    for (const kind of ['check_correction_unclassifiable', 'spec_change']) {
      const d = pace.project.decisions.find((x) => x.kind === kind);
      assert.ok(d && typeof d.open_seconds === 'number' && d.open_seconds >= 0, `${kind}'s open time measured (${JSON.stringify(pace.project.decisions)})`);
    }
    assert.ok(typeof pace.project.created_to_alpha_deployed === 'number');
    assert.equal(pace.host.autonomy, 'phase');
  });

  test('(l) the teardown applied; nothing of the prefix left; no check result from a fixture on the project lane; no decision answered by a role', () => {
    const { fx, p, switched, deployed } = J;
    assert.deepEqual(J.afterTeardown.units, [], 'no unit of the prefix');
    assert.deepEqual(J.afterTeardown.cgroups, [], 'no cgroup of the prefix');
    assert.deepEqual(J.afterTeardown.runFiles, [], 'no runtime file of the environment');
    const projectLane = new Set(candidatesOfProject(fx.home, p.id).filter((c) => after_(c.nominated_at, switched.at)).map((c) => c.id));
    const results = resultsOf(fx.home, p.id).filter((r) => projectLane.has(r.candidate));
    assert.ok(results.some((r) => r.candidate === deployed.id), 'the deployed candidate has results');
    const fixtures = results.filter((r) => !selfTested(fx.home, r));
    assert.deepEqual(fixtures.map((r) => [r.id, r.runner_id, r.runner_qualification]), [], 'every result on a project-lane candidate names the self-tested runner, none a fixture');
    const answered = withStore(fx.home, (db) => db.prepare('SELECT "answer" FROM "decisions" WHERE "project" = ? AND "status" = ?').all(p.id, 'consumed')).map((r) => JSON.parse(r.answer ?? '{}'));
    assert.ok(answered.every((a) => (a.actor ?? 'human') === 'human'), 'every answer the human\'s (the harness as the owner)');
  });
});
