// M338 (a), (c), (e), (g): `surety qualify-adapter local_service` by command
// in the test's home, outside harness mode; and M336 (c)'s refused
// capability on the production path (slice 29; sandbox lane). M4 plan §3.7
// M338, §3.6 M336 (c); D4-A06, D4-A08, D4-R02; D4 §§2.2, 2.6, 9.5, 11 class
// B, A.3, A.5; AR N03; BS4 §11.3 (`adapter_read_deadline`); E121 item 3;
// SEAM.md §§316, 318, 321 to 323.
//
// A fresh sandbox-lane home whose engine runs outside harness mode, where
// the real `local_service` adapter is the only one and no stand-in exists
// (SEAM §§247, 248, 316). Nothing is qualified at start; then the owner's
// command qualifies the adapter (the CLI over POST /v1/adapters/:a/qualify):
//   (a) every case of D4 §2.6 recorded `passed` beside a control recorded
//       `passed`, in order; the row `current`, labelled by nothing, with the
//       engine's build, the host qualification in force and the profile
//       fingerprint; its qualification_evidence record with the host tools'
//       paths and versions; `adapter.qualified` with no fixture label;
//       corroborated: launches were granted to the qualification
//       environment's attempts, and its units were named in attempt intents
//       of this home's prefix;
//   M336 (c), deferred here by slice 28 (SEAM §318 reading (2)): the
//       `refused` case ran on the production path: a capability naming
//       another environment, another digest, another unit, a stale attempt
//       and a stale lease generation each refused, `deploy.capability_refused`
//       naming each member;
//   (c) afterwards no unit, cgroup, socket or directory of the qualification
//       environment, read from the host;
//   (e) `receipt_lost` is an in-process instrument, never an engine-crash
//       result: no engine incarnation began during the run, and the case
//       names the one it ran in;
//   (g) the qualification's host time and its identity reads' durations are
//       recorded, and printed for the report (BS4 §11.3: a read over half of
//       `adapter_read_deadline` goes back to Sean).
// (b) is M338-a-case-that-does-not-pass; (d) and (f) are the kernel file
// and M338-lapse-on-a-changed-host.
//
// SAFETY (BS4 §4.1 rules 1, 2, 5, 7; E64; SEAM.md §§257, 322). The test
// creates, stops and restarts no unit and signals nothing: the qualification
// creates and removes its own units through the engine's adapter, under this
// test's home's prefix (D4 §9.5), and its `unreadable` case changes only the
// bus address the adapter's own calls use, never the manager. The test only
// reads, by its own prefix, afterwards. The engine is stopped in order. The
// file ends with `operatorGuard`, which reports anything left by exact name.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { sharedFixture } from './harness/gates.mjs';
import { sandboxEngine } from './harness/sandbox/lane.mjs';
import { unitPrefix } from './harness/deploy/kernel.mjs';
import { cgroupsNamed, listUnits, operatorGuard } from './harness/deploy/host.mjs';
import {
  ADAPTER_CASES,
  REFUSED_MEMBERS,
  adapterQualifications,
  assertAnswerForm,
  caseEntry,
  eventsSince,
  evidenceOf,
  incarnationsOf,
  intendedUnder,
  maxSeq,
  qualificationRow,
  qualifyByCommand,
  toolVersionLine,
} from './harness/deploy/qualify.mjs';
import { withStore } from './harness/store.mjs';

const READ_DEADLINE_MS = 10_000;

describe('M338 qualify-adapter local_service by command, outside harness mode', () => {
  const shared = sharedFixture();
  let guard;
  let Q;
  before(async () => {
    guard = operatorGuard();
    const fx = await sandboxEngine(shared.context, { start: false });
    guard.track(fx);
    await fx.start({ harness: false });
    const info = await fx.engine.engineInfo();
    Q = { fx, info, rowsAtStart: adapterQualifications(fx.home), qualifiedAtStart: eventsSince(fx.home, 'adapter.qualified', 0) };
    Q.seq = maxSeq(fx.home);
    Q.incarnations = incarnationsOf(fx.home);
    Q.pid = fx.engine.pid;
    Q.started = Date.now();
    Q.cli = qualifyByCommand(fx);
    Q.elapsedMs = Date.now() - Q.started;
    Q.incarnationsAfter = incarnationsOf(fx.home);
    Q.running = fx.engine.isRunning();
    Q.pidAfter = fx.engine.pid;
    Q.body = Q.cli.body;
    if (Q.body?.environment) {
      const prefix = unitPrefix(fx.home, Q.body.environment);
      Q.prefix = prefix;
      Q.after = {
        units: (listUnits() ?? null)?.filter((u) => u.unit.startsWith(prefix)) ?? null,
        cgroups: cgroupsNamed(prefix),
        runFiles: (() => {
          try {
            return readdirSync(join(fx.home, 'run'), { recursive: true }).filter((n) => String(n).includes(Q.body.environment) || String(n).includes(prefix));
          } catch {
            return [];
          }
        })(),
      };
    }
  });
  after(async () => {
    try {
      guard.assertClean();
    } finally {
      await shared.cleanup();
    }
  });

  test('(a) the command qualifies the adapter: every case of D4 §2.6 passed beside a passed control, in order; nothing ran at start; outside harness mode', () => {
    assert.notEqual(Q.info.harness, true, 'the fixture is live: the engine runs outside harness mode, on the production adapter path');
    assert.deepEqual(Q.rowsAtStart, [], 'no qualification at engine start (D4 §2.6: by the operator\'s command only)');
    assert.deepEqual(Q.qualifiedAtStart, [], 'no adapter.qualified at start');
    assert.equal(Q.cli.status, 0, `surety qualify-adapter local_service exits 0 (stdout ${Q.cli.stdout.slice(0, 600)}; stderr ${Q.cli.stderr.slice(0, 400)})`);
    assertAnswerForm(Q.body, 'the command\'s answer');
    assert.equal(Q.body.qualified, true, 'the adapter is qualified');
    for (const name of ADAPTER_CASES) {
      const entry = caseEntry(Q.body, name);
      assert.deepEqual([entry?.result, entry?.control], ['passed', 'passed'], `${name}: passed, beside a control that passed (AR N03: by its explicit assertions and a working control) (${JSON.stringify(entry).slice(0, 400)})`);
      assert.ok(entry.detail !== null && typeof entry.detail === 'object' && Object.keys(entry.detail).length > 0, `${name}: its detail records what it observed, never an instrument's exit status alone (SEAM.md §323)`);
    }
  });

  const answered = () => assert.ok(Q.body && typeof Q.body === 'object', `the command answered with JSON (exit ${Q.cli.status}; stderr ${Q.cli.stderr.slice(0, 300)})`);

  test('(a) the row current, unlabelled, with the engine build, the host qualification in force and the profile fingerprint; its evidence with the host tools\' paths and versions; adapter.qualified with no fixture label', () => {
    answered();
    const row = qualificationRow(Q.fx.home, Q.body.adapter_qualification);
    assert.ok(row, 'the row exists');
    assert.equal(row.status, 'current');
    assert.equal(row.label, null, 'labelled by nothing: no fixture wrote it');
    assert.equal(row.adapter_version, Q.body.adapter_version);
    assert.ok(row.engine_build && row.profile_fingerprint, 'the engine build and the service profile fingerprint it covers');
    const host = withStore(Q.fx.home, (db) => db.prepare(`SELECT "id" FROM "host_qualifications" WHERE "status" = 'active'`).get());
    assert.equal(row.host_qualification, host?.id ?? '(none)', 'the host qualification in force');
    assert.deepEqual(row.cases.map((c) => [c.case, c.result, c.control]), ADAPTER_CASES.map((c) => [c, 'passed', 'passed']), 'the row records each case and its control');
    assert.equal(row.evidence, Q.body.evidence, 'and names the evidence record');
    const { content } = evidenceOf(Q.fx.home, row.evidence);
    for (const tool of ['systemd-run', 'systemctl']) {
      const t = content.tools?.[tool];
      assert.ok(t && isAbsolute(t.path ?? '') && basename(t.path) === tool && existsSync(t.path) && (statSync(t.path).mode & 0o111) !== 0, `${tool}: an absolute path to the executable it ran (D4 B: resolved to absolute paths) (${JSON.stringify(t)})`);
      assert.equal(t.version, toolVersionLine(tool), `${tool}: its version recorded as it prints it`);
    }
    const events = eventsSince(Q.fx.home, 'adapter.qualified', Q.seq).filter((e) => e.subject?.adapter_qualification === row.id);
    assert.equal(events.length, 1, 'adapter.qualified once');
    assert.notEqual(events[0].payload?.test_fixture, true, 'with no fixture label');
  });

  test('(a) corroborated: the qualification environment\'s units were named in attempt intents of this home\'s prefix, and launches were granted to its attempts (A and B at least)', () => {
    answered();
    const named = intendedUnder(Q.fx.home, Q.prefix);
    assert.ok(named.length >= 2, `the qualification created units only through recorded intents, under ${Q.prefix} (BS4 §4.1 rule 5) (${named.join(', ')})`);
    const granted = eventsSince(Q.fx.home, 'deploy.launch_authorized', Q.seq).filter((e) => e.subject?.environment === Q.body.environment);
    assert.ok(granted.length >= 2, `launches granted to the qualification environment (A, then B as generation 2) (${granted.length})`);
  });

  test('M336 (c), deferred from slice 28: the refused case on the production path, each forged member refused before any host call, deploy.capability_refused naming each', () => {
    answered();
    assert.equal(caseEntry(Q.body, 'refused')?.result, 'passed', 'the refused case passed outside harness mode');
    // Nothing else runs in this home (no project, no deployment): every refusal since the command began is the qualification's.
    const fields = eventsSince(Q.fx.home, 'deploy.capability_refused', Q.seq).map((e) => e.payload?.field);
    for (const accepted of REFUSED_MEMBERS) {
      assert.ok(fields.some((f) => accepted.includes(f)), `a capability forged in ${accepted.join(' or ')} was refused, deploy.capability_refused naming it (D4 §2.2) (fields: ${JSON.stringify(fields)})`);
    }
    assert.equal(caseEntry(Q.body, 'refused')?.control, 'passed', 'beside its control: an unforged capability accepted');
  });

  test('(c) afterwards no unit, cgroup, socket or directory of the qualification environment, read from the host', () => {
    answered();
    assert.ok(Q.after, 'the qualification environment is named');
    assert.notEqual(Q.after.units, null, 'the user units can be listed');
    assert.deepEqual(Q.after.units, [], `no unit of ${Q.prefix} is loaded`);
    assert.deepEqual(Q.after.cgroups, [], 'no cgroup of it');
    assert.deepEqual(Q.after.runFiles, [], 'no socket or runtime directory of it under $SURETY_HOME/run/');
    assert.equal(caseEntry(Q.body, 'teardown')?.result, 'passed', 'the teardown case itself passed');
  });

  test('(e) receipt_lost is in-process, never an engine-crash result: no incarnation began during the run, and the case names the one it ran in', () => {
    answered();
    assert.equal(Q.running, true, 'the engine ran throughout');
    assert.equal(Q.pidAfter, Q.pid, 'the same engine process');
    assert.deepEqual(Q.incarnationsAfter.map((i) => i.id), Q.incarnations.map((i) => i.id), 'no engine incarnation began during the qualification');
    const current = Q.incarnations.find((i) => i.pid === Q.pid && i.ended_at === null);
    assert.ok(current, 'the running incarnation is read');
    const entry = caseEntry(Q.body, 'receipt_lost');
    assert.equal(entry?.result, 'passed');
    assert.equal(entry.detail?.incarnation, current.id, `the case names the one incarnation it ran in (SEAM.md §323) (${JSON.stringify(entry.detail)})`);
  });

  test('(g) the host time and each identity read\'s duration are recorded (for the M4 report; BS4 §11.3)', () => {
    answered();
    const { content } = evidenceOf(Q.fx.home, Q.body.evidence);
    assert.ok(Number.isInteger(content.host_time_ms) && content.host_time_ms > 0, `the qualification's host time is recorded (${content.host_time_ms})`);
    assert.ok(content.host_time_ms <= Q.elapsedMs + 1000, 'within the command\'s own elapsed time');
    const reads = content.identity_reads ?? [];
    assert.ok(reads.length >= 2, `its identity reads are recorded (${reads.length})`);
    assert.ok(reads.some((r) => r.case === 'deploy_read_back'), 'deploy_read_back\'s among them');
    for (const r of reads) assert.ok(Number.isFinite(r.duration_ms) && r.duration_ms >= 0, `each with its duration (${JSON.stringify(r)})`);
    const slowest = Math.max(...reads.map((r) => r.duration_ms));
    console.log(`# note: M338 (g) qualification host time ${content.host_time_ms} ms (command ${Q.elapsedMs} ms); ${reads.length} identity reads, the slowest ${slowest} ms`);
    if (slowest > READ_DEADLINE_MS / 2) console.log(`# note: M338 (g) an identity read took ${slowest} ms, over half of adapter_read_deadline (BS4 §11.3: Sean decides)`);
  });
});
