// The design preview's static file server (D7 §5.7; G4; SEAM.md §§499, 500):
// an engine-authored file of the engine's install, run by the engine's own
// node as the application of the reserved environment `design-preview`
// (`start: [<node>, <this file>]`), its working directory the sealed design
// tree (`/surety/app` in the service domain, bound read-only). Its hash is
// recorded on every preview deployment.
//
// What it does: on 127.0.0.1:$PORT, GET and HEAD only (any other method
// 405, nothing written), it answers
//   - `/`: the engine's index, each mockup of the tree's `design.json` with
//     its target and its preview capability;
//   - a path of the tree: the file's bytes, except a mockup the engine
//     frames (an HTML mockup of a target that is not `native`, every
//     `simulated_html`), whose own path answers the engine's frame: a fixed
//     banner saying what it simulates and that it is not native behaviour,
//     around one iframe sandboxed `allow-scripts` (scripts, not same origin,
//     so the mockup can neither reach nor remove the banner);
//   - `/__surety/raw/<path>`: a file's bytes for the frame's iframe, under a
//     `sandbox allow-scripts` content security policy; a top-level
//     navigation to a framed mockup's raw path answers the frame instead.
// A path that resolves outside the tree, through `..`, an encoded `..` or a
// link, is 404; a path that does not decode is 400.
//
// Nothing it serves is run here: the files are read and answered as bytes;
// HTML and scripts run only in the owner's browser. Self-contained (Node's
// own modules only): the service domain binds this one file at its own
// path. The engine imports the pure functions below (the index's mockups,
// the frame, SIMULATIONS.txt); it serves only when run as the program.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIMULATION_SENTENCE = 'Not native behaviour: back, safe areas, permissions, gestures, window chrome and menus are drawn, not exercised.';
// Where a framed mockup's own bytes are served, for its frame's iframe.
export const RAW_PREFIX = '/__surety/raw/';

export type Capability = 'native' | 'simulated' | 'none';

export interface Simulates {
  target: string;
  form_factor?: string;
  layout: string;
}

export interface SiteMockup {
  path: string;
  kind: string;
  target: string;
  capability: Capability;
  // Answered at its own path with the engine's frame.
  framed: boolean;
  simulates: Simulates | null;
}

const CAPABILITIES: readonly string[] = ['native', 'simulated', 'none'];

const parse = (b: Buffer | string | null | undefined): unknown => {
  if (b === null || b === undefined) return null;
  try {
    return JSON.parse(typeof b === 'string' ? b : b.toString('utf8'));
  } catch {
    return null;
  }
};
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isHtml = (path: string, kind: string): boolean => /\.html?$/i.test(path) || kind.endsWith('_html');

// The mockups of a design tree, as `design.json` and `screens.json` say:
// each one's target (what it simulates, else its first screen's target),
// its capability (`simulated` for a `simulated_html`; otherwise its
// target's `preview_capability` as `design.json` declares it, `none` when
// it declares none), and whether the engine frames it.
export function siteMockups(designJson: Buffer | string | null, screensJson: Buffer | string | null): SiteMockup[] {
  const design = obj(parse(designJson)) ?? {};
  const screens = obj(parse(screensJson))?.screens;
  const targetOfScreen = new Map<string, string>();
  for (const s of Array.isArray(screens) ? screens : []) {
    const o = obj(s);
    if (o && typeof o.key === 'string' && typeof o.target === 'string') targetOfScreen.set(o.key, o.target);
  }
  const declared = new Map<string, Capability>();
  for (const t of Array.isArray(design.targets) ? design.targets : []) {
    const o = obj(t);
    if (o && typeof o.target === 'string' && typeof o.preview_capability === 'string' && CAPABILITIES.includes(o.preview_capability)) declared.set(o.target, o.preview_capability as Capability);
  }
  const out: SiteMockup[] = [];
  const seen = new Set<string>();
  for (const m0 of Array.isArray(design.mockups) ? design.mockups : []) {
    const m = obj(m0);
    if (!m || typeof m.path !== 'string' || m.path === '' || seen.has(m.path)) continue;
    seen.add(m.path);
    const kind = typeof m.kind === 'string' ? m.kind : '';
    const sim = obj(m.simulates);
    const keys = Array.isArray(m.screens) ? m.screens.filter((k): k is string => typeof k === 'string') : [];
    const target = typeof sim?.target === 'string' ? sim.target : (keys.map((k) => targetOfScreen.get(k)).find((t) => t !== undefined) ?? 'unknown');
    const capability: Capability = kind === 'simulated_html' ? 'simulated' : (declared.get(target) ?? 'none');
    // Every HTML mockup the owner's browser would not run as the target's
    // own runtime is framed: a simulation is never served bare.
    const framed = kind === 'simulated_html' || (isHtml(m.path, kind) && capability !== 'native');
    const simulates: Simulates | null = framed
      ? { target, ...(typeof sim?.form_factor === 'string' && sim.form_factor !== '' ? { form_factor: sim.form_factor } : {}), layout: typeof sim?.layout === 'string' && sim.layout !== '' ? sim.layout : 'layout not declared' }
      : null;
    out.push({ path: m.path, kind, target, capability, framed, simulates });
  }
  return out;
}

export const bannerText = (s: Simulates): string => `Simulation of ${s.target} (${s.form_factor ? `${s.form_factor}, ` : ''}${s.layout}). ${SIMULATION_SENTENCE}`;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

// The engine's frame around a framed mockup.
export function frameHtml(m: SiteMockup): string {
  const s = m.simulates ?? { target: m.target, layout: 'layout not declared' };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(`Simulation of ${s.target}: ${m.path}`)}</title>`,
    '<style>body{margin:0;font-family:system-ui,sans-serif}#surety-simulation-banner{padding:8px 12px;background:#fff3c4;color:#3d3000;border-bottom:1px solid #d9c36a;font-size:14px}iframe{border:0;width:100%;height:calc(100vh - 48px)}</style>',
    '</head>',
    '<body>',
    `<div id="surety-simulation-banner" role="note">${esc(bannerText(s))}</div>`,
    `<iframe src="${esc(`${RAW_PREFIX}${encodePath(m.path)}`)}" sandbox="allow-scripts" title="${esc(m.path)}"></iframe>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// The engine's index of the mockups.
export function indexHtml(mockups: SiteMockup[], note: string | null): string {
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
    ...mockups.map((m) => `<li><a href="/${esc(encodePath(m.path))}" data-path="${esc(m.path)}" data-target="${esc(m.target)}" data-capability="${esc(m.capability)}">${esc(m.path)}</a> (${esc(m.target)}, ${esc(m.capability)})</li>`),
    '</ul>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// SIMULATIONS.txt (SEAM.md §501): one line per framed mockup,
// `<path>\t<target>\t<form_factor or ->\t<layout>`, after free-text lines
// beginning `#`.
export function simulationsText(mockups: SiteMockup[]): string {
  const lines = [
    '# Written by the Surety engine (D7 §5.7). Each line names a mockup that is a simulation:',
    '# an HTML drawing of a screen of a target this preview cannot run natively. It is not',
    '# native behaviour: back, safe areas, permissions, gestures, window chrome and menus are',
    '# drawn, not exercised. Columns: path, target, form factor (- if none), layout.',
    '',
  ];
  for (const m of mockups) if (m.framed && m.simulates) lines.push([m.path, m.simulates.target, m.simulates.form_factor ?? '-', m.simulates.layout].map((x) => x.replace(/[\t\r\n]/g, ' ')).join('\t'));
  return `${lines.join('\n')}\n`;
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

function serve(): void {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write('the design preview server needs PORT\n');
    process.exit(2);
  }
  const root = realpathSync(process.cwd());
  const read = (rel: string): Buffer | null => {
    try {
      return readFileSync(resolve(root, rel));
    } catch {
      return null;
    }
  };
  const mockups = siteMockups(read('design.json'), read('screens.json'));
  const note = read('design.json') === null ? 'This revision has no readable design.json: no mockup is listed.' : null;
  const framed = new Map(mockups.filter((m) => m.framed).map((m) => [m.path, m]));
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
      const m = framed.get(rel);
      // A framed mockup's own path, and a top-level navigation to its raw
      // path, answer the frame: never its bytes bare.
      if (m && (!raw || req.headers['sec-fetch-dest'] === 'document')) {
        answer(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'" }, Buffer.from(frameHtml(m)));
        return;
      }
      const file = fileOf(rel);
      if (file === null) {
        text(404, 'not found');
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        text(404, 'not found');
        return;
      }
      answer(200, { 'content-type': typeOf(rel), ...(raw ? { 'content-security-policy': 'sandbox allow-scripts' } : {}) }, body);
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
