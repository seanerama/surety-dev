// The egress proxy (D2 §§2.4, 3.7; AR B03): the only way out of a sandbox.
// One per domain, in the engine's process, listening on the domain's unix
// socket under its area, which the sandbox binds beside the domain init; the
// init's forwarder carries each of the role's connections to it unchanged.
//
// For each connection it reads one `CONNECT host:port` request, canonicalizes
// the authority, and accepts it only on an exact match with the domain's
// allow list (the trust entry's or the qualification attempt's egress list
// plus the project's approved `egress_allow_extra`), on port 443. It resolves
// the name once per attempt within `egress_resolve_timeout`, validates every
// address of the answer under one IPv4 and IPv6 policy (proxy/address.ts),
// refuses the whole answer set if any address is forbidden, and connects only
// to a validated numeric address from that answer, never resolving the name
// again. It does not terminate TLS: after `200` the tunnel's bytes pass both
// ways unchanged. Under the `probe` profile alone it also reaches the
// engine's own echo endpoint (proxy/echo.ts).
//
// Its limits: connect time, tunnel lifetime, concurrent tunnels and bytes
// buffered per tunnel (`egress_connect_timeout`, `egress_tunnel_max_seconds`,
// `egress_tunnels_max`, `egress_buffer_max_bytes`) refuse or close the one
// tunnel; the log's bound (`egress_log_max_bytes`) stops the log, marks it
// truncated, refuses every later connection unlogged, and cancels the run
// through D2 §3.2 (the caller's `onLogBound`). Every refusal emits
// `domain.egress_refused` (the caller's `onRefused`); every connection,
// accepted or refused, with destination, resolved addresses, the address
// connected to, byte counts and times, is in the domain's `egress_log`
// record, which the engine writes when the domain is terminated.
//
// The proxy connects out only to an address it validated (or to its own
// echo endpoint, in-process); never to loopback, a private range, this host,
// or the engine's API.

import { closeSync, openSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { duplexPair } from 'node:stream';

import { answerVerdict, hostAddresses } from './address.js';
import { ECHO_HOST, ECHO_PORT, type EchoEndpoint } from './echo.js';
import { type Resolver, resolveOnce } from './resolver.js';

export interface ProxyLimits {
  resolveTimeoutMs: number;
  connectTimeoutMs: number;
  tunnelMaxMs: number;
  tunnelsMax: number;
  bufferMaxBytes: number;
  logMaxBytes: number;
}

export interface ProxyOptions {
  // The domain's area: the socket is `<area>/egress.sock`.
  area: string;
  domain: string;
  run: string | null;
  invocation: string | null;
  profile: string;
  // Host names allowed at port 443, exact match, canonical.
  allow: string[];
  limits: ProxyLimits;
  resolver: Resolver;
  // The echo endpoint, under the `probe` profile only.
  echo: EchoEndpoint | null;
  onRefused?: (r: { authority: string; reason: string }) => void;
  onLogBound?: () => void;
}

// One line of the domain's `egress_log` record (SEAM.md §140), one per
// CONNECT in the order received.
export interface EgressEntry {
  authority: string;
  // `refused` when no connection was attempted, `accepted` when the proxy
  // attempted one.
  decision: 'accepted' | 'refused';
  reason: null | 'not_listed' | 'port' | 'address_policy' | 'resolve_failed' | 'resolve_timeout' | 'tunnels_max' | 'bad_request';
  resolved: string[];
  address: string | null;
  opened_at: string;
  closed_at: string | null;
  bytes_up: number;
  bytes_down: number;
  ended: 'refused' | 'closed' | 'resolve_timeout' | 'connect_timeout' | 'connect_failed' | 'tunnel_max_seconds' | 'buffer_max' | 'run_ended' | null;
  limit: null | { key: string; value: number };
}

export const EGRESS_SOCKET_NAME = 'egress.sock';
const HEADER_MAX = 8192;
const HEADER_TIMEOUT_MS = 10_000;

// A host name canonical: lower case, no trailing dot; an IPv6 literal without
// its brackets.
export function canonicalHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

// `host:port` of a CONNECT request; null if it is not one.
export function parseAuthority(text: string): { host: string; port: number } | null {
  const m = /^(\[[0-9A-Fa-f:.%a-zA-Z]+\]|[^\s:/@[\]]+):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = canonicalHost(m[1]!);
  if (host.length === 0) return null;
  return { host, port };
}

const STATUS_TEXT: Record<number, string> = { 200: 'Connection established', 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export class DomainProxy {
  readonly socketPath: string;
  readonly entries: EgressEntry[] = [];
  truncated = false;
  private logBytes = 0;
  private active = 0;
  private seq = 0;
  private server: net.Server | null = null;
  private readonly open = new Set<Duplex>();
  // How to end each open tunnel when the domain's egress ends.
  private readonly tunnels = new Set<() => void>();
  private closing = false;
  private readonly host = hostAddresses();
  private boundCalled = false;

  constructor(readonly opts: ProxyOptions) {
    this.socketPath = join(opts.area, EGRESS_SOCKET_NAME);
  }

  // Listen on the domain's socket. A path longer than a unix socket address
  // holds is reached through a descriptor of the area (/proc/self/fd/N/…).
  async listen(): Promise<void> {
    rmSync(this.socketPath, { force: true });
    const dirFd = openSync(this.opts.area, 'r');
    try {
      const server = net.createServer((sock) => this.accept(sock));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(`/proc/self/fd/${dirFd}/${EGRESS_SOCKET_NAME}`, () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.server = server;
    } finally {
      closeSync(dirFd);
    }
  }

  // No more connections; every tunnel closed; the socket removed.
  async close(): Promise<void> {
    this.closing = true;
    for (const stop of [...this.tunnels]) stop();
    for (const s of this.open) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
  }

  // The `egress_log` record's bytes (D2 §2.4; SEAM.md §140): JSON lines in
  // the order received, at most `egress_log_max_bytes`, then the truncation
  // marker if the log reached its bound.
  recordText(): string {
    const max = this.opts.limits.logMaxBytes;
    let out = '';
    let cut = this.truncated;
    for (const e of this.entries) {
      const line = `${JSON.stringify(e)}\n`;
      if (Buffer.byteLength(out) + Buffer.byteLength(line) > max) {
        cut = true;
        break;
      }
      out += line;
    }
    if (cut) out += `${JSON.stringify({ truncated: true, limit: 'egress_log_max_bytes', value: max })}\n`;
    return out;
  }

  // Room in the log for one more entry; false (and the log truncated, the
  // run cancelled) once the bound is reached.
  private admit(entry: EgressEntry): boolean {
    if (this.truncated) return false;
    // An entry grows when its tunnel closes (byte counts, times): its room
    // is taken at the start, with that growth.
    const size = Buffer.byteLength(JSON.stringify(entry)) + 160;
    if (this.logBytes + size > this.opts.limits.logMaxBytes) {
      this.truncated = true;
      if (!this.boundCalled) {
        this.boundCalled = true;
        this.opts.onLogBound?.();
      }
      return false;
    }
    this.logBytes += size;
    this.entries.push(entry);
    return true;
  }

  private accept(client: net.Socket): void {
    if (this.closing) {
      client.destroy();
      return;
    }
    this.open.add(client);
    client.once('close', () => this.open.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), HEADER_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > HEADER_MAX) {
          clearTimeout(timer);
          client.off('data', onData);
          this.refuse(client, this.entry('(unparsed)'), 400, 'bad_request');
        }
        return;
      }
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      void this.request(client, head.subarray(0, end).toString('latin1'), head.subarray(end + 4)).catch(() => client.destroy());
    };
    client.on('data', onData);
  }

  private entry(authority: string): EgressEntry {
    return { authority, decision: 'refused', reason: null, resolved: [], address: null, opened_at: new Date().toISOString(), closed_at: null, bytes_up: 0, bytes_down: 0, ended: null, limit: null };
  }

  private refuse(client: net.Socket, e: EgressEntry, status: number, reason: NonNullable<EgressEntry['reason']>, limit: EgressEntry['limit'] = null, ended: EgressEntry['ended'] = 'refused'): void {
    e.decision = 'refused';
    e.reason = reason;
    e.limit = limit;
    e.ended = ended;
    e.closed_at = new Date().toISOString();
    if (this.admit(e)) this.opts.onRefused?.({ authority: e.authority, reason });
    this.answer(client, status);
  }

  // The attempt was made and failed (a limit or the connection itself).
  private failed(client: net.Socket, e: EgressEntry, status: number, ended: EgressEntry['ended'], limit: EgressEntry['limit'] = null): void {
    e.decision = 'accepted';
    e.ended = ended;
    e.limit = limit;
    e.closed_at = new Date().toISOString();
    this.admit(e);
    this.answer(client, status);
  }

  private answer(client: net.Socket, status: number): void {
    try {
      client.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Refused'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    } catch {
      client.destroy();
    }
  }

  private async request(client: net.Socket, header: string, rest: Buffer): Promise<void> {
    const line = header.split('\r\n')[0] ?? '';
    const parts = line.split(' ');
    const authorityText = parts[1] ?? '(none)';
    const e = this.entry(authorityText);
    // The log's bound reached: nothing more is logged, so nothing more passes.
    if (this.truncated) {
      this.answer(client, 503);
      return;
    }
    if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]!) || parts[0] !== 'CONNECT') {
      this.refuse(client, e, parts[0] !== 'CONNECT' && parts.length === 3 ? 405 : 400, 'bad_request');
      return;
    }
    const authority = parseAuthority(authorityText);
    if (authority === null) {
      this.refuse(client, e, 400, 'bad_request');
      return;
    }
    // The engine's echo endpoint: listed in the `probe` profile alone, never
    // resolved.
    const echo = authority.host === ECHO_HOST && authority.port === ECHO_PORT && this.opts.echo !== null;
    if (!echo) {
      if (!this.opts.allow.includes(authority.host)) {
        this.refuse(client, e, 403, 'not_listed');
        return;
      }
      if (authority.port !== 443) {
        this.refuse(client, e, 403, 'port');
        return;
      }
    }
    if (this.active >= this.opts.limits.tunnelsMax) {
      this.refuse(client, e, 503, 'tunnels_max', { key: 'egress_tunnels_max', value: this.opts.limits.tunnelsMax });
      return;
    }
    if (echo) {
      const [near, far] = duplexPair();
      this.opts.echo!.serve(far, { domain: this.opts.domain, run: this.opts.run });
      this.tunnel(client, near, e, rest);
      return;
    }
    // One resolution for this attempt; the connection goes to an address of
    // this answer and the name is never resolved again for it.
    this.active++;
    let answer: Awaited<ReturnType<typeof resolveOnce>>;
    try {
      answer = await resolveOnce(this.opts.resolver, authority.host, this.opts.limits.resolveTimeoutMs);
    } finally {
      this.active--;
    }
    if (answer.state === 'timeout') {
      this.refuse(client, e, 504, 'resolve_timeout', { key: 'egress_resolve_timeout', value: this.opts.limits.resolveTimeoutMs / 1000 }, 'resolve_timeout');
      return;
    }
    if (answer.state === 'failed') {
      this.refuse(client, e, 502, 'resolve_failed');
      return;
    }
    e.resolved = answer.addresses;
    const verdict = answerVerdict(answer.addresses, this.host);
    if (!verdict.ok) {
      this.refuse(client, e, 403, 'address_policy');
      return;
    }
    if (this.closing) {
      this.answer(client, 503);
      return;
    }
    const address = answer.addresses[0]!;
    e.address = address;
    this.active++;
    const remote = net.connect({ host: address, port: authority.port });
    this.open.add(remote);
    const outcome = await new Promise<'connected' | 'timeout' | string>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), this.opts.limits.connectTimeoutMs);
      remote.once('connect', () => {
        clearTimeout(t);
        resolve('connected');
      });
      remote.once('error', (err) => {
        clearTimeout(t);
        resolve((err as NodeJS.ErrnoException).code ?? 'error');
      });
    });
    this.active--;
    if (outcome !== 'connected') {
      remote.destroy();
      this.open.delete(remote);
      if (outcome === 'timeout') this.failed(client, e, 504, 'connect_timeout', { key: 'egress_connect_timeout', value: this.opts.limits.connectTimeoutMs / 1000 });
      else this.failed(client, e, 502, 'connect_failed');
      return;
    }
    this.tunnel(client, remote, e, rest);
  }

  // A tunnel: `200`, then bytes both ways, unchanged, within the per-tunnel
  // limits; a limit ends the tunnel, never the run.
  private tunnel(client: net.Socket, remote: Duplex, e: EgressEntry, rest: Buffer): void {
    e.decision = 'accepted';
    if (!this.admit(e)) {
      remote.destroy();
      this.answer(client, 503);
      return;
    }
    this.active++;
    this.open.add(remote);
    let closed = false;
    const close = (ended: NonNullable<EgressEntry['ended']>, limit: EgressEntry['limit'] = null) => {
      if (closed) return;
      closed = true;
      this.active--;
      clearTimeout(lifetime);
      e.closed_at = new Date().toISOString();
      e.ended = this.closing && ended === 'closed' ? 'run_ended' : ended;
      if (limit) e.limit = limit;
      client.destroy();
      remote.destroy();
      this.open.delete(remote);
      this.tunnels.delete(stop);
    };
    const stop = () => close('run_ended');
    this.tunnels.add(stop);
    const lifetime = setTimeout(() => close('tunnel_max_seconds', { key: 'egress_tunnel_max_seconds', value: this.opts.limits.tunnelMaxMs / 1000 }), this.opts.limits.tunnelMaxMs);
    const max = this.opts.limits.bufferMaxBytes;
    const buffer = { key: 'egress_buffer_max_bytes', value: max };
    client.on('data', (chunk: Buffer) => {
      e.bytes_up += chunk.length;
      remote.write(chunk);
      if (remote.writableLength > max) close('buffer_max', buffer);
    });
    remote.on('data', (chunk: Buffer) => {
      e.bytes_down += chunk.length;
      client.write(chunk);
      if (client.writableLength > max) close('buffer_max', buffer);
    });
    client.on('end', () => remote.end());
    remote.on('end', () => client.end());
    client.on('close', () => close('closed'));
    remote.on('close', () => close('closed'));
    remote.on('error', () => close('closed'));
    client.on('error', () => close('closed'));
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (rest.length > 0) {
      e.bytes_up += rest.length;
      remote.write(rest);
    }
    client.resume();
  }
}
