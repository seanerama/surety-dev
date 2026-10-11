// `surety env …` (D4 §§3.2, 4.6, 5.2, 6.1, A.8; the M4 build spec §3; SEAM.md
// §§313, 317): a thin client of the running engine's environment routes,
// with the token of $SURETY_HOME/api.token and the authority of its
// config.json. It parses its arguments and makes one request; it holds no
// logic of its own and decides nothing. On a 2xx answer it prints the
// answer's JSON and exits 0; otherwise it prints the code and body and
// exits 1.
//
//   surety env config <env> --project <p> --file <content.json>   PUT    …/environments/:e/config
//   surety env config <env> --project <p> --resolve-secrets       POST   …/environments/:e/config/resolve-secrets
//   surety env open <env> --project <p>                           POST   …/environments/:e/relay
//   surety env close <env> --project <p>                          DELETE …/environments/:e/relay
//   surety env logs <env> --project <p>                           GET    …/environments/:e/logs
//   surety env logs <env> --project <p> --collect                 POST   …/environments/:e/logs
//   surety env teardown <env> --project <p> [--preempt]           POST   …/environments/:e/teardown

import { readFileSync } from 'node:fs';
import http from 'node:http';

import { loadEngineConfig } from '../config/engine-config.js';
import { homePaths } from '../paths.js';
import { readToken } from '../token.js';

export interface EnvRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
}

const USAGE = 'env takes config, open, close, logs or teardown: surety env <command> <env> --project <p> [flags]';

// The command line, parsed into one request; a string is the usage problem.
export function parseEnv(argv: string[]): EnvRequest | string {
  const [sub, env, ...rest] = argv;
  if (sub === undefined || !['config', 'open', 'close', 'logs', 'teardown'].includes(sub)) return USAGE;
  if (env === undefined || env.startsWith('-')) return `env ${sub} needs an environment name`;
  let project: string | null = null;
  let file: string | null = null;
  const switches = new Set<string>();
  const allowed: Record<string, string[]> = { config: ['--resolve-secrets'], open: [], close: [], logs: ['--collect'], teardown: ['--preempt'] };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--project' || (flag === '--file' && sub === 'config')) {
      const value = rest[++i];
      if (value === undefined) return `${flag} needs a value`;
      if (flag === '--project') project = value;
      else file = value;
    } else if (allowed[sub]!.includes(flag)) switches.add(flag);
    else return `unknown flag ${flag} for env ${sub}`;
  }
  if (project === null) return `env ${sub} needs --project <project>`;
  const base = `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(env)}`;
  switch (sub) {
    case 'config': {
      if (switches.has('--resolve-secrets')) {
        if (file !== null) return 'env config takes --file or --resolve-secrets, not both';
        return { method: 'POST', path: `${base}/config/resolve-secrets`, body: {} };
      }
      if (file === null) return 'env config needs --file <content.json> or --resolve-secrets';
      let body: unknown;
      try {
        body = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        return `--file ${file} could not be read as JSON (${(err as Error).message})`;
      }
      return { method: 'PUT', path: `${base}/config`, body };
    }
    case 'open':
      return { method: 'POST', path: `${base}/relay`, body: {} };
    case 'close':
      return { method: 'DELETE', path: `${base}/relay`, body: null };
    case 'logs':
      return switches.has('--collect') ? { method: 'POST', path: `${base}/logs`, body: {} } : { method: 'GET', path: `${base}/logs`, body: null };
    default:
      return { method: 'POST', path: `${base}/teardown`, body: switches.has('--preempt') ? { preempt: true } : {} };
  }
}

// The request, made once; resolves with the status and the body's text.
export function sendEnv(home: string, r: EnvRequest, timeoutMs = 120_000): Promise<{ status: number; text: string }> {
  const paths = homePaths(home);
  const config = loadEngineConfig(paths.config);
  const token = readToken(paths.token);
  if (token === null) return Promise.reject(new Error('the engine home has no api.token: start the engine first'));
  const data = r.body === null ? null : Buffer.from(JSON.stringify(r.body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.values.api_port,
        method: r.method,
        path: r.path,
        headers: { host: config.values.api_authority, 'x-surety-token': token, ...(data !== null ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`the engine did not answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    if (data !== null) req.end(data);
    else req.end();
  });
}
