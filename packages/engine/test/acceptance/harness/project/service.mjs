// The reference project of M4's project lane (BS4 §§3, 7, 11.2; M4 plan
// §2.3; SEAM.md §325; rows M339 and M340): a dependency-free Node HTTP
// service (Node's own `http`, nothing from npm) with a requirement and its
// criterion, workspace acceptance and smoke checks under M3's protective
// wrapper, a required `post_deploy_behavior` check exercising the specified
// user operation, one disposable secret, and the Switchboard mutant (E120
// item 2; AR §7). Its files are written here as text and committed by the
// test into a repository of its own; nothing here is a test file.
//
// The project:
//   src/sum.mjs                               the library (M3's SUM): written by the Builder
//   server.mjs                                the service (SERVER, or SWITCHBOARD for the
//                                             mutant): written by the Builder
//   .surety/checks/protected-policy.json      the governed file
//   .surety/checks/wrapper.mjs                M3's protective wrapper
//   .surety/checks/tests/sum.test.mjs         M3's node:test of src/sum.mjs (criterion R1.1)
//   .surety/checks/post-deploy/operation.mjs  the specified user operation, over HTTP
//   .surety/checks/post-deploy/health.mjs     a health probe only (M340 (c))
//   .surety/checks/defs/accept.json           acceptance, covers R1.1 (stage, alpha_authorize)
//   .surety/checks/defs/smoke.json            smoke: node --check server.mjs (stage, alpha_authorize)
//   .surety/checks/defs/operation.json        post_deploy_behavior (alpha_complete), or
//   .surety/checks/defs/health.json           the health-only one in its place (M340 (c))
//
// The specified user operation (R1, "a user sums two numbers through the
// service"): GET /sum?a=2&b=3 answers 200 {"sum": 5}. The workspace checks
// test the library, not the service, so the Switchboard mutant passes them:
// its /health answers and its tree is what was sealed, while /sum hands the
// library the query's strings and answers {"sum": "23"}.
//
// SAFETY (BS4 §4.1; E64). The service listens on 127.0.0.1 in its own
// network namespace, reads one variable (REF_SECRET, a disposable random
// value the test makes) only to require that it is set, never prints it,
// and has no act: it starts nothing, signals nothing and writes nothing.
// The check programs make one or two GETs to the address
// SURETY_TARGET_APP names and exit; they start, signal and write nothing.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { roleThat, runToEnd, step, waitForCandidates } from '../gitruns.mjs';
import { changePolicy } from '../journal.mjs';
import { sandboxEngine } from '../sandbox/lane.mjs';
import { withStore } from '../store.mjs';
import { definitionText, executionsOf, governedText, installIndexedPlan, nodeReadPaths, qualifyRunnerByFixture, checkProject, waitRecorded } from '../checks/fixtures.mjs';
import { waitSelfTest } from '../checks/execution.mjs';
import { RUNTIME, configContent, configure, roundsOf, verificationsOf } from '../deploy/kernel.mjs';
import { newestOperation, realAdapterStarts, secretArgs, secretFile, serviceOf, testSecret, ticksUntil } from '../deploy/host.mjs';
import { qualifyAdapter, qualifyByCommand } from '../deploy/qualify.mjs';
import { freePort } from '../engine.mjs';
import { SUM, SUM_PATH, SUM_TEST, WRAPPER } from './reference.mjs';

export { SUM, SUM_PATH };
export const SERVER_PATH = 'server.mjs';
export const SECRET_REF = 'deploy/ref_secret';
export const SECRET_VAR = 'REF_SECRET';

const serviceText = (sumLine) => `// The reference service (SEAM.md §325): Node's own http, nothing from npm.
import { createServer } from 'node:http';
import { sum } from './src/sum.mjs';

// One disposable secret: required, never printed.
if (typeof process.env.REF_SECRET !== 'string' || process.env.REF_SECRET === '') {
  process.stderr.write('reference service: REF_SECRET is not set\\n');
  process.exit(1);
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://service');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/sum') {
${sumLine}
  }
  return send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

// The correct service: the query's numbers, summed by the library.
export const SERVER = serviceText(`    const a = Number(url.searchParams.get('a'));
    const b = Number(url.searchParams.get('b'));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return send(res, 400, { error: 'a and b must be numbers' });
    return send(res, 200, { sum: sum(a, b) });`);

// The Switchboard mutant (E120 item 2; AR §7): its health answers and its
// library is correct, but the route hands the library the query's strings.
export const SWITCHBOARD = serviceText(`    return send(res, 200, { sum: sum(url.searchParams.get('a'), url.searchParams.get('b')) });`);

const checkProgram = (tag, paths, verdict) => `// A post-deploy check of the reference project (SEAM.md §325): GETs to the
// service through SURETY_TARGET_APP, reported on one line, judged by ${tag}.
import { get } from 'node:http';

const base = process.env.SURETY_TARGET_APP;
if (!base) {
  console.log('${tag} ' + JSON.stringify({ error: 'SURETY_TARGET_APP is not set' }));
  process.exit(2);
}
const ask = (path) =>
  new Promise((resolve) => {
    const req = get(new URL(path, base), { timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ path, status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ path, status: null, error: err.code ?? err.message }));
  });
const results = [];
for (const path of ${JSON.stringify(paths)}) results.push(await ask(path));
console.log('${tag} ' + JSON.stringify(results));
const verdict = ${verdict};
process.exit(verdict(results) ? 0 : 1);
`;

// The specified user operation: /health is asked and reported (the mutant's
// answers), but only /sum's answer decides.
export const OPERATION_CHECK = checkProgram('REF-OPERATION', ['/health', '/sum?a=2&b=3'], `(r) => { const s = r.find((x) => x.path.startsWith('/sum')); try { return s.status === 200 && JSON.parse(s.body).sum === 5; } catch { return false; } }`);
// A check that only probes health (M340 (c); D4 §5.4, §11 class C).
export const HEALTH_CHECK = checkProgram('REF-HEALTH', ['/health'], `(r) => r[0].status === 200`);

export const POLICY = Object.freeze({ deploy_auto_retries_max: 0, service_memory_max: 67108864, identity_observation_every: 1 });

// The project's files: its protected set; the Builder writes the service.
// `behaviour` names the required post_deploy_behavior check: `operation`
// (the specified user operation) or `health` (the health probe only).
export function serviceProjectFiles({ behaviour = 'operation' } = {}) {
  const wrapper = '.surety/checks/wrapper.mjs';
  const sumTest = '.surety/checks/tests/sum.test.mjs';
  const program = behaviour === 'health' ? '.surety/checks/post-deploy/health.mjs' : '.surety/checks/post-deploy/operation.mjs';
  return {
    '.surety/checks/protected-policy.json': governedText({
      protected_paths: ['.surety/checks/'],
      check_commands: { node: { path: process.execPath } },
      runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
    }),
    [wrapper]: WRAPPER,
    [sumTest]: SUM_TEST,
    '.surety/checks/post-deploy/operation.mjs': OPERATION_CHECK,
    '.surety/checks/post-deploy/health.mjs': HEALTH_CHECK,
    '.surety/checks/defs/accept.json': definitionText('accept', { kind: 'acceptance', command: ['node', wrapper, sumTest], timeout_s: 120, gate_kinds: ['stage', 'alpha_authorize'], covers: { criteria: ['R1.1'] } }),
    '.surety/checks/defs/smoke.json': definitionText('smoke', { kind: 'smoke', command: ['node', '--check', SERVER_PATH], timeout_s: 60, gate_kinds: ['stage', 'alpha_authorize'] }),
    [`.surety/checks/defs/${behaviour}.json`]: definitionText(behaviour, { kind: 'post_deploy_behavior', command: ['node', program], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
  };
}

export const REQUIREMENT = Object.freeze({ key: 'R1', title: 'A user sums two numbers through the service: GET /sum?a=2&b=3 answers {"sum": 5}', criteria: ['R1.1'] });

// What the Builder writes: the library and the service (or the mutant).
export const builderSteps = ({ service = SERVER } = {}) => [step.write(SUM_PATH, SUM), step.write(SERVER_PATH, service)];

// A sandbox-lane engine on the real adapter holding one disposable secret
// on every start; the check runner qualified by its self-test
// (`runnerSelfTest`) or by section 181's fixture; the adapter qualified by
// command (`qualify`: `command`, the CLI; `route`, POST …/qualify), never by
// the stand-in; then the reference project built by a scripted Builder,
// nominated, its workspace checks recorded by the engine. Returns
// {fx, project, p, candidate, stage, qualification, secret, envs}.
export async function referenceDeployable(t, guard, { service = SERVER, behaviour = 'operation', runnerSelfTest = false, qualify = 'route', policy = POLICY, engineConfig = {} } = {}) {
  const fx = realAdapterStarts(await sandboxEngine(t, { start: false, config: engineConfig }));
  guard.track(fx);
  // The secret's directory lies in the fixture's own root (removed with it), outside the engine home (section 160's rule).
  const dir = join(fx.root, 'ref-secret');
  mkdirSync(dir, { mode: 0o700 });
  const secret = { ref: SECRET_REF, value: testSecret('ref') };
  secret.file = secretFile(dir, 'ref_secret', secret.value);
  const flags = secretArgs({ [SECRET_REF]: secret.file });
  const inner = fx.start;
  fx.start = (opts = {}) => inner({ ...opts, args: [...(opts.args ?? []), ...flags, ...(runnerSelfTest ? ['--harness-runner-self-test', 'run'] : [])] });
  await fx.start();
  if (runnerSelfTest) await waitSelfTest(fx);
  else await qualifyRunnerByFixture(fx.engine);

  let qualification;
  if (qualify === 'command') {
    const cli = qualifyByCommand(fx);
    assert.equal(cli.status, 0, `surety qualify-adapter local_service exits 0 in the test's home (SEAM.md §322) (stdout ${cli.stdout.slice(0, 600)}; stderr ${cli.stderr.slice(0, 400)})`);
    qualification = cli.body;
  } else qualification = await qualifyAdapter(fx.engine);
  assert.equal(qualification?.qualified, true, `the adapter is qualified by command (${JSON.stringify(qualification).slice(0, 400)})`);

  const p = await checkProject(fx, { files: serviceProjectFiles({ behaviour }), tier: 'T1' });
  if (Object.keys(policy).length > 0) await changePolicy(fx.engine, p.id, policy);
  const plan = await installIndexedPlan(fx.engine, p.id, { index: [REQUIREMENT], stages: [{ number: 1, goal: 'the reference service', implements: ['R1'] }] });
  const [stage] = plan.stages;
  fx.scripted.script(stage.work_item, [roleThat(builderSteps({ service }), { nominate: true })]);
  const build = await runToEnd(fx, p.id, stage.work_item, { timeoutMs: 300_000 });
  assert.deepEqual([build.outcome, build.reason_class], ['completed', 'none'], `the Builder's run was accepted (${build.reason_text})`);
  const [candidate] = await waitForCandidates(fx, p.id);
  const recorded = await waitRecorded(fx, p.id, candidate.id, ['accept', 'smoke'], { what: "the reference candidate's workspace checks to be recorded" });
  return { fx, project: p.id, p, candidate, stage, qualification, secret, workspace: recorded, envs: {} };
}

// Environment `name` of the reference project: the service by the engine's
// own node, its secret by reference, a port free on the host (SEAM.md §325).
export async function referenceEnvironment(ctx, name, over = {}) {
  const content = configContent({
    adapter_version: ctx.qualification.adapter_version,
    port: await freePort(),
    start: [RUNTIME.path, SERVER_PATH],
    secrets: { [SECRET_VAR]: SECRET_REF },
    ...over,
  });
  const done = await configure(ctx.fx.engine, ctx.project, name, content);
  const env = { ...done.environment, name, config: done.config, content };
  ctx.envs[name] = env;
  return env;
}

// Ask for ticks until the newest round of the environment's newest deploy has
// its verification row. Returns {op, round, row, svc}.
export async function roundRow(ctx, env, { timeoutMs = 300_000 } = {}) {
  const found = await ticksUntil(
    ctx.fx,
    ctx.project,
    () => {
      const op = newestOperation(ctx, env);
      const round = op ? roundsOf(ctx.fx.home, op.id).at(-1) : undefined;
      const row = round ? verificationsOf(ctx.fx.home, round.id).at(-1) : undefined;
      return row ? { op, round, row } : undefined;
    },
    { timeoutMs, what: `the verification row of ${env.name}'s deploy` },
  );
  return { ...found, svc: serviceOf(ctx, env, found.op) };
}

// The post-deploy executions of a round, with their result rows and domains.
export function roundChecks(ctx, round) {
  return withStore(ctx.fx.home, (db) => {
    const xs = db
      .prepare(`SELECT x.*, c."key" AS "key" FROM "check_executions" x JOIN "checks" c ON c."id" = x."check" WHERE x."deployment" IS NOT NULL ORDER BY x."execution_seq"`)
      .all()
      .filter((x) => JSON.parse(x.deployment)?.round === round.id);
    return xs.map((x) => ({
      ...x,
      result: db.prepare('SELECT * FROM "check_results" WHERE "execution" = ? ORDER BY rowid DESC').get(x.id) ?? null,
      domain: x.domain ? db.prepare('SELECT * FROM "execution_domains" WHERE "id" = ?').get(x.domain) ?? null : null,
    }));
  });
}

// The program's report line (`REF-OPERATION [...]` or `REF-HEALTH [...]`) in a result's output.
export function reportOf(text, tag) {
  const line = (text ?? '').split('\n').find((l) => l.startsWith(`${tag} `));
  return line ? JSON.parse(line.slice(tag.length + 1)) : null;
}

export { executionsOf };
