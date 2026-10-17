// Developer tests for the design preview's sealed site (D7 §5.7; SEAM.md
// §§488, 500): the index lists each mockup with its target and capability;
// a simulated mockup's path answers with the engine's frame (the banner,
// one iframe sandboxed `allow-scripts`, its src the raw path), never its
// bytes; a native mockup answers with its bytes; the engine's server
// answers only the routes it lists (a path outside them, a traversal, a
// method other than GET or HEAD refused). The server is the engine's own
// program, run here as this test's child on 127.0.0.1 and ended by its own
// handle; nothing it serves is run.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { previewSite, bannerText, RAW_PREFIX } = await import(join(root, 'dist', 'design', 'preview-site.js'));
const { parseDesignCommand } = await import(join(root, 'dist', 'design', 'design-command.js'));

const WEB = Buffer.from('<!doctype html><title>S1</title><p>list</p>\n');
const ANDROID = Buffer.from('<!doctype html><title>S2</title><script>1</script>\n');
const tree = new Map([
  ['design.json', Buffer.from(JSON.stringify({ mockups: [
    { path: 'mockups/web/s1.html', kind: 'html', screens: ['S1'] },
    { path: 'mockups/android/s2.html', kind: 'simulated_html', screens: ['S2'], simulates: { target: 'android', form_factor: 'phone', layout: 'portrait' } },
  ] }))],
  ['screens.json', Buffer.from(JSON.stringify({ screens: [{ key: 'S1', target: 'web' }, { key: 'S2', target: 'android' }] }))],
  ['mockups/web/s1.html', WEB],
  ['mockups/android/s2.html', ANDROID],
]);
const targets = [{ target: 'web', technology: 'html_css' }, { target: 'android', technology: 'react_native' }];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const get = (port, path, method = 'GET') => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
  });
  req.on('error', (e) => resolve({ status: null, error: e.code }));
  req.end();
});

test('the site: mockups with their capability, the frame for a simulated one, digests', () => {
  const site = previewSite(tree, { targets, design_preview: 'static', revision: 'a'.repeat(40) });
  assert.deepEqual(site.mockups.map((m) => [m.path, m.target, m.capability]), [['mockups/web/s1.html', 'web', 'native'], ['mockups/android/s2.html', 'android', 'simulated']]);
  const index = site.files.get('index.html').toString();
  assert.match(index, /data-path="mockups\/web\/s1.html" data-target="web" data-capability="native"/);
  assert.match(index, /data-path="mockups\/android\/s2.html" data-target="android" data-capability="simulated"/);
  const frame = site.files.get('frames/1.html').toString();
  assert.ok(frame.includes(bannerText({ target: 'android', form_factor: 'phone', layout: 'portrait' })));
  assert.match(frame, /<iframe src="\/__surety\/raw\/mockups\/android\/s2.html" sandbox="allow-scripts"/);
  assert.match(site.tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(site.server_digest, /^sha256:[0-9a-f]{64}$/);
  // The tree's digest is the design's alone, the same for the same files.
  assert.equal(previewSite(new Map([...tree].reverse()), { targets, design_preview: 'static', revision: 'b'.repeat(40) }).tree_digest, site.tree_digest);
});

test('the engine\'s server answers the routes it lists and nothing else', async (t) => {
  const site = previewSite(tree, { targets, design_preview: 'static', revision: 'a'.repeat(40) });
  const dir = mkdtempSync(join(tmpdir(), 'preview-site-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, bytes] of site.files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { PATH: '/usr/bin:/bin', PORT: String(port) }, stdio: 'ignore' });
  // Ended through its own handle, once its command line reads back as the server this test started.
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let argv = [];
    try {
      argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
    } catch {
      return;
    }
    if (argv[0] === process.execPath && argv[1] === 'server.js') child.kill('SIGTERM');
  });
  for (let i = 0; i < 100 && (await get(port, '/')).status !== 200; i++) await new Promise((r) => setTimeout(r, 50));
  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  const web = await get(port, '/mockups/web/s1.html');
  assert.ok(web.bytes.equals(WEB), 'a native mockup: its bytes');
  const android = await get(port, '/mockups/android/s2.html');
  assert.equal(android.status, 200);
  assert.ok(!android.bytes.equals(ANDROID), 'a simulated mockup\'s path: never its bytes bare');
  assert.match(android.bytes.toString(), /Simulation of android/);
  const raw = await get(port, `${RAW_PREFIX}mockups/android/s2.html`);
  assert.ok(raw.bytes.equals(ANDROID));
  assert.equal(raw.headers['content-security-policy'], 'sandbox allow-scripts');
  assert.equal((await get(port, '/server.js')).status, 404, 'the server itself is not served');
  assert.equal((await get(port, '/routes.json')).status, 404);
  assert.equal((await get(port, '/mockups/../server.js')).status, 404);
  assert.equal((await get(port, '/%2e%2e/server.js')).status, 404);
  assert.equal((await get(port, '/', 'POST')).status, 405);
});

test('surety design: the requests it makes', () => {
  assert.deepEqual(parseDesignCommand(['preview', '--project', 'p1']), { method: 'POST', path: '/v1/projects/p1/design/preview', body: { revision: 'checkpoint' } });
  assert.deepEqual(parseDesignCommand(['preview', '--project', 'p1', '--revision', 'approved']), { method: 'POST', path: '/v1/projects/p1/design/preview', body: { revision: 'approved' } });
  assert.deepEqual(parseDesignCommand(['preview', '--stop', '--project', 'p1']), { method: 'DELETE', path: '/v1/projects/p1/design/preview', body: null });
  assert.deepEqual(parseDesignCommand(['assets', 'submit', '--project', 'p1']), { method: 'POST', path: '/v1/projects/p1/design/assets/submit', body: {} });
  assert.equal(typeof parseDesignCommand(['preview']), 'string');
  assert.equal(typeof parseDesignCommand(['preview', '--stop', '--revision', 'x', '--project', 'p']), 'string');
});
