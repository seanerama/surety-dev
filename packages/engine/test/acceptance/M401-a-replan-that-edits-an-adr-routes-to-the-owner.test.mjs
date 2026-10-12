// M401 (g), the 31b review's S4 (slice 31; kernel lane). D6 §5.4 (the
// routing computed from the artifacts: a replan whose commit changes the
// architecture, the module map, an ADR or the roadmap raises `plan_approval`;
// only one that changes none of them is registered by `engine:plan_check`),
// §5.6, B03; SEAM §§352, 374.
//
// After phase 1 completes, the replan's commit also edits
// `.surety/adrs/ADR-001.md`: phase 2 is not published by computed routing;
// `plan_approval` is raised to the owner. A second case: the ADR rewritten
// with front matter that does not parse is not counted as an accepted,
// unchanged ADR: the replan is not registered either.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { phaseCompleted, planOfPhase, pump, replanScript, decisionsOf, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { ADR_001, ADR_001_REVISED, ADR_KEY } from './harness/journey/reference.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';

const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
// The ADR's front matter left unclosed: it does not parse, whatever it claims.
const ADR_UNPARSEABLE = ADR_001.replace('status: accepted\n---\n', 'status: accepted\n');

// The replan's script for phase 2, with the ADR file written beside it.
const replanWith = (adr) => {
  const base = replanScript();
  return { ...base, steps: [step.write(ADR_PATH, adr), ...base.steps] };
};

// Rounds until phase 2 is published, plan_approval is open, or the replan's run failed.
async function routed(fx, ctx, p) {
  return pump(
    fx,
    ctx,
    () => {
      const published = planOfPhase(fx.home, p.id, 2).find((x) => x.published_at);
      if (published) return { published };
      const approval = decisionsOf(fx.home, p.id, 'plan_approval').find((d) => d.status === 'open');
      if (approval) return { approval };
      const replanRuns = runsOfProject(fx.home, p.id).filter((r) => workOf(fx.home, p.id, 'replan').some((w) => w.id === r.work_item));
      const failed = replanRuns.find((r) => r.state === 'ended' && r.outcome !== 'completed');
      if (failed) return { failed };
      return undefined;
    },
    { what: 'the replan to be routed', max: 60 },
  );
}

describe('M401 (g) S4: a replan that edits an ADR', () => {
  test('a replan whose commit edits ADR-001 raises plan_approval; phase 2 is not published by engine:plan_check', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanWith(ADR_001_REVISED)]);
    await phaseCompleted(fx, ctx, 1);
    const out = await routed(fx, ctx, p);
    assert.ok(!out.published || (out.published.approved_by !== 'engine:plan_check' && out.published.routing !== 'registered'), `phase 2 is not registered by computed routing (${JSON.stringify(out.published ?? null)})`);
    assert.ok(out.approval, `plan_approval is raised to the owner (${JSON.stringify(out)})`);
  });

  test('an ADR rewritten with front matter that does not parse is not counted as accepted: the replan is not registered', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanWith(ADR_UNPARSEABLE)]);
    await phaseCompleted(fx, ctx, 1);
    const out = await routed(fx, ctx, p);
    assert.ok(!out.published || (out.published.approved_by !== 'engine:plan_check' && out.published.routing !== 'registered'), `phase 2 is not registered by computed routing on an ADR that does not parse (${JSON.stringify(out.published ?? null)})`);
  });
});
