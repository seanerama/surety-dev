// M07, a valid project policy change and the effective policy; and project
// creation through the public API, which is where a project's policy starts
// (slice 3). Plan §3.1 M07 ("effective settings/defaults are inspectable and
// used by later tests"); D1 §§3.1, 7.8, 11.4; E2; E23 item 3; SEAM.md §§2,
// 27, 28.
//
// Slice 1 pinned the refusals of the closed project schema. A valid change
// that widens nothing is now committed by the engine, as .surety/policy.json
// on the integration branch, through the journal, and recorded as a policy
// revision; it takes effect and is used. The effective policy is the
// revision the engine recorded; with none, the schema defaults with no
// revision. A policy file that is in the repository and that the engine
// never recorded is not effective and never becomes so.
//
// A project is created by POST /v1/projects: a journaled bootstrap commit of
// .surety/project.json, after which it is registered.
//
// Which changes widen authority, and the confirmation they need, is row M49
// (slice 5); these cases only lower limits.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CONTRACT, assertRefused } from './harness/fixtures.mjs';
import { PERMITTED_EDIT, addGitProject, addItem, permittedEdit, roleThat, roleThatHolds, runToEnd, runToHold } from './harness/gitruns.mjs';
import { acceptanceState, assertCommitted, assertNothingAccepted, assertOrdinaryCourse, changePolicy, createProject, eventsOfType, getPolicy, operationsOf, outOfBand, policyRevisions, registryOf } from './harness/journal.mjs';
import { changedPaths, checkoutState, fileAt, gitQuiet, makeProjectRepo, parentsOf, refOid, repoFingerprint } from './harness/repos.mjs';
import { countOf, getRow, runsOf, scriptedEngine, tick, tickUntil, waitForRun, workItem } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';

const MAIN = 'refs/heads/main';
const DEFAULTS = Object.fromEntries(Object.entries(CONTRACT.project).filter(([key]) => !key.startsWith('$')).map(([key, spec]) => [key, spec.default]));
const blobAt = (repo, rev, path) => gitQuiet(repo, ['rev-parse', `${rev}:${path}`]);

describe('M07 a project is created through the API by a journaled bootstrap commit', () => {
  test('POST /v1/projects commits .surety/project.json to the integration branch, registers the branch, and the project becomes registered', async (t) => {
    const fx = await scriptedEngine(t);
    const repo = makeProjectRepo(join(fx.root, 'repo-new'), { primary: 'other', files: { 'src/lib.js': 'export {};\n' } });
    const before = { fingerprint: repoFingerprint(repo.path), checkout: checkoutState(repo.path) };
    const { id, res } = await createProject(fx.engine, { repoPath: repo.path, name: 'created-through-the-api', tier: 'T2' });
    assert.ok(res.headers['x-surety-request-id'], 'the command is attributable');

    const row = getRow(fx.home, 'projects', id);
    assert.deepEqual([row.registration_state, row.name, row.tier, row.integration_branch, row.paused], ['registered', 'created-through-the-api', 'T2', 'main', 0]);
    const [created] = eventsOfType(fx.home, 'project.created');
    const [registered] = eventsOfType(fx.home, 'project.registered');
    assert.equal(created.subject.project, id);
    assert.ok(!created.payload.test_fixture, 'a project created through the API is not labelled as a test fixture');
    assert.ok(registered && registered.subject.project === id && registered.seq > created.seq, 'project.registered follows project.created');

    // The bootstrap commit: one parent, one added path, the identity file.
    const tip = refOid(repo.path, MAIN);
    assert.deepEqual(parentsOf(repo.path, tip), [repo.head], 'the bootstrap commit was made on the commit the branch pointed at');
    assert.deepEqual(changedPaths(repo.path, repo.head, tip), { '.surety/project.json': 'A' }, 'and adds exactly the identity file');
    assert.equal(JSON.parse(fileAt(repo.path, tip, '.surety/project.json')).id, id, 'which names the project');

    // Through the journal, each operation in its ordinary course.
    const commits = operationsOf(fx.home, { project: id, journalKind: 'commit_tree' });
    const moves = operationsOf(fx.home, { project: id, journalKind: 'ref_update' });
    assert.deepEqual([commits.length, moves.length], [1, 1], 'one commit and one ref update were journaled');
    assertOrdinaryCourse(commits[0], 'the bootstrap commit');
    assertOrdinaryCourse(moves[0], 'the bootstrap ref update');
    assert.deepEqual({ ref: moves[0].events[0].payload.ref, old_oid: moves[0].events[0].payload.old_oid, new_oid: moves[0].events[0].payload.new_oid }, { ref: MAIN, old_oid: repo.head, new_oid: tip });
    assert.deepEqual(registryOf(fx.home, id)[MAIN], { kind: 'integration', expected_oid: tip, immutable: 0 }, 'the integration branch is registered at the bootstrap commit');

    // Nothing else in the repository moved, and integrity finds nothing.
    const after = repoFingerprint(repo.path);
    const developerRefs = (refs) => Object.fromEntries(Object.entries(refs).filter(([ref]) => ref !== MAIN && !ref.startsWith('refs/surety/')));
    assert.deepEqual(developerRefs(after.refs), developerRefs(before.fingerprint.refs), 'no developer ref moved');
    assert.equal(after.config, before.fingerprint.config, "the repository's configuration is untouched");
    assert.deepEqual(checkoutState(repo.path), before.checkout, "the developer's checkout is untouched");
    for (let i = 0; i < 2; i++) await tick(fx.engine, id);
    assert.deepEqual(outOfBand(fx.home, id), [], 'the bootstrap was the engine\'s own move');

    // And work is dispatched for it.
    const item = await addItem(fx, id, 'fix');
    fx.scripted.script(item, [roleThat([permittedEdit()])]);
    const run = await runToEnd(fx, id, item);
    assertCommitted(fx, run.id, { kind: 'engine_commit', parent: tip, integrated: true, changes: { [PERMITTED_EDIT.path]: 'A' } });
  });

  test('a request the schema refuses, a path that is no repository and a branch that does not exist create nothing', async (t) => {
    const fx = await scriptedEngine(t);
    const repo = makeProjectRepo(join(fx.root, 'repo-untouched'));
    const before = repoFingerprint(repo.path);
    const good = { name: 'p', tier: 'T2', dev_repo_path: repo.path, integration_branch: 'main' };
    const CASES = [
      ['an unknown key', { ...good, surprise: true }, 400, 'unknown_field', null],
      ['a tier that is none of T1, T2, T3', { ...good, tier: 'T9' }, 400, 'invalid_value', 'tier'],
      ['a branch that does not exist', { ...good, integration_branch: 'no-such-branch' }, 400, 'invalid_value', 'integration_branch'],
      ['a path that is not a git repository', { ...good, dev_repo_path: join(fx.root, 'not-a-repository') }, 409, 'repo_unreadable', null],
    ];
    for (const [what, body, status, code, field] of CASES) {
      const res = await fx.engine.post('/v1/projects', body);
      assertRefused(res, status, code, what);
      if (field) assert.equal(res.body.subject?.field, field, `${what}: the refusal names the field`);
      assert.equal(countOf(fx.home, 'projects'), 0, `${what}: no project was created`);
      assert.deepEqual(repoFingerprint(repo.path), before, `${what}: the repository is untouched`);
    }
  });
});

describe('M07 the effective policy is the revision the engine recorded', () => {
  test('a policy file that was in the repository before the project existed is not effective, is left as it is, and never becomes effective through a later change', async (t) => {
    const fx = await scriptedEngine(t);
    const unrecorded = { repair_attempts_max: 7, no_progress_max: 5, deadline_builder: 300 };
    const project = await addGitProject(fx, { via: 'api', files: { '.surety/policy.json': `${JSON.stringify(unrecorded)}\n` } });
    const repo = project.repo.path;

    const policy = await getPolicy(fx.engine, project.id);
    assert.equal(policy.revision, null, 'no revision is recorded');
    assert.deepEqual(policy.effective, DEFAULTS, 'the effective policy is the schema defaults, whatever the file in the repository says');
    assert.equal(getRow(fx.home, 'projects', project.id).policy_revision, null);
    assert.deepEqual(policyRevisions(fx.home, project.id), []);
    assert.equal(blobAt(repo, project.base, '.surety/policy.json'), blobAt(repo, project.repo.head, '.surety/policy.json'), 'bootstrap left the file exactly as it was');

    // The first recorded change is written from what the engine has recorded, not from that file.
    const changed = await changePolicy(fx.engine, project.id, { repair_attempts_max: 1 });
    assert.equal(changed.revision, 1);
    assert.deepEqual(changed.effective, { ...DEFAULTS, repair_attempts_max: 1 }, 'the change took effect, and nothing of the unrecorded file came with it');
    const tip = refOid(repo, MAIN);
    const committed = JSON.parse(fileAt(repo, tip, '.surety/policy.json'));
    for (const [key, value] of Object.entries(committed)) {
      assert.ok(key in DEFAULTS, `the committed file holds only keys of the closed schema (${key})`);
      assert.deepEqual(value, changed.effective[key], `the committed file's ${key} is the effective value`);
    }
    assert.equal(committed.repair_attempts_max, 1);
  });
});

describe('M07 a valid project policy change', () => {
  test('is committed through the journal, recorded as a revision, and reported as effective; a second change is the next revision', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const repo = project.repo.path;
    const initial = await getPolicy(fx.engine, project.id);
    assert.equal(initial.revision, null, 'a project with no recorded policy has no revision');
    assert.deepEqual(initial.effective, DEFAULTS, 'and the schema defaults are in effect');

    const first = await changePolicy(fx.engine, project.id, { repair_attempts_max: 1, deadline_reviewer: 600 });
    assert.deepEqual([first.revision, first.effective.repair_attempts_max, first.effective.deadline_reviewer], [1, 1, 600]);
    assert.deepEqual(first.effective, { ...DEFAULTS, repair_attempts_max: 1, deadline_reviewer: 600 }, 'every other key keeps its default');

    const tip = refOid(repo, MAIN);
    assert.deepEqual(parentsOf(repo, tip), [project.base]);
    assert.deepEqual(changedPaths(repo, project.base, tip), { '.surety/policy.json': 'A' }, 'the commit adds the policy file and nothing else');
    const [revision, ...more] = policyRevisions(fx.home, project.id);
    assert.deepEqual(more, []);
    assert.deepEqual(
      { revision: revision.revision, git_path: revision.git_path, git_blob: revision.git_blob, committed: revision.committed, widens_authority: revision.widens_authority },
      { revision: 1, git_path: '.surety/policy.json', git_blob: blobAt(repo, tip, '.surety/policy.json'), committed: 1, widens_authority: 0 },
      'the revision points at the committed file',
    );
    assert.equal(getRow(fx.home, 'projects', project.id).policy_revision, revision.id);
    assert.equal(eventsOfType(fx.home, 'policy.changed').length, 1);
    const commits = operationsOf(fx.home, { project: project.id, journalKind: 'commit_tree' });
    const moves = operationsOf(fx.home, { project: project.id, journalKind: 'ref_update' });
    assert.deepEqual([commits.length, moves.length], [1, 1]);
    assertOrdinaryCourse(commits[0], 'the policy commit');
    assertOrdinaryCourse(moves[0], 'the policy ref update');
    assert.equal(registryOf(fx.home, project.id)[MAIN].expected_oid, tip);

    const second = await changePolicy(fx.engine, project.id, { no_progress_max: 1 });
    assert.deepEqual([second.revision, second.effective.no_progress_max, second.effective.repair_attempts_max], [2, 1, 1], 'the second change is revision 2 and keeps the first');
    assert.deepEqual(changedPaths(repo, tip, refOid(repo, MAIN)), { '.surety/policy.json': 'M' });
    assert.deepEqual(policyRevisions(fx.home, project.id).map((r) => r.revision), [1, 2]);

    for (let i = 0; i < 2; i++) await tick(fx.engine, project.id);
    assert.deepEqual(outOfBand(fx.home, project.id), [], "the policy commits were the engine's own");
    // A refused change still changes nothing (slice 1), now with a revision in place.
    assertRefused(await fx.engine.post(`/v1/projects/${project.id}/policy`, { repair_attempts_max: 2, bogus: 1 }), 400, 'unknown_field', 'a mixed submission');
    assert.equal((await getPolicy(fx.engine, project.id)).revision, 2);
  });

  test('takes effect: the repair limit, a role deadline and a snapshot cap are the changed ones', async (t) => {
    const fx = await scriptedEngine(t);
    const project = await addGitProject(fx);
    const cap = CONTRACT.project.snapshot_max_file_bytes.min;
    await changePolicy(fx.engine, project.id, { repair_attempts_max: 1, deadline_reviewer: 600, snapshot_max_file_bytes: cap });
    const base = refOid(project.repo.path, MAIN);

    // The repair limit: work whose every run fails is launched once plus one repair.
    const failing = await addItem(fx, project.id, 'verification');
    fx.scripted.script(failing, [script.crash(3), script.crash(3), script.crash(3)]);
    await tickUntil(fx.engine, project.id, () => workItem(fx.home, failing).status === 'parked', { max: 8, what: 'the failing work to park' });
    assert.equal(runsOf(fx.home, failing).length, 2, 'launched once plus repair_attempts_max (1) times');
    assert.equal(JSON.parse(workItem(fx.home, failing).blocker).reason, 'repair_attempts_max');

    // A reviewer's deadline is the changed setting.
    const review = await addItem(fx, project.id, 'review');
    fx.scripted.script(review, [script.complete()]);
    const reviewRun = await runToEnd(fx, project.id, review);
    const span = (Date.parse(reviewRun.deadline_at) - Date.parse(reviewRun.created_at)) / 1000;
    assert.ok(Math.abs(span - 600) <= 5, `a review run's deadline is 600 s after its creation (observed ${span} s)`);

    // The snapshot cap: a file exactly at it is committed, a file one byte over it is rejected.
    const at = await addItem(fx, project.id, 'fix');
    fx.scripted.script(at, [roleThat([step.writeFill('at-the-cap.bin', cap)])]);
    const atRun = await runToEnd(fx, project.id, at);
    const committed = assertCommitted(fx, atRun.id, { kind: 'engine_commit', parent: base, integrated: true, changes: { 'at-the-cap.bin': 'A' } });

    const over = await addItem(fx, project.id, 'fix');
    fx.scripted.script(over, [roleThatHolds([step.writeFill('over-the-cap.bin', cap + 1)]), script.hold('never')]);
    const { run: overRun } = await runToHold(fx, project.id, over);
    const before = acceptanceState(fx, project.id);
    fx.scripted.release(over);
    await waitForRun(fx.home, over, { state: 'ended' });
    assertNothingAccepted(fx, overRun.id, before, { reason: 'diff_violation' });
    assert.equal(refOid(project.repo.path, MAIN), committed.sha, 'the branch is where the accepted commit left it');
  });
});
