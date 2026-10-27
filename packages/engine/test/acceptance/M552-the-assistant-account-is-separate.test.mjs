// M552, WA-separate: the workspace assistant's account and the projects'
// accounts never count against each other (UI1 slice 48, sandbox lane; the
// assistant design of 2026-10-27, §1.2 "Identity" and "Separation"; O4, O7;
// E184; SEAM.md §§567, 568).
//
//   (a) Assistant turns, a reported one and a large unknown-cost one, change
//       nothing a project shows: its ledger view (rows, totals, by role,
//       exhausted limits, the day's account against budget_day_*) and the
//       project read's spend_today are as before, and no project row names
//       the assistant's role. The account is not a project: GET
//       /v1/projects lists only the projects as before, and
//       /v1/projects/workspace_assistant is not one.
//   (b) The reverse: the qualification's three canaries are project rows of
//       the fixture project and none of them is in the assistant's account;
//       and with that project's day exhausted by its own spend (a
//       verification run's unknown-cost tokens past its
//       budget_day_unknown_tokens, which the owner lowered) the assistant's
//       state, its account and its admission are unchanged.
//
// The scripted backend stands in for a real provider; no model is called.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { accountRows, accountView, allowanceOf, askAndSettle, assistantScripts, assistantState, block, counts, newConversation, readyAssistant, reply, usage } from './harness/assistant.mjs';
import { changePolicy } from './harness/journal.mjs';
import { addWork, tick, waitForRun } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';

const B = block({ day_limit_billable_tokens: 400_000, turn_limit_billable_tokens: 40_000 });

async function projectView(fx, project) {
  const ledger = await fx.engine.get(`/v1/projects/${project}/ledger`);
  assert.equal(ledger.status, 200, `GET the project's ledger (body: ${ledger.text})`);
  const read = await fx.engine.get(`/v1/projects/${project}`);
  assert.equal(read.status, 200, `GET the project (body: ${read.text})`);
  const { served_at: _s, snapshot_seq: _q, ...rest } = ledger.body;
  return { ledger: rest, spend_today: read.body.project?.spend_today ?? read.body.spend_today ?? null };
}

const accountFigures = (a) => ({ day: a.day, used_known: a.used_known, unknown_allowance: allowanceOf(a), reserved: a.reserved, remaining: a.remaining, turns_charged: a.turns_charged });

describe("M552 the assistant's account and the projects' never count against each other", () => {
  test("(a) assistant turns change nothing a project shows; the account is not a project", async (t) => {
    const { fx, fixtureProject } = await readyAssistant(t, { block: B });
    const before = await projectView(fx, fixtureProject);
    const projectsBefore = (await fx.engine.get('/v1/projects')).body.projects.map((p) => p.id).sort();
    assert.ok(before.ledger.rows.length >= 3, `the fixture is live: the project has its canaries' rows (${before.ledger.rows.length})`);

    assistantScripts(fx, [
      { steps: [counts(1_000, 100, { cost_usd: 0.05 }), reply('Reported.')] },
      { steps: [counts(30_000, 500), reply('Unknown cost.')] },
      { steps: [usage({ input_tokens: 2_000 }), { hold: 'stuck', heartbeat_ms: 0 }], on_term: 'exit' },
    ]);
    const conv = await newConversation(fx);
    for (const i of [1, 2, 3]) await askAndSettle(fx, conv, `m552-a${i}`);
    assert.equal(accountRows(fx.home).length, 3, 'the fixture is live: the account charged three rows');
    assert.ok((await accountView(fx)).used_known > 30_000, 'and counts them');

    const after = await projectView(fx, fixtureProject);
    assert.deepEqual(after, before, "the project's ledger view, exhausted limits, day account and spend_today are unchanged");
    assert.ok(!after.ledger.rows.some((r) => r.role === 'workspace_assistant'), 'no project row names the assistant');
    assert.ok(!Object.keys(after.ledger.by_role).includes('workspace_assistant'), 'nor does its by_role');

    const projectsAfter = (await fx.engine.get('/v1/projects')).body.projects.map((p) => p.id).sort();
    assert.deepEqual(projectsAfter, projectsBefore, 'GET /v1/projects lists the same projects');
    assert.ok(!projectsAfter.includes('workspace_assistant'), 'and never the account');
    const notOne = await fx.engine.get('/v1/projects/workspace_assistant');
    assert.ok(notOne.status === 404 || notOne.status === 400, `the account is not a project (${notOne.status} ${notOne.text})`);
  });

  test("(b) the canaries are the fixture project's rows, never the account's; a project's exhausted day leaves the assistant's state, account and admission unchanged", async (t) => {
    const { fx, fixtureProject } = await readyAssistant(t, { block: B });
    const project = await projectView(fx, fixtureProject);
    assert.ok(project.ledger.rows.length >= 3, `the canaries charged the fixture project (${project.ledger.rows.length} rows)`);
    assert.equal(accountRows(fx.home).length, 0, 'none of them is in the assistant\'s account');
    const a0 = await accountView(fx);
    assert.deepEqual([a0.used_known, allowanceOf(a0), a0.turns_charged], [0, 0, 0], `the account starts empty (${JSON.stringify(a0)})`);

    // The project spends on its own: one verification run whose role
    // reports 5,010 billable tokens at an unknown cost.
    const item = await addWork(fx.engine, fixtureProject, 'verification');
    fx.scripted.script(item, [{ steps: [step.usage({ input_tokens: 5_000, output_tokens: 10, cache_read_tokens: 0 }), step.result()] }]);
    await tick(fx.engine, fixtureProject);
    await waitForRun(fx.home, item, { state: 'ended', timeoutMs: 120_000 });
    await changePolicy(fx.engine, fixtureProject, { budget_day_unknown_tokens: 1_000 });
    const exhausted = await projectView(fx, fixtureProject);
    assert.ok(exhausted.ledger.budget.exhausted.includes('budget_day_unknown_tokens'), `the fixture is live: the project's day is exhausted (${JSON.stringify(exhausted.ledger.budget)})`);
    const s = await assistantState(fx);
    assert.equal(s.state, 'ready', `the assistant is still ready (${s.reason})`);
    assert.deepEqual(accountFigures(s.account), accountFigures(a0), 'its account is unchanged');

    assistantScripts(fx, [{ steps: [counts(500, 50), reply('Still here.')] }]);
    const conv = await newConversation(fx);
    const r = await askAndSettle(fx, conv, 'm552-b1');
    assert.equal(r.turn?.outcome, 'completed', `a turn is admitted and completes (${r.res.status} ${JSON.stringify(r.turn)})`);
    const later = await projectView(fx, fixtureProject);
    assert.deepEqual(later.ledger.rows, exhausted.ledger.rows, "and the project's rows are as they were");
  });
});
