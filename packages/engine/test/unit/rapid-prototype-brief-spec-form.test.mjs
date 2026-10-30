// Developer tests for the brief preparation's specification form (the
// first real Rapid Prototype trial, 2026-10-30: run
// run_01M657B0R80EVSDQZ48TRC417A of the Lap-Lab prototype wrote
// .surety/spec/spec.md with `## 4 Requirements`, `### R1 — <title>`,
// numbered criteria and no requirement index, and ended failed
// (invalid_result): "the prepared specification is not readable: the
// specification has neither section 4 (Requirements) nor section 5
// (Requirement index)". Its package had stated no form: a brief
// preparation's package carried no `surety-reads` elements).
//
// The fixtures are that run's specification and result.json, byte for byte
// (fixtures/brief-preparation-2026-10-30/; sha256 66a924b5… and 5c07e504…).
//
//   1. The package a brief preparation is given states the exact path, the
//      exact headings and the result's shape, and carries the Spec Writer's
//      forms as `surety-reads` blocks (package `brief_preparation`).
//   2. The reader, on the run's own text, refuses it naming what it found:
//      the headings as written and that none is in the section form.
//   3. The same content in the stated form (five requirements) is read,
//      has no finding that blocks approval, and the run's own brief is
//      accepted against it.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist');
const { writeContextPackage } = await import(join(dist, 'invoke', 'sandbox', 'context.js'));
const { PACKAGE_ELEMENTS } = await import(join(dist, 'packages', 'elements.js'));
const { parseSpecification } = await import(join(dist, 'spec', 'semantics.js'));
const { blockingFindings } = await import(join(dist, 'spec', 'approval.js'));
const B = await import(join(dist, 'prototype', 'brief.js'));
const Database = (await import('better-sqlite3')).default;
const { migrate } = await import(join(dist, 'store', 'migrate.js'));
const { transact, ENGINE_ACTOR } = await import(join(dist, 'store', 'transitions', 'tx.js'));
const { setEngineSettings } = await import(join(dist, 'store', 'transitions', 'settings.js'));
const { configureHarness } = await import(join(dist, 'testing', 'seam.js'));
const { configureGit } = await import(join(dist, 'git', 'exec.js'));
const { prepareNewProject } = await import(join(dist, 'setup', 'projects.js'));
const { bootstrapProject } = await import(join(dist, 'store', 'transitions', 'project.js'));
const R = await import(join(dist, 'store', 'transitions', 'runs.js'));
const { answerQueued } = await import(join(dist, 'store', 'transitions', 'queue.js'));
const { registerRef, integrationRef } = await import(join(dist, 'store', 'transitions', 'repo.js'));
const { readIteration, iterationReceipt } = await import(join(dist, 'prototype', 'iterations.js'));

const FIX = join(here, 'fixtures', 'brief-preparation-2026-10-30');
const RUN_SPEC = readFileSync(join(FIX, 'spec-as-written.md'), 'utf8');
const RUN_RESULT = JSON.parse(readFileSync(join(FIX, 'result-as-written.json'), 'utf8'));

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surety-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
function blocks(prompt) {
  const out = {};
  for (const m of prompt.matchAll(/^```json surety-reads ([a-z_.]+)\n([\s\S]*?)\n```$/gm)) out[m[1]] = JSON.parse(m[2]);
  return out;
}

const FACTS = {
  iteration: 'pit_1',
  iteration_seq: 1,
  idea_path: '.surety/idea.md',
  idea_version: 1,
  objectives: { ...B.OBJECTIVES },
  model_fields: B.MODEL_FIELDS,
  engine_fields: B.ENGINE_FIELDS,
  previous: null,
  continues: null,
};

function preparationPackage(t) {
  const dir = scratch(t);
  const claim = { run: 'run_1', role: 'spec_writer', work_item: 'wrk_1', work_kind: 'brief_preparation', base_revision: 'b'.repeat(40), attempt: null, check_outputs: [] };
  const facts = { run: { id: 'run_1', role: 'spec_writer', base_revision: 'b'.repeat(40), content_hash: null }, work_item: { id: 'wrk_1', kind: 'brief_preparation', subject: '{}', project: 'prj_1' }, stage: null, requirements: [], modules: [], phase_plan: null, candidate: null, resumed: null, prototype_brief: FACTS };
  writeContextPackage(dir, claim, facts, { probe: false });
  const prompt = read(dir, 'prompt.md');
  return { prompt, reads: blocks(prompt), manifest: JSON.parse(read(dir, 'manifest.json')), schema: JSON.parse(read(dir, 'result-schema.json')) };
}

test("a brief preparation's package states the exact path, the exact headings, the requirement and index forms and the result's shape", (t) => {
  const p = preparationPackage(t);
  // The package and its elements: the Spec Writer's forms, as a session's and a spec change's carry them.
  assert.equal(p.manifest.package, 'brief_preparation');
  assert.deepEqual(p.manifest.reads, [...PACKAGE_ELEMENTS.brief_preparation]);
  assert.deepEqual(Object.keys(p.reads), [...PACKAGE_ELEMENTS.brief_preparation]);
  for (const id of ['spec_writer.header_fields', 'spec_writer.requirement_form', 'spec_writer.index_columns', 'spec_writer.index_cells', 'spec_writer.environment_fields', 'spec_writer.approval_blockers']) assert.ok(p.reads[id], `the package states ${id}`);
  assert.equal(p.reads['spec_writer.requirement_form'].section, '## 4. Requirements');
  assert.equal(p.reads['spec_writer.requirement_form'].heading, '### R<n>. <title>');
  assert.equal(p.reads['spec_writer.requirement_form'].criterion, '- R<n>.<m> <text>');
  assert.equal(p.reads['spec_writer.index_columns'].section, '## 5. Requirement index');
  // The prompt's own text: the path, every heading in its form, the forms the run got wrong, and the result.
  assert.match(p.prompt, /The engine reads \.surety\/spec\/spec\.md \(exactly that path\)/);
  for (const [n, title] of B.BRIEF_SPEC_SECTIONS) assert.ok(p.prompt.includes(`\`## ${n}. ${title}\``), `the prompt names the heading "## ${n}. ${title}"`);
  assert.ok(p.prompt.includes('`## 4 Requirements` without the full stop is not read'), 'the prompt names the run\'s heading form as unread');
  assert.ok(p.prompt.includes('`### R<n>. <title>` (not `### R<n> — <title>`)'), 'the prompt names the requirement heading form and the run\'s');
  assert.ok(p.prompt.includes('`- R<n>.<m> <text>` (not a numbered list)'), 'the prompt names the criterion form');
  assert.ok(p.prompt.includes('`Key`, `Title`, `Phase`, `Sensitive areas`, `Criteria`'), 'the prompt names the index columns');
  assert.ok(p.prompt.includes('`**Spec version:** 1`') && p.prompt.includes('`**Tier:** T1`') && p.prompt.includes('`**Status:** draft`'), 'the prompt names the header lines');
  assert.match(p.prompt, /Write your result to \/surety\/out\/result\.json as \/surety\/context\/result-schema\.json states: `status`, `summary` and `brief`/);
  // The stated forms precede the blocks they point to.
  assert.ok(p.prompt.indexOf("The specification's form.") < p.prompt.indexOf('## What the engine reads: Each requirement (section 4)'));
  assert.deepEqual(p.schema.required, ['status', 'summary', 'brief']);
  assert.deepEqual(p.schema.properties.brief.required, [...B.MODEL_FIELDS]);
});

test("the reader refuses the run's own specification naming the headings it found and the form it reads", () => {
  const parsed = parseSpecification(RUN_SPEC);
  assert.equal(parsed.readable, false);
  assert.equal(parsed.representation, null);
  assert.equal(parsed.findings.length, 1);
  const [f] = parsed.findings;
  assert.equal(f.code, 'section_missing');
  assert.ok(f.why.startsWith('the specification has neither section 4 (Requirements) nor section 5 (Requirement index): no heading of the form "## 4. Requirements" or "## 5. Requirement index"; '), f.why);
  assert.ok(f.why.includes('its 11 level-2 headings are "## 1 Purpose", "## 2 Users", "## 3 Scope of this prototype", "## 4 Requirements", "## 5 Behaviour and data model"'), f.why);
  assert.ok(f.why.endsWith('(none of them in the section form "## <n>. <title>")'), f.why);
  // The cause, by the parser's own form: with the full stop alone section 4
  // is read, and its requirements still are not (`### R1 — …` is not a
  // requirement heading; numbered criteria are not criteria).
  const dotted = parseSpecification(RUN_SPEC.replace(/^## (\d+) /gm, '## $1. '));
  assert.equal(dotted.readable, true);
  assert.equal(dotted.representation.requirements.length, 0);
  assert.ok(blockingFindings(dotted.findings).some((x) => x.code === 'index_invalid' || x.code === 'index_missing' || x.code === 'header_missing'));
});

// The run's content, in the form the package states: its title, the header,
// the sections headed `## <n>. <title>`, its five requirements as
// `### R<n>. <title>` with their objective as the statement and their
// numbered criteria as `- R<n>.<m>`, the index, one environment.
function inStatedForm(text) {
  const lines = text.split('\n');
  const reqs = [];
  let cur = null;
  let inS4 = false;
  for (const line of lines) {
    if (/^## /.test(line)) inS4 = /^## 4 Requirements/.test(line);
    if (!inS4) continue;
    const h = /^### (R\d+) — (.*)$/.exec(line);
    if (h) {
      cur = { key: h[1], title: h[2], statement: '', criteria: [] };
      reqs.push(cur);
      continue;
    }
    if (!cur) continue;
    const o = /^Objective: (.*)$/.exec(line);
    if (o) cur.statement = o[1];
    const c = /^(\d+)\. (.*)$/.exec(line);
    if (c) cur.criteria.push(c[2]);
  }
  const section = (n) => {
    const [, title] = B.BRIEF_SPEC_SECTIONS.find(([k]) => k === n);
    return `## ${n}. ${title}`;
  };
  const out = ['# Lap-Lab', '', '**Spec version:** 1', '**Status:** draft', '**Tier:** T1', '**Owner:** Sean', ''];
  out.push(section(1), '', 'A desktop browser game in which the player acts as a race engineer.', '');
  out.push(section(2), '', '- Manual driving', '');
  out.push(section(3), '', 'Adults with general technical curiosity, on a desktop browser.', '');
  out.push(section(4), '');
  for (const r of reqs) {
    out.push(`### ${r.key}. ${r.title}`, '', r.statement, '', '**Sensitive areas:** none', '', '**Acceptance criteria**', '');
    r.criteria.forEach((c, i) => out.push(`- ${r.key}.${i + 1} ${c}`));
    out.push('');
  }
  out.push(section(5), '', '| Key | Title | Phase | Sensitive areas | Criteria |', '|---|---|---|---|---|');
  for (const r of reqs) out.push(`| ${r.key} | ${r.title} | 1 | none | ${r.criteria.map((_, i) => `${r.key}.${i + 1}`).join(', ')} |`);
  out.push('', section(6), '', '| Module | Paths | Sensitive areas |', '|---|---|---|', '| app | `index.html`, `src/` | none |', '');
  out.push(section(7), '', '### alpha', '', '- **Purpose:** the owner\'s prototype target', '- **Target:** `local_service`, target `app`.', '- **Runtime and start command:** `node server.mjs`.', '- **Port:** `PORT`.', '');
  out.push(section(8), '', '- Desktop only.', '', section(9), '', 'A static single-page app.', '', section(10), '', 'None.', '', section(11), '', '| Version | Date | Change | Approved by |', '|---|---|---|---|', '');
  return { text: out.join('\n'), reqs };
}

test("the same content in the stated form, five requirements, is read with no blocking finding and the run's own brief is accepted against it", () => {
  const { text, reqs } = inStatedForm(RUN_SPEC);
  assert.deepEqual(reqs.map((r) => r.key), ['R1', 'R2', 'R3', 'R4', 'R5']);
  assert.ok(reqs.every((r) => r.statement !== '' && r.criteria.length > 0), 'each requirement has its objective and criteria');
  const parsed = parseSpecification(text);
  assert.equal(parsed.readable, true);
  assert.deepEqual(blockingFindings(parsed.findings), [], JSON.stringify(parsed.findings));
  assert.deepEqual(parsed.representation.requirements.map((r) => [r.key, r.criteria.length]), reqs.map((r) => [r.key, r.criteria.length]));
  assert.deepEqual(parsed.representation.environments.map((e) => e.name), ['alpha']);
  assert.equal(parsed.representation.header.tier, 'T1');
  // The run's result.json, as written: its brief is in the form the engine accepts.
  assert.deepEqual(Object.keys(RUN_RESULT), ['status', 'summary', 'brief']);
  const model = B.validateModelBrief(RUN_RESULT.brief, parsed.representation);
  assert.ok('brief' in model, JSON.stringify(model));
  assert.equal(model.brief.objectives.length, 5);
});

// ---- 4. the failed preparation's usage on the iteration read --------------------------------

setEngineSettings({ lease_ttl: 600, git_deadline: 30, decision_targets: {}, incarnation: 'inc_1' });
const HUMAN = { actor_kind: 'human', actor_id: null, request_id: 'req-1' };
const AT = '2026-10-30T00:00:00.000Z';

test("a preparation that ends failed (invalid_result) is counted in the iteration's preparation subtotal, on the read and the receipt", async (t) => {
  assert.equal(configureHarness(true, []), null);
  t.after(() => configureHarness(false, []));
  const dir = mkdtempSync(join(tmpdir(), 'surety-bpf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  mkdirSync(join(home, 'scratch'), { recursive: true });
  configureGit({ home, incarnation: 'test', deadlineSeconds: 30, outputCap: 1048576 });
  const db = new Database(join(dir, 'store.db'));
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  migrate(db, join(here, '..', '..', 'migrations'));
  db.prepare(`INSERT INTO engine_incarnations (id, created_at, pid, started_at, host_boot_id) VALUES ('inc_1', ?, 1, ?, 'boot')`).run(AT, AT);
  const rt = { home, scratch: join(home, 'scratch'), setting: () => 30 };
  const prepared = await prepareNewProject(rt, { name: 'Lap-Lab', idea: 'A race-engineering game.', dev_repo_path: join(dir, 'app'), mode: 'rapid_prototype' });
  const p = transact(db, HUMAN, (tx) => bootstrapProject(tx, prepared)).project;
  db.prepare(`UPDATE projects SET registration_state = 'registered', paused = 0 WHERE id = ?`).run(p.id);
  transact(db, ENGINE_ACTOR, (tx) => registerRef(tx, { project: p.id, ref: integrationRef('main'), kind: 'integration', expected: 'sha_boot' }));
  const d = db.prepare(`SELECT * FROM decisions WHERE project = ? AND kind = 'prototype_preparation_approval'`).get(p.id);
  transact(db, HUMAN, (tx) => answerQueued(tx, { project: p.id, decision: d.id, option: 'approve', preview_hash: d.preview_hash, note: null }));
  const item = db.prepare(`SELECT * FROM work_items WHERE project = ? AND kind = 'brief_preparation'`).get(p.id);
  const c = transact(db, ENGINE_ACTOR, (tx) => R.claimDispatch(tx, { project: p.id, workItem: item.id, incarnation: 'inc_1', scripted: 'scripted-1' }));
  const inv = db.prepare('SELECT id FROM invocation_receipts WHERE run = ?').get(c.run).id;
  const dom = db.prepare('SELECT id FROM execution_domains WHERE run = ?').get(c.run).id;
  transact(db, ENGINE_ACTOR, (tx) => {
    R.dispatchStarted(tx, { run: c.run, invocation: inv });
    R.recordLaunch(tx, { run: c.run, invocation: inv, domain: dom, pid: 999999, pgid: 999999, startTime: null });
  });
  // The trial's normalized usage (billable_in 23,396; cached_in 106,918; out 8,697), on the scripted provider here.
  transact(db, ENGINE_ACTOR, (tx) => R.recordUsage(tx, { run: c.run, generation: 1, invocation: inv, semantics: 'cumulative', raw: { input_tokens: 23396, cache_read_tokens: 106918, output_tokens: 8697 } }));
  transact(db, ENGINE_ACTOR, (tx) => R.beginEnd(tx, { run: c.run, outcome: 'failed', reason: 'invalid_result' }));
  transact(db, ENGINE_ACTOR, (tx) => R.domainTerminated(tx, { domain: dom, observed: true }));
  transact(db, ENGINE_ACTOR, (tx) => R.finishRun(tx, { run: c.run, invocations: { [inv]: 'ended' }, recovery: null }));
  const iterationId = db.prepare('SELECT iteration FROM runs WHERE id = ?').get(c.run).iteration;
  assert.ok(iterationId, 'the preparation run is attributed to the iteration');
  for (const read of [readIteration(db, { project: p.id, iteration: iterationId }), iterationReceipt(db, { project: p.id, iteration: iterationId })]) {
    // The scripted provider has no price: its cost is unknown (null), never 0.
    assert.deepEqual(read.usage.totals.preparation, { runs: 1, tokens: 23396 + 106918 + 8697, usd: null });
    const run = read.usage.runs.find((r) => r.id === c.run);
    assert.deepEqual([run.work_kind, run.outcome], ['brief_preparation', 'failed']);
    assert.deepEqual([run.invocations[0].usage.state, run.invocations[0].usage.billable_in, run.invocations[0].usage.cached_in, run.invocations[0].usage.out], ['complete', 23396, 106918, 8697]);
  }
});
