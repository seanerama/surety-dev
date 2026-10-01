// Migrations (D1 §6.4, build spec §6 correction 19, SEAM.md §5). Numbered SQL
// files are applied in order, all pending ones in one transaction, each
// recorded in schema_migrations with its identity, order and checksum. An
// applied migration whose file is missing or changed prevents full mode.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { nowIso } from '../clock.js';
import { Refusal } from '../refusal.js';
import { barrier } from '../testing/seam.js';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  seq: number;
  name: string;
  sql: string;
  checksum: string;
}

interface AppliedRow {
  seq: number;
  name: string;
  checksum: string;
}

const failed = (code: string, migration: string, reason: string, whatToDo: string) =>
  new Refusal(500, code, reason, whatToDo, { migration });

function listMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      return {
        seq: Number(MIGRATION_FILE.exec(name)![1]),
        name,
        sql: bytes.toString('utf8'),
        checksum: createHash('sha256').update(bytes).digest('hex'),
      };
    })
    .sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.seq === files[i - 1]!.seq) {
      throw failed('migration_failed', files[i]!.name, `Two migrations share number ${files[i]!.seq}.`, 'Give each migration a distinct number.');
    }
  }
  return files;
}

// The history table is part of the store's own bookkeeping, created in the
// same transaction as the first migration. Its rows are never rewritten.
const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  seq INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update BEFORE UPDATE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete BEFORE DELETE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema_migrations is append-only'); END;
`;

export function migrate(db: Database, dir: string): { applied: string[] } {
  const files = listMigrations(dir);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(HISTORY_DDL);
    const applied = db.prepare('SELECT "seq", "name", "checksum" FROM "schema_migrations" ORDER BY "seq"').all() as AppliedRow[];
    for (const row of applied) {
      const file = files.find((f) => f.seq === row.seq);
      if (!file || file.name !== row.name || file.checksum !== row.checksum) {
        throw failed(
          'migration_checksum_mismatch',
          row.name,
          file && file.name === row.name
            ? `Applied migration ${row.name} has changed since it was applied (checksum ${file.checksum}, recorded ${row.checksum}).`
            : `Applied migration ${row.name} is missing from the migrations directory.`,
          'Restore the migration file exactly as it was applied. An applied migration is immutable; changes go in a new migration.',
        );
      }
    }
    const last = applied.at(-1)?.seq ?? 0;
    const pending = files.filter((f) => !applied.some((a) => a.seq === f.seq));
    const record = db.prepare('INSERT INTO "schema_migrations" ("seq", "name", "checksum", "applied_at") VALUES (?, ?, ?, ?)');
    for (const file of pending) {
      if (file.seq < last) {
        throw failed(
          'migration_failed',
          file.name,
          `Migration ${file.name} is numbered before the last applied migration and cannot be applied in order.`,
          'Renumber it after the last applied migration.',
        );
      }
      try {
        db.exec(file.sql);
      } catch (err) {
        throw failed('migration_failed', file.name, `Migration ${file.name} failed: ${(err as Error).message}`, 'Fix the migration and restart the engine; nothing from this batch was applied.');
      }
      record.run(file.seq, file.name, file.checksum, nowIso());
    }
    if (pending.length > 0) barrier('migration.before_commit');
    db.exec('COMMIT');
    return { applied: pending.map((f) => f.name) };
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
