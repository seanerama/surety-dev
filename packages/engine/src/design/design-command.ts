// `surety design …` (D7 A.8; SEAM.md §488): a thin client of the running
// engine's design routes, in the form of `surety env` (deploy/env-command.ts):
// one request with the token of $SURETY_HOME; on a 2xx answer its JSON on
// stdout and exit 0, otherwise the code and body on stderr and exit 1.
//
//   surety design preview --project <p> [--revision checkpoint|approved|<sha>]   POST   …/design/preview
//   surety design preview --stop --project <p>                                   DELETE …/design/preview
//   surety design assets submit --project <p>                                    POST   …/design/assets/submit

import type { EnvRequest } from '../deploy/env-command.js';

const USAGE = 'design takes preview or assets submit: surety design preview --project <p> [--revision <r>] [--stop] | surety design assets submit --project <p>';

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
