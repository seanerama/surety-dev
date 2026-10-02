// M74, the invocation boundary (slice 6). Plan §3.7 M74 ("inspect ... the
// package/launch graph"; "insert a forbidden model-launch path in a mutation
// fixture"; "backend spawn outside the choke point fails the boundary
// test"); D1 §§11.2, 15.4, 17(11); Review §8.3 (invariants 9 and 12);
// SEAM.md §95. The row's API cases are in `M74-fixture-semantics.test.mjs`,
// its seam-confinement cases in `M74-seam-confinement.test.mjs` (slice 1).
//
// Three inspections, none of which needs a running engine:
//   - the launch graph: the engine's source names a module that can start a
//     process only in the choke point, in the git runner and in the seam
//     folder (harness/launch-lint.mjs states the rule and its limits);
//   - the mutation fixture: the same inspection, given the engine's source
//     with a launch path inserted somewhere else, in each form such a path
//     can be written, reports it; given the same code inside the choke point,
//     or a types-only import, it does not;
//   - the package graph: what the engine package offers a client is the API
//     and nothing callable, so a UI or any other client can invoke a model or
//     change engine state only through the API.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from './harness/engine.mjs';
import { ALLOWED, inspectLaunches, launchSites } from './harness/launch-lint.mjs';
import { formatViolations, readSources } from './harness/source-lint.mjs';

const ENGINE = join(REPO_ROOT, 'packages', 'engine');
const SRC = join(ENGINE, 'src');
const UI = join(REPO_ROOT, 'packages', 'ui');

// Launch paths a change could add, each in a file that is not one of the
// allowed places. `file` is created or, if it exists, has `text` appended.
const FORBIDDEN = [
  { what: 'a static import of spawn in the scheduler', file: 'scheduler/tick.ts', text: `\nimport { spawn } from 'node:child_process';\nexport const launchModel = (prompt: string) => spawn('claude', ['-p', prompt]);\n` },
  { what: 'a namespace import without the node: prefix in a new file', file: 'gate/launch.ts', text: `import * as cp from 'child_process';\nexport const run = () => cp.execFile('codex', ['exec']);\n` },
  { what: 'a dynamic import in the API server', file: 'api/server.ts', text: `\nexport async function launchFromRoute() {\n  const { spawn } = await import('node:child_process');\n  return spawn('claude', []);\n}\n` },
  { what: 'a require through createRequire in the store', file: 'store/launch.ts', text: `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const run = () => require('child_process').spawnSync('claude');\n` },
  { what: 'a re-export that hands the module on', file: 'runs/end.ts', text: `\nexport { spawn as startProcess } from 'node:child_process';\n` },
  { what: 'the built-in module asked for by name', file: 'recovery/launch.ts', text: `export const run = () => process.getBuiltinModule('node:child_process').spawn('claude');\n` },
  { what: 'a fork through the cluster module', file: 'decisions/launch.ts', text: `import cluster from 'node:cluster';\nexport const run = () => cluster.fork();\n` },
];

// The engine's sources with one mutation applied.
function mutated(sources, { file, text }) {
  const found = sources.some((source) => source.file === file);
  return found ? sources.map((source) => (source.file === file ? { file, text: source.text + text } : source)) : [...sources, { file, text }];
}

describe('M74 the invocation boundary', () => {
  test("the engine's source starts a process only in the choke point, in the git runner and in the seam folder", () => {
    const sources = readSources(SRC);
    assert.ok(sources.length > 0, 'there is source to inspect');
    const sites = launchSites(sources);
    assert.ok(sites.some((file) => file.startsWith('invoke/')), `the inspection finds the choke point's own launch (files that name a process-starting module: ${sites.join(', ') || 'none'})`);
    const violations = inspectLaunches(sources);
    assert.equal(violations.length, 0, `D1 §15.4: a process is started only in ${ALLOWED.map((place) => `${place.where} (${place.why})`).join(', ')}.\n${formatViolations(violations)}\n`);
  });

  test('a launch path inserted anywhere else fails the inspection, in every form it can be written; the same code in the choke point, and a types-only import, do not', () => {
    const sources = readSources(SRC);
    const clean = inspectLaunches(sources).length;
    for (const mutation of FORBIDDEN) {
      const found = inspectLaunches(mutated(sources, mutation)).filter((violation) => violation.file === mutation.file);
      assert.ok(found.length >= 1, `${mutation.what} (${mutation.file}) is reported`);
      assert.equal(inspectLaunches(mutated(sources, mutation)).length, clean + found.length, `${mutation.what}: and nothing else is`);
    }
    // The controls: the inspection does not simply report everything.
    const inChoke = { file: 'invoke/another-backend.ts', text: FORBIDDEN[0].text };
    assert.equal(inspectLaunches(mutated(sources, inChoke)).length, clean, 'the same launch inside invoke/ is where it belongs');
    const typesOnly = { file: 'gate/types.ts', text: `import type { ChildProcess } from 'node:child_process';\nexport type Handle = ChildProcess;\n` };
    assert.equal(inspectLaunches(mutated(sources, typesOnly)).length, clean, 'an import of types starts nothing and is not reported');
    const comment = { file: 'gate/notes.ts', text: `// nothing here imports 'node:child_process'\nexport const note = 1;\n` };
    assert.equal(inspectLaunches(mutated(sources, comment)).length, clean, 'a comment is not code');
  });

  test('the package graph offers a client nothing but the API: the engine package exports one entry with nothing callable in it, and nothing under packages/ui reaches into the engine or starts a process', async () => {
    const manifest = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.exports ?? {}), ['.'], 'the engine package exports exactly one entry point');
    assert.deepEqual(Object.keys(manifest.bin ?? {}), ['surety'], 'and one command, which talks to the API');
    const entry = join(ENGINE, manifest.exports['.'].default);
    assert.ok(existsSync(entry), `the entry point is built (${entry})`);
    const offered = await import(pathToFileURL(entry).href);
    const callable = Object.entries(offered).filter(([, value]) => typeof value === 'function').map(([name]) => name);
    assert.deepEqual(callable, [], 'the entry point exports no function and no class: a client that imports the engine package cannot start an engine, open its store or launch a backend with it');

    // The UI package is not built in M1. Whatever is in it must already keep to the rule.
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(m?js|ts|html|json)$/.test(name)) files.push(path);
      }
    };
    if (existsSync(UI)) walk(UI);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /child_process|node:cluster/, `${file}: a UI file names no process-starting module`);
      assert.doesNotMatch(text, /engine\/(src|dist|migrations)\b/, `${file}: a UI file reaches into no engine internals`);
    }
  });
});
