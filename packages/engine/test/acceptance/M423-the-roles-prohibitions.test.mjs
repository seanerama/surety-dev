// M423, the roles' prohibitions (slice 34; kernel lane). M5 plan §3.4 M423;
// D6-W03, D6-A03; D6 §2.5, §3.3; F §4.1; D1 §7.3; the driver's rulings
// (2026-10-13: a path outside the role's is `diff_violation`, the Architect's
// result carrying a requirement's new text `invalid_result`); SEAM.md §§344,
// 400.
//
// (a) a Spec Writer save touching source, `.surety/checks/` or
//     `.surety/architecture/` beside its spec, and the spec change hidden in a
//     renamed or deleted artifact or a link: each refused whole,
//     `diff_violation`, naming the path, nothing committed;
// (b) a Vision save touching `.surety/spec/`: refused the same way;
// (c) an Architect save touching source or `.surety/checks/`: refused;
// (d) an Architect replan whose commit writes `.surety/spec/spec.md`:
//     `diff_violation`; an Architect replan whose result carries a
//     requirement's new statement: `invalid_result`; a Spec Writer change
//     run touching anything but `.surety/spec/`: `diff_violation`, no
//     proposal raised. Nothing of any of them is integrated.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOfKind } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { architectSession, createWithIdea, specRevisions, specSession, visionSession, workOf } from './harness/journey/drive.mjs';
import { IDEA_RECORD, SPEC, specText } from './harness/journey/reference.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { SPEC_PATH, requirementsWith } from './harness/journey/spec34.mjs';
import { fileAt, refOid, refsOf } from './harness/repos.mjs';
import { addWork, runsOf, scriptedEngine, tickUntil } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { readSession, openSession, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { postSaveRaw } from './harness/session-lane.mjs';

const R1_REWRITTEN = 'The library multiplies two numbers.';
const SPEC_R1_REWRITTEN = specText({ requirements: requirementsWith({ R1: { statement: R1_REWRITTEN } }) });

// A session of `role` whose one turn runs `steps`, then a save: refused whole,
// 422 `diff_violation` naming `names`, the branch unmoved, the session idle.
async function refusedSave(fx, p, role, steps, names) {
  const run = await openSession(fx, p.id, role);
  scriptTurns(fx, run.id, [{ steps: [...steps, step.result(turnResult({ reply: 'Written.', artifact_changed: true }))] }]);
  await sayAndSettle(fx, p.id, run.id, 'Write it.');
  const head = refOid(p.repo.path, p.repo.ref);
  const res = await postSaveRaw(fx, p.id, run.id);
  assertRefused(res, 422, 'diff_violation', `a ${role} save touching ${names}`);
  assert.ok(JSON.stringify(res.body.subject ?? {}).includes(names), `the refusal names ${names} (${res.text})`);
  assert.equal(refOid(p.repo.path, p.repo.ref), head, 'refused whole: nothing committed, the permitted part included');
  assert.equal((await readSession(fx, p.id, run.id)).run.session_state, 'open_idle', 'the session idle, its workspace retained');
  return run;
}

const specWrite = step.write(SPEC_PATH, SPEC);
const SPEC_WRITER_CASES = [
  { name: 'source', steps: [specWrite, step.write('src/sum.mjs', 'export const sum = (a, b) => a + b;\n')], names: 'src/sum.mjs' },
  { name: '.surety/checks/', steps: [specWrite, step.write('.surety/checks/tests/sum.test.mjs', 'export {};\n')], names: '.surety/checks/tests/sum.test.mjs' },
  { name: '.surety/architecture/', steps: [specWrite, step.write('.surety/architecture/architecture.md', '# Architecture\n')], names: '.surety/architecture/architecture.md' },
  { name: 'a rename of the idea record into .surety/spec/', steps: [specWrite, step.rename('.surety/idea.md', '.surety/spec/idea.md')], names: '.surety/idea.md' },
  { name: 'a deletion of the idea record', steps: [specWrite, step.delete('.surety/idea.md')], names: '.surety/idea.md' },
  { name: 'a link in .surety/spec/ to .surety/checks/', steps: [specWrite, step.symlink('.surety/spec/checks', '../checks')], names: '.surety/spec/checks' },
];

// A project at `developing` (the first plan published), its authoring
// ended at once so a fixture's work item is dispatched next.
async function developing(fx) {
  const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
  await visionSession(fx, p.id);
  await specSession(fx, p.id);
  await architectSession(fx, p.id, p.repo);
  for (const w of workOf(fx.home, p.id, 'check_authoring')) fx.scripted.script(w.id, [script.complete(), script.complete()]);
  fx.scripted.defaultScript(script.complete());
  return p;
}

// A replan work item (the labelled fixture, as M404 (e)) run with `scriptValue`; its ended run.
async function replanRun(fx, p, scriptValue) {
  const item = await addWork(fx.engine, p.id, 'replan');
  fx.scripted.script(item, [scriptValue]);
  return tickUntil(fx.engine, p.id, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { max: 20, what: 'the replan run to end' });
}

describe('M423 the roles\' prohibitions', () => {
  for (const c of SPEC_WRITER_CASES) {
    test(`(a) a Spec Writer save with its spec and ${c.name}: refused whole, diff_violation naming ${c.names}`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      await refusedSave(fx, p, 'spec_writer', c.steps, c.names);
    });
  }

  test('(b) a Vision save touching .surety/spec/: refused whole, diff_violation naming the path', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    await refusedSave(fx, p, 'vision', [step.write('.surety/idea.md', IDEA_RECORD), step.write(SPEC_PATH, SPEC)], SPEC_PATH);
  });

  for (const [name, path] of [['source', 'server.mjs'], ['.surety/checks/', '.surety/checks/tests/service.test.mjs']]) {
    test(`(c) an Architect save touching ${name}: refused whole, diff_violation naming ${path}`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      await visionSession(fx, p.id);
      await specSession(fx, p.id);
      await refusedSave(fx, p, 'architect', [step.write('.surety/architecture/architecture.md', '# Tally: architecture\n'), step.write(path, 'export {};\n')], path);
    });
  }

  test('(d) an Architect replan whose commit rewrites a requirement in .surety/spec/spec.md: failed diff_violation naming the path; nothing integrated', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await developing(fx);
    const ended = await replanRun(fx, p, { steps: [step.write(SPEC_PATH, SPEC_R1_REWRITTEN), step.result({ status: 'completed', summary: 'R1 restated', plan: 'phase-2', conformance: 'within_baseline' })] });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'diff_violation'], `the run is refused (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /\.surety\/spec\/spec\.md/, 'naming the path');
    assert.ok(!fileAt(p.repo.path, refOid(p.repo.path, p.repo.ref), SPEC_PATH).includes(R1_REWRITTEN), 'the integration branch does not carry the rewrite');
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'no spec revision');
  });

  test('(d) an Architect replan whose result carries a requirement\'s new statement: failed invalid_result; nothing integrated', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await developing(fx);
    const head = refOid(p.repo.path, p.repo.ref);
    const ended = await replanRun(fx, p, {
      steps: [step.result({ status: 'completed', summary: 'R1 restated', plan: 'phase-2', conformance: 'within_baseline', requirement_changes: [{ key: 'R1', statement: R1_REWRITTEN }] })],
    });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'invalid_result'], `the result is refused by its closed schema (${ended.reason_text})`);
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing integrated');
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'no spec revision');
    assert.equal(fileAt(p.repo.path, head, SPEC_PATH).includes(R1_REWRITTEN), false);
  });

  test('(d) a Spec Writer change run touching src/ beside .surety/spec/: failed diff_violation naming the path; no proposal, no spec_change decision', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
    await visionSession(fx, p.id);
    await specSession(fx, p.id);
    fx.scripted.kindScript('spec_change', {
      steps: [step.write(SPEC_PATH, SPEC_R1_REWRITTEN), step.write('src/sum.mjs', 'export const sum = (a, b) => a * b;\n'), step.result({ status: 'completed', summary: 'R1 restated', changes: [{ key: 'R1', kind: 'text_changed', reason: 'restated' }] })],
    });
    const head = refOid(p.repo.path, p.repo.ref);
    const request = await postChange(fx, { project: p.id }, 'Restate R1.');
    const item = workOf(fx.home, p.id, 'spec_change').at(-1);
    assert.ok(item, 'the request made spec_change work');
    const ended = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, item.id).find((r) => r.state === 'ended'), { max: 20, what: 'the spec_change run to end' });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'diff_violation'], `the change run is refused (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /src\/sum\.mjs/, 'naming the path');
    assert.deepEqual(decisionsOfKind(fx.home, p.id, 'spec_change'), [], 'no proposal reaches the owner');
    for (const ref of Object.keys(refsOf(p.repo.path)).filter((r) => r.startsWith('refs/surety/spec-change/'))) {
      let source = null;
      try {
        source = fileAt(p.repo.path, ref, 'src/sum.mjs');
      } catch {
        source = null;
      }
      assert.equal(source, null, `the side ref ${ref} carries no source file`);
    }
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'the integration branch did not move');
    assert.deepEqual(specRevisions(fx.home, p.id).map((r) => r.version), [1], 'no spec revision');
    assert.match(request.id ?? '', /^scr_/, 'the request was recorded');
  });
});
