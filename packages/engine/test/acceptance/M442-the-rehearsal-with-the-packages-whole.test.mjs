// M442 (c), the rehearsal with the packages whole (M5 slice 38; kernel lane).
// M5 plan §3.8 M442 (c); E135; BS5 §12; SEAM.md §§453 to 455. Never evidence
// for M443 or M444: it shows the package-driven fakes carry the journey when
// nothing is omitted, so that M442 (b)'s failures are the omissions'.
//
// M401's journey (Tally, T2, `autonomy: phase`, `alpha_deploy:
// on_phase_complete`) with every role the package-driven fake
// (harness/standin/package-fakes.cjs): the owner's words typed through the
// session routes (the project brief, the architecture brief, CR-1), the
// owner's approvals answered (the specification, the architecture with the
// first plan, the toolchain's correction, the change), the scripted check
// boundary passing every check, the scripted adapter deploying. Then:
//   (c1) the journey reaches `alpha_deployed` through both phases and CR-1,
//        the owner's acts only those D6 §1 routes to him;
//   (c2) every product the fakes wrote passes the rehearsal's judgement
//        against what the whole package states: the specification, the
//        architecture and both plans, both phases' checks, every Builder's
//        code;
//   (c3) every package carried its elements (§454), and none was omitted.
// A play that threw (SEAM.md §548) is its own failure in (c2) and (c3),
// naming its error; its package's elements, logged before the play, are
// still judged in (c3), so an errored play never reads as a package with no
// elements.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { ROUTED_KINDS, alphaDeployed, blockers, buildActs, changeRequest, evaluationsOfKind, nextPhasePublished, phaseCompleted, runsOfProject } from './harness/journey/drive.mjs';
import { ARCHITECT_ELEMENTS, AUTHORING_ELEMENTS, BUILDER_ELEMENTS, PHASE_VERIFICATION_ELEMENTS, SPEC_CHANGE_ELEMENTS, SPEC_WRITER_ELEMENTS } from './harness/real/packages.mjs';
import { alphaConfigured, contextOf, fakeEngine, judgeArchitect, judgeAuthoring, judgeBuilder, judgePhaseVerification, judgeSpec, judgeSpecChange, publishedPaused, resume, specApproved, wholeElements } from './harness/real/kernel-rehearsal.mjs';
import { TALLY_CHANGE_TEXT, tallyBrief } from './harness/real/rehearsal-content.mjs';

const show = (v) => JSON.stringify(v)?.slice(0, 6000);
// A play that threw (SEAM.md §548), named by its kind, its run and the first line of its error.
const errored = (e) => ({ at: `${e.kind === 'session' ? e.role : e.launch?.work_kind ?? '?'} (${e.launch?.run ?? '?'})`, errored: String(e.error).split('\n')[0], package_error: e.package_error ?? null });

describe('M442 (c) the rehearsal with the packages whole: the journey on the package-driven fakes', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const fx = await fakeEngine(shared.context);
    const { p } = await specApproved(fx);
    await publishedPaused(fx, p);
    await alphaConfigured(fx, p, { answers: [{ result: 'issued', apply: true }, { result: 'issued', apply: true }] });
    await resume(fx, p);
    const ctx = contextOf(fx, p);
    J = { fx, p, ctx, steps: {} };
    try {
      J.steps.phase1 = await phaseCompleted(fx, ctx, 1);
      J.steps.phase2 = await nextPhasePublished(fx, ctx, 2);
      J.steps.change = await changeRequest(fx, ctx, { text: TALLY_CHANGE_TEXT });
      J.steps.phase2done = await phaseCompleted(fx, ctx, 2, { max: 200 });
      J.steps.deployed = await alphaDeployed(fx, ctx, { newest: true });
    } catch (err) {
      J.error = err;
      // What held the journey, for the failure's message.
      J.held = {
        blockers: blockers(fx.home, p.id),
        runs: runsOfProject(fx.home, p.id).map((r) => [r.kind, r.role, r.work_item, r.outcome, r.reason_class]),
        gates: ['stage', 'phase', 'alpha_authorize'].flatMap((k) => evaluationsOfKind(fx.home, p.id, k).slice(-3).map((e) => [k, e.outcome, e.reasons])),
      };
    }
    J.W = wholeElements(fx);
    J.plays = fx.scripted.fakePlays().filter((e) => e.launch?.project === p.id || e.launch === null);
  });
  after(shared.cleanup);

  test('(c1) the journey reaches alpha_deployed through both phases and CR-1, the owner\'s acts only those D6 §1 routes to him', () => {
    assert.equal(J.error, undefined, `the journey on the fakes went through (${J.error?.message}; what held it: ${show(J.held)})`);
    assert.equal(J.steps.deployed?.progress, 'alpha_deployed', 'the newest candidate is alpha_deployed');
    const kinds = buildActs(J.ctx).map((a) => a.kind);
    assert.deepEqual(kinds.filter((k) => !ROUTED_KINDS.includes(k) && k !== 'spec_change_request'), [], `no human act outside the routed kinds (${show(kinds)})`);
  });

  test('(c2) every product the fakes wrote passes the judgement against the whole package', () => {
    const failures = [];
    // A play that threw wrote no product: its error is the failure (SEAM.md §548).
    for (const e of J.plays.filter((x) => typeof x.error === 'string')) failures.push(errored(e));
    const by = (kind) => J.plays.filter((e) => typeof e.error !== 'string' && ((e.launch?.work_kind ?? null) === kind || (kind === 'session' && e.kind === 'session')));
    const brief = tallyBrief();
    for (const e of by('session').filter((x) => x.role === 'spec_writer' && x.written?.['.surety/spec/spec.md'])) failures.push(...judgeSpec(e.written['.surety/spec/spec.md'], { ...J.W, ...(e.blocks ?? {}) }, brief).map((f) => ({ ...f, at: 'spec session' })));
    for (const e of by('session').filter((x) => x.role === 'architect' && Object.keys(x.written ?? {}).length > 0)) failures.push(...judgeArchitect(e.written, { ...J.W, ...(e.blocks ?? {}) }, { adrs: ['ADR-001'] }).map((f) => ({ ...f, at: 'architect session' })));
    for (const e of by('replan')) failures.push(...judgeArchitect(e.written ?? {}, { ...J.W, ...(e.blocks ?? {}) }, { routing: 'replan' }).map((f) => ({ ...f, at: 'replan' })));
    by('check_authoring').forEach((e, i) => failures.push(...judgeAuthoring(e.written ?? {}, e.result, e.blocks ?? {}, { first: i === 0 }).map((f) => ({ ...f, at: `check_authoring ${i + 1}` }))));
    for (const e of by('spec_change')) failures.push(...judgeSpecChange(e.result, e.blocks ?? {}).map((f) => ({ ...f, at: 'spec_change' })));
    for (const e of by('phase_verification')) failures.push(...judgePhaseVerification(e.result, e.blocks ?? {}).map((f) => ({ ...f, at: 'phase_verification' })));
    for (const e of by('stage_build')) failures.push(...judgeBuilder(e.written ?? {}, e.result, e.blocks ?? {}).map((f) => ({ ...f, at: `stage ${e.blocks?.['builder.tasks']?.stage}` })));
    assert.ok(by('stage_build').length >= 4, `four Builders played (${by('stage_build').length})`);
    assert.deepEqual(failures, [], 'the rehearsal\'s judgement of every product');
  });

  test('(c3) every package the fakes read carried its elements, none omitted', () => {
    const missing = [];
    const want = { spec_writer: SPEC_WRITER_ELEMENTS, architect: ARCHITECT_ELEMENTS, replan: ARCHITECT_ELEMENTS, check_authoring: AUTHORING_ELEMENTS, stage_build: BUILDER_ELEMENTS, spec_change: SPEC_CHANGE_ELEMENTS, phase_verification: PHASE_VERIFICATION_ELEMENTS };
    const errors = [];
    for (const e of J.plays) {
      const key = e.kind === 'session' ? e.role : e.launch?.work_kind;
      if (typeof e.error === 'string') errors.push(errored(e));
      // A package the play could not read has no elements to judge: its error says so.
      if (e.blocks === null && typeof e.error === 'string') continue;
      for (const id of want[key] ?? []) if (!(id in (e.blocks ?? {}))) missing.push(`${key} (${e.launch?.run ?? '?'}): ${id}`);
    }
    assert.deepEqual(errors, [], 'no play errored (each named with its error)');
    assert.deepEqual(missing, []);
  });
});
