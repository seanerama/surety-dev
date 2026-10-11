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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { cgroupInode } from '../boundary/cgroup.js';
import { INIT_SCRIPT } from '../invoke/sandboxed.js';
import { engineNode, initNodeCopy, initNodeIn, resolveSandboxTools } from '../invoke/sandbox/tools.js';
import { heldSecret } from '../records/redact.js';
import { type Runtime, log } from '../runtime.js';
import { pausePoint, seamLauncherBarriers, seamLauncherReached, seamTakeDeployFault } from '../testing/seam.js';
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
  onClose: (() => void) | null = null;

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
      this.onClose?.();
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

  // The engine's own end closed at once, as a lost connection is: what the
  // channel's loss does follows now (the harness fault
  // `control_channel_dropped`, SEAM.md §277).
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose?.();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
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
  links: Set<ServiceLink>;
  open: Set<net.Socket>;
  // Ended by the engine itself (closure observed): its channel's close is
  // not a lost supervision.
  disposed: boolean;
}

// The limits of a post-deploy check's service link (D4 §5.2, A.7), and the
// bound of its log (D2's egress log bound, the slice-25 design Q8).
export interface LinkLimits {
  connectTimeoutMs: number;
  tunnelMaxMs: number;
  tunnelsMax: number;
  bufferMaxBytes: number;
  logMaxBytes: number;
}

type LinkBinding = { execution: string; round: string; operation: string; attempt: string; generation: number; instance: { pid: number; start_time: number } | null };

// One entry of a link's `service_link_log` record (SEAM.md §268), one per
// connection the link received, in order.
interface LinkEntry extends LinkBinding {
  decision: 'accepted' | 'refused';
  reason: string | null;
  limit: { key: string; value: number } | null;
  opened_at: string;
  closed_at: string | null;
  ended: string | null;
  bytes_up: number;
  bytes_down: number;
}

// A post-deploy check's service link (D4 §5.2; J8): the socket it is bound
// to, every connection's entry, and how it closes.
export interface ServiceLink {
  path: string;
  close(): void;
  // The JSON lines of its log, redacted by the caller; `truncated` when the
  // log reached its bound.
  entries(): LinkEntry[];
  truncated(): boolean;
  // Every open tunnel closed; the link keeps refusing new connections.
  dropTunnels(): void;
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
  private stopping = false;
  // Attempts whose control channel this incarnation saw close and whose loss
  // is not yet durable (the review's m4).
  private readonly lost = new Set<string>();

  // The loss written to the store, retried a few times now; until it is
  // written, `lossRecorded` says no and no round of the attempt is decided.
  private async recordLoss(attempt: string): Promise<boolean> {
    for (let i = 0; i < 5 && this.lost.has(attempt); i++) {
      try {
        await this.rt.engine('deploy.supervision_lost', { attempt, why: 'the control channel closed' });
        this.lost.delete(attempt);
        return true;
      } catch (err) {
        log('service channel', err, { attempt, try: i + 1 });
        await new Promise((r) => setTimeout(r, 200 * (i + 1)).unref?.());
      }
    }
    return !this.lost.has(attempt);
  }

  // Whether every channel loss of the attempt this incarnation saw is
  // durable now (one still pending is written again here).
  async lossRecorded(attempt: string): Promise<boolean> {
    if (!this.lost.has(attempt)) return true;
    return this.recordLoss(attempt);
  }

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
    // An earlier incarnation's link sockets: a link lives in the engine that
    // opened it, so after a restart nothing listens on any of them. Each is
    // removed at its own path in this home's run directory, by its name and
    // its real path, and only if it is a socket (the inventory would
    // otherwise list it for ever, D4 §2.4).
    for (const name of readdirSync(run)) {
      if (!LINK_NAME.test(name)) continue;
      const real = this.ownRun(join(run, name), LINK_NAME);
      try {
        if (real !== null && lstatSync(real).isSocket()) rmSync(real, { force: true });
      } catch {
        // gone meanwhile
      }
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
    this.stopping = true;
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
    const s: Service = { attempt: args.attempt, domain: args.domain, environment: args.environment, generation: args.generation, runtimeDir: args.runtimeDir, ingress: null, channel: null, pending: new Map(), links: new Set(), open: new Set(), disposed: false };
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
      if (!resolve) {
        // No tunnel the engine asked for: whatever connected (the service's
        // own code can see this socket) reaches nothing (D4 §5.2).
        log('service ingress', new Error('a connection with no pending tunnel was refused'), { attempt: s.attempt });
        return void c.destroy();
      }
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
  // relaying each connection to that generation's application and to
  // nothing else. Each connection is checked in the store first (the
  // generation still current, its domain launched, its supervision
  // attached), holds one of `service_link_tunnels_max`, is refused past
  // `service_link_connect_timeout`, closed past
  // `service_link_tunnel_max_seconds` or when more than
  // `service_link_buffer_max_bytes` wait in either direction, and is
  // written to the link's log; the log's bound refuses every later
  // connection, unlogged, and calls `onLogBound`. A tunnel is never
  // retargeted: the attempt is fixed. `close` removes the socket.
  async startLink(args: { execution: string; attempt: string; environment: string; generation: number; checkDomain: string; limits: LinkLimits; onLogBound?: () => void }): Promise<ServiceLink> {
    const name = `${args.environment}-g${args.generation}-link-${args.checkDomain.slice(-10).toLowerCase()}.sock`;
    const path = join(this.rt.home, 'run', name);
    mkdirSync(join(this.rt.home, 'run'), { recursive: true, mode: 0o700 });
    const limits = args.limits;
    const first = await this.rt.read<{ ok: boolean; reason: string | null; binding: LinkBinding | null }>('deploy.link_target', { execution: args.execution });
    const binding: LinkBinding = first.binding ?? { execution: args.execution, round: '', operation: '', attempt: args.attempt, generation: args.generation, instance: null };
    const entries: LinkEntry[] = [];
    let logBytes = 0;
    let truncated = false;
    let active = 0;
    const open = new Set<net.Socket>();
    const closers = new Set<() => void>();
    const entry = (decision: LinkEntry['decision'], reason: string | null, limit: LinkEntry['limit'] = null): LinkEntry | null => {
      const e: LinkEntry = { ...binding, decision, reason, limit, opened_at: new Date().toISOString(), closed_at: null, ended: decision === 'refused' ? 'refused' : null, bytes_up: 0, bytes_down: 0 };
      // Room for the entry as it will be written once closed.
      const size = Buffer.byteLength(`${JSON.stringify({ ...e, closed_at: e.opened_at, ended: 'tunnel_max_seconds', bytes_up: 1e12, bytes_down: 1e12 })}\n`);
      if (truncated || logBytes + size > limits.logMaxBytes) {
        if (!truncated) {
          truncated = true;
          log('service link', new Error(`the link's log reached egress_log_max_bytes (${limits.logMaxBytes} bytes): every later connection is refused`), { execution: args.execution });
          args.onLogBound?.();
        }
        return null;
      }
      logBytes += size;
      entries.push(e);
      return e;
    };
    const refuse = (client: net.Socket, reason: string, limit: LinkEntry['limit'] = null) => {
      entry('refused', reason, limit);
      client.destroy();
    };
    const server = await new Promise<net.Server>((resolve, reject) => {
      const srv = net.createServer((client) => {
        client.on('error', () => client.destroy());
        client.pause();
        if (truncated) return void client.destroy();
        if (active >= limits.tunnelsMax) return refuse(client, 'tunnels_max', { key: 'service_link_tunnels_max', value: limits.tunnelsMax });
        // The slot is held from the moment the connection is accepted.
        active++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          active--;
        };
        open.add(client);
        client.on('close', () => {
          open.delete(client);
          release();
        });
        void (async () => {
          const now = await this.rt.read<{ ok: boolean; reason: string | null }>('deploy.link_target', { execution: args.execution }).catch(() => ({ ok: false, reason: 'unread' }));
          if (client.destroyed) return release();
          if (!now.ok) return refuse(client, now.reason ?? 'refused');
          const s = this.services.get(args.attempt);
          if (!s || !s.channel || s.channel.closed) return refuse(client, 'no_service');
          const up = await this.openTunnel(args.attempt, limits.connectTimeoutMs);
          if (up === null) return refuse(client, 'connect_timeout', { key: 'service_link_connect_timeout', value: limits.connectTimeoutMs / 1000 });
          if (client.destroyed) {
            up.destroy();
            return;
          }
          const e = entry('accepted', null);
          if (e === null) {
            up.destroy();
            client.destroy();
            return;
          }
          open.add(up);
          s.open.add(up);
          let closed = false;
          const close = (ended: string, limit: LinkEntry['limit'] = null) => {
            if (closed) return;
            closed = true;
            clearTimeout(lifetime);
            closers.delete(stop);
            e.closed_at = new Date().toISOString();
            e.ended = ended;
            if (limit) e.limit = limit;
            client.destroy();
            up.destroy();
            open.delete(up);
            s.open.delete(up);
          };
          const stop = () => close('link_closed');
          closers.add(stop);
          const lifetime = setTimeout(() => close('tunnel_max_seconds', { key: 'service_link_tunnel_max_seconds', value: limits.tunnelMaxMs / 1000 }), limits.tunnelMaxMs);
          lifetime.unref?.();
          const buffer = { key: 'service_link_buffer_max_bytes', value: limits.bufferMaxBytes };
          client.on('data', (chunk: Buffer) => {
            e.bytes_up += chunk.length;
            up.write(chunk);
            if (up.writableLength > limits.bufferMaxBytes) close('buffer_max', buffer);
          });
          up.on('data', (chunk: Buffer) => {
            e.bytes_down += chunk.length;
            client.write(chunk);
            if (client.writableLength > limits.bufferMaxBytes) close('buffer_max', buffer);
          });
          client.on('end', () => up.end());
          up.on('end', () => client.end());
          client.on('close', () => close('closed'));
          up.on('close', () => close('closed'));
          up.on('error', () => close('closed'));
          client.on('error', () => close('closed'));
          client.resume();
        })().catch((err) => {
          log('service link', err, { execution: args.execution });
          client.destroy();
        });
      });
      srv.once('error', reject);
      srv.listen(path, () => resolve(srv));
    });
    let closed = false;
    const link: ServiceLink = {
      path,
      close: () => {
        if (closed) return;
        closed = true;
        server.close();
        this.services.get(args.attempt)?.links.delete(link);
        for (const c of [...closers]) c();
        for (const c of open) c.destroy();
        const real = this.ownRun(path, LINK_NAME);
        if (real !== null) rmSync(real, { force: true });
      },
      entries: () => entries,
      truncated: () => truncated,
      dropTunnels: () => {
        for (const c of [...closers]) c();
      },
    };
    this.services.get(args.attempt)?.links.add(link);
    return link;
  }

  // The engine's TERM to a service's init (D2 §3.2), when its channel stands.
  term(attempt: string): boolean {
    const s = this.services.get(attempt);
    if (!s?.channel || s.channel.closed) return false;
    s.channel.send({ t: 'term' });
    return true;
  }

  // The harness fault `control_channel_dropped` (SEAM.md §277): the engine
  // closes its own end of the attempt's control channel, as a lost
  // connection; the service goes on, its supervision `unknown`.
  dropChannel(attempt: string): void {
    const s = this.services.get(attempt);
    if (s?.channel && !s.channel.closed) s.channel.drop();
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
      s.disposed = true;
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
    // Every secret the configuration names must be held, or nothing is
    // launched (the slice-24 review, m7): a service is never started
    // without a value its configuration names.
    const unheld = Object.values(lk.secrets).filter((ref) => heldSecret(ref) === null);
    if (unheld.length > 0) return refuse(`the secrets ${unheld.join(', ')} are not held by this engine`);
    const pid = Number(hello.pid);
    const [unit] = (await showUnits([lk.unit], { home: this.rt.home, env: lk.environment, timeoutMs: this.rt.config.values.adapter_read_deadline * 1000 })) ?? [];
    if (!unit || unit.LoadState !== 'loaded' || !unit.ControlGroup) return refuse('the unit is not loaded');
    // Its invocation is what positive ownership is later checked by (D4 §4.6):
    // none read, no grant (the slice-24 review, m1).
    if (!unit.InvocationID || !/^[0-9a-f]{32}$/.test(unit.InvocationID)) return refuse("the unit's InvocationID could not be read");
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
      invocation_id: unit.InvocationID,
      unit: lk.unit,
    });
    if (!placed.placed) return refuse(placed.reason ?? 'not placed');
    const tools = await resolveSandboxTools();
    if (!tools.paths.unshare) return refuse('unshare is not installed');
    // D2's launcher barriers, for a service launcher too (SEAM.md §274), and
    // the harness fault `service_setup_refused` (SEAM.md §277): harness only.
    const w = seamLauncherBarriers(this.rt.home);
    const refuseSetup = seamTakeDeployFault(lk.environment, 'service_setup_refused');
    ch.send({
      t: 'spec',
      unshare: tools.paths.unshare,
      node: engineNode(),
      init: INIT_SCRIPT,
      ...(w && Object.keys(w.barriers).length > 0 ? { waits: w.barriers, releaseDir: w.releaseDir } : {}),
      ...(refuseSetup ? { refuse_setup: true } : {}),
    });

    // The init's authorization, before anything of the application exists.
    // A launcher waiting at a barrier says so first; its wait may be long.
    let asked = await ch.next(60_000);
    while (asked && asked.t === 'wait') {
      seamLauncherReached(String(asked.name), String(asked.action));
      asked = await ch.next(3_600_000);
    }
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
    // The control channel is never reopened (D4 §9.2): lost, in this
    // incarnation, its service's supervision is `unknown` from then on, and
    // every tunnel to it closes now (E110, E116).
    ch.onClose = () => {
      for (const l of [...s.links]) l.dropTunnels();
      for (const c of s.open) c.destroy();
      if (s.disposed || this.stopping) return;
      this.lost.add(s.attempt);
      void this.recordLoss(s.attempt);
    };
    await pausePoint('deploy.launch_granted');
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
            if (value === null) {
              // Checked at the launcher's hello; gone since: nothing starts.
              log('service launch', new Error(`refused: the secret ${ref} is not held`), { attempt: s.attempt });
              ch.send({ t: 'term' });
              ch.end();
              return;
            }
            env[name] = value;
          }
          if (lk.port !== null) env.PORT = String(lk.port);
          // The harness fault `service_exec_failed` (SEAM.md §277): the start
          // command names a program that does not exist, so its exec fails.
          const argv = seamTakeDeployFault(lk.environment, 'service_exec_failed') ? [`${APP_DIR}/.surety-exec-failed`, ...(lk.start ?? []).slice(1)] : lk.start;
          ch.send({ t: 'backend', backend: { argv, env, cwd: APP_DIR, stdin: null, service: { port: lk.port, ingress: INGRESS_SOCKET, logMax: lk.limits.log_max_bytes } } });
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
        await pausePoint('init.app_started');
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
        await this.rt.engine('deploy.app_exited', {
          attempt: s.attempt,
          exit: { at: typeof m.at === 'string' ? m.at : new Date().toISOString(), code: typeof m.code === 'number' ? m.code : null, signal: typeof m.signal === 'number' ? m.signal : null, external_term: m.external_term === true },
        });
        return;
      default:
        return;
    }
  }
}

export const runtimeDirExists = (path: string | null): boolean => path !== null && existsSync(path);
