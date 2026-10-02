// api.token (D1 §11.1, SEAM.md §6, E23 items 7 and 8). The API token is the
// content of $SURETY_HOME/api.token, created at first start with mode 0600 and
// never rotated by the engine. An existing file the engine cannot trust is
// refused, never repaired or replaced: one open to group or others may already
// have been read, and one that is empty or too short was not written by a
// complete first start. The refusal is decided before the lock is taken.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { syncDirectory } from './durable.js';
import { Refusal } from './refusal.js';

export const TOKEN_MIN_LENGTH = 32;

function tokenFileRefused(why: string, whatToDo: string): Refusal {
  return new Refusal(500, 'token_file_refused', `api.token cannot be used: ${why}.`, whatToDo, { file: 'api.token' });
}

const REPLACE =
  'If the token may have been exposed, or the file is damaged, remove api.token so the next start creates a new one, and give clients the new token.';

// A token is well formed when it has at least TOKEN_MIN_LENGTH characters and
// every one is a visible ASCII character (0x21 to 0x7E): it travels in a
// header (D1 §11.1, SEAM.md §6). A token this engine creates is hex, so it is
// well formed by this rule.
const WELL_FORMED = /^[\x21-\x7e]+$/;

function malformedWhy(token: string): string | null {
  if (token.length === 0) return 'it is empty';
  if (!WELL_FORMED.test(token)) return 'it holds a character that is not visible ASCII (whitespace, a control character, or a non-ASCII character)';
  if (token.length < TOKEN_MIN_LENGTH) return `it holds ${token.length} characters, fewer than ${TOKEN_MIN_LENGTH}`;
  return null;
}

// The token held by an existing api.token, or null if there is none. Reads
// only. Anything that makes the file untrustworthy, or unreadable, refuses.
// The kind of file is judged before it is opened, and it is opened without
// blocking: opening a named pipe for reading would wait for a writer.
export function readToken(file: string): string | null {
  let kind;
  try {
    kind = lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw tokenFileRefused(`it could not be examined (${(err as Error).message})`, 'Make api.token readable by the engine user only, or remove it.');
  }
  if (kind.isSymbolicLink()) throw tokenFileRefused('it is a symbolic link', 'Replace it with a regular file of mode 0600, or remove it.');
  if (!kind.isFile()) throw tokenFileRefused('it is not a regular file', 'Remove it so the next start creates api.token.');
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw tokenFileRefused('it is a symbolic link', 'Replace it with a regular file of mode 0600, or remove it.');
    throw tokenFileRefused(`it could not be opened (${(err as Error).message})`, 'Make api.token readable by the engine user only, or remove it.');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw tokenFileRefused('it is not a regular file', 'Remove it so the next start creates api.token.');
    if ((st.mode & 0o077) !== 0) {
      throw tokenFileRefused(
        `its mode ${(st.mode & 0o777).toString(8).padStart(4, '0')} grants access to group or others, so the token may already have been read`,
        `The engine does not repair the mode or replace the token on its own. Either restrict it (chmod 600 api.token) if you know it was not read, or remove it. ${REPLACE}`,
      );
    }
    let text: string;
    try {
      text = readFileSync(fd, 'utf8');
    } catch (err) {
      throw tokenFileRefused(`it could not be read (${(err as Error).message})`, REPLACE);
    }
    const token = text.trimEnd();
    const why = malformedWhy(token);
    if (why !== null) throw tokenFileRefused(why, `The engine does not replace a token on its own. ${REPLACE}`);
    return token;
  } finally {
    closeSync(fd);
  }
}

// Create api.token for the first time and return its token. The file appears
// complete or not at all: the token is written and synced under a temporary
// name, then linked into place, which fails rather than overwrites if a file
// appeared meanwhile; that file is then judged like any existing one. Called
// only by the start that is taking the lock.
export function createToken(file: string): string {
  const temp = `${file}.tmp`;
  const token = randomBytes(32).toString('hex');
  // A temporary file left by an interrupted first start never became the
  // token; only the lock holder writes here.
  try {
    unlinkSync(temp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = readToken(file);
    if (existing === null) throw new Error(`${basename(file)} appeared and vanished while it was being created`);
    return existing;
  } finally {
    unlinkSync(temp);
  }
  syncDirectory(dirname(file));
  return token;
}

