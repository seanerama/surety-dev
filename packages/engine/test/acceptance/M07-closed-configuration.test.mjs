// M07 (slice 1). Plan §3.1 M07; D1 §§7.1, 8, 11.1, 11.4, A.8, A.9; build spec
// §6 correction 20; E18; Review B17. The configuration is closed: unknown or
// invalid values are refused and have no effect; effective settings and
// defaults are inspectable and actually used; per-project concurrency stays
// exactly 1 through M3 while engine-wide concurrency is configurable within
// its bound; nothing missing or null means unlimited.
//
// Engine keys come from $SURETY_HOME/config.json, read before the lock is
// taken (SEAM.md "Engine configuration"). Ungoverned project keys go through
// POST /v1/projects/:p/policy; slice 1 pins only its refusals. Deferred to
// slice 3 (COVERAGE.md): a valid project policy change, which commits through
// the journaled git path.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EXIT,
  engineFixture,
  freePort,
  installProject,
  makeTempDir,
  removeDir,
  snapshotDir,
  startEngine,
  startRefused,
  writeEngineConfig,
} from './harness/engine.mjs';
import { makeRepo, repoState } from './harness/git.mjs';
import { CONTRACT, assertRefused, auditEvents, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { hasTable, withStore } from './harness/store.mjs';

const ENGINE_KEYS = Object.keys(CONTRACT.engine);
const PROJECT_KEYS = Object.keys(CONTRACT.project).filter((k) => !k.startsWith('$'));

// Start with `config` (plus a port) in a fresh home; expect a refusal naming
// `field` with `code`, and no change to the home.
async function assertConfigRefused(t, config, { code = 'invalid_value', field }) {
  const home = makeTempDir('m07');
  t.after(() => removeDir(home));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, ...config });
  const before = snapshotDir(home);
  const result = await startRefused({ home });
  const label = JSON.stringify(config);
  assert.equal(result.code, EXIT.config, `${label}: exit status (stderr: ${result.stderr})`);
  assert.equal(result.refusal?.code, code, `${label}: refusal code (stderr: ${result.stderr})`);
  assert.equal(result.refusal.subject?.field, field, `${label}: refusal names the field`);
  assert.ok(result.refusal.reason && result.refusal.what_to_do, `${label}: refusal explains itself`);
  assert.deepEqual(snapshotDir(home), before, `${label}: nothing written under the engine home`);
}

async function assertEachRefused(t, key, values, opts = {}) {
  for (const value of values) await assertConfigRefused(t, { [key]: value }, { field: key, ...opts });
}

describe('M07 engine configuration', () => {
  test('defaults are inspectable, finite and attributed to their source', async (t) => {
    const { engine, port } = await engineFixture(t);
    const { config } = await engine.engineInfo();
    assert.deepEqual(Object.keys(config).sort(), [...ENGINE_KEYS].sort(), 'exactly the closed key set');
    for (const key of ENGINE_KEYS) {
      if (key === 'decision_targets') continue;
      const spec = CONTRACT.engine[key];
      let expected = spec.default;
      if (key === 'api_port') expected = port;
      if (key === 'api_authority') expected = `127.0.0.1:${port}`;
      assert.deepEqual(config[key].value, expected, `${key} value`);
      assert.equal(config[key].source, key === 'api_port' ? 'file' : 'default', `${key} source`);
      if (typeof expected === 'number') assert.ok(Number.isFinite(config[key].value) && config[key].value > 0, `${key} is finite`);
    }
    assert.equal(config.decision_targets.source, 'default');
    for (const [kind, seconds] of Object.entries(CONTRACT.decision_target_defaults)) {
      if (kind.startsWith('$')) continue;
      assert.equal(config.decision_targets.value[kind], seconds, `decision target ${kind}`);
    }
  });

  test('an unknown key is refused before the engine takes any state', async (t) => {
    await assertConfigRefused(t, { tick_intervall: 30 }, { code: 'unknown_field', field: 'tick_intervall' });
  });

  test('a refused configuration leaves an existing home and store unchanged', async (t) => {
    const { home, port, engine } = await engineFixture(t);
    await engine.stop();
    const before = snapshotDir(home);
    writeEngineConfig(home, { api_port: port, lease_ttl: 5 });
    const configAfterEdit = snapshotDir(home)['config.json'];
    const result = await startRefused({ home });
    assert.equal(result.code, EXIT.config, result.stderr);
    assert.equal(result.refusal?.code, 'invalid_value');
    assert.deepEqual(snapshotDir(home), { ...before, 'config.json': configAfterEdit });
  });

  test('invalid API port values are refused', async (t) => {
    await assertEachRefused(t, 'api_port', [0, 80, 1023, 65536, -1, '7227', 7227.5, null]);
  });

  test('invalid API authority values are refused', async (t) => {
    const port = await freePort();
    // Each case writes its own api_port, so the authority is checked against that port.
    for (const authority of ['evil.example:{p}', '127.0.0.1:{q}', '0.0.0.0:{p}', '127.0.0.1', 'http://127.0.0.1:{p}', '[::1]:{p}', 42, null]) {
      const value = typeof authority === 'string' ? authority.replace('{p}', port).replace('{q}', port + 1) : authority;
      await assertConfigRefused(t, { api_port: port, api_authority: value }, { field: 'api_authority' });
    }
  });

  test('out-of-range and malformed time limits are refused', async (t) => {
    const cases = {
      tick_interval: [4, 601, 30.5, '30'],
      tick_budget: [4, 301],
      tick_step_budget: [0, 61],
      lease_ttl: [29, 601],
      terminate_grace: [0, 61],
      kill_grace: [0, 31],
      api_latency_bound: [49, 2001],
      request_body_deadline: [0, 61],
    };
    for (const [key, values] of Object.entries(cases)) await assertEachRefused(t, key, values);
  });

  test('the body caps are fixed', async (t) => {
    await assertEachRefused(t, 'body_cap', [1, 2097152]);
    await assertEachRefused(t, 'upload_cap', [1, 16777216]);
  });

  test('out-of-range git deadlines and output limits are refused', async (t) => {
    await assertEachRefused(t, 'git_deadline', [0, 601]);
    await assertEachRefused(t, 'git_deadline_long', [59, 3601]);
    await assertEachRefused(t, 'git_output_cap', [65535, 268435457]);
  });

  // M3 slice 19 (D3 A.7; Q5; SEAM.md §217): an object {mode, version?};
  // `authoritative` requires the integer version it trusts.
  test('invalid classifier_authority values are refused', async (t) => {
    await assertEachRefused(t, 'classifier_authority', ['recommend', { mode: 'authoritative' }, { mode: 'sometimes' }, { mode: 'authoritative', version: '1' }, { mode: 'authoritative', version: 1.5 }, null]);
  });

  test('invalid decision-target overrides are refused', async (t) => {
    await assertConfigRefused(t, { decision_targets: { not_a_kind: 3600 } }, { code: 'unknown_field', field: 'decision_targets.not_a_kind' });
    for (const value of [299, 2592001, 3600.5, null, '3600']) {
      await assertConfigRefused(t, { decision_targets: { blocker: value } }, { field: 'decision_targets.blocker' });
    }
    for (const kind of ['stop_confirm', 'abandon_confirm']) {
      await assertConfigRefused(t, { decision_targets: { [kind]: 3600 } }, { field: `decision_targets.${kind}` });
    }
    await assertConfigRefused(t, { decision_targets: [] }, { field: 'decision_targets' });
  });

  // SEAM.md §2: the source is "file" only if at least one override was given.
  // An empty map is valid, overrides nothing and so reports the defaults.
  test('an empty decision-target map is valid and is reported as the default', async (t) => {
    const { engine } = await engineFixture(t, { config: { decision_targets: {} } });
    const { config } = await engine.engineInfo();
    const defaults = Object.fromEntries(Object.entries(CONTRACT.decision_target_defaults).filter(([kind]) => !kind.startsWith('$')));
    for (const [kind, seconds] of Object.entries(defaults)) {
      assert.equal(config.decision_targets.value[kind], seconds, `decision target ${kind} keeps its default`);
    }
    assert.equal(config.decision_targets.source, 'default', 'a map with no override is not a configured value');
  });

  test('engine-wide run concurrency is bounded', async (t) => {
    await assertEachRefused(t, 'max_concurrent_runs', [0, 9, -1, 2.5]);
  });

  test('null never stands for a default or for unlimited', async (t) => {
    for (const key of ['lease_ttl', 'max_concurrent_runs', 'git_output_cap', 'backup_keep', 'tick_budget']) {
      await assertConfigRefused(t, { [key]: null }, { field: key });
    }
  });

  test('valid alternatives take effect, are reported as configured and are used', async (t) => {
    const port = await freePort();
    const authority = `localhost:${port}`;
    const chosen = {
      api_port: port,
      api_authority: authority,
      tick_interval: 60,
      lease_ttl: 120,
      api_latency_bound: 500,
      request_body_deadline: 20,
      backup_keep: 7,
      max_concurrent_runs: 3,
      git_deadline: 120,
      git_output_cap: 1048576,
      decision_targets: { blocker: 3600, policy_widening: 86400 },
      classifier_authority: { mode: 'authoritative', version: 7 },
    };
    const home = makeTempDir('m07-valid');
    t.after(() => removeDir(home));
    writeEngineConfig(home, chosen);
    const engine = await startEngine({ home, port, authority });
    t.after(() => engine.kill());

    const { config } = await engine.engineInfo();
    for (const key of ENGINE_KEYS) {
      if (key === 'decision_targets') continue;
      if (key in chosen) {
        assert.deepEqual(config[key].value, chosen[key], `${key} value`);
        assert.equal(config[key].source, 'file', `${key} source`);
      } else {
        assert.deepEqual(config[key].value, CONTRACT.engine[key].default, `${key} keeps its default`);
        assert.equal(config[key].source, 'default', `${key} source`);
      }
    }
    assert.equal(config.decision_targets.source, 'file');
    assert.equal(config.decision_targets.value.blocker, 3600);
    assert.equal(config.decision_targets.value.policy_widening, 86400);
    assert.equal(config.decision_targets.value.finding_disposition, CONTRACT.decision_target_defaults.finding_disposition);

    // The configured authority is the one the Host check uses.
    assert.equal((await engine.get('/v1/health')).status, 200);
    assertRefused(await engine.get('/v1/health', { host: `127.0.0.1:${port}` }), 400, 'host_refused', 'default authority');

    // Engine concurrency 3 does not raise a project above 1.
    const repoDir = makeTempDir('m07-repo');
    t.after(() => removeDir(repoDir));
    const project = await installProject(engine, { repoPath: makeRepo(repoDir).path });
    const policy = await engine.get(`/v1/projects/${project}/policy`);
    assert.equal(policy.status, 200, policy.text);
    assert.equal(policy.body.effective.max_concurrent_runs, 1);
  });
});

describe('M07 project policy', () => {
  // Refused policy submissions change nothing: not the effective policy, not
  // the repository, not the store; and each refusal is audited.
  async function assertPolicyRefused(fx, body, { code = 'invalid_value', field }) {
    const { engine, home, project, repo } = fx;
    const before = await engine.get(`/v1/projects/${project}/policy`);
    const repoBefore = repoState(repo.path);
    const seq = maxEventSeq(home);
    const path = `/v1/projects/${project}/policy`;
    const res = await engine.post(path, body);
    const label = JSON.stringify(body);
    assertRefused(res, 400, code, label);
    assert.equal(res.body.subject?.field, field, `${label}: names the field`);
    const after = (await engine.get(path)).body;
    assert.deepEqual(after.effective, before.body.effective, `${label}: effective policy unchanged`);
    assert.deepEqual(after.revision, before.body.revision, `${label}: policy revision unchanged`);
    assert.deepEqual(repoState(repo.path), repoBefore, `${label}: repository untouched`);
    withStore(home, (db) => {
      if (hasTable(db, 'policy_revisions')) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "policy_revisions"').get().n, 0);
    });
    const audits = auditEvents(home, seq, 'POST', path);
    assert.equal(audits.length, 1, `${label}: refusal audited once`);
    assert.equal(JSON.parse(audits[0].payload).status, 400);
  }

  test('project defaults are inspectable, with concurrency fixed at 1', async (t) => {
    const { engine, project } = await projectFixture(t);
    const res = await engine.get(`/v1/projects/${project}/policy`);
    assert.equal(res.status, 200, res.text);
    for (const key of PROJECT_KEYS) {
      // deepEqual since M2 slice 10: two D2 keys default to an empty list (SEAM.md §115).
      assert.deepEqual(res.body.effective[key], CONTRACT.project[key].default, `${key} default`);
    }
    assert.equal(res.body.effective.max_concurrent_runs, 1);
  });

  test('project concurrency other than 1 is refused with no effect', async (t) => {
    const fx = await projectFixture(t);
    for (const value of [2, 8, 0]) await assertPolicyRefused(fx, { max_concurrent_runs: value }, { field: 'max_concurrent_runs' });
  });

  test('unknown project keys are refused', async (t) => {
    const fx = await projectFixture(t);
    await assertPolicyRefused(fx, { max_concurent_runs: 1 }, { code: 'unknown_field', field: 'max_concurent_runs' });
  });

  test('out-of-range project values are refused, and a mixed submission changes nothing', async (t) => {
    const fx = await projectFixture(t);
    const cases = [
      ['repair_attempts_max', 11],
      ['no_progress_max', 0],
      ['deadline_builder', 299],
      ['record_retention_days', 6],
      ['snapshot_max_files', 0],
      ['snapshot_max_bytes', 1048575],
      ['budget_day_verified_usd', -1],
      ['budget_run_billable_tokens', null],
      ['preflight_refusals_max', 1.5],
    ];
    for (const [key, value] of cases) await assertPolicyRefused(fx, { [key]: value }, { field: key });
    await assertPolicyRefused(fx, { repair_attempts_max: 5, no_progress_max: 9 }, { field: 'no_progress_max' });
    const after = await fx.engine.get(`/v1/projects/${fx.project}/policy`);
    assert.equal(after.body.effective.repair_attempts_max, CONTRACT.project.repair_attempts_max.default);
  });
});
