// M409, adoption's records and signals; the immutable source revision
// (slice 32; kernel lane). M5 plan §3.2 M409; D6-R01; D6 §8.1 step 1, A.3,
// A.6, A.7; E6, E18; B11; E140 N4; Sean, 2026-10-12 (a repository that
// already carries Surety records is refused); SEAM.md §§376 to 378.
//   (a) a repository with an unpushed commit on the branch: `pinned_revision`
//       the local head A, recorded before the bootstrap commit, the branch
//       the integration branch, the bootstrap journaled on top of A,
//       `.surety/idea.md` written (given, or the adopted placeholder),
//       `project.adopted`, baseline `idea`, `adoption_mode` raised;
//   (b) the branch moved between the engine's observation and the bootstrap
//       (the `adoption.observed` barrier †): `adoption_branch_moved`,
//       nothing pinned, no bootstrap;
//   (c) the signals and the recommendation at `adoption_full_max_files`
//       2,000 (one repository under, one over) and at an override of 100; an
//       unreadable signal (the `adoption_signal` fault †) is `unknown`, never
//       zero, empty or none;
//   (d) the environment the CI file names, `unknown` by name with no adapter
//       configuration; the tag a `releases` row `external_unverified` with no
//       artifact and no candidate progress;
//   (e) that environment never read and never deployed to: no adapter call,
//       no observation, its record still `unknown` after ticks;
//   (f) A cannot be updated afterwards: adopting the same repository under
//       the same name again, and the policy route with an adoption key, are
//       refused, and A is unchanged;
//   (g) Sean, 2026-10-12: a repository with `.surety/` or a `refs/surety/*`
//       ref is refused, naming what was found, and nothing is created.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { armFault, releaseBarrier, waitFor } from './harness/engine.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { armBarrier, eventsOfType } from './harness/journal.mjs';
import { environmentsOf, projectRow } from './harness/journey/drive.mjs';
import { commitOnRef, fileAt, parentsOf } from './harness/repos.mjs';
import { scriptedEngine, tick } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { adoptProject, adoptedRepo, adoptionModeRows, adoptionOf, postAdopt, projectsNamed, releasesOf, retrofitEngine } from './harness/retrofit/drive.mjs';
import { ADOPTED_NAME, CI_ENVIRONMENT, EXPECTED_SIGNALS, RELEASE_TAG, bulkFiles, countsAt, refOid } from './harness/retrofit/repo.mjs';

const barrierWaiting = async (fx, name) => {
  const res = await fx.engine.get('/v1/harness/barriers');
  return res.status === 200 && res.body?.barriers?.some((b) => b.name === name && b.state === 'waiting');
};
const isUnknown = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'unknown' in v;

describe('M409 adoption: the records, the signals and the immutable source revision', () => {
  test('(a) an unpushed head is pinned as A before the bootstrap commit, which is journaled on top of it; the placeholder idea; project.adopted; baseline idea; adoption_mode raised', async (t) => {
    const fx = await retrofitEngine(t);
    const repo = adoptedRepo(fx);
    const A = refOid(repo.path, repo.ref);
    assert.notEqual(A, repo.pushed, 'the fixture is live: the branch head is an unpushed commit');
    // Held where the bootstrap's commit is intended (SEAM.md §33): A must already be recorded.
    await armBarrier(fx.engine, 'journal.commit_tree.intent_committed', 'pause');
    const pending = postAdopt(fx, { repo });
    await waitFor(() => barrierWaiting(fx, 'journal.commit_tree.intent_committed'), { what: 'the bootstrap commit to be intended' });
    const [held] = projectsNamed(fx.home, ADOPTED_NAME);
    assert.ok(held, 'the project row exists while its bootstrap is intended');
    assert.equal(adoptionOf(fx.home, held.id)?.pinned_revision, A, `pinned_revision is A before the bootstrap commit is made (${JSON.stringify(adoptionOf(fx.home, held.id))})`);
    assert.equal(refOid(repo.path, repo.ref), A, 'and the branch is still at A');
    await releaseBarrier(fx.engine, 'journal.commit_tree.intent_committed');
    const res = await pending;
    assert.equal(res.status, 201, `POST /v1/projects/adopt (→ ${res.status} ${res.text})`);
    const id = res.body.project.id;
    await waitFor(() => projectRow(fx.home, id)?.registration_state === 'registered', { what: 'the adopted project to be registered' });
    const row = projectRow(fx.home, id);
    assert.deepEqual([row.integration_branch, row.baseline_state], [repo.branch, 'idea'], 'the branch is the integration branch; baseline idea');
    const head = refOid(repo.path, repo.ref);
    assert.deepEqual(parentsOf(repo.path, head), [A], 'the bootstrap commit sits on A');
    assert.match(fileAt(repo.path, head, '.surety/project.json'), new RegExp(id), '.surety/project.json names the project');
    assert.match(fileAt(repo.path, head, '.surety/idea.md'), /adopted/i, 'no idea given: the idea record says the project is adopted and its intent is pending');
    assert.equal(adoptionOf(fx.home, id).pinned_revision, A, 'A stays pinned after the bootstrap');
    assert.equal(eventsOfType(fx.home, 'project.adopted').filter((e) => e.subject?.project === id).length, 1, 'project.adopted once');
    const modes = adoptionModeRows(fx.home, id);
    assert.deepEqual(modes.map((d) => [d.status, d.subject_type]), [['open', 'project']], 'adoption_mode raised, about the project');
    assert.deepEqual(modes[0].options.map((o) => o.key).sort(), ['full', 'scoped'], 'the owner chooses full or scoped');
  });

  test('(a) an idea given at adoption is the idea record', async (t) => {
    const fx = await retrofitEngine(t);
    const idea = '# Idea: Sums\n\nKeep the service and make it refuse what is not a number.\n';
    const p = await adoptProject(fx, { idea });
    assert.equal(fileAt(p.repo.path, refOid(p.repo.path, p.repo.ref), '.surety/idea.md'), idea);
  });

  test('(b) the branch moved between the observation and the bootstrap: adoption_branch_moved, nothing pinned, no bootstrap', async (t) => {
    const fx = await retrofitEngine(t);
    const repo = adoptedRepo(fx);
    await armBarrier(fx.engine, 'adoption.observed', 'pause');
    const pending = postAdopt(fx, { repo });
    await waitFor(() => barrierWaiting(fx, 'adoption.observed'), { what: 'the adoption to have observed the branch' });
    const moved = commitOnRef(repo.path, repo.ref, { 'NOTES.md': 'a developer pushed\n' });
    await releaseBarrier(fx.engine, 'adoption.observed');
    const res = await pending;
    assertRefused(res, 409, 'adoption_branch_moved', 'an adoption whose branch moved after it was observed');
    assert.deepEqual(projectsNamed(fx.home, ADOPTED_NAME), [], 'no project row: nothing pinned');
    assert.equal(refOid(repo.path, repo.ref), moved, 'the branch is where the developer left it: no bootstrap');
    assert.deepEqual(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "operations"').get().n), 0, 'no journaled operation');
  });

  test('(c) the signals as observed evidence and the recommendation at 2,000: a repository under is recommended full, one over scoped', async (t) => {
    const fx = await retrofitEngine(t);
    const small = await adoptProject(fx);
    const a = adoptionOf(fx.home, small.id);
    const counts = countsAt(small.repo.path, small.A);
    assert.deepEqual([a.signals?.files, a.signals?.bytes, a.signals?.commits], [counts.files, counts.bytes, counts.commits], `files, bytes and commits at A (${JSON.stringify(a.signals)})`);
    assert.ok(Array.isArray(a.signals.languages) && a.signals.languages.length > 0, 'languages by extension');
    for (const key of ['test_files', 'ci_files', 'deploy_files']) assert.deepEqual([...a.signals[key]].sort(), EXPECTED_SIGNALS[key], `${key} by name`);
    assert.equal(a.recommended_mode, 'full', `${counts.files} files: full recommended`);
    const [mode] = adoptionModeRows(fx.home, small.id);
    assert.deepEqual(mode.evidence?.signals, a.signals, 'the decision carries the signals as its evidence');
    assert.equal(mode.evidence?.recommended_mode, 'full', 'and the recommendation');
    const big = await adoptProject(fx, { name: 'sums-big', repoOpts: { extra: bulkFiles(2001) } });
    const b = adoptionOf(fx.home, big.id);
    assert.ok(b.signals.files > 2000, `over the threshold (${b.signals.files})`);
    assert.equal(b.recommended_mode, 'scoped', 'over 2,000 files: scoped recommended');
  });

  test('(c) an override of adoption_full_max_files 100; an unreadable signal is unknown, never zero, empty or none', async (t) => {
    const fx = await retrofitEngine(t, { config: { adoption_full_max_files: 100 } });
    const over = await adoptProject(fx, { repoOpts: { extra: bulkFiles(120) } });
    assert.equal(adoptionOf(fx.home, over.id).recommended_mode, 'scoped', 'at 100, 120-odd files are recommended scoped');
    const under = await adoptProject(fx, { name: 'sums-small' });
    assert.equal(adoptionOf(fx.home, under.id).recommended_mode, 'full', 'and a dozen files full');
    await armFault(fx.engine, { point: 'adoption_signal', signal: 'commits' });
    const blind = await adoptProject(fx, { name: 'sums-blind' });
    const signals = adoptionOf(fx.home, blind.id).signals;
    assert.ok(isUnknown(signals.commits), `the unreadable signal is recorded unknown (${JSON.stringify(signals.commits)})`);
    const [mode] = adoptionModeRows(fx.home, blind.id);
    assert.ok(isUnknown(mode.evidence?.signals?.commits), 'and shown unknown on the decision');
  });

  test('(d) the CI file\'s environment unknown by name with no adapter; the tag external_unverified with no artifact and no candidate progress; (e) never read, never deployed to', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    const envs = environmentsOf(fx.home, p.id);
    const env = envs.find((e) => e.name === CI_ENVIRONMENT);
    assert.ok(env, `an environment named ${CI_ENVIRONMENT} (${JSON.stringify(envs.map((e) => e.name))})`);
    assert.equal(env.current_config, null, 'with no configuration: Surety did not deploy it');
    const read = await fx.engine.get(`/v1/projects/${p.id}/environments`);
    assert.equal(read.status, 200, read.text);
    const shown = read.body.environments.find((e) => e.name === CI_ENVIRONMENT);
    assert.equal(shown?.state, 'unknown', `shown unknown (SEAM.md §378 †) (${JSON.stringify(shown)})`);
    const releases = releasesOf(fx.home, p.id);
    assert.deepEqual(releases.map((r) => [r.name, r.state, r.artifact ?? null, r.candidate ?? null]), [[RELEASE_TAG, 'external_unverified', null, null]], 'the tag a release, external_unverified');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "candidates" WHERE "project" = ?').get(p.id).n), 0, 'no candidate');
    // (e) ticks: nothing reads or deploys to the environment.
    await tick(fx.engine, p.id, { rounds: 3 });
    const calls = await fx.engine.get(`/v1/harness/deploy/environments/${env.id}`);
    assert.deepEqual(calls.status === 200 ? calls.body.calls : [], [], `no adapter call on ${CI_ENVIRONMENT} (${calls.text})`);
    for (const table of ['observation_jobs', 'environment_logs']) {
      assert.equal(withStore(fx.home, (db) => db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "environment" = ?`).get(env.id).n), 0, `nothing in ${table} for it`);
    }
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "deploy_journal_state" WHERE "project" = ?').get(p.id).n), 0, 'no deployment journaled for the project');
    const again = (await fx.engine.get(`/v1/projects/${p.id}/environments`)).body.environments.find((e) => e.name === CI_ENVIRONMENT);
    assert.equal(again?.state, 'unknown', 'still unknown');
  });

  test('(f) A is immutable: adopting the same repository under the same name again, and the policy route with an adoption key, are refused; A unchanged', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    const again = await postAdopt(fx, { repo: p.repo });
    assert.ok(again.status >= 400 && again.status < 500, `a second adoption of the repository is refused (→ ${again.status} ${again.text})`);
    assert.equal(projectsNamed(fx.home, ADOPTED_NAME).length, 1, 'no second project');
    for (const body of [{ adoption: { pinned_revision: p.repo.pushed } }, { pinned_revision: p.repo.pushed }]) {
      const res = await fx.engine.post(`/v1/projects/${p.id}/policy`, body);
      assert.ok(res.status >= 400 && res.status < 500, `the policy route refuses ${JSON.stringify(Object.keys(body))} (→ ${res.status} ${res.text})`);
    }
    assert.equal(adoptionOf(fx.home, p.id).pinned_revision, p.A, 'A unchanged');
  });

  test('(g) Sean, 2026-10-12: a repository already carrying Surety records is refused, naming what was found; nothing is created', async (t) => {
    const fx = await scriptedEngine(t);
    const withDir = adoptedRepo(fx, { surety: { files: { '.surety/project.json': '{"id": "proj_old"}\n' } } });
    const res1 = await postAdopt(fx, { repo: withDir });
    assertRefused(res1, 409, 'adoption_surety_records', 'a repository with .surety/');
    assert.match(JSON.stringify(res1.body.subject), /\.surety\//, `the refusal names .surety/ (${res1.text})`);
    const withRef = adoptedRepo(fx, { surety: { ref: 'refs/surety/keep/1' } });
    const res2 = await postAdopt(fx, { repo: withRef, name: 'sums-ref' });
    assertRefused(res2, 409, 'adoption_surety_records', 'a repository with refs/surety/*');
    assert.match(JSON.stringify(res2.body.subject), /refs\/surety\/keep\/1/, `the refusal names the ref (${res2.text})`);
    assert.deepEqual([projectsNamed(fx.home, ADOPTED_NAME).length, projectsNamed(fx.home, 'sums-ref').length], [0, 0], 'no project');
    assert.equal(refOid(withDir.path, withDir.ref), withDir.head, 'the branch untouched');
    assert.equal(withStore(fx.home, (db) => db.prepare("SELECT COUNT(*) AS n FROM \"decisions\" WHERE \"kind\" = 'adoption_mode'").get().n), 0, 'no decision');
  });
});
