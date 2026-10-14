// M432 (a), (b), (c), (e) and M433 (b), (d), (e) (slice 36; kernel lane).
// M5 plan §3.6 M432, M433; D6-C03, D6-C04, D6-C05; D6 §4.4 (what the
// impact binds and lists), §4.5 (approval, the generation, invalidation and
// the obligations), §4.6; B05; A.3 (`spec_impact`); SEAM.md §§418, 420, 421.
//
// One project carried by the journey's own path into phase 2 and left at
// rest (`phaseTwoAtRest`): phase 1 complete, phase 2 published and authored,
// stage 3 verified, stage 4's Builder failed and parked; ADR-001 cites R2;
// two Low findings on stage 3's candidate, one naming R3.1 and one R4.1.
// Then, one proposal at a time, the first two rejected:
// (c)  R3's statement only: R3 `text_changed`, R3.1 affected, its checks
//      listed as obligations; `uncertain_scope` names R3 (no ADR cites it);
// (b)  R2's criteria reordered: no requirement, no check, the digests equal;
// (a)  R5 added, R2 withdrawn, R3.1's text changed, an area added to R4: the
//      impact names exactly those keys and kinds, the checks covering R2.*
//      and R3.1, the stages implementing R2 to R4 with their status, the
//      phases and whether the current one is touched, every result and
//      evaluation of those checks, the finding naming R3.1 (not R4.1's), the
//      open work on those stages; nothing else;
// (e)  its record: kind `spec_impact`, the decision's evidence `observed`,
//      both digests, the dependency manifest with each entry's generation,
//      ADR-001 `textual` citing R2, `service` `structural`;
// then (a) approved: M433 (b) the version, keys, withdrawal, the added
//      requirement unassigned, the generation; (d) in the same finalizer the
//      results invalidated `spec_changed`, their evaluations stale, the
//      discovery errors, an obligation per listed check named by the gates,
//      `check_correction` naming the affected and uncovered criteria,
//      `replan`; (e) stage 3's candidate keeps version 1 and is evaluated
//      under version 2.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { answer, decision } from './harness/decisions.mjs';
import { versionRead } from './harness/checks/fixtures.mjs';
import { effectiveVersion, evaluate, raiseFindings, scopeOf, sharedFixture } from './harness/gates.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { withStore } from './harness/store.mjs';
import { candidatesOfProject, checkRows, eventsAbout, obligationsOf, projectRow, requirementsOf, specRevisions, stagesOfProject, workOf } from './harness/journey/drive.mjs';
import {
  AREA,
  SPEC_CHANGES,
  SPEC_PATH,
  blobAt,
  impactCheckKeys,
  impactRecordOf,
  impactRequirements,
  propose,
  pumpHolding,
  refOid,
  rejectProposal,
} from './harness/journey/change36.mjs';
import { phaseTwoAtRest } from './harness/journey/change36.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const sorted = (xs) => [...xs].sort();
const keysOfChecks = (impact, cls) => sorted((impact.checks?.[cls] ?? []).map((c) => c.key));

// What the store says the impact of a change touching `checkKeys` and the
// stages implementing `reqKeys` must list, read with nothing live.
function expected(home, project, { checkKeys, reqKeys }) {
  const results = rows(home, `SELECT r."id" FROM "check_results" r JOIN "checks" c ON c."id" = r."check" WHERE r."project" = ? AND r."invalidated_at" IS NULL AND c."key" IN (SELECT value FROM json_each(?))`, project, JSON.stringify(checkKeys)).map((r) => r.id);
  const evaluations = results.length === 0
    ? []
    : rows(home, `SELECT DISTINCT g."id" FROM "gate_evaluations" g WHERE g."project" = ? AND g."stale" = 0 AND EXISTS (SELECT 1 FROM json_each(g."inputs_snapshot", '$.results') j WHERE j.value IN (SELECT value FROM json_each(?)))`, project, JSON.stringify(results)).map((g) => g.id);
  const reqIds = requirementsOf(home, project).filter((r) => reqKeys.includes(r.key)).map((r) => r.id);
  const stages = stagesOfProject(home, project)
    .filter((s) => s.cancelled_at === null && (JSON.parse(s.implements ?? '[]')).some((x) => reqIds.includes(x) || reqKeys.includes(x)))
    .map((s) => ({ stage: s.id, number: s.number, status: s.status }));
  const stageIds = stages.map((s) => s.stage);
  const work = workOf(home, project).filter((w) => !['complete', 'cancelled'].includes(w.status) && stageIds.includes(w.subject?.stage)).map((w) => w.id);
  return { results: sorted(results), evaluations: sorted(evaluations), stages, work: sorted(work) };
}

describe('M432 the impact, exact and bound; M433 the approval that follows', () => {
  const shared = sharedFixture();
  let S;
  before(async () => {
    S = await phaseTwoAtRest(shared.context);
    const { fx, p, candidate3 } = S;
    S.findings = await raiseFindings(fx, p.id, candidate3.id, [
      { category: 'defect', severity: 'low', criterion: 'R3.1', message: 'The tally\'s total is a number only by accident of addition.' },
      { category: 'defect', severity: 'low', criterion: 'R4.1', message: 'The stats route is not built yet.' },
    ]);
    S.v1 = specRevisions(fx.home, p.id)[0];
  });
  after(() => shared.cleanup());

  test('(c) R3\'s statement only, every ID unchanged: R3 text_changed, R3.1 affected and its checks listed; uncertain_scope names R3', async () => {
    const { fx, p, ctx } = S;
    const { request, decision: d } = await propose(fx, ctx, SPEC_CHANGES.r3Statement, [{ key: 'R3', kind: 'text_changed', reason: 'R3 sharpened' }]);
    try {
      assert.ok(d, `the proposal is raised (${request.status} ${request.failure ?? ''})`);
      const impact = impactRecordOf(fx.home, request.id).value;
      assert.deepEqual(impactRequirements(impact), { R3: ['text_changed'] }, 'R3 text_changed and nothing else');
      assert.deepEqual(sorted(impact.affected_criteria ?? []), ['R3.1'], 'R3.1 affected though its text and ID are unchanged (B05)');
      assert.deepEqual(keysOfChecks(impact, 'obligations'), ['accept-r3', 'integration-tally'], 'its checks listed as obligations to come');
      assert.deepEqual(keysOfChecks(impact, 'criterion_unknown'), [], 'none of them on a removed criterion');
      const uncertain = JSON.stringify(impact.uncertain_scope ?? null);
      assert.ok(Array.isArray(impact.uncertain_scope) && uncertain.includes('R3'), `uncertain_scope names R3, whose independence no ADR establishes (${uncertain})`);
    } finally {
      if (d) await rejectProposal(fx, ctx, d);
    }
  });

  test('(b) R2\'s criteria reordered, every text unchanged: no requirement impact, no check, the digests equal', async () => {
    const { fx, p, ctx } = S;
    const { request, decision: d } = await propose(fx, ctx, SPEC_CHANGES.reordered, [{ key: 'R2', kind: 'criteria_changed', reason: 'reordered' }]);
    try {
      assert.equal(request.status, 'proposed', `a reorder is recorded as a proposal with its impact (${request.status} ${request.failure ?? ''})`);
      const impact = impactRecordOf(fx.home, request.id).value;
      assert.deepEqual(impact.requirements ?? [], [], `no requirement impact (${JSON.stringify(impact.requirements)})`);
      assert.deepEqual(impactCheckKeys(impact), [], 'no check named');
      assert.equal(impact.proposed_digest, impact.approved_digest, 'the digests differ by nothing');
      assert.equal(impact.approved_digest, S.v1.semantic_digest, 'the approved digest is version 1\'s');
    } finally {
      if (d) await rejectProposal(fx, ctx, d);
    }
    void p;
  });

  test('(a) R5 added, R2 withdrawn, R3.1 changed, an area added to R4: exactly those keys and kinds, checks, stages, phases, evidence, findings and work', async () => {
    const { fx, p, ctx } = S;
    S.before = expected(fx.home, p.id, { checkKeys: ['accept-r2', 'integration', 'accept-r3', 'integration-tally'], reqKeys: ['R2', 'R3', 'R4'] });
    S.generation = projectRow(fx.home, p.id).spec_evidence_generation;
    S.head = refOid(p.repo.path, p.repo.ref);
    const out = await propose(fx, ctx, SPEC_CHANGES.a, [
      { key: 'R2', kind: 'withdrawn', reason: 'R2 withdrawn' },
      { key: 'R3', kind: 'criteria_changed', reason: 'R3.1 names the type' },
      { key: 'R4', kind: 'areas_changed', reason: 'R4 handles a secret' },
      { key: 'R5', kind: 'added', reason: 'R5 counts refusals' },
    ]);
    S.a = out;
    assert.ok(out.decision, `the proposal is raised (${out.request.status} ${out.request.failure ?? ''})`);
    const impact = impactRecordOf(fx.home, out.request.id).value;
    S.impact = impact;
    assert.deepEqual(impactRequirements(impact), { R2: ['withdrawn'], R3: ['criteria_changed'], R4: ['areas_changed'], R5: ['added'] }, 'exactly those keys and kinds');
    assert.deepEqual(keysOfChecks(impact, 'criterion_unknown'), ['accept-r2', 'integration'], 'the checks covering R2.*');
    assert.deepEqual(keysOfChecks(impact, 'obligations'), ['accept-r3', 'integration-tally'], 'the checks covering R3.1');
    assert.deepEqual(sorted(impact.checks?.uncovered ?? []), ['R5.1'], 'R5.1 covered by no check');
    assert.deepEqual(
      sorted((impact.stages ?? []).map((s) => `${s.number}:${s.status}`)),
      sorted(S.before.stages.map((s) => `${s.number}:${s.status}`)),
      'every stage implementing R2 to R4, with its status, and no other',
    );
    assert.deepEqual(sorted(impact.phases ?? []), [1, 2], 'the phases holding the affected requirements');
    assert.equal(impact.touches_current, true, 'the current phase is touched');
    assert.deepEqual(sorted(impact.evidence?.results ?? []), S.before.results, 'every result of those checks');
    assert.deepEqual(sorted(impact.evidence?.evaluations ?? []), S.before.evaluations, 'every evaluation that selected one');
    assert.deepEqual(sorted(impact.work ?? []), S.before.work, 'the open work on those stages');
    const [r31, r41] = S.findings;
    assert.deepEqual(sorted(impact.findings ?? []), [r31.id], `the finding naming R3.1, not R4.1's (${JSON.stringify(impact.findings)}; R4.1's is ${r41.id})`);
  });

  test('(e) the record and its bindings: spec_impact observed, both digests, the dependency manifest with generations, the textual ADR and the structural module', async () => {
    const { fx, p } = S;
    assert.ok(S.a?.decision, 'the fixture is live: (a) was proposed');
    const { row, value: impact } = impactRecordOf(fx.home, S.a.request.id);
    assert.equal(row.kind, 'spec_impact', 'a spec_impact record');
    const evidence = decision(fx.home, S.a.decision.id).evidence ?? [];
    assert.ok(evidence.some((e) => e.record === row.id && e.provenance === 'observed'), `the decision's evidence names it, observed (${JSON.stringify(evidence)})`);
    assert.equal(impact.approved_digest, S.v1.semantic_digest, 'the approved digest');
    assert.match(impact.proposed_digest ?? '', /\S/, 'the proposed digest');
    assert.notEqual(impact.proposed_digest, impact.approved_digest);
    const m = impact.dependency_manifest ?? {};
    for (const k of ['plans', 'requirements', 'checks', 'findings', 'results', 'work']) {
      assert.ok(Array.isArray(m[k]), `the dependency manifest lists ${k} (${JSON.stringify(Object.keys(m))})`);
      for (const e of m[k]) assert.ok(e && e.id !== undefined && e.generation !== undefined, `each ${k} entry carries its id and generation (${JSON.stringify(e)})`);
    }
    const plan = m.plans.find((x) => x.id === S.plan2.id);
    assert.ok(plan, 'the active phase 2 plan is in it');
    assert.equal(plan.generation, S.plan2.generation, 'at its generation');
    const ids = (k) => m[k].map((e) => e.id);
    for (const c of checkRows(fx.home, p.id).filter((c) => ['accept-r2', 'integration', 'accept-r3', 'integration-tally'].includes(c.key) && c.protected_version === effectiveVersion(fx.home, p.id).id)) {
      assert.ok(ids('checks').includes(c.id), `the listed check ${c.key} is in it`);
    }
    for (const r of impact.evidence?.results ?? []) assert.ok(ids('results').includes(r), `the listed result ${r} is in it`);
    for (const f of impact.findings ?? []) assert.ok(ids('findings').includes(f), `the listed finding ${f} is in it`);
    for (const w of impact.work ?? []) assert.ok(ids('work').includes(w), `the listed work ${w} is in it`);
    assert.deepEqual(impact.adrs ?? null, [{ key: 'ADR-001', class: 'textual', cites: ['R2'] }], 'ADR-001 cites R2: a textual dependency');
    assert.deepEqual((impact.modules ?? []).map((x) => [x.name, x.class]), [['service', 'structural']], 'service\'s areas change: a structural dependency');
  });

  test('M433 (b), (d), (e): approved, the version, the generation, and in the same finalizer the invalidation, the obligations, the corrections and the replan', async () => {
    const { fx, p, ctx } = S;
    assert.ok(S.a?.decision, 'the fixture is live: (a) was proposed');
    const before = {
      results: S.before.results,
      evaluations: S.before.evaluations,
      checks: Object.fromEntries(checkRows(fx.home, p.id).filter((c) => c.protected_version === effectiveVersion(fx.home, p.id).id).map((c) => [c.key, c.id])),
    };
    const res = await answer(fx.engine, p.id, decision(fx.home, S.a.decision.id), 'approve');
    assert.equal(res.status, 200, `the owner approves (→ ${res.status} ${res.text})`);
    const v2 = await pumpHolding(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'version 2', max: 20 });
    // (b)
    assert.equal(v2.supersedes, S.v1.id, 'version 2 supersedes version 1');
    assert.match(v2.semantic_digest ?? '', /\S/, 'with its semantic digest');
    const head = refOid(p.repo.path, p.repo.ref);
    assert.equal(blobAt(p.repo.path, head), v2.git_blob, 'the integration branch holds the approved specification');
    const touched = gitQuiet(p.repo.path, ['diff', '--name-only', S.head, head]).split('\n').filter(Boolean);
    assert.deepEqual(touched, [SPEC_PATH], `the spec file alone changed on the integration branch (${touched})`);
    const reqs = Object.fromEntries(requirementsOf(fx.home, p.id).map((r) => [r.key, r]));
    assert.deepEqual(Object.keys(reqs).sort(), ['R1', 'R2', 'R3', 'R4', 'R5'], 'keys kept, R5 added, nothing deleted');
    assert.equal(reqs.R2.status, 'withdrawn', 'R2 withdrawn');
    assert.ok(reqs.R2.withdrawn_at, 'with its time');
    assert.deepEqual(reqs.R4.sensitive_areas, [AREA], 'R4 carries its area');
    const approved = eventsAbout(fx.home, 'baseline.spec_approved', p.id).at(-1);
    assert.equal(approved?.payload?.version, 2, 'baseline.spec_approved with version 2');
    assert.equal(projectRow(fx.home, p.id).spec_evidence_generation, S.generation + 1, 'the spec-evidence generation advanced');
    // (d)
    const results = rows(fx.home, `SELECT * FROM "check_results" WHERE "id" IN (SELECT value FROM json_each(?))`, JSON.stringify(before.results));
    assert.ok(results.length > 0, 'the fixture is live: the listed checks had results');
    for (const r of results) assert.deepEqual([Boolean(r.invalidated_at), r.invalidated_reason], [true, 'spec_changed'], `listed result ${r.id} invalidated spec_changed`);
    const evals = rows(fx.home, `SELECT "id", "stale" FROM "gate_evaluations" WHERE "id" IN (SELECT value FROM json_each(?))`, JSON.stringify(before.evaluations));
    for (const e of evals) assert.equal(e.stale, 1, `listed evaluation ${e.id} stale`);
    const effective = effectiveVersion(fx.home, p.id);
    const version = await versionRead(fx.engine, p.id, effective.id);
    for (const key of ['accept-r2', 'integration']) {
      const errors = version.discovery_errors.filter((e) => e.code === 'criterion_unknown' && e.path.startsWith(`.surety/checks/defs/${key}.json`));
      assert.ok(errors.length > 0, `${key} names a removed criterion: criterion_unknown at discovery (${JSON.stringify(version.discovery_errors)})`);
    }
    const obligations = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed');
    assert.deepEqual(sorted(obligations.map((o) => o.key)), ['accept-r2', 'accept-r3', 'integration', 'integration-tally'], 'an obligation per listed check');
    for (const o of obligations) {
      assert.equal(o.generation, S.generation + 1, `${o.key}'s at the new generation`);
      assert.equal(o.resolved_at, null, `${o.key}'s unresolved`);
    }
    const corrections = workOf(fx.home, p.id, 'check_correction').filter((w) => JSON.stringify(w).includes(S.a.request.id));
    assert.equal(corrections.length, 1, 'check_correction registered for the Verifier');
    const named = JSON.stringify(corrections[0]);
    for (const c of ['R3.1', 'R5.1']) assert.ok(named.includes(c), `naming the affected and uncovered criterion ${c} (${named})`);
    const replans = workOf(fx.home, p.id, 'replan').filter((w) => w.trigger_source === 'spec_change');
    assert.equal(replans.length, 1, 'replan registered: the current phase is touched');
    // The gates name the obligations; (e) the candidate before the change.
    const candidate = S.candidate3;
    assert.equal(candidatesOfProject(fx.home, p.id).find((c) => c.id === candidate.id).spec_revision, candidate.spec_revision, 'the candidate nominated before the change keeps its spec_revision');
    assert.equal(candidate.spec_revision, S.v1.id, 'version 1, as a historical fact');
    const evaluation = await evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: S.stage3.id }, { inventory: false });
    assert.equal(scopeOf(fx.home, evaluation).spec_revision, v2.id, 'its new evaluation is under version 2');
    const subjects = evaluation.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects ?? []);
    for (const key of ['accept-r3', 'integration-tally']) {
      const id = checkRows(fx.home, p.id).filter((c) => c.key === key && c.protected_version === effective.id).map((c) => c.id);
      assert.ok(subjects.some((s) => id.includes(s) || String(s).includes(key)), `ACCEPTANCE_SCOPE_INCOMPLETE names ${key} (${JSON.stringify(evaluation.reasons)})`);
    }
    // (b), last so the rest of (d) is read on any build: the added requirement unassigned.
    assert.equal(reqs.R5.assigned_phase, null, 'R5 has no phase: the roadmap places it, not its index hint (D6 §4.5; Q8)');
  });
});
