#!/usr/bin/env node
// Role-boundary check for the manual first build (F §4.1, build spec §4).
// Owner-only file. The integrator names the role and the branch; nothing here
// is self-declared.
//
// Usage: node scripts/check-role-boundary.mjs <builder|verifier> <base> <branch>
//   e.g. node scripts/check-role-boundary.mjs builder main build/slice-1
//
// It examines what <branch> changed since it diverged from <base>, so commits
// that landed on <base> afterwards are not attributed to the branch. Each role
// has a list of paths it may write; a change anywhere else is a violation.
// Only committed changes are visible to it, so it refuses to run on a working
// tree with uncommitted changes.
// Exit 0 inside the role's paths, 1 outside them, 2 on a usage or git error.

import { execFileSync } from 'node:child_process';

const ALLOWED = {
  builder: [
    'packages/engine/src/',
    'packages/engine/migrations/',
    'packages/engine/api/',
    'packages/engine/test/unit/',
    'docs/acceptance/objections/',
  ],
  verifier: [
    'packages/engine/test/acceptance/',
    'docs/acceptance/objections/',
    'docs/acceptance/reports/',
  ],
};

const [role, base, branch] = process.argv.slice(2);
if (!(role in ALLOWED) || !base || !branch) {
  console.error('usage: check-role-boundary.mjs <builder|verifier> <base> <branch>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
let changed;
try {
  if (git('status', '--porcelain').trim() !== '') {
    console.error('uncommitted changes in the working tree: commit them first, this check sees commits only');
    process.exit(2);
  }
  changed = git('diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`, '--').split('\0').filter(Boolean);
} catch (err) {
  console.error(`git failed for ${base}...${branch}: ${err.message}`);
  process.exit(2);
}

const violations = changed.filter((p) => !ALLOWED[role].some((prefix) => p.startsWith(prefix)));
if (violations.length > 0) {
  console.error(`${role} boundary: ${violations.length} of ${changed.length} changed path(s) on ${branch} are outside the role's paths`);
  for (const p of violations) console.error(`  ${p}`);
  process.exit(1);
}
if (changed.length === 0) {
  console.error(`${role} boundary: ${branch} has no committed changes since ${base}; nothing was checked`);
  process.exit(1);
}
console.log(`${role} boundary: ${changed.length} changed path(s) on ${branch}, all inside the role's paths`);
