// M514, the design decisions' bindings (slice 44; kernel lane). M6 plan
// §3.6 M514; D7 §7.4, §11, §10.3; G5; D1 §4.6, §10; SEAM.md §§485, 486,
// 502, 517.
//
// (a) `design_approval`'s binding: the design version, the architecture
//     version, the `design_check`, the asset manifest's version, the
//     selection, the tree's blobs, the spec version its batched change
//     creates (with the change's diff hash) and the inventory: every field on
//     the manifest;
// (b) a change to a binding between the preview and the answer: the asset
//     manifest's version (the owner's `surety design asset add`); the
//     architecture version (a later Architect revision that leaves the
//     inventory as it was); the selection, the tree and the check (a later
//     save narrowing the themes): each stales the approval. A save in
//     general is M505 (g)'s; another spec change approved first is M530
//     (c)'s; an inventory that moves is M530 (d)'s;
// (c) `design_due`'s binding to its held stages and stale screens; a change
//     to them (a second spec change staling another screen): stale and
//     re-raised;
// (d) `design_verdicts`' binding to the review file's hash and its evidence
//     records; a change to the file: stale;
// (e) each kind's 2 d target.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CODES, decision } from './harness/decisions.mjs';
import { phaseCompleted, pump, specRevisions } from './harness/journey/drive.mjs';
import { scriptedEngine, waitForIdle } from './harness/runs.mjs';
import { step } from './harness/scripted.mjs';
import { closeSession, sayAndSettle, scriptTurns, turnResult } from './harness/sessions.mjs';
import { postSaveRaw } from './harness/session-lane.mjs';
import { withStore } from './harness/store.mjs';
import { MANIFEST_PATH } from './harness/design/reference.mjs';
import { answerWith, assertNoSilentHold, gitJson, head, inventoryOf, openDesignDue, openDesigner, openOfKind, stageRow } from './harness/design/drive.mjs';
import { checkSession, variantOf } from './harness/design/check41.mjs';
import { assetAdd, blobBytes, pngOf, sha256hex } from './harness/design/assets43.mjs';
import { gitQuiet } from './harness/repos.mjs';
import {
  TWO_DAYS,
  architectureMd,
  designedPantry,
  laterArchitect,
  openDues,
  ownerChange,
  ownerReview,
  reviewFileOf,
  specOf,
} from './harness/design/plan44.mjs';

const stale = (res) => res.status === 409 && [CODES.stale, CODES.invalidated].includes(res.body?.code);
const refusedStale = (res, what) => assert.ok(stale(res), `${what}: the answer refused stale (D1 §4.6) (→ ${res.status} ${res.text?.slice(0, 400)})`);

describe('M514 the design decisions\' bindings', () => {
  test('(a) design_approval binds every field of D7 §7.4 on its manifest; (e) its and design_due\'s 2 d target', async (t) => {
    const fx = await scriptedEngine(t);
    const due0 = { at: null };
    const d = await designedPantry(fx, { name: 'pantry-binding', approve: false });
    const { p, batch, session } = d;
    due0.at = openDesignDue(fx.home, p.id);
    const m = batch.design_approval.manifest ?? {};
    const inventory = inventoryOf(p);
    const tree = gitJson(p, MANIFEST_PATH);
    assert.equal(m.design_version, 1, `design_version: the first design (${JSON.stringify(m)})`);
    assert.equal(m.architecture_version, 1, 'architecture_version');
    // The design_check record the approval is bound to: the passing save's (or the one the batch's raise ran on the same tree).
    const passing = designChecks(fx).filter((c) => c.outcome === 'passed').map((c) => c.id);
    assert.ok(passing.includes(m.design_check), `design_check: a passing design_checks row of this design (${JSON.stringify([m.design_check, passing])})`);
    assert.equal(m.asset_manifest_version, tree.version, 'asset_manifest_version: the manifest the design names');
    for (const k of ['selection', 'tree_blobs']) assert.ok(m[k] !== null && m[k] !== undefined && JSON.stringify(m[k]) !== '{}', `${k} bound (${JSON.stringify(m[k])})`);
    assert.equal(m.spec_version, 2, 'spec_version: the version the batched change creates, not the current one (D7 §7.4)');
    assert.equal(specRevisions(fx.home, p.id).length, 1, 'the current one is 1');
    const request = rowsOfRequest(fx, batch.spec_change.subject_id);
    assert.equal(m.spec_change_diff_hash, request.proposal_blob, `spec_change_diff_hash: the batched change's proposal (SEAM.md §517) (${JSON.stringify([m.spec_change_diff_hash, request.proposal_blob])})`);
    assert.equal(m.inventory_digest, inventory.inventory_digest, 'inventory_digest');
    // (e) the 2 d targets of design_approval and design_due.
    assert.equal(batch.design_approval.target_seconds, TWO_DAYS, 'design_approval: target_seconds 2 d');
    assert.equal(due0.at?.target_seconds, TWO_DAYS, 'design_due: target_seconds 2 d');
    void session;
  });

  test('(b) the asset manifest\'s version moved by the owner\'s asset add between the preview and the answer: the approval stale', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, batch } = await designedPantry(fx, { name: 'pantry-bind-assets', approve: false });
    const added = assetAdd(fx, p.id, 'favicon', 'default', 'favicon.png', pngOf(48, 48));
    assert.equal(added.status, 0, `surety design asset add (SEAM.md §508) (${added.stdout} ${added.stderr})`);
    assert.notEqual(gitJson(p, MANIFEST_PATH).version, batch.design_approval.manifest?.asset_manifest_version, 'the fixture is live: the manifest\'s version moved');
    refusedStale(await answerWith(fx, p.id, batch.design_approval, 'approve'), 'design_approval after the asset manifest moved');
  });

  test('(b) the architecture version moved by a later Architect revision leaving the inventory as it was: the approval stale', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-bind-arch', approve: false });
    const { p, ctx, batch } = d;
    // Nothing in flight before the Architect session (E147 item 4).
    await pump(fx, ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage verified', max: 80 });
    await waitForIdle(fx.home, p.id);
    const digest = inventoryOf(p).inventory_digest;
    await laterArchitect(fx, p.id, { '.surety/architecture/architecture.md': architectureMd('The API logs each request to standard error.') });
    await pump(fx, ctx, () => (rowsOfArchitecture(fx, p.id).length >= 2 ? true : undefined), { what: 'architecture version 2', max: 20 });
    assert.equal(inventoryOf(p).inventory_digest, digest, 'the fixture is live: the inventory is as it was');
    refusedStale(await answerWith(fx, p.id, batch.design_approval, 'approve'), 'design_approval after an architecture revision');
    assertNoSilentHold(fx.home, p.id, '(b) architecture');
  });

  test('(b) a later save narrowing the selection (the tree, the check, the selection): the approval stale', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-bind-save', approve: false });
    const { p, batch, model } = d;
    const narrowed = variantOf(model, (m) => {
      m.design.selection.themes = ['light'];
      delete m.tokens.themes.dark;
    });
    const out = await checkSession(fx, p.id, [{ name: 'the themes narrowed to light', model: narrowed }]);
    assert.equal(out.saves[0].res.status, 200, `the later save (${out.saves[0].res.text?.slice(0, 400)})`);
    await closeSession(fx, p.id, out.run.id, { refuse: true });
    refusedStale(await answerWith(fx, p.id, batch.design_approval, 'approve'), 'design_approval after a save narrowing the selection');
  });

  test('(c) design_due bound to its held stages and stale screens: a second change staling another screen stales it and re-raises it, one open', async (t) => {
    const fx = await scriptedEngine(t);
    const d = await designedPantry(fx, { name: 'pantry-bind-due' });
    const { p, ctx, v2 } = d;
    // Built to the end of phase 1 (nothing held, nothing in flight): the
    // stages verified and the phase complete, so its phase-gate checks have
    // recorded their results before the change binds them (objection 180).
    await pump(fx, ctx, () => ([1, 2, 3].every((n) => stageRow(fx.home, p.id, n)?.status === 'verified') ? true : undefined), { what: 'the three stages verified', max: 200 });
    await phaseCompleted(fx, ctx, 1, { max: 200 });
    await waitForIdle(fx.home, p.id);
    const reword = (reqs, key, statement) => reqs.map((r) => (r.key === key ? { ...r, statement } : r));
    const v3reqs = reword(v2.requirements, 'R2', 'A user sees every item of the pantry, and its quantity, in a web browser.');
    await ownerChange(fx, ctx, { text: specOf({ version: 3, requirements: v3reqs }), changes: [{ key: 'R2', kind: 'text_changed', reason: 'R2 names the quantity' }], say: 'Show the quantity on the web list.' });
    const first = await pump(fx, ctx, () => openDesignDue(fx.home, p.id) ?? undefined, { what: 'design_due raised for the stale web screen', max: 10 });
    assert.deepEqual((first.evidence?.stale_screens ?? []).map((s) => `${s.screen}/${s.target}`), ['S1/web'], `naming S1 on web (${JSON.stringify(first.evidence)})`);
    assert.ok(first.manifest && JSON.stringify(first.manifest).includes('S1'), `its manifest binds the stale screens (SEAM.md §517) (${JSON.stringify(first.manifest)})`);
    assert.ok('held_stages' in (first.manifest ?? {}) && 'stale_screens' in (first.manifest ?? {}), `and the held stages (${JSON.stringify(first.manifest)})`);
    // The first change's own work ended before the second is made (objection 180).
    await waitForIdle(fx.home, p.id);
    const v4reqs = reword(v3reqs, 'R3', 'A user sees every item of the pantry, and its quantity, in the Android app.');
    await ownerChange(fx, ctx, { text: specOf({ version: 4, requirements: v4reqs }), changes: [{ key: 'R3', kind: 'text_changed', reason: 'R3 names the quantity' }], say: 'And on Android.' });
    const next = await pump(fx, ctx, () => {
      const x = openDesignDue(fx.home, p.id);
      return x && (x.evidence?.stale_screens ?? []).length === 2 ? x : undefined;
    }, { what: 'design_due re-raised naming both stale screens', max: 10 });
    assert.deepEqual((next.evidence.stale_screens ?? []).map((s) => `${s.screen}/${s.target}`).sort(), ['S1/web', 'S2/android'], 'its subjects updated');
    assert.notEqual(decision(fx.home, first.id).status, 'open', 'the earlier generation no longer open');
    refusedStale(await answerWith(fx, p.id, first, 'later', { until: new Date(Date.now() + 3600_000).toISOString() }), 'the earlier design_due');
    assert.equal(openDues(fx.home, p.id).length, 1, 'one open design_due');
    assertNoSilentHold(fx.home, p.id, '(c)');
  });

  test('(d) design_verdicts bound to the review file\'s hash and its evidence: a change to the file stales it; (e) its 2 d target', async (t) => {
    const fx = await scriptedEngine(t);
    const { p, ctx } = await designedPantry(fx, { name: 'pantry-bind-verdicts' });
    const path = '.surety/design/reviews/review-1.json';
    const screens = [{ target: 'android', key: 'S2', verdict: 'matches', observed_on: 'emulator', evidence: [], deltas: [] }];
    const review = await ownerReview(fx, p.id, { files: { [path]: reviewFileOf({ screens }) } });
    assert.equal(review.close.status, 200, `the review's close (${review.close.text?.slice(0, 400)})`);
    const verdicts = await pump(fx, ctx, () => openOfKind(fx.home, p.id, 'design_verdicts').at(-1), { what: 'design_verdicts', max: 20 });
    const m = verdicts.manifest ?? {};
    const blob = { git: gitBlobId(p, path), sha256: sha256hex(blobBytes(p.repo.path, head(p), path)) };
    assert.ok(JSON.stringify(m).includes(blob.git) || JSON.stringify(m).includes(blob.sha256), `the manifest binds the review file's hash (SEAM.md §517) (${JSON.stringify(m)}; blob ${JSON.stringify(blob)})`);
    assert.ok('evidence' in m, `and its evidence records (${JSON.stringify(m)})`);
    assert.equal(verdicts.target_seconds, TWO_DAYS, 'design_verdicts: target_seconds 2 d');
    // A Designer save changing the review file.
    const changed = [{ ...screens[0], deltas: [{ owner_words: 'The add button is too small.', kind: 'design' }], verdict: 'deltas' }];
    const s = await checkSessionFiles(fx, p.id, { [path]: reviewFileOf({ screens: changed }) });
    assert.equal(s.status, 200, `the save changing the review file (${s.text?.slice(0, 400)})`);
    refusedStale(await answerWith(fx, p.id, verdicts, 'confirm'), 'design_verdicts after its review file changed');
  });
});

// ---- local reads ----------------------------------------------------------------------------

const designChecks = (fx) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "design_checks" ORDER BY rowid').all());
const rowsOfRequest = (fx, id) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "spec_change_requests" WHERE "id" = ?').get(id));
const rowsOfArchitecture = (fx, project) => withStore(fx.home, (db) => db.prepare('SELECT * FROM "architecture_revisions" WHERE "project" = ? ORDER BY "version"').all(project));
const gitBlobId = (p, path) => gitQuiet(p.repo.path, ['rev-parse', `${head(p)}:${path}`]).trim();
// One Designer session writing `files`, saved; the save's answer.
async function checkSessionFiles(fx, project, files) {
  const run = await openDesigner(fx, project);
  scriptTurns(fx, run.id, [{ steps: [...Object.entries(files).map(([path, content]) => step.write(path, content)), step.result(turnResult({ reply: 'The review file is revised.', artifact_changed: true }))] }]);
  await sayAndSettle(fx, project, run.id, 'Record the delta I found.');
  return postSaveRaw(fx, project, run.id);
}
