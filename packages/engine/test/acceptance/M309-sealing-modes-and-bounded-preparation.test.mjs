// M309, sealing, modes and bounded preparation (slice 24; kernel lane). M4
// plan §3.2 M309; D4 §3.1, A.7; D4-I02, D4-I07, D4-I08; E117; BS4 §11.3 as
// approved (E121 item 3); SEAM.md §§256, 260, 262. The target read of the
// modes is the sandbox file `M309-modes-through-the-target-read.test.mjs`.
//   (a) the sealed files: no write bit, the executable class kept; a byte
//       changed in the sealed copy before the next deploy: `artifact_corrupt`
//       at the effect's precondition (§250's fact `artifact_integrity`), the
//       artifact `failed`, a `security` finding `high`, nothing deployed;
//   (b) `100755` and `100644` in the manifest; equal digests under two host
//       umasks; a changed executable class changes the digest; a file added
//       to, and one removed from, the sealed copy refuse the next deploy,
//       never omitted;
//   (c) each bound, one under (passes) and one over (refused before
//       anything is authorized, the bound named): `artifact_max_entries`
//       (`too_many`), `artifact_max_bytes` (`too_large`), `artifacts_max_bytes`
//       (`retention_full`, the referenced artifact kept), `host_reserve_disk`
//       as artifact admission sees it (`disk_reserve`, SEAM.md §260's
//       `--harness-artifact-free-bytes`), `artifact_prepare_deadline`
//       (`prepare_deadline`, on the controlled clock);
//   (d) a killed preparation and a cancelled one (the engine's orderly stop
//       while it prepares, SEAM.md §260 †): only unreferenced staging is
//       removed, the referenced artifact kept; and the slice-23 review's
//       minor m5: a request that is not authorized, coalesced, or refused
//       for `config_secrets_changed` leaves nothing under artifacts/ that no
//       `artifacts` row records, within `artifacts_max_bytes`;
//   (e) the API answered while a preparation is under way;
//   (f) the defaults BS4 §11.3 set, and a value outside its range refused
//       at start.
//
// SAFETY: kernel lane; no unit, no systemctl, nothing signalled but the
// test's own engines (the `kill` barrier makes an engine kill itself). The
// cases change files of the test's own engine homes only. The file ends
// with the operator's guard (row M313).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { EXIT, freePort, makeTempDir, removeDir, startRefused, writeEngineConfig } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { armBarrier, eventsOfType } from './harness/journal.mjs';
import { advanceClock, scriptedEngine, tick, tickUntil } from './harness/runs.mjs';
import { listTree } from './harness/repos.mjs';
import { withStore } from './harness/store.mjs';
import {
  SERVICE_FILES,
  adapterState,
  artifactsOf,
  atBarrier,
  configContent,
  configure,
  deploy,
  deployable,
  effectCalls,
  operationsOf,
  qualifyByFixture,
  releaseBarrier,
  requestDeployment,
} from './harness/deploy/kernel.mjs';
import { manifestDigest, operatorGuard, treeManifest, unrecordedUnderArtifacts } from './harness/deploy/host.mjs';

const KiB = 1024;
const MiB = 1024 * KiB;
const SERVER_BYTES = Buffer.byteLength(SERVICE_FILES['server.js']);
const RUN_SH = Object.freeze({ content: '#!/bin/sh\necho run\n', mode: '100755' });

const authorizationsOf = (home, candidate, environment) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "deployment_authorizations" WHERE "candidate" = ? AND "environment" = ? ORDER BY rowid').all(candidate, environment));
const securityFindings = (home, project) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "findings" WHERE "project" = ? AND "category" = 'security' ORDER BY "seq"`).all(project));
const modeOf = (path) => statSync(path).mode & 0o777;
const pad = (ch, n) => ch.repeat(n);

// A pre-effect failure of the project's newest deploy operation, ticked to.
const failedBeforeEffect = (fx, project) =>
  tickUntil(fx.engine, project, () => {
    const op = operationsOf(fx.home, project, 'deploy').at(-1);
    return op && op.status === 'failed' ? op : undefined;
  }, { max: 12, what: 'the deploy to fail before its effect' });

// The refused request's shape (SEAM.md §260): 422 artifact_refused naming the bound; nothing authorized; nothing left.
async function assertRefusedBound(fx, ctx, env, refusal) {
  const res = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, env);
  assert.deepEqual([res.status, res.body?.code, res.body?.subject?.refusal], [422, 'artifact_refused', refusal], `over the bound: refused, naming ${refusal} (${res.text})`);
  const envId = withStore(fx.home, (db) => db.prepare('SELECT "id" FROM "environments" WHERE "project" = ? AND "name" = ?').get(ctx.project, env))?.id;
  assert.deepEqual(authorizationsOf(fx.home, ctx.candidate.id, envId), [], 'nothing authorized');
  assert.ok(eventsOfType(fx.home, 'artifact.failed').some((e) => e.payload?.refusal === refusal), `artifact.failed records the bound (${refusal})`);
  assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'nothing under artifacts/ but recorded artifacts');
}

// An environment `name` whose projection is server.js (the start command's
// entry point) and the paths under `keep` only: every other tracked path of
// the candidate outside .surety/ is excluded by its exact name.
async function only(fx, ctx, name, keep) {
  const paths = Object.keys(listTree(ctx.p.repo.path, ctx.candidate.revision)).filter((p) => !p.startsWith('.surety/'));
  const exclude = paths.filter((p) => p !== 'server.js' && !keep.some((k) => p === k || p.startsWith(k)));
  return configure(fx.engine, ctx.project, name, configContent({ artifact: { exclude } }));
}

describe('M309 sealing, modes and bounded preparation (kernel lane)', () => {
  const shared = sharedFixture();
  let guard;
  before(() => {
    guard = operatorGuard();
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  let P1digest;
  test('(a) sealed files have no write bit and keep the executable class; a byte changed in the sealed copy before the next deploy: artifact_corrupt at the precondition, the artifact failed, a security finding high, nothing deployed', async () => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const ctx = await deployable(fx, { entries: { 'bin/run.sh': RUN_SH } });
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const [artifact] = artifactsOf(fx.home, ctx.project);
    const run = join(artifact.path, 'bin/run.sh');
    const server = join(artifact.path, 'server.js');
    assert.equal(modeOf(run) & 0o222, 0, 'bin/run.sh has no write bit');
    assert.notEqual(modeOf(run) & 0o111, 0, 'bin/run.sh keeps its executable class');
    assert.equal(modeOf(server) & 0o333, 0, 'server.js has no write bit and no execute bit');
    const { entries } = treeManifest(artifact.path);
    assert.deepEqual(entries.filter((e) => ['bin/run.sh', 'server.js'].includes(e[0])).map((e) => [e[0], e[2]]), [['bin/run.sh', '100755'], ['server.js', '100644']], '(b) the manifest classes');
    assert.equal(manifestDigest(entries), artifact.digest);
    P1digest = artifact.digest;

    chmodSync(server, 0o644);
    appendFileSync(server, '// one more line\n');
    chmodSync(server, 0o444);
    const op = await failedBeforeEffect(fx, ctx.project);
    assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'artifact_integrity'], `refused at the precondition (${JSON.stringify(op.outcome_detail)})`);
    assert.equal(artifactsOf(fx.home, ctx.project)[0].status, 'failed', 'the artifact is failed');
    assert.ok(eventsOfType(fx.home, 'artifact.failed').some((e) => e.payload?.reason === 'artifact_corrupt'), 'artifact.failed, reason artifact_corrupt');
    const findings = securityFindings(fx.home, ctx.project);
    assert.ok(findings.some((f) => f.effective_severity === 'high' && f.scope === 'project' && f.status === 'open'), `a security finding, high, scoped to the project (${JSON.stringify(findings.map((f) => [f.effective_severity, f.scope, f.status]))})`);
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'nothing deployed: no deploy call');
  });

  test('(b) equal digests under two host umasks; a changed executable class changes the digest', async () => {
    assert.ok(P1digest, '(a) sealed its artifact');
    const fx = guard.track(await scriptedEngine(shared.context, { start: false }));
    const old = process.umask(0o077);
    try {
      await fx.start();
    } finally {
      process.umask(old);
    }
    const same = await deployable(fx, { entries: { 'bin/run.sh': RUN_SH } });
    await deploy(fx.engine, same.project, same.candidate.id, same.env.name);
    const [artifact] = artifactsOf(fx.home, same.project);
    assert.equal(artifact.digest, P1digest, 'the same revision content sealed under umask 077 has the digest it had under the default umask');
    assert.equal(modeOf(join(artifact.path, 'bin/run.sh')) & 0o222, 0, 'no write bit under umask 077 either');
    assert.notEqual(modeOf(join(artifact.path, 'bin/run.sh')) & 0o111, 0, 'the executable class kept under umask 077');

    const plain = await deployable(fx, { entries: { 'bin/run.sh': { ...RUN_SH, mode: '100644' } } });
    await deploy(fx.engine, plain.project, plain.candidate.id, plain.env.name);
    const [other] = artifactsOf(fx.home, plain.project);
    assert.notEqual(other.digest, P1digest, 'bin/run.sh not executable: another digest');
    assert.deepEqual(treeManifest(other.path).entries.find((e) => e[0] === 'bin/run.sh')?.[2], '100644');
  });

  test('(b) a file added to the sealed copy refuses the next deploy (artifact_integrity), never omitted', async () => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const ctx = await deployable(fx);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const [artifact] = artifactsOf(fx.home, ctx.project);
    chmodSync(artifact.path, 0o755);
    writeFileSync(join(artifact.path, 'added.txt'), 'added by the test\n', { mode: 0o444 });
    chmodSync(artifact.path, 0o555);
    const op = await failedBeforeEffect(fx, ctx.project);
    assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'artifact_integrity']);
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'nothing deployed');
  });

  test('(b) a file removed from the sealed copy refuses the next deploy (artifact_integrity), never omitted', async () => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const ctx = await deployable(fx);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const [artifact] = artifactsOf(fx.home, ctx.project);
    chmodSync(join(artifact.path, 'lib'), 0o755);
    rmSync(join(artifact.path, 'lib', 'greeting.js'));
    chmodSync(join(artifact.path, 'lib'), 0o555);
    const op = await failedBeforeEffect(fx, ctx.project);
    assert.deepEqual([op.outcome_detail?.code, op.outcome_detail?.fact], ['EFFECT_PRECONDITION_CHANGED', 'artifact_integrity']);
    assert.equal(effectCalls(await adapterState(fx.engine, ctx.env.id), 'deploy').length, 0, 'nothing deployed');
  });

  test('(c) artifact_max_entries at its minimum, 100: 100 entries pass, 101 are refused too_many', async () => {
    const fx = guard.track(await scriptedEngine(shared.context, { config: { artifact_max_entries: 100 } }));
    const files = {};
    for (let i = 0; i < 99; i++) files[`fill/f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
    files['extra/one.txt'] = 'one more\n';
    const ctx = await deployable(fx, { files });
    await only(fx, ctx, 'under', ['fill/']);
    await only(fx, ctx, 'over', ['fill/', 'extra/']);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'under');
    const [artifact] = artifactsOf(fx.home, ctx.project);
    assert.equal(artifact.entries, 100, 'the under case is exactly at the bound: server.js and 99 files');
    await assertRefusedBound(fx, ctx, 'over', 'too_many');
  });

  test('(c) artifact_max_bytes at its minimum, 1 MiB: exactly 1 MiB passes, one byte more is refused too_large', async () => {
    const fx = guard.track(await scriptedEngine(shared.context, { config: { artifact_max_bytes: MiB, artifacts_max_bytes: 8 * MiB } }));
    const files = { 'pad-under.bin': pad('u', MiB - SERVER_BYTES), 'pad-over.bin': pad('o', MiB - SERVER_BYTES + 1) };
    const ctx = await deployable(fx, { files });
    await only(fx, ctx, 'under', ['pad-under.bin']);
    await only(fx, ctx, 'over', ['pad-over.bin']);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'under');
    assert.equal(artifactsOf(fx.home, ctx.project)[0].bytes, MiB, 'the under case is exactly at the bound');
    await assertRefusedBound(fx, ctx, 'over', 'too_large');
  });

  test('(c), (d) artifacts_max_bytes at 1 MiB: a second artifact taking the total past it is refused retention_full; the referenced artifact is kept; one keeping the total within it passes', async () => {
    const fx = guard.track(await scriptedEngine(shared.context, { config: { artifact_max_bytes: MiB, artifacts_max_bytes: MiB } }));
    const files = { 'pad-a.bin': pad('a', 600 * KiB), 'pad-b.bin': pad('b', 300 * KiB), 'pad-c.bin': pad('c', 600 * KiB) };
    const ctx = await deployable(fx, { files });
    for (const [name, keep] of [['first', 'pad-a.bin'], ['past', 'pad-c.bin'], ['within', 'pad-b.bin']]) await only(fx, ctx, name, [keep]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'first');
    const [first] = artifactsOf(fx.home, ctx.project);
    await assertRefusedBound(fx, ctx, 'past', 'retention_full');
    const kept = artifactsOf(fx.home, ctx.project).find((a) => a.id === first.id);
    assert.equal(kept?.status, 'sealed', 'the referenced artifact is not evicted');
    assert.equal(manifestDigest(treeManifest(first.path).entries), first.digest, 'and its sealed copy is intact');
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'within');
    const rows = artifactsOf(fx.home, ctx.project);
    assert.equal(rows.length, 2, 'the one within the total is sealed');
    assert.ok(rows.reduce((n, r) => n + r.bytes, 0) <= MiB, 'the retained total stays within artifacts_max_bytes');
  });

  test('(c) host_reserve_disk as artifact admission sees it (--harness-artifact-free-bytes): an artifact that keeps the reserve free passes; one that would not is refused disk_reserve', async () => {
    const reserve = 1024 * MiB;
    const fx = guard.track(await scriptedEngine(shared.context, { start: false, config: { host_reserve_disk: reserve } }));
    await fx.start({ args: ['--harness-artifact-free-bytes', String(reserve + 600 * KiB)] });
    const files = { 'pad-small.bin': pad('s', 500 * KiB), 'pad-large.bin': pad('l', 700 * KiB) };
    const ctx = await deployable(fx, { files });
    await only(fx, ctx, 'under', ['pad-small.bin']);
    await only(fx, ctx, 'over', ['pad-large.bin']);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'under');
    await assertRefusedBound(fx, ctx, 'over', 'disk_reserve');
  });

  test('(c), (e) artifact_prepare_deadline on the controlled clock: 590 s of preparation passes, 601 s is refused prepare_deadline; while the preparation waits, the API answers within 2 s', async () => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const files = { 'pad-a.bin': pad('a', 4 * KiB), 'pad-b.bin': pad('b', 4 * KiB) };
    const ctx = await deployable(fx, { files });
    await only(fx, ctx, 'under', ['pad-a.bin']);
    await only(fx, ctx, 'over', ['pad-b.bin']);

    await armBarrier(fx.engine, 'artifact.staging_written', 'pause');
    const under = requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'under');
    await atBarrier(fx.engine, 'artifact.staging_written');
    const started = performance.now();
    const info = await fx.engine.get('/v1/engine');
    const took = performance.now() - started;
    assert.equal(info.status, 200, '(e) GET /v1/engine answers during the preparation');
    assert.ok(took < 2000, `(e) within 2 s (${Math.round(took)} ms)`);
    await advanceClock(fx.engine, 590);
    await releaseBarrier(fx.engine, 'artifact.staging_written');
    const done = await under;
    assert.ok([200, 201].includes(done.status), `under the deadline: the request is answered with its authorization (${done.status} ${done.text})`);

    await armBarrier(fx.engine, 'artifact.staging_written', 'pause');
    const over = requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'over');
    await atBarrier(fx.engine, 'artifact.staging_written');
    await advanceClock(fx.engine, 601);
    await releaseBarrier(fx.engine, 'artifact.staging_written');
    const res = await over;
    assert.deepEqual([res.status, res.body?.code, res.body?.subject?.refusal], [422, 'artifact_refused', 'prepare_deadline'], `past the deadline: refused (${res.text})`);
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'no staging left');
  });

  test('(d) a preparation killed, and one cancelled by the engine\'s orderly stop: after the restart only the unreferenced staging is gone and the referenced artifact is intact', async () => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const files = { 'pad-a.bin': pad('a', 4 * KiB), 'pad-b.bin': pad('b', 4 * KiB), 'pad-c.bin': pad('c', 4 * KiB) };
    const ctx = await deployable(fx, { files });
    for (const [name, keep] of [['kept', 'pad-a.bin'], ['killed', 'pad-b.bin'], ['cancelled', 'pad-c.bin']]) await only(fx, ctx, name, [keep]);
    await deploy(fx.engine, ctx.project, ctx.candidate.id, 'kept');
    const [kept] = artifactsOf(fx.home, ctx.project);

    await armBarrier(fx.engine, 'artifact.staging_written', 'kill');
    await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'killed').catch(() => null);
    await fx.engine.exited;
    await fx.start();
    await tick(fx.engine, ctx.project);
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'after the killed preparation and a restart: nothing under artifacts/ but recorded artifacts');
    assert.equal(manifestDigest(treeManifest(kept.path).entries), kept.digest, 'the referenced artifact is intact');

    await armBarrier(fx.engine, 'artifact.staging_written', 'pause');
    const pending = requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'cancelled').catch(() => null);
    await atBarrier(fx.engine, 'artifact.staging_written');
    await fx.engine.stop();
    await pending;
    await fx.start();
    await tick(fx.engine, ctx.project);
    assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], 'after the cancelled preparation and a restart: nothing under artifacts/ but recorded artifacts');
    assert.equal(artifactsOf(fx.home, ctx.project).find((a) => a.id === kept.id)?.status, 'sealed', 'the referenced artifact is still sealed');
    assert.equal(manifestDigest(treeManifest(kept.path).entries), kept.digest, 'and intact');
  });

  test('(d) m5: a request not authorized, a coalesced request and one refused for config_secrets_changed each leave nothing under artifacts/ that no artifacts row records, within artifacts_max_bytes', async () => {
    const dir = makeTempDir('m309-secret');
    shared.context.after(() => removeDir(dir));
    const file = join(dir, 'token');
    writeFileSync(file, `surety-m309-${randomBytes(16).toString('hex')}\n`);
    chmodSync(file, 0o600);
    const args = ['--secret-file', `deploy/app_token=${file}`];
    const fx = guard.track(await scriptedEngine(shared.context, { start: false }));
    await fx.start({ args });
    const secrets = { secrets: { APP_TOKEN: 'deploy/app_token' } };
    const ctx = await deployable(fx, { qualify: false, config: secrets });
    const clean = (what) => {
      assert.deepEqual(unrecordedUnderArtifacts(fx.home), [], `${what}: every entry under artifacts/ lies within a recorded artifact`);
      const total = artifactsOf(fx.home, ctx.project).reduce((n, r) => n + r.bytes, 0);
      assert.ok(total <= 2 * 1024 * MiB, `${what}: the recorded total is within artifacts_max_bytes`);
    };

    const refused = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([refused.status, refused.body?.code], [409, 'authorization_not_issued'], `no qualification: not authorized (${refused.text})`);
    clean('not authorized');

    await qualifyByFixture(fx.engine);
    const issued = await deploy(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    const rows = artifactsOf(fx.home, ctx.project).length;
    const again = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, ctx.env.name);
    assert.deepEqual([again.status, again.body?.authorization?.id], [200, issued.authorization.id], `the repeat coalesces (${again.text})`);
    assert.equal(artifactsOf(fx.home, ctx.project).length, rows, 'coalesced: no artifacts row added');
    clean('coalesced');

    await configure(fx.engine, ctx.project, 'beta', configContent(secrets));
    writeFileSync(file, `surety-m309-${randomBytes(16).toString('hex')}\n`);
    await fx.engine.stop();
    await fx.start({ args });
    const changed = await requestDeployment(fx.engine, ctx.project, ctx.candidate.id, 'beta');
    assert.deepEqual([changed.status, changed.body?.code], [409, 'config_secrets_changed'], `the secret changed across the restart: refused (${changed.text})`);
    clean('refused for config_secrets_changed');
  });

  test('(f) the defaults BS4 §11.3 set are in force, and a value outside its range is refused at start', async (t) => {
    const fx = guard.track(await scriptedEngine(shared.context));
    const { config } = await fx.engine.engineInfo();
    const want = { artifact_max_entries: 20000, artifact_max_bytes: 268435456, artifacts_max_bytes: 2147483648, artifact_prepare_deadline: 600, adapter_read_deadline: 10 };
    for (const [key, value] of Object.entries(want)) assert.equal(config[key]?.value, value, `${key} defaults to ${value}`);
    const refusals = [
      [{ artifact_max_entries: 99 }, 'artifact_max_entries'],
      [{ artifact_max_entries: 200001 }, 'artifact_max_entries'],
      [{ artifact_max_bytes: MiB - 1 }, 'artifact_max_bytes'],
      [{ artifact_max_bytes: 4 * MiB, artifacts_max_bytes: 2 * MiB }, 'artifacts_max_bytes'],
      [{ artifact_prepare_deadline: 9 }, 'artifact_prepare_deadline'],
      [{ artifact_prepare_deadline: 3601 }, 'artifact_prepare_deadline'],
    ];
    for (const [over, field] of refusals) {
      const home = makeTempDir('m309-config');
      t.after(() => removeDir(home));
      writeEngineConfig(home, { api_port: await freePort(), ...over });
      const result = await startRefused({ home });
      assert.deepEqual([result.code, result.refusal?.code, result.refusal?.subject?.field], [EXIT.config, 'invalid_value', field], `${JSON.stringify(over)} is refused at start, naming ${field} (stderr: ${result.stderr.slice(-300)})`);
    }
  });
});
