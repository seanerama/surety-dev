// The connected clients of the load case of row M71 (SEAM.md §93), run as a
// process of their own by load.mjs `startStreamClients`, so that their
// reading does not occupy the test process's event loop while it measures
// latencies. It is a client of the engine's public event stream and nothing
// else.
//
// Input: SURETY_STREAM_SPEC, a JSON object {port, authority, followers,
// pagers, slow, since, limit}; SURETY_STREAM_TOKEN, the API token (in the
// environment, so that it is in no argument list and no URL).
// Output, one JSON object per line on stdout:
//   {"ready": true, "connected": n, "statuses": [...]}   every client has its response head
//   {"progress": true, "clients": [...]}                 on SIGUSR2
//   {"summary": true, "connected": n, "clients": [...]}  on SIGTERM, before it exits

import { eventsPath, openStream } from './sse.mjs';

const spec = JSON.parse(process.env.SURETY_STREAM_SPEC);
const token = process.env.SURETY_STREAM_TOKEN;
const open = (path, opts = {}) => openStream({ port: spec.port, authority: spec.authority, token, path, ...opts });

const clients = [];
const report = () =>
  clients.map((c) => ({ kind: c.kind, status: c.current?.status ?? null, bytes: c.bytes + (c.current?.bytes ?? 0), events: c.events + (c.current?.ids.length ?? 0), pages: c.pages, lastId: c.current?.lastId ?? c.lastId, ended: c.current?.ended ?? true }));

async function follower() {
  const entry = { kind: 'follower', bytes: 0, events: 0, pages: 0, lastId: null, current: null };
  clients.push(entry);
  entry.current = await open(eventsPath({ since: spec.since ?? 0 }));
}

async function slow() {
  const entry = { kind: 'slow', bytes: 0, events: 0, pages: 0, lastId: null, current: null };
  clients.push(entry);
  entry.current = await open(eventsPath({ since: 0 }), { paused: true });
}

// A pager reads the whole log in pages, and starts again when it reaches the end.
async function pager() {
  const entry = { kind: 'pager', bytes: 0, events: 0, pages: 0, lastId: null, current: null };
  clients.push(entry);
  entry.current = await open(eventsPath({ since: 0, limit: spec.limit ?? 1_000_000 }));
  (async () => {
    for (;;) {
      const page = entry.current;
      if (page.status !== 200) return;
      await page.waitEnd({ timeoutMs: 600_000 });
      entry.bytes += page.bytes;
      entry.events += page.ids.length;
      entry.pages++;
      entry.lastId = page.ids.length === 0 ? 0 : page.lastId;
      // Drop what the finished page held before the next one is read.
      entry.current = null;
      entry.current = await open(eventsPath({ since: entry.lastId, limit: spec.limit ?? 1_000_000 }));
    }
  })().catch((err) => process.stderr.write(`pager: ${err.stack ?? err}\n`));
}

const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.on('SIGUSR2', () => say({ progress: true, clients: report() }));
process.on('SIGTERM', () => {
  say({ summary: true, connected: clients.filter((c) => c.current !== null || c.pages > 0).length, clients: report() });
  for (const c of clients) c.current?.close();
  process.exit(0);
});

const starting = [];
for (let i = 0; i < (spec.followers ?? 0); i++) starting.push(follower());
for (let i = 0; i < (spec.pagers ?? 0); i++) starting.push(pager());
for (let i = 0; i < (spec.slow ?? 0); i++) starting.push(slow());
await Promise.all(starting);
say({ ready: true, connected: clients.filter((c) => c.current !== null).length, statuses: clients.map((c) => c.current?.status ?? null) });
// Stay until told to stop.
setInterval(() => {}, 1000);
