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

import { TEMPLATES, templateOf } from '../invoke/adapters/templates.js';
import { canonicalHost } from '../invoke/proxy/proxy.js';
import { ECHO_HOST } from '../invoke/proxy/echo.js';
import { Refusal } from '../refusal.js';
import { seamQualifyMode, seamRefuseBinary } from '../testing/seam.js';
import { helpHash, versionOf } from '../invoke/static.js';
import { resolveInstallation } from './fixture.js';

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

// Outside the test mode: the engine's own fixture project, made and
// registered on first use (trust/fixture.ts; api/server.ts).
export interface QualifyContext {
  fixtureProject: () => Promise<string>;
}

export async function prepareQualify(b: unknown, ctx: QualifyContext | null = null): Promise<QualifyRequest> {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw invalid('the body', 'must be an object');
  const body = b as Record<string, unknown>;
  // In the engine's test mode only: a stand-in binary, a fixture project of
  // the test's, and the scripted backend (SEAM.md §148).
  const testMode = seamQualifyMode();
  const allowed = testMode ? FIELDS : FIELDS.filter((f) => f !== 'binary' && f !== 'fixture_project' && f !== 'version');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new Refusal(400, 'unknown_field', `${k} is not a field of a qualification request.`, 'Remove it.', { field: k });
  const backend = body.backend;
  const template = typeof backend === 'string' ? templateOf(backend, { scripted: testMode }) : undefined;
  if (typeof backend !== 'string' || !template) throw invalid('backend', `must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  const mode = body.mode ?? 'one_shot_headless';
  if (mode !== 'one_shot_headless') throw invalid('mode', 'must be one_shot_headless: only it can be qualified in M2 (D2 §1.8)');
  if (typeof body.model !== 'string' || body.model.trim() === '' || body.model.startsWith('-')) throw invalid('model', 'must be a model name');
  const list = body.candidate_egress ?? [];
  if (!Array.isArray(list) || list.some((h) => typeof h !== 'string' || h.trim().length === 0)) throw invalid('candidate_egress', 'must be a list of host names');
  // The echo endpoint is the probe suite's alone (D2 §2.4; SEAM.md §140).
  if (list.some((h) => canonicalHost(String(h)) === ECHO_HOST)) {
    throw new Refusal(400, 'invalid_value', `candidate_egress names ${ECHO_HOST}, the engine's own echo endpoint, which only the probe suite may reach.`, 'Remove the echo endpoint from the list.', { field: 'candidate_egress' });
  }
  let fixtureProject: string;
  let given: string | null;
  if (!testMode) {
    // The backend's installation as the engine's PATH resolves it, to its
    // real path (D2 §7.2, §7.3), and the engine's own fixture project.
    if (backend === 'scripted') throw invalid('backend', 'must name a real backend outside the test mode');
    given = resolveInstallation(backend);
    if (given === null) {
      throw new Refusal(409, 'backend_refused', `No executable named ${backend} is on the engine's PATH.`, `Install ${backend}, or start the engine with its directory on PATH, and ask again.`, { backend });
    }
    if (ctx === null) throw new Refusal(500, 'store_error', 'The engine could not make its fixture project.', 'Start the engine again.', { backend });
    fixtureProject = await ctx.fixtureProject();
  } else {
    if (typeof body.fixture_project !== 'string' || body.fixture_project === '') throw invalid('fixture_project', 'must name the project the canaries run on');
    fixtureProject = body.fixture_project;
    given = null;
  }
  const deadlines = { ...CANARY_DEADLINES };
  if (body.canary_deadlines !== undefined) {
    const d = body.canary_deadlines;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw invalid('canary_deadlines', 'must be an object');
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (!(k in deadlines) || !Number.isSafeInteger(v) || (v as number) < 1) throw invalid('canary_deadlines', 'must give positive whole seconds for positive, cancellation and containment');
      deadlines[k as keyof typeof deadlines] = v as number;
    }
  }
  const binary = body.binary;
  const path =
    given ??
    (typeof binary === 'object' && binary !== null && typeof (binary as Record<string, unknown>).path === 'string' ? String((binary as Record<string, unknown>).path) : typeof binary === 'string' ? binary : null);
  if (path === null) throw invalid('binary', 'must be {"path": <the stand-in binary>}');
  const statics = await staticChecks(backend, path);
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
    fixture_project: fixtureProject,
    canary_deadlines: deadlines,
  };
}

// The static checks (D2 §7.2; SEAM.md §148): the binary's real path and its
// file's SHA-256, and `--version` and `--help`, each run once, exactly so,
// outside any domain. A real backend's binary is refused in the test mode.
async function staticChecks(backend: string, given: string): Promise<{ path: string; sha256: string; help: string; version: string }> {
  if (!given.startsWith('/')) throw invalid('binary', 'must be an absolute path');
  let path: string;
  try {
    path = realpathSync(given);
  } catch {
    throw invalid('binary', `${given} cannot be resolved`);
  }
  const real = seamRefuseBinary(path, backend);
  if (real !== null) throw new Refusal(409, 'backend_refused', `The engine's test mode never runs a real backend's binary: ${real}.`, 'Name the stand-in binary.', { field: 'binary' });
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  const version = await versionOf(path, backend).catch(() => null);
  const help = await helpHash(path, backend).catch(() => null);
  if (version === null || help === null) throw new Refusal(409, 'backend_refused', `${path} did not answer --version and --help.`, 'Name a binary that answers both.', { field: 'binary' });
  return { path, sha256, help, version };
}
