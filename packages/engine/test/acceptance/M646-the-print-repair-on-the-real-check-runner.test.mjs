// M646, the print repair on the real check runner (the owner's M7 plan §3j,
// row M646; DECISIONS item 57, Sean's acceptance ask of 2026-11-26: "Exercise
// the actual print-label defect: show candidate review detects it, an
// authorized repair corrects it, and the first printed page names the unit
// before the diagrams."). Sandbox lane, M223's: the engine's own check
// runner executes the fixture's `node` commands in check domains; slice 50.
// The slice plan §A M646, §D.3. The kernel file
// (M646-the-maintenance-job-replayed) replays the job and counts; this file
// shows the same repair under the engine's runner.
//
// The fixture (harness/wcp, README.md): one project with iteration 2's R5
// checks (accept-r5-1 to accept-r5-5 and the scripts under .surety/checks/run,
// as a88fa57 has them; protected-policy.json rewritten to the engine's own
// node) and the Verifier's check correction added (accept-r5-5-print and its
// scenario, harness/wcp/tightened/: the approved node command,
// check-scenario.mjs, covers R5.5). A Builder's stage writes a88fa57's code
// (candidate 2 of production, the print defect), and a fix writes
// 1d32e51's styles.css (candidate 3, the print fix).
// (a) accept-r5-5-print fails on a88fa57 (the runner's own exit, 1, the two
//     print-order assertions failing in its output) and passes on 1d32e51;
//     the stage gate on a88fa57 names it CHECK_NOT_PASSED;
// (b) WCP's own accept-r5-5 passes on both (recorded as non-regression
//     only: it never discriminated the defect);
// (c) accept-r5-1 to accept-r5-4 pass on both candidates;
// (d) the print order, asserted directly over the print-visible text of
//     each tree with the saved two-board plan loaded: the unit statement
//     precedes the first board diagram on 1d32e51 and follows it on a88fa57,
//     in millimetres and in inches;
// (e) the walkthrough's facts on 1d32e51 (workshop-cut-planner-walkthrough.md
//     l.53, l.93), read directly: boards of 1,000 mm and 500 mm with offcuts
//     of 194 mm and 97 mm; in inches 39.37 in and 15.748 in; a refresh in
//     inches keeps the unit and the layout; switching back restores 1,000 mm,
//     500 mm, 194 mm and 97 mm.
//
// SAFETY: WCP's own check scripts only (its DOM and CSS, no browser, no
// network), run by the engine's runner in its domains or by this process on
// copies of the trees under its TMPDIR; no kill or signal instrument.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { outputText, checkProject, executionsOf, installIndexedPlan, qualifyRunnerByFixture, resultRow } from './harness/checks/fixtures.mjs';
import { waitFor } from './harness/engine.mjs';
import { reasonSubjects, sharedFixture, stageGate } from './harness/gates.mjs';
import { addItem, pinStep, roleThat, runToEnd, waitForCandidates } from './harness/gitruns.mjs';
import { changePolicy } from './harness/journal.mjs';
import { runsOf, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { PRINT_CHECK, REV, checksOf, codeAt, delta, materialize, printOrder, walkthrough } from './harness/wcp/index.mjs';

const R5 = ['accept-r5-1', 'accept-r5-2', 'accept-r5-3', 'accept-r5-4', 'accept-r5-5', PRINT_CHECK];
const show = (v) => JSON.stringify(v);

// Iteration 2's R5 checks and the correction: their definitions, every script under run/, the governed file.
function r5Checks() {
  const all = checksOf(2, { tightened: true });
  return Object.fromEntries(Object.entries(all).filter(([p]) => !p.startsWith('.surety/checks/defs/') || R5.some((k) => p === `.surety/checks/defs/${k}.json`)).filter(([p]) => !p.startsWith('.surety/checks/post-deploy/')));
}
// As checks/fixtures.mjs waitRecorded, with room for six page-driving checks
// run one after another in check domains (its 60 s is not enough for them).
const waitRecorded = (fx, project, candidate, keys, { what }) =>
  waitFor(
    async () => {
      const latest = {};
      for (const x of executionsOf(fx.home, candidate)) if (keys.includes(x.key)) latest[x.key] = x;
      if (keys.every((k) => latest[k]?.status === 'recorded' && latest[k]?.result)) return latest;
      await tick(fx.engine, project, { rounds: 1 });
      return undefined;
    },
    { intervalMs: 500, timeoutMs: 600_000, what },
  );
const writes = (files) => Object.entries(files).filter(([, c]) => c !== null).map(([p, c]) => step.write(p, c));

// One project: the stage writes a88fa57's code, then a fix writes 1d32e51's.
async function project(fx, name, code) {
  const p = await pinStep(fx, await checkProject(fx, { files: r5Checks(), tier: 'T1', name }));
  // As M223: a failing acceptance check while the fix verifies would send it
  // back to its Builder; this row is about the runner's judgment, so every
  // candidate keeps its commit (repair_attempts_max 0 before the build).
  await changePolicy(fx.engine, p.id, { repair_attempts_max: 0 });
  const plan = await installIndexedPlan(fx.engine, p.id, { index: [{ key: 'R5', criteria: ['R5.1', 'R5.2', 'R5.3', 'R5.4', 'R5.5'] }], stages: [{ number: 1, goal: 'print a cut sheet', implements: ['R5'] }] });
  const [stage] = plan.stages;
  fx.scripted.script(stage.work_item, [roleThat(writes(code.a88), { nominate: true })]);
  const build = await runToEnd(fx, p.id, stage.work_item);
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `${name}: the Builder's stage was accepted (${build.reason_text})`);
  const [c2] = await waitForCandidates(fx, p.id);
  const onC2 = await waitRecorded(fx, p.id, c2.id, R5, { what: `${name}: the R5 checks on a88fa57` });
  const gate = await stageGate(fx, { project: p, stage: stage.id }, c2);
  const fix = await addItem(fx, p.id, 'fix');
  fx.scripted.script(fix, [roleThat(writes(code.fix), { nominate: true })]);
  await tickUntil(fx.engine, p.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: `${name}: the fix to be built` });
  const c3 = (await waitForCandidates(fx, p.id, 2)).at(-1);
  const onC3 = await waitRecorded(fx, p.id, c3.id, R5, { what: `${name}: the R5 checks on 1d32e51` });
  const judged = (rec) => Object.fromEntries(R5.map((k) => {
    const r = resultRow(fx.home, rec[k].result);
    return [k, { established: r.execution_established, exit: r.exit_status, out: outputText(fx.home, r), toolchain: rec[k].toolchain?.path ?? null }];
  }));
  return { p, c2, c3, gate, onC2: judged(onC2), onC3: judged(onC3), checkOf: onC2[PRINT_CHECK].check };
}

describe('M646 the print repair on the real check runner', () => {
  const shared = sharedFixture();
  const X = {};
  before(async () => {
    const scratch = join(process.env.TMPDIR ?? '/tmp', `m646s-${process.pid}`);
    mkdirSync(scratch, { recursive: true });
    const a88 = codeAt(REV.stage2, scratch);
    const fixed = codeAt(REV.fix, scratch);
    const code = { a88, fix: delta(a88, fixed) };
    // (d), (e): the trees alone, read directly.
    X.direct = {};
    for (const [name, c] of [['a88fa57', a88], ['1d32e51', fixed]]) {
      const dir = materialize(join(scratch, `direct-${name}`), c, checksOf(2));
      X.direct[name] = { print: printOrder(dir), walk: walkthrough(dir) };
    }
    const fx = await sandboxEngine(shared.context, { config: { terminate_grace: 3, kill_grace: 2 } });
    await qualifyRunnerByFixture(fx.engine);
    X.fx = fx;
    X.wcp = await project(fx, 'wcp', code);
  });
  after(shared.cleanup);

  test('(a) accept-r5-5-print fails on a88fa57 with the runner\'s exit 1, the print-order assertions failing, and the stage gate names it; it passes on 1d32e51', () => {
    const { onC2, onC3, gate, checkOf } = X.wcp;
    const a = onC2[PRINT_CHECK];
    assert.equal(a.toolchain, process.execPath, "the engine's own node ran it");
    assert.match(a.out, /R5\.5: with the saved two-board plan/, `the fixture is live: WCP's check-scenario ran the correction's scenario in the domain (${a.out.slice(0, 300)})`);
    assert.deepEqual([a.established, a.exit], [1, 1], `on a88fa57: failed, exit 1 (${a.out.slice(-1200)})`);
    const fails = a.out.split('\n').filter((l) => /^\s+FAIL /.test(l));
    assert.deepEqual(fails.map((l) => l.trim()), ['FAIL the printed page names the unit (millimetres) before the first board diagram', 'FAIL the printed page names the unit (inches) before the first board diagram'], 'the two print-order assertions are what failed');
    assert.ok(reasonSubjects(gate, 'CHECK_NOT_PASSED').includes(checkOf), `the stage gate on a88fa57 is not satisfied: CHECK_NOT_PASSED names accept-r5-5-print (${show(gate.reasons ?? gate)})`);
    const b = onC3[PRINT_CHECK];
    assert.deepEqual([b.established, b.exit], [1, 0], `on 1d32e51: passed, exit 0 (${b.out.slice(-600)})`);
    assert.match(b.out, /R5\.5: passed \(\d+ assertions\)/, 'every assertion held');
  });

  test('(b) WCP\'s own accept-r5-5 passes on a88fa57 and on 1d32e51 (non-regression only: it never saw the defect)', () => {
    const { onC2, onC3 } = X.wcp;
    for (const [rev, on] of [['a88fa57', onC2], ['1d32e51', onC3]]) {
      const r = on['accept-r5-5'];
      assert.deepEqual([r.established, r.exit], [1, 0], `accept-r5-5 on ${rev}: exit 0 (${r.out.slice(-600)})`);
      assert.match(r.out, /R5\.5: passed \(21 assertions\)/, `its 21 assertions on ${rev}`);
    }
  });

  test('(c) accept-r5-1 to accept-r5-4 pass on both candidates', () => {
    for (const [rev, on] of [['a88fa57', X.wcp.onC2], ['1d32e51', X.wcp.onC3]]) {
      for (const k of R5.slice(0, 4)) assert.deepEqual([on[k].established, on[k].exit], [1, 0], `${k} on ${rev} (${on[k].out.slice(-400)})`);
    }
  });

  test('(d) with the saved two-board plan, the first printed page names the unit before the first board diagram on 1d32e51, and after it on a88fa57 (millimetres and inches)', () => {
    for (const unit of ['mm', 'in']) {
      const bad = X.direct.a88fa57.print[unit];
      const good = X.direct['1d32e51'].print[unit];
      assert.equal(good.diagrams, 2, 'two board diagrams');
      assert.ok(bad.diagramAt >= 0 && bad.unitAt > bad.diagramAt, `a88fa57 (${unit}): the unit only after the first diagram (unit ${bad.unitAt}, diagram ${bad.diagramAt}): ${bad.text.slice(0, 300)}`);
      assert.ok(good.unitAt >= 0 && good.unitAt < good.diagramAt, `1d32e51 (${unit}): the unit before the first diagram (unit ${good.unitAt}, diagram ${good.diagramAt}): ${good.text.slice(0, 300)}`);
    }
  });

  test('(e) the walkthrough\'s facts on 1d32e51: 1,000 mm and 500 mm boards with 194 mm and 97 mm offcuts; 39.37 in and 15.748 in; a refresh in inches keeps unit and layout; back to millimetres restores them', () => {
    const { opened, reloaded } = X.direct['1d32e51'].walk;
    const facts = (v) => v.boards.map((b) => [b.caption, b.segments.filter((s) => s.kind === 'offcut').map((s) => s.lengthMm), b.segments.filter((s) => s.kind === 'piece').map((s) => s.lengthMm)]);
    assert.deepEqual(facts(opened.mm), [['Board 1 · 1000 mm', [194], [400, 400]], ['Board 2 · 500 mm', [97], [400]]], `the saved plan opened (${show(facts(opened.mm))})`);
    assert.equal(opened.in.unit, 'in');
    assert.deepEqual(opened.in.boards.map((b) => b.caption), ['Board 1 · 39.37 in', 'Board 2 · 19.685 in'], 'the 1,000 mm board as 39.37 in');
    assert.ok(opened.in.boards[0].segments.filter((s) => s.kind === 'piece').every((s) => /15\.748 in/.test(s.text)), `the 400 mm pieces as 15.748 in (${show(opened.in.boards[0].segments)})`);
    assert.equal(reloaded.reloaded.unit, 'in', 'a refresh in inches keeps inches');
    assert.deepEqual(facts(reloaded.reloaded), [['Board 1 · 39.37 in', [194], [400, 400]], ['Board 2 · 19.685 in', [97], [400]]], 'and the layout (placement preserved, millimetres underneath)');
    assert.deepEqual(facts(reloaded.back), [['Board 1 · 1000 mm', [194], [400, 400]], ['Board 2 · 500 mm', [97], [400]]], 'switching back restores 1,000 mm, 500 mm, 194 mm and 97 mm');
    assert.ok(reloaded.back.boards.every((b) => b.segments.some((s) => s.kind === 'offcut' && /Offcut (194|97) mm/.test(s.text))), 'the offcuts read 194 mm and 97 mm');
  });
});
