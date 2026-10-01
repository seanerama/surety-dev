// Identity (D1 §2.1, A.1): a type prefix plus a 26-character time-ordered
// ULID in Crockford base32. Monotonic within one millisecond in one thread.

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_MASK = (1n << 80n) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  let random: bigint;
  if (now <= lastTime) {
    // Same millisecond (or a clock step back): keep ordering by incrementing.
    now = lastTime;
    random = (lastRandom + 1n) & RANDOM_MASK;
  } else {
    random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  }
  lastTime = now;
  lastRandom = random;
  return encode(BigInt(now), 10) + encode(random, 16);
}

export const newId = (prefix: string): string => `${prefix}${ulid()}`;
