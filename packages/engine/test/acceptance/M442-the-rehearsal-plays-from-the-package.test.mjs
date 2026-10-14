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
// Not here: the retrofit packages' own elements (`spec_writer.claims_table`,
// `verifier.adoption_rule`), which the retrofit rehearsal of M444 reads
// (SEAM.md §456); the parts of a product only an execution reads (a check's
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
import {
  SPEC_WORDS,
  alphaConfigured,
  architectTurn,
  contextOf,
  fakeEngine,
  fakeSession,
  judgeArchitect,
  judgeAuthoring,
  judgeBuilder,
  judgeSpec,
  lastPlay,
  named,
  omit,
  publishedPaused,
  resume,
  specApproved,
  wholeElements,
} from './harness/real/kernel-rehearsal.mjs';
import { tallyBrief } from './harness/real/rehearsal-content.mjs';
import { createWithIdea, JOURNEY_POLICY } from './harness/journey/drive.mjs';
import { pauseProject } from './harness/runs.mjs';

const show = (v) => JSON.stringify(v)?.slice(0, 1500);
const blocking = (findings) => (findings ?? []).map((f) => f.code);
const playsOf = (fx, project, kind) => fx.scripted.fakePlays().filter((e) => e.launch?.project === project && e.launch?.work_kind === kind);

// The engine's reaction a spec element's omission must draw at the save (the
// kernel lane's parse at save), where it draws one.
const SPEC_ENGINE = Object.freeze({
  'spec_writer.header_fields': /header/,
  'spec_writer.requirement_form': /./,
  'spec_writer.marks': /uncertain|mark/,
  'spec_writer.index_columns': /index/,
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
      assert.ok(named(judgeArchitect(c.play.written ?? {}, A.W, { adrs: ['ADR-001'] })).includes(id), `the judgement names ${id} (${show(judgeArchitect(c.play.written ?? {}, A.W, { adrs: ['ADR-001'] }))})`);
      if (id === 'architect.routing') {
        assert.equal(c.close.status, 200, `the close raises the pair (→ ${c.close.status} ${c.close.text})`);
        assert.equal(c.check?.conformance, 'uncertain', `the plan check records the declared uncertainty (${show(c.check)})`);
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
