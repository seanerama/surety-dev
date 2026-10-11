// M333, rotation and the held value (slice 28; kernel lane). M4 plan §3.6
// M333; D4-S03, D4-S04; D4 §3.2, §7.4; RV5; E116; SEAM.md §§245, 250, 294,
// 310, 313.
//
// The engine reads secret files only at start and holds what it read. On the
// scripted deployment adapter (SEAM §247), whose launch stand-in keeps the
// grant's reply in memory and answers, for a value the test names, whether
// the reply carried it (SEAM §313; no value in any answer or record):
//   (f) a secret file replaced while the engine runs changes nothing: the
//       version stays `current` with its identity, and a deploy meanwhile
//       launches with the held value; a restart with the value unchanged
//       keeps the version `current`, no event;
//   (a) a restart with a changed value: the current version `secrets_changed`,
//       `environment.config_secrets_changed`;
//   (b) a deploy request meanwhile: 409 `config_secrets_changed`, nothing
//       authorized; the environment read says why;
//   (c) `surety env config <env> --resolve-secrets` (the CLI over
//       `POST …/config/resolve-secrets`): a new version, a new identity, the
//       old one `superseded`; asked again, unchanged (200, the same identity);
//   (e) until a new request redeploys, the environment read reports
//       `rotation_pending_replacement` with the running and the current
//       versions and no value; after the redeploy the launch reply carries
//       the new value and the condition is gone;
//   (d) an authorization bound to the old identity (its deploy waiting for
//       admission across the rotation) fails its precondition before the
//       effect, `configuration_changed` not held, no effect call.
// The secrets are disposable random values the test makes, in 0600 files of
// a directory of its own; nothing is printed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { CLI, makeTempDir, removeDir } from './harness/engine.mjs';
import { eventsOfType } from './harness/journal.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { recordExit, roundsOf, rowWhen } from './harness/deploy/rounds.mjs';
import { holdsAny, secretArgs, secretFile, testSecret } from './harness/deploy/host.mjs';
import {
  adapterState,
  attemptsOf,
  authorizationRow,
  configsOf,
  deploy,
  deployable,
  effectCalls,
  environmentRead,
  launchReplyHolds,
  operationRow,
  operationsOf,
  postDeployExecutions,
  requestDeployment,
  resolveSecrets,
  scriptCall,
  setAdmission,
} from './harness/deploy/kernel.mjs';

const REF = 'deploy/m333_app';

// An engine holding REF from a file of the test's own, and the deployable
// project whose environment `alpha` names it as APP_TOKEN.
async function rotating(t, { policy = {} } = {}) {
  const dir = makeTempDir('m333-secrets');
  t.after(() => removeDir(dir));
  const values = { s0: testSecret('m333-s0'), s1: testSecret('m333-s1') };
  const file = secretFile(dir, 'app', values.s0);
  const args = secretArgs({ [REF]: file });
  const fx = await scriptedEngine(t, { start: false });
  await fx.start({ args });
  const ctx = await deployable(fx, { config: { secrets: { APP_TOKEN: REF } }, policy });
  const restart = async () => {
    await fx.engine.stop();
    await fx.start({ args });
  };
  return { ...ctx, values, file, args, restart };
}

const setValue = (ctx, value) => writeFileSync(ctx.file, `${value}\n`);
const authorizationCount = (home) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deployment_authorizations"').get().n);
const secretsChangedEvents = (home, env) => eventsOfType(home, 'environment.config_secrets_changed').filter((e) => e.subject?.environment === env);

// A deploy requested and applied on the scripted target, its round settled
// failed (the candidate stays developing). Returns {op, attempt}.
async function deployAndSettle(ctx, what) {
  const { fx, project, candidate, env } = ctx;
  const known = new Set(operationsOf(fx.home, project, 'deploy').map((o) => o.id));
  await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
  await deploy(fx.engine, project, candidate.id, env.name);
  const execution = await tickUntil(fx.engine, project, () => postDeployExecutions(fx.home, candidate.id).find((x) => !known.has(x.deployment?.operation)), { max: 16, what: `${what}: its round's check` });
  const op = operationsOf(fx.home, project, 'deploy').find((o) => !known.has(o.id));
  await recordExit(fx.engine, execution.id, 1);
  await rowWhen(ctx, roundsOf(fx.home, op.id).at(-1).id);
  await tick(fx.engine, project, { rounds: 2 });
  const attempt = attemptsOf(fx.home, op.id).at(-1);
  assert.ok(attempt?.app_instance, `${what}: the fixture is live: the launch was granted and the application reported (${JSON.stringify(attempt)})`);
  return { op, attempt };
}

describe('M333 rotation and the held value', () => {
  test('(f), (a), (b), (c), (e): a file replaced while running changes nothing; a restart with the same value keeps current; a changed value makes secrets_changed and refuses deploys; resolving makes a new version; rotation_pending_replacement until a redeploy launches with the new value', async (t) => {
    const ctx = await rotating(t);
    const { fx, project, env, values } = ctx;
    const responses = [];
    const read = async () => {
      const res = await fx.engine.get(`/v1/projects/${project}/environments/${env.name}`);
      assert.equal(res.status, 200, res.text);
      responses.push(res.text);
      return res.body.environment;
    };
    const first = await deployAndSettle(ctx, 'the first deploy');
    assert.deepEqual(await launchReplyHolds(fx.engine, first.attempt.id, { APP_TOKEN: values.s0 }), { APP_TOKEN: true }, 'the fixture is live: the launch reply carried the held value (SEAM §313)');
    const v1 = configsOf(fx.home, env.id).at(-1);

    // (f) the file replaced while the engine runs: nothing changes.
    setValue(ctx, values.s1);
    const during = await deployAndSettle(ctx, 'a deploy after the file was replaced');
    assert.deepEqual(await launchReplyHolds(fx.engine, during.attempt.id, { APP_TOKEN: values.s0 }), { APP_TOKEN: true }, '(f) the deploy launches with the value held since the start');
    assert.deepEqual(await launchReplyHolds(fx.engine, during.attempt.id, { APP_TOKEN: values.s1 }), { APP_TOKEN: false }, '(f) and not with the file\'s new content');
    let now = configsOf(fx.home, env.id);
    assert.deepEqual([now.length, now.at(-1).id, now.at(-1).status, now.at(-1).config_identity], [v1.version, v1.id, 'current', v1.config_identity], '(f) the version stays current, with its identity');
    assert.equal(secretsChangedEvents(fx.home, env.id).length, 0, '(f) no config_secrets_changed');

    // (f) a restart with the value unchanged keeps the version current.
    setValue(ctx, values.s0);
    await ctx.restart();
    now = configsOf(fx.home, env.id);
    assert.deepEqual([now.at(-1).id, now.at(-1).status], [v1.id, 'current'], '(f) a restart with unchanged values keeps the version current');
    assert.equal(secretsChangedEvents(fx.home, env.id).length, 0, '(f) and emits nothing');

    // (a) a restart with a changed value.
    setValue(ctx, values.s1);
    await ctx.restart();
    assert.equal(configsOf(fx.home, env.id).find((c) => c.id === v1.id).status, 'secrets_changed', '(a) the current version is secrets_changed');
    const changed = secretsChangedEvents(fx.home, env.id);
    assert.equal(changed.length, 1, `(a) environment.config_secrets_changed, once (${JSON.stringify(changed)})`);

    // (b) a deploy request meanwhile.
    const before = authorizationCount(fx.home);
    const refused = await requestDeployment(fx.engine, project, ctx.candidate.id, env.name);
    responses.push(refused.text);
    assert.deepEqual([refused.status, refused.body?.code], [409, 'config_secrets_changed'], `(b) refused config_secrets_changed (D4 A.6) (${refused.text})`);
    assert.equal(authorizationCount(fx.home), before, '(b) nothing authorized');
    assert.equal((await read()).config?.status, 'secrets_changed', '(b) the environment read says why');

    // (c) the owner resolves the secrets: through the CLI, then through the route again (unchanged).
    const cli = spawnSync(process.execPath, [CLI, 'env', 'config', env.name, '--project', project, '--resolve-secrets'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, SURETY_HOME: fx.home } });
    responses.push(`${cli.stdout}${cli.stderr}`);
    assert.equal(cli.status, 0, `(c) surety env config ${env.name} --resolve-secrets exits 0 (stdout ${cli.stdout.slice(0, 300)}; stderr ${cli.stderr.slice(0, 300)})`);
    const v2 = configsOf(fx.home, env.id).at(-1);
    assert.deepEqual([v2.version, v2.status], [v1.version + 1, 'current'], '(c) a new version, current');
    assert.notEqual(v2.config_identity, v1.config_identity, '(c) a new identity');
    assert.deepEqual(v2.content, v1.content, '(c) the same content');
    assert.equal(configsOf(fx.home, env.id).find((c) => c.id === v1.id).status, 'superseded', '(c) the old version superseded');
    const again = await resolveSecrets(fx.engine, project, env.name);
    responses.push(again.text);
    assert.equal(again.status, 200, `(c) asked again with nothing changed: 200, unchanged (${again.text})`);
    assert.equal(configsOf(fx.home, env.id).length, v2.version, '(c) and no further version');

    // (e) rotation pending until a redeploy.
    const pending = await read();
    assert.ok((pending.conditions ?? []).includes('rotation_pending_replacement'), `(e) rotation_pending_replacement (D4 §6.1; E116) (${JSON.stringify(pending.conditions)})`);
    assert.equal(pending.running?.config, v1.id, '(e) beside it, the version the running service was launched with');
    assert.equal(pending.config?.id, v2.id, '(e) and the current one');
    const after = await deployAndSettle(ctx, 'the redeploy');
    assert.deepEqual(await launchReplyHolds(fx.engine, after.attempt.id, { APP_TOKEN: values.s1 }), { APP_TOKEN: true }, '(e) after the redeploy the launch reply carries the new value');
    assert.deepEqual(await launchReplyHolds(fx.engine, after.attempt.id, { APP_TOKEN: values.s0 }), { APP_TOKEN: false }, '(e) and not the old one');
    const replaced = await read();
    assert.ok(!(replaced.conditions ?? []).includes('rotation_pending_replacement'), `(e) the condition ends with the replacement (${JSON.stringify(replaced.conditions)})`);
    assert.equal(replaced.running?.config, v2.id, '(e) the running service is the current version\'s');

    // No value in any answer the test received.
    for (const text of responses) assert.deepEqual(holdsAny(text, values), [], 'no response holds a value or its escaped form');
  });

  test('(d) an authorization bound to the old identity, its deploy waiting for admission across the rotation and the resolution, fails its precondition before the effect', async (t) => {
    const ctx = await rotating(t);
    const { fx, project, env, values } = ctx;
    await setAdmission(fx.engine, env.id, 'held');
    await scriptCall(fx.engine, env.id, 'deploy', [{ result: 'issued', apply: true }]);
    const request = await deploy(fx.engine, project, ctx.candidate.id, env.name);
    const op = await tickUntil(fx.engine, project, () => operationsOf(fx.home, project, 'deploy')[0], { max: 8, what: 'the deploy to be intended' });
    await tick(fx.engine, project, { rounds: 2 });
    assert.equal(operationRow(fx.home, op.id).status, 'intended', 'the fixture is live: the deploy waits for admission');

    setValue(ctx, values.s1);
    await ctx.restart();
    const resolved = await resolveSecrets(fx.engine, project, env.name);
    assert.equal(resolved.status, 201, `the fixture is live: a new version with a new identity (${resolved.text})`);
    assert.notEqual(resolved.body?.config?.config_identity, authorizationRow(fx.home, request.authorization.id).config_identity ?? null, 'the authorization is bound to the old identity');

    await setAdmission(fx.engine, env.id, 'granted');
    const ended = await tickUntil(fx.engine, project, () => {
      const o = operationRow(fx.home, op.id);
      return ['intended', 'in_progress'].includes(o.status) && attemptsOf(fx.home, o.id).length === 0 ? undefined : o;
    }, { max: 12, what: 'the deploy to end or attempt its effect' });
    assert.equal(ended.status, 'failed', `it fails before its effect (${ended.status} ${JSON.stringify(ended.outcome_detail)})`);
    assert.equal(ended.outcome_detail?.code, 'EFFECT_PRECONDITION_CHANGED');
    assert.ok(['configuration_changed', 'config_secrets_changed'].includes(ended.outcome_detail?.fact), `naming the configuration (${JSON.stringify(ended.outcome_detail)})`);
    const facts = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, ended.outcome_detail.manifest))).toString('utf8')).facts ?? [];
    assert.ok(facts.some((f) => f.fact === 'configuration_changed' && f.held === false), `the manifest records configuration_changed not held: the bound identity is not the current one (${JSON.stringify(facts)})`);
    assert.equal(effectCalls(await adapterState(fx.engine, env.id), 'deploy').length, 0, 'no adapter effect call');
    assert.deepEqual(attemptsOf(fx.home, op.id), [], 'no attempt');
  });
});
