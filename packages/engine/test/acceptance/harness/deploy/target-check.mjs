// The test-owned post-deploy check program of the M4 slice-24 rows
// (SEAM.md §258). The engine's check runner executes it as the process of
// an environment-bound check (`post_deploy_behavior`) inside a `check`
// domain: a `check_commands` entry names the installed copy
// (`installTargetCheck` in host.mjs writes it with a shebang naming the
// test's node), and the definition's `command[1..]` are its arguments.
//
// It is benign by construction: it signals nothing, starts no process,
// writes nothing but its standard output, and opens no connection but to
// the address its environment's SURETY_TARGET_APP names (the engine's
// service link, D4 §5.2). Every wait is bounded. Node built-ins only, no
// relative imports.
//
// Arguments:
//   --hold <name>         wait until <release-dir>/<name> exists (at most 280 s);
//                         its content, JSON, is the plan: {"get": [<path>…], "exit": <n>,
//                         "then": <name2>}; with "then", after asking for the plan's
//                         paths it waits again, until <release-dir>/<name2> exists (at
//                         most 280 s), whose content is a second plan {"get", "exit"}:
//                         it asks for those paths too and exits with that plan's `exit`
//                         (so the test can let it end only after a fact it reads from
//                         the host)
//   --release-dir <dir>   where the release files are (a test path in read_paths)
//   --get <path>          the path to ask for when not held (repeatable; default /hello)
// It asks SURETY_TARGET_APP for each path in turn (one GET, at most 15 s
// each), writes one line `SURETY-TARGET-REPORT <json>`
// ({"target", "results": [{"path", "status", "body", "error"}], "plan",
// and with "then" "plan2"}),
// and exits: with the plan's `exit` when held, else 0 when every answer was
// 200 and 1 otherwise; 3 when SURETY_TARGET_APP is absent (nothing asked).

import { existsSync, readFileSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opts = { hold: null, releaseDir: null, get: [] };
while (args.length > 0) {
  const flag = args.shift();
  if (flag === '--hold') opts.hold = args.shift() ?? null;
  else if (flag === '--release-dir') opts.releaseDir = args.shift() ?? null;
  else if (flag === '--get') opts.get.push(args.shift() ?? '/');
}

const out = (line) => {
  const buf = Buffer.from(`${line}\n`);
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off, buf.length - off);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A plan's raw output (the slice-28 review, S1; SEAM.md §320): each item
// written to standard output as is, with no line end: {"pad": n} n bytes of
// `p`; {"env": NAME} the value of that variable of its own environment (a
// secret the engine delivered); {"text": s}. `first` is written as soon as
// the plan is read, before anything else; `last` after the report, just
// before the exit. It writes only to its own output.
const raw = (items) => {
  for (const item of Array.isArray(items) ? items : []) {
    let text = '';
    if (Number.isInteger(item?.pad) && item.pad > 0 && item.pad <= 1_048_576) text = 'p'.repeat(item.pad);
    else if (typeof item?.env === 'string') text = process.env[item.env] ?? '';
    else if (typeof item?.text === 'string') text = item.text;
    const buf = Buffer.from(text);
    let off = 0;
    while (off < buf.length) off += writeSync(1, buf, off, buf.length - off);
  }
};

function get(base, path) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let url;
    try {
      url = new URL(path, base);
    } catch (err) {
      finish({ path, status: null, body: null, error: `bad_url:${err.message}` });
      return;
    }
    const req = request(url, { method: 'GET', timeout: 15_000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < 4096) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => finish({ path, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 4096), error: null }));
      res.on('error', (err) => finish({ path, status: res.statusCode, body: null, error: err.code ?? String(err) }));
    });
    req.on('timeout', () => {
      req.destroy();
      finish({ path, status: null, body: null, error: 'timeout' });
    });
    req.on('error', (err) => finish({ path, status: null, body: null, error: err.code ?? String(err) }));
    req.end();
  });
}

// Wait (at most 280 s) until <release-dir>/<name> exists; its plan, or null on the timeout.
async function holdFor(name, fallback) {
  const file = join(opts.releaseDir ?? '/nonexistent', name);
  const until = Date.now() + 280_000;
  while (!existsSync(file)) {
    if (Date.now() > until) return null;
    await sleep(100);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const target = process.env.SURETY_TARGET_APP ?? null;
  let plan = null;
  if (opts.hold !== null) {
    plan = await holdFor(opts.hold, { get: ['/hello'], exit: 0 });
    if (plan === null) {
      out(`SURETY-TARGET-REPORT ${JSON.stringify({ target, results: [], plan: null, error: 'hold_timeout' })}`);
      process.exit(98);
    }
  }
  raw(plan?.first);
  if (target === null) {
    out(`SURETY-TARGET-REPORT ${JSON.stringify({ target, results: [], plan, error: 'no_target' })}`);
    process.exit(3);
  }
  const paths = plan?.get ?? (opts.get.length > 0 ? opts.get : ['/hello']);
  const results = [];
  for (const path of paths) results.push(await get(target, path));
  if (typeof plan?.then === 'string') {
    const plan2 = await holdFor(plan.then, { get: [], exit: Number.isInteger(plan.exit) ? plan.exit : 0 });
    if (plan2 === null) {
      out(`SURETY-TARGET-REPORT ${JSON.stringify({ target, results, plan, plan2: null, error: 'hold_timeout' })}`);
      process.exit(98);
    }
    for (const path of plan2.get ?? []) results.push(await get(target, path));
    out(`SURETY-TARGET-REPORT ${JSON.stringify({ target, results, plan, plan2 })}`);
    process.exit(Number.isInteger(plan2.exit) ? plan2.exit : 0);
  }
  out(`SURETY-TARGET-REPORT ${JSON.stringify({ target, results, plan })}`);
  raw(plan?.last);
  if (plan !== null) process.exit(Number.isInteger(plan.exit) ? plan.exit : 0);
  process.exit(results.every((r) => r.status === 200) ? 0 : 1);
}

main().catch((err) => {
  out(`SURETY-TARGET-REPORT ${JSON.stringify({ error: String(err) })}`);
  process.exit(97);
});
