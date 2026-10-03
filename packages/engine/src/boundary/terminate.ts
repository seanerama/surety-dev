// Termination and observation of a domain on the real boundary (D2 §§3.2 to
// 3.4, 1.6), the engine's side; the run-end protocol (runs/end.ts) calls it
// for every domain that has a cgroup.
//
//   1. close the launch (`domain.launch_closed`): no grant is possible after;
//   2. establish that no launcher can still enter: this engine's launcher has
//      exited or is a member; an unplaced one is killed through its handle
//      and its exit awaited;
//   3. TERM through the domain init, which relays it (or, without the init's
//      channel, to every member from the host), then `terminate_grace`;
//   4. `cgroup.kill`, then `kill_grace`;
//   5. observe `cgroup.events`: `populated 0` in the directory this engine
//      created, in the verified hierarchy, with the launch closed, is
//      termination; so is the directory's absence there. It is recorded with
//      the exit's evidence, and only then is the directory removed.
//
// Whatever cannot be established is `unknown` (D2 §3.4), which quarantines:
// the user manager unreachable; the recorded path outside the verified
// hierarchy, or a directory there that is not the one created; `cgroup.events`
// unreadable; `cgroup.kill` refused; a launcher whose exit cannot be
// established; `populated 1` after `kill_grace`. Kill's return is never
// termination, and a manager restart is never evidence that a domain died.

import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { nowIso } from '../clock.js';
import type { SandboxLaunch } from '../invoke/sandboxed.js';
import type { RunHandle, Runtime } from '../runtime.js';
import { log } from '../runtime.js';
import type { DomainRow } from '../store/transitions/boundary.js';
import { pausePoint, seamMainFault } from '../testing/seam.js';
import { SUPERVISOR_LEAF, cgroupInode, homeScopes, isHomeScope, readPopulated, readProcs, removeCgroup, verifyDomainPath, writeKill } from './cgroup.js';
import { managerReachable } from './scope.js';

export type Verdict = { terminated: true } | { terminated: false; unknown: string | null };

export interface ExitFacts {
  exit_class: string;
  exit_evidence: Record<string, unknown>;
}

function counters(path: string): { oom_kill: number | null; pids_max: number | null } {
  const read = (file: string, key: string): number | null => {
    try {
      const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(readFileSync(join(path, file), 'utf8'));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };
  return { oom_kill: read('memory.events', 'oom_kill'), pids_max: read('pids.events', 'max') };
}

// The exit class by D2 §1.6's precedence, with every fact kept.
// `signal` is the last signal the engine sent the domain (15 or 9) when it
// began cancelling before the backend's exit, else the signal that ended the
// backend (SEAM.md §126).
export function classifyExit(args: {
  report: { code: number | null; signal: number | null } | null;
  cancelledBeforeExit: boolean;
  termSent: boolean;
  killWritten: boolean;
  resources: { oom_kill: number | null; pids_max: number | null } | Record<string, never>;
  cleanResult: boolean;
}): ExitFacts {
  const { report } = args;
  const engineSignal = args.killWritten ? 9 : args.termSent ? 15 : null;
  const byEngine = args.cancelledBeforeExit && engineSignal !== null;
  const signal = byEngine ? engineSignal : (report?.signal ?? (report === null ? engineSignal : null));
  const evidence: Record<string, unknown> = {
    status: report?.code ?? null,
    signal,
    signal_by_engine: byEngine,
    terminal_event: args.cleanResult ? 'result' : null,
    resource_events: args.resources,
    report: report === null ? 'none' : 'received',
    term_sent: args.termSent,
    kill_written: args.killWritten,
  };
  const oom = 'oom_kill' in args.resources ? (args.resources.oom_kill ?? 0) : 0;
  let cls: string;
  if (args.cancelledBeforeExit) cls = 'engine_signaled';
  else if (report === null) cls = 'unknown';
  else if (report.signal !== null && !byEngine && oom > 0) cls = 'resource_limit';
  else if (report.signal !== null && !byEngine) cls = 'foreign_signal';
  else if (report.code === 0 && args.cleanResult) cls = 'clean';
  else cls = 'error_exit';
  return { exit_class: cls, exit_evidence: evidence };
}

// Is the manager reachable, the harness's fault included (D2 §3.4)?
async function manager(): Promise<string | null> {
  if (seamMainFault('manager_unreachable')) return 'the systemd user manager is unreachable (injected fault)';
  const r = await managerReachable();
  return r.reachable ? null : `the systemd user manager is unreachable: ${r.observed}`;
}

// Where a domain's cgroup must be: the engine's own scope's parent is the
// verified hierarchy (`app.slice` of this user's manager).
function placeOf(rt: Runtime, d: DomainRow, incarnation: string): string | null {
  if (rt.scope === null) return 'this engine has no scope, so the hierarchy cannot be verified';
  if (d.cgroup_path === null) return 'the domain has no recorded cgroup';
  const v = verifyDomainPath(d.cgroup_path, { parent: dirname(rt.scope.path), home: rt.home, domain: d.id, incarnation });
  return v.where === 'inside' ? null : `the recorded path is outside the verified hierarchy: ${v.detail}`;
}

export interface TerminateArgs {
  rt: Runtime;
  d: DomainRow;
  incarnation: string; // the incarnation that owned the domain
  handle: RunHandle | undefined;
  // An unknown established before (a prior supervisor leaf that could not be
  // closed; recovery); the domain is not terminated.
  knownUnknown?: string | null;
  // At a quarantine's re-observation (each tick): observe only, signal
  // nothing (D2 §3.4).
  observeOnly?: boolean;
}

// Steps 1 to 5 for one domain.
export async function terminateDomain(args: TerminateArgs): Promise<Verdict> {
  const { rt, d, handle } = args;
  const launch: SandboxLaunch | null = handle && handle.claim.domain === d.id ? (handle.sandbox ?? null) : null;
  // 1. Closure, before anything else (B13). This engine's own launch is
  // taken no further from here.
  if (launch) launch.closed = true;
  await rt.engine('domain.close', { domain: d.id, cause: args.observeOnly ? 'observation' : 'termination' });
  const unknown = async (why: string): Promise<Verdict> => {
    await rt.engine('domain.observed', { domain: d.id, observation: 'unknown', detail: why }).catch((err) => log('domain observation', err, { domain: d.id }));
    return { terminated: false, unknown: why };
  };
  if (args.knownUnknown) return unknown(args.knownUnknown);
  // 2. The launcher.
  if (launch && !args.observeOnly) {
    if (seamMainFault('launcher_wait')) return unknown("the launcher's exit could not be established (injected fault)");
    if (launch.alive && launch.placedPid === null) await launch.killUnplaced();
  }
  const where = placeOf(rt, d, args.incarnation);
  if (where !== null) return unknown(where);
  const unreachable = await manager();
  if (unreachable !== null) return unknown(unreachable);
  const path = d.cgroup_path!;

  const graceMs = rt.setting('terminate_grace') * 1000;
  const killMs = rt.setting('kill_grace') * 1000;
  // Had the backend's exit been reported before the engine began to cancel?
  const startedBackend = handle?.backendStarted === true && launch !== null;
  const exitedBefore = launch?.exitReport !== null && launch?.exitReport !== undefined;
  let termSent = false;
  let killWritten = false;
  const start = performance.now();
  const empty = (): 'empty' | 'populated' | 'absent' | string => {
    const p = readPopulated(path);
    if (p.state === 'absent') return 'absent';
    if (p.state === 'unreadable') return p.detail;
    return p.value === 0 ? 'empty' : 'populated';
  };

  if (!args.observeOnly) {
    // 3. TERM through the init, or to the members from the host.
    let state = empty();
    if (state === 'populated') {
      if (!(launch?.term() ?? false)) for (const pid of readProcs(path) ?? []) signal(pid, 'SIGTERM');
      termSent = true;
      while (performance.now() - start < graceMs) {
        state = empty();
        if (state !== 'populated') break;
        await sleep(100);
      }
    }
    // 4. cgroup.kill, whatever the grace period left (a member that is
    // unreadable is no reason to stop signalling).
    if (state === 'populated' || (state !== 'empty' && state !== 'absent')) {
      const k = writeKill(path);
      if (k.state === 'refused') return unknown(`cgroup.kill was refused: ${k.detail}`);
      killWritten = k.state === 'written';
      const killed = performance.now();
      while (performance.now() - killed < killMs) {
        state = empty();
        if (state !== 'populated') break;
        await sleep(50);
      }
    }
  }

  // 5. Observe.
  const final = readPopulated(path);
  const observedAt = nowIso();
  if (final.state === 'unreadable') return unknown(`cgroup.events cannot be read: ${final.detail}`);
  if (final.state === 'populated' && final.value === 1) {
    if (args.observeOnly) {
      await rt.engine('domain.observed', { domain: d.id, observation: 'running', detail: 'populated 1' }).catch(() => {});
      return { terminated: false, unknown: null };
    }
    return unknown(`populated 1 persists after kill_grace (${killMs / 1000} s)`);
  }
  if (final.state === 'populated') {
    const inode = cgroupInode(path);
    if (d.cgroup_inode !== null && inode !== d.cgroup_inode) return unknown(`${path} is not the cgroup the engine created for the domain (another directory is there)`);
  } else {
    // Absent: absence counts only in the verified hierarchy, which must be
    // readable (D2 §3.3).
    const scopes = homeScopes(dirname(dirname(path)), rt.home);
    if (scopes === null) return unknown(`${dirname(dirname(path))} cannot be read, so the domain's absence is not established`);
  }
  if (!args.observeOnly && launch && launch.alive && launch.placedPid === null) return unknown("the launcher is outstanding and is not a member");
  await pausePoint('boundary.before_terminated');
  const read = final.state === 'populated' ? counters(path) : null;
  const resources = read && (read.oom_kill !== null || read.pids_max !== null) ? read : {};
  const report = launch?.exitReport ?? null;
  const exit = classifyExit({
    report,
    cancelledBeforeExit: startedBackend && (termSent || killWritten) && !exitedBefore,
    termSent,
    killWritten,
    resources,
    cleanResult: handle?.result?.valid === true,
  });
  // What is known of how the backend ended: from this engine's launch, or,
  // for a domain another incarnation launched, only that its exit report
  // never reached this engine (`unknown`, D2 §1.6).
  if (startedBackend || (!launch && d.launch_binding !== null)) await rt.engine('domain.exit', { domain: d.id, ...exit });
  await rt.engine('domain.terminated', {
    domain: d.id,
    observed: true,
    observedAt,
    evidence: { populated: 0, absent: final.state === 'absent', term_sent: termSent, kill_written: killWritten, cgroup_path: path },
  });
  // The directory goes after the record; nothing recreates it, since its
  // launch is closed (D2 §3.2).
  if (final.state === 'populated') removeCgroup(path);
  // The probe profile's sibling goes with its domain (SEAM.md §127).
  const sibling = join(dirname(path), `sibling_${d.id}`);
  if (readPopulated(sibling).state !== 'absent') {
    writeKill(sibling);
    removeCgroup(sibling);
  }
  // The domain's area under the engine home (its context package and the
  // setup stage's two mountpoints, empty on the host) goes with it.
  try {
    rmSync(join(rt.home, 'domains', d.id), { recursive: true, force: true });
  } catch (err) {
    log('domain area', err, { domain: d.id });
  }
  return { terminated: true };
}

// One member, by its host pid as the verified domain's cgroup.procs listed it:
// never 0, 1, a negative pid or the engine itself.
function signal(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, sig);
  } catch {
    // gone meanwhile
  }
}

// D2 §3.3: at startup recovery, after every non-terminated domain is closed,
// the `supervisor` leaf of every prior incarnation of this home whose scope
// exists is killed and observed `populated 0`, or the scope's absence is
// established in the verified hierarchy. Returns, per prior incarnation, why
// its domains are `unknown` (absent from the map: closed).
export async function closePriorSupervisors(rt: Runtime, recorded: { incarnation: string; scope_cgroup: string }[]): Promise<Map<string, string>> {
  const unknown = new Map<string, string>();
  const scopes = new Map<string, string>();
  for (const r of recorded) scopes.set(r.incarnation, r.scope_cgroup);
  const parent = rt.scope ? dirname(rt.scope.path) : null;
  if (parent !== null) {
    for (const [inc, path] of homeScopes(parent, rt.home) ?? new Map<string, string>()) if (inc !== rt.incarnation && !scopes.has(inc)) scopes.set(inc, path);
  }
  const unreachable = await manager();
  for (const [inc, path] of scopes) {
    if (inc === rt.incarnation) continue;
    if (parent === null) {
      unknown.set(inc, 'this engine has no scope, so the prior incarnation\'s scope cannot be verified');
      continue;
    }
    if (unreachable !== null) {
      unknown.set(inc, unreachable);
      continue;
    }
    if (!isHomeScope(path, { parent, home: rt.home, incarnation: inc })) {
      unknown.set(inc, `the prior scope ${path} is not this home's scope for ${inc} in the verified hierarchy`);
      continue;
    }
    const scopeState = readPopulated(path);
    if (scopeState.state === 'absent') {
      const listing = homeScopes(parent, rt.home);
      if (listing === null) unknown.set(inc, `${parent} cannot be read, so the prior scope's absence is not established`);
      continue;
    }
    const leaf = join(path, SUPERVISOR_LEAF);
    const before = readPopulated(leaf);
    if (before.state === 'absent') continue;
    if (before.state === 'unreadable') {
      unknown.set(inc, `the prior supervisor leaf cannot be read: ${before.detail}`);
      continue;
    }
    const k = writeKill(leaf);
    if (k.state === 'refused') {
      unknown.set(inc, `the prior supervisor leaf cannot be killed: ${k.detail}`);
      continue;
    }
    const until = performance.now() + rt.setting('kill_grace') * 1000;
    let after = readPopulated(leaf);
    while (after.state === 'populated' && after.value === 1 && performance.now() < until) {
      await sleep(50);
      after = readPopulated(leaf);
    }
    if (after.state === 'unreadable') unknown.set(inc, `the prior supervisor leaf cannot be read: ${after.detail}`);
    else if (after.state === 'populated' && after.value === 1) unknown.set(inc, 'the prior supervisor leaf is still populated after kill_grace');
  }
  return unknown;
}
