// The host's view of the processes inside a domain (M2 plan §2.4; SEAM.md
// §125): /proc/<pid>/status (NSpid, uid, capabilities), environ, cmdline,
// stat (session id), cgroup. A role inside the sandbox sees itself by its
// pid in its own pid namespace, which is what the scripted log records; the
// host sees it by its host pid, and NSpid joins the two. Everything here is
// read by the same uid as the engine's helpers, as D2 §2.4 of the plan
// allows; a process whose files cannot be read is reported as such, never
// as absent.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

import { waitFor } from '../engine.mjs';
import { procsOf } from './cgroup.mjs';

function statusOf(pid) {
  const out = {};
  for (const line of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

// Field n of /proc/<pid>/stat, counted as proc(5) does, from the last ')'.
function statField(pid, n) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[n - 3];
}

// One host process, read whole: null when it is gone. `environ` is a Map,
// or null when it cannot be read (then `environ_error` says why).
export function hostProcess(pid) {
  try {
    const status = statusOf(pid);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '');
    let environ = null;
    let environError = null;
    try {
      environ = new Map();
      for (const entry of readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0) environ.set(entry.slice(0, eq), entry.slice(eq + 1));
      }
    } catch (err) {
      environ = null;
      environError = err.code ?? String(err);
    }
    return {
      pid,
      nspid: (status.NSpid ?? String(pid)).split(/\s+/).map(Number),
      innerPid: Number((status.NSpid ?? String(pid)).split(/\s+/).at(-1)),
      state: statField(pid, 3),
      session: Number(statField(pid, 6)),
      pgrp: Number(statField(pid, 5)),
      startTime: statField(pid, 22),
      uid: (status.Uid ?? '').split(/\s+/).map(Number),
      capEff: status.CapEff ?? null,
      noNewPrivs: status.NoNewPrivs === undefined ? null : Number(status.NoNewPrivs),
      cmdline,
      environ,
      environError,
    };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH') return null;
    throw err;
  }
}

// Every process of a domain's cgroup, read from the host; a pid listed in
// cgroup.procs that has gone by the time it is read is left out.
export function members(dir) {
  return procsOf(dir)
    .map(hostProcess)
    .filter((p) => p !== null);
}

// The member whose pid inside the sandbox's pid namespace is `innerPid`.
export const memberByInnerPid = (dir, innerPid) => members(dir).find((p) => p.innerPid === innerPid) ?? null;

// The members whose environment carries the invocation marker: the role
// and whatever inherited its environment (SEAM.md §13: SURETY_INVOCATION).
export const roleMembers = (dir, invocation) => members(dir).filter((p) => p.environ?.get('SURETY_INVOCATION') === invocation);

// The members running the scripted role program (by command line): the
// role and its descendants, whatever their environment.
export const scriptedMembers = (dir, program) => members(dir).filter((p) => p.cmdline.some((a) => a.endsWith(program)));

// Every host process running `program` (a path or its basename), anywhere.
export function hostProcessesRunning(program) {
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').some((a) => a === program || a.endsWith(`/${program}`))) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

export const isHostAlive = (pid) => {
  const p = hostProcess(pid);
  return p !== null && p.state !== 'Z';
};

export const waitHostGone = (pid, { timeoutMs = 20_000 } = {}) => waitFor(() => (isHostAlive(pid) ? undefined : true), { timeoutMs, what: `host pid ${pid} to be gone` });

// A member of `dir` matching `predicate`, waited for.
export const waitMember = (dir, predicate, { timeoutMs = 20_000, what = 'a member' } = {}) =>
  waitFor(
    () => {
      try {
        return members(dir).find(predicate);
      } catch {
        return undefined;
      }
    },
    { timeoutMs, what: `${what} in ${dir}` },
  );

// ---- a process's environment block, read from its memory (objection 008) -------------------
//
// `/proc/<pid>/environ` is the process's initial environment block, the
// bytes between `env_start` and `env_end` of its memory. For a non-dumpable
// process whose /proc files the kernel gives to a root the host is not (the
// domain init, by design: D2 §2.3, M117 (b)), the file's mode refuses the
// host. The same bytes stay readable to the host by another route that the
// role does not have: `/proc/<pid>/stat` shows `env_start` and `env_end`
// (fields 50 and 51) to a reader the kernel lets ptrace-read the process,
// and `process_vm_readv(2)` copies them under the ptrace check alone, with
// no file-mode check. The host, uid 1000 in the initial user namespace,
// owns the sandbox's user namespaces and so holds CAP_SYS_PTRACE over them;
// the role, in the init's own namespace with no capability, does not. Node
// has no binding for the call, so the host's python3 makes it (a host tool,
// like git and systemd-run; no package). Read-only; the target is a process
// of the test's own engine. Returns {env: Map, start, end}; throws with the
// reason when the block cannot be read: unknown is never absence.
const ENV_BLOCK_READER = String.raw`
import ctypes, json, os, sys
pid = int(sys.argv[1])
stat = open(f"/proc/{pid}/stat").read()
f = stat[stat.rindex(")") + 2:].split(" ")
start, end = int(f[50 - 3]), int(f[51 - 3])
if start == 0 or end <= start:
    print(json.dumps({"error": "env_start/env_end are not shown to this reader"})); sys.exit(0)
class iovec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p), ("iov_len", ctypes.c_size_t)]
libc = ctypes.CDLL(None, use_errno=True)
n = end - start
buf = ctypes.create_string_buffer(n)
local = iovec(ctypes.cast(buf, ctypes.c_void_p), n)
remote = iovec(ctypes.c_void_p(start), n)
r = libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
if r != n:
    e = ctypes.get_errno()
    print(json.dumps({"error": f"process_vm_readv read {r} of {n} bytes ({os.strerror(e) if r < 0 else 'short'})"})); sys.exit(0)
print(json.dumps({"start": start, "end": end, "env": [x.decode("latin1") for x in buf.raw.split(b"\0") if x]}))
`;

export function environFromMemory(pid) {
  const done = spawnSync('python3', ['-c', ENV_BLOCK_READER, String(pid)], { encoding: 'utf8', timeout: 10_000 });
  if (done.error || done.status !== 0) throw new Error(`the host could not run python3 to read pid ${pid}'s environment block (${done.error?.code ?? done.status}: ${(done.stderr ?? '').trim().slice(0, 300)})`);
  const out = JSON.parse(done.stdout.trim());
  if (out.error) throw new Error(`pid ${pid}'s environment block cannot be read from the host: ${out.error}`);
  const env = new Map();
  for (const entry of out.env) {
    const eq = entry.indexOf('=');
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { env, start: out.start, end: out.end };
}
