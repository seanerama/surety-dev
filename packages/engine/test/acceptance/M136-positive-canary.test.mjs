// M136, the positive canary; delegation verified absent (M2 slice 14, REAL
// LANE, manifest `real`). M2 plan §3.8 M136; D2 §4.1, §4.2, §4.5, §7.2, A.3;
// AR B05, T08, T13; CH §3.7; SEAM.md §§148, 149, 159 to 165.
//
// PAID. The attempt's three canaries (this file's, M137's and M138's) are
// one attempt (`harness/real/attempt.mjs`, step `attempt`), run once by the
// first of the three files to reach it, after Sean's approval through the
// API, which the test waits for and never gives. The other two files judge
// the same attempt from its records; nothing is run twice.
//
// What can be asserted before the first paid run, and what cannot. D2 §4.5
// lists what only the canaries establish for Claude Code: which events carry
// usage and how often, the terminal success fields, the hosts contacted, key
// delivery, what it writes despite --no-session-persistence, exit statuses,
// TERM behaviour, and whether the stream's first event lists the tools.
// None of that is assumed here. The cases assert what D2 requires of the
// entry the attempt writes (every field present, with evidence; delegation
// shown unavailable; usage recorded as reported, never invented) and the
// test's own host-side reads (the domain's members). What the stream held is
// recorded verbatim for the report (`observed/attempt.json`), and is
// compared with the ledger only where it says something (a terminal event
// with `total_cost_usd`); where it is silent the case records that.

import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';

import { canaryOfKind, collectAttempt, homeOf, qualificationAttempt } from './harness/real/attempt.mjs';
import { REAL, REAL_TEST_TIMEOUT_MS, costStatusFor, judged, observe, readObserved, realPreflight, sha256, terminalOutput } from './harness/real/lane.mjs';
import { withStore } from './harness/store.mjs';
import { BOUNDARY, ISOLATION, hostId } from './harness/trust.mjs';

// The delegation and scheduling tools the template denies by name (D2 §4.5).
const DENIED = Object.freeze(['Agent', 'Task', 'ScheduleWakeup', 'Workflow']);
const HEX64 = /^[0-9a-f]{64}$/;

async function attemptOf(ctx) {
  const out = await qualificationAttempt(ctx);
  return { out, home: homeOf(ctx, 'home'), c: collectAttempt(homeOf(ctx, 'home'), out.attempt) };
}

describe('M136 the positive canary; delegation verified absent (real lane, paid)', () => {
  test('(a) the edit and the result: exactly the expected file content after materialization and exactly the expected result; exit class clean; the canary passed', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M136 (a)', async () => {
      const { c } = await attemptOf(ctx);
      assert.equal(c.attempt.status, 'succeeded');
      const p = canaryOfKind(c, 'positive');
      assert.ok(p, 'the positive canary ran');
      assert.equal(p.canary.passed, true, `the positive canary passed (${JSON.stringify(p.canary)})`);
      assert.equal(p.exit_class, 'clean', `exit class clean (${p.exit_class}; ${JSON.stringify(p.exit_evidence)})`);
      assert.equal(p.exit_evidence?.signal_by_engine, false, 'the engine signalled nothing');
      assert.equal(p.exit_evidence?.status, 0, 'the backend exited 0');

      // The engine's judgement, re-made by the test from what it recorded
      // (SEAM.md §165): the expected edit's bytes against what was read,
      // no-follow, from the workspace after materialization.
      const ev = p.evidence;
      assert.ok(ev?.expected?.edit && ev?.observed?.edit, `the positive canary's evidence holds the expected and the observed edit (SEAM.md §165): ${JSON.stringify(ev)}`);
      assert.equal(ev.observed.edit.path, ev.expected.edit.path, 'the edit is at the expected path');
      assert.equal(ev.observed.edit.type, 'file', 'a regular file, read without following a link');
      assert.equal(ev.observed.edit.sha256, sha256(ev.expected.edit.content), 'holding exactly the expected content');
      // The result: the collected value as the engine recorded it in the
      // canary's evidence (SEAM.md §165: `observed.result`, "the collected
      // value or null"). A canary run is never the acceptance pipeline, and
      // no section publishes a `result` record for it; if one is ever
      // published it must hold the same value. (Found by the E79 rehearsal:
      // this case first read a `result` record no section promises.)
      assert.deepEqual(ev.observed.result, ev.expected.result, `the collected result is exactly the expected one (${JSON.stringify(ev.observed.result)})`);
      if (p.result !== null) assert.deepEqual(p.result, ev.expected.result, `a published result record holds the same value (${JSON.stringify(p.result)})`);
      assert.deepEqual([p.run.outcome, p.run.reason_class], ['completed', 'none'], 'the canary run completed');

      // Recorded, not asserted beyond D2: the session id the engine assigned
      // and whether the stream's first event names the same one (D2 §1.7;
      // SEAM.md §146: "whether Claude Code 2.1.288 accepts the id at all is
      // the positive canary's to establish"). A clean run is the acceptance.
      observe(ctx, 'M136', 'session_id', { receipt: p.receipt.provider_session_id, stream_init_session_id: p.stream.init?.session_id ?? null, accepted: p.exit_class === 'clean' });
      assert.match(String(p.receipt.provider_session_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'the receipt carries the derived session id (SEAM.md §146)');
    });
  });

  test("(b) the evidence on the entry: capabilities, usage granularity and semantics, cost reporting, auth mode with the key's delivery established, egress hosts as contacted (anything else reported, never added), provider files despite --no-session-persistence, the help hash, each with its record", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M136 (b)', async () => {
      const { c } = await attemptOf(ctx);
      const e = c.entry;
      assert.ok(e, 'the succeeded attempt wrote an entry');
      // The operator's source binary as the test read it at qualification
      // time (objection 016): every expected value below is the test's own.
      const source = readObserved(ctx, 'attempt').source_binary;
      assert.ok(source?.sha256 && source?.version, `the test read the source binary before the attempt (${JSON.stringify(source)})`);
      // The engine-owned pinned copy (E74 item 3; E75 item 1): under the
      // engine home, named for the version and the first 16 hex digits of
      // the hash the TEST computed, mode 0500, its bytes hashing to that.
      const expected = join(homeOf(ctx, 'home'), 'backends', `claude-${source.version}-${source.sha256.slice(0, 16)}`);
      assert.equal(e.binary_path, expected, `the entry binds the engine's pinned copy, not the operator's file (${e.binary_path})`);
      const pin = lstatSync(e.binary_path);
      assert.ok(pin.isFile() && (pin.mode & 0o777) === 0o500 && pin.uid === process.getuid(), `the pinned copy is a regular file of this user, mode 0500 (${(pin.mode & 0o777).toString(8)})`);
      assert.equal(sha256(readFileSync(e.binary_path)), source.sha256, "the pinned copy's bytes hash to what the test computed of the source");
      observe(ctx, 'M136', 'pinned_binary', { path: e.binary_path, mode: (pin.mode & 0o777).toString(8), source });
      assert.ok(['proposed', 'active'].includes(e.status), `the entry is proposed, or active once Sean activated it (${e.status})`);
      assert.deepEqual(
        { backend: e.backend, mode: e.mode, model: e.model, auth_mode: e.auth_mode, binary_sha256: e.binary_sha256, isolation: e.isolation, boundary: e.boundary, result_channel: e.result_channel, session_qualified: e.session_qualified, host_id: e.host_id },
        { backend: REAL.backend, mode: REAL.mode, model: REAL.model, auth_mode: ctx.authMode, binary_sha256: source.sha256, isolation: ISOLATION, boundary: BOUNDARY, result_channel: 'file', session_qualified: 0, host_id: hostId() },
        'the entry binds what the attempt qualified (D2 §4.1)',
      );
      assert.equal(e.template, c.attempt.template, 'the exact template the canaries ran');
      assert.equal(e.version, c.attempt.version, 'the version the static check read');
      assert.ok(HEX64.test(e.help_sha256) && e.help_sha256 === c.attempt.help_sha256, `the help hash (${e.help_sha256})`);
      assert.ok(HEX64.test(e.evidence_fingerprint), 'the evidence fingerprint');

      // Capabilities (the tool surface; (c) holds the delegation test).
      const caps = e.capabilities;
      assert.ok(caps && Array.isArray(caps.tools) && Array.isArray(caps.denied) && Array.isArray(caps.features_disabled) && typeof caps.delegation_verified === 'boolean', `capabilities {tools, denied, features_disabled, delegation_verified} (D2 A.3): ${JSON.stringify(caps)}`);

      // Usage: what the canaries' streams showed, never `none` for an entry
      // that can be activated (D2 §4.2).
      assert.ok(['model_call', 'invocation'].includes(e.usage_granularity), `usage_granularity observed (${e.usage_granularity})`);
      assert.ok(['cumulative', 'delta'].includes(e.usage_semantics), `usage_semantics observed (${e.usage_semantics})`);
      assert.ok(['reported', 'tokens_only'].includes(e.cost_reporting), `cost_reporting observed (${e.cost_reporting})`);
      const boundaries = e.enforceable_boundaries ?? [];
      assert.ok(boundaries.some((b) => b.boundary === 'invocation' && b.mechanism === 'dispatch_check'), `the invocation boundary, by dispatch_check, with the deadline as overshoot (D2 §4.2): ${JSON.stringify(boundaries)}`);
      assert.ok(!boundaries.some((b) => b.boundary === 'model_turn'), 'no model_turn boundary: per-call usage events establish no admission control (D2 §4.2)');

      // The credential's delivery, established by the positive canary, never
      // assumed (D2 §2.5; E74 item 1; SEAM.md §165). For an API key D2 names
      // the variable; for a subscription token the path is Claude Code's
      // documented one, recorded as the canary established it.
      const p = canaryOfKind(c, 'positive');
      const delivery = p.evidence?.credential_delivery;
      observe(ctx, 'M136', 'credential_delivery', delivery ?? null);
      assert.deepEqual([delivery?.auth_mode, delivery?.established], [ctx.authMode, true], `the ${ctx.authMode}'s delivery is established by the canary (SEAM.md §165): ${JSON.stringify(delivery)}`);
      assert.ok(typeof delivery.variable === 'string' && delivery.variable.length > 0, 'the variable it was delivered in is recorded');
      // The documented delivery (code.claude.com/docs, Environment variables:
      // CLAUDE_CODE_OAUTH_TOKEN, "Generate one with claude setup-token"); an
      // API key through ANTHROPIC_API_KEY (D2 §4.5).
      assert.equal(delivery.variable, ctx.authMode === 'api_key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN', `the ${ctx.authMode} is delivered in its documented variable`);
      // The subscription mode's template has no --bare (E74 item 1): with it,
      // Claude Code takes Anthropic authentication only from an API key.
      assert.equal(/(^|\s)--bare(\s|$)/.test(e.template), ctx.authMode === 'api_key', `--bare ${ctx.authMode === 'api_key' ? 'is' : 'is not'} in the ${ctx.authMode} template (${e.template})`);
      for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) assert.ok(e.template.includes(name), `the template the entry binds names ${name} (E74 item 3)`);

      // Egress: the hosts the canaries used, within the candidate list;
      // every refused destination reported and none added (D2 §2.4, §7.2).
      const accepted = new Set(c.runs.flatMap((r) => r.egress_log.filter((l) => l.decision === 'accepted').map((l) => String(l.authority).replace(/:443$/, ''))));
      const refused = c.runs.flatMap((r) => r.egress_log.filter((l) => l.decision === 'refused' && l.reason === 'not_listed').map((l) => l.authority));
      observe(ctx, 'M136', 'egress', { accepted: [...accepted], refused, unexpected_contacts: c.attempt.unexpected_contacts, entry_egress_hosts: e.egress_hosts });
      assert.ok(accepted.has(ctx.providerHost), `the canaries reached the provider (${ctx.providerHost}) through the proxy (${[...accepted].join(', ')})`);
      assert.ok(e.egress_hosts.every((h) => ctx.candidateEgress.includes(h)), `the entry's egress hosts are within the candidate list (${JSON.stringify(e.egress_hosts)})`);
      assert.ok(e.egress_hosts.every((h) => accepted.has(h)), 'and each was contacted');
      for (const authority of refused) {
        if (ctx.candidateEgress.some((h) => authority.startsWith(`${h}:`))) continue;
        assert.ok(c.attempt.unexpected_contacts.some((u) => u.destination === authority), `the refused contact ${authority} is reported in unexpected_contacts`);
        assert.ok(!e.egress_hosts.some((h) => authority.startsWith(h)), `and not added to the entry (${authority})`);
      }

      // Provider files: every writable location, with the no-persistence
      // flags in force, credential files excluded (D2 §4.3; SEAM.md §152).
      const pf = e.provider_files;
      assert.ok(pf && Array.isArray(pf.locations) && Array.isArray(pf.persistence_flags) && Array.isArray(pf.excluded), `provider_files {locations, persistence_flags, excluded}: ${JSON.stringify(pf)?.slice(0, 400)}`);
      assert.ok(pf.persistence_flags.includes('--no-session-persistence'), 'the no-persistence flag in force is recorded');
      observe(ctx, 'M136', 'provider_files', pf);

      // Each field's evidence is a published record of the attempt.
      assert.ok(Array.isArray(e.evidence) && e.evidence.length > 0, 'the entry names its evidence records');
      for (const id of e.evidence) {
        const row = withStore(homeOf(ctx, 'home'), (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(id));
        assert.equal(row?.published, 1, `evidence record ${id} is published`);
      }
    });
  });

  test('(c) T13: instructed to delegate and to schedule, the backend is seen unable: the tools absent from the inventory or denied in the stream, and no second backend process ever in cgroup.procs sampled from the host; no inventory and no test is delegation_unverified', { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M136 (c)', async () => {
      const { c } = await attemptOf(ctx);
      const caps = c.entry.capabilities;
      assert.equal(caps.delegation_verified, true, `delegation verified absent, by inventory or by the capability test (D2 §4.5): ${JSON.stringify(caps)}`);
      for (const name of DENIED) {
        assert.ok(!caps.tools.includes(name) || caps.denied.includes(name), `${name} is absent from the tool surface or denied (${JSON.stringify(caps)})`);
      }
      // What the stream's first event listed, if it listed tools (recorded; D2 §4.5).
      const init = canaryOfKind(c, 'positive').stream.init;
      const listed = Array.isArray(init?.tools) ? init.tools.map((t) => (typeof t === 'string' ? t : t?.name)) : null;
      observe(ctx, 'M136', 'stream_inventory', { listed_tools: listed, init_keys: init ? Object.keys(init) : null });
      if (listed) for (const name of DENIED) assert.ok(!listed.includes(name), `the stream's inventory does not offer ${name}`);

      // The host's samples of every canary domain's members: never two
      // processes of the backend at once (CH incident 7). What else Claude
      // Code starts (a shell for its Bash tool, a search program) is
      // recorded; only a second instance of the qualified binary counts.
      const samples = readObserved(ctx, 'attempt').domain_samples ?? [];
      assert.ok(samples.length > 0, 'the host sampled the canaries\' domains while they ran');
      const isBackend = (argv) => argv && (argv[0] === c.entry.binary_path || basename(argv[0] ?? '') === basename(c.entry.binary_path) || basename(argv[0] ?? '') === 'claude');
      const worst = Math.max(0, ...samples.map((s) => s.members.filter((m) => isBackend(m.argv)).length));
      observe(ctx, 'M136', 'backend_processes_per_sample_max', worst);
      assert.ok(worst <= 1, `no second backend process in any sample (at most ${worst})`);
      assert.ok(samples.some((s) => s.members.some((m) => isBackend(m.argv))), 'and the backend itself was seen a member of its domain');
    });
  });

  test("(d) usage: the canary's ledger row holds the reported tokens, cost_status reported if total_cost_usd is present (estimated in the subscription mode, E74), usage_complete 1", { timeout: REAL_TEST_TIMEOUT_MS }, async () => {
    const ctx = realPreflight();
    await judged(ctx, 'M136 (d)', async () => {
      const { c } = await attemptOf(ctx);
      const p = canaryOfKind(c, 'positive');
      assert.equal(p.ledger.length, 1, 'one original ledger row for the canary run');
      const [row] = p.ledger;
      observe(ctx, 'M136', 'ledger_row', row);
      observe(ctx, 'M136', 'terminal_event', p.stream.terminal);
      assert.equal(row.usage_complete, 1, `usage complete on a clean exit with the terminal usage (${JSON.stringify(row)})`);
      assert.ok(Number.isInteger(row.out) && row.out > 0, `output tokens reported (${row.out})`);
      assert.ok(Number.isInteger(row.billable_in) && row.billable_in >= 0, `billable input tokens reported (${row.billable_in})`);
      const t = p.stream.terminal;
      if (typeof t?.total_cost_usd === 'number') {
        // With an API key, the provider's reported cost (D2 §4.5); with a
        // subscription token, Claude Code's own estimate (E74 item 1).
        assert.equal(row.cost_status, costStatusFor(ctx), `the stream's total_cost_usd is recorded as ${costStatusFor(ctx)} in the ${ctx.authMode} mode`);
        assert.ok(Math.abs(row.cost_usd - t.total_cost_usd) < 1e-6, `the ledger's cost is the stream's (${row.cost_usd} against ${t.total_cost_usd})`);
        // Every model call's output tokens, as total_cost_usd covers them
        // (`modelUsage` where present, else the main loop's `usage`; objection 015).
        const reported = terminalOutput(t);
        observe(ctx, 'M136', 'terminal_output_scope', reported.scope);
        if (reported.tokens !== null) assert.equal(row.out, reported.tokens, `the output tokens are the terminal event's (${reported.scope})`);
      } else {
        assert.notEqual(row.cost_status, 'reported', 'no cost in the stream: the ledger does not claim one was reported');
        assert.notEqual(row.cost_usd, 0, 'and never zero for it');
        assert.ok(row.cost_usd === null || row.cost_status === 'estimated', `an unreported cost is estimated with its price version or unknown, never zero (${JSON.stringify(row)})`);
      }
    });
  });
});
