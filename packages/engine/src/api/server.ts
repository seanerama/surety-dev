// The local HTTP API (D1 §11; SEAM.md §§6, 7, 89 to 92). Every request passes,
// in this order and before routing, any body read or `100 Continue`: the Host
// check, the origin-evidence check, the token check (except on the shell
// routes and the token bootstrap) and the declared-length check. Every
// mutating request past the Host check is audited, refusals included, once
// the store is open. Every response carries the defensive headers.

import { prepareQualify } from '../trust/qualify.js';
import { credentialRef } from '../invoke/adapters/templates.js';
import { ensureFixtureProject, findFixtureProject } from '../trust/fixture.js';
import { heldProviderCaps } from '../records/redact.js';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { inspectEngineConfig } from '../config/engine-config.js';
import { runningClassifierVersion } from '../checks/classify.js';
import type { EngineState } from '../engine.js';
import { ENGINE_VERSION } from '../index.js';
import { answerFacts } from '../decisions/facts.js';
import { ensurePresence, gateFacts } from '../gates/prepare.js';
import { prepareBootstrap, preparePolicy, prepareRebind } from '../projects/commands.js';
import { prepareConfig, prepareDeployment } from '../deploy/commands.js';
import { homePaths } from '../paths.js';
import { log } from '../runtime.js';
import { liveTranscript, readRecordBytes } from '../records/files.js';
import type { RecordRow } from '../store/transitions/records.js';
import { EventReader } from '../store/reader-client.js';
import { newId } from '../ids.js';
import { Refusal, storeError } from '../refusal.js';
import type { Actor } from '../store/transitions/tx.js';
import { seamBackends, seamDescribe, seamRoute, seamTokenRead } from '../testing/seam.js';
import { DEFENSIVE_HEADERS, checkBootstrapEvidence, checkOrigin, checkTarget, checkToken, payloadTooLarge, readJsonBody } from './boundary.js';
import { SHELL_CSP, loadShell } from './shell.js';
import { type TailSource, serveEvents, serveTail } from './streams.js';

interface Reply {
  status: number;
  body: unknown;
  // A record's bytes, answered as they are (SEAM.md §56).
  raw?: Buffer;
  // The content type of `raw`, if not application/octet-stream.
  type?: string;
  headers?: Record<string, string>;
}

interface Request {
  method: string;
  path: string;
  query: string;
  req: IncomingMessage;
  res: ServerResponse;
  actor: Actor;
  // The client sent `Expect: 100-continue` and has not yet been told to send
  // its body.
  awaitingContinue: boolean;
}

// A matched route. A direct route (a read, or a route the seam provides) is
// answered by its handler and not audited. A refusal route is audited here. A
// command is prepared here (body read and checked; a failure is audited here)
// and then runs in the store, which commits its audit record with it.
//
// A prepared command first does, on the main thread and with no transaction
// open, the reads and git work its transaction needs (projects/commands.ts);
// a refusal there is audited like any other.
type Route =
  | { kind: 'direct'; restricted?: boolean; handler: (r: Request) => Promise<Reply> }
  // A server-sent event stream: the handler answers the head and writes the body.
  | { kind: 'stream'; open: (r: Request) => Promise<(res: ServerResponse) => Promise<void>> }
  | { kind: 'refuse'; refusal: Refusal }
  | { kind: 'command'; name: string; args: (body: unknown) => unknown }
  | { kind: 'prepared'; name: string; prepare: (body: unknown) => Promise<unknown> };

const MUTATING = (method: string) => method !== 'GET' && method !== 'HEAD';

const notFound = (path: string) =>
  new Refusal(404, 'not_found', `No route ${path} exists in this engine.`, 'Check the method and path.', { path });

const unsupported = (what: string) =>
  new Refusal(
    501,
    'unsupported',
    `${what} is outside milestone M1 and is not available in this engine.`,
    'Nothing was done. This capability needs a later design and milestone.',
    { capability: what },
  );

const quarantinedRecord = (id: string) =>
  new Refusal(409, 'record_quarantined', `Record ${id} matched a secret detector and is no longer served.`, 'Inspect the record through the engine home; resolve the finding.', { record: id });

// A path segment, percent-decoded; null if the escape is malformed.
const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const isObject = (b: unknown): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b);

// A body that is absent or an object of only these fields.
const onlyFields = (b: unknown, fields: string[]): Record<string, unknown> => {
  if (b === undefined) return {};
  if (!isObject(b)) throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send a JSON object.', { field: null });
  for (const key of Object.keys(b)) {
    if (!fields.includes(key)) throw new Refusal(400, 'unknown_field', `"${key}" is not a field of this command.`, `Send only ${fields.join(', ') || 'an empty object'}.`, { field: key });
  }
  return b;
};

const optionalString = (b: Record<string, unknown>, field: string): string | undefined => {
  const v = b[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Refusal(400, 'invalid_value', `"${field}" must be a string.`, `Send "${field}" as a string.`, { field });
  return v;
};

const noFields = (b: unknown) => {
  if (b === undefined) return;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    throw new Refusal(400, 'invalid_value', 'The request body must be a JSON object.', 'Send {} or no body.', { field: null });
  }
  const [extra] = Object.keys(b);
  if (extra !== undefined) throw new Refusal(400, 'unknown_field', `"${extra}" is not a field of this command.`, 'Send {} or no body.', { field: extra });
};

// A query parameter that must be a non-negative integer, or a default.
function integerParam(query: string, name: string, fallback: number | null, min: number): number | null {
  const value = new URLSearchParams(query).get(name);
  if (value === null) return fallback;
  if (!/^\d{1,15}$/.test(value) || Number(value) < min) {
    throw new Refusal(400, 'invalid_value', `"${name}" must be an integer of at least ${min}.`, `Send ?${name}=<an integer of at least ${min}>, or leave it out.`, { field: name });
  }
  return Number(value);
}

export interface ApiOptions {
  home: string;
  // The directory of the static shell, or null for none (SEAM.md §90).
  shellDir: string | null;
}

export function createApiServer(state: EngineState, opts: ApiOptions): http.Server {
  const token = Buffer.from(state.token, 'utf8');
  const authority = state.config.values.api_authority;
  const bodyCap = state.config.values.body_cap;
  const bodyDeadlineMs = state.config.values.request_body_deadline * 1000;
  const shell = loadShell(opts.shellDir);
  const reader = new EventReader(homePaths(opts.home).store);
  const maxConcurrentRuns = state.config.values.max_concurrent_runs;

  // Reading a body is what earns a `100 Continue`: only a request that has
  // passed the Host and token checks and reached a command that reads its
  // body is told to send it (D1 §11.1, SEAM.md §6).
  const body = async (r: Request): Promise<unknown> => {
    if (r.awaitingContinue) {
      r.awaitingContinue = false;
      r.res.writeContinue();
    }
    return readJsonBody(r.req, bodyCap, bodyDeadlineMs);
  };
  const store = () => {
    if (!state.store) throw storeError(new Error('the store is not open'));
    return state.store;
  };
  const runtime = () => {
    if (!state.runtime) throw storeError(new Error('the engine is not running'));
    return state.runtime;
  };

  // The engine's own fixture project for a qualification attempt outside the
  // test mode (trust/fixture.ts).
  const engineFixtureProject = (): Promise<string> => ensureFixtureProject(runtime(), store());

  function match(method: string, s: string[]): Route | null {
    const get = method === 'GET' || method === 'HEAD';
    const post = method === 'POST';
    if (s[0] !== 'v1') return null;

    if (s.length === 2 && s[1] === 'health' && get) {
      return { kind: 'direct', restricted: true, handler: async () => ({ status: 200, body: { mode: state.mode } }) };
    }
    if (s.length === 2 && s[1] === 'engine' && get) {
      return { kind: 'direct', restricted: true, handler: async () => ({ status: 200, body: await engineInfo(state) }) };
    }

    // The engine-scoped decisions (SEAM.md §117): trust_activation and
    // qualification_approval belong to no project.
    if (s.length === 2 && s[1] === 'decisions' && get) {
      return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'decisions.engine', args: {} }) }) };
    }
    if (s.length === 4 && s[1] === 'decisions' && s[3] === 'answer' && post) {
      const decision = decodeSegment(s[2]!);
      if (decision === null) return null;
      return {
        kind: 'prepared',
        name: 'decision.answer',
        prepare: async (b) => {
          const body = onlyFields(b, ['option', 'preview_hash', 'note']);
          return { project: null, decision, option: body.option, preview_hash: body.preview_hash, note: body.note, facts: {} };
        },
      };
    }
    // POST /v1/trust/qualify (D2 §7.2): the candidate egress list is
    // validated here; the attempt itself is slice 13's (row M135). The echo
    // endpoint is the probe suite's alone and no attempt may list it
    // (D2 §2.4; SEAM.md §140).
    if (s.length === 3 && s[1] === 'trust' && s[2] === 'qualify' && post) {
      return {
        kind: 'prepared',
        name: 'trust.qualify',
        prepare: async (b) => {
          const request = await prepareQualify(b, { fixtureProject: engineFixtureProject, home: runtime().home });
          // The provider-side cap held with the key's reference, shown on
          // the attempt as configured, never as engine enforcement (Q2).
          const cap = heldProviderCaps()[credentialRef(request.backend, request.auth_mode)];
          return { ...request, provider_cap_usd: cap ?? null };
        },
      };
    }
    if (s.length === 2 && s[1] === 'projects' && post) {
      return { kind: 'prepared', name: 'project.create', prepare: (b) => prepareBootstrap(runtime(), b) };
    }
    if (s.length === 2 && s[1] === 'projects' && get) {
      return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'projects.list', args: { maxConcurrentRuns } }) }) };
    }
    if (s.length === 2 && s[1] === 'events' && method === 'GET') {
      return {
        kind: 'stream',
        open: async (r) => {
          const since = integerParam(r.query, 'since', 0, 0)!;
          const limit = integerParam(r.query, 'limit', null, 1);
          return (res) => serveEvents(res, { reader, store: store(), since, limit });
        },
      };
    }
    if (s.length === 3 && s[1] === 'projects' && get) {
      const project = decodeSegment(s[2]!);
      if (project === null) return null;
      return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'project.read', args: { project, maxConcurrentRuns } }) }) };
    }

    if (s[1] === 'projects' && s.length >= 4) {
      const project = decodeSegment(s[2]!);
      if (project === null) return null;
      const rest = s.slice(3);
      if (rest.length === 1 && rest[0] === 'policy') {
        if (get) {
          return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'project.policy', args: { project } }) }) };
        }
        if (post) return { kind: 'prepared', name: 'project.policy_submit', prepare: (b) => preparePolicy(runtime(), project, b) };
      }
      if (rest.length === 1 && rest[0] === 'decisions' && get) {
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'decisions.open', args: { project } }) }) };
      }
      if (rest.length === 2 && rest[0] === 'candidates' && get) {
        const candidate = decodeSegment(rest[1]!);
        if (candidate === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'candidate.read', args: { project, candidate } }) }) };
      }
      if (rest.length === 1 && rest[0] === 'work' && get) {
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'work.list', args: { project } }) }) };
      }
      // The reads of D1 §11.3 added in M2 (brief B4): reads, which probe,
      // evaluate and write nothing.
      if (rest.length === 2 && rest[0] === 'decisions' && get) {
        const decision = decodeSegment(rest[1]!);
        if (decision === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'decision.read', args: { project, decision } }) }) };
      }
      if (rest.length === 1 && rest[0] === 'operations' && get) {
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'operations.list', args: { project } }) }) };
      }
      if (rest.length === 1 && rest[0] === 'environments' && get) {
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'environments.list', args: { project } }) }) };
      }
      // D4 §§3.2, 4.1, 4.6, 6.1 (M4 slice 23): an environment's stored read;
      // its configuration, written by the owner; the deployment request;
      // the ordinary teardown.
      if (rest.length === 2 && rest[0] === 'environments' && get) {
        const environment = decodeSegment(rest[1]!);
        if (environment === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'environment.read', args: { project, environment } }) }) };
      }
      if (rest.length === 3 && rest[0] === 'environments' && rest[2] === 'config' && method === 'PUT') {
        const environment = decodeSegment(rest[1]!);
        if (environment === null) return null;
        return { kind: 'prepared', name: 'environment.configure', prepare: async (b) => prepareConfig(runtime(), project, environment, b) };
      }
      if (rest.length === 3 && rest[0] === 'environments' && rest[2] === 'teardown' && post) {
        const environment = decodeSegment(rest[1]!);
        if (environment === null) return null;
        return {
          kind: 'command',
          name: 'environment.teardown',
          args: (b) => {
            noFields(b);
            return { project, environment };
          },
        };
      }
      if (rest.length === 1 && rest[0] === 'deployments' && post) {
        return { kind: 'prepared', name: 'deployment.request', prepare: async (b) => prepareDeployment(runtime(), project, b) };
      }
      // D3 A.7; SEAM.md §§178, 180: a protected version as discovery read it,
      // and a candidate's check executions; reads.
      if (rest.length === 2 && rest[0] === 'protected-versions' && get) {
        const version = decodeSegment(rest[1]!);
        if (version === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'protected.version', args: { project, version } }) }) };
      }
      if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'checks' && get) {
        const candidate = decodeSegment(rest[1]!);
        if (candidate === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'candidate.executions', args: { project, candidate } }) }) };
      }
      // The latest recorded evaluation; a read, which evaluates nothing.
      if (rest.length === 4 && rest[0] === 'candidates' && rest[2] === 'gates' && get) {
        const candidate = decodeSegment(rest[1]!);
        const kind = decodeSegment(rest[3]!);
        if (candidate === null || kind === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'candidate.gate', args: { project, candidate, kind } }) }) };
      }
      if (rest.length === 3 && rest[0] === 'runs' && rest[2] === 'tail' && method === 'GET') {
        const run = decodeSegment(rest[1]!);
        if (run === null) return null;
        return { kind: 'stream', open: (r) => openTail(project, run, r.query) };
      }
      if (rest.length === 1 && rest[0] === 'ledger' && get) {
        return { kind: 'direct', handler: async (r) => ({ status: 200, body: await store().call('read', { name: 'ledger.view', args: { project, day: ledgerDay(r.query) } }) }) };
      }
      if (rest.length === 2 && rest[0] === 'records' && get) {
        const record = decodeSegment(rest[1]!);
        if (record === null) return null;
        return { kind: 'direct', handler: async () => readRecord(project, record) };
      }
      if (rest.length === 1 && rest[0] === 'rebind' && post) {
        return { kind: 'prepared', name: 'project.rebind', prepare: (b) => prepareRebind(runtime(), project, b) };
      }
      if (rest.length === 1 && rest[0] === 'tick' && post) {
        return {
          kind: 'command',
          name: 'project.tick',
          args: (b) => {
            noFields(b);
            return { project };
          },
        };
      }
      if (rest.length === 3 && rest[0] === 'runs' && (rest[2] === 'stop' || rest[2] === 'abandon') && post) {
        const run = decodeSegment(rest[1]!);
        if (run === null) return null;
        return {
          kind: 'command',
          name: rest[2] === 'stop' ? 'run.stop' : 'run.abandon',
          args: (b) => ({
            project,
            run,
            preview_hash: optionalString(onlyFields(b, ['preview_hash']), 'preview_hash'),
            // What the running engine has decided of the run, read when the
            // command is sent; the store runs commands in the order sent.
            decided: state.runtime?.endDecided(run) ?? false,
            // Its backend has exited on its own (Q13): the exit decides.
            exited: state.runtime?.exitedFirst(run) ?? false,
          }),
        };
      }
      if (rest.length === 2 && rest[0] === 'runs' && get) {
        const run = decodeSegment(rest[1]!);
        if (run === null) return null;
        return { kind: 'direct', handler: async () => ({ status: 200, body: await store().call('read', { name: 'run.representation', args: { project, run } }) }) };
      }
      if (rest.length === 3 && rest[0] === 'work' && rest[2] === 'resume' && post) {
        const workItem = decodeSegment(rest[1]!);
        if (workItem === null) return null;
        return {
          kind: 'command',
          name: 'work.resume',
          args: (b) => {
            noFields(b);
            return { project, work_item: workItem };
          },
        };
      }
      if (rest.length === 2 && rest[0] === 'decisions' && rest[1] === 'answer-batch' && post) {
        return {
          kind: 'prepared',
          name: 'decision.answer_batch',
          prepare: async (b) => {
            const body = onlyFields(b, ['answers']);
            const facts: Record<string, unknown> = {};
            if (Array.isArray(body.answers)) {
              for (const a of body.answers as { decision?: unknown }[]) {
                if (typeof a?.decision === 'string') facts[a.decision] = await answerFacts(runtime(), project, a.decision);
              }
            }
            return { project, answers: body.answers, facts };
          },
        };
      }
      if (rest.length === 3 && rest[0] === 'decisions' && rest[2] === 'answer' && post) {
        const decision = decodeSegment(rest[1]!);
        if (decision === null) return null;
        return {
          kind: 'prepared',
          name: 'decision.answer',
          prepare: async (b) => {
            const body = onlyFields(b, ['option', 'preview_hash', 'note']);
            return { project, decision, option: body.option, preview_hash: body.preview_hash, note: body.note, facts: await answerFacts(runtime(), project, decision) };
          },
        };
      }
      if (rest.length === 4 && rest[0] === 'candidates' && rest[2] === 'gates' && post) {
        const candidate = decodeSegment(rest[1]!);
        const kind = decodeSegment(rest[3]!);
        if (candidate === null || kind === null) return null;
        // The engine computes three gate kinds (`alpha_complete` since M4,
        // D4 §5.5); every other is refused before any effect, whatever the
        // body (build spec §3; row M08).
        if (kind !== 'stage' && kind !== 'alpha_authorize' && kind !== 'alpha_complete') return { kind: 'refuse', refusal: unsupported(`Evaluating the ${kind} gate`) };
        return {
          kind: 'prepared',
          name: 'gate.evaluate',
          prepare: async (b) => {
            const body = onlyFields(b, kind === 'stage' ? ['stage'] : kind === 'alpha_complete' ? ['operation'] : ['authorization']);
            const facts = await gateFacts(runtime(), project, candidate);
            return { project, candidate, kind, stage: body.stage, authorization: body.authorization, operation: body.operation, ...facts };
          },
        };
      }
      // D3 A.7: operator-requested executions of a candidate's required checks.
      if (rest.length === 3 && rest[0] === 'candidates' && rest[2] === 'checks' && post) {
        const candidate = decodeSegment(rest[1]!);
        if (candidate === null) return null;
        // The candidate's required checks need its module presence (D3
        // §4.1): read first, as a gate evaluation reads its facts.
        return {
          kind: 'prepared',
          name: 'candidate.request_checks',
          prepare: async (b) => {
            await ensurePresence(runtime(), project).catch((err) => log('module presence', err, { project }));
            return { project, candidate, body: b };
          },
        };
      }
      // J3: no production route takes an authorization's binding from the
      // caller; `POST …/candidates/:c/authorizations` is gone (404, as any
      // route this engine does not have). The deployment request derives it.
      if (rest.length === 1 && (rest[0] === 'pause' || rest[0] === 'resume') && post) {
        return {
          kind: 'command',
          name: rest[0] === 'pause' ? 'project.pause' : 'project.resume',
          args: (b) => {
            noFields(b);
            return { project };
          },
        };
      }
      // Sessions are excluded from M1 (build spec §3, row M08): refused
      // whether or not the run exists, before anything is read or written.
      const sessionRoute =
        (rest.length === 1 && rest[0] === 'sessions') ||
        (rest.length === 3 && rest[0] === 'sessions' && ['turns', 'save', 'close'].includes(rest[2]!));
      if (sessionRoute && post) return { kind: 'refuse', refusal: unsupported('Agent sessions') };
      // Management and releases belong to later designs; every method is refused.
      if (rest[0] === 'management') return { kind: 'refuse', refusal: unsupported('Management') };
      if (rest[0] === 'releases') return { kind: 'refuse', refusal: unsupported('Releases') };
    }
    return null;
  }

  // GET /v1/projects/:p/records/:id (D1 §11.3; SEAM.md §§56-58). Unknown is
  // never answered as empty: a record that is not whole is refused.
  async function readRecord(project: string, id: string): Promise<Reply> {
    const row = await store().call<RecordRow>('read', { name: 'record.get', args: { project, record: id } });
    const refuse = (status: number, code: string, reason: string, whatToDo: string) => {
      throw new Refusal(status, code, reason, whatToDo, { record: id });
    };
    if (row.published !== 1) refuse(409, 'record_unpublished', `Record ${id} is a stream that was never published, so it is not known to be whole.`, 'Nothing depends on it; read a published record.');
    if (row.path === null) refuse(410, 'record_expired', `Record ${id} has expired: its retention passed and its content was removed.`, 'Its row says what it was; its bytes are gone.');
    if (row.post_scan === 'hit') throw quarantinedRecord(id);
    const bytes = await readRecordBytes(runtime().home, { path: row.path!, sha256: row.sha256, bytes: row.bytes });
    if (bytes === null) refuse(409, 'record_missing', `The bytes of record ${id} are missing or do not have the recorded hash.`, 'Restore the record from a backup; it is not served as anything else.');
    return { status: 200, body: null, raw: bytes! };
  }

  // GET /v1/projects/:p/runs/:r/tail (SEAM.md §92). The run must be of the
  // project in the path; a run that has ended with no published transcript
  // has no output to serve, which is not an empty output.
  async function openTail(project: string, run: string, query: string): Promise<(res: ServerResponse) => Promise<void>> {
    const offset = integerParam(query, 'offset', 0, 0)!;
    type Source = { ended: boolean; record: { id: string; path: string; sha256: string | null; bytes: number | null; quarantined: boolean } | null };
    const source = () => store().call<Source>('read', { name: 'run.tail', args: { project, run } });
    const first = await source();
    // A quarantined record is served by no route (E42 item 1): the tail is
    // refused as the record read is, and delivers none of its bytes.
    if (first.record?.quarantined) throw quarantinedRecord(first.record.id);
    if (first.ended && first.record === null && !liveTranscript(run)) {
      throw new Refusal(409, 'record_unpublished', `The output of run ${run} was not kept whole, so there is none to serve.`, 'Read the run for how it ended.', { run });
    }
    const settled = async (): Promise<TailSource | 'ended' | 'pending'> => {
      const now = await source();
      if (now.record !== null) {
        const record = now.record;
        // Quarantined while the tail was open: nothing more of it is served.
        if (record.quarantined) return 'ended';
        const bytes = await readRecordBytes(runtime().home, { path: record.path, sha256: record.sha256, bytes: record.bytes });
        if (bytes === null) return 'ended';
        return { kind: 'file', total: bytes.length, read: async (at, max) => bytes.subarray(at, at + max) };
      }
      return now.ended ? 'ended' : 'pending';
    };
    return (res) => serveTail(res, { run, offset, settled });
  }

  // A request no production route matched is offered to the seam, which
  // answers only in harness mode (SEAM.md §7).
  function offerToSeam(r: Request, segments: string[]): Route | null {
    const offered = seamRoute(r.method, segments, { body: () => body(r), store, actor: r.actor, scratch: () => runtime(), runtime });
    return offered === null ? null : { kind: 'direct', restricted: offered.restricted, handler: offered.handler };
  }

  async function audit(actor: Actor, method: string, path: string, status: number): Promise<Refusal | null> {
    try {
      await store().call('audit', { actor, method, path, status });
      return null;
    } catch (err) {
      return err instanceof Refusal ? err : storeError(err);
    }
  }

  // expect: 'none' (no expectation), 'continue' (exactly `100-continue`), or
  // 'refuse' (any other expectation, which the engine answers itself after
  // the boundary checks, SEAM.md §6).
  async function handle(req: IncomingMessage, res: ServerResponse, expect: 'none' | 'continue' | 'refuse'): Promise<void> {
    const expectsContinue = expect === 'continue';
    const requestId = newId('req_');
    const method = req.method ?? 'GET';
    const send = (reply: Reply) => {
      if (res.headersSent) return;
      const text = method === 'HEAD' ? '' : reply.raw ?? JSON.stringify(reply.body);
      const headers: Record<string, string> = {
        ...DEFENSIVE_HEADERS,
        'content-type': reply.raw ? (reply.type ?? 'application/octet-stream') : 'application/json; charset=utf-8',
        'x-surety-request-id': requestId,
        ...(reply.headers ?? {}),
      };
      // A request whose body was not read is not read further: the
      // connection ends with the answer.
      if (!req.complete) headers.connection = 'close';
      res.writeHead(reply.status, headers);
      res.end(text);
    };
    const refuse = (err: unknown) => {
      const refusal = err instanceof Refusal ? err : storeError(err);
      send({ status: refusal.status, body: refusal.body() });
      return refusal;
    };

    // 1. Host and target.
    let target;
    try {
      target = checkTarget(req, authority);
    } catch (err) {
      refuse(err);
      return;
    }

    const actor: Actor = { actor_kind: 'human', actor_id: null, request_id: requestId };
    const mutating = MUTATING(method);
    // Audit a refusal decided here, when the store can take it. In restricted
    // mode the store may be mid-migration, so nothing is audited.
    const refuseAudited = async (err: unknown) => {
      const refusal = err instanceof Refusal ? err : storeError(err);
      if (mutating && state.mode === 'full') {
        const failed = await audit(actor, method, target.path, refusal.status);
        if (failed) return void refuse(failed);
      }
      refuse(refusal);
    };

    // 2. Origin evidence.
    let evidence;
    try {
      evidence = checkOrigin(req, authority);
    } catch (err) {
      return refuseAudited(err);
    }

    // The routes that need no token: the enumerated shell files, and the
    // token bootstrap, which needs positive same-origin evidence instead.
    const get = method === 'GET' || method === 'HEAD';
    const file = get ? shell.get(target.path) : undefined;
    if (file) {
      const headers: Record<string, string> = file.document ? { 'content-security-policy': SHELL_CSP } : {};
      return void send({ status: 200, body: null, raw: file.bytes, type: file.type, headers });
    }
    if (get && target.path === '/v1/token/bootstrap') {
      // D2 §2.6, K3: the route answers only while the bootstrap exception is
      // in force, and otherwise refuses before the token is read.
      if (state.config.values.ui_bootstrap !== true) {
        return void refuse(
          new Refusal(
            403,
            'bootstrap_disabled',
            'The token bootstrap route is disabled: it trusts headers any local program can forge, so it answers only when the engine setting ui_bootstrap is true.',
            'Read the token from api.token in the engine home, or set ui_bootstrap to true in config.json for an explicitly labelled compatibility test.',
            { setting: 'ui_bootstrap' },
          ),
        );
      }
      try {
        checkBootstrapEvidence(evidence);
      } catch (err) {
        return void refuse(err);
      }
      let token: string;
      try {
        token = readBootstrapToken(state);
      } catch (err) {
        return void refuse(err);
      }
      return void send({ status: 200, body: { token } });
    }

    // 3. Token.
    try {
      checkToken(req, token);
    } catch (err) {
      return refuseAudited(err);
    }
    // 4. Declared length: refused before any of the body is read.
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > bodyCap) return refuseAudited(payloadTooLarge(bodyCap));
    if (expect === 'refuse') {
      const value = String(req.headers.expect ?? '');
      return refuseAudited(
        new Refusal(417, 'expect_refused', `The expectation "${value}" is not one this engine meets.`, 'Send the request without an Expect header, or with Expect: 100-continue.', {
          expect: value,
        }),
      );
    }

    const segments = target.path.split('/').slice(1);
    const r: Request = { method, path: target.path, query: target.query, req, res, actor, awaitingContinue: expectsContinue };
    let route: Route | null;
    try {
      route = match(method, segments) ?? offerToSeam(r, segments);
    } catch (err) {
      return refuseAudited(err);
    }
    const restricted = route !== null && route.kind === 'direct' && route.restricted === true;
    if (state.mode !== 'full' && !restricted) {
      refuse(
        new Refusal(503, 'engine_starting', `The engine is in restricted mode at startup step "${state.step}".`, 'Wait for startup to finish, or read GET /v1/engine for a startup failure.', {
          step: state.step,
        }),
      );
      return;
    }
    if (!route) return refuseAudited(notFound(target.path));

    switch (route.kind) {
      case 'refuse':
        return refuseAudited(route.refusal);
      case 'command':
      case 'prepared': {
        let args: unknown;
        try {
          args = route.kind === 'command' ? route.args(await body(r)) : await route.prepare(await body(r));
        } catch (err) {
          return refuseAudited(err);
        }
        try {
          const result = await store().call<Reply & { effects?: { kind: string; run?: string }[] }>('mutate', { name: route.name, args, actor, method, path: target.path });
          send({ status: result.status, body: result.body });
          if (result.effects && result.effects.length > 0) state.runtime?.afterCommit(result.effects);
        } catch (err) {
          refuse(err);
        }
        return;
      }
      case 'stream': {
        let write: (res: ServerResponse) => Promise<void>;
        try {
          write = await route.open(r);
        } catch (err) {
          refuse(err);
          return;
        }
        if (res.headersSent) return;
        res.writeHead(200, { ...DEFENSIVE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'x-surety-request-id': requestId });
        res.flushHeaders();
        res.on('error', () => {});
        await write(res);
        return;
      }
      default:
        try {
          send(await route.handler(r));
        } catch (err) {
          refuse(err);
        }
    }
  }

  const serve = (mode: 'none' | 'continue' | 'expect') => (req: IncomingMessage, res: ServerResponse) => {
    // Node routes an Expect header that merely contains `100-continue` here
    // too; only the exact expectation earns a `100 Continue`.
    const expect =
      mode === 'none' ? 'none' : mode === 'continue' && String(req.headers.expect ?? '').trim().toLowerCase() === '100-continue' ? 'continue' : 'refuse';
    handle(req, res, expect).catch((err) => {
      try {
        const refusal = err instanceof Refusal ? err : storeError(err);
        if (!res.headersSent) {
          res.writeHead(refusal.status, { ...DEFENSIVE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(refusal.body()));
        }
      } catch {
        res.destroy();
      }
    });
  };
  // The engine answers a request without a Host header itself (E23 item 10).
  const server = http.createServer({ requireHostHeader: false }, serve('none'));
  // Without these listeners Node answers an `Expect` header itself (`100
  // Continue`, or 417 for anything else), before the boundary checks have run.
  server.on('checkContinue', serve('continue'));
  server.on('checkExpectation', serve('expect'));
  // A request the HTTP parser rejects is answered by the engine, in its own
  // form and with its headers (D1 §17(13), §17(14)); a client that failed in
  // the middle of a request or a stream only ends its own connection.
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    const busy = (socket as unknown as { _httpMessage?: unknown })._httpMessage !== undefined && (socket as unknown as { _httpMessage?: unknown })._httpMessage !== null;
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || !socket.writable || busy) {
      socket.destroy();
      return;
    }
    const tooLarge = err.code === 'HPE_HEADER_OVERFLOW';
    const refusal = tooLarge
      ? new Refusal(431, 'invalid_value', 'The request header section is larger than this engine reads.', 'Send a request with a smaller header section.', { field: null })
      : new Refusal(400, 'invalid_value', 'The request is not a well-formed HTTP/1.1 request.', 'Send a well-formed HTTP/1.1 request.', { field: null });
    const text = JSON.stringify(refusal.body());
    const head = [
      `HTTP/1.1 ${refusal.status} ${tooLarge ? 'Request Header Fields Too Large' : 'Bad Request'}`,
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(text)}`,
      ...Object.entries(DEFENSIVE_HEADERS).map(([k, v]) => `${k}: ${v}`),
      'Connection: close',
    ];
    try {
      socket.end(`${head.join('\r\n')}\r\n\r\n${text}`);
    } catch {
      socket.destroy();
    }
  });
  server.on('close', () => void reader.close());
  return server;
}

// `?day=YYYY-MM-DD`, or every day.
function ledgerDay(query: string): string | null {
  const day = new URLSearchParams(query).get('day');
  if (day === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Refusal(400, 'invalid_value', '"day" must be a date, YYYY-MM-DD.', 'Send ?day=YYYY-MM-DD, or no day for every day.', { field: 'day' });
  }
  return day;
}

// The one place the bootstrap route reads the token (D2 §2.6), after the
// setting and the evidence have been checked.
function readBootstrapToken(state: EngineState): string {
  seamTokenRead();
  return state.token;
}

interface TrustView {
  backends: string[];
  host_qualification: unknown;
  trust_entries: unknown[];
  qualification_attempts: unknown[];
}

async function engineInfo(state: EngineState) {
  const scripted = seamBackends().some((b) => b.id === 'scripted');
  // The trust table, read from the store once it is open (D2 A.7). Unknown
  // is not empty: while it cannot be read, it is null.
  let trust: TrustView | null = null;
  if (state.store && state.completed.includes('store')) {
    trust = await state.store.call<TrustView>('read', { name: 'trust.view', args: { scripted } }).catch(() => null);
  }
  const bootstrap = state.config.values.ui_bootstrap === true;
  return seamDescribe({
    version: ENGINE_VERSION,
    incarnation: state.lock.incarnation_id,
    mode: state.mode,
    // The backends a dispatch may use: those with an active trust entry, and
    // the scripted backend only where the test seam provides it (D2 §5 C3).
    backends: trust?.backends ?? (scripted ? ['scripted'] : []),
    config: inspectEngineConfig(state.config),
    // D3 §3.3 (SEAM.md §217): the classifier this engine runs; every
    // classification records it.
    classifier_version: runningClassifierVersion(),
    startup: { step: state.step, completed: [...state.completed], failed: state.failed },
    // D2 §2.6: whether the bootstrap exception is in force; while it is, no
    // protection from other local uids is claimed and no host qualification
    // is active.
    bootstrap_exception: bootstrap,
    // SEAM.md §164: the engine's own qualification fixture project, null
    // where the home has none (and while the store cannot be read).
    qualification_fixture_project: state.store && state.completed.includes('store') ? await findFixtureProject(state.store, state.home).catch(() => null) : null,
    // D2 §6, §7.1 (SEAM.md §§114, 118): the checks, the host's eligibility
    // and where it comes from. The checks are not built in this engine
    // revision: each is not_exercised, never passed.
    host_qualification: trust?.host_qualification ?? null,
    // D2 §3.1: the incarnation scope the engine runs in, null without one.
    scope: state.scope,
    trust_entries: trust?.trust_entries ?? null,
    qualification_attempts: trust?.qualification_attempts ?? null,
  });
}
