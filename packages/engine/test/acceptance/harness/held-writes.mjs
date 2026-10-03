// A hold on the engine's git writes, and on nothing else (M2 slice 2, entry
// B6; row M15; SEAM.md §110). `holdGit` in repos.mjs holds every git call on
// a repository, so the first call held is always a read and a write is never
// reached while the engine runs (COVERAGE.md, "What the second session could
// not turn into a test"). This tool holds a write by what it is: the engine
// is started with a `git` on its PATH that is a thin wrapper of the real
// one. The wrapper looks at the git subcommand the engine asked for and, if
// a hold is in place for it, waits until the hold is lifted before it hands
// over to the real git; every other command is handed over at once. Reads,
// probes and the engine's other writes go through; the held command never
// starts, so an engine that kills it at its deadline leaves its effect
// absent, which is what the engine then has to establish.
//
// Two holds are offered, one per write the entry names: the commit object
// (`hash-object -w`, SEAM.md §45 "a commit's identity is stable across a
// retry") and a ref update of a ref under a given prefix (`update-ref`, so
// that the integration branch can be held while a keep ref is not). The
// wrapper is a POSIX shell script; the hold is a file in the tool's own
// directory, which the wrapper polls ten times a second. A hold lifted while
// a wrapper still waits lets that command run; one the engine has killed is
// gone with its process group (the engine kills the group, exec.ts).
//
// What it does not do: it never delays a git process after it has started,
// so a late completion (git finishing after the engine gave up) is not
// produced by it; the hold applies to every repository the engine touches
// while it is in place.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir, removeDir } from './engine.mjs';

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const WRAPPER = (dir, real) => `#!/bin/sh
# Surety acceptance harness: a git that holds a write while a hold file exists (held-writes.mjs).
dir='${dir}'
real='${real}'
sub=''
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -c) skip=1 ;;
    -*) ;;
    *) sub="$arg"; break ;;
  esac
done
hold=''
case "$sub" in
  hash-object)
    for arg in "$@"; do
      if [ "$arg" = "-w" ] && [ -e "$dir/hold-hash-object" ]; then hold="$dir/hold-hash-object"; fi
    done
    ;;
  update-ref)
    if [ -e "$dir/hold-update-ref" ]; then
      prefix=$(cat "$dir/hold-update-ref")
      for arg in "$@"; do
        case "$arg" in
          "$prefix"*) hold="$dir/hold-update-ref" ;;
        esac
      done
    fi
    ;;
esac
if [ -n "$hold" ]; then
  echo "$$ $sub $*" >> "$dir/held.log"
  while [ -e "$hold" ]; do sleep 0.1; done
fi
exec "$real" "$@"
`;

// Make the tool: a directory with the wrapper. Returns {env, holdCommit,
// holdRefUpdate, release, heldLog, dir}; `env` is what the engine is started
// with (`scriptedEngine(t, {env})`), its PATH beginning with the wrapper's
// directory. The directory is removed when the test ends.
export function heldGitWrites(t) {
  const dir = makeTempDir('held-writes');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const wrapper = join(dir, 'bin', 'git');
  writeFileSync(wrapper, WRAPPER(dir, REAL_GIT));
  chmodSync(wrapper, 0o755);
  t.after(() => removeDir(dir));
  const file = (what) => join(dir, `hold-${what}`);
  return {
    dir,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    // Hold every write of a commit object (`hash-object -w`).
    holdCommit: () => writeFileSync(file('hash-object'), ''),
    // Hold every `update-ref` of a ref whose name begins with `prefix`.
    holdRefUpdate: (prefix) => writeFileSync(file('update-ref'), prefix),
    // Lift a hold: 'hash-object' or 'update-ref'.
    release: (what) => rmSync(file(what), { force: true }),
    holding: (what) => existsSync(file(what)),
    // The commands the wrapper held, one line each: "<pid> <subcommand> <args>".
    heldLog: () => (existsSync(join(dir, 'held.log')) ? readFileSync(join(dir, 'held.log'), 'utf8').trim().split('\n').filter((l) => l !== '') : []),
  };
}
