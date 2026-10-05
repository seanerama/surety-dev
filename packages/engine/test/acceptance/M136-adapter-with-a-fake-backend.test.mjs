// M136, the Claude adapter's usage and delegation judgements with a FAKE
// backend (M2 slice 14, SANDBOX LANE, manifest slice 14; no model, no key,
// no network beyond the engine's proxy). The slice-14 review's S1 and S2
// (E74 items 2 and 3); M2 plan §3.8 M136 (c), (d); D2 §1.5, §4.2, §4.5, C4;
// SEAM.md §§120, 148, 161, 165, 167.
//
// The backend is `claude`, bound in the engine's test mode to a test-owned
// fake (`harness/standin/fake-claude.mjs`): a script that prints synthetic
// stream-json and acts out the canaries. It is never the real binary, and
// the engine's test mode refuses the real one (section 148). The attempt's
// approval is the test's own, as in M135: nothing here is paid.
//
// S1: usage is final only when every count is known, and a null never
// overwrites a known count (E74 item 3). (a) A success `result` whose
// `modelUsage` lacks a count, after per-call usage was observed: the ledger
// row keeps the observed counts, `usage_complete` 0, the unknown allowance
// charged. (b) A failure `result` with no totals after model calls: the
// observed per-call counts are kept.
// S2: the tool inventory must be a subset of the template's `--tools`, and
// the host's sampler must have seen the backend at least once (E74 item 3).
// (a) An inventory listing `Skill` is not `delegation_verified`. (b) A
// backend the sampler never identified is not `delegation_verified`.
//
// SAFETY (SEAM.md §141): the fake runs the containment canary's actions only
// when /surety/context exists and its pid namespace is not the host's, which
// the test gives it; the actions are the engine's probe program asking the
// domain init to act.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { getPolicy } from './harness/journal.mjs';
import { ledgerRows } from './harness/ledger.mjs';
import { holdSecret, recordFile, recordRow } from './harness/records.mjs';
import { FakeClaude } from './harness/sandbox/fakeclaude.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { approveAttempt, attemptOf, canaryOf, canaryRuns, qualify, waitAttempt } from './harness/sandbox/qualify.mjs';
import { withStore } from './harness/store.mjs';
import { apiKeyRef } from './harness/trust.mjs';

const MODEL = 'claude-sonnet-5-5';
// Names under .example only, never resolved (SEAM.md §132).
const EGRESS = ['api.provider.example'];

// A sandbox-lane engine, the fake bound as `claude`, a fixture project, and
// a credential held for the attempt (the fake reads none).
async function fakeFixture(t) {
  const fx = await sandboxEngine(t, { config: { terminate_grace: 3, kill_grace: 2 } });
  const fake = new FakeClaude(join(fx.root, 'fake-claude'), { modeDir: fx.scripted.dir });
  const project = (await addGitProject(fx)).id;
  await holdSecret(fx.engine, apiKeyRef('claude'), 'sk-test-surety-fake-claude-not-a-key-0000');
  return { fx, fake, project };
}

const body = (fake, project) => ({ backend: 'claude', mode: 'one_shot_headless', model: MODEL, binary: { path: fake.path }, fixture_project: project, candidate_egress: [...EGRESS], canary_deadlines: { positive: 120, cancellation: 60, containment: 120 } });

// The original ledger row of an attempt's first (positive) canary, once it ended.
async function positiveRow(fx, project, attemptId) {
  const run = await (async () => {
    for (let i = 0; i < 600; i++) {
      const [first] = canaryRuns(fx.home, attemptId);
      if (first?.state === 'ended') return first;
      await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the positive canary of ${attemptId} did not end`);
  })();
  const rows = ledgerRows(fx.home, project).filter((r) => r.run === run.run && r.corrects === null);
  assert.equal(rows.length, 1, `one original ledger row for the positive canary (${JSON.stringify(rows)})`);
  return rows[0];
}

const runLimit = async (fx, project) => {
  const limit = (await getPolicy(fx.engine, project)).effective?.budget_run_billable_tokens;
  assert.ok(Number.isInteger(limit), `the project's run limit is read (SEAM.md §2): ${limit}`);
  return limit;
};

// The containment canary's evidence: its `capabilities` (SEAM.md §165).
function containmentCapabilities(fx, attempt) {
  const k = canaryOf(attempt, 'containment');
  assert.ok(k?.evidence, `the containment canary ran and kept its evidence (${JSON.stringify(attempt.canaries)})`);
  const ev = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, k.evidence)), 'utf8'));
  return { k, ev, caps: ev.capabilities ?? null };
}

describe('M136 the Claude adapter with a fake backend: usage kept when the totals are incomplete; delegation verified only on the template\'s tools and a sampler that saw the backend (sandbox lane, no model)', () => {
  test('S1 (a): a success result whose modelUsage lacks a count, after per-call usage was observed: the ledger row keeps the observed counts, usage_complete 0, the unknown allowance charged', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ positive: 'missing_count' });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const row = await positiveRow(fx, project, attempt.id);
    // Observed per call: input 1200, cache creation 3000, output 300; the
    // terminal totals lack cacheCreationInputTokens.
    assert.ok(row.billable_in !== null && row.billable_in >= 1200 + 3000, `the observed billable input (1200 + 3000 cache creation) is kept, not overwritten by the terminal's missing count (${JSON.stringify(row)})`);
    assert.equal(row.usage_complete, 0, `usage is not complete when a terminal count is unknown (${JSON.stringify(row)})`);
    const limit = await runLimit(fx, project);
    assert.equal(row.unknown_allowance_tokens, Math.max(0, limit - (row.billable_in + (row.out ?? 0))), `the unknown allowance is charged: the run limit less what was observed (D2 C4; SEAM.md §120) (${JSON.stringify(row)})`);
  });

  test('S1 (b): a failure result with no totals after model calls: the observed per-call counts are kept, usage_complete 0, the allowance charged', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ positive: 'failure_no_totals' });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const row = await positiveRow(fx, project, attempt.id);
    // Observed per call: (40000 + 80000) + (30000 + 10000) billable input,
    // 80000 cache read, 500 + 700 output.
    assert.deepEqual([row.billable_in, row.cached_in, row.out], [160000, 80000, 1200], `the observed per-call counts are kept when the terminal event carries none (${JSON.stringify(row)})`);
    assert.equal(row.usage_complete, 0, 'usage incomplete');
    const limit = await runLimit(fx, project);
    assert.equal(row.unknown_allowance_tokens, Math.max(0, limit - 161200), `the allowance charged on the remainder (${JSON.stringify(row)})`);
    // The attempt ends after the canary's ledger row is written: waited for,
    // not read at once (a race seen 2026-10-05: it read `running`).
    const ended = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(ended.status, 'failed', 'the failed positive canary fails the attempt');
  });

  test('S2 (a): an inventory listing a tool outside the template\'s --tools (Skill) is not delegation_verified; the attempt does not succeed', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ extra_tools: ['Skill'] });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const { caps } = containmentCapabilities(fx, done);
    assert.equal(caps?.delegation_verified, false, `an inventory with Skill, a tool the template does not grant, is not delegation_verified (E74 item 3): ${JSON.stringify(caps)}`);
    assert.notEqual(done.status, 'succeeded', 'and the attempt does not succeed');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "trust_entries" WHERE "qualification_attempt" = ?').get(attempt.id).n), 0, 'no entry is written');
  });

  test('S2 (b): a host sampler that never identified the backend (its process title hides the binary) does not pass: not delegation_verified; the attempt does not succeed', async (t) => {
    const { fx, fake, project } = await fakeFixture(t);
    fake.set({ hide_title: true });
    const attempt = await qualify(fx, body(fake, project));
    await approveAttempt(fx, project, attempt.id);
    const done = await waitAttempt(fx.home, attempt.id, ['succeeded', 'failed', 'invalidated'], { timeoutMs: 600_000 });
    assert.equal(canaryOf(done, 'positive')?.passed, true, `the fixture is live: the positive canary passed (${JSON.stringify(done.canaries)})`);
    const { caps, ev } = containmentCapabilities(fx, done);
    assert.equal(caps?.delegation_verified, false, `a sampler that never saw the backend shows nothing absent: not delegation_verified (E74 item 3): ${JSON.stringify({ caps, sampling: ev.sampling ?? null })}`);
    assert.notEqual(done.status, 'succeeded', 'and the attempt does not succeed');
  });
});
