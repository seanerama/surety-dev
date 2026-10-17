// The design preview's static file server (D7 §5.7; G4; SEAM.md §§499, 500):
// an engine-authored file of the engine's install, run by the engine's own
// node as the application of the reserved environment `design-preview`
// (`start: [<node>, <this file>]`), its working directory the sealed design
// tree (`/surety/app` in the service domain, bound read-only). Its hash is
// recorded on every preview deployment. An ES module by its name (`.mjs`),
// whatever package scope surrounds it, or none (the service domain binds
// this one file).
//
// What it serves is the engine's word, not the Designer's: the engine
// computes each mockup's target and preview capability from its own facts
// (the approved module map's targets and technologies, the project's
// `design_preview`) and hands them here in the configuration's environment
// (`SURETY_PREVIEW_MOCKUPS`), so the sealed tree stays the tree alone. On
// 127.0.0.1:$PORT, GET and HEAD only (any other method 405, nothing
// written), it answers
//   - `/`: the engine's index, each mockup with its target and capability;
//   - a path of the tree: the file's bytes, except an HTML file (`.html`,
//     `.htm`) that the engine did not list as a native mockup: every such
//     path answers the engine's frame, a fixed banner saying it is a
//     simulation and not native behaviour, around one iframe sandboxed
//     `allow-scripts` (scripts, not same origin, so the mockup can neither
//     reach nor remove the banner). Unlisted, unknown or malformed: framed.
//   - `/__surety/raw/<path>`: a file's bytes for the frame's iframe (and what
//     it loads), under a `sandbox allow-scripts` policy; a framed HTML path
//     there answers its bytes only to an iframe's request
//     (`Sec-Fetch-Dest: iframe`), and the frame to anything else.
// A path that resolves outside the tree, through `..`, an encoded `..` or a
// link, is 404; a path that does not decode is 400.
//
// Nothing it serves is run here: the files are read and answered as bytes;
// HTML and scripts run only in the owner's browser. Node's own modules only.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIMULATION_SENTENCE = 'Not native behaviour: back, safe areas, permissions, gestures, window chrome and menus are drawn, not exercised.';
// Where a framed mockup's own bytes are served, for its frame's iframe.
export const RAW_PREFIX = '/__surety/raw/';
// The configuration's variable carrying the engine's table of mockups.
export const MOCKUPS_VARIABLE = 'SURETY_PREVIEW_MOCKUPS';

export interface Simulates {
  target: string;
  form_factor?: string;
  layout: string;
}

// One mockup as the engine hands it over: its target and capability, or
// null where the engine could not determine them (shown as unknown, and
// framed).
export interface ServedMockup {
  path: string;
  target: string | null;
  capability: 'native' | 'simulated' | 'none' | null;
  simulates: Simulates | null;
}

export const isHtmlPath = (path: string): boolean => /\.html?$/i.test(path);

export const bannerText = (s: Simulates): string => `Simulation of ${s.target} (${s.form_factor ? `${s.form_factor}, ` : ''}${s.layout}). ${SIMULATION_SENTENCE}`;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// The engine's frame around a framed path.
export function frameHtml(path: string, s: Simulates): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(`Simulation of ${s.target}: ${path}`)}</title>`,
    '<style>body{margin:0;font-family:system-ui,sans-serif}#surety-simulation-banner{padding:8px 12px;background:#fff3c4;color:#3d3000;border-bottom:1px solid #d9c36a;font-size:14px}iframe{border:0;width:100%;height:calc(100vh - 48px)}</style>',
    '</head>',
    '<body>',
    `<div id="surety-simulation-banner" role="note">${esc(bannerText(s))}</div>`,
    `<iframe src="${esc(`${RAW_PREFIX}${encodePath(path)}`)}" sandbox="allow-scripts" title="${esc(path)}"></iframe>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// The engine's index of the mockups.
export function indexHtml(mockups: ServedMockup[], note: string | null): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Design preview</title>',
    '<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:860px}li{margin:6px 0}</style></head>',
    '<body>',
    '<h1>Design preview</h1>',
    '<p>Static files only. A native mockup is the design\'s own HTML in your browser; a simulated one is a drawing of a native screen, shown inside a labelled frame. Neither is the product, and neither is evidence about it.</p>',
    ...(note ? [`<p>${esc(note)}</p>`] : []),
    '<ul>',
    ...mockups.map((m) => {
      const target = m.target ?? 'target unknown';
      const capability = m.capability ?? 'capability unknown';
      return `<li><a href="/${esc(encodePath(m.path))}" data-path="${esc(m.path)}" data-target="${esc(m.target ?? '')}" data-capability="${esc(m.capability ?? '')}">${esc(m.path)}</a> (${esc(target)}, ${esc(capability)})</li>`;
    }),
    '</ul>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// The engine's table, read from the environment; anything malformed is
// dropped (and so framed, if HTML).
export function servedMockups(text: string | undefined): { mockups: ServedMockup[]; note: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? '');
  } catch {
    return { mockups: [], note: 'The engine gave this preview no readable list of mockups: every HTML file is shown as a simulation.' };
  }
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: ServedMockup[] = [];
  for (const m of Array.isArray(o.mockups) ? o.mockups : []) {
    if (m === null || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    if (typeof x.path !== 'string' || x.path === '') continue;
    const cap = x.capability === 'native' || x.capability === 'simulated' || x.capability === 'none' ? x.capability : null;
    const sim = x.simulates !== null && typeof x.simulates === 'object' ? (x.simulates as Record<string, unknown>) : null;
    out.push({
      path: x.path,
      target: typeof x.target === 'string' ? x.target : null,
      capability: cap,
      simulates:
        sim && typeof sim.target === 'string' && typeof sim.layout === 'string'
          ? { target: sim.target, ...(typeof sim.form_factor === 'string' ? { form_factor: sim.form_factor } : {}), layout: sim.layout }
          : null,
    });
  }
  return { mockups: out, note: typeof o.note === 'string' ? o.note : null };
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};
export const typeOf = (path: string): string => TYPES[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';

// ---- the program ----------------------------------------------------------------------------------

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' };
const UNKNOWN_SIMULATION: Simulates = { target: 'a target the engine could not determine', layout: 'layout not declared' };

function serve(): void {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write('the design preview server needs PORT\n');
    process.exit(2);
  }
  const root = realpathSync(process.cwd());
  const { mockups, note } = servedMockups(process.env[MOCKUPS_VARIABLE]);
  // Native: only what the engine listed as native. Every other HTML path is framed.
  const native = new Set(mockups.filter((m) => m.capability === 'native').map((m) => m.path));
  const listed = new Map(mockups.map((m) => [m.path, m]));
  const framed = (rel: string): boolean => isHtmlPath(rel) && !native.has(rel);
  const simulationOf = (rel: string): Simulates => {
    const m = listed.get(rel);
    if (m?.simulates) return m.simulates;
    if (m?.target) return { target: m.target, layout: 'layout not declared' };
    return UNKNOWN_SIMULATION;
  };
  const index = Buffer.from(indexHtml(mockups, note));

  // A path of the tree as a file under the root, or null: no empty, `.` or
  // `..` segment, and its real path (links followed) inside the root.
  const fileOf = (rel: string): string | null => {
    if (rel === '' || rel.split('/').some((s) => s === '' || s === '.' || s === '..') || rel.includes('\0') || rel.includes('\\')) return null;
    const full = resolve(root, rel);
    if (!full.startsWith(`${root}${sep}`)) return null;
    try {
      const real = realpathSync(full);
      if (!real.startsWith(`${root}${sep}`)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  http
    .createServer((req, res) => {
      const head = req.method === 'HEAD';
      const answer = (status: number, headers: Record<string, string>, body: Buffer): void => {
        res.writeHead(status, { ...BASE_HEADERS, ...headers, 'content-length': String(body.length) });
        res.end(head ? undefined : body);
      };
      const text = (status: number, s: string, extra: Record<string, string> = {}) => answer(status, { 'content-type': 'text/plain; charset=utf-8', ...extra }, Buffer.from(`${s}\n`));
      if (req.method !== 'GET' && !head) {
        text(405, 'method not allowed: the design preview is read-only', { allow: 'GET, HEAD' });
        req.resume();
        return;
      }
      let path = String(req.url ?? '/');
      const q = path.search(/[?#]/);
      if (q >= 0) path = path.slice(0, q);
      try {
        path = decodeURIComponent(path);
      } catch {
        text(400, 'bad path');
        return;
      }
      if (!path.startsWith('/')) {
        text(400, 'bad path');
        return;
      }
      if (path === '/') {
        answer(200, { 'content-type': 'text/html; charset=utf-8' }, index);
        return;
      }
      const raw = path.startsWith(RAW_PREFIX);
      const rel = raw ? path.slice(RAW_PREFIX.length) : path.slice(1);
      const file = fileOf(rel);
      if (file === null) {
        text(404, 'not found');
        return;
      }
      // A framed path, and its raw path to anything but an iframe's
      // request, answer the frame: never its bytes bare.
      if (framed(rel) && (!raw || req.headers['sec-fetch-dest'] !== 'iframe')) {
        answer(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'" }, Buffer.from(frameHtml(rel, simulationOf(rel))));
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        text(404, 'not found');
        return;
      }
      const type = typeOf(rel);
      // The sandboxed frame's document has an opaque origin: what it loads
      // from the raw path is served to it as cross-origin.
      const headers: Record<string, string> = raw
        ? { 'content-type': type, 'content-security-policy': 'sandbox allow-scripts', 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': 'null' }
        : { 'content-type': type, ...(type === 'image/svg+xml' ? { 'content-security-policy': 'sandbox' } : {}) };
      answer(200, headers, body);
    })
    .listen(port, '127.0.0.1');
}

// Served only when this file is the program (`node <this file>`); an import
// by the engine starts nothing.
const self = fileURLToPath(import.meta.url);
let program: string | null = null;
try {
  program = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  program = null;
}
if (program !== null && (program === self || program === realpathSync(self))) serve();
