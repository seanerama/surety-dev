// Developer tests for what each role package states of what the engine
// reads (row M442; E135; src/packages/reads.ts): every element a package
// states is a fenced `json surety-reads <id>` block in its prompt.md, listed
// in its manifest's `reads`; the blocks alone suffice to write a product the
// engine's own parsers accept; the correction package carries no governed
// changes; the retrofit variants add the claims table and the adoption
// rule; a stage's Builder is told its tasks, what it implements, its
// obligations and its dependencies' interfaces; and the test seam's
// omission removes an element from the prompt, the block, the result schema
// and the manifest at once.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const { writeSessionPackage } = await import(join(dist, 'sessions', 'package.js'));
const { writeContextPackage } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { PACKAGE_ELEMENTS, ELEMENT_IDS, elementListing } = await import(join(dist, 'packages', 'elements.js'));
const { parseSpecification } = await import(join(dist, 'spec', 'semantics.js'));
const { parseModuleMap, parseRoadmap, parsePhasePlan, parseAdr, B5 } = await import(join(dist, 'plan', 'schemas.js'));
const { PLAN_REASONS } = await import(join(dist, 'plan', 'check.js'));
const { defaultGoverned, SENSITIVE_AREAS } = await import(join(dist, 'checks', 'schema.js'));
const { KIND_INVENTORY } = await import(join(dist, 'checks', 'scope.js'));
const { configureHarness, setPackageOmit } = await import(join(dist, 'testing', 'seam.js'));
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { contextFacts } = await import(join(dist, 'store', 'reads.js'));

const AT = '2026-10-14T00:00:00.000Z';
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Every `surety-reads` block of a prompt, by id.
function blocks(prompt) {
  const out = {};
  for (const m of prompt.matchAll(/^```json surety-reads ([a-z_.]+)\n([\s\S]*?)\n```$/gm)) out[m[1]] = JSON.parse(m[2]);
  return out;
}
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const manifest = (dir) => JSON.parse(read(dir, 'manifest.json'));

function session(t, role, { retrofit = false } = {}) {
  const dir = scratch(t);
  writeSessionPackage(dir, { run: 'run_s' }, {
    run: 'run_s',
    project: 'prj_1',
    role,
    turn: 1,
    paths: role === 'spec_writer' ? ['.surety/spec/'] : ['.surety/architecture/', '.surety/adrs/', '.surety/roadmap/', '.surety/phases/'],
    transcript: [{ turn: 1, speaker: 'owner', at: AT, text: 'Build me a greeter.' }],
    findings: [],
    approved: [],
    retrofit: retrofit ? { pinned_revision: 'a'.repeat(40), mode: 'full', paths: ['README.md'], total: 1 } : null,
  });
  return { dir, prompt: read(dir, 'prompt.md'), reads: blocks(read(dir, 'prompt.md')), manifest: manifest(dir) };
}

// A product written from the blocks and nothing else: what a rehearsal's
// fake does (BS5 §12), here for the engine's own parser.
function specFromBlocks(b, { claims = false } = {}) {
  const h = b['spec_writer.header_fields'].fields;
  const req = b['spec_writer.requirement_form'];
  const idx = b['spec_writer.index_columns'];
  const tier = b['spec_writer.tier_table'].tiers[1].tier;
  const area = b['spec_writer.sensitive_areas'].areas[0].id;
  const value = { 'Spec version': '1', Status: h.find((f) => f.name === 'Status').value, Tier: tier, Owner: 'Sean' };
  const fill = (form, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`<${k}>`, v), form);
  const lines = ['# Greeter', '', ...h.map((f) => `${f.line} ${value[f.name]}`), '', req.section, ''];
  lines.push(fill(req.heading, { n: '1', title: 'Greets' }), '', 'The greeter greets.', '', `${req.sensitive_areas} ${area}`, '', fill(req.criterion, { n: '1', m: '1', text: 'it says hello' }).replace('R1.<m>', 'R1.1').replace('<n>', '1'), '');
  lines.push(fill(req.heading, { n: '2', title: 'Is liked' }), '', 'People like it.', '', `${req.sensitive_areas} ${b['spec_writer.sensitive_areas'].none}`, '', b['spec_writer.marks'].human_test, '');
  const cols = idx.columns;
  lines.push(idx.section, '', `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
  lines.push(`| R1 | Greets | 1 | ${area} | R1.1 | ${idx.default_origin} |`, `| R2 | Is liked | 1 | none |  | ${idx.default_origin} |`, '');
  const mt = b['spec_writer.module_table'];
  lines.push(mt.section, '', `| ${mt.columns.join(' | ')} |`, `|${mt.columns.map(() => '---').join('|')}|`, '| greeter | src/ | none |', '');
  const env = b['spec_writer.environment_fields'];
  lines.push(env.section, '', env.heading.replace('<name>', 'alpha'), '', ...env.fields.map((f) => `- **${f}:** x`), '');
  const q = b['spec_writer.question_form'];
  lines.push(q.section, '', `${q.item.replace('<k>', '1').replace('<text>', 'Which language? Blocks R2.')} ${q.phase_hint.replace('<n>', '2')}`, '');
  if (claims) {
    const c = b['spec_writer.claims_table'];
    lines.push(c.section, '', `| ${c.columns.join(' | ')} |`, `|${c.columns.map(() => '---').join('|')}|`, `| README.md | greets | ${c.not_checked} | ${c.none} |`, '');
  }
  return lines.join('\n');
}

test("the Spec Writer's package states its forms as blocks, listed in the manifest, from which the engine's parser accepts a specification", (t) => {
  const s = session(t, 'spec_writer');
  assert.equal(s.manifest.package, 'spec_writer');
  assert.deepEqual(s.manifest.reads, [...PACKAGE_ELEMENTS.spec_writer]);
  assert.deepEqual(Object.keys(s.reads), [...PACKAGE_ELEMENTS.spec_writer], 'one block per stated element, in order');
  assert.equal(s.reads['spec_writer.claims_table'], undefined, 'the claims table is retrofit only');
  assert.deepEqual(s.reads['spec_writer.header_fields'], { fields: [{ name: 'Spec version', line: '**Spec version:**' }, { name: 'Status', line: '**Status:**', value: 'draft' }, { name: 'Tier', line: '**Tier:**' }, { name: 'Owner', line: '**Owner:**' }] });
  assert.deepEqual(s.reads['spec_writer.index_columns'].columns, ['Key', 'Title', 'Phase', 'Sensitive areas', 'Criteria', 'Origin']);
  assert.deepEqual(s.reads['spec_writer.sensitive_areas'].areas.map((a) => a.id), SENSITIVE_AREAS);
  assert.deepEqual(s.reads['spec_writer.tier_table'].tiers.map((x) => x.kinds), [KIND_INVENTORY.T1, KIND_INVENTORY.T2, KIND_INVENTORY.T3]);
  const codes = s.reads['spec_writer.approval_blockers'].blockers.map((x) => x.code);
  for (const c of ['spec_semantics_invalid', 'QUESTION_NO_PHASE_HINT', 'REQUIREMENT_NO_PHASE_HINT', 'QUESTION_BLOCKS_PHASE_1']) assert.ok(codes.includes(c), c);
  const parsed = parseSpecification(specFromBlocks(s.reads));
  assert.deepEqual(parsed.findings, [], 'a specification written from the blocks alone has no finding');
  assert.equal(parsed.representation.header.tier, 'T2');
  assert.deepEqual(parsed.representation.requirements.map((r) => [r.key, r.criteria.map((c) => c.id), r.human_test]), [['R1', ['R1.1'], false], ['R2', [], true]]);
  assert.equal(parsed.representation.environments[0].name, 'alpha');
  const r = session(t, 'spec_writer', { retrofit: true });
  assert.equal(r.manifest.package, 'spec_writer_retrofit');
  const rp = parseSpecification(specFromBlocks(r.reads, { claims: true }));
  assert.deepEqual(rp.findings, []);
  assert.equal(rp.representation.claims.length, 1, 'the claims table written from its block is read');
});

test("the Architect's package states B.3 to B.6 as closed JSON Schemas of the parsers' own fields, the plan check's reasons and the routing", (t) => {
  const a = session(t, 'architect');
  assert.equal(a.manifest.package, 'architect');
  assert.deepEqual(Object.keys(a.reads), [...PACKAGE_ELEMENTS.architect]);
  const plan = a.reads['architect.schema.phase_plan'];
  assert.equal(plan.file, '.surety/phases/phase-<n>.json');
  const stage = plan.schema.properties.stages.items;
  assert.deepEqual(Object.keys(stage.properties), [...B5.stage.fields]);
  assert.deepEqual(stage.required, [...B5.stage.required]);
  const closed = (s) => (s && typeof s === 'object' ? (s.type === 'object' ? s.additionalProperties === false : true) && Object.values(s.properties ?? {}).concat(s.items ? [s.items] : []).every(closed) : true);
  for (const id of ['architect.schema.modules', 'architect.schema.roadmap', 'architect.schema.phase_plan']) assert.ok(closed(a.reads[id].schema), `${id}: every object closed`);
  // Objects built from the schemas' required fields parse.
  const map = { version: 1, modules: [{ name: 'greeter', paths: ['src/'], sensitive_areas: [], interfaces: [{ name: 'greet', kind: 'module', path: 'src/greet.mjs', description: 'greets' }] }], mapping_from_spec: [{ spec_module: 'greeter', to: ['greeter'] }] };
  assert.equal(parseModuleMap(JSON.stringify(map)).ok, true);
  assert.equal(parseRoadmap(JSON.stringify({ version: 1, architecture_version: 1, phases: [{ number: 1, goal: 'g', modules: ['greeter'], requirement_ids: ['R1'], depends_on: [] }] })).ok, true);
  const p = { phase: 1, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'a'.repeat(40) }, stages: [{ number: 1, goal: 'g', tasks: ['t'], modules: ['greeter'], implements: ['R1'], adrs: [], depends_on: [], validation: { criteria: ['R1.1'], kinds: ['acceptance'], sensitive_areas: [] }, integration_obligations: [] }], conformance: 'within_baseline' };
  assert.equal(parsePhasePlan(JSON.stringify(p), '.surety/phases/phase-1.json', 1).ok, true);
  const adr = a.reads['architect.schema.adr'];
  const text = `---\nkey: ADR-001\nstatus: ${adr.front_matter.properties.status.enum[1]}\n---\n${adr.headings.map((h) => `## ${h}\n\nx\n`).join('\n')}`;
  assert.equal(parseAdr(text, '.surety/adrs/ADR-001.md').ok, true);
  const reasons = a.reads['architect.plan_reasons'].reasons.map((r) => r.code);
  assert.deepEqual(reasons, PLAN_REASONS.filter((c) => !['PLAN_DESCRIPTIVE_MODULE_TOUCHED', 'PLAN_CONFORMANCE_MISPLACED'].includes(c)));
  assert.ok(a.reads['architect.plan_reasons'].reasons.every((r) => typeof r.rule === 'string' && r.rule.length > 0));
  assert.deepEqual(a.reads['architect.routing'].registered, 'engine:plan_check');
  assert.deepEqual(a.reads['architect.routing'].human, 'plan_approval');
  const ar = session(t, 'architect', { retrofit: true });
  assert.equal(ar.manifest.package, 'architect_retrofit');
  assert.deepEqual(ar.reads['architect.plan_reasons'].reasons.map((r) => r.code), [...PLAN_REASONS], 'the retrofit variant adds the two retrofit reasons');
});

const GOVERNED = { ...defaultGoverned(), check_commands: { node: { path: '/usr/bin/node' } } };
const writing = {
  governed: GOVERNED,
  tier: 'T1',
  modules: [],
  requirements: [{ key: 'R1', text: 'Greets.', text_ref: 'x', criteria: ['R1.1'], sensitive_areas: [] }],
  stages: [{ number: 1, status: 'planned', implements: ['R1'] }],
  environments: [{ name: 'alpha', targets: ['app'], check_secrets: ['deploy/ref'] }],
};
const authoring = { phase_plan: { id: 'pp_1', phase_number: 1, generation: 1 }, stages: [{ number: 1, goal: 'g', modules: ['greeter'], implements: ['R1'], depends_on: [], validation: null }], interfaces: [], architecture: 'arch', environments: [], follow_up: null };

function oneShot(t, role, work_kind, facts) {
  const dir = scratch(t);
  const claim = { run: 'run_1', role, work_item: 'wrk_1', work_kind, base_revision: 'b'.repeat(40), attempt: null, check_outputs: [] };
  const base = { run: { id: 'run_1', role, base_revision: 'b'.repeat(40), content_hash: null }, work_item: { id: 'wrk_1', kind: work_kind, subject: '{}', project: 'prj_1' }, stage: null, requirements: [], modules: [], phase_plan: null, candidate: null, resumed: null };
  writeContextPackage(dir, claim, { ...base, ...facts }, { probe: false });
  return { dir, prompt: read(dir, 'prompt.md'), reads: blocks(read(dir, 'prompt.md')), manifest: manifest(dir), schema: JSON.parse(read(dir, 'result-schema.json')) };
}

test('the correction package states the six check elements and no governed changes; the authoring package adds its result; the retrofit variant adds the adoption rule', (t) => {
  const c = oneShot(t, 'verifier', 'check_correction', { check_writing: writing });
  assert.equal(c.manifest.package, 'verifier_correction');
  assert.deepEqual(Object.keys(c.reads), [...PACKAGE_ELEMENTS.verifier_correction]);
  assert.equal(c.schema.properties.governed_changes, undefined);
  assert.deepEqual(c.reads['verifier.gate_kinds_floor'], {
    tier: 'T1',
    floor: KIND_INVENTORY.T1,
    gate_kinds: ['stage', 'alpha_authorize'],
    member: 'gate_kinds',
    allowed: ['stage', 'phase', 'alpha_authorize', 'alpha_complete', 'beta_authorize', 'beta_complete', 'live_authorize', 'live_complete'],
    non_empty: true,
    no_repeats: true,
  });
  assert.deepEqual(c.reads['verifier.post_deploy'].environments, [{ name: 'alpha', targets: ['app'] }]);
  assert.deepEqual(c.reads['verifier.secrets'].environments, [{ name: 'alpha', check_secrets: ['deploy/ref'], variables: [{ ref: 'deploy/ref', variable: 'SURETY_SECRET_REF' }] }]);
  assert.deepEqual(c.reads['verifier.covers'].refused_on, ['smoke', 'security_lint', 'post_deploy_identity', 'post_deploy_behavior']);
  const a = oneShot(t, 'verifier', 'check_authoring', { check_writing: writing, authoring });
  assert.equal(a.manifest.package, 'verifier_authoring');
  assert.deepEqual(a.reads['verifier.authoring_result'].fields, ['governed_changes', 'deferred_criteria']);
  assert.match(a.reads['verifier.authoring_result'].no_execution_authority, /^A proposal grants no execution authority/);
  assert.ok(a.schema.properties.governed_changes && a.schema.properties.deferred_criteria);
  assert.equal(a.schema.properties.adopted_tests, undefined);
  const r = oneShot(t, 'verifier', 'check_authoring', { check_writing: writing, authoring, adopted: true });
  assert.equal(r.manifest.package, 'verifier_authoring_retrofit');
  assert.deepEqual(r.reads['verifier.adoption_rule'].dispositions, ['copied', 'replaced', 'application']);
  assert.equal(r.reads['verifier.adoption_rule'].protected_root, '.surety/checks/');
  assert.deepEqual(r.schema.properties.adopted_tests.items.properties.dependency_boundary.items.properties.disposition.enum, ['copied', 'replaced', 'application']);
});

test("a stage's Builder is told its tasks, what it implements, its obligations and the interfaces of the stages it depends on, from the plan's bundle", (t) => {
  const dir = scratch(t);
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`, AT);
  const artifacts = { modules: { version: 1, modules: [{ name: 'lib', paths: ['src/lib/'], sensitive_areas: [], interfaces: [{ name: 'sum', kind: 'module', path: 'src/lib/sum.mjs', description: 'adds' }] }, { name: 'web', paths: ['src/web/'], sensitive_areas: [], interfaces: [{ name: 'GET /sum', kind: 'http', description: 'serves' }] }], mapping_from_spec: [] } };
  run(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status) VALUES ('pb_1', ?, 'prj_1', ?, '{}', ?, '{}', 'published')`, AT, 'c'.repeat(40), JSON.stringify(artifacts));
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, bundle) VALUES ('pp_1', ?, 'prj_1', 1, ?, '.surety/phases/phase-1.json', 1, 1, 'pb_1')`, AT, 'c'.repeat(40));
  run(`INSERT INTO requirements (id, created_at, project, key, text_ref, status, text) VALUES ('req_1', ?, 'prj_1', 'R2', 'x', 'pending', 'Serves the sum.')`, AT);
  run(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_1', ?, 'prj_1', 'web', '["src/web/"]')`, AT);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, tasks, depends_on, integration_obligations) VALUES ('stg_1', ?, 'prj_1', 'pp_1', 1, 'the library', '["lib"]', '[]', '[]', 'integrated', '[]', '[]', '[]')`, AT);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, tasks, depends_on, integration_obligations) VALUES ('stg_2', ?, 'prj_1', 'pp_1', 2, 'the service', '["web"]', '["req_1"]', '["req_1"]', 'building', 'wrk_2', '["write server.mjs"]', '["stg_1"]', '["keep sum pure"]')`, AT);
  run(`INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold) VALUES ('wrk_2', ?, 'prj_1', 2, 'stage_build', '{"stage":"stg_2"}', 'executing', 'plan', 'pp_1', 1, 0, 0, 0, 0)`, AT);
  run(`INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_b', ?, 'prj_1', 1, 'wrk_2', 'builder', 'one_shot', 'executing', 'scripted', '1', 'sonnet', ?, ?, 0)`, AT, 'c'.repeat(40), AT);
  const facts = contextFacts(db, { run: 'run_b' });
  assert.deepEqual(facts.builder_stage, {
    number: 2,
    goal: 'the service',
    tasks: ['write server.mjs'],
    implements: ['R2'],
    integration_obligations: ['keep sum pure'],
    depends_on: [1],
    dependency_interfaces: [{ stage: 1, module: 'lib', name: 'sum', kind: 'module', path: 'src/lib/sum.mjs', description: 'adds' }],
  });
  assert.deepEqual(facts.modules[0].interfaces, [{ name: 'GET /sum', kind: 'http', path: null, description: 'serves' }], "the stage's own modules carry the map's interfaces");
  const out = scratch(t);
  writeContextPackage(out, { run: 'run_b', role: 'builder', work_item: 'wrk_2', work_kind: 'stage_build', base_revision: 'c'.repeat(40), attempt: null, check_outputs: [] }, facts, { probe: false });
  const b = blocks(read(out, 'prompt.md'));
  assert.deepEqual(manifest(out).reads, [...PACKAGE_ELEMENTS.builder]);
  assert.deepEqual(b['builder.tasks'], { stage: 2, goal: 'the service', tasks: ['write server.mjs'] });
  assert.deepEqual(b['builder.implements'], { implements: ['R2'] });
  assert.deepEqual(b['builder.integration_obligations'], { integration_obligations: ['keep sum pure'] });
  assert.deepEqual(b['builder.dependency_interfaces'].depends_on, [1]);
  assert.deepEqual(JSON.parse(read(out, 'interfaces/web.json')).interfaces, [{ name: 'GET /sum', kind: 'http', path: null, description: 'serves' }]);
});

test('the seam lists every element with its packages, and an omission removes the element from the prompt, the block, the result schema and the manifest (harness mode only)', (t) => {
  assert.deepEqual(elementListing().map((e) => e.id), [...ELEMENT_IDS]);
  assert.deepEqual(elementListing().find((e) => e.id === 'spec_writer.claims_table').packages, ['spec_writer_retrofit']);
  for (const e of elementListing()) assert.ok(e.title && e.packages.length > 0, e.id);
  // Outside harness mode an omission changes nothing.
  configureHarness(false, []);
  assert.equal(setPackageOmit(['spec_writer.marks']), null);
  assert.ok('spec_writer.marks' in session(t, 'spec_writer').reads, 'outside harness mode nothing is omitted');
  configureHarness(true, []);
  t.after(() => {
    setPackageOmit([]);
    configureHarness(false, []);
  });
  assert.match(setPackageOmit(['spec_writer.nope']), /not spec_writer\.nope/);
  assert.equal(setPackageOmit(['spec_writer.marks', 'verifier.authoring_result']), null);
  const s = session(t, 'spec_writer');
  assert.equal(s.reads['spec_writer.marks'], undefined);
  assert.ok(!s.manifest.reads.includes('spec_writer.marks'));
  assert.ok(!s.prompt.includes('The marks of a requirement with no criteria'), 'the subsection goes with its block');
  const a = oneShot(t, 'verifier', 'check_authoring', { check_writing: writing, authoring });
  assert.equal(a.reads['verifier.authoring_result'], undefined);
  assert.equal(a.schema.properties.governed_changes, undefined, 'its result fields go too');
  assert.equal(a.schema.properties.deferred_criteria, undefined);
  assert.ok(!a.manifest.reads.includes('verifier.authoring_result'));
});

// The driver's slice-38 findings on M442 (a): a published plan's stage
// names its modules by id, and an environment is one thing per project.
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { writeConfigVersion } = await import(join(dist, 'store', 'transitions', 'deploy.js'));

function plainStore(t) {
  const db = new Database(join(scratch(t), 'store.db'));
  t.after(() => db.close());
  migrate(db, join(root, 'migrations'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO projects (id, created_at, name, tier, dev_repo_path, integration_branch, baseline_state, registration_state, management) VALUES ('prj_1', ?, 'p', 'T1', '/nowhere', 'main', 'spec_ready', 'registered', '{}')`).run(AT);
  return db;
}

test("a stage that names its modules by id (a published plan): its dependencies' interfaces are found by the modules' names in the map", (t) => {
  const db = plainStore(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const iface = (name) => ({ name, kind: 'module', path: `src/${name}.mjs`, description: name });
  const artifacts = { modules: { version: 1, modules: [{ name: 'lib', paths: ['src/'], sensitive_areas: [], interfaces: [iface('sum'), iface('tally')] }, { name: 'service', paths: ['server.mjs'], sensitive_areas: [], interfaces: [] }], mapping_from_spec: [] } };
  run(`INSERT INTO plan_bundles (id, created_at, project, head, blobs, artifacts, versions, status) VALUES ('pb_1', ?, 'prj_1', ?, '{}', ?, '{}', 'published')`, AT, 'c'.repeat(40), JSON.stringify(artifacts));
  run(`INSERT INTO phase_plans (id, created_at, project, phase_number, prepared_against_revision, git_path, generation, active, bundle) VALUES ('pp_1', ?, 'prj_1', 1, ?, 'x', 1, 1, 'pb_1')`, AT, 'c'.repeat(40));
  run(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_lib', ?, 'prj_1', 'lib', '["src/"]')`, AT);
  run(`INSERT INTO modules (id, created_at, project, name, paths) VALUES ('mod_svc', ?, 'prj_1', 'service', '["server.mjs"]')`, AT);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status) VALUES ('stg_1', ?, 'prj_1', 'pp_1', 1, 'lib', '["mod_lib"]', '[]', '[]', 'integrated')`, AT);
  run(`INSERT INTO stages (id, created_at, project, phase_plan, number, goal, modules, requirement_ids, implements, status, work_item, depends_on) VALUES ('stg_2', ?, 'prj_1', 'pp_1', 2, 'svc', '["mod_svc"]', '[]', '[]', 'building', 'wrk_2', '["stg_1"]')`, AT);
  run(`INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold) VALUES ('wrk_2', ?, 'prj_1', 2, 'stage_build', '{"stage":"stg_2"}', 'executing', 'plan', 'pp_1', 1, 0, 0, 0, 0)`, AT);
  run(`INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_b', ?, 'prj_1', 1, 'wrk_2', 'builder', 'one_shot', 'executing', 'scripted', '1', 's', ?, ?, 0)`, AT, 'c'.repeat(40), AT);
  const facts = contextFacts(db, { run: 'run_b' });
  assert.deepEqual(facts.builder_stage.depends_on, [1]);
  assert.deepEqual(facts.builder_stage.dependency_interfaces.map((i) => `${i.stage}:${i.module}:${i.name}`), ['1:lib:sum', '1:lib:tally']);
  assert.deepEqual(facts.modules.map((m) => m.name), ['service'], "the stage's own module, found by its id");
});

test("an environment is one thing per project: the owner's first configuration of a name the specification gave attaches to that environment, and the Verifier's package states it once", (t) => {
  const db = plainStore(t);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_spec', ?, 'prj_1', 'alpha', 'none', 'spec', '{}')`).run(AT);
  const content = { adapter: 'local_service', targets: ['app'], check_secrets: ['deploy/k'] };
  const out = transact(db, ENGINE_ACTOR, (tx) => writeConfigVersion(tx, { project: 'prj_1', name: 'alpha', content, identity: 'ci', secretDigests: [], homeHash: 'a'.repeat(12) }));
  assert.equal(out.body.environment.id, 'env_spec', "the specification's environment, under its own id");
  assert.equal(out.body.environment.prefix, `surety-${'a'.repeat(12)}-env_spec-`);
  const rows = db.prepare(`SELECT "id", "adapter", "adapter_config_ref", "prefix" IS NOT NULL AS configured FROM "environments" WHERE "project" = 'prj_1' AND "name" = 'alpha'`).all();
  assert.deepEqual(rows, [{ id: 'env_spec', adapter: 'local_service', adapter_config_ref: 'environment_configs', configured: 1 }], 'one row of the name');
  // A second version of the configuration writes to the same environment.
  const again = transact(db, ENGINE_ACTOR, (tx) => writeConfigVersion(tx, { project: 'prj_1', name: 'alpha', content: { ...content, targets: ['app', 'web'] }, identity: 'ci2', secretDigests: [], homeHash: 'a'.repeat(12) }));
  assert.equal(again.body.environment.id, 'env_spec');
  // An adoption signal's environment of another name is never configured this way.
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, origin) VALUES ('env_sig', ?, 'prj_1', 'beta', 'none', 'adoption_signal', '{}', 'adoption_signal')`).run(AT);
  const beta = transact(db, ENGINE_ACTOR, (tx) => writeConfigVersion(tx, { project: 'prj_1', name: 'beta', content, identity: 'ci3', secretDigests: [], homeHash: 'a'.repeat(12) }));
  assert.notEqual(beta.body.environment.id, 'env_sig');
});

test('a store holding two rows of one environment name (before the ruling) is stated once, merged: the configured row supplies targets and secrets, nothing stated is null', (t) => {
  const db = plainStore(t);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_spec', ?, 'prj_1', 'alpha', 'none', 'spec', '{}')`).run(AT);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec, prefix, current_config) VALUES ('env_cfg', ?, 'prj_1', 'alpha', 'local_service', 'environment_configs', '{}', 'surety-x-', 'envc_1')`).run(AT);
  db.prepare(`INSERT INTO environment_configs (id, created_at, project, environment, version, content, config_identity, secret_digests, status, written_by, written_at) VALUES ('envc_1', ?, 'prj_1', 'env_cfg', 1, ?, 'ci', '[]', 'current', 'sean', ?)`).run(AT, JSON.stringify({ targets: ['app'] }), AT);
  db.prepare(`INSERT INTO environments (id, created_at, project, name, adapter, adapter_config_ref, verify_spec) VALUES ('env_b', ?, 'prj_1', 'beta', 'none', 'spec', '{}')`).run(AT);
  db.prepare(`INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold) VALUES ('wrk_c', ?, 'prj_1', 1, 'check_correction', '{}', 'executing', 'x', 'x', 1, 0, 0, 0, 0)`).run(AT);
  db.prepare(`INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES ('run_c', ?, 'prj_1', 1, 'wrk_c', 'verifier', 'one_shot', 'executing', 'scripted', '1', 's', ?, ?, 0)`).run(AT, 'c'.repeat(40), AT);
  assert.deepEqual(contextFacts(db, { run: 'run_c' }).check_writing.environments, [
    { name: 'alpha', targets: ['app'], check_secrets: [], runtime: null },
    { name: 'beta', targets: null, check_secrets: null, runtime: null },
  ]);
});

// The real-run review (slice 38): phase 1's authoring names the toolchain,
// which the package must state (E135's kind); the correction package does not.
const { parseGoverned } = await import(join(dist, 'checks', 'schema.js'));

test("the authoring package states the governed file's form and the runtimes; a governed file written from the block alone parses; the correction package carries none of it", (t) => {
  const facts = { ...writing, governed: defaultGoverned(), environments: [{ name: 'alpha', targets: ['app'], check_secrets: [], runtime: { path: '/opt/rt/bin/node', sha256: 'a'.repeat(64) } }] };
  const a = oneShot(t, 'verifier', 'check_authoring', { check_writing: facts, authoring });
  const tc = a.reads['verifier.toolchain'];
  assert.ok(a.manifest.reads.includes('verifier.toolchain'));
  assert.equal(tc.file, '.surety/checks/protected-policy.json');
  assert.deepEqual(tc.members, ['protected_paths', 'check_discovery', 'check_commands', 'runner_config', 'result_collection', 'required_checks']);
  assert.deepEqual(tc.current.check_commands, {}, 'the effective values: no program yet');
  assert.equal(tc.runtimes[0].path, process.execPath, "the engine's own node");
  assert.deepEqual(tc.runtimes[1], { name: 'node', path: '/opt/rt/bin/node', sha256: 'a'.repeat(64), read_paths: ['/opt/rt'], path_dirs: ['/opt/rt/bin'], source: "the runtime environment alpha's configuration pins" });
  for (const rt of tc.runtimes) {
    const governed = { check_commands: { [rt.name]: { path: rt.path, ...(rt.sha256 ? { sha256: rt.sha256 } : {}) } }, runner_config: { direct: { read_paths: rt.read_paths, path: [...rt.path_dirs, '/usr/bin', '/bin'] } } };
    assert.deepEqual(parseGoverned(JSON.stringify(governed)).errors, [], `a governed file naming ${rt.path} from the block parses`);
  }
  assert.ok(!a.prompt.includes('do not change it'), 'the authoring Verifier may name the toolchain');
  assert.ok(!a.prompt.includes('Write no definition'));
  const c = oneShot(t, 'verifier', 'check_correction', { check_writing: facts });
  assert.equal(c.reads['verifier.toolchain'], undefined);
  assert.ok(c.prompt.includes('do not change it'), 'the correction Verifier changes no governed value');
  assert.ok(!c.prompt.includes('/opt/rt/bin/node'), "no runtime's path in the correction package");
});

// M442 (c)'s finding (slice 38): a package's prose may ask only for what its
// result schema allows; each result field a package asks for is an element.
test("the phase Verifier's package states its sign-off and its schema takes it; the spec change's and the retrofit replan's results likewise; an omission takes the field away", (t) => {
  const phase = { phase_plan: { id: 'pp_1', phase_number: 1, generation: 1 }, candidate: 'cand_1', evaluation: { id: 'gev_1', outcome: 'satisfied' }, findings: [] };
  const p = oneShot(t, 'verifier', 'phase_verification', { phase, criteria: [] });
  assert.equal(p.manifest.package, 'phase_verification');
  assert.deepEqual(p.reads['verifier.phase_signoff'], { field: 'signoffs', item: { scope: 'phase' }, scope: 'phase', binding: ['acceptance_hash', 'protected_version', 'spec_revision', 'plan_generation'] });
  assert.deepEqual(p.schema.properties.signoffs.items.properties.scope.enum, ['phase']);
  assert.ok(!/sign the phase off in `signoffs`/.test(p.prompt), 'stated once, in its element');
  const s = oneShot(t, 'spec_writer', 'spec_change', { change_request: { id: 'scr_1', text: 'change R2' } });
  assert.equal(s.manifest.package, 'spec_change');
  assert.ok(s.reads['spec_writer.change_result'].item.kind.includes('criteria_changed'));
  assert.deepEqual(s.schema.properties.changes.items.required, ['key', 'kind', 'reason']);
  assert.match(s.prompt, /Write the specification change the owner's request asks for/);
  const replan = { completed_plan: null, open_plan: null, generation: { spec_revision: null, architecture_revision: null, roadmap_revision: null, plan: null, spec_evidence_generation: null }, trigger: {}, trigger_subject: {}, refusal: null };
  const rr = oneShot(t, 'architect', 'replan', { replan, adopted: true });
  assert.equal(rr.manifest.package, 'replan_retrofit');
  assert.ok(rr.schema.properties.spec_change_requests);
  const r = oneShot(t, 'architect', 'replan', { replan });
  assert.equal(r.schema.properties.spec_change_requests, undefined, 'a new project\'s replan asks for none');
  configureHarness(true, []);
  t.after(() => {
    setPackageOmit([]);
    configureHarness(false, []);
  });
  setPackageOmit(['verifier.phase_signoff']);
  const o = oneShot(t, 'verifier', 'phase_verification', { phase, criteria: [] });
  assert.equal(o.schema.properties.signoffs, undefined, 'omitted: no sign-off field');
  assert.equal(o.reads['verifier.phase_signoff'], undefined);
});

// The slice-38 review: S1 (the target variables), S2 (prepared_against), M5
// (the index's cells), the first close's refusal; each from the engine's
// own code.
const { targetVariable, checkSecretVariable } = await import(join(dist, 'checks', 'variables.js'));
const { parseRequirementIndex } = await import(join(dist, 'checks', 'requirement-index.js'));
const { preparedAgainstFacts, bundleBaselineFacts } = await import(join(dist, 'plan', 'bundle.js'));
const { firstPlanMissing } = await import(join(dist, 'sessions', 'driver.js'));

test("S1: both Verifier packages state each target's variable and value form, and each secret's variable, from the runner's own naming", (t) => {
  const facts = { ...writing, environments: [{ name: 'alpha', targets: ['app', 'web-1'], check_secrets: ['deploy/probe_key'], runtime: null }, { name: 'beta', targets: null, check_secrets: null, runtime: null }] };
  for (const [kind, extra] of [['check_correction', {}], ['check_authoring', { authoring }]]) {
    const p = oneShot(t, 'verifier', kind, { check_writing: facts, ...extra });
    const tv = p.reads['verifier.target_variables'];
    assert.ok(p.manifest.reads.includes('verifier.target_variables'), kind);
    assert.equal(tv.variable, 'SURETY_TARGET_<NAME>');
    assert.equal(tv.value_form, 'http://127.0.0.1:<port>');
    assert.match(tv.name_rule, /upper-cased/);
    assert.deepEqual(tv.environments, [{ name: 'alpha', targets: [{ name: 'app', variable: targetVariable('app') }, { name: 'web-1', variable: targetVariable('web-1') }] }, { name: 'beta', targets: null }]);
    assert.equal(tv.environments[0].targets[1].variable, 'SURETY_TARGET_WEB_1');
    assert.deepEqual(p.reads['verifier.secrets'].environments[0].variables, [{ ref: 'deploy/probe_key', variable: checkSecretVariable('deploy/probe_key') }]);
    assert.equal(p.reads['verifier.secrets'].environments[1].variables, null, 'unread secrets: unknown, never none');
  }
});

test("S2: the Architect's session package states prepared_against's rule and the values the check compares with; the replan's names the approved ones", (t) => {
  const dir = scratch(t);
  writeSessionPackage(dir, { run: 'run_s' }, { run: 'run_s', project: 'prj_1', role: 'architect', turn: 1, paths: [], transcript: [], findings: [], approved: [], retrofit: null, prepared_against: { spec_version: 1, architecture_version: 1, roadmap_version: 1, roadmap_version_if_changed: 1, revision: 'c'.repeat(40) } });
  const b = blocks(read(dir, 'prompt.md'))['architect.prepared_against'];
  assert.deepEqual(b.facts, { spec_version: 1, architecture_version: 1, roadmap_version: 1, revision: 'c'.repeat(40) });
  assert.match(b.rule, /revision, the commit your session started from/);
  const replan = { completed_plan: null, open_plan: null, generation: { spec_revision: { version: 2 }, architecture_revision: { version: 1 }, roadmap_revision: { version: 3 }, plan: null, spec_evidence_generation: 2 }, trigger: {}, trigger_subject: {}, refusal: null };
  const r = oneShot(t, 'architect', 'replan', { replan });
  assert.deepEqual(r.reads['architect.prepared_against'].facts, { spec_version: 2, architecture_version: 1, roadmap_version: 3, revision: 'b'.repeat(40) });
  // The session's facts are the check's own (bundleBaselineFacts), never computed apart.
  const db = plainStore(t);
  db.prepare(`INSERT INTO spec_revisions (id, created_at, project, version, git_path, git_blob, semantic_digest, approved_by, approved_at) VALUES ('spec_1', ?, 'prj_1', 1, '.surety/spec/spec.md', 'blob', 'd', 'sean', ?)`).run(AT, AT);
  const head = 'e'.repeat(40);
  const f = preparedAgainstFacts(db, 'prj_1', head);
  const base = bundleBaselineFacts(db, { project: 'prj_1', head, withPlan: true });
  assert.deepEqual(f, { spec_version: base.baseline.spec_version, architecture_version: base.baseline.architecture_version, roadmap_version: base.baseline.roadmap_version, roadmap_version_if_changed: 1, revision: base.baseline.head });
  assert.deepEqual([f.spec_version, f.architecture_version, f.roadmap_version], [1, 1, 1], 'a first bundle: version 1 of each');
});

test("M5: an index written from spec_writer.index_cells and index_columns parses; its patterns are the parser's", (t) => {
  const s = session(t, 'spec_writer');
  const cells = s.reads['spec_writer.index_cells'];
  const cols = s.reads['spec_writer.index_columns'].columns;
  assert.ok(new RegExp(cells.separator_row.cell_pattern).test('---'));
  const sep = `|${cols.map(() => '---').join('|')}|`;
  const join = (xs) => xs.join(cells.list_separator);
  const table = [`| ${cols.join(' | ')} |`, sep, `| R1 | A | 1 | ${join(['authentication', 'personal_data'])} | ${join(['R1.1', 'R1.2'])} | intended |`, '| R2 | B |  | none |  | observed |'].join('\n');
  const parsed = parseRequirementIndex(table);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.rows.map((r) => [r.key, r.phase, r.criteria, r.origin]), [['R1', 1, ['R1.1', 'R1.2'], 'intended'], ['R2', null, [], 'observed']]);
  assert.ok(new RegExp(cells.key_pattern).test('R12') && !new RegExp(cells.key_pattern).test('R0'));
  assert.ok(new RegExp(cells.phase_pattern).test('3') && !new RegExp(cells.phase_pattern).test('phase 3'));
  assert.ok(new RegExp(cells.criterion_pattern).test('R1.2'));
});

test('the first Architect close without the first phase plan is refused, naming the plan; a later one may close without a plan', () => {
  assert.deepEqual(firstPlanMissing([], { architecture_revision: null, phase: 1 }), {
    code: 'machine_file_invalid',
    path: '.surety/phases/phase-1.json',
    subject: { path: '.surety/phases/phase-1.json', field: null },
    message: ".surety/phases/phase-1.json is missing: the first architecture is approved with the first phase's plan, in one bundle",
  });
  assert.equal(firstPlanMissing([1], { architecture_revision: null, phase: 1 }), null, 'the first bundle with its plan');
  assert.equal(firstPlanMissing([], { architecture_revision: 'arch_1', phase: 2 }), null, 'a later session on an approved architecture');
});

// M443's real run: a Verifier wrote acceptance-origin `integration` checks
// with no criterion, refused at `#/covers`, a rule verifier.covers did not
// state (E135's kind); and its repair was told only that its proposal was
// rejected, so it repeated the mistake.
const { parseDefinition, COVERING_KINDS, GATE_KINDS } = await import(join(dist, 'checks', 'schema.js'));

test('verifier.covers states the converse rule: an acceptance-origin check of a criteria kind names at least one criterion; a developer-origin check carries no covers; each as the parser enforces it', (t) => {
  const c = oneShot(t, 'verifier', 'check_correction', { check_writing: writing });
  const cv = c.reads['verifier.covers'];
  assert.equal(cv.must_cover_one, true);
  assert.deepEqual(cv.must_cover_one_on, { origin: 'acceptance', kinds: [...COVERING_KINDS] });
  assert.equal(cv.origin_default, 'acceptance');
  assert.match(cv.developer_origin, /covers nothing, counts toward no criterion or tier kind/);
  assert.deepEqual(cv.members, ['criteria', 'sensitive_areas']);
  assert.deepEqual(cv.sensitivity_floor.areas, [...SENSITIVE_AREAS]);
  assert.equal(cv.sensitivity_floor.origin, 'acceptance');
  assert.match(c.prompt, /must name at least one criterion/);
  const entries = [{ path: '.surety/checks/t.mjs', type: 'blob', mode: '100644', oid: 'a'.repeat(40) }];
  const parse = (d) => parseDefinition('.surety/checks/definitions/c.json', 'c', JSON.stringify({ schema: 1, key: 'c', command: ['node', '.surety/checks/t.mjs'], timeout_s: 60, gate_kinds: ['stage'], ...d }), GOVERNED, entries).errors.map((e) => `${e.path.split('#')[1]} ${e.code}`);
  for (const kind of cv.must_cover_one_on.kinds) {
    assert.deepEqual(parse({ kind }), ['/covers invalid_value'], `${kind}: acceptance-origin (the default) with no criterion is refused`);
    assert.deepEqual(parse({ kind, origin: 'acceptance', covers: { criteria: [] } }), ['/covers invalid_value']);
    assert.deepEqual(parse({ kind, covers: { criteria: ['R1.1'] } }), [], `${kind}: one criterion is enough`);
    assert.deepEqual(parse({ kind, origin: 'developer' }), [], `${kind}: developer-origin with no covers is accepted`);
    assert.deepEqual(parse({ kind, origin: 'developer', covers: { criteria: ['R1.1'] } }), ['/covers covers_not_allowed'], 'a developer check carries no covers');
  }
  assert.deepEqual(parse({ kind: 'sensitivity_floor', origin: 'developer' }), ['/covers invalid_value'], 'sensitivity_floor is never developer-origin');
  assert.deepEqual(parse({ kind: 'sensitivity_floor', covers: { sensitive_areas: [cv.sensitivity_floor.areas[0]] } }), []);
  assert.deepEqual(parse({ kind: 'acceptance', covers: { criteria: ['R1.1', 'R1.1'] } }), ['/covers/criteria/1 duplicate_entry'], 'no repeats');
  assert.deepEqual(parse({ kind: 'acceptance', covers: { criteria: ['R1.1'], x: 1 } }), ['/covers/x unknown_field'], 'covers is closed');
  // The other members the elements alone state (guide.ts: kind, covers,
  // gate_kinds, requires, secrets): their refusals, as stated.
  const gk = c.reads['verifier.gate_kinds_floor'];
  assert.deepEqual(gk.allowed, [...GATE_KINDS]);
  assert.deepEqual(parse({ kind: 'smoke', gate_kinds: [] }), ['/gate_kinds invalid_value']);
  assert.deepEqual(parse({ kind: 'smoke', gate_kinds: ['stage', 'stage'] }), ['/gate_kinds/1 duplicate_entry']);
  assert.equal(c.reads['verifier.requires'].no_repeats, true);
  const sc = c.reads['verifier.secrets'];
  assert.ok(new RegExp(sc.reference_pattern).test('deploy/ref') && !new RegExp(sc.reference_pattern).test('deploy/Ref'));
  assert.deepEqual(sc.only_with, { requires: 'environment' });
  assert.deepEqual(parse({ kind: 'smoke', secrets: ['deploy/ref'] }), ['/secrets invalid_value']);
});

test("a check writer's repair after its proposal was rejected is told the proposal's discovery errors, each with its code, and the reason it was rejected", (t) => {
  const db = plainStore(t);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run(`INSERT INTO work_items (id, created_at, project, seq, kind, subject, status, trigger_source, trigger_id, trigger_generation, repair_attempts, no_progress_count, preflight_refusals, dispatch_hold) VALUES ('wrk_a', ?, 'prj_1', 1, 'check_authoring', '{}', 'executing', 'x', 'x', 1, 1, 0, 0, 0)`, AT);
  const runRow = (id, seq) => run(`INSERT INTO runs (id, created_at, project, seq, work_item, role, kind, state, backend, backend_version, model_requested, base_revision, deadline_at, quarantined) VALUES (?, ?, 'prj_1', ?, 'wrk_a', 'verifier', 'one_shot', 'executing', 'scripted', '1', 's', ?, ?, 0)`, id, AT, seq, 'c'.repeat(40), AT);
  runRow('run_1', 1);
  runRow('run_2', 2);
  const file = '.surety/checks/definitions/journey.json';
  const classification = {
    change_kind: 'unclassifiable',
    elements: [
      { reason: 'discovery_error', path: `${file}#/covers` },
      { reason: 'discovery_error', path: `${file}#/covers/criteria/0` },
      { reason: 'discovery_error', path: '.surety/checks/definitions/other.json#/kind' },
    ],
    discovery: { governed: GOVERNED, checks: [], errors: [{ path: `${file}#/covers`, code: 'invalid_value' }] },
  };
  run(`INSERT INTO protected_proposals (id, created_at, project, seq, proposed_by, run, base_revision, tree_id, diff_hash, requested_change_kind, status, classification) VALUES ('pp_x', ?, 'prj_1', 1, 'verifier_run', 'run_1', ?, 't', 'd', 'initial', 'rejected', ?)`, AT, 'c'.repeat(40), JSON.stringify(classification));
  run(`INSERT INTO events (id, created_at, seq, at, type, subject, actor_kind, payload, tx) VALUES ('ev_1', ?, 1, ?, 'protected.rejected', ?, 'engine', ?, 'tx_1')`, AT, AT, JSON.stringify({ project: 'prj_1', proposal: 'pp_x' }), JSON.stringify({ decision: null, cause: 'application_conflict', reason: 'the head moved' }));
  const facts = contextFacts(db, { run: 'run_2' });
  assert.deepEqual(facts.rejected_proposal, {
    proposal: 'pp_x',
    note: 'the head moved',
    errors: [
      { path: `${file}#/covers`, code: 'invalid_value' },
      { path: `${file}#/covers/criteria/0`, code: 'criterion_unknown' },
      { path: '.surety/checks/definitions/other.json#/kind', code: null },
    ],
  });
  assert.equal(contextFacts(db, { run: 'run_1' }).rejected_proposal, null, 'the first run has no earlier proposal');
  const out = scratch(t);
  writeContextPackage(out, { run: 'run_2', role: 'verifier', work_item: 'wrk_a', work_kind: 'check_correction', base_revision: 'c'.repeat(40), attempt: null, check_outputs: [] }, { ...facts, check_writing: writing }, { probe: false });
  const prompt = read(out, 'prompt.md');
  assert.match(prompt, /## Your last proposal was rejected/);
  assert.match(prompt, /Proposal pp_x was rejected: "the head moved"\./);
  assert.ok(prompt.includes(`- \`${file}#/covers\`: invalid_value`));
  assert.ok(prompt.includes(`- \`${file}#/covers/criteria/0\`: criterion_unknown`));
  assert.ok(prompt.includes('- `.surety/checks/definitions/other.json#/kind`: code unknown'));
  // Applied, or not rejected: nothing is said.
  run(`UPDATE protected_proposals SET status = 'applied' WHERE id = 'pp_x'`);
  assert.equal(contextFacts(db, { run: 'run_2' }).rejected_proposal, null);
});
