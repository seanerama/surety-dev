// M555, WA-boundary: the assistant's turn crosses only the runner boundary
// (UI1 slice 48; the assistant design of 2026-10-27, §3's provider host
// allow-list row, §4 "A real turn is spawned only by the choke point"; D1
// §§15.1, 15.4; row M74's inspection extended; E184; SEAM.md §§95, 567,
// 568).
//
//   (a) Source inspection, no engine (M74's lexer and rule,
//       harness/launch-lint.mjs): the assistant backend's process is started
//       in `invoke/` (invoke/assistant-turn.ts is a launch site) and nowhere
//       else; no file of `assistant/` names a module that can start a
//       process; the modules that serve the message routes
//       (assistant/service.ts, assistant/real.ts, api/server.ts) do not
//       import the turn launcher, which only the engine's start
//       (engine.ts) and the runtime's types reach, so a request cannot spawn
//       a backend; and a spawn inserted into assistant/real.ts is reported.
//   (b) Sandbox lane, a turn's domain: its published mount plan (a
//       qualification_evidence record, purpose workspace_assistant) mounts
//       no repository (no /surety/workspace, no git view), and holds
//       /surety/context read-only; from inside, /surety/workspace does not
//       exist; the engine's API port is unreachable from the role on
//       loopback (no connection), while its egress forwarder answers (the
//       control); a CONNECT through the proxy to a host the entry does not
//       list is refused 403 and recorded `domain.egress_refused` for the
//       turn's domain. (The scripted entry qualified no egress host, its
//       canaries having connected nowhere, so no listed destination is
//       exercised here; the proxy's allow-list itself is M2 slice 12's,
//       M127 and M128.)
//
// SAFETY (E64; SEAM.md §141): the role's connection attempts are guarded
// probes; the role holds at "armed" until the host has read that it is in
// its domain's cgroup and in namespaces of its own (assertContained), and
// only then is it released into them. Nothing leaves the host: the targets
// are loopback and a name under .example, which is never resolved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { askAndSettle, assistantScripts, domainOfTurn, hold, newConversation, readyAssistant, reply, turnOf } from './harness/assistant.mjs';
import { REPO_ROOT, waitFor } from './harness/engine.mjs';
import { inspectLaunches, launchSites } from './harness/launch-lint.mjs';
import { recordFile, recordRow } from './harness/records.mjs';
import { egressRefusals, hostConnects } from './harness/sandbox/egress.mjs';
import { roleProcess } from './harness/sandbox/lane.mjs';
import { assertContained } from './harness/sandbox/view.mjs';
import { acting, hostNamespaces, step } from './harness/scripted.mjs';
import { moduleRefs, readSources, tokenize } from './harness/source-lint.mjs';

const SRC = join(REPO_ROOT, 'packages', 'engine', 'src');
const LAUNCHER = 'invoke/assistant-turn';

// The relative module specifiers a file imports (static, dynamic or
// re-exported), as written.
const importsOf = (source) => {
  const tokens = tokenize(source.text, source.file);
  return moduleRefs(tokens).map((r) => tokens[r.spec]?.text).filter((x) => typeof x === 'string');
};

describe('M555 the assistant crosses only the runner boundary', () => {
  test('(a) the assistant backend is started only under invoke/; nothing of assistant/ can start a process; no route module reaches the launcher; an inserted spawn is reported', () => {
    const sources = readSources(SRC);
    assert.ok(sources.some((s) => s.file === `${LAUNCHER}.ts`), `the launcher exists (src/${LAUNCHER}.ts)`);
    assert.ok(launchSites(sources).includes(`${LAUNCHER}.ts`), "the assistant's launch is a launch site, inside the choke point's directory");
    const assistantFiles = sources.filter((s) => s.file.startsWith('assistant/'));
    assert.ok(assistantFiles.length >= 3, `there is assistant source to inspect (${assistantFiles.map((s) => s.file).join(', ')})`);
    assert.deepEqual(launchSites(assistantFiles), [], 'no file of assistant/ names a module that can start a process');
    assert.deepEqual(inspectLaunches(sources), [], 'nothing outside the allowed places starts a process (M74\'s rule)');
    const reaching = sources.filter((s) => importsOf(s).some((spec) => spec.includes('assistant-turn'))).map((s) => s.file).sort();
    for (const f of reaching) assert.ok(['engine.ts', 'runtime.ts'].includes(f), `only the engine's start and the runtime's types reach the launcher (also: ${f})`);
    for (const route of ['assistant/service.ts', 'assistant/real.ts', 'api/server.ts']) assert.ok(!reaching.includes(route), `${route} does not import the launcher`);
    const mutated = sources.map((s) => (s.file === 'assistant/real.ts' ? { file: s.file, text: `${s.text}\nimport { spawn } from 'node:child_process';\nexport const turnNow = () => spawn('claude', ['-p']);\n` } : s));
    assert.ok(inspectLaunches(mutated).some((v) => v.file === 'assistant/real.ts'), 'a spawn inserted into assistant/real.ts is reported');
  });

  test('(b) a turn\'s domain: no repository mounted, the context read-only; the engine\'s port unreachable; an unlisted host refused by the proxy', async (t) => {
    const { fx } = await readyAssistant(t);
    const hostNs = hostNamespaces();
    const act = acting(hostNs);
    assert.equal(await hostConnects('127.0.0.1', fx.port), true, "the target is seeded: the engine's API answers the host");
    assistantScripts(fx, [
      {
        steps: [
          step.probe('stat_paths', { paths: ['/surety/workspace', '/surety/context', '/surety/out', '/surety/git'], label: 'paths' }),
          hold('armed'),
          act.tcpConnect([{ host: '127.0.0.1', port: fx.port }, { host: '::1', port: fx.port }], { label: 'engine' }),
          act.tcpConnect('proxy', { label: 'forwarder' }),
          act.proxyConnect('unlisted.provider.example:443', { label: 'unlisted' }),
          reply('Probed.'),
        ],
        on_term: 'exit',
      },
    ]);
    const conv = await newConversation(fx);
    const settled = askAndSettle(fx, conv, 'm555-b');
    const turn = await waitFor(() => turnOf(fx.home, 'm555-b') ?? undefined, { timeoutMs: 60_000, what: 'the turn' });
    const launch = await fx.scripted.waitForHolding({ invocation: turn.invocation }, 'armed', { timeoutMs: 90_000 });
    const domain = domainOfTurn(fx.home, turn.invocation);
    const member = await roleProcess(fx, domain, launch);
    assertContained(domain, member, "the assistant's backend");
    fx.scripted.release(turn.invocation, 'armed');
    const done = await settled;
    assert.equal(done.turn?.outcome, 'completed', `the turn completed (${JSON.stringify(done.turn)})`);

    // The published plan.
    const d = domainOfTurn(fx.home, turn.invocation);
    const rec = recordRow(fx.home, d.mount_plan_record);
    assert.ok(rec, `the domain names its published mount plan (${d.mount_plan_record})`);
    const plan = JSON.parse(readFileSync(recordFile(fx.home, rec), 'utf8'));
    assert.equal(plan.purpose, 'workspace_assistant', `the plan is the assistant's (${plan.purpose})`);
    const targets = plan.entries.map((e) => e.target);
    assert.ok(!targets.some((x) => x === '/surety/workspace' || x.startsWith('/surety/workspace/')), `no repository is mounted (targets: ${targets.join(', ')})`);
    assert.ok(!targets.some((x) => x === '/surety/git' || x.startsWith('/surety/git/')), `no git view (targets: ${targets.join(', ')})`);
    const ctx = plan.entries.find((e) => e.target === '/surety/context');
    assert.ok(ctx && ctx.options.includes('ro'), `the context is mounted read-only (${JSON.stringify(ctx)})`);

    const probes = (action, label) => fx.scripted.probes(turn.invocation, action).filter((p) => p.label === label);
    const paths = Object.fromEntries((probes('stat_paths', 'paths')[0]?.results ?? []).map((r) => [r.path, r]));
    assert.equal(paths['/surety/workspace']?.outcome, 'failed', `inside, /surety/workspace does not exist (${JSON.stringify(paths['/surety/workspace'])})`);
    assert.equal(paths['/surety/context']?.outcome, 'found', 'and /surety/context does');
    const engine = probes('tcp_connect', 'engine')[0];
    assert.ok(engine, 'the role logged its engine-port probe');
    assert.notEqual(engine.outcome, 'refused_unsandboxed', 'the role program\'s guard let it run inside the sandbox');
    for (const r of engine.results ?? []) assert.notEqual(r.outcome, 'connected', `the engine's port is unreachable from the role (${JSON.stringify(r)})`);
    assert.equal(probes('tcp_connect', 'forwarder')[0]?.results?.[0]?.outcome, 'connected', 'control: the role reaches its forwarder');
    const unlisted = probes('proxy_connect', 'unlisted')[0];
    assert.deepEqual([unlisted?.outcome, unlisted?.status], ['answered', 403], `the proxy refuses a host the entry does not list (${JSON.stringify(unlisted)})`);
    assert.ok(egressRefusals(fx.home, d.id).some((e) => e.payload?.authority === 'unlisted.provider.example:443'), 'domain.egress_refused for it, on the turn\'s domain');
  });
});
