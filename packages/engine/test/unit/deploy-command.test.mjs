// Developer tests for `surety deploy` (D4 §1 item 4, Q3, A.8; SEAM.md §335):
// the command line parsed into exactly one request to the deployment route
// with its closed body, every usage problem refused before anything is
// asked, and the client's wait taken from the engine's configured
// `artifact_prepare_deadline` (the driver's ruling on the slice-30 design).
// The command itself, against an engine, is M342-the-deploy-command's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { deployTimeoutMs, parseDeploy } = await import(join(dist, 'deploy', 'deploy-command.js'));

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('surety deploy: one POST to the project\'s deployments with exactly {candidate, environment}, in any order of its flags', () => {
  const want = { method: 'POST', path: '/v1/projects/prj_1/deployments', body: { candidate: 'cand_1', environment: 'alpha' } };
  assert.deepEqual(parseDeploy(['cand_1', '--env', 'alpha', '--project', 'prj_1']), want);
  assert.deepEqual(parseDeploy(['--project', 'prj_1', '--env', 'alpha', 'cand_1']), want);
  assert.deepEqual(parseDeploy(['cand_1', '--env', 'alpha', '--project', 'p/x']).path, '/v1/projects/p%2Fx/deployments', 'the project is one path segment');
});

test('surety deploy: every usage problem is a string (exit 2), nothing asked', () => {
  const problems = [
    [],
    ['--env', 'alpha', '--project', 'prj_1'],
    ['cand_1', '--project', 'prj_1'],
    ['cand_1', '--env', 'alpha'],
    ['cand_1', '--env'],
    ['cand_1', '--env', '--project', 'prj_1'],
    ['cand_1', '--env', 'alpha', '--env', 'beta', '--project', 'prj_1'],
    ['cand_1', '--env', 'alpha', '--project', 'prj_1', '--project', 'prj_2'],
    ['cand_1', 'cand_2', '--env', 'alpha', '--project', 'prj_1'],
    ['cand_1', '--env', 'alpha', '--project', 'prj_1', '--artifact-digest', 'sha256:00'],
    ['cand_1', '--env', 'alpha', '--project', 'prj_1', '--yes'],
  ];
  for (const argv of problems) assert.equal(typeof parseDeploy(argv), 'string', JSON.stringify(argv));
});

test("the client waits the engine's configured artifact_prepare_deadline and a minute more", (t) => {
  const home = scratch(t);
  writeFileSync(join(home, 'config.json'), '{}\n');
  assert.equal(deployTimeoutMs(home), (600 + 60) * 1000, 'the default deadline');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ artifact_prepare_deadline: 30 }));
  assert.equal(deployTimeoutMs(home), 90_000);
});

test('the command line: a usage problem exits 2 before SURETY_HOME is read; no engine running exits 1 with nothing on standard output', (t) => {
  const cli = join(dist, 'cli.js');
  const usage = spawnSync(process.execPath, [cli, 'deploy', 'cand_1', '--project', 'prj_1'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(usage.status, 2, usage.stderr);
  assert.match(usage.stderr, /--env/);
  const home = scratch(t);
  writeFileSync(join(home, 'config.json'), '{}\n');
  const unreachable = spawnSync(process.execPath, [cli, 'deploy', 'cand_1', '--env', 'alpha', '--project', 'prj_1'], { encoding: 'utf8', env: { PATH: process.env.PATH, SURETY_HOME: home } });
  assert.equal(unreachable.status, 1, unreachable.stderr);
  assert.equal(unreachable.stdout, '');
  assert.equal(JSON.parse(unreachable.stderr).code, 'engine_unreachable');
});
