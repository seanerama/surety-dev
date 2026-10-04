// The test's half of the exhaustion instruments (M2 slice 13 part 3; SEAM.md
// §155; E64 item 2, E69). Exhaustion lane only: these helpers are used by
// files listed under the manifest's `exhaust` key, which the runner runs
// only on a host named by SURETY_EXHAUSTION_HOST (mini-hp01), never on the
// development workstation.
//
// A role is released into an exhausting action only after the host has
// read (1) that its process is contained (assertContained: a member of its
// domain's cgroup, an inner pid, its own pid, net and mnt namespaces) and
// (2) that its domain's limits are exactly the case's: `pids.max`,
// `memory.max`, `memory.swap.max` 0, and the volatile filesystem's size and
// inodes as the role's own mount table shows them. Anything else, `max`
// included, and anything that cannot be read, fails the case before the
// release.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { newId } from '../ids.mjs';
import { armedRole } from './view.mjs';

const MIB = 1024 * 1024;

// Sean's caps (E69 item 1). The role program refuses any step whose caps
// exceed these (harness/scripted/child.mjs, SEAN_CAPS).
export const CAPS = Object.freeze({ pids_max: 64, memory_max: 64 * MIB, writable_bytes: 1 * MIB, writable_inodes: 64 });

// A work item whose every domain has `caps` as its limits (the trigger
// fixture's harness-only `domain_limits`, SEAM.md §155).
export async function addLimitedWork(fx, project, caps = CAPS, kind = 'verification') {
  const res = await fx.engine.post('/v1/harness/fixtures/trigger', { project, kind, trigger_source: 'test', trigger_id: newId('trg_'), trigger_generation: 1, domain_limits: { ...caps } });
  assert.equal(res.status, 201, `a ${kind} trigger with domain_limits ${JSON.stringify(caps)} (body: ${res.text})`);
  return res.body.work_item.id;
}

const unit = { k: 1024, m: MIB, g: 1024 * MIB };
const sizeOf = (v) => {
  const m = /^(\d+)([kmg]?)$/i.exec(v ?? '');
  return m ? Number(m[1]) * (unit[m[2].toLowerCase()] ?? 1) : null;
};

// The volatile filesystem's bounds as the role's own mount table shows them
// (the superblock options of the tmpfs mounted at /surety/home).
export function volatileBoundsOf(pid) {
  const lines = readFileSync(`/proc/${pid}/mountinfo`, 'utf8').split('\n').filter(Boolean);
  const line = lines.find((l) => l.split(' ')[4] === '/surety/home');
  assert.ok(line, `host-read: the role's mount table has /surety/home (${lines.length} mounts)`);
  const [, right] = line.split(' - ');
  const [fstype, , superopts = ''] = right.split(' ');
  const opts = Object.fromEntries(superopts.split(',').map((o) => o.split('=')));
  return { fstype, bytes: sizeOf(opts.size), inodes: opts.nr_inodes === undefined ? null : Number(opts.nr_inodes) };
}

const readLimit = (dir, file) => readFileSync(join(dir, file), 'utf8').trim();

// The test's half (SEAM.md §155): the domain's limits, read from the host,
// equal the case's. Called after assertContained (armedRole) and before the
// release.
export function assertDomainCaps(domain, member, caps) {
  const dir = domain.cgroup_path;
  assert.equal(readLimit(dir, 'pids.max'), String(caps.pids_max), `host-read: the domain's pids.max is the case's ${caps.pids_max}; anything else, max included, is not released`);
  assert.equal(readLimit(dir, 'memory.max'), String(caps.memory_max), `host-read: the domain's memory.max is the case's ${caps.memory_max}`);
  assert.equal(readLimit(dir, 'memory.swap.max'), '0', 'host-read: the domain cannot swap');
  const vol = volatileBoundsOf(member.pid);
  assert.equal(vol.fstype, 'tmpfs', 'the volatile filesystem is a tmpfs');
  assert.deepEqual([vol.bytes, vol.inodes], [caps.writable_bytes, caps.writable_inodes], `host-read from the role's mount table: the volatile filesystem's size and inodes are the case's (${JSON.stringify(vol)})`);
}

// armedRole with the second test-side check: the role holds at "armed", the
// host reads it contained (armedRole) and its domain's limits the case's,
// and only then may the case call release().
export async function limitedRole(fx, project, item, caps, opts) {
  const armed = await armedRole(fx, project, item, opts);
  assertDomainCaps(armed.domain, armed.member, caps);
  return armed;
}
