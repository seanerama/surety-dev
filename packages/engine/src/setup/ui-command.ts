// A local launcher, outside the browser: start this home's engine once and
// open its same-origin console. The API token never enters a browser URL.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadEngineConfig } from '../config/engine-config.js';
import { judgeOwner, readBootId } from '../lock.js';
import { readToken } from '../token.js';

export async function launchConsole(args: string[], cli: string): Promise<{ url: string; home: string }> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--home', '--shell'].includes(key) || !value || opts[key]) throw new Error('ui takes --home <absolute directory> --shell <absolute console/public directory>');
    opts[key] = value;
  }
  const home = opts['--home']; const shell = opts['--shell'];
  if (!home || !shell || !isAbsolute(home) || !isAbsolute(shell) || !existsSync(join(shell, 'index.html'))) throw new Error('Choose an absolute engine home and an existing console/public directory.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Existing homes retain their configuration. A new home gets an available
  // loopback port; the engine's bind remains the final arbiter of any race.
  const path = join(home, 'config.json');
  if (!existsSync(path)) {
    const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => done(port)); }); });
    writeFileSync(path, JSON.stringify({ api_port: port, api_authority: `127.0.0.1:${port}` }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const config = loadEngineConfig(path);
  const url = `http://${config.values.api_authority}/`;
  const ready = async () => {
    const token = readToken(join(home, 'api.token'));
    if (!token) return false;
    try {
      const r = await fetch(`${url}v1/engine`, { headers: { 'X-Surety-Token': token }, signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (!r.ok) return false;
      const body = await r.json() as { mode?: string; startup?: { failed?: unknown } };
      // Restricted mode is still a useful UI: show its actual startup failure.
      return body.mode === 'full' || !!body.startup?.failed;
    } catch { return false; }
  };
  if (!await ready() && existsSync(join(home, 'engine.lock')) && judgeOwner(readFileSync(join(home, 'engine.lock'), 'utf8'), readBootId()).live) {
    let found = false;
    for (let i = 0; i < 180; i++) {
      if (await ready()) { found = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!found) throw new Error('This home already has an engine, but it is not ready. See console-engine.log.');
  }
  if (!await ready()) {
    const fd = openSync(join(home, 'console-engine.log'), 'a', 0o600);
    const child = spawn(process.execPath, [resolve(cli), 'serve', '--shell', shell], { env: { ...process.env, SURETY_HOME: home }, stdio: ['ignore', fd, fd], detached: true });
    closeSync(fd);
    let ended = false; let spawnError: Error | null = null;
    child.once('exit', () => { ended = true; }); child.once('error', err => { spawnError = err; });
    let found = false;
    for (let i = 0; i < 180; i++) {
      if (await ready()) { found = true; break; }
      if (ended || spawnError) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    child.unref();
    if (!found) throw new Error(`The engine did not become available. Startup details are in ${join(home, 'console-engine.log')}.`);
  }
  // No shell interpolation and no credential in the arguments.
  const browserCommand = process.env.WSL_DISTRO_NAME && existsSync('/mnt/c/Windows/explorer.exe') ? '/mnt/c/Windows/explorer.exe' : 'xdg-open';
  const browser = spawn(browserCommand, [url], { stdio: 'ignore', detached: true });
  browser.on('error', () => { process.stderr.write(`Open ${url} in your browser.\n`); }); browser.unref();
  return { url, home };
}
