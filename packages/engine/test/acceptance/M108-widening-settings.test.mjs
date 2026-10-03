// M108, the widening settings (M2 slice 10, kernel lane). M2 plan §3.1
// M108; D2 §§2.3, 2.4, A.7 (D2-I15); RN R2; AR B02; SEAM.md §§27, 78, 115,
// 120.
//
// `egress_allow_extra` and `sandbox_read_paths` widen what a role may reach:
// a submission that adds to either raises `policy_widening`, and the policy
// is unchanged until the human approves. An approved widening still cannot
// expose forbidden authority: a read path that is, contains or aliases the
// engine home, a registered repository, a workspace or an operator
// credential location, a forbidden root, a WSL path, or a directory that
// holds a socket or a FIFO, refuses every launch with `mount_plan_refused`
// naming the path and the reason, before any launcher starts. Removing an
// entry narrows, needs no decision and takes effect at once. What the
// proxy and the mount plan do with an approved value is the sandbox lane's
// (M119, M127).
//
// Every case here is expected to fail on the engine these tests were
// written against, which knows neither key (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { confirmRequired, consume, decisionsOfKind } from './harness/decisions.mjs';
import { makeTempDir, removeDir, waitFor } from './harness/engine.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy, getPolicy, policyRevisions } from './harness/journal.mjs';
import { readRun } from './harness/reads.mjs';
import { addWork, assertRunEnded, getRow, requestTick, runsOf, scriptedEngine, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { eventsNamed } from './harness/trust.mjs';

const policyPath = (project) => `/v1/projects/${project}/policy`;

// The effective policy once revision `n` is the recorded one.
const atRevision = (fx, project, n) =>
  waitFor(
    async () => {
      const policy = await getPolicy(fx.engine, project);
      return policy.revision === n ? policy : undefined;
    },
    { what: `policy revision ${n} to be effective` },
  );

// A widening previewed, with the policy shown unchanged, then approved and
// in effect. Returns the effective policy afterwards.
async function approvedWidening(fx, project, change, key) {
  const before = await getPolicy(fx.engine, project);
  const previewed = await confirmRequired(fx, policyPath(project), change);
  assert.deepEqual([previewed.kind, previewed.manifest.widens], ['policy_widening', [key]], `${key}: the submission raises a widening that names the key`);
  assert.deepEqual(previewed.manifest.proposed_policy[key], change[key], `${key}: the preview binds the complete proposed value`);
  const unchanged = await getPolicy(fx.engine, project);
  assert.deepEqual([unchanged.revision, unchanged.effective[key]], [before.revision, before.effective[key]], `${key}: nothing changes before the approval`);
  await consume(fx, project, previewed, 'approve');
  const policy = await atRevision(fx, project, (before.revision ?? 0) + 1);
  assert.deepEqual(policy.effective[key], change[key], `${key}: approved, the effective policy holds the value`);
  return policy;
}

// A test-owned place the engine may be given to read: a directory with one file.
function harmlessDirectory(t) {
  const dir = makeTempDir('m108-read');
  t.after(() => removeDir(dir));
  writeFileSync(join(dir, 'tool.txt'), 'a harmless toolchain file\n');
  return dir;
}

describe('M108 the widening settings', () => {
  test('(a) egress_allow_extra and (b) sandbox_read_paths: each addition raises policy_widening and changes nothing until approved; approved, the effective policy holds the value', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addGitProject(fx)).id;
    await approvedWidening(fx, project, { egress_allow_extra: ['registry.example'] }, 'egress_allow_extra');
    const harmless = harmlessDirectory(t);
    await approvedWidening(fx, project, { sandbox_read_paths: [harmless] }, 'sandbox_read_paths');
    assert.deepEqual(policyRevisions(fx.home, project).map((row) => row.widens_authority), [1, 1], 'both revisions record that they widen authority');
  });

  test('(c) an approved sandbox_read_paths that exposes forbidden authority refuses every launch mount_plan_refused, naming the path and the reason, with no launcher started', async (t) => {
    // The engine's HOME is a directory of its own, apart from the engine
    // home, so that an operator credential location can be seeded there.
    const operatorHome = makeTempDir('m108-operator');
    t.after(() => removeDir(operatorHome));
    mkdirSync(join(operatorHome, '.ssh'), { mode: 0o700 });
    writeFileSync(join(operatorHome, '.ssh', 'id_ed25519'), 'not a real key\n', { mode: 0o600 });
    const fx = await scriptedEngine(t, { env: { HOME: operatorHome } });
    fx.scripted.defaultScript(script.complete());
    const project = await addGitProject(fx);
    const id = project.id;

    // A workspace of an earlier run, under the engine home.
    const first = await addWork(fx.engine, id, 'verification');
    await tickUntil(fx.engine, id, () => workItem(fx.home, first).status === 'complete', { what: 'a first run to leave a workspace' });
    const workspace = getRow(fx.home, 'workspaces', runsOf(fx.home, first)[0].workspace).path;
    assert.ok(existsSync(workspace), 'the fixture is live: a retained workspace exists');

    // Aliases and special files, seeded and verified from the host side.
    const scratch = makeTempDir('m108-special');
    t.after(() => removeDir(scratch));
    symlinkSync(fx.home, join(scratch, 'home-alias'));
    mkdirSync(join(scratch, 'with-socket'));
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(scratch, 'with-socket', 'listener.sock'), resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    mkdirSync(join(scratch, 'with-fifo'));
    assert.equal(spawnSync('mkfifo', [join(scratch, 'with-fifo', 'pipe')]).status, 0, 'the fixture is live: a FIFO was made');
    const mnt = existsSync('/mnt/c') ? '/mnt/c' : '/mnt';
    assert.ok(existsSync(mnt), `the fixture is live: ${mnt} exists`);

    const forbidden = [
      ['the engine home', fx.home, ['engine_home']],
      ['a registered repository', project.repo.path, ['repository']],
      ['a workspace', workspace, ['workspace', 'engine_home']],
      ['a seeded ~/.ssh', join(operatorHome, '.ssh'), ['credential_location']],
      ['a symlink alias of the engine home', join(scratch, 'home-alias'), ['engine_home']],
      ['a directory holding a listening unix socket', join(scratch, 'with-socket'), ['special_file']],
      ['a directory holding a FIFO', join(scratch, 'with-fifo'), ['special_file']],
      ['/run', '/run', ['forbidden_root']],
      ['/proc', '/proc', ['forbidden_root']],
      ['/dev', '/dev', ['forbidden_root']],
      ['/tmp', '/tmp', ['forbidden_root']],
      [`a path under /mnt (${mnt})`, mnt, ['forbidden_root', 'wsl_path']],
    ];
    for (const [what, path, reasons] of forbidden) {
      await approvedWidening(fx, id, { sandbox_read_paths: [path] }, 'sandbox_read_paths');
      const item = await addWork(fx.engine, id, 'verification');
      const launches = fx.scripted.launches().length;
      await requestTick(fx.engine, id);
      const run = await waitForRun(fx.home, item, { state: 'ended' });
      assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
      assert.equal(fx.scripted.launches().length, launches, `${what}: no launcher started`);
      assert.deepEqual(eventsNamed(fx.home, 'domain.placed').filter((event) => event.subject?.run === run.id), [], `${what}: no domain placed`);
      const shown = await readRun(fx.engine, id, run.id);
      assert.equal(shown.code, 'mount_plan_refused', `${what}: the run read carries the code (${JSON.stringify(shown.refusal ?? null)})`);
      assert.equal(shown.refusal?.subject?.path, path, `${what}: the refusal names the path as the policy gave it`);
      assert.ok(reasons.includes(shown.refusal?.subject?.reason), `${what}: the reason is ${reasons.join(' or ')} (it is ${JSON.stringify(shown.refusal?.subject?.reason)})`);
    }
  });

  test('(d) removing an entry needs no decision and takes effect at once', async (t) => {
    const fx = await scriptedEngine(t);
    const project = (await addGitProject(fx)).id;
    await approvedWidening(fx, project, { egress_allow_extra: ['registry.example', 'mirror.example'] }, 'egress_allow_extra');
    const harmless = harmlessDirectory(t);
    await approvedWidening(fx, project, { sandbox_read_paths: [harmless] }, 'sandbox_read_paths');
    const decisions = decisionsOfKind(fx.home, project, 'policy_widening').length;

    const narrowed = await changePolicy(fx.engine, project, { egress_allow_extra: ['mirror.example'], sandbox_read_paths: [] });
    assert.deepEqual([narrowed.effective.egress_allow_extra, narrowed.effective.sandbox_read_paths, narrowed.revision], [['mirror.example'], [], 3], 'the removal is in effect at once, as the next revision');
    assert.equal(decisionsOfKind(fx.home, project, 'policy_widening').length, decisions, 'no decision was raised for a removal');
    assert.equal(policyRevisions(fx.home, project).at(-1).widens_authority, 0, 'the revision records that it widens nothing');
  });
});
