// `surety qualify <backend> --mode one_shot_headless --model <m>
// [--egress <host>]... [--deadline <kind>=<seconds>]...` (D2 §7.2; the M2
// plan's M136 setup): a client of the running engine's
// `POST /v1/trust/qualify`, with the token of $SURETY_HOME/api.token and the
// authority of its config.json. It proposes an attempt and prints the answer:
// the attempt and its `qualification_approval`, which only a person answers.
// It runs nothing itself and never starts a canary: the engine does that,
// after the approval.

import http from 'node:http';

import { loadEngineConfig } from '../config/engine-config.js';
import { homePaths } from '../paths.js';
import { readToken } from '../token.js';

// The provider each backend reaches by default, offered as the attempt's
// candidate egress when none is named (D2 §§2.4, 7.2): the destination the
// approval preview shows, never added to afterwards.
export const DEFAULT_EGRESS: Readonly<Record<string, string[]>> = { claude: ['api.anthropic.com'] };

export interface QualifyCommand {
  body: Record<string, unknown>;
}

// The command line, parsed; a string is the usage problem.
export function parseQualify(argv: string[]): QualifyCommand | string {
  const [backend, ...rest] = argv;
  if (backend === undefined || backend.startsWith('-')) return 'qualify needs a backend: surety qualify <backend> --mode one_shot_headless --model <model>';
  let mode: string | null = null;
  let model: string | null = null;
  const egress: string[] = [];
  const deadlines: Record<string, number> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = rest[++i];
    if (value === undefined) return `${flag} needs a value`;
    if (flag === '--mode') mode = value;
    else if (flag === '--model') model = value;
    else if (flag === '--egress') egress.push(value);
    else if (flag === '--deadline') {
      const m = /^(positive|cancellation|containment)=([1-9]\d*)$/.exec(value);
      if (!m) return '--deadline takes <positive|cancellation|containment>=<seconds>';
      deadlines[m[1]!] = Number(m[2]);
    } else return `unknown flag ${flag} for qualify`;
  }
  if (mode === null) return 'qualify needs --mode one_shot_headless';
  if (model === null) return 'qualify needs --model <model>';
  const body: Record<string, unknown> = { backend, mode, model, candidate_egress: egress.length > 0 ? egress : (DEFAULT_EGRESS[backend] ?? []) };
  if (Object.keys(deadlines).length > 0) body.canary_deadlines = deadlines;
  return { body };
}

// The request, made once; resolves with the status and the body's text.
export function sendQualify(home: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const paths = homePaths(home);
  const config = loadEngineConfig(paths.config);
  const token = readToken(paths.token);
  if (token === null) return Promise.reject(new Error('the engine home has no api.token: start the engine first'));
  const authority = config.values.api_authority;
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.values.api_port,
        method: 'POST',
        path: '/v1/trust/qualify',
        headers: { host: authority, 'content-type': 'application/json', 'content-length': data.length, 'x-surety-token': token },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('the engine did not answer within 120 s')));
    req.on('error', reject);
    req.end(data);
  });
}
