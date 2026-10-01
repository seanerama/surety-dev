// Composite fixtures shared by slice-1 test files.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  engineFixture,
  freePort,
  installProject,
  isRefusalBody,
  makeTempDir,
  removeDir,
  startEngine,
  writeEngineConfig,
} from './engine.mjs';
import { makeRepo } from './git.mjs';
import { copyStore, dumpStore, openStore, withStore } from './store.mjs';

export const CONTRACT = JSON.parse(readFileSync(new URL('../contract/config.json', import.meta.url), 'utf8'));

// A running harness-mode engine with one fixture-installed project on a real repository.
export async function projectFixture(t, opts = {}) {
  const fx = await engineFixture(t, opts);
  const repoDir = makeTempDir('repo');
  t.after(() => removeDir(repoDir));
  const repo = makeRepo(repoDir);
  const project = await installProject(fx.engine, { repoPath: repo.path });
  return { ...fx, repo, project };
}

// A stopped engine's home holding a store with one fixture project. Store
// cases copy it so each case has its own store.
export async function storeTemplate() {
  const root = makeTempDir('template');
  const home = join(root, 'home');
  mkdirSync(home);
  const repo = makeRepo(join(root, 'repo'));
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  const engine = await startEngine({ home, port });
  let project;
  try {
    project = await installProject(engine, { repoPath: repo.path });
  } finally {
    await engine.stop();
  }
  return { root, home, repo, project, cleanup: () => removeDir(root) };
}

// A private read-write copy of the template's store.
export function storeCopy(t, template) {
  const dir = makeTempDir('store');
  const file = copyStore(template.home, dir);
  const db = openStore(file);
  t.after(() => {
    if (db.open) db.close();
    removeDir(dir);
  });
  return { db, file, dir, project: template.project };
}

// A private copy of the template's whole home on a new port.
export async function homeCopy(t, template) {
  const dir = makeTempDir('homecopy');
  const home = join(dir, 'home');
  cpSync(template.home, home, { recursive: true });
  const port = await freePort();
  writeEngineConfig(home, { api_port: port });
  t.after(() => removeDir(dir));
  return { home, port, project: template.project };
}

// Assert an HTTP refusal: status, D1 §11.5 body shape, and code.
export function assertRefused(res, status, code, what = '') {
  assert.equal(res.status, status, `${what} status (body: ${res.text})`);
  assert.ok(isRefusalBody(res.body), `${what} refusal body has code, reason, what_to_do, subject: ${res.text}`);
  if (Array.isArray(code)) assert.ok(code.includes(res.body.code), `${what} code ${res.body.code} not in ${code}`);
  else assert.equal(res.body.code, code, `${what} code`);
}

export const maxEventSeq = (home) => withStore(home, (db) => db.prepare('SELECT COALESCE(MAX("seq"), 0) AS n FROM "events"').get().n);

export const eventsSince = (home, seq) =>
  withStore(home, (db) => db.prepare('SELECT * FROM "events" WHERE "seq" > ? ORDER BY "seq"').all(seq));

// The audit events (api.act) recorded for one method and path since `seq`.
export function auditEvents(home, seq, method, path) {
  return eventsSince(home, seq)
    .filter((e) => e.type === 'api.act')
    .filter((e) => {
      const p = JSON.parse(e.payload);
      return p.method === method && p.path === path;
    });
}

// Everything in the store except the append-only event log and the engine's
// own incarnation bookkeeping, for "the request had no effect" checks.
export const storeState = (home) => withStore(home, (db) => dumpStore(db, { exclude: ['events', 'engine_incarnations'] }));

// After a refused request: no row changed anywhere, and the only new events are
// audit records or scheduler heartbeats.
export function assertNoEffect(home, before, sinceSeq, what) {
  assert.deepEqual(storeState(home), before, `${what}: store rows unchanged`);
  const types = new Set(eventsSince(home, sinceSeq).map((e) => e.type));
  for (const type of types) assert.ok(['api.act', 'engine.tick'].includes(type), `${what}: unexpected event ${type}`);
}
