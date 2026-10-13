// The adopted fixture repository of M5's second journey (D6 §8; BS5 §3,
// "the reference projects of the project lane": "an existing dependency-free
// Node repository with its own tests importing an assertion helper, a README
// whose claims include one the code does not meet, a tagged release and a
// CI file, and no Surety records"; E141 item 4; SEAM.md §376).
//
// "Sums": the shape of the M4 real run's Builder repository (`server.mjs`,
// `src/sum.mjs`, dependency-free Node), so the slice-38 run on that
// repository's copy (M444) adopts the same kind of thing. Its README claims
// that a non-number is refused with 400; the code answers 200 with
// {"sum": null}. That is the deliberately false claim (E141 item 4).
//
// Test-side git only, with nothing a repository configures switched on.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { git, gitEnv } from '../git.mjs';
import { gitQuiet, refOid } from '../repos.mjs';
import { execFileSync } from 'node:child_process';

export const ADOPTED_NAME = 'sums';

export const SUM_MJS = 'export const sum = (a, b) => a + b;\n';

// The service as adopted (source A): no refusal of a non-number.
export const SERVER_MJS = `// Sums: a small HTTP service. Node's own http, nothing from npm.
import { createServer } from 'node:http';
import { sum } from './src/sum.mjs';

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://service');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/sum') {
    const a = Number(url.searchParams.get('a'));
    const b = Number(url.searchParams.get('b'));
    return send(res, 200, { sum: sum(a, b) });
  }
  return send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
`;

// What phase 2's Builder writes (the `defect` requirement delivered): the
// non-number refused with 400, nothing else changed.
export const SERVER_MJS_FIXED = SERVER_MJS.replace(
  "    return send(res, 200, { sum: sum(a, b) });\n",
  "    if (!Number.isFinite(a) || !Number.isFinite(b)) return send(res, 400, { error: 'a and b must be numbers' });\n    return send(res, 200, { sum: sum(a, b) });\n",
);

// The repository's own tests: Builder-owned developer tests (D6 §8.3), each
// importing the assertion helper.
export const EXPECT_HELPER = `// The project's assertion helper: what decides each test's verdict.
import assert from 'node:assert/strict';

export const expectEqual = (actual, expected, label) => assert.deepEqual(actual, expected, label);
export const expectStatus = (got, status, label) => assert.equal(got.status, status, label + ' status');
`;
export const SUM_TEST = `import { test } from 'node:test';

import { expectEqual } from './helpers/expect.mjs';
import { sum } from '../src/sum.mjs';

test('sum adds two numbers', () => {
  expectEqual(sum(2, 3), 5, 'sum(2, 3)');
});
`;
export const SERVICE_TEST = `import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { expectEqual, expectStatus } from './helpers/expect.mjs';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const ask = (port, path) => new Promise((resolve, reject) => {
  get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
});

test('the service sums and answers its health', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    let up = null;
    for (let i = 0; i < 50 && up === null; i++) { try { up = await ask(port, '/health'); } catch { await sleep(100); } }
    expectStatus(up, 200, '/health');
    const got = await ask(port, '/sum?a=2&b=3');
    expectStatus(got, 200, '/sum');
    expectEqual(JSON.parse(got.body), { sum: 5 }, '/sum body');
  } finally {
    child.kill('SIGKILL');
  }
});
`;

// The README's claims (D6 §8.1 step 2, TPL §12): three the code meets, one it
// does not (E141 item 4).
export const README = `# Sums

A tiny HTTP service that adds two numbers.

- \`GET /sum?a=2&b=3\` answers \`{"sum": 5}\`.
- \`GET /health\` answers \`{"ok": true}\`.
- A request whose \`a\` or \`b\` is not a number is refused with 400.
- \`sum(a, b)\` in \`src/sum.mjs\` is a pure function.

Run it with \`node server.mjs\`; run the tests with \`node --test test/\`.
`;
export const README_CLAIMS = Object.freeze({ false: 'A request whose `a` or `b` is not a number is refused with 400.' });

// A CI file naming an environment (D6 §8.1 step 1: CI and deployment files
// by name; the environment the signals suggest, `unknown` by name).
export const CI_YML = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: node --test test/
`;
export const CI_ENVIRONMENT = 'production';

// The files of the repository at its first (pushed) commit.
export const ADOPTED_FILES = Object.freeze({
  'README.md': README,
  'server.mjs': SERVER_MJS,
  'src/sum.mjs': SUM_MJS,
  'test/helpers/expect.mjs': EXPECT_HELPER,
  'test/sum.test.mjs': SUM_TEST,
  'test/service.test.mjs': SERVICE_TEST,
  '.github/workflows/ci.yml': CI_YML,
  Procfile: 'web: node server.mjs\n',
  '.env.example': 'PORT=3000\n',
});
// The unpushed commit (E18: the head, unpushed commits included).
export const UNPUSHED = Object.freeze({ 'src/sum.mjs': '// Adds two numbers.\nexport const sum = (a, b) => a + b;\n' });
export const RELEASE_TAG = 'v0.1.0';

// What the signals hold for the fixture at A (D6 §8.1 step 1), by name.
export const EXPECTED_SIGNALS = Object.freeze({
  test_files: ['test/helpers/expect.mjs', 'test/service.test.mjs', 'test/sum.test.mjs'],
  ci_files: ['.github/workflows/ci.yml'],
  deploy_files: ['.env.example', 'Procfile'],
});

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

// The adopted repository at `dir`: a bare `origin` holding the first commit
// (tagged `v0.1.0`), and `branch` one unpushed commit ahead of it. The
// developer's work tree is left detached (the supported topology, SEAM.md
// §§25, 30). `extra` adds files to the first commit (a large repository for
// the size signal); `surety` plants Surety records (Sean, 2026-10-12: refused).
// Returns {path, branch, ref, head (A), pushed, origin}.
export function makeAdoptedRepo(dir, { branch = 'main', extra = {}, unpushed = true, surety = null } = {}) {
  const origin = `${dir}-origin.git`;
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin], { env: gitEnv(dir) });
  execFileSync('git', ['init', '-q', '-b', branch, dir], { env: gitEnv(dir) });
  writeFiles(dir, { ...ADOPTED_FILES, ...extra, ...(surety?.files ?? {}) });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'sums: first version']);
  git(dir, ['tag', RELEASE_TAG]);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', 'origin', branch, '--tags']);
  const pushed = git(dir, ['rev-parse', 'HEAD']);
  if (unpushed) {
    writeFiles(dir, UNPUSHED);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'sums: a comment on sum']);
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (surety?.ref) git(dir, ['update-ref', surety.ref, head]);
  git(dir, ['checkout', '-q', '--detach', head]);
  return { path: dir, branch, ref: `refs/heads/${branch}`, head, pushed, origin };
}

// `n` small files under `bulk/`, for the size signal (M409 (c)).
export const bulkFiles = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`bulk/f${String(i).padStart(5, '0')}.txt`, `${i}\n`]));

// The tracked files of a revision and their bytes, and its commit count, as
// test-side git reads them (the signals' expected counts).
export function countsAt(repo, rev) {
  const lines = gitQuiet(repo, ['ls-tree', '-r', '-l', rev]).split('\n').filter(Boolean);
  const bytes = lines.reduce((n, line) => n + Number(line.split(/\s+/)[3]), 0);
  const commits = Number(gitQuiet(repo, ['rev-list', '--count', rev]));
  return { files: lines.length, bytes, commits };
}

export { refOid };
