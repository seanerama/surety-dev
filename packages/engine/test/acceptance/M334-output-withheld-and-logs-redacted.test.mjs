// M334, output withheld after a restart; logs redacted (slice 28; sandbox
// lane). M4 plan §3.6 M334, and M324 (a)'s logs and relay refusals after an
// engine restart (deferred by slice 26, SEAM §280; E129 item 9); D4-S05,
// D4-A09; D4 §§6.1, 7.3, 9.2, 9.3; E110, E116; the driver's rulings on the
// slice-28 Builder's design; SEAM.md §§256 to 259, 268, 278, 294, 310, 314.
//
// The service is the fixture service (SEAM §258) with a held secret S0 in
// its environment (`APP_TOKEN`), which it writes to its own output at its
// start and every two seconds (`SECRET-OUT-<mark> <value>`, SEAM §314).
//   (a), (c), (b), (f) while it is supervised: the collection command
//       (`POST …/logs`) records one bounded `deployment_logs` record within
//       `adapter_output_max_bytes` (set to its minimum, 64 KiB, under a
//       256 KiB flood), holding the newest output with the value removed
//       before disk; the unit's standard streams name no sink of the
//       application's and its journal holds none of its output; no
//       verification row names a log record;
//   (d) S0 rotated to S1 (the file rewritten) and the engine killed and
//       started again with the S0 service surviving, which has written S0 to
//       its output (retained capture and new lines every two seconds) and
//       into its process title (`title-secret`, released before the kill),
//       and would write it into a response to a check (`GET /secret`): a
//       collection asked before the kill is recorded `refused`,
//       `redaction_unavailable`, and none is made; a new collection is 409
//       `redaction_unavailable`; the relay is 409 `redaction_unavailable`
//       and nothing listens on its port; a re-verification runs no check
//       against it and nothing reaches it through the link: its first
//       identity read `differs` on `argv` (the title, D4 §3.4 step 4) with
//       no value recorded, so the round registers none, or any check it
//       registers is not run, `redaction_unavailable` (objection 051; the
//       register-then-refuse form is M324 (a)'s); reads of the survivor (the
//       round's identity reads and an observation's) are made and recorded;
//       the check's response is never made, the link being refused (before
//       the kill a check printing S0 is screened and raises the critical
//       finding, D4 §7.3, as M218 pins for check output: not this case's);
//       neither S0 nor S1, raw or JSON-escaped, is in the engine home
//       (store, records, events), the responses, the unit's properties, its
//       journal or the engine's output;
//   (a), the slice-28 review's S1 (i): the service writes `token=` and the
//       first 20 characters of S0 with no line end (the fixture's
//       `split-secret`, the rest 90 s later); a collection made in the pause
//       publishes no prefix of S0 of 8 bytes or more (SEAM §320); once the
//       line is whole a collection holds it with S0 redacted;
//   (e) the owner resolves the secrets and redeploys: supervision
//       `attached`, the collection recorded again (redacted), the relay
//       opens, the check runs: the refusals end.
//
// SAFETY (BS4 §4.1; E64; SEAM.md §§257, 258, 274). Every unit is the
// engine's, under this test's home's prefix; the test acts on no unit. The
// fixture's acts (`flood`, `title-secret`) are released only after
// `assertServiceContained` reads the service's containment from the host,
// and run only when the service reads itself contained. The engine is
// killed only by `killOwnEngine` (SIGKILL through the ChildProcess handle the
// harness spawned, after reading /proc that it is this home's engine).
// Values are compared in memory, never printed. Every environment is ended
// in `finally`; the file ends with `operatorGuard`. It is the slice's last
// file (BS4 §4.1 rule 9).

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';

import { makeTempDir, removeDir } from './harness/engine.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { withStore } from './harness/store.mjs';
import { configure, deploy, environmentRead, resolveSecrets } from './harness/deploy/kernel.mjs';
import { collectLogs, logsRead, observeOnHost, oobDecision, openOob } from './harness/deploy/observe.mjs';
import { answerOn, killOwnEngine, startAgain } from './harness/deploy/recover.mjs';
import { roundsOf, verificationsOf, verifyAgain } from './harness/deploy/rounds.mjs';
import {
  assertServiceContained,
  cmdlineOf,
  endCase,
  filesHoldingAny,
  heldCheck,
  holdsAny,
  hostConfig,
  hostDeployable,
  journalOf,
  newestOperation,
  operatorGuard,
  postDeployOf,
  procInstance,
  releaseCheck,
  secretArgs,
  secretFile,
  serviceLinkLogs,
  serviceOf,
  targetReport,
  testSecret,
  ticksUntil,
  unitShow,
  unitShowAll,
  valueForms,
  verificationOf,
} from './harness/deploy/host.mjs';

const REF = 'deploy/m334_app';
const OUTPUT_MAX = 65536;
const ENGINE = Object.freeze({ adapter_output_max_bytes: OUTPUT_MAX });
const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1 });
const EXIT_1 = Object.freeze({ get: ['/hello'], exit: 1 });

const resultOf = (home, execution) => withStore(home, (db) => db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(execution));
const recordText = (home, id) => readFileSync(recordFile(home, recordRow(home, id))).toString('utf8');

// Whether anything accepts a TCP connection on 127.0.0.1:<port> (the host's namespace).
function listening(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    setTimeout(() => done(false), 5000).unref();
  });
}

describe('M334 output withheld after a restart; logs redacted', () => {
  const shared = sharedFixture();
  let guard;
  let ctx;
  let dir;
  let file;
  let values;
  const responses = [];
  before(async () => {
    guard = operatorGuard();
    dir = guard.root(makeTempDir('m334-secrets'));
    values = { s0: testSecret('m334-s0'), s1: testSecret('m334-s1') };
    file = secretFile(dir, 'app', values.s0);
    ctx = await hostDeployable(shared.context, guard, { everyStart: secretArgs({ [REF]: file }), engineConfig: ENGINE, policy: POLICY });
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
      removeDir(dir);
    }
  });

  // An environment whose service holds REF as APP_TOKEN and writes it to its output.
  // `extra` replaces the periodic secret line (slice 28's review case writes the line itself).
  async function secretEnvironment(name, extra = null) {
    const base = await hostConfig();
    const content = { ...base, env: { ...base.env, SURETY_TEST_SECRET_VAR: 'APP_TOKEN', ...(extra ?? { SURETY_TEST_SECRET_EVERY_MS: '2000' }) }, secrets: { APP_TOKEN: REF } };
    const done = await configure(ctx.fx.engine, ctx.project, name, content);
    const env = { ...done.environment, name, content };
    ctx.envs[name] = env;
    return env;
  }

  // A deploy whose round's check is held, then released with `plan`; the row recorded.
  async function deployed(env, plan) {
    const known = newestOperation(ctx, env)?.id ?? null;
    responses.push(JSON.stringify(await deploy(ctx.fx.engine, ctx.project, ctx.candidate.id, env.name)));
    const op = await ticksUntil(ctx.fx, ctx.project, () => {
      const o = newestOperation(ctx, env);
      return o && o.id !== known && heldCheck(ctx, env) ? o : undefined;
    }, { timeoutMs: 300_000, what: `the deploy of ${env.name} to reach its round's check` });
    const svc = serviceOf(ctx, env, op);
    releaseCheck(ctx, svc, plan);
    const { row } = await verificationOf(ctx, op);
    return { op, svc, row };
  }

  // One collection asked and recorded; returns the stored read and the record's text.
  async function collected(env) {
    const before = (await logsRead(ctx.fx.engine, ctx.project, env.name)).body?.logs?.length ?? 0;
    const asked = await collectLogs(ctx.fx.engine, ctx.project, env.name);
    responses.push(asked.text);
    assert.equal(asked.status, 202, `the collection is asked (${asked.text})`);
    const read = await ticksUntil(ctx.fx, ctx.project, async () => {
      const r = await logsRead(ctx.fx.engine, ctx.project, env.name);
      return r.body?.state === 'collected' && r.body.logs.length > before ? r : undefined;
    }, { what: 'the log to be collected' });
    responses.push(read.text);
    const newest = read.body.logs[0];
    return { log: newest, text: recordText(ctx.fx.home, newest.record) };
  }

  test('(a), (b), (c), (f) while supervised: one bounded, redacted deployment_logs record; nothing of the application\'s on the unit\'s streams or in its journal; no verification reads a log', async () => {
    const env = await secretEnvironment('logs');
    try {
      const { op, svc } = await deployed(env, { get: ['/act/flood'], exit: 1 });
      const mark = env.content.env.MARK;
      // (a), (c)
      const { log, text } = await collected(env);
      assert.ok(log.bytes <= OUTPUT_MAX && statSync(recordFile(ctx.fx.home, recordRow(ctx.fx.home, log.record))).size <= OUTPUT_MAX, `(c) within adapter_output_max_bytes (${log.bytes} bytes)`);
      assert.ok(text.includes(`FLOOD-END-${mark}`), '(a) the record holds the service\'s newest output (the flood\'s end)');
      assert.ok(text.includes(`SECRET-OUT-${mark}`), '(a) including the lines that carried the secret');
      assert.deepEqual(holdsAny(text, { s0: values.s0 }), [], '(a) redacted before disk: the value is not in the record');
      // (b)
      const streams = unitShow(svc.unit, ['StandardOutput', 'StandardError']);
      for (const [k, v] of Object.entries(streams ?? {})) assert.ok(!/^(journal|kmsg|tty|inherit)/.test(v), `(b) the unit's ${k} is no sink of the application's (${v})`);
      const journal = journalOf(svc.unit).text;
      for (const line of [`APP-OUTPUT-${mark}`, `SECRET-OUT-${mark}`, `FLOOD-END-${mark}`]) assert.ok(!journal.includes(line), `(b) the unit's journal holds none of the application's output (${line})`);
      assert.deepEqual(holdsAny(journal, values), [], '(b) nor the value');
      // (f) a verification after the collection reads no log.
      const round = await verifyAgain(ctx.fx.engine, ctx.project, op.id);
      await ticksUntil(ctx.fx, ctx.project, () => heldCheck(ctx, env), { what: 'the re-verification\'s check' });
      releaseCheck(ctx, svc, EXIT_1);
      await verificationOf(ctx, op);
      const logIds = withStore(ctx.fx.home, (db) => db.prepare(`SELECT "id" FROM "records" WHERE "kind" = 'deployment_logs'`).all()).map((r) => r.id);
      assert.ok(logIds.length > 0, 'the fixture is live: a log record exists');
      for (const r of roundsOf(ctx.fx.home, op.id)) {
        const rows = JSON.stringify({ round: r, rows: verificationsOf(ctx.fx.home, r.id) });
        for (const id of logIds) assert.ok(!rows.includes(id), `(f) no verification's inputs name a log (round ${r.round}; D4 §9.3)`);
      }
      assert.ok(roundsOf(ctx.fx.home, op.id).some((r) => r.id === round.id));
      assert.deepEqual(filesHoldingAny(ctx.fx.home, valueForms(values.s0)), [], 'no file of the engine home holds the value');
    } finally {
      await endCase(ctx, env);
    }
  });

  test('(a) a line the collection cuts (the slice-28 review, S1 (i)): a collection made while the service has written only part of a line holding the secret publishes no prefix of it of 8 bytes or more; once the line is whole it is collected redacted', async () => {
    const env = await secretEnvironment('split', { SURETY_TEST_SPLIT_PAUSE_MS: '90000' });
    try {
      const mark = env.content.env.MARK;
      const { op, svc, row } = await deployed(env, { get: ['/act/split-secret'], exit: 1 });
      const ended = Date.now();
      const held = postDeployOf(ctx, env).find((x) => x.deployment?.operation === op.id);
      const report = targetReport(ctx, held);
      assert.equal(report.report.results[0]?.status, 200, `the fixture is live: the service wrote the first part of the line (the act answered) (${JSON.stringify(report.report.results)})`);
      assert.ok(row, 'the round is decided');
      assert.ok(Date.now() - ended < 60_000, 'the fixture is live: the collection is asked well within the act\'s 90 s pause');
      const { text } = await collected(env);
      const found = [8, 20].map((n) => valueForms(values.s0).map((f) => f.slice(0, n))).flat().filter((f) => text.includes(f));
      assert.deepEqual(found.length, 0, `no prefix of the held secret of 8 bytes or more reaches the deployment_logs record (SEAM §320)`);
      assert.ok(procInstance(svc.app.pid), 'the service still runs');
      // The control: once the line is whole, a collection holds it, redacted.
      await new Promise((r) => setTimeout(r, Math.max(0, ended + 92_000 - Date.now())));
      const whole = await collected(env);
      assert.ok(whole.text.includes(`SPLIT-${mark} token=`), 'the control: once the rest of the line is written the line is collected');
      assert.deepEqual(holdsAny(whole.text, { s0: values.s0 }), [], 'and the value in it is redacted');
      assert.ok(!whole.text.includes(values.s0.slice(0, 8)), 'and no prefix of it remains');
    } finally {
      await endCase(ctx, env);
    }
  });

  test('(d), (e) S0 rotated to S1 and the engine restarted with the S0 service surviving: logs, relay and checks refused redaction_unavailable; no value in records, events, responses, unit properties or the journal; a redeploy ends the refusals', async () => {
    const env = await secretEnvironment('withheld');
    try {
      // The survivor writes S0 into its process title, then into its output for ever (objection 051: no /secret
      // before the kill, whose screen hit would raise the critical finding D4 §7.3 requires and block (e)).
      const { op, svc } = await deployed(env, { get: ['/act/title-secret'], exit: 1 });
      await ticksUntil(ctx.fx, ctx.project, () => (cmdlineOf(svc.app.pid).join(' ').includes(values.s0) ? true : undefined), { what: 'the title to carry the value (host-read, compared in memory)' });
      // A collection asked, not yet made (no tick), when the engine dies.
      const pending = await collectLogs(ctx.fx.engine, ctx.project, env.name);
      responses.push(pending.text);
      assert.equal(pending.status, 202, `the fixture is live: a collection is pending (${pending.text})`);
      assertServiceContained(ctx, svc, 'before the restart');

      // Rotate S0 to S1; SIGKILL to this test's own engine child (killOwnEngine reads its /proc first); start again.
      writeFileSync(file, `${values.s1}\n`);
      const killedAt = new Date().toISOString();
      await killOwnEngine(ctx.fx);
      await startAgain(ctx);
      const read = await environmentRead(ctx.fx.engine, ctx.project, env.name);
      responses.push(JSON.stringify(read));
      assert.equal(read.supervision, 'unknown', `the fixture is live: the survivor's supervision is unknown (E110) (${JSON.stringify(read.supervision)})`);
      assert.equal(cmdlineOf(svc.app.pid).join(' ').includes(values.s0), true, 'the fixture is live: the survivor runs, its title carrying S0');

      // Logs: the pending collection refused, none made; a new one 409.
      const logs = await ticksUntil(ctx.fx, ctx.project, async () => {
        const r = await logsRead(ctx.fx.engine, ctx.project, env.name);
        return r.body?.state === 'refused' ? r : undefined;
      }, { what: 'the pending collection to be recorded refused' });
      responses.push(logs.text);
      assert.equal(logs.body.reason ?? logs.body.refused?.reason, 'redaction_unavailable', `the pending collection is refused redaction_unavailable, never made (${logs.text})`);
      assert.ok(logs.body.logs.every((l) => l.collected_at < killedAt), 'no record was collected after the restart');
      const again = await collectLogs(ctx.fx.engine, ctx.project, env.name);
      responses.push(again.text);
      assert.deepEqual([again.status, again.body?.code], [409, 'redaction_unavailable'], `a new collection is refused (${again.text})`);
      // The relay.
      const relay = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/environments/${env.name}/relay`, {});
      responses.push(relay.text);
      assert.deepEqual([relay.status, relay.body?.code], [409, 'redaction_unavailable'], `the relay is refused (${relay.text})`);
      assert.equal(await listening(env.content.port), false, 'and nothing listens on its port');
      // A check against it: not run, nothing through the link; its round's identity reads made.
      const round = await verifyAgain(ctx.fx.engine, ctx.project, op.id);
      const row = await ticksUntil(ctx.fx, ctx.project, () => verificationsOf(ctx.fx.home, round.id)[0], { what: 'the re-verification\'s row' });
      const executions = postDeployOf(ctx, env).filter((x) => x.deployment?.round === round.id);
      const firstRead = (row.identity_reads ?? []).find((r) => r.bracket === 'first');
      console.log(`# note: M334 (d)'s re-verification registered ${executions.length} check(s); its first read ${firstRead?.match} (${firstRead?.detail?.field ?? 'no field'})`);
      if (executions.length === 0) {
        // The title changed the survivor's arguments: the first read differs and no check is registered (objection 051).
        assert.equal(firstRead?.match, 'differs', `no check registered: the round's first identity read differs (D4 §3.4 step 4) (${JSON.stringify(firstRead)})`);
        assert.equal(firstRead?.detail?.field, 'argv', `on the arguments the title rewrote (${JSON.stringify(firstRead?.detail)})`);
      }
      for (const x of executions) {
        const r = resultOf(ctx.fx.home, x.id);
        assert.deepEqual([r?.execution_established, r?.not_run_reason], [0, 'redaction_unavailable'], `the check is not run (${JSON.stringify(r)})`);
        assert.ok(!serviceLinkLogs(ctx.fx.home, ctx.project).some((l) => l.entries.some((e) => e.execution === x.id)), 'and reaches nothing through the link');
      }
      assert.ok((row.identity_reads ?? []).length > 0, `the survivor is read (${JSON.stringify(row.identity_reads)})`);
      const observed = await observeOnHost(ctx, env, ticksUntil);
      assert.ok(observed, 'an observation of the survivor is recorded (its status and identity read)');

      // Neither value, raw or escaped, anywhere the engine writes or answers.
      const places = [
        ['the responses', responses.join('\n')],
        ['the unit\'s properties', unitShowAll(svc.unit)],
        ['the unit\'s journal', journalOf(svc.unit).text],
        ['the engine\'s output', ctx.fx.engines.map((e) => `${e.output().stdout}${e.output().stderr}`).join('')],
      ];
      for (const [what, text] of places) assert.deepEqual(holdsAny(text, values), [], `${what} hold neither S0 nor S1 (D4-S05)`);
      assert.deepEqual(filesHoldingAny(ctx.fx.home, Object.values(values).flatMap(valueForms)), [], 'no file of the engine home (store, records, events) holds either, and every one was read');

      // (e) the owner resolves the secrets; the out-of-band rows the changed
      // title opened (CD4: arguments that differ) are acknowledged, so a
      // deploy's precondition holds (D4 §6.3); a redeploy; the refusals end.
      const resolved = await resolveSecrets(ctx.fx.engine, ctx.project, env.name);
      assert.equal(resolved.status, 201, `a new version (${resolved.text})`);
      for (const r of openOob(ctx.fx.home, env.id)) await answerOn(ctx, oobDecision(ctx.fx.home, r), 'acknowledge');
      const second = await deployed(env, EXIT_1);
      assert.equal((await environmentRead(ctx.fx.engine, ctx.project, env.name)).supervision, 'attached', '(e) supervision attached after the redeploy');
      const ran = postDeployOf(ctx, env).filter((x) => x.deployment?.operation === second.op.id);
      assert.ok(ran.some((x) => resultOf(ctx.fx.home, x.id)?.execution_established === 1), '(e) the check ran');
      const { text } = await collected(env);
      assert.deepEqual(holdsAny(text, values), [], '(e) the collection is made, redacted');
      const opened = await ctx.fx.engine.post(`/v1/projects/${ctx.project}/environments/${env.name}/relay`, {});
      assert.ok(opened.status >= 200 && opened.status < 300, `(e) the relay opens (${opened.text})`);
      const closed = await ctx.fx.engine.request('DELETE', `/v1/projects/${ctx.project}/environments/${env.name}/relay`);
      assert.ok(closed.status >= 200 && closed.status < 300, `the relay closes (${closed.text})`);
    } finally {
      await endCase(ctx, env);
    }
  });
});
