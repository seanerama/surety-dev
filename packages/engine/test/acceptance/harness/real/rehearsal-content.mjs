// The rehearsal's content (M5 slice 38; M442 (b), (c); M443's and M444's
// rehearsals; SEAM.md §455): what the owner says and what a model would
// write, which no package states. Never the form the engine reads: that the
// package-driven fakes take from the package alone
// (harness/standin/package-fakes.cjs).
//
//   - The owner's words, as the rehearsal's owner types them: the project
//     brief of the Spec Writer's session (`json rehearsal-owner`), the
//     architecture brief of the Architect's (`json rehearsal-architecture`),
//     the change request (`json rehearsal-change`).
//   - CONTENT: the code a stage's Builder writes, keyed by the path a task
//     names and the requirement it implements; the program of a check, keyed
//     by the check's key the fake derives from the package (`accept-r<n>`,
//     `<kind>-s<n>`, `smoke`, `lint`, `operation`); the corrections, keyed
//     the same; the toolchain and its governed file; in retrofit the adopted
//     tests' copies.
//
// The project is M401's Tally (harness/journey/reference.mjs), its programs
// and code reused from there; the retrofit one is M408's Sums.

import {
  ADR_KEY,
  CHANGE_REQUEST,
  CHECK_PROGRAMS,
  CORRECTED_R4_TESTS,
  CORRECTED_SERVICE_TEST,
  REQUIREMENTS,
  REQUIREMENTS_V2,
  SERVER_MJS,
  SERVER_MJS_STATS,
  SUM_MJS,
  TALLY_MJS,
} from '../journey/reference.mjs';

const WRAPPER = '.surety/checks/wrapper.mjs';
// A post-deploy program with its target's variable left to the fake: the
// URL expression and the variable's name as placeholders it fills from the package.
export function targetFree(text) {
  const out = text.replaceAll('process.env.SURETY_TARGET_APP', '{{target:url}}').replaceAll('SURETY_TARGET_APP', '{{target:name}}');
  if (/SURETY_TARGET_/.test(out) || !out.includes('{{target:url}}')) throw new Error('rehearsal content: the post-deploy program\'s target was not found');
  return out;
}
const T = (name) => `.surety/checks/tests/${name}.test.mjs`;
const viaWrapper = (name) => ({ files: { [WRAPPER]: CHECK_PROGRAMS[WRAPPER], [T(name)]: CHECK_PROGRAMS[T(name)] }, run: [WRAPPER, T(name)] });

// ---- what the owner says ---------------------------------------------------------------------

export const block = (tag, value) => `\`\`\`json ${tag}\n${JSON.stringify(value, null, 2)}\n\`\`\``;

// The project brief: Tally at the standard tier, two phases of two
// requirements, its modules and Alpha. `variant`: a human-test requirement
// (R5, phase 2) and an open question (Q1, blocking R4, phase 2), which only
// the specification units use (M442 (b)).
export function tallyBrief({ variant = false } = {}) {
  const requirements = REQUIREMENTS.map((r) => ({ key: r.key, title: r.title, phase: r.phase, statement: r.statement, areas: [], criteria: r.criteria.map((c) => ({ ...c })) }));
  if (variant) requirements.push({ key: 'R5', title: 'Readable count', phase: 2, statement: 'The dashboard shows the count large enough to read across the room.', areas: [], criteria: [], human_test: 'A person stands across the room from the dashboard and reads the count aloud.' });
  return {
    project: 'Tally',
    owner: 'Sean',
    tier: 'standard',
    spec_version: 1,
    purpose: 'Tally sums two numbers over HTTP for a workshop and counts the sums it served, so a dashboard can show the day\'s activity.',
    non_goals: ['Authentication', 'Persistence across restarts'],
    users: 'The workshop organizer reads the count on a dashboard during the day.',
    requirements,
    modules: [
      { name: 'lib', paths: ['src/'], areas: [] },
      { name: 'service', paths: ['server.mjs'], areas: [] },
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
          'Required post-deploy behaviour check': 'GET /sum?a=2&b=3 answers 200 {"sum": 5}',
          'Stable arguments': 'the service does not change its process title or arguments',
        },
      },
    ],
    constraints: ["Node's own modules only; no package.json.", 'ES modules.'],
    interfaces: 'HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data.',
    questions: variant ? [{ id: 'Q1', text: 'Should a refused request count toward R4\'s stats? Blocks R4.', blocks: ['R4'], phase: 2 }] : [],
    no_area_words: 'no sensitive area',
  };
}

// The architecture brief: the modules with their interfaces, each interface's
// description citing the requirement it serves (so the fake's stages follow
// them), the requirements each module holds (E145 item 1), one ADR, the two
// phases, and the service's integration obligation.
export const TALLY_ARCHITECTURE = Object.freeze({
  architecture: 'Two modules: `lib` (pure functions under src/) and `service` (server.mjs, Node\'s own http). The service imports the library.',
  modules: [
    {
      name: 'lib',
      paths: ['src/'],
      sensitive_areas: [],
      requirements: ['R1', 'R3'],
      interfaces: [
        { name: 'sum', kind: 'module', path: 'src/sum.mjs', description: 'R1: export const sum = (a, b) => number' },
        { name: 'tally', kind: 'module', path: 'src/tally.mjs', description: 'R3: export const makeTally = () => ({count(), total()})' },
      ],
    },
    {
      name: 'service',
      paths: ['server.mjs'],
      sensitive_areas: [],
      requirements: ['R2', 'R4'],
      interfaces: [
        { name: 'sum-route', kind: 'http', path: 'server.mjs', description: 'R2: GET /health; GET /sum?a&b answers {"sum": n}, 400 on a non-number' },
        { name: 'stats-route', kind: 'http', path: 'server.mjs', description: 'R4: GET /stats answers {"count": n} of the successful sums' },
      ],
    },
  ],
  mapping: [
    { spec_module: 'lib', to: ['lib'] },
    { spec_module: 'service', to: ['service'] },
  ],
  adrs: [{ key: ADR_KEY, title: 'No dependencies', status: 'accepted', context: 'A workshop service, run by node alone.', decision: "The service uses Node's own `http` module and no dependency.", consequences: 'No framework; routing is a small switch on the path.' }],
  phases: [
    { number: 1, goal: 'sum two numbers, in the library and through the service', modules: ['lib', 'service'], requirements: ['R1', 'R2'], depends_on: [] },
    { number: 2, goal: 'count the sums and show the stats', modules: ['lib', 'service'], requirements: ['R3', 'R4'], depends_on: [1] },
  ],
  obligations: { service: ['server.mjs listens on 127.0.0.1:$PORT'] },
});

// CR-1 (M401's): R2.1 reworded, R4 sharpened.
export const TALLY_CHANGE = Object.freeze({
  criteria: { 'R2.1': REQUIREMENTS_V2.find((r) => r.key === 'R2').criteria[0].text },
  statements: { R4: REQUIREMENTS_V2.find((r) => r.key === 'R4').statement },
  reason: 'CR-1: R2.1 names the content type; R4 counts successful sums only',
});
export const TALLY_CHANGE_TEXT = `${CHANGE_REQUEST}\n${block('rehearsal-change', TALLY_CHANGE)}\n`;

export const ownerSays = (words, tag, value) => `${words}\n\n${block(tag, value)}\n`;

// ---- CONTENT ---------------------------------------------------------------------------------

// The code each stage writes, by the path its task names and the
// requirement it implements; `{{dep:<interface>}}` is resolved by the fake
// from the package's dependency interfaces.
const SERVER = (text) => {
  const out = text.replace("'./src/sum.mjs'", "'{{dep:sum}}'").replace("'./src/tally.mjs'", "'{{dep:tally}}'").replace(".listen(Number(process.env.PORT), '127.0.0.1')", '.{{obligation:listen}}');
  if (!out.includes('{{obligation:listen}}')) throw new Error('rehearsal content: the service\'s listen call was not found');
  return out;
};

export function tallyContent() {
  return {
    code: {
      'src/sum.mjs': { R1: SUM_MJS },
      'src/tally.mjs': { R3: TALLY_MJS },
      'server.mjs': { R2: SERVER(SERVER_MJS), R4: SERVER(SERVER_MJS_STATS) },
    },
    checks: {
      'accept-r1': viaWrapper('sum'),
      'accept-r2': viaWrapper('service'),
      'accept-r3': viaWrapper('tally'),
      'accept-r4': viaWrapper('stats'),
      'integration-s1': viaWrapper('integration-lib'),
      'integration-s2': viaWrapper('integration'),
      'integration-s3': viaWrapper('integration-tally'),
      'integration-s4': viaWrapper('integration-stats'),
      smoke: { files: {}, run: ['--check', 'src/sum.mjs'] },
      lint: { files: { '.surety/checks/lint.mjs': CHECK_PROGRAMS['.surety/checks/lint.mjs'] }, run: ['.surety/checks/lint.mjs'] },
      // The target's variable and its URL use are the package's (verifier.target_variables), never this text's.
      operation: { files: { '.surety/checks/post-deploy/operation.mjs': targetFree(CHECK_PROGRAMS['.surety/checks/post-deploy/operation.mjs']) }, run: ['.surety/checks/post-deploy/operation.mjs'] },
    },
    corrections: {
      'accept-r2': { [T('service')]: CORRECTED_SERVICE_TEST },
      'accept-r4': Object.fromEntries(Object.entries(CORRECTED_R4_TESTS).filter(([p]) => p === T('stats'))),
      'integration-s4': Object.fromEntries(Object.entries(CORRECTED_R4_TESTS).filter(([p]) => p === T('integration-stats'))),
    },
  };
}

// ---- the retrofit journey's (M444's rehearsal; M408's Sums) ----------------------------------

import { WRAPPER as SUMS_WRAPPER } from '../project/reference.mjs';
import { ADOPTED, ADOPTED_HELPER_COPY, ADOPTED_SUM_TEST, CLAIMS as SUMS_CLAIMS, POST_DEPLOY as SUMS_POST_DEPLOY, R4_CHECK, REQUIREMENTS as SUMS_REQS, serviceCheck } from '../retrofit/products.mjs';
import { SERVER_MJS_FIXED } from '../retrofit/repo.mjs';

// The owner's confirmations (D6 §8.1 step 2; E141 item 4): R4 is the false
// README claim, answered `defect` and scheduled to phase 2.
export const SUMS_ANSWERS = Object.freeze({ R1: 'confirm', R2: 'confirm', R3: 'confirm', R4: 'defect' });

// What the owner says to the retrofit Spec Writer: the repository as it is,
// the README's claims set against the code (one false), each requirement's
// origin; the prototype tier.
export function sumsBrief() {
  return {
    project: 'Sums',
    owner: 'Sean',
    tier: 'prototype',
    spec_version: 1,
    purpose: 'Sums adds two numbers over HTTP. This specification describes the service as it is and what its owner intends.',
    non_goals: ['Authentication', 'Persistence'],
    users: 'A client asks the service for a sum.',
    requirements: SUMS_REQS.map((r) => ({ key: r.key, title: r.title, phase: r.phase, statement: r.statement, areas: [], origin: r.origin, criteria: r.criteria.map((c) => ({ ...c })) })),
    modules: [
      { name: 'lib', paths: ['src/'], areas: [] },
      { name: 'service', paths: ['server.mjs'], areas: [] },
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
          'Excluded from the artifact': '`test/`',
          'Required post-deploy behaviour check': 'GET /sum?a=2&b=3 answers 200 {"sum": 5}',
          'Stable arguments': 'the service does not change its process title or arguments',
        },
      },
    ],
    constraints: ["Node's own modules only; no package.json."],
    interfaces: 'HTTP on 127.0.0.1:$PORT; JSON bodies; no persistent data.',
    questions: [],
    claims: SUMS_CLAIMS.map((c) => ({ ...c })),
    no_area_words: 'no sensitive area',
  };
}

// What the owner says to the retrofit Architect: the modules as they are,
// each interface citing the requirements it serves, the reconstructed ADR,
// the conformance phase and the change phase.
export function sumsArchitecture() {
  return {
    architecture: 'Two modules, reconstructed from the code: `lib` (`src/sum.mjs`) and `service` (`server.mjs`, Node\'s own http).',
    modules: [
      { name: 'lib', paths: ['src/'], sensitive_areas: [], requirements: ['R1'], interfaces: [{ name: 'sum', kind: 'module', path: 'src/sum.mjs', description: 'R1: export const sum = (a, b) => number' }] },
      { name: 'service', paths: ['server.mjs'], sensitive_areas: [], requirements: ['R2', 'R3', 'R4'], interfaces: [{ name: 'routes', kind: 'http', path: 'server.mjs', description: 'R2: GET /sum?a&b answers {"sum": n}; R3: GET /health answers {"ok": true}; R4: 400 on a non-number' }] },
    ],
    mapping: [
      { spec_module: 'lib', to: ['lib'] },
      { spec_module: 'service', to: ['service'] },
    ],
    adrs: [{ key: 'ADR-001', title: "Node's own http, no dependency", status: 'accepted', reconstructed: true, context: 'Reconstructed from the code: the service imports nothing but Node\'s own modules.', decision: "The service uses Node's own `http` module and no dependency.", consequences: 'Routing is a small switch on the path.' }],
    phases: [
      { number: 1, goal: 'conformance: the adopted code through the protected acceptance path to Alpha, unchanged', modules: ['lib', 'service'], requirements: ['R1', 'R2', 'R3'], depends_on: [] },
      { number: 2, goal: 'refuse a non-number', modules: ['service'], requirements: ['R4'], depends_on: [1] },
    ],
    conformance_phase: 1,
    obligations: { service: ['server.mjs keeps its start command'] },
  };
}

const SW = '.surety/checks/wrapper.mjs';
const sumsTest = (name, title, requests) => ({ files: { [SW]: SUMS_WRAPPER, [`.surety/checks/tests/${name}.test.mjs`]: serviceCheck(title, requests) }, run: [SW, `.surety/checks/tests/${name}.test.mjs`] });

export function sumsContent() {
  const r4 = Object.entries(R4_CHECK).find(([p]) => p.endsWith('.test.mjs'));
  return {
    code: { 'server.mjs': { R4: SERVER_MJS_FIXED } },
    checks: {
      'accept-r1': { files: { [SW]: SUMS_WRAPPER, '.surety/checks/tests/sum.test.mjs': ADOPTED_SUM_TEST.replace(/\.\/helpers\/expect\.mjs|\.\.\/adopted\/helpers\/expect\.mjs/g, '../adopted/helpers/expect.mjs'), '.surety/checks/adopted/helpers/expect.mjs': ADOPTED_HELPER_COPY }, run: [SW, '.surety/checks/tests/sum.test.mjs'] },
      'accept-r2': sumsTest('sum-route', 'R2.1: GET /sum?a=2&b=3 answers 200 {"sum": 5}', [{ path: '/sum?a=2&b=3', status: 200, body: { sum: 5 } }]),
      'accept-r3': sumsTest('health', 'R3.1: GET /health answers 200 {"ok": true}', [{ path: '/health', status: 200, body: { ok: true } }]),
      'accept-r4': { files: { [SW]: SUMS_WRAPPER, [r4[0]]: r4[1] }, run: [SW, r4[0]] },
      smoke: { files: {}, run: ['--check', 'server.mjs'] },
      operation: { files: { '.surety/checks/post-deploy/operation.mjs': targetFree(SUMS_POST_DEPLOY) }, run: ['.surety/checks/post-deploy/operation.mjs'] },
    },
    // The owner's criteria for a descriptive requirement a scoped replan touches (M414's R1).
    descriptive_criteria: { R1: 'Give R1 its criterion R1.1: sum(2, 3) returns 5.' },
    adopt: [
      {
        key: 'accept-r1',
        from: ADOPTED.from,
        to: ADOPTED.to,
        criteria: ADOPTED.criteria,
        dependency_boundary: ADOPTED.dependency_boundary,
        files: { [SW]: SUMS_WRAPPER, [ADOPTED.to]: ADOPTED_SUM_TEST, '.surety/checks/adopted/helpers/expect.mjs': ADOPTED_HELPER_COPY },
        run: [SW, ADOPTED.to],
      },
    ],
    corrections: {},
  };
}
