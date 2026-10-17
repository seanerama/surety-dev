// M511, a preview is never evidence; when it is unavailable (slice 42;
// kernel lane). M6 plan §3.4 M511; D7 §5.2, §5.7, A.6, A.7; G4; Q2; E156 Q4;
// BS6 §9.3 (G4's straddle), §11.1; SEAM.md §§480, 488, 498 to 501.
//
// The reference project "Pantry" (web `html_css`, android `react_native`)
// under `design: before_build`, on the scripted backend and the scripted
// deployment adapter: a preview is the engine's deployment of a design
// revision to the reserved environment `design-preview`, its deploy answered
// at the barrier `preview.sealed` (SEAM.md §499).
//   (a) a preview deployed, then the API stage built and verified beside it:
//       no candidate progress, no `alpha_deployed`, no deployment request or
//       authorization, no gate evaluation reading the preview; the preview's
//       operation names no candidate and no authorization;
//   (b) `design_preview_unavailable` (409), naming its cause: no design
//       revision; the adapter unqualified (lapsed); `design_preview: off`;
//       `design: off`; and `design_preview: stack` refused at the policy
//       route naming the allowed `off` and `static` (E156 Q4);
//   (c) `surety design export <dir>` at a checkpoint and at the approved
//       revision, with an engine-authored `SIMULATIONS.txt`; `GET
//       …/design/export` the same as a ustar archive; no host call beyond the
//       write (no operation, no adapter qualification needed);
//   (d) an owner's configuration of `design-preview` refused: the
//       environment is reserved and engine-configured (BS6 §9.3, G4);
//   (e) the envelope with a preview running: counted at
//       `preview_memory_max`, and no shared check capacity reserved for it
//       (E126's is not).
//
// SAFETY (BS6 §4.1). Kernel lane: no unit, no domain, nothing run but the
// test's engine and its scripted roles; nothing the Designer wrote is read
// but as bytes (rules 21, 22).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { consume, decision } from './harness/decisions.mjs';
import { waitFor } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { addGitProject } from './harness/gitruns.mjs';
import { changePolicy, getPolicy } from './harness/journal.mjs';
import { addWork, runsOf, scriptedEngine } from './harness/runs.mjs';
import { withStore } from './harness/store.mjs';
import { configContent, filesUnder, lapseByFixture, putConfig, qualifyByFixture } from './harness/deploy/kernel.mjs';
import { clearEnvelope, holdOf, holding, heldItems, setEnvelope, settle, ticksUntil } from './harness/exec37/envelope.mjs';
import { pump } from './harness/journey/drive.mjs';
import { ANDROID_MOCKUP_PATH, WEB_MOCKUP_PATH } from './harness/design/reference.mjs';
import { cli, designerSession, stageRow, toPublished, validDesign } from './harness/design/drive.mjs';
import { BEFORE_BUILD, approveBatch, approvedRevision, scriptVariant, untilBatch } from './harness/design/check41.mjs';
import {
  GIB,
  MIB,
  PREVIEW_ENV,
  PREVIEW_MEMORY_MAX,
  assertSameFiles,
  countOf,
  designTreeAt,
  domainOfAttempt,
  engineBytes,
  lastAttempt,
  liveDomains,
  previewEnvRow,
  previewOnKernel,
  previewOps,
  previewRoute,
  simulationRecords,
  untar,
} from './harness/design/preview42.mjs';

const rows = (home, sql, ...params) => withStore(home, (db) => db.prepare(sql).all(...params));
const R = 2 * GIB; // host_reserve_memory's default (M438)
const ROLE = 4 * GIB; // role_memory_max's default (M438)

// Pantry published under before_build, its roles scripted (slice 41's
// scriptVariant), and one Designer save of the whole design: the checkpoint.
// The session is left open unless `close` is given. Returns {fx, p, ctx, s, checkpoint}.
async function pantryWithCheckpoint(fx, { name, policy = BEFORE_BUILD, close = null } = {}) {
  const { p } = await toPublished(fx, { policy, name });
  const ctx = scriptVariant(fx, p);
  const s = await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry for the web and Android.' }], { close });
  const save = s.saves[0];
  assert.equal(save?.status, 200, `the Designer's save is answered (${save?.status} ${save?.text?.slice(0, 400)})`);
  assert.equal(save.body?.design_check?.outcome, 'passed', `the reference design passes its check (SEAM.md §483) (${JSON.stringify(save.body?.design_check)})`);
  return { fx, p, ctx, s, checkpoint: save.body.revision };
}

// The owner's change of `design` (D7 §2, an ordinary policy change; whether
// turning it off asks for a confirmation is M513's, slice 44): applied
// directly, or through its `policy_widening` decision answered approve.
async function ownerSetsDesign(fx, project, value) {
  const res = await fx.engine.post(`/v1/projects/${project}/policy`, { design: value });
  if (res.status === 409 && res.body?.code === 'confirm_required') await consume(fx, project, decision(fx.home, res.body.subject?.decision), 'approve');
  else assert.equal(res.status, 200, `design: ${value} by the owner (→ ${res.status} ${res.text})`);
  await waitFor(async () => (await getPolicy(fx.engine, project)).effective?.design === value, { what: `design ${value} in effect` });
}

// A preview request refused 409 design_preview_unavailable naming `cause` (SEAM.md §499).
function assertUnavailable(res, cause, what) {
  assert.equal(res.status, 409, `${what}: 409 design_preview_unavailable (D7 A.6) (→ ${res.status} ${res.text?.slice(0, 400)})`);
  assert.equal(res.body?.code, 'design_preview_unavailable', `${what}: the code (${res.text?.slice(0, 400)})`);
  assert.equal(res.body?.subject?.cause, cause, `${what}: naming the cause ${cause} (${res.text?.slice(0, 400)})`);
}

describe('M511 a preview is never evidence; when it is unavailable (kernel lane)', () => {
  const shared = sharedFixture();
  after(() => shared.cleanup());

  test('(a) a preview deployed beside the API stage\'s build: never a candidate progress, never alpha_deployed, never a deployment request, never an input of any gate', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p, ctx } = await pantryWithCheckpoint(fx, { name: 'pantry-a' });
    await qualifyByFixture(fx.engine);
    const { op, env, event } = await previewOnKernel(fx, p.id, { revision: 'checkpoint' });
    assert.ok(op, 'the preview is an operation of kind deploy on the reserved environment (SEAM.md §499)');
    assert.equal(event.payload?.generation, 1, `the first generation (${JSON.stringify(event.payload)})`);
    // The API stage built, verified and gated with the preview running.
    await pump(fx, ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage to be verified beside the preview', max: 80 });
    const ids = [op.id, env.id, lastAttempt(fx.home, op)?.id, PREVIEW_ENV].filter(Boolean);
    const evaluations = rows(fx.home, 'SELECT * FROM "gate_evaluations" WHERE "project" = ? ORDER BY rowid', p.id);
    assert.ok(evaluations.some((e) => e.gate_kind === 'stage' && e.outcome === 'satisfied'), `the API stage's gate was evaluated with the preview running (${JSON.stringify(evaluations.map((e) => [e.gate_kind, e.outcome]))})`);
    for (const e of evaluations) {
      const text = JSON.stringify(e);
      for (const id of ids) assert.ok(!text.includes(id), `gate evaluation ${e.id} (${e.gate_kind}) reads nothing of the preview (${id})`);
    }
    const candidates = rows(fx.home, 'SELECT * FROM "candidates" WHERE "project" = ?', p.id);
    assert.ok(candidates.length > 0, 'the API stage made a candidate');
    assert.deepEqual([...new Set(candidates.map((c) => c.progress))], ['developing'], 'no candidate progressed: never alpha_deployed');
    for (const c of candidates) for (const id of ids) assert.ok(!JSON.stringify(c).includes(id), `candidate ${c.id} names nothing of the preview`);
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_requests" WHERE "project" = ?', p.id), 0, 'no deployment request');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations"'), 0, 'no deployment authorization');
    assert.equal(countOf(fx.home, `SELECT COUNT(*) AS n FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" IN ('alpha_authorize', 'alpha_complete')`, p.id), 0, 'no alpha_authorize or alpha_complete evaluation');
    const now = previewOps(fx.home, p.id).find((o) => o.id === op.id);
    assert.equal(now.authorization ?? null, null, 'the preview\'s operation carries no authorization');
    assert.equal(now.subject?.candidate ?? null, null, `the preview's operation names no candidate (${JSON.stringify(now.subject)})`);
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "check_executions" WHERE "environment" = ?', env.id), 0, 'no check ran against the preview');
  });

  test('(b) design_preview_unavailable naming its cause: no design revision, the adapter unqualified, design_preview off, design off; design_preview stack refused naming off and static', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p } = await toPublished(fx, { policy: BEFORE_BUILD, name: 'pantry-b' });
    scriptVariant(fx, p);
    const qualification = await qualifyByFixture(fx.engine);

    // No design revision (the inventory alone is not a design revision).
    assertUnavailable(await previewRoute(fx, p.id, { revision: 'checkpoint' }), 'no_design_revision', 'no Designer save yet');
    const byCli = cli(fx, ['design', 'preview', '--project', p.id, '--revision', 'checkpoint']);
    assert.equal(byCli.status, 1, `surety design preview exits 1 (SEAM.md §480) (${byCli.stdout.slice(0, 300)} ${byCli.stderr.slice(0, 300)})`);
    assert.ok(`${byCli.stdout}${byCli.stderr}`.includes('design_preview_unavailable') && `${byCli.stdout}${byCli.stderr}`.includes('no_design_revision'), `printing the code and the cause (${byCli.stdout.slice(0, 300)} ${byCli.stderr.slice(0, 300)})`);

    // A checkpoint; the adapter's qualification lapsed.
    const s = await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry.' }], { close: null });
    assert.equal(s.saves[0]?.body?.design_check?.outcome, 'passed', `the reference design saved (${s.saves[0]?.text?.slice(0, 300)})`);
    await lapseByFixture(fx.engine, qualification);
    assertUnavailable(await previewRoute(fx, p.id, { revision: 'checkpoint' }), 'adapter_unqualified', 'the adapter\'s qualification lapsed');

    // Qualified again; design_preview off.
    await qualifyByFixture(fx.engine);
    await changePolicy(fx.engine, p.id, { design_preview: 'off' });
    assertUnavailable(await previewRoute(fx, p.id, { revision: 'checkpoint' }), 'design_preview_off', 'design_preview off');

    // stack refused (E156 Q4), the policy unchanged.
    const stack = await fx.engine.post(`/v1/projects/${p.id}/policy`, { design_preview: 'stack' });
    assert.equal(stack.status, 400, `design_preview: stack refused (→ ${stack.status} ${stack.text})`);
    assert.equal(stack.body?.code, 'invalid_value', `invalid_value (${stack.text})`);
    assert.equal(stack.body?.subject?.field, 'design_preview', `naming the key (${stack.text})`);
    assert.ok(/\boff\b/.test(stack.body?.reason ?? '') && /\bstatic\b/.test(stack.body?.reason ?? ''), `naming the allowed off and static (${stack.body?.reason})`);
    assert.equal((await getPolicy(fx.engine, p.id)).effective?.design_preview, 'off', 'the policy unchanged');

    // design_preview static again (applied directly, SEAM.md §499); design off.
    await changePolicy(fx.engine, p.id, { design_preview: 'static' });
    await fx.engine.post(`/v1/projects/${p.id}/sessions/${s.run.id}/close`, { refuse: true });
    await ownerSetsDesign(fx, p.id, 'off');
    assertUnavailable(await previewRoute(fx, p.id, { revision: 'checkpoint' }), 'design_off', 'design off');
    assert.equal(previewOps(fx.home, p.id).length, 0, 'no preview was deployed by any refused request');
  });

  test('(c) surety design export at a checkpoint and at the approved revision, with SIMULATIONS.txt; GET …/design/export the same as an archive; no host call beyond the write', async () => {
    const fx = await scriptedEngine(shared.context);
    // No adapter qualification in this engine: export needs none (D7 §5.7).
    const { p, ctx } = await pantryWithCheckpoint(fx, { name: 'pantry-c', close: {} });
    const batch = await untilBatch(fx, ctx);
    await approveBatch(fx, ctx, batch);
    const approved = approvedRevision(fx.home, p.id);
    assert.ok(approved?.tree_blob, `the approved revision records its tree (D7 A.3 tree_blob) (${JSON.stringify(approved)})`);
    // A newer checkpoint: design.md changed, nothing else.
    const files = validDesign(p);
    files['.surety/design/design.md'] = '# Pantry: design\n\nA second checkpoint, after the approval.\n';
    const s2 = await designerSession(fx, p.id, [{ files, say: 'Reword the notes.' }], { close: null });
    const checkpoint = s2.saves[0]?.body?.revision;
    assert.ok(checkpoint, `the second session's checkpoint (${s2.saves[0]?.text?.slice(0, 300)})`);

    const opsBefore = countOf(fx.home, 'SELECT COUNT(*) AS n FROM "operations" WHERE "project" = ? AND "kind" IN (\'deploy\', \'teardown\')', p.id);
    const expectSimulations = (text, what) => {
      const records = simulationRecords(text);
      assert.deepEqual(records, [[ANDROID_MOCKUP_PATH, 'android', 'phone', 'phone-portrait']], `${what}: SIMULATIONS.txt names the simulated mockup with its target, form factor and layout, and nothing else (SEAM.md §501) (${JSON.stringify(text)})`);
      assert.ok(!text.includes(WEB_MOCKUP_PATH), `${what}: the native mockup is not named`);
    };
    for (const [revision, expected] of [
      ['checkpoint', designTreeAt(p.repo.path, checkpoint)],
      ['approved', designTreeAt(p.repo.path, approved.tree_blob, { tree: true })],
    ]) {
      const dir = join(fx.root, `export-${revision}`);
      const out = cli(fx, ['design', 'export', '--project', p.id, '--revision', revision, dir]);
      assert.equal(out.status, 0, `surety design export --revision ${revision} exits 0 (${out.stdout.slice(0, 300)} ${out.stderr.slice(0, 300)})`);
      assert.ok(existsSync(join(dir, 'SIMULATIONS.txt')), `${revision}: SIMULATIONS.txt beside the tree`);
      expectSimulations(readFileSync(join(dir, 'SIMULATIONS.txt'), 'utf8'), `${revision}: the directory`);
      const written = filesUnder(dir);
      delete written['SIMULATIONS.txt'];
      assertSameFiles(written, expected, `${revision}: the tree written at its paths under .surety/design/`);
      const archive = await engineBytes(fx, `/v1/projects/${p.id}/design/export?revision=${revision}`);
      assert.equal(archive.status, 200, `GET …/design/export?revision=${revision} (→ ${archive.status} ${archive.bytes?.toString('utf8').slice(0, 300)})`);
      assert.match(String(archive.headers['content-type'] ?? ''), /^application\/x-tar/, `${revision}: a tar archive`);
      const entries = untar(archive.bytes);
      expectSimulations(entries['SIMULATIONS.txt']?.toString('utf8') ?? '', `${revision}: the archive`);
      delete entries['SIMULATIONS.txt'];
      assertSameFiles(entries, expected, `${revision}: the archive`);
    }
    // The two revisions differ where the second checkpoint changed design.md.
    assert.notEqual(readFileSync(join(fx.root, 'export-checkpoint', 'design.md'), 'utf8'), readFileSync(join(fx.root, 'export-approved', 'design.md'), 'utf8'), 'the checkpoint and the approved revision are each their own');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "operations" WHERE "project" = ? AND "kind" IN (\'deploy\', \'teardown\')', p.id), opsBefore, 'no deployment or teardown operation');
    assert.equal(previewEnvRow(fx.home, p.id), null, 'no preview environment made by an export');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "adapter_qualifications"'), 0, 'and no adapter qualification was needed');
  });

  test('(d) an owner\'s configuration of the environment design-preview refused: reserved and engine-configured', async () => {
    const fx = await scriptedEngine(shared.context);
    const p = await addGitProject(fx);
    const res = await putConfig(fx.engine, p.id, PREVIEW_ENV, configContent({ start: [process.execPath, 'server.mjs'], port: 8091 }));
    assert.equal(res.status, 409, `PUT …/environments/design-preview/config refused (SEAM.md §499) (→ ${res.status} ${res.text})`);
    assert.equal(res.body?.code, 'environment_reserved', `environment_reserved (${res.text})`);
    assert.ok(JSON.stringify(res.body?.subject ?? {}).includes(PREVIEW_ENV), `naming design-preview (${res.text})`);
    assert.equal(previewEnvRow(fx.home, p.id), null, 'no environment made by it');
    // A Pantry project whose preview the engine configured: the owner's write still refused.
    const { p: q } = await pantryWithCheckpoint(fx, { name: 'pantry-d' });
    await qualifyByFixture(fx.engine);
    const { env } = await previewOnKernel(fx, q.id);
    const before = rows(fx.home, 'SELECT "id", "version" FROM "environment_configs" WHERE "environment" = ?', env.id);
    const again = await putConfig(fx.engine, q.id, PREVIEW_ENV, configContent({ start: [process.execPath, 'server.mjs'], port: 8092 }));
    assert.equal(again.status, 409, `refused with a preview configured by the engine (→ ${again.status} ${again.text})`);
    assert.equal(again.body?.code, 'environment_reserved');
    assert.deepEqual(rows(fx.home, 'SELECT "id", "version" FROM "environment_configs" WHERE "environment" = ?', env.id), before, 'the engine\'s configuration unchanged');
  });

  test('(e) the envelope with a preview running: counted at preview_memory_max; no shared check capacity reserved for it', async () => {
    const fx = await scriptedEngine(shared.context);
    const { p, s } = await pantryWithCheckpoint(fx, { name: 'pantry-e' });
    await qualifyByFixture(fx.engine);
    const { op } = await previewOnKernel(fx, p.id);
    const attempt = lastAttempt(fx.home, op);
    const domain = domainOfAttempt(fx.home, attempt.id);
    assert.ok(domain, 'the preview\'s service domain is recorded (execution_domains.attempt)');
    assert.equal(domain.reservation?.memory, PREVIEW_MEMORY_MAX, `reserved at preview_memory_max, 256 MiB (SEAM.md §499) (${JSON.stringify(domain.reservation)})`);
    assert.ok(!domain.reservation?.check_capacity, `no shared check capacity reserved with it (${JSON.stringify(domain.reservation)})`);
    // The design project quiet: its session closed, paused, no domain of it but the preview's.
    await fx.engine.post(`/v1/projects/${p.id}/sessions/${s.run.id}/close`, { refuse: true });
    const paused = await fx.engine.post(`/v1/projects/${p.id}/pause`, {});
    assert.equal(paused.status, 200, `the design project paused (${paused.text})`);
    await ticksUntil(fx, p.id, () => (liveDomains(fx.home, p.id, [domain.id]).length === 0 ? true : undefined), { what: 'no domain of the design project but the preview\'s', max: 40 });
    // Another project's role, held, against the scripted MemAvailable.
    const other = (await addGitProject(fx)).id;
    await changePolicy(fx.engine, other, { budget_run_billable_tokens: CONTRACT.project.budget_run_billable_tokens.min });
    await setEnvelope(fx, { mem_available: R + PREVIEW_MEMORY_MAX + ROLE - MIB, default_current: 0 });
    const [item] = await heldItems(fx, other, 1, { addWork });
    await settle(fx, other, 3);
    const hold = await holdOf(fx, other, item);
    assert.deepEqual([runsOf(fx.home, item).length, hold?.code], [0, 'resource_envelope'], `1 MiB short of reserve + the preview + a role: held, so the preview is counted (${JSON.stringify(hold)})`);
    await setEnvelope(fx, { mem_available: R + PREVIEW_MEMORY_MAX + ROLE, default_current: 0 });
    await ticksUntil(fx, other, () => (holding(fx, item) ? true : undefined), { what: 'the role admitted at exactly reserve + the preview + a role', max: 20 });
    assert.equal(runsOf(fx.home, item).length, 1, 'admitted with no room for a check domain: no shared check capacity is kept for a preview (E126\'s is not)');
    fx.scripted.release('all', 'gate');
    await clearEnvelope(fx);
  });
});
