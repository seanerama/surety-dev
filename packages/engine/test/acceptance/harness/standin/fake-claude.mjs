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
const success = (modelUsage, cost) => out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, modelUsage: { [model]: modelUsage } });

let canary = null;
try {
  canary = JSON.parse(readFileSync('/surety/context/canary.json', 'utf8'));
} catch {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  process.exit(1);
}
const writeResult = () => writeFileSync('/surety/out/result.json', JSON.stringify(canary.result));

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
  } else {
    if (contained) for (const a of canary.actions ?? []) spawnSync(a.argv[0], a.argv.slice(1), { stdio: 'ignore', timeout: 20_000 });
    writeResult();
  }
  success({ inputTokens: 800, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 100 }, 0.002);
  process.exit(0);
} else {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  process.exit(1);
}
