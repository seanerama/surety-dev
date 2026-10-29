// M611 (e), replacement withdraws the replaced candidate's claim, and an
// observation made before a finalized deployment or teardown no longer
// reads as current (the owner's M7 plan §3, row M611 (e), as amended for
// his ruling of 2026-10-29: "Keep historical deployment evidence separate
// from current availability. Teardown or replacement must remove any claim
// that the old candidate is currently available."; objection 224; SEAM.md
// §579). Kernel lane, the scripted deployment adapter: the store's and the
// reads' part of the row. A replacement on a real unit (M611 (a) to (d)'s
// lane) is not exercised here.
//
//   (e) replacement: iteration 1 of a rapid prototype at its Alpha and
//       observed current; iteration 2 driven to its own Alpha in the same
//       environment. Iteration 2's deployment, once finalized, withdraws
//       iteration 1's candidate: `candidate.alpha_replaced` once, in that
//       operation's finalizing transaction, naming the environment, the
//       operation and the candidate that replaced it; the candidate
//       `developing`; iteration 1's `alpha.current_state` `replaced`,
//       `alpha.current` null, its served `next_step` no longer `open_alpha`;
//       its history kept (outcome status and reason, `alpha_at`, its
//       candidate, deployment request and deployed_at, the request rows,
//       `candidate.advanced`).
//   (e) the observation made before that deployment was finalized reads
//       `unknown`/`expired` with `ended_by` (kind deployment, the operation),
//       on the environment read and on the environments list (`state`
//       unknown); the stored observation and the observation history are
//       untouched.
//   (e) teardown: after a fresh observation of iteration 2's deployment, a
//       finalized teardown: that observation reads `unknown`/`expired` with
//       `ended_by` (kind teardown, the operation), the stored observation
//       and the history untouched; iteration 2's `alpha.current_state`
//       `torn_down`, its `next_step` no longer `open_alpha`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { candidateRow, environmentRecord, operationsOf, teardown } from './harness/deploy/kernel.mjs';
import { historyOf } from './harness/deploy/observe.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { withStore } from './harness/store.mjs';
import { PROTO, briefToAlpha, iterateToAlpha, iterationRead, iterationsRead, observedCurrent, protoEngine, pump, scriptTeardown, toBrief } from './harness/prototype.mjs';

const requestsOf = (home, candidate) => withStore(home, (db) => db.prepare('SELECT * FROM "deployment_requests" WHERE "candidate" = ? ORDER BY rowid').all(candidate));

async function envRead(fx, p) {
  const res = await fx.engine.get(`/v1/projects/${p}/environments/alpha`);
  assert.equal(res.status, 200, `the environment read (→ ${res.status} ${res.text})`);
  return res.body.environment;
}
async function envList(fx, p) {
  const res = await fx.engine.get(`/v1/projects/${p}/environments`);
  assert.equal(res.status, 200, `the environments list (→ ${res.status} ${res.text})`);
  return res.body.environments.find((e) => e.name === 'alpha');
}
// The environment as it stands: both reads, the stored observation and the history.
const snapshot = async (fx, p, env) => ({
  read: await envRead(fx, p),
  listed: await envList(fx, p),
  stored: environmentRecord(fx.home, env.id)?.observed ?? null,
  history: historyOf(fx.home, env.id),
});

describe('M611 (e) replacement and the end of an observation, on the scripted target', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await protoEngine(shared.context);
    J.fx = fx;
    const { id: p, it } = await toBrief(fx, { name: 'Tasks replaced' });
    Object.assign(J, { p, one: it.id });
    J.env = await briefToAlpha(fx, p, it.id, { port: 18611 });
    await observedCurrent(fx, p, it.id);
    J.oneRead = await iterationRead(fx, p, it.id);
    J.oneCandidate = J.oneRead.alpha.candidate;
    J.oneRequests = requestsOf(fx.home, J.oneCandidate);
    J.beforeReplacement = await snapshot(fx, p, J.env);
    const deploysBefore = operationsOf(fx.home, p, 'deploy').map((o) => o.id);
    // Iteration 2 to its own Alpha in the same environment, nothing torn down between.
    const { two } = await iterateToAlpha(fx, p, it.id, J.env);
    J.two = two;
    J.replacing = operationsOf(fx.home, p, 'deploy').filter((o) => !deploysBefore.includes(o.id));
    J.afterReplacement = await snapshot(fx, p, J.env);
    J.oneAfter = await iterationRead(fx, p, it.id);
    J.list = (await iterationsRead(fx, p)).iterations;
    J.twoAtAlpha = await iterationRead(fx, p, two);
    J.progressAtReplacement = { one: candidateRow(fx.home, J.oneCandidate).progress, two: candidateRow(fx.home, J.twoAtAlpha.alpha.candidate).progress };
    // A fresh observation of iteration 2's deployment, then a finalized teardown.
    await observedCurrent(fx, p, two);
    J.twoObserved = await iterationRead(fx, p, two);
    J.beforeTeardown = await snapshot(fx, p, J.env);
    await scriptTeardown(fx, J.env);
    const asked = await teardown(fx.engine, p, 'alpha');
    assert.ok(asked.status >= 200 && asked.status < 300, `the owner's teardown (→ ${asked.status} ${asked.text})`);
    J.teardownOp = await pump(fx, p, () => operationsOf(fx.home, p, 'teardown').find((o) => o.finalized_at !== null), { what: 'the teardown to finalize' });
    J.afterTeardown = await snapshot(fx, p, J.env);
    J.twoAfter = await iterationRead(fx, p, two);
  });
  after(() => shared.cleanup());

  test('(e) replacement: candidate.alpha_replaced once, in the replacing deployment\'s finalizing transaction, naming the environment, the operation and the replacing candidate; the replaced candidate developing', () => {
    const { fx, oneCandidate, env } = J;
    const twoCandidate = J.twoAtAlpha.alpha.candidate;
    assert.ok(twoCandidate && twoCandidate !== oneCandidate, 'iteration 2 has its own candidate');
    const finalized = J.replacing.filter((o) => o.finalized_at !== null);
    assert.ok(finalized.length >= 1, `iteration 2's deployment operation was finalized (${JSON.stringify(J.replacing.map((o) => [o.id, o.finalized_at]))})`);
    const replaced = eventsOfType(fx.home, 'candidate.alpha_replaced');
    assert.equal(replaced.length, 1, `candidate.alpha_replaced, once (${JSON.stringify(replaced.map((e) => e.payload))})`);
    const [e] = replaced;
    assert.deepEqual(
      [e.subject?.candidate, e.payload?.from, e.payload?.to, e.payload?.environment, e.payload?.replaced_by],
      [oneCandidate, 'alpha_deployed', 'developing', env.id, twoCandidate],
      'it names the replaced candidate, alpha_deployed → developing, the environment and the candidate whose deployment replaced it',
    );
    const op = finalized.find((o) => o.id === e.payload?.operation);
    assert.ok(op, `it names iteration 2's finalized deployment operation (${e.payload?.operation})`);
    const fin = eventsOfType(fx.home, 'operation.finalized').filter((x) => x.subject?.operation === op.id);
    assert.equal(fin.length, 1);
    assert.equal(e.tx, fin[0].tx, "the withdrawal is in the replacing deployment's finalizing transaction");
    assert.equal(J.progressAtReplacement.one, 'developing', 'the replaced candidate no longer claims current availability');
    assert.equal(J.progressAtReplacement.two, 'alpha_deployed', 'the replacing one does');
    assert.ok(!eventsOfType(fx.home, 'candidate.alpha_withdrawn').some((w) => w.subject?.candidate === oneCandidate), 'no teardown withdrew the replaced one');
  });

  test('(e) replacement: the replaced iteration reads replaced, no current Alpha, next_step no longer open_alpha; its history kept', () => {
    const { oneRead, oneAfter, list } = J;
    assert.equal(oneRead.alpha.current_state, 'available', `before, iteration 1's Alpha was available (${oneRead.alpha.current_reason})`);
    assert.equal(oneRead.outcome.next_step, 'open_alpha');
    assert.equal(oneAfter.alpha.current_state, 'replaced', `iteration 1's Alpha replaced (${oneAfter.alpha.current_reason})`);
    assert.equal(oneAfter.alpha.current, null, 'no current Alpha is claimed for it');
    assert.equal(typeof oneAfter.alpha.current_reason, 'string');
    assert.ok(oneAfter.alpha.current_reason.length > 0);
    assert.notEqual(oneAfter.outcome.next_step, 'open_alpha', 'it no longer offers to open the Alpha');
    assert.equal(oneAfter.outcome.next_step, PROTO.next_steps.alpha_gone, 'the guidance that its Alpha is no longer deployed');
    assert.equal(list.find((i) => i.id === J.one)?.next_step, oneAfter.outcome.next_step, 'the list serves the same guidance');
    // History, kept as recorded.
    assert.deepEqual([oneAfter.outcome.status, oneAfter.outcome.reason], [oneRead.outcome.status, oneRead.outcome.reason], 'the historical outcome');
    assert.deepEqual(
      [oneAfter.iteration.status, oneAfter.iteration.alpha_at, oneAfter.alpha.candidate, oneAfter.alpha.deployment_request, oneAfter.alpha.deployed_at, oneAfter.alpha.environment],
      [oneRead.iteration.status, oneRead.iteration.alpha_at, oneRead.alpha.candidate, oneRead.alpha.deployment_request, oneRead.alpha.deployed_at, oneRead.alpha.environment],
      'its Alpha history: status, alpha_at, candidate, deployment request, deployed_at, environment',
    );
    assert.deepEqual(requestsOf(J.fx.home, J.oneCandidate), J.oneRequests, 'the deployment request rows, outcome deployed, unchanged');
    assert.ok(J.oneRequests.every((r) => r.outcome === 'deployed'));
    assert.equal(eventsOfType(J.fx.home, 'candidate.advanced').filter((x) => x.subject?.candidate === J.oneCandidate && x.payload?.to === 'alpha_deployed').length, 1, 'candidate.advanced kept, once');
  });

  test('(e) the observation made before the replacing deployment was finalized: unknown, expired, ended_by the deployment; the stored observation and the history untouched', () => {
    const { beforeReplacement: b, afterReplacement: a } = J;
    const op = eventsOfType(J.fx.home, 'candidate.alpha_replaced')[0]?.payload?.operation;
    assert.ok(b.stored && b.stored.observed_at, 'iteration 1\'s Alpha was observed');
    assert.equal(b.read.observed.freshness, 'fresh');
    assert.equal(b.read.observed.ended_by, undefined, 'before the replacement nothing ended it');
    assert.deepEqual(a.stored, b.stored, `no newer observation was made in between (stored ${JSON.stringify(a.stored)}); the stored observation untouched`);
    assert.deepEqual(a.history, b.history, 'the observation history untouched');
    const o = a.read.observed;
    assert.deepEqual([o.condition, o.freshness, o.stored_condition, o.observed_at], ['unknown', 'expired', b.stored.condition, b.stored.observed_at], `the environment read (${JSON.stringify(o)})`);
    assert.equal(o.ended_by?.kind, 'deployment');
    assert.equal(o.ended_by?.operation, op, 'naming the replacing operation');
    assert.equal(o.expires_at, o.ended_by?.finalized_at, 'expired at the finalization');
    assert.ok(typeof o.ended_by?.reason === 'string' && o.ended_by.reason.includes(op), o.ended_by?.reason);
    assert.equal(a.listed.state, 'unknown', 'the environments list: unknown');
    assert.deepEqual([a.listed.observed.condition, a.listed.observed.freshness, a.listed.observed.ended_by?.kind, a.listed.observed.ended_by?.operation], ['unknown', 'expired', 'deployment', op]);
  });

  test('(e) teardown: the observation of the torn-down deployment reads unknown, expired, ended_by the teardown; stored and history untouched; the iteration torn_down, next_step no longer open_alpha', () => {
    const { beforeTeardown: b, afterTeardown: a, teardownOp } = J;
    assert.equal(J.twoObserved.alpha.current_state, 'available', `iteration 2's Alpha observed available (${J.twoObserved.alpha.current_reason})`);
    assert.equal(b.read.observed.freshness, 'fresh');
    assert.equal(b.read.observed.ended_by, undefined);
    assert.deepEqual(a.stored, b.stored, 'the stored observation untouched');
    assert.deepEqual(a.history, b.history, 'the observation history untouched');
    const o = a.read.observed;
    assert.deepEqual([o.condition, o.freshness, o.stored_condition], ['unknown', 'expired', b.stored.condition], JSON.stringify(o));
    assert.deepEqual([o.ended_by?.kind, o.ended_by?.operation, o.ended_by?.finalized_at], ['teardown', teardownOp.id, teardownOp.finalized_at]);
    assert.equal(o.expires_at, teardownOp.finalized_at);
    assert.equal(a.listed.state, 'unknown');
    assert.deepEqual([a.listed.observed.ended_by?.kind, a.listed.observed.ended_by?.operation], ['teardown', teardownOp.id]);
    assert.equal(J.twoAfter.alpha.current_state, 'torn_down', J.twoAfter.alpha.current_reason);
    assert.equal(J.twoAfter.alpha.current, null);
    assert.equal(J.twoAfter.outcome.next_step, PROTO.next_steps.alpha_gone);
    assert.deepEqual([J.twoAfter.outcome.status, J.twoAfter.iteration.alpha_at], [J.twoAtAlpha.outcome.status, J.twoAtAlpha.iteration.alpha_at], 'its history kept');
  });
});
