// The test side of the power-loss shim (row M67; SEAM.md §60; E31 item 5).
// powerloss/shim.c is compiled at test time and loaded with LD_PRELOAD into
// the process under test, where it copies every file at the moment it is
// synced. This module builds it, says which directories a cut applies to,
// and cuts power: it kills every process the shim is in and puts every
// regular file under those directories back to what was last synced.
//
// The model: a file's durable content is what it held at its last fsync or
// fdatasync (or when the session began), followed across renames and links;
// a file created since and never synced is empty; names are durable at once.
// SEAM.md §60 says what that does and does not stand for.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'powerloss', 'shim.c');

// Compile the shim into `dir`. A compiler that is missing or fails is an
// error, never a skip: without the shim row M67 is unpassed (Plan M67).
export function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'powerloss-shim.so');
  const cc = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-o', out, SOURCE, '-ldl'], { encoding: 'utf8' });
  if (cc.error) throw new Error(`the power-loss shim could not be compiled: cc could not be run (${cc.error.message})`);
  if (cc.status !== 0) throw new Error(`the power-loss shim could not be compiled: cc exited ${cc.status}\n${cc.stderr}`);
  return out;
}

// The key the shim files a synced copy under: the file, not its name. The
// birth time tells a new file from an older one whose inode number it got.
const keyOf = (path) => {
  const s = statSync(path, { bigint: true });
  return `${s.dev}-${s.ino}-${s.birthtimeNs}`;
};

// Every regular file under a directory. Symbolic links are not followed.
function regularFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) regularFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export class PowerLoss {
  // `dir` is where the shim is built and keeps its copies; `roots` are the
  // directories a cut applies to (an engine home, a repository). Neither
  // may contain the other.
  constructor(dir, roots) {
    this.dir = dir;
    this.lib = buildShim(dir);
    this.control = join(dir, 'control');
    mkdirSync(join(this.control, 'synced'), { recursive: true });
    mkdirSync(join(this.control, 'loaded'), { recursive: true });
    this.roots = roots.map((root) => realpathSync(root));
    writeFileSync(join(this.control, 'roots'), this.roots.map((root) => `${root}\n`).join(''));
  }

  // What a process is started with to be under the shim.
  env() {
    return { LD_PRELOAD: this.lib, SURETY_POWERLOSS: this.control };
  }

  // Everything under the roots now is durable: the state power is cut back
  // to if nothing is synced afterwards. Call it with no process writing.
  baseline() {
    for (const root of this.roots) for (const file of regularFiles(root)) copyFileSync(file, join(this.control, 'synced', keyOf(file)));
  }

  // The processes the shim was loaded into: [{pid, comm}].
  loaded() {
    return readdirSync(join(this.control, 'loaded')).map((pid) => ({ pid: Number(pid), comm: readFileSync(join(this.control, 'loaded', pid), 'utf8').trim() }));
  }

  // Syncs the shim saw and could not record. A cut refuses to go on if
  // there are any: what it restored would not be what was synced.
  errors() {
    const file = join(this.control, 'errors');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  }

  // The live processes that carry this session's marker in their environment.
  #processes() {
    const marker = `SURETY_POWERLOSS=${this.control}`;
    const found = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(marker)) found.push(Number(name));
      } catch {
        // gone, or not ours to read
      }
    }
    return found;
  }

  // Cut power. Every process under the shim, and every pid given, is killed
  // at once and waited for. Then each regular file under the roots gets the
  // content it had when it was last synced, and a file never synced is
  // emptied; names, directories and links stay as they are. Returns the
  // paths it changed: {reverted, emptied}.
  async cut({ pids = [] } = {}) {
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)[0] !== 'Z';
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 15_000;
    for (;;) {
      const victims = [...new Set([...pids, ...this.#processes()])].filter(alive);
      if (victims.length === 0) break;
      for (const pid of victims) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      if (Date.now() > deadline) throw new Error(`power cut: processes ${victims.join(', ')} did not die`);
      await sleep(20);
    }
    const errors = this.errors();
    if (errors.length > 0) throw new Error(`the power-loss shim could not record every sync:\n${errors.join('\n')}`);

    const changed = { reverted: [], emptied: [] };
    for (const root of this.roots) {
      for (const file of regularFiles(root)) {
        const synced = join(this.control, 'synced', keyOf(file));
        const durable = existsSync(synced) ? readFileSync(synced) : Buffer.alloc(0);
        if (durable.equals(readFileSync(file))) continue;
        // A new file under the old name, with the old mode: the file may be
        // read-only (a git object), and one inode may have several names.
        const mode = lstatSync(file).mode & 0o7777;
        const temp = `${file}.powerloss-restore`;
        writeFileSync(temp, durable);
        chmodSync(temp, mode);
        renameSync(temp, file);
        (existsSync(synced) ? changed.reverted : changed.emptied).push(file);
      }
    }
    return changed;
  }
}
