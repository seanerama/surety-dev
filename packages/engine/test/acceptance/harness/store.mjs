// Direct access to the engine's store file (build spec §8, preference 3):
// read durable rows, and attempt forbidden writes in constraint tests.

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

export const storePath = (home) => join(home, 'store.db');

export function openStore(file, { readonly = false } = {}) {
  const db = new Database(file, { readonly, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  if (!readonly) db.pragma('foreign_keys = ON');
  return db;
}

// Read with a short-lived connection so no test holds the store open.
export function withStore(home, fn, { readonly = true } = {}) {
  const db = openStore(storePath(home), { readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Copy a stopped engine's store (with any WAL/SHM side files) into `dir`.
export function copyStore(home, dir) {
  const src = storePath(home);
  const dest = join(dir, 'store.db');
  copyFileSync(src, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix);
  }
  return dest;
}

export function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

export const hasTable = (db, name) => tableNames(db).includes(name);

export const countRows = (db, table, where = '1 = 1', ...params) =>
  db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(...params).n;

export function eventsOfType(db, type) {
  return db.prepare('SELECT * FROM "events" WHERE "type" = ? ORDER BY "seq"').all(type);
}

export const parseJson = (text) => (text === null || text === undefined ? text : JSON.parse(text));

// Every row of every table as JSON text, for "the transaction left nothing behind".
export function dumpStore(db, { exclude = [] } = {}) {
  const out = {};
  for (const name of tableNames(db)) {
    if (exclude.includes(name)) continue;
    out[name] = db
      .prepare(`SELECT * FROM "${name}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return out;
}
