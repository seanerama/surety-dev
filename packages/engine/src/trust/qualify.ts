// `POST /v1/trust/qualify` (D2 §7.2, K10, Q7, A.7), the main thread's half:
// the request's form and the attempt's static checks, made before the store
// writes the attempt `proposed` and raises its `qualification_approval`.
// Nothing is launched here and no canary runs until a person has authorized
// the attempt; the binary is resolved and hashed, never run by this route.
//
// The static checks (D2 §7.2: the resolved path, the binary's hash, its
// version, the help hash of the commands the template uses) bind what a
// person approves. A real backend's binary is never run in harness mode
// (the engine's test mode), where the binary is the test's stand-in.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { TEMPLATES } from '../invoke/adapters/templates.js';
import { canonicalHost } from '../invoke/proxy/proxy.js';
import { ECHO_HOST } from '../invoke/proxy/echo.js';
import { Refusal } from '../refusal.js';
import { seamQualifyStatic } from '../testing/seam.js';

const FIELDS = ['backend', 'mode', 'model', 'binary', 'version', 'candidate_egress', 'fixture_project', 'canary_deadlines'];

// The canaries' default deadlines, in seconds (D2 §7.2: a deadline per canary).
export const CANARY_DEADLINES = { positive: 900, cancellation: 600, containment: 900 };

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `${field} ${why}.`, 'Correct the request; nothing was written.', { field });

export interface QualifyRequest {
  backend: string;
  mode: string;
  model: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  version: string;
  template: string;
  template_version: string;
  candidate_egress: string[];
  fixture_project: string;
  canary_deadlines: { positive: number; cancellation: number; containment: number };
}

export async function prepareQualify(b: unknown): Promise<QualifyRequest> {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw invalid('the body', 'must be an object');
  const body = b as Record<string, unknown>;
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw new Refusal(400, 'unknown_field', `${k} is not a field of a qualification request.`, 'Remove it.', { field: k });
  const backend = body.backend;
  if (typeof backend !== 'string' || !TEMPLATES[backend]) throw invalid('backend', `must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  const mode = body.mode ?? 'one_shot_headless';
  if (mode !== 'one_shot_headless') {
    throw new Refusal(409, 'backend_refused', `Only one_shot_headless can be qualified in M2; ${String(mode)} is refused (D2 §1.8).`, 'Qualify the one-shot headless mode.', { field: 'mode' });
  }
  if (typeof body.model !== 'string' || body.model.trim() === '' || body.model.startsWith('-')) throw invalid('model', 'must be a model name');
  const list = body.candidate_egress ?? [];
  if (!Array.isArray(list) || list.some((h) => typeof h !== 'string' || h.trim().length === 0)) throw invalid('candidate_egress', 'must be a list of host names');
  // The echo endpoint is the probe suite's alone (D2 §2.4; SEAM.md §140).
  if (list.some((h) => canonicalHost(String(h)) === ECHO_HOST)) {
    throw new Refusal(400, 'invalid_value', `candidate_egress names ${ECHO_HOST}, the engine's own echo endpoint, which only the probe suite may reach.`, 'Remove the echo endpoint from the list.', { field: 'candidate_egress' });
  }
  if (typeof body.fixture_project !== 'string' || body.fixture_project === '') throw invalid('fixture_project', 'must name the project the canaries run on');
  const deadlines = { ...CANARY_DEADLINES };
  if (body.canary_deadlines !== undefined) {
    const d = body.canary_deadlines;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw invalid('canary_deadlines', 'must be an object');
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (!(k in deadlines) || !Number.isSafeInteger(v) || (v as number) < 1) throw invalid('canary_deadlines', 'must give positive whole seconds for positive, cancellation and containment');
      deadlines[k as keyof typeof deadlines] = v as number;
    }
  }
  const template = TEMPLATES[backend]!;
  const statics = await staticChecks(backend, body);
  return {
    backend,
    mode,
    model: body.model,
    binary_path: statics.path,
    binary_sha256: statics.sha256,
    help_sha256: statics.help,
    version: statics.version,
    template: template.text,
    template_version: template.version,
    candidate_egress: [...new Set(list.map((h) => canonicalHost(String(h))))],
    fixture_project: body.fixture_project,
    canary_deadlines: deadlines,
  };
}

// The static checks. In harness mode the seam gives the stand-in's (its
// path, its file's hash, the version the test names, a help hash over its
// own file) and refuses a real backend's binary; outside it the binary named
// is resolved and hashed, and its version and help are part of a real
// attempt, the paid lane's (slice 14), which this engine revision does not
// yet make: refused rather than guessed.
async function staticChecks(backend: string, body: Record<string, unknown>): Promise<{ path: string; sha256: string; help: string; version: string }> {
  const seam = await seamQualifyStatic(backend, body);
  if (seam !== null) return seam;
  if (typeof body.binary !== 'string' || !body.binary.startsWith('/')) throw invalid('binary', 'must be the absolute path of the backend binary');
  let path: string;
  try {
    path = realpathSync(body.binary);
  } catch {
    throw invalid('binary', `${body.binary} cannot be resolved`);
  }
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  void sha256;
  throw new Refusal(
    501,
    'not_implemented',
    'A qualification attempt of a real backend binary reads its version and help, which this engine revision does not yet do outside its test mode.',
    'Wait for the real lane (M2 slice 14).',
    { backend, binary: path },
  );
}
