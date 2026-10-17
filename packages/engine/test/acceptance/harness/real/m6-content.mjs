// The M6 real lane's rehearsal content (slice 46; M519's and M535's dress
// rehearsals; BS6 §12; SEAM.md §541): what the rehearsal's owner says and
// what a model would write, which no package states. Never the form the
// engine reads: the package-driven fakes (harness/standin/package-fakes.cjs)
// take that from the package alone, the Designer's from its
// `json surety-reads designer.*` blocks (SEAM.md §538).
//
// The rehearsal's project is the design journey's Pantry
// (harness/design/reference.mjs): M535's rehearsal the whole of it (web
// `html_css`, `android` `react_native`, `**Cross-platform:** yes`), M519's
// its web half (the API and the web page, `**Targets:** web`). The paid runs
// never read this file: their projects come from the briefs (M519 the V1
// visual-design brief, M535 docs/acceptance/reports/M6-real-lane/m535-brief.md)
// and their products from the real roles. The rehearsal is never evidence.
//
// The Designer's own content (palette, type, the logo it proposes) is the
// slice's Verifier's `designerContent` (harness/design/packages46.mjs),
// loaded when a rehearsal builds its fake, never at this module's load, so
// that a real-lane file's preflight refusal never depends on it.

import {
  ADR_KEY,
  APP_CSS,
  APP_JS,
  CHECK_PROGRAMS,
  INDEX_HTML,
  INTERFACES,
  IDEA_BRIEF as PANTRY_IDEA,
  REQUIREMENTS as PANTRY_REQUIREMENTS,
  SERVER_MJS,
  WEB_LOGO_PATH,
  ANDROID_LOGO_PATH,
} from '../design/reference.mjs';
import { block, ownerSays, targetFree } from './rehearsal-content.mjs';

export { block, ownerSays };

const WRAPPER = '.surety/checks/wrapper.mjs';
const T = (name) => `.surety/checks/tests/${name}.test.mjs`;
const viaWrapper = (name) => ({ files: { [WRAPPER]: CHECK_PROGRAMS[WRAPPER], [T(name)]: CHECK_PROGRAMS[T(name)] }, run: [WRAPPER, T(name)] });

// ---- the two rehearsal variants ----------------------------------------------------------------

// M519's rehearsal: Pantry on the web only (the API and the web page).
// M535's: the whole Pantry, web and android.
export const VARIANTS = Object.freeze({
  M519: { targets: ['web'], requirements: ['R1', 'R2'], modules: ['api', 'web'] },
  M535: { targets: ['web', 'android'], requirements: ['R1', 'R2', 'R3'], modules: ['api', 'web', 'mobile'] },
});
const variantOf = (row) => {
  const v = VARIANTS[row];
  if (!v) throw new Error(`m6-content: no rehearsal variant for ${row}`);
  return v;
};

// The idea the rehearsal's project is created with (the paid runs read their brief).
export function rehearsalIdea(row) {
  if (row === 'M535') return PANTRY_IDEA;
  // The web half: the same identity, the Android app out.
  return PANTRY_IDEA.replace('in the browser and on Android', 'in the browser')
    .replace('a web page and an Android app show it and add to it, sharing one look and one workflow', 'a web page shows it and adds to it')
    .replace('- a web page and an Android app that list and add items', '- a web page that lists and adds items')
    .replace('The household, on a laptop and on a phone.', 'The household, on a laptop.');
}

// ---- what the owner says (the fakes read these blocks; SEAM.md §455) ----------------------------

// The Spec Writer's brief: Pantry at the standard tier, one phase, its
// targets (G3) and each UI requirement's surface mark.
export function pantryBrief(row) {
  const v = variantOf(row);
  const requirements = PANTRY_REQUIREMENTS.filter((r) => v.requirements.includes(r.key)).map((r) => ({
    key: r.key,
    title: r.title,
    phase: 1,
    statement: r.statement,
    areas: [],
    ...(r.surface ? { surface: r.surface } : {}),
    criteria: r.criteria.map((c) => ({ ...c })),
  }));
  return {
    project: 'Pantry',
    owner: 'Sean',
    tier: 'standard',
    spec_version: 1,
    targets: [...v.targets],
    cross_platform: v.targets.length > 1,
    purpose: v.targets.length > 1 ? "Pantry keeps a household's pantry list, in the browser and on Android, with a JSON API." : "Pantry keeps a household's pantry list in the browser, with a JSON API.",
    non_goals: ['Accounts and sharing', 'Persistence across restarts'],
    users: 'The household.',
    requirements,
    modules: [
      { name: 'api', paths: ['server.mjs'], areas: [] },
      { name: 'web', paths: ['web/'], areas: [] },
      ...(v.modules.includes('mobile') ? [{ name: 'mobile', paths: ['mobile/'], areas: [] }] : []),
    ],
    environments: [
      {
        name: 'alpha',
        fields: {
          Purpose: "the owner's test target",
          'Verified means': 'the post-deploy behaviour check passes against it',
          Target: '`local_service`, target `app`',
          'Runtime and start command': '`node server.mjs`',
          Port: '`PORT`',
          'Excluded from the artifact': 'none',
          'Required post-deploy behaviour check': 'GET /api/items answers 200 {"items": []}',
          'Stable arguments': 'the service does not change its process title or arguments',
        },
      },
    ],
    constraints: ["Node's own modules only for the API; no package.json.", 'ES modules.'],
    interfaces: 'HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data.',
    questions: [],
    no_area_words: 'no sensitive area',
  };
}

// The Architect's brief: the modules with surfaces, targets, technologies
// and interface shapes (G1; B.3 as D7 extends it), one ADR, one phase.
export function pantryArchitecture(row) {
  const v = variantOf(row);
  const consumers = v.modules.filter((m) => m !== 'api');
  const iface = (i) => ({ ...i, consumed_by: consumers, description: `${i.name === 'list-items' || i.name === 'add-item' ? 'R1: ' : ''}${i.description}` });
  const modules = [
    { name: 'api', surface: 'api', paths: ['server.mjs'], sensitive_areas: [], requirements: ['R1'], interfaces: [iface(INTERFACES.list), iface(INTERFACES.add), { ...INTERFACES.health, consumed_by: [] }] },
    { name: 'web', surface: 'ui', paths: ['web/'], sensitive_areas: [], requirements: ['R2'], targets: [{ target: 'web', ui_technology: 'html_css' }], interfaces: [] },
  ];
  if (v.modules.includes('mobile')) {
    modules.push({
      name: 'mobile',
      surface: 'ui',
      paths: ['mobile/'],
      sensitive_areas: [],
      requirements: ['R3'],
      targets: [{ target: 'android', ui_technology: 'react_native', form_factors: ['phone'] }],
      platform_permissions: [{ target: 'android', permission: 'notifications', why: 'to remind the household when an item runs low' }],
      asset_paths: [{ slot: 'logo', variant: 'full', target: 'android', path: ANDROID_LOGO_PATH }],
      interfaces: [],
    });
  }
  return {
    architecture: v.modules.includes('mobile')
      ? '`api` (server.mjs, Node\'s own http) holds the list in memory and serves the web module\'s files; `web` is a static page in HTML and CSS; `mobile` is a React Native app (source only in M6).'
      : '`api` (server.mjs, Node\'s own http) holds the list in memory and serves the web module\'s files; `web` is a static page in HTML and CSS.',
    modules,
    mapping: v.modules.map((m) => ({ spec_module: m, to: [m] })),
    adrs: [
      {
        key: ADR_KEY,
        title: v.modules.includes('mobile') ? 'one API, two UI technologies' : 'one API, a static web page',
        status: 'accepted',
        context: 'The household uses a laptop' + (v.modules.includes('mobile') ? ' and an Android phone.' : '.'),
        decision: "The API is Node's own `http`; the web UI is HTML and CSS (`html_css`) served by the API" + (v.modules.includes('mobile') ? '; the Android UI is React Native (`react_native`).' : '.'),
        consequences: 'The web page reads tokens.css' + (v.modules.includes('mobile') ? '; the Android app reads the neutral tokens.json.' : '.'),
      },
    ],
    phases: [{ number: 1, goal: v.modules.includes('mobile') ? 'the pantry on the web and on Android' : 'the pantry on the web', modules: [...v.modules], requirements: [...v.requirements], depends_on: [] }],
    obligations: { api: ['server.mjs listens on 127.0.0.1:$PORT'] },
  };
}

// What the rehearsal's owner says to the Designer (his feedback turns, D7
// §1 step 5a), and to the review-mode Designer at Alpha. Words only: the
// fake's design comes from its package.
export const DESIGNER_WORDS = Object.freeze([
  'Draw Pantry from the inventory: one list, one way to add an item, the brand kept quiet.',
  'Looks right. Keep the contrast as it is. We are done.',
]);
export const REVIEW_WORDS = Object.freeze(['I opened the web Alpha through the relay: the list and the add form match the mockup. We are done.']);
// The asset the rehearsal's owner supplies for the held logo (an SVG text,
// no script, no event attribute, no external reference; BS6 §4.1 rule 22).
export const OWNER_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40"><rect width="120" height="40" rx="6" fill="#1d6b3a"/><text x="60" y="26" font-size="18" text-anchor="middle" fill="#ffffff">Pantry</text></svg>
`;

// ---- CONTENT (what a model would write, keyed by what the package names) ------------------------

const SERVER = (text) => {
  const out = text.replace(".listen(Number(process.env.PORT), '127.0.0.1')", '.{{obligation:listen}}');
  if (!out.includes('{{obligation:listen}}')) throw new Error("m6-content: the service's listen call was not found");
  return out;
};

// A design criterion's check program, by its kind (D7 §7.2): a template the
// Verifier's fake fills from `verifier.design_catalogue` (SEAM.md §539:
// {{criterion}}, {{paths}} space-separated, {{path0}}, {{slot}},
// {{variant}}) and runs with node directly. A failure exits non-zero.
export const DESIGN_CHECKS = Object.freeze({
  tokens_only: `// {{criterion}}: tokens_only (D7 §7.2) on {{paths}}
import { readFileSync } from 'node:fs';
const paths = '{{paths}}'.split(' ').filter(Boolean);
const sheets = paths.filter((p) => p.endsWith('.css') && !p.endsWith('tokens.css'));
const tokens = paths.filter((p) => p.endsWith('tokens.css')).map((p) => readFileSync(p, 'utf8')).join('\\n');
const bad = [];
if (sheets.length === 0) bad.push('no stylesheet named');
for (const p of sheets) {
  const css = readFileSync(p, 'utf8');
  if (/#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\b\\d+(\\.\\d+)?(px|rem|em|ms|s)\\b/.test(css)) bad.push(p + ': a literal colour, size or duration');
  for (const [, name] of css.matchAll(/var\\((--[a-z0-9-]+)\\)/g)) if (!tokens.includes(name + ':')) bad.push(name + ' is not defined in the tokens stylesheet');
}
console.log('DESIGN-CHECK ' + JSON.stringify({ criterion: '{{criterion}}', kind: 'tokens_only', bad }));
process.exit(bad.length === 0 ? 0 : 1);
`,
  asset_parity: `// {{criterion}}: asset_parity (D7 §7.2) of {{slot}}/{{variant}} at {{paths}}
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const variable = 'SURETY_ASSET_' + '{{slot}}_{{variant}}'.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const effective = process.env[variable];
const bad = [];
if (!effective) bad.push('the engine gave the check no ' + variable);
else for (const p of '{{paths}}'.split(' ').filter(Boolean)) if (digest(p) !== digest(effective)) bad.push(p + ' differs from the effective file');
console.log('DESIGN-CHECK ' + JSON.stringify({ criterion: '{{criterion}}', kind: 'asset_parity', bad }));
process.exit(bad.length === 0 ? 0 : 1);
`,
});

// The criteria the rehearsal's Designer proposes (designerContent's form:
// [{target, kind, paths, slot?, variant?}]; the fake keeps each only where
// its package's catalogue applies it).
const designCriteria = (v) => [
  { target: 'web', kind: 'tokens_only', paths: ['web/app.css', 'web/tokens.css'] },
  { target: 'web', kind: 'asset_parity', paths: [WEB_LOGO_PATH], slot: 'logo', variant: 'full' },
  ...(v.modules.includes('mobile') ? [{ target: 'android', kind: 'asset_parity', paths: [ANDROID_LOGO_PATH], slot: 'logo', variant: 'full' }] : []),
];
// The criteria of a variant (M6-hands-on.sh plays the whole Pantry, M535's; objection 202).
export const designCriteriaOf = (row) => designCriteria(variantOf(row));

// The rehearsal's CONTENT for `row` (SEAM.md §455's form, with the design
// additions of §539: `design` the Designer's, `design_checks` by kind,
// `asset_paths` where a UI Builder places each effective file when its
// package declares none). Async: the Designer's content is loaded here.
export async function m6Content(row) {
  const v = variantOf(row);
  let designerContent;
  try {
    ({ designerContent } = await import('../design/packages46.mjs'));
  } catch (err) {
    throw new Error(`m6-content: the Designer's rehearsal content (harness/design/packages46.mjs designerContent) could not be loaded: ${err?.message ?? err}`);
  }
  if (typeof designerContent !== 'function') throw new Error('m6-content: harness/design/packages46.mjs exports no designerContent');
  const code = {
    'server.mjs': { R1: SERVER(SERVER_MJS) },
    'web/index.html': { R2: INDEX_HTML },
    'web/app.css': { R2: APP_CSS },
  };
  const checks = {
    'accept-r1': viaWrapper('api'),
    'accept-r2': viaWrapper('web'),
    'integration-s1': viaWrapper('integration-api'),
    'integration-s2': viaWrapper('integration-web'),
    smoke: { files: {}, run: ['--check', 'server.mjs'] },
    lint: { files: { '.surety/checks/lint.mjs': CHECK_PROGRAMS['.surety/checks/lint.mjs'] }, run: ['.surety/checks/lint.mjs'] },
    operation: { files: { '.surety/checks/post-deploy/operation.mjs': targetFree(CHECK_PROGRAMS['.surety/checks/post-deploy/operation.mjs']) }, run: ['.surety/checks/post-deploy/operation.mjs'] },
  };
  const assetPaths = { web: { 'logo/full': WEB_LOGO_PATH } };
  if (v.modules.includes('mobile')) {
    code['mobile/App.js'] = { R3: APP_JS };
    checks['accept-r3'] = viaWrapper('mobile');
    checks['integration-s3'] = viaWrapper('integration-mobile');
    assetPaths.android = { 'logo/full': ANDROID_LOGO_PATH };
  }
  return {
    code,
    checks,
    corrections: {},
    design: designerContent({ name: 'Pantry', criteria: designCriteria(v) }),
    design_checks: DESIGN_CHECKS,
    asset_paths: assetPaths,
    // Where the web UI Builder places the package's design/tokens.css (the tokens_only criterion reads it).
    tokens_paths: { web: 'web/tokens.css' },
  };
}
