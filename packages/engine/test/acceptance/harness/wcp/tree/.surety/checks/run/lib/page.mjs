// The child process of a UI check: loads public/index.html into the check DOM,
// runs the page's scripts (public/js/app.mjs and what it imports) as the
// browser would, then runs one session of a scenario against it and prints a
// report line that the parent check judges.
//
//   node page.mjs <scenario module> <criterion> <session index>
//   env CP_NONCE    report marker
//       CP_STORAGE  JSON object: localStorage contents at page open
//       CP_CARRY    JSON value handed over from the previous session

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import vm from 'node:vm';
import * as D from './dom.mjs';
import { StyleEngine } from './css.mjs';
import { makeUI } from './ui.mjs';

const [scenarioFile, criterion, sessionArg] = process.argv.slice(2);
const nonce = process.env.CP_NONCE || '';
const root = process.cwd();
const publicDir = path.join(root, 'public');
const publicURL = pathToFileURL(publicDir + path.sep).href;
register(new URL('./hooks.mjs', import.meta.url).href, { data: { publicURL } });

const report = { nonce, criterion, session: Number(sessionArg), assertions: [], pageErrors: [], consoleErrors: [], notes: [], done: false, storage: null, carry: null };
const realConsoleError = console.error.bind(console);
let emitted = false;
function emit() {
  if (emitted) return;
  emitted = true;
  fs.writeSync(1, `\n${nonce}${JSON.stringify(report)}\n`);
}

// ---------------------------------------------------------------- storage

class Storage {
  constructor(init = {}) { Object.defineProperty(this, '_data', { value: new Map(Object.entries(init)), enumerable: false }); }
  get length() { return this._data.size; }
  key(i) { return [...this._data.keys()][i] ?? null; }
  getItem(k) { k = String(k); return this._data.has(k) ? this._data.get(k) : null; }
  setItem(k, v) { this._data.set(String(k), String(v)); }
  removeItem(k) { this._data.delete(String(k)); }
  clear() { this._data.clear(); }
  _dump() { return Object.fromEntries(this._data); }
}
function storageProxy(s) {
  return new Proxy(s, {
    get(t, p) { if (typeof p === 'string' && !(p in t)) return t.getItem(p) ?? undefined; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
    set(t, p, v) { t.setItem(p, v); return true; },
    deleteProperty(t, p) { t.removeItem(p); return true; },
    has(t, p) { return p in t || t._data.has(p); },
    ownKeys(t) { return [...t._data.keys()]; },
    getOwnPropertyDescriptor(t, p) { return t._data.has(p) ? { value: t._data.get(p), enumerable: true, configurable: true } : undefined; },
  });
}

// ---------------------------------------------------------------- window

const storageInit = JSON.parse(process.env.CP_STORAGE || '{}');
const local = new Storage(storageInit);
const calls = { confirm: [], alert: [], prompt: [], print: 0, reload: 0, open: [] };
const answers = { confirm: [], prompt: [] };
const winTarget = new D.EventTarget();
winTarget._handlerHost = () => globalThis;
const rafQueue = new Map();
let rafId = 0;

function errorText(e) { return e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : String(e); }
function pageError(e) {
  report.pageErrors.push(errorText(e));
  try { winTarget.dispatchEvent(Object.assign(new D.Event('error'), { error: e, message: String(e && e.message || e) })); } catch {}
}
D.setErrorReporter(pageError);
process.on('uncaughtException', pageError);
process.on('unhandledRejection', pageError);

const location = {
  href: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080', protocol: 'http:', host: '127.0.0.1:8080', hostname: '127.0.0.1', port: '8080', pathname: '/', search: '', hash: '',
  reload() { calls.reload++; }, assign(u) { calls.open.push(String(u)); }, replace(u) { calls.open.push(String(u)); }, toString() { return this.href; },
};
const selection = { removeAllRanges() {}, addRange() {}, toString() { return ''; }, rangeCount: 0, getRangeAt() { return null; } };

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}

let doc = null;
function installGlobals() {
  const classes = ['Event', 'CustomEvent', 'UIEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'SubmitEvent', 'EventTarget', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment', 'CharacterData', 'DocumentFragment', 'Document', 'NodeFilter',
    'HTMLDivElement', 'HTMLSpanElement', 'HTMLParagraphElement', 'HTMLHeadingElement', 'HTMLUListElement', 'HTMLOListElement', 'HTMLLIElement', 'HTMLTableElement', 'HTMLTableRowElement', 'HTMLTableCellElement', 'HTMLTableSectionElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLScriptElement', 'HTMLStyleElement', 'HTMLLinkElement', 'HTMLBodyElement', 'HTMLHtmlElement', 'HTMLHeadElement', 'HTMLFieldSetElement', 'HTMLLegendElement', 'HTMLOutputElement', 'HTMLCanvasElement', 'HTMLDialogElement', 'HTMLTemplateElement', 'HTMLLabelElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLOptionElement', 'HTMLOptGroupElement', 'HTMLSelectElement', 'HTMLFormElement'];
  for (const c of classes) define(c, D[c]);
  define('ErrorEvent', D.Event);
  define('window', globalThis);
  define('self', globalThis);
  define('globalThis', globalThis);
  define('top', globalThis);
  define('parent', globalThis);
  define('frames', globalThis);
  define('_target', winTarget);
  define('document', doc);
  define('localStorage', storageProxy(local));
  define('sessionStorage', storageProxy(new Storage()));
  define('location', location);
  define('history', { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} });
  define('navigator', { userAgent: 'Mozilla/5.0 (check DOM)', language: 'en-GB', languages: ['en-GB', 'en'], onLine: true, platform: 'Linux', cookieEnabled: true, clipboard: { writeText: async () => {} }, storage: { persist: async () => false, estimate: async () => ({}) } });
  define('screen', { width: 1280, height: 800, availWidth: 1280, availHeight: 800 });
  define('innerWidth', 1280); define('innerHeight', 800); define('outerWidth', 1280); define('outerHeight', 800);
  define('devicePixelRatio', 1); define('scrollX', 0); define('scrollY', 0); define('pageXOffset', 0); define('pageYOffset', 0);
  define('name', '');
  define('closed', false);
  define('isSecureContext', true);
  define('origin', location.origin);
  define('addEventListener', (t, f, o) => winTarget.addEventListener(t, f, o));
  define('removeEventListener', (t, f, o) => winTarget.removeEventListener(t, f, o));
  define('dispatchEvent', (e) => winTarget.dispatchEvent(e));
  define('confirm', (m) => { calls.confirm.push(String(m ?? '')); return answers.confirm.length ? answers.confirm.shift() : true; });
  define('alert', (m) => { calls.alert.push(String(m ?? '')); });
  define('prompt', (m, d) => { calls.prompt.push(String(m ?? '')); return answers.prompt.length ? answers.prompt.shift() : null; });
  define('print', () => { calls.print++; winTarget.dispatchEvent(new D.Event('beforeprint')); winTarget.dispatchEvent(new D.Event('afterprint')); });
  define('open', (u) => { calls.open.push(String(u)); return null; });
  define('close', () => {});
  define('focus', () => {});
  define('blur', () => {});
  define('scrollTo', () => {}); define('scrollBy', () => {}); define('scroll', () => {});
  define('getSelection', () => selection);
  define('requestAnimationFrame', (fn) => { const id = ++rafId; rafQueue.set(id, setTimeout(() => { rafQueue.delete(id); try { fn(performance.now()); } catch (e) { pageError(e); } }, 16)); return id; });
  define('cancelAnimationFrame', (id) => { clearTimeout(rafQueue.get(id)); rafQueue.delete(id); });
  define('requestIdleCallback', (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 10 }), 1));
  define('cancelIdleCallback', (id) => clearTimeout(id));
  define('matchMedia', (q) => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }));
  define('getComputedStyle', (el) => {
    const eng = engine();
    return new Proxy({}, {
      get(_, p) {
        if (p === 'getPropertyValue') return (q) => (q === 'display' ? eng.display(el, 'screen') : eng.value(el, q, 'screen') ?? '');
        if (typeof p !== 'string') return undefined;
        const k = p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
        return k === 'display' ? eng.display(el, 'screen') : eng.value(el, k, 'screen') ?? '';
      },
    });
  });
  define('MutationObserver', class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } });
  define('ResizeObserver', class { constructor() {} observe() {} unobserve() {} disconnect() {} });
  define('IntersectionObserver', class { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  define('DOMParser', class { parseFromString(s) { return D.parseDocument(String(s)); } });
  define('CSS', { escape: D.cssEscape, supports: () => false });
  define('Option', function Option(text = '', value, defSel = false, sel = false) {
    const o = doc.createElement('option');
    o.textContent = text;
    if (value !== undefined) o.setAttribute('value', value);
    if (defSel) o.setAttribute('selected', '');
    if (sel) o.selected = true;
    return o;
  });
  define('FormData', class FormData {
    constructor(form) {
      this._e = [];
      if (form && form.elements) {
        for (const c of form.elements) {
          const n = c.getAttribute('name');
          if (!n || c.disabled) continue;
          if (c.localName === 'button' || (c.localName === 'input' && ['submit', 'button', 'reset', 'image'].includes(c.type))) continue;
          if (c.localName === 'input' && ['checkbox', 'radio'].includes(c.type) && !c.checked) continue;
          this._e.push([n, c.value]);
        }
      }
    }
    append(k, v) { this._e.push([String(k), String(v)]); }
    set(k, v) { this.delete(k); this.append(k, v); }
    delete(k) { this._e = this._e.filter(([n]) => n !== k); }
    get(k) { const e = this._e.find(([n]) => n === k); return e ? e[1] : null; }
    getAll(k) { return this._e.filter(([n]) => n === k).map(([, v]) => v); }
    has(k) { return this._e.some(([n]) => n === k); }
    entries() { return this._e[Symbol.iterator](); }
    keys() { return this._e.map(([k]) => k)[Symbol.iterator](); }
    values() { return this._e.map(([, v]) => v)[Symbol.iterator](); }
    forEach(fn) { this._e.forEach(([k, v]) => fn(v, k, this)); }
    [Symbol.iterator]() { return this.entries(); }
  });
  console.error = (...a) => { report.consoleErrors.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 400)); };
}

// ---------------------------------------------------------------- styles

const sheetCache = new Map();
function readSheet(href) {
  const rel = decodeURIComponent(String(href).replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0]).replace(/^\.?\//, '');
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir)) return '';
  if (!sheetCache.has(file)) {
    try { sheetCache.set(file, fs.readFileSync(file, 'utf8')); } catch { sheetCache.set(file, ''); report.notes.push(`stylesheet ${href} could not be read`); }
  }
  return sheetCache.get(file);
}
function engine() {
  const sheets = [];
  for (const el of doc.querySelectorAll('link, style')) {
    if (el.localName === 'link') {
      if (!/\bstylesheet\b/i.test(el.getAttribute('rel') || '') || /\balternate\b/i.test(el.getAttribute('rel') || '')) continue;
      sheets.push({ text: readSheet(el.getAttribute('href') || ''), media: el.getAttribute('media') || '' });
    } else {
      sheets.push({ text: el.textContent, media: el.getAttribute('media') || '' });
    }
  }
  return new StyleEngine(sheets);
}

// ---------------------------------------------------------------- page

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 80) {
  for (let t = 0; t < ms; t += 20) await sleep(20);
}

async function runScript(el) {
  const type = (el.getAttribute('type') || '').trim().toLowerCase();
  const src = el.getAttribute('src');
  const isModule = type === 'module';
  if (type && !isModule && !/javascript|ecmascript/.test(type)) return;
  if (src) {
    if (/^(https?:)?\/\//.test(src)) { pageError(new Error(`the page loads a script from the network: ${src}`)); return; }
    const rel = src.split(/[?#]/)[0].replace(/^\.?\//, '');
    const file = path.join(publicDir, rel);
    if (!fs.existsSync(file)) { pageError(new Error(`script ${src} does not exist under public/`)); return; }
    if (isModule) {
      try { await import(pathToFileURL(file).href); } catch (e) { pageError(e); }
    } else {
      try { vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file }); } catch (e) { pageError(e); }
    }
  } else if (el.textContent.trim()) {
    if (isModule) {
      report.notes.push('an inline module script is run from a data: URL, where relative imports do not resolve');
      try { await import('data:text/javascript,' + encodeURIComponent(el.textContent)); } catch (e) { pageError(e); }
    } else {
      try { vm.runInThisContext(el.textContent); } catch (e) { pageError(e); }
    }
  }
}

let opened = false;
async function openPage({ confirm = [], prompt = [] } = {}) {
  if (opened) throw new Error('one page per session');
  opened = true;
  answers.confirm.push(...confirm);
  answers.prompt.push(...prompt);
  const htmlFile = path.join(publicDir, 'index.html');
  if (!fs.existsSync(htmlFile)) throw new Error('public/index.html does not exist');
  doc = D.parseDocument(fs.readFileSync(htmlFile, 'utf8'));
  doc.defaultView = globalThis;
  installGlobals();
  const scripts = doc.querySelectorAll('script');
  const classic = scripts.filter((s) => (s.getAttribute('type') || '').toLowerCase() !== 'module');
  const modules = scripts.filter((s) => (s.getAttribute('type') || '').toLowerCase() === 'module');
  for (const s of classic.filter((s) => !s.hasAttribute('defer'))) await runScript(s);
  doc.readyState = 'interactive';
  for (const s of classic.filter((s) => s.hasAttribute('defer'))) await runScript(s);
  for (const s of modules) await runScript(s);
  await settle(20);
  doc.dispatchEvent(new D.Event('DOMContentLoaded', { bubbles: true }));
  doc.readyState = 'complete';
  doc.dispatchEvent(new D.Event('readystatechange'));
  winTarget.dispatchEvent(new D.Event('load'));
  winTarget.dispatchEvent(new D.Event('pageshow'));
  await settle(150);
  const P = { doc, engine, settle, calls, answers, local, report };
  P.ui = makeUI(P);
  return P;
}

// Leaves the page as a reload does: unload events, then the storage is kept.
async function unload() {
  await settle(1000);
  if (doc) {
    doc.visibilityState = 'hidden';
    doc.hidden = true;
    doc.dispatchEvent(new D.Event('visibilitychange', { bubbles: true }));
    winTarget.dispatchEvent(new D.Event('beforeunload', { cancelable: true }));
    winTarget.dispatchEvent(new D.Event('pagehide'));
    winTarget.dispatchEvent(new D.Event('unload'));
  }
  await settle(40);
}

// ---------------------------------------------------------------- context

class Abort extends Error {}
const ctx = {
  carry: JSON.parse(process.env.CP_CARRY || 'null'),
  storageInit,
  open: openPage,
  unload,
  settle,
  check(cond, msg, detail) {
    const a = { ok: !!cond, msg };
    if (!cond && detail !== undefined) a.detail = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500);
    report.assertions.push(a);
    return !!cond;
  },
  must(cond, msg, detail) { if (!ctx.check(cond, msg, detail)) throw new Abort(msg); },
  note(msg) { report.notes.push(String(msg).slice(0, 500)); },
  async importCandidate(rel) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Abort(`${rel} does not exist`);
    return import(pathToFileURL(file).href);
  },
  storage: () => local._dump(),
};

try {
  const mod = await import(pathToFileURL(path.resolve(scenarioFile)).href);
  const def = mod.scenarios[criterion];
  if (!def) throw new Error(`no scenario for ${criterion}`);
  const fn = def.sessions[report.session];
  if (!fn) throw new Error(`no session ${report.session} for ${criterion}`);
  const carry = await fn(ctx);
  report.carry = carry === undefined ? null : carry;
  report.done = true;
} catch (e) {
  if (!(e instanceof Abort)) report.assertions.push({ ok: false, msg: 'the scenario stopped: ' + errorText(e) });
}
report.storage = local._dump();
report.calls = calls;
report.navigations = doc ? doc._navigations : [];
console.error = realConsoleError;
emit();
process.exit(0);
