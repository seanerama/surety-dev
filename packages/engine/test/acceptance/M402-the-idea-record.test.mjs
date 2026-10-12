// M402, the idea record (slice 31a; kernel lane). M5 plan §3.1 M402; D6-V01;
// D6 §1 step 1, §3.1, Appendix B.1; reading 5; F §3.2; SEAM.md §§343 to 345.
//
// (a) `POST /v1/projects` with `idea` in IBT's form and as a paragraph: the
//     idea record committed through the journal as version 1, baseline
//     `idea`, `baseline.idea_recorded`, `projects.idea_version` 1;
// (b) a Vision save whose identity block does not parse (an unknown key, a
//     tier outside the three, an area outside the closed list): committed as
//     a checkpoint, the parse error returned naming the key as the engine's
//     entry on the next turn, nothing registered from the block;
// (c) `idea_accept` answered: `idea_version` 2, the block's fields on the
//     project read, still baseline `idea`;
// (d) a project created with the owner's brief and no Vision session: a Spec
//     Writer session opens on it; no Vision run exists;
// (e) the route with `idea` absent: as built (M1's create), no idea record;
// (f) the two approval bindings: the create route's record (actor `human`,
//     the brief's blob) and the `idea_accept` decision bound to the
//     checkpoint's blob; distinct, each durable.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { consume, decision } from './harness/decisions.mjs';
import { createWithIdea, eventsAbout, projectRow, readProjectRaw, revisionRows, visionSession } from './harness/journey/drive.mjs';
import { BAD_IDENTITY, IDEA_BRIEF, IDEA_PARAGRAPH, IDEA_RECORD } from './harness/journey/reference.mjs';
import { createProject } from './harness/journal.mjs';
import { fileAt, refOid } from './harness/repos.mjs';
import { scriptedEngine } from './harness/runs.mjs';
import { closeSession, openSession, saveSession, sayAndSettle, scriptTurns, transcriptEntries, turnThatSays, turnThatWrites } from './harness/sessions.mjs';
import { makeProjectRepo } from './harness/repos.mjs';
import { join } from 'node:path';
import { withStore } from './harness/store.mjs';

const IDEA_PATH = '.surety/idea.md';

describe('M402 the idea record', () => {
  for (const [form, idea] of [
    ['IBT\'s form', IDEA_BRIEF],
    ['a paragraph', IDEA_PARAGRAPH],
  ]) {
    test(`(a) surety project create --idea with ${form}: .surety/idea.md version 1 through the journal, baseline idea, idea_version 1`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx, { idea });
      const head = refOid(p.repo.path, p.repo.ref);
      assert.equal(fileAt(p.repo.path, head, IDEA_PATH), idea, 'the idea record at the integration head is the brief, verbatim');
      const revisions = revisionRows(fx.home, p.id);
      assert.ok(revisions.some((r) => r.sha === head), 'the commit that holds it is a journaled revision of the project (D1 §3.1)');
      const row = projectRow(fx.home, p.id);
      assert.equal(row.idea_version, 1, 'projects.idea_version 1');
      assert.equal(row.baseline_state, 'idea', 'baseline idea');
      const recorded = eventsAbout(fx.home, 'baseline.idea_recorded', p.id);
      assert.equal(recorded.length, 1, 'one baseline.idea_recorded');
      assert.equal(recorded[0].payload?.version, 1);
      const read = await readProjectRaw(fx, p.id);
      assert.equal(read.project?.idea?.version ?? read.idea?.version, 1, `the project read shows the idea's version (${JSON.stringify(read.project?.idea ?? read.idea)})`);
    });
  }

  for (const [name, bad] of Object.entries(BAD_IDENTITY)) {
    test(`(b) a Vision save whose identity block does not parse (${name.replace('_', ' ')}): committed as a checkpoint, the error returned as the engine's entry naming ${bad.names}, nothing registered`, async (t) => {
      const fx = await scriptedEngine(t);
      const p = await createWithIdea(fx);
      const run = await openSession(fx, p.id, 'vision');
      scriptTurns(fx, run.id, [turnThatWrites({ [IDEA_PATH]: bad.text }, { reply: 'Rewritten.' }), turnThatSays('I see the error.')]);
      await sayAndSettle(fx, p.id, run.id, 'Rewrite the idea record.');
      const before = refOid(p.repo.path, p.repo.ref);
      const saved = await saveSession(fx, p.id, run.id);
      const head = refOid(p.repo.path, p.repo.ref);
      assert.notEqual(head, before, 'the save committed a checkpoint');
      assert.equal(saved.saved, true);
      assert.equal(saved.revision, head, 'the save names the checkpoint commit');
      assert.equal(fileAt(p.repo.path, head, IDEA_PATH), bad.text, 'the checkpoint holds the block as written');
      const findings = saved.findings ?? [];
      assert.ok(findings.some((f) => f.code === 'identity_block_invalid' && JSON.stringify(f).includes(bad.names)), `the save answers the parse finding identity_block_invalid naming ${bad.names} (${JSON.stringify(findings)})`);
      // The engine's entry, and the next turn carries it.
      const engineEntries = transcriptEntries(fx.home, run.id).filter((e) => e.speaker === 'engine');
      assert.ok(engineEntries.some((e) => (e.text ?? '').includes(bad.names)), `the engine's transcript entry names ${bad.names} (${JSON.stringify(engineEntries.map((e) => e.text))})`);
      const second = await sayAndSettle(fx, p.id, run.id, 'What was wrong?');
      const engineBefore = (second.read.transcript ?? []).filter((e) => e.speaker === 'engine' && e.turn <= 2);
      assert.ok(engineBefore.some((e) => (e.text ?? '').includes(bad.names)), 'the entry precedes the next turn in the read transcript');
      assert.equal(projectRow(fx.home, p.id).idea_version, 1, 'nothing registered from the block: idea_version still 1');
      const read = await readProjectRaw(fx, p.id);
      const identity = read.project?.idea?.identity ?? read.idea?.identity ?? null;
      assert.equal(identity, null, `no identity fields on the project read (${JSON.stringify(identity)})`);
    });
  }

  test('(c) idea_accept answered: idea_version 2, the identity block\'s fields on the project read, still baseline idea; no run launched by the answer', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const launchesBefore = fx.scripted.launches().length;
    const v = await visionSession(fx, p.id);
    assert.equal(v.answered.status, 'consumed');
    const row = projectRow(fx.home, p.id);
    assert.equal(row.idea_version, 2, 'idea_version 2');
    assert.equal(row.baseline_state, 'idea', 'still baseline idea: accepting the idea approves no specification');
    const read = await readProjectRaw(fx, p.id);
    const idea = read.project?.idea ?? read.idea;
    assert.equal(idea?.version, 2);
    assert.deepEqual([idea?.identity?.name, idea?.identity?.tier_recommendation, idea?.identity?.sensitive_areas], ['Tally', 'T2', 'none'], `the block's fields are read (${JSON.stringify(idea?.identity)})`);
    assert.deepEqual(idea?.identity?.environments, ['alpha']);
    assert.equal(fx.scripted.launches().length, launchesBefore + 2, 'two turns were launched and nothing else: the answer launches nothing (D1 §10.5)');
  });

  test('(d) a project created with the owner\'s brief and no Vision session: a Spec Writer session opens on it; no Vision run exists', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const run = await openSession(fx, p.id, 'spec_writer');
    assert.equal(run.role, 'spec_writer');
    const runs = withStore(fx.home, (db) => db.prepare('SELECT "role", "kind" FROM "runs" WHERE "project" = ?').all(p.id));
    assert.deepEqual(runs.map((r) => r.role), ['spec_writer'], 'no Vision run exists');
    await closeSession(fx, p.id, run.id, { refuse: true });
  });

  test('(e) the route with idea absent: as built, a project with no idea record', async (t) => {
    const fx = await scriptedEngine(t);
    const repo = makeProjectRepo(join(fx.root, 'repo-plain'), { files: { 'README.md': '# plain\n' } });
    const { id } = await createProject(fx.engine, { repoPath: repo.path, name: 'plain', tier: 'T2' });
    const row = projectRow(fx.home, id);
    assert.equal(row.idea_version ?? null, null, 'no idea version');
    assert.throws(() => fileAt(repo.path, refOid(repo.path, repo.ref), IDEA_PATH), 'no .surety/idea.md at the head');
    assert.deepEqual(eventsAbout(fx.home, 'baseline.idea_recorded', id), [], 'no baseline.idea_recorded');
  });

  test('(f) two approval bindings: the create route\'s record (actor human, the brief\'s blob) and the idea_accept decision bound to the checkpoint\'s blob; distinct, each durable across a restart', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createWithIdea(fx);
    const read1 = await readProjectRaw(fx, p.id);
    const idea1 = read1.project?.idea ?? read1.idea;
    assert.equal(idea1?.binding?.kind, 'create', `the owner-created idea's binding is the create route's record (${JSON.stringify(idea1)})`);
    assert.equal(idea1?.binding?.actor, 'human');
    assert.match(idea1?.blob ?? '', /^[0-9a-f]{40}$/, 'the brief\'s blob');
    const v = await visionSession(fx, p.id);
    const row = decision(fx.home, v.decisions[0].id);
    assert.match(row.manifest?.blob ?? '', /^[0-9a-f]{40}$/, `the idea_accept manifest binds the checkpoint's blob (${JSON.stringify(row.manifest)})`);
    assert.notEqual(row.manifest.blob, idea1.blob, 'a different blob from the brief\'s');
    await fx.engine.kill();
    await fx.start();
    const read2 = await readProjectRaw(fx, p.id);
    const idea2 = read2.project?.idea ?? read2.idea;
    assert.deepEqual([idea2?.version, idea2?.binding?.kind, idea2?.binding?.decision], [2, 'idea_accept', row.id], `after a restart the accepted product's binding is the decision (${JSON.stringify(idea2)})`);
    assert.equal(idea2?.blob, row.manifest.blob, 'and its blob is the one the decision bound');
    assert.deepEqual((idea2?.history ?? []).map((h) => [h.version, h.binding?.kind]), [[1, 'create'], [2, 'idea_accept']], `both bindings stay on record, distinct (${JSON.stringify(idea2?.history)})`);
  });
});
