// The exhaustion lane's fixture service (row M341 only; SEAM.md §326; E69;
// BS4 §4.1 rules 8 and 10). NEVER deployed on the development workstation:
// only M341's file names it, and that file runs only where
// SURETY_EXHAUSTION_HOST names the host (mini-hp01).
//
// A dependency-free Node HTTP server on 127.0.0.1:$PORT: GET /hello answers;
// GET /act/alloc allocates past its memory limit; GET /act/fork starts
// `sleep` children until a start is refused. Each act refuses (403
// {"refused": [reasons]}) unless its guard, the instrument's half of E64's
// rule, passes from inside:
//   - SURETY_TEST_EXHAUST is "1" (set only by M341's configuration);
//   - SURETY_TEST_HOST_NS (the test's own `pid:[n],net:[n],mnt:[n]`)
//     differs from this process's pid, network and mount namespaces in all
//     three;
//   - /proc/1/comm is no system init;
//   - at most 16 processes are visible.
// Any failed read is a refusal. And each act bounds itself, whatever the
// cgroup does (E69 item 1): `alloc` stops at 128 MiB, 1 MiB at a time,
// touching every page; `fork` stops at 96 children, each `/usr/bin/sleep
// 300`, which never forks; a child is never signalled by this program (the
// domain's end removes them).

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFileSync, readlinkSync, readdirSync } = require('node:fs');

const MIB = 1024 * 1024;
const ALLOC_CEILING = 128 * MIB;
const FORK_CEILING = 96;

function guard() {
  const refused = [];
  if (process.env.SURETY_TEST_EXHAUST !== '1') refused.push('SURETY_TEST_EXHAUST is not 1');
  try {
    const host = Object.fromEntries((process.env.SURETY_TEST_HOST_NS ?? '').split(',').map((p) => p.split(':')).filter((p) => p.length === 2).map(([k, v]) => [k, `${k}:${v}`]));
    for (const kind of ['pid', 'net', 'mnt']) {
      const own = readlinkSync(`/proc/self/ns/${kind}`);
      if (!host[kind] || host[kind] === own) refused.push(`${kind} namespace is the host's or unknown`);
    }
  } catch {
    refused.push('namespaces unreadable');
  }
  try {
    const comm = readFileSync('/proc/1/comm', 'utf8').trim();
    if (['systemd', 'init'].includes(comm)) refused.push(`pid 1 is ${comm}`);
  } catch {
    refused.push('/proc/1/comm unreadable');
  }
  try {
    const procs = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
    if (procs > 16) refused.push(`${procs} processes visible`);
  } catch {
    refused.push('/proc unreadable');
  }
  return refused;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const held = [];
const children = [];

http
  .createServer((req, res) => {
    if (req.url === '/hello') return send(res, 200, { ok: true, pid: process.pid });
    if (req.url === '/act/alloc' || req.url === '/act/fork') {
      const refused = guard();
      if (refused.length > 0) return send(res, 403, { refused });
    }
    if (req.url === '/act/alloc') {
      let total = 0;
      const step = () => {
        if (total >= ALLOC_CEILING) return send(res, 200, { reached_ceiling: true, bytes: total });
        const block = Buffer.alloc(MIB, 1);
        held.push(block);
        total += MIB;
        setImmediate(step);
      };
      return step();
    }
    if (req.url === '/act/fork') {
      let error = null;
      while (children.length < FORK_CEILING && error === null) {
        try {
          const child = spawn('/usr/bin/sleep', ['300'], { stdio: 'ignore' });
          let failed = null;
          child.on('error', (err) => {
            failed = err.code ?? err.message;
          });
          if (child.pid === undefined) error = failed ?? 'no pid';
          else children.push(child.pid);
        } catch (err) {
          error = err.code ?? err.message;
        }
      }
      return send(res, 200, { spawned: children.length, error, ceiling: children.length >= FORK_CEILING });
    }
    return send(res, 404, { error: 'no such route' });
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
