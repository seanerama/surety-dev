// The fake `claude` of the review's cases (M2 slice 14; E74 items 2, 3;
// SEAM.md §167): writes `harness/standin/fake-claude.mjs` as a test-owned
// executable, and sets what it does through a mode file in the scripted
// directory. It is never the real binary: it is a script, outside every
// directory on the engine's PATH, so the engine's test mode accepts it as a
// stand-in (section 148), and it runs no model.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../engine.mjs';
import { hostPidNamespace } from '../scripted.mjs';

const PROGRAM = join(dirname(fileURLToPath(import.meta.url)), '..', 'standin', 'fake-claude.mjs');

export class FakeClaude {
  // `dir`: where the program is written; `modeDir`: a directory every
  // sandbox of the engine can read (the scripted directory).
  constructor(dir, { modeDir }) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'claude');
    this.modeFile = join(modeDir, 'fake-claude.json');
    writeFileSync(this.path, `#!${process.execPath}\nconst MODE_FILE = ${JSON.stringify(this.modeFile)};\n${readFileSync(PROGRAM, 'utf8')}`);
    chmodSync(this.path, 0o755);
    this.sha256 = sha256Hex(readFileSync(this.path));
    this.set({});
  }

  // What the next launches do (see the program's header).
  set(mode) {
    writeFileSync(this.modeFile, JSON.stringify({ host_pid_ns: hostPidNamespace(), ...mode }));
  }
}
