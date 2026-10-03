// The stand-in backend binary (M2 plan §2.3; SEAM.md §116). A fixture trust
// entry for a real backend name (`claude`, `codex`) binds the engine to this
// program instead of the real binary: the entry records its path and
// SHA-256, and the engine spawns it exactly as it would spawn the real one,
// with the adapter's template argv and the environment it constructs.
//
// It is the Verifier's instrument, not an agent: it records what it was
// given and does nothing else. Each launch appends one line to
// `standin.jsonl`:
//   {"event": "launch", "pid", "start_time", "pgrp", "cwd", "args": [...],
//    "env_keys": [...], "env_value_hashes": [...], "env_hashes": {...},
//    "domain", "invocation", "ppid", "parent_comm", "parent_cmdline",
//    "cmdline", "context"}
// where `args` is every argument after the program's own path, as the
// kernel delivered it, `env_keys` the names of every environment variable
// and `env_value_hashes` the SHA-256 of each value (so a test can see that
// a held secret arrived, and that the API token did not, without the log
// holding either). It writes nothing to stdout, reads nothing from stdin
// (an adapter that keeps stdin open must not be waited for), and exits 0.
// What the stand-in runs after recording (the scripted child, for the
// canaries of M135) is a later slice's extension, not slice 10's.
//
// M2 slice 12 (SEAM.md §139; row M125) adds, for the sandbox lane:
//   - `env_hashes`, the same hashes by variable name; `cmdline`, the whole
//     argument array as /proc/self/cmdline has it; the parent's pid, name
//     and argument array (the init, never a shell);
//   - `context`: when /surety/context exists, every file of it with its size
//     and hash, and its text where it is small (the context package is
//     engine-authored text and the task's own);
//   - where it logs: inside a sandbox its own directory is the backend's
//     installation, read-only, so the harness may name another directory in
//     the first line of the file (`const LOG_DIR_OVERRIDE = "<dir>";`, the
//     scripted directory, which a sandbox-lane engine binds read-write);
//   - a hold: while `standin-hold` exists in the log directory the stand-in
//     waits, after recording, until `standin-release` exists there, so that
//     the host can read its process while it lives. It then exits 0.
//
// The harness writes this file into each test's stand-in directory with a
// shebang naming the test's own node (`StandIn` in harness/trust.mjs), so
// that the engine's constructed PATH, which need not hold node, cannot
// keep it from starting; the entry's SHA-256 is of the file as written.
// Self-contained: Node built-ins only.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line no-undef
const logDir = typeof LOG_DIR_OVERRIDE === 'string' ? LOG_DIR_OVERRIDE : dir;

function statField(n) {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[n - 3];
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Every file under the context package, without following links, bounded.
function contextFiles(root) {
  if (!existsSync(root)) return null;
  const out = [];
  const queue = [''];
  let total = 0;
  while (queue.length > 0 && out.length < 2000) {
    const rel = queue.shift();
    let names;
    try {
      names = readdirSync(join(root, rel), { withFileTypes: true });
    } catch (err) {
      out.push({ name: rel, error: err.code ?? String(err) });
      continue;
    }
    for (const d of names) {
      const name = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) queue.push(name);
      else if (d.isFile()) {
        try {
          const size = lstatSync(join(root, name)).size;
          const item = { name, type: 'file', size };
          if (size <= 262144 && total + size <= 1024 * 1024) {
            const bytes = readFileSync(join(root, name));
            total += bytes.length;
            item.sha256 = sha256(bytes);
            item.text = bytes.toString('utf8');
          }
          out.push(item);
        } catch (err) {
          out.push({ name, error: err.code ?? String(err) });
        }
      } else out.push({ name, type: 'other' });
    }
  }
  return out;
}

const ppid = Number(statField(4));
const parent = {};
try {
  parent.parent_comm = readFileSync(`/proc/${ppid}/comm`, 'utf8').trim();
  parent.parent_cmdline = readFileSync(`/proc/${ppid}/cmdline`, 'latin1').split('\0').filter(Boolean);
} catch (err) {
  parent.parent_error = err.code ?? String(err);
}

const entry = {
  event: 'launch',
  at: new Date().toISOString(),
  pid: process.pid,
  start_time: statField(22),
  pgrp: Number(statField(5)),
  cwd: process.cwd(),
  args: process.argv.slice(2),
  cmdline: readFileSync('/proc/self/cmdline', 'latin1').split('\0').filter((a, i, all) => !(i === all.length - 1 && a === '')),
  env_keys: Object.keys(process.env).sort(),
  env_value_hashes: Object.values(process.env).map(sha256),
  env_hashes: Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, sha256(v)])),
  domain: process.env.SURETY_DOMAIN ?? null,
  invocation: process.env.SURETY_INVOCATION ?? null,
  ppid,
  ...parent,
  context: contextFiles('/surety/context'),
};

try {
  appendFileSync(join(logDir, 'standin.jsonl'), `${JSON.stringify(entry)}\n`);
} catch {
  // The log is the test's evidence; a lost line must not change what the stand-in does.
}

// The hold (see the head of this file): bounded, so that a test that failed
// before its release does not leave the stand-in for ever.
if (existsSync(join(logDir, 'standin-hold'))) {
  const began = Date.now();
  while (!existsSync(join(logDir, 'standin-release')) && existsSync(join(logDir, 'standin-hold')) && Date.now() - began < 120_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
process.exit(0);
