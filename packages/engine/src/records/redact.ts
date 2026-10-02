// The redactor (D1 §14.2; E16c; SEAM.md §57). It holds every secret value the
// engine has resolved, in memory only, and the detectors registered with it.
// Secret values are removed from a role's output before any byte of it
// reaches the disk, and from every value derived from that output that the
// engine keeps or answers with. The match is made on the stream, not on the
// pieces it arrives in: across writes, across stored chunks, and inside a
// multibyte character. Detectors are patterns the post-write scan looks for
// in stored bytes.

export const REDACTION_VERSION = 'redactor-1';

const MARK = Buffer.from('[REDACTED]');
const MARK_TEXT = MARK.toString('utf8');

const secrets = new Map<string, Buffer>();
const detectors = new Map<string, RegExp>();

// A resolved secret: from now on its value is redacted. Held in memory only.
export function holdSecret(ref: string, value: string): void {
  if (value.length > 0) secrets.set(ref, Buffer.from(value, 'utf8'));
}

export function registerDetector(name: string, pattern: string): void {
  detectors.set(name, new RegExp(pattern));
}

const secretValues = (): Buffer[] => [...secrets.values()];

// Does a stored record's content match anything the engine knows to be
// secret: a held secret value, or a registered detector?
export function scanBytes(bytes: Buffer): { hit: boolean; by: string | null } {
  for (const [ref, value] of secrets) if (bytes.includes(value)) return { hit: true, by: `secret:${ref}` };
  if (detectors.size > 0) {
    const text = bytes.toString('utf8');
    for (const [name, re] of detectors) if (re.test(text)) return { hit: true, by: `detector:${name}` };
  }
  return { hit: false, by: null };
}

// Every secret value removed from a string.
export function redactText(text: string): string {
  let out = text;
  for (const value of secretValues()) {
    const v = value.toString('utf8');
    if (out.includes(v)) out = out.split(v).join(MARK_TEXT);
  }
  return out;
}

// Every secret value removed from every string of a JSON value, keys included.
export function redactValue<T>(value: T): T {
  if (secrets.size === 0) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redactText(k)] = redactValue(v);
    return out as T;
  }
  return value;
}

// A stream through the redactor. What `push` returns is safe to store: it
// holds back the bytes that could be the start of a secret value until it is
// known whether they are, and `end` gives what is held back.
export class StreamRedactor {
  private carry: Buffer = Buffer.alloc(0);

  push(data: Buffer): Buffer {
    return this.process(Buffer.concat([this.carry, data]), false);
  }

  end(): Buffer {
    return this.process(this.carry, true);
  }

  private process(buf: Buffer, final: boolean): Buffer {
    const values = secretValues();
    if (values.length === 0) {
      this.carry = Buffer.alloc(0);
      return buf;
    }
    const longest = Math.max(...values.map((v) => v.length));
    const out: Buffer[] = [];
    let pos = 0;
    for (;;) {
      let at = -1;
      let len = 0;
      for (const v of values) {
        const i = buf.indexOf(v, pos);
        if (i >= 0 && (at < 0 || i < at || (i === at && v.length > len))) {
          at = i;
          len = v.length;
        }
      }
      if (at < 0) break;
      out.push(buf.subarray(pos, at), MARK);
      pos = at + len;
    }
    // A match that starts before `keep` would lie wholly inside `buf` and has
    // been found; what follows may be the start of one.
    const keep = final ? buf.length : Math.max(pos, buf.length - (longest - 1));
    out.push(buf.subarray(pos, keep));
    this.carry = Buffer.from(buf.subarray(keep));
    return Buffer.concat(out);
  }
}
