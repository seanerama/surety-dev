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
  onRefused?: (r: { authority: string; reason: string; detail: Record<string, unknown> }) => void;
  onLogBound?: () => void;
}

export type EgressOutcome = 'accepted' | 'refused';

export interface EgressEntry {
  seq: number;
  opened_at: string;
  authority: string;
  host: string | null;
  port: number | null;
  outcome: EgressOutcome;
  status: number;
  reason: string | null;
  // The limit's value when a limit refused or closed the tunnel.
  figure: number | null;
  resolved: string[] | null;
  address: string | null;
  bytes_up: number;
  bytes_down: number;
  closed_at: string | null;
  close_reason: string | null;
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

const STATUS_TEXT: Record<number, string> = { 200: 'Connection established', 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

export class DomainProxy {
  readonly socketPath: string;
  readonly entries: EgressEntry[] = [];
  truncated = false;
  private logBytes = 0;
  private active = 0;
  private seq = 0;
  private server: net.Server | null = null;
  private readonly open = new Set<Duplex>();
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
    for (const s of this.open) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.socketPath, { force: true });
  }

  // The `egress_log` record's content (D2 §2.4): within its bound.
  record(): Record<string, unknown> {
    return {
      domain: this.opts.domain,
      run: this.opts.run,
      invocation: this.opts.invocation,
      profile: this.opts.profile,
      allow: this.opts.allow,
      limits: {
        egress_resolve_timeout: this.opts.limits.resolveTimeoutMs / 1000,
        egress_connect_timeout: this.opts.limits.connectTimeoutMs / 1000,
        egress_tunnel_max_seconds: this.opts.limits.tunnelMaxMs / 1000,
        egress_tunnels_max: this.opts.limits.tunnelsMax,
        egress_buffer_max_bytes: this.opts.limits.bufferMaxBytes,
        egress_log_max_bytes: this.opts.limits.logMaxBytes,
      },
      truncated: this.truncated,
      complete: !this.truncated,
      connections: this.entries,
    };
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
          this.refuse(client, this.entry('(unparsed)'), 400, 'bad_request', null, {});
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
    return {
      seq: ++this.seq,
      opened_at: new Date().toISOString(),
      authority,
      host: null,
      port: null,
      outcome: 'refused',
      status: 0,
      reason: null,
      figure: null,
      resolved: null,
      address: null,
      bytes_up: 0,
      bytes_down: 0,
      closed_at: null,
      close_reason: null,
    };
  }

  private refuse(client: net.Socket, e: EgressEntry, status: number, reason: string, figure: number | null, detail: Record<string, unknown>): void {
    e.outcome = 'refused';
    e.status = status;
    e.reason = reason;
    e.figure = figure;
    e.closed_at = new Date().toISOString();
    e.close_reason = reason;
    const logged = this.admit(e);
    if (logged) this.opts.onRefused?.({ authority: e.authority, reason, detail: { status, ...(figure === null ? {} : { figure }), ...detail } });
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
      this.refuse(client, e, 403, 'egress_log_max_bytes', this.opts.limits.logMaxBytes, {});
      return;
    }
    if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]!)) {
      this.refuse(client, e, 400, 'bad_request', null, {});
      return;
    }
    if (parts[0] !== 'CONNECT') {
      this.refuse(client, e, 405, 'not_connect', null, { method: parts[0] });
      return;
    }
    const authority = parseAuthority(authorityText);
    if (authority === null) {
      this.refuse(client, e, 400, 'bad_authority', null, {});
      return;
    }
    e.host = authority.host;
    e.port = authority.port;
    if (this.active >= this.opts.limits.tunnelsMax) {
      this.refuse(client, e, 403, 'egress_tunnels_max', this.opts.limits.tunnelsMax, {});
      return;
    }
    // The engine's echo endpoint: the `probe` profile alone.
    if (authority.host === ECHO_HOST) {
      if (this.opts.echo === null || authority.port !== ECHO_PORT) {
        this.refuse(client, e, 403, 'echo_probe_only', null, { profile: this.opts.profile });
        return;
      }
      const [near, far] = duplexPair();
      this.opts.echo.serve(far, { domain: this.opts.domain, run: this.opts.run });
      e.address = 'echo';
      this.tunnel(client, near, e, rest);
      return;
    }
    if (authority.port !== 443) {
      this.refuse(client, e, 403, 'port_not_443', null, {});
      return;
    }
    if (!this.opts.allow.includes(authority.host)) {
      this.refuse(client, e, 403, 'not_listed', null, {});
      return;
    }
    // One resolution for this attempt; the connection goes to an address of
    // this answer and the name is never resolved again for it.
    const answer = await resolveOnce(this.opts.resolver, authority.host, this.opts.limits.resolveTimeoutMs);
    if (answer.state === 'timeout') {
      this.refuse(client, e, 504, 'egress_resolve_timeout', this.opts.limits.resolveTimeoutMs / 1000, {});
      return;
    }
    if (answer.state === 'failed') {
      this.refuse(client, e, 502, 'resolve_failed', null, { error: answer.detail });
      return;
    }
    e.resolved = answer.addresses;
    const verdict = answerVerdict(answer.addresses, this.host);
    if (!verdict.ok) {
      this.refuse(client, e, 403, `address_${verdict.reason}`, null, { resolved: answer.addresses, address: verdict.address });
      return;
    }
    const address = answer.addresses[0]!;
    e.address = address;
    if (this.closing) {
      this.refuse(client, e, 403, 'domain_ending', null, {});
      return;
    }
    const remote = net.connect({ host: address, port: authority.port });
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
    if (outcome !== 'connected') {
      remote.destroy();
      if (outcome === 'timeout') this.refuse(client, e, 504, 'egress_connect_timeout', this.opts.limits.connectTimeoutMs / 1000, { address });
      else this.refuse(client, e, 502, 'connect_failed', null, { address, error: outcome });
      return;
    }
    this.tunnel(client, remote, e, rest);
  }

  // A tunnel: `200`, then bytes both ways, unchanged, within the per-tunnel
  // limits.
  private tunnel(client: net.Socket, remote: Duplex, e: EgressEntry, rest: Buffer): void {
    e.outcome = 'accepted';
    e.status = 200;
    if (!this.admit(e)) {
      remote.destroy();
      this.refuse(client, { ...e }, 403, 'egress_log_max_bytes', this.opts.limits.logMaxBytes, {});
      return;
    }
    this.active++;
    this.open.add(remote);
    const started = performance.now();
    let closed = false;
    const close = (reason: string, figure: number | null = null) => {
      if (closed) return;
      closed = true;
      this.active--;
      clearTimeout(lifetime);
      e.closed_at = new Date().toISOString();
      e.close_reason = reason;
      if (figure !== null) e.figure = figure;
      if (reason === 'egress_tunnel_max_seconds' || reason === 'egress_buffer_max_bytes') e.reason = reason;
      client.destroy();
      remote.destroy();
      this.open.delete(remote);
      void started;
    };
    const lifetime = setTimeout(() => close('egress_tunnel_max_seconds', this.opts.limits.tunnelMaxMs / 1000), this.opts.limits.tunnelMaxMs);
    const max = this.opts.limits.bufferMaxBytes;
    client.on('data', (chunk: Buffer) => {
      e.bytes_up += chunk.length;
      remote.write(chunk);
      if (remote.writableLength > max) close('egress_buffer_max_bytes', max);
    });
    remote.on('data', (chunk: Buffer) => {
      e.bytes_down += chunk.length;
      client.write(chunk);
      if (client.writableLength > max) close('egress_buffer_max_bytes', max);
    });
    client.on('end', () => remote.end());
    remote.on('end', () => client.end());
    client.on('close', () => close('client_closed'));
    remote.on('close', () => close('remote_closed'));
    remote.on('error', () => close('remote_error'));
    client.on('error', () => close('client_error'));
    client.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (rest.length > 0) {
      e.bytes_up += rest.length;
      remote.write(rest);
    }
    client.resume();
  }
}
