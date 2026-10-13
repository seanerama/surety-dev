// M409 (f), the same repository adopted under a second name (slice 32's
// review, Q1; kernel lane). D6 §8.1 step 1 (A pinned once, immutable; B11);
// D6-R01; SEAM.md §§377, 387. Adopting a repository path that an adopted
// project already holds, under another name, is refused 409, naming the
// project that holds it; nothing is pinned, and the holder's A is unchanged.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withStore } from './harness/store.mjs';
import { adoptProject, adoptionOf, postAdopt, projectsNamed, retrofitEngine } from './harness/retrofit/drive.mjs';
import { refOid } from './harness/retrofit/repo.mjs';

describe('M409 (f) Q1: the same repository under a second name', () => {
  test('refused 409 naming the project that holds it; nothing pinned; A unchanged', async (t) => {
    const fx = await retrofitEngine(t);
    const first = await adoptProject(fx);
    const head = refOid(first.repo.path, first.repo.ref);
    const res = await postAdopt(fx, { repo: first.repo, name: 'sums-again' });
    assert.equal(res.status, 409, `refused 409 (→ ${res.status} ${res.text})`);
    assert.ok(JSON.stringify(res.body?.subject ?? {}).includes(first.id), `the refusal names the project that holds the repository, ${first.id} (${res.text})`);
    assert.deepEqual(projectsNamed(fx.home, 'sums-again'), [], 'no second project: nothing pinned');
    assert.equal(withStore(fx.home, (db) => db.prepare('SELECT COUNT(*) AS n FROM "projects" WHERE "dev_repo_path" = ?').get(first.repo.path).n), 1, 'one project holds the path');
    assert.equal(adoptionOf(fx.home, first.id).pinned_revision, first.A, 'the holder\'s A unchanged');
    assert.equal(refOid(first.repo.path, first.repo.ref), head, 'the branch untouched');
  });
});
