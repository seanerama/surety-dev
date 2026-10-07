// M202, the governed schemas, their defaults, the required set (M3 slice 15;
// kernel lane). M3 plan §3.1 M202; D3-P01, D3-P05; T01; N04; D3 §1.1, §1.4,
// A.4, §7.1 L5; SEAM.md §§177 to 185.
//
// The engine discovers a project's checks from its governed file and its
// definitions when the project is created. Read through the protected-version
// read (SEAM.md §178): (a) every omitted governed field and member of
// runner_config.direct takes A.4's default, in A.4's unit; (b) an unknown
// key, an invalid value, a value over an engine bound and a container or
// remote key are each a discovery error with its path and code, never
// clamped; (c) discovery is the same under another host environment; (d) an
// effective version with errors makes every gate ACCEPTANCE_SCOPE_INCOMPLETE
// naming the path, and a proposal with errors cannot be approved; (e)
// required_checks absent, a list, and a listed key with no definition.
//
// Kernel lane: nothing runs a check; the program named in check_commands is
// never executed or read (discovery runs nothing, D3 §1.4).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { answer, openDecision } from './harness/decisions.mjs';
import { alphaTarget, capturedProposal, effectiveVersion, nominated, proposalsOf, reasonSubjects, stageGate } from './harness/gates.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { listTree } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { GOVERNED_FILE, KERNEL_COMMANDS, checkByKey, checkProject, codesAt, defPath, errorsAt, governedText, smoke, versionRead } from './harness/checks/fixtures.mjs';

const GOV = GOVERNED_FILE;
const minimalSmoke = (key) => smoke(key, { gates: ['stage'] });

async function versionOf(fx, project) {
  return versionRead(fx.engine, project.id, effectiveVersion(fx.home, project.id).id);
}

describe('M202 the governed schemas, their defaults, the required set', () => {
  test('(a) each governed field omitted, and each member of runner_config.direct omitted: the A.4 default, in its unit, on the version read', async (t) => {
    const fx = await scriptedEngine(t);
    for (const [label, gov] of [
      ['runner_config omitted', { check_commands: KERNEL_COMMANDS }],
      ['runner_config.direct empty', { check_commands: KERNEL_COMMANDS, runner_config: { direct: {} } }],
    ]) {
      const project = await checkProject(fx, { files: { [GOV]: governedText(gov), [defPath('s')]: minimalSmoke('s') } });
      const v = await versionOf(fx, project);
      assert.deepEqual(v.discovery_errors, [], `${label}: no discovery error`);
      assert.deepEqual(
        v.governed,
        {
          protected_paths: ['.surety/checks/'],
          check_discovery: { definitions: '.surety/checks/defs/' },
          check_commands: KERNEL_COMMANDS,
          runner_config: { direct: { read_paths: [], path: ['/usr/bin', '/bin'], env: {}, egress_allow: [], timeout_max_s: 600 } },
          result_collection: { output_max_bytes: 65536 },
          required_checks: null,
        },
        `${label}: every omitted governed field and member has A.4's default (seconds, bytes)`,
      );
      const s = checkByKey(v, 's');
      assert.ok(s, `${label}: the check is discovered`);
      assert.equal(s.required, true, `${label}: required_checks absent, every discovered check is required`);
      const d = s.definition;
      assert.deepEqual(
        { origin: d.origin, cwd: d.cwd, env: d.env, runner_class: d.runner_class, requires: d.requires, egress: d.egress, timeout_s: d.timeout_s },
        { origin: 'acceptance', cwd: '.', env: {}, runner_class: 'direct', requires: [], egress: [], timeout_s: 60 },
        `${label}: the definition's omitted fields have A.4's defaults`,
      );
      const tree = listTree(project.repo.path, project.base);
      const expected = Object.entries(tree)
        .filter(([path]) => path.startsWith('.surety/checks/') && path !== GOV)
        .map(([path, entry]) => {
          const [mode, type, oid] = entry.split(' ');
          return [path, type, mode, oid];
        })
        .sort(([a], [b]) => (a < b ? -1 : 1));
      assert.deepEqual(s.input_manifest, expected, `${label}: default inputs are every file under the roots but the governed file, as [path, type, mode, object id]`);
    }
  });

  test('(b) an unknown key, an invalid value, a value over check_timeout_max or check_output_max_bytes, a container or remote key: each a discovery error with its path and code, never clamped', async (t) => {
    const fx = await scriptedEngine(t);
    const variants = [
      { label: 'an unknown key', gov: { surprise: 1 }, path: `${GOV}#/surprise`, codes: ['unknown_field'] },
      { label: 'an invalid value', gov: { result_collection: { output_max_bytes: 'big' } }, path: `${GOV}#/result_collection/output_max_bytes`, codes: ['invalid_value'] },
      // The accepted fixtures' former form (objection 022; SEAM.md §187), pinned as now refused.
      { label: 'a check_commands entry given as an argument array', gov: { check_commands: { ...KERNEL_COMMANDS, login: ['node', '.surety/checks/login.mjs'] } }, path: `${GOV}#/check_commands/login`, codes: ['invalid_value'] },
      { label: 'timeout_max_s over check_timeout_max (1800 s)', gov: { runner_config: { direct: { timeout_max_s: 1801 } } }, path: `${GOV}#/runner_config/direct/timeout_max_s`, codes: ['invalid_value'], clamp: { get: (g) => g?.runner_config?.direct?.timeout_max_s, bound: 1800 } },
      { label: 'output_max_bytes over check_output_max_bytes (1 MiB)', gov: { result_collection: { output_max_bytes: 1048577 } }, path: `${GOV}#/result_collection/output_max_bytes`, codes: ['invalid_value'], clamp: { get: (g) => g?.result_collection?.output_max_bytes, bound: 1048576 } },
      { label: 'a container key', gov: { runner_config: { container: {} } }, path: `${GOV}#/runner_config/container`, codes: ['unknown_field', 'invalid_value'] },
      { label: 'a remote key', gov: { runner_config: { remote: {} } }, path: `${GOV}#/runner_config/remote`, codes: ['unknown_field', 'invalid_value'] },
    ];
    for (const variant of variants) {
      const project = await checkProject(fx, { files: { [GOV]: governedText({ check_commands: KERNEL_COMMANDS, ...variant.gov }), [defPath('s')]: minimalSmoke('s') } });
      const v = await versionOf(fx, project);
      const at = errorsAt(v, GOV);
      assert.equal(at.length, 1, `${variant.label}: exactly one discovery error at the governed file (${JSON.stringify(v.discovery_errors)})`);
      assert.equal(at[0].path, variant.path, `${variant.label}: the error names the member`);
      assert.ok(variant.codes.includes(at[0].code), `${variant.label}: code ${at[0].code} is one of ${variant.codes.join(', ')}`);
      if (variant.clamp) assert.notEqual(variant.clamp.get(v.governed), variant.clamp.bound, `${variant.label}: the value is not clamped to the engine's bound`);
    }
  });

  test('(c) discovery under a changed host environment is identical', async (t) => {
    const files = { [GOV]: governedText({ check_commands: KERNEL_COMMANDS }), [defPath('s')]: minimalSmoke('s'), [defPath('a')]: smoke('a', { gates: ['stage', 'alpha_authorize'], timeout: 120 }) };
    const plain = await scriptedEngine(t);
    const hostileRoot = await scriptedEngine(t, { start: false });
    const tmp = join(hostileRoot.root, 'tmpdir');
    mkdirSync(tmp);
    await hostileRoot.start({
      env: {
        PATH: `/opt/surety-decoy/bin:${process.env.PATH}`,
        LANG: 'tr_TR.UTF-8',
        TZ: 'Pacific/Kiritimati',
        TMPDIR: tmp,
        CI: 'false',
        HTTPS_PROXY: 'http://192.0.2.10:3128',
        CHECK_TIMEOUT_MAX: '5',
        SURETY_CHECK_OUTPUT_MAX_BYTES: '1024',
        TIMEOUT_MAX_S: '7',
      },
    });
    const shape = (v) => ({
      fingerprint: v.fingerprint,
      governed: v.governed,
      discovery_errors: v.discovery_errors,
      checks: v.checks.map((c) => ({ key: c.key, required: c.required, definition: c.definition, input_manifest: c.input_manifest, definition_hash: c.definition_hash })).sort((x, y) => (x.key < y.key ? -1 : 1)),
    });
    const a = shape(await versionOf(plain, await checkProject(plain, { files })));
    const b = shape(await versionOf(hostileRoot, await checkProject(hostileRoot, { files })));
    assert.equal(a.checks.length, 2, 'the fixture is live: two checks discovered');
    assert.deepEqual(b, a, 'the same tree discovers the same governed values, checks, fingerprints and errors whatever the host environment');
  });

  test('(d) an effective version with errors: every gate ACCEPTANCE_SCOPE_INCOMPLETE naming the path', async (t) => {
    const fx = await scriptedEngine(t);
    const bad = defPath('bad');
    const files = { [GOV]: governedText({ check_commands: KERNEL_COMMANDS }), [defPath('s')]: minimalSmoke('s'), [bad]: smoke('bad', { gates: ['stage'], surprise: true }) };
    const ctx = await nominated(fx, { tier: 'T1', files, requirements: [], stages: [{ number: 1, goal: 'the first stage', implements: [] }] });
    const v = await versionOf(fx, ctx.project);
    assert.deepEqual(codesAt(v, bad), ['unknown_field'], `the fixture is live: the effective version has the error at ${bad} (${JSON.stringify(v.discovery_errors)})`);
    const errorPath = errorsAt(v, bad)[0].path;
    const stage = await stageGate(fx, ctx);
    const alpha = await (await alphaTarget(fx, ctx)).evaluate();
    for (const [what, e] of [['stage', stage], ['alpha_authorize', alpha]]) {
      assert.equal(e.outcome, 'not_satisfied', `${what}: not satisfied`);
      assert.ok(reasonSubjects(e, 'ACCEPTANCE_SCOPE_INCOMPLETE').includes(errorPath), `${what}: ACCEPTANCE_SCOPE_INCOMPLETE names ${errorPath} (reasons: ${JSON.stringify(e.reasons)})`);
    }
  });

  test('(d) a proposal with errors cannot be approved: approve carries CHECK_DEFINITION_INVALID and is refused; nothing is applied', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await checkProject(fx, { files: { [GOV]: governedText({ check_commands: KERNEL_COMMANDS }), [defPath('s')]: minimalSmoke('s') } });
    const before = effectiveVersion(fx.home, project.id);
    const proposal = await capturedProposal(fx, project, { changeKind: 'unclassifiable', steps: [step.write(defPath('worse'), '{"schema": 1, "key": "worse", ')] });
    const decision = await openDecision(fx, project.id, 'check_correction_unclassifiable', proposal.id);
    const approve = decision.options.find((o) => o.key === 'approve');
    assert.ok(approve?.blockers?.includes('CHECK_DEFINITION_INVALID'), `approve carries CHECK_DEFINITION_INVALID while the proposal's discovery has errors (L5) (options: ${JSON.stringify(decision.options)})`);
    assertRefused(await answer(fx.engine, project.id, decision, 'approve'), 409, 'illegal_transition', 'approving a proposal whose discovery has errors');
    assert.equal(effectiveVersion(fx.home, project.id).id, before.id, 'the effective version is unchanged');
    const row = proposalsOf(fx.home, project.id).find((p) => p.id === proposal.id);
    assert.ok(row.status !== 'applied' && row.resulting_version === null, `the proposal is not applied (${row.status})`);
  });

  test('(e) required_checks absent requires every check; a list requires exactly its keys; a listed key with no definition is required_key_without_definition', async (t) => {
    const fx = await scriptedEngine(t);
    const defs = { [defPath('a')]: minimalSmoke('a'), [defPath('b')]: minimalSmoke('b') };
    const make = (gov) => checkProject(fx, { files: { [GOV]: governedText({ check_commands: KERNEL_COMMANDS, ...gov }), ...defs } });
    const required = (v) => Object.fromEntries(v.checks.map((c) => [c.key, c.required]));

    const absent = await versionOf(fx, await make({}));
    assert.deepEqual(required(absent), { a: true, b: true }, 'absent: every discovered check is required');

    const listed = await versionOf(fx, await make({ required_checks: ['a'] }));
    assert.deepEqual([listed.discovery_errors, required(listed)], [[], { a: true, b: false }], 'a list: exactly its keys are required');

    const ghost = await versionOf(fx, await make({ required_checks: ['a', 'ghost'] }));
    const at = errorsAt(ghost, GOV).map((e) => ({ path: e.path, code: e.code }));
    assert.deepEqual(at, [{ path: `${GOV}#/required_checks/1`, code: 'required_key_without_definition' }], `a listed key with no definition is an error naming it (${JSON.stringify(ghost.discovery_errors)})`);
  });
});
