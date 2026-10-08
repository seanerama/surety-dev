// M239's free half: what the Verifier of `check_correction` work is told
// (M3 slice 22; sandbox lane, no model, nothing paid). M3 plan §3.8 M239
// (a); BS3 §3, "the role packages": every role is told what its gate reads
// (E87 item 10's principle), and "the Verifier's package names the
// requirement index's criteria and D3 Appendix B's definition reference";
// D3 §§1.1 to 1.3, 4.3, Appendix B; SEAM.md §237.
//
// The real row (M239-the-real-check-journey, manifest `real`) asks a real
// Verifier to write a project's checks from its package alone. What that
// package must hold can be read without a model: here a scripted Verifier on
// `check_correction` work, in M239's own project (T1; R1 to R3 with their
// texts and criteria; a governed file naming one program, `node`, and no
// definition), dumps its context package, and the case reads every file but
// the result schema and the manifest for:
//   - the project's protected root and the definitions directory the
//     governed file names (`.surety/checks/`, `.surety/checks/defs/`);
//   - each criterion of the index (R1.1, R2.1, R3.1) and each requirement's
//     approved text, so a check can be written per criterion;
//   - the program the governed file lets a definition run, by its name (`node`);
//   - a definition's form, as D3 Appendix B gives it: the members "key",
//     "kind", "command", "covers", "criteria", "gate_kinds", "inputs" and
//     "timeout_s";
//   - the kinds the project's tier requires (T1: acceptance and smoke, D3
//     §4.3) and the gate kinds (stage, alpha_authorize);
// and its result schema for the `proposal` the engine captures.
// What the package says, and in what words, is the engine's to choose.
//
// SAFETY: the scripted Verifier only reads its package; nothing is run in a
// check domain.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installGatedPlan } from './harness/gates.mjs';
import { roleThat } from './harness/gitruns.mjs';
import { addWork, pauseProject, resumeProject, runsOf, tickUntil } from './harness/runs.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { step } from './harness/scripted.mjs';
import { checkProject, governedText } from './harness/checks/fixtures.mjs';
import { M239, M239_GOVERNED, SEEDED_DEFECT_M3, m239Toolchain } from './harness/real/checks-journey.mjs';

const FIELDS = ['key', 'kind', 'command', 'covers', 'criteria', 'gate_kinds', 'inputs', 'timeout_s'];

// M239's project at the point the real journey writes its checks: the plan's
// one stage (stage 1, implementing R1 only), a scripted Verifier on
// `check_correction` work dumping its package. Returns {fx, run, dump, told}:
// `told` is every file but the result schema and the manifest, which name
// fields and files, not guidance.
async function dumpedPackage(t) {
  const fx = await sandboxEngine(t);
  const project = await checkProject(fx, { files: { '.surety/checks/protected-policy.json': governedText(M239_GOVERNED(m239Toolchain(fx.root))), [SEEDED_DEFECT_M3.path]: SEEDED_DEFECT_M3.content }, tier: M239.tier });
  await pauseProject(fx.engine, project.id);
  await installGatedPlan(fx.engine, project.id, { requirements: M239.requirements, constraints: M239.constraints, stages: [M239.stageOne] });
  const item = await addWork(fx.engine, project.id, 'check_correction');
  fx.scripted.script(item, [roleThat([step.probe('context_dump')])]);
  await resumeProject(fx.engine, project.id);
  await tickUntil(fx.engine, project.id, () => runsOf(fx.home, item)[0]?.state === 'ended', { what: "the check_correction Verifier's run to end" });
  await pauseProject(fx.engine, project.id);
  const [run] = runsOf(fx.home, item);
  assert.equal(run.role, 'verifier', 'check_correction work is the Verifier\'s');
  const launch = fx.scripted.launches({ work_item: item })[0];
  const [dump] = fx.scripted.probes(launch.invocation, 'context_dump');
  assert.equal(dump?.outcome, 'dumped', `the Verifier read its context package (${dump?.error})`);
  const told = dump.files.filter((f) => !['result-schema.json', 'manifest.json'].includes(f.name) && typeof f.text === 'string').map((f) => `\n=== ${f.name}\n${f.text}`).join('');
  return { fx, run, dump, told };
}

// The package's sentences: split at line ends and at sentence and clause ends.
const sentencesOf = (text) => text.split(/\n|(?<=[.;:])\s+/).map((x) => x.trim()).filter(Boolean);

describe("M239 the Verifier's check-writing package (sandbox lane, no model)", () => {
  test("a check_correction Verifier is told where and how to write the project's checks: the roots, the definitions directory, every criterion with its requirement's text, the program, a definition's form, the tier's kinds and the gate kinds; its result offers the proposal", async (t) => {
    const { dump, told } = await dumpedPackage(t);
    const schemaFile = dump.files.find((f) => f.name === 'result-schema.json');
    const missing = [];
    const need = (what, ok) => {
      if (!ok) missing.push(what);
    };
    need('the protected root .surety/checks/', told.includes('.surety/checks/'));
    need('the definitions directory .surety/checks/defs/', told.includes('.surety/checks/defs/'));
    for (const r of M239.requirements) {
      need(`the criterion ${r.key}.1`, told.includes(`${r.key}.1`));
      need(`the approved text of ${r.key}`, told.includes(r.text));
    }
    need('the program the governed file names, `node`', /\bnode\b/.test(told));
    for (const f of FIELDS) need(`a definition's member "${f}" (D3 Appendix B)`, told.includes(`"${f}"`));
    for (const k of ['acceptance', 'smoke']) need(`the kind ${k}, which a T1 scope requires (D3 §4.3)`, new RegExp(`\\b${k}\\b`).test(told));
    for (const g of ['stage', 'alpha_authorize']) need(`the gate kind ${g}`, new RegExp(`\\b${g}\\b`).test(told));
    assert.deepEqual(missing, [], `the check_correction Verifier's package is missing what it needs to write the checks (files: ${dump.files.map((f) => f.name).join(', ')}); prompt: ${JSON.stringify((dump.files.find((f) => f.name === 'prompt.md')?.text ?? '').slice(0, 1500))}`);
    const schema = JSON.parse(schemaFile.text);
    assert.deepEqual(schema.properties?.proposal?.required, ['rationale', 'requested_change_kind'], 'its result offers the proposal the engine captures (SEAM.md §68)');
  });

  // Sean's real run, first try (2026-10-09; COVERAGE.md, "M3 slice 22: Sean's real run"): the real
  // Verifier wrote a smoke check importing every src file of the spec; stage 1 (R1 only) failed it,
  // src/logout.mjs not yet written; the Builder objected and path one stopped at the X2 decision. The
  // package never stated the scope rule (D3 §4.2; computeScope): a check covering no criterion is in
  // the required set of every stage's gate, so it must pass on every stage's candidate, before later
  // stages' code exists; a check naming criteria is required at a stage only when that stage
  // implements their requirement.
  test("(b) the package states the scope rule for the project in hand: a check covering no criterion is required at every stage's gate and must pass before later stages' code exists; a check naming criteria is required only at a stage implementing their requirement; which stage implements which requirement", async (t) => {
    const { told } = await dumpedPackage(t);
    const sentences = sentencesOf(told);
    const noCriterion = (x) => /\b(covers? no|names? no|naming no|with no|without (a|any)|no) criteri(on|a)\b/i.test(x) || /\bcriteria\b[^.]*\bempty\b/i.test(x);
    const everyStage = (x) => /\b(every|each|all) stages?\b|\bevery stage(?:'s)? gate\b|\bat every stage\b/i.test(x);
    const notYet = (x) => /\b(not yet|does not (yet )?exist|do not (yet )?exist|no stage has|yet to be|later stages?|not (yet )?delivered|not (yet )?built)\b/i.test(x);
    const missing = [];
    const need = (what, ok) => {
      if (!ok) missing.push(what);
    };
    need('that a check covering no criterion (a smoke check) is required at every stage\'s gate', sentences.some((x) => noCriterion(x) && everyStage(x)));
    need("that such a check must therefore pass on every stage's candidate, before later stages' code exists, so it must not require code no stage has delivered yet", sentences.some((x) => (noCriterion(x) || /\bsmoke\b/i.test(x) || /\bsuch a check\b/i.test(x)) && notYet(x)));
    need('that a check naming criteria is required at a stage only when that stage implements their requirement', sentences.some((x) => /\bcriteri/i.test(x) && /\bstage\b/i.test(x) && /\bimplement/i.test(x) && /\b(only|when|if|unless)\b/i.test(x)));
    need('the project in hand: stage 1 implements R1', sentences.some((x) => /\bstage 1\b/i.test(x) && /\bR1\b/.test(x) && /\bimplement/i.test(x)));
    need('the project in hand: R2 and R3 are implemented by no stage yet', sentences.some((x) => /\bR2\b/.test(x) && /\bR3\b/.test(x) && /\b(no stage|not (yet )?(implemented|planned)|none of the stages|no planned stage)\b/i.test(x)));
    assert.deepEqual(missing, [], `the package does not state the scope rule for this project; prompt: ${JSON.stringify(told.slice(told.indexOf("## Writing the project's checks"), told.indexOf("## Writing the project's checks") + 3500))}`);
  });
});
