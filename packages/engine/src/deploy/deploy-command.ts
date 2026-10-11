// `surety deploy <candidate> --env <environment> --project <project>` (D4 §1
// item 4, Q3, A.8; E121 item 4; SEAM.md §335): the operator's deployment
// request, a thin client of POST /v1/projects/:p/deployments on the engine of
// $SURETY_HOME, with its api.token and the authority of its config.json
// (sendEnv). It parses its arguments into one request with the route's
// closed body, {candidate, environment}, and decides nothing: sealing, the
// engine-derived binding, `alpha_authorize` and coalescing are the route's
// (J3). It holds no authority of its own; whoever cannot present the
// engine's token cannot deploy with it.

import { loadEngineConfig } from '../config/engine-config.js';
import { homePaths } from '../paths.js';
import type { EnvRequest } from './env-command.js';

const USAGE = 'deploy takes a candidate, its environment and its project: surety deploy <candidate> --env <environment> --project <project>';

// The command line, parsed into one request; a string is the usage problem.
export function parseDeploy(argv: string[]): EnvRequest | string {
  let candidate: string | null = null;
  let environment: string | null = null;
  let project: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--env' || arg === '--project') {
      const value = argv[++i];
      if (value === undefined || value === '' || value.startsWith('-')) return `${arg} needs a value`;
      if (arg === '--env') {
        if (environment !== null) return '--env is given twice';
        environment = value;
      } else {
        if (project !== null) return '--project is given twice';
        project = value;
      }
    } else if (arg.startsWith('-')) {
      return `unknown flag ${arg} for deploy`;
    } else if (candidate === null && arg !== '') {
      candidate = arg;
    } else {
      return `unknown argument ${arg} for deploy`;
    }
  }
  if (candidate === null) return USAGE;
  if (environment === null) return 'deploy needs --env <environment>';
  if (project === null) return 'deploy needs --project <project>';
  return { method: 'POST', path: `/v1/projects/${encodeURIComponent(project)}/deployments`, body: { candidate, environment } };
}

// How long the client waits (the driver's ruling on the slice-30 design):
// the request seals the artifact, bounded by the engine's
// `artifact_prepare_deadline`, so the configured deadline and a minute more.
export function deployTimeoutMs(home: string): number {
  return (loadEngineConfig(homePaths(home).config).values.artifact_prepare_deadline + 60) * 1000;
}
