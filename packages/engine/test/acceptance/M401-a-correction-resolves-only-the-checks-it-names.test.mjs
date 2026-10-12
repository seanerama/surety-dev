// M401 (h), the 31b review's S2 (slice 31; kernel lane). D6 §4.5 ("a
// protected correction applied that names the criteria" resolves an
// obligation), B05; D3 §4.3; SEAM §§353, 368, 374.
//
// A change rewording R2.1 and R2.2 lists two checks: accept-r2 (R2.1,
// R2.2) and integration (R2.2), each with an obligation. The Verifier's
// correction rewrites accept-r2's test only and is applied (the owner
// approves it, §370). That resolves accept-r2's obligation alone:
// integration's stays unresolved, and a stage gate whose scope requires
// integration is refused ACCEPTANCE_SCOPE_INCOMPLETE naming it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluate } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { authoringReady, candidatesOfProject, checkRows, correctionScript, obligationsOf, planOfPhase, pump, specRevisions, stagesOfPlan, workOf } from './harness/journey/drive.mjs';
import { SPEC_R2_BOTH, journeyProject, postChange } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';

describe('M401 (h) S2: a correction resolves only the obligations of the checks it names', () => {
  test('obligations on accept-r2 and integration; a correction rewriting accept-r2 alone resolves accept-r2 alone; integration still blocks the gate', async (t) => {
    const { fx, p, ctx, plan } = await journeyProject(t);
    await authoringReady(fx, ctx, 1);
    fx.scripted.kindScript('spec_change', roleThat([step.write('.surety/spec/spec.md', SPEC_R2_BOTH)], { changes: [{ key: 'R2', kind: 'criteria_changed', reason: 'S2: R2.1 and R2.2 name the content type' }] }));
    fx.scripted.kindScript('check_correction', correctionScript());
    await postChange(fx, ctx, 'S2: R2.1 and R2.2 name the content type.');
    await pump(fx, ctx, () => specRevisions(fx.home, p.id).find((r) => r.version === 2), { what: 'spec version 2', max: 60 });
    const listed = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed');
    assert.deepEqual([...new Set(listed.map((o) => o.key))].sort(), ['accept-r2', 'integration'], `the fixture is live: obligations on accept-r2 and integration (${JSON.stringify(listed)})`);
    // The correction (accept-r2's test alone) applied.
    await pump(fx, ctx, () => workOf(fx.home, p.id, 'check_correction').find((w) => w.status === 'complete') && obligationsOf(fx.home, p.id).some((o) => o.key === 'accept-r2' && o.resolved_at), { what: 'the correction applied and accept-r2\'s obligation resolved', max: 60 });
    const after = obligationsOf(fx.home, p.id).filter((o) => o.reason === 'spec_changed');
    assert.ok(after.filter((o) => o.key === 'accept-r2').every((o) => o.resolved_at), 'accept-r2\'s obligation is resolved by the correction that names it');
    assert.ok(after.filter((o) => o.key === 'integration').every((o) => o.resolved_at === null), `integration's obligation is not: the correction does not name it (${JSON.stringify(after)})`);
    // A gate whose scope requires integration (stage 2 implements R2) names it.
    const stage2 = stagesOfPlan(fx.home, plan.id).find((s) => s.number === 2);
    const candidate = await pump(fx, ctx, () => candidatesOfProject(fx.home, p.id).at(-1), { what: 'a candidate', max: 60 });
    const evaluation = await evaluate(fx.engine, p.id, candidate.id, 'stage', { stage: stage2.id }, { inventory: false });
    const integration = checkRows(fx.home, p.id).filter((c) => c.key === 'integration').map((c) => c.id);
    const named = evaluation.reasons.filter((r) => r.code === 'ACCEPTANCE_SCOPE_INCOMPLETE').flatMap((r) => r.subjects ?? []);
    assert.ok(named.some((id) => integration.includes(id)), `ACCEPTANCE_SCOPE_INCOMPLETE names integration (${JSON.stringify(evaluation.reasons)})`);
    void planOfPhase;
  });
});
