// The test-owned check program of M3 slice 15 (SEAM.md §182). The engine's
// check runner executes it as a check's own process inside a `check` domain:
// a `check_commands` entry names the installed copy (`installCheckProgram`
// in fixtures.mjs writes it with a shebang naming the test's node), and the
// definition's `command[1..]` are its arguments.
//
// It is benign by construction. It signals nothing, writes no file, opens no
// descriptor it did not inherit, starts no process and connects nowhere. It
// reads its working directory, the files it is told to digest and the
// existence of one release file, writes to its standard output and exits.
// Every wait it makes is bounded. Node built-ins only, no relative imports.
//
// Arguments, options first, then one mode:
//   --say <text>        write <text> and a line ending to standard output (repeatable)
//   --report            write one line `SURETY-CHECK-REPORT <json>`: its cwd, its pid,
//                       whether `.git` exists in its cwd, every entry under its cwd
//                       (no link followed, at most 5000) and the digests asked for
//   --digest <path>     SHA-256 of that file's bytes, relative to the cwd (repeatable)
//   --hold <name>       wait until <release-dir>/<name> exists (at most 180 s) before the mode
//   --release-dir <dir> where the release files are (a test path in read_paths)
// Modes:
//   exit <n>                      exit with status n
//   expect <source> <expected>    exit 0 if the two files' bytes are equal, else 1
//   term-exit0 <max ms>           wait for SIGTERM and exit 0 on it; exit 99 after <max ms>

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOLD_MAX_MS = 180_000;
const TERM_WAIT_MAX_MS = 120_000;
const WALK_MAX = 5000;

const out = (text) =>
  new Promise((resolve) => {
    process.stdout.write(`${text}\n`, () => resolve());
  });

async function leave(code) {
  await new Promise((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}

const args = process.argv.slice(2);
const opts = { say: [], digest: [], report: false, hold: null, releaseDir: null };
while (args.length > 0 && args[0].startsWith('--')) {
  const flag = args.shift();
  if (flag === '--report') opts.report = true;
  else if (flag === '--say') opts.say.push(args.shift() ?? '');
  else if (flag === '--digest') opts.digest.push(args.shift() ?? '');
  else if (flag === '--hold') opts.hold = args.shift() ?? null;
  else if (flag === '--release-dir') opts.releaseDir = args.shift() ?? null;
  else {
    await out(`SURETY-CHECK unknown option ${flag}`);
    await leave(90);
  }
}
const [mode, ...rest] = args;

function walk(root) {
  const entries = [];
  const visit = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      entries.push({ path: relative(root, dir) || '.', type: 'unreadable', error: err.code ?? String(err) });
      return;
    }
    for (const name of names) {
      if (entries.length >= WALK_MAX) return;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        entries.push({ path: relative(root, full), type: 'unreadable', error: err.code ?? String(err) });
        continue;
      }
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      entries.push({ path: relative(root, full), type });
      if (type === 'dir') visit(full);
    }
  };
  visit(root);
  return entries;
}

function digestOf(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (err) {
    return `error:${err.code ?? String(err)}`;
  }
}

for (const text of opts.say) await out(text);

if (opts.report) {
  const cwd = process.cwd();
  const report = {
    cwd,
    pid: process.pid,
    git_present: existsSync(join(cwd, '.git')),
    entries: walk(cwd),
    digests: Object.fromEntries(opts.digest.map((p) => [p, digestOf(join(cwd, p))])),
  };
  await out(`SURETY-CHECK-REPORT ${JSON.stringify(report)}`);
}

if (opts.hold !== null) {
  if (opts.releaseDir === null) {
    await out('SURETY-CHECK hold without --release-dir');
    await leave(91);
  }
  const file = join(opts.releaseDir, opts.hold);
  const started = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - started > HOLD_MAX_MS) {
      await out(`SURETY-CHECK hold ${opts.hold} timed out`);
      await leave(98);
    }
    await sleep(100);
  }
  await out(`SURETY-CHECK released ${opts.hold}`);
}

if (mode === 'exit') {
  await leave(Number.isInteger(Number(rest[0])) ? Number(rest[0]) : 92);
} else if (mode === 'expect') {
  const [source, expected] = rest;
  let same = false;
  try {
    same = readFileSync(join(process.cwd(), source)).equals(readFileSync(join(process.cwd(), expected)));
  } catch (err) {
    await out(`SURETY-CHECK expect could not read: ${err.code ?? String(err)}`);
  }
  await out(`SURETY-CHECK expect ${source} ${same ? 'matches' : 'differs from'} ${expected}`);
  await leave(same ? 0 : 1);
} else if (mode === 'term-exit0') {
  const max = Math.min(Number(rest[0]) || TERM_WAIT_MAX_MS, TERM_WAIT_MAX_MS);
  process.on('SIGTERM', () => {
    process.stdout.write('SURETY-CHECK got SIGTERM, exiting 0\n', () => process.exit(0));
  });
  await out('SURETY-CHECK waiting for SIGTERM');
  await sleep(max);
  await out('SURETY-CHECK no SIGTERM arrived');
  await leave(99);
} else {
  await out(`SURETY-CHECK unknown mode ${mode}`);
  await leave(93);
}
