// M342's other free half: what the Verifier of `check_correction` work is
// told about environment-bound checks (M4 slice 30; sandbox lane, no model,
// nothing paid; manifest slice 30). M4 plan §3.8 M342 (a) ("a real Verifier
// writes the workspace acceptance checks and the `post_deploy_behavior`
// check through `check_correction` work"); BS4 §3, "the role packages": "the
// Verifier's check-writing package (`src/checks/guide.ts`) gains the
// environment-bound kinds, `requires`, `gate_kinds` `alpha_complete`,
// `SURETY_TARGET_<NAME>` and the `secrets` field, and states that
// `alpha_complete` reads at least one required `post_deploy_behavior`
// check"; E87 item 10's principle (each role's package says what its gate
// reads); D4 §§5.1, 5.2, 7.2; SEAM.md §334. M239's form
// (`M239-the-verifiers-check-writing-package`).
//
// The real row asks a real Verifier to write a `post_deploy_behavior` check
// from its package alone; today the package names only the workspace kinds
// and the gate kinds `stage` and `alpha_authorize`. What it must hold is read
// without a model: a scripted Verifier on `check_correction` work, in M342's
// own project with environment `alpha` configured (one target, `app`), dumps
// its package, and the case reads every file but the result schema and the
// manifest, for meaning, never wording:
//   - the environment-bound kinds `post_deploy_behavior` and
//     `post_deploy_identity`, and the gate kind `alpha_complete`;
//   - a definition's member "requires" with its values `environment` and
//     `artifact_digest`, and the member "secrets";
//   - how a check reaches its environment's target: `SURETY_TARGET_APP` for
//     the configured target `app`, or the general `SURETY_TARGET_<NAME>`;
//   - one sentence saying that `alpha_complete` needs at least one required
//     `post_deploy_behavior` check.
//
// SAFETY: the scripted Verifier only reads its package; nothing is deployed
// (the environment is configured, never requested) and nothing runs in a
// check domain.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { freePort } from './harness/engine.mjs';
import { installGatedPlan } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { addWork, pauseProject, resumeProject, runsOf, tickUntil } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { checkProject, governedText } from './harness/checks/fixtures.mjs';
import { RUNTIME, configContent, configure } from './harness/deploy/kernel.mjs';
import { M239_GOVERNED, m239Toolchain } from './harness/real/checks-journey.mjs';
import { M342 } from './harness/real/deploy-journey.mjs';

const sentencesOf = (text) => text.split(/\n|(?<=[.;:])\s+/).map((x) => x.trim()).filter(Boolean);

describe("M342 the Verifier's deployment-check package (sandbox lane, no model)", () => {
  test("a check_correction Verifier in a project with an environment is told how to write its post_deploy_behavior check: the environment-bound kinds, alpha_complete, requires, secrets, SURETY_TARGET_<NAME>, and that alpha_complete needs at least one required post_deploy_behavior check", async (t) => {
    const fx = await sandboxEngine(t);
    const project = await checkProject(fx, { files: { '.surety/checks/protected-policy.json': governedText(M239_GOVERNED(m239Toolchain(fx.root))) }, tier: M342.tier });
    // The owner's configuration, one target `app` (SEAM.md §245), as the real journey writes it before the checks.
    await configure(fx.engine, project.id, M342.environment, configContent({ port: await freePort(), start: [RUNTIME.path, 'server.mjs'] }));
    await pauseProject(fx.engine, project.id);
    await installGatedPlan(fx.engine, project.id, { requirements: M342.requirements, constraints: M342.constraints, stages: [M342.stage] });
    const item = await addWork(fx.engine, project.id, 'check_correction');
    fx.scripted.script(item, [roleThat([step.probe('context_dump')])]);
    await resumeProject(fx.engine, project.id);
    await tickUntil(fx.engine, project.id, () => runsOf(fx.home, item)[0]?.state === 'ended', { what: "the check_correction Verifier's run to end" });
    await pauseProject(fx.engine, project.id);
    const [run] = runsOf(fx.home, item);
    assert.equal(run.role, 'verifier', "check_correction work is the Verifier's");
    const launch = fx.scripted.launches({ work_item: item })[0];
    const [dump] = fx.scripted.probes(launch.invocation, 'context_dump');
    assert.equal(dump?.outcome, 'dumped', `the Verifier read its context package (${dump?.error})`);
    const told = dump.files.filter((f) => !['result-schema.json', 'manifest.json'].includes(f.name) && typeof f.text === 'string').map((f) => `\n=== ${f.name}\n${f.text}`).join('');
    const sentences = sentencesOf(told);

    const missing = [];
    const need = (what, ok) => {
      if (!ok) missing.push(what);
    };
    for (const k of ['post_deploy_behavior', 'post_deploy_identity']) need(`the environment-bound kind ${k} (D4 §5.1)`, new RegExp(`\\b${k}\\b`).test(told));
    need('the gate kind alpha_complete', /\balpha_complete\b/.test(told));
    need('a definition\'s member "requires"', told.includes('"requires"'));
    for (const v of ['environment', 'artifact_digest']) need(`the value ${v} of "requires"`, new RegExp(`\\b${v}\\b`).test(told));
    need('a definition\'s member "secrets" (D4 §7.2)', told.includes('"secrets"'));
    need("how a check reaches the environment's target: SURETY_TARGET_APP, or SURETY_TARGET_<NAME>", /SURETY_TARGET_(APP\b|<)/.test(told));
    need('that alpha_complete needs at least one required post_deploy_behavior check', sentences.some((x) => /\balpha_complete\b/.test(x) && /\bpost_deploy_behavior\b/.test(x) && /\brequired\b/i.test(x) && /\b(at least one|one or more|requires?|needs?|must)\b/i.test(x)));
    assert.deepEqual(missing, [], `the check_correction Verifier's package is missing what it needs to write the deployment's check (files: ${dump.files.map((f) => f.name).join(', ')}); prompt: ${JSON.stringify((dump.files.find((f) => f.name === 'prompt.md')?.text ?? '').slice(0, 1500))}`);
  });
});
