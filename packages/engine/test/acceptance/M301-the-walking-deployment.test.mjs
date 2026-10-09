// M301, the deployment journey on the scripted adapter (slice 23). M4 plan
// §3.1 M301; D4 §§1, 3 to 5, 4.6; J1, J3, J4, J5; E40; BS4 §§8, 9; SEAM.md
// §§244 to 251.
//
// The whole of D4 §1 on the kernel lane, made once in the `before` hook,
// each case reading one clause of the row from that history: the owner's
// configuration version 1; a T1 candidate whose workspace checks (acceptance
// and smoke, discovered) pass through the scripted check boundary; the
// labelled qualification facts; `POST …/deployments`; the Release
// Operator's intent, held at the `deploy.intended` barrier and read there;
// attempt 1 against the scripted target (an applying `deploy` answer);
// reconcile, confirmation, the finalizer and the one round; the round's
// identity reads from the scripted target and its required
// `post_deploy_behavior` check recorded passing; completion to
// `alpha_deployed`; and the teardown. If the journey cannot be made, every
// case fails with the step it stopped at.
//
// Not this row's: the artifact's bounds and refusals (M308, M309), the
// real unit (M307), reconcile's other outcomes (M320).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

import { evaluate } from './harness/gates.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { listTree } from './harness/repos.mjs';
import { scriptedEngine, tickUntil, workItem } from './harness/runs.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { withStore } from './harness/store.mjs';
import {
  adapterState,
  armBarrier,
  artifactsOf,
  attemptIntent,
  attemptsOf,
  authorizationRow,
  candidateRow,
  completeRound,
  configContent,
  configsOf,
  deploy,
  deployable,
  deployWork,
  effectCalls,
  environmentLeases,
  environmentRecord,
  environmentRow,
  eventsAbout,
  filesUnder,
  isWritable,
  mappingsOf,
  operationRow,
  operationsOf,
  operationsRead,
  postDeployExecutions,
  releaseBarrier,
  roundsOf,
  scriptCall,
  teardown,
  tickToBarrier,
  unitName,
  verificationsOf,
} from './harness/deploy/kernel.mjs';

const json = (t) => (typeof t === 'string' ? JSON.parse(t) : t);
const hasTable = (home, name) => withStore(home, (db) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined);

describe('M301 the deployment journey on the scripted adapter: configure, request, intend, deploy, verify, complete, tear down', () => {
  const shared = sharedFixture();
  let J;
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    const ctx = await deployable(fx);
    const { project, candidate, env } = ctx;
    J = { fx, ctx, project, candidate, env };
    J.stage = await evaluate(fx.engine, project, candidate.id, 'stage', { stage: ctx.p.stages[0].id }, { inventory: false });

    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    await armBarrier(fx.engine, 'deploy.intended', 'pause');
    J.request = await deploy(fx.engine, project, candidate.id, env.name);
    J.atRequest = { authorization: authorizationRow(fx.home, J.request.authorization.id), work: deployWork(fx.home, project) };

    // The Release Operator's intent, read while the engine waits at deploy.intended.
    await tickToBarrier(fx, project, 'deploy.intended');
    const [op] = operationsOf(fx.home, project, 'deploy');
    J.atIntent = {
      op,
      leases: environmentLeases(fx.home, env.id),
      authorization: authorizationRow(fx.home, J.request.authorization.id),
      read: (await operationsRead(fx.engine, project)).find((o) => o.id === op?.id),
      attempts: op ? attemptsOf(fx.home, op.id) : [],
    };
    await releaseBarrier(fx.engine, 'deploy.intended');

    // The effect, its confirmation and the round.
    J.execution = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, candidate.id)[0], { max: 16, what: 'the round to register its post-deploy check' });
    J.op = operationRow(fx.home, op.id);
    J.attempts = attemptsOf(fx.home, op.id);
    J.intent = attemptIntent(fx.home, J.attempts[0]?.id);
    J.atRound = { record: environmentRecord(fx.home, env.id), rounds: roundsOf(fx.home, op.id), adapter: await adapterState(fx.engine, env.id), env: environmentRow(fx.home, env.id) };

    // The check passes; completion.
    await completeRound(ctx, J.execution);
    J.rounds = roundsOf(fx.home, op.id);
    J.verifications = verificationsOf(fx.home, J.rounds[0].id);
    J.atCompletion = { record: environmentRecord(fx.home, env.id), leases: environmentLeases(fx.home, env.id), op: operationRow(fx.home, op.id), read: (await operationsRead(fx.engine, project)).find((o) => o.id === op.id) };

    // The teardown.
    await scriptCall(fx.engine, env.id, 'teardown', [{ result: 'issued', apply: true }]);
    const asked = await teardown(fx.engine, project, env.name);
    assert.ok(asked.status >= 200 && asked.status < 300, `the operator's teardown is accepted (→ ${asked.status} ${asked.text})`);
    J.teardown = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'teardown').find((o) => o.finalized_at !== null), { max: 12, what: 'the teardown to be finalized' });
    J.after = { record: environmentRecord(fx.home, env.id), adapter: await adapterState(fx.engine, env.id), read: (await operationsRead(fx.engine, project)).find((o) => o.id === J.teardown.id) };
  });
  after(() => shared.cleanup());

  test('(a) the owner writes configuration version 1: an immutable environment_configs row with its config_identity; environment.configured', () => {
    const { fx, ctx, env } = J;
    const configs = configsOf(fx.home, env.id);
    assert.deepEqual(
      configs.map((c) => [c.version, c.status, c.config_identity]),
      [[1, 'current', ctx.config.config_identity]],
      'one version, version 1, current, with the identity the PUT answered',
    );
    assert.deepEqual(configs[0].content, configContent(), 'its content is what the owner wrote');
    assert.match(configs[0].config_identity, /^sha256:[0-9a-f]{64}$/);
    const row = environmentRow(fx.home, env.id);
    assert.deepEqual([row.name, row.adapter, row.current_config], ['alpha', 'local_service', configs[0].id], 'the environment is the one named, of adapter local_service, version 1 current');
    assert.equal(eventsAbout(fx.home, 'environment.configured', 'environment', env.id).length, 1, 'environment.configured, once');
  });

  test('(b) the stage gate satisfied on engine-observed workspace results; the request seals an artifact, records the authorization proposed with engine-derived bindings, issues it and creates one deploy work item', () => {
    const { fx, ctx, project, candidate, env, request, atRequest } = J;
    assert.equal(J.stage.outcome, 'satisfied', `the stage gate is satisfied on the scripted boundary's results (reasons: ${JSON.stringify(J.stage.reasons)})`);

    const [artifact, ...more] = artifactsOf(fx.home, project);
    assert.equal(more.length, 0, 'one artifact');
    assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(artifact.status, 'sealed');
    assert.ok(artifact.path.startsWith(`${fx.home}/artifacts/`), `sealed under $SURETY_HOME/artifacts/ (${artifact.path})`);
    assert.equal(eventsOfType(fx.home, 'artifact.sealed').length, 1, 'artifact.sealed, once');
    const tree = listTree(ctx.p.repo.path, candidate.revision);
    const projected = Object.keys(tree).filter((path) => !path.startsWith('.surety/')).sort();
    const sealed = filesUnder(artifact.path);
    assert.deepEqual(Object.keys(sealed).sort(), projected, "the sealed directory holds the revision's tracked files minus .surety/, and nothing else");
    for (const path of projected) {
      const oid = tree[path].split(' ')[2];
      assert.ok(sealed[path].equals(execFileSync('git', ['-C', ctx.p.repo.path, 'cat-file', 'blob', oid])), `${path} is its blob's bytes`);
      assert.equal(isWritable(`${artifact.path}/${path}`), false, `${path} has no write bit`);
    }
    const mappings = mappingsOf(fx.home, artifact.id);
    assert.deepEqual(mappings.map((m) => [m.dev_revision, m.config_version]), [[candidate.revision, ctx.config.id]], "one mapping, naming the candidate's revision and configuration version 1");

    assert.equal(request.evaluation?.outcome, 'satisfied', 'the answer carries the satisfied alpha_authorize evaluation');
    const auth = atRequest.authorization;
    assert.deepEqual(
      [auth.status, auth.environment, auth.artifact_digest, auth.config_identity, json(auth.target_set)],
      ['issued', env.id, artifact.digest, ctx.config.config_identity, ['app']],
      'issued, bound to the sealed digest, the current identity and its one target: all engine-derived',
    );
    assert.equal(json(auth.source_delivery_mapping).dev_revision, candidate.revision, "the mapping it carries is its own candidate's revision");
    assert.deepEqual(
      atRequest.work.map((w) => [w.id, w.trigger_source, w.trigger_id, w.trigger_generation]),
      [[request.work_item.id, 'deployment_request', auth.id, 1]],
      'one deploy work item, trigger (deployment_request, <authorization>, 1)',
    );
  });

  test('(c) the intent: the environment lease taken; one deploy operation; the authorization consumed; the frozen intent naming no unit; the journal intended (deploy_apply); the orchestration deadline and stage', () => {
    const { fx, env, candidate, atIntent } = J;
    const { op } = atIntent;
    assert.ok(op, 'a deploy operation exists at deploy.intended');
    assert.deepEqual(atIntent.leases.map((l) => l.released_at), [null], 'one environment lease, held');
    assert.equal(atIntent.authorization.status, 'consumed', 'the authorization is consumed in the intent');
    assert.equal(eventsOfType(fx.home, 'authorization.consumed').length, 1, 'authorization.consumed, once');
    assert.deepEqual([op.kind, op.target?.environment, op.subject?.candidate, op.subject?.artifact_digest], ['deploy', env.id, candidate.id, J.atRequest.authorization.artifact_digest]);
    assert.deepEqual(atIntent.attempts, [], 'no attempt yet');
    const fi = op.finalizer_inputs;
    assert.deepEqual(
      [fi.authorization, fi.artifact_digest, fi.config_identity, fi.config_version, fi.target_set, fi.environment],
      [J.atRequest.authorization.id, J.atRequest.authorization.artifact_digest, J.ctx.config.config_identity, J.ctx.config.id, ['app'], env.id],
      "the operation's frozen intent: the authorization, digest, configuration version and identity, targets and environment",
    );
    assert.ok(typeof fi.mapping === 'string' && fi.mapping.length > 0, 'and the source mapping');
    assert.doesNotMatch(JSON.stringify(fi), /\.service|surety-[0-9a-f]{12}-/, 'it names no unit');
    assert.deepEqual([atIntent.read?.journal_kind, (atIntent.read?.journal ?? []).map((e) => e.event_kind)], ['deploy_apply', ['intended']], 'the journal: intended, of kind deploy_apply');
    assert.equal(Date.parse(op.orchestration_deadline_at) - Date.parse(op.created_at), 1800 * 1000, 'the orchestration deadline is the intent plus deploy_orchestration_deadline (1,800 s)');
    assert.equal(op.orchestration_stage, 'effect');
  });

  test('(d) attempt 1: generation 1; its intent names g1\'s unit and no prior; a capability; issued recorded as a claim; reconcile applied; succeeded; attempted written; one round created by the finalizer', () => {
    const { fx, env, attempts, intent, atRound } = J;
    const unit = unitName(fx.home, env.id, 1);
    assert.deepEqual(attempts.map((a) => [a.attempt_number, a.deployment_generation, a.status]), [[1, 1, 'succeeded']], 'one attempt, generation 1, succeeded');
    assert.deepEqual([atRound.env.deployment_generation, atRound.env.current_generation], [1, 1], "the environment's counter and current generation are 1");
    assert.deepEqual([intent?.generation, intent?.create_units, intent?.prior, intent?.cleanup], [1, [unit], [], []], "the attempt's frozen intent: g1's unit, no prior, no cleanup");
    const cap = attempts[0].capability;
    assert.deepEqual([cap?.environment, cap?.operation, cap?.attempt, cap?.generation, cap?.create_units], [env.id, J.op.id, attempts[0].id, 1, [unit]], 'the capability minted from that intent');
    assert.deepEqual([attempts[0].receipt?.result, attempts[0].receipt?.provenance], ['issued', 'claimed'], "the adapter's issued, recorded as a claim");
    assert.equal(attempts[0].reconciliation_reads.at(-1)?.result, 'applied', 'reconcile read applied');
    const scripted = atRound.adapter.target.units.find((u) => u.name === unit);
    assert.ok(scripted, `the scripted target holds ${unit}`);
    assert.deepEqual([attempts[0].app_instance?.pid, attempts[0].app_instance?.start_time], [scripted.instance.pid, scripted.instance.start_time], 'the original application instance recorded at the launch is the one the target runs');
    const at = atRound.record?.attempted;
    assert.deepEqual([at?.operation, at?.attempt, at?.generation, at?.outcome], [J.op.id, attempts[0].id, 1, 'applied'], "the environment's attempted fact");
    assert.deepEqual(atRound.rounds.map((r) => r.round), [1], 'exactly one round, created by the finalizer');
    assert.equal(effectCalls(atRound.adapter, 'deploy').length, 1, 'one deploy call');
  });

  test("(e) the round: two identity reads matching; the check registered with trigger (deployment_verification, O:1, 1) and its deployment binding; passed; a verified deployment_verifications row; last_verified naming candidate, digest, identity, generation 1 and round 1", () => {
    const { fx, env, candidate, execution, rounds, verifications, attempts, atCompletion } = J;
    const digest = J.atRequest.authorization.artifact_digest;
    assert.deepEqual([execution.key, execution.trigger], ['behaves', { source: 'deployment_verification', id: `${J.op.id}:1`, generation: 1 }]);
    assert.deepEqual(execution.deployment, { operation: J.op.id, attempt: attempts[0].id, deployment_generation: 1, round: rounds[0].id }, 'bound to the operation, attempt, generation and round');
    assert.deepEqual([execution.environment, execution.artifact_digest], [env.id, digest]);
    const result = withStore(fx.home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ?').get(execution.id));
    assert.equal(result?.exit_status, 0, 'its result passed');
    assert.ok(json(rounds[0].required_checks).includes(execution.check), "the round's required set holds it");
    assert.equal(verifications.length, 1, 'one verification row');
    const [v] = verifications;
    assert.equal(v.outcome, 'verified');
    const reads = v.identity_reads;
    assert.deepEqual(reads.map((r) => [r.target, r.bracket, r.method, r.match, r.expected, r.read, r.generation]), [
      ['app', 'first', 'tree_digest', 'match', digest, digest, 1],
      ['app', 'second', 'tree_digest', 'match', digest, digest, 1],
    ]);
    for (const r of reads) assert.deepEqual([r.instance?.pid, r.instance?.start_time], [attempts[0].app_instance.pid, attempts[0].app_instance.start_time], 'with the original instance throughout');
    const lv = atCompletion.record?.last_verified;
    assert.deepEqual(
      [lv?.candidate, lv?.artifact_digest, lv?.config_identity, lv?.generation, lv?.round, lv?.verification],
      [candidate.id, digest, J.ctx.config.config_identity, 1, rounds[0].id, v.id],
      'last_verified names the candidate, digest, identity, generation 1 and round 1',
    );
    assert.equal(rounds[0].round, 1);
  });

  test('(f) alpha_complete satisfied: in one transaction the candidate developing → alpha_deployed (candidate.advanced) and the work item complete; the lease released; no releases row', () => {
    const { fx, project, candidate, request, atCompletion } = J;
    assert.equal(candidateRow(fx.home, candidate.id).progress, 'alpha_deployed');
    const evaluations = withStore(fx.home, (db) => db.prepare(`SELECT * FROM "gate_evaluations" WHERE "candidate" = ? AND "gate_kind" = 'alpha_complete' ORDER BY rowid`).all(candidate.id));
    const satisfied = evaluations.filter((e) => e.outcome === 'satisfied');
    assert.equal(satisfied.length, 1, 'one satisfied alpha_complete evaluation');
    const advanced = eventsOfType(fx.home, 'candidate.advanced');
    assert.equal(advanced.length, 1, 'candidate.advanced, once');
    assert.equal(advanced[0].subject?.candidate, candidate.id);
    assert.equal(workItem(fx.home, request.work_item.id).status, 'complete', 'the deploy work item is complete');
    const completed = withStore(fx.home, (db) =>
      db.prepare(`SELECT * FROM "events" WHERE "type" LIKE 'work.%' AND json_extract("subject", '$.work_item') = ? AND json_extract("payload", '$.to') = 'complete'`).all(request.work_item.id),
    );
    const evaluated = eventsOfType(fx.home, 'gate.evaluated').filter((e) => e.subject?.evaluation === satisfied[0].id || e.payload?.evaluation === satisfied[0].id);
    assert.equal(completed.length, 1, "the work item's completion event");
    assert.equal(completed[0].tx, advanced[0].tx, 'the advance and the completion are one transaction');
    if (evaluated.length > 0) assert.equal(evaluated[0].tx, advanced[0].tx, "and it is the evaluation's");
    assert.ok(atCompletion.leases.length >= 1 && atCompletion.leases.every((l) => l.released_at !== null), 'the environment lease is released');
    assert.equal(atCompletion.op.status, 'succeeded');
    assert.equal(atCompletion.op.orchestration_stage, 'ended');
    if (hasTable(fx.home, 'releases')) assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "releases" WHERE "project" = ?').get(project).n), 0, 'no releases row');
  });

  test('(g) surety env teardown: a teardown operation journaled as teardown_apply, applied; attempted teardown_applied; last_verified kept; observed not written by the teardown', () => {
    const { fx, env, teardown: op, atCompletion, after } = J;
    assert.deepEqual([op.status, after.read?.journal_kind, (after.read?.journal ?? []).map((e) => e.event_kind)], ['succeeded', 'teardown_apply', ['intended', 'applied', 'confirmed', 'finalized']]);
    const [attempt] = attemptsOf(fx.home, op.id);
    assert.equal(attempt?.reconciliation_reads.at(-1)?.result, 'applied', "the teardown's reconcile read applied");
    assert.equal(after.record.attempted?.outcome, 'teardown_applied');
    assert.deepEqual(after.record.last_verified, atCompletion.record.last_verified, 'last_verified is kept');
    assert.deepEqual(after.record.observed, atCompletion.record.observed, 'observed is not written by the teardown');
    assert.deepEqual(after.adapter.target.units.filter((u) => u.name.startsWith(`surety-`) && u.name.includes(env.id)), [], 'the scripted target holds no unit of the environment');
    assert.equal(effectCalls(after.adapter, 'teardown').length, 1);
  });

  test('(h) provenance: no check result from the fixture route or a role; every adapter call through adapterCall with a capability of its attempt; no role but the Builder launched', async () => {
    const { fx, project, after } = J;
    const results = withStore(fx.home, (db) => db.prepare('SELECT r."id", r."execution", x."trigger" FROM "check_results" r LEFT JOIN "check_executions" x ON x."id" = r."execution" WHERE r."project" = ?').all(project));
    assert.ok(results.length >= 3, 'the workspace and post-deploy results are there');
    for (const r of results) {
      assert.ok(r.execution, `result ${r.id} names an execution the engine registered`);
      assert.ok(['nomination', 'deployment_verification'].includes(json(r.trigger)?.source), `result ${r.id}'s execution was registered by the engine's nomination or round`);
    }
    const attempts = [...operationsOf(fx.home, project, 'deploy'), ...operationsOf(fx.home, project, 'teardown')].flatMap((o) => attemptsOf(fx.home, o.id).map((a) => [a.id, o.id]));
    const effects = after.adapter.calls.filter((c) => c.call === 'deploy' || c.call === 'teardown');
    assert.equal(effects.length, 2, 'two effect calls in all');
    for (const c of effects) assert.ok(attempts.some(([a, o]) => c.capability?.attempt === a && c.capability?.operation === o), `the ${c.call} call carried its attempt's capability (${JSON.stringify(c.capability)})`);
    assert.deepEqual(fx.scripted.launches().map((l) => l.role), ['builder'], 'the Builder is the only role launched: no agent deploys');
  });
});
