// Row M616's projects (the M7 plan §3b; D4 §13.4; SEAM.md §573): the
// design journey's reference project (Pantry, harness/design/reference.mjs)
// in three variants, each taken through the owner's production routes to
// its published plan (D6 §1 steps 1 to 4; design off), and the browser app
// built to its phase's completion on the kernel lane (the scripted roles and
// check boundary, the routed decisions answered by the owner as M6's kernel
// rows answer them):
//
//   PAGE     a browser app: one `ui` module targeting the web under
//            `html_css`, no service module, **Targets:** web, and the
//            specification's environment stating no server runtime (D4 §13.4:
//            `static_site`). Its Builder writes the page and a package.json
//            whose start script names a server, so the candidate's tree
//            disagrees with the architecture (row M616 (d)).
//   SERVICE  Pantry as M6 has it: the environment's runtime `node server.mjs`
//            (`node_service`).
//   SILENT   Pantry with no runtime stated in the specification: an `api`
//            module whose runtime nothing names (`unknown`).
//
// Nothing here acts on a unit or signals a process.

import assert from 'node:assert/strict';

import { definitionText, governedText, nodeReadPaths } from '../checks/fixtures.mjs';
import { KERNEL_KINDS } from '../design/check41.mjs';
import { stageWork, toPublished } from '../design/drive.mjs';
import { ADR_KEY, REQUIREMENTS, SPEC, T2_KINDS, specText } from '../design/reference.mjs';
import { roleThat } from '../gitruns.mjs';
import { journeyContext, phaseCompleted } from '../journey/drive.mjs';
import { WRAPPER } from '../project/reference.mjs';
import { script, step } from '../scripted.mjs';
import { dirname } from 'node:path';

// The policy of every variant: design off (the default, left as it is),
// `phase` autonomy, and a phase size that admits a one-stage phase.
export const PAGE_POLICY = Object.freeze({ autonomy: 'phase', phase_size: { min: 1, max: 5 } });

const RUNTIME_LINE = '- **Runtime and start command:** `node server.mjs`.\n';

// ---- PAGE: the browser app -------------------------------------------------------------------

export const PAGE_REQUIREMENT = Object.freeze({
  key: 'R1',
  title: 'The pantry page',
  phase: 1,
  surface: 'ui (web)',
  statement: 'A user reads the pantry list in a web browser.',
  criteria: [{ id: 'R1.1', text: 'Given the web module, when index.html is read, then it links web/app.css.' }],
});
export const PAGE_PATHS = Object.freeze(['index.html', 'package.json', 'web/']);
const pageSpecText = (runtimeLine) => {
  const text = specText({ requirements: [PAGE_REQUIREMENT], targets: '**Targets:** web', crossPlatform: null, modules: [{ name: 'web', paths: PAGE_PATHS }] });
  assert.ok(text.includes(RUNTIME_LINE), 'the reference specification states its runtime on the expected line');
  return text.replace(RUNTIME_LINE, runtimeLine).replace('GET /api/items answers 200', 'GET / answers the page');
};
// The specification's environment says there is no server: the files are served as they are.
export const PAGE_SPEC = pageSpecText('- **Runtime and start command:** none: static files served from the artifact.\n');
export const PAGE_MODULES = Object.freeze({
  version: 1,
  modules: [{ name: 'web', surface: 'ui', paths: [...PAGE_PATHS], sensitive_areas: [], targets: [{ target: 'web', ui_technology: 'html_css' }], interfaces: [] }],
  mapping_from_spec: [{ spec_module: 'web', to: ['web'] }],
});
export const PAGE_ROADMAP = Object.freeze({ version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'the pantry page', modules: ['web'], requirement_ids: ['R1'], depends_on: [] }] });
export const PAGE_STAGES = Object.freeze([
  { number: 1, goal: 'the page', tasks: ['write index.html and web/app.css'], modules: ['web'], implements: ['R1'], adrs: [ADR_KEY], depends_on: [], validation: { criteria: ['R1.1'], kinds: T2_KINDS, sensitive_areas: [] }, integration_obligations: [] },
]);
export const PAGE_FILES = Object.freeze({ modules: PAGE_MODULES, roadmap: PAGE_ROADMAP, stages: PAGE_STAGES });

// What the page's Builder writes: the page, its stylesheet, and a
// package.json with a start script (the tree's own answer: a Node service).
export const PAGE_BUILT = Object.freeze({
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="web/app.css"></head><body><ul id="items"></ul></body></html>\n',
  'web/app.css': 'body { font-family: sans-serif; }\n',
  'package.json': '{"name":"pantry-page","private":true,"scripts":{"start":"node server.mjs"}}\n',
});

// The Verifier's phase-1 authoring for the page: T2's four kinds over R1.1.
const WRAPPER_PATH = '.surety/checks/wrapper.mjs';
const defs = (key) => `.surety/checks/defs/${key}.json`;
const GATES = ['stage', 'alpha_authorize'];
const fileTest = (title, path, pattern) => `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test(${JSON.stringify(title)}, () => {
  assert.match(readFileSync(${JSON.stringify(path)}, 'utf8'), new RegExp(${JSON.stringify(pattern)}));
});
`;
const LINT = `import { readFileSync } from 'node:fs';
const text = readFileSync('index.html', 'utf8');
process.exit(/<script[^>]*src=["']https?:/.test(text) ? 1 : 0);
`;
export const PAGE_AUTHORING = Object.freeze({
  [WRAPPER_PATH]: WRAPPER,
  '.surety/checks/tests/page.test.mjs': fileTest('R1.1: index.html links web/app.css', 'index.html', 'web/app\\.css'),
  '.surety/checks/tests/integration-page.test.mjs': fileTest('integration, R1.1: the page and its stylesheet', 'web/app.css', 'body'),
  '.surety/checks/lint.mjs': LINT,
  [defs('accept-r1')]: definitionText('accept-r1', { inputs: [WRAPPER_PATH, '.surety/checks/tests/page.test.mjs'], kind: 'acceptance', command: ['node', WRAPPER_PATH, '.surety/checks/tests/page.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
  [defs('integration-page')]: definitionText('integration-page', { inputs: [WRAPPER_PATH, '.surety/checks/tests/integration-page.test.mjs'], kind: 'integration', command: ['node', WRAPPER_PATH, '.surety/checks/tests/integration-page.test.mjs'], timeout_s: 120, gate_kinds: GATES, covers: { criteria: ['R1.1'] } }),
  [defs('smoke')]: definitionText('smoke', { inputs: ['.surety/checks/lint.mjs'], kind: 'smoke', command: ['node', '--check', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: GATES }),
  [defs('lint')]: definitionText('lint', { inputs: ['.surety/checks/lint.mjs'], kind: 'security_lint', command: ['node', '.surety/checks/lint.mjs'], timeout_s: 60, gate_kinds: GATES }),
  '.surety/checks/protected-policy.json': governedText({
    protected_paths: ['.surety/checks/'],
    check_commands: { node: { path: process.execPath } },
    runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
  }),
});

const writes = (files) => Object.entries(files).map(([path, text]) => step.write(path, text));

// The roles of the page's build by work kind (as M6's `designScripts`).
export function pageScripts(fx) {
  fx.scripted.kindScript('check_authoring', [0, 1, 2, 3].map(() => roleThat(writes(PAGE_AUTHORING), { proposal: { rationale: 'The Verifier authors phase 1\'s checks before any stage builds.', requested_change_kind: 'unclassifiable' } })));
  fx.scripted.kindScript('verification', script.complete());
  fx.scripted.kindScript('review', { steps: [{ review_auto: { reason: 'The approved specification requires these checks.' } }] });
  fx.scripted.kindScript('phase_verification', roleThat([], { signoffs: [{ scope: 'phase' }] }));
  fx.scripted.defaultScript(script.complete());
}

// The page published: {p, spec, arch}.
export const pagePublished = (fx, { name = 'pantry-page' } = {}) => toPublished(fx, { policy: PAGE_POLICY, name, spec: PAGE_SPEC, files: PAGE_FILES });

// The page's one phase built to its completion on the kernel lane, from
// its publication. Returns {ctx, plan}.
export async function pageBuilt(fx, p) {
  pageScripts(fx);
  const w = stageWork(fx.home, p.id, 1);
  assert.ok(w, 'the published plan has its stage_build work item');
  fx.scripted.script(w.id, [0, 1, 2].map(() => roleThat(writes(PAGE_BUILT))));
  const ctx = journeyContext(fx, p, { lane: 'kernel' });
  ctx.answerKinds = [...KERNEL_KINDS];
  const plan = await phaseCompleted(fx, ctx, 1, { max: 160 });
  return { ctx, plan };
}

// ---- SERVICE and SILENT ----------------------------------------------------------------------

export const SERVICE_POLICY = PAGE_POLICY;
export const servicePublished = (fx, { name = 'pantry-service' } = {}) => toPublished(fx, { policy: SERVICE_POLICY, name, spec: SPEC });
// Pantry's specification with its environment's runtime line left out.
export const SILENT_SPEC = (() => {
  assert.ok(SPEC.includes(RUNTIME_LINE));
  return SPEC.replace(RUNTIME_LINE, '');
})();
export const silentPublished = (fx, { name = 'pantry-silent' } = {}) => toPublished(fx, { policy: SERVICE_POLICY, name, spec: SILENT_SPEC });

export { REQUIREMENTS };
