// M503, the Designer's paths and everyone else's (slice 40; kernel lane).
// M6 plan §3.2 M503; D7 §3.3; G9; `339e116`; E147 item 2 (7); D1 §7.3;
// SEAM.md §§400, 483.
//
// (a) a Designer save touching source, `.surety/spec/`,
//     `.surety/architecture/`, `.surety/adrs/`, `.surety/roadmap/`,
//     `.surety/phases/`, `.surety/checks/` or the policy beside a design
//     file: refused whole, `diff_violation`, the workspace retained, the
//     refusal the next turn's engine entry;
// (b) touching `.surety/design/inventory/`: refused whole,
//     `DESIGN_INVENTORY_MODIFIED`;
// (c) a Builder, an authoring and a correction Verifier, a Reviewer, a Spec
//     Writer (session and change one-shot) and an Architect (session and
//     replan) writing under `.surety/design/`: `diff_violation` each;
// (d) a Designer symlink under `.surety/design/` resolving outside it:
//     judged by where it resolves, refused.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decisionsOfKind } from './harness/decisions.mjs';
import { assertRefused } from './harness/fixtures.mjs';
import { architectSession, createWithIdea, specSession, workOf } from './harness/journey/drive.mjs';
import { SPEC as TALLY_SPEC } from './harness/journey/reference.mjs';
import { postChange } from './harness/journey/review31b.mjs';
import { SPEC_PATH } from './harness/journey/spec34.mjs';
import { refOid } from './harness/repos.mjs';
import { addWork, runsOf, scriptedEngine, tickUntil } from './harness/runs.mjs';
import { script, step } from './harness/scripted.mjs';
import { closeSession, openSession, readSession, sayAndSettle, scriptTurns, transcriptEntries, turnResult } from './harness/sessions.mjs';
import { postSaveRaw } from './harness/session-lane.mjs';
import { INVENTORY_PATH } from './harness/design/reference.mjs';
import { openDesigner, toPublished } from './harness/design/drive.mjs';

const DESIGN_NOTE = step.write('.surety/design/design.md', '# Pantry: design\n\nA first note.\n');
// The role's own git in its workspace: every tracked file back to the base, every untracked one gone.
const RESET = [step.git('checkout', '--', '.'), step.git('clean', '-fdq')];
const FORBIDDEN = [
  ['source', 'server.mjs'],
  ['.surety/spec/', '.surety/spec/spec.md'],
  ['.surety/architecture/', '.surety/architecture/architecture.md'],
  ['.surety/adrs/', '.surety/adrs/ADR-002.md'],
  ['.surety/roadmap/', '.surety/roadmap/roadmap.md'],
  ['.surety/phases/', '.surety/phases/phase-1.md'],
  ['.surety/checks/', '.surety/checks/notes.md'],
  ['the policy', '.surety/policy.json'],
];

// A Designer session whose first turn runs `steps` and whose save is
// refused: 422 with `code`, naming `names`, nothing committed, the session
// idle, and the refusal the second turn's engine entry. Closed with --refuse.
async function refusedDesignerSave(fx, p, steps, { code = 'diff_violation', names }) {
  const run = await openDesigner(fx, p.id);
  scriptTurns(fx, run.id, [
    { steps: [...steps, step.result(turnResult({ reply: 'Written.', artifact_changed: true }))] },
    // The role reads the refusal and puts its workspace back, so the session can be closed.
    { steps: [...RESET, step.result(turnResult({ reply: 'I see the refusal; the change is undone.', artifact_changed: true }))] },
  ]);
  await sayAndSettle(fx, p.id, run.id, 'Write it.');
  const before = refOid(p.repo.path, p.repo.ref);
  const res = await postSaveRaw(fx, p.id, run.id);
  assert.equal(res.status, 422, `the save is refused 422 (${res.status} ${res.text?.slice(0, 400)})`);
  assert.ok(res.text.includes(code), `naming ${code} (${res.text.slice(0, 400)})`);
  assert.ok(res.text.includes(names), `naming ${names} (${res.text.slice(0, 400)})`);
  assert.equal(refOid(p.repo.path, p.repo.ref), before, 'refused whole: nothing committed, the design file included');
  assert.equal((await readSession(fx, p.id, run.id)).run.session_state, 'open_idle', 'the session idle, its workspace retained');
  await sayAndSettle(fx, p.id, run.id, 'What happened?');
  const entries = transcriptEntries(fx.home, run.id).filter((e) => e.speaker === 'engine' && e.turn === 2);
  assert.ok(entries.some((e) => (e.text ?? '').includes(code) && (e.text ?? '').includes(names)), `the refusal is the next turn's engine entry (${JSON.stringify(entries)})`);
  await closeSession(fx, p.id, run.id, { refuse: true });
}

// A one-shot of `kind` on `p` whose run writes under .surety/design/: failed diff_violation naming the path; nothing integrated.
async function refusedOneShot(fx, p, kind, steps, path) {
  const item = await addWork(fx.engine, p.id, kind);
  fx.scripted.script(item, [{ steps: [...steps, step.result({ status: 'completed', summary: 'done' })] }]);
  const head = refOid(p.repo.path, p.repo.ref);
  const ended = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, item).find((r) => r.state === 'ended'), { max: 20, what: `the ${kind} run to end` });
  assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'diff_violation'], `a ${kind} run writing ${path}: refused (${ended.reason_text})`);
  assert.match(ended.reason_text ?? '', new RegExp(path.replace(/[.]/g, '\\.')), 'naming the path');
  assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing integrated');
}

describe('M503 the Designer\'s paths and everyone else\'s', () => {
  test('(a) a Designer save touching source, .surety/spec/, architecture/, adrs/, roadmap/, phases/, checks/ or the policy beside its design: refused whole, diff_violation, the refusal the next turn\'s engine entry', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx);
    for (const [, path] of FORBIDDEN) await refusedDesignerSave(fx, p, [DESIGN_NOTE, step.write(path, '{"x": 1}\n')], { names: path });
  });

  test('(b) a Designer save touching .surety/design/inventory/: refused whole, DESIGN_INVENTORY_MODIFIED', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx);
    await refusedDesignerSave(fx, p, [DESIGN_NOTE, step.write(INVENTORY_PATH, '{"inventory_digest": "forged"}\n')], { code: 'DESIGN_INVENTORY_MODIFIED', names: INVENTORY_PATH });
    await refusedDesignerSave(fx, p, [DESIGN_NOTE, step.write('.surety/design/inventory/fixtures/extra.json', '{}\n')], { code: 'DESIGN_INVENTORY_MODIFIED', names: '.surety/design/inventory/fixtures/extra.json' });
  });

  test('(d) a Designer symlink under .surety/design/ resolving outside it: judged by where it resolves, refused', async (t) => {
    const fx = await scriptedEngine(t);
    const { p } = await toPublished(fx);
    await refusedDesignerSave(fx, p, [DESIGN_NOTE, step.symlink('.surety/design/spec-link.md', '../spec/spec.md')], { names: '.surety/design/spec-link.md' });
  });

  test('(c) a Builder, an authoring and a correction Verifier and a Reviewer writing under .surety/design/: diff_violation each', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
    await specSession(fx, p.id);
    await architectSession(fx, p.id, p.repo);
    for (const w of workOf(fx.home, p.id, 'check_authoring')) fx.scripted.script(w.id, [script.complete(), script.complete()]);
    fx.scripted.defaultScript(script.complete());
    for (const kind of ['fix', 'check_authoring', 'check_correction', 'review']) {
      const path = `.surety/design/${kind}.md`;
      await refusedOneShot(fx, p, kind, [step.write(path, `# written by ${kind}\n`)], path);
    }
  });

  test('(c) a Spec Writer session and an Architect session writing under .surety/design/ beside their own paths: refused whole, diff_violation', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    for (const [role, own] of [['spec_writer', step.write(SPEC_PATH, TALLY_SPEC)]]) {
      const run = await openSession(fx, p.id, role);
      scriptTurns(fx, run.id, [
        { steps: [own, step.write('.surety/design/design.md', '# x\n'), step.result(turnResult({ reply: 'Written.', artifact_changed: true }))] },
        { steps: [...RESET, step.result(turnResult({ reply: 'Undone.', artifact_changed: true }))] },
      ]);
      await sayAndSettle(fx, p.id, run.id, 'Write it.');
      const res = await postSaveRaw(fx, p.id, run.id);
      assertRefused(res, 422, 'diff_violation', `a ${role} save touching .surety/design/`);
      assert.ok(res.text.includes('.surety/design/design.md'), `naming the path (${res.text.slice(0, 300)})`);
      await sayAndSettle(fx, p.id, run.id, 'Undo it.');
      await closeSession(fx, p.id, run.id, { refuse: true });
    }
    await specSession(fx, p.id);
    const run = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, run.id, [{ steps: [step.write('.surety/architecture/architecture.md', '# Tally\n'), step.write('.surety/design/design.md', '# x\n'), step.result(turnResult({ reply: 'Written.', artifact_changed: true }))] }]);
    await sayAndSettle(fx, p.id, run.id, 'Write it.');
    const res = await postSaveRaw(fx, p.id, run.id);
    assertRefused(res, 422, 'diff_violation', 'an Architect save touching .surety/design/');
    assert.ok(res.text.includes('.surety/design/design.md'), `naming the path (${res.text.slice(0, 300)})`);
  });

  test('(c) a Spec Writer change one-shot and an Architect replan writing under .surety/design/: diff_violation each, no proposal raised', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx, { policy: { repair_attempts_max: 0 } });
    await specSession(fx, p.id);
    await architectSession(fx, p.id, p.repo);
    for (const w of workOf(fx.home, p.id, 'check_authoring')) fx.scripted.script(w.id, [script.complete(), script.complete()]);
    fx.scripted.defaultScript(script.complete());
    fx.scripted.kindScript('spec_change', { steps: [step.write(SPEC_PATH, TALLY_SPEC.replace('exactly, as a pure function', 'exactly as a pure function')), step.write('.surety/design/design.md', '# x\n'), step.result({ status: 'completed', summary: 'R1 restated', changes: [{ key: 'R1', kind: 'text_changed', reason: 'restated' }] })] });
    const head = refOid(p.repo.path, p.repo.ref);
    await postChange(fx, { project: p.id }, 'Restate R1.');
    const item = workOf(fx.home, p.id, 'spec_change').at(-1);
    const ended = await tickUntil(fx.engine, p.id, () => runsOf(fx.home, item.id).find((r) => r.state === 'ended'), { max: 20, what: 'the spec_change run to end' });
    assert.deepEqual([ended.outcome, ended.reason_class], ['failed', 'diff_violation'], `the change run is refused (${ended.reason_text})`);
    assert.match(ended.reason_text ?? '', /\.surety\/design\/design\.md/, 'naming the path');
    assert.deepEqual(decisionsOfKind(fx.home, p.id, 'spec_change'), [], 'no proposal');
    assert.equal(refOid(p.repo.path, p.repo.ref), head, 'nothing integrated');
    await refusedOneShot(fx, p, 'replan', [step.write('.surety/design/design.md', '# x\n')], '.surety/design/design.md');
  });
});
