// M214, the check tree and bounded preparation (M3 slice 17, the protected
// inputs; sandbox lane). M3 plan §3.3 M214; D3-R01, D3-R25; Astra's T17;
// D3 §2.4, A.7; D2 §3.7; SEAM.md §§195, 200, 202.
//
// (a) with (e): two projects with the same relative paths, one of them with
// hooks, a filter driver and a remote planted. While each check runs, the
// check tree is read from the host: no `.git`, the governed file's bytes in
// no file, the candidate's source there; nothing planted ran; and each check
// read its own project's bytes, never the other's.
// (b) Two executions of one (project, revision, version) run at once: one
// tree, its files read-only, shared; once the candidate is superseded and
// nothing runs on it, the tree is gone.
// (c) with (d): each bound low. More entries than `checktree_max_entries`
// (zero-byte files), more bytes than `checktree_max_bytes` (both at the
// configured minimum), and a git that does not answer: each
// `materialization_failed`, and nothing of the refused tree is left.
// (f) While the materialization waits on that git, the API answers and a
// cancellation (a Stop of another project's run) is answered, each within
// two seconds (D2 §3.7).
// The bound for all trees, `checktrees_max_bytes`, is set below its
// configured range by the harness flag of SEAM.md §200: a second project's
// tree that would take the trees past it is `materialization_failed` while
// the first project's tree is in use.
// (d)'s "large definition traversal" is discovery's cap, M203 (b)'s 513
// definitions (D3 §1.4).
//
// SAFETY: the check program (harness/checks/program.mjs) only reads its
// workspace, holds at a release file, writes its output and exits 0. The
// planted hooks and filter programs only append to the test's own evidence
// file. The held git is the test's own repository's (holdGit), let go
// before the case ends. No storage is filled: the largest file is 64 MiB of
// zeros (git stores it compressed; the bound refuses the tree before it is
// written), and the trees of the all-trees case hold 60 KiB each.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';

import { releaseBarrier, sha256Hex } from './harness/engine.mjs';
import { reachBarrier } from './harness/decisions.mjs';
import { addGitProject, addItem, roleThat, waitForCandidates } from './harness/gitruns.mjs';
import { armBarrier, changePolicy } from './harness/journal.mjs';
import { evidenceProgram, gitQuiet, holdGit, plantAllHooks, plantFilter, readEvidence } from './harness/repos.mjs';
import { runsOf, tickUntil } from './harness/runs.mjs';
import { roleHolding, sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { askingForTicks } from './harness/gates.mjs';
import {
  GOVERNED_FILE,
  buildStage,
  checkProject,
  checktreeEntries,
  checktreeFiles,
  defPath,
  filesHolding,
  heldExecution,
  holdArgs,
  installCheckProgram,
  outputText,
  programReport,
  qualifyRunnerByFixture,
  release,
  resultRow,
  sandboxGoverned,
  smoke,
  terminalExecution,
  waitRecorded,
} from './harness/checks/fixtures.mjs';

const INPUT = '.surety/checks/expect.txt';
const DATA = 'src/data.txt';
// Two sandbox domains at once fit this host's memory admission only at the
// contract's smallest domain_memory_max (SEAM.md §168).
const TWO_DOMAINS = Object.freeze({ domain_memory_max: 536870912 });
const MiB = 1024 * 1024;

const readerOf = (key, prog, { hold = true } = {}) =>
  smoke(key, { command: ['probe', '--report', '--digest', DATA, '--digest', INPUT, ...(hold ? holdArgs(prog, key) : []), 'exit', '0'], inputs: [INPUT], gates: ['stage'], timeout: 300 });

function assertNotRunMaterialization(fx, x, what) {
  assert.equal(x.status, 'recorded', `${what}: the execution is recorded (status ${x.status})`);
  const result = resultRow(fx.home, x.result);
  assert.deepEqual([result?.execution_established, result?.not_run_reason], [0, 'materialization_failed'], `${what}: materialization_failed, not established (${JSON.stringify(result)})`);
}

describe('M214 the check tree and bounded preparation', () => {
  test('(a), (e) the tree has no .git and no governed file, holds the source, and nothing planted ran; two projects with the same relative paths each read their own', async (t) => {
    const fx = await sandboxEngine(t);
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const evidence = join(fx.root, 'evidence.log');
    const plant = (repo) => {
      plantAllHooks(repo.path, evidence);
      plantFilter(repo.path, repo.ref, evidence, { dir: join(fx.root, 'planted'), pattern: '*.txt' });
      gitQuiet(repo.path, ['config', 'remote.origin.url', `ext::${evidenceProgram(join(fx.root, 'planted', 'remote'), evidence, 'remote')} %S`]);
      gitQuiet(repo.path, ['config', 'protocol.ext.allow', 'always']);
      gitQuiet(repo.path, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    };
    const projects = {};
    for (const label of ['first', 'second']) {
      const governed = sandboxGoverned(prog);
      const files = { [GOVERNED_FILE]: governed, [DATA]: `${label} project's data\n`, [INPUT]: `${label} project's expectation\n`, [defPath('reads')]: readerOf('reads', prog) };
      const project = await checkProject(fx, { files, plant: label === 'first' ? plant : undefined });
      const { candidate } = await buildStage(fx, project);
      const held = await heldExecution(fx, project.id, candidate.id, { reads: 'reads' });
      const entries = checktreeEntries(fx.home);
      const treeFiles = checktreeFiles(fx.home);
      release(prog, 'reads');
      const { reads } = await waitRecorded(fx, project.id, candidate.id, ['reads']);
      // The next project's check holds at the same name.
      rmSync(join(prog.releaseDir, 'reads'));
      projects[label] = { project, candidate, held, entries, treeFiles, governed, files, result: resultRow(fx.home, reads.result) };
    }
    for (const [label, p] of Object.entries(projects)) {
      assert.deepEqual(p.entries.filter((e) => e.name === '.git').map((e) => e.path), [], `${label}: host-read while its check ran, nothing named .git under checktrees/`);
      assert.deepEqual(filesHolding(p.treeFiles, p.governed).map((f) => f.path), [], `${label}: host-read, no file under checktrees/ holds the governed file's bytes`);
      assert.ok(filesHolding(p.treeFiles, p.files[DATA]).length > 0, `${label}: host-read, the check tree holds the candidate's source`);
      assert.deepEqual([p.result.execution_established, p.result.exit_status], [1, 0], `${label}: the check ran`);
      const report = programReport(outputText(fx.home, p.result));
      assert.equal(report.git_present, false, `${label}: the check saw no .git`);
      assert.deepEqual([report.digests[DATA], report.digests[INPUT]], [sha256Hex(p.files[DATA]), sha256Hex(p.files[INPUT])], `(e) ${label}: the check read its own project's source and input, never the other project's at the same paths`);
    }
    assert.equal(readEvidence(evidence), null, '(a) no hook, filter driver or remote transport planted in the repository ran');
  });

  test('(b) two executions of one triple at once share one read-only tree; once the candidate is superseded and nothing runs on it, the tree is gone', async (t) => {
    const fx = await sandboxEngine(t, { config: TWO_DOMAINS });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const DATA_1 = 'the first candidate\'s unique source\n';
    const files = { [GOVERNED_FILE]: sandboxGoverned(prog), [DATA]: DATA_1, [INPUT]: 'the shared expectation, unique too\n', [defPath('one')]: readerOf('one', prog), [defPath('two')]: readerOf('two', prog) };
    const project = await checkProject(fx, { files });
    await changePolicy(fx.engine, project.id, { max_concurrent_checks: 2 });
    const { candidate } = await buildStage(fx, project);

    const first = await heldExecution(fx, project.id, candidate.id, { one: 'one', two: 'two' });
    const other = first.key === 'one' ? 'two' : 'one';
    const second = await heldExecution(fx, project.id, candidate.id, { [other]: other });
    const treeFiles = checktreeFiles(fx.home);
    release(prog, 'one');
    release(prog, 'two');
    const holding = filesHolding(treeFiles, DATA_1);
    assert.equal(holding.length, 1, `host-read with both executions running: one tree holds the candidate's source, once (${holding.map((f) => f.path).join(', ')})`);
    assert.equal(holding[0].mode & 0o222, 0, `its files are read-only (mode ${holding[0].mode.toString(8)})`);
    const inputs = filesHolding(treeFiles, files[INPUT]);
    assert.equal(inputs.length, 1, 'and holds the protected input once, for both executions');
    assert.equal(inputs[0].mode & 0o222, 0, 'read-only too');
    assert.notEqual(first.execution.id, second.execution.id);
    await waitRecorded(fx, project.id, candidate.id, ['one', 'two']);

    // A successor whose source differs supersedes the candidate.
    const fix = await addItem(fx, project.id, 'fix');
    fx.scripted.script(fix, [roleThat([step.write(DATA, 'the second candidate\'s source\n')], { nominate: true })]);
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, fix)[0]?.state === 'ended', { what: 'the fix to be built' });
    await waitForCandidates(fx, project.id, 2);
    await askingForTicks(fx, project.id, () => filesHolding(checktreeFiles(fx.home), DATA_1).length === 0, "the superseded candidate's tree to be removed once nothing runs on it");
  });

  test("(c), (d), (f) entries, bytes per tree and a git that does not answer: materialization_failed, nothing of the tree left; while it waits, the API and a Stop are answered", async (t) => {
    const fx = await sandboxEngine(t, { config: { ...TWO_DOMAINS, checktree_max_entries: 1000, checktree_max_bytes: 64 * MiB, check_infra_retries_max: 0, git_deadline: 10 } });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const base = (marker) => ({ [GOVERNED_FILE]: sandboxGoverned(prog), [INPUT]: `${marker}\n`, [defPath('reads')]: readerOf('reads', prog, { hold: false }) });

    // (c), (d) entries: 1001 zero-byte files, the first tree of this engine.
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`bulk/e${String(i).padStart(4, '0')}`, '']));
    const entries = await checkProject(fx, { files: { ...base('the entries project'), ...many } });
    const e = await buildStage(fx, entries);
    assertNotRunMaterialization(fx, await terminalExecution(fx, entries.id, e.candidate.id, 'reads'), 'more entries than checktree_max_entries');
    assert.deepEqual(checktreeFiles(fx.home).map((f) => f.path), [], 'host-read: no file of the refused tree is left, or visible, under checktrees/');

    // (c) bytes per tree: one file a byte over 64 MiB.
    const big = await checkProject(fx, { files: { ...base('the bytes project'), 'bin/big.bin': Buffer.alloc(64 * MiB + 1) } });
    const b = await buildStage(fx, big);
    assertNotRunMaterialization(fx, await terminalExecution(fx, big.id, b.candidate.id, 'reads'), 'more bytes than checktree_max_bytes');
    assert.deepEqual(filesHolding(checktreeFiles(fx.home), 'the bytes project\n').map((f) => f.path), [], 'host-read: nothing of the refused tree is left');
    assert.deepEqual(checktreeFiles(fx.home).filter((f) => f.size > MiB).map((f) => f.path), [], 'and nothing large was written');

    // (f)'s other project: a role run held in its domain, to be stopped.
    const other = await addGitProject(fx, { tier: 'T1' });
    const otherItem = await addItem(fx, other.id, 'fix');
    const role = await roleHolding(fx, other.id, otherItem);

    // (c) a git that does not answer, reached at the materialization.
    const stalled = await checkProject(fx, { files: base('the stalled project') });
    await armBarrier(fx.engine, 'checks.before_materialize', 'pause');
    const s = await buildStage(fx, stalled);
    await reachBarrier(fx, stalled.id, 'checks.before_materialize');
    const letGo = holdGit(stalled.repo.path);
    fx.beforeCleanup.push(letGo);
    await releaseBarrier(fx.engine, 'checks.before_materialize');

    // (f) While it waits: the API, and a Stop of the other project's run.
    const timed = async (fn) => {
      const t0 = performance.now();
      const res = await fn();
      return { res, ms: performance.now() - t0 };
    };
    const info = await timed(() => fx.engine.get('/v1/engine'));
    assert.equal(info.res.status, 200);
    assert.ok(info.ms < 2000, `(f) the API answers while the materialization waits on git (${Math.round(info.ms)} ms)`);
    const path = `/v1/projects/${other.id}/runs/${role.run.id}/stop`;
    const ask = await timed(() => fx.engine.post(path, {}));
    assert.deepEqual([ask.res.status, ask.res.body?.code], [409, 'confirm_required'], `the Stop asks for its confirmation (body: ${ask.res.text})`);
    const confirm = await timed(() => fx.engine.post(path, { preview_hash: ask.res.body.subject.preview_hash }));
    assert.equal(confirm.res.status, 200, `(f) the Stop is answered while the materialization waits (body: ${confirm.res.text})`);
    assert.ok(ask.ms < 2000 && confirm.ms < 2000, `(f) each within two seconds (${Math.round(ask.ms)} ms, ${Math.round(confirm.ms)} ms)`);
    const stalledX = await terminalExecution(fx, stalled.id, s.candidate.id, 'reads', "the stalled materialization to end at git's deadline");
    letGo();
    fx.beforeCleanup.pop();
    assertNotRunMaterialization(fx, stalledX, 'a git that does not answer');
    assert.deepEqual(filesHolding(checktreeFiles(fx.home), 'the stalled project\n').map((f) => f.path), [], 'host-read: nothing of the refused tree is left');
  });

  test('checktrees_max_bytes: a second tree that would take the trees in use past the bound is materialization_failed; the first is unaffected', async (t) => {
    const fx = await sandboxEngine(t, { config: { ...TWO_DOMAINS, check_infra_retries_max: 0 }, start: false });
    await fx.start({ args: ['--harness-checktrees-max-bytes', String(100 * 1024)] });
    const prog = installCheckProgram(fx.root);
    await qualifyRunnerByFixture(fx.engine);
    const payload = (label) => Buffer.alloc(60 * 1024, label);
    const make = (label) => ({ [GOVERNED_FILE]: sandboxGoverned(prog), [INPUT]: `${label}\n`, 'bin/payload.bin': payload(label), [defPath('reads')]: readerOf('reads', prog) });
    const first = await checkProject(fx, { files: make('first') });
    const f = await buildStage(fx, first);
    await heldExecution(fx, first.id, f.candidate.id, { reads: 'reads' });
    assert.equal(filesHolding(checktreeFiles(fx.home), payload('first')).length, 1, "the fixture is live: the first project's tree, 60 KiB, is built and in use");

    const second = await checkProject(fx, { files: make('second') });
    const s = await buildStage(fx, second);
    assertNotRunMaterialization(fx, await terminalExecution(fx, second.id, s.candidate.id, 'reads'), 'a tree past checktrees_max_bytes with the trees in use');
    assert.deepEqual(filesHolding(checktreeFiles(fx.home), payload('second')).map((x) => x.path), [], 'host-read: nothing of the refused tree is left');

    release(prog, 'reads');
    const { reads } = await waitRecorded(fx, first.id, f.candidate.id, ['reads']);
    assert.deepEqual([resultRow(fx.home, reads.result).execution_established, resultRow(fx.home, reads.result).exit_status], [1, 0], 'the first check ran to its end');
  });
});
