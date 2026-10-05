// The real lane (M2 slice 14; M2 plan §2.1, §3.8; D2 §7.2, Q1, Q2, Q7; E59;
// SEAM.md §§159 to 166): a real backend binary, Claude Code, against a model,
// paid, under a qualification attempt Sean approves. Only Sean runs it, with
// `node scripts/run-tests.mjs acceptance --lane real`; nothing here runs in
// `npm test` or a slice.
//
// MONEY. Every paid step passes through one of Sean's answers given through
// the API: `qualification_approval` before any canary, `trust_activation`
// before any journey run. Nothing in this module answers either for him
// (E59 item 2; the build spec: "never by a fixture"). It waits, prints what
// it waits for, and gives up after SURETY_REAL_WAIT_MINUTES with nothing
// spent beyond what Sean approved.
//
// STOP, NEVER RETRY. A retry costs money (E59; the slice-14 brief). Every
// paid step is a named step recorded in the run directory's state.json; a
// step that has run is never run again by a later file or a later run of the
// lane, which re-judges it from its records. The first step that ends in an
// unexpected outcome halts the run directory: every later step fails at once
// without starting anything. Only Sean clears a step, by naming it in
// SURETY_REAL_RERUN.
//
// THE CREDENTIAL. M2's real lane authenticates with Sean's Claude
// subscription: a long-lived token he makes himself with `claude setup-token`
// (E74 item 1, Sean's decision). The `api_key` mode is kept and can be
// selected (SURETY_REAL_AUTH_MODE), but M2 claims only the subscription
// mode. Either credential is never in this source, an argument, an
// environment variable, a log or a file this module writes. The test is
// given a reference (SURETY_REAL_CREDENTIAL_REF, the path of a file that
// holds it) and hands the engine the same path (`--secret-file`). It reads
// the value only to search for it afterwards, in-process (M139 (a), M140 (e)).
// Below, "key" names the credential of either mode.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { REPO_ROOT, freePort, startEngine, writeEngineConfig } from '../engine.mjs';
import { decisionsOn } from '../decisions.mjs';
import { recordFile } from '../records.mjs';
import { withStore } from '../store.mjs';
import { sandboxEnv } from '../sandbox/lane.mjs';

// ---- what Sean decided (E59) and the bounds the lane sets (SEAM.md §161) ----------

export const REAL = Object.freeze({
  backend: 'claude',
  mode: 'one_shot_headless',
  // E59: claude-sonnet-5-5 for the canaries and for every role of the journey.
  model: 'claude-sonnet-5-5',
  // The one destination the attempt proposes. Anything else a canary
  // contacts is refused by the proxy and reported, never added (D2 §2.4).
  candidateEgress: Object.freeze(['api.anthropic.com']),
  // The credential's reference, per auth mode (E74 item 1; SEAM.md §160).
  authModes: Object.freeze({
    subscription_token: Object.freeze({ ref: 'backend/claude/subscription_token', invalid: 'sk-ant-oat01-surety-invalid-' }),
    api_key: Object.freeze({ ref: 'backend/claude/api_key', invalid: 'sk-ant-api03-surety-wrong-' }),
  }),
  // E59: 300 000 billable tokens per run; 25 USD verified per day; the
  // provider-side cap on the dedicated key is 50 USD. The day's 25 USD is
  // split between the three projects the lane charges, so their day limits
  // together never pass it: the engine's qualification fixture project and
  // the journey's two projects, one per path. Each limit is a project key
  // (`contract/config.json`); a run held at its project's limit waits.
  runBillableTokens: 300_000,
  dayVerifiedUsd: Object.freeze({ qualification: 10, pathOne: 6, pathTwo: 9 }),
  dayUnknownTokens: 900_000,
  // The provider-side cap on a dedicated API key (api_key mode only). In
  // the subscription mode the hard limit is the subscription's own usage
  // limits, which Sean's own Claude use shares (E74 item 1).
  providerCapUsd: 50,
  // Seconds. The attempt's canaries; the journey's roles (the minimum is 300).
  canaryDeadlines: Object.freeze({ positive: 600, cancellation: 300, containment: 600 }),
  roleDeadlines: Object.freeze({ deadline_builder: 900, deadline_verifier: 600, deadline_reviewer: 600 }),
  // First-party rates per million tokens for claude-sonnet-5-5 (Anthropic's
  // reference as cached on 2026-09-25): 2 USD input, 10 USD output, 0.20 USD
  // a cache read. Used only to state what a step can cost at most; the
  // engine's estimate is the engine's (SEAM.md §161).
  usdPerMillion: Object.freeze({ input: 2, output: 10, cacheRead: 0.2 }),
});

// The most one run's billable tokens can cost at the dearest rate. Cache
// reads are not billable tokens and the run limit does not count them, and
// one invocation can overshoot its limit until its deadline (D2 §4.2, §8 C).
export const RUN_BILLABLE_MAX_USD = (REAL.runBillableTokens * REAL.usdPerMillion.output) / 1_000_000;

// SURETY_REAL_CONFIRM_SPEND must be exactly this.
export const CONFIRM_PHRASE = 'I accept the M2 real lane on my Claude subscription, up to 25 USD a day as estimated';

const ENV = Object.freeze({
  runDir: 'SURETY_REAL_RUN_DIR',
  keyRef: 'SURETY_REAL_CREDENTIAL_REF',
  authMode: 'SURETY_REAL_AUTH_MODE',
  binary: 'SURETY_REAL_CLAUDE_BINARY',
  confirm: 'SURETY_REAL_CONFIRM_SPEND',
  wait: 'SURETY_REAL_WAIT_MINUTES',
  rerun: 'SURETY_REAL_RERUN',
  pathTwo: 'SURETY_REAL_PATH_TWO',
  rehearsal: 'SURETY_REAL_REHEARSAL',
});

const HOURS = 3_600_000;
// Each real-lane test sets its own timeout (node:test's per-test option),
// long enough for Sean's answers; the runner's default is ten minutes.
export const REAL_TEST_TIMEOUT_MS = 8 * HOURS;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const inside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const fail = (message) => {
  throw new Error(`${message} (SEAM.md §160). Nothing was started.`);
};

// ---- the preflight: every guard before anything starts ---------------------------

// Every real-lane test begins here. It refuses, before any engine or binary
// starts, unless Sean has set the run directory, the key reference, the
// pinned binary and the spend confirmation, each well formed. Returns the
// lane's context. The key's value is held in memory only, for the searches.
export function realPreflight() {
  const env = process.env;
  for (const name of [ENV.runDir, ENV.keyRef, ENV.binary, ENV.confirm]) {
    if (!env[name]) fail(`the real lane needs ${name} (SEAM.md §§160, 161)`);
  }
  if (env[ENV.confirm] !== CONFIRM_PHRASE) fail(`${ENV.confirm} must be exactly "${CONFIRM_PHRASE}"`);

  // The key reference: a path, never a key.
  const keyRef = env[ENV.keyRef];
  if (!keyRef.startsWith('/')) fail(`${ENV.keyRef} must be the absolute path of a file that holds the credential, never the credential itself (its value is not shown)`);
  let st;
  try {
    st = lstatSync(keyRef);
  } catch {
    fail(`${ENV.keyRef} names no file`);
  }
  if (!st.isFile()) fail(`${ENV.keyRef} must name a regular file, not a link or anything else`);
  if ((st.mode & 0o077) !== 0) fail(`${ENV.keyRef}'s file must be readable by its owner only (mode 0600 or 0400)`);
  if (st.uid !== process.getuid()) fail(`${ENV.keyRef}'s file must belong to this user`);
  if (st.size < 20 || st.size > 512) fail(`${ENV.keyRef}'s file must hold one key and nothing else`);
  const keyValue = readFileSync(keyRef, 'utf8').replace(/\r?\n$/, '');
  if (keyValue.length < 20 || /\s/.test(keyValue)) fail(`${ENV.keyRef}'s file must hold one key on one line`);
  for (const forbidden of [REPO_ROOT, join(homedir(), '.claude'), join(homedir(), '.codex')]) {
    if (inside(keyRef, forbidden)) fail(`${ENV.keyRef} must not be inside ${forbidden}`);
  }

  // The run directory: outside the repository, holding nothing of the key.
  const runDir = env[ENV.runDir];
  if (!isAbsolute(runDir)) fail(`${ENV.runDir} must be an absolute path`);
  if (inside(runDir, REPO_ROOT)) fail(`${ENV.runDir} must be outside the repository: it holds engine homes and records`);
  if (inside(keyRef, runDir)) fail(`${ENV.keyRef} must not be inside ${ENV.runDir}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  // The pinned binary: one regular file, by its own path (SEAM.md §164).
  const binary = env[ENV.binary];
  if (!isAbsolute(binary)) fail(`${ENV.binary} must be an absolute path`);
  let bst;
  try {
    bst = lstatSync(binary);
  } catch {
    fail(`${ENV.binary} names no file`);
  }
  if (!bst.isFile()) fail(`${ENV.binary} must name the binary's own file, not a link to it (a link like ~/.local/bin/claude moves when Claude Code updates itself)`);
  if ((bst.mode & 0o111) === 0) fail(`${ENV.binary} must be executable`);
  const binarySha256 = sha256(readFileSync(binary));
  const rehearsal = rehearsalGuard(env[ENV.rehearsal], binary);

  sandboxEnv(); // a login session with the user manager (SEAM.md §122): asserts, never skips

  const waitMinutes = Number(env[ENV.wait] ?? 120);
  if (!Number.isFinite(waitMinutes) || waitMinutes < 1 || waitMinutes > 600) fail(`${ENV.wait} must be a number of minutes from 1 to 600`);
  const authMode = env[ENV.authMode] ?? 'subscription_token';
  if (!(authMode in REAL.authModes)) fail(`${ENV.authMode} must be "subscription_token" (M2's) or "api_key"`);
  const pathTwo = env[ENV.pathTwo] ?? 'real';
  if (!['real', 'mixed'].includes(pathTwo)) fail(`${ENV.pathTwo} must be "real" or "mixed"`);

  // The pin: the engine resolves `claude` on its own PATH (D2 §7.2, "the
  // resolved path"); this directory comes first in it and names only the
  // pinned file.
  const binDir = join(runDir, 'bin');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const link = join(binDir, 'claude');
  if (existsSync(link) || isLink(link)) {
    if (readlinkSync(link) !== binary) unlinkSync(link);
  }
  if (!isLink(link)) symlinkSync(binary, link);

  const candidateEgress = rehearsal ? [...REHEARSAL_EGRESS] : [...REAL.candidateEgress];
  const ctx = { runDir, keyRef, keyValue, authMode, credentialRef: REAL.authModes[authMode].ref, binary, binarySha256, binDir, waitMinutes: waitMinutes, pathTwo, rehearsal, candidateEgress, providerHost: candidateEgress[0] };
  Object.defineProperty(ctx, 'keyValue', { enumerable: false }); // never serialized
  applyRerun(ctx);
  return ctx;
}

// ---- the dress rehearsal (E79 item 1; SEAM.md §170) ---------------------------------

// The marker the rehearsal's fake carries (harness/standin/rehearsal-claude.mjs).
export const REHEARSAL_MARKER = 'SURETY REHEARSAL FAKE CLAUDE';
// The rehearsal's only candidate destination: a name that resolves nowhere,
// so nothing leaves this machine for a provider (the provider-tunnel
// control then fails, as expected in a rehearsal).
export const REHEARSAL_EGRESS = Object.freeze(['provider.rehearsal.invalid']);

// SURETY_REAL_REHEARSAL=1 lets the harness answer Sean's approvals itself,
// and only for the rehearsal's fake: a script (not an executable image)
// carrying the marker, outside Claude Code's own install directories, under
// 1 MiB. Anything else refuses the run before anything starts. Without the
// switch, nothing changes: the test waits for Sean.
function rehearsalGuard(value, binary) {
  if (value === undefined || value === '') return false;
  if (value !== '1') fail('SURETY_REAL_REHEARSAL must be 1 or unset');
  const real = realpathSync(binary);
  const bytes = readFileSync(real);
  const reasons = [];
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) reasons.push('it is an executable image');
  if (!bytes.subarray(0, 2).equals(Buffer.from('#!'))) reasons.push('it is not a script');
  if (!bytes.includes(Buffer.from(REHEARSAL_MARKER))) reasons.push(`it does not carry "${REHEARSAL_MARKER}"`);
  if (bytes.length > 1 << 20) reasons.push('it is larger than 1 MiB');
  for (const dir of [join(homedir(), '.local', 'share', 'claude'), join(homedir(), '.local', 'bin')]) if (inside(real, dir)) reasons.push(`it is inside ${dir}`);
  if (reasons.length > 0) fail(`the rehearsal switch works only with the rehearsal's fake claude, and ${binary} is not it: ${reasons.join('; ')}`);
  const banner = `\n${'#'.repeat(78)}\n# SURETY REAL LANE: DRESS REHEARSAL (SURETY_REAL_REHEARSAL=1)\n# The backend is the FAKE claude at ${real}.\n# The harness answers qualification_approval and trust_activation ITSELF.\n# Nothing is sent to a provider: the only candidate destination is ${REHEARSAL_EGRESS[0]}.\n# Nothing here is evidence for M2.\n${'#'.repeat(78)}\n`;
  process.stderr.write(banner);
  return true;
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---- the run directory's state: steps, the halt, reruns (SEAM.md §159) ----------

const statePath = (ctx) => join(ctx.runDir, 'state.json');

export function loadState(ctx) {
  if (!existsSync(statePath(ctx))) return { version: 1, created_at: new Date().toISOString(), steps: {}, halted: null };
  return JSON.parse(readFileSync(statePath(ctx), 'utf8'));
}

function saveState(ctx, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  assertNoKey(ctx, text, 'state.json');
  const tmp = `${statePath(ctx)}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, statePath(ctx));
}

// Sean's reruns are applied once per run of the lane, not once per file:
// every file of one `--lane real` run is a child of the same runner
// process, so the runner's pid and the names are the key. Applied again by
// a later file of the same run, they would clear a step that file's
// predecessor had just run, and a later case could run it a second time.
function applyRerun(ctx) {
  const names = (process.env[ENV.rerun] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return;
  const state = loadState(ctx);
  const key = `${process.ppid}:${names.join(',')}`;
  state.reruns_applied ??= [];
  if (state.reruns_applied.includes(key)) return;
  state.reruns_applied.push(key);
  for (const name of names) delete state.steps[name];
  if (state.halted && names.includes(state.halted.step)) state.halted = null;
  saveState(ctx, state);
}

// A paid or engine-starting step, at most once per run directory. A step
// already recorded returns its recorded value (or fails again with its
// recorded failure) and starts nothing. A halted run directory fails every
// step that has not run. A step that throws halts the run directory.
export async function realStep(ctx, name, fn) {
  let state = loadState(ctx);
  const done = state.steps[name];
  if (done?.status === 'done') return done.value;
  if (done?.status === 'failed') throw new Error(`step ${name} failed earlier and is not run again (${done.reason}); it is rerun only if Sean names it in ${ENV.rerun}`);
  if (state.halted) throw new Error(`the run directory is halted by step ${state.halted.step} (${state.halted.reason}); nothing was started. Sean clears it by naming that step in ${ENV.rerun}.`);
  state.steps[name] = { status: 'started', at: new Date().toISOString() };
  saveState(ctx, state);
  try {
    const value = await fn();
    state = loadState(ctx);
    state.steps[name] = { status: 'done', at: new Date().toISOString(), value: value ?? null };
    saveState(ctx, state);
    return value;
  } catch (err) {
    state = loadState(ctx);
    const reason = String(err?.message ?? err).slice(0, 2000);
    state.steps[name] = { status: 'failed', at: new Date().toISOString(), reason: redactKey(ctx, reason) };
    state.halted = { step: name, reason: redactKey(ctx, reason).slice(0, 400), at: new Date().toISOString() };
    saveState(ctx, state);
    throw err;
  }
}

// A judgement over what a step recorded. When it fails, the outcome was not
// the one expected, so the run directory is halted as a failed step halts
// it (if nothing halted it before): no paid step starts after an unexpected
// outcome. Sean clears it with SURETY_REAL_RERUN=judge:<label>.
export async function judged(ctx, label, fn) {
  try {
    return await fn();
  } catch (err) {
    const state = loadState(ctx);
    if (!state.halted) {
      state.halted = { step: `judge:${label}`, reason: redactKey(ctx, String(err?.message ?? err)).slice(0, 400), at: new Date().toISOString() };
      saveState(ctx, state);
    }
    throw err;
  }
}

// A step's recorded value, or a failure naming why there is none.
export function stepValue(ctx, name) {
  const s = loadState(ctx).steps[name];
  assert.ok(s?.status === 'done', `step ${name} has a recorded outcome (it is ${s ? `${s.status}${s.reason ? `: ${s.reason}` : ''}` : 'not run'})`);
  return s.value;
}

// ---- what is recorded for the report (SEAM.md §163) --------------------------------

export function observe(ctx, row, key, value) {
  const dir = join(ctx.runDir, 'observed');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${row}.json`);
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { row, written_by: 'the real-lane test, never edited by hand' };
  current[key] = value;
  current.updated_at = new Date().toISOString();
  const text = `${JSON.stringify(current, null, 2)}\n`;
  assertNoKey(ctx, text, `observed/${row}.json`);
  writeFileSync(file, text, { mode: 0o600 });
}

export const readObserved = (ctx, row) => {
  const file = join(ctx.runDir, 'observed', `${row}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

function redactKey(ctx, text) {
  return ctx.keyValue && text.includes(ctx.keyValue) ? text.split(ctx.keyValue).join('[the key]') : text;
}

function assertNoKey(ctx, text, where) {
  if (ctx.keyValue && text.includes(ctx.keyValue)) throw new Error(`the key's value was about to be written to ${where}; nothing was written`);
}

// ---- engines (SEAM.md §164) -----------------------------------------------------------

// The secret flags of every real-lane engine: the credential's file by
// reference under the mode's reference name, and, for an API key only, the
// provider-side cap recorded beside it (D2 Q2; E74 item 1; SEAM.md §160).
export const secretArgs = (ctx, keyFile) => {
  const ref = REAL.authModes[ctx.authMode].ref;
  return ['--secret-file', `${ref}=${keyFile}`, ...(ctx.authMode === 'api_key' ? ['--provider-cap-usd', `${ref}=${REAL.providerCapUsd}`] : [])];
};

const engineEnvFor = (ctx) => ({ ...sandboxEnv(), PATH: `${ctx.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` });

// A production engine (no --harness) on `<run dir>/<name>`: the
// qualification attempts' engine (M136 to M139), D2 §7.2's path exactly.
export async function productionEngine(ctx, name, { keyFile = ctx.keyRef, config = {} } = {}) {
  const home = join(ctx.runDir, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, tick_interval: 30, ...config });
  const engine = await startEngine({ home, port, harness: false, args: secretArgs(ctx, keyFile), env: engineEnvFor(ctx), timeoutMs: 180_000 });
  return { engine, home, port, root: ctx.runDir };
}

// The journey's engine (M140): the same home, restarted in the engine's
// test mode for the real lane (`--harness-real-lane`), because the plan,
// the checks, the check's execution and the Alpha target are fixtures in
// M2 (D3 is not built). The entry it dispatches to was written and
// activated by the production engine (SEAM.md §164). `scriptedDir` only
// for path two's mixed fallback (E59 item 3).
export async function journeyEngine(ctx, name, { scriptedDir = null, config = {} } = {}) {
  const home = join(ctx.runDir, name);
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, tick_interval: 600, ...config });
  const args = ['--harness-real-lane', ...(scriptedDir ? ['--harness-scripted', scriptedDir] : []), ...secretArgs(ctx, ctx.keyRef)];
  const engine = await startEngine({ home, port, harness: true, args, env: engineEnvFor(ctx), timeoutMs: 180_000 });
  return { engine, home, port, root: ctx.runDir };
}

// ---- waiting for Sean (SEAM.md §162) ---------------------------------------------------

// Writes a message where Sean will see it: the test's stderr, his terminal
// when the test has one, and <run dir>/WAITING.txt.
export function tellSean(ctx, text) {
  const banner = `\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}\n`;
  process.stderr.write(banner);
  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, banner);
    closeSync(fd);
  } catch {
    // no terminal: the file and stderr are enough
  }
  writeFileSync(join(ctx.runDir, 'WAITING.txt'), banner, { mode: 0o600 });
}

const answerCommand = (fx, row, option) =>
  `curl -sS -H "X-Surety-Token: $(cat ${join(fx.home, 'api.token')})" -H 'Content-Type: application/json' ` +
  `-X POST http://127.0.0.1:${fx.port}/v1/decisions/${row.id}/answer -d '{"option": "${option}", "preview_hash": "${row.preview_hash}"}'`;

// Wait for Sean's answer to the one open engine-scoped decision of `kind`
// about `subjectId`. Never answers it. Prints the question, the facts the
// preview binds that matter for money, and the command he can send. A next
// generation (the question still standing after a change) is followed and
// printed again. Returns the consumed decision; fails, and so halts, on a
// rejection or when the wait runs out (the decision is left open).
export async function waitForSean(ctx, fx, kind, subjectId, { what, facts = {} }) {
  const limitMs = ctx.waitMinutes * 60_000;
  const started = performance.now();
  let shown = null;
  for (;;) {
    const all = decisionsOn(fx.home, kind, subjectId);
    const consumed = all.find((d) => d.status === 'consumed');
    if (consumed) {
      writeFileSync(join(ctx.runDir, 'WAITING.txt'), `answered: ${kind} ${consumed.id} with ${consumed.answer?.option} at ${new Date().toISOString()}\n`, { mode: 0o600 });
      if (consumed.answer?.option !== 'approve') throw new Error(`Sean answered ${kind} ${consumed.id} with "${consumed.answer?.option}": the step stops here, as he chose`);
      return consumed;
    }
    const open = all.find((d) => d.status === 'open');
    if (open && ctx.rehearsal && open.id !== shown) {
      shown = open.id;
      tellSean(ctx, `SURETY REAL LANE REHEARSAL: the harness answers ${kind} ${open.id} itself with "approve" (the backend is the rehearsal's fake; SURETY_REAL_REHEARSAL=1).\nWhat: ${what}`);
      const res = await fx.engine.post(`/v1/decisions/${open.id}/answer`, { option: 'approve', preview_hash: open.preview_hash });
      if (res.status !== 200) throw new Error(`rehearsal: answering ${kind} ${open.id} was refused (${res.status} ${res.text})`);
    }
    if (open && open.id !== shown) {
      shown = open.id;
      tellSean(
        ctx,
        [
          `SURETY REAL LANE: waiting for Sean's answer (the test will not answer it).`,
          `What: ${what}`,
          `Decision: ${kind} ${open.id} (preview ${open.preview_hash}), about ${subjectId}`,
          ...Object.entries(facts).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
          `The full preview: GET /v1/decisions on http://127.0.0.1:${fx.port}.`,
          `To approve:`,
          `  ${answerCommand(fx, open, 'approve')}`,
          `To refuse (nothing is spent; the step stops):`,
          `  ${answerCommand(fx, open, 'reject')}`,
          `This test waits ${ctx.waitMinutes} minutes from when it began waiting, then stops with nothing further spent.`,
        ].join('\n'),
      );
    }
    if (performance.now() - started > limitMs) throw new Error(`no answer to ${kind} about ${subjectId} within ${ctx.waitMinutes} minutes; the decision is left open and nothing further was started`);
    await sleep(5_000);
  }
}

// ---- reading what the engine recorded --------------------------------------------------

const json = (text) => (text === null || text === undefined ? text : JSON.parse(text));

export const recordsOfRun = (home, run, kind) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "records" WHERE "run" = ?${kind ? ' AND "kind" = ?' : ''} ORDER BY rowid`).all(...(kind ? [run, kind] : [run])));

export const recordText = (home, row) => (row?.path ? readFileSync(recordFile(home, row), 'utf8') : null);
export const recordJson = (home, id) => {
  const row = withStore(home, (db) => db.prepare('SELECT * FROM "records" WHERE "id" = ?').get(id));
  const text = recordText(home, row);
  return text === null ? null : JSON.parse(text);
};

// The backend's stream as the run's transcript record holds it (SEAM.md
// §163): every line that parses as JSON, in order. What Claude Code's
// stream-json events hold is the canaries' to establish (D2 §4.5); these
// readers take what is there and assume no field.
export function streamEvents(home, run) {
  const rows = recordsOfRun(home, run, 'transcript');
  const lines = rows.flatMap((row) => (recordText(home, row) ?? '').split('\n'));
  const out = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line that is not JSON is kept in the record, not read here
    }
  }
  return out;
}

// The first event that looks like Claude Code's initial event and the last
// that looks like its terminal one (CH §3.7 at 2.1.281: `system`/`init`
// and `result`), recorded for the report whatever they hold.
export const initEvent = (events) => events.find((e) => e?.type === 'system' && e?.subtype === 'init') ?? null;
export const terminalEvent = (events) => [...events].reverse().find((e) => e?.type === 'result') ?? null;

// The output tokens the terminal event reports for every model call of the
// invocation (objection 015; SEAM.md §161): the sum of `modelUsage[*].outputTokens`
// where the event carries `modelUsage` (every call, the same calls as
// `total_cost_usd`), else `usage.output_tokens` (the main loop's only), else
// null. Recorded with the scope it came from.
export function terminalOutput(t) {
  const models = t?.modelUsage;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    const each = Object.values(models).map((m) => m?.outputTokens);
    if (each.length > 0 && each.every(Number.isInteger)) return { tokens: each.reduce((a, n) => a + n, 0), scope: 'all_models' };
  }
  if (Number.isInteger(t?.usage?.output_tokens)) return { tokens: t.usage.output_tokens, scope: 'main_loop' };
  return { tokens: null, scope: null };
}

// What the ledger calls Claude Code's `total_cost_usd` in each auth mode
// (E74 item 1; SEAM.md §161): with an API key, the provider's reported cost;
// with a subscription token, Claude Code's client-side estimate.
export const costStatusFor = (ctx) => (ctx.authMode === 'api_key' ? 'reported' : 'estimated');
export const dayTotalFor = (ctx) => (ctx.authMode === 'api_key' ? 'reported_usd' : 'estimated_usd');

export const ledgerOriginal = (home, run) => withStore(home, (db) => db.prepare('SELECT * FROM "ledger_rows" WHERE "run" = ? AND "corrects" IS NULL').all(run));

export const eventsAboutRun = (home, run) =>
  withStore(home, (db) => db.prepare(`SELECT * FROM "events" WHERE json_extract("subject", '$.run') = ? ORDER BY "seq"`).all(run)).map((e) => ({ ...e, subject: json(e.subject), payload: json(e.payload) }));

// ---- the host side: members of the domains while they run (M136 (c), M142 (4)) ------------

// Samples, every `intervalMs`, the members of each domain of `project` that
// exists on the host: each pid and its argv as /proc shows it. Returns
// {stop(): samples}.
export function sampleDomains(home, project, { intervalMs = 250 } = {}) {
  const samples = [];
  const timer = setInterval(() => {
    let rows = [];
    try {
      rows = withStore(home, (db) => db.prepare('SELECT d."id", d."run", d."cgroup_path" FROM "execution_domains" d JOIN "runs" r ON r."id" = d."run" WHERE r."project" = ? AND d."cgroup_path" IS NOT NULL').all(project));
    } catch {
      return;
    }
    for (const row of rows) {
      let pids;
      try {
        pids = readFileSync(join(row.cgroup_path, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
      } catch {
        continue; // not created yet, or gone
      }
      const members = pids.map((pid) => {
        try {
          return { pid, argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(0, 4) };
        } catch {
          return { pid, argv: null };
        }
      });
      samples.push({ at: new Date().toISOString(), domain: row.id, run: row.run, members });
    }
  }, intervalMs);
  return { stop: () => (clearInterval(timer), samples) };
}

// ---- the key's absence (M139 (a), M140 (e), M142 (9); SEAM.md §163) ---------------------

// Every file under `roots` that holds `value` or its JSON-escaped form, and
// every git object of `repos` that does. Compared in-process: the value is
// never put in an argument or another process's environment.
export function secretHits(value, { roots = [], repos = [] } = {}) {
  const forms = [...new Set([value, JSON.stringify(value).slice(1, -1)])].map((v) => Buffer.from(v));
  const holds = (buf) => forms.some((f) => buf.includes(f));
  const hits = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        try {
          if (holds(readFileSync(path))) hits.push(path);
        } catch {
          hits.push(`${path} (unreadable: not shown to hold nothing)`);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  for (const repo of repos) {
    const all = execFileSync('git', ['-C', repo, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 1 << 30 });
    if (holds(all)) hits.push(`${repo}: a git object`);
  }
  return hits;
}

// An invalid credential for M139, of the lane's auth mode: a subscription
// token or an API key in form, random, held in a 0600 file in the run
// directory. It authenticates nothing.
export function wrongKeyFile(ctx) {
  const dir = join(ctx.runDir, 'keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `invalid-${ctx.authMode}`);
  if (!existsSync(file)) {
    writeFileSync(file, `${REAL.authModes[ctx.authMode].invalid}${randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return { file, value: readFileSync(file, 'utf8').trim() };
}

// ---- small waits on long real runs -------------------------------------------------------

// Ask for a tick every `everyMs` until `done()` gives a value, or fail after
// `timeoutMs` (on the monotonic clock). For real runs that last minutes.
export async function tickWhile(fx, project, done, { timeoutMs, everyMs = 15_000, what }) {
  const started = performance.now();
  for (;;) {
    const value = await done();
    if (value !== undefined && value !== null && value !== false) return value;
    if (performance.now() - started > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await fx.engine.post(`/v1/projects/${project}/tick`, {}).catch(() => null);
    await sleep(everyMs);
  }
}

export { sha256 };
