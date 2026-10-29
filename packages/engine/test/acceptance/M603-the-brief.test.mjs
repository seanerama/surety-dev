// M603, the brief (the owner's draft M7 plan §3, row M603; request §4, §5;
// rulings R3, R6 of 2026-10-28; SEAM.md §575). Kernel lane.
//
//   (a) a typed idea and an imported Markdown idea: a prototype_brief record
//       with 3 to 5 objectives, each bound to a requirement of the new spec
//       revision; spec_approval raised with brief_record, brief_digest,
//       brief_version and iteration in its manifest; the brief readable
//       through GET …/records/:id as text.
//   (b) an idea that cannot fit five objectives: a smaller scope proposed,
//       the cuts listed in left_out; a brief of six objectives, or one that
//       leaves a requirement unnamed, refused: nothing silently dropped.
//   (c) the record's shape: the engine-filled fields (target, models,
//       limits, preparation, stop conditions) apart from the model's; an
//       engine field sent by the model refused.
//   (d) the exposure note: the configured port, and that the engine has not
//       checked reachability; never "private".
//   (e) a second preparation while the first brief's spec_approval is open:
//       that approval invalidated, answering it refused 409.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { configure, configContent } from './harness/deploy/kernel.mjs';
import { sharedFixture } from './harness/gates.mjs';
import {
  EXTRA_REQS,
  LIMIT_KEYS,
  PROTO,
  REQS,
  answer,
  answerOpen,
  currentIt,
  decisionRead,
  decisionsOfProject,
  iterationRead,
  modelBrief,
  newApp,
  ok,
  openDecisionsRead,
  prepScript,
  projectRead,
  protoEngine,
  pump,
  recordsOfKind,
  runsOfIteration,
  specText,
  statusIs,
  workOfProject,
} from './harness/prototype.mjs';
import { withStore } from './harness/store.mjs';

const IMPORTED_IDEA = `# Idea: Tasks

## What

A small task list for one person: add a task, list the tasks, mark one done.

## Why

To try the idea before building it properly.

## Out of scope

- accounts
- sharing
`;

// A prototype whose next preparation follows `script`, run to its brief (or
// to the preparation's end when the brief is refused).
async function prepared(fx, name, script, { idea, before: beforePrep } = {}) {
  const { id } = await newApp(fx, { name, ...(idea ? { idea } : {}) });
  const it = await currentIt(fx, id);
  if (beforePrep) await beforePrep(id);
  await answerOpen(fx, id, PROTO.preparation.decision);
  const [item] = workOfProject(fx.home, id);
  fx.scripted.script(item.id, [script]);
  await pump(fx, id, async () => {
    const r = await iterationRead(fx, id, it.id);
    return r.iteration.status === 'awaiting_brief_approval' || (r.outcome.next_step === 'prepare again or discard' && r.usage.runs.every((x) => x.finished_at)) ? r : undefined;
  }, { what: `${name}: the preparation to end` });
  return { id, it: (await iterationRead(fx, id, it.id)) };
}

const recordText = async (fx, p, rec) => {
  const res = await fx.engine.get(`/v1/projects/${p}/records/${rec}`);
  assert.equal(res.status, 200, `GET …/records/${rec} (→ ${res.status})`);
  return res.text;
};

// The preparation's run refused at acceptance: what the iteration says of it.
function refusedAs(read, fragment, what) {
  assert.equal(read.iteration.status, 'preparing', `${what}: the iteration stays preparing`);
  assert.equal(read.iteration.brief.record, null, `${what}: no brief is recorded`);
  const [run] = read.usage.runs;
  assert.notEqual(run.outcome, 'completed', `${what}: the preparation run is not accepted (${run.outcome}, ${run.reason_class})`);
  assert.equal(read.outcome.next_step, 'prepare again or discard');
  assert.ok((read.outcome.reason ?? '').includes(fragment), `${what}: the reason says why (${read.outcome.reason})`);
}

describe('M603 the brief', () => {
  const shared = sharedFixture();
  const S = {};
  before(async () => {
    S.fx = await protoEngine(shared.context);
  });
  after(() => shared.cleanup());

  test('(a) a typed idea and an imported Markdown idea each reach a prototype_brief record of 3 to 5 objectives bound to the new spec revision\'s requirements; spec_approval binds the brief; the brief is readable as text', async () => {
    const { fx } = S;
    for (const [name, idea] of [['Tasks typed', undefined], ['Tasks imported', IMPORTED_IDEA]]) {
      const { id, it: read } = await prepared(fx, name, prepScript(), { idea });
      if (idea) {
        const p = await projectRead(fx, id);
        assert.ok(p.idea, `${name}: the imported idea is recorded (${JSON.stringify(p.idea)})`);
        const row = withStore(fx.home, (db) => db.prepare('SELECT "idea_version", "idea_blob" FROM "projects" WHERE "id" = ?').get(id));
        assert.deepEqual([row.idea_version, typeof row.idea_blob], [1, 'string'], `${name}: the Markdown idea is idea version 1`);
      }
      assert.equal(read.iteration.status, 'awaiting_brief_approval', `${name}: the brief awaits approval`);
      const recs = recordsOfKind(fx.home, id, PROTO.preparation.record_kind);
      assert.equal(recs.length, 1, `${name}: one prototype_brief record`);
      assert.equal(read.iteration.brief.record, recs[0].id, `${name}: the iteration names it`);
      const objectives = read.brief.objectives;
      assert.ok(objectives.length >= PROTO.objectives.min && objectives.length <= PROTO.objectives.max, `${name}: 3 to 5 objectives (${objectives.length})`);
      // As text, whole: the record served is the brief the iteration serves.
      const text = await recordText(fx, id, recs[0].id);
      assert.deepEqual(JSON.parse(text).brief, read.brief, `${name}: the record, read as text, is the brief`);
      const [spec] = (await openDecisionsRead(fx, id)).filter((d) => d.kind === 'spec_approval');
      assert.ok(spec, `${name}: the brief is put to the owner as spec_approval`);
      const m = (await decisionRead(fx, id, spec.id)).dependency_manifest;
      assert.deepEqual([m.brief_record, m.brief_digest, m.brief_version, m.iteration], [recs[0].id, recs[0].sha256, read.brief.version, read.iteration.id], `${name}: its manifest binds the brief's record, digest, version and the iteration`);
      assert.equal(read.brief.version, 1, `${name}: the brief is version 1 of the specification`);
      // Approved: the new spec revision, whose requirements are the objectives', one each.
      await answerOpen(fx, id, 'spec_approval');
      const revs = withStore(fx.home, (db) => db.prepare('SELECT * FROM "spec_revisions" WHERE "project" = ? ORDER BY "version"').all(id));
      assert.deepEqual(revs.map((r) => r.version), [read.brief.version], `${name}: spec revision ${read.brief.version}, the brief's`);
      const keys = withStore(fx.home, (db) => db.prepare('SELECT "key" FROM "requirements" WHERE "project" = ? ORDER BY "key"').all(id)).map((r) => r.key);
      assert.deepEqual(keys, REQS.map((r) => r.key), `${name}: its requirements`);
      for (const key of keys) assert.equal(objectives.filter((o) => new RegExp(`\\b${key}\\b`).test(o)).length, 1, `${name}: requirement ${key} is named by exactly one objective`);
      assert.equal((await iterationRead(fx, id, read.iteration.id)).iteration.brief.spec_revision, revs[0].id, `${name}: the iteration binds the approved revision`);
    }
  });

  test('(b) an idea that cannot fit five objectives: five, the cuts listed in left_out; six objectives, or a requirement no objective names, refused', async () => {
    const { fx } = S;
    const five = [...REQS, ...EXTRA_REQS];
    const cuts = ['reminders by email', 'sharing a list with others', 'calendar sync'];
    const fit = await prepared(fx, 'Tasks big', prepScript({ spec: specText({ reqs: five }), brief: modelBrief({ objectives: five.map((r) => `${r.key}: ${r.statement}`), left_out: cuts }) }));
    assert.equal(fit.it.iteration.status, 'awaiting_brief_approval', 'the smaller scope is prepared');
    assert.equal(fit.it.brief.objectives.length, PROTO.objectives.max, 'five objectives');
    assert.deepEqual(fit.it.brief.left_out, cuts, 'what was cut is listed in left_out');
    assert.deepEqual(fit.it.limitations.left_out, cuts, 'and kept beside the limitations');

    const six = [...five, { key: 'R6', title: 'Reminders', statement: 'A user is reminded of a due task.', crit: 'Given a due task, when its time comes, then a reminder is shown.' }];
    const tooMany = await prepared(fx, 'Tasks six', prepScript({ spec: specText({ reqs: six }), brief: modelBrief({ objectives: six.map((r) => `${r.key}: ${r.statement}`) }) }));
    refusedAs(tooMany.it, 'brief.objectives lists 6: a prototype has 3 to 5 observable objectives (R3); if the idea does not fit, propose a smaller scope and list what is left out in brief.left_out; never drop a requirement silently', 'six objectives');

    const four = [...REQS, EXTRA_REQS[0]];
    const dropped = await prepared(fx, 'Tasks dropped', prepScript({ spec: specText({ reqs: four }), brief: modelBrief({ objectives: [...REQS.map((r) => `${r.key}: ${r.statement}`), 'Due dates are shown'] }) }));
    refusedAs(dropped.it, 'no objective names requirement R4', 'a requirement no objective names');
  });

  test('(c) the record\'s shape: the engine-filled fields apart from the model\'s; an engine field sent by the model refused', async () => {
    const { fx } = S;
    const { id, it: read } = await prepared(fx, 'Tasks shape', prepScript());
    const [rec] = recordsOfKind(fx.home, id, PROTO.preparation.record_kind);
    const { brief } = JSON.parse(await recordText(fx, id, rec.id));
    assert.deepEqual(Object.keys(brief), PROTO.brief_fields, 'exactly the brief\'s fields, in its order');
    const model = modelBrief();
    for (const k of PROTO.brief_fields.filter((f) => !PROTO.engine_fields.includes(f))) assert.deepEqual(brief[k], model[k], `${k}: the Spec Writer's, as it reported it`);
    // The engine's: what it serves, never the model's.
    assert.equal(brief.version, 1);
    assert.ok(!Number.isNaN(Date.parse(brief.prepared_at)), 'prepared_at is a time');
    assert.deepEqual([brief.target.environment, brief.target.kind], ['alpha', 'local_service'], 'the target from the specification\'s environment');
    assert.ok(Array.isArray(brief.models) && brief.models.length >= 1 && brief.models.every((m) => m.provider === 'scripted' && m.roles.length > 0), `the models the roles resolve to (${JSON.stringify(brief.models)})`);
    assert.deepEqual(brief.models.flatMap((m) => m.roles).sort(), ['architect', 'builder', 'spec_writer', 'verifier'], 'every build role named once');
    for (const k of LIMIT_KEYS) assert.equal(brief.limits[k], read.iteration.limits[k], `limits.${k}: the policy's`);
    assert.match(brief.limits.reservation_rule, /^Each run is given an effective allowance at dispatch: the lower of the per-run limit \(budget_run_billable_tokens 5000000\) and what the iteration has left/, 'the reservation rule states the effective allowance (S5)');
    assert.equal(brief.preparation.runs, 1);
    assert.ok(Array.isArray(brief.stop_conditions) && brief.stop_conditions.length > 0);

    for (const field of ['target', 'limits', 'stop_conditions']) {
      const sent = await prepared(fx, `Tasks sends ${field}`, prepScript({ brief: { ...modelBrief(), [field]: field === 'target' ? { kind: 'local_service', description: 'private', exposure_note: 'private' } : field === 'limits' ? { prototype_budget_tokens: 50_000_000 } : ['none'] } }));
      refusedAs(sent.it, `brief.${field} is the engine's to fill from what it serves, not the Spec Writer's`, `the model sending ${field}`);
      assert.equal(recordsOfKind(fx.home, sent.id, PROTO.preparation.record_kind).length, 0, `the model sending ${field}: no brief record`);
    }
  });

  test('(d) the exposure note states the configured port and that the engine has not checked reachability; never "private"', async () => {
    const { fx } = S;
    const port = 18123;
    const configured = await prepared(fx, 'Tasks port', prepScript(), { before: (id) => configure(fx.engine, id, 'alpha', configContent({ start: [process.execPath, 'server.mjs'], port })) });
    const note = configured.it.brief.target.exposure_note;
    assert.ok(note.includes(`port ${port}`), `the note names the configured port (${note})`);
    assert.match(note, /which the engine has not checked/, 'and says the engine has not checked who can reach it');
    assert.doesNotMatch(JSON.stringify(configured.it.brief.target), /private/i, 'never "private"');
    const unconfigured = await prepared(fx, 'Tasks no port', prepScript());
    const note2 = unconfigured.it.brief.target.exposure_note;
    assert.match(note2, /has no configuration recorded yet: its port and who can reach it are not known, and the engine has not checked its exposure/, `unconfigured: the port is not known, nothing is claimed (${note2})`);
    assert.doesNotMatch(JSON.stringify(unconfigured.it.brief.target), /private/i, 'never "private"');
  });

  test('(e) a second preparation while the first brief\'s spec_approval is open invalidates it; answering it is refused 409', async () => {
    const { fx } = S;
    const { id, it: read } = await prepared(fx, 'Tasks twice', prepScript());
    const first = (await openDecisionsRead(fx, id)).find((d) => d.kind === 'spec_approval');
    assert.ok(first);
    const asked = await ok(fx.engine.post(`/v1/projects/${id}/iterations/${read.iteration.id}/prepare`, {}), 201, 'POST …/prepare while the brief awaits approval');
    const d = await decisionRead(fx, id, asked.decision.id);
    await ok(answer(fx, id, d), 200, 'the second preparation approved');
    const item = workOfProject(fx.home, id).filter((w) => w.kind === PROTO.preparation.work_kind).at(-1);
    fx.scripted.script(item.id, [prepScript({ brief: modelBrief({ app: 'Tasks, changed' }) })]);
    await pump(fx, id, async () => {
      const r = await iterationRead(fx, id, read.iteration.id);
      return r.iteration.brief.record !== read.iteration.brief.record && r.iteration.status === 'awaiting_brief_approval' ? r : undefined;
    }, { what: 'the second brief' });
    const stale = await decisionRead(fx, id, first.id);
    assert.equal(stale.status, 'invalidated', 'the first brief\'s spec_approval is invalidated');
    assert.match(stale.invalidated_reason ?? '', /a later brief/, 'naming the later brief');
    const refused = await answer(fx, id, first);
    assert.equal(refused.status, 409, `answering it is refused (→ ${refused.status} ${refused.text})`);
    const open = (await openDecisionsRead(fx, id)).filter((x) => x.kind === 'spec_approval');
    assert.equal(open.length, 1, 'one spec_approval open: the second brief\'s');
    assert.equal((await decisionRead(fx, id, open[0].id)).dependency_manifest.brief_record, (await iterationRead(fx, id, read.iteration.id)).iteration.brief.record);
    assert.equal(decisionsOfProject(fx.home, id, 'spec_approval').filter((x) => x.status === 'consumed').length, 0, 'nothing was approved');
    assert.equal(runsOfIteration(fx.home, read.iteration.id).length, 2, 'two preparation runs, one per approval');
  });
});
