// Developer tests for the deployment compatibility and the build's deploy
// readiness (the owner's instruction of 2026-10-29: "Before a build begins,
// Surety should establish that the selected target can host the intended
// output, or clearly explain the missing capability. 'Build complete' must
// distinguish completed implementation from readiness to deploy." and
// "Hosted deployment should be required only for outputs that need
// hosting."; the static-preview shapes, §5).
//
// Against a scratch store (foreign keys off, the rows the minimum the code
// reads) and scratch git repositories. The output kind from the approved
// specification and architecture, and from a candidate's tree, with the
// tree deciding; the compatibility recorded at a plan's publication (the
// main-thread path, deploy/compatibility-eval.ts, through a runtime stand-in
// that calls the store functions), at a configuration (the transition
// itself, writeConfigVersion), its event once per evaluation; the project
// read's `deployment_compatibility` and `build.deploy_readiness`; NOW's
// build_complete text and primary action in each readiness state; a store
// that cannot be read gives unknown with why.
//
// Every configuration's content is validated by validateConfig, as the
// route does: §2's `mode: 'static'` (merged from build/static-preview) and
// the service mode. The adapter read's modes and outputs, the validation's
// modes and the compatibility's are one table (deploy/capabilities.ts).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { writeConfigVersion } = await import(join(dist, 'store', 'transitions', 'deploy.js'));
const { validateConfig } = await import(join(dist, 'deploy', 'config.js'));
const { readProject, listProjects, readOneEnvironment } = await import(join(dist, 'store', 'projections.js'));
const { architectureKind, treeKind, readTreeKind, OUTPUT_KINDS } = await import(join(dist, 'deploy', 'output-kind.js'));
const { recordCompatibility, compatibilityTarget } = await import(join(dist, 'deploy', 'compatibility.js'));
const { treesForRead, candidateTree } = await import(join(dist, 'deploy', 'compatibility-eval.js'));
const { registerPlan } = await import(join(dist, 'store', 'transitions', 'work.js'));
const { intendNomination } = await import(join(dist, 'store', 'transitions', 'accept.js'));
const { executionInputsDigest } = await import(join(dist, 'plan', 'check.js'));
const { ADAPTER_CAPABILITIES, modesOf, HOSTING_REQUIRED } = await import(join(dist, 'deploy', 'capabilities.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { CONFIG_MODES } = await import(join(dist, 'deploy', 'static-site.js'));
const { adapterRead } = await import(join(dist, 'deploy', 'adapter-read.js'));
const { candidateKind } = await import(join(dist, 'deploy', 'compatibility.js'));

setEngineSettings({ lease_ttl: 90, git_deadline: 60, decision_targets: {} });

const AT = '2026-10-29T00:00:00.000Z';
const HEX = 'a'.repeat(64);
const scratch = (t, tag) => {
  const dir = mkdtempSync(join(tmpdir(), `surety-ready-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
configureGit({ deadlineSeconds: 30, outputCap: 1 << 20, home: mkdtempSync(join(tmpdir(), 'surety-ready-git-')), incarnation: 'inc_test' });

// ---- fixtures ---------------------------------------------------------------------------

// A browser app: one ui module targeting the web with HTML/CSS, a library
// beside it; the specification's environment states no server runtime.
const BROWSER_MAP = {
  version: 1,
  modules: [
    { name: 'app', paths: ['index.html', 'src/'], sensitive_areas: [], interfaces: [], surface: 'ui', targets: [{ target: 'web', ui_technology: 'three_js' }] },
    { name: 'physics', paths: ['src/physics/'], sensitive_areas: [], interfaces: [{ name: 'step', kind: 'module', description: 'one step' }], surface: 'library' },
  ],
  mapping_from_spec: [],
};
const NODE_MAP = {
  version: 1,
  modules: [{ name: 'api', paths: ['server.mjs'], sensitive_areas: [], interfaces: [{ name: 'notes', kind: 'http', path: '/notes', description: 'the notes' }], surface: 'api' }],
  mapping_from_spec: [],
};
const spec = ({ runtime = null, targets = ['web'] } = {}) => ({
  header: { spec_version: 1, status: 'approved', tier: 'T2', owner: 'o' },
  requirements: [],
  index: [],
  questions: [],
  modules: [],
  claims: [],
  environments: [{ name: 'alpha', fields: { Purpose: 'Alpha', ...(runtime === null ? {} : { 'Runtime and start command': runtime }) } }],
  ...(targets === null ? {} : { targets }),
});

function store(t) {
  const dir = scratch(t, 'store');
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management)
     VALUES ('prj_1', ?, 'p', 'T2', ?, 'main', 'spec_ready', 'registered', '{}')`,
  ).run(AT, join(dir, 'repo-missing'));
  return db;
}

// The approved specification and architecture (their latest revisions).
function approve(db, { rep, map }) {
  if (rep) {
    db.prepare(`INSERT INTO spec_semantics (id, created_at, project, git_blob, representation, readable) VALUES ('ss_1', ?, 'prj_1', 'b', ?, 1)`).run(AT, JSON.stringify(rep));
    db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, semantics, approved_by, approved_at) VALUES ('sr_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'b', 'd', 'ss_1', 'human', ?)`).run(AT, AT);
  }
  if (map) {
    db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('ar_1', ?, 'prj_1', 1, '{}', ?, '[]', 'human', ?)`).run(AT, JSON.stringify(map), AT);
  }
}

// The environment the approved specification named, not configured (as the
// spec approval makes it: no prefix, adapter none).
function specEnvironment(db, name = 'alpha') {
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES (?, ?, 'prj_1', ?, 'none', 'spec', '{}')`).run(`env_${name}`, AT, name);
}

const SERVICE_CONTENT = { adapter: 'local_service', adapter_version: '1', targets: ['alpha'], runtime: { path: '/usr/bin/node', sha256: HEX }, start: ['node', 'server.mjs'], port: 8080 };
// §2's static mode, validated: no start; the static root and entry defaulted.
const { start: _start, ...NO_START } = SERVICE_CONTENT;
const STATIC_CONTENT = validateConfig({ ...structuredClone(NO_START), mode: 'static' });

// PUT …/config through the transition (the route validates first).
function configure(db, name, content, tree = null) {
  return transact(db, { actor_kind: 'human', actor_id: 'owner', request_id: null }, (tx) =>
    writeConfigVersion(tx, { project: 'prj_1', name, content, identity: `sha256:${JSON.stringify(content).length}${name}${content.mode ?? ''}`, secretDigests: [], homeHash: 'abcdefabcdef', tree }),
  );
}

function candidate(db, id, seq, revision) {
  db.prepare(`UPDATE candidates SET superseded_by = ? WHERE project = 'prj_1' AND superseded_by IS NULL`).run(id);
  db.prepare(
    `INSERT INTO candidates (id, created_at, project, seq, revision, lineage, nominated_at, nominated_by, progress, held_work) VALUES (?, ?, 'prj_1', ?, ?, 'lin_1', ?, 'engine_cadence', 'developing', '[]')`,
  ).run(id, AT, seq, revision, AT);
}

// A completed build: every roadmap phase's plan completed.
function completeBuild(db) {
  db.prepare(`INSERT INTO roadmap_revisions (id, created_at, project, version, git_path, git_blob, phases, approved_by, approved_at) VALUES ('rm_1', ?, 'prj_1', 1, 'r', 'b', ?, 'human', ?)`).run(AT, JSON.stringify([{ number: 1 }]), AT);
  db.prepare(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, status, completed_at) VALUES ('plan_1', ?, 'prj_1', 1, ?, 'p1.json', 1, 1, 'completed', ?)`).run(AT, 'a'.repeat(40), AT);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// A repository whose one commit holds `files`; its revision.
function repoWith(t, files) {
  const dir = scratch(t, 'repo');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c');
  return { dir, revision: git(dir, 'rev-parse', 'HEAD') };
}

// The main thread's reads, standing in: they go to the store functions the
// worker runs.
const runtimeOf = (db) => ({
  read: async (name, args) => {
    if (name === 'deploy.compatibility_target') return compatibilityTarget(db, args);
    throw new Error(`unexpected read ${name}`);
  },
  setting: () => 30,
});

// A plan published (the publication's transaction, registerPlan).
const stage = { number: 1, goal: 'g', tasks: ['t'], modules: ['app'], implements: [], adrs: [], depends_on: [], validation: { criteria: [], kinds: ['acceptance'], sensitive_areas: [] }, integration_obligations: [] };
const publishPlan = (db) =>
  transact(db, ENGINE_ACTOR, (tx) =>
    registerPlan(
      tx,
      { project: 'prj_1', baseRevision: 'h', authority: { kind: 'publication', by: 'human', bundle: 'b1', check: null, routing: 'human' }, phase: 1, stages: [{ ...stage, execution_inputs_digest: executionInputsDigest(stage) }], prepared: { spec: null, architecture: null, roadmap: null } },
      {},
    ),
  );

// A nomination's evaluation as its finalizer makes it: the tree read on
// the main thread before the intent, recorded in the transaction.
const nominationEvaluation = (db, tree) => transact(db, ENGINE_ACTOR, (tx) => recordCompatibility(tx, { project: 'prj_1', trigger: 'candidate_nominated', tree }));

const events = (db) => db.prepare(`SELECT payload FROM events WHERE type = 'deployment.compatibility_evaluated' ORDER BY seq`).all().map((e) => JSON.parse(e.payload));
const rows = (db) => db.prepare('SELECT COUNT(*) AS n FROM deployment_compatibility').get().n;
const read = (db, trees) => readProject(db, { project: 'prj_1', ...(trees ? { trees } : {}) }).project;

// ---- the output kind ----------------------------------------------------------------------

test('the output kinds and the capabilities table: local_service in service mode hosts a Node service, in static mode a static site', () => {
  assert.deepEqual([...OUTPUT_KINDS], ['static_site', 'node_service', 'unknown']);
  assert.deepEqual(modesOf('local_service'), ['service', 'static']);
  assert.equal(modesOf('kubernetes'), null);
  assert.deepEqual(ADAPTER_CAPABILITIES.local_service.outputs, [{ kind: 'node_service', hosted: true }, { kind: 'static_site', hosted: true, downloadable: true }]);
  assert.deepEqual(HOSTING_REQUIRED, { static_site: false, node_service: true, unknown: null });
});

test('one table: the configuration validation\'s modes and the adapter read\'s modes and outputs are the capabilities table\'s', async () => {
  assert.deepEqual([...CONFIG_MODES], modesOf('local_service'));
  const read = await adapterRead({ read: async () => ({ status: 'none', id: null, at: null }) }, 'local_service');
  assert.deepEqual(read.modes, modesOf('local_service'));
  assert.deepEqual(read.outputs, ADAPTER_CAPABILITIES.local_service.outputs);
  assert.throws(() => validateConfig({ ...structuredClone(SERVICE_CONTENT), mode: 'kubernetes' }), /mode/);
});

test('the output kind from the approved specification and architecture: a browser app is a static site, a Node service is one, silence is unknown', () => {
  const browser = architectureKind({ spec: spec(), map: BROWSER_MAP });
  assert.deepEqual(browser, {
    kind: 'static_site',
    reason: "The approved architecture's ui module app targets the web browser (three_js), no module is a service, and the approved specification names no server runtime.",
  });
  const node = architectureKind({ spec: spec({ runtime: '`node server.mjs`' }), map: NODE_MAP });
  assert.deepEqual(node, { kind: 'node_service', reason: 'The approved specification\'s environment alpha states the runtime and start command "`node server.mjs`", which names Node.' });
  assert.deepEqual(architectureKind({ spec: null, map: null }), { kind: 'unknown', reason: 'No approved specification or architecture states what the build produces.' });
  // A service module whose runtime nothing names: not guessed.
  assert.equal(architectureKind({ spec: spec(), map: NODE_MAP }).kind, 'unknown');
  assert.match(architectureKind({ spec: spec(), map: NODE_MAP }).reason, /names the service module api, and neither it nor the approved specification names the runtime/);
  // A runtime that is neither Node nor static.
  assert.match(architectureKind({ spec: spec({ runtime: 'python app.py' }), map: BROWSER_MAP }).reason, /names neither Node nor a static site/);
  // A runtime statement that says static files keeps the browser app static.
  assert.equal(architectureKind({ spec: spec({ runtime: 'none: static files' }), map: BROWSER_MAP }).kind, 'static_site');
  // A specification with no architecture, a native target, a framework: unknown.
  assert.equal(architectureKind({ spec: spec(), map: null }).kind, 'unknown');
  assert.equal(architectureKind({ spec: spec({ targets: ['web', 'ios'] }), map: BROWSER_MAP }).kind, 'unknown');
  const rn = { ...BROWSER_MAP, modules: [{ ...BROWSER_MAP.modules[0], targets: [{ target: 'web', ui_technology: 'streamlit' }] }] };
  assert.match(architectureKind({ spec: spec(), map: rn }).reason, /app \(web, streamlit\) are not a web browser/);
});

test('the output kind from a tree: index.html at the root is a static site, a start script a Node service, neither unknown', () => {
  const where = 'The tree of candidate c at abc1234';
  assert.deepEqual(treeKind({ indexHtml: true, packageJson: null }, where), { kind: 'static_site', reason: `${where} has index.html at its root and no package.json.` });
  assert.deepEqual(treeKind({ indexHtml: true, packageJson: '{"name":"x","scripts":{"test":"node --test"}}' }, where), { kind: 'static_site', reason: `${where} has index.html at its root and no package.json start script.` });
  assert.deepEqual(treeKind({ indexHtml: true, packageJson: '{"scripts":{"start":"node server.mjs"}}' }, where), { kind: 'node_service', reason: `${where} has a package.json start script ("node server.mjs").` });
  assert.deepEqual(treeKind({ indexHtml: false, packageJson: null }, where), { kind: 'unknown', reason: `${where} has neither index.html at its root nor a package.json start script.` });
  assert.equal(treeKind({ indexHtml: true, packageJson: '{not json' }, where).kind, 'unknown');
});

test("a candidate's tree is read from the object store at its revision, not from the work tree", async (t) => {
  const site = repoWith(t, { 'index.html': '<!doctype html>', 'src/main.js': '' });
  const answer = await readTreeKind(site.dir, site.revision);
  assert.deepEqual(answer, { revision: site.revision, kind: 'static_site', reason: `The candidate's tree at ${site.revision.slice(0, 7)} has index.html at its root and no package.json.` });
  // The work tree changed after the commit says nothing of the revision.
  writeFileSync(join(site.dir, 'package.json'), '{"scripts":{"start":"node x"}}');
  rmSync(join(site.dir, 'index.html'));
  assert.equal((await readTreeKind(site.dir, site.revision)).kind, 'static_site');
  const service = repoWith(t, { 'package.json': '{"scripts":{"start":"node server.mjs"}}', 'server.mjs': '' });
  assert.equal((await readTreeKind(service.dir, service.revision)).kind, 'node_service');
  const neither = repoWith(t, { 'README.md': 'x', 'web/index.html': '' });
  assert.equal((await readTreeKind(neither.dir, neither.revision)).kind, 'unknown');
  // A revision the repository does not have: not read, with why.
  const missing = await readTreeKind(site.dir, 'b'.repeat(40));
  assert.equal(missing.kind, undefined);
  assert.match(missing.unread, /^git ls-tree failed/);
});

test("the candidate's tree decides over the architecture, and the disagreement is the reason", async (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  const service = repoWith(t, { 'index.html': '', 'package.json': '{"scripts":{"start":"node server.mjs"}}' });
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(service.dir);
  candidate(db, 'cand_1', 1, service.revision);
  const trees = await treesForRead(runtimeOf(db), 'prj_1');
  const c = read(db, trees).deployment_compatibility;
  assert.equal(c.output_kind, 'node_service');
  assert.equal(
    c.reason,
    `The candidate's tree at ${service.revision.slice(0, 7)} has a package.json start script ("node server.mjs"). The approved architecture says otherwise (The approved architecture's ui module app targets the web browser (three_js), no module is a service, and the approved specification names no server runtime); the candidate's tree decides. A Node service needs hosting to run.`,
  );
  assert.equal(c.hosting_required, true);
  // No tree given to a read and none recorded: unknown, said so, never the architecture's answer.
  const unread = read(db).deployment_compatibility;
  assert.equal(unread.output_kind, 'unknown');
  assert.match(unread.reason, /^The tree of candidate cand_1 at [0-9a-f]{7} has not been read, so what it holds is not known\./);
});

// ---- the compatibility, recorded --------------------------------------------------------

test('recorded at the plan publication with the environment unconfigured: unconfigured, hosting not required for a static site, one event', (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  // A read before any evaluation computes the answer and writes nothing.
  const before = read(db).deployment_compatibility;
  assert.equal(before.output_kind, 'static_site');
  assert.equal(rows(db), 0, 'a read records nothing');
  assert.equal(events(db).length, 0, 'a read emits nothing');
  publishPlan(db);
  const c = read(db).deployment_compatibility;
  assert.deepEqual(
    { ...c, evaluated_at: null },
    {
      evaluated_at: null,
      output_kind: 'static_site',
      environments: [{ environment: 'env_alpha', name: 'alpha', adapter: null, mode: null, state: 'unconfigured', missing_capability: null, reason: 'alpha has no configuration: no adapter or mode is chosen for it yet.' }],
      hosting_required: false,
      reason:
        "The approved architecture's ui module app targets the web browser (three_js), no module is a service, and the approved specification names no server runtime. A static site needs no hosting: a download suffices.",
    },
  );
  assert.equal(rows(db), 1);
  assert.deepEqual(events(db), [{ evaluation: db.prepare('SELECT id FROM deployment_compatibility').get().id, trigger: 'plan_published', candidate: null, output_kind: 'static_site', hosting_required: false, environments: [{ environment: 'env_alpha', state: 'unconfigured' }] }]);
  // Read again: the recorded evaluation, nothing more written.
  assert.deepEqual(read(db).deployment_compatibility, c);
  assert.equal(rows(db), 1);
  // Not blocked: no decision, no hold.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 0);
  // The environment's own read serves its entry.
  const env = readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.deployment_compatibility;
  assert.deepEqual(env.environments, c.environments);
  assert.equal(env.output_kind, 'static_site');
});

test('configured in service mode for a static site: unsupported, naming the missing capability; in static mode: hostable; each configuration one evaluation', (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  let c = read(db).deployment_compatibility;
  assert.deepEqual(c.environments, [
    {
      environment: 'env_alpha',
      name: 'alpha',
      adapter: 'local_service',
      mode: 'service',
      state: 'unsupported',
      missing_capability: 'local_service in service mode hosts a Node service started from the artifact; this output is a static site: configure the environment in static mode',
      reason:
        'alpha is configured for local_service in service mode, which cannot host this output: local_service in service mode hosts a Node service started from the artifact; this output is a static site: configure the environment in static mode.',
    },
  ]);
  assert.deepEqual(events(db).map((e) => [e.trigger, e.environments[0].state]), [['environment_configured', 'unsupported']]);
  // §2's static mode, validated (its root and entry filled in).
  assert.deepEqual(STATIC_CONTENT.static, { root: '.', entry: 'index.html' });
  configure(db, 'alpha', STATIC_CONTENT);
  c = read(db).deployment_compatibility;
  assert.deepEqual(c.environments.map((e) => [e.mode, e.state, e.missing_capability, e.reason]), [['static', 'hostable', null, 'alpha is configured for local_service in static mode, which hosts a static site.']]);
  assert.deepEqual(events(db).map((e) => [e.trigger, e.environments[0].state]), [['environment_configured', 'unsupported'], ['environment_configured', 'hostable']]);
  // The same content again writes no version and evaluates nothing.
  configure(db, 'alpha', STATIC_CONTENT);
  assert.equal(events(db).length, 2);
  // A Node service in static mode: unsupported the other way.
  // (New revisions: a revision's content never changes, and the basis names them.)
  db.prepare(`INSERT INTO architecture_revisions (id, created_at, project, version, blobs, module_map, mapping_from_spec, approved_by, approved_at) VALUES ('ar_2', ?, 'prj_1', 2, '{}', ?, '[]', 'human', ?)`).run(AT, JSON.stringify(NODE_MAP), AT);
  db.prepare(`INSERT INTO spec_semantics (id, created_at, project, git_blob, representation, readable) VALUES ('ss_2', ?, 'prj_1', 'b2', ?, 1)`).run(AT, JSON.stringify(spec({ runtime: '`node server.mjs`' })));
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, semantics, approved_by, approved_at) VALUES ('sr_2', ?, 'prj_1', 2, '.surety/spec/spec.md', 'b2', 'd2', 'ss_2', 'human', ?)`).run(AT, AT);
  assert.equal(
    read(db).deployment_compatibility.environments[0].missing_capability,
    "local_service in static mode serves the artifact's files with the engine's static server; this output is a Node service: configure the environment in service mode",
  );
});

test('a Node service configured in service mode through validated content: hostable', (t) => {
  const db = store(t);
  approve(db, { rep: spec({ runtime: '`node server.mjs`' }), map: NODE_MAP });
  specEnvironment(db);
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  const c = read(db).deployment_compatibility;
  assert.equal(c.output_kind, 'node_service');
  assert.equal(c.hosting_required, true);
  assert.deepEqual(c.environments.map((e) => [e.adapter, e.mode, e.state]), [['local_service', 'service', 'hostable']]);
});

test('an unknown output: every configured environment unknown, never hostable; hosting_required null', (t) => {
  const db = store(t);
  specEnvironment(db);
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  const c = read(db).deployment_compatibility;
  assert.equal(c.output_kind, 'unknown');
  assert.equal(c.hosting_required, null);
  assert.deepEqual(c.environments.map((e) => [e.state, e.missing_capability]), [['unknown', null]]);
  assert.equal(c.environments[0].reason, 'Whether alpha can host the output is unknown: the output kind is unknown (no approved specification or architecture states what the build produces).');
  assert.equal(c.reason, 'No approved specification or architecture states what the build produces. Whether it needs hosting is not known.');
});

test('a nomination evaluates with the new candidate\'s tree; the next read serves it without reading the tree again', async (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  const site = repoWith(t, { 'index.html': '' });
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(site.dir);
  candidate(db, 'cand_1', 1, site.revision);
  assert.equal(compatibilityTarget(db, { project: 'prj_1' }).tree_known, false);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  assert.deepEqual(events(db).map((e) => [e.trigger, e.candidate, e.output_kind]), [['candidate_nominated', 'cand_1', 'static_site']]);
  const target = compatibilityTarget(db, { project: 'prj_1' });
  assert.deepEqual([target.tree_known, target.current, target.recorded], [true, true, true]);
  assert.deepEqual(await treesForRead(runtimeOf(db), 'prj_1'), [], 'nothing to read for the read');
  assert.equal(read(db).deployment_compatibility.output_kind, 'static_site');
  // A configuration after it keeps the recorded tree (its transaction is given none).
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  assert.deepEqual(events(db).map((e) => [e.trigger, e.output_kind, e.environments[0].state]).at(-1), ['environment_configured', 'static_site', 'unsupported']);
});

// ---- deploy readiness and NOW -------------------------------------------------------------

const BUILD_DONE = 'The planned build and its automated gates are complete.';
const UNREAD_SERVING = "what follows a request could not be read (whether the engine's serving check is in place); the preview opens only once a deployment is verified";
const NOT_PROPOSED =
  "the engine's serving check has not been proposed yet; its proposal (made when the environment's static configuration is written), its approval, the deployment and its verification follow before the preview opens, and no deployment is made before the check is applied";
const THEN_VERIFIED = 'the deployment and its verification follow before the preview opens';

test('build.deploy_readiness is not_complete until the build is, whatever the environment', (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  const p = read(db);
  assert.deepEqual(p.build, { complete: false, completed_at: null, deploy_readiness: { state: 'not_complete', reason: 'The planned build is not complete, so there is nothing to deploy yet.', environment: 'alpha' } });
  assert.deepEqual(listProjects(db).projects[0].build, p.build, 'the list serves the same build fact');
  assert.notEqual(p.now.state, 'build_complete');
});

function builtStaticSite(t) {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  completeBuild(db);
  const site = repoWith(t, { 'index.html': '' });
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(site.dir);
  candidate(db, 'cand_1', 1, site.revision);
  return { db, site };
}

test('the build complete, its environment not configured: unconfigured, configure_environment; the text keeps implementation apart from deployment', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  const p = read(db);
  assert.deepEqual(p.build, { complete: true, completed_at: AT, deploy_readiness: { state: 'unconfigured', reason: 'The environment alpha is not configured for hosting yet.', environment: 'alpha' } });
  assert.deepEqual(p.now, { state: 'build_complete', primary_action: 'configure_environment', reason: `${BUILD_DONE} Its environment alpha is not configured for hosting yet.`, cause: null });
  // The list says the same.
  assert.deepEqual(listProjects(db).projects[0].now, p.now);
});

test('the build complete in service mode for a static site: unsupported, no primary action, the missing capability said', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  const p = read(db);
  const missing = 'local_service in service mode hosts a Node service started from the artifact; this output is a static site: configure the environment in static mode';
  assert.deepEqual(p.build.deploy_readiness, { state: 'unsupported', reason: `The environment alpha cannot host this output: ${missing}.`, environment: 'alpha' });
  assert.deepEqual(p.now, { state: 'build_complete', primary_action: null, reason: `${BUILD_DONE} Its environment alpha cannot host this output: ${missing}.`, cause: null });
});

test('the build complete in static mode: ready, deploy; the reason says where the engine\'s serving check stands', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  const READY = 'The environment alpha can host this output (static site) with local_service in static mode.';
  // No protected version: the serving check's state is not read, and said so;
  // what follows a request is then not known (null, never a guess).
  assert.deepEqual(read(db).build.deploy_readiness, {
    state: 'ready',
    reason: `${READY} Whether the engine's serving check is in place could not be read. Ready to request deployment, not verified and not open: ${UNREAD_SERVING}.`,
    environment: 'alpha',
    means: 'request_deployment',
    follows: null,
  });
  db.prepare(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots, effective_from) VALUES ('pv_1', ?, 'prj_1', 1, 'f1', 'initial', 'h', 'human', ?, 1, '[]', ?)`).run(AT, AT, AT);
  const p = read(db);
  // The owner's ruling of 2026-10-29: not yet proposed, `ready` means ready
  // to request deployment; the proposal, its approval and the
  // verification follow, and the text says so.
  assert.deepEqual(p.build.deploy_readiness, {
    state: 'ready',
    reason: `${READY} The engine's serving check has not been proposed yet. Ready to request deployment, not verified and not open: ${NOT_PROPOSED}.`,
    environment: 'alpha',
    means: 'request_deployment',
    follows: ['serving_check_proposal', 'approval', 'deployment', 'verification'],
  });
  assert.deepEqual(p.now, { state: 'build_complete', primary_action: 'deploy', reason: `${BUILD_DONE} It is ready to request deployment to alpha (static site, local_service static mode), not verified and not open: ${NOT_PROPOSED}.`, cause: null });
  assert.doesNotMatch(p.now.reason, /visual|human|production|accept|ready to open/i);
});

test('the build complete with an unknown output: unknown, no primary action, why said', async (t) => {
  const { db, site } = builtStaticSite(t);
  // A tree that is neither: the tree decides, unknown.
  const neither = repoWith(t, { 'README.md': '' });
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(neither.dir);
  candidate(db, 'cand_2', 2, neither.revision);
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)), await candidateTree(runtimeOf(db), 'prj_1'));
  const p = read(db);
  const tree = `the candidate's tree at ${neither.revision.slice(0, 7)} has neither index.html at its root nor a package.json start script`;
  assert.equal(p.deployment_compatibility.output_kind, 'unknown');
  assert.deepEqual(p.build.deploy_readiness.state, 'unknown');
  assert.deepEqual(p.now, {
    state: 'build_complete',
    primary_action: null,
    reason: `${BUILD_DONE} Whether alpha can host it is unknown: the output kind is unknown (${tree}. The approved architecture says otherwise (The approved architecture's ui module app targets the web browser (three_js), no module is a service, and the approved specification names no server runtime); the candidate's tree decides).`,
    cause: null,
  });
});

test('several environments: the first hostable is named; with none hostable, the first', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  specEnvironment(db, 'beta');
  configure(db, 'beta', validateConfig({ ...structuredClone(NO_START), targets: ['beta'], mode: 'static' }));
  assert.deepEqual(read(db).build.deploy_readiness, {
    state: 'ready',
    reason: `The environment beta can host this output (static site) with local_service in static mode. Whether the engine's serving check is in place could not be read. Ready to request deployment, not verified and not open: ${UNREAD_SERVING}.`,
    environment: 'beta',
    means: 'request_deployment',
    follows: null,
  });
  assert.equal(read(db).now.reason, `${BUILD_DONE} It is ready to request deployment to beta (static site, local_service static mode), not verified and not open: ${UNREAD_SERVING}.`);
  configure(db, 'beta', validateConfig({ ...structuredClone(SERVICE_CONTENT), targets: ['beta'] }));
  assert.deepEqual(read(db).build.deploy_readiness.environment, 'alpha', 'none hostable: the first');
});

test('no environment at all: unconfigured, configure_environment', async (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  completeBuild(db);
  const site = repoWith(t, { 'index.html': '' });
  db.prepare(`UPDATE projects SET dev_repo_path = ?`).run(site.dir);
  candidate(db, 'cand_1', 1, site.revision);
  const p = read(db, await treesForRead(runtimeOf(db), 'prj_1'));
  assert.deepEqual(p.deployment_compatibility.environments, []);
  assert.deepEqual(p.build.deploy_readiness, { state: 'unconfigured', reason: 'The project has no environment configured for hosting yet.', environment: null });
  assert.deepEqual([p.now.primary_action, p.now.reason], ['configure_environment', `${BUILD_DONE} It has no environment configured for hosting yet.`]);
});

test('a store that cannot be read for it: unknown with the reason, environments not read (null), never a default', async (t) => {
  const { db, site } = builtStaticSite(t);
  db.prepare('DROP TABLE deployment_compatibility').run();
  const p = read(db);
  assert.equal(p.deployment_compatibility.output_kind, 'unknown');
  assert.equal(p.deployment_compatibility.environments, null);
  assert.equal(p.deployment_compatibility.hosting_required, null);
  assert.match(p.deployment_compatibility.reason, /^The deployment compatibility cannot be evaluated: the store could not be read \(.*deployment_compatibility.*\)\.$/);
  assert.equal(p.build.deploy_readiness.state, 'unknown');
  assert.equal(p.build.deploy_readiness.environment, null);
  assert.deepEqual([p.now.state, p.now.primary_action], ['build_complete', null]);
  assert.match(p.now.reason, /^The planned build and its automated gates are complete\. Whether it can be deployed is unknown: the deployment compatibility cannot be evaluated: the store could not be read \(/);
});

test("a nomination's intent freezes the revision's tree as read before it, for its finalizer's evaluation; a tree of another revision is not taken", (t) => {
  const db = store(t);
  const R = 'c'.repeat(40);
  const due = (revision) => db.prepare(`UPDATE projects SET nomination_due = ?`).run(JSON.stringify({ revision, by: 'engine_cadence', chain: 1 }));
  const intend = (tree) => transact(db, ENGINE_ACTOR, (tx) => intendNomination(tx, { project: 'prj_1', deadlineSeconds: 60, tree }));
  const inputsOf = (op) => JSON.parse(db.prepare('SELECT finalizer_inputs FROM operations WHERE id = ?').get(op).finalizer_inputs);
  due(R);
  const tree = { revision: R, kind: 'static_site', reason: 'r' };
  const first = intend(tree);
  assert.deepEqual(inputsOf(first.operation).output_tree, tree);
  due('d'.repeat(40));
  const second = intend(tree);
  assert.equal(inputsOf(second.operation).output_tree, undefined);
});

test("the candidate's output kind for the deliverable: the one an evaluation recorded from its tree, else none (the sealed tree's then)", async (t) => {
  const db = store(t);
  const site = repoWith(t, { 'index.html': '' });
  candidate(db, 'cand_1', 1, site.revision);
  assert.equal(candidateKind(db, { project: 'prj_1', candidate: 'cand_1' }), null, 'no evaluation: null');
  nominationEvaluation(db, { revision: site.revision, unread: 'git failed' });
  assert.equal(candidateKind(db, { project: 'prj_1', candidate: 'cand_1' }), null, 'a tree not read: null, never a guess');
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  assert.equal(candidateKind(db, { project: 'prj_1', candidate: 'cand_1' }), 'static_site');
  assert.equal(candidateKind(db, { project: 'prj_other', candidate: 'cand_1' }), null, "another project's path: null");
});

// ---- the integration candidate's engine findings (laplab-validation E1 to E4; RECORD-engine item 3) ----

const { phaseStep } = await import(join(dist, 'plan', 'phase.js'));

const decisionRow = (db, id, subject, status = 'open') =>
  db
    .prepare(
      `INSERT INTO decisions (id, created_at, project, seq, kind, subject_type, subject_id, semantic_generation, scope, question, options, dependency_manifest, transition_schema_version, preview_hash, evidence, blocked_while_open, raised_at, status)
       VALUES (?, ?, 'prj_1', 1, 'check_correction_tightening', 'protected_proposal', ?, 1, 'subject', 'q', '[]', '{}', 1, 'h', '[]', '{}', ?, ?)`,
    )
    .run(id, AT, subject, AT, status);
const effectiveV1 = (db) =>
  db.prepare(`INSERT INTO protected_versions (id, created_at, project, seq, fingerprint, change_kind, approved_by, approver_authority, approved_at, authorized, roots, effective_from) VALUES ('pv_1', ?, 'prj_1', 1, 'f1', 'initial', 'h', 'human', ?, 1, '[]', ?)`).run(AT, AT, AT);
const engineProposal = (db, status) =>
  db.prepare(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, base_revision, tree_id, diff_hash, requested_change_kind, status) VALUES ('pp_1', ?, 'prj_1', 1, 'engine', 'b', 't', 'd', 'tightening', ?)`).run(AT, status);

test("E1: the engine's serving check proposed and not applied: blocked (never ready), naming the open decision; answer_decision, never deploy; ready once it is in place", async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  effectiveV1(db);
  engineProposal(db, 'awaiting_human');
  decisionRow(db, 'dec_1', 'pp_1');
  const HOST = 'The environment alpha can host this output (static site) with local_service in static mode';
  const WHAT = "the engine's serving check (proposal pp_1), which the deployment needs, is not applied yet";
  let p = read(db);
  assert.deepEqual(p.build.deploy_readiness, { state: 'blocked', reason: `${HOST}, but a deployment would be refused now: ${WHAT}: it waits for your answer on decision dec_1.`, environment: 'alpha', decision: 'dec_1' });
  assert.equal(p.now.state, 'waiting_on_you', 'the open decision is NOW');
  // Answered and approved, not yet applied: still blocked, no decision; NOW's second sentence says it.
  db.prepare(`UPDATE decisions SET status = 'answered' WHERE id = 'dec_1'`).run();
  db.prepare(`UPDATE protected_proposals SET status = 'approved' WHERE id = 'pp_1'`).run();
  p = read(db);
  assert.deepEqual(p.build.deploy_readiness, { state: 'blocked', reason: `${HOST}, but a deployment would be refused now: ${WHAT}: it is approved and is being applied.`, environment: 'alpha', decision: null });
  assert.deepEqual(p.now, { state: 'build_complete', primary_action: null, reason: `${BUILD_DONE} It cannot be deployed to alpha yet: ${WHAT}: it is approved and is being applied.`, cause: null });
  // Applied: the check is in the effective version, required in the alpha_complete scope: ready, deploy.
  db.prepare(`UPDATE protected_proposals SET status = 'applied' WHERE id = 'pp_1'`).run();
  db.prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_s', ?, 'prj_1', 'pv_1', 'surety-static-serving', 'post_deploy_serving', 1, '["alpha_complete"]', 'x', 'h', 'direct')`).run(AT);
  p = read(db);
  assert.equal(p.build.deploy_readiness.state, 'ready');
  assert.equal(p.build.deploy_readiness.decision, undefined, 'ready carries no decision member');
  assert.equal(p.now.primary_action, 'deploy');
});

test("E1: a project's own required post_deploy_behavior check meets the requirement: the engine's pending proposal does not block", async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  effectiveV1(db);
  engineProposal(db, 'approved');
  db.prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_b', ?, 'prj_1', 'pv_1', 'behaves', 'post_deploy_behavior', 1, '["alpha_complete"]', 'x', 'h', 'direct')`).run(AT);
  assert.equal(read(db).build.deploy_readiness.state, 'ready');
});

test("E1: the candidate's checks running again: blocked with the counts, no primary action; NOW is checking", async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  effectiveV1(db);
  db.prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_s', ?, 'prj_1', 'pv_1', 'surety-static-serving', 'post_deploy_serving', 1, '["alpha_complete"]', 'x', 'h', 'direct')`).run(AT);
  const ex = (id, key, status, n) =>
    db
      .prepare(
        `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
         VALUES (?, ?, 'prj_1', ?, ?, 'cand_1', 'r', 'pv_1', 'direct', ?, '{"source":"protected_application"}', ?, ?, ?)`,
      )
      .run(id, AT, `chk_${key}`, key, n, `tk_${n}`, status, AT);
  ex('cx_1', 'smoke', 'running', 1);
  ex('cx_2', 'acceptance', 'queued', 2);
  const p = read(db);
  assert.deepEqual(p.build.deploy_readiness, {
    state: 'blocked',
    reason: "The environment alpha can host this output (static site) with local_service in static mode, but a deployment would be refused now: the candidate's automated checks are running (0 of 2 completed); it can be requested once they pass.",
    environment: 'alpha',
    decision: null,
  });
  assert.equal(p.now.state, 'checking');
});

test("ready means ready to request deployment (the owner's ruling of 2026-10-29): the serving check in place, the deployment and its verification follow; the current candidate deployed there and verified, `verified`; never verified before", async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  effectiveV1(db);
  db.prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_s', ?, 'prj_1', 'pv_1', 'surety-static-serving', 'post_deploy_serving', 1, '["alpha_complete"]', 'x', 'h', 'direct')`).run(AT);
  const READY = 'The environment alpha can host this output (static site) with local_service in static mode.';
  const IN_PLACE = " The engine's serving check is in place: after deployment it verifies that the entry page and its assets are served from the artifact (serving verified, not functional or visual acceptance).";
  let p = read(db);
  assert.deepEqual(p.build.deploy_readiness, {
    state: 'ready',
    reason: `${READY}${IN_PLACE} Ready to request deployment, not verified and not open: ${THEN_VERIFIED}.`,
    environment: 'alpha',
    means: 'request_deployment',
    follows: ['deployment', 'verification'],
  });
  assert.equal(p.now.reason, `${BUILD_DONE} It is ready to request deployment to alpha (static site, local_service static mode), not verified and not open: ${THEN_VERIFIED}.`);
  assert.equal(p.now.primary_action, 'deploy', 'the request is the primary action');
  // A deployment of the current candidate applied there, not yet verified
  // (its request pending): still request_deployment, never verified.
  const env = db.prepare(`SELECT id FROM environments WHERE name = 'alpha' AND prefix IS NOT NULL`).get().id;
  db.prepare(`INSERT INTO deployment_requests (id, created_at, project, request_key, requested_by, candidate, environment, authorization, outcome) VALUES ('dreq_1', ?, 'prj_1', 'k1', 'human', 'cand_1', ?, 'auth_1', 'pending')`).run(AT, env);
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, authorization, finalized_at)
     VALUES ('op_d1', ?, 'prj_1', 1, 'deploy', ?, '{}', 'kd1', 1, 'in_progress', ?, 'auth_1', ?)`,
  ).run(AT, JSON.stringify({ environment: env }), AT, AT);
  assert.equal(read(db).build.deploy_readiness.means, 'request_deployment', 'applied, not verified: not verified');
  // Verified and completed: the request deployed, the candidate alpha_deployed.
  db.prepare(`UPDATE deployment_requests SET outcome = 'deployed' WHERE id = 'dreq_1'`).run();
  db.prepare(`UPDATE candidates SET progress = 'alpha_deployed' WHERE id = 'cand_1'`).run();
  p = read(db);
  assert.deepEqual([p.build.deploy_readiness.state, p.build.deploy_readiness.means, p.build.deploy_readiness.follows], ['ready', 'verified', ['deployment', 'verification']]);
  assert.match(p.build.deploy_readiness.reason, /Ready: the current candidate cand_1 is deployed there and its deployment was verified by its automated checks \(serving verified, not functional or visual acceptance\); a request deploys it again, and that deployment is verified in turn\.$/);
});

test("ready for another output kind: with no deployment-specific post-deploy check, a request asks a Verifier to write it, and its approval, a request again, the deployment and its verification follow; with one, the deployment and its verification", (t) => {
  const db = store(t);
  approve(db, { rep: spec({ runtime: '`node server.mjs`' }), map: NODE_MAP });
  specEnvironment(db);
  completeBuild(db);
  configure(db, 'alpha', validateConfig(structuredClone(SERVICE_CONTENT)));
  effectiveV1(db);
  const AUTHOR =
    'the deployment-specific post-deploy check is not in place yet, so a request is refused naming it and asks a Verifier to write it; its approval, a request again, the deployment and its verification follow before the preview opens';
  let r = read(db).build.deploy_readiness;
  assert.deepEqual(r, {
    state: 'ready',
    reason: `The environment alpha can host this output (Node service) with local_service in service mode. Ready to request deployment, not verified and not open: ${AUTHOR}.`,
    environment: 'alpha',
    means: 'request_deployment',
    follows: ['deployment_checks_authoring', 'approval', 'request_again', 'deployment', 'verification'],
  });
  db.prepare(`INSERT INTO checks (id, created_at, project, protected_version, key, kind, required, gate_kinds, definition_path, definition_hash, runner_class) VALUES ('chk_b', ?, 'prj_1', 'pv_1', 'behaves', 'post_deploy_behavior', 1, '["alpha_complete"]', 'x', 'h', 'direct')`).run(AT);
  r = read(db).build.deploy_readiness;
  assert.deepEqual([r.means, r.follows], ['request_deployment', ['deployment', 'verification']]);
  assert.match(r.reason, new RegExp(`${THEN_VERIFIED}\\.$`));
});

test("open approvals first, build complete as its own fact (the owner's ruling of 2026-10-29): with a decision open NOW is waiting_on_you and says the build is complete after the decision sentence; build.complete and completed_at served in the read and the list", async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  effectiveV1(db);
  engineProposal(db, 'awaiting_human');
  decisionRow(db, 'dec_1', 'pp_1');
  const p = read(db);
  assert.deepEqual(p.now, { state: 'waiting_on_you', primary_action: 'answer_decision', reason: `One decision is waiting for your answer. ${BUILD_DONE}`, cause: null });
  assert.deepEqual([p.build.complete, p.build.completed_at, p.build.deploy_readiness.state], [true, AT, 'blocked']);
  const listed = listProjects(db).projects[0];
  assert.deepEqual([listed.now, listed.build], [p.now, p.build], 'the list says the same');
  // Not complete: the decision sentence alone.
  db.prepare(`UPDATE phase_plans SET completed_at = NULL, status = 'published'`).run();
  const q = read(db);
  assert.deepEqual([q.now.state, q.now.reason, q.build.complete, q.build.completed_at], ['waiting_on_you', 'One decision is waiting for your answer.', false, null]);
});

// An environment configured (service mode), with an installed observation
// made `ago` ms before now of generation 1, and the store's operation rows.
function observedEnvironment(db, { ago = 2000 } = {}) {
  configure(db, 'alpha', SERVICE_CONTENT);
  const env = db.prepare(`SELECT id FROM environments WHERE name = 'alpha' AND prefix IS NOT NULL`).get().id;
  const observedAt = new Date(Date.now() - ago).toISOString();
  const observed = { id: 'obsh_1', environment: env, condition: 'healthy', detail: null, observed_at: observedAt, source: 'observation_job', read_interval: { from: observedAt, to: observedAt }, expected_revision: 1, deployment_generation: 1, facts: {} };
  db.prepare(`INSERT INTO environment_records (id, created_at, project, environment, observed) VALUES ('er_1', ?, 'prj_1', ?, ?)`).run(AT, env, JSON.stringify(observed));
  db.prepare(`INSERT INTO observation_history (id, created_at, project, environment, observed_at, source, condition, detail, read_interval, expected_revision, deployment_generation, facts, installed) VALUES ('obsh_1', ?, 'prj_1', ?, ?, 'observation_job', 'healthy', NULL, '{}', 1, 1, '{}', 1)`).run(AT, env, observedAt);
  return { env, observedAt, observed };
}
let opSeq = 0;
function finalizedOperation(db, env, { kind, finalizedAt, generation }) {
  opSeq += 1;
  const id = `op_${kind}_${opSeq}`;
  db.prepare(
    `INSERT INTO operations (id, created_at, project, seq, kind, target, subject, idempotency_key, semantic_generation, status, deadline_at, finalizer_inputs, finalized_at)
     VALUES (?, ?, 'prj_1', ?, ?, ?, '{}', ?, 1, 'succeeded', ?, '{}', ?)`,
  ).run(id, AT, opSeq, kind, JSON.stringify({ environment: env }), `k${opSeq}`, AT, finalizedAt);
  db.prepare(`INSERT INTO operation_attempts (id, created_at, project, operation, attempt_number, status, started_at, deployment_generation, reconciliation_reads) VALUES (?, ?, 'prj_1', ?, 1, 'succeeded', ?, ?, '[]')`).run(`att_${opSeq}`, AT, id, AT, generation);
  return id;
}

test('E3: a finalized teardown ends the observation made before it at once: the environment read and the list say unknown, expired at the finalization, ended_by the teardown; the stored observation and its history untouched', (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  const { env, observedAt, observed } = observedEnvironment(db);
  // Before: fresh and healthy.
  assert.equal(readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.observed.condition, 'healthy');
  assert.equal(read(db).environments[0].state, 'healthy');
  const finalizedAt = new Date(Date.parse(observedAt) + 1000).toISOString();
  const op = finalizedOperation(db, env, { kind: 'teardown', finalizedAt, generation: 1 });
  const o = readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.observed;
  assert.equal(o.condition, 'unknown');
  assert.equal(o.stored_condition, 'healthy');
  assert.equal(o.freshness, 'expired');
  assert.equal(o.expires_at, finalizedAt);
  assert.equal(o.observed_at, observedAt, 'when it was observed is kept');
  assert.deepEqual({ kind: o.ended_by.kind, operation: o.ended_by.operation, finalized_at: o.ended_by.finalized_at }, { kind: 'teardown', operation: op, finalized_at: finalizedAt });
  assert.match(o.ended_by.reason, /before the teardown of alpha .* nothing deployed is available there until a new deployment\.$/);
  const listed = read(db).environments[0];
  assert.equal(listed.state, 'unknown');
  assert.equal(listed.observed.condition, 'unknown');
  assert.equal(listed.observed.freshness, 'expired');
  assert.equal(listed.observed.ended_by.kind, 'teardown');
  // Nothing written by the reads: the stored observation and the history as they were.
  assert.deepEqual(JSON.parse(db.prepare(`SELECT observed FROM environment_records WHERE environment = ?`).get(env).observed), observed);
  assert.equal(db.prepare(`SELECT condition FROM observation_history WHERE id = 'obsh_1'`).get().condition, 'healthy');
  // The next observation, made after the finalization, reads as any does.
  const next = { ...observed, id: 'obsh_2', condition: 'down', observed_at: new Date().toISOString() };
  db.prepare(`UPDATE environment_records SET observed = ? WHERE environment = ?`).run(JSON.stringify(next), env);
  const after = readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.observed;
  assert.equal(after.condition, 'down');
  assert.equal(after.freshness, 'fresh');
  assert.equal(after.ended_by, undefined);
});

test("E3: a replacement (a later deployment finalized) ends the earlier observation too; a finalization of an earlier generation's attempt, or one before the observation, does not", (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  const { env, observedAt } = observedEnvironment(db);
  const at = (ms) => new Date(Date.parse(observedAt) + ms).toISOString();
  finalizedOperation(db, env, { kind: 'deploy', finalizedAt: at(-500), generation: 1 });
  finalizedOperation(db, env, { kind: 'teardown', finalizedAt: at(500), generation: 0 });
  assert.equal(readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.observed.condition, 'healthy', 'neither ends it');
  const op = finalizedOperation(db, env, { kind: 'deploy', finalizedAt: at(800), generation: 2 });
  const o = readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.observed;
  assert.deepEqual([o.condition, o.freshness, o.ended_by.kind, o.ended_by.operation], ['unknown', 'expired', 'deployment', op]);
  assert.match(o.ended_by.reason, /replaced what ran: it describes what ran before, not what runs now/);
  assert.equal(read(db).environments[0].state, 'unknown');
});

test("E4: the environment read serves the open relay's bound address (host, port, url) as POST …/relay answers it; null when none is open", (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  configure(db, 'alpha', SERVICE_CONTENT);
  assert.equal(readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.relay, null);
  db.prepare(`UPDATE environments SET relay = ? WHERE name = 'alpha' AND prefix IS NOT NULL`).run(JSON.stringify({ attempt: 'att_1', generation: 1, port: 37361, opened_at: AT }));
  assert.deepEqual(readOneEnvironment(db, { project: 'prj_1', environment: 'alpha' }).environment.relay, { attempt: 'att_1', generation: 1, port: 37361, opened_at: AT, host: '127.0.0.1', url: 'http://127.0.0.1:37361/' });
});

test('E2: after the build is complete the engine evaluates a stale phase gate again by itself, once the candidate\'s checks have ended; never while they run, never a satisfied one', (t) => {
  const { db } = builtStaticSite(t);
  const step = () => transact(db, ENGINE_ACTOR, (tx) => phaseStep(tx, { project: 'prj_1' }));
  db.prepare(
    `INSERT INTO gate_evaluations (id, created_at, project, scope, candidate, gate_kind, computed_at, inputs_hash, inputs_snapshot, check_states, outcome, reasons, satisfiers, stale, phase_plan, plan_generation)
     VALUES ('ge_1', ?, 'prj_1', '{}', 'cand_1', 'phase', ?, 'h', '{}', '{}', 'satisfied', '[]', '[]', 0, 'plan_1', 1)`,
  ).run(AT, AT);
  assert.equal(step().evaluate, null, 'a current satisfied evaluation: nothing to do');
  db.prepare(`UPDATE gate_evaluations SET stale = 1 WHERE id = 'ge_1'`).run();
  db.prepare(
    `INSERT INTO check_executions (id, created_at, project, "check", key, candidate, source_revision, protected_version, runner_class, execution_seq, "trigger", trigger_key, status, registered_at)
     VALUES ('cx_1', ?, 'prj_1', 'chk_a', 'a', 'cand_1', 'r', 'pv_2', 'direct', 1, '{"source":"protected_application"}', 'tk', 'running', ?)`,
  ).run(AT, AT);
  assert.equal(step().evaluate, null, 'its checks still running: wait for their results');
  db.prepare(`UPDATE check_executions SET status = 'recorded' WHERE id = 'cx_1'`).run();
  assert.deepEqual(step().evaluate, { candidate: 'cand_1', phase_plan: 'plan_1' });
});

test('RECORD-engine item 3: a rapid prototype with its build complete and undeployed reads build_complete only when its iteration is simply built; its own status (limit_reached, stopped, discarded, failed, awaiting_*) is never hidden', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  db.prepare(`UPDATE projects SET mode = 'rapid_prototype'`).run();
  const iteration = (status, reason = null, next = null) => {
    db.prepare('DELETE FROM prototype_iterations').run();
    db.prepare(`INSERT INTO prototype_iterations (id, created_at, project, seq, mode, status, limits_json, outcome_reason, next_step) VALUES ('it_1', ?, 'prj_1', 1, 'rapid_prototype', ?, '{}', ?, ?)`).run(AT, status, reason, next);
  };
  iteration('alpha_ready');
  assert.equal(read(db).now.state, 'build_complete', 'built and not deployed: build_complete with the readiness sentence');
  assert.ok(read(db).now.reason.startsWith(`${BUILD_DONE} It is ready to request deployment to alpha`), read(db).now.reason);
  iteration('limit_reached', 'the token limit was reached', 'raise the limit or discard');
  assert.deepEqual(read(db).now, { state: 'idle', primary_action: null, reason: 'Prototype iteration 1 is limit_reached: the token limit was reached. Nothing more of it is dispatched; next: raise the limit or discard.', cause: null });
  iteration('discarded', 'discarded by the owner', 'none');
  assert.equal(read(db).now.state, 'idle');
  assert.match(read(db).now.reason, /^Prototype iteration 1 is discarded/);
  iteration('failed', 'a work item of it was parked', 'retry the parked work');
  assert.deepEqual(read(db).now, { state: 'idle', primary_action: null, reason: 'Prototype iteration 1 is failed: a work item of it was parked. Next: retry the parked work.', cause: null });
  iteration('awaiting_brief_approval');
  const n = read(db).now;
  assert.notEqual(n.state, 'build_complete');
  assert.match(n.reason, /^(Prototype iteration 1 is awaiting_brief_approval\.|The next run of prototype iteration 1 is held)/, n.reason);
  // A planned project keeps build_complete (no iteration).
  db.prepare(`UPDATE projects SET mode = 'planned'`).run();
  db.prepare('DELETE FROM prototype_iterations').run();
  assert.equal(read(db).now.state, 'build_complete');
});
