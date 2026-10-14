// M442 (b), the rehearsal plays from the package (M5 slice 38; kernel lane).
// M5 plan §3.8 M442 (b); E135 (M4's rehearsal passed with a fake whose check
// carried the right gate kinds where the package said nothing); BS5 §12
// ("A fake that passes the rehearsal under a package from which a required
// element has been removed by harness override fails M442 (b)"), §4.1 rule
// 18; SEAM.md §§453 to 455.
//
// Every role is the package-driven fake (harness/standin/package-fakes.cjs),
// on the reference project of M401 (Tally, T2), the owner's words typed
// through the owner's routes. For each element of §454, the element is
// omitted (`POST /v1/harness/package-omit`, §453) from the packages written
// while the role that reads it runs; then:
//   - the package the fake was given lacks it (no block);
//   - the fake's product lacks what the element states, and the rehearsal's
//     judgement fails there, naming the element (harness/real/
//     kernel-rehearsal.mjs `judge*`, against the element as the whole
//     package states it);
//   - where the kernel lane's engine reads that part of the product at that
//     step, it reacts too: a save's findings (the header, B.2's forms, the
//     marks, the index, the areas, the tier), the approval's blocked option
//     (the phase hint), a refused close (the Architect's machine files, an
//     ADR, the kinds), the plan check's routing (a declared `uncertain`).
// Each step's control, with the packages whole, passes the same judgement
// (and the whole journey is M442 (c)'s file). No product here is the
// fixture's: each is derived from the package and the owner's words.
//
// The retrofit packages' own elements (`spec_writer.claims_table`,
// `verifier.adoption_rule`, `architect.spec_change_requests`) on the
// retrofit fixture repository: the claims table and the adoption on a full
// adoption played by the fakes; the change requests on M414 (d)'s scoped
// adoption, its descriptive R1 held by phase 2, with the replan the fake's.
// Not here: the parts of a product only an execution reads (a check's
// program, the Builder's code), which the kernel lane does not run: the
// real-lane rehearsals run them in real domains.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { decision } from './harness/decisions.mjs';
import { planChecks, pump } from './harness/journey/drive.mjs';
import { blockersOf } from './harness/journey/spec34.mjs';
import { saveSession, sayAndSettle } from './harness/sessions.mjs';
import { ARCHITECT_ELEMENTS, AUTHORING_ELEMENTS, BUILDER_ELEMENTS, SPEC_WRITER_ELEMENTS } from './harness/real/packages.mjs';
import { sumsArchitecture, sumsBrief, sumsContent } from './harness/real/rehearsal-content.mjs';
import { advance, completeConformance, passAlphaBarrier, retrofitEngine, toConformancePublished } from './harness/retrofit/drive.mjs';
import { REQUIREMENTS as SUMS_REQS, conformanceStage, retrofitSpecText, roadmapJson } from './harness/retrofit/products.mjs';
import {
  SPEC_WORDS,
  adoptedFull,
  architectTurn as architectTurnOf,
  judgeReplanRetrofit,
  retrofitSpecTurn,
  alphaConfigured,
  architectTurn,
  contextOf,
  fakeEngine,
  fakeSession,
  FAKE,
  judgeArchitect,
  judgeAuthoring,
  judgeBuilder,
  judgePhaseVerification,
  judgeSpec,
  judgeSpecChange,
  lastPlay,
  named,
  omit,
  publishedPaused,
  resume,
  specApproved,
  wholeElements,
} from './harness/real/kernel-rehearsal.mjs';
import { TALLY_CHANGE_TEXT, tallyBrief } from './harness/real/rehearsal-content.mjs';
import { createWithIdea, JOURNEY_POLICY, ROUTED_KINDS } from './harness/journey/drive.mjs';
import { pauseProject } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { recordJson } from './harness/real/lane.mjs';
const rows = (home, sql, ...p) => withStore(home, (db) => db.prepare(sql).all(...p));

const show = (v) => JSON.stringify(v)?.slice(0, 1500);
const blocking = (findings) => (findings ?? []).map((f) => f.code);
const playsOf = (fx, project, kind) => fx.scripted.fakePlays().filter((e) => e.launch?.project === project && e.launch?.work_kind === kind);

// The engine's reaction a spec element's omission must draw at the save (the
// kernel lane's parse at save), where it draws one.
const SPEC_ENGINE = Object.freeze({
  'spec_writer.header_fields': /header/,
  'spec_writer.requirement_form': /^spec_row_unmatched$/,
  'spec_writer.marks': /uncertain|mark/,
  'spec_writer.index_columns': /index/,
  'spec_writer.index_cells': /index/,
  'spec_writer.sensitive_areas': /area/,
  'spec_writer.tier_table': /tier|header/,
});

describe('M442 (b) the Spec Writer under its package with one element omitted', () => {
  const shared = sharedFixture();
  const S = { cases: {} };
  const brief = tallyBrief({ variant: true });
  before(async () => {
    const fx = await fakeEngine(shared.context);
    const p = await createWithIdea(fx, { policy: JOURNEY_POLICY });
    const run = await fakeSession(fx, p.id, 'spec_writer');
    await sayAndSettle(fx, p.id, run.id, SPEC_WORDS(brief));
    const control = await saveSession(fx, p.id, run.id);
    S.control = { text: lastPlay(fx, { run: run.id })?.written?.['.surety/spec/spec.md'] ?? null, findings: control.findings, play: lastPlay(fx, { run: run.id }) };
    for (const id of SPEC_WRITER_ELEMENTS.filter((e) => e !== 'spec_writer.approval_blockers')) {
      await omit(fx, [id]);
      await sayAndSettle(fx, p.id, run.id, 'Write it again, from what I said.');
      const saved = await saveSession(fx, p.id, run.id);
      const play = lastPlay(fx, { run: run.id });
      S.cases[id] = { play, text: play?.written?.['.surety/spec/spec.md'] ?? null, findings: saved.findings };
      await omit(fx, []);
    }
    // The approval's blockers are read at the close.
    await omit(fx, ['spec_writer.approval_blockers']);
    await sayAndSettle(fx, p.id, run.id, 'Write it again, from what I said.');
    const saved = await saveSession(fx, p.id, run.id);
    const play = lastPlay(fx, { run: run.id });
    await omit(fx, []);
    const close = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/close`, {});
    const approval = (close.body?.decisions ?? []).find((d) => d.kind === 'spec_approval');
    S.cases['spec_writer.approval_blockers'] = { play, text: play?.written?.['.surety/spec/spec.md'] ?? null, findings: saved.findings, close, approval: approval ? decision(fx.home, approval.id) : null };
    S.W = wholeElements(fx);
  });
  after(shared.cleanup);

  test('(b) control: with the package whole, the fake\'s specification passes the judgement and the save finds nothing', () => {
    assert.ok(S.control.text, `the fake wrote the specification (${show(S.control.play)})`);
    assert.deepEqual(judgeSpec(S.control.text, S.W, brief), [], 'the judgement of the whole package\'s product');
    assert.deepEqual(blocking(S.control.findings), [], `the engine's parse at save finds nothing (${show(S.control.findings)})`);
  });

  for (const id of SPEC_WRITER_ELEMENTS) {
    test(`(b) ${id} omitted: the package lacks it, the specification lacks it, the rehearsal fails naming it`, () => {
      const c = S.cases[id];
      assert.ok(c?.play, `the fake played the turn (${show(c)})`);
      assert.ok(!(id in (c.play.blocks ?? {})), `the package the fake was given has no ${id} block (${Object.keys(c.play.blocks ?? {}).join(', ')})`);
      assert.notEqual(c.text, S.control.text, 'the product differs from the whole package\'s');
      assert.ok(named(judgeSpec(c.text, S.W, brief)).includes(id), `the judgement names ${id} (${show(judgeSpec(c.text, S.W, brief))})`);
      if (SPEC_ENGINE[id]) assert.ok(blocking(c.findings).some((code) => SPEC_ENGINE[id].test(code)), `the engine's parse at save reacts (${show(c.findings)})`);
      if (id === 'spec_writer.approval_blockers') {
        assert.equal(c.close.status, 200, `the close raises the approval (→ ${c.close.status} ${c.close.text})`);
        assert.ok(blockersOf(c.approval).some((b) => b.startsWith('QUESTION_NO_PHASE_HINT:Q1')), `approve is blocked QUESTION_NO_PHASE_HINT:Q1 (${show(c.approval?.options)})`);
      }
    });
  }
});

describe('M442 (b) the Architect under its package with one element omitted', () => {
  const shared = sharedFixture();
  const A = { cases: {} };
  // One project per case, in one engine, so that no earlier session's
  // checkpoint holds the files a case's omission keeps the fake from writing.
  before(async () => {
    const fx = await fakeEngine(shared.context);
    const turn = async (ids) => {
      const { p } = await specApproved(fx);
      await omit(fx, ids);
      const a = await architectTurn(fx, p);
      await omit(fx, []);
      return { close: a.close, play: lastPlay(fx, { run: a.run.id }), check: planChecks(fx.home, p.id).at(-1) ?? null };
    };
    // The control: the whole package; the pair raised, left open.
    A.control = await turn([]);
    for (const id of ARCHITECT_ELEMENTS) A.cases[id] = await turn([id]);
    A.W = wholeElements(fx);
    A.fx = fx;
  });
  after(shared.cleanup);

  test('(b) control: with the package whole, the fake\'s architecture passes the judgement, the close raises the pair, the plan check routes nothing by declaration', () => {
    assert.equal(A.control.close.status, 200, `the close (→ ${A.control.close.status} ${A.control.close.text})`);
    assert.deepEqual(judgeArchitect(A.control.play?.written ?? {}, A.W, { adrs: ['ADR-001'] }), []);
    assert.equal(A.control.check?.conformance, 'within_baseline', `the plan declares within_baseline (${show(A.control.check)})`);
  });

  for (const id of ARCHITECT_ELEMENTS) {
    test(`(b) ${id} omitted: the package lacks it, the products lack it, the rehearsal fails naming it`, () => {
      const c = A.cases[id];
      assert.ok(c?.play, `the fake played the turn (${show(c)})`);
      assert.ok(!(id in (c.play.blocks ?? {})), `no ${id} block in the package (${Object.keys(c.play.blocks ?? {}).join(', ')})`);
      // Judged against the whole package with this turn's own facts (its prepared_against).
      const W = { ...A.W, ...(c.play.blocks ?? {}) };
      assert.ok(named(judgeArchitect(c.play.written ?? {}, W, { adrs: ['ADR-001'] })).includes(id), `the judgement names ${id} (${show(judgeArchitect(c.play.written ?? {}, W, { adrs: ['ADR-001'] }))})`);
      if (id === 'architect.routing') {
        assert.equal(c.close.status, 200, `the close raises the pair (→ ${c.close.status} ${c.close.text})`);
        assert.equal(c.check?.conformance, 'uncertain', `the plan check records the declared uncertainty (${show(c.check)})`);
      } else if (id === 'architect.schema.phase_plan') {
        // A first Architect close without the first phase's plan is refused 422
        // plan_refused naming the plan's file (reading 2; the Builder's 7b481d4).
        assert.equal(c.close.status, 422, `the first close without phase 1's plan is refused (→ ${c.close.status} ${c.close.text})`);
        assert.equal(c.close.body?.code, 'plan_refused', `plan_refused (${c.close.text})`);
        assert.match(c.close.text, /\.surety\/phases\/phase-1\.json/, 'naming .surety/phases/phase-1.json');
      } else {
        assert.ok([409, 422].includes(c.close.status), `the engine refuses the close (→ ${c.close.status} ${c.close.text})`);
      }
    });
  }
});

describe('M442 (b) the phase-authoring Verifier under its package with one element omitted', () => {
  const shared = sharedFixture();
  const V = { cases: {} };
  // One project per case, in one engine: its plan published while paused,
  // alpha configured with the check secret, the omission set, resumed until
  // the authoring run has played.
  const authoring = async (fx, ids) => {
    const { p } = await specApproved(fx);
    await publishedPaused(fx, p);
    await alphaConfigured(fx, p);
    await omit(fx, ids);
    await resume(fx, p);
    const ctx = { ...contextOf(fx, p), answerKinds: [] };
    await pump(fx, ctx, () => (playsOf(fx, p.id, 'check_authoring').length > 0 ? true : undefined), { what: 'the authoring run to play', max: 20 });
    await omit(fx, []);
    await pauseProject(fx.engine, p.id);
    return playsOf(fx, p.id, 'check_authoring')[0];
  };
  before(async () => {
    const fx = await fakeEngine(shared.context);
    V.control = await authoring(fx, []);
    for (const id of AUTHORING_ELEMENTS) V.cases[id] = await authoring(fx, [id]);
    V.W = V.control?.blocks ?? {};
  });
  after(shared.cleanup);

  test('(b) control: with the package whole, the fake\'s checks and result pass the judgement', () => {
    assert.ok(V.control, 'the authoring run played');
    assert.deepEqual(judgeAuthoring(V.control.written ?? {}, V.control.result, V.W), []);
  });

  for (const id of AUTHORING_ELEMENTS) {
    test(`(b) ${id} omitted: the package lacks it, the checks lack it, the rehearsal fails naming it`, () => {
      const c = V.cases[id];
      assert.ok(c, 'the authoring run played');
      assert.ok(!(id in (c.blocks ?? {})), `no ${id} block in the package (${Object.keys(c.blocks ?? {}).join(', ')})`);
      const f = judgeAuthoring(c.written ?? {}, c.result, V.W);
      assert.ok(named(f).includes(id), `the judgement names ${id} (${show(f)})`);
    });
  }
});

describe('M442 (b) the Builder under its package with one element omitted', () => {
  const shared = sharedFixture();
  const B = { cases: {} };
  const builds = async (fx, ids) => {
    const { p } = await specApproved(fx);
    await publishedPaused(fx, p);
    await alphaConfigured(fx, p);
    await omit(fx, ids);
    await resume(fx, p);
    const ctx = contextOf(fx, p);
    const two = () => playsOf(fx, p.id, 'stage_build');
    await pump(fx, ctx, () => (two().length >= 2 || (two().length >= 1 && ids.some((i) => i === 'builder.tasks' || i === 'builder.implements')) ? true : undefined), { what: 'the Builders to play', max: 60 });
    await omit(fx, []);
    await pauseProject(fx.engine, p.id);
    return two();
  };
  before(async () => {
    const fx = await fakeEngine(shared.context);
    B.control = await builds(fx, []);
    for (const id of BUILDER_ELEMENTS) B.cases[id] = await builds(fx, [id]);
  });
  after(shared.cleanup);
  // The whole package of stage n, as the control's Builder of stage n was given it.
  const wholeOf = (n) => B.control.find((x) => x.blocks?.['builder.tasks']?.stage === n)?.blocks ?? {};

  test('(b) control: with the packages whole, stages 1 and 2\'s Builders pass the judgement', () => {
    for (const n of [1, 2]) {
      const play = B.control.find((x) => x.blocks?.['builder.tasks']?.stage === n);
      assert.ok(play, `stage ${n}'s Builder played (${show(B.control.map((x) => x.blocks?.['builder.tasks']))})`);
      assert.deepEqual(judgeBuilder(play.written ?? {}, play.result, wholeOf(n)), [], `stage ${n}`);
    }
  });

  for (const id of BUILDER_ELEMENTS) {
    test(`(b) ${id} omitted: the package lacks it, the stage's code lacks it, the rehearsal fails naming it`, () => {
      const plays = B.cases[id] ?? [];
      // The stage the element matters at: the first stage for its tasks and
      // requirements; the second, which depends on the first and carries the
      // service's obligation, for the others.
      const n = id === 'builder.tasks' || id === 'builder.implements' ? 1 : 2;
      const play = id === 'builder.tasks' || id === 'builder.implements' ? plays[0] : plays.find((x) => x.blocks?.['builder.tasks']?.stage === 2);
      assert.ok(play, `stage ${n}'s Builder played (${plays.length} plays)`);
      assert.ok(!(id in (play.blocks ?? {})), `no ${id} block in the package (${Object.keys(play.blocks ?? {}).join(', ')})`);
      const f = judgeBuilder(play.written ?? {}, play.result, wholeOf(n));
      assert.ok(named(f).includes(id), `the judgement names ${id} (${show(f)})`);
    });
  }
});

describe("M442 (b) the phase Verifier and the Spec Writer's change, each under its package with its element omitted", () => {
  const shared = sharedFixture();
  const C = {};
  // A project to phase 1's verification, the omission set from the start
  // (it touches only the phase Verifier's package); stopped at its play.
  const phase = async (fx, ids) => {
    const { p } = await specApproved(fx);
    await publishedPaused(fx, p);
    await alphaConfigured(fx, p);
    await omit(fx, ids);
    await resume(fx, p);
    const ctx = { ...contextOf(fx, p), answerKinds: ROUTED_KINDS };
    await pump(fx, ctx, () => (playsOf(fx, p.id, 'phase_verification').length > 0 ? true : undefined), { what: 'the phase Verifier to play', max: 120 });
    // The engine's reaction to the play: the phase completes, or the phase verification parks for its missing sign-off.
    const work = () => rows(fx.home, `SELECT "status", "blocker" FROM "work_items" WHERE "project" = ? AND "kind" = 'phase_verification' ORDER BY rowid`, p.id).at(-1);
    const plan1 = () => rows(fx.home, 'SELECT "completed_at" FROM "phase_plans" WHERE "project" = ? AND "phase_number" = 1 AND "active" = 1', p.id)[0];
    await pump(fx, ctx, () => (plan1()?.completed_at || /phase_signoff_missing/.test(work()?.blocker ?? '') ? true : undefined), { what: 'the phase to complete or its verification to park', max: 40 }).catch(() => null);
    await omit(fx, []);
    await pauseProject(fx.engine, p.id);
    return { ...playsOf(fx, p.id, 'phase_verification')[0], reaction: { work: work() ?? null, completed: plan1()?.completed_at ?? null } };
  };
  // A project with its first plan ready, then the owner's change request.
  const change = async (fx, ids) => {
    const { p } = await specApproved(fx);
    await publishedPaused(fx, p);
    await alphaConfigured(fx, p);
    await omit(fx, ids);
    await resume(fx, p);
    const ctx = { ...contextOf(fx, p), answerKinds: ROUTED_KINDS };
    const res = await fx.engine.post(`/v1/projects/${p.id}/spec/change-requests`, { text: TALLY_CHANGE_TEXT });
    assert.equal(res.status, 201, `the owner's change request (→ ${res.status} ${res.text})`);
    await pump(fx, ctx, () => (playsOf(fx, p.id, 'spec_change').length > 0 ? true : undefined), { what: 'the Spec Writer\'s change to play', max: 60 });
    // The engine's reaction: the impact it records keeps the role's claimed changes beside its own.
    const request = () => rows(fx.home, 'SELECT * FROM "spec_change_requests" WHERE "project" = ? ORDER BY "seq"', p.id).at(-1);
    await pump(fx, ctx, () => (request()?.impact || request()?.impact_value ? true : undefined), { what: 'the change\'s impact to be recorded', max: 30 }).catch(() => null);
    const r = request();
    const impact = r?.impact_value ? JSON.parse(r.impact_value) : r?.impact ? recordJson(fx.home, r.impact) : null;
    await omit(fx, []);
    await pauseProject(fx.engine, p.id);
    return { ...playsOf(fx, p.id, 'spec_change')[0], reaction: { impact } };
  };
  before(async () => {
    const fx = await fakeEngine(shared.context);
    C.phaseControl = await phase(fx, []);
    C.phaseOmitted = await phase(fx, ['verifier.phase_signoff']);
    C.changeControl = await change(fx, []);
    C.changeOmitted = await change(fx, ['spec_writer.change_result']);
  });
  after(shared.cleanup);

  test('(b) control: with the packages whole, the phase Verifier signs the phase off and the change lists its changes', () => {
    assert.ok(C.phaseControl && C.changeControl, 'both played');
    assert.deepEqual(judgePhaseVerification(C.phaseControl.result, C.phaseControl.blocks ?? {}), []);
    assert.ok(C.phaseControl.reaction.completed, `the engine completes the phase on the sign-off (${show(C.phaseControl.reaction)})`);
    assert.deepEqual(judgeSpecChange(C.changeControl.result, C.changeControl.blocks ?? {}), []);
    assert.ok(Array.isArray(C.changeControl.reaction.impact?.claimed) && C.changeControl.reaction.impact.claimed.length > 0, `the engine records the claimed changes beside its impact (${show(C.changeControl.reaction.impact?.claimed)})`);
  });

  test('(b) verifier.phase_signoff omitted: the package lacks it, the result signs nothing off, the rehearsal fails naming it', () => {
    const c = C.phaseOmitted;
    assert.ok(c, 'the phase Verifier played');
    assert.ok(!('verifier.phase_signoff' in (c.blocks ?? {})), 'no verifier.phase_signoff block in the package');
    const f = judgePhaseVerification(c.result, C.phaseControl.blocks ?? {});
    assert.ok(named(f).includes('verifier.phase_signoff'), `the judgement names it (${show(f)})`);
    assert.ok(!c.reaction.completed && /phase_signoff_missing/.test(c.reaction.work?.blocker ?? ''), `the engine parks the phase verification phase_signoff_missing and completes nothing (${show(c.reaction)})`);
  });

  test('(b) spec_writer.change_result omitted: the package lacks it, the result lists no change, the rehearsal fails naming it', () => {
    const c = C.changeOmitted;
    assert.ok(c, 'the Spec Writer\'s change played');
    assert.ok(!('spec_writer.change_result' in (c.blocks ?? {})), 'no spec_writer.change_result block in the package');
    const f = judgeSpecChange(c.result, C.changeControl.blocks ?? {});
    assert.ok(named(f).includes('spec_writer.change_result'), `the judgement names it (${show(f)})`);
    assert.ok(c.reaction.impact && !(Array.isArray(c.reaction.impact.claimed) && c.reaction.impact.claimed.length > 0), `the engine records no claimed change beside its impact (${show(c.reaction.impact?.claimed)})`);
  });
});

describe("M442 (b) the retrofit packages' own elements, each omitted", () => {
  const shared = sharedFixture();
  const R = {};
  const brief = sumsBrief();
  // A full adoption on the fakes to its conformance authoring's play, `ids` omitted for the authoring.
  const toAuthoring = async (fx, ids) => {
    const { p } = await adoptedFull(fx);
    await retrofitSpecTurn(fx, p, { brief, close: true });
    const a = await architectTurnOf(fx, p, { arch: sumsArchitecture() });
    assert.equal(a.close.status, 200, `the retrofit Architect's close (→ ${a.close.status} ${a.close.text})`);
    await pauseProject(fx.engine, p.id);
    for (const d of a.close.body.decisions ?? []) await fx.engine.post(`/v1/projects/${p.id}/decisions/${d.id}/answer`, { option: 'approve', preview_hash: decision(fx.home, d.id).preview_hash });
    await alphaConfigured(fx, p);
    await omit(fx, ids);
    await resume(fx, p);
    const ctx = { ...contextOf(fx, p, 'T1'), answerKinds: [] };
    await pump(fx, ctx, () => (playsOf(fx, p.id, 'check_authoring').length > 0 ? true : undefined), { what: 'the conformance authoring to play', max: 30 });
    await omit(fx, []);
    await pauseProject(fx.engine, p.id);
    return playsOf(fx, p.id, 'check_authoring')[0];
  };
  before(async () => {
    const fx = await fakeEngine(shared.context, { content: sumsContent() });
    // The claims table: two spec turns on one adopted project, the second with it omitted.
    const { p } = await adoptedFull(fx);
    R.claimsControl = (await retrofitSpecTurn(fx, p, { brief })).play;
    await omit(fx, ['spec_writer.claims_table']);
    R.claimsOmitted = (await retrofitSpecTurn(fx, p, { brief })).play;
    await omit(fx, []);
    R.W = { ...(R.claimsControl?.blocks ?? {}) };
    // The adoption rule.
    R.adoptControl = await toAuthoring(fx, []);
    R.adoptOmitted = await toAuthoring(fx, ['verifier.adoption_rule']);
  });
  after(shared.cleanup);

  test('(b) control: the retrofit specification carries the claims table; the conformance authoring adopts in the rule\'s form', () => {
    assert.deepEqual(judgeSpec(R.claimsControl?.written?.['.surety/spec/spec.md'], R.W, brief).filter((f) => f.element === 'spec_writer.claims_table'), []);
    assert.deepEqual(judgeAuthoring(R.adoptControl?.written ?? {}, R.adoptControl?.result, R.adoptControl?.blocks ?? {}, { retrofit: true }).filter((f) => f.element === 'verifier.adoption_rule'), []);
  });

  test('(b) spec_writer.claims_table omitted: the package lacks it, the specification has no claims table, the rehearsal fails naming it', () => {
    const c = R.claimsOmitted;
    assert.ok(c && !('spec_writer.claims_table' in (c.blocks ?? {})), 'no spec_writer.claims_table block in the package');
    assert.ok(named(judgeSpec(c.written?.['.surety/spec/spec.md'], R.W, brief)).includes('spec_writer.claims_table'), 'the judgement names it');
  });

  test('(b) verifier.adoption_rule omitted: the package lacks it, nothing is adopted, the rehearsal fails naming it', () => {
    const c = R.adoptOmitted;
    assert.ok(c && !('verifier.adoption_rule' in (c.blocks ?? {})), 'no verifier.adoption_rule block in the package');
    const f = judgeAuthoring(c.written ?? {}, c.result, R.adoptControl?.blocks ?? {}, { retrofit: true });
    assert.ok(named(f).includes('verifier.adoption_rule'), `the judgement names it (${show(f)})`);
  });
});

describe('M442 (b) architect.spec_change_requests: a scoped adoption\'s replan, its descriptive requirement in phase 2', () => {
  // M414 (d)'s adoption (R1 descriptive in phase 2, R4 a defect), every role
  // the fixture's but the replan, which is the package-driven fake.
  const replan = async (t, ids) => {
    const fx = await retrofitEngine(t, { withoutR1: true });
    fx.scripted.packageFakes(sumsContent());
    fx.scripted.kindScript('replan', FAKE);
    const phase2Both = (roadmap) => ({ ...roadmap, phases: roadmap.phases.map((ph) => (ph.number === 2 ? { ...ph, modules: ['lib', 'service'] } : ph)) });
    const J = await toConformancePublished(fx, {
      mode: 'scoped',
      policy: { alpha_deploy: 'manual' },
      spec: retrofitSpecText({ requirements: SUMS_REQS.map((r) => (r.key === 'R1' ? { ...r, descriptive: true, phase: 2 } : r)) }),
      answers: { R2: 'confirm', R3: 'confirm', R4: 'defect' },
      architect: { roadmap: phase2Both(roadmapJson({ phase1: ['R2', 'R3'], phase2: ['R1', 'R4'] })), stages: [conformanceStage({ implements: ['R2', 'R3'], modules: ['service'] })] },
    });
    await omit(fx, ids);
    const done = await completeConformance(fx, J);
    await passAlphaBarrier(fx, done, { max: 20 }).catch(() => null);
    await advance(fx, J.ctx, () => (playsOf(fx, J.p.id, 'replan').length > 0 ? true : undefined), { what: 'the replan to play', max: 20 }).catch(() => null);
    await omit(fx, []);
    return { play: playsOf(fx, J.p.id, 'replan')[0] ?? null, requests: rows(fx.home, 'SELECT "id", "source" FROM "spec_change_requests" WHERE "project" = ?', J.p.id) };
  };

  test('(b) control and omission: the fake requests R1\'s criteria in the block\'s form and the engine records the request; without the block, no request, and the rehearsal fails naming it', async (t) => {
    const control = await replan(t, []);
    assert.ok(control.play, 'the replan played');
    assert.ok('architect.spec_change_requests' in (control.play.blocks ?? {}), 'the replan_retrofit package carries architect.spec_change_requests');
    assert.deepEqual(judgeReplanRetrofit(control.play.result, control.play.blocks, ['R1']), [], 'the control requests R1\'s criteria');
    assert.ok(control.requests.length >= 1, `the engine records the replan's request (${show(control.requests)})`);
    const omitted = await replan(t, ['architect.spec_change_requests']);
    assert.ok(omitted.play && !('architect.spec_change_requests' in (omitted.play.blocks ?? {})), 'no block in the package');
    assert.ok(named(judgeReplanRetrofit(omitted.play.result, control.play.blocks, ['R1'])).includes('architect.spec_change_requests'), 'the judgement names it');
    assert.equal(omitted.requests.length, 0, `the engine records no request (${show(omitted.requests)})`);
  });
});
