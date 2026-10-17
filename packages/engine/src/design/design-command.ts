// `surety design …` (D7 A.8; SEAM.md §488): a thin client of the running
// engine's design routes, in the form of `surety env` (deploy/env-command.ts):
// one request with the token of $SURETY_HOME; on a 2xx answer its JSON on
// stdout and exit 0, otherwise the code and body on stderr and exit 1.
//
//   surety design preview --project <p> [--revision checkpoint|approved|<sha>]   POST   …/design/preview
//   surety design preview --stop --project <p>                                   DELETE …/design/preview
//   surety design assets submit --project <p>                                    POST   …/design/assets/submit
//   surety design export --project <p> [--revision checkpoint|approved|<sha>] <dir>  GET …/design/export, written to <dir>

import http from 'node:http';
import { isAbsolute, resolve } from 'node:path';

import { loadEngineConfig } from '../config/engine-config.js';
import type { EnvRequest } from '../deploy/env-command.js';
import { homePaths } from '../paths.js';
import { readToken } from '../token.js';
import { readUstar, writeEntries } from './export.js';

const USAGE =
  'design takes preview, export or assets submit: surety design preview --project <p> [--revision <r>] [--stop] | surety design export --project <p> [--revision <r>] <dir> | surety design assets submit --project <p>';

export function parseDesignCommand(argv: string[]): EnvRequest | string {
  const [sub, ...rest0] = argv;
  let rest = rest0;
  if (sub === 'assets') {
    if (rest[0] !== 'submit') return USAGE;
    rest = rest.slice(1);
  } else if (sub !== 'preview') return USAGE;
  let project: string | null = null;
  let revision: string | null = null;
  let stop = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--project' || (flag === '--revision' && sub === 'preview')) {
      const value = rest[++i];
      if (value === undefined) return `${flag} needs a value`;
      if (flag === '--project') project = value;
      else revision = value;
    } else if (flag === '--stop' && sub === 'preview') stop = true;
    else return `unknown flag ${flag} for design ${sub}`;
  }
  if (project === null) return `design ${sub} needs --project <project>`;
  const base = `/v1/projects/${encodeURIComponent(project)}/design`;
  if (sub === 'assets') return { method: 'POST', path: `${base}/assets/submit`, body: {} };
  if (stop) {
    if (revision !== null) return 'design preview takes --revision or --stop, not both';
    return { method: 'DELETE', path: `${base}/preview`, body: null };
  }
  return { method: 'POST', path: `${base}/preview`, body: { revision: revision ?? 'checkpoint' } };
}

// `surety design export` (D7 §5.7, A.8; SEAM.md §501): the archive of the
// design tree at the revision, asked of the running engine, written under
// <dir> (made if absent) with its SIMULATIONS.txt. Nothing else is written.
export function parseDesignExport(argv: string[]): { project: string; revision: string; dir: string } | string {
  let project: string | null = null;
  let revision = 'checkpoint';
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project' || a === '--revision') {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === '--project') project = value;
      else revision = value;
    } else if (a.startsWith('-')) return `unknown flag ${a} for design export`;
    else if (dir === null) dir = a;
    else return 'design export takes one directory';
  }
  if (project === null) return 'design export needs --project <project>';
  if (dir === null) return 'design export needs a directory: surety design export --project <p> [--revision <r>] <dir>';
  return { project, revision, dir };
}

function getBytes(home: string, path: string, timeoutMs = 120_000): Promise<{ status: number; bytes: Buffer }> {
  const paths = homePaths(home);
  const config = loadEngineConfig(paths.config);
  const token = readToken(paths.token);
  if (token === null) return Promise.reject(new Error('the engine home has no api.token: start the engine first'));
  return new Promise((done, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port: config.values.api_port, method: 'GET', path, headers: { host: config.values.api_authority, 'x-surety-token': token }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
        res.on('error', fail);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`the engine did not answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', fail);
    req.end();
  });
}

// Exit 0 with the answer's JSON on stdout; else the code and body on stderr, exit 1.
export async function designExport(home: string, args: { project: string; revision: string; dir: string }): Promise<{ code: number; out: string }> {
  const dir = isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir);
  const { status, bytes } = await getBytes(home, `/v1/projects/${encodeURIComponent(args.project)}/design/export?revision=${encodeURIComponent(args.revision)}`);
  if (status < 200 || status >= 300) return { code: 1, out: `${status} ${bytes.toString('utf8').trim().replace(/\n/g, ' ')}` };
  const written = writeEntries(dir, readUstar(bytes));
  return { code: 0, out: JSON.stringify({ exported: { project: args.project, revision: args.revision, dir, files: written.sort() } }) };
}
