// M557, WA-qualify: the assistant's own qualification attempt (UI1 slice
// 48, sandbox lane, scripted backend; the assistant design of 2026-10-27,
// §3 "The additional qualification" and "Cost"; O7; B2 (E183 item 3);
// E184; SEAM.md §§148, 149, 567, 568).
//
//   (a) An attempt with "purpose": "assistant" runs on the assistant
//       template (`scripted-assistant-1`) and its three canaries pass on
//       their stated evidence: the positive canary's reply is schema-valid,
//       cites the seeded evidence and carries the engine's nonce; the
//       cancellation canary was cancelled while running (its time from TERM
//       to exit recorded); the containment canary's check, run by the
//       engine in the live domain, found the token, the engine's port, an
//       unlisted CONNECT and the repository configuration denied, a write to
//       /surety/out allowed and no workspace. Its entry binds the assistant
//       template, one-shot. Its cost is the qualification's, under B2's
//       profile: each canary limited to the block's turn limit, charged to
//       the fixture project and shown with the attempt (its spend and on
//       GET /v1/engine), never to the assistant's account. Its approval
//       names the true canary count.
//   (b) It fails on its stated evidence: a positive canary whose reply is
//       not the one asked for, and in another attempt a cancellation canary
//       that finishes before the engine cancels it, each fail the attempt
//       with no entry, and the assistant stays `qualification_pending`.
//
// No model is called: the canaries are the scripted role program inside the
// real sandbox.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BLOCK, KEY_REF, TEST_KEY, accountRows, accountView, assistantAttempt, assistantState, block, obeyingAssistantCanaries } from './harness/assistant.mjs';
import { holdSecret } from './harness/records.mjs';
import { recordJson } from './harness/sandbox/result.mjs';
import { approveAttempt, attemptFixture, canaryOf, canaryRuns, waitAttempt } from './harness/sandbox/qualify.mjs';
import { step } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { trustEntry } from './harness/trust.mjs';

const B = block({ turn_limit_billable_tokens: 40_000 });
const KINDS = ['positive', 'cancellation', 'containment'];
const ASSISTANT_ACTIONS = { token_read: 'denied', git_config: 'denied', engine_port: 'denied', unlisted_connect: 'denied', out_write: 'allowed', workspace_absent: 'absent' };
const times = (one) => Array.from({ length: 6 }, () => one);

const canaryReceipts = (home, attempt) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "invocation_receipts" WHERE "qualification_attempt" = ? ORDER BY rowid').all(attempt)).map((r) => ({ ...r, budget_snapshot: JSON.parse(r.budget_snapshot) }));
const rowsOfInvocations = (home, ids) => withStore(home, (db) => ids.flatMap((id) => db.prepare('SELECT * FROM "ledger_rows" WHERE "invocation" = ?').all(id)));

async function fixture(t) {
  const { fx, standIn, fixtureProject } = await attemptFixture(t, { config: { workspace_assistant: B } });
  await holdSecret(fx.engine, KEY_REF, TEST_KEY);
  return { fx, standIn, fixtureProject };
}

describe("M557 the assistant's own qualification attempt", () => {
  test('(a) three canaries pass on their stated evidence; the entry binds the assistant template; the cost is the qualification\'s, per canary the turn limit, charged to the fixture project, never to the account; the approval names three canaries', async (t) => {
    const { fx, standIn, fixtureProject } = await fixture(t);
    obeyingAssistantCanaries(fx);
    const { id, row } = await assistantAttempt(fx, standIn, fixtureProject, { approve: false });
    const decision = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "decisions" WHERE "kind" = 'qualification_approval' AND "subject_id" = ?`).get(id));
    assert.ok(decision, 'the attempt raised its qualification_approval');
    assert.match(JSON.stringify(decision), /three canaries \(positive, cancellation, containment\)/, `the approval names the true canary count (${decision.question ?? ''})`);
    assert.equal(row, null);

    const attemptRow = withStore(fx.home, (db) => db.prepare('SELECT * FROM "qualification_attempts" WHERE "id" = ?').get(id));
    const spend = JSON.parse(attemptRow.spend);
    assert.equal(attemptRow.template_version, 'scripted-assistant-1', 'the assistant template');
    assert.deepEqual(
      { purpose: spend.purpose, canary_limit_tokens: spend.canary_limit_tokens, charged_to: spend.charged_to },
      { purpose: 'assistant', canary_limit_tokens: BLOCK.turn_limit_billable_tokens, charged_to: { account: 'project', project: fixtureProject, as: 'qualification' } },
      `the spend shown with the attempt: per canary the turn limit, charged to the fixture project as qualification (${attemptRow.spend})`,
    );
    const shown = (await fx.engine.engineInfo()).qualification_attempts?.find((a) => a.id === id);
    assert.ok(shown, 'GET /v1/engine shows the attempt');
    assert.equal(shown.admission?.requested_tokens, BLOCK.turn_limit_billable_tokens, `its admission requests the turn limit, under B2 (${JSON.stringify(shown.admission)})`);

    await approveAttempt(fx, fixtureProject, id);
    const done = await waitAttempt(fx.home, id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 300_000 });
    assert.equal(done.status, 'succeeded', `the attempt passed (${JSON.stringify(done.canaries)})`);
    for (const kind of KINDS) assert.equal(canaryOf(done, kind)?.passed, true, `the ${kind} canary passed`);

    const positive = recordJson(fx.home, canaryOf(done, 'positive').evidence);
    assert.deepEqual([positive.purpose, positive.result_matches, positive.reply_problem], ['assistant', true, null], `positive: the reply cites the seeded evidence and carries the nonce (${JSON.stringify(positive)})`);
    assert.ok(Array.isArray(positive.expected?.result?.cited_evidence) && positive.expected.result.cited_evidence.includes(positive.expected.cites), 'the expected reply cites the seeded evidence');
    const cancellation = canaryOf(done, 'cancellation');
    assert.ok(Number.isInteger(cancellation.term_to_exit_ms), `cancellation: cancelled while running, its TERM-to-exit recorded (${JSON.stringify(cancellation)})`);
    const containment = recordJson(fx.home, canaryOf(done, 'containment').evidence);
    const actions = Object.fromEntries((containment.actions ?? containment.check?.actions ?? []).map((a) => [a.name, a]));
    for (const [name, expected] of Object.entries(ASSISTANT_ACTIONS)) {
      assert.deepEqual([actions[name]?.expected, actions[name]?.outcome, actions[name]?.passed], [expected, expected, true], `containment: ${name} ${expected} (${JSON.stringify(actions[name] ?? null)})`);
    }
    assert.equal(actions.workspace_write, undefined, 'the coding plan\'s workspace_write is not among the assistant\'s');

    const entry = trustEntry(fx.home, done.trust_entry);
    assert.deepEqual([entry.template_version, entry.mode, entry.backend, entry.model], ['scripted-assistant-1', 'one_shot_headless', 'scripted', BLOCK.model], 'the entry binds the assistant template, one-shot');

    const receipts = canaryReceipts(fx.home, id);
    assert.equal(receipts.length, 3, 'three canary receipts');
    for (const r of receipts) {
      assert.deepEqual([r.account, r.project], ['project', fixtureProject], 'each charged to the fixture project');
      assert.equal(r.budget_snapshot.budget_run_billable_tokens, BLOCK.turn_limit_billable_tokens, `each limited to the turn limit (${JSON.stringify(r.budget_snapshot)})`);
    }
    const rows = rowsOfInvocations(fx.home, receipts.map((r) => r.id));
    assert.equal(rows.length, 3, 'one ledger row per canary');
    for (const r of rows) assert.deepEqual([r.account, r.project], ['project', fixtureProject], 'in the fixture project\'s ledger');
    assert.ok(canaryRuns(fx.home, id).every((r) => r.project === fixtureProject), 'the canary runs are the fixture project\'s');
    assert.equal(accountRows(fx.home).length, 0, 'nothing in the assistant\'s account');
    const a = await accountView(fx);
    assert.deepEqual([a.used_known, a.turns_charged], [0, 0], 'the account spent nothing');
    const after = (await fx.engine.engineInfo()).qualification_attempts?.find((x) => x.id === id);
    assert.equal(after?.reserved_tokens, 0, `nothing held once the attempt ended (${JSON.stringify(after)})`);
  });

  test('(b) a positive canary with the wrong reply, and a cancellation canary that finishes early, each fail the attempt: no entry, the assistant still qualification_pending', async (t) => {
    const { fx, standIn, fixtureProject } = await fixture(t);
    fx.scripted.canaryScript('positive', times({ steps: [step.canary('wrong_result')] }));
    fx.scripted.canaryScript('cancellation', times({ steps: [step.canary('obey')], on_term: 'exit' }));
    fx.scripted.canaryScript('containment', times({ steps: [step.canary('obey')] }));
    const first = await assistantAttempt(fx, standIn, fixtureProject);
    assert.equal(first.row.status, 'failed', `a wrong reply fails the attempt (${JSON.stringify(first.row.canaries)})`);
    assert.equal(canaryOf(first.row, 'positive')?.passed, false, 'the positive canary did not pass');
    assert.equal(first.row.trust_entry ?? null, null, 'no entry');
    let s = await assistantState(fx);
    assert.deepEqual([s.state, s.qualification?.stage], ['qualification_pending', 'failed'], `still pending (${s.reason})`);

    fx.scripted.canaryScript('positive', times({ steps: [step.canary('obey')] }));
    fx.scripted.canaryScript('cancellation', times({ steps: [step.canary('finish_early')], on_term: 'exit' }));
    const second = await assistantAttempt(fx, standIn, fixtureProject);
    assert.equal(second.row.status, 'failed', `an early finish fails the attempt (${JSON.stringify(second.row.canaries)})`);
    assert.equal(canaryOf(second.row, 'cancellation')?.passed, false, 'the cancellation canary did not pass');
    assert.equal(second.row.trust_entry ?? null, null, 'no entry');
    s = await assistantState(fx);
    assert.equal(s.state, 'qualification_pending', `still pending (${s.reason})`);
    assert.equal(accountRows(fx.home).length, 0, 'nothing in the assistant\'s account');
  });
});
