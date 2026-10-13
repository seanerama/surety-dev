// M414, the evidence rules; the dependency boundary; scoped mode (slice 32;
// kernel lane). M5 plan §3.2 M414; D6-R07, D6-R08; D6 §8.3; F P1, §5.4; E6;
// reading 11; B13, B10; D3 §2.9, §6 class C; SEAM.md §383. On the scripted
// check boundary (§190): verdicts here are the boundary's; the adopted copy's
// real verdict against the application defect is M408's (project lane).
//   (a) the adopted repository's tests, CI file and a prior result (a CI
//       log saying the suite passed): no check of theirs, in no scope,
//       satisfying no gate; no result before c-1's own executions;
//   (b) the `developer`-origin check over the suite in place: registered,
//       covering no criterion;
//   (c) the adopted test: the copy and its helper under `.surety/checks/`,
//       an `acceptance` definition naming R1.1 whose inputs are the copies,
//       `adopted_tests` with the dependency boundary on the proposal (the
//       `application` import recorded, never hidden); afterwards phase 2's
//       Builder changes the original test, the original helper and the
//       original expectations: no protected change, the check's definition
//       and protected version unchanged, the copy what runs; a copy that
//       imports outside the protected root undeclared is refused;
//   (d) scoped mode: the descriptive requirement in no obligation; a plan
//       touching its module is `PLAN_DESCRIPTIVE_MODULE_TOUCHED`, with or
//       without `spec_change_requests`; the request an ordinary change
//       request the harness approves as the owner; afterwards `pending`, and
//       a plan touching the module passes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { roleThat } from './harness/gitruns.mjs';
import { scopeOf } from './harness/gates.mjs';
import { checkRows, evaluationsOfKind, obligationsOf, planChecks, protectedVersionsOf, proposalsOf, requirementsOf, resultsOf, runsOfProject } from './harness/journey/drive.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { advance, completeConformance, conformanceStages, passAlphaBarrier, retrofitEngine, toConformancePublished, toPhaseTwoPublished } from './harness/retrofit/drive.mjs';
import { ADOPTED, ADOPTED_SUM_TEST, DEFECT_STAGE, REQUIREMENTS, authoringFiles, authoringResult, conformanceStage, phasePlan, retrofitSpecText, roadmapJson } from './harness/retrofit/products.mjs';
import { SERVER_MJS_FIXED, SUM_TEST, refOid } from './harness/retrofit/repo.mjs';

const json = (t) => (typeof t === 'string' ? JSON.parse(t) : t);
const phase2Both = (roadmap) => ({ ...roadmap, phases: roadmap.phases.map((ph) => (ph.number === 2 ? { ...ph, modules: ['lib', 'service'] } : ph)) });
const PRIOR_RESULT = { 'ci/last-run.log': 'ok 1 - sum adds two numbers\nok 2 - the service sums\n# pass 2\n# fail 0\n' };

describe('M414 the evidence rules, the dependency boundary and scoped mode', () => {
  test('(a) the repository\'s tests, CI file and prior result are no evidence; (b) the developer check covers nothing; (c) the adopted copy, its definition and its boundary on the proposal', async (t) => {
    const fx = await retrofitEngine(t);
    const J = await toConformancePublished(fx, { repoOpts: { extra: PRIOR_RESULT } });
    const p = J.p.id;
    await advance(fx, J.ctx, () => (conformanceStages(fx.home, p)[0]?.conformance_state === 'conformed' ? true : undefined), { what: 'conformance', max: 40 });
    const checks = checkRows(fx.home, p);
    const keys = checks.map((c) => c.key).sort();
    assert.deepEqual(keys, ['accept-r1', 'accept-r2', 'accept-r3', 'operation', 'smoke', 'suite'], `the checks are the Verifier's definitions and nothing of the repository (${keys})`);
    const text = JSON.stringify(checks);
    for (const path of ['.github/workflows/ci.yml', 'ci/last-run.log', 'test/sum.test.mjs', 'test/helpers/expect.mjs']) assert.ok(!text.includes(`"${path}"`), `no check reads ${path} as an input`);
    const gate = evaluationsOfKind(fx.home, p, 'stage').at(-1);
    const scope = scopeOf(fx.home, gate);
    const required = new Set(scope.required ?? []);
    assert.ok(checks.filter((c) => required.has(c.id)).every((c) => keys.includes(c.key)), 'the scope requires only those');
    const firstExecution = withStore(fx.home, (db) => db.prepare('SELECT MIN("execution_seq") AS n FROM "check_executions" x JOIN "candidates" k ON k."id" = x."candidate" WHERE k."project" = ?').get(p).n);
    assert.ok(resultsOf(fx.home, p).every((r) => r.execution_seq >= firstExecution), 'no result predates the engine\'s own executions: no prior result imported');
    // (b)
    const suite = checks.find((c) => c.key === 'suite');
    assert.equal(suite.origin, 'developer', 'the suite in place is a developer-origin check');
    assert.deepEqual(json(suite.covers ?? '[]') ?? [], [], 'covering no criterion');
    // (c)
    const accept = checks.find((c) => c.key === 'accept-r1');
    assert.match(JSON.stringify(accept), /\.surety\/checks\/adopted\/sum\.test\.mjs/, 'the adopted check runs the copy under the protected root');
    const proposal = proposalsOf(fx.home, p).find((row) => row.adopted_tests);
    assert.ok(proposal, `the authoring proposal lists adopted_tests (§383 †) (${JSON.stringify(proposalsOf(fx.home, p).map((r) => Object.keys(r)))})`);
    assert.deepEqual(json(proposal.adopted_tests), [ADOPTED], 'from, to, criteria and the dependency boundary as the Verifier declared them');
    assert.ok(json(proposal.adopted_tests)[0].dependency_boundary.some((b) => b.path === 'src/sum.mjs' && b.disposition === 'application'), 'the application import recorded, never hidden');
  });

  test('(c) phase 2\'s Builder changes the original test, helper and expectations: no protected change, the adopted check unchanged, the copy what runs', async (t) => {
    const fx = await retrofitEngine(t);
    const mutated = {
      'server.mjs': SERVER_MJS_FIXED,
      // The original top-level test and its expectation, and the original helper, each changed by the Builder.
      'test/sum.test.mjs': SUM_TEST.replace('expectEqual(sum(2, 3), 5', 'expectEqual(sum(2, 3), 6'),
      'test/helpers/expect.mjs': 'export const expectEqual = () => {};\nexport const expectStatus = () => {};\n',
    };
    fx.scripted.kindScript('stage_build', roleThat(Object.entries(mutated).map(([path, text]) => step.write(path, text))));
    const { J, phase2 } = await toPhaseTwoPublished(fx);
    const p = J.p.id;
    const before = { versions: protectedVersionsOf(fx.home, p).length, accept: checkRows(fx.home, p).find((c) => c.key === 'accept-r1') };
    await advance(fx, J.ctx, () => withStore(fx.home, (db) => db.prepare('SELECT * FROM "stages" WHERE "phase_plan" = ? AND "status" IN (\'integrated\', \'verifying\', \'verified\')').get(phase2.id)), { what: 'phase 2\'s stage integrated', max: 40 });
    const head = refOid(J.p.repo.path, J.p.repo.ref);
    assert.ok(head, 'the fixture is live: the Builder\'s change is on the integration branch');
    const after = checkRows(fx.home, p).find((c) => c.key === 'accept-r1');
    assert.ok(proposalsOf(fx.home, p).every((r) => r.proposed_by === 'verifier_run'), 'the originals are the Builder\'s: no protected change beyond the Verifier\'s own proposals');
    assert.deepEqual([after.id, JSON.stringify(after)], [before.accept.id, JSON.stringify(before.accept)], 'the adopted check\'s definition unchanged');
    assert.ok(protectedVersionsOf(fx.home, p).length <= before.versions + 1, 'no protected version from the originals (phase 2\'s authoring at most)');
  });

  test('(c) a copy importing outside the protected root without declaring it is refused by the proposal check', async (t) => {
    const fx = await retrofitEngine(t);
    const leaky = { ...authoringFiles(), [ADOPTED.to]: ADOPTED_SUM_TEST.replace("from './helpers/expect.mjs'", "from '../../../test/helpers/expect.mjs'") };
    fx.scripted.kindScript('check_authoring', roleThat(Object.entries(leaky).map(([path, text]) => step.write(path, text)), authoringResult({ adopted: [{ ...ADOPTED, dependency_boundary: [{ path: 'src/sum.mjs', disposition: 'application' }] }] })));
    const J = await toConformancePublished(fx);
    const p = J.p.id;
    const run = await advance(fx, J.ctx, () => runsOfProject(fx.home, p).find((r) => r.state === 'ended' && r.role === 'verifier'), { what: 'the authoring run to end', exits: () => null, max: 12 });
    const applied = proposalsOf(fx.home, p).filter((r) => r.status === 'applied');
    assert.deepEqual(applied, [], 'nothing applied');
    const said = `${run.reason_text ?? ''} ${JSON.stringify(proposalsOf(fx.home, p))}`;
    assert.match(said, /test\/helpers\/expect\.mjs/, `the refusal names the undeclared import (${said.slice(0, 400)})`);
  });

  test('(d) scoped mode: the descriptive requirement in no obligation; a plan touching its module refused PLAN_DESCRIPTIVE_MODULE_TOUCHED with and without the request; after the owner approves its criteria, pending, and the plan passes', async (t) => {
    // R1 (lib) descriptive; phase 1 conforms R2 and R3 (service); phase 2 holds R1 and the defect R4.
    const fx = await retrofitEngine(t, { withoutR1: true });
    const descriptive = REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, descriptive: true, phase: 2 } : r));
    const J = await toConformancePublished(fx, {
      mode: 'scoped',
      policy: { alpha_deploy: 'manual' },
      spec: retrofitSpecText({ requirements: descriptive }),
      answers: { R2: 'confirm', R3: 'confirm', R4: 'defect' },
      // Phase 2 touches `lib` (R1) and `service` (R4): its roadmap phase names both modules (objection 075).
      architect: { roadmap: phase2Both(roadmapJson({ phase1: ['R2', 'R3'], phase2: ['R1', 'R4'] })), stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })] },
    }).catch((err) => ({ err }));
    assert.ok(!J.err, `the fixture is live: the scoped conformance plan is published (${J.err?.message})`);
    const p = J.p.id;
    const r1 = requirementsOf(fx.home, p).find((r) => r.key === 'R1');
    assert.equal(r1.status, 'descriptive_unverified', 'R1 descriptive_unverified');
    assert.ok(!obligationsOf(fx.home, p).some((o) => (o.criteria ?? []).some((c) => c.startsWith('R1'))), 'in no obligation');
    // The replans of phase 2: touching `lib` without the request, then with it, then (criteria approved) again.
    const stage = (criteria) => ({ ...DEFECT_STAGE, goal: 'describe and refuse', tasks: ['answer 400 on a non-number'], modules: ['lib', 'service'], implements: ['R1', 'R4'], validation: { ...DEFECT_STAGE.validation, criteria } });
    // The replans after the owner's approval are prepared against spec version 2 (D6 §5.3 clause 2; objection 075).
    const touch = ({ requests = false, criteria = ['R4.1'], spec_version = 1 } = {}) => ({
      steps: [
        { write: { path: '.surety/phases/phase-2.json', content: `${JSON.stringify({ ...phasePlan(2, { revision: '__HEAD__', spec_version }), stages: [stage(criteria)] }, null, 2)}\n`, substitute_head: true } },
        step.result({ status: 'completed', summary: 'phase 2 planned', plan: 'phase-2', conformance: 'within_baseline', ...(requests ? { spec_change_requests: [{ keys: ['R1'], text: 'Give R1 its criterion R1.1: sum(2, 3) returns 5.' }] } : {}) }),
      ],
    });
    fx.scripted.kindScript('replan', [touch(), touch({ requests: true }), touch({ criteria: ['R1.1', 'R4.1'], spec_version: 2 }), touch({ criteria: ['R1.1', 'R4.1'], spec_version: 2 })]);
    const withCriteria = REQUIREMENTS.map((r) => (r.key === 'R1' ? { ...r, phase: 2 } : r));
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', retrofitSpecText({ version: 2, requirements: withCriteria, changeLog: [{ version: 2, date: '2026-10-12', change: 'R1 criteria', by: 'Sean' }] }))], { changes: [{ key: 'R1', kind: 'criteria_added', reason: 'phase 2 touches lib' }] }));
    const done = await completeConformance(fx, J);
    const passed = await passAlphaBarrier(fx, done, { max: 80 }).catch((err) => ({ err }));
    const refusals = planChecks(fx.home, p).filter((c) => (c.reasons ?? []).some((r) => r.code === 'PLAN_DESCRIPTIVE_MODULE_TOUCHED'));
    assert.ok(refusals.length >= 2, `PLAN_DESCRIPTIVE_MODULE_TOUCHED without and with the request (${JSON.stringify(planChecks(fx.home, p).map((c) => [c.outcome, c.reasons]))})`);
    const requests = withStore(fx.home, (db) => db.prepare('SELECT * FROM "spec_change_requests" WHERE "project" = ?').all(p));
    assert.ok(requests.length >= 1, 'the replan\'s request an ordinary change request');
    assert.equal(requirementsOf(fx.home, p).find((r) => r.key === 'R1').status, 'pending', 'R1 pending once the owner approved its criteria');
    assert.ok(!passed.err, `and a plan touching lib then passes (${passed.err?.message})`);
  });
});
