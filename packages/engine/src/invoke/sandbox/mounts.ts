// The mount plan the domain init's setup stage executes (D2 §2.3): the
// role's root, resolved by the engine from the host before each launch.
//
// What the root holds: read-only binds of /usr, /bin, /lib and /lib64; the
// enumerated files of /etc and an engine-written `hosts` and empty
// `resolv.conf`; the engine's node at its real path (read-only), and the
// domain init with its execute-only copy of node under /.init; a private
// /proc, a minimal /dev with a private devpts and /dev/shm; `/surety` with
// exactly `context` (read-only), `workspace`, `git`, `home` and `out`; /tmp.
// `home`, `out` and /tmp are on the domain's volatile filesystem, one tmpfs
// bounded by `domain_writable_bytes` and `domain_writable_inodes` and charged
// to the domain's memory.
//
// Binds are non-recursive, so no host submount comes with them. Where a
// permitted tree holds a host submount (on WSL2, /usr/lib/wsl/drivers is a 9p
// mount), the kernel refuses a non-recursive bind of the tree in an
// unprivileged namespace, so the tree is bound entry by entry around the
// submount, which is left an empty directory: what is under it on the host
// never enters the root.
//
// Slice 11 builds what the scripted backend needs to run inside the real
// sandbox: the workspace is the run's checkout, bound read-write, and
// `/surety/git` is empty. The engine-constructed git view, the overlay of the
// workspace on the volatile filesystem with its screened materialization, the
// egress forwarder and the plan's validation against the role's mount table
// are slice 12's (rows M119 to M128).

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface Entry {
  path: string;
  kind: 'dir' | 'file' | 'symlink';
  target?: string;
  content?: string;
  mode?: number;
}

export interface Tools {
  mount: string;
  umount: string;
  pivot_root: string;
  ip: string;
  unshare: string;
  setpriv: string;
}

export interface Plan {
  stage: string;
  vol: string;
  rootBytes: number;
  volBytes: number;
  volInodes: number;
  volDirs: string[];
  skeleton: Entry[];
  fstab: string[];
  // Made, and mounted, after the first table: what lies under a mount of
  // the first (a widening's path under /tmp, say).
  late: Entry[];
  lateFstab: string[];
  tools: Tools;
  uid: number;
  gid: number;
  initNode: string;
  initScript: string;
  overlayTrial?: boolean;
}

export interface PlanInput {
  // The domain's area under the engine home: `root` and `vol` are the
  // mountpoints the setup stage mounts its two tmpfs on (in its own mount
  // namespace; the host sees two empty directories).
  area: string;
  context: string;
  workspace: string;
  // Read-only and read-write binds beyond the profile's, each at its real
  // path: a project's approved `sandbox_read_paths`; in harness mode the
  // scripted backend's directory.
  readPaths: string[];
  writablePaths: string[];
  // Binds at a target other than their source (the probe profile's cgroup
  // directories, D2 §2.8, A.6 P15).
  binds?: { source: string; target: string; writable: boolean; noexec?: boolean }[];
  volBytes: number;
  volInodes: number;
  shmBytes: number;
  tools: Tools;
  node: string; // the engine's node, real path
  initNodeCopy: string; // execute-only copy, host path
  initScript: string; // domain-init.js, host path
}

// D2 §2.3: the files of /etc a role sees.
export const ETC_FILES = ['passwd', 'group', 'nsswitch.conf', 'ld.so.cache', 'localtime', 'ssl/certs/ca-certificates.crt'];
export const SYSTEM_TREES = ['/usr', '/bin', '/lib', '/lib64'];
const DEV_NODES = ['null', 'zero', 'full', 'random', 'urandom'];

// Mount points of the host, from this process's mount table.
export function hostMountPoints(): string[] {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[4]!.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
  } catch {
    return [];
  }
}

const esc = (p: string): string => p.replace(/[\\ \t\n]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);

class Builder {
  skeleton: Entry[] = [];
  fstab: string[] = [];
  readonly late: Entry[] = [];
  readonly lateFstab: string[] = [];
  private readonly made = new Set<string>();

  // From here on, entries and mounts go to the second phase.
  second(): void {
    this.skeleton = this.late;
    this.fstab = this.lateFstab;
  }

  constructor(
    private readonly stage: string,
    private readonly mounts: string[],
  ) {}

  entry(e: Entry): void {
    if (this.made.has(e.path)) return;
    this.made.add(e.path);
    this.skeleton.push(e);
  }

  dir(path: string, mode = 0o755): void {
    this.entry({ path: rel(path), kind: 'dir', mode });
  }

  file(path: string, content = '', mode?: number): void {
    this.entry({ path: rel(path), kind: 'file', content, ...(mode === undefined ? {} : { mode }) });
  }

  line(source: string, target: string, type: string, options: string): void {
    this.fstab.push(`${esc(source)} ${esc(join(this.stage, rel(target)))} ${type} ${options} 0 0`);
  }

  // A non-recursive bind of `source` at `target` (default: the same path).
  bind(source: string, opts: { writable?: boolean; target?: string; device?: boolean; noexec?: boolean } = {}): void {
    const target = opts.target ?? source;
    const st = lstatSync(source);
    if (st.isDirectory()) this.dir(target);
    else this.file(target);
    // A device node is usable only on a mount without `nodev`, and /dev/null
    // only where it can be written.
    // A cgroupfs directory keeps its mount's locked `noexec` (it cannot be
    // cleared in an unprivileged namespace).
    const options = opts.device ? 'bind,nosuid,noexec' : `${opts.writable ? 'bind,nosuid,nodev' : 'bind,ro,nosuid,nodev'}${opts.noexec ? ',noexec' : ''}`;
    this.line(source, target, 'none', options);
  }

  // A permitted system tree, bound entry by entry around any host submount.
  tree(source: string): void {
    let st;
    try {
      st = lstatSync(source);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      this.entry({ path: rel(source), kind: 'symlink', target: readlinkSync(source) });
      return;
    }
    if (this.mounts.includes(source) && !SYSTEM_TREES.includes(source)) {
      // A host submount: not bound, an empty directory in its place.
      this.dir(source);
      return;
    }
    const below = this.mounts.some((m) => m.startsWith(`${source}/`));
    if (st.isDirectory() && below) {
      this.dir(source);
      for (const name of readdirSync(source).sort()) this.tree(join(source, name));
      return;
    }
    if (st.isDirectory() || st.isFile()) this.bind(source);
  }
}

const rel = (p: string): string => relative('/', p);

function parents(path: string): string[] {
  const out: string[] = [];
  for (let d = dirname(path); d !== '/' && d !== '.'; d = dirname(d)) out.unshift(d);
  return out;
}

export function buildPlan(input: PlanInput): Plan {
  const stage = join(input.area, 'root');
  const vol = join(input.area, 'vol');
  const b = new Builder(stage, hostMountPoints());
  for (const t of SYSTEM_TREES) b.tree(t);
  // /etc: the enumerated files, and the engine's own `hosts` and `resolv.conf`.
  b.dir('/etc');
  for (const name of ETC_FILES) {
    const path = join('/etc', name);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    for (const p of parents(path)) b.dir(p);
    b.bind(real, { target: path });
  }
  b.file('/etc/hosts', '127.0.0.1 localhost\n::1 localhost\n', 0o644);
  b.file('/etc/resolv.conf', '', 0o644);
  // /dev: the enumerated nodes, a private devpts, a private /dev/shm.
  b.dir('/dev');
  for (const n of DEV_NODES) b.bind(join('/dev', n), { device: true });
  b.dir('/dev/pts');
  b.line('devpts', '/dev/pts', 'devpts', 'newinstance,ptmxmode=0666,mode=0620,nosuid,noexec');
  b.dir('/dev/shm', 0o1777);
  b.line('surety-shm', '/dev/shm', 'tmpfs', `size=${input.shmBytes},nr_inodes=1024,mode=1777,nosuid,nodev`);
  b.dir('/proc');
  b.line('proc', '/proc', 'proc', 'nosuid,nodev,noexec');
  // The engine's node, read-only at its real path; the init's execute-only
  // copy and its script under /.init.
  for (const p of parents(input.node)) b.dir(p);
  b.bind(input.node);
  b.dir('/.init');
  b.bind(input.initNodeCopy, { target: '/.init/node' });
  b.bind(input.initScript, { target: '/.init/init.js' });
  // /surety: exactly context, workspace, git, home, out.
  b.dir('/surety');
  b.bind(input.context, { target: '/surety/context' });
  b.bind(input.workspace, { target: '/surety/workspace', writable: true });
  b.dir('/surety/git');
  b.dir('/surety/home');
  b.line(join(vol, 'home'), '/surety/home', 'none', 'bind,nosuid,nodev');
  b.dir('/surety/out');
  b.line(join(vol, 'out'), '/surety/out', 'none', 'bind,nosuid,nodev');
  b.dir('/tmp', 0o1777);
  b.line(join(vol, 'tmp'), '/tmp', 'none', 'bind,nosuid,nodev');
  const first = { skeleton: b.skeleton, fstab: b.fstab };
  b.second();
  b.entry({ path: 'dev/ptmx', kind: 'symlink', target: 'pts/ptmx' });
  for (const p of input.readPaths) {
    for (const d of parents(p)) b.dir(d);
    b.bind(p);
  }
  for (const p of input.writablePaths) {
    for (const d of parents(p)) b.dir(d);
    b.bind(p, { writable: true });
  }
  for (const x of input.binds ?? []) {
    for (const d of parents(x.target)) b.dir(d);
    b.bind(x.source, { target: x.target, writable: x.writable, noexec: x.noexec === true });
  }
  return {
    stage,
    vol,
    rootBytes: 16 * 1024 * 1024,
    volBytes: input.volBytes,
    volInodes: input.volInodes,
    volDirs: ['home', 'out', 'tmp'],
    skeleton: first.skeleton,
    fstab: first.fstab,
    late: b.late,
    lateFstab: b.lateFstab,
    tools: input.tools,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    initNode: '/.init/node',
    initScript: '/.init/init.js',
  };
}

// The fingerprint of what a plan makes visible (D2 §2.3: part of the profile
// qualified), over its structure with the domain's own paths taken out.
export function planFingerprint(plan: Plan): string {
  const strip = (s: string) => s.split(plan.stage).join('<root>').split(plan.vol).join('<vol>');
  const shape = {
    skeleton: plan.skeleton.map((e) => ({ ...e, content: e.content === undefined ? undefined : createHash('sha256').update(e.content).digest('hex') })),
    fstab: [...plan.fstab, ...plan.lateFstab].map(strip).filter((l) => !l.includes('/surety/context') && !l.includes('/surety/workspace')),
    volBytes: plan.volBytes,
    volInodes: plan.volInodes,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export const planIsBuildable = (input: PlanInput): boolean => existsSync(input.node) && existsSync(input.initScript);
