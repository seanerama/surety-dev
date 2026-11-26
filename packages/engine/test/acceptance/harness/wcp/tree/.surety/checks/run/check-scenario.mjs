// A UI acceptance check of a criterion's scenario in a named scenario file
// (scenarios/<name>.mjs): runs each session in a child process (lib/page.mjs)
// against the candidate's public/ and judges the report it prints. Exits
// nonzero unless every session reports completion and every assertion holds.
//
//   node .surety/checks/run/check-scenario.mjs <scenario file name> <criterion>

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] || '';
const criterion = process.argv[3] || '';
if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !/^R\d+\.\d+$/.test(criterion)) { console.log('usage: check-scenario.mjs <scenario file name> <criterion>'); process.exit(2); }
const scenarioFile = path.join(here, 'scenarios', name + '.mjs');
const { scenarios } = await import(pathToFileURL(scenarioFile).href);
const def = scenarios[criterion];
if (!def || !def.sessions.length) { console.log(`no scenario for ${criterion}`); process.exit(2); }

let failed = false;
let total = 0;
let storage = def.storage || {};
let carry = null;
console.log(`${criterion}: ${def.title}`);
for (let i = 0; i < def.sessions.length; i++) {
  const nonce = 'CPREPORT' + randomBytes(12).toString('hex') + ':';
  const r = spawnSync(process.execPath, [path.join(here, 'lib', 'page.mjs'), scenarioFile, criterion, String(i)], {
    cwd: process.cwd(),
    env: { ...process.env, CP_NONCE: nonce, CP_STORAGE: JSON.stringify(storage), CP_CARRY: JSON.stringify(carry) },
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith(nonce));
  console.log(`-- session ${i + 1} of ${def.sessions.length}`);
  if (!line || r.status !== 0) {
    failed = true;
    console.log(`  FAIL the page process ended without its report (exit ${r.status}, signal ${r.signal}${r.error ? ', ' + r.error.message : ''})`);
    const tail = ((r.stderr || '') + (r.stdout || '')).slice(-2000);
    if (tail.trim()) console.log('  output: ' + tail.replace(/\n/g, '\n  '));
    break;
  }
  const rep = JSON.parse(line.slice(nonce.length));
  for (const a of rep.assertions) {
    total++;
    console.log(`  ${a.ok ? 'ok  ' : 'FAIL'} ${a.msg}${!a.ok && a.detail ? '\n       ' + a.detail : ''}`);
    if (!a.ok) failed = true;
  }
  if (rep.navigations && rep.navigations.length) {
    failed = true;
    for (const n of rep.navigations) console.log(`  FAIL ${n}`);
  }
  for (const e of rep.pageErrors.slice(0, 5)) console.log(`  page error: ${e.slice(0, 600)}`);
  for (const e of rep.consoleErrors.slice(0, 5)) console.log(`  console.error: ${e.slice(0, 300)}`);
  for (const n of rep.notes.slice(0, 5)) console.log(`  note: ${n}`);
  if (!rep.done) { failed = true; console.log('  FAIL the session did not complete'); break; }
  if (!rep.assertions.length) { failed = true; console.log('  FAIL the session made no assertion'); }
  storage = rep.storage || {};
  carry = rep.carry;
}
console.log(failed ? `${criterion}: FAILED` : `${criterion}: passed (${total} assertions)`);
process.exit(failed ? 1 : 0);
