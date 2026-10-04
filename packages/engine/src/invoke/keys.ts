// The provider keys outside the engine's test mode (D2 §2.5, Q1; D1 §5.5,
// §17 item 5): each backend's key is the secret reference
// `backend/<backend>/api_key`, and the resolver takes its value at start
// from the engine's own environment, under the reference's name made an
// environment variable: `SURETY_SECRET_BACKEND_CLAUDE_API_KEY` for
// `backend/claude/api_key`. A provider-side cap on that key, if the
// operator states one, is `SURETY_SECRET_BACKEND_CLAUDE_API_KEY_PROVIDER_CAP_USD`
// and is recorded on a grant as `configured`, never as engine enforcement
// (D2 §4.2, Q2; SEAM.md §120). Both are removed from the engine's
// environment once read, so nothing the engine starts inherits them; the
// value lives only in the resolver (records/redact.ts), which also redacts
// it from everything the engine writes. In the test mode the harness holds
// keys (SEAM.md §57) and these variables are not read.

import { TEMPLATES } from './adapters/templates.js';
import { holdSecret } from '../records/redact.js';

export const keyReference = (backend: string): string => `backend/${backend}/api_key`;
export const keyEnvironmentName = (reference: string): string => `SURETY_SECRET_${reference.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
export const capEnvironmentName = (reference: string): string => `${keyEnvironmentName(reference)}_PROVIDER_CAP_USD`;

// Hold every backend key the environment gives; returns the references held
// (names only) and the problems found, for the start's log. A cap that is
// not a positive number is a problem and is not recorded.
export function holdEnvironmentKeys(env: NodeJS.ProcessEnv): { held: string[]; problems: string[] } {
  const held: string[] = [];
  const problems: string[] = [];
  for (const backend of Object.keys(TEMPLATES)) {
    const ref = keyReference(backend);
    const name = keyEnvironmentName(ref);
    const capName = capEnvironmentName(ref);
    const value = env[name];
    const capText = env[capName];
    delete env[name];
    delete env[capName];
    if (value === undefined || value === '') {
      if (capText !== undefined) problems.push(`${capName} is set without ${name}`);
      continue;
    }
    let cap: number | undefined;
    if (capText !== undefined) {
      const n = Number(capText);
      if (Number.isFinite(n) && n > 0) cap = n;
      else problems.push(`${capName} is not a positive number of US dollars; no provider cap is recorded`);
    }
    holdSecret(ref, value, cap);
    held.push(ref);
  }
  return { held, problems };
}
