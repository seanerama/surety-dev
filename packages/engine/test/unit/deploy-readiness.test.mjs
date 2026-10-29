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
// The hostable static case: this branch has no static mode in the
// configuration's validation (§2 is the other slice's), so a version whose
// content carries `mode: 'static'` is written through the transition as §2's
// validation will admit it (not through validateConfig); hostable is also
// tested with a Node service in service mode through validated content.

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
// §2's static mode, as its validation will admit it: no start, the static root and entry.
const { start: _start, ...NO_START } = SERVICE_CONTENT;
const STATIC_CONTENT = { ...NO_START, mode: 'static', static: { root: '.', entry: 'index.html' } };

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
  // §2's static mode (written as its validation will admit it).
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

test('build.deploy_readiness is not_complete until the build is, whatever the environment', (t) => {
  const db = store(t);
  approve(db, { rep: spec(), map: BROWSER_MAP });
  specEnvironment(db);
  const p = read(db);
  assert.deepEqual(p.build, { complete: false, deploy_readiness: { state: 'not_complete', reason: 'The planned build is not complete, so there is nothing to deploy yet.', environment: 'alpha' } });
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
  assert.deepEqual(p.build, { complete: true, deploy_readiness: { state: 'unconfigured', reason: 'The environment alpha is not configured for hosting yet.', environment: 'alpha' } });
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

test('the build complete in static mode: ready, deploy', async (t) => {
  const { db, site } = builtStaticSite(t);
  nominationEvaluation(db, await readTreeKind(site.dir, site.revision));
  configure(db, 'alpha', STATIC_CONTENT);
  const p = read(db);
  assert.deepEqual(p.build.deploy_readiness, { state: 'ready', reason: 'The environment alpha can host this output (static site) with local_service in static mode.', environment: 'alpha' });
  assert.deepEqual(p.now, { state: 'build_complete', primary_action: 'deploy', reason: `${BUILD_DONE} It can be deployed to alpha (static site, local_service static mode).`, cause: null });
  assert.doesNotMatch(p.now.reason, /visual|human|production|accept/i);
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
  configure(db, 'beta', { ...STATIC_CONTENT, targets: ['beta'] });
  assert.deepEqual(read(db).build.deploy_readiness, { state: 'ready', reason: 'The environment beta can host this output (static site) with local_service in static mode.', environment: 'beta' });
  assert.equal(read(db).now.reason, `${BUILD_DONE} It can be deployed to beta (static site, local_service static mode).`);
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
