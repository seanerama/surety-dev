// The engine's echo endpoint (D2 §§2.4, 2.8, 7.1): the one destination the
// `probe` profile's proxy reaches besides the allow list, so that the probe
// suite needs neither a model nor the internet. It is the engine's own and
// in-process: the proxy hands it the tunnel's bytes, it records what it
// received and sends every byte back unchanged. The `role` profile, and
// every canary, cannot name it (the proxy refuses it there). What it
// received is readable by the probe suite and, in harness mode, by the
// tests.

import type { Duplex } from 'node:stream';

export const ECHO_HOST = 'surety-echo.invalid';
export const ECHO_PORT = 443;

// What one tunnel to the echo endpoint carried.
export interface EchoConnection {
  id: number;
  domain: string;
  run: string | null;
  opened_at: string;
  closed_at: string | null;
  bytes: number;
  // The first bytes received, for a witness to compare (at most 64 KiB).
  received: Buffer;
}

const KEEP_BYTES = 64 * 1024;
const KEEP_CONNECTIONS = 1000;

export class EchoEndpoint {
  readonly connections: EchoConnection[] = [];
  private next = 1;

  // Serve one tunnel: everything written to `side` is recorded and written
  // back. Returns the connection's record.
  serve(side: Duplex, who: { domain: string; run: string | null }): EchoConnection {
    const c: EchoConnection = { id: this.next++, domain: who.domain, run: who.run, opened_at: new Date().toISOString(), closed_at: null, bytes: 0, received: Buffer.alloc(0) };
    this.connections.push(c);
    if (this.connections.length > KEEP_CONNECTIONS) this.connections.shift();
    side.on('data', (chunk: Buffer) => {
      c.bytes += chunk.length;
      if (c.received.length < KEEP_BYTES) c.received = Buffer.concat([c.received, chunk.subarray(0, KEEP_BYTES - c.received.length)]);
      side.write(chunk);
    });
    const done = () => {
      if (c.closed_at === null) c.closed_at = new Date().toISOString();
    };
    side.on('end', () => {
      done();
      side.end();
    });
    side.on('close', done);
    side.on('error', done);
    return c;
  }

  // What a domain's tunnels to the endpoint carried, in order.
  of(domain: string): EchoConnection[] {
    return this.connections.filter((c) => c.domain === domain);
  }
}

// One endpoint per engine process.
export const echoEndpoint = new EchoEndpoint();
