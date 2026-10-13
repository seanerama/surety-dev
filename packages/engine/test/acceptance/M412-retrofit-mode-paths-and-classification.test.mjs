// M412, retrofit mode's paths and classification (slice 32; kernel lane).
// M5 plan §3.2 M412; D6-R04; D6 §8.2, §2.5, §8.1 step 3; E6 (the floor from
// day one); SEAM.md §§344, 381.
//   (a) a retrofit Spec Writer session and a retrofit Architect session: the
//       package names the repository as the input and asks for the retrofit
//       marks; the products carry `reverse_engineered`, `Origin` and
//       `reconstructed`;
//   (b) a retrofit session's save touching source, `test/` or
//       `.surety/checks/`: refused whole, 422 `diff_violation` naming the
//       path, the workspace retained;
//   (c) the module map in `full` and in `scoped` mode: every module
//       classified;
//   (d) an Architect save dropping a module's classification: refused as
//       architecture (`plan_refused`), naming the module.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRefused } from './harness/fixtures.mjs';
import { baselineTexts, modulesOf, requirementsOf } from './harness/journey/drive.mjs';
import { closeSession, openSession, packageOf, readSession, sayAndSettle, scriptTurns, turnResult, turnThatDumps, turnThatWrites } from './harness/sessions.mjs';
import { step } from './harness/scripted.mjs';
import { FULL_ANSWERS, adoptProject, chooseMode, confirmAndApprove, retrofitArchitectSession, retrofitEngine, retrofitSpecSession } from './harness/retrofit/drive.mjs';
import { ADR_KEY, MODULES_JSON, REQUIREMENTS, SPEC, retrofitArchitectFiles, retrofitSpecText } from './harness/retrofit/products.mjs';
import { SUM_TEST, UNPUSHED, refOid } from './harness/retrofit/repo.mjs';

const packageText = (pkg) => Object.values(pkg ?? {}).join('\n');

describe('M412 retrofit mode: the paths and the classification', () => {
  test('(a) the retrofit packages name the repository as the input and the marks; the products carry reverse_engineered, Origin and reconstructed', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    const spec = await openSession(fx, p.id, 'spec_writer');
    scriptTurns(fx, spec.id, [turnThatDumps({ '.surety/spec/spec.md': SPEC }, { reply: 'Described.', done: true })]);
    await sayAndSettle(fx, p.id, spec.id, 'Describe the repository.');
    const specPkg = packageText(packageOf(fx, spec.id));
    assert.ok(specPkg.length > 0, 'the fixture is live: the Spec Writer dumped its package');
    assert.match(specPkg, /retrofit/i, 'the Spec Writer package is the retrofit variant');
    assert.match(specPkg, /Origin/, 'it asks for the Origin column');
    assert.match(specPkg, /Claims and reality/, 'and §12');
    assert.match(specPkg, /server\.mjs|src\/sum\.mjs/, 'it names the repository\'s code as the input');
    await closeSession(fx, p.id, spec.id);
    await confirmAndApprove(fx, p.id, FULL_ANSWERS);
    assert.ok(requirementsOf(fx.home, p.id).every((r) => r.reverse_engineered), 'every produced requirement reverse_engineered');

    const arch = await openSession(fx, p.id, 'architect');
    scriptTurns(fx, arch.id, [turnThatDumps(retrofitArchitectFiles({ revision: refOid(p.repo.path, p.repo.ref) }), { reply: 'Reconstructed.', done: true })]);
    await sayAndSettle(fx, p.id, arch.id, 'Reconstruct the architecture.');
    const archPkg = packageText(packageOf(fx, arch.id));
    assert.match(archPkg, /retrofit/i, 'the Architect package is the retrofit variant');
    assert.match(archPkg, /reconstructed/, 'it asks for reconstructed ADRs');
    assert.match(archPkg, /conformance/, 'and a conformance phase');
    const closed = await closeSession(fx, p.id, arch.id);
    assert.ok((closed.decisions ?? []).length > 0, `the retrofit Architect close raises its approvals (${JSON.stringify(closed)})`);
    const [adr] = baselineTexts(fx.home, p.id, 'adr').filter((a) => a.key === ADR_KEY);
    assert.ok(!adr || /reconstructed: true/.test(adr.text), 'a registered ADR keeps its reconstructed mark');
  });

  test('(b) a retrofit save touching source, test/ or .surety/checks/: 422 diff_violation naming the path, the workspace retained', async (t) => {
    const fx = await retrofitEngine(t);
    const p = await adoptProject(fx);
    await chooseMode(fx, p.id, 'full');
    // Each path, then what puts the workspace back (A's content, or nothing).
    const cases = [
      ['src/sum.mjs', (steps) => steps.push(step.write('src/sum.mjs', UNPUSHED['src/sum.mjs']))],
      ['test/sum.test.mjs', (steps) => steps.push(step.write('test/sum.test.mjs', SUM_TEST))],
      ['.surety/checks/defs/x.json', (steps) => steps.push(step.delete('.surety/checks/defs/x.json'))],
    ];
    for (const [path, restore] of cases) {
      const run = await openSession(fx, p.id, 'spec_writer');
      const back = [];
      restore(back);
      scriptTurns(fx, run.id, [
        turnThatWrites({ '.surety/spec/spec.md': SPEC, [path]: 'changed by a retrofit session\n' }, { reply: 'I also fixed something.' }),
        { steps: [...back, step.result(turnResult({ reply: 'Put back.', artifact_changed: true, done: true }))] },
      ]);
      await sayAndSettle(fx, p.id, run.id, 'Describe the repository.');
      const head = refOid(p.repo.path, p.repo.ref);
      const res = await fx.engine.post(`/v1/projects/${p.id}/sessions/${run.id}/save`, {});
      assertRefused(res, 422, 'diff_violation', `a save touching ${path}`);
      assert.ok(JSON.stringify(res.body.subject).includes(path), `the refusal names ${path} (${res.text})`);
      assert.equal(refOid(p.repo.path, p.repo.ref), head, 'refused whole: the integration branch did not move');
      const read = await readSession(fx, p.id, run.id);
      assert.equal(read.run.session_state, 'open_idle', 'the session stays, its workspace retained');
      // The role puts the path back; the session is closed without a decision.
      await sayAndSettle(fx, p.id, run.id, 'Put that back.');
      await closeSession(fx, p.id, run.id, { refuse: true });
    }
  });

  test('(c) every module classified in full and in scoped mode; (d) an Architect save dropping a module\'s classification refused, naming it', async (t) => {
    for (const mode of ['full', 'scoped']) {
      const fx = await retrofitEngine(t);
      const p = await adoptProject(fx);
      await chooseMode(fx, p.id, mode);
      const descriptive = mode === 'scoped' ? REQUIREMENTS.map((r) => (r.module === 'service' ? { ...r, descriptive: true } : r)) : REQUIREMENTS;
      await retrofitSpecSession(fx, p.id, { spec: retrofitSpecText({ requirements: descriptive }) });
      const answers = mode === 'scoped' ? { R1: 'confirm' } : FULL_ANSWERS;
      await confirmAndApprove(fx, p.id, answers);
      const modules = modulesOf(fx.home, p.id);
      assert.deepEqual(modules.map((m) => [m.name, Array.isArray(m.sensitive_areas)]), [['lib', true], ['service', true]], `${mode}: every module recorded with its classification`);
      // (d) the module map without `service`'s classification.
      const dropped = { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => (m.name === 'service' ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'sensitive_areas')) : m)) };
      const arch = await retrofitArchitectSession(fx, p.id, p.repo, { modules: dropped, answer: 'none' });
      assert.equal(arch.closeRes.status, 422, `${mode}: the close is refused (→ ${arch.closeRes.status} ${arch.closeRes.text})`);
      assert.match(JSON.stringify(arch.closeRes.body?.subject ?? {}), /service/, `${mode}: naming the module`);
    }
  });
});
