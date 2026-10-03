// M109, no entry without the sandbox; no production route to the harness
// boundary; the spawn lint (M2 slice 10, kernel lane). M2 plan §3.1 M109;
// D2 §1.1, §5 C3 (D2-C06); D1 §15.4; E25 item 2; SEAM.md §§95, 116, 118,
// 121.
//
// A trust entry names D2's one isolation and one boundary mechanism or is
// not written, and an entry's mechanism never changes. Outside harness mode
// the engine would dispatch only to backends with active entries, never to
// `scripted`, and no configuration key selects the harness boundary. The
// M74 lint keeps every spawn of a backend binary inside `invoke/`, and
// allows the boundary's own helper modules only by name, each one file for
// one host tool. That the scripted non-harness path runs in the sandbox is
// observed by M120 (the role's mount table equals the plan).
//
// Cases (a) and (b) are expected to fail on the engine these tests were
// written against; (c) passes on it, since no helper module exists yet
// (COVERAGE.md, "M2 slice 10").

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { EXIT, REPO_ROOT, freePort, makeTempDir, removeDir, snapshotDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { ALLOWED, D2_HELPERS, inspectLaunches } from './harness/launch-lint.mjs';
import { readRun } from './harness/reads.mjs';
import { addWork, assertRunEnded, pauseProject, requestTick, resumeProject, waitForRun } from './harness/runs.mjs';
import { formatViolations, readSources } from './harness/source-lint.mjs';
import { BOUNDARY, ISOLATION, directUpdateRefused, entryShown, installTrustEntry, realBackendProject, refusedTrustEntry, trustEntries, trustEntry, useBackend } from './harness/trust.mjs';

const SRC = join(REPO_ROOT, 'packages', 'engine', 'src');

describe('M109 no entry without the sandbox', () => {
  test('(a) an entry whose isolation or boundary is not D2\'s mechanism identifier is refused at write, and an active entry has no transition to another isolation or boundary', async (t) => {
    const { fx, standIn } = await realBackendProject(t);
    await refusedTrustEntry(fx.engine, standIn, { isolation: 'docker' }, { field: 'isolation' });
    await refusedTrustEntry(fx.engine, standIn, { boundary: 'process_group' }, { field: 'boundary' });
    await refusedTrustEntry(fx.engine, standIn, { isolation: 'none' }, { field: 'isolation' });
    assert.deepEqual(trustEntries(fx.home), [], 'none was written');

    const active = await installTrustEntry(fx.engine, standIn, { status: 'active' });
    const row = trustEntry(fx.home, active.id);
    assert.deepEqual([row.status, row.isolation, row.boundary], ['active', ISOLATION, BOUNDARY], 'the fixture is live: an active entry with D2\'s mechanisms');
    await fx.engine.stop();
    for (const [column, value] of [['isolation', 'docker'], ['boundary', 'process_group']]) {
      const attempt = directUpdateRefused(fx.home, `UPDATE "trust_entries" SET "${column}" = ? WHERE "id" = ?`, value, active.id);
      assert.equal(attempt.refused, true, `the store refuses to change an entry's ${column} (${attempt.code})`);
      assert.match(attempt.code, /^SQLITE_CONSTRAINT/, 'with a constraint error, not a silently ignored write');
    }
    assert.deepEqual([trustEntry(fx.home, active.id).isolation, trustEntry(fx.home, active.id).boundary], [ISOLATION, BOUNDARY], 'the entry is as it was');
  });

  test('(b) outside harness mode: backends lists only backends with active entries and never scripted; a dispatch to scripted is backend_refused; a configuration key naming the harness boundary is unknown', async (t) => {
    const { fx, standIn, project } = await realBackendProject(t);
    const active = await installTrustEntry(fx.engine, standIn, { status: 'active' });
    // The project's roles are at their default, `scripted`, apart from the verifier: put that back too.
    await useBackend(fx.engine, project, 'scripted', { roles: ['verifier'] });
    await pauseProject(fx.engine, project);
    const item = await addWork(fx.engine, project, 'verification');
    await fx.engine.stop();

    const engine = await fx.start({ harness: false });
    const info = await engine.engineInfo();
    assert.equal(info.harness, false, 'the fixture is live: no harness');
    assert.ok(!info.backends.includes('scripted'), `scripted is never a backend outside harness mode (backends: ${info.backends.join(', ')})`);
    const activeBackends = trustEntries(fx.home).filter((row) => row.status === 'active').map((row) => row.backend);
    assert.ok(info.backends.every((name) => activeBackends.includes(name)), `every backend listed has an active entry (listed: ${info.backends.join(', ') || 'none'}; active: ${activeBackends.join(', ')})`);
    assert.equal(entryShown(info, active.id).status, 'active', 'the entry is listed, active, outside harness mode too');

    await resumeProject(engine, project);
    await requestTick(engine, project);
    const run = await waitForRun(fx.home, item, { state: 'ended' });
    assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
    assert.equal((await readRun(engine, project, run.id)).code, 'backend_refused', 'a dispatch to scripted outside harness mode is refused');
    assert.equal(fx.scripted.launches().length, 0, 'and nothing was launched');

    // No production setting selects the harness boundary (C3): the key is unknown to the closed configuration.
    await engine.stop();
    for (const key of ['execution_boundary', 'harness_boundary']) {
      const home = makeTempDir('m109');
      t.after(() => removeDir(home));
      const port = await freePort();
      writeEngineConfig(home, { api_port: port, [key]: 'scripted' });
      const before = snapshotDir(home);
      const result = await startRefused({ home, harness: false });
      assert.equal(result.code, EXIT.config, `{"${key}": "scripted"}: exit status (stderr: ${result.stderr})`);
      assert.deepEqual([result.refusal?.code, result.refusal?.subject?.field], ['unknown_field', key], `{"${key}": "scripted"}: refused as an unknown key`);
      assert.deepEqual(snapshotDir(home), before, 'nothing written under the engine home');
    }
  });

  test('(c) the spawn lint: a spawn of claude outside invoke/ is reported, in a boundary module that is not a named helper and in the trust module; the named helpers are one file each, for one host tool each, and the real source keeps to the list', () => {
    const sources = readSources(SRC);
    assert.ok(sources.length > 0, 'there is source to inspect');
    const clean = inspectLaunches(sources);
    assert.equal(clean.length, 0, `the engine's source starts a process only in ${ALLOWED.map((place) => `${place.where} (${place.why})`).join(', ')}.\n${formatViolations(clean)}\n`);

    for (const helper of D2_HELPERS) {
      assert.ok(!helper.where.endsWith('/') && helper.where.endsWith('.ts'), `a helper is one file, not a directory (${helper.where})`);
      assert.ok(typeof helper.tool === 'string' && helper.tool.length > 0 && helper.why.includes(helper.tool), `a helper names the host tool it runs (${helper.where}: ${helper.why})`);
      assert.ok(!helper.where.startsWith('invoke/') && helper.where !== 'git/exec.ts' && !helper.where.startsWith('testing/'), `a helper is outside the three M1 places (${helper.where})`);
    }

    const mutated = (file, text) => (sources.some((source) => source.file === file) ? sources.map((source) => (source.file === file ? { file, text: source.text + text } : source)) : [...sources, { file, text }]);
    const spawnClaude = `\nimport { spawn } from 'node:child_process';\nexport const launchModel = (prompt: string) => spawn('claude', ['--bare', '-p', prompt]);\n`;
    for (const file of ['boundary/launch.ts', 'boundary/domains.ts', 'trust/qualify.ts', 'invoke-helpers/spawn.ts']) {
      const found = inspectLaunches(mutated(file, spawnClaude)).filter((violation) => violation.file === file);
      assert.ok(found.length >= 1, `a spawn of claude in ${file} is reported`);
      assert.ok(found.every((violation) => /child_process/.test(violation.what)), `and named for what it is (${found.map((violation) => violation.what).join('; ')})`);
    }
    // The control: the same text inside the choke point is where a backend spawn belongs.
    assert.equal(inspectLaunches(mutated('invoke/adapters/claude.ts', spawnClaude)).length, 0, 'the same spawn under invoke/ is not reported');
  });
});
