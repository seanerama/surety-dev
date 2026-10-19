// The design journey's reference project (BS6 §8; M6 plan §2.3; SEAM.md
// §§480 to 489). Everything a scripted session or one-shot role writes is
// text here, written by the test's scripts; nothing here is run by the test
// runner, and nothing the Designer writes is run by anyone (BS6 §4.1 rule 21).
//
// The project, "Pantry": T2, `**Targets:** web, android`, `**Cross-platform:**
// yes`; one `api` module and two `ui` modules (web under `html_css`, `android`
// under `react_native`); two interfaces with shapes, two declared errors and
// one platform permission; one phase of three stages:
//   stage 1  api     R1  server.mjs        GET/POST /api/items; serves web/ at / and /web/*
//   stage 2  web     R2  web/              the page (UI stage, target web)
//   stage 3  mobile  R3  mobile/           the React Native app (UI stage, target android; never run)
// The design (written by the scripted Designer from the inventory it is
// given, as a real one would): one flow, one screen per target (S1 web, S2
// android), a logo proposal (`assets/logo/full.svg`), three design criteria
// (`tokens_only` on R2, `asset_parity` on R2 and R3) and one human test per
// target. The owner holds the logo at the first approval and approves it
// later by an asset-only approval.
//
// The design files are built from what the engine derived (inventory.json,
// the placeholder asset manifest), never from a hard-coded copy of them:
// their forms are D7 Appendix B's exactly, and their values are the
// inventory's (SEAM.md §484).

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { definitionText, governedText, nodeReadPaths } from '../checks/fixtures.mjs';
import { identityBlock } from '../journey/reference.mjs';
import { WRAPPER } from '../project/reference.mjs';

export const PROJECT_NAME = 'pantry';
export const TIER = 'T2';
export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

// ---- the idea (D6 §1 step 1) --------------------------------------------------------------

const PANTRY_IDENTITY = identityBlock({
  name: 'Pantry',
  one_line: 'A small household pantry list, in the browser and on Android, with a JSON API.',
  users: ['the household', 'the Android app'],
  non_goals: ['accounts and sharing', 'persistence across restarts'],
  success_measures: ['an item added on one target is listed on the other', 'the list answers in under 50 ms'],
  environments: ['alpha'],
});

export const IDEA_BRIEF = `# Idea: Pantry

**Date:** 2026-10-16
**Owner:** Sean

## The idea in one paragraph

Pantry keeps a household's pantry list: what is in the cupboard and how many of each. A small JSON API holds the list; a web page and an Android app show it and add to it, sharing one look and one workflow.

## Who it is for

The household, on a laptop and on a phone.

## First version

- GET /api/items lists the items; POST /api/items adds one
- a web page and an Android app that list and add items

## Deliberately out

- accounts and sharing
- persistence across restarts

## Constraints

- Node's own modules only for the API; no package.json

## Where it runs

On the owner's machine as a user service (alpha).

## Risk tier, if you have a view

T2

${PANTRY_IDENTITY}`;

export const IDEA_RECORD = `# Pantry

Pantry keeps a household's pantry list. A dependency-free Node API holds it in memory; a web page and an Android app list the items and add to them, with one shared look and workflow.

## Users

The household.

## Non-goals

Accounts and sharing; persistence across restarts.

${PANTRY_IDENTITY}`;

// ---- the specification (TPL; B.2 with G3's header lines and mark) -------------------------

export const TARGETS_LINE = '**Targets:** web, android';
export const CROSS_PLATFORM_LINE = '**Cross-platform:** yes';

export const REQUIREMENTS = Object.freeze([
  {
    key: 'R1',
    title: 'The pantry API',
    phase: 1,
    statement: 'The service lists the pantry\'s items and adds an item, over HTTP with JSON bodies.',
    criteria: [
      { id: 'R1.1', text: 'Given the service is running, when a client requests GET /api/items, then it answers 200 with the JSON body {"items": []}.' },
      { id: 'R1.2', text: 'Given the service is running, when a client posts {"name": "rice", "quantity": 2} to /api/items, then it answers 201 and GET /api/items lists rice with quantity 2.' },
    ],
  },
  {
    key: 'R2',
    title: 'The pantry in the browser',
    phase: 1,
    surface: 'ui (web)',
    statement: 'A user sees the pantry\'s items and adds one in a web browser.',
    criteria: [{ id: 'R2.1', text: 'Given the service is running, when a client requests GET /, then it answers 200 with an HTML page that links web/app.css.' }],
  },
  {
    key: 'R3',
    title: 'The pantry on Android',
    phase: 1,
    surface: 'ui (android)',
    statement: 'A user sees the pantry\'s items and adds one in the Android app.',
    criteria: [{ id: 'R3.1', text: 'Given the mobile module, when mobile/App.js is read, then it exports a default function component named App.' }],
  },
]);

export const SPEC_MODULES = Object.freeze([
  { name: 'api', paths: ['server.mjs'] },
  { name: 'web', paths: ['web/'] },
  { name: 'mobile', paths: ['mobile/'] },
]);

function requirementSection(r) {
  const out = [`### ${r.key}. ${r.title}`, '', r.statement, ''];
  if (r.surface) out.push(`**Surface:** ${r.surface}`, '');
  out.push('**Rationale.** The household needs it.', '', '**Sensitive areas:** none', '');
  if (r.human_test) out.push('**Human test.**', '', r.human_test, '');
  else out.push('**Acceptance criteria**', '', ...r.criteria.map((c) => `- ${c.id} ${c.text}`), '');
  return out.join('\n');
}

export function indexTable(requirements) {
  const lines = ['| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|'];
  for (const r of requirements) lines.push(`| ${r.key} | ${r.title} | ${r.phase} | none | ${r.criteria.map((c) => c.id).join(', ')} |`);
  return lines.join('\n');
}

// The specification in TPL's shape. `targets` and `crossPlatform` are the
// header lines (null leaves a line out); `modules` the §6 rows.
export function specText({ version = 1, requirements = REQUIREMENTS, index = requirements, targets = TARGETS_LINE, crossPlatform = CROSS_PLATFORM_LINE, modules = SPEC_MODULES, changeLog = [] } = {}) {
  const header = ['# Pantry', '', `**Spec version:** ${version}`, '**Status:** draft', `**Tier:** ${TIER}`, '**Owner:** Sean'];
  if (targets) header.push(targets);
  if (crossPlatform) header.push(crossPlatform);
  return `${header.join('\n')}

## 1. Purpose

Pantry keeps a household's pantry list, in the browser and on Android, over a small JSON API.

## 2. Non-goals

- Accounts and sharing
- Persistence across restarts

## 3. Users and situations

The household adds what it bought and reads what is left, on a laptop or a phone.

## 4. Requirements

${requirements.map(requirementSection).join('\n')}
## 5. Requirement index

${indexTable(index)}

## 6. Modules and protected paths

| Module | Paths | Sensitive areas |
|---|---|---|
${modules.map((m) => `| ${m.name} | \`${m.paths.join('`, `')}\` | none |`).join('\n')}

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
- **Required post-deploy behaviour check:** GET /api/items answers 200.
- **Stable arguments:** the service does not change its process title or arguments.

## 8. Constraints

- Node's own modules only for the API; no package.json.

## 9. Interfaces and data

HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data.

## 10. Open questions

None.

## 11. Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1 | 2026-10-16 | First approved version | Sean |
${changeLog.map((c) => `| ${c.version} | ${c.date} | ${c.change} | ${c.by} |`).join('\n')}
`;
}

export const SPEC = specText();

// ---- the Architect's products (B.3 as G1 extends it; B.4 to B.6) -------------------------

const NAME = { type: 'string', minLength: 1, maxLength: 40 };
const QUANTITY = { type: 'integer', minimum: 0, maximum: 99, unit: 'pcs' };
export const ITEM = { type: 'object', properties: { name: NAME, quantity: QUANTITY }, required: ['name', 'quantity'] };

export const INTERFACES = Object.freeze({
  list: {
    name: 'list-items',
    kind: 'http',
    path: '/api/items',
    description: 'GET /api/items answers {"items": [...]}',
    consumed_by: ['web', 'mobile'],
    request: { type: 'null' },
    response: { type: 'object', properties: { items: { type: 'array', collection: true, items: ITEM } }, required: ['items'] },
    errors: [],
  },
  add: {
    name: 'add-item',
    kind: 'http',
    path: '/api/items',
    description: 'POST /api/items {"name", "quantity"} adds an item and answers it',
    consumed_by: ['web', 'mobile'],
    request: ITEM,
    response: ITEM,
    errors: [
      { code: 'name_taken', when: 'an item of that name is already listed' },
      { code: 'invalid_item', when: 'the body is not an item within its bounds' },
    ],
  },
  // An interface no `ui` module consumes or exposes (M504 (h)).
  health: { name: 'health', kind: 'http', path: '/health', description: 'GET /health answers {"ok": true}', consumed_by: [] },
});

export const MODULES_JSON = {
  version: 1,
  modules: [
    { name: 'api', surface: 'api', paths: ['server.mjs'], sensitive_areas: [], interfaces: [INTERFACES.list, INTERFACES.add, INTERFACES.health] },
    { name: 'web', surface: 'ui', paths: ['web/'], sensitive_areas: [], targets: [{ target: 'web', ui_technology: 'html_css' }], interfaces: [] },
    {
      name: 'mobile',
      surface: 'ui',
      paths: ['mobile/'],
      sensitive_areas: [],
      targets: [{ target: 'android', ui_technology: 'react_native', form_factors: ['phone'] }],
      platform_permissions: [{ target: 'android', permission: 'notifications', why: 'to remind the household when an item runs low' }],
      // The Architect's declared binding (G1; B.17): where the effective logo goes on Android.
      asset_paths: [{ slot: 'logo', variant: 'full', target: 'android', path: 'mobile/assets/logo.svg' }],
      interfaces: [],
    },
  ],
  mapping_from_spec: [
    { spec_module: 'api', to: ['api'] },
    { spec_module: 'web', to: ['web'] },
    { spec_module: 'mobile', to: ['mobile'] },
  ],
};

// Interfaces a `ui` module EXPOSES (no consumed_by from a ui module), as M535's
// Architect declared them (finding F5; Sean's ruling 2026-10-19, errata
// E169): `page` and `api_base_url` with no request, response or errors (the
// inventory's `shape_known: false`); `design_tokens` with request and
// response and no errors; `simulation` with all three.
export const EXPOSED = Object.freeze({
  page: Object.freeze({ name: 'page', kind: 'file', path: 'web/index.html', description: 'the web page the API serves' }),
  apiBaseUrl: Object.freeze({ name: 'api_base_url', kind: 'module', path: 'mobile/config.js', description: 'the API base URL the app reads' }),
  designTokens: Object.freeze({ name: 'design_tokens', kind: 'file', path: 'web/tokens.css', description: 'the tokens the web page reads', request: { type: 'null' }, response: { type: 'string' } }),
  simulation: Object.freeze({ name: 'simulation', kind: 'file', path: 'mobile/simulation.html', description: 'the simulated Android preview', request: { type: 'null' }, response: { type: 'string' }, errors: [] }),
});
// Pantry's map with `exposed` ({module: [interface]}) appended to each named
// `ui` module's interfaces.
export function modulesExposing(exposed) {
  const m = structuredClone(MODULES_JSON);
  for (const [name, list] of Object.entries(exposed)) m.modules.find((x) => x.name === name).interfaces.push(...structuredClone(list));
  return m;
}

export const ARCHITECTURE_MD =`# Pantry: architecture

\`api\` (\`server.mjs\`, Node's own \`http\`) holds the list in memory and serves the web module's files; \`web\` is a static page in HTML and CSS; \`mobile\` is a React Native app (source only in M6).
`;
export const ADR_KEY = 'ADR-001';
export const ADR_001 = `---
key: ${ADR_KEY}
status: accepted
---

# ${ADR_KEY}: one API, two UI technologies

## Context

The household uses a laptop and an Android phone.

## Decision

The API is Node's own \`http\`; the web UI is HTML and CSS (\`html_css\`) served by the API; the Android UI is React Native (\`react_native\`).

## Consequences

The web page reads tokens.css; the Android app reads the neutral tokens.json.
`;

export const T2_KINDS = ['acceptance', 'smoke', 'integration', 'security_lint'];
export const STAGES = Object.freeze([
  { number: 1, goal: 'the pantry API', tasks: ['write server.mjs: GET and POST /api/items, GET /health, and the web module\'s files at / and /web/'], modules: ['api'], implements: ['R1'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R1.1', 'R1.2'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: ['server.mjs listens on 127.0.0.1:$PORT'] },
  { number: 2, goal: 'the web page', tasks: ['write web/index.html and web/app.css from the approved design'], modules: ['web'], implements: ['R2'], adrs: [ADR_KEY], depends_on: [1], validation: { criteria: ['R2.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
  { number: 3, goal: 'the Android app', tasks: ['write mobile/App.js from the approved design'], modules: ['mobile'], implements: ['R3'], adrs: [ADR_KEY], depends_on: [1], validation: { criteria: ['R3.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
]);

export const ROADMAP_JSON = { version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'the pantry on the web and on Android', modules: ['api', 'web', 'mobile'], requirement_ids: ['R1', 'R2', 'R3'], depends_on: [] }] };

export const phasePlan = (phase, { spec_version = 1, architecture_version = 1, roadmap_version = 1, revision, stages = STAGES } = {}) => ({ phase, prepared_against: { spec_version, architecture_version, roadmap_version, revision }, stages, conformance: 'within_baseline' });
export const phasePlanMd = (stages = STAGES) => `# Phase 1\n\n${stages.map((s) => `- Stage ${s.number}: ${s.goal}`).join('\n')}\n`;

// The Architect's files ({path: text}); `stages` are phase 1's; `over`
// replaces any (an object is written as JSON) and a null removes one.
export function architectFiles({ revision, over = {}, modules = MODULES_JSON, roadmap = ROADMAP_JSON, stages = STAGES } = {}) {
  const files = {
    '.surety/architecture/architecture.md': ARCHITECTURE_MD,
    '.surety/architecture/modules.json': json(modules),
    [`.surety/adrs/${ADR_KEY}.md`]: ADR_001,
    '.surety/roadmap/roadmap.md': '# Roadmap\n\n1. The pantry on the web and on Android.\n',
    '.surety/roadmap/roadmap.json': json(roadmap),
    '.surety/phases/phase-1.md': phasePlanMd(stages),
    '.surety/phases/phase-1.json': json(phasePlan(1, { revision, stages })),
  };
  for (const [path, text] of Object.entries(over)) {
    if (text === null) delete files[path];
    else files[path] = typeof text === 'string' ? text : json(text);
  }
  return files;
}

// ---- what the Builders write (D6 §1 steps 6, 7; D7 §8.4) -------------------------------

export const SERVER_MJS = `// Pantry's API: Node's own http, nothing from npm (ADR-001).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const WEB = new URL('./web/', import.meta.url);
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json' };
const items = [];
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const file = async (res, rel) => {
  if (rel.includes('..')) return send(res, 404, { error: 'not found' });
  try {
    const body = await readFile(new URL(rel, WEB));
    res.writeHead(200, { 'content-type': TYPES[rel.split('.').pop()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
};
const valid = (v) => typeof v?.name === 'string' && v.name.length >= 1 && v.name.length <= 40 && Number.isInteger(v.quantity) && v.quantity >= 0 && v.quantity <= 99;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://pantry');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (url.pathname === '/api/items' && req.method === 'GET') return send(res, 200, { items });
  if (url.pathname === '/api/items' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let v = null;
      try {
        v = JSON.parse(body);
      } catch {
        v = null;
      }
      if (!valid(v)) return send(res, 400, { code: 'invalid_item' });
      if (items.some((i) => i.name === v.name)) return send(res, 409, { code: 'name_taken' });
      items.push({ name: v.name, quantity: v.quantity });
      return send(res, 201, { name: v.name, quantity: v.quantity });
    });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/') return file(res, 'index.html');
  if (req.method === 'GET' && url.pathname.startsWith('/web/')) return file(res, url.pathname.slice('/web/'.length));
  return send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pantry</title>
<link rel="stylesheet" href="/web/tokens.css">
<link rel="stylesheet" href="/web/app.css">
</head>
<body>
<header><img class="logo" src="/web/assets/logo.svg" alt="Pantry"></header>
<main id="S1">
<p class="empty" data-state="empty">Nothing in the pantry yet.</p>
<ul class="items" data-state="ok"></ul>
<form class="add">
<label for="name">Item name</label><input id="name" name="name" maxlength="40" required>
<label for="quantity">Quantity (pcs)</label><input id="quantity" name="quantity" type="number" min="0" max="99" required>
<button type="submit">Add</button>
</form>
</main>
</body>
</html>
`;
// Every colour, size and spacing a custom property of tokens.css (the `tokens_only` criterion).
export const APP_CSS = `body { color: var(--color-text-primary); background: var(--color-surface-base); font-size: var(--type-body); margin: var(--space-md); }
.logo { border-radius: var(--radius-sm); }
.add button { background: var(--color-accent); color: var(--color-surface-base); transition: opacity var(--duration-fast); }
@media (prefers-reduced-motion: reduce) { .add button { transition: none; } }
`;
export const APP_JS = `import React from 'react';
import { FlatList, Image, Text, TextInput, View } from 'react-native';

// Never run in M6: the Android target's source, read by its checks only.
export default function App() {
  return null;
}
`;

// Where the Builders place the effective logo (B.17 bindings).
export const WEB_LOGO_PATH = 'web/assets/logo.svg';
export const ANDROID_LOGO_PATH = 'mobile/assets/logo.svg';
// The UI Builder's package layout (SEAM.md §482): the effective file of
// slot `logo`, variant `full` (an SVG), and the generated CSS binding.
export const PACKAGE_LOGO = 'design/assets/logo/full.svg';
export const PACKAGE_TOKENS_CSS = 'design/tokens.css';

export const bindingOf = (target, path, form = 'copy') => ({ slot: 'logo', variant: 'full', target, path, form });

// ---- the checks the Verifier's phase-1 authoring writes ----------------------------------

const WRAPPER_PATH = '.surety/checks/wrapper.mjs';
const defs = (key) => `.surety/checks/defs/${key}.json`;
const GATES = ['stage', 'alpha_authorize'];

// A node:test file that starts the candidate's server as a child on a free
// loopback port and makes `requests` ([{method?, path, body?, status, json?, header?, includes?}]).
const serviceTest = (title, requests) => `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const ask = (port, r) => new Promise((resolve, reject) => {
  const data = r.body === undefined ? null : Buffer.from(JSON.stringify(r.body));
  const req = request({ host: '127.0.0.1', port, path: r.path, method: r.method ?? 'GET', timeout: 5000, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
  req.on('error', reject);
  req.end(data ?? undefined);
});

test(${JSON.stringify(title)}, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let up = null;
    for (let i = 0; i < 50 && up === null; i++) { try { up = await ask(port, { path: '/health' }); } catch { await sleep(100); } }
    assert.ok(up, 'the service answered /health');
    for (const r of ${JSON.stringify(requests)}) {
      const got = await ask(port, r);
      assert.equal(got.status, r.status, r.path + ' status');
      if (r.header) assert.match(got.headers['content-type'] ?? '', new RegExp(r.header), r.path + ' content type');
      if (r.json !== undefined) assert.deepEqual(JSON.parse(got.body), r.json, r.path + ' body');
      if (r.includes !== undefined) assert.ok(got.body.includes(r.includes), r.path + ' body includes ' + r.includes);
    }
  } finally {
    child.kill('SIGKILL');
  }
});
`;

const fileTest = (title, path, pattern) => `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test(${JSON.stringify(title)}, () => {
  const text = readFileSync(${JSON.stringify(path)}, 'utf8');
  assert.match(text, new RegExp(${JSON.stringify(pattern)}));
});
`;

export const CHECK_PROGRAMS = Object.freeze({
  [WRAPPER_PATH]: WRAPPER,
  '.surety/checks/tests/api.test.mjs': serviceTest('R1.1, R1.2: the list, an item added, the list again', [
    { path: '/api/items', status: 200, json: { items: [] } },
    { method: 'POST', path: '/api/items', body: { name: 'rice', quantity: 2 }, status: 201, json: { name: 'rice', quantity: 2 } },
    { path: '/api/items', status: 200, json: { items: [{ name: 'rice', quantity: 2 }] } },
  ]),
  '.surety/checks/tests/integration-api.test.mjs': serviceTest('integration, R1.1: /health and the list through one process, the declared errors', [
    { path: '/health', status: 200, json: { ok: true } },
    { path: '/api/items', status: 200, json: { items: [] } },
    { method: 'POST', path: '/api/items', body: { name: '', quantity: 1 }, status: 400, json: { code: 'invalid_item' } },
  ]),
  '.surety/checks/tests/web.test.mjs': serviceTest('R2.1: GET / answers an HTML page linking web/app.css', [{ path: '/', status: 200, header: 'text/html', includes: 'web/app.css' }]),
  '.surety/checks/tests/integration-web.test.mjs': serviceTest('integration, R2.1: the page and its stylesheet through the API', [
    { path: '/', status: 200, header: 'text/html', includes: 'web/app.css' },
    { path: '/web/app.css', status: 200, header: 'text/css' },
  ]),
  '.surety/checks/tests/mobile.test.mjs': fileTest('R3.1: mobile/App.js exports a default function component App', 'mobile/App.js', 'export default function App\\b'),
  '.surety/checks/tests/integration-mobile.test.mjs': fileTest('integration, R3.1: the app module names react-native and exports App', 'mobile/App.js', "from 'react-native'[\\s\\S]*export default function App\\b"),
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
  for (const pattern of [/\\beval\\(/, /new Function\\(/]) if (pattern.test(text)) bad.push(f + ': ' + pattern.source);
}
console.log('LINT ' + JSON.stringify({ files: files.length, bad }));
process.exit(bad.length === 0 ? 0 : 1);
`,
  '.surety/checks/post-deploy/operation.mjs': `// The specified user operation (TPL §7): GET /api/items through SURETY_TARGET_APP.
import { get } from 'node:http';

const base = process.env.SURETY_TARGET_APP;
if (!base) { console.log('REF-OPERATION ' + JSON.stringify({ error: 'SURETY_TARGET_APP is not set' })); process.exit(2); }
const ask = (path) => new Promise((resolve) => {
  const req = get(new URL(path, base), { timeout: 15000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ path, status: res.statusCode, body })); });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (err) => resolve({ path, status: null, error: err.code ?? err.message }));
});
const results = [await ask('/health'), await ask('/api/items')];
console.log('REF-OPERATION ' + JSON.stringify(results));
process.exit(results[1].status === 200 ? 0 : 1);
`,
});

export const GOVERNED = governedText({
  protected_paths: ['.surety/checks/'],
  check_commands: { node: { path: process.execPath } },
  runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
});

export const CHECK_DEFS = Object.freeze({
  [defs('accept-r1')]: definitionText('accept-r1', { inputs: [WRAPPER_PATH, '.surety/checks/tests/api.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/api.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1', 'R1.2'] } }),
  [defs('integration-api')]: definitionText('integration-api', { inputs: [WRAPPER_PATH, '.surety/checks/tests/integration-api.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-api.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
  [defs('accept-r2')]: definitionText('accept-r2', { inputs: [WRAPPER_PATH, '.surety/checks/tests/web.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/web.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.1'] } }),
  [defs('integration-web')]: definitionText('integration-web', { inputs: [WRAPPER_PATH, '.surety/checks/tests/integration-web.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-web.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.1'] } }),
  [defs('accept-r3')]: definitionText('accept-r3', { inputs: [WRAPPER_PATH, '.surety/checks/tests/mobile.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/mobile.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
  [defs('integration-mobile')]: definitionText('integration-mobile', { inputs: [WRAPPER_PATH, '.surety/checks/tests/integration-mobile.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-mobile.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.1'] } }),
  [defs('smoke')]: definitionText('smoke', { inputs: [], kind: 'smoke', command: ['node', '--check', 'server.mjs'], timeout_s: 60, gate_kinds: GATES }),
  [defs('lint')]: definitionText('lint', { inputs: ['.surety/checks/lint.mjs'], kind: 'security_lint', command: ['node', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: GATES }),
  [defs('operation')]: definitionText('operation', { inputs: ['.surety/checks/post-deploy/operation.mjs'], kind: 'post_deploy_behavior', command: ['node', '.surety/checks/post-deploy/operation.mjs'], timeout_s: 120, gate_kinds: ['alpha_complete'], requires: ['environment', 'artifact_digest'] }),
});

// Phase 1's check authoring: every program, every definition, the governed file.
export const authoringFiles = () => ({ ...CHECK_PROGRAMS, ...CHECK_DEFS, '.surety/checks/protected-policy.json': GOVERNED });

// ---- the design (D7 §5; Appendix B), written by the scripted Designer ----------------------

export const DESIGN = '.surety/design/';
export const INVENTORY_PATH = '.surety/design/inventory/inventory.json';
export const MANIFEST_PATH = '.surety/design/assets/manifest.json';

export const TOKENS = {
  unit: 'lu',
  themes: {
    light: { 'color.text.primary': '#1a1a1a', 'color.surface.base': '#ffffff', 'color.accent': '#0b5cad' },
    dark: { 'color.text.primary': '#f2f2f2', 'color.surface.base': '#121212', 'color.accent': '#8ab4f8' },
  },
  type: { 'type.body': { size: 16 } },
  space: { 'space.md': 16 },
  radius: { 'radius.sm': 4 },
  duration: { 'duration.fast': 150 },
  pairs: [{ text: 'color.text.primary', background: 'color.surface.base' }],
};

export const FLOWS = {
  flows: [
    {
      key: 'F1',
      title: 'Keep the pantry',
      requirements: ['R2', 'R3'],
      steps: [
        { key: 'F1.1', title: 'See the pantry', interfaces: ['list-items'] },
        { key: 'F1.2', title: 'Add an item', interfaces: ['add-item'] },
      ],
    },
  ],
};

export const WEB_MOCKUP_PATH = 'mockups/web/s1.html';
export const ANDROID_MOCKUP_PATH = 'mockups/android/s2.html';
export const WEB_MOCKUP = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>S1 Pantry (web)</title><link rel="stylesheet" href="../../tokens.css"></head>
<body>
<main>
<h1>Pantry</h1>
<p data-state="empty">Nothing in the pantry yet.</p>
<form><label>Item name <input name="name" maxlength="40"></label><label>Quantity (pcs) <input name="quantity" type="number" min="0" max="99"></label><button>Add</button></form>
</main>
</body>
</html>
`;
export const ANDROID_MOCKUP = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>S2 Pantry (android, simulated)</title><link rel="stylesheet" href="../../tokens.css"></head>
<body style="width: 360px">
<main>
<h1>Pantry</h1>
<p data-state="empty">Nothing in the pantry yet.</p>
<p data-state="permission_denied:notifications">Reminders are off: notifications are not allowed.</p>
<form><label>Item name <input name="name" maxlength="40"></label><label>Quantity (pcs) <input name="quantity" type="number" min="0" max="99"></label><button>Add</button></form>
</main>
</body>
</html>
`;

// The Designer's logo proposal (an SVG with no script, no event attribute, no external reference).
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40" rx="6" fill="#0b5cad"/><text x="60" y="26" font-size="18" text-anchor="middle" fill="#ffffff">Pantry</text></svg>
`;
export const LOGO_PATH = 'assets/logo/full.svg';

export const CONVENTIONS = Object.freeze({
  web: { route: '/', browser_back: 'leaves Pantry for the previous page; forward returns to the list', keyboard_path: 'Tab reaches Item name, Quantity and Add in that order; Enter adds' },
  android: { permissions: [{ permission: 'notifications', prompt_when: 'the first time an item is added', rationale: 'to remind the household when an item runs low' }], gestures: ['tap', 'scroll'] },
});

// The fixture path of an obligation from the inventory's list (B.9
// `fixtures`); a permission state reads the list's `ok` fixture.
function fixtureFor(inventory, o) {
  const iface = o.interface ?? 'list-items';
  const state = o.interface ? o.state : 'ok';
  const f = (inventory.fixtures ?? []).find((x) => x.interface === iface && x.state === state);
  if (!f) throw new Error(`the inventory lists no fixture for ${iface} ${state} (${JSON.stringify(inventory.fixtures)})`);
  return f.path.startsWith(DESIGN) ? f.path.slice(DESIGN.length) : f.path;
}

const targetOf = (inventory, target) => {
  const t = (inventory.targets ?? []).find((x) => x.target === target);
  if (!t) throw new Error(`the inventory has no ${target} target (${JSON.stringify(inventory.targets)})`);
  return t;
};

// screens.json (B.12) for the inventory: S1 on web, S2 on android, each
// with a state for every obligation of its target. `omit` drops states
// ({target, interface, state}) from a screen: the first save's defect.
export function screensFor(inventory, { omit = [] } = {}) {
  const screen = (key, target, requirement, mockup) => {
    const states = (inventory.obligations ?? [])
      .filter((o) => o.target === target)
      .filter((o) => !omit.some((x) => x.target === o.target && x.state === o.state && (x.interface ?? null) === (o.interface ?? null)))
      .map((o) => ({ obligation: o, mockup, fixture: fixtureFor(inventory, o) }));
    return {
      key,
      target,
      title: 'Pantry',
      flow_steps: ['F1.1', 'F1.2'],
      requirements: [requirement],
      interfaces: ['list-items', 'add-item'],
      states,
      layouts: targetOf(inventory, target).layouts,
      inputs: [
        { interface: 'add-item', property: 'name', label: 'Item name' },
        { interface: 'add-item', property: 'quantity', label: 'Quantity (pcs)', unit: 'pcs' },
      ],
      conventions: CONVENTIONS[target],
    };
  };
  return { screens: [screen('S1', 'web', 'R2', WEB_MOCKUP_PATH), screen('S2', 'android', 'R3', ANDROID_MOCKUP_PATH)] };
}

export const NAVIGATION = { targets: [{ target: 'web', entries: ['S1'], edges: [] }, { target: 'android', entries: ['S2'], edges: [] }] };

// The design criteria (B.13; D7 §7.2) and one human test per target (§7.3).
export const CRITERIA = {
  criteria: [
    { requirement: 'R2', text: 'Given the web module, when web/app.css is read, then every colour, size, spacing, radius and duration in it is a custom property defined in web/tokens.css.', kind: 'tokens_only', targets: ['web'], paths: ['web/app.css', 'web/tokens.css'] },
    { requirement: 'R2', text: 'Given the web module, when web/assets/logo.svg is read, then it equals the effective logo (full) byte for byte.', kind: 'asset_parity', targets: ['web'], paths: [WEB_LOGO_PATH], slot: 'logo', variant: 'full' },
    { requirement: 'R3', text: 'Given the mobile module, when mobile/assets/logo.svg is read, then it equals the effective logo (full) byte for byte.', kind: 'asset_parity', targets: ['android'], paths: [ANDROID_LOGO_PATH], slot: 'logo', variant: 'full' },
  ],
  human_tests: [
    { target: 'web', text: 'The web UI matches approved design version 1: screen S1 at its layouts; browser back and the keyboard path are judged by a person.', screens: ['S1'], not_checkable_yet: [{ screen: 'S1', convention: 'browser_back' }, { screen: 'S1', convention: 'keyboard_path' }] },
    { target: 'android', text: 'The android UI matches approved design version 1, judged on an emulator or a device and not on the simulated preview: screen S2; the notification prompt and touch are judged by a person.', screens: ['S2'], not_checkable_yet: [{ screen: 'S2', convention: 'permission_prompt' }, { screen: 'S2', convention: 'touch_interaction' }] },
  ],
};

// The design's selection (B.10; §5.8): both default themes, the logo
// narrowed to `full` (listed on the approval), every other default slot and
// variant and every layout as the inventory gives them.
export function selectionFor(inventory) {
  const slots = new Map();
  for (const t of inventory.targets ?? []) for (const s of t.required_slots ?? []) slots.set(s.kind, [...new Set([...(slots.get(s.kind) ?? []), ...s.variants])]);
  return {
    themes: ['light', 'dark'],
    slots: [...slots].map(([kind, variants]) => ({ kind, variants: kind === 'logo' ? ['full'] : variants })),
    layouts: ['web', 'android'].map((target) => ({ target, layouts: targetOf(inventory, target).layouts })),
  };
}

// The asset manifest (B.16) with the Designer's logo proposal: the engine's
// placeholder manifest, its logo slot's `full` variant replaced by
// LOGO_PATH, the slot's `slot_version` and the manifest's `version`
// incremented, status `proposed`, provenance `designer`, the history kept.
export function manifestWithLogo(manifest, { designVersion = 1 } = {}) {
  const m = structuredClone(manifest);
  const slot = m.slots.find((s) => s.kind === 'logo');
  if (!slot) throw new Error(`the engine's manifest has no logo slot (${JSON.stringify(m.slots.map((s) => s.key))})`);
  slot.variants = slot.variants.map((v) => (v.name === 'full' ? { name: 'full', format: 'svg', transparency: v.transparency ?? 'any', file: LOGO_PATH, digest: sha256hex(LOGO_SVG) } : v));
  slot.slot_version += 1;
  slot.status = 'proposed';
  slot.provenance = 'designer';
  slot.status_since = designVersion;
  slot.history = [...(slot.history ?? []), { slot_version: slot.slot_version, design_version: designVersion, status: 'proposed', files: slot.variants.filter((v) => v.digest).map((v) => ({ variant: v.name, digest: v.digest })) }];
  m.version += 1;
  return m;
}

// design.json (B.10).
export function designJson(inventory, { version = 1 } = {}) {
  const t = (target) => {
    const x = targetOf(inventory, target);
    return { module: x.module, target, ui_technology: x.ui_technology, form_factors: x.form_factors ?? [], preview_capability: x.preview_capability, layouts: x.layouts };
  };
  return {
    version,
    origin: 'intended',
    inventory_digest: inventory.inventory_digest,
    selection: selectionFor(inventory),
    targets: [t('web'), t('android')],
    cross_platform: { targets: ['web', 'android'], differences: [] },
    tokens_file: 'tokens.json',
    flows_file: 'flows.json',
    screens_file: 'screens.json',
    navigation_file: 'navigation.json',
    criteria_file: 'criteria.json',
    assets_file: 'assets/manifest.json',
    mockups: [
      { path: WEB_MOCKUP_PATH, kind: 'static_html', screens: ['S1'], external_urls: [] },
      { path: ANDROID_MOCKUP_PATH, kind: 'simulated_html', screens: ['S2'], simulates: { target: 'android', form_factor: 'phone', layout: targetOf(inventory, 'android').layouts[0] }, external_urls: [] },
    ],
  };
}

// The whole design tree as {path: text} under .surety/design/.
export function designFiles(inventory, manifest, { omit = [], version = 1, tokens = TOKENS, criteria = CRITERIA } = {}) {
  const files = {
    'design.json': json(designJson(inventory, { version })),
    'tokens.json': json(tokens),
    'flows.json': json(FLOWS),
    'screens.json': json(screensFor(inventory, { omit })),
    'navigation.json': json(NAVIGATION),
    'criteria.json': json(criteria),
    'assets/manifest.json': json(manifestWithLogo(manifest, { designVersion: version })),
    [LOGO_PATH]: LOGO_SVG,
    [WEB_MOCKUP_PATH]: WEB_MOCKUP,
    [ANDROID_MOCKUP_PATH]: ANDROID_MOCKUP,
    'design.md': '# Pantry: design\n\nOne flow, one screen per target; light and dark; the logo proposed.\n',
  };
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [`${DESIGN}${p}`, t]));
}

// The first save's defect: S1 without the `empty` state of list-items.
export const FIRST_SAVE_DEFECT = Object.freeze({ target: 'web', interface: 'list-items', state: 'empty', reason: 'DESIGN_STATE_UNCOVERED' });

// ---- the batch's specification change (D7 §7.1, §7.3), written by the Spec Writer one-shot ----

// Spec version 2: the design's criteria under their requirements, verbatim
// from criteria.json, each numbered after its requirement's last criterion;
// a criterion with `requirement: "new"` a new requirement of its own; one
// human-test requirement per target, marked `**Human test.**` and
// `**Surface:** ui (<target>)` (SEAM.md §486); and `extra`, ordinary new
// requirements the same change adds. `base` the requirements before (their
// index phases as given). Returns {text, requirements, changes, humanKeys, newKeys, extraKeys}.
export function specV2For({ criteria = CRITERIA, base = REQUIREMENTS, extra = [], phase = 1 } = {}) {
  const reqs = base.map((r) => ({ ...r, criteria: [...r.criteria] }));
  const changes = new Map();
  const newKeys = [];
  const extraKeys = [];
  let next = reqs.length + 1;
  for (const c of criteria.criteria) {
    if (c.requirement === 'new') {
      const key = `R${next++}`;
      newKeys.push(key);
      reqs.push({ key, title: 'A design criterion of its own', phase, statement: c.text, criteria: [{ id: `${key}.1`, text: c.text }] });
      changes.set(key, { key, kind: 'added', reason: 'a design criterion proposed as a new requirement' });
      continue;
    }
    const r = reqs.find((x) => x.key === c.requirement);
    r.criteria.push({ id: `${r.key}.${r.criteria.length + 1}`, text: c.text });
    changes.set(r.key, { key: r.key, kind: 'criteria_added', reason: 'the approved design\'s criteria' });
  }
  const humanKeys = {};
  for (const h of criteria.human_tests) {
    const key = `R${next++}`;
    humanKeys[h.target] = key;
    reqs.push({ key, title: `The ${h.target} UI matches the approved design`, phase, surface: `ui (${h.target})`, statement: `A person judges the ${h.target} UI against the approved design.`, human_test: h.text, criteria: [] });
    changes.set(key, { key, kind: 'added', reason: `the ${h.target} human test of the approved design` });
  }
  for (const e of extra) {
    const key = `R${next++}`;
    extraKeys.push(key);
    reqs.push({ ...e, key, phase, criteria: (e.criteria ?? []).map((text, i) => ({ id: `${key}.${i + 1}`, text })) });
    changes.set(key, { key, kind: 'added', reason: 'an ordinary new requirement' });
  }
  const text = specText({ version: 2, requirements: reqs, changeLog: [{ version: 2, date: '2026-10-16', change: 'The approved design\'s criteria and human tests', by: 'Sean' }] });
  return { text, requirements: reqs, changes: [...changes.values()], humanKeys, newKeys, extraKeys };
}
const V2 = specV2For();
export const DESIGN_CRITERIA_IDS = Object.freeze({ tokens: 'R2.2', parityWeb: 'R2.3', parityAndroid: 'R3.2' });
export const HUMAN_TEST_KEYS = Object.freeze(V2.humanKeys);
export const REQUIREMENTS_V2 = Object.freeze(V2.requirements);
export const SPEC_V2 = V2.text;
export const SPEC_V2_CHANGES = Object.freeze(V2.changes);

// ---- the design criteria's checks, written by the check correction (D6 §4.5) -------------------

const tokensTest = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('R2.2: web/app.css holds no literal; every custom property it uses is defined in web/tokens.css', () => {
  const css = readFileSync('web/app.css', 'utf8');
  const tokens = readFileSync('web/tokens.css', 'utf8');
  assert.equal(/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\b\\d+(\\.\\d+)?(px|rem|em|ms|s)\\b/.test(css), false, 'no literal colour, size or duration');
  for (const [, name] of css.matchAll(/var\\((--[a-z0-9-]+)\\)/g)) assert.ok(tokens.includes(name + ':'), name + ' is defined in tokens.css');
});
`;
// The parity check reads the effective file the engine materializes for it
// (SEAM.md §487: SURETY_ASSET_<SLOT>_<VARIANT>, from the definition's `asset_inputs`).
const parityTest = (criterion, path) => `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
test(${JSON.stringify(`${criterion}: ${path} equals the effective logo (full)`)}, () => {
  const effective = process.env.SURETY_ASSET_LOGO_FULL;
  assert.ok(effective, 'the engine gave the check the effective logo');
  assert.equal(digest(${JSON.stringify(path)}), digest(effective));
});
`;
export const CORRECTION_FILES = Object.freeze({
  '.surety/checks/tests/tokens.test.mjs': tokensTest,
  '.surety/checks/tests/parity-web.test.mjs': parityTest('R2.3', WEB_LOGO_PATH),
  '.surety/checks/tests/parity-android.test.mjs': parityTest('R3.2', ANDROID_LOGO_PATH),
  [defs('accept-r2-tokens')]: definitionText('accept-r2-tokens', { inputs: [WRAPPER_PATH, '.surety/checks/tests/tokens.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/tokens.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.2'] } }),
  [defs('parity-web')]: definitionText('parity-web', { inputs: [WRAPPER_PATH, '.surety/checks/tests/parity-web.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/parity-web.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R2.3'] }, asset_inputs: [{ slot: 'logo', variant: 'full' }] }),
  [defs('parity-android')]: definitionText('parity-android', { inputs: [WRAPPER_PATH, '.surety/checks/tests/parity-android.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/parity-android.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R3.2'] }, asset_inputs: [{ slot: 'logo', variant: 'full' }] }),
});
export const PARITY_CHECKS = Object.freeze(['parity-web', 'parity-android']);
export const DESIGN_CHECKS = Object.freeze(['accept-r2-tokens', 'parity-web', 'parity-android']);

// ---- the review at Alpha (B.14) ---------------------------------------------------------

// review-1.json: S1 matches on the browser, resting on the engine's observation of its route; S2 not observed.
export const reviewFile = ({ candidate, webEvidence }) =>
  json({
    design_version: 1,
    subject: { kind: 'candidate', candidate },
    screens: [
      { target: 'web', key: 'S1', verdict: 'matches', observed_on: 'browser', evidence: webEvidence, deltas: [] },
      { target: 'android', key: 'S2', verdict: 'not_observed', not_observed_reason: 'no_native_runtime', evidence: [], deltas: [] },
    ],
    revised_design: false,
    first_design: false,
  });
export const REVIEW_PATH = '.surety/design/reviews/review-1.json';
