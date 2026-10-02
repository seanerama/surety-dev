// `surety store backup` and `surety store restore` (D1 §§6.5, 11.6; SEAM.md
// §59). Both run against an engine home that no engine holds: they take its
// lock for as long as they work.
//
// A backup is a consistent snapshot of the store, taken through SQLite's
// online backup API, every published record the snapshot refers to, and a
// manifest that lists each member with its length and hash and, per
// project, the commits the snapshot refers to. The commits are not copied:
// the engine keeps each reachable in the repository from a ref it has
// registered. A copy of the database alone is labeled
// `incomplete_for_recovery`.
//
// A restore verifies the whole closure before it writes anything: the label,
// every member's presence, length and hash, that the snapshot refers to no
// record the backup lacks, that every project is bound to a repository, and
// that every listed commit exists in the repository bound to its project.
// Then it installs the records and the store, and records each project's
// repository as bound, through the store's own transition.

import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { syncDirectory, writeFileDurable } from '../durable.js';
import { configureGit, repoContext, git } from '../git/exec.js';
import { newId } from '../ids.js';
import { acquireLock, releaseLock } from '../lock.js';
import { homePaths } from '../paths.js';
import { Refusal } from '../refusal.js';
import { rebindProject } from './transitions/project.js';
import { ENGINE_ACTOR, transact } from './transitions/tx.js';

export const STORE_EXIT = { ok: 0, usage: 2, locked: 3, refused: 7 } as const;

export class StoreCommandRefused extends Error {
  constructor(
    readonly status: number,
    readonly refusal: Refusal,
  ) {
    super(refusal.reason);
  }
}

const refused = (code: string, reason: string, whatToDo: string, subject: unknown = {}) => new StoreCommandRefused(STORE_EXIT.refused, new Refusal(409, code, reason, whatToDo, subject));

const incomplete = (reason: string, subject: unknown = {}) =>
  refused('backup_incomplete', `The backup cannot be restored: ${reason}.`, 'Restore from a complete backup whose members are all present and unaltered, with every project bound to its repository. Nothing was written.', subject);

interface Manifest {
  label: 'complete' | 'incomplete_for_recovery';
  store: { file: string; sha256: string; bytes: number };
  records: { id: string; file: string; sha256: string; bytes: number }[];
  git: { project: string; objects: string[] }[];
}

function fileDigest(path: string): { sha256: string; bytes: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Run `work` holding the engine home's lock.
async function withLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  let lock;
  try {
    lock = acquireLock(home);
  } catch (err) {
    if (err instanceof Refusal) throw new StoreCommandRefused(err.code === 'engine_locked' ? STORE_EXIT.locked : STORE_EXIT.refused, err);
    throw err;
  }
  try {
    return await work();
  } finally {
    releaseLock(home, lock);
  }
}

// The published, unexpired records a store refers to, and per project the
// commits it refers to.
function closureOf(db: Database.Database): { records: { id: string; path: string; sha256: string; bytes: number }[]; git: Manifest['git']; projects: string[] } {
  const records = db
    .prepare('SELECT "id", "path", "sha256", "bytes" FROM "records" WHERE "published" = 1 AND "path" IS NOT NULL ORDER BY "created_at", "id"')
    .all() as { id: string; path: string; sha256: string; bytes: number }[];
  const projects = (db.prepare('SELECT "id" FROM "projects" ORDER BY "created_at", "id"').all() as { id: string }[]).map((p) => p.id);
  const git = projects.map((project) => {
    const objects = new Set<string>();
    for (const r of db.prepare('SELECT "sha" FROM "revisions" WHERE "project" = ? ORDER BY "id"').all(project) as { sha: string }[]) objects.add(r.sha);
    for (const r of db.prepare('SELECT "expected_oid" FROM "ref_registry" WHERE "project" = ? ORDER BY "id"').all(project) as { expected_oid: string }[]) objects.add(r.expected_oid);
    return { project, objects: [...objects] };
  });
  return { records, git, projects };
}

export async function backupStore(home: string, opts: { databaseOnly: boolean }): Promise<{ backup: string; label: Manifest['label'] }> {
  const paths = homePaths(home);
  return withLock(home, async () => {
    if (!existsSync(paths.store)) throw refused('store_missing', 'There is no store in this engine home to back up.', 'Run the command against the engine home that holds store.db.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(home, 'backups', `${stamp}-${newId('bak_')}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const source = new Database(paths.store, { fileMustExist: true });
      try {
        await source.backup(join(dir, 'store.db'));
      } finally {
        source.close();
      }
      syncFile(join(dir, 'store.db'));
      const label: Manifest['label'] = opts.databaseOnly ? 'incomplete_for_recovery' : 'complete';
      const manifest: Manifest = { label, store: { file: 'store.db', ...fileDigest(join(dir, 'store.db')) }, records: [], git: [] };
      if (!opts.databaseOnly) {
        const snapshot = new Database(join(dir, 'store.db'), { readonly: true, fileMustExist: true });
        let closure;
        try {
          closure = closureOf(snapshot);
        } finally {
          snapshot.close();
        }
        mkdirSync(join(dir, 'records'), { recursive: true, mode: 0o700 });
        for (const r of closure.records) {
          const file = join('records', r.path);
          const from = join(home, 'records', r.path);
          if (!existsSync(from)) throw refused('backup_incomplete', `Record ${r.id} is referred to by the store, and its bytes are missing.`, 'Nothing can be backed up completely until it is restored; a database-only copy can be taken.', { record: r.id });
          mkdirSync(dirname(join(dir, file)), { recursive: true, mode: 0o700 });
          copyFileSync(from, join(dir, file));
          syncFile(join(dir, file));
          const digest = fileDigest(join(dir, file));
          if (digest.sha256 !== r.sha256 || digest.bytes !== r.bytes) {
            throw refused('backup_incomplete', `Record ${r.id} does not have the hash the store recorded for it.`, 'Nothing can be backed up completely until it is restored; a database-only copy can be taken.', { record: r.id });
          }
          manifest.records.push({ id: r.id, file, ...digest });
        }
        syncDirectory(join(dir, 'records'));
        manifest.git = closure.git;
      }
      writeFileDurable(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      syncDirectory(dirname(dir));
      return { backup: dir, label };
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });
}

function readManifest(dir: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw incomplete('its manifest is missing or unreadable', { member: 'manifest.json' });
  }
  const m = value as Partial<Manifest>;
  if (m === null || typeof m !== 'object' || typeof m.label !== 'string' || typeof m.store !== 'object' || m.store === null || !Array.isArray(m.records) || !Array.isArray(m.git)) {
    throw incomplete('its manifest is not a backup manifest', { member: 'manifest.json' });
  }
  return m as Manifest;
}

// A member of the backup, present with its listed length and hash.
function verifyMember(dir: string, member: { file: string; sha256: string; bytes: number }): string {
  const path = resolve(dir, member.file);
  if (typeof member.file !== 'string' || isAbsolute(member.file) || !path.startsWith(`${resolve(dir)}/`)) throw incomplete(`a member names a file outside the backup (${String(member.file)})`, { member: member.file });
  if (!existsSync(path)) throw incomplete(`its member ${member.file} is missing`, { member: member.file });
  const digest = fileDigest(path);
  if (digest.bytes !== member.bytes || digest.sha256 !== member.sha256) throw incomplete(`its member ${member.file} does not have the listed length and hash`, { member: member.file });
  return path;
}

export async function restoreStore(home: string, opts: { from: string; bind: Map<string, string> }): Promise<{ restored: string; projects: string[] }> {
  const paths = homePaths(home);
  if (existsSync(paths.store)) throw refused('store_exists', 'This engine home already has a store; a restore installs one only into a home that has none.', 'Restore into a fresh engine home.');
  return withLock(home, async () => {
    const dir = resolve(opts.from);
    const manifest = readManifest(dir);
    if (manifest.label === 'incomplete_for_recovery') {
      throw refused('incomplete_for_recovery', 'The backup is a copy of the database alone, labeled incomplete for recovery: it holds no records and lists no repository objects.', 'Restore from a complete backup.', { label: manifest.label });
    }
    if (manifest.label !== 'complete') throw incomplete(`its label is ${String(manifest.label)}`);
    const storeFile = verifyMember(dir, manifest.store);
    const recordFiles = manifest.records.map((r) => ({ ...r, from: verifyMember(dir, r) }));

    // What the snapshot refers to must all be here.
    const snapshot = new Database(storeFile, { readonly: true, fileMustExist: true });
    let closure;
    try {
      closure = closureOf(snapshot);
    } finally {
      snapshot.close();
    }
    for (const r of closure.records) {
      const listed = recordFiles.find((m) => m.id === r.id);
      if (!listed || listed.sha256 !== r.sha256 || listed.bytes !== r.bytes) throw incomplete(`the store refers to record ${r.id}, which the backup does not hold whole`, { record: r.id });
    }
    for (const project of closure.projects) if (!opts.bind.has(project)) throw incomplete(`project ${project} is not bound to a repository (--bind ${project}=<path>)`, { project });
    for (const project of opts.bind.keys()) if (!closure.projects.includes(project)) throw incomplete(`there is no project ${project} in the backup to bind`, { project });

    // Every listed commit is in the repository bound to its project.
    configureGit({ deadlineSeconds: 60, outputCap: 8 << 20, home, incarnation: 'restore' });
    for (const entry of closure.git) {
      const listed = manifest.git.find((g) => g.project === entry.project);
      const objects = new Set([...(listed?.objects ?? []), ...entry.objects]);
      const repo = opts.bind.get(entry.project)!;
      for (const oid of objects) {
        const found = await git(repoContext(repo), ['cat-file', '-e', `${oid}^{commit}`]);
        if (found.code !== 0) throw incomplete(`commit ${oid} of project ${entry.project} is not in the repository bound to it (${repo})`, { project: entry.project, object: oid });
      }
    }

    // Verified: install the records, then the store, then the bindings.
    const records = join(home, 'records');
    mkdirSync(records, { recursive: true, mode: 0o700 });
    for (const r of closure.records) {
      const member = recordFiles.find((m) => m.id === r.id)!;
      const to = join(records, r.path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileDurable(to, readFileSync(member.from));
    }
    syncDirectory(records);
    try {
      writeFileDurable(paths.store, readFileSync(storeFile));
      const db = new Database(paths.store, { fileMustExist: true });
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('foreign_keys = ON');
        for (const [project, repo] of opts.bind) transact(db, ENGINE_ACTOR, (tx) => rebindProject(tx, { project, dev_repo_path: repo }));
      } finally {
        db.close();
      }
    } catch (err) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${paths.store}${suffix}`, { force: true });
      throw err;
    }
    return { restored: dir, projects: closure.projects };
  });
}
