// The `local_service` adapter (D4 §§2, 9; Appendix B; J2; E110; E121 item 4;
// BS4 §§4.1, 5): a disposable service on this host, in a transient unit of
// the user's service manager, run by D2's launcher with the `service`
// profile. The only code in the engine that starts `systemd-run` or
// `systemctl`, both with `--user`, resolved to absolute paths from the
// system directories, with an argument array and never a shell, a
// constructed environment (the bus address from the engine's own), an output
// bound and a deadline per call. No transaction is held across a call.
//
// The guard (BS4 §4.1 rule 5; D4 §§2.2, 9.5). Every unit name a call takes is
// checked here before any host call: it must be `surety-<h>-<env>-g<n>.service`
// with `<h>` derived from this engine's own home (never taken from the store
// alone), `<env>` the environment's id, and, for an effect, present in the
// attempt's frozen intent. A unit is stopped or reset only by its exact name
// and only when the manager reports for it the cgroup and the invocation the
// engine recorded for that unit's own domain; otherwise it is left alone and
// listed. `cgroup.kill` is written only to such a recorded domain cgroup.
// Listing units and jobs by the environment's exact prefix is a read: it
// grants nothing.
//
// The host calls (BS4 §4.1 rule 6), each bounded by `adapter_effect_deadline`
// for an effect and `adapter_read_deadline` for a read, through `host()`:
//   systemd-run --user … --unit=<exact name> …            create (deploy)
//   systemctl --user stop --no-ask-password -- <exact>     stop (deploy's prior, teardown)
//   systemctl --user reset-failed -- <exact>               after that stop, if failed
//   systemctl --user show --property=… -- <exact names>    read
//   systemctl --user list-units --all … -- '<prefix>*'     read (inventory)
//   systemctl --user list-jobs … -- '<prefix>*'            read (pending jobs)
// Signals: only to this adapter's own spawned children, by their handles,
// at their deadline or output bound (the `signal` option of spawn).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { nowMs } from '../../clock.js';
import { readPopulated } from '../../boundary/cgroup.js';
import { type Runtime, log } from '../../runtime.js';
import { seamTakeDeployFault } from '../../testing/seam.js';
import type { AdapterReadFailure, AttemptIntent, DeployCapability, DeploymentAdapter, EffectReceipt, EnvRef, IdentityRead, InventoryEntry, LogTail, OperationIntent, Reconciliation, TargetExpectation, TargetStatus, TeardownCapability } from '../adapter.js';
import { AdapterUnavailable } from '../adapter.js';
import { readIdentity, type UnitState, procStat } from '../identity.js';
import type { ServiceHost } from '../service-host.js';
import { launchSocketPath } from '../service-host.js';
import { LAUNCHER_SCRIPT } from '../../invoke/sandboxed.js';

const SYSTEM_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const UNIT_NAME = new RegExp(`^surety-[0-9a-f]{12}-env_${ULID}-g[1-9][0-9]*\\.service$`);
const ENV_ID = new RegExp(`^env_${ULID}$`);
// A service unit's cgroup under the user manager: the unit's own directory.
const SERVICE_CGROUP = new RegExp(`^/sys/fs/cgroup/(?:[A-Za-z0-9@._-]+/)+surety-[0-9a-f]{12}-env_${ULID}-g[1-9][0-9]*\\.service$`);
export const SHOW_PROPS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'InvocationID', 'MainPID', 'ControlGroup'];

export const homeHash12 = (home: string): string => createHash('sha256').update(home).digest('hex').slice(0, 12);
export const unitPrefix = (home: string, env: string): string => `surety-${homeHash12(home)}-${env}-`;
export const generationOf = (unit: string): number | null => {
  const m = /-g([1-9][0-9]*)\.service$/.exec(unit);
  return m ? Number(m[1]) : null;
};

// The guard: null when `name` may be named by a call for environment `env`
// of this home (and, when `permitted` is given, is one of those names);
// otherwise why not.
export function ownUnit(home: string, env: string, name: string, permitted?: readonly string[]): string | null {
  if (typeof name !== 'string' || !UNIT_NAME.test(name)) return `${JSON.stringify(name)} is not a unit name the engine derives`;
  if (!ENV_ID.test(env)) return `${JSON.stringify(env)} is not an environment id`;
  if (!name.startsWith(unitPrefix(home, env))) return `${name} does not carry this home's prefix for ${env}`;
  if (permitted !== undefined && !permitted.includes(name)) return `${name} is not named in the attempt's frozen intent`;
  return null;
}

export function hostTool(name: 'systemctl' | 'systemd-run'): string | null {
  for (const dir of SYSTEM_DIRS) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// The environment of a call to the user manager: the bus address from the
// engine's own environment, and nothing else.
function managerEnv(): Record<string, string> | null {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!runtime && !bus) return null;
  return { PATH: SYSTEM_DIRS.join(':'), LANG: 'C.UTF-8', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0', ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}), ...(bus ? { DBUS_SESSION_BUS_ADDRESS: bus } : {}) };
}

type HostResult = { ok: true; code: number; stdout: string; stderr: string } | { ok: false; failure: AdapterReadFailure; detail: string };

// One host call: an argument array, the constructed environment, a deadline
// and an output bound. Never throws.
function host(tool: 'systemctl' | 'systemd-run', args: string[], opts: { timeoutMs: number; outputBytes: number; signal?: AbortSignal | undefined }): Promise<HostResult> {
  const path = hostTool(tool);
  const env = managerEnv();
  if (path === null) return Promise.resolve({ ok: false, failure: 'unavailable', detail: `${tool} is not installed` });
  if (env === null) return Promise.resolve({ ok: false, failure: 'unavailable', detail: 'the user manager is not reachable (XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset)' });
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, failure: 'deadline', detail: 'the call passed its deadline before it started' });
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    let out = '';
    let err = '';
    let bytes = 0;
    let why: AdapterReadFailure | null = null;
    const child = spawn(path, args, { env, stdio: ['ignore', 'pipe', 'pipe'], signal: ctl.signal, killSignal: 'SIGKILL' });
    const timer = setTimeout(() => {
      why = 'deadline';
      ctl.abort();
    }, Math.max(1, opts.timeoutMs));
    const take = (chunk: Buffer, into: 'out' | 'err') => {
      bytes += chunk.length;
      if (bytes > opts.outputBytes) {
        why = 'output_exceeded';
        ctl.abort();
        return;
      }
      if (into === 'out') out += chunk.toString('utf8');
      else err += chunk.toString('utf8');
    };
    child.stdout.on('data', (c: Buffer) => take(c, 'out'));
    child.stderr.on('data', (c: Buffer) => take(c, 'err'));
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR') return;
      resolve({ ok: false, failure: 'unavailable', detail: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (why !== null || opts.signal?.aborted) return resolve({ ok: false, failure: why ?? 'deadline', detail: `${tool} ${args[1] ?? ''}: ${why ?? 'deadline'}` });
      resolve({ ok: true, code: code ?? -1, stdout: out, stderr: err });
    });
  });
}

const OUTPUT_DEFAULT = 1_048_576;

// `systemctl --user show` of exact unit names, of this home's prefix for
// `env`: one {property: value} per name, in order; null when the manager
// could not be read (unread, never "absent").
export async function showUnits(names: string[], opts: { home: string; env: string; timeoutMs: number; outputBytes?: number; signal?: AbortSignal | undefined }): Promise<Record<string, string>[] | null> {
  if (names.length === 0) return [];
  for (const n of names) if (ownUnit(opts.home, opts.env, n) !== null) throw new Error(`refused to read ${n}: ${ownUnit(opts.home, opts.env, n)}`);
  const r = await host('systemctl', ['--user', 'show', `--property=${SHOW_PROPS.join(',')}`, '--', ...names], { timeoutMs: opts.timeoutMs, outputBytes: opts.outputBytes ?? OUTPUT_DEFAULT, signal: opts.signal });
  if (!r.ok || r.code !== 0) return null;
  const blocks = r.stdout.split(/\n\s*\n/).filter((b) => b.trim() !== '');
  const out = blocks.map((b) => {
    const o: Record<string, string> = {};
    for (const line of b.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) o[line.slice(0, at)] = line.slice(at + 1);
    }
    return o;
  });
  // Each block names its unit: matched by Id, never by position alone.
  const byId = names.map((n) => out.find((o) => o.Id === n));
  if (byId.some((o) => o === undefined)) return null;
  return byId as Record<string, string>[];
}

const unitState = (o: Record<string, string> | undefined): UnitState | null =>
  o === undefined
    ? null
    : {
        loaded: o.LoadState === 'loaded',
        active: o.ActiveState === 'active',
        invocationId: o.InvocationID || null,
        mainPid: Number(o.MainPID) || null,
        cgroup: o.ControlGroup ? join('/sys/fs/cgroup', o.ControlGroup) : null,
      };

// `cgroup.kill` (kernel 5.14) on a recorded service domain's cgroup only:
// the path recorded for that domain, the manager's cgroup for its exact unit,
// of the service-unit form under the user manager, the same directory
// (inode) the engine recorded. Writing it is not termination; only a later
// absence or `populated 0` is.
export function writeServiceKill(path: string, guard: { unit: string; recorded: string; inode: number | null }): 'written' | 'absent' | string {
  if (path !== guard.recorded || !SERVICE_CGROUP.test(path) || path.split('/').includes('..') || !path.endsWith(`/${guard.unit}`)) return `${path} is not the recorded cgroup of ${guard.unit}`;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return 'absent';
  }
  if (real !== path) return `${path} is not its own real path`;
  if (guard.inode !== null && statSync(path).ino !== guard.inode) return `${path} is another creation of the directory than the one recorded`;
  try {
    writeFileSync(join(path, 'cgroup.kill'), '1');
    return 'written';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : `${path}/cgroup.kill: ${(err as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

interface Resource {
  domain: string;
  unit: string | null;
  cgroup_path: string | null;
  cgroup_inode: number | null;
  invocation_id: string | null;
  runtime_dir: string | null;
  status: string;
  attempt: string;
  generation: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LocalService implements DeploymentAdapter {
  readonly id = 'local_service';
  readonly version = '1';
  readonly reach = 'service_link' as const;
  readonly identityMethod = 'tree_digest';

  constructor(
    private readonly rt: Runtime,
    private readonly services: ServiceHost,
  ) {}

  private get readMs(): number {
    return this.rt.config.values.adapter_read_deadline * 1000;
  }
  private get outputBytes(): number {
    return this.rt.config.values.adapter_output_max_bytes;
  }

  private resources(env: string): Promise<Resource[]> {
    return this.rt.read<Resource[]>('deploy.environment_resources', { environment: env });
  }

  private show(env: string, names: string[], signal?: AbortSignal): Promise<Record<string, string>[] | null> {
    return showUnits(names, { home: this.rt.home, env, timeoutMs: this.readMs, outputBytes: this.outputBytes, signal });
  }

  // A unit's domain is positively owned when its recorded cgroup and
  // invocation are what the manager reports for its exact name (D4 §4.6).
  // Both the recorded cgroup and the recorded invocation are required (the
  // slice-24 review, m1). A unit loaded `failed` or `inactive` has no
  // ControlGroup: it is owned by its recorded invocation alone, and only
  // while its recorded cgroup is gone (m5), so it can be reset by exact name.
  private owned(show: Record<string, string>, r: Resource | undefined): r is Resource {
    if (!r || r.cgroup_path === null || r.invocation_id === null || r.invocation_id === '') return false;
    if (show.InvocationID !== r.invocation_id) return false;
    if (show.ControlGroup) return join('/sys/fs/cgroup', show.ControlGroup) === r.cgroup_path;
    return (show.ActiveState === 'failed' || show.ActiveState === 'inactive') && readPopulated(r.cgroup_path).state === 'absent';
  }

  // Stop one positively owned unit and observe its domain's closure (D2
  // §3.2; D4 §§4.6, 9.3): TERM through its init while attached, the stop by
  // exact name, `cgroup.kill` on its recorded cgroup if anything is left,
  // its failed state reset, then its closure recorded and its runtime
  // directory removed. `steps` records what was done; false: uncertain.
  private async stopOwned(env: string, unit: string, r: Resource, deadline: number, step: (s: string, d: string) => void, signal: AbortSignal): Promise<boolean> {
    if (this.services.term(r.attempt)) step('term', `TERM through the init of ${unit}`);
    const left = () => Math.max(1000, deadline - nowMs());
    const stop = await host('systemctl', ['--user', 'stop', '--no-ask-password', '--', unit], { timeoutMs: left(), outputBytes: this.outputBytes, signal });
    step('stop', stop.ok ? `systemctl stop ${unit}: exit ${stop.code}` : `systemctl stop ${unit}: ${stop.failure}`);
    const grace = this.rt.setting('kill_grace') * 1000;
    const closed = async (): Promise<boolean | null> => {
      const until = performance.now() + grace;
      for (;;) {
        const p = readPopulated(r.cgroup_path!);
        if (p.state === 'absent' || (p.state === 'populated' && p.value === 0)) return true;
        if (p.state === 'unreadable') return null;
        if (performance.now() > until || signal.aborted) return false;
        await sleep(50);
      }
    };
    let done = await closed();
    if (done === false) {
      const k = writeServiceKill(r.cgroup_path!, { unit, recorded: r.cgroup_path!, inode: r.cgroup_inode });
      step('cgroup.kill', `${r.cgroup_path}: ${k}`);
      done = await closed();
    }
    const after = await this.show(env, [unit], signal);
    const s = after?.[0];
    if (s && s.LoadState === 'loaded' && s.ActiveState === 'failed') {
      const reset = await host('systemctl', ['--user', 'reset-failed', '--', unit], { timeoutMs: left(), outputBytes: this.outputBytes, signal });
      step('reset-failed', reset.ok ? `exit ${reset.code}` : reset.failure);
    }
    if (done === true) {
      await this.rt.engine('deploy.domain_closed', { domain: r.domain, observed: `the cgroup of ${unit} is gone or empty after its stop` });
      this.services.dispose({ attempt: r.attempt, runtimeDir: r.runtime_dir });
      step('closed', `${unit}: closure observed`);
      return true;
    }
    step('closed', `${unit}: closure not observed (${done === null ? 'unreadable' : 'still populated'})`);
    return false;
  }

  async deploy(cap: DeployCapability, signal: AbortSignal): Promise<EffectReceipt> {
    const steps: EffectReceipt['steps'] = [];
    const step = (s: string, d: string) => steps.push({ at: new Date().toISOString(), step: s, detail: d });
    const deadline = nowMs() + this.rt.config.values.adapter_effect_deadline * 1000;
    const unit = cap.create_units[0];
    // The guard: every name, before any host call.
    for (const u of [...cap.create_units, ...cap.prior.map((p) => p.unit)]) {
      const why = ownUnit(this.rt.home, cap.environment, u, [...cap.create_units, ...cap.prior.map((p) => p.unit)]);
      if (why !== null) {
        step('guard', why);
        return { result: 'refused', steps };
      }
    }
    if (unit === undefined || cap.create_units.length !== 1) {
      step('guard', 'one unit per attempt (one target, X2)');
      return { result: 'refused', steps };
    }
    if (hostTool('systemd-run') === null || hostTool('systemctl') === null || managerEnv() === null) {
      step('host', 'systemd-run, systemctl or the user manager is not reachable');
      return { result: 'not_issued', steps };
    }
    const resources = await this.resources(cap.environment);
    const mine = resources.find((r) => r.unit === unit && r.attempt === cap.attempt);
    if (!mine || mine.runtime_dir === null) {
      step('domain', `no service domain of attempt ${cap.attempt} is recorded for ${unit}`);
      return { result: 'refused', steps };
    }
    const now = await this.show(cap.environment, [unit, ...cap.prior.map((p) => p.unit)], signal);
    if (now === null) {
      step('show', 'the user manager could not be read');
      return { result: 'not_issued', steps };
    }
    if (now[0]!.LoadState !== 'not-found') {
      step('show', `${unit} exists already (${now[0]!.LoadState} ${now[0]!.ActiveState}): a name in use is refused`);
      return { result: 'refused', steps };
    }
    // The prior instances the intent replaces: stopped only when positively owned.
    let changed = false;
    for (const [i, p] of cap.prior.entries()) {
      const s = now[i + 1]!;
      if (s.LoadState === 'not-found') {
        step('prior', `${p.unit} is not loaded`);
        continue;
      }
      const r = resources.find((x) => x.unit === p.unit);
      if (!this.owned(s, r)) {
        step('prior', `${p.unit} is not positively owned (cgroup or invocation not the recorded ones): left alone`);
        return { result: changed ? 'uncertain' : 'refused', steps };
      }
      if (s.ActiveState === 'inactive' && readPopulated(r.cgroup_path!).state === 'absent') {
        step('prior', `${p.unit} is inactive`);
        continue;
      }
      changed = true;
      if (!(await this.stopOwned(cap.environment, p.unit, r, deadline, step, signal))) return { result: 'uncertain', steps };
    }
    // The runtime directory and the ingress socket, at the recorded path.
    try {
      await this.services.prepare({ attempt: cap.attempt, domain: mine.domain, environment: cap.environment, generation: cap.generation, runtimeDir: mine.runtime_dir });
      step('runtime', mine.runtime_dir);
    } catch (err) {
      step('runtime', (err as Error).message);
      return { result: changed ? 'uncertain' : 'not_issued', steps };
    }
    const lk = await this.rt.read<{ limits: { memory_max: number; pids_max: number }; lease_expected: number; domain: { id: string } | null } | null>('deploy.launch_lookup', { attempt: cap.attempt });
    if (!lk || !lk.domain) return { result: 'uncertain', steps };
    const sock = launchSocketPath(this.rt.home);
    const node = realpathSync(process.execPath);
    const launcher = realpathSync(LAUNCHER_SCRIPT);
    const args = [
      '--user',
      '--no-ask-password',
      '--quiet',
      `--unit=${unit}`,
      `--description=surety deployment ${cap.environment} g${cap.generation}`,
      '--service-type=exec',
      '--working-directory=/',
      '--setenv=NODE_OPTIONS=',
      '--property=Delegate=yes',
      '--property=Restart=no',
      `--property=MemoryMax=${lk.limits.memory_max}`,
      '--property=MemorySwapMax=0',
      `--property=TasksMax=${lk.limits.pids_max}`,
      '--property=KillMode=control-group',
      `--property=TimeoutStopSec=${this.rt.setting('kill_grace')}s`,
      `--property=StandardInput=file:${sock}`,
      `--property=StandardOutput=file:${sock}`,
      '--property=StandardError=null',
      '--',
      node,
      '--no-warnings',
      launcher,
      'service',
      cap.attempt,
      lk.domain.id,
      cap.incarnation,
      String(cap.lease_generation),
    ];
    const made = await host('systemd-run', args, { timeoutMs: Math.max(1000, deadline - nowMs()), outputBytes: this.outputBytes, signal });
    step('systemd-run', made.ok ? `exit ${made.code}${made.stderr ? `: ${made.stderr.trim().slice(0, 300)}` : ''}` : made.failure);
    if (!made.ok || made.code !== 0) return { result: 'uncertain', steps };
    // Wait, within the deadline, for the launch granted and the application
    // started (or the launch's end).
    for (;;) {
      if (signal.aborted) return { result: 'uncertain', steps };
      const a = await this.rt.read<{ init_instance: unknown; app_instance: unknown; launch_state: string | null } | null>('deploy.launch_lookup', { attempt: cap.attempt });
      const detail = await this.rt.read<{ attempts: { id: string; app_disagreement: unknown; app_instance: unknown }[] } | null>('deploy.detail', { operation: cap.operation });
      const att = detail?.attempts.find((x) => x.id === cap.attempt);
      if (att && (att.app_instance !== null || att.app_disagreement !== null)) {
        step('started', att.app_instance !== null ? 'the application instance is recorded' : "the init's report and the host read disagree");
        return { result: 'issued', steps };
      }
      const s = (await this.show(cap.environment, [unit], signal))?.[0];
      if (s && s.ActiveState !== 'active' && s.ActiveState !== 'activating') {
        step('unit', `${unit} is ${s.LoadState} ${s.ActiveState} (${s.Result ?? ''}) before the application was recorded; launch ${a?.launch_state ?? 'unread'}`);
        return { result: 'issued', steps };
      }
      if (nowMs() > deadline) return { result: 'uncertain', steps };
      await sleep(200);
    }
  }

  async teardown(cap: TeardownCapability, signal: AbortSignal): Promise<EffectReceipt> {
    const steps: EffectReceipt['steps'] = [];
    const step = (s: string, d: string) => steps.push({ at: new Date().toISOString(), step: s, detail: d });
    const deadline = nowMs() + this.rt.config.values.adapter_effect_deadline * 1000;
    for (const u of cap.stop_units) {
      const why = ownUnit(this.rt.home, cap.environment, u, cap.stop_units);
      if (why !== null) {
        step('guard', why);
        return { result: 'refused', steps };
      }
    }
    if (hostTool('systemctl') === null || managerEnv() === null) {
      step('host', 'systemctl or the user manager is not reachable');
      return { result: 'not_issued', steps };
    }
    const resources = await this.resources(cap.environment);
    const shows = await this.show(cap.environment, cap.stop_units, signal);
    if (shows === null) {
      step('show', 'the user manager could not be read');
      return { result: 'not_issued', steps };
    }
    let uncertain = false;
    for (const [i, u] of cap.stop_units.entries()) {
      const s = shows[i]!;
      const r = resources.find((x) => x.unit === u);
      if (s.LoadState === 'not-found') {
        step('unit', `${u} is not loaded`);
        continue;
      }
      if (!this.owned(s, r)) {
        // Left alone and running: whether the teardown took effect is for
        // reconcile to say (the slice-24 review, m6).
        step('left', `${u}: not positively owned (cgroup or invocation not the recorded ones); left alone`);
        uncertain = true;
        continue;
      }
      if (!(await this.stopOwned(cap.environment, u, r, deadline, step, signal))) uncertain = true;
    }
    // What is left of the environment's recorded domains whose closure was
    // observed: their runtime directories and link sockets.
    for (const r of await this.resources(cap.environment)) {
      if (r.unit === null) continue;
      const s = (await this.show(cap.environment, [r.unit], signal))?.[0];
      if (!s || s.LoadState !== 'not-found') continue;
      const gone = r.cgroup_path === null || readPopulated(r.cgroup_path).state === 'absent';
      if (!gone) continue;
      if (r.status !== 'terminated') await this.rt.engine('deploy.domain_closed', { domain: r.domain, observed: `${r.unit} is not loaded and its cgroup is gone` });
      this.services.dispose({ attempt: r.attempt, runtimeDir: r.runtime_dir });
    }
    return { result: uncertain ? 'uncertain' : 'issued', steps };
  }

  async reconcile(op: OperationIntent, attempt: AttemptIntent, signal: AbortSignal): Promise<Reconciliation> {
    const env = op.environment;
    const prefix = unitPrefix(this.rt.home, env);
    const incomplete = (): Reconciliation => ({ outcome: 'unknown', complete: false, inventory: [], reads: [], identity: [] });
    if (prefix !== op.prefix) return incomplete();
    const listed = await host('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', '--full', '--', `${prefix}*`], { timeoutMs: this.readMs, outputBytes: this.outputBytes, signal });
    const jobs = await host('systemctl', ['--user', 'list-jobs', '--plain', '--no-legend', '--no-pager', '--full', '--', `${prefix}*`], { timeoutMs: this.readMs, outputBytes: this.outputBytes, signal });
    if (!listed.ok || listed.code !== 0 || !jobs.ok || jobs.code !== 0) return incomplete();
    const listedUnits = listed.stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((u) => u.startsWith(prefix) && u.endsWith('.service'));
    const jobUnits = new Set(
      jobs.stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[1] ?? '')
        .filter((u) => u.startsWith(prefix)),
    );
    const unitNames = [...new Set([...listedUnits, ...attempt.recorded_units, ...attempt.create_units, ...attempt.prior.map((p) => p.unit), ...attempt.stop_units])].filter((u) => ownUnit(this.rt.home, env, u) === null);
    // A unit carrying the prefix that is no name the engine derives is still
    // the environment's: listed, unreadable as an owned unit.
    const strangers = listedUnits.filter((u) => ownUnit(this.rt.home, env, u) !== null);
    const shows = await this.show(env, unitNames, signal);
    if (shows === null) return incomplete();
    const inventory: InventoryEntry[] = strangers.map((u) => ({ resource: u, kind: 'unit', recorded: false, state: 'unread', pendingJob: 'unread' }));
    const identity: IdentityRead[] = [];
    const g = new Set(attempt.create_units);
    for (const [i, name] of unitNames.entries()) {
      const s = shows[i]!;
      if (s.LoadState === 'not-found') continue;
      const entry: InventoryEntry = {
        resource: name,
        kind: 'unit',
        recorded: attempt.recorded_units.includes(name),
        state: s.ActiveState || 'unread',
        pendingJob: jobUnits.has(name),
        generation: generationOf(name),
        invocation_id: s.InvocationID || null,
      };
      if (s.ActiveState === 'active' && g.has(name) && op.kind === 'deploy') {
        const expect = (attempt.expect ?? []).find((e) => e.unit === name);
        if (expect && expect.instance) {
          const read = await readIdentity({ expect, readUnit: async () => unitState((await this.show(env, [name], signal))?.[0]), signal });
          identity.push(read);
          entry.instance = read.instance === 'unread' ? 'unread' : { pid: read.instance.pid, start_time: read.instance.start_time };
          entry.tree = read.match === 'match' ? read.read : read.match === 'unread' ? 'unread' : `differs:${read.detail?.field ?? 'tree'}`;
        } else {
          entry.instance = 'unread';
          entry.tree = 'unread';
        }
      } else if (s.ActiveState === 'active') {
        const p = attempt.prior.find((x) => x.unit === name);
        if (p?.instance) {
          const now = procStat(p.instance.pid);
          entry.instance = now && now.start_time === p.instance.start_time ? p.instance : 'unread';
        }
      }
      inventory.push(entry);
    }
    // The store's recorded resources (D4 §2.4): domain cgroups, ingress and
    // link sockets, runtime directories.
    let complete = true;
    for (const r of await this.resources(env)) {
      if (r.cgroup_path !== null && r.status !== 'terminated') {
        const p = readPopulated(r.cgroup_path);
        if (p.state === 'unreadable') {
          complete = false;
          inventory.push({ resource: r.cgroup_path, kind: 'cgroup', recorded: true, state: 'unread', pendingJob: false, generation: r.generation });
        } else if (p.state === 'populated' && p.value === 1) inventory.push({ resource: r.cgroup_path, kind: 'cgroup', recorded: true, state: 'populated', pendingJob: false, generation: r.generation });
      }
      if (r.runtime_dir !== null && existsSync(r.runtime_dir)) {
        inventory.push({ resource: r.runtime_dir, kind: 'directory', recorded: true, state: 'present', pendingJob: false, generation: r.generation });
        if (existsSync(join(r.runtime_dir, 'in.sock'))) inventory.push({ resource: join(r.runtime_dir, 'in.sock'), kind: 'socket', recorded: true, state: 'present', pendingJob: false, generation: r.generation });
      }
    }
    try {
      for (const name of readdirSync(join(this.rt.home, 'run'))) {
        const m = new RegExp(`^${env}-g([1-9][0-9]*)-link-[0-9a-z]{10}\\.sock$`).exec(name);
        if (m) inventory.push({ resource: join(this.rt.home, 'run', name), kind: 'socket', recorded: true, state: 'present', pendingJob: false, generation: Number(m[1]) });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    }
    return { outcome: 'unknown', complete, inventory, reads: [], identity };
  }

  async status(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<TargetStatus[]> {
    const names = expect.map((e) => e.unit).filter((u): u is string => typeof u === 'string');
    const shows = await this.show(env.environment, names, signal);
    if (shows === null) throw new AdapterUnavailable('unavailable');
    return expect.map((e) => {
      const s = e.unit ? shows[names.indexOf(e.unit)] : undefined;
      const alive = e.instance ? procStat(e.instance.pid)?.start_time === e.instance.start_time : false;
      return {
        target: e.target,
        unit: e.unit,
        active: s ? s.ActiveState === 'active' : 'unread',
        instance: e.instance && alive ? e.instance : 'unread',
        generation: e.generation ?? 'unread',
        supervision: e.attempt && this.services.attached(e.attempt) ? 'attached' : 'unknown',
        at: new Date().toISOString(),
      };
    });
  }

  async verify(env: EnvRef, expect: TargetExpectation[], signal: AbortSignal): Promise<IdentityRead[]> {
    // The seam's one-shot faults (SEAM.md §262), taken by this read.
    const faults = { startTimeSkew: seamTakeDeployFault(env.environment, 'identity_start_time'), procUnreadable: seamTakeDeployFault(env.environment, 'identity_proc_unreadable') };
    const out: IdentityRead[] = [];
    for (const x of expect) {
      const read = await readIdentity({
        expect: x,
        signal,
        faults,
        readUnit: async () => (x.unit ? unitState((await this.show(env.environment, [x.unit], signal))?.[0]) : null),
      });
      out.push(await this.otherGeneration(env.environment, x, read, signal));
    }
    return out;
  }

  // Another generation at the target (D4 §3.4: "another generation
  // `differs`"; the slice-25 design Q11): an active unit of the
  // environment's prefix other than the expected one is what answers there,
  // so the read differs, naming that generation. A read-only listing of the
  // exact prefix; a listing that cannot be made leaves the read as it was.
  private async otherGeneration(env: string, x: TargetExpectation, read: IdentityRead, signal: AbortSignal): Promise<IdentityRead> {
    const prefix = unitPrefix(this.rt.home, env);
    if (x.unit === null || !x.unit.startsWith(prefix)) return read;
    const listed = await host('systemctl', ['--user', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', '--full', '--', `${prefix}*`], { timeoutMs: this.readMs, outputBytes: this.outputBytes, signal });
    if (!listed.ok || listed.code !== 0) return read;
    const other = listed.stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => (f[0] ?? '').startsWith(prefix) && (f[0] ?? '').endsWith('.service') && f[0] !== x.unit && f[2] === 'active')
      .map((f) => f[0]!)
      .find((u) => ownUnit(this.rt.home, env, u) === null);
    if (other === undefined) return read;
    const generation = generationOf(other);
    return { ...read, match: 'differs', generation: generation ?? 'unread', detail: { field: 'generation', expected: x.generation, read: generation ?? other } };
  }

  async logs(_env: EnvRef, _target: string, _maxBytes: number, _signal: AbortSignal): Promise<LogTail> {
    // The collection command is slice 27's (D4 §6.1).
    throw new AdapterUnavailable('unavailable');
  }
}

export const isServiceCgroup = (path: string): boolean => SERVICE_CGROUP.test(path);
export const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
void log;
