// M538, the Designer session, its limits and its findings (slice 41; kernel
// lane). M6 plan §3.3 M538; D7 §3.1, §3.2, §3.5, §4.5; B.12; A.7; BS6
// §11.1; SEAM.md §§480, 483, 486, 491, 531.
//
// (a) `surety session open --role designer` and `POST …/sessions` with role
//     `designer`: a run of kind `session`, role `designer`, D6 §2's mechanism
//     unchanged (settlement, the idle generation, save and close through the
//     journal);
// (b) a turn: a ledger row with the model requested `model_designer` (Opus
//     by default) and the deadline `deadline_designer` (30 m); a setting
//     changes both: the deadline at the open session's next turn, the model
//     at the next session's first turn (objection 157; M420 (c));
// (c) the cumulative budget at `designer_session_budget_billable_tokens`
//     (lowered), in place of the run budget; exhausted between turns: closed
//     `budget_exhausted` through the idle protocol, no turn after;
// (d) a turn result with an unknown field: refused, the engine's entry
//     naming the field; `findings` of category `contract_conflict` naming an
//     interface: an owner question with D3 X2's options plus `architect`;
//     `requirement_conflict` naming a requirement: `change_spec` offered;
// (e) the session continuing after a finding; the approval while the finding
//     is open: `approve` blocked DESIGN_INTERFACE_DISPUTED (M505 (e));
// (f) the session's end by idle timeout, by budget, by `--refuse`: each
//     re-raises `design_due`, said on the next read (M512 (d); E162 item 1:
//     an open design_due naming the held stages, not naming the ended
//     session, its `open` not blocked by it; every hold accounted for).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decision } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { changePolicy, getPolicy } from './harness/journal.mjs';
import { openDecisions } from './harness/journey/drive.mjs';
import { refOid } from './harness/repos.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { invocationsOf, postCloseRaw, postSaveRaw, postTurnRaw } from './harness/session-lane.mjs';
import { ledgerRowsOf, readSession, runRow, say, sayAndSettle, scriptTurns, transcriptEntries, turnResult } from './harness/sessions.mjs';
import { assertReRaised, inventoryOf, cli, openDesignDue, openDesigner, openOfKind, toPublished } from './harness/design/drive.mjs';
import { BEFORE_BUILD, designModel, designTurnOf, scriptVariant, untilBatch } from './harness/design/check41.mjs';

const DESIGN_KINDS = Object.freeze(['design_approval', 'design_due', 'design_verdicts']);
const talk = (reply, extra = {}) => ({ steps: [step.result(turnResult({ reply, ...extra }))] });
const spend = (tokens, reply) => ({ steps: [step.usage({ input_tokens: tokens - 10, output_tokens: 10 }), step.result(turnResult({ reply }))] });
const endedRow = (fx, run) => waitFor(() => (runRow(fx.home, run)?.state === 'ended' ? runRow(fx.home, run) : undefined), { what: `run ${run} to end`, timeoutMs: 60_000 });
const optionKeys = (d) => (d.options ?? []).map((o) => (typeof o === 'string' ? o : o.key));
const blockersOf = (row, option) => ((row.options ?? []).find((o) => o.key === option)?.blockers ?? []).map((b) => (typeof b === 'string' ? b : JSON.stringify(b)));

// Pantry published under before_build, its roles scripted; the design drawn from its inventory.
async function pantry(t, name) {
  const fx = await scriptedEngine(t);
  const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name });
  const ctx = scriptVariant(fx, p);
  return { fx, p, ctx, model: designModel(inventoryOf(p)) };
}
// The open decisions of the project that are not the design's own kinds, parsed.
const otherQuestions = (fx, project) =>
  openDecisions(fx.home, project)
    .filter((d) => !DESIGN_KINDS.includes(d.kind))
    .map((d) => decision(fx.home, d.id));

describe('M538 the Designer session, its limits and its findings', () => {
  test('(a) opened by the CLI and by the route: a session run of role designer; (b) a turn requests model_designer under deadline_designer; a setting changes both; save and close as D6 §2', async (t) => {
    const { fx, p, model } = await pantry(t);
    const { effective } = await getPolicy(fx.engine, p.id);
    assert.deepEqual(
      [effective.model_designer, effective.deadline_designer, effective.designer_session_budget_billable_tokens],
      ['opus', 1800, 3_000_000],
      `model_designer opus, deadline_designer 30 m, designer_session_budget_billable_tokens 3,000,000 (D7 A.7; BS6 §11.1; SEAM.md §491) (${JSON.stringify({ model: effective.model_designer, deadline: effective.deadline_designer, budget: effective.designer_session_budget_billable_tokens })})`,
    );
    // (a) the CLI, in the test's own home (SEAM.md §491: M5's form, --role designer).
    const opened = cli(fx, ['session', 'open', '--project', p.id, '--role', 'designer']);
    assert.equal(opened.status, 0, `surety session open --role designer exits 0 (${opened.stdout} ${opened.stderr})`);
    const viaCli = opened.body?.run;
    assert.deepEqual([viaCli?.role, viaCli?.kind], ['designer', 'session'], `a session run of role designer (${opened.stdout})`);
    assert.equal((await postCloseRaw(fx, p.id, viaCli.id, { refuse: true })).status, 200, 'closed');
    // (a) the route; (b) a turn.
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [designTurnOf(model), talk('Noted.')]);
    await sayAndSettle(fx, p.id, run.id, 'Draw Pantry.');
    const generation = runRow(fx.home, run.id).idle_generation;
    const [ledger] = ledgerRowsOf(fx.home, p.id, run.id);
    assert.equal(ledger?.model_requested, 'opus', `the turn's ledger row requests model_designer, opus (${JSON.stringify(ledger)})`);
    const [receipt] = invocationsOf(fx.home, run.id);
    const deadline = (Date.parse(receipt.deadline_at) - Date.parse(receipt.created_at)) / 1000;
    assert.ok(Math.abs(deadline - 1800) <= 120, `the turn's deadline is deadline_designer, 30 m (${receipt.deadline_at} from ${receipt.created_at})`);
    // D6 §2's save: a checkpoint through the journal, the idle generation kept.
    const saved = await postSaveRaw(fx, p.id, run.id);
    assert.equal(saved.status, 200, `the save (${saved.text?.slice(0, 400)})`);
    assert.equal(saved.body?.revision, refOid(p.repo.path, p.repo.ref), 'the checkpoint is the integration branch\'s head');
    assert.equal(runRow(fx.home, run.id).current_base, saved.body.revision, 'current_base advanced to the checkpoint (D6 §2.4; M417 (a))');
    assert.equal(runRow(fx.home, run.id).idle_generation, generation, 'the idle generation unchanged by the save (M417 (a))');
    // A setting changes both.
    await changePolicy(fx.engine, p.id, { model_designer: 'sonnet', deadline_designer: 600 });
    await sayAndSettle(fx, p.id, run.id, 'Anything else?');
    const r2 = invocationsOf(fx.home, run.id)[1];
    assert.ok(Math.abs((Date.parse(r2.deadline_at) - Date.parse(r2.created_at)) / 1000 - 600) <= 120, `deadline_designer set to 10 m: the next turn's deadline (${r2.deadline_at} from ${r2.created_at})`);
    const closed = await postCloseRaw(fx, p.id, run.id, { refuse: true });
    assert.equal(closed.status, 200, `closed (${closed.text?.slice(0, 300)})`);
    assert.equal((await endedRow(fx, run.id)).state, 'ended', 'the session run ended');
    // The model is the session run's, chosen at its opening (objection 157;
    // M420 (c)'s form): the setting is read by the next session's first turn.
    const next = await openDesigner(fx, p.id);
    scriptTurns(fx, next.id, [talk('Hello again.')]);
    await sayAndSettle(fx, p.id, next.id, 'Hello.');
    const [first] = ledgerRowsOf(fx.home, p.id, next.id);
    assert.equal(first?.model_requested, 'sonnet', `model_designer set to sonnet: the next session's first turn requests it (${JSON.stringify(first)})`);
    assert.equal((await postCloseRaw(fx, p.id, next.id, { refuse: true })).status, 200, 'the second session closed');
  });

  test('(c) the cumulative budget is designer_session_budget_billable_tokens, not the run budget; exhausted between turns: closed budget_exhausted, no turn after', async (t) => {
    const { fx, p } = await pantry(t);
    await changePolicy(fx.engine, p.id, { budget_run_billable_tokens: 10_000, designer_session_budget_billable_tokens: 250_000 });
    const run = await openDesigner(fx, p.id);
    scriptTurns(fx, run.id, [spend(20_000, 'A first look.'), spend(230_000, 'A long mockup turn.'), talk('Never.')]);
    // 20,000 tokens: past the run budget, under the Designer's.
    await sayAndSettle(fx, p.id, run.id, 'Look at the inventory.');
    assert.notEqual(runRow(fx.home, run.id).state, 'ended', 'the session continues past budget_run_billable_tokens (D7 §3.2: its own budget)');
    // 250,000 in all: the Designer's budget spent at this settlement.
    await say(fx, p.id, run.id, 'Draw every screen.');
    const ended = await endedRow(fx, run.id);
    assert.equal(ended.reason_class, 'budget', `closed with reason class budget (${JSON.stringify([ended.outcome, ended.reason_class])})`);
    const read = await fx.engine.get(`/v1/projects/${p.id}/runs/${run.id}`);
    assert.equal(read.body?.run?.code, 'budget_exhausted', `its public code budget_exhausted (${read.text?.slice(0, 300)})`);
    const res = await postTurnRaw(fx, p.id, run.id, 'One more.');
    assert.ok(res.status >= 400, `no further turn admitted (→ ${res.status} ${res.text})`);
  });

  test('(d) an unknown field refused naming it; a contract_conflict finding: X2\'s options plus architect; a requirement_conflict: change_spec; (e) the session continues, and approve is blocked DESIGN_INTERFACE_DISPUTED', async (t) => {
    const { fx, p, ctx, model } = await pantry(t);
    const run = await openDesigner(fx, p.id);
    const ODD = 'A reply with a field B.12 does not have.';
    scriptTurns(fx, run.id, [
      talk(ODD, { mood: 'calm' }),
      talk('Understood.'),
      talk('add-item cannot say the pantry is full.', { findings: [{ category: 'contract_conflict', severity: 'medium', message: 'add-item declares no error for a full pantry', interface: 'add-item' }] }),
      talk('R3 asks for something the inventory cannot show.', { findings: [{ category: 'requirement_conflict', severity: 'medium', message: 'R3 needs the list offline, which no interface offers', requirement: 'R3' }] }),
      designTurnOf(model, { reply: 'The design, meanwhile.' }),
    ]);
    // (d) the unknown field.
    const first = await say(fx, p.id, run.id, 'Hello.');
    assert.notEqual(first.turn.state === 'settled' && first.turn.reply === ODD, true, `the reply is not accepted (${JSON.stringify(first.turn)})`);
    await sayAndSettle(fx, p.id, run.id, 'Try again.');
    const engineText = transcriptEntries(fx.home, run.id).filter((e) => e.speaker === 'engine' && e.turn <= 2).map((e) => e.text ?? '').join('\n');
    assert.match(engineText, /mood/, `the engine's entry names the field (${engineText.slice(0, 400)})`);
    assert.ok(!transcriptEntries(fx.home, run.id).some((e) => e.speaker === 'role' && e.text === ODD), 'no role entry from the refused reply');
    // (d) contract_conflict: an owner question with X2's options plus architect, naming the interface.
    await sayAndSettle(fx, p.id, run.id, 'Can the API say the pantry is full?');
    const contract = await tickUntil(fx.engine, p.id, () => otherQuestions(fx, p.id).find((d) => optionKeys(d).includes('architect')), { max: 6, what: 'the owner question for the contract_conflict finding' });
    for (const key of ['change_spec', 'architect']) assert.ok(optionKeys(contract).includes(key), `the question offers ${key} (D7 §4.5; SEAM.md §491) (${JSON.stringify(optionKeys(contract))})`);
    assert.match(JSON.stringify(contract), /add-item/, 'naming the interface');
    // (d) requirement_conflict: change_spec offered, naming the requirement.
    await sayAndSettle(fx, p.id, run.id, 'And offline?');
    const requirement = await tickUntil(fx.engine, p.id, () => otherQuestions(fx, p.id).find((d) => d.id !== contract.id && optionKeys(d).includes('change_spec') && JSON.stringify(d).includes('R3')), { max: 6, what: 'the owner question for the requirement_conflict finding' });
    assert.ok(requirement, 'change_spec offered for the requirement_conflict, naming R3 (D6 §4.2)');
    // (e) the session continues: a further turn admitted and settled, the design saved.
    await sayAndSettle(fx, p.id, run.id, 'Draw it anyway.');
    const saved = await postSaveRaw(fx, p.id, run.id);
    assert.equal(saved.body?.design_check?.outcome, 'passed', `the design saved and checked (${saved.text?.slice(0, 400)})`);
    const closed = await postCloseRaw(fx, p.id, run.id, {});
    assert.equal(closed.status, 200, `the close (${closed.text?.slice(0, 400)})`);
    const batch = await untilBatch(fx, ctx);
    const blockers = blockersOf(batch.design_approval, 'approve');
    assert.ok(blockers.some((b) => b.includes('DESIGN_INTERFACE_DISPUTED') && b.includes('add-item')), `approve blocked DESIGN_INTERFACE_DISPUTED naming add-item while the finding is open (${JSON.stringify(blockers)})`);
  });

  test('(f) a Designer session ended by idle timeout, by budget and by --refuse: each re-raises design_due, said on the next read', async (t) => {
    const { fx, p, model } = await pantry(t);
    await changePolicy(fx.engine, p.id, { designer_session_budget_billable_tokens: 250_000 });
    const due = openDesignDue(fx.home, p.id);
    assert.ok(due, 'the fixture is live: design_due open at derivation (SEAM.md §485)');
    // E162 item 1: the session ended without resolving the hold re-raises the question (assertReRaised).
    const reRaised = async (how, run) => {
      await tick(fx.engine, p.id, { rounds: 2 });
      assert.deepEqual(openOfKind(fx.home, p.id, 'design_approval'), [], `${how}: no design_approval raised`);
      await assertReRaised(fx, p.id, run, how);
    };
    // Idle timeout.
    const idle = await openDesigner(fx, p.id);
    scriptTurns(fx, idle.id, [{ steps: [step.write('.surety/design/design.md', '# Pantry: a first note\n'), step.result(turnResult({ reply: 'A note.', artifact_changed: true }))] }]);
    await sayAndSettle(fx, p.id, idle.id, 'Start.');
    await advanceClock(fx.engine, 1200 + 60);
    await tick(fx.engine, p.id, { rounds: 2 });
    const timedOut = await endedRow(fx, idle.id);
    assert.deepEqual([timedOut.outcome, timedOut.reason_class], ['timed_out', 'deadline'], 'closed by the idle timeout');
    await reRaised('the idle timeout', idle.id);
    // Budget.
    const spent = await openDesigner(fx, p.id);
    scriptTurns(fx, spent.id, [spend(250_000, 'Everything at once.')]);
    await say(fx, p.id, spent.id, 'Draw everything.');
    assert.equal((await endedRow(fx, spent.id)).reason_class, 'budget', 'closed by the budget');
    await reRaised('budget exhaustion', spent.id);
    // --refuse.
    const refused = await openDesigner(fx, p.id);
    scriptTurns(fx, refused.id, [designTurnOf(model)]);
    await sayAndSettle(fx, p.id, refused.id, 'Draw it.');
    assert.equal((await postSaveRaw(fx, p.id, refused.id)).status, 200, 'saved');
    assert.equal((await postCloseRaw(fx, p.id, refused.id, { refuse: true })).status, 200, 'closed with --refuse');
    await reRaised('--refuse', refused.id);
  });
});
