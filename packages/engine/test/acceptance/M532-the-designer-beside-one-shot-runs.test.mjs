// M532, G12: the Designer beside one-shot runs (slice 41; kernel lane,
// MemAvailable scripted). M6 plan §3.3 M532; D7 §3.1; G12; Q5; D1 §7.5;
// E147 item 4's M2 for the other roles; D6-S08 (M419); SEAM.md §§438, 483,
// 492, 531.
//
// (a) a Designer session open, a Builder of the same project eligible:
//     dispatched, each (the Builder, the Designer's turn) admitted by the
//     envelope as a `role` domain at `role_memory_max`;
// (b) a Designer session opened while a Builder runs: opened;
// (c) a Builder's integration and a Designer save in either order; a
//     Designer save behind the base: serialized on the integration lease,
//     the save rebased and re-validated (D1 §7.5), its disjoint paths
//     applying without conflict;
// (d) a Vision, Spec Writer or Architect session opened beside the
//     Designer: `session_busy` each; a second Designer session:
//     `session_busy`; a Spec Writer session's save on a moved head: refused
//     `integration_conflict` as built (E147 item 4);
// (e) an approved spec change re-deriving the inventory under the open
//     session: the next save refused DESIGN_INVENTORY_STALE, the role told
//     in the engine's entry;
// (f) a one-shot's package while a Designer checkpoint newer than the
//     approved revision exists (its session still open): the approved
//     design only;
// (g) M419's cases for the other roles: unchanged, on a project under
//     `design` too.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { GIB, domainOfItem, setEnvelope } from './harness/exec37/envelope.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { governedEdit, humanApplies } from './harness/gates.mjs';
import { roleThat, roleThatHolds } from './harness/gitruns.mjs';
import { getPolicy } from './harness/journal.mjs';
import { pump, workOf } from './harness/journey/drive.mjs';
import { specReady } from './harness/journey/plan35.mjs';
import { SPEC as TALLY_SPEC } from './harness/journey/reference.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { SPEC_PATH } from './harness/journey/spec34.mjs';
import { fileAt, gitQuiet, parentsOf, refOid } from './harness/repos.mjs';
import { addWork, runsOf, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { domainsOfRun, pauseAt, postCloseRaw, postSaveRaw, reached, release } from './harness/session-lane.mjs';
import { openSession, postTurn, readSession, runRow, sayAndSettle, scriptTurns, turnResult, turnThatWrites } from './harness/sessions.mjs';
import { REQUIREMENTS, TOKENS, specText } from './harness/design/reference.mjs';
import {
  createPantry,
  designerSession,
  dumpedPackage,
  gitText,
  inventoryOf,
  openDesigner,
  openOfKind,
  pantrySpec,
  scriptBuilders,
  stageWork,
  toPublished,
  validDesign,
} from './harness/design/drive.mjs';
import { BEFORE_BUILD, approveBatch, designModel, designTurnOf, engineEntryText, scriptVariant, untilBatch } from './harness/design/check41.mjs';

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const sessionsOf = (project) => `/v1/projects/${project}/sessions`;
const talk = (reply) => ({ steps: [step.result(turnResult({ reply }))] });
const SAVE_REBASE = 'design.save_rebase';
const endedRun = (fx, project, item, what) => tickUntil(fx.engine, project, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { max: 20, what });
const heldFor = (fx, project, item) => {
  const row = workOf(fx.home, project).find((w) => w.id === item);
  return JSON.stringify({ held: row?.held ?? null, blocker: row?.blocker ?? null, status: row?.status });
};

async function pantry(t, name) {
  const fx = await scriptedEngine(t);
  const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name });
  const ctx = scriptVariant(fx, p);
  return { fx, p, ctx, model: designModel(inventoryOf(p)) };
}
// A one-shot Builder (a `fix`) that holds once launched.
async function heldBuilder(fx, project, before = []) {
  const item = await addWork(fx.engine, project, 'fix');
  fx.scripted.script(item, [roleThatHolds(before)]);
  return item;
}
// The held Builder's launch, in M419 (d)'s form: one tick, then wait for the
// launch itself, never for every run of the project to end (the Builder holds
// until the case releases it; objection 155; SEAM.md §531).
const launched = async (fx, project, item, what) => {
  await tick(fx.engine, project, { rounds: 1 });
  return waitFor(() => fx.scripted.launches({ work_item: item })[0], { what }).catch((err) => {
    throw new Error(`${err.message}; the item: ${heldFor(fx, project, item)}`);
  });
};
// A Designer turn said beside a held Builder: poll that turn's settlement and
// tick between polls, never waiting for the held Builder to end (objection 155;
// SEAM.md §531). Asserts what `sayAndSettle` asserts.
const TURN_ENDED = Object.freeze(['settled', 'failed', 'unknown']);
async function sayBeside(fx, project, run, text, { max = 12 } = {}) {
  const posted = await postTurn(fx, project, run, text);
  const what = `turn ${posted.turn} of ${run} to settle beside the held Builder`;
  const ended = async () => {
    const read = await readSession(fx, project, run);
    const turn = (read.turns ?? []).find((x) => x.turn === posted.turn);
    return (turn && TURN_ENDED.includes(turn.state)) || read.run?.state === 'ended' ? { read, turn } : undefined;
  };
  for (let i = 0; i < max; i++) {
    await tick(fx.engine, project, { rounds: 1 });
    const done = await waitFor(ended, { timeoutMs: 2_000, what }).catch(() => undefined);
    if (!done) continue;
    assert.equal(done.turn?.state, 'settled', `turn ${posted.turn} settled (${JSON.stringify(done.turn ?? done.read.run)})`);
    assert.equal(done.read.run.session_state, 'open_idle', 'the session is idle again');
    return done;
  }
  throw new Error(`${what} was not reached after ${max} ticks`);
}

describe('M532 G12, the Designer beside one-shot runs', () => {
  test('(a) a Builder dispatched beside an open Designer session, each admitted as a role domain at role_memory_max; (b) a Designer session opened while a Builder runs', async (t) => {
    const { fx, p } = await pantry(t);
    await setEnvelope(fx, { mem_available: 64 * GIB, default_current: 0 });
    const roleMax = (await getPolicy(fx.engine, p.id)).effective.role_memory_max;
    assert.ok(roleMax > 0, `the project's role_memory_max is read (${roleMax})`);
    // (a)
    const run = await openDesigner(fx, p.id);
    const item = await heldBuilder(fx, p.id);
    await launched(fx, p.id, item, 'the Builder dispatched beside the open Designer session');
    const builderDomain = await waitFor(() => domainOfItem(fx.home, item), { what: 'the Builder\'s domain' });
    assert.deepEqual([builderDomain.profile, builderDomain.memory_max], ['role', roleMax], `the Builder admitted as a role domain at role_memory_max (${JSON.stringify(builderDomain)})`);
    scriptTurns(fx, run.id, [talk('Looking at the inventory.')]);
    await sayBeside(fx, p.id, run.id, 'Start while the Builder works.');
    const [turnDomain] = domainsOfRun(fx.home, run.id);
    assert.deepEqual([turnDomain?.profile, turnDomain?.memory_max], ['role', roleMax], `the Designer's turn admitted as a role domain at role_memory_max (${JSON.stringify(turnDomain)})`);
    fx.scripted.release(item, 'gate');
    await endedRun(fx, p.id, item, 'the Builder to end');
    assert.equal((await postCloseRaw(fx, p.id, run.id, { refuse: true })).status, 200, 'the Designer session closed');
    // (b)
    const second = await heldBuilder(fx, p.id);
    await launched(fx, p.id, second, 'the second Builder to run');
    const res = await fx.engine.post(sessionsOf(p.id), { role: 'designer' });
    assert.equal(res.status, 201, `a Designer session opens while a Builder runs (→ ${res.status} ${res.text})`);
    scriptTurns(fx, res.body.run.id, [talk('Hello.')]);
    await sayBeside(fx, p.id, res.body.run.id, 'Hello.');
    fx.scripted.release(second, 'gate');
    await endedRun(fx, p.id, second, 'the second Builder to end');
  });

  test('(c) a Builder\'s integration and a Designer save in either order: the save behind the base rebased and re-validated, the disjoint paths applied, history linear', async (t) => {
    const { fx, p, model } = await pantry(t);
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [designTurnOf(model), { steps: [step.write('.surety/design/design.md', '# Pantry: design\n\nA second note.\n'), step.result(turnResult({ reply: 'A note.', artifact_changed: true }))] }, talk('Done.')]);
    // Order 1: the Builder integrates first; the Designer's save is behind the base.
    await sayAndSettle(fx, p.id, run.id, 'Draw Pantry.');
    const base = refOid(p.repo.path, p.repo.ref);
    const first = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(first, [roleThat([step.write('notes/builder-1.md', 'The first Builder\'s note.\n')])]);
    const ended = await endedRun(fx, p.id, first, 'the first Builder to integrate beside the session');
    assert.equal(ended.outcome, 'completed', `the Builder integrated (${ended.reason_text})`);
    const moved = refOid(p.repo.path, p.repo.ref);
    assert.notEqual(moved, base, 'the fixture is live: the head moved under the session');
    await pauseAt(fx, SAVE_REBASE);
    const saving = postSaveRaw(fx, p.id, run.id);
    await reached(fx, SAVE_REBASE, 'the Designer save behind the base, before its rebase (SEAM.md §492)');
    await release(fx, SAVE_REBASE);
    const saved = await saving;
    assert.equal(saved.status, 200, `the save behind the base is rebased, not refused (G12; D1 §7.5) (${saved.status} ${saved.text?.slice(0, 400)})`);
    assert.equal(saved.body?.design_check?.outcome, 'passed', `and re-validated: the design check on the rebased tree (${JSON.stringify(saved.body?.design_check)})`);
    const checkpoint = saved.body.revision;
    assert.deepEqual(parentsOf(p.repo.path, checkpoint), [moved], 'the checkpoint\'s parent is the Builder\'s integration');
    assert.ok(fileAt(p.repo.path, checkpoint, 'notes/builder-1.md') && fileAt(p.repo.path, checkpoint, '.surety/design/design.json'), 'both changes in the tree: disjoint paths, no conflict');
    // Order 2: the Designer saves while a Builder runs on the older base; the Builder integrates after.
    await sayAndSettle(fx, p.id, run.id, 'Add a note.');
    const second = await heldBuilder(fx, p.id, [step.write('notes/builder-2.md', 'The second Builder\'s note.\n')]);
    await launched(fx, p.id, second, 'the second Builder to run');
    const saved2 = await postSaveRaw(fx, p.id, run.id);
    assert.equal(saved2.status, 200, `the Designer's save while a Builder runs (${saved2.status} ${saved2.text?.slice(0, 400)})`);
    fx.scripted.release(second, 'gate');
    const ended2 = await endedRun(fx, p.id, second, 'the second Builder to integrate after the save');
    assert.equal(ended2.outcome, 'completed', `the Builder behind the Designer's checkpoint integrated (D1 §7.5) (${ended2.reason_text})`);
    const head = refOid(p.repo.path, p.repo.ref);
    assert.ok(gitText(p, 'notes/builder-2.md', head) && gitText(p, '.surety/design/design.md', head)?.includes('A second note'), 'both in the head');
    assert.equal(gitQuiet(p.repo.path, ['rev-list', '--merges', `${base}..${head}`]), '', 'serialized: no merge commit, the history linear');
    await sayAndSettle(fx, p.id, run.id, 'Done.');
    await postCloseRaw(fx, p.id, run.id, { refuse: true });
  });

  test('(d) a Vision, Spec Writer or Architect session beside the Designer: session_busy each; a second Designer session: session_busy', async (t) => {
    const { fx, p } = await pantry(t);
    const run = await openDesigner(fx, p.id);
    for (const role of ['vision', 'spec_writer', 'architect', 'designer']) assertRefused(await fx.engine.post(sessionsOf(p.id), { role }), 409, 'session_busy', `a ${role} session beside the Designer's`);
    await postCloseRaw(fx, p.id, run.id, { refuse: true });
  });

  test('(d) a Spec Writer session\'s save on a moved head: refused integration_conflict, as built (E147 item 4)', async (t) => {
    const fx = await scriptedEngine(t);
    const q = await specReady(fx);
    const run = await openSession(fx, q.id, 'spec_writer');
    scriptTurns(fx, run.id, [turnThatWrites({ [SPEC_PATH]: TALLY_SPEC.replace('exactly, as a pure function', 'exactly as a pure function') }, { reply: 'Restated.' })]);
    await sayAndSettle(fx, q.id, run.id, 'Restate R1.');
    const opened = refOid(q.repo.path, q.repo.ref);
    const proposal = await governedEdit(fx, q, { protected_paths: ['.surety/checks/', 'docs/'] });
    await humanApplies(fx, q, proposal, 'tightening');
    assert.notEqual(refOid(q.repo.path, q.repo.ref), opened, 'the fixture is live: an engine commit moved the head under the session');
    assertRefused(await postSaveRaw(fx, q.id, run.id), 409, 'integration_conflict', 'the Spec Writer\'s save behind the head');
  });

  test('(e) an approved spec change re-derives the inventory under the open session: the next save refused DESIGN_INVENTORY_STALE, the role told', async (t) => {
    const { fx, p, ctx, model } = await pantry(t);
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [
      designTurnOf(model),
      { steps: [step.write('.surety/design/design.md', '# Pantry: design\n\nA later note.\n'), step.result(turnResult({ reply: 'A note.', artifact_changed: true }))] },
      talk('I see the inventory moved.'),
    ]);
    await sayAndSettle(fx, p.id, run.id, 'Draw Pantry.');
    const first = await postSaveRaw(fx, p.id, run.id);
    assert.equal(first.body?.design_check?.outcome, 'passed', `the first save passes (${first.text?.slice(0, 400)})`);
    const before = inventoryOf(p).inventory_digest;
    // The change: R2 shown on android too (its mark), so R2 becomes a UI requirement of android.
    const v2 = specText({ version: 2, requirements: REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, surface: 'ui (web, android)' } : r)), changeLog: [{ version: 2, date: '2026-10-16', change: 'R2 on android too', by: 'Sean' }] });
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', v2)], { changes: [{ key: 'R2', kind: 'text_changed', reason: 'the list on android too' }] }));
    await postChange(fx, { project: p.id }, 'Show the pantry list on Android as well.');
    const change = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'spec_change').at(-1), { what: 'the spec change raised beside the open session', max: 30 });
    await consume(fx, p.id, change, 'approve');
    await pump(fx, ctx, () => (inventoryOf(p).inventory_digest !== before ? true : undefined), { what: 'the inventory re-derived from spec version 2', max: 30 });
    assert.notEqual(runRow(fx.home, run.id).state, 'ended', 'the session still open');
    await sayAndSettle(fx, p.id, run.id, 'Add a note.');
    const stale = await postSaveRaw(fx, p.id, run.id);
    assert.match(stale.text ?? '', /DESIGN_INVENTORY_STALE/, `the next save refused DESIGN_INVENTORY_STALE (${stale.status} ${stale.text?.slice(0, 600)})`);
    if (stale.status === 200) assert.equal(stale.body?.design_check?.outcome, 'refused', 'its check refused');
    await sayAndSettle(fx, p.id, run.id, 'What changed?');
    assert.match(engineEntryText(fx.home, run.id, 3), /DESIGN_INVENTORY_STALE/, 'the role told in the engine\'s entry');
    await postCloseRaw(fx, p.id, run.id, { refuse: true });
  });

  test('(f) a one-shot\'s package while a Designer checkpoint newer than the approved revision exists, its session still open: the approved design only', async (t) => {
    const { fx, p, ctx } = await pantry(t);
    scriptBuilders(fx, p.id, { dump: [2, 3] });
    const approvedFiles = validDesign(p);
    await designerSession(fx, p.id, [{ files: approvedFiles, say: 'Draw Pantry.', result: { done: true } }]);
    const batch = await untilBatch(fx, ctx);
    await approveBatch(fx, ctx, batch);
    const purple = { ...TOKENS, themes: { ...TOKENS.themes, light: { ...TOKENS.themes.light, 'color.accent': '#7a1fa2' } } };
    const later = await designerSession(fx, p.id, [{ files: { '.surety/design/tokens.json': json(purple) }, say: 'Try a purple accent.' }], { close: null });
    const checkpoint = later.saves[0]?.body?.revision;
    assert.ok(checkpoint && gitText(p, '.surety/design/tokens.json', checkpoint)?.includes('#7a1fa2'), 'the fixture is live: the newer checkpoint saved');
    await pump(fx, ctx, () => ([2, 3].every((n) => fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id }).length > 0) ? true : undefined), { what: 'both UI Builders launched beside the open session', max: 80 });
    assert.notEqual(runRow(fx.home, later.run.id).state, 'ended', 'the later Designer session was open while they launched');
    for (const n of [2, 3]) {
      const launch = fx.scripted.launches({ work_item: stageWork(fx.home, p.id, n).id })[0];
      const pkg = dumpedPackage(fx, launch.run, 0);
      assert.ok(pkg, `stage ${n}'s Builder dumped its package`);
      assert.equal(pkg['design/tokens.json']?.text, approvedFiles['.surety/design/tokens.json'], `stage ${n}: the approved tokens (D6 §3.5: no package resolves to a checkpoint)`);
      assert.ok(!JSON.stringify(pkg).includes('#7a1fa2'), `stage ${n}: nothing of the checkpoint`);
    }
    await postCloseRaw(fx, p.id, later.run.id, { refuse: true });
  });

  test('(g) M419 for the other roles on a project under design: a one-shot beside an Architect session held session_busy; a Spec Writer session beside a running one-shot refused session_busy', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { policy: BEFORE_BUILD, name: 'pantry-m419' });
    await pantrySpec(fx, p.id);
    const run = await openSession(fx, p.id, 'architect');
    const item = await addWork(fx.engine, p.id, 'fix');
    fx.scripted.script(item, [roleThatHolds([])]);
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(runsOf(fx.home, item), [], 'no run for the one-shot beside the Architect session');
    assert.match(heldFor(fx, p.id, item), /session_busy/, `held session_busy (D6-S08 unchanged) (${heldFor(fx, p.id, item)})`);
    assertRefused(await fx.engine.post(sessionsOf(p.id), { role: 'spec_writer' }), 409, 'session_busy', 'a second session beside the Architect\'s');
    await postCloseRaw(fx, p.id, run.id, { refuse: true });
    await launched(fx, p.id, item, 'the one-shot once the session closed');
    assertRefused(await fx.engine.post(sessionsOf(p.id), { role: 'spec_writer' }), 409, 'session_busy', 'a Spec Writer session while the one-shot runs');
    fx.scripted.release(item, 'gate');
    await endedRun(fx, p.id, item, 'the one-shot to end');
  });
});
