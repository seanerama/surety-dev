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
// check reaches the service through its own link socket,
// `$SURETY_HOME/run/lk-<environment tail>-g<generation>-<check domain
// tail>.sock`, which relays each connection to a tunnel of the generation
// frozen on the execution, and to nothing else.
//
// Every socket here is bound at a path checked against what a unix socket
// address holds (socket-path.ts; objection 055): the engine start refuses a
// home whose paths would pass it, and no path is ever bound cut.
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
import { assertSocketPath } from '../socket-path.js';
import { pausePoint, seamLauncherBarriers, seamLauncherReached, seamTakeDeployFault } from '../testing/seam.js';
import { exeSha, innerPid, membersNamed, procStat, cgroupOf, cmdlineOf } from './identity.js';
import { showUnits } from './adapters/local-service.js';
import { APP_DIR, INGRESS_SOCKET, buildServicePlan, serviceEnvironment } from './service-profile.js';
import { previewServerPath } from '../design/preview/path.js';

type Msg = Record<string, unknown>;
type Lookup = {
  attempt: string;
  operation: string;
  project: string;
  preview: boolean;
  static: boolean;
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

// The service link's socket name (objection 055): short, so that it never
// governs the length of this home's socket paths (socket-path.ts), yet
// naming the environment (the last 8 characters of its id, the random tail
// of its ULID), the frozen generation and the check domain (its last 10), so
// the inventory can attribute it to an environment and a generation without
// reading the store, and the start sweep can tell it from anything else.
const LINK_NAME = /^lk-[0-9a-z]{8}-g[1-9][0-9]*-[0-9a-z]{10}\.sock$/;
export const linkSocketName = (environment: string, generation: number, checkDomain: string): string =>
  `lk-${environment.slice(-8).toLowerCase()}-g${generation}-${checkDomain.slice(-10).toLowerCase()}.sock`;
// The link sockets of one environment, with the generation captured.
export const linkNamesOf = (environment: string): RegExp => new RegExp(`^lk-${environment.slice(-8).toLowerCase()}-g([1-9][0-9]*)-[0-9a-z]{10}\\.sock$`);

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

interface Relay {
  environment: string;
  attempt: string;
  port: number;
  server: net.Server;
  open: Set<net.Socket>;
  closers: Set<() => void>;
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

// ---- the launch channel's peer (E127 item 7, m3; the driver's ruling) ----------------------
//
// Node offers no SO_PEERCRED, so a connection proves which process holds it
// by a challenge the kernel arbitrates: the engine sends a single-use random
// nonce on this connection, and the process the client named must write it
// to its own `/proc/self/comm`. Linux lets only a process's own threads set
// its name (a write to another's `comm` is EINVAL), and under Yama
// `ptrace_scope` >= 1 only its ancestors may ptrace it, so a client naming a
// pid it is not cannot answer. The named process's start time is read
// before and after the name, so a pid reused meanwhile proves nothing. The
// limit: a same-uid process allowed to ptrace the named one could forge the
// answer; it could read the engine's memory too (D2 §8 class C).

const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// 15 characters: the most a task's name holds (TASK_COMM_LEN 16 with its NUL).
export function launchNonce(): string {
  const bytes = randomBytes(15);
  return [...bytes].map((b) => NONCE_ALPHABET[b % NONCE_ALPHABET.length]).join('');
}

// Whether the process at `pid`, with the start time read before the
// challenge, shows `nonce` as its own name now and is still that process.
export function commAnswers(pid: number, startTime: number, nonce: string): boolean {
  let name: string;
  try {
    name = readFileSync(`/proc/${pid}/comm`, 'utf8').replace(/\n$/, '');
  } catch {
    return false;
  }
  return name === nonce && procStat(pid)?.start_time === startTime;
}

const PROOF_TIMEOUT_MS = 10_000;

// How long the adapter qualification may hold a refusal (holdRefusal).
const REFUSAL_HOLD_MS = 60_000;

export class ServiceHost {
  private server: net.Server | null = null;
  private readonly services = new Map<string, Service>();
  private stopping = false;
  // Attempts whose control channel this incarnation saw close and whose loss
  // is not yet durable (the review's m4).
  private readonly lost = new Set<string>();
  // Attempts whose launch connection proved its peer (one per attempt: a
  // second connection is refused once one has, E127 m3).
  private readonly proven = new Set<string>();
  // Collection reads asked of an init, by their id, until it answers.
  private readonly captures = new Map<string, (b: Buffer | null) => void>();
  // The operator relays open, by environment (D4 §5.2).
  private readonly relays = new Map<string, Relay>();
  // The adapter qualification's hold on a refusal (D4 §2.6 `late_launcher`
  // and `out_of_band`; deploy/qualify.ts): a launcher of the attempt that is
  // to be refused waits for its answer until the qualification has read the
  // unit while it is still loaded, then is refused as ever. Bounded: a hold
  // nobody releases lets the refusal go after REFUSAL_HOLD_MS.
  private readonly refusalHolds = new Map<string, { reached: (why: string) => void; released: Promise<void> }>();
  // The refusals sent, newest last (bounded): what a qualification case
  // reads of a launcher it expected refused.
  private readonly refusalLog: { attempt: string; reason: string; at: string }[] = [];

  // Hold the next refusal of a launcher of `attempt` (deploy/qualify.ts):
  // `reached` resolves with the refusal's reason once a launcher of it is
  // waiting to be refused; `release` lets the refusal go.
  // Only an attempt of a running qualification's own operation (the
  // slice-29 review, m6); null otherwise, and nothing is held.
  async holdRefusal(attempt: string): Promise<{ reached: Promise<string>; release: () => void } | null> {
    if (!(await this.rt.read<boolean>('qualify.attempt_running', { attempt }))) return null;
    let reached!: (why: string) => void;
    let release!: () => void;
    const r = new Promise<string>((res) => (reached = res));
    const released = new Promise<void>((res) => (release = res));
    this.refusalHolds.set(attempt, { reached, released });
    return {
      reached: r,
      release: () => {
        this.refusalHolds.delete(attempt);
        release();
      },
    };
  }

  // The refusals that mean a launch already spent or closed: a launch is
  // single-use (D4 §9.2).
  static readonly SPENT = ['a launch connection of this attempt has already proved its peer', 'the launch is authorized', 'the launch is closed'];

  refusalsOf(attempt: string): { reason: string; at: string }[] {
    return this.refusalLog.filter((r) => r.attempt === attempt).map(({ reason, at }) => ({ reason, at }));
  }

  // One challenge on `ch` to the process `pid` named (see launchNonce):
  // true only when that process, unchanged, shows the nonce as its name.
  private async prove(ch: Channel, pid: number): Promise<boolean> {
    const before = procStat(pid)?.start_time;
    if (before === undefined) return false;
    const nonce = launchNonce();
    ch.send({ t: 'prove', nonce });
    const answer = await ch.next(PROOF_TIMEOUT_MS);
    if (!answer || answer.t !== 'proved') return false;
    return commAnswers(pid, before, nonce);
  }

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
    // Never bound cut (objection 055): the start already refused a home whose
    // paths pass the limit; this stands behind it.
    const path = assertSocketPath(launchSocketPath(this.rt.home));
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
    // A relay lives in the engine that opened it (recorded closed at the
    // next start).
    for (const env of [...this.relays.keys()]) this.dropRelay(env);
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
    // Refused by name, never bound cut, when the generation's digits put the
    // path past what a socket address holds (objection 055).
    const sock = assertSocketPath(join(args.runtimeDir, 'in.sock'));
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
  // $SURETY_HOME/run/ named `lk-<environment tail>-g<generation>-<check
  // domain tail>.sock` (`linkSocketName`; objection 055), for the
  // environment and the frozen generation,
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
    const name = linkSocketName(args.environment, args.generation, args.checkDomain);
    // Refused by name, never bound cut (objection 055): the check that asked
    // for the link then ends with this as its reason.
    const path = assertSocketPath(join(this.rt.home, 'run', name));
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

  // The newest output of a service's capture, at most `max` bytes (D4 §§7.3,
  // 9.3): asked of its init on the control channel, in memory only. null
  // when the channel does not stand (supervision `unknown`: refused by the
  // caller before this) or no answer came within `timeoutMs`.
  readCapture(attempt: string, max: number, timeoutMs: number): Promise<Buffer | null> {
    const s = this.services.get(attempt);
    if (!s || !s.channel || s.channel.closed) return Promise.resolve(null);
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.captures.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.captures.set(id, (b) => {
        clearTimeout(timer);
        resolve(b !== null && b.length <= max ? b : null);
      });
      s.channel!.send({ t: 'logs', id, max });
    });
  }

  // ---- the operator relay (D4 §5.2; Q7; SEAM.md §317) ----------------------------------------
  //
  // Opened only by the owner's command, on 127.0.0.1 and the running
  // generation's configured port, to that generation's service and to
  // nothing else: every connection is checked in the store first (the relay
  // still open to that attempt, its service still the environment's running
  // one, supervised), takes one of `service_link_tunnels_max`, waits at most
  // `service_link_connect_timeout` for its tunnel, is closed past
  // `service_link_tunnel_max_seconds` or when more than
  // `service_link_buffer_max_bytes` wait in either direction. Its bytes are
  // the application's: it adds nothing, answers nothing itself, and reaches
  // no engine route, token or control channel. It is never retargeted: it
  // closes with its generation's domain, at a teardown, on command, when its
  // supervision is lost, and with the engine.

  // Bind the relay; 'in_use' when the port has another listener (untouched).
  async openRelay(args: { environment: string; attempt: string; generation: number | null; port: number; limits: Omit<LinkLimits, 'logMaxBytes'> }): Promise<'opened' | 'in_use'> {
    const existing = this.relays.get(args.environment);
    if (existing && existing.attempt === args.attempt && existing.port === args.port) return 'opened';
    // Another relay of the environment stays open until the new one is bound
    // (the slice-28 review, m2), unless it holds the very port: then it is
    // closed, and recorded, first.
    if (existing && existing.port === args.port) await this.closeRelays({ environment: args.environment }, 'replaced');
    const limits = args.limits;
    const relay: Relay = { environment: args.environment, attempt: args.attempt, port: args.port, server: null as unknown as net.Server, open: new Set(), closers: new Set() };
    let active = 0;
    const server = net.createServer((client) => {
      client.on('error', () => client.destroy());
      client.pause();
      if (active >= limits.tunnelsMax) return void client.destroy();
      active++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
      };
      relay.open.add(client);
      client.on('close', () => {
        relay.open.delete(client);
        release();
      });
      void (async () => {
        const ok = await this.rt.read<boolean>('deploy.relay_check', { environment: args.environment, attempt: args.attempt }).catch(() => false);
        if (client.destroyed) return release();
        const s = this.services.get(args.attempt);
        if (!ok || !s || !s.channel || s.channel.closed || this.relays.get(args.environment) !== relay) return void client.destroy();
        const up = await this.openTunnel(args.attempt, limits.connectTimeoutMs);
        if (up === null) return void client.destroy();
        if (client.destroyed || this.relays.get(args.environment) !== relay) {
          up.destroy();
          client.destroy();
          return;
        }
        relay.open.add(up);
        s.open.add(up);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(lifetime);
          relay.closers.delete(close);
          client.destroy();
          up.destroy();
          relay.open.delete(up);
          s.open.delete(up);
        };
        relay.closers.add(close);
        const lifetime = setTimeout(close, limits.tunnelMaxMs);
        lifetime.unref?.();
        client.on('data', (chunk: Buffer) => {
          up.write(chunk);
          if (up.writableLength > limits.bufferMaxBytes) close();
        });
        up.on('data', (chunk: Buffer) => {
          client.write(chunk);
          if (client.writableLength > limits.bufferMaxBytes) close();
        });
        client.on('end', () => up.end());
        up.on('end', () => client.end());
        client.on('close', close);
        up.on('close', close);
        up.on('error', close);
        client.on('error', close);
        client.resume();
      })().catch((err) => {
        log('operator relay', err, { environment: args.environment });
        client.destroy();
      });
    });
    const bound = await new Promise<'opened' | 'in_use'>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve('in_use') : reject(err)));
      server.listen({ host: '127.0.0.1', port: args.port, exclusive: true }, () => resolve('opened'));
    });
    if (bound === 'in_use') return 'in_use';
    server.on('error', (err) => log('operator relay', err, { environment: args.environment }));
    relay.server = server;
    // Bound: the one it replaces is closed and recorded now.
    if (this.relays.has(args.environment)) await this.closeRelays({ environment: args.environment }, 'replaced');
    this.relays.set(args.environment, relay);
    return 'opened';
  }

  // The relay's listener and every tunnel of it closed; nothing recorded.
  dropRelay(environment: string): { attempt: string } | null {
    const r = this.relays.get(environment);
    if (!r) return null;
    this.relays.delete(environment);
    r.server.close();
    for (const c of [...r.closers]) c();
    for (const c of r.open) c.destroy();
    return { attempt: r.attempt };
  }

  // Closed by the engine itself (a teardown, its generation's end, a lost
  // supervision), and recorded with the reason.
  async closeRelays(match: { environment?: string; attempt?: string }, reason: string): Promise<void> {
    for (const r of [...this.relays.values()]) {
      if ((match.environment !== undefined && r.environment !== match.environment) || (match.attempt !== undefined && r.attempt !== match.attempt)) continue;
      this.dropRelay(r.environment);
      await this.rt.engine('deploy.relay_closed', { environment: r.environment, attempt: r.attempt, reason }).catch((err) => log('operator relay', err, { environment: r.environment }));
    }
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
    // Its generation's end closes its relay (D4 §5.2: never retargeted).
    void this.closeRelays({ attempt: args.attempt }, 'generation_ended');
    // Its launch is over for good: nothing of it is proven any more (m6).
    this.proven.delete(args.attempt);
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
    let named: string | null = null;
    const refuse = async (why: string): Promise<void> => {
      log('service launch', new Error(`refused: ${why}`));
      const hold = named === null ? undefined : this.refusalHolds.get(named);
      if (hold) {
        hold.reached(why);
        await Promise.race([hold.released, new Promise<void>((r) => setTimeout(r, REFUSAL_HOLD_MS).unref?.())]);
      }
      if (named !== null) {
        this.refusalLog.push({ attempt: named, reason: why, at: new Date().toISOString() });
        if (this.refusalLog.length > 256) this.refusalLog.splice(0, this.refusalLog.length - 256);
      }
      ch.send({ t: 'refused', reason: why });
      ch.end();
    };
    const hello = await ch.next(30_000);
    if (!hello || hello.t !== 'hello' || hello.profile !== 'service') return refuse('no hello');
    const attempt = String(hello.attempt ?? '');
    named = attempt;
    const lk = await this.rt.read<Lookup | null>('deploy.launch_lookup', { attempt });
    if (!lk || !lk.domain || !lk.unit) return refuse('no such attempt');
    // Checked first in the store (cheaply), then on the host.
    if (hello.incarnation !== this.rt.incarnation || lk.incarnation !== this.rt.incarnation) return refuse('not this incarnation');
    // Single-use (D4 §9.2; E127 m3): once a connection of this attempt has
    // proved its peer, any other is refused at once, with nothing sent.
    if (this.proven.has(attempt)) return refuse('a launch connection of this attempt has already proved its peer');
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
    // The peer (E127 m3): the connection must be the named launcher's, before
    // anything is recorded or sent.
    if (!(await this.prove(ch, pid)) || cgroupOf(pid) !== cgroup) return refuse('the connection is not the named launcher\'s: it did not answer the challenge');
    // And it is still the unit's MainPID (ruling 1; the slice-28 review, m5).
    const [again] = (await showUnits([lk.unit], { home: this.rt.home, env: lk.environment, timeoutMs: this.rt.config.values.adapter_read_deadline * 1000 })) ?? [];
    if (!again || Number(again.MainPID) !== pid || again.InvocationID !== unit.InvocationID) return refuse("after the challenge the launcher is no longer the unit's MainPID");
    if (this.proven.has(attempt)) return refuse('a launch connection of this attempt has already proved its peer');
    this.proven.add(attempt);
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
    // The expected init holds this connection (E127 m3): it answers its own
    // challenge, before the grant and anything it carries.
    if (!(await this.prove(ch, ipid))) return refuse('the init did not answer the challenge');
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
      // Its relay answers nothing more (D4 §§5.2, 7.3; E116).
      if (!s.disposed && !this.stopping) void this.closeRelays({ attempt: s.attempt }, 'supervision_lost');
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
            // The design preview, and a static configuration's deployment
            // (SHAPES.md §2), run the engine's own server, and only it.
            ...((lk.preview || lk.static) && lk.start?.[1] === previewServerPath() ? { programs: [lk.start[1]] } : {}),
          });
          ch.send({ t: 'plan', plan });
        } else if (m.stage === 'init') {
          const built = serviceEnvironment(lk, heldSecret);
          if ('unheld' in built) {
            // Checked at the launcher's hello; gone since: nothing starts.
            log('service launch', new Error(`refused: the secret ${built.unheld} is not held`), { attempt: s.attempt });
            ch.send({ t: 'term' });
            ch.end();
            return;
          }
          const env = built.env;
          // The harness fault `service_exec_failed` (SEAM.md §277): the start
          // command names a program that does not exist, so its exec fails.
          const argv = seamTakeDeployFault(lk.environment, 'service_exec_failed') ? [`${APP_DIR}/.surety-exec-failed`, ...(lk.start ?? []).slice(1)] : lk.start;
          ch.send({ t: 'backend', backend: { argv, env, cwd: APP_DIR, stdin: null, service: { port: lk.port, ingress: INGRESS_SOCKET, logMax: lk.limits.log_max_bytes } } });
        }
        return;
      case 'ready':
        ch.send({ t: 'start' });
        return;
      case 'logs': {
        const done = this.captures.get(String(m.id ?? ''));
        if (!done) return;
        this.captures.delete(String(m.id));
        let bytes: Buffer | null = null;
        try {
          bytes = typeof m.d === 'string' ? Buffer.from(m.d, 'base64') : null;
        } catch {
          bytes = null;
        }
        done(bytes);
        return;
      }
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
