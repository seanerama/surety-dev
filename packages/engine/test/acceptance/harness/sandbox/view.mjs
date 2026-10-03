// What a role sees and reaches from inside the sandbox, and how a test
// reads it (M2 slice 12, rows M119 to M128; D2 §§1.2, 1.3, 2.3 to 2.8, A.6;
// SEAM.md §§132 to 141).
//
// A sandbox-lane test never trusts what a role prints: the role's probe
// entries (harness/scripted/child.mjs) say what the role attempted and what
// it got, and the host side corroborates every claim, here or in the case.
//
// SAFETY (E64 item 2; SEAM.md §141). Every probe of this slice that writes
// outside the role's own files, connects or executes is released in two
// halves: the role program refuses it unless its step carries the host's
// pid, network and mount namespaces and its own are three others, and the
// test releases the role into it only after `assertContained` has read,
// from the host, that the role's process is a member of its domain's
// cgroup, has a pid of its own in an inner pid namespace, and is in a pid,
// a network and a mount namespace other than the test's. `armedRole` is the
// one way the cases dispatch such a role.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { confirmRequired, consume } from '../decisions.mjs';
import { makeTempDir, removeDir, sha256Hex, waitFor } from '../engine.mjs';
import { newId } from '../ids.mjs';
import { getPolicy } from '../journal.mjs';
import { readRun } from '../reads.mjs';
import { recordFile, recordRow } from '../records.mjs';
import { assertRunEnded, requestTick, runsOf, stopRun, tick, waitForRun, waitForRunState, waitForWork } from '../runs.mjs';
import { VALID_RESULT, acting, hostNamespaces, namespacesOf, script, step } from '../scripted.mjs';
import { eventsNamed } from '../trust.mjs';
import { cgroupOfPid } from './cgroup.mjs';
import { domainOf, roleProcess } from './lane.mjs';

// ---- containment, read from the host -----------------------------------------------------

// The test's half of the guard (SEAM.md §141): the role's process, as the
// host sees it, is inside its domain's cgroup and in namespaces of its own.
// Anything that cannot be read is a failure: unknown is not contained.
export function assertContained(domain, member, what = 'the role') {
  const host = hostNamespaces();
  assert.ok(domain?.cgroup_path, `${what}: its domain has a cgroup (host-read from the store)`);
  assert.equal(cgroupOfPid(member.pid), domain.cgroup_path, `${what}: host-read, its process is a member of its domain's cgroup`);
  assert.ok(member.nspid.length >= 2, `${what}: host-read, it has a pid of its own in an inner pid namespace (NSpid ${member.nspid.join(' ')})`);
  const own = namespacesOf(member.pid);
  for (const kind of ['pid', 'net', 'mnt']) {
    assert.ok(own[kind] !== null && new RegExp(`^${kind}:\\[\\d+\\]$`).test(own[kind]), `${what}: host-read, its ${kind} namespace can be read (${own[kind]})`);
    assert.notEqual(own[kind], host[kind], `${what}: host-read, it is not in the host's ${kind} namespace; only then is it released into an acting probe`);
  }
  return { host, own };
}

// A work item of a kind, dispatched under a profile (SEAM.md §127: the
// trigger fixture's `profile`).
export async function addProfiledWork(fx, project, kind = 'verification', { profile = 'probe', subject } = {}) {
  const body = { project, kind, trigger_source: 'test', trigger_id: newId('trg_'), trigger_generation: 1, profile };
  if (subject !== undefined) body.subject = subject;
  const res = await fx.engine.post('/v1/harness/fixtures/trigger', body);
  assert.equal(res.status, 201, `a ${kind} trigger with profile ${profile} (body: ${res.text})`);
  return res.body.work_item.id;
}

// Dispatch `item`. Its role runs `before` (probes that only read), then
// holds at "armed"; the test reads from the host that the role is contained;
// `release()` lets the role run `acts(acting(hostNs))` (the guarded probes)
// and `after`, send a valid result (unless `result` is false) and exit, and
// waits for the run to end. With `thenHold`, the role sends no result and
// holds again at "done" after its steps: `release()` then returns once it
// is there, so that the host can be read with the role's steps behind it and
// its domain still alive, and `stop()` ends the run by a Stop. Returns {run,
// domain, launch, member, release, stop, probes, probe, gits}: `probes(action)`
// are the role's entries of that action, `probe(action, label)` the one
// entry, required to exist; `gits()` its `git` steps' entries in order.
export async function armedRole(fx, project, item, { before = [], acts = () => [], after = [], result = {}, thenHold = false, on_term = 'exit', timeoutMs = 90_000 } = {}) {
  const hostNs = hostNamespaces();
  const ending = thenHold ? [step.hold('done')] : result === false ? [] : [step.result({ ...VALID_RESULT, ...result })];
  const steps = [...before, step.hold('armed'), ...acts(acting(hostNs)), ...after, ...ending];
  // The item's next launch follows this script, whichever launch of the item
  // that is (a resumed item's second, say: objection 009); the holding role
  // is that launch's, not an earlier one's.
  const prior = fx.scripted.launches({ work_item: item }).length;
  fx.scripted.script(item, Array.from({ length: prior + 1 }, () => ({ steps, on_term })));
  await tick(fx.engine, project);
  await fx.scripted.waitForLaunch({ work_item: item }, { count: prior + 1 });
  const launch = await fx.scripted.waitForHolding({ work_item: item }, 'armed');
  assert.equal(launch.launch_index, prior, `the holding role is the item's launch ${prior + 1}`);
  // The run of the launch that holds, not the item's first run: a resumed
  // item's holding role is its latest run's (objection 009).
  assert.ok(launch.run, `the holding launch names its run (${JSON.stringify(launch.request_keys)})`);
  const run = await waitForRunState(fx.home, launch.run, 'executing');
  const domain = domainOf(fx.home, run.id);
  const member = await roleProcess(fx, domain, launch);
  assertContained(domain, member, `the role of ${item}`);
  const probes = (action, label) => fx.scripted.probes(launch.invocation, action).filter((p) => label === undefined || p.label === label);
  const probe = (action, label) => {
    const found = probes(action, label);
    assert.equal(found.length, 1, `the role logged one ${action} probe${label === undefined ? '' : ` labelled ${label}`} (it logged ${found.length}; all: ${fx.scripted.probes(launch.invocation).map((p) => `${p.action}${p.label ? `:${p.label}` : ''}`).join(', ') || 'none'})`);
    if (found[0].guard !== undefined) assert.notEqual(found[0].outcome, 'refused_unsandboxed', `the role program's own guard let ${action} run inside the sandbox (${JSON.stringify(found[0].guard)})`);
    return found[0];
  };
  const gits = () => fx.scripted.eventsOfInvocation(launch.invocation, 'git');
  const release = async () => {
    fx.scripted.release(item, 'armed');
    if (thenHold) return fx.scripted.waitForHolding({ work_item: item }, 'done', { timeoutMs });
    return waitForRunState(fx.home, run.id, 'ended', { timeoutMs });
  };
  const stop = async () => {
    await stopRun(fx.engine, project, run.id);
    return waitForRunState(fx.home, run.id, 'ended', { timeoutMs });
  };
  return { run, domain, launch, member, hostNs, release, stop, probes, probe, gits };
}

// The same, released at once: for a role whose probes need nothing read
// from the host while it holds beyond its containment.
export async function probedRun(fx, project, item, opts = {}) {
  const armed = await armedRole(fx, project, item, opts);
  const ended = await armed.release();
  return { ...armed, ended };
}

// By path: the results of an `open_paths`, `list_dirs` or `stat_paths` probe.
export const byPath = (probe) => Object.fromEntries((probe.results ?? []).map((r) => [r.path, r]));

// ---- the published mount plan (SEAM.md §133) --------------------------------------------

const PLAN_KINDS = ['root', 'bind', 'volatile', 'proc', 'devpts', 'shm', 'overlay', 'cgroup'];
const FLAGS = ['ro', 'nosuid', 'nodev', 'noexec'];
// File systems that carry the host, or Windows, into a mount table (D2 §2.3;
// A.6 P12): none may appear in a role's.
const FORBIDDEN_FSTYPES = /^(9p|drvfs|virtiofs|fuse(\..*)?|fuseblk|cifs|nfs\d?)$/;

// The run read's `mount_plan` and the record it names, parsed and checked
// for its form: {profile, fingerprint, record, entries, row}.
export async function mountPlanOf(fx, project, runId) {
  const shown = await readRun(fx.engine, project, runId);
  const mp = shown.mount_plan;
  assert.ok(mp && typeof mp === 'object', `the run read has mount_plan once the plan was validated for its launch (run keys: ${Object.keys(shown).join(', ')}; mount_plan: ${JSON.stringify(mp ?? null)})`);
  assert.ok(['role', 'probe'].includes(mp.profile), `mount_plan.profile is the domain's profile (${JSON.stringify(mp.profile)})`);
  assert.match(String(mp.fingerprint), /^[0-9a-f]{64}$/, `mount_plan.fingerprint is a SHA-256 in hex (${JSON.stringify(mp.fingerprint)})`);
  const row = recordRow(fx.home, mp.record);
  assert.ok(row, `mount_plan.record names a record (${JSON.stringify(mp.record)})`);
  assert.deepEqual(
    { kind: row.kind, published: row.published, project: row.project, run: row.run },
    { kind: 'qualification_evidence', published: 1, project, run: runId },
    'the validated plan is published as a qualification_evidence record of the run',
  );
  const bytes = readFileSync(recordFile(fx.home, row));
  assert.equal(sha256Hex(bytes), row.sha256, 'the record\'s bytes are the ones the store names');
  const doc = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual({ profile: doc.profile, fingerprint: doc.fingerprint }, { profile: mp.profile, fingerprint: mp.fingerprint }, 'the record is the plan the run read names');
  assert.ok(Array.isArray(doc.entries) && doc.entries.length > 0, 'the plan lists its entries');
  for (const e of doc.entries) {
    assert.ok(typeof e.target === 'string' && e.target.startsWith('/'), `a plan entry has an absolute target (${JSON.stringify(e)})`);
    assert.ok(PLAN_KINDS.includes(e.kind), `a plan entry's kind is one of ${PLAN_KINDS.join(', ')} (${JSON.stringify(e)})`);
    assert.ok(Array.isArray(e.options) && e.options.every((o) => FLAGS.includes(o)), `a plan entry's options are among ${FLAGS.join(', ')} (${JSON.stringify(e)})`);
    if (['bind', 'overlay', 'cgroup'].includes(e.kind)) assert.ok(typeof e.source === 'string' && e.source.startsWith('/'), `a ${e.kind} entry names its host source (${JSON.stringify(e)})`);
    else assert.equal(e.source ?? null, null, `a ${e.kind} entry has no host source (${JSON.stringify(e)})`);
  }
  return { ...mp, entries: doc.entries, document: doc, row };
}

const unescape = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

// /proc/<pid>/mountinfo lines, parsed: {point, root, options, fstype, source, superopts}.
export function parseMountinfo(lines) {
  return lines.map((line) => {
    const [left, right] = line.split(' - ');
    const fields = left.split(' ');
    const [fstype, source, superopts = ''] = right.split(' ');
    return { point: unescape(fields[4]), root: unescape(fields[3]), options: fields[5].split(','), fstype, source: unescape(source), superopts, line };
  });
}

// This process's own mount table: the host's.
export const hostMounts = () => parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean));

const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

// The role's mount table equals the validated plan, entry by entry (D2 §2.3,
// A.6 P12; SEAM.md §133): one mount per plan entry and no other; each of the
// kind the plan says, read-only exactly where the plan says and carrying at
// least the flags it lists; each bind the very directory or file the plan
// names (the same device and inode as the host sees at the source); no file
// system that carries the host in; no source that is, holds or is inside
// the control plane. `table` is the role's `mount_table` probe; `ctx` gives
// {home, domain, workspace} (the engine home, the domain id, the run's
// checkout).
export function assertMountTableIsPlan(table, plan, ctx) {
  const mounts = parseMountinfo(table.mountinfo);
  assert.ok(mounts.length > 0, 'the fixture is live: the role read its mount table');
  const sorted = (xs) => [...xs].sort();
  assert.deepEqual(sorted(mounts.map((m) => m.point)), sorted(plan.entries.map((e) => e.target)), 'the mount points of the role\'s table are the plan\'s targets: one mount per entry and no other');
  const fstypeOf = { volatile: 'tmpfs', shm: 'tmpfs', proc: 'proc', devpts: 'devpts', overlay: 'overlay', root: 'tmpfs' };
  for (const e of plan.entries) {
    const m = mounts.find((x) => x.point === e.target);
    const what = `${e.target} (${e.kind}${e.source ? ` of ${e.source}` : ''})`;
    assert.ok(!FORBIDDEN_FSTYPES.test(m.fstype), `${what}: its file system is none that carries the host in (${m.fstype})`);
    assert.ok(!/drvfs/i.test(`${m.source} ${m.superopts}`), `${what}: it is no DrvFs mount (${m.source} ${m.superopts})`);
    if (fstypeOf[e.kind] !== undefined) assert.equal(m.fstype, fstypeOf[e.kind], `${what}: mounted as the plan's kind says`);
    if (e.kind === 'cgroup') assert.equal(m.fstype, 'cgroup2', `${what}: a cgroup2 directory`);
    assert.equal(m.options.includes('ro'), e.options.includes('ro'), `${what}: read-only exactly where the plan says (table: ${m.options.join(',')}; plan: ${e.options.join(',')})`);
    for (const flag of e.options) assert.ok(m.options.includes(flag), `${what}: the table carries the plan's ${flag} (table: ${m.options.join(',')})`);
    if (e.kind === 'bind' || e.kind === 'cgroup') {
      const inside = table.points[e.target];
      assert.ok(inside && inside.error === undefined, `${what}: the role could stat what is mounted there (${JSON.stringify(inside)})`);
      const host = statSync(e.source);
      assert.deepEqual([inside.dev, inside.ino], [String(host.dev), String(host.ino)], `${what}: host-read, what is mounted there is the very ${host.isDirectory() ? 'directory' : 'file'} the plan names (device and inode)`);
    }
    if (e.source) {
      const s = e.source;
      const home = ctx.home;
      assert.ok(!within(home, s), `${what}: its source neither is nor holds the engine home`);
      if (within(s, home)) {
        const own = [join(home, 'domains', ctx.domain), ctx.workspace];
        const control = ['api.token', 'store.db', 'store.db-wal', 'store.db-shm', 'engine.lock', 'engine.log', 'config.json', 'records', 'backups'].map((n) => join(home, n));
        assert.ok(!control.some((c) => within(s, c)), `${what}: its source is no control-plane file of the engine home`);
        for (const shared of ['domains', 'workspaces']) {
          if (within(s, join(home, shared))) assert.ok(own.some((o) => within(s, o)), `${what}: a source under ${shared}/ is this domain's own area or this run's own checkout, never another's and never the directory of them all`);
        }
      }
    }
  }
  assert.deepEqual(mounts.filter((m) => within(m.point, '/mnt')).map((m) => m.point), [], 'nothing is mounted under /mnt');
  return mounts;
}

// ---- seeded targets --------------------------------------------------------------------

// D2 §2.3's enumerated operator credential locations, each a directory or a file.
export const CREDENTIAL_LOCATIONS = Object.freeze([
  ['.ssh', 'dir'],
  ['.gnupg', 'dir'],
  ['.aws', 'dir'],
  ['.config/gh', 'dir'],
  ['.claude', 'dir'],
  ['.codex', 'dir'],
  ['.docker', 'dir'],
  ['.kube', 'dir'],
  ['.netrc', 'file'],
  ['.git-credentials', 'file'],
  ['.npmrc', 'file'],
]);

// A disposable operator home (the engine's HOME for the test; NEVER the
// user's real one) with every enumerated credential location seeded and
// read back from the host: {home, seeded: [{rel, kind, path, sentinel, sha256}]}.
export function seedOperatorHome(t) {
  const home = makeTempDir('operator');
  t.after(() => removeDir(home));
  const seeded = CREDENTIAL_LOCATIONS.map(([rel, kind]) => {
    const path = join(home, rel);
    const content = `sentinel credential ${rel} ${randomBytes(8).toString('hex')}\n`;
    let sentinel = path;
    if (kind === 'dir') {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      sentinel = join(path, 'sentinel');
    } else mkdirSync(dirname(path), { recursive: true });
    writeFileSync(sentinel, content, { mode: 0o600 });
    assert.equal(readFileSync(sentinel, 'utf8'), content, `the target is seeded and host-readable: ${sentinel}`);
    return { rel, kind, path, sentinel, sha256: sha256Hex(content) };
  });
  return { home, seeded };
}

// A sentinel file with random content, read back from the host: {path, content, sha256}.
export function seedSentinel(path, label = 'sentinel') {
  mkdirSync(dirname(path), { recursive: true });
  const content = `${label} ${randomBytes(8).toString('hex')}\n`;
  writeFileSync(path, content);
  assert.equal(readFileSync(path, 'utf8'), content, `the target is seeded and host-readable: ${path}`);
  return { path, content, sha256: sha256Hex(content) };
}

// The forms by which a role could name a host path (D2 A.6 P1): the path
// itself, through /proc/self/root, and through `..` from where it stands.
export const aliasesOf = (path) => [path, `/proc/self/root${path}`, `/surety/workspace/../..${path}`, `/proc/self/cwd/../..${path}`];

// ---- a widening, approved (SEAM.md §§78, 115; as row M108 approves one) ----------------

const atRevision = (fx, project, n) =>
  waitFor(
    async () => {
      const policy = await getPolicy(fx.engine, project);
      return policy.revision === n ? policy : undefined;
    },
    { what: `policy revision ${n} to be effective` },
  );

export async function approveWidening(fx, project, change) {
  const [key] = Object.keys(change);
  const before = await getPolicy(fx.engine, project);
  const previewed = await confirmRequired(fx, `/v1/projects/${project}/policy`, change);
  assert.deepEqual([previewed.kind, previewed.manifest.widens], ['policy_widening', [key]], `${key}: the submission raises a widening that names the key`);
  await consume(fx, project, previewed, 'approve');
  const policy = await atRevision(fx, project, (before.revision ?? 0) + 1);
  assert.deepEqual(policy.effective[key], change[key], `${key}: approved, the effective policy holds the value`);
  return policy;
}

// ---- a dispatch refused before any launcher starts (SEAM.md §§116, 120) -----------------

// Tick, and require the item's run to end `refused` / `preflight_refused`
// with `code`, nothing launched: no launcher placed, no scripted launch. The
// project parks a refused item at once (PARK_ON_REFUSAL). Returns {run, shown}.
export async function refusedBeforeLaunch(fx, project, item, code, what) {
  const launches = fx.scripted.launches().length;
  // A role that is launched after all finishes at once, so that the case
  // fails at its assertion and not at a wait.
  fx.scripted.script(item, [script.complete()]);
  await requestTick(fx.engine, project);
  const run = await waitForRun(fx.home, item, { state: 'ended' });
  assertRunEnded(fx.home, run.id, { outcome: 'refused', reason_class: 'preflight_refused', launched: false, recovery: false });
  assert.equal(fx.scripted.launches().length, launches, `${what}: no role was launched`);
  assert.deepEqual(eventsNamed(fx.home, 'domain.placed').filter((event) => event.subject?.run === run.id), [], `${what}: no launcher was placed`);
  const shown = await readRun(fx.engine, project, run.id);
  assert.equal(shown.code, code, `${what}: the run read carries the code (refusal: ${JSON.stringify(shown.refusal ?? null)})`);
  assert.equal(shown.refusal?.code, code, `${what}: and the refusal in its form`);
  const parked = await waitForWork(fx.home, item, 'parked');
  assert.equal(runsOf(fx.home, item).length, 1, `${what}: the one refusal parks the item (${parked.status})`);
  return { run, shown };
}

// ---- descriptors (D2 §2.3 "nothing is inherited"; A.6 P14; as row M117 (c) judges them) --

// Of a `self_status` probe's descriptor table, those beyond 0 to 2 that are
// not the runtime's own: an anonymous inode, /dev/null or a random device, a
// pipe both of whose ends are in the same table (or one of 0 to 2). What is
// left was inherited.
export function inheritedDescriptors(fds) {
  const own = Object.entries(fds).filter(([fd]) => Number(fd) > 2);
  const pipeEnds = Object.values(fds).filter((v) => v.startsWith('pipe:'));
  const stdPipes = new Set(['0', '1', '2'].map((fd) => fds[fd]).filter((v) => v?.startsWith('pipe:')));
  return own.filter(([, target]) => {
    if (target.startsWith('anon_inode:')) return false;
    if (target === '/dev/null' || target === '/dev/urandom' || target === '/dev/random') return false;
    if (target.startsWith('unreadable:')) return false;
    if (target.startsWith('pipe:')) return !(pipeEnds.filter((v) => v === target).length >= 2 || stdPipes.has(target));
    return true;
  });
}
