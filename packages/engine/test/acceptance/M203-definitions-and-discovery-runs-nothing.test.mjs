// M203, definitions, and discovery runs nothing (M3 slice 15; kernel lane).
// M3 plan §3.1 M203; D3-P02, D3-P03; T01; D3 §§1.3, 1.4, A.2 DiscoveryError,
// A.4; SEAM.md §§177 to 185.
//
// (a) Each field of a definition invalid in turn is its discovery error at
// the definition's path, never a dropped definition. (b) A hostile tree (a
// symlink, a submodule and an executable in the definitions directory, a
// definition over 64 KiB, 513 definitions; hooks, a filter driver, a
// file-system monitor and a remote planted) is discovered with its errors
// and caps; nothing planted runs and no remote is contacted.
//
// Kernel lane: discovery reads trees with engine git and runs nothing.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { effectiveVersion } from './harness/gates.mjs';
import { evidenceProgram, gitQuiet, plantAllHooks, plantFilter, readEvidence } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { DEFS_DIR, GOVERNED_FILE, KERNEL_COMMANDS, acceptance, checkByKey, checkProject, codesAt, defPath, definitionText, governedText, smoke, versionRead } from './harness/checks/fixtures.mjs';

const GOV = GOVERNED_FILE;
const DATA = '.surety/checks/data.txt';
const LINK = '.surety/checks/link.txt';
const base = (extra = {}) => ({ [GOV]: governedText({ check_commands: KERNEL_COMMANDS, ...extra }), [DATA]: 'protected data\n', [defPath('s')]: smoke('s', { gates: ['stage'] }) });
const versionOf = async (fx, project) => versionRead(fx.engine, project.id, effectiveVersion(fx.home, project.id).id);

describe('M203 definitions, and discovery runs nothing', () => {
  test('(a) each field of a definition invalid in turn: its discovery error at its path, never a dropped definition', async (t) => {
    const fx = await scriptedEngine(t);
    const variants = [
      { label: 'key is not the stem', file: defPath('x'), text: smoke('y', { gates: ['stage'] }), code: 'key_mismatch' },
      { label: 'a repeated JSON member', file: defPath('dup'), text: '{"schema": 1, "key": "dup", "key": "dup", "kind": "smoke", "command": ["probe"], "timeout_s": 60, "gate_kinds": ["stage"]}\n', code: 'duplicate_entry' },
      { label: 'a repeated criterion', file: defPath('rc'), text: acceptance('rc', ['R1.1', 'R1.1'], { gates: ['stage'] }), code: 'duplicate_entry' },
      { label: 'a repeated input', file: defPath('ri'), text: smoke('ri', { gates: ['stage'], inputs: [DATA, DATA] }), code: 'duplicate_entry' },
      { label: 'a repeated required key', file: GOV, gov: { required_checks: ['s', 's'] }, code: 'duplicate_entry' },
      { label: 'a program not in check_commands', file: defPath('np'), text: smoke('np', { gates: ['stage'], command: ['nope'] }), code: 'program_not_allowed' },
      { label: 'an input outside the roots', file: defPath('out'), text: smoke('out', { gates: ['stage'], inputs: ['README.md'] }), code: 'input_outside_roots' },
      { label: 'an input naming the governed file', file: defPath('gov'), text: smoke('gov', { gates: ['stage'], inputs: [GOV] }), code: 'invalid_value' },
      { label: 'an input that is not a regular file', file: defPath('lnk'), text: smoke('lnk', { gates: ['stage'], inputs: [LINK] }), code: 'input_not_regular', entries: { [LINK]: { link: 'data.txt' } } },
      { label: 'covers on a developer check', file: defPath('dev'), text: acceptance('dev', ['R1.1'], { gates: ['stage'], origin: 'developer' }), code: 'covers_not_allowed' },
      { label: 'covers on a kind that covers nothing (smoke)', file: defPath('wk'), text: smoke('wk', { gates: ['stage'], covers: { criteria: ['R1.1'] } }), code: 'covers_not_allowed' },
      { label: 'sensitive_areas on a kind other than sensitivity_floor', file: defPath('wa'), text: definitionText('wa', { kind: 'acceptance', command: ['probe'], timeout_s: 60, gate_kinds: ['stage'], covers: { criteria: ['R1.1'], sensitive_areas: ['authentication'] } }), code: 'covers_not_allowed' },
      { label: 'an engine variable in env (SURETY_CHECK)', file: defPath('ev'), text: smoke('ev', { gates: ['stage'], env: { SURETY_CHECK: 'forged' } }), code: 'invalid_value' },
      { label: 'an engine variable in env (PATH)', file: defPath('ep'), text: smoke('ep', { gates: ['stage'], env: { PATH: '/opt/elsewhere' } }), code: 'invalid_value' },
    ];
    for (const v of variants) {
      const files = base(v.gov ?? {});
      if (v.text !== undefined) files[v.file] = v.text;
      const project = await checkProject(fx, { files, entries: v.entries });
      const version = await versionOf(fx, project);
      assert.ok(codesAt(version, v.file).includes(v.code), `${v.label}: a ${v.code} discovery error at ${v.file} (errors: ${JSON.stringify(version.discovery_errors)})`);
      assert.ok(checkByKey(version, 's'), `${v.label}: control: the valid definition beside it is discovered`);
    }
  });

  test('(b) a hostile tree: a symlink, a submodule and an executable in the definitions directory and a definition over 64 KiB are errors; nothing planted runs and no remote is contacted', async (t) => {
    const fx = await scriptedEngine(t);
    const evidence = join(fx.root, 'evidence.log');
    const dir = join(fx.root, 'planted');
    const big = definitionText('big', { kind: 'smoke', command: ['probe'], timeout_s: 60, gate_kinds: ['stage'], env: { PADDING: 'x'.repeat(66 * 1024) } });
    const plant = (repo) => {
      plantAllHooks(repo.path, evidence);
      plantFilter(repo.path, repo.ref, evidence, { dir, pattern: '*.json' });
      gitQuiet(repo.path, ['config', 'core.fsmonitor', evidenceProgram(join(dir, 'fsmonitor'), evidence, 'fsmonitor')]);
      gitQuiet(repo.path, ['config', 'remote.origin.url', `ext::${evidenceProgram(join(dir, 'remote'), evidence, 'remote')} %S`]);
      gitQuiet(repo.path, ['config', 'protocol.ext.allow', 'always']);
      gitQuiet(repo.path, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    };
    const files = { ...base(), [defPath('big')]: big };
    const project = await checkProject(fx, {
      files,
      entries: {
        [defPath('link')]: { link: 's.json' },
        [`${DEFS_DIR}sub`]: { gitlink: 'a'.repeat(40) },
        [defPath('exec')]: { content: smoke('exec', { gates: ['stage'] }), mode: '100755' },
      },
      plant,
    });
    const version = await versionOf(fx, project);
    await tick(fx.engine, project.id);
    for (const [file, code] of [
      [defPath('link'), 'not_regular_file'],
      [`${DEFS_DIR}sub`, 'not_regular_file'],
      [defPath('exec'), 'not_regular_file'],
      [defPath('big'), 'too_large'],
    ]) assert.ok(codesAt(version, file).includes(code), `${file}: a ${code} discovery error (errors: ${JSON.stringify(version.discovery_errors)})`);
    assert.ok(checkByKey(version, 's'), 'control: the valid definition is discovered');
    assert.equal(readEvidence(evidence), null, 'no hook, filter driver, file-system monitor or remote transport planted in the repository ran');
  });

  test('(b) 513 definitions: the cap is a discovery error, and no definition is dropped silently', async (t) => {
    const fx = await scriptedEngine(t);
    const files = base();
    for (let i = 0; i < 512; i++) files[defPath(`c${String(i).padStart(3, '0')}`)] = smoke(`c${String(i).padStart(3, '0')}`, { gates: ['stage'] });
    const project = await checkProject(fx, { files });
    const version = await versionOf(fx, project);
    assert.ok(
      version.discovery_errors.some((e) => e.path === DEFS_DIR && e.code === 'too_many'),
      `513 definitions: a too_many discovery error at ${DEFS_DIR} (errors: ${JSON.stringify(version.discovery_errors.slice(0, 5))})`,
    );
  });
});
