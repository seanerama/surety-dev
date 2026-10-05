// SURETY REHEARSAL FAKE CLAUDE (E79 item 1). The real lane's dress
// rehearsal backend: a script that plays Claude Code's documented headless
// behaviour, never Claude Code. It contacts nothing, runs no model, holds no
// account. The marker on the first line of this comment is what the
// rehearsal switch looks for (SEAM.md §170): the harness refuses to answer
// Sean's approvals itself for any binary without it.
//
// What it plays, from what the engine's Claude adapter parses (stream-json,
// one event per line):
//   - a `system`/`init` event: the tools the template's `--tools` grants,
//     `apiKeySource` ("ANTHROPIC_API_KEY" when that variable is set, "none"
//     under the subscription token), the model, the session id;
//   - `assistant` messages with per-call `usage` and distinct message ids;
//   - a terminal `result` with `modelUsage` and `total_cost_usd`;
//   - an invalid credential (its value begins with `sk-ant-oat01-surety-
//     invalid-` or `sk-ant-api03-surety-wrong-`): an assistant message with
//     `error: "authentication_failed"` and a result with
//     `api_error_status: 401`, exit 1;
//   - the three canaries, from /surety/context/canary.json: the positive
//     edit and result; the cancellation barrier, then a long wait until
//     TERM; the containment canary's actions, each run as written (the
//     probe program asks the domain init to act), then its result;
//   - a journey role, from /surety/context/prompt.md: a Builder writes the
//     `src/*.js` file its stage names (a fix work item corrects
//     src/session.js); a Verifier reports the seeded defect of
//     src/session.js as a Critical finding naming the check `login`, else
//     nothing; a Reviewer signs the candidate off. A stage whose goal names
//     `farewell` works slowly (two minutes), so that it can be stopped.
// The fake knows the result fields the gates read (findings with `check`,
// signoffs) because it was written to; a real agent learns them only from
// its context package.
//
// Built-ins only. It acts only inside a sandbox: without /surety/context it
// prints a failure result and exits 1.

// CommonJS, so that Node runs it under any file name: the engine pins its
// copy as `claude-<version>-<sha16>`, a name whose dot an ES module loader
// would read as an unknown file extension. No top-level `return`: the
// native wrapper (rehearsal-claude.c) runs this text with `node -e`.
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('2.1.289 (Claude Code)\n');
  process.exit(0);
}
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Usage: claude [options] [command] [prompt]\n  SURETY REHEARSAL FAKE CLAUDE: it runs no model\n');
  process.exit(0);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const model = val('--model') ?? 'claude-sonnet-5-5';
const tools = (val('--tools') ?? 'Read,Edit,Write,Bash,Glob,Grep').split(',');
const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
out({ type: 'system', subtype: 'init', tools, apiKeySource: apiKey ? 'ANTHROPIC_API_KEY' : 'none', model, session_id: val('--session-id'), permissionMode: 'bypassPermissions', mcp_servers: [], claude_code_version: '2.1.289' });

let n = 0;
const assistant = (usage) => out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_rehearsal_${process.pid}_${++n}`, model, usage, content: [{ type: 'text', text: 'rehearsal' }] } });
const success = (u, cost) => out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, modelUsage: { [model]: u }, usage: { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens } });
const fail = (code = 1) => {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true });
  process.exit(code);
};

// An invalid credential: what Claude Code's stream shows when the provider refuses it.
const credential = token ?? apiKey ?? '';
if (credential.startsWith('sk-ant-oat01-surety-invalid-') || credential.startsWith('sk-ant-api03-surety-wrong-')) {
  out({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: `msg_rehearsal_${process.pid}_auth`, model, content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login', total_cost_usd: 0 });
  process.exit(1);
}
if (!existsSync('/surety/context')) fail();

const U = { inputTokens: 900, outputTokens: 240, cacheReadInputTokens: 0, cacheCreationInputTokens: 2400 };
const usageOf = (u) => ({ input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens });
const writeResult = (value) => writeFileSync('/surety/out/result.json', JSON.stringify(value));
const finish = (value, u = U, cost = 0.0102) => {
  writeResult(value);
  success(u, cost);
  process.exit(0);
};

let canary = null;
try {
  canary = JSON.parse(readFileSync('/surety/context/canary.json', 'utf8'));
} catch {
  canary = null;
}

if (canary?.kind === 'positive') {
  assistant(usageOf(U));
  const path = `/surety/workspace/${canary.edit.path}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canary.edit.content);
  finish(canary.result);
} else if (canary?.kind === 'cancellation') {
  assistant(usageOf(U));
  process.on('SIGTERM', () => process.exit(143));
  writeFileSync(canary.barrier, '');
  setTimeout(() => finish(canary.result), (canary.wait_seconds ?? 60) * 1000);
} else if (canary?.kind === 'containment') {
  assistant(usageOf(U));
  let ns = null;
  try {
    ns = readlinkSync('/proc/self/ns/pid');
  } catch {
    ns = null;
  }
  // The actions only where the probe program can ask the init to act: inside the sandbox.
  if (ns !== null && existsSync('/surety/context/probe')) for (const a of canary.actions ?? []) spawnSync(a.argv[0], a.argv.slice(1), { stdio: 'ignore', timeout: 20_000 });
  // The provider's tunnel: Claude Code reaches its provider through the
  // proxy. The fake asks for its first candidate destination, which in a
  // rehearsal is a name that resolves nowhere: the tunnel cannot open.
  finish(canary.result);
} else if (canary) {
  fail();
}
// A canary is played above: the cancellation canary waits on its timer
// and TERM, and must not fall through into a journey role.
if (!canary) playRole();

// A journey role.
function playRole() {
const prompt = readFileSync('/surety/context/prompt.md', 'utf8');
const role = /# Your task \(([a-z]+)\)/.exec(prompt)?.[1] ?? 'builder';
const ws = (p) => `/surety/workspace/${p}`;
const write = (p, text) => {
  mkdirSync(dirname(ws(p)), { recursive: true });
  writeFileSync(ws(p), text);
};
assistant(usageOf(U));
if (role === 'builder') {
  const isFix = /\(fix\)/.test(prompt);
  if (isFix && existsSync(ws('src/session.js'))) {
    write('src/session.js', readFileSync(ws('src/session.js'), 'utf8').replace('SESSION_LIFETIME * 1000 * 1000', 'SESSION_LIFETIME * 1000'));
    finish({ status: 'completed', summary: 'rehearsal: corrected the session lifetime to 30 minutes in milliseconds' });
  }
  // The file names the stage's goal or its requirements' texts name.
  let texts = prompt;
  try {
    for (const f of require('node:fs').readdirSync('/surety/context/requirements')) texts += `\n${readFileSync(`/surety/context/requirements/${f}`, 'utf8')}`;
  } catch {
    // no requirement texts
  }
  const files = [...new Set([...texts.matchAll(/src\/([a-z]+)\.js/g)].map((m) => m[1]))];
  if (files.includes('farewell')) {
    // Slow work, to be stopped: usage first, then a long wait.
    process.on('SIGTERM', () => process.exit(143));
    setTimeout(() => {
      write('src/farewell.js', 'export const farewell = (name) => `Goodbye, ${name}.`;\n');
      finish({ status: 'completed', summary: 'rehearsal: farewell' });
    }, 120_000);
  } else {
    if (files.includes('greeting')) write('src/greeting.js', 'export const greeting = (name) => `Hello, ${name}!`;\n');
    if (files.includes('logout')) write('src/logout.js', 'export const logout = (session) => ({ ...session, revoked: true });\n');
    finish({ status: 'completed', summary: `rehearsal: wrote ${files.map((f) => 'src/' + f + '.js').join(', ') || 'nothing'}` });
  }
} else if (role === 'verifier') {
  const defect = existsSync(ws('src/session.js')) && readFileSync(ws('src/session.js'), 'utf8').includes('SESSION_LIFETIME * 1000 * 1000');
  finish({ status: 'completed', summary: 'rehearsal: verified', ...(defect ? { findings: [{ category: 'security', severity: 'critical', message: 'src/session.js accepts expired sessions: the lifetime is compared a thousand times too long (R1)', check: 'login' }] } : {}) });
} else if (role === 'reviewer') {
  finish({ status: 'completed', summary: 'rehearsal: reviewed', signoffs: [{ scope: 'candidate' }] });
} else {
  finish({ status: 'completed', summary: `rehearsal: ${role}` });
}
}
