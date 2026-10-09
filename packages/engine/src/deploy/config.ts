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
import { ADAPTERS, type ConfigContent } from '../store/transitions/deploy.js';
import { KEY_REFERENCES } from '../invoke/keys.js';
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
const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const TARGET = /^[a-z][a-z0-9-]{0,31}$/;
// A deployment reference (SEAM.md §245; N04) beside the backends' (§160).
export const DEPLOY_REFERENCE = /^deploy\/[a-z][a-z0-9_]{0,62}$/;
const FIELDS = ['adapter', 'adapter_version', 'targets', 'runtime', 'start', 'port', 'env', 'secrets', 'check_secrets', 'egress', 'artifact', 'identity_method'];

const isReference = (v: unknown): v is string => typeof v === 'string' && (DEPLOY_REFERENCE.test(v) || (KEY_REFERENCES as readonly string[]).includes(v));

// The content of a version, validated (SEAM.md §245): a closed object.
// A reference names the deployment or the backend namespace, and the
// engine must hold it (its digest is part of the identity). The refusals of
// D4 X2 that depend on the host are the request's (M312).
export function validateConfig(body: unknown): ConfigContent {
  if (!isObject(body)) throw invalid('body', 'must be a JSON object');
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw invalid(k, 'is not a configuration field');
  if (!(ADAPTERS as readonly string[]).includes(body.adapter as string)) throw invalid('adapter', `must be ${ADAPTERS.join(' or ')}`);
  if (typeof body.adapter_version !== 'string' || body.adapter_version === '' || body.adapter_version.length > 64) throw invalid('adapter_version', 'must be a non-empty string of at most 64 characters');
  if (!Array.isArray(body.targets) || body.targets.length !== 1) throw invalid('targets', 'must name exactly one target (local_service, X2)');
  body.targets.forEach((t, i) => {
    if (typeof t !== 'string' || !TARGET.test(t)) throw invalid(`targets.${i}`, 'must be a target name');
  });
  const r = body.runtime;
  if (!isObject(r) || typeof r.path !== 'string' || !r.path.startsWith('/') || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256) || Object.keys(r).some((k) => k !== 'path' && k !== 'sha256')) {
    throw invalid('runtime', 'must be {"path": <absolute path>, "sha256": <64 lower-case hex>}');
  }
  if (!Array.isArray(body.start) || body.start.length === 0 || body.start.some((a) => typeof a !== 'string')) throw invalid('start', 'must be a non-empty argument array');
  if (!Number.isInteger(body.port) || (body.port as number) < 1024 || (body.port as number) > 65535) throw invalid('port', 'must be an integer from 1024 to 65535');
  if (body.env !== undefined) {
    if (!isObject(body.env)) throw invalid('env', 'must map variable names to strings');
    for (const [k, v] of Object.entries(body.env)) if (!VARIABLE.test(k) || typeof v !== 'string') throw invalid(`env.${k}`, 'must be a variable name with a string value');
  }
  if (body.secrets !== undefined) {
    if (!isObject(body.secrets)) throw invalid('secrets', 'must map variable names to secret references');
    for (const [k, v] of Object.entries(body.secrets)) {
      if (!VARIABLE.test(k)) throw invalid(`secrets.${k}`, 'is not a variable name');
      if (!isReference(v)) throw invalid(`secrets.${k}`, `names ${JSON.stringify(v)}, a reference in neither the deployment (deploy/<name>) nor the backend namespace`);
    }
  }
  if (body.check_secrets !== undefined) {
    if (!Array.isArray(body.check_secrets)) throw invalid('check_secrets', 'must be an array of secret references');
    body.check_secrets.forEach((v, i) => {
      if (!isReference(v)) throw invalid(`check_secrets.${i}`, `names ${JSON.stringify(v)}, a reference in neither the deployment (deploy/<name>) nor the backend namespace`);
    });
  }
  if (body.egress !== undefined && !Array.isArray(body.egress)) throw invalid('egress', 'must be an array');
  if (body.artifact !== undefined) {
    const a = body.artifact;
    if (!isObject(a) || Object.keys(a).some((k) => k !== 'exclude') || (a.exclude !== undefined && (!Array.isArray(a.exclude) || a.exclude.some((p) => typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').includes('..'))))) {
      throw invalid('artifact', 'must be {"exclude": [<repository paths>]}');
    }
  }
  if (body.identity_method !== undefined && body.identity_method !== 'tree_digest') throw invalid('identity_method', 'must be tree_digest');
  return body as unknown as ConfigContent;
}

// The field a reference stands in (for a refusal naming it).
function fieldOf(content: ConfigContent, ref: string): string {
  for (const [k, v] of Object.entries(content.secrets ?? {})) if (v === ref) return `secrets.${k}`;
  const i = (content.check_secrets ?? []).indexOf(ref);
  return i >= 0 ? `check_secrets.${i}` : 'secrets';
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
    if (value === null) throw invalid(fieldOf(content, ref), `names ${ref}, which this engine does not hold (name it with --secret-file at start)`);
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
