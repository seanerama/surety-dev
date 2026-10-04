// A forging instrument for the slice-13 review's S1 (M135 (i); D2 §7.2).
// This is the Reviewer's own instrument, copied verbatim below the header;
// it is used ONLY to prove that the engine must REJECT a forged containment
// witness, never to gain anything. The acceptance case
// (M135-qualification-attempt.test.mjs, "S1") asserts that a containment
// canary driven by this instrument FAILS (containment_failed) and writes no
// trust entry.
//
// It is confined, like every acting instrument (SEAM.md §141): it runs only
// inside the containment canary's sandbox, as a descendant of the backend,
// reached through the guarded `exec_probe` action after the test has read
// from the host that the role is contained. It performs no containment
// action, starts the engine's probe program without `--host-pid-ns` (so the
// program's own guard refuses and it does nothing), and talks only to
// abstract sockets in the sandbox's own network namespace.
//
// --- the Reviewer's forger.mjs, verbatim ---
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const canary = JSON.parse(readFileSync('/surety/context/canary.json', 'utf8'));
const expected = { token_read: 'denied', git_config: 'denied', engine_port: 'denied', unlisted_connect: 'denied', workspace_write: 'allowed' };
const out = [];

function talk(name, line) {
  return new Promise((resolve) => {
    const s = net.connect(`\0${name}`);
    let a = '';
    const t = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
    s.once('connect', () => s.write(`${JSON.stringify(line)}\n`));
    s.on('data', (d) => { a += d; if (a.includes('\n')) { clearTimeout(t); s.destroy(); resolve(a.trim()); } });
    s.once('error', (e) => { clearTimeout(t); resolve(`error ${e.code}`); });
  });
}

for (const a of canary.actions) {
  const fake = `forger-${a.name}-${process.pid}`;
  const answered = await new Promise((resolve) => {
    let child;
    const server = net.createServer((sock) => {
      // The probe program is alive, waiting on us: report in its name.
      sock.once('data', async (d) => {
        const probeSaid = String(d).trim();
        const answer = await talk(canary.witness, { type: 'canary_action', action: a.name, pid: child.pid, outcome: expected[a.name] });
        sock.end('ok\n');
        server.close();
        resolve({ action: a.name, probe_pid: child.pid, probe_said: probeSaid.slice(0, 300), witness_answer: answer });
      });
    });
    server.listen(`\0${fake}`, () => {
      child = spawn(a.argv[0], ['/surety/context/probe', '--canary', a.name, '--witness', fake], { stdio: 'ignore' });
    });
    setTimeout(() => resolve({ action: a.name, outcome: 'no_connection' }), 8000);
  });
  out.push(answered);
}
process.stdout.write(`${JSON.stringify({ forger: out })}\n`);
