// The client side of the acceptance test shell (row M68; SEAM.md §90). It
// does what a UI does to obtain the API token and act, and nothing else:
//
//   - bootstrap: GET /v1/token/bootstrap with the per-request referrer policy
//     the caller names (RN R6: `same-origin`), or with none, in which case the
//     page's own `no-referrer` policy applies and the request carries no
//     evidence of where it comes from;
//   - read and mutate: same-origin requests that carry the token in the
//     X-Surety-Token header.
//
// The token is held in a variable of this closure and nowhere else: not in a
// URL, not in a cookie, not in localStorage, sessionStorage or IndexedDB, and
// it is never returned to whoever calls these functions. The page reports
// what happened in #status and #message, as a UI would show it to a person.
(() => {
  'use strict';
  let token = null;

  const show = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };

  async function parse(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async function bootstrap(options) {
    const init = { method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' };
    if (options && options.referrerPolicy !== undefined) init.referrerPolicy = options.referrerPolicy;
    let res;
    try {
      res = await fetch('/v1/token/bootstrap', init);
    } catch (err) {
      const shown = `The token could not be requested: ${String(err)}`;
      show('message', shown);
      return { ok: false, status: null, code: null, shown };
    }
    const body = await parse(res);
    if (res.status === 200 && body !== null && typeof body.token === 'string' && body.token !== '') {
      token = body.token;
      show('message', 'The engine issued its token to this page.');
      return { ok: true, status: 200, code: null, shown: 'The engine issued its token to this page.' };
    }
    const shown =
      body !== null && typeof body.code === 'string'
        ? `${body.code}: ${body.reason} ${body.what_to_do}`
        : `The engine answered ${res.status} and gave no token.`;
    show('message', shown);
    return { ok: false, status: res.status, code: body === null ? null : (body.code ?? null), shown };
  }

  async function call(method, path, body) {
    if (token === null) return { status: null, body: null, requestId: null, error: 'this page holds no token' };
    const init = { method, cache: 'no-store', redirect: 'error', credentials: 'omit', headers: { 'X-Surety-Token': token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      return { status: null, body: null, requestId: null, error: String(err) };
    }
    return { status: res.status, body: await parse(res), requestId: res.headers.get('x-surety-request-id'), error: null };
  }

  window.shell = {
    bootstrap,
    read: (path) => call('GET', path),
    mutate: (path, body) => call('POST', path, body === undefined ? {} : body),
    hasToken: () => token !== null,
  };
  document.documentElement.setAttribute('data-shell', 'ready');
  show('status', 'ready');
})();
