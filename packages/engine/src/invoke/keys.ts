// The provider keys a production engine resolves (D2 §2.5, Q1, Q2; D1 §5.5,
// §17 item 5; SEAM.md §160): `--secret-file <ref>=<path>` names, by
// reference, the file that holds a backend's dedicated key, and
// `--provider-cap-usd <ref>=<usd>` the provider-side cap the operator
// configured on it. At start the engine reads each file once and holds its
// value as the resolved secret `<ref>` (records/redact.ts): in memory only,
// redacted from everything the engine writes, screened for, and placed by
// the domain init only in the variable the backend's template names
// (`ANTHROPIC_API_KEY` for Claude Code). The cap is recorded as `configured`
// evidence on a grant and an attempt, never as engine enforcement (D2 §4.2).
// The path may be logged; the value never. Accepted with or without the
// test mode.

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { constants } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

import { holdSecret } from '../records/redact.js';

export const KEY_REFERENCES = ['backend/claude/api_key', 'backend/claude/subscription_token', 'backend/codex/api_key'] as const;
export const keyReference = (backend: string): string => `backend/${backend}/api_key`;

// A key file is small: one line. Anything longer is not a key.
const MAX_KEY_FILE_BYTES = 4096;

export class SecretFileRefused extends Error {
  constructor(
    readonly ref: string,
    readonly path: string,
    readonly why: string,
  ) {
    super(why);
  }
  // The path as it may be shown (the slice-14 review's S3): only an absolute
  // path that names something on the filesystem; anything else may be the
  // secret itself, given in place of its path, and is never echoed.
  get shownPath(): string {
    if (!isAbsolute(this.path)) return '<not shown: not an absolute path>';
    try {
      lstatSync(this.path);
      return this.path;
    } catch {
      return '<not shown: names nothing on the filesystem>';
    }
  }
}

// `<ref>=<value>`, with a known reference; a string is the usage problem.
export function parseRefValue(flag: string, text: string): { ref: string; value: string } | string {
  const at = text.indexOf('=');
  const ref = at <= 0 ? '' : text.slice(0, at);
  const value = at <= 0 ? '' : text.slice(at + 1);
  if (!(KEY_REFERENCES as readonly string[]).includes(ref) || value === '') return `${flag} takes <${KEY_REFERENCES.join('|')}>=<value>`;
  return { ref, value };
}

// Read one key file, refusing anything but a regular file of the engine's
// uid, not readable or writable by group or others, outside the engine
// home, holding exactly one non-empty line. Returns the value.
export function readSecretFile(ref: string, path: string, home: string): string {
  const refuse = (why: string): never => {
    throw new SecretFileRefused(ref, path, why);
  };
  if (!isAbsolute(path)) refuse('the path is not absolute');
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    return refuse(`it cannot be examined (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (st.isSymbolicLink()) refuse('it is a symbolic link, not the file itself');
  if (!st.isFile()) refuse('it is not a regular file');
  if ((st.mode & 0o066) !== 0) refuse(`its mode ${(st.mode & 0o777).toString(8)} lets group or others read or write it (use 600 or 400)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) refuse("it is not owned by the engine's user");
  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch {
    realHome = home;
  }
  let realFile: string;
  try {
    realFile = realpathSync(path);
  } catch {
    realFile = path;
  }
  if (realFile === realHome || realFile.startsWith(realHome + sep)) refuse('it is under the engine home');
  let fd: number;
  try {
    // Non-blocking: a FIFO swapped in after the check never holds the start.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return refuse(`it cannot be opened (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let text: string;
  try {
    const f = fstatSync(fd);
    if (!f.isFile() || f.ino !== st.ino || f.dev !== st.dev) refuse('it changed while it was read');
    if (f.size > MAX_KEY_FILE_BYTES) refuse('it is larger than a key');
    const buf = Buffer.alloc(Math.max(1, f.size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const value = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (value === '') refuse('it is empty');
  if (/[\r\n]/.test(value)) refuse('it holds more than one line');
  return value;
}

// The flags' values, read and held; throws SecretFileRefused on the first
// file that may not be used, having held nothing.
export function holdSecretFiles(files: { ref: string; path: string }[], caps: { ref: string; usd: number }[], home: string): string[] {
  const values = files.map((f) => ({ ref: f.ref, value: readSecretFile(f.ref, f.path, home) }));
  for (const v of values) holdSecret(v.ref, v.value, caps.find((c) => c.ref === v.ref)?.usd);
  for (const c of caps) if (!values.some((v) => v.ref === c.ref)) holdSecret(c.ref, '', c.usd);
  return values.map((v) => v.ref);
}
