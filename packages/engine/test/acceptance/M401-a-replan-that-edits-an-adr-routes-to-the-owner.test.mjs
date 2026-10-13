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
//
// Migrated under the slice-34 review's M4 (the driver, 2026-10-13; SEAM.md
// §405): a replan that changes the architecture is checked against the
// version its publication allocates, so both replans here are prepared
// against architecture 2. The former form, an ADR edited while the plan
// names architecture 1, is now refused `PLAN_STALE_BASELINE` at the commit's
// check, with no `plan_approval` (pinned by M448 (a) M4, "naming v").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { phaseCompleted, planOfPhase, pump, decisionsOf, runsOfProject, workOf } from './harness/journey/drive.mjs';
import { replanWith } from './harness/journey/replan34.mjs';
import { ADR_001, ADR_001_REVISED, ADR_KEY } from './harness/journey/reference.mjs';
import { journeyProject } from './harness/journey/review31b.mjs';
import { step } from './harness/scripted.mjs';

const ADR_PATH = `.surety/adrs/${ADR_KEY}.md`;
// The ADR's front matter left unclosed: it does not parse, whatever it claims.
const ADR_UNPARSEABLE = ADR_001.replace('status: accepted\n---\n', 'status: accepted\n');

// The replan's script for phase 2, with the ADR file written beside it,
// prepared against the architecture version its publication allocates (2).
const replanEditingAdr = (adr) => replanWith({ architecture_version: 2, before: [step.write(ADR_PATH, adr)] });

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
    fx.scripted.kindScript('replan', [replanEditingAdr(ADR_001_REVISED)]);
    await phaseCompleted(fx, ctx, 1);
    const out = await routed(fx, ctx, p);
    assert.ok(!out.published || (out.published.approved_by !== 'engine:plan_check' && out.published.routing !== 'registered'), `phase 2 is not registered by computed routing (${JSON.stringify(out.published ?? null)})`);
    assert.ok(out.approval, `plan_approval is raised to the owner (${JSON.stringify(out)})`);
  });

  test('an ADR rewritten with front matter that does not parse is not counted as accepted: the replan is not registered', async (t) => {
    const { fx, p, ctx } = await journeyProject(t);
    fx.scripted.kindScript('replan', [replanEditingAdr(ADR_UNPARSEABLE)]);
    await phaseCompleted(fx, ctx, 1);
    const out = await routed(fx, ctx, p);
    assert.ok(!out.published || (out.published.approved_by !== 'engine:plan_check' && out.published.routing !== 'registered'), `phase 2 is not registered by computed routing on an ADR that does not parse (${JSON.stringify(out.published ?? null)})`);
  });
});
