// Developer tests for the service profile's engine programs (D7 §5.7;
// SEAM.md §499; the slice-42 review): the design preview's server is bound
// read-only at its own path in the plan's second phase, after the volatile
// /tmp is mounted, so an engine installed under /tmp is not hidden by the
// domain's /tmp. The plan is built only; nothing is mounted or run.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildServicePlan } = await import(join(root, 'dist', 'deploy', 'service-profile.js'));

const plan = (programs) => {
  const node = process.execPath;
  return buildServicePlan(
    {
      area: '/<area>',
      sealed: dirname(node),
      runtime: node,
      ingress: node,
      volBytes: 64 * 1024 * 1024,
      volInodes: 1024,
      tools: { mount: '/<mount>', umount: '/<umount>', pivot_root: '/<pivot_root>', ip: '/<ip>', unshare: '/<unshare>', setpriv: '/<setpriv>', mknod: '/<mknod>' },
      node,
      initNodeCopy: node,
      initScript: node,
      ...(programs ? { programs } : {}),
    },
    [],
  );
};

test('an engine program under /tmp is bound after the volatile /tmp, at its own path, read-only and not executable', (t) => {
  const base = mkdtempSync('/tmp/svc-plan-');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const program = join(base, 'eng', 'dist', 'design', 'preview', 'server.mjs');
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, 'export {};\n');
  const p = plan([program]);
  const target = `/<area>/root${program}`;
  const tmpLine = p.fstab.findIndex((l) => l.split(' ')[1] === '/<area>/root/tmp');
  assert.ok(tmpLine >= 0, 'the volatile /tmp is mounted in the first phase');
  assert.ok(!p.fstab.some((l) => l.split(' ')[1] === target), 'the program is not bound in the first phase, under /tmp');
  const line = p.lateFstab.find((l) => l.split(' ')[1] === target);
  assert.ok(line, `the program is bound in the second phase (${JSON.stringify(p.lateFstab)})`);
  const [source, , , options] = line.split(' ');
  assert.equal(source, realpathSync(program));
  assert.match(options, /(^|,)ro(,|$)/);
  assert.match(options, /(^|,)noexec(,|$)/);
  assert.ok(p.late.some((e) => e.path === program.slice(1) && e.kind === 'file'), 'its mount point made in the second phase (its directories with it)');
});

test('no program: the plan is the same shape as before (the qualified profile\'s fingerprint does not move)', () => {
  const a = plan(undefined);
  const b = plan([]);
  assert.deepEqual([a.fstab, a.lateFstab, a.late], [b.fstab, b.lateFstab, b.late]);
});
