// What the role packages say the engine reads (M5 slice 38, row M442; E135;
// E87 item 10; BS5 §3 "the role packages", §12; SEAM.md §§453 to 456).
//
// Each element a package states is a fenced block in its prompt.md,
//
//   ```json surety-reads <element id>
//   <JSON>
//   ```
//
// listed by id in its manifest.json's `reads`. This module reads them from a
// captured package (a role's `context_dump`, {relative path: text}), names
// the elements each package must carry, and checks each element's JSON
// against what the engine's parsers and gates read (the shapes SEAM.md §454
// pins). The same checks are the rehearsal's judgement of a product against
// what the whole package states (SEAM.md §455): `conforms`.
//
// Pure: no engine, no process, no file.

// ---- the elements each package carries (SEAM.md §454) -----------------------------------

export const SPEC_WRITER_ELEMENTS = Object.freeze([
  'spec_writer.header_fields',
  'spec_writer.requirement_form',
  'spec_writer.marks',
  'spec_writer.question_form',
  'spec_writer.index_columns',
  'spec_writer.module_table',
  'spec_writer.environment_fields',
  'spec_writer.sensitive_areas',
  'spec_writer.tier_table',
  'spec_writer.approval_blockers',
]);
export const SPEC_WRITER_RETROFIT_ELEMENTS = Object.freeze([...SPEC_WRITER_ELEMENTS, 'spec_writer.claims_table']);
export const ARCHITECT_ELEMENTS = Object.freeze(['architect.schema.modules', 'architect.schema.roadmap', 'architect.schema.phase_plan', 'architect.schema.adr', 'architect.plan_reasons', 'architect.routing']);
export const VERIFIER_COMMON_ELEMENTS = Object.freeze(['verifier.kinds', 'verifier.gate_kinds_floor', 'verifier.requires', 'verifier.covers', 'verifier.secrets', 'verifier.post_deploy']);
export const AUTHORING_ELEMENTS = Object.freeze([...VERIFIER_COMMON_ELEMENTS, 'verifier.authoring_result']);
export const AUTHORING_RETROFIT_ELEMENTS = Object.freeze([...AUTHORING_ELEMENTS, 'verifier.adoption_rule']);
export const CORRECTION_ELEMENTS = VERIFIER_COMMON_ELEMENTS;
// What the correction package must NOT carry (M442 (a): "the correction
// package without the governed-change permissions").
export const CORRECTION_ABSENT = Object.freeze(['verifier.authoring_result', 'verifier.adoption_rule']);
export const BUILDER_ELEMENTS = Object.freeze(['builder.tasks', 'builder.implements', 'builder.integration_obligations', 'builder.dependency_interfaces']);
export const ALL_ELEMENTS = Object.freeze([...new Set([...SPEC_WRITER_RETROFIT_ELEMENTS, ...ARCHITECT_ELEMENTS, ...AUTHORING_RETROFIT_ELEMENTS, ...BUILDER_ELEMENTS])]);

// D6 A.4: the sixteen plan reasons; and the two of retrofit.
export const PLAN_REASONS_EVERY_PLAN = Object.freeze([
  'PLAN_UNKNOWN_REQUIREMENT',
  'PLAN_UNKNOWN_MODULE',
  'PLAN_UNKNOWN_ADR',
  'PLAN_CRITERION_MISMATCH',
  'PLAN_UNKNOWN_STAGE',
  'PLAN_STALE_BASELINE',
  'PLAN_CYCLE',
  'PLAN_MODULE_OUTSIDE_PHASE',
  'PLAN_REQUIREMENT_UNPLANNED',
  'PLAN_DEPENDENCY_INCOMPLETE',
  'PLAN_CRITERION_UNVALIDATED',
  'PLAN_AREA_UNVALIDATED',
  'PLAN_KIND_MISSING',
  'PLAN_DUPLICATE_STAGE',
  'PLAN_QUESTION_OPEN',
]);
// D6 A.4 counts sixteen: these fifteen, which every plan check applies, and
// PLAN_DESCRIPTIVE_MODULE_TOUCHED, which only a retrofit (scoped-mode) plan
// can meet; K11 adds PLAN_CONFORMANCE_MISPLACED (A.2). A new project's
// Architect package names the fifteen; a retrofit one names all seventeen
// (the engine's PLAN_REASONS, src/plan/check.ts).
export const RETROFIT_PLAN_REASONS = Object.freeze(['PLAN_DESCRIPTIVE_MODULE_TOUCHED', 'PLAN_CONFORMANCE_MISPLACED']);

export const CLOSED_AREAS = Object.freeze(['authentication', 'authorization', 'payments_financial_data', 'personal_data', 'secrets_credentials', 'data_migrations_destructive', 'irreversible_external_actions']);
export const CHECK_KINDS = Object.freeze(['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery', 'sensitivity_floor', 'post_deploy_identity', 'post_deploy_behavior']);
export const CRITERIA_KINDS = Object.freeze(['acceptance', 'integration', 'property', 'failure_recovery']);
// D3 §4.3 (src/checks/scope.ts KIND_INVENTORY): the kinds each tier requires at every scope.
export const KIND_INVENTORY = Object.freeze({ T1: ['acceptance', 'smoke'], T2: ['acceptance', 'smoke', 'integration', 'security_lint'], T3: ['acceptance', 'smoke', 'integration', 'security_lint', 'property', 'failure_recovery'] });
export const DISPOSITIONS = Object.freeze(['copied', 'replaced', 'application']);
export const ENVIRONMENT_FIELDS = Object.freeze(['Purpose', 'Verified means', 'Target', 'Runtime and start command', 'Port', 'Excluded from the artifact', 'Required post-deploy behaviour check', 'Stable arguments']);

// ---- reading a package -------------------------------------------------------------------

const BLOCK = /^```json surety-reads ([A-Za-z0-9_.]+)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

// The `surety-reads` blocks of a prompt: {id: data}, and the ids whose JSON
// did not parse ({id: message}).
export function readsBlocks(prompt) {
  const blocks = {};
  const bad = {};
  if (typeof prompt !== 'string') return { blocks, bad };
  for (const m of prompt.matchAll(BLOCK)) {
    try {
      blocks[m[1]] = JSON.parse(m[2]);
    } catch (err) {
      bad[m[1]] = String(err?.message ?? err);
    }
  }
  return { blocks, bad };
}

// A captured package ({path: text}): its prompt's blocks, its manifest's
// `reads`, its result schema.
export function packageReads(files) {
  const prompt = files?.['prompt.md'] ?? null;
  let manifest = null;
  let resultSchema = null;
  try {
    manifest = JSON.parse(files?.['manifest.json'] ?? 'null');
  } catch {
    manifest = null;
  }
  try {
    resultSchema = JSON.parse(files?.['result-schema.json'] ?? 'null');
  } catch {
    resultSchema = null;
  }
  const { blocks, bad } = readsBlocks(prompt);
  return { prompt, manifest, reads: Array.isArray(manifest?.reads) ? manifest.reads : null, blocks, bad, resultSchema };
}

// ---- the shapes (SEAM.md §454) ----------------------------------------------------------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setEq = (a, b) => Array.isArray(a) && same([...a].sort(), [...b].sort());
const has = (a, xs) => Array.isArray(a) && xs.every((x) => a.includes(x));
const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : null);

// A JSON Schema's object at `path` (property names and `[]` for items), inline (no $ref; §454).
export function schemaAt(schema, path) {
  let s = schema;
  for (const p of path) {
    if (!s || typeof s !== 'object') return null;
    s = p === '[]' ? s.items : s.properties?.[p];
  }
  return s ?? null;
}
const propsAt = (schema, path) => keysOf(schemaAt(schema, path)?.properties ?? null);
// Every object of a schema closed (additionalProperties false): the paths that are not.
function openObjects(schema, path = []) {
  if (!schema || typeof schema !== 'object') return [];
  const out = [];
  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties !== false) out.push(path.join('.') || '(root)');
    for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(...openObjects(v, [...path, k]));
  }
  if (schema.items) out.push(...openObjects(schema.items, [...path, '[]']));
  for (const k of ['oneOf', 'anyOf']) for (const v of schema[k] ?? []) out.push(...openObjects(v, path));
  return out;
}

// What is wrong with an element's JSON, as a list of sentences ([] when it
// holds what §454 pins). `facts`: what the case knows of the project
// ({tier, stage, retrofit}).
export function elementProblems(id, d, facts = {}) {
  const p = [];
  const want = (ok, what) => {
    if (!ok) p.push(`${id}: ${what} (got ${JSON.stringify(d)?.slice(0, 600)})`);
  };
  if (d === undefined || d === null) return [`${id}: no block`];
  switch (id) {
    case 'spec_writer.header_fields': {
      const names = (d.fields ?? []).map((f) => f?.name);
      want(same(names, ['Spec version', 'Status', 'Tier', 'Owner']), 'fields named Spec version, Status, Tier, Owner in that order');
      want((d.fields ?? []).every((f) => f?.line === `**${f?.name}:**`), 'each field\'s line is **<name>:**');
      want((d.fields ?? []).find((f) => f?.name === 'Status')?.value === 'draft', 'Status\'s value draft');
      break;
    }
    case 'spec_writer.requirement_form':
      want(typeof d.heading === 'string' && d.heading.startsWith('### R<n>'), 'heading ### R<n>…');
      want(typeof d.statement === 'string' && d.statement.length > 0, 'statement stated');
      want(d.sensitive_areas === '**Sensitive areas:**', 'sensitive_areas **Sensitive areas:**');
      want(typeof d.criterion === 'string' && d.criterion.includes('R<n>.<m>'), 'criterion item R<n>.<m>');
      break;
    case 'spec_writer.marks':
      want(d.human_test === '**Human test.**' && d.descriptive === '**Descriptive.**', 'the marks **Human test.** and **Descriptive.**');
      break;
    case 'spec_writer.question_form':
      want(typeof d.section === 'string' && /10\./.test(d.section), 'section 10');
      want(typeof d.item === 'string' && d.item.includes('Q<k>'), 'item Q<k>');
      want(d.phase_hint === '(phase <n>)', 'phase_hint (phase <n>)');
      break;
    case 'spec_writer.index_columns':
      want(typeof d.section === 'string' && /5\./.test(d.section), 'section 5');
      want(same(d.columns, ['Key', 'Title', 'Phase', 'Sensitive areas', 'Criteria', 'Origin']), 'the six columns with Origin');
      want(has(d.origin, ['intended', 'observed']) && d.default_origin === 'intended', 'Origin intended | observed, default intended');
      break;
    case 'spec_writer.module_table':
      want(typeof d.section === 'string' && /6\./.test(d.section), 'section 6');
      want(same(d.columns, ['Module', 'Paths', 'Sensitive areas']), 'columns Module, Paths, Sensitive areas');
      break;
    case 'spec_writer.environment_fields':
      want(typeof d.section === 'string' && /7\./.test(d.section), 'section 7');
      want(d.heading === '### <name>', 'heading ### <name>');
      want(same(d.fields, ENVIRONMENT_FIELDS), `fields ${ENVIRONMENT_FIELDS.join(', ')}`);
      break;
    case 'spec_writer.sensitive_areas':
      want(setEq((d.areas ?? []).map((a) => a?.id), CLOSED_AREAS), 'the closed list of seven areas by id');
      want((d.areas ?? []).every((a) => typeof a?.name === 'string' && a.name.length > 0), 'each area with its name');
      want(d.none === 'none', 'none stated');
      break;
    case 'spec_writer.tier_table': {
      const t = d.tiers ?? [];
      want(same(t.map((x) => [x?.tier, x?.name]), [['T1', 'prototype'], ['T2', 'standard'], ['T3', 'critical']]), 'T1 prototype, T2 standard, T3 critical');
      want(t.every((x) => same(x?.kinds, KIND_INVENTORY[x?.tier])), 'each tier\'s kinds as the engine requires them');
      break;
    }
    case 'spec_writer.approval_blockers':
      want(has((d.blockers ?? []).map((b) => b?.code), ['spec_semantics_invalid', 'QUESTION_NO_PHASE_HINT', 'REQUIREMENT_NO_PHASE_HINT', 'QUESTION_BLOCKS_PHASE_1']), 'the blockers spec_semantics_invalid, QUESTION_NO_PHASE_HINT, REQUIREMENT_NO_PHASE_HINT, QUESTION_BLOCKS_PHASE_1');
      want((d.blockers ?? []).every((b) => typeof b?.when === 'string'), 'each blocker with when');
      break;
    case 'spec_writer.claims_table':
      want(typeof d.section === 'string' && /12\./.test(d.section), 'section 12');
      want(same(d.columns, ['Source', 'Claim', 'Observed', 'Requirement']), 'columns Source, Claim, Observed, Requirement');
      want(d.not_checked === 'not checked' && d.none === 'none', 'not checked and none');
      break;
    case 'architect.schema.modules': {
      const s = d.schema;
      want(d.file === '.surety/architecture/modules.json', 'file .surety/architecture/modules.json');
      want(setEq(propsAt(s, []), ['version', 'modules', 'mapping_from_spec']), 'B.3 top level: version, modules, mapping_from_spec');
      want(setEq(propsAt(s, ['modules', '[]']), ['name', 'paths', 'sensitive_areas', 'tier_override', 'interfaces']), 'B.3 module: name, paths, sensitive_areas, tier_override, interfaces');
      want(setEq(propsAt(s, ['modules', '[]', 'interfaces', '[]']), ['name', 'kind', 'path', 'description']), 'B.3 interface: name, kind, path, description');
      want(setEq(schemaAt(s, ['modules', '[]', 'interfaces', '[]', 'kind'])?.enum, ['http', 'cli', 'module', 'file', 'event']), 'interface kind http | cli | module | file | event');
      want(setEq(propsAt(s, ['mapping_from_spec', '[]']), ['spec_module', 'to']), 'B.3 mapping: spec_module, to');
      want(openObjects(s).length === 0, `every object closed (open: ${openObjects(s).join(', ')})`);
      break;
    }
    case 'architect.schema.roadmap': {
      const s = d.schema;
      want(d.file === '.surety/roadmap/roadmap.json', 'file .surety/roadmap/roadmap.json');
      want(has(propsAt(s, []), ['version', 'architecture_version', 'phases']), 'B.4 top level: version, architecture_version, phases');
      want(setEq(propsAt(s, ['phases', '[]']), ['number', 'goal', 'modules', 'requirement_ids', 'depends_on']), 'B.4 phase: number, goal, modules, requirement_ids, depends_on');
      want(openObjects(s).length === 0, `every object closed (open: ${openObjects(s).join(', ')})`);
      break;
    }
    case 'architect.schema.phase_plan': {
      const s = d.schema;
      want(d.file === '.surety/phases/phase-<n>.json', 'file .surety/phases/phase-<n>.json');
      want(has(propsAt(s, []), ['phase', 'prepared_against', 'stages', 'conformance']), 'B.5 top level: phase, prepared_against, stages, conformance');
      want(setEq(propsAt(s, ['prepared_against']), ['spec_version', 'architecture_version', 'roadmap_version', 'revision']), 'B.5 prepared_against');
      want(has(propsAt(s, ['stages', '[]']), ['number', 'goal', 'tasks', 'modules', 'implements', 'adrs', 'depends_on', 'validation', 'integration_obligations']), 'B.5 stage fields');
      want(setEq(propsAt(s, ['stages', '[]', 'validation']), ['criteria', 'kinds', 'sensitive_areas']), 'B.5 validation: criteria, kinds, sensitive_areas');
      want(setEq(schemaAt(s, ['conformance'])?.enum, ['within_baseline', 'uncertain']), 'conformance within_baseline | uncertain');
      want(openObjects(s).length === 0, `every object closed (open: ${openObjects(s).join(', ')})`);
      break;
    }
    case 'architect.schema.adr':
      want(d.file === '.surety/adrs/ADR-<nnn>.md', 'file .surety/adrs/ADR-<nnn>.md');
      want(has(propsAt(d.front_matter, []), ['key', 'status', 'supersedes']), 'B.6 front matter: key, status, supersedes');
      want(setEq(schemaAt(d.front_matter, ['status'])?.enum, ['proposed', 'accepted', 'superseded']), 'status proposed | accepted | superseded');
      want(same(d.headings, ['Context', 'Decision', 'Consequences']), 'headings Context, Decision, Consequences');
      break;
    case 'architect.plan_reasons': {
      const codes = (d.reasons ?? []).map((r) => r?.code);
      want(has(codes, PLAN_REASONS_EVERY_PLAN), `the plan reasons of D6 A.4 (missing: ${PLAN_REASONS_EVERY_PLAN.filter((c) => !codes.includes(c)).join(', ')})`);
      if (facts.retrofit) want(has(codes, RETROFIT_PLAN_REASONS), 'retrofit: PLAN_DESCRIPTIVE_MODULE_TOUCHED and PLAN_CONFORMANCE_MISPLACED');
      want((d.reasons ?? []).every((r) => typeof r?.rule === 'string' && r.rule.length > 0), 'each reason with its rule');
      want(same(d.kinds_by_tier, KIND_INVENTORY), 'kinds_by_tier as the engine requires them');
      break;
    }
    case 'architect.routing':
      want(d.registered === 'engine:plan_check' && d.human === 'plan_approval', 'registered engine:plan_check, human plan_approval');
      want(Array.isArray(d.compared) && d.compared.length > 0 && typeof d.declarations === 'string', 'what is compared, and what a declaration can do');
      break;
    case 'verifier.kinds':
      want(setEq(d.kinds, CHECK_KINDS), 'every check kind');
      want(setEq(d.criteria_kinds, CRITERIA_KINDS), 'the kinds that cover criteria');
      want(same(d.by_tier, KIND_INVENTORY), 'by_tier as the engine requires them');
      break;
    case 'verifier.gate_kinds_floor':
      if (facts.tier) want(d.tier === facts.tier, `the project's tier ${facts.tier}`);
      want(same(d.floor, KIND_INVENTORY[d.tier]), 'the floor of that tier');
      want(has(d.gate_kinds, ['stage', 'alpha_authorize']), 'gate_kinds stage and alpha_authorize');
      break;
    case 'verifier.requires':
      want(d.member === 'requires' && same(d.values, ['environment', 'artifact_digest']), 'requires: environment, artifact_digest');
      want(has(d.kinds, ['post_deploy_behavior']), 'for post_deploy_behavior');
      break;
    case 'verifier.covers':
      want(d.member === 'covers' && d.criteria === 'criteria' && d.sensitive_areas === 'sensitive_areas', 'covers.criteria, covers.sensitive_areas');
      want(setEq(d.criteria_kinds, CRITERIA_KINDS), 'the kinds that cover criteria');
      want(has(d.refused_on, ['post_deploy_behavior']), 'refused on post_deploy_behavior');
      break;
    case 'verifier.secrets':
      want(d.member === 'secrets' && d.reference === 'deploy/<name>' && d.variable === 'SURETY_SECRET_<NAME>', 'secrets: deploy/<name> as SURETY_SECRET_<NAME>');
      want(d.environments === null || Array.isArray(d.environments), 'the environments (or null: unknown)');
      break;
    case 'verifier.post_deploy':
      want(setEq(d.kinds, ['post_deploy_behavior', 'post_deploy_identity']) && d.gate_kind === 'alpha_complete' && d.required === 'post_deploy_behavior', 'post-deploy kinds, alpha_complete, a required post_deploy_behavior check');
      want(d.variable === 'SURETY_TARGET_<NAME>', 'the target variable SURETY_TARGET_<NAME>');
      want(d.environments === null || Array.isArray(d.environments), 'the environments (or null: unknown)');
      break;
    case 'verifier.authoring_result':
      want(has(d.fields, ['governed_changes', 'deferred_criteria', ...(facts.retrofit ? ['adopted_tests'] : [])]), `the authoring result's fields${facts.retrofit ? ' with adopted_tests' : ''}`);
      want(typeof d.no_execution_authority === 'string' && /a proposal grants no execution authority/i.test(d.no_execution_authority), '"A proposal grants no execution authority"');
      break;
    case 'verifier.adoption_rule':
      want(d.field === 'adopted_tests' && same(d.dispositions, DISPOSITIONS) && d.protected_root === '.surety/checks/', 'adopted_tests, copied | replaced | application, .surety/checks/');
      want(typeof d.rule === 'string' && /acceptance logic/i.test(d.rule) && /dependency boundary/i.test(d.rule), 'the rule naming the acceptance logic and the dependency boundary');
      break;
    case 'builder.tasks':
      if (facts.stage) want(d.stage === facts.stage.number && d.goal === facts.stage.goal && same(d.tasks, facts.stage.tasks), `stage ${facts.stage.number}'s goal and tasks as registered`);
      else want(Number.isInteger(d.stage) && Array.isArray(d.tasks), 'stage and tasks');
      break;
    case 'builder.implements':
      if (facts.stage) want(setEq(d.implements, facts.stage.implements), `implements ${JSON.stringify(facts.stage.implements)}`);
      else want(Array.isArray(d.implements), 'implements');
      break;
    case 'builder.integration_obligations':
      if (facts.stage) want(same(d.integration_obligations, facts.stage.integration_obligations), 'the integration obligations as registered');
      else want(Array.isArray(d.integration_obligations), 'integration_obligations');
      break;
    case 'builder.dependency_interfaces':
      if (facts.stage) {
        want(setEq(d.depends_on, facts.stage.depends_on ?? []), `depends_on ${JSON.stringify(facts.stage.depends_on)}`);
        want(setEq((d.interfaces ?? []).map((i) => `${i?.module}:${i?.name}`), facts.dependencyInterfaces ?? []), `the dependencies' interfaces ${JSON.stringify(facts.dependencyInterfaces)}`);
      }
      want((d.interfaces ?? []).every((i) => ['stage', 'module', 'name', 'kind', 'description'].every((k) => k in (i ?? {}))), 'each interface with stage, module, name, kind, description');
      break;
    default:
      p.push(`${id}: not an element this module knows`);
  }
  return p;
}

// Every gap of one package against the ids it must carry and those it must
// not: listed in one sentence each.
export function packageProblems(files, ids, { absent = [], facts = {} } = {}) {
  const r = packageReads(files);
  const out = [];
  if (r.prompt === null) return ['no prompt.md in the package'];
  if (r.reads === null) out.push('manifest.json has no `reads` list');
  for (const id of ids) {
    if (r.reads !== null && !r.reads.includes(id)) out.push(`${id}: not in manifest.reads`);
    if (id in r.bad) out.push(`${id}: its block does not parse (${r.bad[id]})`);
    else out.push(...elementProblems(id, r.blocks[id], facts));
  }
  for (const id of absent) {
    if (id in r.blocks || (r.reads ?? []).includes(id)) out.push(`${id}: must not be in this package`);
  }
  return out;
}
