// What the scripted roles of the retrofit journey write (D6 §8; B.2 to B.7;
// TPL with K10's sixth column and §12; SEAM.md §376). Text only; nothing
// here is run by the test runner.
//
//   R1 Sum two numbers        lib      observed   R1.1 (the adopted test covers it)
//   R2 Sum through the service service observed  R2.1
//   R3 Health                 service  observed   R3.1
//   R4 Refuse a non-number    service  intended   R4.1 (the README's false claim; answered `defect`)
//
// Phase 1 is the conformance phase: one `conformance: true` stage, no tasks,
// implementing the approved conformance set (R1 to R3). Phase 2 delivers R4
// by one Builder stage.

import { dirname } from 'node:path';

import { definitionText, governedText, nodeReadPaths } from '../checks/fixtures.mjs';
import { WRAPPER } from '../project/reference.mjs';
import { CI_ENVIRONMENT, README_CLAIMS } from './repo.mjs';

export const TIER = 'T1';
export const T1_KINDS = Object.freeze(['acceptance', 'smoke']);

export const REQUIREMENTS = Object.freeze([
  { key: 'R1', title: 'Sum two numbers', phase: 1, module: 'lib', origin: 'observed', statement: 'The library sums two numbers as a pure function.', criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns 5.' }] },
  { key: 'R2', title: 'Sum through the service', phase: 1, module: 'service', origin: 'observed', statement: 'A client sums two numbers through the service over HTTP.', criteria: [{ id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with the JSON body {"sum": 5}.' }] },
  { key: 'R3', title: 'Health', phase: 1, module: 'service', origin: 'observed', statement: 'The service answers its health.', criteria: [{ id: 'R3.1', text: 'Given the service is running, when a client requests GET /health, then it answers 200 with the JSON body {"ok": true}.' }] },
  { key: 'R4', title: 'Refuse a non-number', phase: 2, module: 'service', origin: 'intended', statement: 'A request to sum something that is not a number is refused.', criteria: [{ id: 'R4.1', text: 'Given the service is running, when a client requests GET /sum?a=x&b=3, then it answers 400.' }] },
]);
export const KEYS = Object.freeze(REQUIREMENTS.map((r) => r.key));

export const MODULES = Object.freeze([
  { name: 'lib', paths: ['src/'], sensitive_areas: [] },
  { name: 'service', paths: ['server.mjs'], sensitive_areas: [] },
]);

// TPL §12: one row per claim of the README, what the code was observed to do,
// and the requirement that records it.
export const CLAIMS = Object.freeze([
  { source: 'README.md', claim: '`GET /sum?a=2&b=3` answers `{"sum": 5}`.', observed: 'yes', requirement: 'R2' },
  { source: 'README.md', claim: '`GET /health` answers `{"ok": true}`.', observed: 'yes', requirement: 'R3' },
  { source: 'README.md', claim: README_CLAIMS.false, observed: 'no: it answers 200 with {"sum": null}', requirement: 'R4' },
  { source: 'README.md', claim: '`sum(a, b)` in `src/sum.mjs` is a pure function.', observed: 'yes', requirement: 'R1' },
]);

const areasOf = (xs) => (xs.length === 0 ? 'none' : xs.join(', '));

// TPL §5: five columns, or six with `Origin` (K10). `origins` overrides a
// row's origin ({R1: 'intended'}); `sixth` false writes the five-column form.
export function indexTable(requirements, { sixth = true, origins = {}, raw = {} } = {}) {
  const lines = sixth ? ['| Key | Title | Phase | Sensitive areas | Criteria | Origin |', '|---|---|---|---|---|---|'] : ['| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|'];
  for (const r of requirements) {
    const criteria = r.descriptive ? '' : r.criteria.map((c) => c.id).join(', ');
    const origin = raw[r.key] ?? origins[r.key] ?? r.origin ?? 'intended';
    lines.push(sixth ? `| ${r.key} | ${r.title} | ${r.phase} | none | ${criteria} | ${origin} |` : `| ${r.key} | ${r.title} | ${r.phase} | none | ${criteria} |`);
  }
  return lines.join('\n');
}

function requirementSection(r) {
  const body = r.descriptive ? ['**Descriptive.**', ''] : ['**Acceptance criteria**', '', ...r.criteria.map((c) => `- ${c.id} ${c.text}`), ''];
  return [`### ${r.key}. ${r.title}`, '', r.statement, '', '**Rationale.** The service does this today, or its README says it does.', '', '**Sensitive areas:** none', '', ...body].join('\n');
}

export const claimsTable = (claims) => ['| Source | Claim | Observed | Requirement |', '|---|---|---|---|', ...claims.map((c) => `| ${c.source} | ${c.claim.replaceAll('|', '\\|')} | ${c.observed} | ${c.requirement} |`)].join('\n');

// The retrofit specification in TPL's shape (K10): the six-column index and
// §12. `requirements`, `claims`, `sixth`, `origins`, `raw` (a row's sixth
// value as written), `modules` vary it.
export function retrofitSpecText({ version = 1, requirements = REQUIREMENTS, claims = CLAIMS, sixth = true, origins = {}, raw = {}, modules = MODULES, tier = TIER, changeLog = [] } = {}) {
  return `# Sums

**Spec version:** ${version}
**Status:** draft
**Tier:** ${tier}
**Owner:** Sean

## 1. Purpose

Sums adds two numbers over HTTP. This specification describes the service as it is and what its owner intends.

## 2. Non-goals

- Authentication
- Persistence

## 3. Users and situations

A client asks the service for a sum.

## 4. Requirements

${requirements.map(requirementSection).join('\n')}
## 5. Requirement index

${indexTable(requirements, { sixth, origins, raw })}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
${modules.map((m) => `| ${m.name} | \`${m.paths.join('`, `')}\` | ${areasOf(m.sensitive_areas)} |`).join('\n')}

**Protected paths**

- \`.surety/checks/\`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | the owner's test target | the post-deploy behaviour check passes against it |

- **Target:** \`local_service\`, target \`app\`.
- **Runtime and start command:** \`node server.mjs\`.
- **Port:** \`PORT\`.
- **Excluded from the artifact:** \`test/\`.
- **Required post-deploy behaviour check:** GET /sum?a=2&b=3 answers 200 {"sum": 5}.
- **Stable arguments:** the service does not change its process title or arguments.

## 8. Constraints

- Node's own modules only; no package.json.

## 9. Interfaces and data

HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data. The repository's CI names an environment \`${CI_ENVIRONMENT}\`, which Surety did not deploy.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-12 | Described from the existing code | Sean |
${changeLog.map((c) => `| ${c.version} | ${c.date} | ${c.change} | ${c.by} |`).join('\n')}

## 12. Claims and reality

${claimsTable(claims)}
`;
}

export const SPEC = retrofitSpecText();

// ---- the Architect's retrofit products (D6 §8.1 step 3) ---------------------------------------

export const ADR_KEY = 'ADR-001';
export const ARCHITECTURE_MD = `# Sums: architecture as it is

Two modules: \`lib\` (\`src/sum.mjs\`) and \`service\` (\`server.mjs\`, Node's own \`http\`). Reconstructed from the code.
`;
export const MODULES_JSON = {
  version: 1,
  modules: [
    { name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [{ name: 'sum', kind: 'module', path: 'src/sum.mjs', description: 'export const sum = (a, b) => number' }] },
    { name: 'service', paths: ['server.mjs'], sensitive_areas: [], interfaces: [{ name: 'sum-route', kind: 'http', path: '/sum', description: 'GET /sum?a&b answers {"sum": n}' }, { name: 'health', kind: 'http', path: '/health', description: 'GET /health answers {"ok": true}' }] },
  ],
  mapping_from_spec: [
    { spec_module: 'lib', to: ['lib'] },
    { spec_module: 'service', to: ['service'] },
  ],
};
// B.6 with the retrofit mark (D6 §8.1 step 3, §8.2).
export const ADR_001 = `---
key: ${ADR_KEY}
status: accepted
reconstructed: true
---

# ${ADR_KEY}: Node's own http, no dependency

## Context

Reconstructed from the code: the service imports nothing but Node's own modules.

## Decision

The service uses Node's own \`http\` module and no dependency.

## Consequences

Routing is a small switch on the path.
`;

// The conformance roadmap: phase 1 the confirmed set, phase 2 the owner's
// intended changes and the confirmed defects (D6 §8.1 step 3).
export const roadmapJson = ({ phase1 = ['R1', 'R2', 'R3'], phase2 = ['R4'] } = {}) => ({
  version: 1,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'conformance: the adopted code through the protected acceptance path to Alpha, unchanged', modules: ['lib', 'service'], requirement_ids: phase1, depends_on: [] },
    ...(phase2.length === 0 ? [] : [{ number: 2, goal: 'refuse a non-number', modules: ['service'], requirement_ids: phase2, depends_on: [1] }]),
  ],
});
export const ROADMAP_MD = '# Roadmap\n\n1. Conformance (R1, R2, R3).\n2. Refuse a non-number (R4).\n';

const criteriaOf = (keys) => REQUIREMENTS.filter((r) => keys.includes(r.key)).flatMap((r) => r.criteria.map((c) => c.id));

// The conformance stage (K11; B.5): no tasks, the confirmed set's criteria.
export const conformanceStage = ({ implements: keys = ['R1', 'R2', 'R3'], number = 1, ...over } = {}) => ({
  number,
  goal: 'conformance of the adopted code',
  tasks: [],
  modules: ['lib', 'service'],
  implements: keys,
  adrs: [ADR_KEY],
  depends_on: [],
  validation: { criteria: criteriaOf(keys), kinds: [...T1_KINDS], sensitive_areas: [] },
  integration_obligations: [],
  conformance: true,
  ...over,
});
// Phase 2's Builder stage (D6 §8.1 step 7).
export const DEFECT_STAGE = Object.freeze({ number: 2, goal: 'refuse a non-number', tasks: ['answer 400 when a or b is not a number'], modules: ['service'], implements: ['R4'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R4.1'], kinds: [...T1_KINDS], sensitive_areas: [] }, integration_obligations: ['server.mjs keeps its start command'] });

export function phasePlan(phase, { revision, spec_version = 1, architecture_version = 1, roadmap_version = 1, stages } = {}) {
  return { phase, prepared_against: { spec_version, architecture_version, roadmap_version, revision }, stages: stages ?? (phase === 1 ? [conformanceStage()] : [DEFECT_STAGE]), conformance: 'within_baseline' };
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

// The files the retrofit Architect session writes, as {path: text}; `over`
// replaces any (a null removes it).
export function retrofitArchitectFiles({ revision, stages, plan = phasePlan(1, { revision, stages }), roadmap = roadmapJson(), modules = MODULES_JSON, over = {} } = {}) {
  const files = {
    '.surety/architecture/architecture.md': ARCHITECTURE_MD,
    '.surety/architecture/modules.json': json(modules),
    [`.surety/adrs/${ADR_KEY}.md`]: ADR_001,
    '.surety/roadmap/roadmap.md': ROADMAP_MD,
    '.surety/roadmap/roadmap.json': json(roadmap),
    '.surety/phases/phase-1.md': '# Phase 1\n\n- Stage 1: conformance of the adopted code\n',
    '.surety/phases/phase-1.json': json(plan),
  };
  for (const [path, text] of Object.entries(over)) {
    if (text === null) delete files[path];
    else files[path] = typeof text === 'string' ? text : json(text);
  }
  return files;
}

// ---- the Verifier's conformance-phase authoring (D6 §8.1 step 4; §8.3; B.7) ---------------------

export const WRAPPER_PATH = '.surety/checks/wrapper.mjs';
const defs = (key) => `.surety/checks/defs/${key}.json`;
const GATES = ['stage', 'alpha_authorize'];

// A protected node:test file that runs the candidate's service as a child
// and judges what it answers (the Verifier's own logic, not the project's).
export const serviceCheck = (title, requests) => `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const ask = (port, path) => new Promise((resolve, reject) => {
  get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
});

test(${JSON.stringify(title)}, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let up = null;
    for (let i = 0; i < 50 && up === null; i++) { try { up = await ask(port, '/health'); } catch { await sleep(100); } }
    assert.ok(up, 'the service answered /health');
    for (const r of ${JSON.stringify(requests)}) {
      const got = await ask(port, r.path);
      assert.equal(got.status, r.status, r.path + ' status');
      if (r.body !== undefined) assert.deepEqual(JSON.parse(got.body), r.body, r.path + ' body');
    }
  } finally {
    child.kill('SIGKILL');
  }
});
`;

// The adopted test (D6 §8.3, B13): `test/sum.test.mjs` and the helper it
// imports, copied under the protected root with the import rewritten to the
// copy; the application imported as the subject under test.
export const ADOPTED_HELPER_COPY = `// Adopted from test/helpers/expect.mjs (copied; D6 §8.3).
import assert from 'node:assert/strict';

export const expectEqual = (actual, expected, label) => assert.deepEqual(actual, expected, label);
export const expectStatus = (got, status, label) => assert.equal(got.status, status, label + ' status');
`;
export const ADOPTED_SUM_TEST = `// Adopted from test/sum.test.mjs (copied; its helper copied beside it; D6 §8.3).
import { test } from 'node:test';

import { expectEqual } from './helpers/expect.mjs';
import { sum } from '../../../src/sum.mjs';

test('R1.1: sum adds two numbers', () => {
  expectEqual(sum(2, 3), 5, 'sum(2, 3)');
});
`;
export const ADOPTED = Object.freeze({
  from: ['test/sum.test.mjs', 'test/helpers/expect.mjs'],
  to: '.surety/checks/adopted/sum.test.mjs',
  criteria: ['R1.1'],
  dependency_boundary: [
    { path: 'test/helpers/expect.mjs', disposition: 'copied' },
    { path: 'src/sum.mjs', disposition: 'application' },
  ],
});

// The governed file of the first authoring: `node` the engine's own (Q9: the
// first phase's `check_commands` goes to the owner).
export const GOVERNED = governedText({
  protected_paths: ['.surety/checks/'],
  check_commands: { node: { path: process.execPath } },
  runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
});

// The phase-1 checks: the adopted R1.1; R2.1 and R3.1 by the Verifier's own
// logic; smoke; the developer check over the existing suite in place
// (covering nothing, counting toward no kind; D3 §2.9); the post-deploy
// behaviour check. `withR4` (M408 (i)): R4.1's check too, when R4 is confirmed
// into the conformance set.
export function authoringFiles({ withR4 = false, withoutR1 = false, extra = {} } = {}) {
  const files = {
    '.surety/checks/protected-policy.json': GOVERNED,
    [WRAPPER_PATH]: WRAPPER,
    '.surety/checks/adopted/helpers/expect.mjs': ADOPTED_HELPER_COPY,
    [ADOPTED.to]: ADOPTED_SUM_TEST,
    '.surety/checks/tests/sum-route.test.mjs': serviceCheck('R2.1: GET /sum?a=2&b=3 answers 200 {"sum": 5}', [{ path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } }]),
    '.surety/checks/tests/health.test.mjs': serviceCheck('R3.1: GET /health answers 200 {"ok": true}', [{ path: '/health', status: 200, body: { ok: true } }]),
    '.surety/checks/post-deploy/operation.mjs': POST_DEPLOY,
    [defs('accept-r1')]: definitionText('accept-r1', { inputs: [WRAPPER_PATH, ADOPTED.to, '.surety/checks/adopted/helpers/expect.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, ADOPTED.to], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
    [defs('accept-r2')]: definitionText('accept-r2', { inputs: [WRAPPER_PATH, '.surety/checks/tests/sum-route.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/sum-route.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.1'] } }),
    [defs('accept-r3')]: definitionText('accept-r3', { inputs: [WRAPPER_PATH, '.surety/checks/tests/health.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/health.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
    [defs('smoke')]: definitionText('smoke', { inputs: [], kind: 'smoke', command: ['node', '--check', 'server.mjs'], timeout_s: 60, gate_kinds: GATES }),
    [defs('suite')]: definitionText('suite', { inputs: [], kind: 'acceptance', origin: 'developer', command: ['node', '--test', 'test/'], timeout_s: 120, gate_kinds: GATES }),
    [defs('operation')]: definitionText('operation', { inputs: ['.surety/checks/post-deploy/operation.mjs'], kind: 'post_deploy_behavior', command: ['node', '.surety/checks/post-deploy/operation.mjs'], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
  };
  if (withR4) Object.assign(files, R4_CHECK);
  Object.assign(files, extra);
  if (withoutR1) for (const path of [ADOPTED.to, '.surety/checks/adopted/helpers/expect.mjs', defs('accept-r1')]) delete files[path];
  return files;
}
// The sensitive-area variant (M413 (f), a High in a sensitive area): the
// `service` module classified `secrets_credentials` (TPL §6, modules.json),
// the conformance stage validating the area with the floor's kind, and the
// floor's check covering it (D3 §4.4; SEAM.md §382).
export const SENSITIVE_AREA = 'secrets_credentials';
export const MODULES_SENSITIVE = Object.freeze(MODULES.map((m) => (m.name === 'service' ? { ...m, sensitive_areas: [SENSITIVE_AREA] } : m)));
export const MODULES_JSON_SENSITIVE = { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => (m.name === 'service' ? { ...m, sensitive_areas: [SENSITIVE_AREA] } : m)) };
export const FLOOR_CHECK = Object.freeze({
  [defs('floor')]: definitionText('floor', { inputs: [], kind: 'sensitivity_floor', command: ['node', '--check', 'server.mjs'], timeout_s: 60, gate_kinds: GATES, covers: { sensitive_areas: [SENSITIVE_AREA] } }),
});
export const sensitiveConformanceStage = () => {
  const stage = conformanceStage();
  return { ...stage, validation: { ...stage.validation, kinds: [...stage.validation.kinds, 'sensitivity_floor'], sensitive_areas: [SENSITIVE_AREA] } };
};

// R4.1's check (phase 2's authoring; or phase 1's when R4 is confirmed, M408 (i)).
export const R4_CHECK = Object.freeze({
  '.surety/checks/tests/refuse.test.mjs': serviceCheck('R4.1: GET /sum?a=x&b=3 answers 400', [{ path: '/sum?a=x&b=3', status: 400 }]),
  [defs('accept-r4')]: definitionText('accept-r4', { inputs: [WRAPPER_PATH, '.surety/checks/tests/refuse.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/refuse.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R4.1'] } }),
});

export const POST_DEPLOY = `// The specified user operation: GET /sum?a=2&b=3 through SURETY_TARGET_APP.
import { get } from 'node:http';

const base = process.env.SURETY_TARGET_APP;
if (!base) { console.log('OPERATION ' + JSON.stringify({ error: 'SURETY_TARGET_APP is not set' })); process.exit(2); }
const ask = (path) => new Promise((resolve) => {
  const req = get(new URL(path, base), { timeout: 15000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ path, status: res.statusCode, body })); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (err) => resolve({ path, status: null, error: err.code ?? err.message }));
});
const s = await ask('/sum?a=2&b=3');
console.log('OPERATION ' + JSON.stringify(s));
let ok = false;
try { ok = s.status === 200 && JSON.parse(s.body).sum === 5; } catch { ok = false; }
process.exit(ok ? 0 : 1);
`;

// The phase-authoring result (B.7, N04, B13), in the form slice 31's
// authoring uses (`proposal` with its rationale), with `adopted_tests` and
// the dependency boundary beside it.
export const authoringResult = ({ adopted = [ADOPTED] } = {}) => ({
  summary: 'The conformance phase checks: R1.1 adopted from the project\'s own test, R2.1 and R3.1 written, the smoke, the developer suite and the post-deploy check.',
  proposal: { rationale: 'The Verifier authors the conformance phase\'s checks, adopting the project\'s sum test with its helper.', requested_change_kind: 'unclassifiable' },
  adopted_tests: adopted,
});
