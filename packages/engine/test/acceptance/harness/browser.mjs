// The browser lane of row M68 (Plan §2, resource B; E36 item 1; SEAM.md §90):
// real Chromium and real Firefox, driven by Playwright, loading the test
// shell the engine serves. Nothing here fabricates a request header: what a
// page sends is what its browser sends.
//
// The shell is the harness's, not the engine's (packages/ui/README.md: "M1
// needs only a minimal served test shell ..., which belongs to the acceptance
// harness"). `shellDirectory` copies it to a directory the engine is given
// with --harness-shell.

import { cpSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, firefox } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHELL_SOURCE = join(HERE, 'shell');

// The two browser families whose versions the M1 report records.
export const FAMILIES = ['chromium', 'firefox'];
const LAUNCHERS = { chromium, firefox };

const launched = new Map();

// The one browser of a family this test file uses, launched headless the
// first time it is asked for. A family that cannot be launched fails the
// test that asked: a missing lane is never skipped.
export async function browserOf(family) {
  if (!LAUNCHERS[family]) throw new Error(`unknown browser family ${family}`);
  if (!launched.has(family)) launched.set(family, LAUNCHERS[family].launch({ headless: true }));
  return launched.get(family);
}

export async function closeBrowsers() {
  for (const pending of launched.values()) {
    try {
      await (await pending).close();
    } catch {
      // it never launched, or is already gone
    }
  }
  launched.clear();
}

// A page in a browser context of its own: no cookie, no storage, no cache, no
// history. Every request the page makes and every response it gets is kept,
// as Playwright reports them from the browser's network layer. No header is
// added and no request is intercepted.
export async function freshPage(t, family) {
  const browser = await browserOf(family);
  const context = await browser.newContext();
  t.after(() => context.close().catch(() => {}));
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push(request));
  return { browser, context, page, requests };
}

// The requests a page made to one path of one origin, oldest first.
export const requestsTo = (requests, origin, path) =>
  requests.filter((request) => {
    const url = new URL(request.url());
    return url.origin === origin && url.pathname === path;
  });

// What the browser put on the wire for a request, and what came back:
// {headers, status, responseHeaders, text}. `text` is null when the browser
// does not hand the body to its driver (it does not for some responses a page
// was not allowed to read).
export async function exchangeOf(request) {
  const headers = await request.allHeaders();
  const response = await request.response();
  if (response === null) return { headers, status: null, responseHeaders: {}, text: null };
  let text = null;
  try {
    text = await response.text();
  } catch {
    text = null;
  }
  return { headers, status: response.status(), responseHeaders: await response.allHeaders(), text };
}

// The test shell, copied into `dir`: index.html and assets/shell.js. Returns
// {dir, files}: `files` maps each route the engine must serve to the bytes it
// must serve there.
export function shellDirectory(dir) {
  cpSync(SHELL_SOURCE, dir, { recursive: true });
  return {
    dir,
    files: {
      '/': { file: join(dir, 'index.html'), bytes: readFileSync(join(dir, 'index.html')), type: /^text\/html\b/ },
      '/assets/shell.js': { file: join(dir, 'assets', 'shell.js'), bytes: readFileSync(join(dir, 'assets', 'shell.js')), type: /^(text|application)\/javascript\b/ },
    },
  };
}

// A page of another origin, for the hostile half of row M68: a test-owned
// server on its own loopback port that serves one document and one script.
// The script asks the engine named in the page's query string for the token,
// as a page a person was lured to could, and writes what it was able to read
// into the document. It is not the engine and stands in for no part of it.
const HOSTILE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>another origin</title>
<script src="/hostile.js" defer></script></head>
<body><p>A page of another origin.</p><pre id="out"></pre></body></html>
`;
const HOSTILE_SCRIPT = `(async () => {
  const target = new URLSearchParams(location.search).get('target');
  const out = [];
  for (const mode of ['cors', 'no-cors']) {
    try {
      const res = await fetch(target + '/v1/token/bootstrap', { mode, referrerPolicy: 'unsafe-url', credentials: 'include', cache: 'no-store' });
      let text;
      try { text = await res.text(); } catch (err) { text = 'unreadable: ' + String(err); }
      out.push({ mode, type: res.type, status: res.status, text });
    } catch (err) {
      out.push({ mode, error: String(err) });
    }
  }
  document.getElementById('out').textContent = JSON.stringify(out);
  document.documentElement.setAttribute('data-done', 'yes');
})();
`;

export async function otherOriginServer(t) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://other.invalid').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HOSTILE_PAGE);
    } else if (path === '/hostile.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HOSTILE_SCRIPT);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}` };
}
