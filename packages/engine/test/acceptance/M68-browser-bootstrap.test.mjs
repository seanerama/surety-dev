// M68, fresh-browser bootstrap (slice 6). Plan §3.7 M68 and §2 (resource B);
// RN R6; D1 §§11.1, 17(2), D1-29; Review B14; build spec §6 correction 7;
// E36 item 1; SEAM.md §90.
//
// Two real browsers, Chromium and Firefox, driven by Playwright. Each starts
// with an empty session and navigates to the shell the engine serves: no
// token is injected, no header is added, no request is intercepted. What the
// engine sees is what a browser sends.
//
// The shell is the acceptance harness's own page (harness/shell/), handed to
// the engine with --harness-shell: M1 has no UI. It asks for the token as RN
// R6 says a UI must, with a per-request `same-origin` referrer policy, while
// the page's own policy stays `no-referrer`. Asked for without that policy,
// the same page sends neither Origin nor Referer (Review B14's
// counterexample, here observed in both browsers), and the engine must refuse
// with text a person can act on and no token. A page of another origin gets
// nothing either.
//
// Each browser case prints the browser's version and what it put on the
// wire: that is the qualification evidence Review B14 asks for. A browser
// that cannot be launched fails its cases; nothing is skipped.
//
// K3 change (M2 slice 10, row M107 (b); D2 §2.6, K3, N05; E56 item 3, E58
// item 11; SEAM.md §115; COVERAGE.md "M2 slice 10"): the bootstrap route is
// off by default under D2, served only when the engine setting
// `ui_bootstrap` is true. This file is the labelled compatibility test: its
// engine opts in with `ui_bootstrap: true` and every assertion below is
// unchanged. The default-off case, with the token never read, is row M107
// (M107-bootstrap-off-by-default.test.mjs). With the exception on, any
// local uid can obtain the token (D2 §8 class C): this file claims no
// protection from other local users.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { assertDefensiveHeaders, assertNoCors, requestHead, selfOrigin, sendRaw } from './harness/boundary.mjs';
import { FAMILIES, browserOf, closeBrowsers, exchangeOf, freshPage, otherOriginServer, requestsTo, shellDirectory } from './harness/browser.mjs';
import { engineFixture, isRefusalBody, makeTempDir, removeDir } from './harness/engine.mjs';
import { assertRefused, auditEvents, maxEventSeq, projectFixture } from './harness/fixtures.mjs';
import { sharedFixture } from './harness/gates.mjs';
import { withStore } from './harness/store.mjs';

after(() => closeBrowsers());

const pausedFlag = (home, project) => withStore(home, (db) => db.prepare('SELECT "paused" FROM "projects" WHERE "id" = ?').get(project).paused);
const anyEventContains = (home, needle) => withStore(home, (db) => db.prepare('SELECT * FROM "events"').all().some((row) => JSON.stringify(row).includes(needle)));
const wire = (headers) => Object.fromEntries(['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode'].map((name) => [name, headers[name] ?? null]));

describe('M68 the two browser lanes', () => {
  for (const family of FAMILIES) {
    test(`${family} launches, reports its version, and reaches the engine: a navigation to an API route carries no token and is refused`, async (t) => {
      const { engine } = await engineFixture(t);
      const browser = await browserOf(family);
      const version = browser.version();
      assert.match(version, /^\d+\./, `${family} reports a version (${version})`);
      t.diagnostic(`M68 browser lane: ${family} ${version}`);
      const { page } = await freshPage(t, family);
      const response = await page.goto(`${selfOrigin(engine)}/v1/health`);
      // The exception for the shell does not extend to an API read (Review B14).
      assert.ok([401, 403].includes(response.status()), `a bare navigation to /v1/health is refused (status ${response.status()})`);
      const body = JSON.parse(await response.text());
      assert.ok(isRefusalBody(body) && ['token_required', 'origin_refused'].includes(body.code), `with the engine's refusal: ${JSON.stringify(body)}`);
    });
  }
});

describe('M68 fresh-browser bootstrap', () => {
  const shared = sharedFixture();
  const ctx = {};

  // One engine for the cases below, started with the shell the first time a
  // case asks for it. A case that cannot have it fails with the reason. It
  // opts in to the bootstrap route (K3): the compatibility test's engine.
  let built = null;
  const fixture = () =>
    (built ??= (async () => {
      const root = makeTempDir('shell');
      shared.context.after(() => removeDir(root));
      mkdirSync(join(root, 'shell'));
      ctx.shell = shellDirectory(join(root, 'shell'));
      Object.assign(ctx, await projectFixture(shared.context, { args: ['--harness-shell', ctx.shell.dir], config: { ui_bootstrap: true } }));
      ctx.origin = selfOrigin(ctx.engine);
      return ctx;
    })());

  after(() => shared.cleanup());

  // A page that has just loaded the shell from the engine, in an empty session.
  async function loadShell(t, family) {
    const loaded = await freshPage(t, family);
    const response = await loaded.page.goto(`${ctx.origin}/`);
    assert.equal(response.status(), 200, `${family}: the first navigation, with no token and no history, loads the shell`);
    await loaded.page.waitForSelector('html[data-shell="ready"]', { state: 'attached', timeout: 15_000 });
    return { ...loaded, navigation: response };
  }

  test('the shell and its asset are served without a token, byte for byte, under the no-referrer policy and a restrictive content security policy; they hold no token and no project state, and nothing else is served without a token', async () => {
    const { engine, project, shell } = await fixture();
    for (const [route, expected] of Object.entries(shell.files)) {
      const res = await engine.get(route, { token: null });
      assert.equal(res.status, 200, `GET ${route} without a token (body: ${res.text.slice(0, 200)})`);
      assert.match(res.headers['content-type'] ?? '', expected.type, `GET ${route}: content type`);
      assert.ok(Buffer.from(res.text, 'utf8').equals(expected.bytes), `GET ${route}: the engine serves the shell's file exactly as it is, with nothing put into it`);
      assertDefensiveHeaders(res, `GET ${route}`);
      assert.equal(res.headers['set-cookie'], undefined, `GET ${route}: no cookie is set`);
      for (const secret of [engine.token(), project]) {
        assert.equal(JSON.stringify(res.headers).includes(secret) || res.text.includes(secret), false, `GET ${route}: neither the token nor a project's identity is in the response`);
      }
    }
    const csp = (await engine.get('/', { token: null })).headers['content-security-policy'];
    assert.ok(typeof csp === 'string' && csp.length > 0, 'the shell document carries a Content-Security-Policy');
    assert.match(csp, /(^|;)\s*default-src\s+'(none|self)'\s*(;|$)/, `its default is 'none' or 'self' (${csp})`);
    assert.match(csp, /(^|;)\s*frame-ancestors\s+'none'\s*(;|$)/, `it forbids framing (${csp})`);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|\bdata:|\bhttps?:/, `it allows no inline script, no eval and no other origin (${csp})`);

    // The exception is for the enumerated shell routes only.
    assertRefused(await engine.get('/v1/engine', { token: null }), 401, 'token_required', 'an API read without a token');
    assertRefused(await engine.get('/assets/not-a-shell-file.js', { token: null }), 401, 'token_required', 'a path under /assets/ that is not a file of the shell');
    assertRefused(await engine.get('/', { token: null, host: 'evil.example' }), 400, 'host_refused', 'the shell under a foreign Host');
  });

  for (const family of FAMILIES) {
    test(`${family}: a fresh session loads the shell, obtains the token with the per-request policy, and reads and mutates with it; the token is in no URL and no browser storage`, async (t) => {
      const { engine, home, project, origin } = await fixture();
      const token = engine.token();
      const version = (await browserOf(family)).version();
      const { page, context, requests } = await loadShell(t, family);
      assert.equal(await page.getAttribute('html', 'data-inline'), null, "the shell's inline script did not run: the content security policy is enforced by the browser");

      const boot = await page.evaluate(() => window.shell.bootstrap({ referrerPolicy: 'same-origin' }));
      assert.deepEqual([boot.ok, boot.status], [true, 200], `the engine issues the token to its own page (the page shows: ${boot.shown})`);
      const [bootRequest] = requestsTo(requests, origin, '/v1/token/bootstrap');
      const sentBoot = await exchangeOf(bootRequest);
      t.diagnostic(`M68 ${family} ${version}: bootstrap with referrerPolicy same-origin sent ${JSON.stringify(wire(sentBoot.headers))}`);
      assert.equal(sentBoot.headers['sec-fetch-site'], 'same-origin', 'the browser itself said the request is same-origin');
      assert.equal(new URL(sentBoot.headers.referer).origin, origin, 'and sent a Referer of the engine\'s own origin');
      assert.equal(sentBoot.headers['x-surety-token'], undefined, 'the bootstrap request carried no token');
      assert.match(sentBoot.responseHeaders['cache-control'] ?? '', /no-store/, 'the answer that holds the token is not to be stored');
      assertNoCors({ headers: sentBoot.responseHeaders }, 'the bootstrap answer');

      // An authenticated read and an authenticated mutation, from the page.
      const read = await page.evaluate(() => window.shell.read('/v1/engine'));
      assert.equal(read.status, 200, `the page reads with its token (${JSON.stringify(read).slice(0, 300)})`);
      assert.equal(read.body?.incarnation, (await engine.engineInfo()).incarnation, 'and is answered by this engine');
      const seq = maxEventSeq(home);
      const path = `/v1/projects/${project}/pause`;
      const mutation = await page.evaluate((target) => window.shell.mutate(target, {}), path);
      assert.equal(mutation.status, 200, `the page mutates with its token (${JSON.stringify(mutation).slice(0, 300)})`);
      assert.equal(pausedFlag(home, project), 1, 'the mutation was carried out');
      const audits = auditEvents(home, seq, 'POST', path);
      assert.deepEqual(audits.map((event) => [event.request_id, JSON.parse(event.payload).status]), [[mutation.requestId, 200]], 'and audited under the request id the page was given');
      const sentMutation = await exchangeOf(requestsTo(requests, origin, path).at(-1));
      t.diagnostic(`M68 ${family} ${version}: authenticated POST sent ${JSON.stringify(wire(sentMutation.headers))}`);
      const undo = await page.evaluate((target) => window.shell.mutate(target, {}), `/v1/projects/${project}/resume`);
      assert.equal(undo.status, 200);

      // The token went from the engine to the page's memory and back in a header. Nowhere else.
      assert.equal(requests.some((request) => request.url().includes(token)) || page.url().includes(token), false, 'no URL the page requested holds the token');
      const state = await context.storageState();
      assert.deepEqual(state.cookies, [], 'the session has no cookie');
      assert.equal(JSON.stringify(state).includes(token), false, 'the token is not in local storage');
      const kept = await page.evaluate(async () => ({
        local: Object.keys(localStorage).length,
        session: Object.keys(sessionStorage).length,
        databases: (await indexedDB.databases()).length,
        text: document.documentElement.outerHTML,
      }));
      assert.deepEqual([kept.local, kept.session, kept.databases], [0, 0, 0], 'the page stored nothing: no localStorage, no sessionStorage, no IndexedDB');
      assert.equal(kept.text.includes(token), false, 'the token is not written into the document');
      assert.equal(anyEventContains(home, token), false, 'and it is in no event the engine recorded');
    });
  }

  for (const family of FAMILIES) {
    test(`${family}: without the per-request policy the page's own request carries no origin evidence and is refused with text a person can act on; a page of another origin is refused too; neither is given the token`, async (t) => {
      const { engine, origin } = await fixture();
      const token = engine.token();
      const version = (await browserOf(family)).version();

      // The same page, asking as a page under `no-referrer` asks by default.
      const { page, requests } = await loadShell(t, family);
      const boot = await page.evaluate(() => window.shell.bootstrap());
      const sent = await exchangeOf(requestsTo(requests, origin, '/v1/token/bootstrap').at(-1));
      t.diagnostic(`M68 ${family} ${version}: bootstrap with the page's default policy sent ${JSON.stringify(wire(sent.headers))}`);
      assert.deepEqual([sent.headers.origin, sent.headers.referer], [undefined, undefined], 'the fixture is live: this browser sends neither Origin nor Referer on that request');
      assert.deepEqual([boot.ok, boot.status, boot.code], [false, 403, 'origin_refused'], `the engine refuses for want of evidence (the page shows: ${boot.shown})`);
      const shown = await page.textContent('#message');
      assert.equal(shown, boot.shown, 'the page shows the refusal');
      const refusal = JSON.parse(sent.text);
      assert.ok(isRefusalBody(refusal), `the refusal says what to do: ${sent.text}`);
      assert.ok(shown.includes(refusal.what_to_do), 'and that text is what the person sees');
      assert.equal(sent.text.includes(token) || shown.includes(token), false, 'the refusal holds no token');
      assert.equal(await page.evaluate(() => window.shell.hasToken()), false, 'the page holds no token');
      const without = await page.evaluate(() => window.shell.read('/v1/engine'));
      assert.equal(without.status, null, 'and so cannot act');

      // A page of another origin, asking in the two ways a page can.
      const other = await otherOriginServer(t);
      const hostile = await freshPage(t, family);
      await hostile.page.goto(`${other.origin}/?target=${encodeURIComponent(origin)}`);
      await hostile.page.waitForSelector('html[data-done="yes"]', { state: 'attached', timeout: 15_000 });
      const reported = await hostile.page.textContent('#out');
      t.diagnostic(`M68 ${family} ${version}: a page of another origin could read ${reported}`);
      assert.equal(reported.includes(token), false, 'the page of another origin read no token');
      const attempts = requestsTo(hostile.requests, origin, '/v1/token/bootstrap');
      assert.equal(attempts.length, 2, 'the fixture is live: that page sent both of its requests to the engine');
      const statuses = [];
      for (const request of attempts) {
        const seen = await exchangeOf(request);
        if (seen.status === null) continue; // the browser kept the answer from its driver as it kept it from the page
        statuses.push(seen.status);
        assert.equal(seen.status, 403, `the engine refuses a bootstrap request from another origin (it sent ${JSON.stringify(wire(seen.headers))})`);
        assert.equal((seen.text ?? '').includes(token), false, 'its answer holds no token');
        assertNoCors({ headers: seen.responseHeaders }, 'the refusal of another origin');
      }
      assert.ok(statuses.length >= 1, 'at least one of those answers was observed');
    });
  }

  test('over plain HTTP, the bootstrap yields the token only on positive same-origin evidence: missing, foreign and contradictory signals are all refused without it', async () => {
    const { engine, origin, port } = await fixture();
    const token = engine.token();
    const ask = (headers, opts = {}) => engine.get('/v1/token/bootstrap', { token: null, headers, ...opts });
    const evil = 'http://evil.example';

    const refused = [
      ['no evidence at all (a client that is not a browser page)', {}],
      ['fetch metadata, and neither Origin nor Referer', { 'sec-fetch-site': 'same-origin' }],
      ['a Referer of the engine and no fetch metadata', { referer: `${origin}/` }],
      ['an Origin of the engine and no fetch metadata', { origin }],
      ['same-site fetch metadata', { 'sec-fetch-site': 'same-site', referer: `${origin}/` }],
      ['cross-site fetch metadata with an Origin of the engine', { 'sec-fetch-site': 'cross-site', origin }],
      ['a foreign Referer', { 'sec-fetch-site': 'same-origin', referer: `${evil}/` }],
      ['a foreign Origin', { 'sec-fetch-site': 'same-origin', origin: evil }],
      ['Origin: null', { 'sec-fetch-site': 'same-origin', origin: 'null' }],
      ['an Origin of the engine and a foreign Referer', { 'sec-fetch-site': 'same-origin', origin, referer: `${evil}/` }],
      ['a Referer on another port', { 'sec-fetch-site': 'same-origin', referer: `http://127.0.0.1:${port + 1}/` }],
      ['a Referer under another scheme', { 'sec-fetch-site': 'same-origin', referer: `https://127.0.0.1:${port}/` }],
      ['a Referer that is not a URL', { 'sec-fetch-site': 'same-origin', referer: 'not a url' }],
    ];
    for (const [what, headers] of refused) {
      const res = await ask(headers);
      assertRefused(res, 403, 'origin_refused', `bootstrap with ${what}`);
      assert.equal(res.text.includes(token) || JSON.stringify(res.headers).includes(token), false, `bootstrap with ${what}: no token in the refusal`);
      assertNoCors(res, `bootstrap with ${what}`);
    }

    // Host and target are checked first, whatever the evidence.
    const good = { 'sec-fetch-site': 'same-origin', referer: `${origin}/` };
    const foreignHost = await ask(good, { host: 'evil.example' });
    assertRefused(foreignHost, 400, 'host_refused', 'bootstrap under a foreign Host');
    assert.equal(foreignHost.text.includes(token), false);
    const foreignTarget = await sendRaw(engine, requestHead(engine, 'GET', `http://evil.example:${port}/v1/token/bootstrap`, { 'Sec-Fetch-Site': 'same-origin', Referer: `${origin}/` }, { token: null }));
    assertRefused(foreignTarget, 400, 'host_refused', 'bootstrap with a foreign absolute-form authority');
    assert.equal(foreignTarget.text.includes(token), false);

    // The positive form, with either header.
    for (const headers of [good, { 'sec-fetch-site': 'same-origin', origin }]) {
      const res = await ask(headers);
      assert.equal(res.status, 200, `bootstrap with ${JSON.stringify(headers)} (body: ${res.text})`);
      assert.deepEqual(res.body, { token }, 'the answer is the token and nothing else');
      assert.match(res.headers['cache-control'] ?? '', /no-store/);
      assertNoCors(res, 'the bootstrap answer');
    }
    // That evidence authorizes the bootstrap and nothing else.
    assertRefused(await engine.get('/v1/engine', { token: null, headers: good }), 401, 'token_required', 'an API read with same-origin evidence and no token');
  });
});
