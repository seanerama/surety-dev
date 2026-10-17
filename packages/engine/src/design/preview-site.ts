// The design preview's sealed site (D7 §5.7; SEAM.md §§488, 500): the design
// tree's files as bytes, an index of the mockups with each one's target and
// preview capability, and for each simulated mockup the engine's frame: a
// banner saying what it simulates and what is not native behaviour, around
// an iframe that allows scripts and not same origin. The server is the
// engine's own, a fixed program that answers exactly the routes the site
// lists with their bytes; it runs nothing it serves. Nothing here is run by
// the engine either: the mockups are only copied.

import { createHash } from 'node:crypto';

import { previewCapability } from './inventory.js';

export const SIMULATION_SENTENCE = 'Not native behaviour: back, safe areas, permissions, gestures, window chrome and menus are drawn, not exercised.';
// Where a simulated mockup's own bytes are served, for its frame's iframe.
export const RAW_PREFIX = '/__surety/raw/';

export interface PreviewMockup {
  path: string;
  kind: string;
  target: string;
  capability: 'native' | 'simulated';
  screens: string[];
  simulates: { target: string; form_factor?: string; layout: string } | null;
}

export interface PreviewSite {
  // path in the sealed copy → bytes
  files: Map<string, Buffer>;
  mockups: PreviewMockup[];
  tree_digest: string;
  server_digest: string;
}

const sha256hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

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
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};
const typeOf = (path: string): string => TYPES[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const href = (path: string): string => `/${path.split('/').map(encodeURIComponent).join('/')}`;

export const bannerText = (s: { target: string; form_factor?: string | undefined; layout: string }): string =>
  `Simulation of ${s.target} (${s.form_factor ? `${s.form_factor}, ` : ''}${s.layout}). ${SIMULATION_SENTENCE}`;

// The engine's server: CommonJS, Node's own http, the routes read from
// routes.json beside it; a path not listed is 404, a method other than GET
// or HEAD 405. Nothing is decoded but the request path; nothing is run.
export const PREVIEW_SERVER = [
  "'use strict';",
  '// The design preview server (D7 §5.7), written by the Surety engine. It answers',
  '// the routes routes.json lists with their files, as bytes, and nothing else.',
  "const http = require('node:http');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const routes = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'))));",
  "const base = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' };",
  'function answer(res, status, headers, body, head) {',
  "  res.writeHead(status, Object.assign({}, base, headers, { 'content-length': body.length }));",
  '  res.end(head ? undefined : body);',
  '}',
  'http.createServer((req, res) => {',
  "  const head = req.method === 'HEAD';",
  "  if (req.method !== 'GET' && !head) return answer(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, Buffer.from('method not allowed\\n'), false);",
  "  let p = String(req.url || '/');",
  "  const q = p.indexOf('?');",
  '  if (q >= 0) p = p.slice(0, q);',
  '  try {',
  '    p = decodeURIComponent(p);',
  '  } catch (e) {',
  "    return answer(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('bad path\\n'), head);",
  '  }',
  '  const r = routes.get(p);',
  "  if (!r) return answer(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('not found\\n'), head);",
  '  let body;',
  '  try {',
  '    body = fs.readFileSync(path.join(__dirname, r.file));',
  '  } catch (e) {',
  "    return answer(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('unreadable\\n'), head);",
  '  }',
  "  const headers = { 'content-type': r.type };",
  "  if (r.sandbox) headers['content-security-policy'] = 'sandbox allow-scripts';",
  '  return answer(res, 200, headers, body, head);',
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
  '',
].join('\n');

interface DesignJson {
  mockups?: { path?: unknown; kind?: unknown; screens?: unknown; simulates?: unknown }[];
}
interface ScreensJson {
  screens?: { key?: unknown; target?: unknown }[];
}

const parse = <T>(b: Buffer | undefined): T | null => {
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8')) as T;
  } catch {
    return null;
  }
};

// The site of a design tree ({path under .surety/design/: bytes}).
export function previewSite(tree: Map<string, Buffer>, opts: { targets: { target: string; technology: string }[]; design_preview: string; revision: string }): PreviewSite {
  const design = parse<DesignJson>(tree.get('design.json')) ?? {};
  const screens = parse<ScreensJson>(tree.get('screens.json'))?.screens ?? [];
  const targetOfScreen = new Map(screens.map((s) => [String(s.key), String(s.target)]));
  const technology = new Map(opts.targets.map((t) => [t.target, t.technology]));
  const mockups: PreviewMockup[] = [];
  for (const m of design.mockups ?? []) {
    if (typeof m.path !== 'string' || !tree.has(m.path)) continue;
    const keys = Array.isArray(m.screens) ? m.screens.map(String) : [];
    const sim = m.simulates && typeof m.simulates === 'object' ? (m.simulates as Record<string, unknown>) : null;
    const target = typeof sim?.target === 'string' ? sim.target : (keys.map((k) => targetOfScreen.get(k)).find((t) => t !== undefined) ?? 'web');
    const capability: 'native' | 'simulated' =
      m.kind === 'simulated_html' ? 'simulated' : previewCapability(target, technology.get(target) ?? 'html_css', opts.design_preview) === 'native' ? 'native' : 'simulated';
    mockups.push({
      path: m.path,
      kind: String(m.kind ?? 'html'),
      target,
      capability,
      screens: keys,
      simulates: capability === 'simulated' ? { target, ...(typeof sim?.form_factor === 'string' ? { form_factor: sim.form_factor } : {}), layout: typeof sim?.layout === 'string' ? sim.layout : '' } : null,
    });
  }
  const files = new Map<string, Buffer>();
  const routes: Record<string, { file: string; type: string; sandbox?: true }> = {};
  const sorted = [...tree.keys()].sort();
  for (const p of sorted) {
    const file = `site/${p}`;
    files.set(file, tree.get(p)!);
    routes[`/${p}`] = { file, type: typeOf(p) };
  }
  // Each simulated mockup: its own path answers with the engine's frame;
  // its bytes only at the raw path, sandboxed.
  mockups.forEach((m, i) => {
    if (m.capability !== 'simulated') return;
    const frame = `frames/${i}.html`;
    const banner = bannerText(m.simulates!);
    files.set(
      frame,
      Buffer.from(
        [
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
          `<title>${esc(`Simulation of ${m.target}: ${m.path}`)}</title>`,
          '<style>body{margin:0;font-family:system-ui,sans-serif}#surety-simulation-banner{padding:8px 12px;background:#fff3c4;color:#3d3000;border-bottom:1px solid #d9c36a;font-size:14px}iframe{border:0;width:100%;height:calc(100vh - 48px)}</style>',
          '</head>',
          '<body>',
          `<div id="surety-simulation-banner" role="note">${esc(banner)}</div>`,
          `<iframe src="${esc(`${RAW_PREFIX}${m.path.split('/').map(encodeURIComponent).join('/')}`)}" sandbox="allow-scripts" title="${esc(m.path)}"></iframe>`,
          '</body>',
          '</html>',
          '',
        ].join('\n'),
      ),
    );
    routes[`/${m.path}`] = { file: frame, type: 'text/html; charset=utf-8' };
    routes[`${RAW_PREFIX}${m.path}`] = { file: `site/${m.path}`, type: typeOf(m.path), sandbox: true };
  });
  const index = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Design preview</title>',
    '<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:860px}li{margin:6px 0}code{font-size:13px}</style></head>',
    '<body>',
    '<h1>Design preview</h1>',
    `<p>Revision <code>${esc(opts.revision)}</code>. Static files only: native mockups are the design's own HTML; simulated ones are drawings of a native screen in a frame.</p>`,
    '<ul>',
    ...mockups.map((m) => `<li><a href="${esc(href(m.path))}" data-path="${esc(m.path)}" data-target="${esc(m.target)}" data-capability="${esc(m.capability)}">${esc(m.path)}</a> (${esc(m.target)}, ${esc(m.capability)})</li>`),
    '</ul>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  files.set('index.html', Buffer.from(index));
  routes['/'] = { file: 'index.html', type: 'text/html; charset=utf-8' };
  routes['/index.html'] = routes['/index.html'] ?? { file: 'index.html', type: 'text/html; charset=utf-8' };
  files.set('routes.json', Buffer.from(`${JSON.stringify(routes, null, 2)}\n`));
  const server = Buffer.from(PREVIEW_SERVER);
  files.set('server.js', server);
  const tree_digest = `sha256:${sha256hex(JSON.stringify(sorted.map((p) => [p, sha256hex(tree.get(p)!)])))}`;
  return { files, mockups, tree_digest, server_digest: `sha256:${sha256hex(server)}` };
}
