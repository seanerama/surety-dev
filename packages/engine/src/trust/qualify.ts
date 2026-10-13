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

import { isModelName, sameModel } from '../invoke/adapters/model.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { AUTH_MODES, TEMPLATES, templateOf } from '../invoke/adapters/templates.js';
import { canonicalHost } from '../invoke/proxy/proxy.js';
import { ECHO_HOST } from '../invoke/proxy/echo.js';
import { Refusal } from '../refusal.js';
import { seamQualifyMode, seamRefuseBinary } from '../testing/seam.js';
import { helpHash, versionOf } from '../invoke/static.js';
import { resolveInstallation } from './fixture.js';
import { pinBinary } from './pin.js';

const FIELDS = ['backend', 'mode', 'model', 'auth_mode', 'binary', 'version', 'candidate_egress', 'fixture_project', 'canary_deadlines'];
// D6 §2.6 (SEAM.md §393): an active entry's session qualification, the
// continuation canary alone; the rest is the entry's.
const ENTRY_FIELDS = ['entry', 'mode', 'model', 'fixture_project', 'canary_deadlines'];

// The canaries' default deadlines, in seconds (D2 §7.2: a deadline per canary;
// D6 §2.6: the continuation canary's covers both its turns).
export const CANARY_DEADLINES = { positive: 900, cancellation: 600, containment: 900, continuation: 1800 };

const invalid = (field: string, why: string) => new Refusal(400, 'invalid_value', `${field} ${why}.`, 'Correct the request; nothing was written.', { field });

export interface QualifyRequest {
  backend: string;
  mode: string;
  model: string;
  auth_mode: string;
  binary_path: string;
  binary_sha256: string;
  help_sha256: string;
  version: string;
  template: string;
  template_version: string;
  candidate_egress: string[];
  fixture_project: string;
  canary_deadlines: { positive: number; cancellation: number; containment: number; continuation: number };
  // D6 §2.6 (M5 slice 33).
  mode_requested: 'one_shot_headless' | 'session_headless';
  session_entry: string | null;
}

// Outside the test mode: the engine's own fixture project, made and
// registered on first use (trust/fixture.ts; api/server.ts).
export interface QualifyContext {
  fixtureProject: () => Promise<string>;
  // The active entry a session qualification names (D6 §2.6), as the store holds it.
  entryOf?: (id: string) => Promise<{ id: string; status: string; backend: string; binary_path: string; binary_sha256: string; help_sha256: string; model: string; auth_mode: string; egress_hosts: string; session_qualified: number } | null>;
  // The engine home, where a production attempt's binary is pinned.
  home: string;
}

export async function prepareQualify(b: unknown, ctx: QualifyContext | null = null): Promise<QualifyRequest> {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw invalid('the body', 'must be an object');
  const body = b as Record<string, unknown>;
  // In the engine's test mode only: a stand-in binary, a fixture project of
  // the test's, and the scripted backend (SEAM.md §148).
  const testMode = seamQualifyMode();
  if (body.entry !== undefined) return prepareSessionQualify(body, ctx, testMode);
  const allowed = testMode ? FIELDS : FIELDS.filter((f) => f !== 'binary' && f !== 'fixture_project' && f !== 'version');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new Refusal(400, 'unknown_field', `${k} is not a field of a qualification request.`, 'Remove it.', { field: k });
  const backend = body.backend;
  // The authentication mode (E74 item 1): `api_key` unless named; the
  // template, the credential and the entry are that mode's.
  const authMode = body.auth_mode ?? 'api_key';
  if (typeof authMode !== 'string' || !(AUTH_MODES as readonly string[]).includes(authMode)) throw invalid('auth_mode', `must be one of ${AUTH_MODES.join(', ')}`);
  if (typeof backend !== 'string' || !(backend in TEMPLATES || (testMode && backend === 'scripted'))) throw invalid('backend', `must be one of ${Object.keys(TEMPLATES).join(', ')}`);
  const template = templateOf(backend, { scripted: testMode, authMode });
  if (!template) throw invalid('auth_mode', `is not a mode ${backend} can be qualified in`);
  // `session_headless` (D6 §2.6): D2's three canaries and the continuation
  // canary; the entry is written for one-shot headless runs, qualified for
  // sessions by the fourth. No provider continuation is qualified.
  const mode = body.mode ?? 'one_shot_headless';
  if (mode !== 'one_shot_headless' && mode !== 'session_headless') throw invalid('mode', 'must be one_shot_headless or session_headless');
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
      if (!(k in deadlines) || !Number.isSafeInteger(v) || (v as number) < 1) throw invalid('canary_deadlines', 'must give positive whole seconds for positive, cancellation, containment and continuation');
      deadlines[k as keyof typeof deadlines] = v as number;
    }
  }
  const binary = body.binary;
  const path =
    given ??
    (typeof binary === 'object' && binary !== null && typeof (binary as Record<string, unknown>).path === 'string' ? String((binary as Record<string, unknown>).path) : typeof binary === 'string' ? binary : null);
  if (path === null) throw invalid('binary', 'must be {"path": <the stand-in binary>}');
  // Outside the test mode the attempt pins the engine's own copy of the
  // resolved binary (trust/pin.ts; E74 item 3); a stand-in is used as given.
  const statics = await staticChecks(backend, path, testMode || ctx === null ? null : ctx.home);
  return {
    backend,
    mode: 'one_shot_headless',
    mode_requested: mode,
    session_entry: null,
    model: body.model,
    auth_mode: authMode,
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

// An active entry's session qualification (D6 §2.6; SEAM.md §393): the
// continuation canary alone, on the entry's own binary (hashed again now and
// held to the entry's hashes), template, authentication mode, egress list
// and model; a request naming another model is refused (the review's M2).
// The profile and the host qualification are held to the entry's in the
// transaction (store/transitions/qualification.ts). Nothing is launched
// before its qualification_approval.
async function prepareSessionQualify(body: Record<string, unknown>, ctx: QualifyContext | null, testMode: boolean): Promise<QualifyRequest> {
  const allowed = testMode ? ENTRY_FIELDS : ENTRY_FIELDS.filter((f) => f !== 'fixture_project');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new Refusal(400, 'unknown_field', `${k} is not a field of a session qualification request.`, 'Send entry, mode and model.', { field: k });
  if (body.mode !== 'session_headless') throw invalid('mode', 'must be session_headless for an entry\'s session qualification');
  if (typeof body.entry !== 'string' || body.entry === '') throw invalid('entry', 'must name an active trust entry');
  if (body.model !== undefined && !isModelName(body.model)) throw invalid('model', 'must be a model name');
  const entry = ctx?.entryOf ? await ctx.entryOf(body.entry) : null;
  if (entry === null) throw new Refusal(404, 'not_found', `No trust entry ${body.entry} exists.`, 'Name an active entry.', { entry: body.entry });
  if (entry.status !== 'active') throw new Refusal(409, 'backend_refused', `Trust entry ${entry.id} is ${entry.status}, not active: only an active entry is qualified for sessions.`, 'Activate the entry first.', { entry: entry.id, status: entry.status });
  if (entry.session_qualified === 1) throw new Refusal(409, 'illegal_transition', `Trust entry ${entry.id} is already qualified for sessions.`, 'Nothing to do.', { entry: entry.id });
  // The canary runs on the entry's own model (D6 §2.6; D2 §7.2).
  if (body.model !== undefined && !sameModel(body.model as string, entry.model)) {
    throw new Refusal(409, 'backend_refused', `Trust entry ${entry.id} was qualified with the model ${entry.model}, not ${String(body.model)}: its session qualification runs on its own model.`, `Leave the model out, or name ${entry.model}.`, {
      entry: entry.id,
      model: body.model,
      entry_model: entry.model,
    });
  }
  let fixtureProject: string;
  if (testMode) {
    if (typeof body.fixture_project !== 'string' || body.fixture_project === '') throw invalid('fixture_project', 'must name the project the canary runs on');
    fixtureProject = body.fixture_project;
  } else {
    if (ctx === null) throw new Refusal(500, 'store_error', 'The engine could not make its fixture project.', 'Start the engine again.', {});
    fixtureProject = await ctx.fixtureProject();
  }
  const template = templateOf(entry.backend, { scripted: testMode, authMode: entry.auth_mode });
  if (!template) throw invalid('entry', `names a backend and mode (${entry.backend}, ${entry.auth_mode}) this engine has no template for`);
  const deadlines = { ...CANARY_DEADLINES };
  if (body.canary_deadlines !== undefined) {
    const d = body.canary_deadlines;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw invalid('canary_deadlines', 'must be an object');
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
      if (k !== 'continuation' || !Number.isSafeInteger(v) || (v as number) < 1) throw invalid('canary_deadlines', 'must give positive whole seconds for continuation');
      deadlines.continuation = v as number;
    }
  }
  // The entry's own copy, as qualified: its hash and help checked again and
  // held to what the entry recorded (D2 §7.3: a change is a new attempt).
  const statics = await staticChecks(entry.backend, entry.binary_path, null);
  if (statics.sha256 !== entry.binary_sha256 || statics.help !== entry.help_sha256) {
    throw new Refusal(409, 'backend_refused', `The binary at ${entry.binary_path} is not the one trust entry ${entry.id} was qualified with (${statics.sha256 !== entry.binary_sha256 ? 'its hash' : 'its help'} differs).`, 'Qualify the binary that is installed with a new attempt.', {
      entry: entry.id,
      expected_sha256: entry.binary_sha256,
      found_sha256: statics.sha256,
      help_matches: statics.help === entry.help_sha256,
    });
  }
  let egress: string[] = [];
  try {
    egress = JSON.parse(entry.egress_hosts) as string[];
  } catch {
    egress = [];
  }
  return {
    backend: entry.backend,
    mode: 'one_shot_headless',
    mode_requested: 'session_headless',
    session_entry: entry.id,
    model: entry.model,
    auth_mode: entry.auth_mode,
    binary_path: statics.path,
    binary_sha256: statics.sha256,
    help_sha256: statics.help,
    version: statics.version,
    template: template.text,
    template_version: template.version,
    candidate_egress: egress,
    fixture_project: fixtureProject,
    canary_deadlines: deadlines,
  };
}

// The static checks (D2 §7.2; SEAM.md §148): the binary's real path and its
// file's SHA-256, and `--version` and `--help`, each run once, exactly so,
// outside any domain. A real backend's binary is refused in the test mode.
async function staticChecks(backend: string, given: string, pinHome: string | null): Promise<{ path: string; sha256: string; help: string; version: string }> {
  if (!given.startsWith('/')) throw invalid('binary', 'must be an absolute path');
  let path: string;
  try {
    path = realpathSync(given);
  } catch {
    throw invalid('binary', `${given} cannot be resolved`);
  }
  const real = seamRefuseBinary(path, backend);
  if (real !== null) throw new Refusal(409, 'backend_refused', `The engine's test mode never runs a real backend's binary: ${real}.`, 'Name the stand-in binary.', { field: 'binary' });
  if (pinHome !== null) {
    // The operator's file answers --version once, to name the copy; then the
    // copy is what is checked, hashed and bound.
    const named = await versionOf(path, backend).catch(() => null);
    if (named === null) throw new Refusal(409, 'backend_refused', `${path} did not answer --version.`, 'Name a binary that answers it.', { field: 'binary' });
    try {
      path = (await pinBinary(pinHome, backend, path, named)).path;
    } catch (err) {
      throw new Refusal(500, 'backend_refused', `The engine could not make its own copy of ${path}: ${(err as Error).message}.`, 'Check the space in the engine home and ask again.', { field: 'binary' });
    }
  }
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  const version = await versionOf(path, backend).catch(() => null);
  const help = await helpHash(path, backend).catch(() => null);
  if (version === null || help === null) throw new Refusal(409, 'backend_refused', `${path} did not answer --version and --help.`, 'Name a binary that answers both.', { field: 'binary' });
  return { path, sha256, help, version };
}
