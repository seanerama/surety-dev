// M612, the receipt and the untouched planned workflow (the owner's draft M7
// plan §3, row M612; request §6, §7, §8; ruling R9 of 2026-10-28, with S3;
// SEAM.md §575). Kernel lane.
//
//   (a) receipt.json of an alpha_ready iteration: an attachment; agent runs,
//       roles, invocations, the token categories with their rule,
//       completeness, cost by status with its pricing basis, unknown
//       allowances, the preparation subtotal, time to Alpha, limitations
//       with human_acceptance not_recorded; nothing claims visual (or any
//       person's) acceptance.
//   (b) the receipt of a failed, a stopped and a discarded iteration, and of
//       an alpha_ready one whose environment was torn down: the historical
//       outcome and "Alpha not currently available" kept distinct.
//   (c) secrets: no key, token, grant or budget snapshot in the receipt.
//   (d) a planned project beside a prototype, through M5's journey to
//       `developing` and its first build dispatch: its decisions, policy
//       and behaviour as M5; nothing of either counted in the other.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { operationsOf } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { architectSession, createWithIdea, specSession, visionSession } from './harness/journey/drive.mjs';
import { tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import {
  CHECK_KINDS,
  PROTO,
  SERVER,
  alphaReady,
  answerOpen,
  assertAccounted,
  briefToAlpha,
  builderScript,
  candidatesOfProject,
  confirmed,
  firstPlanScript,
  holdingBuilder,
  idle,
  iterationRead,
  kindNext,
  ok,
  policyRead,
  protoEngine,
  pump,
  result,
  runsOfProjectRows,
  scriptTeardown,
  statusIs,
  toBrief,
  usage,
  workOfProject,
  write,
} from './harness/prototype.mjs';

const receiptOf = async (fx, p, it) => {
  const res = await fx.engine.get(`/v1/projects/${p}/iterations/${it}/receipt.json`);
  assert.equal(res.status, 200, `GET …/receipt.json (→ ${res.status} ${res.text.slice(0, 400)})`);
  return res;
};
// Every leaf of a value with its path.
const leaves = (v, path = [], out = []) => {
  if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
  else out.push([path, v]);
  return out;
};
const keysOf = (v, out = new Set()) => {
  if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (!Array.isArray(v)) out.add(k);
    keysOf(x, out);
  }
  return out;
};
const priced = (input, cached, out) => ({ usage: { semantics: 'cumulative', raw: { input_tokens: input, cache_read_tokens: cached, output_tokens: out, model: 'scripted-priced' } } });
const reported = (input, cached, out, usd) => ({ usage: { semantics: 'cumulative', raw: { input_tokens: input, cache_read_tokens: cached, output_tokens: out, cost_usd: usd } } });

describe('M612 the receipt and the untouched planned workflow', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    const fx = await protoEngine(shared.context);
    S.fx = fx;
    // An alpha_ready iteration with every kind of cost and an unknown
    // allowance: the first plan's usage priced (estimated), stage 2's
    // reported, the others unknown; stage 1's first run stopped by the owner
    // (its allowance charged), its work resumed. The per-run limit is
    // lowered so the stopped run's allowance leaves room for the rest.
    const { id: p, it } = await toBrief(fx, { name: 'Tasks receipt', policy: { budget_run_billable_tokens: 100_000 } });
    S.p = p;
    S.it = it.id;
    kindNext(fx, 'replan', [{ steps: [priced(2000, 500, 900), ...firstPlanScript().steps.slice(1)] }], firstPlanScript());
    kindNext(fx, 'stage_build', [holdingBuilder('receipt'), builderScript(1), { steps: [reported(1500, 500, 700, 0.42), write('src/s2.mjs', 'export const s2 = 2;\n'), result()] }], builderScript(1));
    await answerOpen(fx, p, 'spec_approval');
    S.env = await alphaReady(fx, p);
    const under = await pump(fx, p, async () => {
      const r = await iterationRead(fx, p, it.id);
      return r.usage.runs.find((x) => x.work_kind === 'stage_build' && x.finished_at === null && x.invocations[0]?.usage.billable_in === 1000);
    }, { answer: CHECK_KINDS, wait: false, what: 'stage 1 under way' });
    await confirmed(fx, `/v1/projects/${p}/runs/${under.id}/stop`);
    await idle(fx, p);
    await ok(fx.engine.post(`/v1/projects/${p}/work/${under.work_item}/resume`, {}), 200, 'the held work resumed');
    await pump(fx, p, statusIs(fx, p, it.id, 'alpha_ready'), { answer: CHECK_KINDS, max: 100, what: 'alpha_ready' });
    S.read = await iterationRead(fx, p, it.id);
    S.receipt = await receiptOf(fx, p, it.id);
  });
  after(() => shared.cleanup());

  test('(a) receipt.json of an alpha_ready iteration: an attachment holding runs, roles, invocations, token categories with their rule, completeness, cost by status with its pricing basis, unknown allowances, the preparation subtotal, time to Alpha and limitations; no acceptance claimed', () => {
    const { receipt: res, read } = S;
    assert.match(res.headers['content-disposition'] ?? '', /^attachment; filename="surety-receipt-[A-Za-z0-9_-]+\.json"$/, 'served as an attachment');
    const r = res.body;
    assert.deepEqual([r.receipt_version, r.project, r.iteration_id, r.outcome.status], [1, S.p, S.it, 'alpha_ready']);
    const t = r.usage.totals;
    assert.equal(t.agent_runs, r.usage.runs.length, 'agent runs');
    assert.ok(t.agent_runs >= 7, `every run of the iteration (${t.agent_runs})`);
    assert.deepEqual(t.roles_used, [...new Set(r.usage.runs.map((x) => x.role))], 'the roles, each once');
    assert.ok(['spec_writer', 'architect', 'verifier', 'builder'].every((x) => t.roles_used.includes(x)), JSON.stringify(t.roles_used));
    assert.equal(t.invocations, r.usage.runs.reduce((n, x) => n + x.invocations.length, 0), 'invocations');
    assert.deepEqual(Object.keys(t.tokens).sort(), ['billable_in', 'cached_in', 'normalization', 'out', 'total', 'total_is', 'total_reason'].sort(), 'the token categories');
    assert.deepEqual(t.tokens.normalization, { scripted: 'scripted-1: input, cache reads and output as reported, each counted once' }, 'with the rule');
    assert.equal(t.tokens.total_is, 'lower_bound', 'a lower bound: the stopped run\'s usage is incomplete');
    assert.deepEqual(Object.keys(t.completeness).sort(), ['complete', 'incomplete', 'not_launched', 'pending']);
    assert.ok(t.completeness.incomplete >= 1 && t.completeness.complete >= 1);
    assert.equal(t.cost.reported_usd, 0.42, 'reported cost, by status');
    assert.equal(t.cost.estimated_usd, (2000 * 2 + 500 * 0.5 + 900 * 8) / 1_000_000, 'estimated cost at the price table');
    assert.ok(t.cost.unknown_invocations >= 1, 'invocations of unknown cost counted, never as 0');
    assert.deepEqual(t.cost.pricing_bases, ['scripted-prices-1'], 'with its pricing basis');
    const est = r.usage.runs.flatMap((x) => x.invocations).find((i) => i.cost.status === 'estimated');
    assert.equal(est.cost.pricing_basis, 'scripted-prices-1');
    assert.ok(t.unknown_allowance_tokens > 0, 'the stopped run\'s unknown allowance');
    assert.equal(t.preparation.runs, 1);
    assert.equal(t.preparation.tokens, 1900, 'the preparation subtotal');
    assert.ok(typeof r.time.approval_to_alpha_seconds === 'number' && r.time.approval_to_alpha_seconds >= 0, 'time to Alpha');
    assert.equal(typeof r.time.preparation_seconds, 'number');
    assert.equal(r.limitations.human_acceptance, 'not_recorded');
    assert.match(r.limitations.statement, /records no human acceptance/);
    assert.deepEqual(r.limitations.brief, read.brief.limitations);
    const claims = leaves(r).filter(([path, v]) => path.some((k) => /visual|accepted_by|human_accept|signed_off|acceptance/i.test(k)) && !(path.at(-1) === 'human_acceptance' && v === 'not_recorded'));
    assert.deepEqual(claims, [], 'no field claims visual or human acceptance');
    assert.ok(!leaves(r).some(([path, v]) => /accept/i.test(String(path.at(-1))) && v === true), 'no acceptance flag is true');
    assertAccounted(r, 'the receipt');
  });

  test('(c) secrets: no key, token, grant or budget snapshot in the receipt', () => {
    const { fx, receipt: res } = S;
    const text = res.text;
    const apiToken = readFileSync(join(fx.home, 'api.token'), 'utf8').trim();
    assert.ok(!text.includes(apiToken), 'the engine\'s API token is not in it');
    const keys = [...keysOf(res.body)];
    const forbidden = keys.filter((k) => /grant|budget_snapshot|capabilit|credential|secret|api_key|apikey|password|private_key|access_token|refresh_token|setup_token|^token$/i.test(k));
    assert.deepEqual(forbidden, [], `no key, token, grant or budget snapshot field (${forbidden})`);
    assert.doesNotMatch(text, /"budget_snapshot"|"prototype_allowance"|"capability"/, 'no receipt budget snapshot');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8}|-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'no key material');
  });

  test('(b) failed, stopped and discarded iterations, and an alpha_ready one torn down: the historical outcome and "Alpha not currently available" distinct', async () => {
    const { fx, p, it, env } = S;
    // alpha_ready, then its environment torn down: the outcome stays alpha_ready (history), Alpha is not currently available.
    await scriptTeardown(fx, env);
    const td = await fx.engine.post(`/v1/projects/${p}/environments/alpha/teardown`, {});
    assert.ok(td.status >= 200 && td.status < 300, `the owner's teardown (→ ${td.status} ${td.text})`);
    await pump(fx, p, () => operationsOf(fx.home, p, 'teardown').find((o) => o.finalized_at !== null), { max: 12, what: 'the teardown' });
    const torn = (await receiptOf(fx, p, it)).body;
    assert.deepEqual([torn.outcome.status, torn.iteration.alpha_at, torn.alpha.deployed_at, torn.alpha.candidate], ['alpha_ready', S.read.iteration.alpha_at, S.read.alpha.deployed_at, S.read.alpha.candidate], 'the historical outcome kept');
    assert.equal(torn.alpha.current, null, 'Alpha not currently available');
    assert.equal(candidatesOfProject(fx.home, p).find((c) => c.id === S.read.alpha.candidate).progress, 'developing', 'its candidate no longer claimed alpha_deployed');

    // Failed: a stage fails with no repair allowed.
    const f = await toBrief(fx, { name: 'Tasks failed', policy: { repair_attempts_max: 0 } });
    kindNext(fx, 'stage_build', [{ steps: [usage(300, 0, 100), { exit: 3 }] }], builderScript(1));
    await answerOpen(fx, f.id, 'spec_approval');
    await alphaReady(fx, f.id, { port: 18086 });
    await pump(fx, f.id, statusIs(fx, f.id, f.it.id, 'failed'), { answer: CHECK_KINDS, what: 'the iteration failed' });
    // Stopped: Stop while the brief awaits approval.
    const s = await toBrief(fx, { name: 'Tasks stopped' });
    await confirmed(fx, `/v1/projects/${s.id}/iterations/${s.it.id}/stop`);
    // Discarded: after its own Alpha, discarded (its Alpha torn down).
    const d = await toBrief(fx, { name: 'Tasks discarded' });
    const denv = await briefToAlpha(fx, d.id, d.it.id, { port: 18087 });
    const dAlpha = await iterationRead(fx, d.id, d.it.id);
    await scriptTeardown(fx, denv);
    await confirmed(fx, `/v1/projects/${d.id}/iterations/${d.it.id}/discard`);
    await pump(fx, d.id, () => operationsOf(fx.home, d.id, 'teardown').find((o) => o.finalized_at !== null), { max: 12, what: 'the discard\'s teardown' });

    for (const [p_, it_, status, alphaAt] of [[f.id, f.it.id, 'failed', null], [s.id, s.it.id, 'stopped', null], [d.id, d.it.id, 'discarded', dAlpha.iteration.alpha_at]]) {
      const r = (await receiptOf(fx, p_, it_)).body;
      assert.equal(r.outcome.status, status, `${status}: the historical outcome`);
      assert.ok(r.outcome.reason, `${status}: with its reason`);
      assert.ok(r.outcome.next_step, `${status}: and its next step`);
      assert.equal(r.alpha.current, null, `${status}: Alpha not currently available`);
      assert.equal(r.iteration.alpha_at, alphaAt, `${status}: alpha_at as it happened`);
      assert.equal(r.limitations.human_acceptance, 'not_recorded');
    }
    const dr = (await receiptOf(fx, d.id, d.it.id)).body;
    assert.deepEqual([dr.alpha.deployed_at, dr.alpha.candidate, dr.alpha.deployment_request], [dAlpha.alpha.deployed_at, dAlpha.alpha.candidate, dAlpha.alpha.deployment_request], 'discarded: its Alpha history kept beside "not currently available"');
  });

  test('(d) a planned project beside a prototype, through M5\'s journey to developing and its first build dispatch: its decisions, policy and behaviour as M5; nothing of either counted in the other', async () => {
    const { fx, p: proto, it } = S;
    const protoBefore = await iterationRead(fx, proto, it);
    const project = await createWithIdea(fx);
    await visionSession(fx, project.id);
    await specSession(fx, project.id);
    const arch = await architectSession(fx, project.id, project.repo);
    assert.ok(arch.published, 'its plan published on the owner\'s two approvals, as M5');
    const kinds = withStore(fx.home, (db) => db.prepare('SELECT "kind", "status" FROM "decisions" WHERE "project" = ? ORDER BY "seq"').all(project.id));
    assert.deepEqual(kinds.map((k) => k.kind), ['idea_accept', 'spec_approval', 'architecture_approval', 'plan_approval'], `its decisions are M5's (${JSON.stringify(kinds)})`);
    assert.ok(kinds.every((k) => k.status === 'consumed'));
    const read = (await ok(fx.engine.get(`/v1/projects/${project.id}`), 200, 'GET …/projects/:p')).project;
    assert.deepEqual([read.mode, read.prototype], ['planned', null]);
    const policy = await policyRead(fx, project.id);
    assert.notEqual(policy.effective.budget_run_billable_tokens, PROTO.preset.budget_run_billable_tokens, 'not the prototype preset');
    assert.notDeepEqual(policy.effective.phase_size, PROTO.preset.phase_size);
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "prototype_iterations" WHERE "project" = ?').get(project.id).n), 0, 'no iteration');
    // Its first build: check authoring dispatched as M5 (the check correction is the owner's).
    await pump(fx, project.id, () => workOfProject(fx.home, project.id).find((w) => w.kind === 'check_authoring' && w.status !== 'eligible'), { max: 6, what: 'its check authoring dispatched' });
    const runs = runsOfProjectRows(fx.home, project.id);
    assert.ok(runs.length >= 1 && runs.every((r) => r.iteration === null), 'its runs are attributed to no iteration');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "decisions" WHERE "project" = ? AND "kind" = ?').get(project.id, PROTO.preparation.decision).n), 0, 'no prototype question');
    await tick(fx.engine, proto);
    const protoAfter = await iterationRead(fx, proto, it);
    assert.deepEqual(protoAfter.usage, protoBefore.usage, "the prototype's usage counts nothing of the planned project");
    assert.deepEqual(protoAfter.app_totals, protoBefore.app_totals, "nor do the app's totals");
  });
});
