// The stand-in backend binary (M2 plan §2.3; SEAM.md §116). A fixture trust
// entry for a real backend name (`claude`, `codex`) binds the engine to this
// program instead of the real binary: the entry records its path and
// SHA-256, and the engine spawns it exactly as it would spawn the real one,
// with the adapter's template argv and the environment it constructs.
//
// It is the Verifier's instrument, not an agent: it records what it was
// given and does nothing else. Each launch appends one line to
// `standin.jsonl` beside this file:
//   {"event": "launch", "pid", "start_time", "pgrp", "cwd", "args": [...],
//    "env_keys": [...], "env_value_hashes": [...], "domain", "invocation"}
// where `args` is every argument after the program's own path, as the
// kernel delivered it, `env_keys` the names of every environment variable
// and `env_value_hashes` the SHA-256 of each value (so a test can see that
// a held secret arrived, and that the API token did not, without the log
// holding either). It writes nothing to stdout, reads nothing from stdin
// (an adapter that keeps stdin open must not be waited for), and exits 0.
// What the stand-in runs after recording (the scripted child, for the
// canaries of M135) is a later slice's extension, not slice 10's.
//
// The harness writes this file into each test's stand-in directory with a
// shebang naming the test's own node (`StandIn` in harness/trust.mjs), so
// that the engine's constructed PATH, which need not hold node, cannot
// keep it from starting; the entry's SHA-256 is of the file as written.
// Self-contained: Node built-ins only.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

function statField(n) {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[n - 3];
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const entry = {
  event: 'launch',
  at: new Date().toISOString(),
  pid: process.pid,
  start_time: statField(22),
  pgrp: Number(statField(5)),
  cwd: process.cwd(),
  args: process.argv.slice(2),
  env_keys: Object.keys(process.env).sort(),
  env_value_hashes: Object.values(process.env).map(sha256),
  domain: process.env.SURETY_DOMAIN ?? null,
  invocation: process.env.SURETY_INVOCATION ?? null,
};

try {
  appendFileSync(join(dir, 'standin.jsonl'), `${JSON.stringify(entry)}\n`);
} catch {
  // The log is the test's evidence; a lost line must not change what the stand-in does.
}
process.exit(0);
