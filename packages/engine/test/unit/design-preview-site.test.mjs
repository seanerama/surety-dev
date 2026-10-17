// Developer tests for the design preview's server and export (D7 §5.7;
// SEAM.md §§499 to 501): the mockups with their target, capability and
// whether they are framed; the frame (the banner, one iframe sandboxed
// `allow-scripts`, its src the raw path); SIMULATIONS.txt; the ustar archive
// written and read back; and the engine's server, a file of the engine's
// install, run here as this test's child in a directory holding only a
// design tree, on 127.0.0.1, and ended by its own handle: the index, a
// native mockup's bytes, a simulated mockup's path answering the frame,
// nothing outside the tree, nothing but GET and HEAD. Nothing it serves is
// run.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = join(root, 'dist', 'design', 'preview', 'server.mjs');
const { bannerText, frameHtml, indexHtml, servedMockups, RAW_PREFIX, MOCKUPS_VARIABLE } = await import(server);
const { engineMockups, servedTable, simulationsText } = await import(join(root, 'dist', 'design', 'preview-mockups.js'));
const { previewServerPath } = await import(join(root, 'dist', 'design', 'preview', 'path.js'));
const { ustar, readUstar, writeEntries } = await import(join(root, 'dist', 'design', 'export.js'));
const { parseDesignCommand, parseDesignExport } = await import(join(root, 'dist', 'design', 'design-command.js'));

const WEB = Buffer.from('<!doctype html><title>S1</title><p>list</p>\n');
const ANDROID = Buffer.from('<!doctype html><title>S2</title><script>1</script>\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n');
const DESIGN = {
  // What the Designer declares is never what the engine serves by: android here claims native.
  targets: [
    { target: 'web', preview_capability: 'native' },
    { target: 'android', preview_capability: 'native' },
  ],
  mockups: [
    { path: 'mockups/web/s1.html', kind: 'static_html', screens: ['S1'] },
    { path: 'mockups/./android/s2.html', kind: 'simulated_html', screens: ['S2'], simulates: { target: 'android', form_factor: 'phone', layout: 'portrait' } },
    { path: 'mockups/android/s3.html', kind: 'static_html', screens: ['S3'] },
    { path: 'mockups/android/s4.svg', kind: 'image', screens: ['S3'] },
    { path: 'mockups/tv/s5.html', kind: 'static_html', screens: ['S5'] },
    { path: '../outside.html', kind: 'static_html', screens: ['S1'] },
  ],
};
const SCREENS = { screens: [{ key: 'S1', target: 'web' }, { key: 'S2', target: 'android' }, { key: 'S3', target: 'android' }, { key: 'S5', target: 'tv' }] };
const tree = new Map([
  ['design.json', Buffer.from(JSON.stringify(DESIGN))],
  ['screens.json', Buffer.from(JSON.stringify(SCREENS))],
  ['mockups/web/s1.html', WEB],
  ['mockups/web/other.html', WEB],
  ['mockups/android/s2.html', ANDROID],
  ['mockups/android/s3.html', ANDROID],
  ['mockups/android/s4.svg', SVG],
  ['mockups/tv/s5.html', WEB],
]);
const FACTS = { targets: [{ target: 'web', technology: 'html_css' }, { target: 'android', technology: 'react_native' }], design_preview: 'static' };

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const get = (port, path, method = 'GET', headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.code }));
    req.end();
  });

test('the engine\'s table: capability from the engine\'s facts, never the Designer\'s; paths normalised; unknown recorded as unknown', () => {
  const t = engineMockups(tree, FACTS);
  const row = (p) => t.mockups.find((m) => m.path === p);
  assert.deepEqual([row('mockups/web/s1.html').target, row('mockups/web/s1.html').capability, row('mockups/web/s1.html').simulates], ['web', 'native', null]);
  assert.deepEqual([row('mockups/android/s2.html').capability, row('mockups/android/s2.html').simulates], ['simulated', { target: 'android', form_factor: 'phone', layout: 'portrait' }], 'normalised, simulated');
  assert.equal(row('mockups/android/s3.html').capability, 'simulated', 'android claims native in design.json: simulated by the engine');
  assert.equal(row('mockups/android/s4.svg').simulates, null);
  assert.deepEqual(row('mockups/tv/s5.html').target, { unknown: 'tv is not a UI target of the approved module map' });
  assert.ok('unknown' in row('mockups/tv/s5.html').capability);
  assert.equal(row('../outside.html'), undefined, 'a path out of the tree is left out');
  assert.deepEqual(engineMockups(new Map(), FACTS), { mockups: [], unread: { unknown: 'design.json is missing or does not parse: no mockup could be read' } });
  const records = simulationsText(t).split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(records.map((r) => r.split('\t')[0]), ['mockups/android/s2.html', 'mockups/android/s3.html', 'mockups/tv/s5.html']);
  const served = servedMockups(servedTable(t)[MOCKUPS_VARIABLE]);
  assert.equal(served.mockups.find((m) => m.path === 'mockups/tv/s5.html').capability, null);
  assert.deepEqual(servedMockups('not json').mockups, []);
  const frame = frameHtml('mockups/android/s2.html', { target: 'android', form_factor: 'phone', layout: 'portrait' });
  assert.ok(frame.includes(bannerText({ target: 'android', form_factor: 'phone', layout: 'portrait' })));
  assert.match(frame, /<iframe src="\/__surety\/raw\/mockups\/android\/s2.html" sandbox="allow-scripts"/);
  assert.equal((frame.match(/<iframe/g) ?? []).length, 1);
  assert.match(indexHtml(served.mockups, null), /data-path="mockups\/web\/s1.html" data-target="web" data-capability="native"/);
});

test('the export archive: ustar, a long path by pax, read back; a malformed archive refused; written only into a new or empty directory', (t) => {
  const long = `mockups/${'a'.repeat(120)}.html`;
  const entries = new Map([...tree, [long, Buffer.from('x')], ['SIMULATIONS.txt', Buffer.from('# s\n')]]);
  const archive = ustar(entries);
  const back = readUstar(archive);
  assert.deepEqual([...back.keys()], [...entries.keys()]);
  for (const [p, b] of entries) assert.ok(back.get(p).equals(b), p);
  assert.throws(() => readUstar(archive.subarray(0, archive.length - 1024)), /two zero blocks/);
  assert.throws(() => readUstar(archive.subarray(0, 1024)), /past the archive's end|two zero blocks/);
  const bad = Buffer.from(archive);
  bad[0] ^= 1;
  assert.throws(() => readUstar(bad), /checksum/);
  const dir = mkdtempSync(join(tmpdir(), 'design-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeEntries(join(dir, 'out'), back);
  assert.ok(readFileSync(join(dir, 'out', 'mockups', 'web', 's1.html')).equals(WEB));
  assert.throws(() => writeEntries(join(dir, 'out'), new Map([['a.txt', Buffer.from('x')]])), /not empty/);
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  assert.throws(() => writeEntries(join(dir, 'link'), new Map([['a.txt', Buffer.from('x')]])), /symbolic link/);
  assert.throws(() => writeEntries(join(dir, 'bad'), new Map([['../escape', Buffer.from('x')]])), /not a path under/);
  assert.throws(() => writeEntries(join(dir, 'bad2'), new Map([['/etc/x', Buffer.from('x')]])), /not a path under/);
});

test('the engine\'s server, a file of its install, frames every HTML path the engine did not list as native', async (t) => {
  assert.equal(previewServerPath(), server, 'the server is the install\'s file');
  const base = mkdtempSync(join(tmpdir(), 'preview-site-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'tree');
  for (const [path, bytes] of tree) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  writeFileSync(join(base, 'secret.txt'), 'outside');
  symlinkSync(join(base, 'secret.txt'), join(dir, 'link.txt'));
  const port = await freePort();
  const env = { PATH: '/usr/bin:/bin', PORT: String(port), ...servedTable(engineMockups(tree, FACTS)) };
  const child = spawn(process.execPath, [server], { cwd: dir, env, stdio: 'ignore' });
  // Ended through its own handle, once its command line reads back as the server this test started.
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let argv = [];
    try {
      argv = readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
    } catch {
      return;
    }
    if (argv[0] === process.execPath && argv[1] === server) child.kill('SIGTERM');
  });
  for (let i = 0; i < 100 && (await get(port, '/')).status !== 200; i++) await new Promise((r) => setTimeout(r, 50));
  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.bytes.toString(), /data-capability="simulated"/);
  const web = await get(port, '/mockups/web/s1.html');
  assert.ok(web.bytes.equals(WEB), 'a native mockup: its bytes');
  for (const p of ['/mockups/android/s2.html', '/mockups/android/s3.html', '/mockups/tv/s5.html', '/mockups/web/other.html']) {
    const r = await get(port, p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.bytes.equals(ANDROID) && !r.bytes.equals(WEB), `${p}: never its bytes bare`);
    assert.match(r.bytes.toString(), /id="surety-simulation-banner"/, `${p}: the frame`);
  }
  const raw = await get(port, `${RAW_PREFIX}mockups/android/s2.html`, 'GET', { 'sec-fetch-dest': 'iframe' });
  assert.ok(raw.bytes.equals(ANDROID));
  assert.equal(raw.headers['content-security-policy'], 'sandbox allow-scripts');
  assert.equal(raw.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(raw.headers['access-control-allow-origin'], 'null');
  for (const h of [{ 'sec-fetch-dest': 'document' }, {}]) assert.match((await get(port, `${RAW_PREFIX}mockups/android/s2.html`, 'GET', h)).bytes.toString(), /Simulation of android/, `the raw path to ${JSON.stringify(h)}: the frame`);
  const svg = await get(port, '/mockups/android/s4.svg');
  assert.ok(svg.bytes.equals(SVG));
  assert.equal(svg.headers['content-security-policy'], 'sandbox');
  assert.ok((await get(port, '/design.json')).bytes.equals(tree.get('design.json')));
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/mockups/..%2f..%2fsecret.txt', '/link.txt', '/mockups', '/nothing.html', '/mockups/./web/s1.html']) assert.equal((await get(port, p)).status, 404, p);
  assert.equal((await get(port, '/%E0%A4%A')).status, 400);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await get(port, '/design.json', m)).status, 405, m);
  assert.equal((await get(port, '/', 'HEAD')).status, 200);
});

test('surety design: the requests it makes', () => {
  assert.deepEqual(parseDesignCommand(['preview', '--project', 'p1']), { method: 'POST', path: '/v1/projects/p1/design/preview', body: { revision: 'checkpoint' } });
  assert.deepEqual(parseDesignCommand(['preview', '--project', 'p1', '--revision', 'approved']), { method: 'POST', path: '/v1/projects/p1/design/preview', body: { revision: 'approved' } });
  assert.deepEqual(parseDesignCommand(['preview', '--stop', '--project', 'p1']), { method: 'DELETE', path: '/v1/projects/p1/design/preview', body: null });
  assert.deepEqual(parseDesignCommand(['assets', 'submit', '--project', 'p1']), { method: 'POST', path: '/v1/projects/p1/design/assets/submit', body: {} });
  assert.equal(typeof parseDesignCommand(['preview']), 'string');
  assert.equal(typeof parseDesignCommand(['preview', '--stop', '--revision', 'x', '--project', 'p']), 'string');
  assert.deepEqual(parseDesignExport(['--project', 'p1', '--revision', 'approved', '/tmp/x']), { project: 'p1', revision: 'approved', dir: '/tmp/x' });
  assert.deepEqual(parseDesignExport(['--project', 'p1', 'out']), { project: 'p1', revision: 'checkpoint', dir: 'out' });
  assert.equal(typeof parseDesignExport(['--project', 'p1']), 'string');
  assert.equal(typeof parseDesignExport(['out']), 'string');
});
