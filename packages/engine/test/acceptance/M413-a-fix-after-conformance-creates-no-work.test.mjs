// M413 (f), a `fix` after conformance creates no work (slice 32's review, S2;
// kernel lane). D6 §8.1 step 5, §8.3 (in the conformance phase a `fix` records
// the unresolved finding and the remediation, creates no fix work, and no
// source changes in phase 1); B12; E142 item 3; SEAM.md §§382, 387.
//
// The sensitive-area variant (§382): once the conformance stage is
// `conformed`, with the phase's own checks held (no phase gate, no Alpha
// yet), the Verifier reports a High finding in the sensitive area on c-1 and
// a Reviewer's `fix` disposition is recorded. Read: the finding unresolved
// with its remediation, no `fix` work, no `stage_build`, the integration
// branch's application source still A, phase 1 not complete.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findingsOf, raiseFindings, review } from './harness/gates.mjs';
import { alphaReady, planOfPhase, workOf } from './harness/journey/drive.mjs';
import { gitQuiet } from './harness/repos.mjs';
import { withStore } from './harness/store.mjs';
import { advance, conformanceStages, retrofitEngine, toConformancePublished } from './harness/retrofit/drive.mjs';
import { FLOOR_CHECK, MODULES_JSON_SENSITIVE, MODULES_SENSITIVE, SENSITIVE_AREA, retrofitSpecText, sensitiveConformanceStage } from './harness/retrofit/products.mjs';
import { refOid } from './harness/retrofit/repo.mjs';

const projection = (repo, rev) =>
  gitQuiet(repo, ['ls-tree', '-r', rev])
    .split('\n')
    .filter((l) => l && !l.split('\t')[1].startsWith('.surety/'))
    .sort();
// The phase's own registrations are held unrecorded; every other execution passes.
const holdPhase = (x) => (JSON.parse(x.trigger ?? '{}').source === 'phase' ? null : 0);

describe('M413 (f) S2: a fix after conformance creates no work', () => {
  test('conformed, before the phase gate and Alpha: a fix on a High finding about c-1 records the remediation; no fix work, no source change', async (t) => {
    const fx = await retrofitEngine(t, { extraAuthoring: FLOOR_CHECK });
    const J = await toConformancePublished(fx, { spec: retrofitSpecText({ modules: MODULES_SENSITIVE }), architect: { modules: MODULES_JSON_SENSITIVE, stages: [sensitiveConformanceStage()] } });
    const { p, ctx } = J;
    await alphaReady(fx, ctx);
    await advance(fx, ctx, () => (conformanceStages(fx.home, p.id)[0]?.conformance_state === 'conformed' ? true : undefined), { what: 'the stage conformed', exits: holdPhase, max: 30 });
    const c1 = withStore(fx.home, (db) => db.prepare('SELECT * FROM "candidates" WHERE "project" = ? ORDER BY "seq"').get(p.id));
    assert.equal(planOfPhase(fx.home, p.id, 1).find((x) => x.active === 1 || x.active === true)?.completed_at ?? null, null, 'the fixture is live: phase 1 not complete (its checks held)');
    // H1 (E171 item 5; SEAM.md §552): a Reviewer's fix on a finding naming no check is refused, so the finding names
    // `accept-r2` and the criterion it covers, R2.1 (the service's sum route), as M413 (f)'s does.
    const [found] = await raiseFindings(fx, p.id, c1.id, [{ category: 'defect', severity: 'high', message: 'the service echoes its PORT secret in an error', sensitive_area: SENSITIVE_AREA, check: 'accept-r2', criterion: 'R2.1' }], { kind: 'verification' });
    await review(fx, p.id, c1.id, { dispositions: [{ finding: found.id, disposition: 'fix', remediation: 'Phase 2: stop echoing the port.' }] });
    await advance(fx, ctx, () => undefined, { exits: holdPhase, max: 4 }).catch(() => null);
    const after = findingsOf(fx.home, p.id).find((f) => f.id === found.id);
    assert.equal(after.resolved_at ?? null, null, 'the finding unresolved');
    assert.match(after.remediation ?? '', /stop echoing/, 'its remediation recorded');
    assert.deepEqual(workOf(fx.home, p.id, 'fix'), [], 'no fix work');
    assert.deepEqual(workOf(fx.home, p.id, 'stage_build'), [], 'no Builder');
    assert.deepEqual(projection(p.repo.path, refOid(p.repo.path, p.repo.ref)), projection(p.repo.path, p.A), 'the application source still A');
  });
});
