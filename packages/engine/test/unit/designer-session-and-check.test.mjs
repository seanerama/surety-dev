// Developer tests for slice 41 (the Designer session and the design
// check): a Designer's own fixture read against B.8's shapes; the plan
// check's clause 5 (targets and technologies); a turn's result outside B.12
// named by its field; the Designer's own session budget key.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { shapeProblem, fixtureProblem } = await import(join(dist, 'design', 'shape.js'));
const { technologyAdmits } = await import(join(dist, 'plan', 'check.js'));
const { sessionReplyProblem } = await import(join(dist, 'sessions', 'session.js'));
const { runBudgetKey } = await import(join(dist, 'store', 'transitions', 'ledger.js'));

const ITEM = { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 40 }, quantity: { type: 'integer', minimum: 0, maximum: 99 } }, required: ['name', 'quantity'] };
const LIST = { type: 'object', properties: { items: { type: 'array', collection: true, items: ITEM } }, required: ['items'] };
const INV = {
  interfaces: [
    { name: 'list-items', response: LIST, request: { type: 'null' }, errors: [] },
    { name: 'add-item', response: ITEM, request: ITEM, errors: [{ code: 'name_taken', when: 'taken' }] },
  ],
  fixtures: [
    { interface: 'list-items', state: 'ok', path: 'inventory/fixtures/list-items.ok.json' },
    { interface: 'list-items', state: 'loading', path: 'inventory/fixtures/list-items.loading.json' },
    { interface: 'add-item', state: 'error:name_taken', path: 'inventory/fixtures/add-item.error:name_taken.json' },
    { interface: 'add-item', state: 'invalid_input', path: 'inventory/fixtures/add-item.invalid_input.json' },
  ],
};
const buf = (v) => Buffer.from(JSON.stringify(v));

test('a value against B.8: types, required, closed properties, bounds', () => {
  assert.equal(shapeProblem({ items: [{ name: 'rice', quantity: 2 }] }, LIST, { bounds: true }), null);
  assert.match(shapeProblem({ items: [{ name: 'rice', quantity: 'two' }] }, LIST, { bounds: true }), /quantity: string/);
  assert.match(shapeProblem({ items: [{ name: 'rice' }] }, LIST, { bounds: true }), /required property "quantity"/);
  assert.match(shapeProblem({ items: [], extra: 1 }, LIST, { bounds: true }), /"extra" is not a property/);
  assert.match(shapeProblem({ name: 'x', quantity: 100 }, ITEM, { bounds: true }), /above its maximum/);
  assert.equal(shapeProblem({ name: 'x', quantity: 100 }, ITEM, { bounds: false }), null);
});

test('a file under mockups/data/: named as an inventory fixture and valid as that fixture is', () => {
  assert.equal(fixtureProblem('list-items.ok.json', buf({ items: [{ name: 'rice', quantity: 2 }] }), INV), null);
  assert.match(fixtureProblem('list-items.ok.json', buf({ items: [{ name: 'rice', quantity: 'two' }] }), INV), /string/);
  assert.equal(fixtureProblem('list-items.loading.json', buf(null), INV), null);
  assert.equal(fixtureProblem('add-item.error:name_taken.json', buf({ code: 'name_taken', message: 'taken' }), INV), null);
  assert.match(fixtureProblem('add-item.error:name_taken.json', buf({ code: 'other', message: 'x' }), INV), /code/);
  assert.equal(fixtureProblem('add-item.invalid_input.json', buf({ name: '', quantity: -1 }), INV), null);
  assert.match(fixtureProblem('add-item.nothing.json', buf({}), INV), /not named/);
  assert.match(fixtureProblem('list-items.ok.json', Buffer.from('{'), INV), /not JSON/);
  assert.match(fixtureProblem('list-items.ok.json', buf({ items: [] }), null), /no recorded inventory/);
});

test('D7 §4.1 admissibility: exactly the table; other on every target', () => {
  const targets = ['web', 'android', 'ios', 'macos', 'windows', 'linux'];
  const admitted = (tech) => targets.filter((t) => technologyAdmits(tech, t));
  assert.deepEqual(admitted('html_css'), ['web']);
  assert.deepEqual(admitted('three_js'), ['web']);
  assert.deepEqual(admitted('streamlit'), ['web']);
  assert.deepEqual(admitted('react_native'), ['android', 'ios']);
  assert.deepEqual(admitted('flutter'), targets);
  assert.deepEqual(admitted('swiftui'), ['ios', 'macos']);
  assert.deepEqual(admitted('compose'), ['android']);
  assert.deepEqual(admitted('other'), targets);
  assert.deepEqual(admitted('cobol'), []);
});

test('a turn result outside B.12 is named by its field; findings only for the Designer', () => {
  const base = { status: 'completed', summary: 's', reply: 'r', artifact_changed: false };
  assert.equal(sessionReplyProblem(base, 'designer'), null);
  assert.match(sessionReplyProblem({ ...base, mood: 'calm' }, 'designer'), /"mood" is not a field/);
  assert.match(sessionReplyProblem({ ...base, findings: [] }, 'architect'), /"findings" is not a field/);
  assert.equal(sessionReplyProblem({ ...base, findings: [{ category: 'contract_conflict', severity: 'low', message: 'm', interface: 'add-item' }] }, 'designer'), null);
  assert.match(sessionReplyProblem({ ...base, findings: [{ category: 'retry', severity: 'low', message: 'm' }] }, 'designer'), /"findings"/);
  assert.match(sessionReplyProblem('text', 'designer'), /not a JSON object/);
});

test('a Designer session budgets on designer_session_budget_billable_tokens; every other run on the run budget', () => {
  assert.equal(runBudgetKey({ kind: 'session', role: 'designer' }), 'designer_session_budget_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'session', role: 'architect' }), 'budget_run_billable_tokens');
  assert.equal(runBudgetKey({ kind: 'one_shot', role: 'builder' }), 'budget_run_billable_tokens');
});
