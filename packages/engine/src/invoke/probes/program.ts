// The engine's probe program (D2 §§2.8, 7.2, A.6; M2 plan §2.3): shipped at
// /surety/context/probe in the `probe` profile and run by node inside a
// sandbox. It is an instrument, not a judge: it attempts what its
// instructions name and reports what the kernel answered, one JSON line per
// action on its standard output, which the domain init relays to the
// engine. The engine judges each probe against its seeded target and its
// control (invoke/probes/suite.ts), and corroborates from the host side.
//
// It fails closed (E64 item 2). Before any action it establishes, by its own
// reads, that it is contained: its pid namespace is not the host's (the
// engine passes the host's in the instructions; equal means refuse); pid 1
// is the engine's domain init, not a system's init; at most a small number
// of processes is visible; it runs in a user namespace. Any read that fails
// is a refusal. Refused, it attempts nothing and reports every action
// refused with the reasons. The actions that exhaust a limit (pids, memory)
// also read the domain's own limit through the probe profile's cgroup bind
// and refuse unless it is small.
//
// This file imports nothing of the engine's: it is copied into the context
// package and runs on its own.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';

type Obj = Record<string, unknown>;

const MAX_VISIBLE = 16;
const SYSTEM_INITS = ['systemd', 'init', 'launchd'];
const errorOf = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? String((err as Error)?.message ?? err);
const emit = (o: Obj): void => {
  process.stdout.write(`${JSON.stringify({ type: 'probe', ...o })}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the guard ---------------------------------------------------------------------------------

export function containment(hostPidNs: unknown): { reasons: string[]; own: string | null; init: string[] | null; visible: number | null } {
  const reasons: string[] = [];
  let own: string | null = null;
  try {
    own = readlinkSync('/proc/self/ns/pid');
  } catch {
    own = null;
  }
  if (typeof hostPidNs !== 'string' || !/^pid:\[\d+\]$/.test(hostPidNs)) reasons.push('the instructions name no host pid namespace');
  if (own === null || !/^pid:\[\d+\]$/.test(own)) reasons.push('the own pid namespace cannot be read');
  else if (own === hostPidNs) reasons.push(`this process is in the host's pid namespace (${own})`);
  let init: string[] | null = null;
  try {
    init = readFileSync('/proc/1/cmdline', 'latin1').split('\0').filter(Boolean);
  } catch {
    init = null;
  }
  if (init === null) reasons.push('pid 1 cannot be read');
  else if (!init.includes('/.init/init.js')) reasons.push(`pid 1 is not the engine's domain init (${init.join(' ')})`);
  try {
    const comm = readFileSync('/proc/1/comm', 'utf8').trim();
    if (SYSTEM_INITS.includes(comm)) reasons.push(`pid 1 is a system's init (${comm})`);
  } catch {
    reasons.push('pid 1 cannot be read');
  }
  let visible: number | null = null;
  try {
    visible = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
  } catch {
    visible = null;
  }
  if (visible === null) reasons.push('/proc cannot be listed');
  else if (visible > MAX_VISIBLE) reasons.push(`${visible} processes are visible, more than a sandbox holds`);
  try {
    const map = readFileSync('/proc/self/uid_map', 'utf8').trim();
    if (/^0\s+0\s+4294967295$/.test(map)) reasons.push('this process is in the initial user namespace');
  } catch {
    reasons.push('the uid map cannot be read');
  }
  return { reasons, own, init, visible };
}

function smallLimit(file: string, max: number): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (text === 'max') return `${file} is unlimited`;
    const n = Number(text);
    if (!Number.isFinite(n)) return `${file} reads ${text}`;
    if (n > max) return `${file} is ${n}, more than ${max}`;
    return null;
  } catch (err) {
    return `${file} cannot be read (${errorOf(err)})`;
  }
}

// ---- actions -----------------------------------------------------------------------------------

function tryOpen(path: string): string {
  try {
    const fd = openSync(path, 'r');
    closeSync(fd);
    return 'opened';
  } catch (err) {
    return errorOf(err);
  }
}

function fds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      out[fd] = readlinkSync(`/proc/self/fd/${fd}`);
    } catch (err) {
      out[fd] = `unreadable:${errorOf(err)}`;
    }
  }
  return out;
}

function status(key: string): string | null {
  try {
    const line = readFileSync('/proc/self/status', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

function run(argv: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Obj {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd ?? '/surety/workspace',
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 5000,
    env: opts.env ?? { PATH: '/usr/bin:/bin', HOME: '/surety/home', LANG: 'C.UTF-8' },
  });
  return { status: r.status, signal: r.signal, error: r.error ? errorOf(r.error) : null, stdout: (r.stdout ?? '').slice(0, 4000), stderr: (r.stderr ?? '').slice(0, 2000) };
}

function connectOnce(target: Obj, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    let sock: net.Socket;
    try {
      sock =
        typeof target.unix === 'string'
          ? net.connect(target.unix)
          : typeof target.abstract === 'string'
            ? net.connect(`\0${target.abstract}`)
            : net.connect({ host: String(target.host), port: Number(target.port) });
    } catch (err) {
      resolve(errorOf(err));
      return;
    }
    const timer = setTimeout(() => {
      sock.destroy();
      resolve('timeout');
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve('connected');
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      resolve(errorOf(err));
    });
  });
}

// One CONNECT through the forwarder; with `send`, the bytes written into the
// tunnel and what came back.
function tunnel(port: number, authority: string, send: Buffer | null, timeoutMs = 4000): Promise<Obj> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let status: number | null = null;
    let echoed = Buffer.alloc(0);
    const done = (o: Obj) => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ authority, status, ...o });
    };
    const timer = setTimeout(() => done({ outcome: 'timeout', echoed: echoed.toString('base64') }), timeoutMs);
    sock.once('connect', () => sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    sock.on('data', (chunk: Buffer) => {
      if (status === null) {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'));
        status = m ? Number(m[1]) : -1;
        const rest = buf.subarray(end + 4);
        if (status !== 200 || send === null) {
          done({ outcome: status === 200 ? 'tunnel' : 'refused' });
          return;
        }
        sock.write(send);
        echoed = Buffer.concat([echoed, rest]);
      } else echoed = Buffer.concat([echoed, chunk]);
      if (send !== null && echoed.length >= send.length) done({ outcome: 'tunnel', echoed: echoed.toString('base64'), same: echoed.subarray(0, send.length).equals(send) });
    });
    sock.on('error', (err) => done({ outcome: errorOf(err) }));
    sock.on('end', () => done({ outcome: status === null ? 'closed' : status === 200 ? 'eof' : 'refused', echoed: echoed.toString('base64') }));
  });
}

function attempt(op: Obj): string {
  const path = String(op.path ?? '');
  try {
    switch (op.op) {
      case 'write':
        writeFileSync(path, String(op.content ?? 'probe'), { flag: 'a' });
        return 'written';
      case 'create':
        writeFileSync(path, String(op.content ?? 'probe'), { flag: 'wx' });
        return 'written';
      case 'truncate':
        truncateSync(path, 0);
        return 'written';
      case 'rename':
        renameSync(path, String(op.to));
        return 'written';
      case 'link':
        linkSync(path, String(op.to));
        return 'written';
      case 'symlink_write':
        rmSync(String(op.to), { force: true });
        symlinkSync(path, String(op.to));
        writeFileSync(String(op.to), 'probe', { flag: 'a' });
        return 'written';
      case 'chmod':
        chmodSync(path, 0o777);
        return 'written';
      case 'mkdir':
        mkdirSync(path);
        return 'written';
      case 'unlink':
        unlinkSync(path);
        return 'written';
      default:
        return 'unknown_op';
    }
  } catch (err) {
    return errorOf(err);
  }
}

async function act(a: Obj): Promise<Obj> {
  switch (a.kind) {
    case 'open': {
      const results: Record<string, string> = {};
      for (const p of (a.paths as string[]) ?? []) results[p] = tryOpen(p);
      return { results };
    }
    case 'fds': {
      let init: Obj;
      try {
        init = { outcome: 'listed', fds: readdirSync('/proc/1/fd') };
      } catch (err) {
        init = { outcome: 'refused', error: errorOf(err) };
      }
      return { own: fds(), init };
    }
    case 'git': {
      const out: Obj[] = [];
      for (const args of (a.commands as string[][]) ?? []) out.push({ args, ...run(['git', ...args], { env: { PATH: '/usr/bin:/bin', HOME: '/surety/home', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1' } }) });
      return { commands: out };
    }
    case 'attempts': {
      const results: Obj[] = [];
      for (const op of (a.ops as Obj[]) ?? []) results.push({ ...op, outcome: attempt(op) });
      return { results };
    }
    case 'read': {
      try {
        return { outcome: 'read', content: readFileSync(String(a.path), 'utf8').slice(0, 4096) };
      } catch (err) {
        return { outcome: 'failed', error: errorOf(err) };
      }
    }
    case 'write_read': {
      try {
        writeFileSync(String(a.path), String(a.content));
        return { outcome: readFileSync(String(a.path), 'utf8') === String(a.content) ? 'same' : 'differs' };
      } catch (err) {
        return { outcome: errorOf(err) };
      }
    }
    case 'connect': {
      const results: Obj[] = [];
      for (const t of (a.targets as Obj[]) ?? []) results.push({ ...t, outcome: await connectOnce(t) });
      return { results };
    }
    case 'own_socket': {
      // A socket the probe creates itself, and a connection to it.
      const name = `surety-probe-own-${process.pid}`;
      const server = net.createServer((c) => c.destroy());
      try {
        await new Promise<void>((resolve, reject) => server.once('error', reject).listen(`\0${name}`, () => resolve()));
        return { name, outcome: await connectOnce({ abstract: name }) };
      } catch (err) {
        return { name, outcome: errorOf(err) };
      } finally {
        server.close();
      }
    }
    case 'tunnels': {
      const results: Obj[] = [];
      for (const r of (a.requests as Obj[]) ?? []) results.push(await tunnel(Number(a.port), String(r.authority), typeof r.send === 'string' ? Buffer.from(r.send, 'base64') : null));
      return { results };
    }
    case 'http': {
      // A plain request on a direct connection (P7's direct route).
      return await new Promise<Obj>((resolve) => {
        const sock = net.connect({ host: String(a.host), port: Number(a.port) });
        const timer = setTimeout(() => {
          sock.destroy();
          resolve({ outcome: 'timeout' });
        }, 1500);
        sock.once('connect', () => sock.write(`GET ${String(a.path)} HTTP/1.1\r\nHost: ${String(a.host)}:${String(a.port)}\r\nOrigin: http://localhost\r\nSec-Fetch-Site: same-origin\r\n\r\n`));
        sock.once('data', (d: Buffer) => {
          clearTimeout(timer);
          sock.destroy();
          resolve({ outcome: 'answered', head: d.toString('latin1').slice(0, 200) });
        });
        sock.once('error', (err) => {
          clearTimeout(timer);
          resolve({ outcome: errorOf(err) });
        });
      });
    }
    case 'exec':
      return run(a.argv as string[], { timeoutMs: Number(a.timeout_ms ?? 5000) });
    case 'status':
      return { cap_eff: status('CapEff'), no_new_privs: status('NoNewPrivs'), uid: status('Uid'), gid: status('Gid'), nspid: status('NSpid'), fds: fds(), mount: run(['mount', '-t', 'tmpfs', 'none', '/surety/out'], { timeoutMs: 3000 }) };
    case 'mountinfo':
      return { mountinfo: readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean) };
    case 'cgroup_migrate': {
      const before = readFileSync('/proc/self/cgroup', 'utf8').trim();
      let present: boolean;
      try {
        lstatSync(join(String(a.to), 'cgroup.procs'));
        present = true;
      } catch {
        present = false;
      }
      let outcome: string;
      try {
        writeFileSync(join(String(a.to), 'cgroup.procs'), `${process.pid}\n`);
        outcome = 'written';
      } catch (err) {
        outcome = errorOf(err);
      }
      const after = readFileSync('/proc/self/cgroup', 'utf8').trim();
      // A moment for the host to see where this process is.
      await sleep(Number(a.linger_ms ?? 300));
      return { pid: process.pid, before, after, outcome, target_present: present };
    }
    case 'signal_all': {
      // P13 (D2 A.6): a child of its own as the control, then every pid it
      // sees, then kill(-1). Only after the guard (main) let it this far.
      const control = spawn('/usr/bin/sleep', ['300'], { stdio: 'ignore' });
      await new Promise((r) => control.once('spawn', r));
      const seen = readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
        .filter((p) => p !== process.pid);
      const results: Record<string, string> = {};
      for (const pid of seen) {
        try {
          process.kill(pid, 'SIGKILL');
          results[pid] = 'sent';
        } catch (err) {
          results[pid] = errorOf(err);
        }
      }
      let all: string;
      try {
        process.kill(-1, 'SIGKILL');
        all = 'sent';
      } catch (err) {
        all = errorOf(err);
      }
      const exit = await Promise.race([new Promise<Obj>((r) => control.once('exit', (code, signal) => r({ code, signal }))), sleep(3000).then(() => null)]);
      let init: string;
      try {
        readdirSync('/proc/1/fd');
        init = 'listed';
      } catch (err) {
        init = errorOf(err);
      }
      return { seen, results, kill_all: all, control: { pid: control.pid, exit }, init_fd: init };
    }
    case 'daemon': {
      // P16: a descendant that leaves its session, clears its environment,
      // double-forks and writes its witness file until it is killed.
      const witness = String(a.witness);
      const script = `const fs=require('fs');const {spawn}=require('child_process');if(process.argv[2]==='mid'){const c=spawn(process.execPath,['-e',process.argv[1],'x','leaf'],{detached:true,stdio:'ignore',env:{}});c.unref();fs.writeFileSync(${JSON.stringify(witness)}+'.pid',String(c.pid));process.exit(0)}else{setInterval(()=>fs.appendFileSync(${JSON.stringify(witness)},'.'),50)}`;
      const mid = spawn(process.execPath, ['-e', script, script, 'mid'], { detached: true, stdio: 'ignore', env: {} });
      await new Promise((r) => mid.once('exit', r));
      for (let i = 0; i < 40; i++) {
        try {
          const pid = Number(readFileSync(`${witness}.pid`, 'utf8'));
          if (pid > 0) return { daemon_pid: pid };
        } catch {
          // not yet
        }
        await sleep(25);
      }
      return { daemon_pid: null };
    }
    case 'results': {
      // P18: what /surety/out/result.json may be made into.
      const made: Record<string, string> = {};
      const mk = (name: string, f: () => void) => {
        try {
          f();
          made[name] = 'made';
        } catch (err) {
          made[name] = errorOf(err);
        }
      };
      const out = String(a.dir);
      mk('link_fifo', () => symlinkSync(String(a.host_fifo), join(out, 'link_fifo.json')));
      mk('fifo', () => {
        const r = spawnSync('/usr/bin/mkfifo', [join(out, 'fifo.json')]);
        if (r.status !== 0) throw new Error(`mkfifo ${r.status}`);
      });
      mk('device', () => symlinkSync('/dev/zero', join(out, 'device.json')));
      mk('oversize', () => writeFileSync(join(out, 'oversize.json'), Buffer.alloc(Number(a.oversize), 0x20)));
      mk('regular', () => writeFileSync(join(out, 'regular.json'), String(a.regular)));
      return { made };
    }
    case 'pids': {
      const why = smallLimit('/surety/cgroup/domain/pids.max', Number(a.max_limit ?? 256));
      if (why) return { refused: why };
      const kids: ReturnType<typeof spawn>[] = [];
      let failure: string | null = null;
      for (let i = 0; i < 512 && failure === null; i++) {
        const c = spawn('/usr/bin/sleep', ['60'], { stdio: 'ignore' });
        const r = await new Promise<string>((resolve) => {
          c.once('spawn', () => resolve('spawned'));
          c.once('error', (err) => resolve(errorOf(err)));
        });
        if (r === 'spawned') kids.push(c);
        else failure = r;
      }
      const n = kids.length;
      for (const c of kids) c.kill('SIGKILL');
      return { forks: n, failure };
    }
    case 'memory': {
      const why = smallLimit('/surety/cgroup/domain/memory.max', Number(a.max_limit ?? 1024 * 1024 * 1024));
      if (why) return { refused: why };
      // The control first, reported before the exhaustion, which ends this
      // process by the kernel's OOM kill.
      const one = Buffer.alloc(1024 * 1024, 1);
      emit({ id: String(a.id), step: 'control', control: { allocated: one.length } });
      const held: Buffer[] = [];
      for (let i = 0; i < 4096; i++) held.push(Buffer.alloc(16 * 1024 * 1024, i & 0xff));
      return { allocated: held.length * 16 * 1024 * 1024 };
    }
    case 'bytes': {
      const dir = String(a.dir);
      let control: string;
      try {
        writeFileSync(join(dir, 'control'), Buffer.alloc(4096, 1));
        control = 'written';
      } catch (err) {
        control = errorOf(err);
      }
      let written = 0;
      let stop: string | null = null;
      try {
        const fd = openSync(join(dir, 'fill'), 'w');
        const chunk = Buffer.alloc(64 * 1024, 2);
        try {
          for (let i = 0; i < 4096; i++) written += writeSync(fd, chunk);
        } catch (err) {
          stop = errorOf(err);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        stop = errorOf(err);
      }
      rmSync(join(dir, 'fill'), { force: true });
      rmSync(join(dir, 'control'), { force: true });
      return { control, written, stop };
    }
    case 'inodes': {
      const dir = String(a.dir);
      let control: string;
      try {
        writeFileSync(join(dir, 'c0'), '');
        control = 'created';
      } catch (err) {
        control = errorOf(err);
      }
      let made = 0;
      let stop: string | null = null;
      for (let i = 0; i < 100000; i++) {
        try {
          writeFileSync(join(dir, `f${i}`), '');
          made++;
        } catch (err) {
          stop = errorOf(err);
          break;
        }
      }
      for (const n of readdirSync(dir)) rmSync(join(dir, n), { force: true });
      return { control, made, stop };
    }
    case 'lstat': {
      const results: Record<string, string> = {};
      for (const p of (a.paths as string[]) ?? []) {
        try {
          const st = lstatSync(p);
          results[p] = st.isSocket() ? 'socket' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        } catch (err) {
          results[p] = errorOf(err);
        }
      }
      return { results };
    }
    case 'mkdir_p': {
      try {
        mkdirSync(String(a.path), { recursive: true });
        return { outcome: 'made' };
      } catch (err) {
        return { outcome: errorOf(err) };
      }
    }
    default:
      return { outcome: 'unknown_action' };
  }
}

async function main(): Promise<void> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  let spec: { host_pid_ns?: unknown; actions?: Obj[] };
  try {
    spec = JSON.parse(text) as typeof spec;
  } catch {
    emit({ id: 'instructions', refused: 'the instructions are not JSON' });
    return;
  }
  const guard = containment(spec.host_pid_ns);
  emit({ id: 'guard', guard });
  for (const a of spec.actions ?? []) {
    const id = String(a.id ?? a.kind);
    if (guard.reasons.length > 0) {
      emit({ id, refused: 'not contained', reasons: guard.reasons });
      continue;
    }
    try {
      emit({ id, ...(await act(a)) });
    } catch (err) {
      emit({ id, threw: errorOf(err) });
    }
  }
  emit({ id: 'done' });
}

// Only as a program of its own, inside a sandbox: never imported for its
// actions.
if (process.argv[1] && /probe(\.js)?$/.test(process.argv[1])) {
  void main().then(
    () => setTimeout(() => process.exit(0), 20),
    () => process.exit(70),
  );
}

void dirname;
