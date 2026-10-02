// Identity and time values the tests write directly into the store (SEAM.md
// "Value formats"). Ids are D1 §2.1 / A.1: a type prefix plus a 26-character
// time-ordered ULID in Crockford base32.

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom = null;

function encode(value, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

// Monotonic within one process: ids made in a loop sort in order, within one
// millisecond and across a host clock that steps back (the time part never
// goes below the last one used).
export function ulid(now = Date.now()) {
  let random;
  if (now <= lastTime && lastRandom !== null) {
    now = lastTime;
    random = lastRandom + 1n;
  } else {
    random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  }
  lastTime = now;
  lastRandom = random;
  return encode(BigInt(now), 10) + encode(random & ((1n << 80n) - 1n), 16);
}

export const newId = (prefix) => `${prefix}${ulid()}`;

export function hasIdForm(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && ULID_BODY.test(value.slice(prefix.length));
}

// ISO-8601 UTC with milliseconds: 2026-10-01T12:00:00.000Z.
export const isoNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
export const dayUtc = () => new Date().toISOString().slice(0, 10);
export const fakeSha = () => randomBytes(20).toString('hex');
