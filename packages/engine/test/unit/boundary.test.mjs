// Developer tests for the request boundary (src/api/boundary.ts). The
// acceptance suite drives it over real sockets; these check the Host rule
// against every Host line, which the parsed headers would hide.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const { checkTarget } = await import(join(dist, 'api', 'boundary.js'));

const SELF = '127.0.0.1:7227';
const req = (url, ...hosts) => ({
  url,
  rawHeaders: hosts.flatMap((h, i) => [i % 2 ? 'HOST' : 'Host', h]),
  headers: { host: hosts[0] },
});
const refused = (r) => assert.throws(() => checkTarget(r, SELF), (err) => err.code === 'host_refused' && err.status === 400);

test('exactly one Host line naming the authority is accepted', () => {
  assert.deepEqual(checkTarget(req('/v1/health?x=1', SELF), SELF), { path: '/v1/health', query: 'x=1' });
  assert.deepEqual(checkTarget(req(`http://${SELF}/v1/engine`, SELF), SELF), { path: '/v1/engine', query: '' });
});

test('no Host line, a foreign one, or more than one is refused', () => {
  refused(req('/v1/health'));
  refused(req('/v1/health', 'evil.example'));
  refused(req('/v1/health', SELF, SELF));
  refused(req('/v1/health', SELF, 'evil.example'));
  refused(req('/v1/health', 'evil.example', SELF));
  refused(req('http://evil.example/v1/health', SELF));
});
