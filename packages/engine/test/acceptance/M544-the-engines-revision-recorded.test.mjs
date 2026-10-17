// M544, the engine's revision recorded (M6 slice 39, the corrections carried
// from M5; kernel lane, the scripted backend). M6 plan §3.1 M544; E154 item
// 6 (5) ("`engine_version` reads `0.0.0`"); E156 Q1; BS6 §11.3; D6 §7.6's
// host block, A.3; M441 (c), (f); SEAM.md §474.
//   (a) an engine started from a build of a known source revision:
//       `host_observations` names the source revision beside the package
//       version, never `0.0.0` alone presented as a version;
//   (b) one whose revision cannot be read: `unknown` with its reason;
//   (c) the pace read's host block for a current and a historical run: each
//       run with the revision recorded at its engine's start, never the
//       present one.
// The pins (SEAM.md §474): the column `host_observations.engine_revision` †,
// the full hexadecimal commit id of the source the running engine was built
// from, or null where it could not be read; `engine_version` stays the
// package version beside it; the pace read's host block and each `hosts[]`
// entry carry `engine_revision` †, that id or `{unknown: <reason>}`. The
// known revision of (a) is this checkout's: `git rev-parse HEAD` in the
// engine package's directory, which the harness's engine runs from (its
// `dist/`, built by the run's `npm run build`); a checkout whose revision
// the test cannot read fails the case at its fixture assertion, never
// skips it. The switch † `--harness-engine-revision-unread` (harness mode
// only; a usage error otherwise): this start records its revision as
// unreadable, whatever it could have read, as an engine started from a
// build outside any repository would.
//
// SAFETY (BS6 §4.1; E64): kernel lane; no domain, no unit; the test signals
// nothing but its own engines through the harness (the verified kill); git
// is only read, in this checkout.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { addGitProject } from './harness/gitruns.mjs';
import { readPace } from './harness/journey/drive.mjs';
import { addWork, runsOf, scriptedEngine, tick, waitForWork } from './harness/runs.mjs';
import { script } from './harness/scripted.mjs';
import { withStore } from './harness/store.mjs';
import { isUnknown, show } from './harness/exec37/pace.mjs';

const UNREAD = '--harness-engine-revision-unread';
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// This checkout's revision, read by the test itself.
function checkoutRevision() {
  const done = spawnSync('git', ['-C', ENGINE_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const rev = done.status === 0 ? done.stdout.trim() : null;
  assert.match(rev ?? '', /^[0-9a-f]{40}$/, `the fixture: this checkout's revision can be read (git rev-parse HEAD in ${ENGINE_DIR}: ${done.status} ${done.stderr})`);
  return rev;
}

const hostRows = (home, project) => withStore(home, (db) => db.prepare('SELECT * FROM "host_observations" WHERE "project" = ? ORDER BY rowid').all(project));

async function startWith(fx, args) {
  try {
    await fx.start({ args });
  } catch (err) {
    assert.fail(`the engine starts${args.length ? ` with ${args.join(' ')} (SEAM.md §474)` : ''}: ${String(err?.message ?? err).slice(0, 600)}`);
  }
}

// One one-shot run completed under the running engine; returns its run.
async function oneRun(fx, project) {
  const item = await addWork(fx.engine, project, 'verification');
  fx.scripted.script(item, script.complete());
  await tick(fx.engine, project);
  await waitForWork(fx.home, item, 'complete');
  return runsOf(fx.home, item)[0];
}

const hostOfRun = (pace, run) => {
  const r = pace.runs.find((x) => x.id === run.id);
  assert.ok(typeof r?.host_observation === 'string', `the run names its host observation (${show(r?.host_observation)})`);
  const h = pace.hosts.find((x) => x.id === r.host_observation);
  assert.ok(h, `its host observation is listed in hosts (${r.host_observation})`);
  return h;
};

describe('M544 the engine\'s revision recorded at its start', () => {
  test('(a) an engine built from a known source revision: host_observations names the revision beside the package version; the pace read\'s host block shows it', async (t) => {
    const rev = checkoutRevision();
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    await oneRun(fx, project.id);
    const rows = hostRows(fx.home, project.id);
    assert.ok(rows.length >= 1, `the fixture is live: a host observation was recorded (${show(rows)})`);
    const row = rows.at(-1);
    assert.equal(row.engine_revision, rev, `host_observations.engine_revision † is the source revision ${rev} (${show({ engine_version: row.engine_version, engine_revision: row.engine_revision })})`);
    assert.ok(typeof row.engine_version === 'string' && row.engine_version.length > 0, `beside the package version (${show(row.engine_version)})`);
    const pace = await readPace(fx, project.id);
    assert.equal(pace.host.engine_revision, rev, `the host block's engine_revision † (${show({ engine_version: pace.host.engine_version, engine_revision: pace.host.engine_revision })})`);
    assert.equal(pace.host.engine_version, row.engine_version, 'and its engine_version, the package version');
  });

  test('(b) an engine whose revision cannot be read: unknown with its reason, never 0.0.0 alone', async (t) => {
    const fx = await scriptedEngine(t, { start: false });
    await startWith(fx, [UNREAD]);
    const project = await addGitProject(fx);
    await oneRun(fx, project.id);
    const row = hostRows(fx.home, project.id).at(-1);
    assert.ok(row, 'the fixture is live: a host observation was recorded');
    assert.equal(row.engine_revision, null, `host_observations.engine_revision † null: nothing read is recorded as a revision (${show(row.engine_revision)})`);
    const pace = await readPace(fx, project.id);
    assert.ok(isUnknown(pace.host.engine_revision), `the host block's engine_revision † is unknown (${show(pace.host.engine_revision)})`);
    assert.ok(pace.host.engine_revision.unknown.length > 0, 'with its reason');
  });

  test('(c) a historical run keeps the revision recorded at its engine\'s start; the host block shows the present one', async (t) => {
    const rev = checkoutRevision();
    const fx = await scriptedEngine(t, { start: false });
    // Three incarnations: unread, read, unread.
    await startWith(fx, [UNREAD]);
    const project = await addGitProject(fx);
    const run1 = await oneRun(fx, project.id);
    await fx.engine.kill();
    await startWith(fx, []);
    const run2 = await oneRun(fx, project.id);
    await fx.engine.kill();
    await startWith(fx, [UNREAD]);
    const run3 = await oneRun(fx, project.id);
    const pace = await readPace(fx, project.id);
    assert.ok(pace.hosts.length >= 3, `the fixture is live: one host observation per incarnation (${show(pace.hosts.map((h) => [h.id, h.incarnation, h.engine_revision]))})`);
    const [h1, h2, h3] = [run1, run2, run3].map((r) => hostOfRun(pace, r));
    assert.ok(new Set([h1.id, h2.id, h3.id]).size === 3, 'each run on its own incarnation\'s observation');
    assert.ok(isUnknown(h1.engine_revision), `the first run: unknown, as recorded at its start, never the revision read later (${show(h1.engine_revision)})`);
    assert.equal(h2.engine_revision, rev, `the second run: the revision recorded at its start (${show(h2.engine_revision)})`);
    assert.ok(isUnknown(h3.engine_revision), `the third run: unknown, not the second's revision (${show(h3.engine_revision)})`);
    assert.ok(isUnknown(pace.host.engine_revision), `the host block is the present observation's (${show(pace.host.engine_revision)})`);
  });
});
