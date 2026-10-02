// The local HTTP API for slice 1 (D1 §11, SEAM.md §6–7). Every request passes
// the Host check and the token check before routing; every mutating request
// past the Host check is audited, refusals included, once the store is open.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { inspectEngineConfig } from '../config/engine-config.js';
import type { EngineState } from '../engine.js';
import { ENGINE_VERSION } from '../index.js';
import { prepareBootstrap, preparePolicy, prepareRebind } from '../projects/commands.js';
import { readRecordBytes } from '../records/files.js';
import type { RecordRow } from '../store/transitions/records.js';
import { newId } from '../ids.js';
import { Refusal, storeError } from '../refusal.js';
import type { Actor } from '../store/transitions/tx.js';
import { seamBackends, seamDescribe, seamRoute } from '../testing/seam.js';
import { checkTarget, checkToken, readJsonBody } from './boundary.js';

interface Reply {
  status: number;
  body: unknown;
  // A record's bytes, answered as they are (SEAM.md §56).
  raw?: Buffer;
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

export function createApiServer(state: EngineState): http.Server {
  const token = Buffer.from(state.token, 'utf8');
  const authority = state.config.values.api_authority;
  const bodyCap = state.config.values.body_cap;
  const bodyDeadlineMs = state.config.values.request_body_deadline * 1000;

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

  function match(method: string, s: string[]): Route | null {
    const get = method === 'GET' || method === 'HEAD';
    const post = method === 'POST';
    if (s[0] !== 'v1') return null;

    if (s.length === 2 && s[1] === 'health' && get) {
      return { kind: 'direct', restricted: true, handler: async () => ({ status: 200, body: { mode: state.mode } }) };
    }
    if (s.length === 2 && s[1] === 'engine' && get) {
      return { kind: 'direct', restricted: true, handler: async () => ({ status: 200, body: engineInfo(state) }) };
    }

    if (s.length === 2 && s[1] === 'projects' && post) {
      return { kind: 'prepared', name: 'project.create', prepare: (b) => prepareBootstrap(runtime(), b) };
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
      if (rest.length === 3 && rest[0] === 'decisions' && rest[2] === 'answer' && post) {
        const decision = decodeSegment(rest[1]!);
        if (decision === null) return null;
        return {
          kind: 'command',
          name: 'decision.answer',
          args: (b) => {
            const body = onlyFields(b, ['option', 'preview_hash', 'note']);
            return { project, decision, option: body.option, preview_hash: body.preview_hash, note: body.note };
          },
        };
      }
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
    if (row.post_scan === 'hit') refuse(409, 'record_quarantined', `Record ${id} matched a secret detector and is no longer served.`, 'Inspect the record through the engine home; resolve the finding.');
    const bytes = await readRecordBytes(runtime().home, { path: row.path!, sha256: row.sha256, bytes: row.bytes });
    if (bytes === null) refuse(409, 'record_missing', `The bytes of record ${id} are missing or do not have the recorded hash.`, 'Restore the record from a backup; it is not served as anything else.');
    return { status: 200, body: null, raw: bytes! };
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
  // the Host and token checks, SEAM.md §6).
  async function handle(req: IncomingMessage, res: ServerResponse, expect: 'none' | 'continue' | 'refuse'): Promise<void> {
    const expectsContinue = expect === 'continue';
    const requestId = newId('req_');
    const method = req.method ?? 'GET';
    const send = (reply: Reply) => {
      if (res.headersSent) return;
      const text = method === 'HEAD' ? '' : reply.raw ?? JSON.stringify(reply.body);
      res.writeHead(reply.status, {
        'content-type': reply.raw ? 'application/octet-stream' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-surety-request-id': requestId,
      });
      res.end(text);
    };
    const refuse = (err: unknown) => {
      const refusal = err instanceof Refusal ? err : storeError(err);
      send({ status: refusal.status, body: refusal.body() });
      return refusal;
    };

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

    try {
      checkToken(req, token);
    } catch (err) {
      return refuseAudited(err);
    }
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
    const route = match(method, segments) ?? offerToSeam(r, segments);
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
          res.writeHead(refusal.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(refusal.body()));
        }
      } catch {
        res.destroy();
      }
    });
  };
  const server = http.createServer(serve('none'));
  // Without these listeners Node answers an `Expect` header itself (`100
  // Continue`, or 417 for anything else), before the Host check has run.
  server.on('checkContinue', serve('continue'));
  server.on('checkExpectation', serve('expect'));
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
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

function engineInfo(state: EngineState) {
  return seamDescribe({
    version: ENGINE_VERSION,
    incarnation: state.lock.incarnation_id,
    mode: state.mode,
    // The backends a dispatch may use: in M1 only the scripted backend, and
    // only where the test seam provides it.
    backends: seamBackends().map((b) => b.id),
    config: inspectEngineConfig(state.config),
    startup: { step: state.step, completed: [...state.completed], failed: state.failed },
  });
}
