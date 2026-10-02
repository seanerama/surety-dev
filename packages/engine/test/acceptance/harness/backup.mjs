// The `surety store` commands and the rebinding of a repository (rows M62 and
// M66; SEAM.md §59). The store commands run while no engine holds the home
// (D1 §11.6); the tests stop the engine first.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI, engineEnv, parseRefusal } from './engine.mjs';

// The exit status of a store command that was refused (SEAM.md §59).
export const STORE_REFUSED = 7;

// `surety store <args>` against an engine home. Returns its exit status, its
// output, the last line of stdout parsed as JSON (or null) and the refusal on
// stderr (or null).
export function storeCommand(home, args) {
  const done = spawnSync(process.execPath, [CLI, 'store', ...args], { env: engineEnv(home), cwd: home, encoding: 'utf8', timeout: 120_000 });
  let last = null;
  try {
    last = JSON.parse(done.stdout.trim().split('\n').at(-1));
  } catch {
    // no JSON line on stdout
  }
  return { status: done.status, stdout: done.stdout, stderr: done.stderr, last, refusal: parseRefusal(done.stderr ?? '') };
}

// `surety store backup`: the directory it wrote, its label, and its manifest.
export function backup(home, { databaseOnly = false } = {}) {
  const done = storeCommand(home, ['backup', ...(databaseOnly ? ['--database-only'] : [])]);
  assert.equal(done.status, 0, `surety store backup exits 0 (stderr: ${done.stderr})`);
  assert.ok(typeof done.last?.backup === 'string', `it names the backup it wrote on stdout: ${done.stdout}`);
  return { dir: done.last.backup, label: done.last.label, manifest: JSON.parse(readFileSync(join(done.last.backup, 'manifest.json'), 'utf8')) };
}

// `surety store restore` into the engine home `home`, binding each project to a repository path.
export const restore = (home, from, bindings) => storeCommand(home, ['restore', '--from', from, ...Object.entries(bindings).flatMap(([project, path]) => ['--bind', `${project}=${path}`])]);

// Tell a running engine where a project's repository now is.
export async function rebind(engine, project, path) {
  const res = await engine.post(`/v1/projects/${project}/rebind`, { dev_repo_path: path });
  assert.equal(res.status, 200, `rebind ${project} to ${path} (body: ${res.text})`);
  return res;
}
