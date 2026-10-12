// The reference project of M5's first journey (BS5 §3, "the reference
// projects of the project lane"; E141 item 2: purpose-written for M5's
// shape, not fixture C; M5 plan §2.3; SEAM.md §342). Everything a scripted
// session or one-shot role writes into the workspace is text here, written
// by the test's scripts; nothing here is run by the test runner.
//
// The project, "Tally": a dependency-free Node HTTP service, T2, two phases
// of two stages, two modules, one specification change between the phases.
//   phase 1  stage 1  lib      R1  src/sum.mjs           sum(a, b)
//            stage 2  service  R2  server.mjs            GET /health, GET /sum?a&b (400 on a non-number)
//   phase 2  stage 3  lib      R3  src/tally.mjs         makeTally(): count(), total()
//            stage 4  service  R4  server.mjs            GET /stats: {"count": n}
//   CR-1 (between the phases): R2.1's text reworded (its ID kept) and R4.1's
//   statement sharpened, so the impact names a phase-1 check with a result
//   (invalidated, an obligation) and a phase-2 requirement (a replan).
//
// Forms: IBT's `yaml surety-identity` fence (D6 B.1; main 15209c4), TPL's
// B.2 forms (`### R<n>. <title>`, the statement paragraph, `**Sensitive
// areas:**`, criteria `- R<n>.<m> ...`), the five-column index (K10's sixth
// column is slice 32's), B.3 to B.6 for the Architect's machine files, and
// the sensitive areas in the engine's identifier form.

import { definitionText, governedText, nodeReadPaths } from '../checks/fixtures.mjs';
import { dirname } from 'node:path';
import { WRAPPER } from '../project/reference.mjs';

export const PROJECT_NAME = 'tally';
export const TIER = 'T2';

// ---- the idea (D6 §1 step 1; IBT) ---------------------------------------------------------

export const IDEA_PARAGRAPH = 'Tally: a small HTTP service for a workshop that adds two numbers and counts how many sums it served, so that a dashboard can show the day\'s activity. Dependency-free Node, one process, no database.\n';

export const identityBlock = ({ name = 'Tally', one_line = 'A dependency-free HTTP service that sums numbers and counts the sums it served, for a workshop dashboard.', users = ['the workshop organizer', 'the dashboard'], non_goals = ['authentication', 'persistence across restarts'], success_measures = ['/sum answers in under 50 ms', 'the count matches the requests made'], sensitive_areas = 'none', tier_recommendation = 'T2', environments = ['alpha'] } = {}) => {
  const list = (xs) => (xs.length === 0 ? '[]' : `\n${xs.map((x) => `  - ${x}`).join('\n')}`);
  const areas = Array.isArray(sensitive_areas) ? list(sensitive_areas) : sensitive_areas;
  return `\`\`\`yaml surety-identity\nname: ${name}\none_line: ${one_line}\nusers:${list(users)}\nnon_goals:${list(non_goals)}\nsuccess_measures:${list(success_measures)}\nsensitive_areas: ${areas}\ntier_recommendation: ${tier_recommendation}\nenvironments:${list(environments)}\n\`\`\`\n`;
};

// The owner's brief in IBT's form, with the identity block filled by the owner.
export const IDEA_BRIEF = `# Idea: Tally

**Date:** 2026-10-12
**Owner:** Sean

## The idea in one paragraph

${IDEA_PARAGRAPH}
## Who it is for

The workshop organizer, who wants a count of the sums the service served, and the dashboard that shows it.

## The problem, and what people do today

Nothing counts today; people guess.

## What success looks like

The count on the dashboard matches the requests made.

## First version

- GET /sum?a=2&b=3 answers {"sum": 5}
- GET /stats answers the count of sums served

## Deliberately out

- authentication
- persistence across restarts

## What already exists

Nothing.

## Constraints

- Node's own modules only; no package.json

## Sensitive areas

- [ ] authentication
- [ ] authorization
- [ ] payments and financial data
- [ ] personal data
- [ ] secrets and credential handling
- [ ] data migrations and destructive data operations
- [ ] irreversible external actions

## Where it runs

On the owner's machine as a user service (alpha).

## Risk tier, if you have a view

T2

## Open questions in my own head

- none

${identityBlock()}`;

// The idea record the Vision session writes (version 2): the brief rewritten
// into the project identity, closing with the identity block.
export const IDEA_RECORD = `# Tally

Tally is a dependency-free Node HTTP service for a workshop: it sums two numbers on request and counts the sums it has served, so a dashboard can show the day's activity. One process, no database, no authentication.

## Users

The workshop organizer and the dashboard.

## Non-goals

Authentication; persistence across restarts.

## Success

The count the dashboard shows matches the requests made; /sum answers in under 50 ms.

${identityBlock()}`;

// Identity blocks that do not parse (M402 (b)): an unknown key, a tier
// outside the three, an area outside the closed list.
export const BAD_IDENTITY = Object.freeze({
  unknown_key: { text: IDEA_RECORD.replace('tier_recommendation: T2', 'tier_recommendation: T2\nbudget: 5 USD'), names: 'budget' },
  tier: { text: IDEA_RECORD.replace('tier_recommendation: T2', 'tier_recommendation: T4'), names: 'tier_recommendation' },
  area: { text: IDEA_RECORD.replace('sensitive_areas: none', 'sensitive_areas:\n  - privacy'), names: 'privacy' },
});

// ---- the specification (D6 §1 step 3; TPL; B.2) ---------------------------------------------

export const REQUIREMENTS = Object.freeze([
  { key: 'R1', title: 'Sum two numbers', phase: 1, module: 'lib', statement: 'The library sums two numbers exactly, as a pure function with no state.', criteria: [{ id: 'R1.1', text: 'Given the numbers 2 and 3, when `sum(2, 3)` of `src/sum.mjs` is called, then it returns 5.' }] },
  {
    key: 'R2',
    title: 'Sum through the service',
    phase: 1,
    module: 'service',
    statement: 'A user sums two numbers through the service over HTTP, and a request that is not two numbers is refused.',
    criteria: [
      { id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with the JSON body {"sum": 5}.' },
      { id: 'R2.2', text: 'Given the service is running, when a client requests GET /sum?a=x&b=3, then it answers 400.' },
    ],
  },
  { key: 'R3', title: 'Count the sums', phase: 2, module: 'lib', statement: 'The library counts the sums served since the process started.', criteria: [{ id: 'R3.1', text: 'Given a fresh tally, when `count()` of `makeTally()` in `src/tally.mjs` is called three times, then `total()` returns 3.' }] },
  { key: 'R4', title: 'Stats through the service', phase: 2, module: 'service', statement: 'A user reads how many sums the service has served since it started.', criteria: [{ id: 'R4.1', text: 'Given the service has served two /sum requests since it started, when a client requests GET /stats, then it answers 200 with the JSON body {"count": 2}.' }] },
]);

// CR-1 (D6 §1 step 11): R2.1's criterion text reworded with its ID kept, and
// R4's statement sharpened (a `text_changed` requirement whose criteria are
// affected though every ID remains, B05).
export const CHANGE_REQUEST = `# Change request CR-1

Two clarifications, no new behaviour:

1. R2.1 should say the body is JSON with the content type application/json.
2. R4's statement should say the count is of successful /sum requests only (a 400 is not counted).
`;
export const REQUIREMENTS_V2 = Object.freeze(
  REQUIREMENTS.map((r) => {
    if (r.key === 'R2') return { ...r, criteria: [{ id: 'R2.1', text: 'Given the service is running, when a client requests GET /sum?a=2&b=3, then it answers 200 with content type application/json and the JSON body {"sum": 5}.' }, r.criteria[1]] };
    if (r.key === 'R4') return { ...r, statement: 'A user reads how many successful sums the service has served since it started; a refused request is not counted.' };
    return r;
  }),
);

export const MODULES = Object.freeze([
  { name: 'lib', paths: ['src/'], sensitive_areas: [] },
  { name: 'service', paths: ['server.mjs'], sensitive_areas: [] },
]);

const areasOf = (xs) => (xs.length === 0 ? 'none' : xs.join(', '));

// TPL §5, five columns (the sixth is K10's, slice 32).
export function indexTable(requirements) {
  const lines = ['| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|'];
  for (const r of requirements) lines.push(`| ${r.key} | ${r.title} | ${r.phase} | none | ${r.criteria.map((c) => c.id).join(', ')} |`);
  return lines.join('\n');
}

function requirementSection(r) {
  return [
    `### ${r.key}. ${r.title}`,
    '',
    r.statement,
    '',
    `**Rationale.** The workshop needs it.`,
    '',
    `**Sensitive areas:** none`,
    '',
    '**Acceptance criteria**',
    '',
    ...r.criteria.map((c) => `- ${c.id} ${c.text}`),
    '',
  ].join('\n');
}

// The whole specification in TPL's shape. `version` and `status` fill the
// header; `requirements` the §4 subsections; `index` the §5 rows (by default
// the same requirements, so the two agree).
export function specText({ version = 1, status = 'draft', requirements = REQUIREMENTS, index = requirements, tier = TIER, changeLog = [] } = {}) {
  return `# Tally

**Spec version:** ${version}
**Status:** ${status}
**Tier:** ${tier}
**Owner:** Sean

## 1. Purpose

Tally sums two numbers over HTTP for a workshop and counts the sums it served, so a dashboard can show the day's activity.

## 2. Non-goals

- Authentication
- Persistence across restarts

## 3. Users and situations

The workshop organizer reads the count on a dashboard during the day. The dashboard asks the service for its stats.

## 4. Requirements

${requirements.map(requirementSection).join('\n')}
## 5. Requirement index

${indexTable(index)}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
${MODULES.map((m) => `| ${m.name} | \`${m.paths.join('`, `')}\` | ${areasOf(m.sensitive_areas)} |`).join('\n')}

**Protected paths**

- \`.surety/checks/\`

## 7. Environments

| Environment | Purpose | Verified means |
|---|---|---|
| alpha | the owner's test target | the post-deploy behaviour check passes against it |

- **Target:** \`local_service\`, target \`app\`.
- **Runtime and start command:** \`node server.mjs\`.
- **Port:** \`PORT\`.
- **Excluded from the artifact:** none.
- **Required post-deploy behaviour check:** GET /sum?a=2&b=3 answers 200 {"sum": 5}.
- **Stable arguments:** the service does not change its process title or arguments.

## 8. Constraints

- Node's own modules only; no package.json.
- ES modules.

## 9. Interfaces and data

HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-12 | First approved version | Sean |
${changeLog.map((c) => `| ${c.version} | ${c.date} | ${c.change} | ${c.by} |`).join('\n')}
`;
}

export const SPEC = specText();
export const SPEC_V2 = specText({ version: 2, requirements: REQUIREMENTS_V2, changeLog: [{ version: 2, date: '2026-10-12', change: 'CR-1: R2.1 reworded; R4 sharpened', by: 'Sean' }] });

// The Spec Writer's first save (M401 (c), M402's neighbours): the index lists
// R2.2, which §4 does not have, so the engine names the row's criterion.
export const SPEC_DEFECTIVE = specText({ requirements: REQUIREMENTS.map((r) => (r.key === 'R2' ? { ...r, criteria: r.criteria.slice(0, 1) } : r)), index: REQUIREMENTS });
export const SPEC_DEFECT = Object.freeze({ criterion: 'R2.2', key: 'R2' });

// A specification whose index has a sensitive area outside the closed list
// (slice 31's parse depth, the driver's ruling 4): the row names `privacy`.
export const SPEC_BAD_AREA = SPEC.replace('| R1 | Sum two numbers | 1 | none |', '| R1 | Sum two numbers | 1 | privacy |');

// ---- the Architect's products (D6 §1 step 4; §3.3; B.3 to B.6) --------------------------------

export const ARCHITECTURE_MD = `# Tally: architecture

Two modules: \`lib\` (pure functions under \`src/\`) and \`service\` (\`server.mjs\`, Node's own \`http\`, one process, listening on 127.0.0.1:$PORT). The service calls the library; the library knows nothing of HTTP.

    client --HTTP--> server.mjs --import--> src/sum.mjs, src/tally.mjs
`;

export const MODULES_JSON = {
  version: 1,
  modules: [
    {
      name: 'lib',
      paths: ['src/'],
      sensitive_areas: [],
      interfaces: [
        { name: 'sum', kind: 'module', path: 'src/sum.mjs', description: 'export const sum = (a, b) => number' },
        { name: 'tally', kind: 'module', path: 'src/tally.mjs', description: 'export const makeTally = () => ({count(), total()})' },
      ],
    },
    {
      name: 'service',
      paths: ['server.mjs'],
      sensitive_areas: [],
      interfaces: [
        { name: 'sum-route', kind: 'http', path: '/sum', description: 'GET /sum?a&b answers {"sum": n}; 400 on a non-number' },
        { name: 'stats-route', kind: 'http', path: '/stats', description: 'GET /stats answers {"count": n}' },
      ],
    },
  ],
  mapping_from_spec: [
    { spec_module: 'lib', to: ['lib'] },
    { spec_module: 'service', to: ['service'] },
  ],
};

export const ADR_KEY = 'ADR-001';
export const adrText = ({ key = ADR_KEY, status = 'accepted', decision = 'The service uses Node\'s own `http` module and no dependency.' } = {}) => `---
key: ${key}
status: ${status}
---

# ${key}: Node's own http, no dependency

## Context

The workshop wants one process with nothing to install.

## Decision

${decision}

## Consequences

No framework; routing is a small switch on the path.
`;
export const ADR_001 = adrText();
export const ADR_001_REVISED = adrText({ decision: 'The service uses Node\'s own `http` module and no dependency; every answer is JSON with content type application/json.' });

export const ROADMAP_JSON = {
  version: 1,
  architecture_version: 1,
  phases: [
    { number: 1, goal: 'sum two numbers, in the library and through the service', modules: ['lib', 'service'], requirement_ids: ['R1', 'R2'], depends_on: [] },
    { number: 2, goal: 'count the sums and show the stats', modules: ['lib', 'service'], requirement_ids: ['R3', 'R4'], depends_on: [1] },
  ],
};
export const ROADMAP_MD = `# Roadmap

1. Sum two numbers (R1, R2): the library, then the service.
2. Count the sums and show the stats (R3, R4): the tally, then /stats.
`;

export const T2_KINDS = ['acceptance', 'smoke', 'integration', 'security_lint'];

// The stages of each phase (B.5). Stage n depends on n-1 within its phase
// (the default chain the Architect is told to use, D6 §6.4).
export const STAGES = Object.freeze({
  1: [
    { number: 1, goal: 'the sum library', tasks: ['write src/sum.mjs exporting sum(a, b)'], modules: ['lib'], implements: ['R1'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R1.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
    { number: 2, goal: 'the service', tasks: ['write server.mjs with GET /health and GET /sum using src/sum.mjs', 'answer 400 on a non-number'], modules: ['service'], implements: ['R2'], adrs: [ADR_KEY], depends_on: [1], validation: { criteria: ['R2.1', 'R2.2'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: ['server.mjs listens on 127.0.0.1:$PORT'] },
  ],
  2: [
    { number: 3, goal: 'the tally', tasks: ['write src/tally.mjs exporting makeTally()'], modules: ['lib'], implements: ['R3'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R3.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
    { number: 4, goal: 'the stats route', tasks: ['count successful /sum requests with the tally', 'answer GET /stats with {"count": n}'], modules: ['service'], implements: ['R4'], adrs: [ADR_KEY], depends_on: [3], validation: { criteria: ['R4.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: ['server.mjs keeps its start command'] },
  ],
});

// phase-<n>.json (B.5) prepared against the versions and head given.
export function phasePlan(phase, { spec_version = 1, architecture_version = 1, roadmap_version = 1, revision, stages = STAGES[phase], conformance = 'within_baseline', notes } = {}) {
  return { phase, prepared_against: { spec_version, architecture_version, roadmap_version, revision }, stages, conformance, ...(notes === undefined ? {} : { notes }) };
}
export const phasePlanMd = (phase) => `# Phase ${phase}\n\n${(STAGES[phase] ?? []).map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`;

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

// The files the Architect's first session writes (D6 §1 step 4), as
// {path: text}; `over` replaces any of them (a machine file that does not
// parse, M404) and a null removes one.
export function architectFiles({ revision, over = {}, plan = phasePlan(1, { revision }) } = {}) {
  const files = {
    '.surety/architecture/architecture.md': ARCHITECTURE_MD,
    '.surety/architecture/modules.json': json(MODULES_JSON),
    [`.surety/adrs/${ADR_KEY}.md`]: ADR_001,
    '.surety/roadmap/roadmap.md': ROADMAP_MD,
    '.surety/roadmap/roadmap.json': json(ROADMAP_JSON),
    '.surety/phases/phase-1.md': phasePlanMd(1),
    '.surety/phases/phase-1.json': json(plan),
  };
  for (const [path, text] of Object.entries(over)) {
    if (text === null) delete files[path];
    else files[path] = typeof text === 'string' ? text : json(text);
  }
  return files;
}

// Machine files that the engine refuses (M404 (b) to (d)), each with what
// the refusal must name.
export const BAD_ARCHITECTURE = Object.freeze({
  area_dropped: {
    // TPL §6 gives `service` no area, so the dropped area is planted: the
    // spec variant SPEC_SERVICE_SECRETS gives `service` secrets_credentials
    // and this map drops it from every module.
    files: { '.surety/architecture/modules.json': { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => ({ ...m, sensitive_areas: [] })) } },
    names: 'secrets_credentials',
  },
  area_moved: {
    files: { '.surety/architecture/modules.json': { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => ({ ...m, sensitive_areas: m.name === 'lib' ? ['secrets_credentials'] : [] })) } },
    // Phase 1's stages with the moved area validated where it now sits: stage
    // 1 touches `lib` (D6 §5.3 item 4, PLAN_AREA_UNVALIDATED; objection 059),
    // with the floor's kind its scope will need (D3 §4.4).
    stages: STAGES[1].map((s) => (s.modules.includes('lib') ? { ...s, validation: { ...s.validation, kinds: [...s.validation.kinds, 'sensitivity_floor'], sensitive_areas: ['secrets_credentials'] } } : s)),
  },
  unknown_field: { files: { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, owner: 'Sean' } }, names: 'owner' },
  requirement_twice: { files: { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: ROADMAP_JSON.phases.map((p) => (p.number === 2 ? { ...p, requirement_ids: ['R1', 'R3', 'R4'] } : p)) } }, names: 'R1' },
  requirement_omitted: { files: { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: ROADMAP_JSON.phases.map((p) => (p.number === 2 ? { ...p, requirement_ids: ['R3'] } : p)) } }, names: 'R4' },
  phase_self: { files: { '.surety/roadmap/roadmap.json': { ...ROADMAP_JSON, phases: ROADMAP_JSON.phases.map((p) => (p.number === 2 ? { ...p, depends_on: [2] } : p)) } }, names: '2' },
  adr_no_key: { files: { [`.surety/adrs/${ADR_KEY}.md`]: ADR_001.replace(`key: ${ADR_KEY}\n`, '') }, names: ADR_KEY },
  adr_status: { files: { [`.surety/adrs/${ADR_KEY}.md`]: ADR_001.replace('status: accepted', 'status: final') }, names: ADR_KEY },
});

// A specification whose `service` module carries secrets_credentials (TPL §6),
// so that M404 (b)'s dropped area is a TPL area.
export const SPEC_SERVICE_SECRETS = SPEC.replace('| service | `server.mjs` | none |', '| service | `server.mjs` | secrets_credentials |');
export const MODULES_JSON_SERVICE_SECRETS = { ...MODULES_JSON, modules: MODULES_JSON.modules.map((m) => (m.name === 'service' ? { ...m, sensitive_areas: ['secrets_credentials'] } : m)) };

// ---- what the Builders write (D6 §1 steps 6, 7, 10) ------------------------------------------

export const SUM_MJS = 'export const sum = (a, b) => a + b;\n';
export const TALLY_MJS = `export const makeTally = () => {
  let n = 0;
  return { count: () => ++n, total: () => n };
};
`;
const serverText = ({ stats = false } = {}) => `// Tally's service: Node's own http, nothing from npm (ADR-001).
import { createServer } from 'node:http';
import { sum } from './src/sum.mjs';
${stats ? "import { makeTally } from './src/tally.mjs';\n\nconst tally = makeTally();" : ''}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://service');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/sum') {
    const a = Number(url.searchParams.get('a'));
    const b = Number(url.searchParams.get('b'));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return send(res, 400, { error: 'a and b must be numbers' });
${stats ? '    tally.count();\n' : ''}    return send(res, 200, { sum: sum(a, b) });
  }
${stats ? "  if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, { count: tally.total() });\n" : ''}  return send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
export const SERVER_MJS = serverText();
export const SERVER_MJS_STATS = serverText({ stats: true });

// {stage number: {path: text}}: what each stage's Builder writes.
export const BUILDER_FILES = Object.freeze({
  1: { 'src/sum.mjs': SUM_MJS },
  2: { 'server.mjs': SERVER_MJS },
  3: { 'src/tally.mjs': TALLY_MJS },
  4: { 'server.mjs': SERVER_MJS_STATS },
});

// ---- what the Verifier's check authoring writes (D6 §1 step 5; §6.2) -----------------------------

const WRAPPER_PATH = '.surety/checks/wrapper.mjs';
const defs = (key) => `.surety/checks/defs/${key}.json`;

// A node:test file that runs the candidate's service as a child on a free
// loopback port, asks it, and judges only what the child observably answers
// (D3 Appendix B, §6 class C); `requests` is [{path, status, body?, header?}].
const serviceTest = (title, requests) => `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const ask = (port, path) => new Promise((resolve, reject) => {
  get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); }).on('error', reject);
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
      if (r.header) assert.match(got.headers['content-type'] ?? '', new RegExp(r.header), r.path + ' content type');
      if (r.body !== undefined) assert.deepEqual(JSON.parse(got.body), r.body, r.path + ' body');
    }
  } finally {
    child.kill('SIGKILL');
  }
});
`;

export const CHECK_PROGRAMS = Object.freeze({
  [WRAPPER_PATH]: WRAPPER,
  '.surety/checks/tests/sum.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../../../src/sum.mjs';

test('R1.1: sum(2, 3) returns 5', () => {
  assert.equal(sum(2, 3), 5);
});
`,
  '.surety/checks/tests/service.test.mjs': serviceTest('R2.1, R2.2: /sum answers 200 {"sum": 5} and 400 on a non-number', [
    { path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } },
    { path: '/sum?a=x&b=3', status: 400 },
  ]),
  // The integration kind (T2; D3 §4.3), one check per stage, each covering a
  // criterion of the requirement its stage implements (D3 §1.3, §4.2 (b);
  // objection 063). Stage 2's: the service and the library together, as a
  // child, its refusal of a non-number (R2.2) among what it asks.
  '.surety/checks/tests/integration.test.mjs': serviceTest('integration, R2.2: /health, /sum and its refusal through one process', [
    { path: '/health', status: 200, body: { ok: true } },
    { path: '/sum?a=1&b=1', status: 200, body: { sum: 2 } },
    { path: '/sum?a=x&b=3', status: 400 },
  ]),
  // Stage 1's: the library as a whole, loaded as a module in a process of its own.
  '.surety/checks/tests/integration-lib.test.mjs': `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('integration, R1.1: src/sum.mjs loads in a fresh process and sum(2, 3) is 5 there', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import { sum } from './src/sum.mjs'; console.log(JSON.stringify({ five: sum(2, 3), again: sum(sum(2, 3), 0) }));"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(out), { five: 5, again: 5 });
});
`,
  // The security_lint kind (T2): no eval, no child process, no network client in the tree.
  '.surety/checks/lint.mjs': `import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === '.surety' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\\.m?js$/.test(name)) files.push(path);
  }
};
walk('.');
const bad = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const pattern of [/\\beval\\(/, /child_process/, /new Function\\(/]) if (pattern.test(text)) bad.push(f + ': ' + pattern.source);
}
console.log('LINT ' + JSON.stringify({ files: files.length, bad }));
process.exit(bad.length === 0 ? 0 : 1);
`,
  '.surety/checks/post-deploy/operation.mjs': `// The specified user operation (TPL §7): GET /sum?a=2&b=3 through SURETY_TARGET_APP.
import { get } from 'node:http';

const base = process.env.SURETY_TARGET_APP;
if (!base) { console.log('REF-OPERATION ' + JSON.stringify({ error: 'SURETY_TARGET_APP is not set' })); process.exit(2); }
const ask = (path) => new Promise((resolve) => {
  const req = get(new URL(path, base), { timeout: 15000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ path, status: res.statusCode, body })); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (err) => resolve({ path, status: null, error: err.code ?? err.message }));
});
const results = [await ask('/health'), await ask('/sum?a=2&b=3')];
console.log('REF-OPERATION ' + JSON.stringify(results));
const s = results[1];
let ok = false;
try { ok = s.status === 200 && JSON.parse(s.body).sum === 5; } catch { ok = false; }
process.exit(ok ? 0 : 1);
`,
  // Phase 2. Stage 3's integration check: the tally with the library, in a process of its own.
  '.surety/checks/tests/integration-tally.test.mjs': `import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('integration, R3.1: src/tally.mjs beside src/sum.mjs in a fresh process: three counts make a total of 3', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import { sum } from './src/sum.mjs'; import { makeTally } from './src/tally.mjs'; const t = makeTally(); for (let i = 0; i < 3; i++) { sum(i, 1); t.count(); } console.log(JSON.stringify({ total: t.total() }));"], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.deepEqual(JSON.parse(out), { total: 3 });
});
`,
  // Stage 4's: the service's sums and its stats together.
  '.surety/checks/tests/integration-stats.test.mjs': serviceTest('integration, R4.1: two sums through the service, then /stats', [
    { path: '/health', status: 200, body: { ok: true } },
    { path: '/sum?a=2&b=3', status: 200 },
    { path: '/sum?a=1&b=1', status: 200 },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
  '.surety/checks/tests/tally.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTally } from '../../../src/tally.mjs';

test('R3.1: three counts make a total of 3', () => {
  const t = makeTally();
  t.count(); t.count(); t.count();
  assert.equal(t.total(), 3);
});
`,
  '.surety/checks/tests/stats.test.mjs': serviceTest('R4.1: two sums, then /stats answers {"count": 2}', [
    { path: '/sum?a=1&b=2', status: 200 },
    { path: '/sum?a=2&b=2', status: 200 },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
  // The phase-only check (M401's "a phase-only check"; K5): every service test
  // again on the phase's candidate, listed for the `phase` gate alone.
  '.surety/checks/tests/phase-regression.test.mjs': serviceTest('phase, R4.1: /sum, its refusal and /stats together on the phase candidate', [
    { path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } },
    { path: '/sum?a=x&b=3', status: 400 },
    { path: '/sum?a=1&b=1', status: 200, body: { sum: 2 } },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
});

// The governed file the first phase's authoring writes: `node` the engine's
// own, which is what makes the proposal `unclassifiable` (Q9).
export const GOVERNED = governedText({
  protected_paths: ['.surety/checks/'],
  check_commands: { node: { path: process.execPath } },
  runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
});

const GATES = ['stage', 'alpha_authorize'];
// The check definitions per phase: {path: text}. Phase 1 covers R1.1, R2.1,
// R2.2 with the T2 kinds (an integration check per stage) and the post-deploy
// behaviour check; phase 2 adds R3.1, R4.1, their integration checks and the
// phase-only check. Every acceptance-origin check of a covering kind names a
// criterion (D3 §1.3; objection 063). Every check declares its `inputs`, the
// protected files it reads (its program, the wrapper it runs under), so a
// later phase's new files lie outside them and its authoring is a tightening
// (D3 §3.1: "declared inputs are what make the remaining tightenings
// provable"; D6 §1 step 10; objection 064). smoke reads no protected file.
export const CHECK_DEFS = Object.freeze({
  1: {
    [defs('accept-r1')]: definitionText('accept-r1', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/sum.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/sum.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
    [defs('accept-r2')]: definitionText('accept-r2', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/service.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/service.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.1', 'R2.2'] } }),
    // smoke covers nothing, so every stage's scope requires it (D3 §4.2 (a)): it reads the one file stage 1 already has.
    [defs('smoke')]: definitionText('smoke', { inputs: [], kind: 'smoke', command: ['node', '--check', 'src/sum.mjs'], timeout_s: 60, gate_kinds: GATES }),
    [defs('integration-lib')]: definitionText('integration-lib', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/integration-lib.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-lib.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
    [defs('integration')]: definitionText('integration', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/integration.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.2'] } }),
    [defs('lint')]: definitionText('lint', { inputs: ['.surety/checks/lint.mjs'], kind: 'security_lint', command: ['node', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: GATES }),
    [defs('operation')]: definitionText('operation', { inputs: ['.surety/checks/post-deploy/operation.mjs'], kind: 'post_deploy_behavior', command: ['node', '.surety/checks/post-deploy/operation.mjs'], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
  },
  2: {
    [defs('accept-r3')]: definitionText('accept-r3', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/tally.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/tally.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
    [defs('accept-r4')]: definitionText('accept-r4', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/stats.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/stats.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R4.1'] } }),
    [defs('integration-tally')]: definitionText('integration-tally', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/integration-tally.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-tally.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
    [defs('integration-stats')]: definitionText('integration-stats', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/integration-stats.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-stats.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R4.1'] } }),
    // The phase-only check (gate_kinds phase alone): acceptance-origin, so it names a criterion of the phase's own requirements (D3 §1.3, §4.2 (b)).
    [defs('phase-regression')]: definitionText('phase-regression', { inputs: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/phase-regression.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/phase-regression.test.mjs'], timeout_s: 120, gate_kinds: ['phase'], covers: { criteria: ['R4.1'] } }),
  },
});

const PHASE_PROGRAMS = Object.freeze({
  1: ['.surety/checks/wrapper.mjs', '.surety/checks/tests/sum.test.mjs', '.surety/checks/tests/service.test.mjs', '.surety/checks/tests/integration-lib.test.mjs', '.surety/checks/tests/integration.test.mjs', '.surety/checks/lint.mjs', '.surety/checks/post-deploy/operation.mjs'],
  2: ['.surety/checks/tests/tally.test.mjs', '.surety/checks/tests/stats.test.mjs', '.surety/checks/tests/integration-tally.test.mjs', '.surety/checks/tests/integration-stats.test.mjs', '.surety/checks/tests/phase-regression.test.mjs'],
});

// The files the phase's check authoring writes under the protected root
// (the governed file in phase 1 only), as {path: text}.
export function authoringFiles(phase) {
  const files = { ...CHECK_DEFS[phase] };
  for (const path of PHASE_PROGRAMS[phase]) files[path] = CHECK_PROGRAMS[path];
  if (phase === 1) files['.surety/checks/protected-policy.json'] = GOVERNED;
  return files;
}

// The check keys each phase's authoring adds, and the criteria each covers.
export const EXPECTED_CHECKS = Object.freeze({
  1: { 'accept-r1': ['R1.1'], 'accept-r2': ['R2.1', 'R2.2'], smoke: [], 'integration-lib': ['R1.1'], integration: ['R2.2'], lint: [], operation: [] },
  2: { 'accept-r3': ['R3.1'], 'accept-r4': ['R4.1'], 'integration-tally': ['R3.1'], 'integration-stats': ['R4.1'], 'phase-regression': ['R4.1'] },
});

// The correction the Verifier proposes for CR-1 (check_correction work,
// D6 §4.5): accept-r2's test now reads the content type R2.1 names.
export const CORRECTED_SERVICE_TEST = serviceTest('R2.1, R2.2: /sum answers 200 application/json {"sum": 5} and 400 on a non-number', [
  { path: '/sum?a=2&b=3', status: 200, body: { sum: 5 }, header: 'application/json' },
  { path: '/sum?a=x&b=3', status: 400 },
]);

// The rest of CR-1's correction (objection 070): R4's statement is
// sharpened (`text_changed`), so D6 §4.4 lists R4.1's checks beside
// accept-r2's, and the one correction rewrites each one's test so it reads
// the sharpened statement: a refused /sum among the sums, and the count
// still that of the successful ones.
export const CORRECTED_R4_TESTS = Object.freeze({
  '.surety/checks/tests/stats.test.mjs': serviceTest('R4.1 (CR-1): two successful sums and a refused one, then /stats answers {"count": 2}', [
    { path: '/sum?a=1&b=2', status: 200 },
    { path: '/sum?a=x&b=2', status: 400 },
    { path: '/sum?a=2&b=2', status: 200 },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
  '.surety/checks/tests/integration-stats.test.mjs': serviceTest('integration, R4.1 (CR-1): two sums and a refused one through the service, then /stats', [
    { path: '/health', status: 200, body: { ok: true } },
    { path: '/sum?a=2&b=3', status: 200 },
    { path: '/sum?a=2&b=y', status: 400 },
    { path: '/sum?a=1&b=1', status: 200 },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
  '.surety/checks/tests/phase-regression.test.mjs': serviceTest('phase, R4.1 (CR-1): /sum, two refusals and /stats together on the phase candidate; refusals are not counted', [
    { path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } },
    { path: '/sum?a=x&b=3', status: 400 },
    { path: '/sum?a=1&b=1', status: 200, body: { sum: 2 } },
    { path: '/sum?a=1&b=z', status: 400 },
    { path: '/stats', status: 200, body: { count: 2 } },
  ]),
});
