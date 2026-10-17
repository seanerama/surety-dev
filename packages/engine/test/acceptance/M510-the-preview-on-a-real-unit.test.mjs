// M510, the preview on a real unit (slice 42; sandbox lane). M6 plan §3.4
// M510; D7 §5.7, A.6, A.7; G4; D4 §4.6, §9.2, §9.3, Q7; E126; BS6 §4.1
// rules 1, 2, 7, 8, 13, 15, 17, 21 to 24; SEAM.md §§488, 498 to 501;
// objection 135 (decided: the preview's unit named from its environment's
// id as D4 §9.3 names every unit).
//
// The reference project "Pantry" under `design: before_build`, on real
// domains, the real `local_service` adapter qualified by `surety
// qualify-adapter` in the test's home, the API stage built and verified
// first (so nothing of the project is in flight while the preview's cases
// run), then one Designer session whose save is the checkpoint. In order,
// each case one step, a case after a failed one failing "did not reach":
//   (a) `surety design preview --revision checkpoint`: the design tree sealed
//       at that revision (the sealed directory exactly `.surety/design/` at
//       the checkpoint) and deployed through D4's operation;
//       `design.preview_deployed` with each mockup's `preview_capability`;
//   (b) the unit `surety-<h>-<env id>-g1.service` by exact name, `<env id>`
//       the project's reserved `design-preview` row's (objection 135), the
//       only one of its prefix and under the guard's `env_` pattern; its
//       domain's `memory.max` reads back `preview_memory_max` (256 MiB); no
//       shared check capacity reserved;
//   (c) verified by the two identity reads (`tree_digest`) only: no
//       authorization, no `alpha_authorize`, no behaviour check;
//   (g) the server: the engine's own file in the engine's install, run by
//       the engine's node, its hash the deployment's `server_digest`;
//   (d) access: `surety env open design-preview` on 127.0.0.1 only, the
//       URL's port; the index lists every mockup with its target and
//       capability; a `static_html` mockup's bytes equal the sealed tree's;
//       a request outside the tree refused; a write refused (read-only);
//   (e) a second preview replaces the first (D4's stop-then-start: one
//       generation); `--stop`; `design_preview_ttl` lowered, the session
//       closed and the controlled clock past close plus the TTL; a newer
//       approved design: each torn down, `design.preview_torn_down`;
//   (f) teardown applied each time, nothing of the prefix left.
//
// SAFETY (BS6 §4.1; E64; SEAM.md §§257, 474, 488). Every unit is the
// engine's own, `surety-<h>-…` with <h> this home's hash; the test starts
// and stops the preview only through the engine's commands, reads units by
// exact name or by the list filtered to this home's hash (§474), and acts on
// none itself but by `stopPreviewLeftovers`' exact name after the file (an
// `env_` name, so the fail-closed teardown and the guard see it too). It
// signals nothing but its own engine (the verified kill). The relay is
// opened by the test's own command on 127.0.0.1 and closed by the case that
// opened it (rule 24). The Designer's files are read as bytes over HTTP,
// never rendered or run (rules 21, 22). The first preview on a real unit is
// the driver's to start, with Sean shown the before-and-after unit lists
// (rule 23; done at slice 40's M536). The file ends with `operatorGuard`.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { assertOwnUnit, cmdlineOf, exeShaOf, operatorGuard, unitShow } from './harness/deploy/host.mjs';
import { RUNTIME, filesUnder } from './harness/deploy/kernel.mjs';
import { qualifyByCommand } from './harness/deploy/qualify.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { journeyContext, pump } from './harness/journey/drive.mjs';
import { journeyEngine } from './harness/journey/project.mjs';
import { advanceClock, tick } from './harness/runs.mjs';
import { waitFor } from './harness/engine.mjs';
import { consume } from './harness/decisions.mjs';
import { ANDROID_MOCKUP_PATH, WEB_MOCKUP_PATH } from './harness/design/reference.mjs';
import { answerWith, batchOf, cli, createPantry, designScripts, designerSession, pantryArchitect, pantrySpec, scriptBuilders, stageRow, validDesign } from './harness/design/drive.mjs';
import { BEFORE_BUILD } from './harness/design/check41.mjs';
import {
  ENGINE_INSTALL,
  PREVIEW_ENV,
  PREVIEW_MEMORY_MAX,
  PREVIEW_TTL_MIN,
  assertSameFiles,
  countOf,
  designTreeAt,
  deployedEvents,
  domainOfAttempt,
  hexOf,
  homeUnits,
  hostListeners,
  indexEntries,
  intentOf,
  lastAttempt,
  memoryMaxOf,
  previewCgroups,
  previewEnvRow,
  previewOps,
  previewPrefix,
  previewUnitName,
  previewUnits,
  quiesce,
  rawRequest,
  sha256hex,
  stopPreviewLeftovers,
  teardownApplied,
  textOf,
  tornDownEvents,
} from './harness/design/preview42.mjs';

// The kinds the owner answers inside the build on this lane (as M536's).
const BUILD_KINDS = Object.freeze(['check_correction_unclassifiable', 'check_correction_loosening', 'plan_approval']);

describe('M510 the preview on a real unit (sandbox lane)', () => {
  const shared = sharedFixture();
  let guard;
  const J = {};
  let stopped = null;
  const step = (name, fn) =>
    test(name, async () => {
      assert.equal(stopped, null, `the file did not reach this case: it stopped at ${stopped}`);
      try {
        await fn();
      } catch (err) {
        stopped = name.slice(0, 3);
        throw err;
      }
    });
  // The newest preview deployed, waited for by the engine's progress.
  const deployedNth = (n, what) => pump(J.fx, J.ctx, () => deployedEvents(J.fx.home, J.p.id)[n - 1], { what, projectMs: 300_000 });
  const tornDownNth = (n, what) => pump(J.fx, J.ctx, () => (tornDownEvents(J.fx.home, J.p.id).length >= n && previewUnits(J.fx.home, J.env.id).length === 0 ? tornDownEvents(J.fx.home, J.p.id)[n - 1] : undefined), { what, projectMs: 300_000 });
  const preview = (revision = 'checkpoint') => cli(J.fx, ['design', 'preview', '--project', J.p.id, '--revision', revision]);

  before(async () => {
    guard = operatorGuard();
    J.fx = await journeyEngine(shared.context, guard, { lane: 'project' });
    designScripts(J.fx);
  });
  after(async () => {
    const problems = [];
    try {
      const { fx, p } = J;
      if (fx && p) {
        if (J.relayOpen) cli(fx, ['env', 'close', PREVIEW_ENV, '--project', p.id]);
        const left = stopPreviewLeftovers(fx, p.id);
        if (left.length > 0) problems.push(`preview units left: ${left.join(', ')}`);
        const env = previewEnvRow(fx.home, p.id);
        if (env) for (const dir of previewCgroups(fx.home, env.id)) problems.push(`preview cgroup left: ${dir}`);
        if (!J.quiet) await quiesce(fx, p.id).catch((err) => problems.push(`the project could not be quiesced: ${err.message}`));
      }
      guard.assertClean();
      assert.deepEqual(problems, [], 'the file left nothing of the preview');
    } finally {
      await shared.cleanup();
    }
  });

  step('(a) surety design preview of the checkpoint: the tree sealed at that revision, deployed through D4\'s operation; design.preview_deployed with each mockup\'s preview_capability', async () => {
    const { fx } = J;
    const p = await createPantry(fx, { policy: BEFORE_BUILD });
    J.p = p;
    J.ctx = journeyContext(fx, p, { lane: 'project', tier: 'T2' });
    J.ctx.answerKinds = [...BUILD_KINDS];
    await pantrySpec(fx, p.id);
    const arch = await pantryArchitect(fx, p.id, p.repo);
    assert.equal(arch.closeRes.status, 200, `the Architect's close is accepted (${arch.closeRes.status} ${arch.closeRes.text?.slice(0, 400)})`);
    scriptBuilders(fx, p.id);
    const q = qualifyByCommand(fx);
    assert.equal(q.status, 0, `surety qualify-adapter local_service exits 0 in the test's home (${q.stdout.slice(0, 300)} ${q.stderr.slice(0, 300)})`);
    await pump(fx, J.ctx, () => (stageRow(fx.home, p.id, 1)?.status === 'verified' ? true : undefined), { what: 'the API stage to be verified (the project quiet after it: its UI stages held)', projectMs: 900_000 });
    const s = await designerSession(fx, p.id, [{ files: validDesign(p), say: 'Draw Pantry for the web and Android.' }], { close: null });
    J.session = s.run;
    assert.equal(s.saves[0]?.body?.design_check?.outcome, 'passed', `the reference design saved (${s.saves[0]?.text?.slice(0, 300)})`);
    J.checkpoint = s.saves[0].body.revision;
    J.before = {
      units: homeUnits(fx.home),
      authorizations: countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations"'),
      alphaAuthorize: countOf(fx.home, 'SELECT COUNT(*) AS n FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = \'alpha_authorize\'', p.id),
      requests: countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_requests" WHERE "project" = ?', p.id),
    };
    // No preview unit before: the reserved row, if it already exists, has no unit
    // (and (b) reads that none of its prefix was in this list once its id is known).
    const env0 = previewEnvRow(fx.home, p.id);
    if (env0) assert.deepEqual(previewUnits(fx.home, env0.id), [], 'no preview unit before');

    const asked = preview('checkpoint');
    assert.equal(asked.status, 0, `surety design preview exits 0 (${asked.stdout.slice(0, 400)} ${asked.stderr.slice(0, 400)})`);
    assert.deepEqual([asked.body?.preview?.environment, asked.body?.preview?.generation], [PREVIEW_ENV, 1], `the answer names the environment and generation 1 (SEAM.md §488) (${asked.stdout.slice(0, 400)})`);
    J.url = asked.body.preview.url;
    assert.match(J.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/, 'the URL printed, on 127.0.0.1');
    J.deployed = await deployedNth(1, 'the first preview to be deployed');
    J.env = previewEnvRow(fx.home, p.id);
    assert.ok(J.env, 'the reserved environment design-preview, a row of the project (SEAM.md §499)');
    J.op = previewOps(fx.home, p.id).at(-1);
    assert.ok(J.op, 'a deploy operation on it (D4\'s operation)');
    J.attempt = lastAttempt(fx.home, J.op);
    const sealed = J.attempt?.capability?.sealed_path;
    assert.ok(sealed && existsSync(sealed), `the attempt names its sealed directory (${sealed})`);
    assertSameFiles(filesUnder(sealed), designTreeAt(p.repo.path, J.checkpoint), 'the sealed directory is .surety/design/ at the checkpoint, and nothing else');
    const payload = J.deployed.payload ?? {};
    assert.equal(payload.generation, 1);
    const mockups = [...(payload.mockups ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(mockups, [
      { path: ANDROID_MOCKUP_PATH, target: 'android', preview_capability: 'simulated' },
      { path: WEB_MOCKUP_PATH, target: 'web', preview_capability: 'native' },
    ].sort((a, b) => a.path.localeCompare(b.path)), `each mockup with its preview_capability (D7 §5.7) (${JSON.stringify(payload.mockups)})`);
    assert.equal(hexOf(payload.tree_digest), hexOf(J.attempt.capability.artifact_digest), 'the event names the sealed tree\'s digest');
  });

  step('(b) the unit surety-<h>-<env id>-g1.service by exact name; its domain\'s memory.max reads back preview_memory_max; no shared check capacity reserved for it', async () => {
    const { fx } = J;
    const unit = previewUnitName(fx.home, J.env.id, 1);
    assertOwnUnit(fx.home, unit, 'the preview\'s unit');
    assert.deepEqual(J.before.units.filter((u) => u.startsWith(previewPrefix(fx.home, J.env.id))), [], 'no unit of the preview\'s prefix before the preview');
    assert.deepEqual(previewUnits(fx.home, J.env.id).map((u) => u.unit), [unit], `the only unit of ${previewPrefix(fx.home, J.env.id)}`);
    assert.equal(J.deployed.payload?.unit, unit, 'the event names it');
    assert.deepEqual(intentOf(fx.home, J.op)?.create_units, [unit], 'the attempt intent names it, exactly');
    const shown = unitShow(unit, ['LoadState', 'ActiveState', 'MemoryMax', 'ControlGroup']);
    assert.deepEqual([shown?.LoadState, shown?.ActiveState], ['loaded', 'active'], `read from the host by exact name (${JSON.stringify(shown)})`);
    const domain = domainOfAttempt(fx.home, J.attempt.id);
    assert.ok(domain?.cgroup_path, `its service domain is recorded with its cgroup (${JSON.stringify(domain)})`);
    assert.equal(memoryMaxOf(domain.cgroup_path), PREVIEW_MEMORY_MAX, `host-read: ${domain.cgroup_path}/memory.max is preview_memory_max (256 MiB)`);
    assert.equal(Number(shown.MemoryMax), PREVIEW_MEMORY_MAX, 'the unit\'s MemoryMax likewise');
    assert.equal(domain.reservation?.memory, PREVIEW_MEMORY_MAX, `admitted at preview_memory_max (${JSON.stringify(domain.reservation)})`);
    assert.ok(!domain.reservation?.check_capacity, `no shared check capacity reserved (D7 §5.7; E126's is not) (${JSON.stringify(domain.reservation)})`);
  });

  step('(c) verified by the two identity reads only: no authorization, no alpha_authorize, no behaviour check', async () => {
    const { fx, p } = J;
    const reads = J.deployed.payload?.identity_reads ?? [];
    assert.deepEqual(reads.map((r) => r.match), ['match', 'match'], `two identity reads, both matching (${JSON.stringify(reads)})`);
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_authorizations"'), J.before.authorizations, 'no authorization');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "gate_evaluations" WHERE "project" = ? AND "gate_kind" = \'alpha_authorize\'', p.id), J.before.alphaAuthorize, 'no alpha_authorize');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "deployment_requests" WHERE "project" = ?', p.id), J.before.requests, 'no deployment request');
    assert.equal(countOf(fx.home, 'SELECT COUNT(*) AS n FROM "check_executions" WHERE "environment" = ?', J.env.id), 0, 'no behaviour check (no execution against the environment)');
    assert.equal(J.op.authorization ?? null, null, 'the operation carries no authorization');
  });

  step('(g) the server: the engine\'s own file in the engine\'s install, run by the engine\'s node, its hash recorded on the deployment', async () => {
    const app = lastAttempt(J.fx.home, J.op)?.app_instance;
    const pid = app?.pid;
    assert.ok(Number.isInteger(pid) && pid > 1, `the application's recorded pid (${JSON.stringify(app)})`);
    const argv = cmdlineOf(pid);
    assert.equal(exeShaOf(pid), RUNTIME.sha256, 'run by the engine\'s own node');
    const server = argv[1];
    assert.ok(server && server.startsWith(`${ENGINE_INSTALL}/`), `the server is a file of the engine's install ${ENGINE_INSTALL} (${JSON.stringify(argv)})`);
    const sealed = realpathSync(J.attempt.capability.sealed_path);
    assert.ok(!server.startsWith(`${sealed}/`) && !server.startsWith(`${J.fx.home}/`), 'not a file of the sealed tree or the home');
    assert.ok(existsSync(server), `${server} is on the host at the path the domain runs it from`);
    assert.equal(hexOf(J.deployed.payload?.server_digest), sha256hex(readFileSync(server)), `its hash is the deployment's server_digest (D7 §5.7) (${J.deployed.payload?.server_digest})`);
  });

  step('(d) access: surety env open design-preview on 127.0.0.1 only; the index with every mockup, its target and capability; a static_html mockup\'s bytes the sealed tree\'s; a request outside the tree refused; a write refused', async () => {
    const { fx, p } = J;
    const port = Number(new URL(J.url).port);
    const opened = cli(fx, ['env', 'open', PREVIEW_ENV, '--project', p.id]);
    assert.equal(opened.status, 0, `surety env open design-preview exits 0 (${opened.stdout.slice(0, 300)} ${opened.stderr.slice(0, 300)})`);
    J.relayOpen = true;
    try {
      assert.ok(opened.stdout.includes('127.0.0.1') && opened.stdout.includes(String(port)), `it prints where the preview is (${opened.stdout.slice(0, 300)})`);
      const listeners = hostListeners(port);
      assert.equal(listeners.length, 1, `one listener on the URL's port (${JSON.stringify(listeners)})`);
      assert.deepEqual([listeners[0].family, listeners[0].local.split(':')[0]], ['tcp', '0100007F'], 'bound on 127.0.0.1 only');
      const index = await rawRequest(port, 'GET', '/');
      assert.equal(index.status, 200, `the index (→ ${index.status} ${index.error ?? ''})`);
      const entries = indexEntries(textOf(index));
      assert.deepEqual(entries.map((e) => [e.path, e.target, e.capability]).sort(), [[ANDROID_MOCKUP_PATH, 'android', 'simulated'], [WEB_MOCKUP_PATH, 'web', 'native']].sort(), `every mockup with its target and capability (SEAM.md §500) (${JSON.stringify(entries)})`);
      const sealed = filesUnder(J.attempt.capability.sealed_path);
      const web = await rawRequest(port, 'GET', `/${WEB_MOCKUP_PATH}`);
      assert.equal(web.status, 200);
      assert.ok(web.bytes.equals(sealed[WEB_MOCKUP_PATH]), 'the static_html mockup\'s bytes equal the sealed tree\'s');
      for (const path of ['/../../../../etc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/mockups/..%2f..%2f..%2fetc%2fpasswd', '/inventory/../../surety/home/']) {
        const res = await rawRequest(port, 'GET', path);
        assert.ok([400, 403, 404].includes(res.status), `a request outside the tree refused: ${path} → ${res.status} ${res.error ?? textOf(res).slice(0, 120)}`);
      }
      for (const [method, path] of [['PUT', '/design.json'], ['POST', '/'], ['DELETE', `/${WEB_MOCKUP_PATH}`], ['PUT', '/new.html']]) {
        const res = await rawRequest(port, method, path, { body: method === 'DELETE' ? undefined : '{"tampered": true}', headers: { 'content-type': 'application/json' } });
        assert.equal(res.status, 405, `a write refused (read-only): ${method} ${path} → ${res.status} ${res.error ?? textOf(res).slice(0, 120)}`);
      }
      const again = await rawRequest(port, 'GET', '/design.json');
      assert.ok(again.status === 200 && again.bytes.equals(sealed['design.json']), 'design.json unchanged after the writes');
      assert.deepEqual(Object.keys(filesUnder(J.attempt.capability.sealed_path)).sort(), Object.keys(sealed).sort(), 'the sealed tree unchanged');
    } finally {
      const closed = cli(fx, ['env', 'close', PREVIEW_ENV, '--project', p.id]);
      J.relayOpen = closed.status !== 0;
    }
    assert.deepEqual(hostListeners(port), [], 'the relay closed by the case that opened it');
  });

  step('(e) a second preview replaces the first (one generation); --stop; the TTL past the session\'s close; a newer approved design: each torn down', async () => {
    const { fx, p } = J;
    // A second preview: generation 2, the first stopped then the second started.
    const second = preview('checkpoint');
    assert.equal(second.status, 0, `the second preview asked (${second.stdout.slice(0, 300)} ${second.stderr.slice(0, 300)})`);
    const d2 = await deployedNth(2, 'the second preview to be deployed');
    assert.equal(d2.payload?.generation, 2, 'generation 2');
    const op2 = previewOps(fx.home, p.id).at(-1);
    const prior = (intentOf(fx.home, op2)?.prior ?? []).map((x) => x.unit);
    assert.ok(prior.includes(previewUnitName(fx.home, J.env.id, 1)), `the new generation's intent names the first's unit as its prior: stopped, then started (D4's stop-then-start) (${JSON.stringify(prior)})`);
    assert.deepEqual(previewUnits(fx.home, J.env.id).map((u) => u.unit), [previewUnitName(fx.home, J.env.id, 2)], 'one preview generation: only g2 loaded');

    // --stop.
    const stop = cli(fx, ['design', 'preview', '--stop', '--project', p.id]);
    assert.equal(stop.status, 0, `surety design preview --stop exits 0 (${stop.stdout.slice(0, 300)} ${stop.stderr.slice(0, 300)})`);
    const t1 = await tornDownNth(1, 'the preview torn down by --stop');
    assert.deepEqual([t1.payload?.generation, t1.payload?.reason], [2, 'stop'], `design.preview_torn_down (${JSON.stringify(t1.payload)})`);

    // design_preview_ttl lowered (its least, 1 h), a third preview, the session closed: torn down at the close plus the TTL.
    const ttl = await fx.engine.post(`/v1/projects/${p.id}/policy`, { design_preview_ttl: PREVIEW_TTL_MIN });
    assert.equal(ttl.status, 200, `design_preview_ttl lowered to 3600 s, applied directly (SEAM.md §499) (→ ${ttl.status} ${ttl.text})`);
    assert.equal(preview('checkpoint').status, 0, 'the third preview asked');
    const d3 = await deployedNth(3, 'the third preview to be deployed');
    assert.equal(d3.payload?.generation, 3);
    // The unit's g<n> is D4's deployment generation, which the --stop teardown
    // also took (objection 160, upheld): read from the event, not built from 3.
    const unit3 = d3.payload?.unit;
    const g3 = new RegExp(`^${previewPrefix(fx.home, J.env.id)}g([1-9][0-9]*)\\.service$`).exec(typeof unit3 === 'string' ? unit3 : '');
    assert.ok(g3, `the third preview's unit, as design.preview_deployed names it, is surety-<h>-<the project's design-preview id>-g<n>.service (${JSON.stringify(unit3)})`);
    assert.ok(Number(g3[1]) > 2, `its generation is past the second preview's g2 (${unit3})`);
    const closed = await fx.engine.post(`/v1/projects/${p.id}/sessions/${J.session.id}/close`, {});
    assert.equal(closed.status, 200, `the Designer session closed (${closed.text?.slice(0, 300)})`);
    await pump(fx, J.ctx, () => (batchOf(fx.home, p.id)?.spec_change ? true : undefined), { what: 'the close\'s batch to be raised', projectMs: 600_000 });
    await tick(fx.engine, p.id, { rounds: 2 });
    assert.deepEqual(previewUnits(fx.home, J.env.id).map((u) => u.unit), [unit3], 'not torn down at the close itself');
    await advanceClock(fx.engine, PREVIEW_TTL_MIN + 60);
    await waitFor(async () => {
      await tick(fx.engine, p.id, { rounds: 1 });
      return tornDownEvents(fx.home, p.id).length >= 2 && previewUnits(fx.home, J.env.id).length === 0;
    }, { timeoutMs: 240_000, what: 'the preview torn down once the clock passed the close plus design_preview_ttl' });
    const t2 = tornDownEvents(fx.home, p.id)[1];
    assert.deepEqual([t2.payload?.generation, t2.payload?.reason], [3, 'ttl'], `design.preview_torn_down (${JSON.stringify(t2.payload)})`);

    // A fourth preview, then the batch approved: a newer approved design tears it down.
    assert.equal(preview('checkpoint').status, 0, 'the fourth preview asked');
    const d4 = await deployedNth(4, 'the fourth preview to be deployed');
    assert.equal(d4.payload?.generation, 4);
    const batch = batchOf(fx.home, p.id);
    assert.ok(batch?.design_approval && batch?.spec_change, 'the batch is open');
    const approved = await answerWith(fx, p.id, batch.design_approval, 'approve');
    assert.equal(approved.status, 200, `design_approval answered approve (${approved.text})`);
    await consume(fx, p.id, batch.spec_change, 'approve');
    const t3 = await tornDownNth(3, 'the preview torn down by the newer approved design');
    assert.deepEqual([t3.payload?.generation, t3.payload?.reason], [4, 'approved'], `design.preview_torn_down (${JSON.stringify(t3.payload)})`);
  });

  step('(f) teardown: each applied; nothing of the prefix left', async () => {
    const { fx, p } = J;
    await quiesce(fx, p.id);
    J.quiet = true;
    const teardowns = previewOps(fx.home, p.id, 'teardown');
    assert.equal(teardowns.length, 3, `three teardown operations on the reserved environment (--stop, the TTL, the approval) (${teardowns.map((o) => o.id).join(', ')})`);
    for (const op of teardowns) assert.ok(teardownApplied(fx.home, op), `teardown ${op.id} applied (D4 §4.6)`);
    assert.deepEqual(previewUnits(fx.home, J.env.id), [], 'no unit of the preview\'s prefix');
    assert.deepEqual(previewCgroups(fx.home, J.env.id), [], 'no cgroup of the preview\'s prefix');
    const runDir = join(fx.home, 'run');
    const leftover = existsSync(runDir) ? readdirSync(runDir, { recursive: true }).map(String).filter((n) => n.includes(J.env.id) || n.includes('design-preview')) : [];
    assert.deepEqual(leftover, [], 'no socket or runtime directory of the preview left');
    assert.deepEqual(homeUnits(fx.home).filter((u) => !J.before.units.includes(u)), [], 'no unit of this home\'s hash added by the file');
  });
});
