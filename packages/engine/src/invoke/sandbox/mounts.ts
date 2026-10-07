// The mount plan the domain init's setup stage executes (D2 §2.3): the
// role's root, resolved by the engine from the host before each launch.
//
// What the root holds: read-only binds of /usr, /bin, /lib and /lib64; the
// enumerated files of /etc and an engine-written `hosts` and empty
// `resolv.conf`; the engine's node at its real path (read-only), and the
// domain init with its execute-only copy of node under /.init, with the
// domain's egress socket beside them; a private /proc, a minimal /dev with a
// private devpts and /dev/shm; `/surety` with exactly `context` (read-only),
// `workspace`, `git`, `home` and `out`; /tmp. `home`, `out`, /tmp, the git
// view's directory and the workspace's upper layer are on the domain's
// volatile filesystem, one tmpfs bounded by `domain_writable_bytes` and
// `domain_writable_inodes` and charged to the domain's memory.
//
// The workspace is an overlay whose lower layer is the run's checkout,
// read-only, and whose upper layer is on the volatile filesystem (`userxattr`:
// the overlay keeps its own markers in user xattrs, so that a directory of the
// checkout can be removed and made again in an unprivileged namespace). Its
// `.git` file is covered, read-only, by one naming `/surety/git`, and every
// effective protected root by a read-only bind (D1 §7.3), except for the
// Verifier. `/surety/git` is the engine-constructed git metadata view (D2
// §2.7): a directory on the volatile filesystem holding this run's index (a
// copy, the role's own), and read-only binds of the engine's `config`, the
// run's `HEAD`, an empty `hooks`, and the repository's `refs`; its `objects`
// are an overlay whose lower layer is the repository's, read-only, and whose
// upper layer is on the volatile filesystem (a role's `git add` works on its
// own index, and no object it writes reaches the repository).
//
// Binds are non-recursive, so no host submount comes with them. Where a
// permitted tree holds a host submount (on WSL2, /usr/lib/wsl/drivers is a 9p
// mount), the kernel refuses a non-recursive bind of the tree in an
// unprivileged namespace, so the tree is bound entry by entry around the
// submount, which is left an empty directory: what is under it on the host
// never enters the root.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface Entry {
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'copy' | 'chardev';
  target?: string;
  content?: string;
  source?: string;
  mode?: number;
  // Made without following a link at any component, each component created
  // or found as a directory, the file created exclusively: an entry inside a
  // tree the engine did not write itself (a check's input targets).
  nofollow?: boolean;
}

export interface Tools {
  mount: string;
  umount: string;
  pivot_root: string;
  ip: string;
  unshare: string;
  setpriv: string;
  mknod?: string;
}

export interface Plan {
  stage: string;
  vol: string;
  rootBytes: number;
  volBytes: number;
  volInodes: number;
  volDirs: string[];
  volEntries: Entry[];
  skeleton: Entry[];
  fstab: string[];
  // Made, and mounted, after the first table: what lies under a mount of
  // the first (a widening's path under /tmp, a protected root the checkout
  // does not have).
  late: Entry[];
  lateFstab: string[];
  tools: Tools;
  uid: number;
  gid: number;
  initNode: string;
  initScript: string;
  overlayTrial?: boolean;
  holdVolatile?: boolean;
  workspaceMount?: string;
}

// The git metadata view's sources (D2 §2.7), prepared by the engine in the
// domain's area before the launch.
export interface GitViewInput {
  // The repository's common directory: its objects and refs are bound.
  commonDir: string;
  // `<area>/git`: the engine-written `config`, `HEAD`, `index`, `gitfile`
  // and the empty `hooks`.
  seed: string;
  // Whether the workspace has an index to copy (git reads a missing one as
  // empty).
  index: boolean;
  packedRefs: boolean;
  shallow: boolean;
}

export interface PlanInput {
  // The domain's area under the engine home: `root` and `vol` are the
  // mountpoints the setup stage mounts its two tmpfs on (in its own mount
  // namespace; the host sees two empty directories).
  area: string;
  context: string;
  workspace: string;
  // Read-only and read-write binds beyond the profile's, each at its real
  // path: a project's approved `sandbox_read_paths`; the backend's
  // installation; in harness mode the scripted backend's directory.
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
  // The containment canary's probe program (E86), bound read-only at
  // /.init/probe.js for the domain init to run; null elsewhere.
  probeProgram?: string | null;
  git?: GitViewInput | null;
  // Read-only binds over the workspace (the protected roots), each a path
  // relative to the workspace, the source a host path; `make` when the
  // checkout has nothing there and the target is made (an empty directory).
  workspaceBinds?: { source: string; target: string; make?: 'dir' }[];
  // The domain's egress socket (D2 §2.4), bound beside the init.
  egressSocket?: string | null;
  holdVolatile?: boolean;
}

// D2 §2.3: the files of /etc a role sees.
export const ETC_FILES = ['passwd', 'group', 'nsswitch.conf', 'ld.so.cache', 'localtime', 'ssl/certs/ca-certificates.crt'];
export const SYSTEM_TREES = ['/usr', '/bin', '/lib', '/lib64'];
export const DEV_NODES = ['null', 'zero', 'full', 'random', 'urandom'];
// Where the domain's egress socket is inside the sandbox.
export const EGRESS_SOCKET = '/.init/egress.sock';
export const WORKSPACE = '/surety/workspace';
export const GIT_VIEW = '/surety/git';

// Mount points of the host, from this process's mount table.
export function hostMountPoints(): string[] {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8')
      .trim()
      .split('\n')
      .map((l) => unescape(l.split(' ')[4]!));
  } catch {
    return [];
  }
}

export const unescape = (p: string): string => p.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
export const esc = (p: string): string => p.replace(/[\\ \t\n]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);

// An overlay's options take a path as given, separated by `,` and `:`: a path
// holding either cannot be named there.
export function overlayPath(p: string): string {
  if (/[,:\\\s]/.test(p)) throw new Error(`the path ${p} cannot be named in an overlay's options`);
  return p;
}

export class Builder {
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
  // `noTarget`: the target exists already (inside a filesystem mounted by an
  // earlier line), so no skeleton entry is made for it.
  bind(source: string, opts: { writable?: boolean; target?: string; device?: boolean; noexec?: boolean; noTarget?: boolean } = {}): void {
    const target = opts.target ?? source;
    const st = lstatSync(source);
    if (!opts.noTarget) {
      if (st.isDirectory()) this.dir(target);
      // A device's mount point is itself a character device (0:0, the one
      // an unprivileged namespace may make), so that the directory lists it
      // as what is mounted there is.
      else if (opts.device) this.entry({ path: rel(target), kind: 'chardev' });
      else this.file(target);
    }
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

export const rel = (p: string): string => relative('/', p);

export function parents(path: string): string[] {
  const out: string[] = [];
  for (let d = dirname(path); d !== '/' && d !== '.'; d = dirname(d)) out.unshift(d);
  return out;
}

// What every domain's root holds beyond its own `/surety` (D2 §2.3; D3
// §2.2): the system trees, the enumerated /etc, a minimal /dev with a
// private devpts and /dev/shm, a private /proc, the engine's node, and the
// domain init with its execute-only node under /.init (and, where given, the
// probe program and the egress socket). Shared by the `role`, `probe` and
// `check` profiles.
export function systemRoot(b: Builder, input: Pick<PlanInput, 'shmBytes' | 'node' | 'initNodeCopy' | 'initScript' | 'probeProgram' | 'egressSocket'>): void {
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
  // copy and its script under /.init, and the domain's egress socket.
  for (const p of parents(input.node)) b.dir(p);
  b.bind(input.node);
  b.dir('/.init');
  b.bind(input.initNodeCopy, { target: '/.init/node' });
  b.bind(input.initScript, { target: '/.init/init.js' });
  if (input.probeProgram) b.bind(input.probeProgram, { target: '/.init/probe.js' });
  // (A unix socket is connected to through a read-only bind as through any
  // other: the bind keeps the role from replacing it, not from using it.)
  if (input.egressSocket) b.bind(input.egressSocket, { target: EGRESS_SOCKET, noexec: true });
}

export function buildPlan(input: PlanInput): Plan {
  const stage = join(input.area, 'root');
  const vol = join(input.area, 'vol');
  const b = new Builder(stage, hostMountPoints());
  systemRoot(b, input);
  // /surety: exactly context, workspace, git, home, out.
  b.dir('/surety');
  b.bind(input.context, { target: '/surety/context' });
  b.dir(WORKSPACE);
  b.line(
    'surety-workspace',
    WORKSPACE,
    'overlay',
    `lowerdir=${esc(overlayPath(input.workspace))},upperdir=${esc(overlayPath(join(vol, 'upper')))},workdir=${esc(overlayPath(join(vol, 'work')))},userxattr,nosuid,nodev`,
  );
  const volEntries: Entry[] = [];
  b.dir(GIT_VIEW);
  if (input.git) {
    // The git metadata view (D2 §2.7): its directory on the volatile
    // filesystem (the role's own index and lock files), with the engine's
    // configuration, the run's HEAD, an empty hooks directory and the
    // repository's objects and refs read-only over it.
    const g = input.git;
    volEntries.push(
      { path: 'git', kind: 'dir', mode: 0o755 },
      ...(g.index ? [{ path: 'git/index', kind: 'copy' as const, source: join(g.seed, 'index'), mode: 0o644 }] : []),
      { path: 'git/config', kind: 'file', content: '' },
      { path: 'git/HEAD', kind: 'file', content: '' },
      { path: 'git/hooks', kind: 'dir' },
      { path: 'git/objects', kind: 'dir' },
      { path: 'git/refs', kind: 'dir' },
    );
    if (g.packedRefs) volEntries.push({ path: 'git/packed-refs', kind: 'file', content: '' });
    if (g.shallow) volEntries.push({ path: 'git/shallow', kind: 'file', content: '' });
    b.line(join(vol, 'git'), GIT_VIEW, 'none', 'bind,nosuid,nodev,noexec');
    b.bind(join(g.seed, 'config'), { target: join(GIT_VIEW, 'config'), noTarget: true });
    b.bind(join(g.seed, 'HEAD'), { target: join(GIT_VIEW, 'HEAD'), noTarget: true });
    b.bind(join(g.seed, 'hooks'), { target: join(GIT_VIEW, 'hooks'), noTarget: true, noexec: true });
    // The objects as an overlay: the repository's read-only below, the
    // volatile filesystem above, so that the role's `git add` writes its
    // blobs where they go with the domain and nothing reaches the
    // repository's own objects.
    volEntries.push({ path: 'gitobj', kind: 'dir' }, { path: 'gitobj/upper', kind: 'dir' }, { path: 'gitobj/work', kind: 'dir' });
    b.line(
      'surety-objects',
      join(GIT_VIEW, 'objects'),
      'overlay',
      `lowerdir=${esc(overlayPath(join(g.commonDir, 'objects')))},upperdir=${esc(overlayPath(join(vol, 'gitobj', 'upper')))},workdir=${esc(overlayPath(join(vol, 'gitobj', 'work')))},userxattr,nosuid,nodev,noexec`,
    );
    b.bind(join(g.commonDir, 'refs'), { target: join(GIT_VIEW, 'refs'), noTarget: true, noexec: true });
    if (g.packedRefs) b.bind(join(g.commonDir, 'packed-refs'), { target: join(GIT_VIEW, 'packed-refs'), noTarget: true });
    if (g.shallow) b.bind(join(g.commonDir, 'shallow'), { target: join(GIT_VIEW, 'shallow'), noTarget: true });
    // The workspace's `.git` names the view, read-only.
    b.bind(join(g.seed, 'gitfile'), { target: join(WORKSPACE, '.git'), noTarget: true });
  }
  b.dir('/surety/home');
  b.line(join(vol, 'home'), '/surety/home', 'none', 'bind,nosuid,nodev');
  b.dir('/surety/out');
  b.line(join(vol, 'out'), '/surety/out', 'none', 'bind,nosuid,nodev');
  b.dir('/tmp', 0o1777);
  b.line(join(vol, 'tmp'), '/tmp', 'none', 'bind,nosuid,nodev');
  const first = { skeleton: b.skeleton, fstab: b.fstab };
  b.second();
  b.entry({ path: 'dev/ptmx', kind: 'symlink', target: 'pts/ptmx' });
  // The protected roots, read-only over the workspace (D1 §7.3; D2 §2.3).
  for (const w of input.workspaceBinds ?? []) {
    const target = join(WORKSPACE, w.target);
    if (w.make === 'dir') b.dir(target);
    b.bind(w.source, { target, noTarget: w.make !== 'dir' });
  }
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
    volDirs: ['home', 'out', 'tmp', 'upper', 'work'],
    volEntries,
    skeleton: first.skeleton,
    fstab: first.fstab,
    late: b.late,
    lateFstab: b.lateFstab,
    tools: input.tools,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    initNode: '/.init/node',
    initScript: '/.init/init.js',
    ...(input.holdVolatile ? { holdVolatile: true } : {}),
    workspaceMount: rel(WORKSPACE),
  };
}

// One mount the plan makes, as the role's /proc/self/mountinfo shows it:
// its mount point inside the sandbox, its type (`bind` for a bind, whose
// filesystem is its source's) and whether it is read-only.
export interface PlannedMount {
  target: string;
  type: string;
  source: string;
  ro: boolean;
}

function parseLine(stage: string, line: string): PlannedMount {
  const [source, target, type, options] = line.split(' ') as [string, string, string, string];
  const opts = options.split(',');
  const inside = `/${relative(stage, unescape(target))}`;
  return { target: inside === '/' ? '/' : inside, type: type === 'none' && opts.includes('bind') ? 'bind' : type, source: unescape(source), ro: opts.includes('ro') };
}

// Every mount the plan makes, in order, the root first (D2 A.6 P12: the
// role's mount table is compared with it entry by entry).
export function plannedMounts(plan: Plan): PlannedMount[] {
  return [{ target: '/', type: 'tmpfs', source: 'surety-root', ro: true }, ...[...plan.fstab, ...plan.lateFstab].map((l) => parseLine(plan.stage, l))];
}

// The published plan (SEAM.md §133): one entry per mount of the role's
// root, in mount order, with its kind, its resolved host source where it has
// one, and the flags it carries.
export type EntryKind = 'root' | 'bind' | 'volatile' | 'proc' | 'devpts' | 'shm' | 'overlay' | 'cgroup';
export interface PlanEntry {
  target: string;
  kind: EntryKind;
  source: string | null;
  options: string[];
}

const FLAGS = ['ro', 'nosuid', 'nodev', 'noexec'];

export function planEntries(plan: Plan): PlanEntry[] {
  const out: PlanEntry[] = [{ target: '/', kind: 'root', source: null, options: ['ro', 'nosuid'] }];
  for (const l of [...plan.fstab, ...plan.lateFstab]) {
    const [rawSource, rawTarget, type, options] = l.split(' ') as [string, string, string, string];
    const opts = options.split(',');
    const source = unescape(rawSource);
    const rel = relative(plan.stage, unescape(rawTarget));
    const target = `/${rel}`;
    const flags = FLAGS.filter((f) => opts.includes(f));
    let kind: EntryKind;
    let src: string | null = null;
    if (type === 'proc') kind = 'proc';
    else if (type === 'devpts') kind = 'devpts';
    else if (type === 'tmpfs') kind = 'shm';
    else if (type === 'overlay') {
      kind = 'overlay';
      const lower = /(?:^|,)lowerdir=([^,]+)/.exec(options);
      src = lower ? unescape(lower[1]!) : null;
    } else if (source === plan.vol || source.startsWith(`${plan.vol}/`)) kind = 'volatile';
    else if (target.startsWith('/surety/cgroup/')) {
      kind = 'cgroup';
      src = source;
    } else {
      kind = 'bind';
      src = source;
    }
    out.push({ target, kind, source: src, options: flags });
  }
  return out;
}

// The plan's fingerprint over its entries with the domain's own paths taken
// out (the domain's area, its volatile filesystem, the run's checkout): two
// runs of one project under one profile and one policy have one fingerprint.
export function entriesFingerprint(entries: PlanEntry[], own: { area: string; workspace: string }): string {
  const strip = (p: string | null) =>
    p === null ? null : p.split(`${own.area}/`).join('<area>/').split(own.workspace).join('<checkout>');
  const shape = entries.map((e) => ({ ...e, source: strip(e.source) }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

// The fingerprint of what a plan makes visible (D2 §2.3: part of the profile
// qualified), over its structure with the domain's own paths taken out.
export function planFingerprint(plan: Plan): string {
  const strip = (s: string) => s.split(plan.stage).join('<root>').split(plan.vol).join('<vol>');
  const shape = {
    skeleton: plan.skeleton.map((e) => ({ ...e, content: e.content === undefined ? undefined : createHash('sha256').update(e.content).digest('hex') })),
    fstab: [...plan.fstab, ...plan.lateFstab].map(strip).filter((l) => !l.includes('/surety/context') && !l.includes('/surety/workspace') && !l.includes('/surety/git')),
    volBytes: plan.volBytes,
    volInodes: plan.volInodes,
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export const planIsBuildable = (input: PlanInput): boolean => existsSync(input.node) && existsSync(input.initScript);
