// M74, seam-confinement case (slice 1). Build spec §8: "Production code
// reaches the seam through one module. Nothing else in `src/` branches on
// being under test." Tightened by the owner after the slice-1 review (E23) and
// stated as three checkable rules in SEAM.md §7 "Confinement". This file
// inspects the engine's source text for exactly those rules; SEAM.md says what
// that proves and what it cannot. The row's other cases (fixture semantics,
// the model-invocation boundary) are slice 6.
//
// It belongs to row M74 because that row already holds the other source
// inspection of the build: a backend spawn outside the choke point.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from './harness/engine.mjs';
import { CLI_ENTRY, SEAM_MODULE, formatViolations, inspectSources, readSources } from './harness/source-lint.mjs';

const SRC = join(REPO_ROOT, 'packages', 'engine', 'src');

// The inspection is only meaningful if it found the things it inspects.
function inspect() {
  assert.ok(existsSync(join(SRC, SEAM_MODULE)), `the seam module packages/engine/src/${SEAM_MODULE} exists`);
  assert.ok(existsSync(join(SRC, CLI_ENTRY)), `the CLI entry point packages/engine/src/${CLI_ENTRY} exists`);
  const sources = readSources(SRC);
  const production = sources.filter((s) => !s.file.startsWith('testing/'));
  assert.ok(production.length > 0, 'there is production source to inspect');
  return inspectSources(sources);
}

function assertNone(violations, rule) {
  assert.equal(violations.length, 0, `${rule}\n${formatViolations(violations)}\n`);
}

describe('M74 the test seam is confined to src/testing/', () => {
  test('production source reaches the seam folder only by importing the seam module', () => {
    assertNone(
      inspect().door,
      'SEAM.md §7 Confinement, rule 1 (one door): production source may refer to src/testing/ only as a static import of testing/seam.js.',
    );
  });

  test('a value imported from the seam module is only ever called', () => {
    assertNone(
      inspect().callOnly,
      'SEAM.md §7 Confinement, rule 2 (call only): production source may call what the seam module exports and do nothing else with it.',
    );
  });

  test('nothing outside the seam folder names the harness or the fixture label', () => {
    assertNone(
      inspect().names,
      'SEAM.md §7 Confinement, rule 3 (no harness names): harness routes, harness store operations, the harness field of GET /v1/engine and the fixture label ' +
        'are produced under src/testing/; only src/cli.ts may name the harness, to parse the --harness flags.',
    );
  });
});
