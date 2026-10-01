// Stand-in for `surety serve`, used only by run.mjs to exercise the harness's
// process plumbing (start, wait, refuse, stop). It is not a model of the engine.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const home = process.env.SURETY_HOME;
const cfgPath = join(home, 'config.json');
const config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
if ('bad' in config) {
  process.stderr.write('a log line\n');
  process.stderr.write(`${JSON.stringify({ code: 'unknown_field', reason: 'r', what_to_do: 'w', subject: { field: 'bad' } })}\n`);
  process.exit(4);
}
const tokenPath = join(home, 'api.token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
const token = readFileSync(tokenPath, 'utf8').trim();
let mode = 'restricted';
const server = http.createServer((req, res) => {
  if (req.headers['x-surety-token'] !== token) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'token_required', reason: 'r', what_to_do: 'w', subject: null }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ mode }));
});
server.listen(config.api_port, '127.0.0.1', () => setTimeout(() => (mode = 'full'), 300));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
