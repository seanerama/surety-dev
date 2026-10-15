// `surety session …` and `surety pace` (BS5 §3; D6 §2.7, §7.6, A.8): thin
// clients of the running engine's session and pace routes, with the token of
// $SURETY_HOME/api.token, as `surety env` is (deploy/env-command.ts). They
// parse their arguments and make their requests; they decide nothing. The
// owner's words reach the engine as the JSON body's text, never through a
// shell (BS5 §5).
//
//   surety session open --project <p> --role <vision|spec_writer|architect> [--model <m>]
//                                                     POST …/sessions
//   surety session say <run> --project <p> (--text <t> | --file <path|->) [--no-wait] [--wait-minutes <n>]
//                                                     POST …/sessions/:r/turns, then GET …/sessions/:r
//                                                     until that turn settles
//   surety session save <run> --project <p>           POST …/sessions/:r/save
//   surety session close <run> --project <p> [--refuse]
//                                                     POST …/sessions/:r/close
//   surety session resume <run> --project <p>         POST …/sessions/:r/resume
//   surety session show <run> --project <p>           GET  …/sessions/:r
//   surety pace --project <p> [--json]                GET  …/pace

import { readFileSync } from 'node:fs';

import type { EnvRequest } from '../deploy/env-command.js';

const SESSION_USAGE = 'session takes open, say, save, close, resume or show: surety session <command> [<run>] --project <p> [flags]';
const ROLES = ['vision', 'spec_writer', 'architect'];

export interface SessionCommand {
  request: EnvRequest;
  // `say` only: wait for the admitted turn to settle, at most this long.
  waitMs: number | null;
  project: string;
  run: string | null;
}

const projectPath = (p: string): string => `/v1/projects/${encodeURIComponent(p)}`;

// The command line, parsed into its request; a string is the usage problem.
// `readText` reads `--file` (a path, or `-` for standard input).
export function parseSession(argv: string[], readText: (file: string) => string = (f) => readFileSync(f === '-' ? 0 : f, 'utf8')): SessionCommand | string {
  const [sub, ...rest] = argv;
  if (sub === undefined || !['open', 'say', 'save', 'close', 'resume', 'show'].includes(sub)) return SESSION_USAGE;
  let run: string | null = null;
  const args = [...rest];
  if (sub !== 'open') {
    run = args.shift() ?? null;
    if (run === null || run.startsWith('-')) return `session ${sub} needs the session's run id`;
  }
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  const valued: Record<string, string[]> = { open: ['--project', '--role', '--model'], say: ['--project', '--text', '--file', '--wait-minutes'], save: ['--project'], close: ['--project'], resume: ['--project'], show: ['--project'] };
  const bare: Record<string, string[]> = { open: [], say: ['--no-wait'], save: [], close: ['--refuse'], resume: [], show: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (valued[sub]!.includes(flag)) {
      const value = args[++i];
      if (value === undefined || (value.startsWith('--') && flag !== '--text')) return `${flag} needs a value`;
      if (flag in values) return `${flag} is given twice`;
      values[flag] = value;
    } else if (bare[sub]!.includes(flag)) {
      if (switches.has(flag)) return `${flag} is given twice`;
      switches.add(flag);
    } else return `unknown flag ${flag} for session ${sub}`;
  }
  const project = values['--project'];
  if (project === undefined) return `session ${sub} needs --project <project>`;
  const base = `${projectPath(project)}/sessions`;
  const at = run === null ? base : `${base}/${encodeURIComponent(run)}`;
  const done = (request: EnvRequest, waitMs: number | null = null): SessionCommand => ({ request, waitMs, project, run });
  switch (sub) {
    case 'open': {
      const role = values['--role'];
      if (role === undefined || !ROLES.includes(role)) return `session open needs --role ${ROLES.join(' | ')}`;
      return done({ method: 'POST', path: base, body: { role, ...(values['--model'] !== undefined ? { model: values['--model'] } : {}) } });
    }
    case 'say': {
      const inline = values['--text'];
      const file = values['--file'];
      if ((inline === undefined) === (file === undefined)) return 'session say takes --text <text> or --file <path|->, one of them';
      let text: string;
      if (inline !== undefined) text = inline;
      else {
        try {
          text = readText(file!);
        } catch (err) {
          return `--file ${file} could not be read (${(err as Error).message})`;
        }
      }
      if (text.trim() === '') return 'session say needs something to say';
      let waitMs: number | null = 45 * 60_000;
      if (values['--wait-minutes'] !== undefined) {
        if (!/^[1-9][0-9]{0,3}$/.test(values['--wait-minutes'])) return '--wait-minutes takes a whole number of minutes, 1 or more';
        waitMs = Number(values['--wait-minutes']) * 60_000;
      }
      if (switches.has('--no-wait')) {
        if (values['--wait-minutes'] !== undefined) return 'session say takes --no-wait or --wait-minutes, not both';
        waitMs = null;
      }
      return done({ method: 'POST', path: `${at}/turns`, body: { text } }, waitMs);
    }
    case 'save':
      return done({ method: 'POST', path: `${at}/save`, body: {} });
    case 'close':
      return done({ method: 'POST', path: `${at}/close`, body: switches.has('--refuse') ? { refuse: true } : {} });
    case 'resume':
      return done({ method: 'POST', path: `${at}/resume`, body: {} });
    default:
      return done({ method: 'GET', path: at, body: null });
  }
}

// The state of turn `n` in a session read (GET …/sessions/:r), or null
// while it is not there yet.
export function turnOf(view: unknown, n: number): { state: string; reply: unknown; questions_for_owner: unknown; done: unknown; failure: unknown } | null {
  const turns = (view as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(turns)) return null;
  const t = turns.find((x) => (x as { turn?: unknown })?.turn === n) as Record<string, unknown> | undefined;
  return t ? { state: String(t.state), reply: t.reply ?? null, questions_for_owner: t.questions_for_owner ?? null, done: t.done ?? null, failure: t.failure ?? null } : null;
}

// What `say` prints once its turn is no longer running: the role's reply
// and questions, or that the turn failed or ended unknown (never a reply
// made up).
export function settledText(t: NonNullable<ReturnType<typeof turnOf>>): { text: string; ok: boolean } {
  if (t.state === 'settled') {
    const qs = Array.isArray(t.questions_for_owner) ? t.questions_for_owner.filter((q) => typeof q === 'string') : [];
    return {
      ok: true,
      text: [typeof t.reply === 'string' ? t.reply : '(the turn settled with no reply)', ...(qs.length > 0 ? ['', 'Questions for you:', ...qs.map((q) => `- ${q}`)] : []), ...(t.done === true ? ['', 'The role proposes closing the session (surety session close).'] : [])].join('\n'),
    };
  }
  if (t.state === 'failed') return { ok: false, text: `The turn failed: ${JSON.stringify(t.failure)}` };
  return { ok: false, text: `The turn ended ${t.state}: its reply is unknown.` };
}

const PACE_USAGE = 'pace takes --project <p> [--json]';

export function parsePace(argv: string[]): { request: EnvRequest; json: boolean } | string {
  let project: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--project') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return '--project needs a value';
      if (project !== null) return '--project is given twice';
      project = value;
    } else if (flag === '--json') {
      if (json) return '--json is given twice';
      json = true;
    } else return `unknown flag ${flag}; ${PACE_USAGE}`;
  }
  if (project === null) return PACE_USAGE;
  return { request: { method: 'GET', path: `${projectPath(project)}/pace`, body: null }, json };
}

// The pace read as lines `path: value`, every leaf of the projection with
// its path; `unknown` stays unknown, never zero (D6 §7.6).
export function paceLines(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${path || '(read)'}: ${value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)}`];
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`${path || '(read)'}: ${Array.isArray(value) ? '[]' : '{}'}`];
  return entries.flatMap(([k, v]) => paceLines(v, path === '' ? k : Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`));
}
