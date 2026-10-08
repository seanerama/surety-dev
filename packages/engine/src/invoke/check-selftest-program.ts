// The runner self-test's check programs (D3 §2.8; SEAM.md §208): plain
// programs the self-test (checks/selftest.ts) runs as a check's own process
// in a real `check` domain, each beside a control. The self-test copies this
// file into its own check tree, as a protected input, and runs it with the
// engine's node. It lives under invoke/ because one of its modes starts a
// process (the spawn lint, row M74, allows that only here).
//
// It signals nothing. Every wait is bounded. It imports nothing of the
// engine's, only Node built-ins. Each mode acts only inside a check domain
// (E64; the guard of SEAM.md §§141, 198, modelled on the acceptance
// harness's check program): its pid, network and mount namespaces are each
// not the host's ones the engine names in `--host-ns`, pid 1's `comm` is no
// system init, and it sees at most 16 processes; any read that fails is a
// refusal: one line `SELFTEST refused <reasons>`, exit 94, nothing done.
//
// Arguments: `--host-ns pid:[n],net:[n],mnt:[n]`, then one mode:
//   exit <n>                     exit with status n
//   print <text> <n>             write <text> and a line ending; exit n
//   sleep <ms> <tag>             sleep <ms> (at most 120 s); exit 0 (<tag> names the case)
//   term-exit0 <ms>              exit 0 on SIGTERM; otherwise exit 0 after <ms> (at most 120 s)
//   orphan <ms>                  start one child, `child-sleep <ms>`, detached in a session of
//                                its own with standard input, output and error closed; write
//                                `SELFTEST-ORPHAN {"pid"}`; exit 0 at once
//   child-sleep <ms>             sleep (at most 120 s); exit 0; started only by `orphan`
//   egress <declared> <undeclared>
//                                for each host, one `CONNECT <host>:443` to the proxy that
//                                HTTPS_PROXY names, reading the status line (at most 10 s);
//                                write `SELFTEST-EGRESS {"proxy", "results"}`; exit 0
//   b01 <input> <source> <ms>    the SHA-256 of the input's bytes; one attempt to open the input
//                                for writing (no create, no truncate); one line written at the
//                                start of the source file; write `SELFTEST-B01 {…}`; then hold
//                                <ms> (at most 30 s), so the engine can read the mount table of
//                                this process; exit 0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync, writeSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const WAIT_MAX_MS = 120_000;
const HOLD_MAX_MS = 30_000;

const out = (line: string): void => {
  writeSync(1, `${line}\n`);
};
const bounded = (v: string | undefined, max: number): number => Math.max(0, Math.min(max, Number.parseInt(v ?? '0', 10) || 0));

// Inside a check domain, or a refusal (the guard; any failed read refuses).
function guard(hostNs: string | null): string[] {
  const why: string[] = [];
  if (hostNs === null) return ['no --host-ns'];
  const host: Record<string, string> = {};
  for (const part of hostNs.split(',')) {
    const at = part.indexOf(':');
    if (at > 0) host[part.slice(0, at)] = part.slice(at + 1);
  }
  for (const ns of ['pid', 'net', 'mnt']) {
    try {
      const mine = readlinkSync(`/proc/self/ns/${ns}`).replace(/^[a-z]+:/, '');
      if (host[ns] === undefined) why.push(`the host's ${ns} namespace is not named`);
      else if (mine === host[ns]) why.push(`the ${ns} namespace is the host's`);
    } catch {
      why.push(`the ${ns} namespace cannot be read`);
    }
  }
  try {
    const comm = readFileSync('/proc/1/comm', 'utf8').trim();
    if (['systemd', 'init', 'launchd'].includes(comm)) why.push(`pid 1 is ${comm}`);
  } catch {
    why.push('pid 1 cannot be read');
  }
  try {
    const n = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length;
    if (n > 16) why.push(`${n} processes are visible`);
  } catch {
    why.push('the processes cannot be counted');
  }
  return why;
}

function connectThrough(proxy: URL, host: string): Promise<{ host: string; status: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: string | null, error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ host, status, error });
    };
    const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) });
    const timer = setTimeout(() => finish(null, 'timeout'), 10_000);
    let text = '';
    socket.once('connect', () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    socket.on('data', (d: Buffer) => {
      text += d.toString('latin1');
      const at = text.indexOf('\r\n');
      if (at >= 0) finish(text.slice(0, at), null);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => finish(null, err.code ?? 'error'));
    socket.on('close', () => finish(null, 'closed'));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let hostNs: string | null = null;
  if (args[0] === '--host-ns') {
    hostNs = args[1] ?? null;
    args.splice(0, 2);
  }
  const [mode, ...rest] = args;
  // `child-sleep` only sleeps, started by `orphan` in the same domain.
  if (mode === 'child-sleep') {
    await sleep(bounded(rest[0], WAIT_MAX_MS));
    process.exit(0);
  }
  const refused = guard(hostNs);
  if (refused.length > 0) {
    out(`SELFTEST refused ${refused.join('; ')}`);
    process.exit(94);
  }
  switch (mode) {
    case 'exit':
      process.exit(bounded(rest[0], 255));
      break;
    case 'print':
      out(rest[0] ?? '');
      process.exit(bounded(rest[1], 255));
      break;
    case 'sleep':
      await sleep(bounded(rest[0], WAIT_MAX_MS));
      process.exit(0);
      break;
    case 'term-exit0': {
      process.on('SIGTERM', () => process.exit(0));
      await sleep(bounded(rest[0], WAIT_MAX_MS));
      process.exit(0);
      break;
    }
    case 'orphan': {
      const child = spawn(process.execPath, [process.argv[1]!, 'child-sleep', String(bounded(rest[0], WAIT_MAX_MS))], { detached: true, stdio: 'ignore' });
      child.unref();
      out(`SELFTEST-ORPHAN ${JSON.stringify({ pid: child.pid ?? null })}`);
      process.exit(0);
      break;
    }
    case 'egress': {
      let proxy: URL | null = null;
      try {
        proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
      } catch {
        proxy = null;
      }
      const results = [];
      for (const host of rest.slice(0, 2)) results.push(proxy === null ? { host, status: null, error: 'no_proxy' } : await connectThrough(proxy, host));
      out(`SELFTEST-EGRESS ${JSON.stringify({ proxy: proxy === null ? null : proxy.host, results })}`);
      process.exit(0);
      break;
    }
    case 'b01': {
      const [input, source, hold] = rest;
      const report: Record<string, unknown> = { input, source };
      try {
        report.input_sha256 = createHash('sha256').update(readFileSync(input!)).digest('hex');
      } catch (err) {
        report.input_sha256 = null;
        report.input_read = (err as NodeJS.ErrnoException).code ?? 'error';
      }
      // One attempt to write the input: never create, never truncate.
      try {
        const fd = openSync(input!, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          writeSync(fd, 'SELFTEST-WROTE\n', 0);
        } finally {
          closeSync(fd);
        }
        report.input_write = 'ok';
      } catch (err) {
        report.input_write = (err as NodeJS.ErrnoException).code ?? 'error';
      }
      // An ordinary source write, which succeeds in the domain only.
      try {
        const fd = openSync(source!, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          writeSync(fd, 'SELFTEST-WROTE\n', 0);
        } finally {
          closeSync(fd);
        }
        report.source_write = 'ok';
      } catch (err) {
        report.source_write = (err as NodeJS.ErrnoException).code ?? 'error';
      }
      out(`SELFTEST-B01 ${JSON.stringify(report)}`);
      await sleep(bounded(hold, HOLD_MAX_MS));
      process.exit(0);
      break;
    }
    default:
      out(`SELFTEST unknown mode ${String(mode)}`);
      process.exit(2);
  }
}

void main();
