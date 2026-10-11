// M336, who deploys, fixtures confined, and the spawn sites (slice 28;
// kernel lane). M4 plan §3.6 M336 (a), (b), (d); D4-R01, D4-R02, D4-A08;
// D4 §§2.5, 8; J3, J4; E92 item 2; BS4 §5; SEAM.md §§7, 246, 247, 248, 262,
// 310, 313, 315, 316.
//
//   (a) no role deploys: a role's result carrying a field that would request
//       a deployment requests none (nothing authorized, no operation, no
//       deploy work item; whether the result is rejected or the field
//       ignored is not pinned); no role's
//       capability grant names the deploy operation, its attempt, its units
//       or a deployment secret; no run of role `release_operator` is
//       dispatched, and no run serves a `deploy` work item; the deployment
//       route without the engine's token is 401 with nothing written;
//   (b) outside harness mode: the scripted deployment adapter's routes, the
//       fixture authorization (caller-supplied bindings), the labelled
//       qualification fixture, the deploy faults (the qualification
//       stand-in and every slice-28 fault) and the launch-reply seam are
//       404 `not_found`; `--harness-deploy-adapter` without `--harness` is a
//       usage error; caller-supplied binding fields on the production
//       deployment route are 400 `unknown_field`, nothing written. M74's
//       seam-confinement lint (`M74-seam-confinement.test.mjs`) is
//       unchanged and keeps passing;
//   (d) the spawn lint: `systemd-run` and `systemctl` are named as programs
//       only in `src/deploy/adapters/local-service.ts` and the two pre-D4
//       sites D2 placed (SEAM §316); nothing in `src/deploy/` reaches a
//       shell; a site planted elsewhere, or a shell in deploy code, fails it,
//       and the same code in the adapter does not.
// (c), the production real-adapter path outside harness mode with its
// negative controls, is `M336-the-production-adapter-path.test.mjs`
// (sandbox).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { join } from 'node:path';

import { EXIT, REPO_ROOT, freePort, makeTempDir, removeDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { roleRun } from './harness/gates.mjs';
import { changePolicy } from './harness/journal.mjs';
import { inspectDeployShell, inspectToolSites, TOOL_SITES } from './harness/launch-lint.mjs';
import { formatViolations, readSources } from './harness/source-lint.mjs';
import { runsOf, scriptedEngine, tickUntil } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { recordExit } from './harness/deploy/rounds.mjs';
import { attemptIntent, attemptsOf, deployToRound, deployWork, deployable, operationsOf } from './harness/deploy/kernel.mjs';

const SRC = join(REPO_ROOT, 'packages', 'engine', 'src');
const authorizations = (home) => withStore(home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deployment_authorizations"').get().n);
const grants = (home) => withStore(home, (db) => db.prepare('SELECT * FROM "capability_grants"').all());

describe('M336 (a) no role deploys', () => {
  test('a result field requesting a deployment is invalid_result; no grant holds a capability; no release_operator run; the route needs the token', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx, { config: {} });
    const { project, candidate } = ctx;
    await changePolicy(fx.engine, project, { repair_attempts_max: 0 });

    // A deployment made by the engine, so there is a capability that could leak.
    const { operation, execution } = await deployToRound(ctx);
    await recordExit(fx.engine, execution.id, 1);
    const [attempt] = attemptsOf(fx.home, operation.id);
    const units = attemptIntent(fx.home, attempt.id)?.create_units ?? [];
    assert.ok(attempt?.capability && units.length > 0, 'the fixture is live: the attempt holds a capability naming its unit');

    for (const field of [
      { deployment: { candidate: candidate.id, environment: ctx.env.name } },
      { deploy: true },
      { deployments: [{ environment: ctx.env.name }] },
      { deploy_request: { environment: ctx.env.name } },
    ]) {
      const [name] = Object.keys(field);
      const before = [authorizations(fx.home), operationsOf(fx.home, project, 'deploy').length];
      const works = deployWork(fx.home, project).length;
      const { run } = await roleRun(fx, project, 'verification', { subject: { candidate: candidate.id }, result: field });
      // No result field requests a deployment (D4-R01; D4 §8.2): the field is
      // none of the schema's. Whether the engine rejects the result
      // (`invalid_result`) or ignores the field is not pinned (SEAM §316);
      // that nothing is requested is.
      assert.ok(run.state === 'ended', `${name}: the run ended (${run.outcome} ${run.reason_class})`);
      assert.deepEqual([authorizations(fx.home), operationsOf(fx.home, project, 'deploy').length, deployWork(fx.home, project).length], [...before, works], `${name}: nothing authorized, no operation, no deploy work item`);
    }

    // No grant holds a capability or names the deployment's operation, attempt or units.
    const all = grants(fx.home);
    assert.ok(all.length > 0, 'the fixture is live: role runs were granted');
    for (const g of all) {
      const text = `${g.capabilities} ${g.env_allowlist} ${g.secret_refs ?? ''}`;
      for (const name of [operation.id, attempt.id, ...units]) assert.ok(!text.includes(name), `grant ${g.id} names nothing of the deployment (${name})`);
      for (const key of ['lease_generation', 'create_units', 'stop_units', 'deploy/']) assert.ok(!text.includes(key), `grant ${g.id} holds no deploy capability (${key})`);
    }

    // No release_operator run, and no run of any deploy work item.
    const roles = withStore(fx.home, (db) => db.prepare('SELECT "role" FROM "runs"').all()).map((r) => r.role);
    assert.ok(!roles.includes('release_operator'), `no run of role release_operator is dispatched (D4 §8.1) (${[...new Set(roles)].join(', ')})`);
    for (const w of deployWork(fx.home, project)) assert.deepEqual(runsOf(fx.home, w.id), [], `the deploy work item ${w.id} is served by no run`);

    // The deployment route without the engine's token.
    const before = [authorizations(fx.home), operationsOf(fx.home, project, 'deploy').length];
    const res = await fx.engine.request('POST', `/v1/projects/${project}/deployments`, { body: { candidate: candidate.id, environment: ctx.env.name }, token: null });
    assert.equal(res.status, 401, `without the engine's token the route is refused (${res.status} ${res.text})`);
    assert.deepEqual([authorizations(fx.home), operationsOf(fx.home, project, 'deploy').length], before, 'and writes nothing');
  });
});

describe('M336 (b) fixtures confined to harness mode', () => {
  test('outside harness mode the scripted adapter, the fixture authorization, the qualification fixture, the deploy faults and the launch-reply seam are 404; caller bindings on the production route are unknown_field', async (t) => {
    const fx = await scriptedEngine(t);
    const ctx = await deployable(fx);
    const { project, candidate, env } = ctx;
    await fx.engine.stop();
    await fx.start({ harness: false });
    const info = await fx.engine.engineInfo();
    assert.notEqual(info.harness, true, 'the fixture is live: the engine is not in harness mode');
    const before = authorizations(fx.home);
    for (const [method, path, body] of [
      ['GET', `/v1/harness/deploy/environments/${env.id}`, undefined],
      ['POST', `/v1/harness/deploy/environments/${env.id}/target`, { units: [] }],
      ['POST', `/v1/harness/deploy/environments/${env.id}/answers`, { call: 'deploy', answers: [{ result: 'issued', apply: true }] }],
      ['POST', '/v1/harness/fixtures/authorization', { project, candidate: candidate.id, environment: env.id, artifact_digest: `sha256:${'a'.repeat(64)}`, config_identity: ctx.config.config_identity, target_set: ['app'] }],
      ['POST', '/v1/harness/fixtures/adapter-qualification', { adapter: 'local_service', adapter_version: '1' }],
      ['POST', '/v1/harness/deploy/faults', { environment: env.id, fault: 'capability_forged', field: 'environment', value: env.id }],
      ['POST', '/v1/harness/deploy/launch-reply', { attempt: 'att_x', expect: {} }],
    ]) {
      const res = await fx.engine.request(method, path, body === undefined ? {} : { body });
      assert.deepEqual([res.status, res.body?.code], [404, 'not_found'], `${method} ${path} does not exist outside harness mode (D4-R02; SEAM §7) (${res.text})`);
    }
    const bound = await fx.engine.post(`/v1/projects/${project}/deployments`, { candidate: candidate.id, environment: env.name, artifact_digest: `sha256:${'a'.repeat(64)}`, config_identity: ctx.config.config_identity, target_set: ['app'] });
    assert.deepEqual([bound.status, bound.body?.code], [400, 'unknown_field'], `caller-supplied bindings are refused on the production route (J3) (${bound.text})`);
    assert.equal(authorizations(fx.home), before, 'nothing was authorized outside harness mode');
  });

  test('--harness-deploy-adapter without --harness is a usage error', async (t) => {
    const home = makeTempDir('m336b');
    t.after(() => removeDir(home));
    writeEngineConfig(home, { api_port: await freePort() });
    for (const value of ['scripted', 'real']) {
      const refused = await startRefused({ home, harness: false, args: ['--harness-deploy-adapter', value] });
      assert.equal(refused.code, EXIT.usage, `--harness-deploy-adapter ${value} without --harness: exit ${EXIT.usage} (exit ${refused.code}; ${refused.stderr.slice(-300)})`);
    }
  });
});

describe('M336 (d) the spawn lint: systemd-run and systemctl only where they belong, never through a shell', () => {
  const mutated = (sources, { file, text }) => (sources.some((s) => s.file === file) ? sources.map((s) => (s.file === file ? { file, text: s.text + text } : s)) : [...sources, { file, text }]);

  test('the engine names systemd-run and systemctl only at the listed sites, and nothing in src/deploy/ reaches a shell', () => {
    const sources = readSources(SRC);
    const adapter = sources.find((s) => s.file === 'deploy/adapters/local-service.ts');
    assert.ok(adapter, 'the fixture is live: the local_service adapter exists');
    for (const tool of Object.keys(TOOL_SITES)) assert.ok(adapter.text.includes(`'${tool}'`), `the inspection has something to find: the adapter names ${tool}`);
    const sites = inspectToolSites(sources);
    assert.equal(sites.length, 0, `D4-A08: systemd-run and systemctl only at ${JSON.stringify(TOOL_SITES)}\n${formatViolations(sites)}\n`);
    const shell = inspectDeployShell(sources);
    assert.equal(shell.length, 0, `BS4 §5: no shell in src/deploy/\n${formatViolations(shell)}\n`);
  });

  test('a planted site fails the lint in every form; the same call in the adapter does not', () => {
    const sources = readSources(SRC);
    const spawnUnit = `\nimport { spawn } from 'node:child_process';\nexport const stopUnit = (u: string) => spawn('systemctl', ['--user', 'stop', '--', u]);\n`;
    for (const mutation of [
      { what: 'the Release Operator stopping a unit itself', file: 'deploy/release-operator.ts', text: spawnUnit },
      { what: 'a transient unit created from the choke point', file: 'invoke/unit.ts', text: `\nimport { spawn } from 'node:child_process';\nexport const run = () => spawn('/usr/bin/systemd-run', ['--user', '--', '/bin/true']);\n` },
      { what: 'the scheduler naming systemctl by path', file: 'scheduler/units.ts', text: `\nexport const TOOL = '/usr/bin/systemctl';\n` },
    ]) {
      const found = inspectToolSites(mutated(sources, mutation)).filter((v) => v.file === mutation.file);
      assert.ok(found.length >= 1, `${mutation.what} (${mutation.file}) is reported`);
    }
    for (const mutation of [
      { what: 'exec from child_process in deploy code', file: 'deploy/adapters/local-service.ts', text: `\nimport { exec } from 'node:child_process';\nexport const viaShell = () => exec('systemctl --user list-units');\n` },
      { what: 'a shell option in deploy code', file: 'deploy/adapters/local-service.ts', text: `\nexport const opts = { shell: true };\n` },
      { what: 'a shell named in deploy code', file: 'deploy/release-operator.ts', text: `\nexport const SH = '/bin/sh';\n` },
    ]) {
      const found = inspectDeployShell(mutated(sources, mutation)).filter((v) => v.file === mutation.file);
      assert.ok(found.length >= 1, `${mutation.what} (${mutation.file}) is reported`);
    }
    // The control: the same argument-array call in the adapter is where it belongs.
    const inAdapter = { file: 'deploy/adapters/local-service.ts', text: `\nexport const again = () => ['systemctl', '--user', 'show'];\n` };
    assert.equal(inspectToolSites(mutated(sources, inAdapter)).length, 0, 'the same tool named in the adapter is not reported');
    assert.equal(inspectDeployShell(mutated(sources, inAdapter)).length, 0, 'an argument array is no shell');
  });
});
