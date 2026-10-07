// M210, input identity and the fingerprint migration (M3 slice 17, the
// protected inputs; kernel lane). M3 plan §3.3 M210; D3-P10; D3 §1.3, §7.1
// L6 (B01), §7.4 Q11; E91 item 2; SEAM.md §§195 to 197, 202.
//
// (a) Type and mode are part of identity. Three projects whose protected
// sets differ only in the git type or mode of one input, its blob id the
// same: a regular file, the same file with its executable bit set, and a
// symlink whose target is the file's bytes. Under the mode-free scheme the
// three recorded fingerprints were equal; over the manifest of L6 they
// differ, and so does the check fingerprint of the check that reads the
// input. (b) A symlink among a check's inputs is `input_not_regular`.
// (a)'s `input_changed` observation is the classifier's, row M226 (slice
// 19; Sean's ruling for slice 17, COVERAGE.md).
//
// (c) The Q11 migration. Two projects, each nominated, have their effective
// version's fingerprint put back in the pre-L6 form by the harness-only
// legacy fixture (SEAM.md §197). Until the engine restarts, no comparison
// crosses schemes: the gate cannot say the head's set is the authorized one.
// The engine is restarted while the second project's repository cannot be
// read. The first version's fingerprint is recomputed from its authorized
// tree, over the manifest; the second's is unreadable, and its gates carry
// PROTECTED_PATH_UNAUTHORIZED although its repository answers again.
//
// Kernel lane: nothing runs a check. The repository made unreadable is the
// test's own (chmod of its .git), restored before the case ends.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { effectiveVersion, legacyProtectedFingerprint, nominated, protectedFingerprint, reasonCodes, stageGate } from './harness/gates.mjs';
import { makeUnreadable } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, checkByKey, checkProject, codesAt, defPath, governedText, smoke, versionRead } from './harness/checks/fixtures.mjs';

const INPUT = '.surety/checks/expect.txt';
// A symlink's blob is its target's text, so this content gives the regular
// file and the symlink one blob id.
const CONTENT = 'expected-bytes';
const GOVERNED = governedText({ check_commands: KERNEL_COMMANDS });
const DEF = smoke('reads', { gates: ['stage'], inputs: [INPUT] });

const versionOf = (fx, project) => versionRead(fx.engine, project.id, effectiveVersion(fx.home, project.id).id);
const storedFingerprint = (home, id) => withStore(home, (db) => db.prepare('SELECT "fingerprint" FROM "protected_versions" WHERE "id" = ?').get(id)).fingerprint;

describe('M210 input identity and the fingerprint migration', () => {
  test('(a) a regular input, the same blob with its executable bit set, the same blob as a symlink: three protected fingerprints and two check fingerprints; (b) the symlink input is input_not_regular', async (t) => {
    const fx = await scriptedEngine(t);
    const files = { [GOVERNED_FILE]: GOVERNED, [defPath('reads')]: DEF };
    const regular = await checkProject(fx, { files: { ...files, [INPUT]: CONTENT } });
    const executable = await checkProject(fx, { files, entries: { [INPUT]: { content: CONTENT, mode: '100755' } } });
    const link = await checkProject(fx, { files, entries: { [INPUT]: { link: CONTENT } } });
    const projects = { regular, executable, link };

    const legacy = Object.values(projects).map((p) => legacyProtectedFingerprint(p.repo.path, p.base));
    assert.equal(new Set(legacy).size, 1, 'the fixture is live: the three protected sets have the same [path, blob id] pairs, so the mode-free fingerprint cannot tell them apart');

    const recorded = {};
    for (const [label, p] of Object.entries(projects)) {
      recorded[label] = effectiveVersion(fx.home, p.id).fingerprint;
      assert.equal(recorded[label], protectedFingerprint(p.repo.path, p.base), `${label}: the version's fingerprint is SHA-256 over the [path, type, mode, object id] manifest (L6; SEAM.md §196)`);
    }
    assert.equal(new Set(Object.values(recorded)).size, 3, `the three protected fingerprints differ: type and mode are identity (${JSON.stringify(recorded)})`);

    const reg = checkByKey(await versionOf(fx, regular), 'reads');
    const exe = checkByKey(await versionOf(fx, executable), 'reads');
    assert.ok(reg && exe, 'the check is discovered in the regular and the executable projects');
    const entry = (c) => c.input_manifest.find(([path]) => path === INPUT);
    assert.deepEqual([entry(reg)[1], entry(reg)[2]], ['blob', '100644'], 'the regular input is in the manifest with its type and mode');
    assert.deepEqual([entry(exe)[1], entry(exe)[2], entry(exe)[3]], ['blob', '100755', entry(reg)[3]], 'the executable input is in the manifest with its mode, the blob id the same');
    assert.notEqual(exe.definition_hash, reg.definition_hash, 'an executable bit changed changes the check fingerprint');

    const linked = await versionOf(fx, link);
    assert.ok(codesAt(linked, defPath('reads')).includes('input_not_regular'), `(b) a symlink among the check's inputs is input_not_regular at its definition (errors: ${JSON.stringify(linked.discovery_errors)})`);
  });

  test('(c) versions recorded under the mode-free scheme: no comparison across schemes; at the next start each is recomputed from its authorized tree, and one whose tree cannot be read is unreadable, its gates PROTECTED_PATH_UNAUTHORIZED', async (t) => {
    const fx = await scriptedEngine(t);
    const files = { [GOVERNED_FILE]: GOVERNED, [INPUT]: `${CONTENT}\n`, [defPath('reads')]: DEF };
    const readable = await checkProject(fx, { files });
    const unreadable = await checkProject(fx, { files });
    const ctx = {
      readable: { ...(await nominated(fx, { project: readable, requirements: [] })), project: readable },
      unreadable: { ...(await nominated(fx, { project: unreadable, requirements: [] })), project: unreadable },
    };
    const versions = {};
    for (const [label, p] of Object.entries({ readable, unreadable })) {
      const version = effectiveVersion(fx.home, p.id);
      versions[label] = version.id;
      const legacy = legacyProtectedFingerprint(p.repo.path, p.base);
      assert.notEqual(legacy, protectedFingerprint(p.repo.path, p.base), 'the fixture is live: the two schemes give different values for this set');
      const res = await fx.engine.post('/v1/harness/fixtures/legacy-fingerprint', { protected_version: version.id });
      assert.equal(res.status, 200, `${label}: the legacy fingerprint fixture records the version under the mode-free scheme (SEAM.md §197) (body: ${res.text})`);
      assert.equal(res.body?.protected_version?.fingerprint, legacy, `${label}: the fixture answers with the mode-free value of the version's own set`);
      assert.equal(storedFingerprint(fx.home, version.id), legacy, `${label}: the store holds the mode-free value, as a store written before slice 17 does`);
    }

    // Meanwhile (Q11): a comparison across schemes is unreadable, never equal.
    const before = await stageGate(fx, ctx.readable);
    assert.ok(reasonCodes(before).includes('PROTECTED_PATH_UNAUTHORIZED'), `before the restart, the head's set is not shown to be the authorized one: no comparison crosses schemes (reasons: ${reasonCodes(before).join(', ') || 'none'})`);

    // The restart, with the second project's repository unreadable.
    await fx.engine.stop();
    const restore = makeUnreadable(unreadable.repo.path);
    fx.beforeCleanup.push(restore);
    await fx.start();
    restore();
    fx.beforeCleanup.pop();
    for (const p of [readable, unreadable]) await tick(fx.engine, p.id, { rounds: 3 });

    const recomputed = storedFingerprint(fx.home, versions.readable);
    assert.equal(recomputed, protectedFingerprint(readable.repo.path, readable.base), "the readable version's fingerprint is recomputed from its authorized tree, over the manifest (Q11 (a))");
    assert.equal((await versionRead(fx.engine, readable.id, versions.readable)).fingerprint, recomputed, 'and the version read shows it');
    const after = await stageGate(fx, ctx.readable);
    assert.ok(!reasonCodes(after).includes('PROTECTED_PATH_UNAUTHORIZED'), `with both sides over the manifest, the head's set is the authorized one (reasons: ${reasonCodes(after).join(', ') || 'none'})`);

    const lost = await versionRead(fx.engine, unreadable.id, versions.unreadable);
    assert.equal(lost.fingerprint, null, `the version whose tree could not be read at the migration has an unreadable fingerprint, null on the version read (SEAM.md §197) (got ${JSON.stringify(lost.fingerprint)})`);
    const refused = await stageGate(fx, ctx.unreadable);
    assert.equal(refused.outcome, 'not_satisfied');
    assert.ok(reasonCodes(refused).includes('PROTECTED_PATH_UNAUTHORIZED'), `its gate carries PROTECTED_PATH_UNAUTHORIZED although the repository answers again (reasons: ${reasonCodes(refused).join(', ') || 'none'})`);
  });
});
