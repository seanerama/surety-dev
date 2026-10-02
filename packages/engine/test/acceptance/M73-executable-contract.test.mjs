// M73, the executable contract and the generated appendix (slice 6). Plan
// §3.7 M73 and §5; RN §3 ("direction of authority reverses") and its B17 and
// N02 rows; E20; D1-38, D1 §11.2; Review B10, B17, N02; build spec §2 item 6
// and §6; SEAM.md §94.
//
// The contract is what the engine executes: its schema, its enumerations,
// its transition tables, its decision kinds, its events, its configuration.
// The engine states it as one document (`surety contract export`, committed
// as packages/engine/api/schema.json), checks a contract document (`surety
// contract check`), and generates Appendix A from one (`surety contract
// appendix`). This file pins:
//
//   - the engine's own contract is valid, is the committed one, agrees with
//     the real schema of a store the engine made, and agrees with the
//     Verifier's expected tables, which hold the accepted corrections. The
//     hand-written Appendix A of D1 is not consulted and cannot override
//     them;
//   - the checker rejects each mutation the Plan names, one case each, and
//     says where;
//   - what is only lexical is labelled so: a contract whose every name is
//     declared, and which is wrong all the same, is rejected by a check that
//     is not the lexical one; and a valid result never claims that lifecycle
//     traces were checked;
//   - the appendix is generated from the contract it is given, and the
//     committed appendix is the generated one.
//
// The mutations are made here, on a copy of the engine's own export, in the
// document format SEAM.md §94 fixes. The schema cases use real SQLite: the
// store of a real engine, read with the pinned driver.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CLI, REPO_ROOT, engineEnv, installProject, makeTempDir, removeDir, engineFixture } from './harness/engine.mjs';
import { DECISIONS } from './harness/decisions.mjs';
import { CONTRACT } from './harness/fixtures.mjs';
import { makeRepo } from './harness/git.mjs';
import { tableNames, withStore } from './harness/store.mjs';
import { LIFECYCLE, WORK, legalEdges } from './harness/transitions.mjs';

const CONTRACT_REFUSED = 8;
const API_DIR = join(REPO_ROOT, 'packages', 'engine', 'api');
const D1 = join(REPO_ROOT, 'docs', 'design', 'sdlc-design-D1-engine-core.md');

// `surety contract <args>`: its exit status and what it wrote.
function contract(home, args) {
  const done = spawnSync(process.execPath, [CLI, 'contract', ...args], { env: engineEnv(home), cwd: home, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

// The result of a check: the last line of stdout, a JSON object.
function checkResult(done) {
  const last = done.stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

const copy = (value) => JSON.parse(JSON.stringify(value));
const pairs = (chains) => [...new Set(chains.flatMap((chain) => chain.slice(1).map((to, i) => `${chain[i]}→${to}`)))].sort();
const startsWith = (path, prefix) => Array.isArray(path) && prefix.every((key, i) => path[i] === key);

// The mutations the Plan names. Each changes one thing in a copy of the
// engine's contract; `at` is where the checker must point; `check` is the
// kind of check that must find it.
const MUTATIONS = [
  {
    name: 'an invalid common WorkItem edge: the common transition held → eligible made to lead to a state that is no WorkItemStatus',
    apply: (doc) => {
      doc.work_items.templates.resume.to = 'undeclared_test_state';
    },
    at: ['work_items', 'templates', 'resume'],
    check: 'lexical',
  },
  {
    name: 'an invalid last state in a chained edge: the path eligible → claimed → executing → complete made to end in a state that is no WorkItemStatus',
    apply: (doc) => {
      doc.work_items.kinds.verification.path = [...doc.work_items.kinds.verification.path.slice(0, -1), 'finished_test_state'];
    },
    at: ['work_items', 'kinds', 'verification'],
    check: 'lexical',
  },
  {
    name: 'a wrong enum: runs.state said to be of an enumeration that is not declared',
    apply: (doc) => {
      doc.tables.runs.fields.state.enum = 'NoSuchEnum';
    },
    at: ['tables', 'runs', 'fields', 'state'],
    check: 'lexical',
  },
  {
    name: 'a wrong field: snapshot_tree, a field of workspaces, assigned to runs',
    apply: (doc) => {
      doc.tables.runs.fields.snapshot_tree = doc.tables.workspaces.fields.snapshot_tree;
      delete doc.tables.workspaces.fields.snapshot_tree;
    },
    at: ['tables', 'runs', 'fields', 'snapshot_tree'],
    check: 'structural',
  },
  {
    name: 'a wrong foreign key: runs.work_item said to reference stages, a declared table that the real schema does not make it reference',
    apply: (doc) => {
      doc.tables.runs.fields.work_item.references = 'stages';
    },
    at: ['tables', 'runs', 'fields', 'work_item'],
    check: 'structural',
  },
  {
    name: 'a missing decision manifest: the enabled kind blocker with no dependency manifest',
    apply: (doc) => {
      delete doc.decisions.blocker.manifest;
    },
    at: ['decisions', 'blocker'],
    check: 'structural',
  },
  {
    name: 'an unowned operational declaration: an event type that is declared, is not reserved, and that nothing emits',
    apply: (doc) => {
      doc.enums.EventType = [...doc.enums.EventType, 'zz.unowned_m73'];
      doc.events['zz.unowned_m73'] = {};
    },
    at: ['events', 'zz.unowned_m73'],
    check: 'structural',
  },
];

describe('M73 the executable contract and the generated appendix', () => {
  // The engine's own contract, exported once. A case that cannot have it
  // fails with the reason.
  let exported = null;
  const fixture = (t) => {
    const home = makeTempDir('contract');
    t.after(() => removeDir(home));
    exported ??= (() => {
      const done = contract(home, ['export']);
      assert.equal(done.status, 0, `surety contract export exits 0 (status ${done.status}; stderr: ${done.stderr.slice(-600)})`);
      return { text: done.stdout, doc: JSON.parse(done.stdout) };
    })();
    const write = (doc, name = 'contract.json') => {
      const file = join(home, name);
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      return file;
    };
    return { home, doc: exported.doc, text: exported.text, write };
  };

  test("the engine's own contract is valid, is the committed one, and a valid result claims no more than was checked", (t) => {
    const { home, doc, write } = fixture(t);
    for (const section of ['enums', 'tables', 'work_items', 'transitions', 'decisions', 'events', 'config']) {
      assert.ok(doc[section] !== null && typeof doc[section] === 'object', `the contract has the section "${section}"`);
    }
    for (const args of [['check'], ['check', '--file', write(doc)]]) {
      const done = contract(home, args);
      const result = checkResult(done);
      assert.equal(done.status, 0, `surety contract ${args[0]}${args.length > 1 ? ' --file <the export>' : ''} exits 0 (stdout: ${done.stdout.slice(-600)})`);
      assert.deepEqual([result?.valid, result?.findings], [true, []], 'the contract is valid, with no finding');
      assert.deepEqual([...result.checked].sort(), ['lexical', 'structural'], 'the result says which checks were made');
      assert.ok(result.not_checked?.includes('lifecycle_traces'), `and that lifecycle traces were not among them: a clean check is not a trace (not_checked: ${JSON.stringify(result.not_checked)})`);
    }
    // The committed contract is the one the engine executes (D1 §11.2: the pin fails on drift).
    const committed = join(API_DIR, 'schema.json');
    assert.ok(existsSync(committed), 'packages/engine/api/schema.json exists');
    assert.deepEqual(JSON.parse(readFileSync(committed, 'utf8')), doc, 'packages/engine/api/schema.json is the contract the engine exports');
  });

  test('the contract is the schema of a real store: every table, column and foreign key the engine creates, and nothing else; every event the engine wrote is declared and owned', async (t) => {
    const { doc } = fixture(t);
    const fx = await engineFixture(t);
    const repoDir = makeTempDir('contract-repo');
    t.after(() => removeDir(repoDir));
    const project = await installProject(fx.engine, { repoPath: makeRepo(repoDir).path });
    assert.equal((await fx.engine.post(`/v1/projects/${project}/pause`, {})).status, 200);
    await fx.engine.stop();

    const real = withStore(fx.home, (db) => {
      const tables = {};
      for (const name of tableNames(db)) {
        tables[name] = {
          columns: db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name).sort(),
          references: Object.fromEntries(db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map((key) => [key.from, key.table])),
        };
      }
      return { tables, eventTypes: db.prepare('SELECT DISTINCT "type" FROM "events"').all().map((row) => row.type) };
    });
    assert.deepEqual(Object.keys(doc.tables).sort(), Object.keys(real.tables).sort(), 'the contract declares exactly the tables the engine creates');
    for (const [name, table] of Object.entries(real.tables)) {
      const fields = doc.tables[name].fields;
      assert.deepEqual(Object.keys(fields).sort(), table.columns, `${name}: the contract declares exactly its columns`);
      const declared = Object.fromEntries(Object.entries(fields).filter(([, field]) => field.references !== undefined).map(([field, spec]) => [field, spec.references]));
      assert.deepEqual(declared, table.references, `${name}: the contract declares exactly its foreign keys`);
      for (const [field, spec] of Object.entries(fields)) {
        if (spec.enum !== undefined) assert.ok(Array.isArray(doc.enums[spec.enum]), `${name}.${field}: its enumeration ${spec.enum} is declared`);
      }
    }
    assert.ok(real.eventTypes.length >= 3, 'the fixture is live: the engine wrote events');
    for (const type of real.eventTypes) {
      assert.ok(doc.enums.EventType.includes(type), `the event ${type}, which the engine wrote, is an EventType`);
      assert.ok(typeof doc.events[type]?.owner === 'string' && doc.events[type].owner !== '' && doc.events[type].reserved !== true, `and is declared with its owner, not as reserved (${JSON.stringify(doc.events[type])})`);
    }
  });

  test("the contract holds the accepted corrections, as the Verifier's tables state them: D1's hand-written appendix overrides none", (t) => {
    const { doc } = fixture(t);
    // The work-item table, kind by kind (correction 11).
    assert.deepEqual(Object.keys(doc.work_items.kinds).sort(), Object.keys(WORK.kinds).sort(), 'the work kinds');
    for (const kind of Object.keys(WORK.kinds)) {
      const edges = (table) => legalEdges(kind, table).map((edge) => `${edge.from}→${edge.to}`).sort();
      assert.deepEqual(edges(doc.work_items), edges(WORK), `${kind}: the legal edges are the contract table's, no more and no fewer`);
      assert.equal(doc.work_items.kinds[kind].m1, WORK.kinds[kind].m1, `${kind}: whether M1 dispatches it`);
    }
    // Corrections 12 and 13, and 4: a run can end from created; a quarantined domain can be terminated; an authorization is proposed first.
    assert.deepEqual(pairs(doc.transitions.RunState), pairs(LIFECYCLE.run.edges), 'the run transitions');
    assert.deepEqual(pairs(doc.transitions.DomainStatus), pairs(LIFECYCLE.domain.edges), 'the domain transitions');
    assert.deepEqual(
      pairs(doc.transitions.AuthorizationStatus),
      ['consumed→superseded', 'issued→consumed', 'issued→superseded', 'proposed→issued', 'proposed→superseded'],
      'the authorization transitions (build spec §6 correction 4)',
    );
    assert.ok(doc.enums.AuthorizationStatus.includes('proposed'), 'AuthorizationStatus has `proposed`');
    // Correction 5 and build spec §3: eleven kinds have effect, the two of RN R4 among them, each with its manifest.
    for (const [kind, expected] of Object.entries(DECISIONS.kinds)) {
      assert.ok(doc.enums.DecisionKind.includes(kind), `${kind} is a DecisionKind`);
      assert.equal(doc.decisions[kind]?.enabled, true, `${kind} is enabled`);
      for (const key of expected.manifest) assert.ok(doc.decisions[kind].manifest?.includes(key), `${kind}: its manifest binds "${key}"`);
    }
    const enabled = Object.keys(doc.decisions).filter((kind) => doc.decisions[kind].enabled).sort();
    assert.deepEqual(enabled, Object.keys(DECISIONS.kinds).sort(), 'no other decision kind is enabled in M1');
    // Correction 20: the closed configuration, key by key.
    for (const scope of ['engine', 'project']) {
      const expected = Object.fromEntries(Object.entries(CONTRACT[scope]).filter(([key]) => !key.startsWith('$')));
      assert.deepEqual(Object.keys(doc.config[scope]).sort(), Object.keys(expected).sort(), `the ${scope} configuration keys`);
      for (const [key, spec] of Object.entries(expected)) {
        for (const bound of ['default', 'min', 'max']) {
          if (typeof spec[bound] === 'number') assert.equal(doc.config[scope][key][bound], spec[bound], `${scope}.${key}: ${bound}`);
        }
      }
    }
  });

  for (const mutation of MUTATIONS) {
    test(`the checker rejects ${mutation.name}`, (t) => {
      const { home, doc, write } = fixture(t);
      const mutated = copy(doc);
      mutation.apply(mutated);
      const done = contract(home, ['check', '--file', write(mutated)]);
      const result = checkResult(done);
      assert.equal(done.status, CONTRACT_REFUSED, `the mutated contract is refused with status ${CONTRACT_REFUSED} (status ${done.status}; stdout: ${done.stdout.slice(-600)}; stderr: ${done.stderr.slice(-300)})`);
      assert.equal(result?.valid, false, 'the result says the contract is not valid');
      const found = (result.findings ?? []).filter((finding) => startsWith(finding.path, mutation.at));
      assert.ok(found.length >= 1, `a finding points at ${mutation.at.join(' / ')} (findings: ${JSON.stringify(result.findings).slice(0, 800)})`);
      assert.ok(found.every((finding) => typeof finding.message === 'string' && finding.message !== ''), 'and says what is wrong');
      assert.ok(found.some((finding) => finding.check === mutation.check), `it is found by the ${mutation.check} check (${JSON.stringify(found.map((finding) => finding.check))})`);
      if (mutation.check === 'structural') {
        // Every name in this document is declared. Only a check that is not lexical can reject it.
        assert.deepEqual(result.findings.filter((finding) => finding.check === 'lexical'), [], 'the lexical check finds nothing wrong with it: lexical success is not validity');
      }
      // The unmutated contract is still accepted: the checker does not refuse everything.
      assert.equal(contract(home, ['check', '--file', write(doc, 'unmutated.json')]).status, 0);
    });
  }

  test('the appendix is generated from the contract it is given, states the corrections where the hand-written one does not, and the committed appendix is the generated one', (t) => {
    const { home, doc, write } = fixture(t);
    const generated = contract(home, ['appendix']);
    assert.equal(generated.status, 0, `surety contract appendix exits 0 (stderr: ${generated.stderr.slice(-600)})`);
    assert.equal(contract(home, ['appendix']).stdout, generated.stdout, 'generating twice gives the same text');
    const enumLine = (name, values) => `- **${name}:** ${values.join(', ')}.`;
    const lines = generated.stdout.split('\n');
    for (const [name, values] of Object.entries(doc.enums)) {
      assert.ok(lines.includes(enumLine(name, values)), `the appendix states the enumeration ${name} as the contract has it (expected the line: ${enumLine(name, values).slice(0, 200)})`);
    }
    for (const table of Object.keys(doc.tables)) assert.ok(generated.stdout.includes(table), `the appendix names the table ${table}`);

    // It follows its source: the same contract with one enumeration in another order gives another appendix.
    const reordered = copy(doc);
    reordered.enums.Severity = [...doc.enums.Severity].reverse();
    const fromFile = contract(home, ['appendix', '--file', write(reordered)]);
    assert.equal(fromFile.status, 0, `surety contract appendix --file exits 0 (stderr: ${fromFile.stderr.slice(-600)})`);
    assert.ok(fromFile.stdout.split('\n').includes(enumLine('Severity', reordered.enums.Severity)), 'the appendix of a changed contract shows the change');
    assert.equal(fromFile.stdout.split('\n').includes(enumLine('Severity', doc.enums.Severity)), false, 'and no longer what it replaced');

    // The hand-written appendix of D1 says otherwise in the places that were corrected, and was not copied.
    const handWritten = readFileSync(D1, 'utf8');
    assert.ok(handWritten.includes('- **AuthorizationStatus:** issued, consumed, superseded.'), "the fixture is live: D1's Appendix A still has the uncorrected line");
    assert.equal(lines.includes('- **AuthorizationStatus:** issued, consumed, superseded.'), false, 'the generated appendix does not repeat it');
    const decisionKinds = lines.find((line) => line.startsWith('- **DecisionKind:**')) ?? '';
    for (const kind of ['finding_applicability_exclusion', 'check_correction_tightening']) assert.ok(decisionKinds.includes(kind), `the generated appendix has the decision kind ${kind} (RN R4)`);

    const committed = join(API_DIR, 'appendix-a.md');
    assert.ok(existsSync(committed), 'packages/engine/api/appendix-a.md exists');
    assert.equal(readFileSync(committed, 'utf8'), generated.stdout, 'packages/engine/api/appendix-a.md is the appendix generated from the contract');
  });
});
