// The request boundary checks that run before routing or reading a body
// (D1 §11.1, SEAM.md §6): the exact self authority, then the token.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { Refusal } from '../refusal.js';

export interface Target {
  path: string;
  query: string;
}

const hostRefused = (reason: string) =>
  new Refusal(400, 'host_refused', reason, 'Address the engine by its configured authority, in exactly one Host header.', {});
const notSelf = (what: string) => hostRefused(`${what} does not name this engine's API authority.`);

// The Host header, and the authority of an absolute-form target, must equal
// the configured authority exactly. Returns the request path and query. The
// check reads every Host line the client sent: the parser keeps only the
// first, and a request with more than one is malformed (RFC 9112 §3.2).
export function checkTarget(req: IncomingMessage, authority: string): Target {
  const hosts: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === 'host') hosts.push(req.rawHeaders[i + 1]!);
  }
  if (hosts.length === 0) throw hostRefused('The request has no Host header.');
  if (hosts.length > 1) throw hostRefused('The request has more than one Host header, so its authority is ambiguous.');
  if (hosts[0] !== authority) throw notSelf('The Host header');
  const raw = req.url ?? '';
  let rest: string;
  if (raw.startsWith('/')) {
    rest = raw;
  } else {
    const m = /^http:\/\/([^/?#]*)(.*)$/i.exec(raw);
    if (!m) throw notSelf('The request target');
    if (m[1] !== authority) throw notSelf('The request target');
    rest = m[2]!.startsWith('/') ? m[2]! : `/${m[2]!}`;
  }
  const q = rest.indexOf('?');
  const path = (q < 0 ? rest : rest.slice(0, q)).replace(/#.*$/, '');
  return { path, query: q < 0 ? '' : rest.slice(q + 1) };
}

// X-Surety-Token, compared length-checked and in constant time.
export function checkToken(req: IncomingMessage, token: Buffer): void {
  const given = req.headers['x-surety-token'];
  if (given === undefined) {
    throw new Refusal(401, 'token_required', 'This request carries no API token.', 'Send the content of $SURETY_HOME/api.token in X-Surety-Token.');
  }
  const presented = Buffer.from(Array.isArray(given) ? given.join(',') : given, 'utf8');
  if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
    throw new Refusal(401, 'token_invalid', 'The API token presented is not this engine\'s token.', 'Send the content of $SURETY_HOME/api.token in X-Surety-Token.');
  }
}

const tooLarge = (cap: number) =>
  new Refusal(413, 'payload_too_large', `The request body exceeds ${cap} bytes.`, 'Send a smaller body.', { cap });

// Read and parse a JSON body under the byte cap and the body deadline. An
// absent body is undefined.
export function readJsonBody(req: IncomingMessage, cap: number, deadlineMs: number): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > cap) return Promise.reject(tooLarge(cap));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Refusal(400, 'invalid_value', 'The request body did not arrive within the body deadline.', 'Send the whole body promptly.', { field: null })),
        ),
      deadlineMs,
    );
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) finish(() => reject(tooLarge(cap)));
      else chunks.push(chunk);
    });
    req.on('error', (err) => finish(() => reject(err)));
    req.on('end', () =>
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') return resolve(undefined);
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Refusal(400, 'invalid_value', 'The request body is not valid JSON.', 'Send a JSON object.', { field: null }));
        }
      }),
    );
  });
}

// The headers every response carries, errors and streams included (D1
// §11.1, §17(13); SEAM.md §89).
export const DEFENSIVE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
});

const originRefused = (reason: string) =>
  new Refusal(
    403,
    'origin_refused',
    reason,
    "Send the request from a page of this engine's own origin, or from a client that sends no Origin, Referer or Sec-Fetch-Site header.",
    {},
  );

// Every value of a header the client sent, as sent.
function headerValues(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) out.push(req.rawHeaders[i + 1]!);
  }
  return out;
}

// Whether a URL or origin, parsed, is exactly this engine's own origin:
// `http`, and the configured authority with its port.
function isSelfOrigin(value: string, authority: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  return `${url.hostname}:${url.port === '' ? '80' : url.port}` === authority;
}

export interface OriginEvidence {
  // Sec-Fetch-Site, if sent (one value).
  site: string | null;
  // An Origin or a Referer of the engine's own origin was sent.
  self: boolean;
}

// The origin evidence of a request (D1 §11.1; SEAM.md §89, item 2). A present
// Origin or Referer that is not exactly the engine's own origin refuses the
// request, and so does present fetch metadata other than `same-origin` (`none`,
// a navigation the person made, goes on: the token still decides). A request
// with none of the three is an origin-less client and goes on.
export function checkOrigin(req: IncomingMessage, authority: string): OriginEvidence {
  const origins = headerValues(req, 'origin');
  const referers = headerValues(req, 'referer');
  for (const value of origins) {
    if (!isSelfOrigin(value.trim(), authority)) throw originRefused(`The Origin "${value}" is not this engine's own origin.`);
  }
  for (const value of referers) {
    if (!isSelfOrigin(value.trim(), authority)) throw originRefused("The Referer is not a page of this engine's own origin.");
  }
  const sites = headerValues(req, 'sec-fetch-site').map((v) => v.trim().toLowerCase());
  if (sites.length > 1) throw originRefused('The request carries more than one Sec-Fetch-Site header.');
  const site = sites[0] ?? null;
  if (site !== null && site !== 'same-origin' && site !== 'none') throw originRefused(`The browser says this request is ${site}, not same-origin.`);
  return { site, self: origins.length + referers.length > 0 };
}

// GET /v1/token/bootstrap (D1 §11.1; RN R6; SEAM.md §90): positive same-origin
// evidence from a browser, or a refusal that says what to do. The Origin and
// Referer that are present have already been found to be the engine's own.
export function checkBootstrapEvidence(evidence: OriginEvidence): void {
  if (evidence.site === 'same-origin' && evidence.self) return;
  throw new Refusal(
    403,
    'origin_refused',
    'The token is given only to a page of this engine\'s own origin, and this request does not show that it comes from one (it needs Sec-Fetch-Site: same-origin and an Origin or Referer of the engine).',
    'Load the engine\'s page and request the token from it with a same-origin referrer policy; a client that is not a browser page reads the token from $SURETY_HOME/api.token.',
    {},
  );
}

export const payloadTooLarge = (cap: number) => tooLarge(cap);
