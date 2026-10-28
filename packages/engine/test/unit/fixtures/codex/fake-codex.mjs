// A FAKE `codex` (C1 of Codex support, 2026-10-27). It is a test
// instrument, never the Codex CLI: it contacts nothing, holds no account,
// runs no model and keeps no credential. It prints synthetic `codex exec
// --json` JSONL in the shapes OpenAI's non-interactive page documents
// (`thread.started`, `turn.started`, `item.*`, `turn.completed` with
// `usage`, `turn.failed`, `error`), reads its prompt from standard input as
// the `codex-exec-3` template's `-` asks, and acts out a role's run or a
// qualification canary from <root>/surety/context/canary.json, as the fake
// claude does (test/acceptance/harness/standin/fake-claude.mjs). Its error
// texts are modelled on the Codex CLI's "unexpected status 401
// Unauthorized: ..." form; they are not recorded from a real run.
//
// What it does is set by a JSON mode file: the file a first line
// `const MODE_FILE = "<path>";` names (as the harness writes the fake
// claude), else the file FAKE_CODEX_MODE names, else defaults:
//   root:      the directory /surety is under (default "/"; a test outside a
//              sandbox names a temporary directory)
//   reads:     the key variable this fake "reads": "CODEX_API_KEY"
//              (default), "OPENAI_API_KEY" or "either"
//   reject_key: a key value the provider refuses (an auth failure)
//   outcome:   "success" (default) | "auth_failed" | "usage_limit" |
//              "timeout" (hangs after turn.started until killed, or
//              `hang_ms`) | "malformed" (lines that are not the protocol,
//              no terminal event, exit 0) | "no_usage" (turn.completed with
//              no usage) | "partial_usage" (no cached_input_tokens) |
//              "web_search" (a web_search item before success) |
//              "second_terminal" (a turn.failed after turn.completed)
//   usage:     the turn's usage (default input 24763, cached 24448,
//              output 122, reasoning 0: the page's own example)
//   dump:      a path: what this launch was given (argv, the stdin text,
//              which key variables were set, never their values) is
//              written there as JSON
//   features_set: `codex features list` (C2b): {name: true|false} sets a
//              listed feature's state, or adds the feature (stage
//              "under development") if the list does not name it
//   features:  the whole list's text instead (a string), e.g. "" for an
//              empty one
//   features_exit: the exit status of `features list` (default 0)
//
// `codex features list` prints, by default, the list the real Codex CLI
// 0.160.0 printed in an empty CODEX_HOME on 2026-10-28 (saved verbatim as
// features-0.160.0.txt beside this file; the evidence folder
// batch-2026-10-27d/codex-c2b holds the original). That is the one recorded
// output this fake replays; everything else it prints is synthetic.
//
// Built-ins only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('codex-cli 0.160.0\n');
  process.exit(0);
}
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Codex CLI\n  a fake codex for the Surety tests; it runs no model\n');
  process.exit(0);
}

let mode = {};
try {
  // eslint-disable-next-line no-undef
  const file = typeof MODE_FILE === 'string' ? MODE_FILE : process.env.FAKE_CODEX_MODE;
  if (file) mode = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  mode = {};
}
// `codex features list` (C2b): the inventory the static checks record.
if (argv.length === 2 && argv[0] === 'features' && argv[1] === 'list') {
  let text = typeof mode.features === 'string' ? mode.features : readFileSync(new URL('./features-0.160.0.txt', import.meta.url), 'utf8');
  if (mode.features_set && typeof mode.features_set === 'object') {
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    for (const [name, on] of Object.entries(mode.features_set)) {
      const i = lines.findIndex((l) => l.split(/\s+/)[0] === name);
      if (i >= 0) lines[i] = lines[i].replace(/(true|false)\s*$/, on ? 'true' : 'false');
      else lines.push(`${name.padEnd(41)}${'under development'.padEnd(19)}${on ? 'true' : 'false'}`);
    }
    text = `${lines.join('\n')}\n`;
  }
  process.stdout.write(text);
  process.exit(Number(mode.features_exit ?? 0));
}
const root = mode.root ?? '/';
const at = (p) => join(root, p);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const stdin = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', () => resolve(''));
});

const keyVars = ['CODEX_API_KEY', 'OPENAI_API_KEY'].filter((v) => typeof process.env[v] === 'string' && process.env[v] !== '');
if (mode.dump) {
  writeFileSync(mode.dump, JSON.stringify({ argv, stdin, key_variables: keyVars, codex_home: process.env.CODEX_HOME ?? null }));
}

// Codex's own checks of its command line: `exec`, `--json`, the prompt on
// standard input (`-`).
if (argv[0] !== 'exec' || !argv.includes('--json') || argv.at(-1) !== '-') {
  process.stderr.write('error: the fake codex expects `exec --json ... -`\n');
  process.exit(2);
}

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
out({ type: 'thread.started', thread_id: THREAD });
out({ type: 'turn.started' });

const reads = mode.reads ?? 'CODEX_API_KEY';
const key = reads === 'either' ? (process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY) : process.env[reads];
const failed = (message, code = 1) => {
  out({ type: 'error', message });
  out({ type: 'turn.failed', error: { message } });
  process.exit(code);
};
if (!key || (mode.reject_key !== undefined && key === mode.reject_key) || mode.outcome === 'auth_failed') {
  failed('unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}');
}
if (mode.outcome === 'usage_limit') failed('exceeded retry limit, last status: 429 Too Many Requests: You exceeded your current quota (insufficient_quota)');
if (mode.outcome === 'timeout') {
  process.on('SIGTERM', () => process.exit(143));
  await new Promise((r) => setTimeout(r, Number(mode.hang_ms ?? 600_000)));
  process.exit(0);
}
if (mode.outcome === 'malformed') {
  process.stdout.write('this is not JSON\n');
  process.stdout.write('{"type":\n');
  out(['an', 'array']);
  out({ no_type: true });
  process.exit(0);
}

// The prompt must be the fixed one: it names the context package and the
// result file. Anything else and the fake does not do the work.
if (!stdin.includes('/surety/context/prompt.md') || !stdin.includes('/surety/out/result.json')) {
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'fake: no prompt naming /surety/context/prompt.md was given' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } });
  process.exit(0);
}

let canary = null;
try {
  canary = JSON.parse(readFileSync(at('surety/context/canary.json'), 'utf8'));
} catch {
  canary = null;
}
let prompt = null;
try {
  prompt = readFileSync(at('surety/context/prompt.md'), 'utf8');
} catch {
  prompt = null;
}

out({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'fake: reading the context package' } });
out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat /surety/context/prompt.md"', aggregated_output: '', exit_code: null, status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "cat /surety/context/prompt.md"', aggregated_output: prompt === null ? '' : prompt.slice(0, 200), exit_code: prompt === null ? 1 : 0, status: prompt === null ? 'failed' : 'completed' } });
if (mode.outcome === 'web_search') out({ type: 'item.completed', item: { id: 'item_ws', type: 'web_search', query: 'fake query' } });

const writeResult = (value) => {
  mkdirSync(at('surety/out'), { recursive: true });
  writeFileSync(at('surety/out/result.json'), JSON.stringify(value));
};

if (canary?.kind === 'positive') {
  const path = at(`surety/workspace/${canary.edit.path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canary.edit.content);
  out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: canary.edit.path, kind: 'add' }], status: 'completed' } });
  writeResult(canary.result);
} else if (canary?.kind === 'cancellation') {
  process.on('SIGTERM', () => process.exit(143));
  if (typeof canary.barrier === 'string') writeFileSync(canary.barrier.startsWith('/') ? at(canary.barrier.slice(1)) : canary.barrier, 'x');
  await new Promise((r) => setTimeout(r, Number(canary.wait_seconds ?? 60) * 1000));
  process.exit(0);
} else if (canary?.kind === 'containment') {
  await new Promise((r) => setTimeout(r, Number(mode.linger_ms ?? Number(canary.wait_seconds ?? 4) * 1000)));
  writeResult(canary.result ?? { status: 'completed', summary: 'fake: the harmless task done' });
} else if (canary !== null) {
  failed(`fake: unknown canary kind ${String(canary.kind)}`);
} else {
  // A role's run: its work, and a valid result.
  if (existsSync(at('surety/workspace'))) {
    mkdirSync(at('surety/workspace/src'), { recursive: true });
    writeFileSync(at('surety/workspace/src/fake-codex.txt'), 'written by the fake codex\n');
  }
  writeResult({ status: 'completed', summary: 'fake: the role did its work' });
}

out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'fake: done; the result is in /surety/out/result.json' } });
const usage = mode.usage ?? { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 };
if (mode.outcome === 'no_usage') out({ type: 'turn.completed' });
else if (mode.outcome === 'partial_usage') out({ type: 'turn.completed', usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
else out({ type: 'turn.completed', usage });
if (mode.outcome === 'second_terminal') out({ type: 'turn.failed', error: { message: 'fake: a second terminal event' } });
process.exit(0);
