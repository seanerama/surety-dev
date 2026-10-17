// `surety design …` (D7 A.8; SEAM.md §488): a thin client of the running
// engine's design routes, in the form of `surety env` (deploy/env-command.ts):
// one request with the token of $SURETY_HOME; on a 2xx answer its JSON on
// stdout and exit 0, otherwise the code and body on stderr and exit 1.
//
//   surety design preview --project <p> [--revision checkpoint|approved|<sha>]   POST   …/design/preview
//   surety design preview --stop --project <p>                                   DELETE …/design/preview
//   surety design assets submit --project <p>                                    POST   …/design/assets/submit
//   surety design asset add --project <p> <slot> <variant> <file>                POST   …/design/assets
//   surety design bindings --project <p>                                         GET    …/design/bindings
//   surety design export --project <p> [--revision checkpoint|approved|<sha>] <dir>  GET …/design/export, written to <dir>
//   surety design review --project <p> --target <t> --build <id> [--candidate <c>] [--observed-on <o>] [--evidence <file>…]
//                                                                                 POST   …/design/reviews (D7 §10.5; SEAM.md §522)
//   surety design verdicts --project <p> <review> confirm [--edit <json>]… [--strike <target>/<screen>]… [--severity <s>] | reject
//                                                                                 the open design_verdicts about <review>, answered (SEAM.md §525)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import { loadEngineConfig } from '../config/engine-config.js';
import { type EnvRequest, sendEnv } from '../deploy/env-command.js';
import { homePaths } from '../paths.js';
import { readToken } from '../token.js';
import { readUstar, writeEntries } from './export.js';

const USAGE =
  'design takes preview, export, asset add, assets submit, bindings, review or verdicts: surety design preview --project <p> [--revision <r>] [--stop] | surety design export --project <p> [--revision <r>] <dir> | surety design asset add --project <p> <slot> <variant> <file> | surety design assets submit --project <p> | surety design bindings --project <p> | surety design review --project <p> --target <t> --build <id> [--candidate <c>] [--observed-on <o>] [--evidence <file>…] | surety design verdicts --project <p> <review> confirm [--edit <json>]… [--strike <target>/<screen>]… [--severity <s>] | reject';

// `surety design review` (D7 §10.5, A.8; SEAM.md §522): each evidence file
// read here and sent as its bytes with its name; the names are data, never
// paths the engine opens, and nothing of the files is decoded here.
// `--evidence` takes the rest of the arguments as files.
function parseReview(argv: string[]): EnvRequest | string {
  let project: string | null = null;
  const values: Record<string, string> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--evidence') {
      files.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--project' || a === '--target' || a === '--build' || a === '--candidate' || a === '--observed-on') {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === '--project') project = value;
      else values[a] = value;
    } else return `unknown argument ${a} for design review`;
  }
  if (project === null) return 'design review needs --project <project>';
  if (values['--target'] === undefined || values['--build'] === undefined) return 'design review needs --target <target> and --build <the build you name>';
  if (argv.includes('--evidence') && files.length === 0) return '--evidence needs at least one file';
  const evidence: { name: string; content_base64: string }[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(isAbsolute(file) ? file : resolve(process.cwd(), file));
    } catch (err) {
      return `design review could not read ${file}: ${(err as Error).message}`;
    }
    evidence.push({ name: basename(file), content_base64: bytes.toString('base64') });
  }
  return {
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(project)}/design/reviews`,
    body: {
      target: values['--target'],
      build_ref: values['--build'],
      ...(values['--candidate'] !== undefined ? { candidate: values['--candidate'] } : {}),
      ...(values['--observed-on'] !== undefined ? { observed_on: values['--observed-on'] } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    },
  };
}

// `surety design verdicts` (D7 §10.3, A.8; SEAM.md §525): the answer to the
// open design_verdicts about the review, as the decision's route takes it.
export interface VerdictsCommand {
  project: string;
  review: string;
  answer: { option: 'confirm' | 'reject'; edits?: Record<string, unknown>[]; strikes?: { target: string; screen: string }[]; severity?: string };
}

export function parseDesignVerdicts(argv: string[]): VerdictsCommand | string {
  let project: string | null = null;
  const positional: string[] = [];
  const edits: Record<string, unknown>[] = [];
  const strikes: { target: string; screen: string }[] = [];
  let severity: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project' || a === '--edit' || a === '--strike' || a === '--severity') {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === '--project') project = value;
      else if (a === '--severity') severity = value;
      else if (a === '--strike') {
        const m = /^([^/]+)\/(.+)$/.exec(value);
        if (!m) return '--strike takes <target>/<screen>';
        strikes.push({ target: m[1]!, screen: m[2]! });
      } else {
        let edit: unknown;
        try {
          edit = JSON.parse(value);
        } catch {
          return '--edit takes a JSON object: {"target", "screen", "verdict"?, "observed_on"?, "deltas"?}';
        }
        if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) return '--edit takes a JSON object';
        edits.push(edit as Record<string, unknown>);
      }
    } else if (a.startsWith('--')) return `unknown flag ${a} for design verdicts`;
    else positional.push(a);
  }
  if (project === null) return 'design verdicts needs --project <project>';
  const [review, option, ...extra] = positional;
  if (review === undefined || (option !== 'confirm' && option !== 'reject') || extra.length > 0) return 'design verdicts takes <review> confirm|reject';
  if (option === 'reject' && (edits.length > 0 || strikes.length > 0 || severity !== null)) return 'design verdicts … reject takes no --edit, --strike or --severity';
  return { project, review, answer: { option, ...(edits.length > 0 ? { edits } : {}), ...(strikes.length > 0 ? { strikes } : {}), ...(severity !== null ? { severity } : {}) } };
}

// `surety design asset add --project <p> <slot> <variant> <file>`: the file
// read here and sent as its bytes; its name is data, never a command.
function parseAssetAdd(argv: string[]): EnvRequest | string {
  let project: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project') {
      const value = argv[++i];
      if (value === undefined) return '--project needs a value';
      project = value;
    } else if (a.startsWith('--')) return `unknown flag ${a} for design asset add`;
    else positional.push(a);
  }
  if (project === null) return 'design asset add needs --project <project>';
  if (positional.length !== 3) return 'design asset add takes <slot> <variant> <file>';
  const [slot, variant, file] = positional as [string, string, string];
  let bytes: Buffer;
  try {
    bytes = readFileSync(isAbsolute(file) ? file : resolve(process.cwd(), file));
  } catch (err) {
    return `design asset add could not read ${file}: ${(err as Error).message}`;
  }
  return { method: 'POST', path: `/v1/projects/${encodeURIComponent(project)}/design/assets`, body: { slot, variant, name: basename(file), content_base64: bytes.toString('base64') } };
}

export function parseDesignCommand(argv: string[]): EnvRequest | string {
  const [sub, ...rest0] = argv;
  let rest = rest0;
  if (sub === 'asset') {
    if (rest[0] !== 'add') return USAGE;
    return parseAssetAdd(rest.slice(1));
  }
  if (sub === 'review') return parseReview(rest);
  if (sub === 'bindings') {
    if (rest.length !== 2 || rest[0] !== '--project') return 'design bindings takes --project <project>';
    return { method: 'GET', path: `/v1/projects/${encodeURIComponent(rest[1]!)}/design/bindings`, body: null };
  }
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

// The open design_verdicts about the review, answered at its current
// preview (one read, one answer, both through the owner's routes). Exit 0
// with the answer's JSON; else the code and body, exit 1.
export async function designVerdicts(home: string, c: VerdictsCommand): Promise<{ code: number; out: string }> {
  const base = `/v1/projects/${encodeURIComponent(c.project)}`;
  const open = await sendEnv(home, { method: 'GET', path: `${base}/decisions`, body: null });
  if (open.status < 200 || open.status >= 300) return { code: 1, out: `${open.status} ${open.text.trim().replace(/\n/g, ' ')}` };
  const decisions = (JSON.parse(open.text) as { decisions?: { id: string; kind: string; subject_id: string; preview_hash: string }[] }).decisions ?? [];
  const d = decisions.find((x) => x.kind === 'design_verdicts' && x.subject_id === c.review);
  if (!d) {
    return {
      code: 1,
      out: `404 ${JSON.stringify({ code: 'not_found', reason: `No design_verdicts is open about the review ${c.review}.`, what_to_do: 'Read the project\'s open decisions: the verdicts may be answered already, or the review not closed yet.', subject: { review: c.review } })}`,
    };
  }
  const res = await sendEnv(home, { method: 'POST', path: `${base}/decisions/${encodeURIComponent(d.id)}/answer`, body: { ...c.answer, preview_hash: d.preview_hash } });
  let shown: string;
  try {
    shown = JSON.stringify(JSON.parse(res.text));
  } catch {
    shown = res.text.trim().replace(/\n/g, ' ');
  }
  return res.status >= 200 && res.status < 300 ? { code: 0, out: shown } : { code: 1, out: `${res.status} ${shown}` };
}
