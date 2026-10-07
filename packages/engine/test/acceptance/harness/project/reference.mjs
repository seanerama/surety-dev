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

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { governedText, definitionText, nodeReadPaths } from '../checks/fixtures.mjs';

export const SUM_PATH = 'src/sum.mjs';
export const SUM = 'export const sum = (a, b) => a + b;\n';
export const BROKEN_SUM = 'export const sum = (a, b) => a - b;\n';

export const WRAPPER = `// The protective wrapper of the reference project (SEAM.md §213).
import { spawn } from 'node:child_process';

const files = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { stdio: ['ignore', 'pipe', 'inherit'] });
let tap = '';
child.stdout.on('data', (chunk) => {
  tap += chunk;
  process.stdout.write(chunk);
});
child.on('close', (code, signal) => {
  const count = (key) => {
    const m = new RegExp('^# ' + key + ' (\\\\d+)$', 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
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
