// M537 (b), (c), the rehearsal plays from the package (M6 slice 46; kernel
// lane). M6 plan §3.8 M537 (b), (c); BS6 §12 ("the fake Designer derives
// every file from the schemas, the conventions table, the catalogue, the
// mockup kinds per capability, the floor and the inventory its package
// states, and from nothing else; with one of those elements removed by
// harness override its product lacks it and the rehearsal fails there,
// naming it"), §4.1 rule 18; E135; SEAM.md §§453, 455, 537 to 539.
//
// The Designer is the package-driven fake (harness/standin/package-fakes.cjs,
// SEAM.md §539) on Pantry (harness/design/), its content `designerContent`
// (harness/design/packages46.mjs): colours, convention values, the criteria
// the owner wants with their paths, a library, a logo proposal; never a form.
// (b) For each of the Designer's nine elements (SEAM.md §538), omitted
//     (`POST /v1/harness/package-omit`, §453) from the package of one turn of
//     one session: the package the fake was given lacks it; the fake's
//     product lacks what it states and the rehearsal's judgement
//     (`judgeDesign`) fails naming it; where the save's design check reads
//     that part, the check refuses (the schemas, the contrast ratio, the
//     conventions, the layouts, the floor, the inventory). The control turn,
//     the package whole, passes the judgement and the check. Then
//     `verifier.design_catalogue` omitted from the design criteria's
//     correction: the correction fake writes no design check and the
//     judgement (`judgeDesignChecks`) names it.
// (c) The packages whole, on a project of its own: the Designer fake's design
//     passes its check at save and close, the batch is approved, the
//     correction fake writes a check covering each design criterion from
//     `verifier.design_catalogue` alone, the design becomes ready and the UI
//     stages are dispatched. A rehearsal is never evidence: nothing here is
//     counted for a real row.
// Not here: what only a model or an execution shows (BS6 §8's limits): the
// fake's design is the test's, so a pass proves the engine's packages and
// handling, never that a model draws an approvable design.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { journeyContext, pump } from './harness/journey/drive.mjs';
import { FAKE, lastPlay, omit, wholeElements } from './harness/real/kernel-rehearsal.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { sayAndSettle, scriptTurns } from './harness/sessions.mjs';
import { postCloseRaw, postSaveRaw } from './harness/session-lane.mjs';
import { DESIGNER_ELEMENTS, designerContent, judgeDesign, judgeDesignChecks } from './harness/design/packages46.mjs';
import { ANDROID_LOGO_PATH, REQUIREMENTS, WEB_LOGO_PATH } from './harness/design/reference.mjs';
import { KERNEL_KINDS, approvedRevision, assertPassed, codesIn } from './harness/design/check41.mjs';
import { batchSpec } from './harness/design/plan44.mjs';
import { answerWith, batchOf, designScripts, openDesigner, scriptBuilders, specChangeScriptFor, stageWork, toPublished } from './harness/design/drive.mjs';

const POLICY = Object.freeze({ design: 'before_build', autonomy: 'phase', phase_size: { min: 1, max: 5 } });
// The criteria the owner wants (content): the last is a CSS kind on a
// react_native target, which the catalogue does not apply.
const PANTRY_CRITERIA = Object.freeze([
  { target: 'web', kind: 'tokens_only', paths: ['web/app.css', 'web/tokens.css'] },
  { target: 'web', kind: 'asset_parity', paths: [WEB_LOGO_PATH], slot: 'logo', variant: 'full' },
  { target: 'android', kind: 'asset_parity', paths: [ANDROID_LOGO_PATH], slot: 'logo', variant: 'full' },
  { target: 'android', kind: 'tokens_only', paths: ['mobile/App.js'] },
]);
const CONTENT = Object.freeze({
  design: designerContent({ name: 'Pantry', criteria: PANTRY_CRITERIA }),
  design_checks: {
    tokens_only: '// {{criterion}}: every literal in {{path0}} is a token\nprocess.exit(0);\n',
    asset_parity: '// {{criterion}}: {{path0}} equals the effective {{slot}} ({{variant}})\nprocess.exit(0);\n',
  },
});
// Where the save's design check reads what an element states, its refusal.
const ENGINE = Object.freeze({
  'designer.inventory': /DESIGN_SCHEMA_INVALID|DESIGN_INVENTORY_STALE|DESIGN_REQUIREMENT_UNCOVERED/,
  'designer.schemas': /DESIGN_SCHEMA_INVALID/,
  'designer.check_reasons': /DESIGN_CONTRAST_BELOW_AA/,
  'designer.conventions': /DESIGN_CONVENTION_UNDECLARED|DESIGN_SCHEMA_INVALID/,
  'designer.layouts': /DESIGN_LAYOUT_UNCOVERED|DESIGN_SCHEMA_INVALID|DESIGN_SELECTION_BELOW_FLOOR/,
  'designer.selection_floor': /DESIGN_SELECTION_BELOW_FLOOR|DESIGN_SCHEMA_INVALID/,
});
const show = (v) => JSON.stringify(v)?.slice(0, 1500);
const DESIGN = '.surety/design/';
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
// The fake's criteria.json, as written by the play, for the batch's spec change.
const criteriaOf = (play) => parse(play?.written?.[`${DESIGN}criteria.json`] ?? 'null') ?? { criteria: [], human_tests: [] };

// The kernel fixture: Pantry published, the scripted roles of the journey,
// the Designer and the correction played by the fakes on CONTENT.
async function fakeDesignEngine(t, name) {
  const fx = await scriptedEngine(t);
  fx.scripted.packageFakes(CONTENT);
  const { p } = await toPublished(fx, { policy: POLICY, name });
  designScripts(fx);
  fx.scripted.kindScript('check_correction', FAKE);
  scriptBuilders(fx, p.id);
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  return { fx, p, ctx };
}

describe('M537 (b) the Designer fake under its package with one element omitted', () => {
  const shared = sharedFixture();
  const S = { cases: {} };
  before(async () => {
    const { fx, p, ctx } = await fakeDesignEngine(shared.context, 'pantry-m537b');
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, Array.from({ length: 16 }, () => FAKE));
    const turn = async (words) => {
      await sayAndSettle(fx, p.id, run.id, words);
      const saved = { res: await postSaveRaw(fx, p.id, run.id) };
      return { play: lastPlay(fx, { run: run.id }), saved };
    };
    S.control = await turn('Draw Pantry for the web and Android.');
    for (const id of DESIGNER_ELEMENTS) {
      await omit(fx, [id]);
      S.cases[id] = await turn('Draw it again, from what you were given.');
      await omit(fx, []);
    }
    S.W = wholeElements(fx);
    // The whole design again, saved and closed; the batch's Spec Writer writes its criteria.
    const last = await turn('Draw it again, whole.');
    fx.scripted.kindScript('spec_change', specChangeScriptFor(batchSpec({ base: REQUIREMENTS, criteria: criteriaOf(last.play) })));
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    S.closed = closed;
    if (closed.status === 200) {
      const batch = await pump(fx, ctx, () => {
        const b = batchOf(fx.home, p.id);
        return b?.spec_change ? b : undefined;
      }, { what: 'the batch', max: 40 });
      // verifier.design_catalogue omitted from the correction the approval registers.
      await omit(fx, ['verifier.design_catalogue']);
      const a = await answerWith(fx, p.id, batch.design_approval, 'approve');
      assert.equal(a.status, 200, `design_approval answered approve (${a.text})`);
      await consume(fx, p.id, batch.spec_change, 'approve');
      S.correction = await pump(fx, ctx, () => fx.scripted.fakePlays().find((e) => e.launch?.work_kind === 'check_correction' && e.launch?.project === p.id) ?? fx.scripted.fakePlays().find((e) => e.kind === 'check_correction') ?? undefined, { what: 'the design criteria\'s correction to be played', max: 60 }).catch((err) => ({ error: String(err) }));
      await omit(fx, []);
      S.Wv = wholeElements(fx);
    }
  });
  after(shared.cleanup);

  test('(b) control: with the package whole, the fake\'s design passes the judgement and the save\'s design check', () => {
    assert.ok(S.control.play?.written, `the fake played the turn (${show(S.control)})`);
    assert.deepEqual(judgeDesign(S.control.play.written, S.W, CONTENT.design), [], 'the judgement of the whole package\'s product');
    assertPassed(S.control.saved?.res, 'the control\'s save');
  });

  for (const id of DESIGNER_ELEMENTS) {
    test(`(b) ${id} omitted: the package lacks it, the design lacks it, the rehearsal fails naming it${ENGINE[id] ? ', and the save\'s check refuses' : ''}`, () => {
      const c = S.cases[id];
      assert.ok(c?.play, `the fake played the turn (${show(c)})`);
      assert.ok(!(id in (c.play.blocks ?? {})), `the package the fake was given has no ${id} block (${Object.keys(c.play.blocks ?? {}).join(', ')})`);
      const failed = judgeDesign(c.play.written ?? {}, S.W, CONTENT.design);
      assert.ok(failed.some((f) => f.element === id), `the judgement names ${id} (it named ${show(failed)})`);
      if (ENGINE[id]) {
        const codes = codesIn(c.saved?.res);
        assert.ok(codes.some((code) => ENGINE[id].test(code)), `the save's design check refuses (${ENGINE[id]}) (got ${show(codes)})`);
      }
    });
  }

  test('(b) verifier.design_catalogue omitted from the correction: the package lacks it, no design check is written, the rehearsal fails naming it', () => {
    assert.equal(S.closed?.status, 200, `the whole design closed and raised its batch (${S.closed?.text?.slice(0, 600)})`);
    const play = S.correction;
    assert.ok(play && !play.error, `the correction was played by the fake (${show(play)})`);
    assert.ok(!('verifier.design_catalogue' in (play.blocks ?? {})), 'the correction\'s package has no verifier.design_catalogue block');
    const failed = judgeDesignChecks(play.written ?? {}, S.Wv);
    assert.ok(failed.some((f) => f.element === 'verifier.design_catalogue'), `the judgement names verifier.design_catalogue (${show(failed)})`);
  });
});

describe('M537 (c) the rehearsal with the packages whole: the Designer and the correction played by the fakes', () => {
  const shared = sharedFixture();
  const C = {};
  before(async () => {
    const { fx, p, ctx } = await fakeDesignEngine(shared.context, 'pantry-m537c');
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, Array.from({ length: 4 }, () => FAKE));
    await sayAndSettle(fx, p.id, run.id, 'Draw Pantry for the web and Android.');
    C.saved = { res: await postSaveRaw(fx, p.id, run.id) };
    C.play = lastPlay(fx, { run: run.id });
    fx.scripted.kindScript('spec_change', specChangeScriptFor(batchSpec({ base: REQUIREMENTS, criteria: criteriaOf(C.play) })));
    C.closed = await postCloseRaw(fx, p.id, run.id, {});
    if (C.closed.status !== 200) return;
    const batch = await pump(fx, ctx, () => {
      const b = batchOf(fx.home, p.id);
      return b?.spec_change ? b : undefined;
    }, { what: 'the batch', max: 40 });
    const a = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.equal(a.status, 200, `design_approval answered approve (${a.text})`);
    await consume(fx, p.id, batch.spec_change, 'approve');
    C.ready = await pump(fx, ctx, () => approvedRevision(fx.home, p.id)?.ready_at ?? undefined, { what: 'the design ready on the covering protected version', max: 80 }).catch((err) => ({ error: String(err) }));
    C.correction = fx.scripted.fakePlays().find((e) => e.kind === 'check_correction') ?? null;
    C.uiLaunched = await pump(fx, ctx, () => ([2, 3].every((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n)?.id }).length > 0) ? true : undefined), { what: 'both UI stages dispatched', max: 80 }).catch((err) => ({ error: String(err) }));
    C.W = wholeElements(fx);
  });
  after(shared.cleanup);

  test('(c) the Designer fake\'s design passes the judgement, its check at save and the close; the batch is raised', () => {
    assert.ok(C.play?.written, `the fake played the turn (${show(C.play)})`);
    assert.deepEqual(judgeDesign(C.play.written, C.W, CONTENT.design), [], 'the judgement of the whole package\'s product');
    assertPassed(C.saved?.res, 'the save');
    assert.equal(C.closed?.status, 200, `the close is accepted and raises the batch (${C.closed?.text?.slice(0, 600)})`);
  });

  test('(c) the correction fake writes a check covering each design criterion from verifier.design_catalogue alone; the design becomes ready; the UI stages are dispatched', () => {
    assert.ok(C.correction?.written, `the correction was played by the fake (${show(C.correction)})`);
    assert.deepEqual(judgeDesignChecks(C.correction.written, C.W), [], 'the judgement of the correction\'s checks');
    assert.ok(C.ready && !C.ready.error, `design_ready set (${show(C.ready)})`);
    assert.equal(C.uiLaunched, true, `both UI stages dispatched (${show(C.uiLaunched)})`);
  });
});
