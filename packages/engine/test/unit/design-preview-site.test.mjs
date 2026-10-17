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
const server = join(root, 'dist', 'design', 'preview', 'server.js');
const { siteMockups, bannerText, frameHtml, indexHtml, simulationsText, RAW_PREFIX } = await import(server);
const { previewServerPath } = await import(join(root, 'dist', 'design', 'preview', 'path.js'));
const { ustar, readUstar, writeEntries } = await import(join(root, 'dist', 'design', 'export.js'));
const { parseDesignCommand, parseDesignExport } = await import(join(root, 'dist', 'design', 'design-command.js'));

const WEB = Buffer.from('<!doctype html><title>S1</title><p>list</p>\n');
const ANDROID = Buffer.from('<!doctype html><title>S2</title><script>1</script>\n');
const DESIGN = {
  targets: [
    { target: 'web', preview_capability: 'native' },
    { target: 'android', preview_capability: 'simulated' },
  ],
  mockups: [
    { path: 'mockups/web/s1.html', kind: 'static_html', screens: ['S1'] },
    { path: 'mockups/android/s2.html', kind: 'simulated_html', screens: ['S2'], simulates: { target: 'android', form_factor: 'phone', layout: 'portrait' } },
    { path: 'mockups/android/s3.png', kind: 'image', screens: ['S3'] },
  ],
};
const SCREENS = { screens: [{ key: 'S1', target: 'web' }, { key: 'S2', target: 'android' }, { key: 'S3', target: 'android' }] };
const tree = new Map([
  ['design.json', Buffer.from(JSON.stringify(DESIGN))],
  ['screens.json', Buffer.from(JSON.stringify(SCREENS))],
  ['mockups/web/s1.html', WEB],
  ['mockups/android/s2.html', ANDROID],
  ['mockups/android/s3.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
]);

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

test('the mockups: target, capability, framed; the frame; the index; SIMULATIONS.txt', () => {
  const m = siteMockups(tree.get('design.json'), tree.get('screens.json'));
  assert.deepEqual(
    m.map((x) => [x.path, x.target, x.capability, x.framed]),
    [
      ['mockups/web/s1.html', 'web', 'native', false],
      ['mockups/android/s2.html', 'android', 'simulated', true],
      ['mockups/android/s3.png', 'android', 'simulated', false],
    ],
  );
  // An HTML mockup of a target that is not native is framed even when it does not say what it simulates.
  const undeclared = siteMockups(JSON.stringify({ ...DESIGN, mockups: [{ path: 'mockups/android/x.html', kind: 'static_html', screens: ['S2'] }] }), JSON.stringify(SCREENS));
  assert.deepEqual([undeclared[0].capability, undeclared[0].framed], ['simulated', true]);
  assert.deepEqual(siteMockups('not json', null), []);
  const frame = frameHtml(m[1]);
  assert.ok(frame.includes(bannerText({ target: 'android', form_factor: 'phone', layout: 'portrait' })));
  assert.match(frame, /<iframe src="\/__surety\/raw\/mockups\/android\/s2.html" sandbox="allow-scripts"/);
  assert.equal((frame.match(/<iframe/g) ?? []).length, 1);
  const index = indexHtml(m, null);
  assert.match(index, /data-path="mockups\/web\/s1.html" data-target="web" data-capability="native"/);
  assert.match(index, /data-path="mockups\/android\/s2.html" data-target="android" data-capability="simulated"/);
  const records = simulationsText(m)
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(records, ['mockups/android/s2.html\tandroid\tphone\tportrait']);
});

test('the export archive: ustar, a long path by pax, read back; written under a directory and never outside it', (t) => {
  const long = `mockups/${'a'.repeat(120)}.html`;
  const entries = new Map([...tree, [long, Buffer.from('x')], ['SIMULATIONS.txt', Buffer.from('# s\n')]]);
  const back = readUstar(ustar(entries));
  assert.deepEqual([...back.keys()], [...entries.keys()]);
  for (const [p, b] of entries) assert.ok(back.get(p).equals(b), p);
  const dir = mkdtempSync(join(tmpdir(), 'design-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeEntries(join(dir, 'out'), back);
  assert.ok(readFileSync(join(dir, 'out', 'mockups', 'web', 's1.html')).equals(WEB));
  assert.throws(() => writeEntries(join(dir, 'bad'), new Map([['../escape', Buffer.from('x')]])), /not a path under/);
  assert.throws(() => writeEntries(join(dir, 'bad'), new Map([['/etc/x', Buffer.from('x')]])), /not a path under/);
});

test('the engine\'s server, a file of its install, serves the design tree and nothing else', async (t) => {
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
  const child = spawn(process.execPath, [server], { cwd: dir, env: { PATH: '/usr/bin:/bin', PORT: String(port) }, stdio: 'ignore' });
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
  const android = await get(port, '/mockups/android/s2.html');
  assert.equal(android.status, 200);
  assert.ok(!android.bytes.equals(ANDROID), 'a simulated mockup\'s path: never its bytes bare');
  assert.match(android.bytes.toString(), /Simulation of android/);
  const raw = await get(port, `${RAW_PREFIX}mockups/android/s2.html`, 'GET', { 'sec-fetch-dest': 'iframe' });
  assert.ok(raw.bytes.equals(ANDROID));
  assert.equal(raw.headers['content-security-policy'], 'sandbox allow-scripts');
  const navigated = await get(port, `${RAW_PREFIX}mockups/android/s2.html`, 'GET', { 'sec-fetch-dest': 'document' });
  assert.match(navigated.bytes.toString(), /Simulation of android/, 'a top-level navigation to the raw path: the frame');
  assert.ok((await get(port, '/design.json')).bytes.equals(tree.get('design.json')));
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/mockups/..%2f..%2fsecret.txt', '/link.txt', '/mockups', '/nothing.html']) assert.equal((await get(port, p)).status, 404, p);
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
