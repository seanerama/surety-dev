#!/usr/bin/env node
// Test runner. The exit status is the judgment (E8). Owner-only file: it is
// part of the acceptance execution path (F §5.2).
//
// Usage: node scripts/run-tests.mjs unit
//        node scripts/run-tests.mjs acceptance [--slice <n> | --lane real | --lane exhaust]
//
// It always builds first, so a stale dist/ is never what gets tested, and it
// runs one test file at a time. For the acceptance suite it refuses to report
// success when that would claim more than was observed (acceptance plan §5):
//   - a file is not named <row>-<slug>.test.mjs for a row in ROWS;
//   - a file is not listed under any slice in manifest.json, or a listed file
//     is missing, or a slice in range lists nothing;
//   - any test was skipped or marked todo;
//   - a file that ran contains no passing test;
//   - full run (no --slice): any row in ROWS has no file.
// --slice n runs exactly the files listed for slices 1..n.
// The real lane (M2 plan §2.1): files listed under manifest "real" run a real
// backend against a model and cost money. They are never part of the full run
// or of a slice; only --lane real runs them, and only then does a run count
// them. The full run still requires each real-lane row to have its file.
// The exhaustion lane (E69): files listed under manifest "exhaust" fork,
// allocate or write up to a domain's limits. They run only on a host Sean
// designated for them, never on the development workstation: only
// --lane exhaust runs them, and only when SURETY_EXHAUSTION_HOST names this
// machine's hostname. Like the real lane they are never part of the full run
// or of a slice, and the full run still requires their rows to have files.
// Around every acceptance run (M4 build spec §4.1 rule 7, E121): before it, the
// user's service manager must report `running`, or nothing is run; after it,
// the run's leftovers are reported by exact name against a snapshot taken
// before: loaded `surety-*` user units, /dev/shm/surety* and /tmp/surety-*.
// A leftover unit fails the run; a leftover file is reported. The check only
// reads (`systemctl --user is-system-running` and `list-units`); it never
// stops, resets or removes anything.
// The full report of every run is also written under test-results/ (not tracked).
// Exit 0 pass, 1 fail, 2 usage error.

import { spawnSync } from 'node:child_process';
import { createWriteStream, globSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

// The acceptance rows: docs/acceptance/sdlc-M1-acceptance-plan-Astra.md §3 (M01 to M74),
// docs/acceptance/sdlc-M2-acceptance-plan.md §3 (M101 to M142),
// docs/acceptance/sdlc-M3-acceptance-plan.md §3 (M201 to M241) and
// docs/acceptance/sdlc-M4-acceptance-plan.md §3 (M301 to M344).
// Adding or removing a row is the owner's decision (build spec §9).
const ROWS = [
  ...Array.from({ length: 74 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 42 }, (_, i) => `M${101 + i}`),
  ...Array.from({ length: 41 }, (_, i) => `M${201 + i}`),
  ...Array.from({ length: 44 }, (_, i) => `M${301 + i}`),
];
const TEST_TIMEOUT_MS = Number(process.env.SURETY_TEST_TIMEOUT_MS ?? 600_000);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const usage = () => {
  console.error('usage: run-tests.mjs unit | acceptance [--slice <n> | --lane real | --lane exhaust]');
  process.exit(2);
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const [suite, ...rest] = process.argv.slice(2);
if (suite !== 'unit' && suite !== 'acceptance') usage();
if (suite === 'unit' && rest.length > 0) usage();
let slice = null;
let lane = null;
if (suite === 'acceptance' && rest.length > 0) {
  if (rest.length === 2 && rest[0] === '--slice' && /^[1-9]\d*$/.test(rest[1])) slice = Number(rest[1]);
  else if (rest.length === 2 && rest[0] === '--lane' && (rest[1] === 'real' || rest[1] === 'exhaust')) lane = rest[1];
  else usage();
}

const dir = `packages/engine/test/${suite}`;
let files = globSync(`${dir}/**/*.test.mjs`, { cwd: root }).sort();

if (suite === 'acceptance') {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8'));
  const rowOf = (file) => /^(M\d{2,3})-[a-z0-9-]+\.test\.mjs$/.exec(basename(file))?.[1];
  const list = (paths) => `\n  ${paths.join('\n  ')}`;

  const misnamed = files.filter((f) => !ROWS.includes(rowOf(f)));
  if (misnamed.length > 0) fail(`acceptance: not named <row>-<slug>.test.mjs for a known row:${list(misnamed)}`);

  const byName = new Map(files.map((f) => [basename(f), f]));
  const realLane = manifest.real ?? [];
  const exhaustLane = manifest.exhaust ?? [];
  const inSlices = Object.values(manifest.slices).flat();
  const both = [...realLane, ...exhaustLane].filter((name) => inSlices.includes(name));
  if (both.length > 0) fail(`acceptance: listed both under a slice and under "real" or "exhaust" in manifest.json:${list(both)}`);
  const twice = realLane.filter((name) => exhaustLane.includes(name));
  if (twice.length > 0) fail(`acceptance: listed under both "real" and "exhaust" in manifest.json:${list(twice)}`);
  const allListed = [...inSlices, ...realLane, ...exhaustLane];
  const absent = allListed.filter((name) => !byName.has(name));
  if (absent.length > 0) fail(`acceptance: listed in manifest.json but not present:${list(absent)}`);
  const unlisted = files.filter((f) => !allListed.includes(basename(f)));
  if (unlisted.length > 0) fail(`acceptance: present but not listed under any slice in manifest.json:${list(unlisted)}`);

  if (lane === 'real') {
    if (realLane.length === 0) fail('acceptance: manifest.json lists no files under "real".');
    files = realLane.map((name) => byName.get(name));
  } else if (lane === 'exhaust') {
    // E69: never on a host not designated by name.
    if (process.env.SURETY_EXHAUSTION_HOST !== hostname()) {
      fail(`acceptance: the exhaustion lane runs only on a host designated for it (E69); SURETY_EXHAUSTION_HOST must equal this host's name (${hostname()}), and this is not to be set on the development workstation.`);
    }
    if (exhaustLane.length === 0) fail('acceptance: manifest.json lists no files under "exhaust".');
    files = exhaustLane.map((name) => byName.get(name));
  } else if (slice === null) {
    const covered = new Set(files.map(rowOf));
    const missing = ROWS.filter((r) => !covered.has(r));
    if (missing.length > 0) {
      fail(`acceptance: ${missing.length} of ${ROWS.length} rows have no test file (first ${missing[0]}, last ${missing.at(-1)}). A missing row is not a pass.`);
    }
    // The full run is the kernel and sandbox lanes; the real lane's files are present but not run.
    files = files.filter((f) => !realLane.includes(basename(f)) && !exhaustLane.includes(basename(f)));
    if (realLane.length > 0) console.log(`acceptance: ${realLane.length} real-lane file(s) not run (only --lane real runs them).`);
    if (exhaustLane.length > 0) console.log(`acceptance: ${exhaustLane.length} exhaustion-lane file(s) not run (only --lane exhaust on a designated host runs them, E69).`);
  } else {
    const selected = [];
    for (let n = 1; n <= slice; n++) {
      const names = manifest.slices[String(n)] ?? [];
      if (names.length === 0) fail(`acceptance: manifest.json lists no files for slice ${n}.`);
      selected.push(...names);
    }
    files = [...new Set(selected)].map((name) => byName.get(name));
  }
}

if (files.length === 0) fail(`${suite}: no test files found`);

// Rule 7's read-only host check (E121): what may be left behind, by exact name.
const leftovers = () => {
  const units = spawnSync('systemctl', ['--user', 'list-units', '--all', 'surety-*', '--no-legend', '--plain'], { encoding: 'utf8' });
  const names = (d, prefix) => {
    try {
      return readdirSync(d).filter((n) => n.startsWith(prefix)).map((n) => join(d, n));
    } catch {
      return null;
    }
  };
  return {
    units: units.status === 0 ? units.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean) : null,
    files: [names('/dev/shm', 'surety'), names('/tmp', 'surety-')],
  };
};
let before = null;
if (suite === 'acceptance') {
  const state = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
  const said = (state.stdout ?? '').trim();
  if (said !== 'running') fail(`acceptance: the user's service manager is not running (systemctl --user is-system-running said "${said || state.error?.message || 'nothing'}"); nothing was run (M4 build spec §4.1 rule 7).`);
  before = leftovers();
  if (before.units === null) fail('acceptance: the user units could not be listed (systemctl --user list-units); nothing was run (M4 build spec §4.1 rule 7).');
}

const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail('build failed; nothing was tested.');

const counts = { failed: 0, failedGroups: 0, skipped: 0, todo: 0 };
const passedIn = new Map(files.map((f) => [join(root, f), 0]));
const stream = run({ files: [...passedIn.keys()], concurrency: false, timeout: TEST_TIMEOUT_MS });
stream.on('test:fail', (t) => {
  // A describe() group that contains a failure is reported as failed too; count it apart
  // so the total names tests, while a group that fails on its own (a hook) still fails the run.
  if (t.todo !== undefined) counts.todo++;
  else if (t.details?.type === 'suite') counts.failedGroups++;
  else counts.failed++;
});
stream.on('test:pass', (t) => {
  if (t.skip !== undefined) counts.skipped++;
  else if (t.todo !== undefined) counts.todo++;
  // A file with no tests is itself reported as one passing test named after its path.
  else if (t.details?.type !== 'suite' && t.name !== t.file && passedIn.has(t.file)) {
    passedIn.set(t.file, passedIn.get(t.file) + 1);
  }
});
// Keep the whole report of every run, so a failure that does not repeat can still be named.
const failures = [];
stream.on('test:fail', (t) => {
  if (t.todo === undefined && t.details?.type !== 'suite') failures.push(`${relative(root, t.file ?? '')}: ${t.name}`);
});
mkdirSync(join(root, 'test-results'), { recursive: true });
const logPath = join('test-results', `${suite}${slice === null ? '' : `-slice${slice}`}${lane === null ? '' : `-lane-${lane}`}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const log = createWriteStream(join(root, logPath));
const report = stream.compose(spec);
report.pipe(process.stdout);
report.pipe(log);
await new Promise((resolve) => report.on('end', resolve));
await new Promise((resolve) => log.end(resolve));
if (failures.length > 0) console.error(`failed:\n  ${failures.join('\n  ')}\nfull report: ${logPath}`);

// Rule 7 after the run: what this run left, by exact name; nothing is cleaned.
let leftUnits = [];
if (before !== null) {
  const after = leftovers();
  if (after.units === null) {
    console.error('acceptance: after the run the user units could not be listed: whether a unit was left is unknown.');
    leftUnits = null;
  } else leftUnits = after.units.filter((u) => !before.units.includes(u));
  const leftFiles = after.files.flatMap((names, i) => (names === null ? [] : names.filter((n) => !(before.files[i] ?? []).includes(n))));
  if (after.files.some((names) => names === null)) console.error('acceptance: after the run /dev/shm or /tmp could not be read: whether a file was left is unknown.');
  if (leftFiles.length > 0) console.error(`acceptance: the run left these files (reported, not removed):\n  ${leftFiles.join('\n  ')}`);
  if (leftUnits !== null && leftUnits.length > 0) console.error(`acceptance: the run left these user units loaded (reported, not stopped):\n  ${leftUnits.join('\n  ')}`);
}

if (counts.failed > 0 || counts.failedGroups > 0) {
  fail(`${suite}: ${counts.failed} test(s) failed or were cancelled, in ${counts.failedGroups} failing group(s).`);
}
if (suite === 'acceptance') {
  if (counts.skipped > 0 || counts.todo > 0) {
    fail(`acceptance: skipped=${counts.skipped} todo=${counts.todo}. A skip is not a pass.`);
  }
  const empty = [...passedIn].filter(([, n]) => n === 0).map(([f]) => relative(root, f));
  if (empty.length > 0) fail(`acceptance: no passing test in:\n  ${empty.join('\n  ')}`);
}
if (leftUnits === null) fail('acceptance: whether the run left a user unit is unknown (M4 build spec §4.1 rule 7).');
if (leftUnits.length > 0) fail(`acceptance: ${leftUnits.length} user unit(s) left loaded by the run (M4 build spec §4.1 rule 7).`);
console.log(`${suite}: ${files.length} file(s) passed.`);
