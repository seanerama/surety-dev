// M528, the owner-invoked review of a native build (slice 45; kernel lane).
// M6 plan §3.7 M528; D7 §10.5, §10.1, §3.4, §14; G13; A.6, A.7; BS6 §4.1
// rules 21, 22, 26; SEAM.md §§502, 516, 521, 522, 524.
//
// Pantry designed and approved before build (every slot a placeholder), its
// phase 1 built and complete, the project idle; then the owner reviews his Android
// build, which M6 cannot run, by `surety design review` and `POST
// …/design/reviews`.
// (a) `surety design review --target android --build "1.4.2 (37)"
//     --evidence a.png b.webm`, and the route with `candidate`: a review
//     subject `{kind: owner_build, target, build_ref}` with the identifier
//     verbatim, a Designer session in review mode bound to it, the candidate
//     recorded as his word and not verified;
// (b) the evidence: a valid PNG, WebP, JPEG, MP4 and WebM, each a
//     `design_evidence` record with digest, target, build reference and his
//     `observed_on`, provenance `owner_supplied`, never decoded beyond its
//     header; a file whose magic bytes contradict its name; past
//     `design_review_evidence_max_bytes` per file and per review (lowered):
//     `design_evidence_invalid` (422) with `REVIEW_EVIDENCE_INVALID`;
// (c) the bounds' defaults: 64 MiB a file, 512 MiB a review;
// (d) the package: screenshots as images, recordings by name only, each
//     labelled `owner_supplied`;
// (e) a target the inventory lacks: `design_review_target_unknown` (422);
// (f) every projection labels owner-supplied, owner-reported and
//     engine-observed apart, and counts no owner item as engine-observed;
// (g) `design_due` for a product with no web target names this command;
// (h) under `off`: refused.
//
// The evidence files are the test's own bytes with valid headers (rule 22):
// no real image, no recording, nothing decoded or played. No browser,
// emulator or device. No unit (kernel lane).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { getPolicy } from './harness/journal.mjs';
import { candidatesOfProject, phaseCompleted, pump } from './harness/journey/drive.mjs';
import { scriptedEngine, waitForIdle } from './harness/runs.mjs';
import { createPantry } from './harness/design/drive.mjs';
import { setPolicy } from './harness/design/assets43.mjs';
import { designedPantry } from './harness/design/plan44.mjs';
import {
  EVIDENCE_FILE_DEFAULT,
  EVIDENCE_FILE_KEY,
  EVIDENCE_FORMATS,
  EVIDENCE_REVIEW_DEFAULT,
  EVIDENCE_REVIEW_KEY,
  MIB,
  REVIEW_FILE,
  androidOnlyAtAlpha,
  countOf,
  designReview,
  designVerdicts,
  designerRuns,
  driveReview,
  evidenceBytes,
  evidenceFiles,
  evidenceRow,
  extensionOf,
  humanTestOf,
  openVerdicts,
  packageJson,
  packageOfLaunch,
  postReview,
  readDesign,
  reviewInDesign,
  reviewJson,
  reviewRow,
  reviewsOf,
} from './harness/design/review45.mjs';

const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BUILD = '1.4.2 (37)';
const labelsOf = (value) => JSON.stringify(value ?? null);
// The refusal's reasons as text (A.6: `design_evidence_invalid`, with its reasons).
const refusalText = (res) => `${res.stdout} ${res.stderr}`;
// "Makes no operation" (SEAM.md §§522, 536; objection 192): no D4 operation of the project
// (deploy, rollback, teardown, publish). The review session's own git journal operations for its
// workspace and saves (D1 §7.3; D6 §2.1) are not effects on the build he names.
const D4_OPERATIONS = `"project" = ? AND "kind" IN ('deploy', 'rollback', 'teardown', 'publish')`;
// The window's counts: engine observations, check executions, D4 operations.
const countsOf = (home, project) => ({ observations: countOf(home, 'records', '"kind" = \'design_observation\''), executions: countOf(home, 'check_executions'), operations: countOf(home, 'operations', D4_OPERATIONS, project) });

describe('M528 the owner-invoked review of a native build (shared: Pantry designed, approved and built)', () => {
  const shared = sharedFixture();
  const J = {};
  before(async () => {
    const fx = await scriptedEngine(shared.context);
    J.fx = fx;
    const d = await designedPantry(fx, { name: 'pantry-owner-build' });
    Object.assign(J, d);
    J.candidate = await pump(fx, d.ctx, () => candidatesOfProject(fx.home, d.p.id).at(-1), { what: 'a candidate of the built stages', max: 120 });
    // The build finished before any case (objection 192): phase 1 complete and the project idle,
    // so a count that moves during a review is the review's, not the build's.
    await phaseCompleted(fx, d.ctx, 1, { max: 200 });
    await waitForIdle(fx.home, d.p.id);
  });
  after(shared.cleanup);

  test('(a) surety design review --target android --build "1.4.2 (37)" --evidence a.png b.webm: a review subject owner_build with the identifier verbatim, a review-mode Designer session bound to it; (d) its package: the screenshot as an image, the recording by name only, each owner_supplied; (f) every projection labels them owner-supplied and none engine-observed', async () => {
    const { fx, p, ctx } = J;
    const png = evidenceBytes('png', { tag: 1 });
    const webm = evidenceBytes('webm', { tag: 1 });
    const [a, b] = evidenceFiles(fx, { 'a.png': png, 'b.webm': webm });
    const before_ = countsOf(fx.home, p.id);
    const res = designReview(fx, p.id, { target: 'android', build: BUILD, observedOn: 'device', evidence: [a, b] });
    assert.equal(res.status, 0, `surety design review exits 0 (stdout ${res.stdout.slice(0, 400)}; stderr ${res.stderr.slice(0, 400)})`);
    const run = res.body?.run;
    assert.match(run?.id ?? '', /^run_/, `the answer names the review's session (${res.stdout.slice(0, 400)})`);
    assert.deepEqual([run.role, run.kind, run.mode], ['designer', 'session', 'review'], 'a Designer session in review mode');
    const reviewId = res.body?.review?.id ?? res.body?.review;
    assert.match(String(reviewId ?? ''), /^drv_/, `the answer names the review (${res.stdout.slice(0, 400)})`);
    const ids = (res.body?.evidence ?? []).map((e) => e.id ?? e);
    assert.equal(ids.length, 2, `two evidence records (${JSON.stringify(res.body?.evidence)})`);
    const rowA = ids.map((id) => evidenceRow(fx.home, id)).find((r) => r?.digest?.replace(/^sha256:/, '') === sha256hex(png));
    const rowB = ids.map((id) => evidenceRow(fx.home, id)).find((r) => r?.digest?.replace(/^sha256:/, '') === sha256hex(webm));
    assert.ok(rowA && rowB, `each file a design_evidence record by its digest (${JSON.stringify(ids.map((id) => evidenceRow(fx.home, id)))})`);
    J.evidence = { png: rowA, webm: rowB };
    // The session: the package dumped, then the review file citing both.
    const screens = [{ target: 'android', key: 'S2', verdict: 'matches', observed_on: 'device', evidence: [rowA.id, rowB.id], deltas: [] }];
    const out = await driveReview(fx, p.id, run, [
      { dump: true, say: 'Here is my phone, build 1.4.2 (37).', reply: 'I see the screenshot; the recording I know by its name.', save: false },
      { files: { [REVIEW_FILE(1)]: reviewJson({ subject: { kind: 'owner_build', target: 'android', build_ref: BUILD }, screens }) }, say: 'It matches the design.', done: true },
    ]);
    assert.equal(out.close.status, 200, `the review's close (${out.close.text?.slice(0, 400)})`);
    const review = reviewRow(fx.home, reviewId);
    assert.deepEqual(review?.subject, { kind: 'owner_build', target: 'android', build_ref: BUILD }, `the subject, the identifier verbatim (${JSON.stringify(review?.subject)})`);
    assert.equal(review.trigger, 'owner_command', 'opened on the owner\'s command');
    assert.equal(review.design_revision, J.approved.id, 'against the approved design');
    J.review = review;
    // (d) the package (SEAM.md §524).
    const pkg = packageOfLaunch(fx, run.id, 0);
    const listed = packageJson(pkg, 'design/evidence.json')?.evidence ?? [];
    const entry = (row) => listed.find((x) => x.id === row.id);
    assert.ok(entry(rowA) && entry(rowB), `both listed in design/evidence.json (${JSON.stringify(listed)})`);
    for (const e of listed) assert.deepEqual([e.provenance, e.target, e.build_ref], ['owner_supplied', 'android', BUILD], `${e.id} labelled owner_supplied with its target and build`);
    assert.equal(entry(rowA).name, 'a.png', 'the screenshot by its name');
    assert.ok(entry(rowA).file && pkg[entry(rowA).file]?.sha256 === sha256hex(png), `the screenshot as an image in the package (${entry(rowA).file})`);
    assert.equal(entry(rowB).name, 'b.webm', 'the recording by its name');
    assert.equal(entry(rowB).file ?? null, null, 'the recording by name only: no file');
    assert.ok(!Object.values(pkg).some((f) => f.sha256 === sha256hex(webm)), 'its bytes nowhere in the package');
    assert.equal(packageJson(pkg, 'design/review.json')?.subject?.kind, 'owner_build', 'the review\'s subject in the package');
    // Not verified: the command observed nothing, ran no check and made no D4 operation.
    const after_ = countsOf(fx.home, p.id);
    assert.equal(after_.observations, before_.observations, 'no engine observation made');
    assert.equal(after_.executions, before_.executions, 'no check run');
    assert.equal(after_.operations, before_.operations, 'no operation (deploy, rollback, teardown, publish)');
    // (f) the projections, before and after the owner's confirmation.
    const verdicts = await pump(fx, ctx, () => openVerdicts(fx.home, p.id, reviewId) ?? undefined, { what: 'design_verdicts', max: 10 });
    const preview = labelsOf(verdicts.evidence);
    assert.ok(preview.includes('owner-supplied'), `the verdicts' preview labels the evidence owner-supplied (${preview.slice(0, 600)})`);
    assert.ok(!preview.includes('engine-observed') && !preview.includes('engine_observed'), 'and none engine-observed');
    const confirmed = designVerdicts(fx, p.id, reviewId, 'confirm');
    assert.equal(confirmed.status, 0, `surety design verdicts … confirm (${confirmed.stdout} ${confirmed.stderr})`);
    const design = await readDesign(fx, p.id);
    const shown = reviewInDesign(design, reviewId);
    assert.ok(shown, `GET …/design lists the review (${JSON.stringify(design.reviews)?.slice(0, 400)})`);
    assert.deepEqual(shown.evidence_by_provenance, { engine_observed: 0, owner_supplied: 2, owner_reported: 0 }, 'counted by provenance: no owner item as engine-observed');
    for (const e of shown.evidence ?? []) assert.deepEqual([e.provenance, e.label], ['owner_supplied', 'owner-supplied'], `${e.id} labelled owner-supplied`);
    const human = humanTestOf(design, 'android');
    const fromReview = (human?.evidence ?? []).filter((e) => e.review === reviewId);
    assert.ok(fromReview.length > 0, `the confirmed verdict recorded against the android human test (${JSON.stringify(human)})`);
    for (const e of fromReview) {
      assert.notEqual(e.provenance, 'engine_observed', 'never as engine-observed');
      assert.deepEqual([e.build_ref, e.observed_on, e.label], [BUILD, 'device', 'owner accepted'], `bound to his build and his runtime, shown owner accepted (${JSON.stringify(e)})`);
    }
  });

  test('(a) POST …/design/reviews with a candidate: the candidate recorded as his word, unverified', async () => {
    const { fx, p, candidate } = J;
    const before_ = countsOf(fx.home, p.id);
    const res = await postReview(fx, p.id, { target: 'android', build_ref: 'pantry-android 0.2.0', candidate: candidate.id });
    assert.equal(res.status, 201, `POST …/design/reviews (→ ${res.status} ${res.text?.slice(0, 400)})`);
    const reviewId = res.body?.review?.id ?? res.body?.review;
    const out = await driveReview(fx, p.id, res.body.run, [{ files: { [REVIEW_FILE(2)]: reviewJson({ subject: { kind: 'owner_build', target: 'android', build_ref: 'pantry-android 0.2.0', candidate: candidate.id }, screens: [{ target: 'android', key: 'S2', verdict: 'matches', observed_on: 'emulator', evidence: [], deltas: [] }] }) }, say: 'On the emulator it matches.', done: true }]);
    assert.equal(out.close.status, 200, `the close (${out.close.text?.slice(0, 300)})`);
    const review = reviewRow(fx.home, reviewId) ?? reviewsOf(fx.home, p.id).at(-1);
    assert.deepEqual(review?.subject, { kind: 'owner_build', target: 'android', build_ref: 'pantry-android 0.2.0', candidate: candidate.id }, `the candidate he named, in the subject (${JSON.stringify(review?.subject)})`);
    const after_ = countsOf(fx.home, p.id);
    assert.equal(after_.observations, before_.observations, 'nothing observed to verify it');
    assert.equal(after_.executions, before_.executions, 'no check run on it');
    assert.equal(after_.operations, before_.operations, 'no operation (deploy, rollback, teardown, publish)');
    const v = openVerdicts(fx.home, p.id, review.id);
    if (v) assert.equal(designVerdicts(fx, p.id, review.id, 'reject').status, 0, 'the verdicts rejected (tidy)');
  });

  test('(b) the evidence: a valid PNG, WebP, JPEG, MP4 and WebM each recorded with digest, target, build reference and his observed_on, owner_supplied; a file whose magic bytes contradict its name, and files past the bounds (lowered), refused design_evidence_invalid with REVIEW_EVIDENCE_INVALID, nothing recorded', async () => {
    const { fx, p } = J;
    const files = Object.fromEntries(EVIDENCE_FORMATS.map((f, i) => [`shot-${i}.${extensionOf(f)}`, evidenceBytes(f, { tag: 2 + i })]));
    const paths = evidenceFiles(fx, files);
    const res = designReview(fx, p.id, { target: 'android', build: 'nightly #41', observedOn: 'emulator', evidence: paths });
    assert.equal(res.status, 0, `five formats admitted (${res.stdout.slice(0, 400)} ${res.stderr.slice(0, 400)})`);
    const rows = (res.body?.evidence ?? []).map((e) => evidenceRow(fx.home, e.id ?? e));
    assert.equal(rows.length, 5, 'five records');
    for (const [i, format] of EVIDENCE_FORMATS.entries()) {
      const bytes = files[`shot-${i}.${extensionOf(format)}`];
      const row = rows.find((r) => r?.digest?.replace(/^sha256:/, '') === sha256hex(bytes));
      assert.ok(row, `${format}: recorded by its digest`);
      assert.deepEqual([row.provenance, row.format, row.bytes, row.target, row.observed_on], ['owner_supplied', format, bytes.length, 'android', 'emulator'], `${format}: provenance, format, size, target and observed_on (${JSON.stringify(row)})`);
      assert.ok(JSON.stringify(row).includes('nightly #41') || JSON.stringify(reviewRow(fx.home, row.review)?.subject).includes('nightly #41'), `${format}: its build reference`);
    }
    // Close that review without a product.
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${res.body.run.id}/close`, { refuse: true });
    assert.equal(closed.status, 200, `the empty review closed (${closed.text?.slice(0, 300)})`);
    const refused = async (what, evidence, check) => {
      const runs = designerRuns(fx.home, p.id).length;
      const records = countOf(fx.home, 'design_evidence');
      const r = designReview(fx, p.id, { target: 'android', build: 'nightly #42', observedOn: 'device', evidence });
      assert.equal(r.status, 1, `${what}: the command exits 1 (${r.stdout.slice(0, 300)})`);
      assert.match(refusalText(r), /422/, `${what}: 422`);
      assert.match(refusalText(r), /design_evidence_invalid/, `${what}: design_evidence_invalid (A.6)`);
      assert.match(refusalText(r), /REVIEW_EVIDENCE_INVALID/, `${what}: its reason REVIEW_EVIDENCE_INVALID (A.4)`);
      if (check) check(refusalText(r));
      assert.equal(designerRuns(fx.home, p.id).length, runs, `${what}: no session opened`);
      assert.equal(countOf(fx.home, 'design_evidence'), records, `${what}: nothing recorded`);
    };
    const [lyingJpg] = evidenceFiles(fx, { 'shot.jpg': evidenceBytes('png', { tag: 9 }) });
    await refused('a PNG named .jpg', [lyingJpg], (t) => assert.match(t, /shot\.jpg/, 'naming the file'));
    const [lyingMp4] = evidenceFiles(fx, { 'clip.mp4': evidenceBytes('webm', { tag: 9 }) });
    await refused('a WebM named .mp4', [lyingMp4], (t) => assert.match(t, /clip\.mp4/, 'naming the file'));
    // Per file, lowered to 1 MiB.
    await setPolicy(fx, p.id, { [EVIDENCE_FILE_KEY]: MIB, [EVIDENCE_REVIEW_KEY]: 2 * MIB });
    const [big] = evidenceFiles(fx, { 'big.png': evidenceBytes('png', { tag: 3, pad: MIB }) });
    await refused('a file past the per-file bound', [big], (t) => assert.ok(t.includes('big.png') && t.includes(EVIDENCE_FILE_KEY), `naming the file and ${EVIDENCE_FILE_KEY}`));
    const three = evidenceFiles(fx, Object.fromEntries([1, 2, 3].map((i) => [`part-${i}.png`, evidenceBytes('png', { tag: 10 + i, pad: 800 * 1024 })])));
    await refused('files past the per-review bound together', three, (t) => assert.ok(t.includes(EVIDENCE_REVIEW_KEY), `naming ${EVIDENCE_REVIEW_KEY}`));
  });

  test('(e) a target the inventory lacks: design_review_target_unknown (422), nothing opened', async () => {
    const { fx, p } = J;
    const runs = designerRuns(fx.home, p.id).length;
    const res = await postReview(fx, p.id, { target: 'ios', build_ref: 'pantry-ios 1.0' });
    assert.deepEqual([res.status, res.body?.code], [422, 'design_review_target_unknown'], `refused (A.6) (→ ${res.status} ${res.text?.slice(0, 300)})`);
    const cliRes = designReview(fx, p.id, { target: 'ios', build: 'pantry-ios 1.0' });
    assert.equal(cliRes.status, 1, 'the command exits 1');
    assert.match(refusalText(cliRes), /design_review_target_unknown/, 'naming the code');
    assert.equal(designerRuns(fx.home, p.id).length, runs, 'no session opened');
  });
});

describe('M528 the owner-invoked review: bounds, a native-only product, the policy off', () => {
  test('(c) the bounds\' defaults: 64 MiB a file, 512 MiB a review', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { policy: { design: 'before_build' } });
    const { effective } = await getPolicy(fx.engine, p.id);
    assert.equal(effective[EVIDENCE_FILE_KEY], EVIDENCE_FILE_DEFAULT, `${EVIDENCE_FILE_KEY} defaults to 64 MiB (D7 A.7)`);
    assert.equal(effective[EVIDENCE_REVIEW_KEY], EVIDENCE_REVIEW_DEFAULT, `${EVIDENCE_REVIEW_KEY} defaults to 512 MiB (D7 A.7)`);
  });

  test('(g) design_due for a product with no web target names surety design review --target android --build', async (t) => {
    const fx = await scriptedEngine(t);
    const { due } = await androidOnlyAtAlpha(fx);
    assert.match(due.evidence?.command ?? '', /surety design review --target android --build/, `the question names the owner's review command, not a browser review (D7 §10.1) (${JSON.stringify(due.evidence)})`);
  });

  test('(h) under design off: the review refused, nothing opened', async (t) => {
    const fx = await scriptedEngine(t);
    const p = await createPantry(fx, { name: 'pantry-off', policy: { autonomy: 'phase' } });
    const res = await postReview(fx, p.id, { target: 'android', build_ref: 'pantry-android 0.1.0' });
    assert.deepEqual([res.status, res.body?.code], [409, 'design_review_unavailable'], `refused under off (→ ${res.status} ${res.text?.slice(0, 300)})`);
    assert.equal(res.body?.subject?.cause, 'design_off', 'naming the cause');
    const cliRes = designReview(fx, p.id, { target: 'android', build: 'pantry-android 0.1.0' });
    assert.equal(cliRes.status, 1, 'the command exits 1');
    assert.equal(designerRuns(fx.home, p.id).length, 0, 'no session opened');
  });
});
