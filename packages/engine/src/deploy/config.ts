// Environment configuration and its keyed identity (D4 §3.2; Q5; RV5; N04).
// The owner writes immutable versions through the API; the engine validates
// the content, refuses what M4 does not support (D4 X2, Q4), and computes
// `config_identity` with each secret reference replaced by {ref, digest},
// the digest HMAC-SHA256 of the held value under a key the engine makes once
// per home. No value and no unkeyed hash of one is stored (D1 §5.5). Main
// thread only: it holds the secrets.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { Refusal } from '../refusal.js';
import { heldSecret } from '../records/redact.js';
import { ADAPTERS, type ConfigContent, SECRET_REFERENCE } from '../store/transitions/deploy.js';
import { canonical } from '../store/transitions/common.js';

export const SECRET_DIGEST_KEY = 'secret-digest.key';

// The first 12 hex characters of SHA-256 of the home (D4 §9.3; D2 §3.1).
export const homeHash = (home: string): string => createHash('sha256').update(home).digest('hex').slice(0, 12);

let cachedKey: { home: string; key: Buffer } | null = null;

// The HMAC key, `$SURETY_HOME/secret-digest.key`, 0600, made once. A key
// file that is not a regular 0600 file of 32 bytes is refused, never
// replaced: the digests recorded under it would no longer compare.
export function secretDigestKey(home: string): Buffer {
  if (cachedKey && cachedKey.home === home) return cachedKey.key;
  const path = join(home, SECRET_DIGEST_KEY);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const key = randomBytes(32);
    writeSync(fd, key);
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(path);
  if (!st.isFile() || (st.mode & 0o777) !== 0o600) throw new Error(`${path} is not a 0600 regular file`);
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const f = fstatSync(fd);
    if (f.size !== 32) throw new Error(`${path} does not hold a 32-byte key`);
    const key = Buffer.alloc(32);
    readSync(fd, key, 0, 32, 0);
    cachedKey = { home, key };
    return key;
  } finally {
    closeSync(fd);
  }
}

export const digestOf = (key: Buffer, value: string): string => `hmac-sha256:${createHmac('sha256', key).update(value, 'utf8').digest('hex')}`;

const invalid = (field: string, why: string): Refusal =>
  new Refusal(422, 'config_invalid', `The configuration's ${field} ${why}.`, 'Correct the configuration and write it again; no version was written.', { field });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const VARIABLE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TARGET = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELDS = ['adapter', 'adapter_version', 'targets', 'identity_method', 'runtime', 'start', 'port', 'env', 'secrets', 'check_secrets', 'artifact', 'egress', 'persistent_state', 'build'];

// The content of a version, validated; the refusals of D4 X2 and Q4: a build
// step, persistent state, a non-empty egress list, a target count other
// than one, another adapter.
export function validateConfig(body: unknown): ConfigContent {
  if (!isObject(body)) throw invalid('body', 'must be a JSON object');
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw invalid(k, 'is not a configuration field');
  if (!(ADAPTERS as readonly string[]).includes(body.adapter as string)) throw invalid('adapter', `must be ${ADAPTERS.join(' or ')}`);
  if (body.adapter_version !== undefined && (typeof body.adapter_version !== 'string' || body.adapter_version === '')) throw invalid('adapter_version', 'must be a non-empty string');
  if (body.build !== undefined) throw invalid('build', 'is not supported: M4 builds the projection only (Q4)');
  if (body.persistent_state !== undefined && body.persistent_state !== false) throw invalid('persistent_state', 'is not supported by local_service in M4 (X2)');
  if (body.egress !== undefined && (!Array.isArray(body.egress) || body.egress.length > 0)) throw invalid('egress', 'must be empty: local_service has no egress in M4 (X2)');
  if (!Array.isArray(body.targets) || body.targets.length !== 1) throw invalid('targets', 'must name exactly one target (X2)');
  const targets = body.targets.map((t, i) => {
    if (!isObject(t) || typeof t.name !== 'string' || !TARGET.test(t.name) || Object.keys(t).some((k) => k !== 'name')) throw invalid(`targets[${i}]`, 'must be {"name": <a lower-case name>}');
    return { name: t.name };
  });
  if (body.identity_method !== undefined && body.identity_method !== 'tree_digest') throw invalid('identity_method', 'must be tree_digest');
  if (body.runtime !== undefined) {
    const r = body.runtime;
    if (!isObject(r) || typeof r.path !== 'string' || !r.path.startsWith('/') || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256) || Object.keys(r).some((k) => k !== 'path' && k !== 'sha256')) {
      throw invalid('runtime', 'must be {"path": <absolute path>, "sha256": <64 hex>}');
    }
  }
  if (body.start !== undefined && (!Array.isArray(body.start) || body.start.length === 0 || body.start.some((a) => typeof a !== 'string'))) throw invalid('start', 'must be a non-empty argument array');
  if (body.port !== undefined && (!Number.isInteger(body.port) || (body.port as number) < 1 || (body.port as number) > 65535)) throw invalid('port', 'must be a port number');
  if (body.env !== undefined && (!isObject(body.env) || Object.entries(body.env).some(([k, v]) => !VARIABLE.test(k) || typeof v !== 'string'))) throw invalid('env', 'must map variable names to strings');
  if (body.secrets !== undefined) {
    if (!isObject(body.secrets)) throw invalid('secrets', 'must map variable names to secret references');
    for (const [k, v] of Object.entries(body.secrets)) {
      if (!VARIABLE.test(k)) throw invalid(`secrets.${k}`, 'is not a variable name');
      if (typeof v !== 'string' || !SECRET_REFERENCE.test(v)) throw invalid(`secrets.${k}`, `names ${JSON.stringify(v)}, which is not a reference of the deployment namespace (deploy/<name>)`);
    }
  }
  if (body.check_secrets !== undefined) {
    if (!Array.isArray(body.check_secrets)) throw invalid('check_secrets', 'must be an array of secret references');
    body.check_secrets.forEach((v, i) => {
      if (typeof v !== 'string' || !SECRET_REFERENCE.test(v)) throw invalid(`check_secrets[${i}]`, `names ${JSON.stringify(v)}, which is not a reference of the deployment namespace (deploy/<name>)`);
    });
  }
  if (body.artifact !== undefined) {
    const a = body.artifact;
    if (!isObject(a) || Object.keys(a).some((k) => k !== 'exclude') || (a.exclude !== undefined && (!Array.isArray(a.exclude) || a.exclude.some((p) => typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..'))))) {
      throw invalid('artifact', 'must be {"exclude": [<relative paths>]}');
    }
  }
  return { ...(body as Record<string, unknown>), targets, adapter: body.adapter as string, adapter_version: (body.adapter_version as string | undefined) ?? '1' } as ConfigContent;
}

// Every secret reference a version names, each once.
export function referencesOf(content: ConfigContent): string[] {
  return [...new Set([...Object.values(content.secrets ?? {}), ...(content.check_secrets ?? [])])].sort();
}

// The digests of the held values; an unheld reference is refused (E121
// decision 7): unknown is not a value an identity can be computed from.
export function secretDigests(home: string, content: ConfigContent): { ref: string; digest: string }[] {
  const key = secretDigestKey(home);
  return referencesOf(content).map((ref) => {
    const value = heldSecret(ref);
    if (value === null) throw invalid(`secret ${ref}`, 'is not held by this engine (name it with --secret-file at start)');
    return { ref, digest: digestOf(key, value) };
  });
}

// The digest each reference has now, or null when the engine holds none.
export function heldDigests(home: string, refs: string[]): Record<string, string | null> {
  const key = secretDigestKey(home);
  const out: Record<string, string | null> = {};
  for (const ref of refs) {
    const value = heldSecret(ref);
    out[ref] = value === null ? null : digestOf(key, value);
  }
  return out;
}

// `config_identity`: sha256 of the canonical content, each secret reference
// replaced by {ref, digest}.
export function configIdentity(content: ConfigContent, digests: { ref: string; digest: string }[]): string {
  const keyed = (ref: string) => ({ ref, digest: digests.find((d) => d.ref === ref)?.digest ?? null });
  const view = {
    ...content,
    ...(content.secrets ? { secrets: Object.fromEntries(Object.entries(content.secrets).map(([k, ref]) => [k, keyed(ref)])) } : {}),
    ...(content.check_secrets ? { check_secrets: content.check_secrets.map(keyed) } : {}),
  };
  return `sha256:${createHash('sha256').update(canonical(view)).digest('hex')}`;
}
