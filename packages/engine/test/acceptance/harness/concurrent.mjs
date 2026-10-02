// Run several concurrent-insert.mjs children against one store file.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'concurrent-insert.mjs');

// The children meet at an instant of the monotonic clock, which on Linux is
// one clock for every process (process.hrtime.bigint(), in nanoseconds). A
// wall-clock instant moves when the host's clock steps (SEAM.md §24, "The
// harness's own waits"): after a step forward the children would not wait
// for one another, and after a step back they would spin for as long as the
// step.
export async function concurrentInserts(file, table, rows, { leadMs = 750 } = {}) {
  const startAt = process.hrtime.bigint() + BigInt(leadMs) * 1_000_000n;
  const runs = rows.map(
    (row) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, file, table, JSON.stringify(row), String(startAt)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        child.on('error', reject);
        child.on('exit', (code) => {
          try {
            resolve(JSON.parse(out.trim().split('\n').at(-1)));
          } catch {
            reject(new Error(`concurrent insert child exited ${code}: ${err || out}`));
          }
        });
      }),
  );
  return Promise.all(runs);
}
