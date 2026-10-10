// The engine's side of a service domain (D4 §§3.4, 5.2, 9.2; J2, J8; E110):
// the launch socket, each service launcher's and init's channel on it, the
// per-domain ingress socket, and the service link a post-deploy check
// reaches its target through. Main thread.
//
// The launch socket, `$SURETY_HOME/run/launch.sock`, is the one way a
// service launcher reaches the engine: the user's service manager connects
// the unit's standard input and output to it (adapters/local-service.ts),
// so the launcher talks on its standard streams as D2's launcher does, and
// the domain init it becomes the parent of keeps the same connection as its
// control channel. On it, in order:
//   1. the launcher's `hello` (attempt, domain, incarnation, lease
//      generation, its pid and cgroup): checked against the store and read
//      on the host (its pid the unit's MainPID, its cgroup the unit's own
//      ControlGroup, E121 item 4; the limits read back from the cgroup
//      files) and recorded as the domain's placement; then `spec`, or
//      `refused` and nothing more;
//   2. the init's `authorize` with its host pid and start time, before
//      anything of the application exists: checked on the host (a child of
//      the launcher, innermost NSpid 1, in the unit's cgroup, that start
//      time) and granted once, in one transaction (D4 §9.2), or refused;
//   3. the setup stage's plan, the init stage's backend, `start`;
//   4. the init's `started` report, resolved on the host to the one member
//      of the unit's cgroup whose innermost NSpid it names and whose parent
//      is the recorded init: the original application instance, recorded
//      once; a disagreement binds nothing (§3.4 step 3);
//   5. the application's exit, as the init reports it.
// The channel is never reopened: a connection lost is a supervision lost.
//
// Ingress (D4 §5.2): the engine listens on `<runtime dir>/in.sock`, bound
// read-only into the service domain; to open a tunnel it sends the init a
// nonce on the control channel, the init dials the ingress socket with it
// and carries the connection to the application's port. A post-deploy
// check reaches the service through its own link socket, which relays each
// connection to a tunnel of the generation frozen on the execution, and to
// nothing else.
//
// Removal sites here: the launch socket at start and at stop (its exact
// path, only a socket); a service domain's runtime directory and a link
// socket, each only at the path the store recorded for this engine home,
// checked by its real path and its name.

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { cgroupInode } from '../boundary/cgroup.js';
import { INIT_SCRIPT } from '../invoke/sandboxed.js';
import { engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from '../invoke/sandbox/tools.js';
import { heldSecret } from '../records/redact.js';
import { type Runtime, log } from '../runtime.js';
import { seamTakeDeployFault } from '../testing/seam.js';
import { exeSha, innerPid, membersNamed, procStat, cgroupOf, cmdlineOf } from './identity.js';
import { showUnits } from './adapters/local-service.js';
import { APP_DIR, INGRESS_SOCKET, buildServicePlan } from './service-profile.js';

type Msg = Record<string, unknown>;
type Lookup = {
  attempt: string;
  operation: string;
  project: string;
  status: string;
  launch_state: string | null;
  incarnation: string | null;
  generation: number | null;
  environment: string;
  prefix: string;
  unit: string | null;
  lease: { generation: number } | null;
  lease_expected: number;
  domain: { id: string; status: string; launch_state: string; cgroup_path: string | null; unit: string | null; invocation_id: string | null; runtime_dir: string | null } | null;
  init_instance: { pid: number; start_time: number } | null;
  artifact: { digest: string | null; path: string | null };
  runtime: { path: string; sha256: string } | null;
  start: string[] | null;
  port: number | null;
  env: Record<string, string>;
  secrets: Record<string, string>;
  limits: { memory_max: number; memory_swap_max: number; pids_max: number; writable_bytes: number; writable_inodes: number; log_max_bytes: number };
};

const RUN_NAME = /^env_[0-9A-HJKMNP-TV-Z]{26}-g[1-9][0-9]*$/;
const LINK_NAME = /^env_[0-9A-HJKMNP-TV-Z]{26}-g[1-9][0-9]*-link-[0-9a-z]{10}\.sock$/;

export const launchSocketPath = (home: string): string => join(home, 'run', 'launch.sock');

// A line channel on a socket: one JSON object per line.
class Channel {
  private readonly queue: Msg[] = [];
  private waiter: ((m: Msg | null) => void) | null = null;
  closed = false;
  onMessage: ((m: Msg) => void) | null = null;

  constructor(readonly socket: net.Socket) {
    socket.on('error', () => {});
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let m: Msg;
      try {
        m = JSON.parse(line) as Msg;
      } catch {
        return;
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(m);
      } else if (this.onMessage) this.onMessage(m);
      else this.queue.push(m);
    });
    lines.on('close', () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(null);
      }
    });
  }

  next(timeoutMs = 120_000): Promise<Msg | null> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  send(m: Msg): void {
    if (this.closed) return;
    try {
      this.socket.write(`${JSON.stringify(m)}\n`);
    } catch {
      this.closed = true;
    }
  }

  end(): void {
    this.closed = true;
    this.socket.end();
  }
}

interface Service {
  attempt: string;
  domain: string;
  environment: string;
  generation: number;
  runtimeDir: string;
  ingress: net.Server | null;
  channel: Channel | null;
  pending: Map<string, (s: net.Socket | null) => void>;
  links: Set<net.Server>;
  open: Set<net.Socket>;
}

const readInt = (path: string): number | 'max' | null => {
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (t === 'max') return 'max';
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
};

export class ServiceHost {
  private server: net.Server | null = null;
  private readonly services = new Map<string, Service>();

  constructor(private readonly rt: Runtime) {}

  // A path of this engine home's runtime directory, checked by its real path.
  private ownRun(path: string, pattern: RegExp): string | null {
    try {
      const base = realpathSync(join(this.rt.home, 'run'));
      const real = realpathSync(path);
      const rel = relative(base, real);
      if (rel === '' || rel.includes(sep) || rel.startsWith('..') || !pattern.test(rel)) return null;
      return real;
    } catch {
      return null;
    }
  }

  // At start (before full mode, after recovery closed every earlier launch).
  async start(): Promise<void> {
    const run = join(this.rt.home, 'run');
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const path = launchSocketPath(this.rt.home);
    try {
      if (lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // none
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        void this.serve(new Channel(socket)).catch((err) => log('service launch', err));
      });
      server.once('error', reject);
      server.listen(path, () => {
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    for (const s of this.services.values()) {
      s.ingress?.close();
      for (const l of s.links) l.close();
    }
    try {
      const path = launchSocketPath(this.rt.home);
      if (lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // gone
    }
  }

  // The runtime directory and the ingress socket of a service domain, made
  // before its unit is created, at the path the store recorded.
  async prepare(args: { attempt: string; domain: string; environment: string; generation: number; runtimeDir: string }): Promise<void> {
    const name = args.runtimeDir.slice(args.runtimeDir.lastIndexOf('/') + 1);
    if (!RUN_NAME.test(name) || args.runtimeDir !== join(this.rt.home, 'run', name)) throw new Error(`refused: ${args.runtimeDir} is not a runtime directory of this engine home`);
    mkdirSync(join(args.runtimeDir, 'root'), { recursive: true, mode: 0o700 });
    mkdirSync(join(args.runtimeDir, 'vol'), { recursive: true, mode: 0o700 });
    const s: Service = { attempt: args.attempt, domain: args.domain, environment: args.environment, generation: args.generation, runtimeDir: args.runtimeDir, ingress: null, channel: null, pending: new Map(), links: new Set(), open: new Set() };
    const sock = join(args.runtimeDir, 'in.sock');
    try {
      if (lstatSync(sock).isSocket()) unlinkSync(sock);
    } catch {
      // none
    }
    s.ingress = await new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer((c) => this.ingress(s, c));
      server.once('error', reject);
      server.listen(sock, () => resolve(server));
    });
    this.services.set(args.attempt, s);
  }

  private ingress(s: Service, c: net.Socket): void {
    c.on('error', () => c.destroy());
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => c.destroy(), 10_000);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl < 0) {
        if (head.length > 64) c.destroy();
        return;
      }
      c.off('data', onData);
      clearTimeout(timer);
      const id = head.subarray(0, nl).toString('utf8');
      const rest = head.subarray(nl + 1);
      const resolve = s.pending.get(id);
      if (!resolve) return void c.destroy();
      s.pending.delete(id);
      if (rest.length > 0) c.unshift(rest);
      resolve(c);
    };
    c.on('data', onData);
  }

  // A tunnel to the application of `attempt`: the init asked to dial the
  // ingress socket with a nonce, within `timeoutMs`. null: none.
  openTunnel(attempt: string, timeoutMs: number): Promise<net.Socket | null> {
    const s = this.services.get(attempt);
    if (!s || !s.channel || s.channel.closed) return Promise.resolve(null);
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      s.pending.set(id, (sock) => {
        clearTimeout(timer);
        resolve(sock);
      });
      s.channel!.send({ t: 'tunnel', id });
    });
  }

  // The service link of a post-deploy check (D4 §5.2; J8): a socket under
  // $SURETY_HOME/run/ named for the environment and the frozen generation,
  // relaying each connection to that generation's application and to nothing
  // else. Closed by the returned function, which removes the socket.
  async startLink(args: { attempt: string; environment: string; generation: number; checkDomain: string; connectTimeoutMs: number }): Promise<{ path: string; close: () => void }> {
    const name = `${args.environment}-g${args.generation}-link-${args.checkDomain.slice(-10).toLowerCase()}.sock`;
    const path = join(this.rt.home, 'run', name);
    mkdirSync(join(this.rt.home, 'run'), { recursive: true, mode: 0o700 });
    const s = this.services.get(args.attempt);
    const open = new Set<net.Socket>();
    const server = await new Promise<net.Server>((resolve, reject) => {
      const srv = net.createServer((client) => {
        client.on('error', () => client.destroy());
        open.add(client);
        client.on('close', () => open.delete(client));
        client.pause();
        void this.openTunnel(args.attempt, args.connectTimeoutMs).then((up) => {
          if (up === null || client.destroyed) {
            up?.destroy();
            client.destroy();
            return;
          }
          open.add(up);
          s?.open.add(up);
          up.on('error', () => up.destroy());
          up.on('close', () => {
            open.delete(up);
            s?.open.delete(up);
            client.destroy();
          });
          client.on('close', () => up.destroy());
          client.pipe(up);
          up.pipe(client);
          client.resume();
        });
      });
      srv.once('error', reject);
      srv.listen(path, () => resolve(srv));
    });
    s?.links.add(server);
    const close = () => {
      server.close();
      s?.links.delete(server);
      for (const c of open) c.destroy();
      const real = this.ownRun(path, LINK_NAME);
      if (real !== null) rmSync(real, { force: true });
    };
    return { path, close };
  }

  // The engine's TERM to a service's init (D2 §3.2), when its channel stands.
  term(attempt: string): boolean {
    const s = this.services.get(attempt);
    if (!s?.channel || s.channel.closed) return false;
    s.channel.send({ t: 'term' });
    return true;
  }

  attached(attempt: string): boolean {
    const s = this.services.get(attempt);
    return s?.channel !== null && s?.channel !== undefined && !s.channel.closed;
  }

  // A service domain whose closure was observed: its ingress closed, and its
  // runtime directory removed at the path the store recorded.
  dispose(args: { attempt: string; runtimeDir: string | null }): void {
    const s = this.services.get(args.attempt);
    if (s) {
      s.ingress?.close();
      for (const l of s.links) l.close();
      for (const c of s.open) c.destroy();
      s.channel?.end();
      this.services.delete(args.attempt);
    }
    if (args.runtimeDir !== null) {
      const real = this.ownRun(args.runtimeDir, RUN_NAME);
      if (real !== null) rmSync(real, { recursive: true, force: true });
    }
  }

  // ---- one connection to the launch socket ------------------------------------------------

  private async serve(ch: Channel): Promise<void> {
    const refuse = (why: string) => {
      log('service launch', new Error(`refused: ${why}`));
      ch.send({ t: 'refused', reason: why });
      ch.end();
    };
    const hello = await ch.next(30_000);
    if (!hello || hello.t !== 'hello' || hello.profile !== 'service') return refuse('no hello');
    const attempt = String(hello.attempt ?? '');
    const lk = await this.rt.read<Lookup | null>('deploy.launch_lookup', { attempt });
    if (!lk || !lk.domain || !lk.unit) return refuse('no such attempt');
    // Checked first in the store (cheaply), then on the host.
    if (hello.incarnation !== this.rt.incarnation || lk.incarnation !== this.rt.incarnation) return refuse('not this incarnation');
    if (lk.status !== 'started' || lk.launch_state !== 'authorizable' || lk.domain.launch_state !== 'authorizable') return refuse(`the launch is ${lk.launch_state}`);
    if (lk.domain.id !== hello.domain) return refuse("not the attempt's domain");
    if (!lk.lease || lk.lease.generation !== hello.lease_generation) return refuse('the lease generation is not current');
    const pid = Number(hello.pid);
    const [unit] = (await showUnits([lk.unit], { home: this.rt.home, env: lk.environment, timeoutMs: this.rt.config.values.adapter_read_deadline * 1000 })) ?? [];
    if (!unit || unit.LoadState !== 'loaded' || !unit.ControlGroup) return refuse('the unit is not loaded');
    const cgroup = join('/sys/fs/cgroup', unit.ControlGroup);
    if (Number(unit.MainPID) !== pid) return refuse("the launcher is not the unit's MainPID");
    if (hello.cgroup !== cgroup || cgroupOf(pid) !== cgroup || !cgroup.endsWith(`/${lk.unit}`)) return refuse("the launcher is not in the unit's own cgroup");
    // The limits read back before anything is authorized (D4 §9.2).
    const limits = { memory_max: readInt(join(cgroup, 'memory.max')), memory_swap_max: readInt(join(cgroup, 'memory.swap.max')), pids_max: readInt(join(cgroup, 'pids.max')) };
    if (limits.memory_max !== lk.limits.memory_max || limits.memory_swap_max !== 0 || limits.pids_max !== lk.limits.pids_max) return refuse(`the unit's limits read back as ${JSON.stringify(limits)}`);
    const placed = await this.rt.engine<{ placed: boolean; reason: string | null }>('deploy.launcher_placed', {
      attempt,
      domain: lk.domain.id,
      incarnation: this.rt.incarnation,
      lease_generation: hello.lease_generation,
      pid,
      cgroup,
      inode: cgroupInode(cgroup),
      invocation_id: unit.InvocationID ?? '',
      unit: lk.unit,
    });
    if (!placed.placed) return refuse(placed.reason ?? 'not placed');
    const tools = await resolveSandboxTools();
    if (!tools.paths.unshare) return refuse('unshare is not installed');
    ch.send({ t: 'spec', unshare: tools.paths.unshare, node: engineNode(), init: INIT_SCRIPT });

    // The init's authorization, before anything of the application exists.
    const asked = await ch.next(60_000);
    if (!asked || asked.t !== 'authorize') return refuse('no authorization asked');
    const init = asked.init as { pid?: unknown; start_time?: unknown } | undefined;
    const ipid = Number(init?.pid);
    const istart = Number(init?.start_time);
    const st = Number.isInteger(ipid) && ipid > 1 ? procStat(ipid) : null;
    if (!st || st.ppid !== pid || innerPid(ipid) !== 1 || st.start_time !== istart || cgroupOf(ipid) !== cgroup) return refuse('the init is not the launcher\'s child with innermost NSpid 1 in the unit\'s cgroup, at that start time');
    const grant = await this.rt.engine<{ granted: boolean; reason?: string }>('deploy.launch_authorize', {
      attempt,
      incarnation: this.rt.incarnation,
      lease_generation: hello.lease_generation,
      init: { pid: ipid, start_time: istart },
      limits,
    });
    if (!grant.granted) return refuse(grant.reason ?? 'not granted');
    let s = this.services.get(attempt);
    if (!s) {
      // Prepared by an effect of this incarnation; otherwise nothing serves it.
      return refuse('no runtime directory was prepared for the attempt');
    }
    s.channel = ch;
    ch.send({ t: 'granted' });
    await this.drive(ch, s, lk, { pid: ipid, start_time: istart }, cgroup);
  }

  private async drive(ch: Channel, s: Service, lk: Lookup, init: { pid: number; start_time: number }, cgroup: string): Promise<void> {
    const tools = await resolveSandboxTools();
    const t = tools.paths;
    const copy = await initNodeCopy(this.rt.home);
    ch.onMessage = (m) => {
      void this.onMessage(ch, s, lk, init, cgroup, m, { t, copy }).catch((err) => log('service channel', err, { attempt: s.attempt }));
    };
    // Anything queued meanwhile.
    for (;;) {
      const m = await ch.next(1);
      if (!m) break;
      await this.onMessage(ch, s, lk, init, cgroup, m, { t, copy });
    }
  }

  private async onMessage(ch: Channel, s: Service, lk: Lookup, init: { pid: number; start_time: number }, cgroup: string, m: Msg, x: { t: Record<string, string | undefined>; copy: string }): Promise<void> {
    switch (m.t) {
      case 'hello':
        if (m.stage === 'setup') {
          const area = realpathSync(s.runtimeDir);
          const plan = buildServicePlan({
            area,
            sealed: lk.artifact.path!,
            runtime: lk.runtime!.path,
            ingress: join(area, 'in.sock'),
            volBytes: lk.limits.writable_bytes,
            volInodes: lk.limits.writable_inodes,
            tools: { mount: x.t.mount!, umount: x.t.umount!, pivot_root: x.t.pivot_root!, ip: x.t.ip!, unshare: x.t.unshare!, setpriv: x.t.setpriv!, ...(x.t.mknod ? { mknod: x.t.mknod } : {}) },
            node: engineNode(),
            initNodeCopy: await initNodeIn(area, x.copy),
            initScript: INIT_SCRIPT,
          });
          ch.send({ t: 'plan', plan });
        } else if (m.stage === 'init') {
          const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/surety/home', TMPDIR: '/tmp', ...lk.env };
          for (const [name, ref] of Object.entries(lk.secrets)) {
            const value = heldSecret(ref);
            if (value !== null) env[name] = value;
          }
          if (lk.port !== null) env.PORT = String(lk.port);
          ch.send({ t: 'backend', backend: { argv: lk.start, env, cwd: APP_DIR, stdin: null, service: { port: lk.port, ingress: INGRESS_SOCKET, logMax: lk.limits.log_max_bytes } } });
        }
        return;
      case 'ready':
        ch.send({ t: 'start' });
        return;
      case 'setup_failed':
      case 'start_failed':
        log('service launch', new Error(`${String(m.t)}: ${String(m.detail ?? '').slice(0, 300)}`), { attempt: s.attempt });
        return;
      case 'started': {
        let nsPid = Number(m.pid);
        const reported = m.start_time === null || m.start_time === undefined ? null : Number(m.start_time);
        if (seamTakeDeployFault(lk.environment, 'init_report_altered')) nsPid = 1;
        const found = Number.isInteger(nsPid) ? await membersNamed(cgroup, nsPid, init.pid) : [];
        const host = found.length === 1 ? found[0]! : null;
        const hostStart = host !== null ? (procStat(host)?.start_time ?? null) : null;
        if (host === null || hostStart === null || (reported !== null && reported !== hostStart)) {
          await this.rt.engine('deploy.app_disagreement', { attempt: s.attempt, detail: { reported: { pid: nsPid, start_time: reported }, host: { members: found, start_time: hostStart } } });
          return;
        }
        const exe = lk.runtime?.path ?? '';
        await this.rt.engine('deploy.app_started', { attempt: s.attempt, app: { pid: host, start_time: hostStart, exe, exe_sha256: await exeSha(host), argv: cmdlineOf(host) ?? [] } });
        return;
      }
      case 'exit':
        await this.rt.engine('deploy.app_exited', { attempt: s.attempt, exit: { at: typeof m.at === 'string' ? m.at : new Date().toISOString(), code: typeof m.code === 'number' ? m.code : null, signal: typeof m.signal === 'number' ? m.signal : null } });
        return;
      default:
        return;
    }
  }
}

export const runtimeDirExists = (path: string | null): boolean => path !== null && existsSync(path);
