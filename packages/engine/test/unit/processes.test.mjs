// Developer tests for the process helpers (src/invoke/processes.ts): only "no
// such process" is gone; a live process found by its marker is a member.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { processState, scanDomain } = await import(join(dist, 'invoke', 'processes.js'));
const { processStartTime } = await import(join(dist, 'lock.js'));

test('a recorded process is the same while it lives, and gone once it has exited or its start time differs', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const start = processStartTime(child.pid);
  assert.equal(processState(child.pid, start), 'same');
  assert.equal(processState(child.pid, `${start}1`), 'gone', 'a different start time is another process');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(processState(child.pid, start), 'gone');
  assert.equal(processState(2 ** 22 + 1, '1'), 'gone', 'no such pid');
});

test('a scan finds the live processes that carry the domain marker, and nothing else', async (t) => {
  const domain = 'dom_UNITTESTSCAN0000000000000';
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', env: { PATH: process.env.PATH, SURETY_DOMAIN: domain } });
  t.after(() => child.kill('SIGKILL'));
  await sleep(100);
  const scan = scanDomain(domain);
  assert.deepEqual(scan.members.map((p) => p.pid), [child.pid]);
  assert.ok(!scan.unreadable.includes(child.pid));
  assert.deepEqual(scanDomain('dom_UNITTESTNOBODY000000000000').members, []);
});
