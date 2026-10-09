// M08, API cases (slice 1). Plan §3.1 M08; build spec §3; RN §4; D1 §§3.7,
// 11.3–11.4, 19.3. Every excluded capability reachable through the API fails
// before any effect with a declared refusal; nothing is fabricated; reserved
// tables do not exist; the test seam is unreachable outside harness mode.
// M4 slice 23: the deploy refusal is narrowed now that POST …/deployments
// exists (D4 Appendix C.2; SEAM.md §253); the other refusals stand.
// Deferred (COVERAGE.md): scheduler-intent refusals and the real
// backend/version/mode refusal to slice 2; phase and completion gate refusals
// to slice 5.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXIT, engineFixture, makeTempDir, removeDir, startRefused } from './harness/engine.mjs';
import { newId } from './harness/ids.mjs';
import {
  assertNoEffect,
  assertRefused,
  auditEvents,
  maxEventSeq,
  projectFixture,
  storeState,
} from './harness/fixtures.mjs';
import { tableNames, withStore } from './harness/store.mjs';

// The excluded request is refused with `codes`, has no effect, and is audited.
async function assertExcluded(fx, method, path, { status, codes }) {
  const { engine, home } = fx;
  const before = storeState(home);
  const seq = maxEventSeq(home);
  const res = method === 'GET' ? await engine.get(path) : await engine.post(path, {});
  if (status) assertRefused(res, status, codes, `${method} ${path}`);
  else {
    assert.ok(res.status >= 400, `${method} ${path}: refused (got ${res.status} ${res.text})`);
    assertRefused(res, res.status, codes, `${method} ${path}`);
  }
  assertNoEffect(home, before, seq, `${method} ${path}`);
  if (method !== 'GET') {
    const audits = auditEvents(home, seq, method, path);
    assert.equal(audits.length, 1, `${method} ${path}: refusal audited once`);
    assert.equal(JSON.parse(audits[0].payload).status, res.status);
  }
  return res;
}

const RESERVED = ['mechanic_issues', 'triage_dispositions', 'product_intent_contracts', 'adoption_analyses', 'export_records', 'promotion_records'];
const NOT_BUILT = ['observation_jobs', 'observation_history'];

describe('M08 excluded capabilities are refused at the API', () => {
  test('session open, turn, save and close are refused before any effect', async (t) => {
    const fx = await projectFixture(t);
    const run = newId('run_');
    const base = `/v1/projects/${fx.project}/sessions`;
    for (const path of [base, `${base}/${run}/turns`, `${base}/${run}/save`, `${base}/${run}/close`]) {
      await assertExcluded(fx, 'POST', path, { status: 501, codes: 'unsupported' });
    }
    withStore(fx.home, (db) => {
      for (const table of ['runs', 'turns', 'invocation_receipts', 'execution_domains', 'capability_grants']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table}: no session fabricated`);
      }
    });
  });

  test('management and release surfaces are refused', async (t) => {
    const fx = await projectFixture(t);
    const p = `/v1/projects/${fx.project}`;
    await assertExcluded(fx, 'GET', `${p}/management`, { status: 501, codes: 'unsupported' });
    await assertExcluded(fx, 'GET', `${p}/releases`, { status: 501, codes: 'unsupported' });
    await assertExcluded(fx, 'POST', `${p}/management/activate`, { codes: ['unsupported', 'not_found'] });
  });

  // M4 slice 23 narrows this case (D4 Appendix C.2; SEAM.md §253; COVERAGE.md): `POST …/deployments` is the one way to ask
  // for a deployment, and the gate it evaluates decides whether anything is deployed (M301, M303). Every other deploy path,
  // and publish, export and releases, stay refused before any effect; the deployments route refuses a request it cannot
  // read before any effect too, so the narrowing opens no path around the gate.
  test('publish, export and release requests, and every deploy path but POST …/deployments, are refused before any effect; a deployment request naming no candidate is refused with no effect', async (t) => {
    const fx = await projectFixture(t);
    const p = `/v1/projects/${fx.project}`;
    const candidate = newId('cand_');
    for (const path of [`${p}/deploy`, `${p}/publish`, `${p}/export`, `${p}/releases`, `${p}/candidates/${candidate}/deploy`, `${p}/candidates/${candidate}/authorizations`]) {
      await assertExcluded(fx, 'POST', path, { codes: ['unsupported', 'not_found'] });
    }
    const res = await assertExcluded(fx, 'POST', `${p}/deployments`, { status: 400, codes: 'invalid_value' });
    assert.equal(res.body.subject?.field, 'candidate', 'the request is refused for the candidate it does not name');
  });

  test('tables reserved for later designs, and environment observation tables, do not exist', async (t) => {
    const { home } = await projectFixture(t);
    const tables = withStore(home, (db) => tableNames(db));
    for (const name of [...RESERVED, ...NOT_BUILT]) assert.ok(!tables.includes(name), `${name} is not created in M1`);
  });

  test('a fixture-installed project is labelled as test setup', async (t) => {
    const { engine, home, project } = await projectFixture(t);
    assert.equal((await engine.engineInfo()).harness, true);
    const created = withStore(home, (db) =>
      db
        .prepare(`SELECT * FROM "events" WHERE "type" = 'project.created' AND json_extract("subject", '$.project') = ?`)
        .all(project),
    );
    assert.equal(created.length, 1);
    assert.equal(JSON.parse(created[0].payload).test_fixture, true);
  });

  test('the test seam is unreachable outside harness mode', async (t) => {
    const fx = await engineFixture(t, { harness: false });
    const info = await fx.engine.engineInfo();
    assert.equal(info.harness, false);
    assert.deepEqual(info.backends, [], 'no backend is qualified in M1 outside the harness');
    const before = storeState(fx.home);
    const seq = maxEventSeq(fx.home);
    assertRefused(
      await fx.engine.post('/v1/harness/fixtures/project', { name: 'x', tier: 'T2', dev_repo_path: fx.home, integration_branch: 'main' }),
      404,
      'not_found',
      'fixture installer',
    );
    assertRefused(await fx.engine.post('/v1/harness/faults', { point: 'audit_write' }), 404, 'not_found', 'fault injection');
    assertRefused(await fx.engine.get('/v1/harness/barriers'), 404, 'not_found', 'barriers');
    assertNoEffect(fx.home, before, seq, 'harness routes outside harness mode');

    const home = makeTempDir('m08-flags');
    t.after(() => removeDir(home));
    const refused = await startRefused({ home, harness: false, args: ['--harness-barrier', 'migration.before_commit=kill'] });
    assert.equal(refused.code, EXIT.usage, `harness flag without --harness is a usage error (stderr: ${refused.stderr})`);
  });
});
