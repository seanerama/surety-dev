// The event-log reader (D1 §§11.3, 12.1; SEAM.md §92). A worker thread with a
// connection of its own that only reads: replaying the log to the event
// streams never occupies the store worker, whose one connection carries every
// transition, and never the main thread, which only hands the bytes this
// worker formats to the client's socket.
//
// One operation: the next page of the log after a cursor, as server-sent
// event messages, at most `maxRows` events and about `maxBytes` bytes (a page
// always holds at least one event when there is one). WAL lets this
// connection read while the store worker writes; each page is its own read
// snapshot, and an event is committed when it is visible here.

import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

export interface ReaderData {
  file: string;
}

export interface PageRequest {
  id: number;
  after: number;
  maxRows: number;
  maxBytes: number;
}

export type PageReply =
  | { id: number; ok: true; bytes: ArrayBuffer; count: number; last: number }
  | { id: number; ok: false; error: string };

const port = parentPort!;
const data = workerData as ReaderData;

let db: Database.Database | null = null;
let page: Database.Statement | null = null;

function open(): Database.Statement {
  if (page) return page;
  db = new Database(data.file, { fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  page = db.prepare('SELECT "seq", "type", "at", "subject", "payload", "actor_kind", "actor_id", "request_id", "operation" FROM "events" WHERE "seq" > ? ORDER BY "seq" LIMIT ?');
  return page;
}

// A JSON text as stored, made one line. The engine writes its event JSON on
// one line; anything else stored there is re-serialized, and text that is not
// JSON at all is sent as a string rather than as broken JSON.
function oneLine(text: string): string {
  if (!text.includes('\n') && !text.includes('\r')) return text;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify(text);
  }
}

const str = (v: unknown): string => (v === null || v === undefined ? 'null' : JSON.stringify(String(v)));

interface Row {
  seq: number;
  type: string;
  at: string;
  subject: string;
  payload: string;
  actor_kind: string;
  actor_id: string | null;
  request_id: string | null;
  operation: string | null;
}

// One event as one message: `id` the sequence number (the cursor), `event`
// the type, `data` the event on one line of JSON.
function message(row: Row): string {
  const type = String(row.type).replace(/[\r\n]/g, ' ');
  const data =
    `{"seq":${row.seq},"type":${str(row.type)},"at":${str(row.at)},"subject":${oneLine(row.subject)},"payload":${oneLine(row.payload)},` +
    `"actor_kind":${str(row.actor_kind)},"actor_id":${str(row.actor_id)},"request_id":${str(row.request_id)},"operation":${str(row.operation)}}`;
  return `id: ${row.seq}\nevent: ${type}\ndata: ${data}\n\n`;
}

port.on('message', (req: PageRequest) => {
  let reply: PageReply;
  try {
    const statement = open();
    const parts: Buffer[] = [];
    let bytes = 0;
    let count = 0;
    let last = req.after;
    for (const row of statement.iterate(req.after, req.maxRows) as IterableIterator<Row>) {
      const buf = Buffer.from(message(row), 'utf8');
      parts.push(buf);
      bytes += buf.length;
      count++;
      last = row.seq;
      if (bytes >= req.maxBytes) break;
    }
    const all = Buffer.concat(parts, bytes);
    // A buffer of its own, so it can be transferred rather than copied.
    const out = all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer;
    reply = { id: req.id, ok: true, bytes: out, count, last };
    port.postMessage(reply, [out]);
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    port.postMessage(reply);
  }
});
