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

const secrets = new Map<string, Buffer>();
const detectors = new Map<string, RegExp>();

// A resolved secret: from now on its value is redacted. Held in memory only.
export function holdSecret(ref: string, value: string): void {
  if (value.length > 0) secrets.set(ref, Buffer.from(value, 'utf8'));
}

export function registerDetector(name: string, pattern: string): void {
  detectors.set(name, new RegExp(pattern));
}

// ---- matching a secret as the role's output encodes it -------------------------
//
// Roles write JSON lines, and JSON may write any character of a string as an
// escape: `\"`, `\\`, `\/`, `\n` and the like, or `\uXXXX` (a surrogate pair
// for a character outside the basic plane). So a secret is looked for twice
// in the same bytes (E37 item 2): as the bytes are, and in their decoded
// view, in which every JSON escape sequence is read as the character it
// stands for. A JSON string's decoded value is exactly the decoded view of
// the bytes between its quotes, so in a line that parses as JSON the match is
// made on its decoded values (keys included), and replacing the escape
// sequences that spelled the secret leaves the line valid JSON; any other
// line is matched as bytes, and in the decoded view as well, so an escaped
// form is found there too. What is looked for in both is each held value and
// its JSON-escaped form (a value escaped once more, as JSON inside a JSON
// string writes it). The post-write scan uses the same matcher, so it can
// find whatever the redactor is meant to remove.

const BACKSLASH = 0x5c;
const SIMPLE_ESCAPES: Record<number, number> = {
  0x22: 0x22, // \"
  0x5c: 0x5c, // \\
  0x2f: 0x2f, // \/
  0x62: 0x08, // \b
  0x66: 0x0c, // \f
  0x6e: 0x0a, // \n
  0x72: 0x0d, // \r
  0x74: 0x09, // \t
};
// The longest run of source bytes one decoded byte can come from: `A`.
const MAX_EXPANSION = 6;

interface Form {
  ref: string;
  bytes: Buffer;
}

// Every form a held secret is looked for in.
function secretForms(): Form[] {
  const forms: Form[] = [];
  for (const [ref, value] of secrets) {
    forms.push({ ref, bytes: value });
    const escaped = Buffer.from(JSON.stringify(value.toString('utf8')).slice(1, -1), 'utf8');
    if (!escaped.equals(value)) forms.push({ ref, bytes: escaped });
  }
  return forms;
}

const hex4 = (buf: Buffer, at: number): number | null => {
  if (at + 4 > buf.length) return null;
  const text = buf.toString('latin1', at, at + 4);
  return /^[0-9a-fA-F]{4}$/.test(text) ? Number.parseInt(text, 16) : null;
};

// The decoded view of `buf`: its bytes with every JSON escape sequence read
// as the UTF-8 bytes of the character it stands for. `from[i]` and `to[i]`
// are the source bytes view byte i came from; `boundary[p]` is true where a
// source element (a byte, or one escape sequence) begins. Null when `buf`
// holds no escape, so its view is itself.
interface View {
  bytes: Buffer;
  from: Int32Array;
  to: Int32Array;
  boundary: Uint8Array;
}

function decodedView(buf: Buffer): View | null {
  const boundary = new Uint8Array(buf.length + 1);
  boundary[buf.length] = 1;
  if (!buf.includes(BACKSLASH)) return null;
  // A decoded byte never comes from fewer than one source byte, so the view
  // is no longer than `buf`.
  const bytes = Buffer.allocUnsafe(buf.length);
  const from = new Int32Array(buf.length);
  const to = new Int32Array(buf.length);
  let n = 0;
  const emit = (decoded: Buffer | number[], start: number, end: number) => {
    for (const b of decoded) {
      bytes[n] = b;
      from[n] = start;
      to[n] = end;
      n++;
    }
  };
  let i = 0;
  while (i < buf.length) {
    boundary[i] = 1;
    const b = buf[i]!;
    if (b === BACKSLASH && i + 1 < buf.length) {
      const next = buf[i + 1]!;
      const simple = SIMPLE_ESCAPES[next];
      if (simple !== undefined) {
        emit([simple], i, i + 2);
        i += 2;
        continue;
      }
      if (next === 0x75) {
        const unit = hex4(buf, i + 2);
        if (unit !== null) {
          // A surrogate pair is one character.
          if (unit >= 0xd800 && unit <= 0xdbff && buf[i + 6] === BACKSLASH && buf[i + 7] === 0x75) {
            const low = hex4(buf, i + 8);
            if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
              emit(Buffer.from(String.fromCharCode(unit, low), 'utf8'), i, i + 12);
              i += 12;
              continue;
            }
          }
          emit(Buffer.from(String.fromCharCode(unit), 'utf8'), i, i + 6);
          i += 6;
          continue;
        }
      }
    }
    emit([b], i, i + 1);
    i += 1;
  }
  return { bytes: bytes.subarray(0, n), from, to, boundary };
}

interface Span {
  start: number;
  end: number;
  ref: string;
}

// Every place in `buf` where a held secret is, in any form, as source byte
// spans, overlapping spans merged, in order.
function secretSpans(buf: Buffer, forms: Form[], view: View | null): Span[] {
  const found: Span[] = [];
  for (const form of forms) {
    for (let at = buf.indexOf(form.bytes); at >= 0; at = buf.indexOf(form.bytes, at + 1)) found.push({ start: at, end: at + form.bytes.length, ref: form.ref });
    if (view) {
      for (let at = view.bytes.indexOf(form.bytes); at >= 0; at = view.bytes.indexOf(form.bytes, at + 1)) {
        found.push({ start: view.from[at]!, end: view.to[at + form.bytes.length - 1]!, ref: form.ref });
      }
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of found) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

// `buf` with every span replaced by the mark.
function replaceSpans(buf: Buffer, spans: Span[], upTo = buf.length): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  for (const s of spans) {
    out.push(buf.subarray(pos, s.start), MARK);
    pos = s.end;
  }
  out.push(buf.subarray(pos, Math.max(pos, upTo)));
  return Buffer.concat(out);
}

// Does a stored record's content match anything the engine knows to be
// secret: a held secret value in any form the redactor removes, or a
// registered detector?
export function scanBytes(bytes: Buffer): { hit: boolean; by: string | null } {
  const forms = secretForms();
  if (forms.length > 0) {
    const [first] = secretSpans(bytes, forms, decodedView(bytes));
    if (first) return { hit: true, by: `secret:${first.ref}` };
  }
  if (detectors.size > 0) {
    const text = bytes.toString('utf8');
    for (const [name, re] of detectors) if (re.test(text)) return { hit: true, by: `detector:${name}` };
  }
  return { hit: false, by: null };
}

// Every secret value removed from a string, in any form the redactor removes.
export function redactText(text: string): string {
  const forms = secretForms();
  if (forms.length === 0) return text;
  const buf = Buffer.from(text, 'utf8');
  const spans = secretSpans(buf, forms, decodedView(buf));
  return spans.length === 0 ? text : replaceSpans(buf, spans).toString('utf8');
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

// The earliest position from which the rest of `buf` is a proper beginning
// of some form, or `buf.length` if no end of `buf` can begin one. Used only
// where the end of `buf` holds no escape sequence, so its decoded view is the
// bytes themselves.
function possibleStart(buf: Buffer, forms: Form[]): number {
  const longest = Math.max(...forms.map((f) => f.bytes.length));
  for (let p = Math.max(0, buf.length - (longest - 1)); p < buf.length; p++) {
    const rest = buf.subarray(p);
    if (forms.some((f) => rest.length < f.bytes.length && f.bytes.subarray(0, rest.length).equals(rest))) return p;
  }
  return buf.length;
}

// A stream through the redactor. What `push` returns is safe to store: it
// holds back the bytes that could be the start of a secret, in any form,
// until it is known whether they are, and `end` gives what is held back.
export class StreamRedactor {
  private carry: Buffer = Buffer.alloc(0);

  push(data: Buffer): Buffer {
    return this.process(Buffer.concat([this.carry, data]), false);
  }

  end(): Buffer {
    return this.process(this.carry, true);
  }

  private process(buf: Buffer, final: boolean): Buffer {
    const forms = secretForms();
    if (forms.length === 0) {
      this.carry = Buffer.alloc(0);
      return buf;
    }
    const view = decodedView(buf);
    let spans = secretSpans(buf, forms, view);
    let keep = buf.length;
    if (!final) {
      // A match is at most this many source bytes long, so one that starts
      // before `limit` lies wholly inside `buf` and has been found; what
      // follows may be the start of one. The cut is made where an escape
      // sequence begins, never inside one, so the next view reads it whole.
      const longest = Math.max(...forms.map((f) => f.bytes.length)) * MAX_EXPANSION;
      const limit = Math.max(0, buf.length - (longest - 1));
      // Where no escape sequence can be under way, only what could still
      // become a secret is held back: the longest end of `buf` that is the
      // beginning of a form. Everything before it is released now, so output
      // reaches its readers as it is written (SEAM.md §92), not a window
      // later.
      keep = buf.subarray(limit).includes(BACKSLASH) ? limit : possibleStart(buf, forms);
      spans = spans.filter((s) => s.start < keep);
      if (view) while (keep > 0 && !view.boundary[keep]) keep--;
      const last = spans[spans.length - 1];
      if (last) keep = Math.max(keep, last.end);
    }
    const out = replaceSpans(buf, spans, keep);
    this.carry = Buffer.from(buf.subarray(keep));
    return out;
  }
}
