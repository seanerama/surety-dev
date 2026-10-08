// The reference project of the `project` lane (M3 build spec §§3, 7; M3
// plan §2.1, §2.3; SEAM.md §213; rows M223 and, in slice 22, M238): a small
// Node project whose protected checks run Node's built-in test runner, from
// the engine's own Node installation, through a protective wrapper. Its
// files are written here as text and committed by the test into a
// repository of its own; nothing here is run by the test runner itself (no
// file of it is named *.test.mjs in this directory).
//
// The project:
//   src/sum.mjs                          the source a Builder writes (`SUM`; `BROKEN_SUM` fails);
//                                        not in the first commit
//   .surety/checks/protected-policy.json  the governed file
//   .surety/checks/wrapper.mjs           the protective wrapper (below)
//   .surety/checks/tests/sum.test.mjs    a node:test file testing src/sum.mjs (criterion R1.1)
//   .surety/checks/tests/<hang>.test.mjs a node:test file whose one test never settles (300 s at most)
//   .surety/checks/defs/accept.json      acceptance, covers R1.1: node wrapper sum.test.mjs
//   .surety/checks/defs/copied.json      smoke: the same through a pinned copy of node
//   .surety/checks/defs/hangs.json       smoke: node wrapper <hang>.test.mjs, timeout_s 5
//
// The wrapper runs `node --test --test-reporter=tap <files>` as its child
// and passes the runner's output through. It exits with the runner's own
// status when that is not 0; when the runner ended by a signal, 2; when the
// runner exited 0 but its summary is missing, counts no test, or counts a
// failed, skipped, todo or cancelled test, 3 (an empty, all-skipped or
// early-exiting run is no pass, T18); otherwise 0. Slice 22's mutants
// (M238) exercise what it protects against; M223 reads only that a real
// runner's pass and failure come through as the check's exit status.
//
// Hardened in slice 22 (M238; SEAM.md §236), from what the mutants showed
// in a check domain: (1) the summary is the runner's LAST one, so a test
// file that prints a summary of its own before the runner's (a premature
// success summary; Node's TAP reporter passes a test file's output through
// as "# <line>") is never the one read; (2) a top-level test entry named
// for a test file is a file that ran no test of its own (Node 22 reports such
// a file, one that exits 0 having run nothing, as one passing test), and is
// no pass either.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { governedText, definitionText, nodeReadPaths } from '../checks/fixtures.mjs';

export const SUM_PATH = 'src/sum.mjs';
export const SUM = 'export const sum = (a, b) => a + b;\n';
export const BROKEN_SUM = 'export const sum = (a, b) => a - b;\n';

export const WRAPPER = `// The protective wrapper of the reference project (SEAM.md §213).
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

const files = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { stdio: ['ignore', 'pipe', 'inherit'] });
let tap = '';
child.stdout.on('data', (chunk) => {
  tap += chunk;
  process.stdout.write(chunk);
});
child.on('close', (code, signal) => {
  // The runner's own summary is its last: a test file's output comes before it.
  const count = (key) => {
    const all = [...tap.matchAll(new RegExp('^# ' + key + ' (\\\\d+)$', 'gm'))];
    return all.length > 0 ? Number(all[all.length - 1][1]) : null;
  };
  // A top-level entry named for a file: a test file that ran no test of its own.
  const fileEntries = [...tap.matchAll(/^ok \\d+ - (.+)$/gm)].map((m) => m[1]).filter((name) => {
    try {
      return statSync(name).isFile();
    } catch {
      return false;
    }
  });
  if (signal !== null) {
    console.log('wrapper: the runner ended by ' + signal);
    process.exit(2);
  }
  if (code !== 0) {
    console.log('wrapper: the runner exited ' + code);
    process.exit(code);
  }
  const tests = count('tests');
  const vacuous = !(tests > 0) || count('pass') !== tests || count('fail') !== 0 || count('skipped') !== 0 || count('todo') !== 0 || count('cancelled') !== 0;
  if (vacuous) {
    console.log('wrapper: an empty, skipped or incomplete run is no pass');
    process.exit(3);
  }
  if (fileEntries.length > 0) {
    console.log('wrapper: a test file ran no test of its own: ' + fileEntries.join(', '));
    process.exit(3);
  }
  process.exit(0);
});
`;

export const SUM_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../../../src/sum.mjs';

test('R1.1: sum adds', () => {
  assert.equal(sum(2, 3), 5);
});
`;

export const HANG_TEST = `import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

test('a test that does not settle in time', async () => {
  await sleep(300000);
});
`;

// Install a copy of the engine's node under `root`/toolchain (the toolchain
// that M223 (b) changes and removes), and return the reference project's
// files with its governed file. Each call names its hanging test file with a
// fresh token, so a host-side search for it finds only this project's.
export function referenceProject(root) {
  const toolchain = join(root, 'toolchain');
  mkdirSync(toolchain, { recursive: true });
  const copy = join(toolchain, 'node');
  copyFileSync(process.execPath, copy);
  chmodSync(copy, 0o755);
  const copySha = createHash('sha256').update(readFileSync(copy)).digest('hex');
  const hangToken = `hang-${randomBytes(6).toString('hex')}`;
  const hangPath = `.surety/checks/tests/${hangToken}.test.mjs`;
  const wrapper = '.surety/checks/wrapper.mjs';
  const sumTest = '.surety/checks/tests/sum.test.mjs';
  const governed = governedText({
    protected_paths: ['.surety/checks/'],
    check_commands: { node: { path: process.execPath }, nodecopy: { path: copy, sha256: copySha } },
    runner_config: { direct: { read_paths: [...nodeReadPaths(), toolchain], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
  });
  const files = {
    '.surety/checks/protected-policy.json': governed,
    [wrapper]: WRAPPER,
    [sumTest]: SUM_TEST,
    [hangPath]: HANG_TEST,
    '.surety/checks/defs/accept.json': definitionText('accept', { kind: 'acceptance', command: ['node', wrapper, sumTest], timeout_s: 120, gate_kinds: ['stage'], covers: { criteria: ['R1.1'] } }),
    '.surety/checks/defs/copied.json': definitionText('copied', { kind: 'smoke', command: ['nodecopy', wrapper, sumTest], timeout_s: 120, gate_kinds: ['stage'] }),
    '.surety/checks/defs/hangs.json': definitionText('hangs', { kind: 'smoke', command: ['node', wrapper, hangPath], timeout_s: 5, gate_kinds: ['stage'] }),
  };
  return { files, toolchain, copy, copySha, hangToken };
}

// ---- M238: the wrapper's mutants and the root-hiding case (M3 slice 22; SEAM.md §236) ----
//
// The project M238 builds from the same parts, with three definitions:
//   guarded   acceptance, covers R1.1: node wrapper .surety/checks/tests/sum-child.test.mjs.
//             The protected test runs the candidate's code as a child process and
//             judges what it observably does (its exit, its signal, its exact output),
//             as D3 Appendix B and §6 class C ask; the wrapper supervises the runner.
//   srctests  smoke: node wrapper 'src/**/*.test.mjs', the retained check that
//             discovers the Builder's own tests under src/ (B02's runner, D3 §3.1).
//   bare      smoke: node --test 'src/**/*.test.mjs' with no wrapper: D3 §6 class
//             B's bare definition, whose vacuous pass the row shows as a limitation.
// Each pattern is passed to node as one argument (no shell); node expands it.

export const SUM_CHILD_TEST_PATH = '.surety/checks/tests/sum-child.test.mjs';
export const SRC_PATTERN = 'src/**/*.test.mjs';
export const BUILDER_TEST_PATH = 'src/sum.test.mjs';

export const SUM_CHILD_TEST = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// R1.1, judged from outside the candidate's process: its code runs as a child
// and only what that child observably does counts (D3 Appendix B, §6 class C).
test('R1.1: sum adds, the candidate run as a child', () => {
  const url = pathToFileURL(resolve('src/sum.mjs')).href;
  const code = 'const { sum } = await import(' + JSON.stringify(url) + '); process.stdout.write("SUM " + JSON.stringify(sum(2, 3)) + "\\\\n");';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.signal, null, 'the candidate child ended by itself');
  assert.equal(child.status, 0, 'the candidate child exited 0: a failed child is never swallowed');
  assert.equal(child.stdout, 'SUM 5\\n', 'and printed exactly what R1.1 requires');
});
`;

// The Builder's own test of sum, in src/ (not protected): it imports the
// candidate's code in the test file's own process, as developer tests do.
export const BUILDER_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from './sum.mjs';

test("the Builder's test: sum adds", () => {
  assert.equal(sum(2, 3), 5);
});
`;

// What a Builder writes for each mutant (M238 (a)): {path: content | null}, null
// removing the file. Each hides a broken sum from a check that would let it
// through, except the child failure, whose sum prints the right answer and then
// fails. `target` is the check that must fail; `code` is the exit status that
// fails it (3: the wrapper's "no pass" for an empty, skipped or forged run; 1:
// the runner's own failure, propagated).
const SUMMARY_KEYS = ['tests 1', 'suites 0', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0', 'duration_ms 1'];
export const MUTANTS = Object.freeze({
  skipped: {
    what: 'a skipped test: the Builder breaks sum and skips its own test of it',
    target: 'srctests',
    code: 3,
    files: {
      [SUM_PATH]: BROKEN_SUM,
      [BUILDER_TEST_PATH]: BUILDER_TEST.replace("test(\"the Builder's test: sum adds\"", "test.skip(\"the Builder's test: sum adds\""),
    },
  },
  empty: {
    what: 'an empty run: the Builder breaks sum and removes every test under src/',
    target: 'srctests',
    code: 3,
    files: { [SUM_PATH]: BROKEN_SUM, [BUILDER_TEST_PATH]: null },
  },
  emptyFile: {
    what: 'an empty run: the Builder breaks sum and its test file runs no test',
    target: 'srctests',
    code: 3,
    files: { [SUM_PATH]: BROKEN_SUM, [BUILDER_TEST_PATH]: "// The Builder's test file, emptied: it runs no test.\nimport './sum.mjs';\n" },
  },
  premature: {
    what: 'a premature success summary: the Builder breaks sum, and its test file prints a passing TAP summary before its one test, which it skips',
    target: 'srctests',
    code: 3,
    files: {
      [SUM_PATH]: BROKEN_SUM,
      // Node's TAP reporter passes a test file's own output through as
      // "# <line>" (seen in a check domain, slice 22): "tests 1" becomes the
      // summary line "# tests 1". The test that follows is skipped, so the
      // runner exits 0 and only its own, later summary says no test passed.
      [BUILDER_TEST_PATH]:
        `// A premature success summary (M238 (a)).\nprocess.stdout.write(${JSON.stringify(['ok 1 - the Builder\'s test: sum adds', '1..1', ...SUMMARY_KEYS].join('\n') + '\n')});\n` +
        BUILDER_TEST.replace("test(\"the Builder's test: sum adds\"", "test.skip(\"the Builder's test: sum adds\""),
    },
  },
  childFailure: {
    what: "a swallowed child failure: the candidate's code prints the right answer and then exits 1",
    target: 'guarded',
    code: 1,
    files: { [SUM_PATH]: `${SUM}setTimeout(() => process.exit(1), 0);\n` },
  },
  exitZero: {
    what: 'candidate code calling process.exit(0): the module ends its process with 0 as soon as it is imported',
    target: 'guarded',
    code: 1,
    files: { [SUM_PATH]: `process.exit(0);\n${BROKEN_SUM}` },
  },
});

// (c): the source is right, but a test the Builder wrote under src/ fails.
export const FAILING_SOURCE_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from './sum.mjs';

test("the Builder's test: sum of two and two is five", () => {
  assert.equal(sum(2, 2), 5);
});
`;

// The governed fields of M238's project, so that (c)'s proposal can rewrite
// the governed file with one root added and nothing else changed.
export function m238Governed() {
  return {
    protected_paths: ['.surety/checks/'],
    check_commands: { node: { path: process.execPath } },
    runner_config: { direct: { read_paths: [...nodeReadPaths()], path: [dirname(process.execPath), '/usr/bin', '/bin'] } },
  };
}

export function m238Project() {
  const wrapper = '.surety/checks/wrapper.mjs';
  return {
    '.surety/checks/protected-policy.json': governedText(m238Governed()),
    [wrapper]: WRAPPER,
    [SUM_CHILD_TEST_PATH]: SUM_CHILD_TEST,
    '.surety/checks/defs/guarded.json': definitionText('guarded', { kind: 'acceptance', command: ['node', wrapper, SUM_CHILD_TEST_PATH], timeout_s: 120, gate_kinds: ['stage'], covers: { criteria: ['R1.1'] }, inputs: [wrapper, SUM_CHILD_TEST_PATH] }),
    '.surety/checks/defs/srctests.json': definitionText('srctests', { kind: 'smoke', command: ['node', wrapper, SRC_PATTERN], timeout_s: 120, gate_kinds: ['stage'], inputs: [wrapper] }),
    '.surety/checks/defs/bare.json': definitionText('bare', { kind: 'smoke', command: ['node', '--test', SRC_PATTERN], timeout_s: 120, gate_kinds: ['stage'], inputs: [] }),
  };
}
