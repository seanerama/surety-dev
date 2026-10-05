// The host sampler's cases (M136 S3; the E79 rehearsal's finding 2; D2
// §4.5, §7.2; SEAM.md §172): a native fake `claude` (standin/sampler-fake.c)
// on the PATH of a production-mode engine, and one qualification attempt
// at a time against it.
//
// Why a production-mode engine in the sandbox lane: the engine's test mode
// refuses an executable image as a stand-in (section 148), and the sampler
// identifies the backend by its executable image, which a script never is;
// so only an engine without --harness can be shown sampling a backend it
// identifies. It is the same engine, on this host's real sandbox and
// boundary, with a fake backend and no network: nothing here is the real
// lane. Its PATH is fixed (no directory of the caller's), and the test
// checks before anything starts that `claude` on it is the test's fake.
//
// SAFETY (E64): the fake acts (forks, a second instance of itself) only
// inside a sandbox, by its own guard (the host's pid namespace compiled in);
// it signals nothing but its node child and runs nothing but /bin/true and
// itself.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort, makeTempDir, startEngine, waitFor, writeEngineConfig } from '../engine.mjs';
import { changePolicy } from '../journal.mjs';
import { recordFile, recordRow } from '../records.mjs';
import { hostPidNamespace } from '../scripted.mjs';
import { withStore } from '../store.mjs';
import { endScopeLeftovers, scopeUnitPrefix } from './cgroup.mjs';
import { sandboxEnv } from './lane.mjs';
import { approveAttempt, attemptOf, canaryOf } from './qualify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const C_SOURCE = join(HERE, '..', 'standin', 'sampler-fake.c');
export const MARKER = 'SURETY SAMPLER FAKE CLAUDE';
const REF = 'backend/claude/api_key';
const MODEL = 'claude-sonnet-5-5';

// The fake's script, run by the native image with node as its child: the
// stream-json Claude Code's adapter parses and the three canaries obeyed.
// The containment canary lingers as long as the image says, so that what
// the image does happens while the canary runs.
const SCRIPT = `// ${MARKER}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') { process.stdout.write('2.1.289 (Claude Code)\\n'); process.exit(0); }
if (argv.length === 1 && argv[0] === '--help') { process.stdout.write('Usage: claude [options]\\n  a fake claude for the sampler cases; it runs no model\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const model = val('--model') || '${MODEL}';
const tools = (val('--tools') || 'Read,Edit,Write,Bash,Glob,Grep').split(',');
out({ type: 'system', subtype: 'init', tools, apiKeySource: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none', model, session_id: val('--session-id'), permissionMode: 'bypassPermissions', mcp_servers: [] });
let canary;
try { canary = JSON.parse(fs.readFileSync('/surety/context/canary.json', 'utf8')); } catch { out({ type: 'result', subtype: 'error_during_execution', is_error: true }); process.exit(1); }
out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_' + canary.kind, model, usage: { input_tokens: 800, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 }, content: [] } });
const finish = () => {
  fs.writeFileSync('/surety/out/result.json', JSON.stringify(canary.result));
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.002, modelUsage: { [model]: { inputTokens: 800, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 100 } } });
  process.exit(0);
};
if (canary.kind === 'positive') {
  const p = '/surety/workspace/' + canary.edit.path;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, canary.edit.content);
  finish();
} else if (canary.kind === 'cancellation') {
  process.on('SIGTERM', () => process.exit(143));
  fs.writeFileSync(canary.barrier, '');
  setTimeout(() => process.exit(0), (canary.wait_seconds || 60) * 1000);
} else {
  setTimeout(finish, Number(process.env.SURETY_SAMPLER_FAKE_LINGER_MS || 0));
}
`;

// Builds the fake at `out` for one mode (1 fork windows, 2 a persisting
// second instance, 3 a fork that never execs): cc, the script embedded as
// bytes, the host's pid namespace and node's path compiled in.
export function buildFake(out, { mode, holdMs, count = 1, startDelayMs = 400 }) {
  const dir = makeTempDir('sampler-fake-build');
  const bytes = [...Buffer.from(`${SCRIPT}\0`)].join(',');
  writeFileSync(join(dir, 'sampler-fake.script.h'), `/* ${MARKER} */\nstatic const char SCRIPT[] = {${bytes}};\n`);
  const node = realpathSync(process.execPath);
  const hostNs = hostPidNamespace();
  assert.match(hostNs, /^pid:\[\d+\]$/, `the host's pid namespace is read for the fake's guard (${hostNs})`);
  const defs = { FAKE_MODE: mode, HOLD_MS: holdMs, COUNT: count, START_DELAY_MS: startDelayMs };
  const tmp = `${out}.${randomBytes(4).toString('hex')}`;
  const cc = spawnSync('cc', ['-O2', '-Wall', '-I', dir, ...Object.entries(defs).map(([k, v]) => `-D${k}=${v}L`), `-DFAKE_NODE="${node}"`, `-DHOST_PID_NS="${hostNs}"`, '-o', tmp, C_SOURCE], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (cc.error) throw new Error(`the sampler fake could not be compiled: cc could not be run (${cc.error.message})`);
  if (cc.status !== 0) throw new Error(`the sampler fake could not be compiled: cc exited ${cc.status}\n${cc.stderr}`);
  renameSync(tmp, out);
  assert.ok(readFileSync(out).includes(Buffer.from(MARKER)), 'the built fake carries its marker');
}

// A production-mode engine (no --harness) whose PATH names only `bin` and
// the system's directories, with a made-up key held by reference. Returns
// {engine, home, root, bin, fixture, cleanup()}.
export async function samplerEngine() {
  const root = makeTempDir('sampler');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, `sk-test-surety-sampler-fake-not-a-key-${randomBytes(8).toString('hex')}\n`, { mode: 0o600 });
  const port = await freePort();
  writeEngineConfig(home, { api_port: port, tick_interval: 600, terminate_grace: 3, kill_grace: 2 });
  const PATH = `${bin}:/usr/local/bin:/usr/bin:/bin`;
  // Whatever answers to `claude` on that PATH is the test's fake, or nothing.
  for (const d of PATH.split(':').slice(1)) assert.ok(!existsSync(join(d, 'claude')), `${d}/claude exists: the engine would find a claude other than the test's fake; nothing was started`);
  const prefix = scopeUnitPrefix(home);
  const engine = await startEngine({ home, port, harness: false, args: ['--secret-file', `${REF}=${keyFile}`, '--provider-cap-usd', `${REF}=50`], env: { ...sandboxEnv(), PATH }, timeoutMs: 180_000 });
  const info = await engine.engineInfo();
  assert.equal(info.host_qualification?.eligible, true, `the host is qualified at this start: ${JSON.stringify(info.host_qualification?.failed_checks)}`);
  const fixture = info.qualification_fixture_project;
  assert.match(String(fixture), /^proj_/, 'GET /v1/engine names the qualification fixture project');
  await changePolicy(engine, fixture, { budget_run_billable_tokens: 300000, budget_day_verified_usd: 10, budget_day_unknown_tokens: 900000 });
  const cleanup = async () => {
    await engine.stop().catch(() => engine.kill());
    endScopeLeftovers(prefix);
    rmSync(root, { recursive: true, force: true });
  };
  return { engine, home, root, bin, fixture, cleanup };
}

// The PF_FORKNOEXEC flag of /proc/<pid>/stat (field 9): forked, not exec'd.
const PF_FORKNOEXEC = 0x40;

// One attempt with the fake built for `fake`, approved by the test. While
// it runs, the test samples the canaries' domains from the host itself:
// each member running the attempt's pinned image, and whether it is a fork
// not yet exec'd. Returns {attempt, k, ev, caps, host}.
export async function samplerAttempt(fx, fake) {
  const claude = join(fx.bin, 'claude');
  buildFake(claude, fake);
  const res = await fx.engine.post('/v1/trust/qualify', { backend: 'claude', mode: 'one_shot_headless', model: MODEL, candidate_egress: ['api.provider.example'], canary_deadlines: { positive: 120, cancellation: 60, containment: 120 }, auth_mode: 'api_key' });
  assert.equal(res.status, 201, `POST /v1/trust/qualify proposes the attempt (body: ${res.text})`);
  const id = res.body.qualification_attempt.id;
  const pinned = attemptOf(fx.home, id).binary_path;
  const host = { samples: 0, image_max: 0, forks_unexeced_seen: 0, exec_seconds_seen: 0 };
  let target = null;
  const timer = setInterval(() => {
    try {
      target ??= statSync(pinned);
      const doms = withStore(fx.home, (db) => db.prepare('SELECT d."cgroup_path" FROM "execution_domains" d JOIN "invocation_receipts" r ON r."run" = d."run" WHERE r."qualification_attempt" = ? AND d."cgroup_path" IS NOT NULL').all(id));
      for (const { cgroup_path } of doms) {
        let pids;
        try {
          pids = readFileSync(join(cgroup_path, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean);
        } catch {
          continue;
        }
        host.samples++;
        let images = 0;
        let forks = 0;
        for (const pid of pids) {
          try {
            const st = statSync(`/proc/${pid}/exe`);
            if (st.dev !== target.dev || st.ino !== target.ino) continue;
            images++;
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const flags = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[6]);
            if (flags & PF_FORKNOEXEC) forks++;
          } catch {
            // gone
          }
        }
        host.image_max = Math.max(host.image_max, images);
        if (images >= 2 && forks >= 1) host.forks_unexeced_seen++;
        if (images >= 2 && forks === 0) host.exec_seconds_seen++;
      }
    } catch {
      // the pinned copy or the store not readable yet
    }
  }, 50);
  try {
    await approveAttempt(fx, fx.fixture, id);
    const done = await waitFor(
      async () => {
        const a = attemptOf(fx.home, id);
        if (['succeeded', 'failed', 'invalidated'].includes(a?.status)) return a;
        await fx.engine.post(`/v1/projects/${fx.fixture}/tick`, {}).catch(() => null);
        return undefined;
      },
      { timeoutMs: 600_000, intervalMs: 1000, what: `attempt ${id} to end` },
    );
    const k = canaryOf(done, 'containment');
    assert.ok(k?.evidence, `the containment canary ran and kept its evidence (${JSON.stringify(done.canaries)})`);
    const ev = JSON.parse(readFileSync(recordFile(fx.home, recordRow(fx.home, k.evidence)), 'utf8'));
    return { attempt: done, k, ev, caps: ev.capabilities ?? null, host };
  } finally {
    clearInterval(timer);
  }
}

