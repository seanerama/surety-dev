// A FAKE `claude` for the sandbox lane (M2 slice 14, the review's S1 and S2;
// E74 items 2 and 3; SEAM.md §167). It is the Verifier's instrument, never
// Claude Code: it contacts nothing, holds no account, runs no model and
// reads no credential. It prints synthetic stream-json in the form the
// Claude adapter parses (a `system`/`init` event, `assistant` messages with
// per-call `usage`, a terminal `result`) and acts out the three qualification
// canaries from /surety/context/canary.json, which exists only inside a
// sandbox.
//
// The harness writes it with a shebang naming the test's node and a first
// line `const MODE_FILE = "<path>";` naming a JSON file in the scripted
// directory (bound read-write in every sandbox of a sandbox-lane engine), so
// that the test can change what it does between attempts without changing
// the bytes the attempt bound:
//   positive:    "complete" (default) | "missing_count" | "failure_no_totals"
//   extra_tools: tool names listed in the inventory beyond the template's
//   hide_title:  true sets the process title, so that /proc no longer names
//                the binary and a host sampler cannot identify it
//   host_pid_ns: the host's pid namespace; the containment actions are
//                refused when this process is in it (SEAM.md §141's guard)
//   fallback:    true (E86 item 3): before its result, the session falls back
//                from the entry's model, as Sean's third attempt recorded it:
//                a system/model_refusal_fallback event (scope session, the
//                original model the requested one, the fallback
//                claude-sonnet-5), an assistant message from the fallback
//                model, and the result's modelUsage naming both models
//   linger_ms:   (E86) how long the containment canary stays live doing its
//                harmless task when canary.json names neither a probe nor
//                actions (the engine runs the probe itself); default the
//                canary's own wait_seconds, as its prompt asks
//   plant_gitconfig: (E86 review S1) while it waits, write a malformed
//                ~/.gitconfig (HOME=/surety/home) and a hostile GIT_* file in
//                the workspace, to make a `git config` the engine runs exit
//                non-zero without the filesystem refusing any write
//   signal_probe: (E86 review S2) while it waits, send SIGUSR1 once to each
//                process in its OWN pid namespace that is neither itself nor
//                one of its ancestors (its siblings, the probe's action
//                children among them); never kill(-1), never a host pid, and
//                only inside the sandbox (the two-part guard, E64; SEAM §141)
//   role:        "complete" (a role's run, not a canary): write
//                src/fake-claude.txt and end with a valid result, exit 0;
//                "proxy_refused" (a role's run, not a canary; E84): one
//                CONNECT to `connect` through HTTPS_PROXY (inside the sandbox
//                only, by the same guard), then Claude Code's ending when
//                its provider cannot be reached, as Sean's second attempt
//                recorded it: retries, a synthetic error message, a result
//                with is_error, all-zero usage and an empty modelUsage; exit 1
//                "connect_and_exit" (the Reviewer's in-flight CONNECT; E85):
//                the same CONNECT, with bytes pipelined after it, and the
//                same ending, but exit 1 at once, without waiting for the
//                proxy's answer; the time the CONNECT was written is saved
//                as fake-claude-connect.json beside the mode file
//   dump_context: true writes what this canary was shown (every file under
//                /surety/context, and the prompt argument) as
//                fake-claude-context-<kind>.json beside the mode file
//                (E83; SEAM.md §173)
// The containment canary (E83; SEAM.md §173): when canary.json names a
// `probe`, the probe program is run once, with no arguments, and its output
// reported as `probe_output`; on an engine before E83, each listed action.
//
// Built-ins only.

import { spawnSync } from 'node:child_process';
import { connect as tcpConnect } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('2.1.289 (Claude Code)\n');
  process.exit(0);
}
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Usage: claude [options] [command] [prompt]\n  a fake claude for the Surety acceptance tests; it runs no model\n');
  process.exit(0);
}

let mode = {};
try {
  // eslint-disable-next-line no-undef
  mode = JSON.parse(readFileSync(MODE_FILE, 'utf8'));
} catch {
  mode = {};
}
if (mode.hide_title) process.title = 'w';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const model = val('--model') ?? 'claude-sonnet-5-5';
const templateTools = (val('--tools') ?? 'Read,Edit,Write,Bash,Glob,Grep').split(',');
out({ type: 'system', subtype: 'init', tools: [...templateTools, ...(mode.extra_tools ?? [])], apiKeySource: 'ANTHROPIC_API_KEY', model, session_id: val('--session-id'), permissionMode: 'bypassPermissions', mcp_servers: [] });

const assistant = (id, usage) => out({ type: 'assistant', parent_tool_use_id: null, message: { id, model, usage, content: [] } });
const FALLBACK_MODEL = 'claude-sonnet-5';
const success = (modelUsage, cost) => {
  if (mode.fallback) {
    // E86 item 3: the session's model changes under the run, as recorded in
    // Sean's third attempt (the event's shape is that transcript's).
    out({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session', original_model: model, fallback_model: FALLBACK_MODEL, api_refusal_category: 'cyber', api_refusal_explanation: 'fake: a safeguard flagged this session', content: 'fake: the fallback model is answering instead' });
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_fallback_1', model: FALLBACK_MODEL, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 }, content: [] } });
    out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, modelUsage: { [model]: modelUsage, [FALLBACK_MODEL]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    return;
  }
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, modelUsage: { [model]: modelUsage } });
};

// The guard's first half (SEAM.md §141): inside a sandbox, never the host's
// pid namespace.
const insideSandbox = () => {
  try {
    const ns = readlinkSync('/proc/self/ns/pid');
    return existsSync('/surety/context') && Boolean(mode.host_pid_ns) && ns !== mode.host_pid_ns;
  } catch {
    return false;
  }
};

if (mode.role === 'complete' && !existsSync('/surety/context/canary.json')) {
  // A role's run that does its work and ends with a valid result.
  assistant('msg_r_1', { input_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 });
  if (existsSync('/surety/workspace')) {
    mkdirSync('/surety/workspace/src', { recursive: true });
    writeFileSync('/surety/workspace/src/fake-claude.txt', 'written by the fake claude\n');
  }
  writeFileSync('/surety/out/result.json', JSON.stringify({ status: 'completed', summary: 'fake: the role did its work' }));
  success({ inputTokens: 600, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, 0.002);
  process.exit(0);
}

if (mode.role === 'connect_and_exit' && !existsSync('/surety/context/canary.json')) {
  // The CONNECT left in flight: written, then the backend ends at once.
  const proxy = new URL(process.env.HTTPS_PROXY ?? 'http://127.0.0.1:1');
  const sent = await new Promise((resolve) => {
    if (!insideSandbox() || !['127.0.0.1', '[::1]', '::1'].includes(proxy.hostname)) return resolve(null);
    const sock = tcpConnect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) }, () => {
      sock.write(`CONNECT ${mode.connect} HTTP/1.1\r\nHost: ${mode.connect}\r\n\r\nPIPELINED-BYTES-AFTER-CONNECT`, () => resolve(new Date().toISOString()));
    });
    sock.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 5_000);
  });
  // eslint-disable-next-line no-undef
  writeFileSync(join(dirname(MODE_FILE), 'fake-claude-connect.json'), JSON.stringify({ sent_at: sent, authority: mode.connect }));
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const text = "API Error: Couldn't connect through your proxy [fake: the backend did not wait for the answer]";
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'synthetic-proxy-error', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', usage: zero, content: [{ type: 'text', text }] }, error: 'server_error', is_api_error_message: true });
  out({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: null, num_turns: 1, total_cost_usd: 0, usage: zero, modelUsage: {}, result: text });
  process.exit(1);
}

if (mode.role === 'proxy_refused' && !existsSync('/surety/context/canary.json')) {
  // E84: the provider unreachable through the proxy.
  const proxy = new URL(process.env.HTTPS_PROXY ?? 'http://127.0.0.1:1');
  const answer = await new Promise((resolve) => {
    if (!insideSandbox() || !['127.0.0.1', '[::1]', '::1'].includes(proxy.hostname)) return resolve('not_attempted');
    const sock = tcpConnect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) }, () => sock.write(`CONNECT ${mode.connect} HTTP/1.1\r\nHost: ${mode.connect}\r\n\r\n`));
    let got = '';
    sock.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('\r\n')) {
        sock.destroy();
        resolve(got.split('\r\n')[0]);
      }
    });
    sock.on('error', () => resolve('error'));
    sock.on('close', () => resolve(got.split('\r\n')[0] || 'closed'));
    setTimeout(() => {
      sock.destroy();
      resolve('timeout');
    }, 10_000);
  });
  for (let attempt = 1; attempt <= 2; attempt++) out({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' });
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const text = `API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) [fake: the proxy answered ${answer}]`;
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'synthetic-proxy-error', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', usage: zero, content: [{ type: 'text', text }] }, error: 'server_error', is_api_error_message: true });
  out({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: null, num_turns: 1, total_cost_usd: 0, usage: zero, modelUsage: {}, result: text });
  process.exit(1);
}

let canary = null;
try {
  canary = JSON.parse(readFileSync('/surety/context/canary.json', 'utf8'));
} catch {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  process.exit(1);
}
const writeResult = () => writeFileSync('/surety/out/result.json', JSON.stringify(canary.result));

// S2 (E86 review): send SIGUSR1, over `durationMs`, to every process in this
// process's OWN pid namespace that is neither itself nor one of its
// ancestors. The /proc this reads is the sandbox's pid namespace, so it
// names only the domain's processes; a host pid is unreachable from here.
// Never kill(-1). The caller runs it only when `contained` (SEAM §141's
// instrument half); the test confirms containment before release (its other
// half). An unhardened node child opens its inspector on SIGUSR1.
function signalSiblings(durationMs) {
  const selfPid = process.pid;
  const ancestors = new Set([selfPid]);
  try {
    let pid = selfPid;
    for (let i = 0; i < 64 && pid > 1; i++) {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const ppid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
      if (!ppid) break;
      ancestors.add(ppid);
      pid = ppid;
    }
  } catch {
    // if the ancestry cannot be read, target nothing
    return;
  }
  const deadline = Date.now() + durationMs;
  const tick = () => {
    let pids = [];
    try {
      pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
    } catch {
      return;
    }
    for (const pid of pids) {
      if (ancestors.has(pid)) continue;
      try {
        process.kill(pid, 'SIGUSR1');
      } catch {
        // gone, or not permitted
      }
    }
    if (Date.now() < deadline) setTimeout(tick, 200);
  };
  tick();
}

if (mode.dump_context) {
  // What the agent is shown: every regular file under /surety/context, read
  // whole (it is small), and the prompt the engine passed as the last argument.
  const files = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path, `${rel}${name}/`);
      else if (st.isFile() && st.size <= 1048576) files.push({ name: `${rel}${name}`, text: readFileSync(path, 'utf8') });
      else files.push({ name: `${rel}${name}`, text: null });
    }
  };
  walk('/surety/context', '');
  // eslint-disable-next-line no-undef
  writeFileSync(join(dirname(MODE_FILE), `fake-claude-context-${canary.kind}.json`), JSON.stringify({ kind: canary.kind, prompt_argument: argv.at(-1) ?? null, files }));
}

if (canary.kind === 'positive') {
  if ((mode.positive ?? 'complete') === 'failure_no_totals') {
    // S1 (b): per-call usage observed, then a failure with no totals at all.
    assistant('msg_f_1', { input_tokens: 40000, cache_creation_input_tokens: 80000, cache_read_input_tokens: 0, output_tokens: 500 });
    assistant('msg_f_2', { input_tokens: 30000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 80000, output_tokens: 700 });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true });
    process.exit(1);
  }
  assistant('msg_p_1', { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 300 });
  const path = `/surety/workspace/${canary.edit.path}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canary.edit.content);
  writeResult();
  if (mode.positive === 'missing_count') {
    // S1 (a): a success whose totals lack one count (cacheCreationInputTokens).
    success({ inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0 }, 0.0123);
  } else {
    success({ inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 3000 }, 0.0123);
  }
  process.exit(0);
} else if (canary.kind === 'cancellation') {
  assistant('msg_c_1', { input_tokens: 500, cache_creation_input_tokens: 700, cache_read_input_tokens: 0, output_tokens: 20 });
  process.on('SIGTERM', () => process.exit(143));
  writeFileSync(canary.barrier, 'x');
  setTimeout(() => process.exit(0), (canary.wait_seconds ?? 60) * 1000);
} else if (canary.kind === 'containment') {
  assistant('msg_k_1', { input_tokens: 800, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 50 });
  // The guard's first half: never on the host (SEAM.md §141).
  let ns = null;
  try {
    ns = readlinkSync('/proc/self/ns/pid');
  } catch {
    ns = null;
  }
  const contained = existsSync('/surety/context') && ns !== null && mode.host_pid_ns && ns !== mode.host_pid_ns;
  if (typeof canary.probe === 'string') {
    // E83: the sanctioned check, the probe run once, its output reported.
    const done = contained && canary.probe.startsWith('/surety/context/') ? spawnSync(canary.probe, [], { encoding: 'utf8', timeout: 60_000 }) : null;
    writeFileSync('/surety/out/result.json', JSON.stringify({ status: 'completed', summary: 'the sanctioned containment check: the probe program run once; its output follows verbatim', probe_output: done?.stdout ?? '' }));
  } else if (Array.isArray(canary.actions)) {
    if (contained) for (const a of canary.actions) spawnSync(a.argv[0], a.argv.slice(1), { stdio: 'ignore', timeout: 20_000 });
    writeResult();
  } else {
    // E86 (SEAM.md §175): the engine runs the probe itself; the agent's task
    // is harmless. The fake does it, staying live a while, and ends. Under a
    // review mode it also tries, from inside the sandbox only, to spoil the
    // engine's check; the engine must not be fooled.
    if (contained && mode.plant_gitconfig) {
      // S1: a malformed git config in the writable home and the workspace.
      writeFileSync('/surety/home/.gitconfig', '[this is not a valid git config line\n');
      try {
        writeFileSync('/surety/workspace/.gitconfig', '[also malformed\n');
      } catch {
        // the workspace may be read-only for this role; the home is enough
      }
    }
    const waitMs = Number(mode.linger_ms ?? Number(canary.wait_seconds ?? 4) * 1000);
    if (contained && mode.signal_probe) signalSiblings(waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
    writeFileSync('/surety/out/result.json', JSON.stringify(canary.result ?? { status: 'completed', summary: 'fake: the harmless task done' }));
  }
  success({ inputTokens: 800, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 100 }, 0.002);
  process.exit(0);
} else {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  process.exit(1);
}
